import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import path from "node:path"
import { fileURLToPath } from "node:url"

type AttachResolved = { abs: string; rel: string }

type WorkerRequest = {
  action: "tables" | "schema" | "query" | "run" | "explain" | "export"
  db: string
  attaches: AttachResolved[]
  mode: "readonly" | "query_only" | "readwrite"
  sql?: string
  params?: unknown[]
  limit?: number
  byteCap?: number
  exportLimit?: number
  exportByteCap?: number
  dryRun?: boolean
  table?: string
}

type WorkerResponse = {
  ok: true
  columns?: string[]
  columnTypes?: Array<string | null | undefined>
  rows: unknown[][]
  total: number
  truncated: boolean
  changes?: number
  lastInsertRowid?: number
  isDdl?: boolean
  tableInfo?: Array<{ cid: number; name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>
  ddl?: string
  tableCount?: number
  viewCount?: number
} | {
  ok: false
  error: string
}

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.ts")

const findBun = Effect.fn("SqliteSubprocess.findBun")(function* () {
  const candidates = ["bun", "bunx"]
  for (const candidate of candidates) {
    const probe = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
          ChildProcess.make(candidate, ["--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
        )
        const out = yield* handle.stdout.pipeToEffect()
        const code = yield* handle.exitCode.pipe(Effect.catch(() => Effect.succeed(1)))
        return { out: out.trim(), code }
      }),
    ).pipe(Effect.catch(() => Effect.succeed({ out: "", code: 1 })))
    if (probe.code === 0 && probe.out.length > 0) return candidate
  }
  throw new Error("Bun runtime not found — install Bun (https://bun.sh) or run opencode under Bun")
})

export const runRemoteAction = Effect.fn("SqliteSubprocess.runRemoteAction")(function* (
  spawner: ChildProcessSpawner["Service"],
  req: WorkerRequest,
  abort: AbortSignal,
) {
  const bunPath = yield* findBun

  const input = JSON.stringify(req)

  const handle = yield* spawner.spawn(
    ChildProcess.make(bunPath, ["run", workerPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    }),
  )

  const abortFiber = yield* Effect.forkScoped(
    Effect.callback(() => {
      if (abort.aborted) {
        return handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
      }
      return Effect.sync(() => {
        abort.addEventListener(
          "abort",
          () => {
            handle.kill({ forceKillAfter: "3 seconds" }).ignore()
          },
          { once: true },
        )
      })
    }),
  )

  const writeEffect = Effect.sync(() => {
    const writer = handle.stdin
    if (!writer) return
    writer.write(input)
    writer.end()
  })

  yield* writeEffect

  const stdout = yield* handle.stdout.pipeToEffect()
  const stderr = yield* handle.stderr.pipeToEffect()
  const exitCode = yield* handle.exitCode.pipe(Effect.catch(() => Effect.succeed(null)))

  const trimmed = stdout.trim()
  if (trimmed === "") {
    const errMsg = stderr.trim()
    throw new Error(`SQLite worker failed (exit ${exitCode}): ${errMsg || "no output"}`)
  }

  const parsed: WorkerResponse = JSON.parse(trimmed)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }

  return parsed
})
