/**
 * Cross-process child for `test/credential-resolver-adversarial.test.ts`.
 *
 * Each child is a REAL OS process with its own Core graph built against the
 * shared file-backed SQLite database named in `input.db`. Both children resolve
 * the SAME stale OAuth credential through the production
 * `CredentialResolver.Service`, so the only mechanism that can stop them from
 * performing two independent remote refresh operations is the DB-local `Flock`
 * lease the resolver holds ACROSS the refresh itself.
 *
 * Cross-process witness: `<sharedDir>/remote-refresh.log`. The refresh callback
 * appends exactly one line per EFFECTIVE REMOTE REFRESH OPERATION, before it
 * blocks waiting for the parent. A design that merely refused a stale DB write
 * (compare-and-swap) would still let the loser perform a second remote refresh
 * and then discard its own write, so the LOG LINE COUNT is what distinguishes
 * remote-refresh collapse from "only a stale write was prevented". There is no
 * network call and no real provider anywhere in this fixture.
 *
 * Line protocol (parent stdin -> child):
 *   go      -> fork one `CredentialResolver.resolve` for `credentialID`
 *   finish  -> release the in-flight remote refresh so the resolve can settle
 *   exit    -> close the scope and exit
 *
 * Every step is announced on stdout as exactly one JSON line. Errors are
 * reported as JSON instead of being hidden.
 */
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { Cause, Deferred, Effect, Logger } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import * as CredentialResolver from "@opencode-ai/core/credential/resolver"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

interface Input {
  readonly role: string
  readonly db: string
  readonly credentialID: string
  readonly sharedDir: string
}

const raw = process.argv[2]
if (raw === undefined || raw.length === 0) {
  process.stderr.write("missing credential resolver cross-process child input\n")
  process.exit(2)
}
const input = JSON.parse(raw) as Input
const credentialID = Credential.ID.make(input.credentialID)
const counterPath = join(input.sharedDir, "remote-refresh.log")

// Mirrors the production staleness rule in
// `Integration.connection.resolve` (five minutes of remaining lifetime).
const STALE_MARGIN_MS = 5 * 60_000
const FRESH_LIFETIME_MS = 60 * 60_000

const emit = (payload: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify(payload) + "\n")
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
  LayerNode.group([CredentialResolver.node, Credential.node, Database.node]),
  [[Database.node, Database.layerFromPath(input.db)]],
)

const program = Effect.gen(function* () {
  const resolver = yield* CredentialResolver.Service
  let inFlight: Deferred.Deferred<void> | undefined

  const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Effect.sync(() => {
          emit({ type: "error", message: Cause.pretty(cause) })
        }),
      ),
    )

  emit({ type: "ready", role: input.role, pid: process.pid })

  for (;;) {
    const line = yield* Effect.promise(() => commands.next())
    if (line === null || line === "exit") break
    if (line === "go") {
      const released = yield* Deferred.make<void>()
      inFlight = released
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          emit({ type: "resolving", role: input.role })
          const resolved = yield* resolver.resolve(credentialID, {
            shouldRefresh: (value, _integrationID, now) => value.expires <= now + STALE_MARGIN_MS,
            refresh: (value) =>
              Effect.gen(function* () {
                // ONE appended line == ONE effective remote refresh operation.
                const marker = { role: input.role, pid: process.pid, at: Date.now(), seenAccess: value.access }
                yield* Effect.promise(() => appendFile(counterPath, JSON.stringify(marker) + "\n"))
                emit({ type: "in-refresh", role: input.role, marker })
                // Model a slow remote refresh performed while the cross-process
                // lease is still held.
                yield* Deferred.await(released)
                return Credential.OAuth.make({
                  ...value,
                  access: `access-${input.role}-${process.pid}`,
                  refresh: `refresh-${input.role}-${process.pid}`,
                  expires: Date.now() + FRESH_LIFETIME_MS,
                })
              }),
          })
          emit({
            type: "result",
            role: input.role,
            defined: resolved !== undefined,
            access: resolved?.value.type === "oauth" ? resolved.value.access : null,
            refresh: resolved?.value.type === "oauth" ? resolved.value.refresh : null,
            revision: resolved?.revision ?? null,
          })
        }),
      )
      continue
    }
    if (line === "finish") {
      const held = inFlight
      if (held === undefined) {
        emit({ type: "error", message: "finish requested without an in-flight remote refresh" })
        continue
      }
      yield* Deferred.succeed(held, undefined)
      continue
    }
    emit({ type: "error", message: `unknown command: ${line}` })
  }
})

await Effect.runPromise(
  Effect.provideService(Effect.scoped(program.pipe(Effect.provide(graph))), Logger.LogToStderr, true),
).catch((cause: unknown) => {
  const text = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
  emit({ type: "fatal", message: text })
  process.exit(1)
})
process.exit(0)
