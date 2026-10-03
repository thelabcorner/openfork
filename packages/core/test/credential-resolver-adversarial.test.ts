/**
 * Adversarial verification of the LIVE P2 shared Credential resolver contract
 * (`packages/core/src/credential/resolver.ts` + `Credential.compareAndSwapValue`).
 *
 * These tests assert the canonical-plan contract
 * (`docs/plans/opencode-v2-auth-integration.md` §7.4, the P2 gate, and §20.4),
 * not the current implementation shape. They are written to make ownership
 * mistakes fail:
 *
 *  - "one effective refresh" is proven by an EXACT remote-operation count plus a
 *    single revision increment, so a design that performed N refreshes and
 *    discarded N-1 of them with compare-and-swap cannot pass.
 *  - revision ordering is proven with the wall clock FROZEN, so every mutation
 *    provably shares one timestamp and ordering can only come from the dedicated
 *    integer counter.
 *  - cross-process collapse is proven with two real OS processes and a shared
 *    append-only marker file, so it cannot be faked with two fibers of one event
 *    loop.
 *  - unrelated-credential concurrency is proven with a mutual barrier: each
 *    remote refresh waits for the OTHER credential's remote refresh to be in
 *    flight, which is unsatisfiable if one global mutex exists.
 *
 * Isolation: the in-process suite uses the test preload's `:memory:` database.
 * The cross-process suite builds its own throwaway temp directory (DB file,
 * DB-local Flock directory, shared marker file, child XDG/TEMP roots) and deletes
 * it in `finally`. The user's normal database, config, and caches are never
 * touched. There are no network or provider calls anywhere in this file.
 */
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { Deferred, Duration, Effect, Fiber } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import * as CredentialResolver from "@opencode-ai/core/credential/resolver"
import { CredentialTable } from "@opencode-ai/core/credential/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { RUNTIME_LOCK_DIRNAME } from "@opencode-ai/core/storage-identity"
import { Hash } from "@opencode-ai/core/util/hash"
import { testEffect } from "./lib/effect"

const resolverNodes = () => LayerNode.group([CredentialResolver.node, Credential.node, Database.node])

const it = testEffect(AppNodeBuilder.build(resolverNodes()))

const itSharedRuntime = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Integration.node, CredentialResolver.node, Credential.node, EventV2.node, Database.node]),
  ),
)

/** Five minutes of remaining lifetime, exactly as production computes it. */
const STALE_MARGIN_MS = 5 * 60_000
/** Comfortably "fresh" without depending on a long wall-clock window. */
const FRESH_LIFETIME_MS = 60 * 60_000
const METHOD_ID = Integration.MethodID.make("adversarial-oauth")

const fresh = () => Date.now() + FRESH_LIFETIME_MS

const oauth = (access: string, expires: number) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    access,
    refresh: `refresh-${access}`,
    expires,
  })

/** Production-equivalent staleness oracle (mirrors `Integration.connection.resolve`). */
const shouldRefresh = (value: Credential.OAuth, _integrationID: Credential.Info["integrationID"], now: number) =>
  value.expires <= now + STALE_MARGIN_MS

const integrationID = (name: string) => Integration.ID.make(`adversarial-${name}`)

const withFrozenWallClock = <A, E, R>(frozen: number, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Date.now
      Date.now = () => frozen
      return previous
    }),
    () => body,
    (previous) =>
      Effect.sync(() => {
        Date.now = previous
      }),
  )

describe("CredentialResolver adversarial contract (in-process)", () => {
  it.effect("collapses 100 concurrent stale resolves of one credential into exactly one effective refresh", () =>
    Effect.gen(function* () {
      const resolver = yield* CredentialResolver.Service
      const credentials = yield* Credential.Service
      const CONCURRENCY = 100

      const stored = yield* credentials.add({
        integrationID: integrationID("collapse"),
        label: "shared",
        value: oauth("expired-access", 1),
      })

      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let refreshes = 0

      const options = {
        shouldRefresh,
        refresh: (_value: Credential.OAuth) =>
          Effect.gen(function* () {
            refreshes++
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return oauth(`access-rotation-${refreshes}`, fresh())
          }),
      }

      const resolved = yield* Effect.all(
        Array.from({ length: CONCURRENCY }, () => resolver.resolve(stored.id, options)),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped)

      // While the single winner is still inside the remote refresh, every other
      // resolver must already be parked on the per-credential critical section.
      yield* Deferred.await(entered)
      yield* Effect.yieldNow
      expect(refreshes).toBe(1)

      yield* Deferred.succeed(release, undefined)
      const values = yield* Fiber.join(resolved)

      // Exactly ONE effective remote refresh for 100 concurrent stale resolves.
      expect(refreshes).toBe(1)
      expect(values).toHaveLength(CONCURRENCY)
      expect(values.every((value) => value !== undefined)).toBe(true)

      // Every observer sees the same winning value AND the same winning revision.
      expect(new Set(values.map((value) => JSON.stringify(value))).size).toBe(1)
      const first = values[0]!
      expect(first.value.type).toBe("oauth")
      expect(first.value.type === "oauth" ? first.value.access : undefined).toBe("access-rotation-1")
      expect(new Set(values.map((value) => value!.revision))).toEqual(new Set([2]))

      // Durable state proves this is refresh collapse and not CAS filtering: a
      // design that ran N refreshes and refused N-1 writes would have advanced
      // the revision N times, not once.
      const persisted = yield* credentials.get(stored.id)
      expect(persisted?.revision).toBe(2)
      expect(persisted?.value.type === "oauth" ? persisted.value.access : undefined).toBe("access-rotation-1")
    }),
  )

  it.effect("advances the integer revision for same-millisecond secret mutations instead of relying on timestamps", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const database = yield* Database.Service

      const stored = yield* credentials.add({
        integrationID: integrationID("revision"),
        label: "clock",
        value: oauth("access-0", fresh()),
      })

      const row = database.db
        .select()
        .from(CredentialTable)
        .where(eq(CredentialTable.id, stored.id))
        .get()
        .pipe(Effect.orDie)

      // `time_updated` is Date.now()-driven, so freezing the wall clock forces a
      // REAL, provable timestamp collision instead of hoping for one.
      const FROZEN = 1_800_000_000_000
      const observed = yield* withFrozenWallClock(
        FROZEN,
        Effect.gen(function* () {
          const revisions: number[] = []
          const stamps: number[] = []
          for (let index = 1; index <= 6; index++) {
            yield* credentials.update(stored.id, { value: oauth(`access-${index}`, fresh()) })
            const current = yield* row
            revisions.push(current!.revision)
            stamps.push(current!.time_updated)
          }
          // A compare-and-swap must still resolve ownership from the integer
          // revision alone while the timestamp is provably frozen.
          const latest = yield* row
          const swapped = yield* credentials.compareAndSwapValue(
            stored.id,
            latest!.revision,
            oauth("access-cas", fresh()),
          )
          revisions.push(swapped!.revision)
          stamps.push((yield* row)!.time_updated)
          return { revisions, stamps }
        }),
      )

      // The collision is real, not probabilistic: all seven writes share one
      // wall-clock millisecond.
      expect(new Set(observed.stamps).size).toBe(1)
      expect(observed.stamps[0]).toBe(FROZEN)
      expect(observed.stamps).toHaveLength(7)

      // Ordering therefore comes only from the dedicated integer counter, +1
      // per secret mutation, strictly monotonic and gapless.
      expect(observed.revisions).toEqual([2, 3, 4, 5, 6, 7, 8])

      const persisted = yield* credentials.get(stored.id)
      expect(persisted?.revision).toBe(8)
    }),
  )

  it.effect("refuses a stale compareAndSwapValue and reconciles to the newer winner", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const resolver = yield* CredentialResolver.Service

      const stored = yield* credentials.add({
        integrationID: integrationID("cas"),
        label: "cas",
        value: oauth("access-1", 1),
      })

      // A trusted writer rotates the secret underneath the observed revision.
      yield* credentials.update(stored.id, { value: oauth("access-2", fresh()) })
      expect((yield* credentials.get(stored.id))?.revision).toBe(2)

      // A stale expected revision must not overwrite the newer credential.
      const stale = yield* credentials.compareAndSwapValue(stored.id, 1, oauth("access-stale", fresh()))
      expect(stale).toBeUndefined()
      const afterStale = yield* credentials.get(stored.id)
      expect(afterStale?.revision).toBe(2)
      expect(afterStale?.value.type === "oauth" ? afterStale.value.access : undefined).toBe("access-2")

      // The current owner can still write, and the write is what advances it.
      const current = yield* credentials.compareAndSwapValue(stored.id, 2, oauth("access-3", fresh()))
      expect(current?.revision).toBe(3)
      expect(current?.value.type === "oauth" ? current.value.access : undefined).toBe("access-3")

      // Reconcile winner semantics: a trusted writer that supersedes the
      // credential while a remote refresh is in flight wins, and the stale
      // refresh result is discarded rather than persisted.
      const contended = yield* credentials.add({
        integrationID: integrationID("cas-reconcile"),
        label: "reconcile",
        value: oauth("access-old", 1),
      })
      const winner = oauth("access-winner", fresh())
      const reconciled = yield* resolver.resolve(contended.id, {
        shouldRefresh,
        refresh: () =>
          Effect.gen(function* () {
            yield* credentials.update(contended.id, { value: winner })
            return oauth("access-loser", fresh())
          }),
      })
      expect(reconciled?.value.type === "oauth" ? reconciled.value.access : undefined).toBe("access-winner")
      expect(reconciled?.revision).toBe(2)
      const persisted = yield* credentials.get(contended.id)
      expect(persisted?.revision).toBe(2)
      expect(persisted?.value.type === "oauth" ? persisted.value.access : undefined).toBe("access-winner")
    }),
  )

  it.live("refreshes unrelated credentials concurrently instead of serializing behind one global mutex", () =>
    Effect.gen(function* () {
      const resolver = yield* CredentialResolver.Service
      const credentials = yield* Credential.Service

      const alpha = yield* credentials.add({
        integrationID: integrationID("alpha"),
        label: "alpha",
        value: oauth("alpha-expired", 1),
      })
      const bravo = yield* credentials.add({
        integrationID: integrationID("bravo"),
        label: "bravo",
        value: oauth("bravo-expired", 1),
      })
      expect(alpha.id).not.toBe(bravo.id)

      const bothInFlight = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const entered: string[] = []
      const refreshFor = (tag: string) => (_value: Credential.OAuth) =>
        Effect.gen(function* () {
          entered.push(tag)
          if (entered.length === 2) yield* Deferred.succeed(bothInFlight, undefined)
          // Mutual barrier: this remote refresh cannot finish until the OTHER
          // credential's remote refresh is also in flight. That is unsatisfiable
          // under a single global mutex, so this is a concurrency proof rather
          // than a wall-clock threshold.
          yield* Deferred.await(release)
          return oauth(`${tag}-refreshed`, fresh())
        })

      const resolved = yield* Effect.all(
        [
          resolver.resolve(alpha.id, { shouldRefresh, refresh: refreshFor("alpha") }),
          resolver.resolve(bravo.id, { shouldRefresh, refresh: refreshFor("bravo") }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped)

      // Bounded wait for a state change that can only occur without a global mutex.
      let waited = 0
      while (entered.length < 2 && waited < 10_000) {
        yield* Effect.sleep(Duration.millis(5))
        waited += 5
      }
      expect(entered.toSorted()).toEqual(["alpha", "bravo"])

      yield* Deferred.succeed(release, undefined)
      const [alphaResolved, bravoResolved] = yield* Fiber.join(resolved)

      // One refresh per credential, both completing, neither clobbering the other.
      expect(alphaResolved?.value.type === "oauth" ? alphaResolved.value.access : undefined).toBe("alpha-refreshed")
      expect(bravoResolved?.value.type === "oauth" ? bravoResolved.value.access : undefined).toBe("bravo-refreshed")
      expect(alphaResolved?.revision).toBe(2)
      expect(bravoResolved?.revision).toBe(2)
    }),
  )

  it.effect("never calls refresh for API keys, fresh OAuth credentials, or unknown ids", () =>
    Effect.gen(function* () {
      const resolver = yield* CredentialResolver.Service
      const credentials = yield* Credential.Service

      // Keys must be excluded by the credential TYPE, even when the caller's
      // staleness oracle would happily ask for a refresh.
      const key = yield* credentials.add({
        integrationID: integrationID("key"),
        label: "key",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })
      const keyResolved = yield* resolver.resolve(key.id, {
        shouldRefresh: () => true,
        refresh: () => Effect.die("an API key credential must never be refreshed"),
      })
      expect(keyResolved?.value).toEqual(Credential.Key.make({ type: "key", key: "secret" }))
      expect(keyResolved?.revision).toBe(1)
      expect((yield* credentials.get(key.id))?.revision).toBe(1)

      // A fresh OAuth credential inside the five-minute window must not refresh.
      const expires = fresh()
      const oauthCredential = yield* credentials.add({
        integrationID: integrationID("fresh"),
        label: "fresh",
        value: oauth("fresh-access", expires),
      })
      const freshResolved = yield* resolver.resolve(oauthCredential.id, {
        shouldRefresh,
        refresh: () => Effect.die("a fresh OAuth credential must never be refreshed"),
      })
      expect(freshResolved?.value).toEqual(oauth("fresh-access", expires))
      expect(freshResolved?.revision).toBe(1)
      expect((yield* credentials.get(oauthCredential.id))?.revision).toBe(1)

      // An unknown id resolves to undefined without ever touching refresh.
      const missing = yield* resolver.resolve(Credential.ID.make("cred_missing_adversarial"), {
        shouldRefresh,
        refresh: () => Effect.die("an unknown credential must never be refreshed"),
      })
      expect(missing).toBeUndefined()

      // A stale credential whose refresh reports "no longer refreshable" must
      // preserve the persisted value/revision instead of manufacturing a
      // secret mutation.
      const stale = yield* credentials.add({
        integrationID: integrationID("not-refreshable"),
        label: "stale",
        value: oauth("stale-access", 1),
      })
      const preserved = yield* resolver.resolve(stale.id, {
        shouldRefresh,
        refresh: () => Effect.succeed(undefined),
      })
      expect(preserved?.value).toEqual(oauth("stale-access", 1))
      expect(preserved?.revision).toBe(1)
      const stillStale = yield* credentials.get(stale.id)
      expect(stillStale?.revision).toBe(1)
      expect(stillStale?.value.type === "oauth" ? stillStale.value.access : undefined).toBe("stale-access")
    }),
  )

  it.effect("fails safely without resurrecting secret state when the credential is removed mid-refresh", () =>
    Effect.gen(function* () {
      const resolver = yield* CredentialResolver.Service
      const credentials = yield* Credential.Service
      const id = integrationID("deleted")

      const stored = yield* credentials.add({
        integrationID: id,
        label: "doomed",
        value: oauth("doomed-access", 1),
      })

      const resolved = yield* resolver.resolve(stored.id, {
        shouldRefresh,
        refresh: () =>
          Effect.gen(function* () {
            // The credential is removed while the remote refresh is in flight.
            yield* credentials.remove(stored.id)
            return oauth("resurrected-access", fresh())
          }),
      })

      // The refresh result must not resurrect a deleted credential.
      expect(resolved).toBeUndefined()
      expect(yield* credentials.get(stored.id)).toBeUndefined()
      expect(yield* credentials.list(id)).toEqual([])
      expect(yield* credentials.all()).toEqual([])

      // A later resolve of the deleted id stays undefined and never refreshes.
      const after = yield* resolver.resolve(stored.id, {
        shouldRefresh,
        refresh: () => Effect.die("a deleted credential must never be refreshed"),
      })
      expect(after).toBeUndefined()
    }),
  )

  itSharedRuntime.effect("shares one refresh critical section between the Integration runtime and the global resolver", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const resolver = yield* CredentialResolver.Service
      const credentials = yield* Credential.Service

      const id = integrationID("shared-runtime")
      const methodID = Integration.MethodID.make("shared-oauth")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let refreshes = 0

      // One refresh implementation, reachable through BOTH the location
      // Integration runtime and the global CredentialResolver.
      const refresh = (credential: Credential.OAuth) =>
        Effect.gen(function* () {
          refreshes++
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return Credential.OAuth.make({
            ...credential,
            access: "shared-access",
            refresh: "shared-refresh",
            expires: Number.MAX_SAFE_INTEGER,
          })
        })

      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID: id,
          method: { id: methodID, type: "oauth", label: "OAuth" },
          authorize: () => Effect.die("unused"),
          refresh,
        }),
      )

      const stored = yield* credentials.add({
        integrationID: id,
        label: "shared",
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "expired-access",
          refresh: "expired-token",
          expires: 1,
        }),
      })

      const connection = yield* integrations.connection.active(id)
      if (!connection || connection.type !== "credential") return yield* Effect.die("credential connection not found")

      const resolved = yield* Effect.all(
        [
          Effect.all(Array.from({ length: 6 }, () => integrations.connection.resolve(connection)), {
            concurrency: "unbounded",
          }),
          resolver.resolve(stored.id, { shouldRefresh, refresh }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped)

      yield* Deferred.await(entered)
      yield* Effect.yieldNow
      expect(refreshes).toBe(1)

      yield* Deferred.succeed(release, undefined)
      const [viaIntegration, viaResolver] = yield* Fiber.join(resolved)

      expect(refreshes).toBe(1)
      expect(viaIntegration).toHaveLength(6)
      expect(
        viaIntegration.every((value) => value?.type === "oauth" && value.access === "shared-access"),
      ).toBe(true)
      expect(viaResolver?.value.type === "oauth" ? viaResolver.value.access : undefined).toBe("shared-access")
      expect(viaResolver?.revision).toBe(2)
      expect((yield* credentials.get(stored.id))?.revision).toBe(2)
    }),
  )
})

// ---------------------------------------------------------------------------
// Cross-process / shared-file-DB proof
// ---------------------------------------------------------------------------

const CORE_ROOT = join(import.meta.dir, "..")
const CROSS_PROCESS_FIXTURE = join(import.meta.dir, "fixture", "credential-resolver-cross-process-child.ts")
const CHILD_COMMAND_TIMEOUT_MS = 120_000
/**
 * Bounded observation window. It is not a correctness threshold: the real
 * assertions are the child's COMPLETE event history plus the shared marker-file
 * line count, both checked after every child has exited. The window only exists
 * to give the contending child a chance to attempt the lease before the winner
 * is released.
 */
const CONTENTION_WINDOW_MS = 1_500

type ChildEvent =
  | { readonly type: "ready"; readonly role: string; readonly pid: number }
  | { readonly type: "resolving"; readonly role: string }
  | {
      readonly type: "in-refresh"
      readonly role: string
      readonly marker: { readonly role: string; readonly pid: number; readonly at: number; readonly seenAccess: string }
    }
  | {
      readonly type: "result"
      readonly role: string
      readonly defined: boolean
      readonly access: string | null
      readonly refresh: string | null
      readonly revision: number | null
    }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "fatal"; readonly message: string }

interface ChildHandle {
  readonly role: string
  readonly events: ChildEvent[]
  send(command: "go" | "finish" | "exit"): void
  waitFor<T extends ChildEvent["type"]>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<ChildEvent, { readonly type: T }>>
  exited(): Promise<number>
  stderr(): string
  terminate(): Promise<void>
}

const childEnvironment = (root: string, databasePath: string) => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  // Never touch the user's real database, config, or caches, and keep background
  // maintenance out of the child so the only DB writer under test is the resolver.
  env.OPENCODE_DB = databasePath
  env.OPENCODE_CONFIG_DIR = join(root, "config")
  env.XDG_DATA_HOME = join(root, "xdg", "data")
  env.XDG_CONFIG_HOME = join(root, "xdg", "config")
  env.XDG_STATE_HOME = join(root, "xdg", "state")
  env.XDG_CACHE_HOME = join(root, "xdg", "cache")
  env.TEMP = join(root, "tmp")
  env.TMP = join(root, "tmp")
  env.TMPDIR = join(root, "tmp")
  env.OPENCODE_DISABLE_MODELS_FETCH = "true"
  delete env.OPENCODE_SEAL_ENABLED
  delete env.OPENCODE_SEAL_COMPACT
  delete env.OPENCODE_SEAL_REBUILD
  return env
}

const startChild = (input: { role: string; db: string; credentialID: string; sharedDir: string }, env: Record<string, string>): ChildHandle => {
  const proc = spawn(process.execPath, [CROSS_PROCESS_FIXTURE, JSON.stringify(input)], {
    cwd: CORE_ROOT,
    stdio: "pipe",
    env,
  })
  const stdout = proc.stdout
  const stdin = proc.stdin
  if (!stdout || !stdin) throw new Error(`failed to open stdio for the ${input.role} child`)

  const events: ChildEvent[] = []
  const stderrChunks: Buffer[] = []
  proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
  const stderr = () => Buffer.concat(stderrChunks).toString("utf8")

  const decoder = new TextDecoder()
  let buffer = ""
  stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true })
    for (;;) {
      const index = buffer.indexOf("\n")
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length === 0) continue
      try {
        events.push(JSON.parse(line) as ChildEvent)
      } catch {
        events.push({ type: "error", message: `unparsable child line: ${line}` })
      }
    }
  })

  const exitCode = new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 1)))

  return {
    role: input.role,
    events,
    send: (command) => stdin.write(command + "\n"),
    waitFor: async <T extends ChildEvent["type"]>(type: T, timeoutMs = CHILD_COMMAND_TIMEOUT_MS) => {
      const started = Date.now()
      for (;;) {
        const found = events.find((event): event is Extract<ChildEvent, { readonly type: T }> => event.type === type)
        if (found) return found
        const failure = events.find((event) => event.type === "error" || event.type === "fatal")
        if (failure) throw new Error(`${input.role} child failed: ${JSON.stringify(failure)}\n${stderr()}`)
        if (Date.now() - started > timeoutMs) {
          throw new Error(
            `${input.role} child never emitted "${type}" within ${timeoutMs}ms; events=${JSON.stringify(events)}` +
              (stderr().length > 0 ? `\nstderr:\n${stderr()}` : ""),
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    exited: () => exitCode,
    stderr,
    terminate: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return
      const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()))
      if (process.platform !== "win32" || !proc.pid) {
        proc.kill()
        await closed
        return
      }
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" })
        killer.on("close", () => {
          proc.kill()
          resolve()
        })
        killer.on("error", () => {
          proc.kill()
          resolve()
        })
      })
      await closed
    },
  }
}

const graphFor = (databasePath: string) =>
  AppNodeBuilder.build(resolverNodes(), [[Database.node, Database.layerFromPath(databasePath)]])

const runGraph = <A, E>(databasePath: string, body: Effect.Effect<A, E, CredentialResolver.Service | Credential.Service>) =>
  Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(graphFor(databasePath))))

const seedStaleCredential = (databasePath: string, label: string) =>
  runGraph(
    databasePath,
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      return yield* credentials.add({
        integrationID: integrationID(`xp-${label}`),
        label,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("xp-oauth"),
          access: "expired-access",
          refresh: "expired-token",
          expires: 1,
        }),
      })
    }),
  )

const readPersisted = (databasePath: string, id: Credential.ID) =>
  runGraph(
    databasePath,
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const info = yield* credentials.get(id)
      if (!info) throw new Error(`credential ${id} is missing from ${databasePath}`)
      return {
        revision: info.revision,
        access: info.value.type === "oauth" ? info.value.access : null,
        refresh: info.value.type === "oauth" ? info.value.refresh : null,
      }
    }),
  )

const isDirectory = async (path: string) => ((await stat(path).catch(() => undefined))?.isDirectory() ?? false)

describe("CredentialResolver cross-process refresh ownership (shared file-backed DB)", () => {
  test(
    "two independent processes contending on one stale OAuth credential perform exactly one effective remote refresh",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "openfork-credential-resolver-xp-"))
      const databasePath = join(root, "resolver.db")
      const sharedDir = join(root, "shared")
      const counterPath = join(sharedDir, "remote-refresh.log")
      const env = childEnvironment(root, databasePath)
      const children: ChildHandle[] = []

      // One appended line == one effective remote refresh operation. This is the
      // cross-process witness that separates "only one remote refresh happened"
      // from "a stale DB write was refused": the loser would still append a line
      // under the latter design.
      const counterLines = async () => {
        const text = await readFile(counterPath, "utf8").catch(() => "")
        return text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      }

      try {
        for (const directory of [sharedDir, join(root, "config"), join(root, "tmp"), join(root, "xdg", "data")]) {
          await mkdir(directory, { recursive: true })
        }

        // Reverse which process wins so the proof is not an artifact of spawn order.
        for (const order of [
          ["alpha", "bravo"],
          ["bravo", "alpha"],
        ] as const) {
          const [first, second] = order
          const stored = await seedStaleCredential(databasePath, `${first}-${second}`)
          await writeFile(counterPath, "", "utf8")

          const lockDir = join(root, RUNTIME_LOCK_DIRNAME)
          const lockPath = join(lockDir, `${Hash.fast(`credential-refresh:${stored.id}`)}.lock`)

          const alpha = startChild(
            { role: "alpha", db: databasePath, credentialID: stored.id, sharedDir },
            env,
          )
          const bravo = startChild(
            { role: "bravo", db: databasePath, credentialID: stored.id, sharedDir },
            env,
          )
          children.push(alpha, bravo)

          const [alphaReady, bravoReady] = await Promise.all([alpha.waitFor("ready"), bravo.waitFor("ready")])
          // Prove these are two independent OS processes, not two fibers.
          expect(alphaReady.pid).not.toBe(bravoReady.pid)
          expect(alphaReady.pid).not.toBe(process.pid)
          expect(bravoReady.pid).not.toBe(process.pid)

          const winner = first === "alpha" ? alpha : bravo
          const loser = first === "alpha" ? bravo : alpha

          winner.send("go")
          const inRefresh = await winner.waitFor("in-refresh")
          expect(inRefresh.marker.role).toBe(first)
          // The winner is genuinely holding the DB-local cross-process lease
          // while its remote refresh is in flight.
          expect(await isDirectory(lockPath)).toBe(true)

          loser.send("go")
          await loser.waitFor("resolving")

          // Bounded observation window. A correct loser cannot complete, and
          // cannot perform a second remote refresh, while the lease is held.
          await new Promise((resolve) => setTimeout(resolve, CONTENTION_WINDOW_MS))
          expect(await counterLines()).toHaveLength(1)
          expect(loser.events.filter((event) => event.type === "in-refresh")).toHaveLength(0)
          expect(loser.events.filter((event) => event.type === "result")).toHaveLength(0)

          winner.send("finish")
          const winnerResult = await winner.waitFor("result")
          const loserResult = await loser.waitFor("result")

          // Remote-refresh collapse, from the children's complete event history.
          const lines = await counterLines()
          expect(lines).toHaveLength(1)
          expect(JSON.parse(lines[0]!)!.role).toBe(first)
          expect(winner.events.filter((event) => event.type === "in-refresh")).toHaveLength(1)
          expect(loser.events.filter((event) => event.type === "in-refresh")).toHaveLength(0)
          expect(loser.events.filter((event) => event.type === "error")).toHaveLength(0)
          expect(loser.events.filter((event) => event.type === "fatal")).toHaveLength(0)

          // Both processes converge on the single winner's value and revision.
          expect(winnerResult.defined).toBe(true)
          expect(loserResult.defined).toBe(true)
          expect(loserResult.access).toBe(winnerResult.access)
          expect(loserResult.refresh).toBe(winnerResult.refresh)
          expect(loserResult.revision).toBe(winnerResult.revision)
          expect(winnerResult.revision).toBe(2)

          // Exactly one rotation was persisted and the lease was released, so
          // the two processes really shared one database file.
          const persisted = await readPersisted(databasePath, stored.id)
          expect(persisted.revision).toBe(2)
          expect(persisted.access).toBe(winnerResult.access)
          expect(persisted.refresh).toBe(winnerResult.refresh)
          expect(await isDirectory(lockPath)).toBe(false)

          alpha.send("exit")
          bravo.send("exit")
          expect(await Promise.all([alpha.exited(), bravo.exited()])).toEqual([0, 0])
        }
      } finally {
        for (const child of children) await child.terminate().catch(() => undefined)
        await rm(root, { recursive: true, force: true })
      }
    },
    240_000,
  )
})
