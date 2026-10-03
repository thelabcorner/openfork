/**
 * Cross-process G2 admission-fence child for
 * `test/session-execution-maintenance-cross-process.test.ts`.
 *
 * One child process owns exactly one authority role against a shared
 * file-backed SQLite database:
 *   - `owner` role: SessionExecutionOwner.tryAcquire(sessionID)
 *   - `guard` role: DirectoryMaintenanceGuard.acquire({ guardId, directories })
 *
 * The child builds the real core graph (Database.layerFromPath, RuntimeOwner,
 * SessionExecutionOwner, DirectoryMaintenanceGuard), announces `ready` on
 * stdout, then executes line-delimited commands from stdin:
 *   go      -> attempt the role's acquisition once and report the result
 *   retry   -> attempt again after the peer released (same reporting)
 *   release -> release the currently held token and report the outcome
 *   exit    -> close the runtime and exit
 *
 * Authority is only released on an explicit parent `release` command, i.e.
 * after the parent recorded the winner. Errors are reported as JSON with an
 * explicit SQLITE_BUSY classification instead of being hidden.
 */
import { Cause, Effect, Logger } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionSchema } from "@opencode-ai/core/session/schema"

interface Input {
  readonly role: "owner" | "guard"
  readonly db: string
  readonly sessionID: string
  readonly guardId: string
  readonly directories: readonly string[]
}

const raw = process.argv[2]
if (raw === undefined || raw.length === 0) {
  process.stderr.write("missing cross-process race child input\n")
  process.exit(2)
}
const input = JSON.parse(raw) as Input

const emit = (payload: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify(payload) + "\n")
}

const looksBusy = (text: string) => {
  const lowered = text.toLowerCase()
  return (
    lowered.includes("sqlite_busy") ||
    lowered.includes("database is locked") ||
    lowered.includes("database table is locked")
  )
}

// Line-delimited command queue over stdin. `null` means stdin reached EOF.
const commands = (() => {
  const pending: string[] = []
  const waiters: Array<(line: string | null) => void> = []
  const decoder = new TextDecoder()
  let buffer = ""
  let closed = false
  const deliver = (line: string | null) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else if (line !== null) pending.push(line)
  }
  void (async () => {
    try {
      for await (const chunk of Bun.stdin.stream()) {
        buffer += decoder.decode(chunk, { stream: true })
        for (;;) {
          const index = buffer.indexOf("\n")
          if (index < 0) break
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line.length > 0) deliver(line)
        }
      }
    } finally {
      closed = true
      for (const waiter of waiters.splice(0)) waiter(null)
    }
  })()
  return {
    next: () =>
      new Promise<string | null>((resolve) => {
        const queued = pending.shift()
        if (queued !== undefined) resolve(queued)
        else if (closed) resolve(null)
        else waiters.push(resolve)
      }),
  }
})()

const graph = AppNodeBuilder.build(
  LayerNode.group([Database.node, RuntimeOwner.node, SessionExecutionOwner.node, DirectoryMaintenanceGuard.node]),
  [[Database.node, Database.layerFromPath(input.db)]],
)

const program = Effect.gen(function* () {
  const owner = yield* SessionExecutionOwner.Service
  const guards = yield* DirectoryMaintenanceGuard.Service
  const runtime = yield* RuntimeOwner.Service
  const sessionID = SessionSchema.ID.make(input.sessionID)
  let token: SessionExecutionOwner.Token | DirectoryMaintenanceGuard.Token | undefined

  const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause: Cause.Cause<unknown>) => {
        const text = Cause.pretty(cause)
        return Effect.sync(() => {
          emit({ type: "error", message: text, sqliteBusy: looksBusy(text) })
        })
      }),
    )

  const attempt = (round: "go" | "retry") =>
    Effect.gen(function* () {
      if (input.role === "owner") {
        const result = yield* owner.tryAcquire(sessionID)
        if (result.state === "acquired") token = result.token
        emit({ type: "result", round, result })
        return
      }
      const result = yield* guards.acquire({ guardId: input.guardId, directories: input.directories })
      if (result.state === "acquired") token = result.token
      emit({ type: "result", round, result })
    })

  const release = () =>
    Effect.gen(function* () {
      const held = token
      if (held === undefined) {
        emit({ type: "error", round: "release", message: "release requested without a held token" })
        return
      }
      token = undefined
      const result =
        input.role === "owner"
          ? yield* owner.release(held as SessionExecutionOwner.Token)
          : yield* guards.release(held as DirectoryMaintenanceGuard.Token)
      emit({ type: "released", round: "release", result })
    })

  emit({ type: "ready", role: input.role, ownerID: runtime.id, pid: process.pid })

  for (;;) {
    const line = yield* Effect.promise(() => commands.next())
    if (line === null || line === "exit") break
    if (line === "go") {
      yield* settle(attempt("go"))
      continue
    }
    if (line === "retry") {
      yield* settle(attempt("retry"))
      continue
    }
    if (line === "release") {
      yield* settle(release())
      continue
    }
    emit({ type: "error", message: `unknown command: ${line}` })
  }
})

await Effect.runPromise(
  Effect.provideService(Effect.scoped(program.pipe(Effect.provide(graph))), Logger.LogToStderr, true),
).catch((cause: unknown) => {
  const text = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
  emit({ type: "fatal", message: text, sqliteBusy: looksBusy(text) })
  process.exit(1)
})
process.exit(0)
