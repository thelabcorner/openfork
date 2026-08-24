import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as AppProcess from "@opencode-ai/core/process"
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
        const handle = yield* (yield* ChildProcessSpawner).spawn(
          ChildProcess.make(candidate, ["--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
        )
        const out = yield* AppProcess.collectStream(handle.stdout, undefined).pipe(Effect.map((r) => r.buffer.toString("utf8").trim()))
        const code = yield* handle.exitCode.pipe(Effect.catch(() => Effect.succeed(1 as const)))
        return { out, code }
      }),
    ).pipe(Effect.catch(() => Effect.succeed({ out: "", code: 1 as const })))
    if (probe.code === 0 && probe.out.length > 0) return candidate
  }
  throw new Error("Bun runtime not found — install Bun (https://bun.sh) or run opencode under Bun")
})

export const runRemoteAction = Effect.fn("SqliteSubprocess.runRemoteAction")(function* (
  spawner: ChildProcessSpawner["Service"],
  req: WorkerRequest,
  abort: AbortSignal,
) {
  const bunPath = yield* findBun()

  const input = JSON.stringify(req)

  const handle = yield* spawner.spawn(
    ChildProcess.make(bunPath, ["run", workerPath], {
      stdin: Stream.make(new TextEncoder().encode(input)),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    }),
  )

  yield* Effect.forkScoped(
    Effect.callback<void>((resume) => {
      if (abort.aborted) {
        resume(Effect.flatMap(handle.kill({ forceKillAfter: "3 seconds" as const }), () => Effect.void).pipe(Effect.orDie))
        return
      }
      const onabort = () => {
        Effect.runFork(handle.kill({ forceKillAfter: "3 seconds" as const }).pipe(Effect.ignore))
      }
      abort.addEventListener("abort", onabort, { once: true })
      return Effect.sync(() => abort.removeEventListener("abort", onabort))
    }),
  )

  const [stdoutBuf, stderrBuf] = yield* Effect.all(
    [AppProcess.collectStream(handle.stdout, undefined), AppProcess.collectStream(handle.stderr, undefined)],
    { concurrency: "unbounded" },
  )
  const stdout = stdoutBuf.buffer.toString("utf8")
  const stderr = stderrBuf.buffer.toString("utf8")
  const exitCode = yield* handle.exitCode.pipe(Effect.catch(() => Effect.succeed(null as unknown as number)))

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
