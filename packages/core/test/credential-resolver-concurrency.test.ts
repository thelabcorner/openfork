import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import * as CredentialResolver from "@opencode-ai/core/credential/resolver"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const graphFor = (databasePath: string) =>
  AppNodeBuilder.build(
    LayerNode.group([Credential.node, CredentialResolver.node]),
    [[Database.node, Database.layerFromPath(databasePath)]],
  )

const it = testEffect(graphFor(":memory:"))

const integrationID = Integration.ID.make("credential-resolver-adversarial")
const methodID = Integration.MethodID.make("oauth")

const expired = (suffix = "seed") =>
  Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: `expired-access-${suffix}`,
    refresh: `expired-refresh-${suffix}`,
    expires: 1,
  })

const fresh = (credential: Credential.OAuth, suffix: string) =>
  Credential.OAuth.make({
    ...credential,
    access: `fresh-access-${suffix}`,
    refresh: `fresh-refresh-${suffix}`,
    expires: Number.MAX_SAFE_INTEGER,
  })

const shouldRefresh = (credential: Credential.OAuth, _integrationID: Credential.Info["integrationID"], now: number) =>
  credential.expires <= now

describe("CredentialResolver adversarial concurrency", () => {
  it.effect(
    "collapses 100 concurrent refreshes of one credential into one remote refresh",
    () =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const resolver = yield* CredentialResolver.Service
        const created = yield* credentials.add({
          integrationID,
          label: "shared",
          value: expired(),
        })

        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let refreshes = 0

        const pending = yield* Effect.all(
          Array.from({ length: 100 }, () =>
            resolver.resolve(created.id, {
              shouldRefresh,
              refresh: (credential) =>
                Effect.gen(function* () {
                  refreshes++
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)
                  return fresh(credential, "winner")
                }),
            }),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(started)
        yield* Effect.yieldNow
        expect(refreshes).toBe(1)

        yield* Deferred.succeed(release, undefined)
        const resolved = yield* Fiber.join(pending)

        expect(refreshes).toBe(1)
        expect(resolved).toHaveLength(100)
        expect(resolved.every((value) => value?.revision === 2)).toBe(true)
        expect(
          resolved.every(
            (value) => value?.value.type === "oauth" && value.value.access === "fresh-access-winner",
          ),
        ).toBe(true)
      }),
    15_000,
  )

  it.effect("keeps secret revisions strictly monotonic inside one wall-clock millisecond", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const originalNow = Date.now
      Date.now = () => 1_700_000_000_000
      try {
        const created = yield* credentials.add({
          integrationID,
          label: "same-ms",
          value: expired("same-ms"),
        })
        expect(created.revision).toBe(1)

        yield* credentials.update(created.id, { value: fresh(created.value as Credential.OAuth, "one") })
        const second = yield* credentials.get(created.id)
        expect(second?.revision).toBe(2)

        if (!second || second.value.type !== "oauth") return yield* Effect.die("missing OAuth credential after first update")
        yield* credentials.update(second.id, { value: fresh(second.value, "two") })
        const third = yield* credentials.get(created.id)
        expect(third?.revision).toBe(3)
      } finally {
        Date.now = originalNow
      }
    }),
  )

  it.effect("rejects a stale secret CAS without overwriting the newer credential", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const created = yield* credentials.add({
        integrationID,
        label: "cas",
        value: expired("cas"),
      })
      if (created.value.type !== "oauth") return yield* Effect.die("expected OAuth credential")

      const winnerValue = fresh(created.value, "winner")
      const winner = yield* credentials.compareAndSwapValue(created.id, created.revision, winnerValue)
      expect(winner?.revision).toBe(2)

      const staleValue = fresh(created.value, "stale")
      const stale = yield* credentials.compareAndSwapValue(created.id, created.revision, staleValue)
      expect(stale).toBeUndefined()

      const stored = yield* credentials.get(created.id)
      expect(stored?.revision).toBe(2)
      expect(stored?.value.type === "oauth" ? stored.value.access : undefined).toBe("fresh-access-winner")
    }),
  )

  it.effect(
    "refreshes unrelated credentials concurrently instead of taking a global refresh mutex",
    () =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const resolver = yield* CredentialResolver.Service
        const first = yield* credentials.add({ integrationID, label: "first", value: expired("first") })
        const second = yield* credentials.add({ integrationID, label: "second", value: expired("second") })

        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const resolveOne = (id: Credential.ID, name: string, started: Deferred.Deferred<void>) =>
          resolver.resolve(id, {
            shouldRefresh,
            refresh: (credential) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                return fresh(credential, name)
              }),
          })

        const firstFiber = yield* resolveOne(first.id, "first", firstStarted).pipe(Effect.forkScoped)
        const secondFiber = yield* resolveOne(second.id, "second", secondStarted).pipe(Effect.forkScoped)

        // If the implementation accidentally uses one global mutex, the second
        // callback cannot start until release and this test hits its timeout.
        yield* Deferred.await(firstStarted)
        yield* Deferred.await(secondStarted)

        yield* Deferred.succeed(release, undefined)
        const [a, b] = yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)])

        expect(a?.revision).toBe(2)
        expect(b?.revision).toBe(2)
        expect(a?.value.type === "oauth" ? a.value.access : undefined).toBe("fresh-access-first")
        expect(b?.value.type === "oauth" ? b.value.access : undefined).toBe("fresh-access-second")
      }),
    10_000,
  )
})

type ChildEvent =
  | { type: "ready"; pid: number }
  | { type: "result"; pid: number; revision?: number; access?: string }
  | { type: "fatal"; message: string }

interface ChildHandle {
  send(command: string): void
  next(timeoutMs?: number): Promise<ChildEvent>
  exited(): Promise<number>
  stderr(): string
  terminate(): Promise<void>
}

const CORE_ROOT = join(import.meta.dir, "..")
const CHILD = join(import.meta.dir, "fixture", "credential-resolver-process-child.ts")

function startChild(input: { db: string; credentialID: string; marker: string }): ChildHandle {
  const proc = spawn(process.execPath, [CHILD, JSON.stringify(input)], {
    cwd: CORE_ROOT,
    stdio: "pipe",
  })
  const stdout = proc.stdout
  const stdin = proc.stdin
  if (!stdout || !stdin) throw new Error("failed to open credential resolver child stdio")

  const pending: string[] = []
  const waiters: Array<(line: string | null) => void> = []
  let buffer = ""
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (;;) {
      const index = buffer.indexOf("\n")
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else pending.push(line)
    }
  })
  stdout.on("end", () => {
    for (const waiter of waiters.splice(0)) waiter(null)
  })

  const stderrChunks: Buffer[] = []
  proc.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)))
  const exitCode = new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 1)))

  const nextLine = () =>
    new Promise<string | null>((resolve) => {
      const queued = pending.shift()
      if (queued !== undefined) resolve(queued)
      else waiters.push(resolve)
    })

  return {
    send(command) {
      stdin.write(command + "\n")
    },
    async next(timeoutMs = 60_000) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const line = await Promise.race([
        nextLine(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs)
        }),
      ])
      if (timer) clearTimeout(timer)
      if (line === null) {
        throw new Error(`credential resolver child timed out/exited; stderr=\n${Buffer.concat(stderrChunks).toString("utf8")}`)
      }
      return JSON.parse(line) as ChildEvent
    },
    exited: () => exitCode,
    stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    async terminate() {
      if (proc.exitCode === null) proc.kill()
      await Promise.race([exitCode, new Promise<void>((resolve) => setTimeout(resolve, 2_000))])
    },
  }
}

const runFileGraph = async <A>(databasePath: string, effect: Effect.Effect<A, any, any>) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(Effect.provide(graphFor(databasePath))) as Effect.Effect<A, any, never>,
    ),
  )

test(
  "two real processes sharing one DB perform exactly one rotating-token refresh",
  async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "credential-resolver.sqlite")
    const marker = join(tmp.path, "remote-refreshes.log")

    const created = await runFileGraph(
      databasePath,
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        return yield* credentials.add({
          integrationID,
          label: "cross-process",
          value: expired("cross-process"),
        })
      }),
    )

    const first = startChild({ db: databasePath, credentialID: String(created.id), marker })
    const second = startChild({ db: databasePath, credentialID: String(created.id), marker })

    try {
      expect((await first.next()).type).toBe("ready")
      expect((await second.next()).type).toBe("ready")

      first.send("go")
      second.send("go")

      const [a, b] = await Promise.all([first.next(), second.next()])
      if (a.type === "fatal") throw new Error(a.message)
      if (b.type === "fatal") throw new Error(b.message)
      expect(a.type).toBe("result")
      expect(b.type).toBe("result")
      if (a.type !== "result" || b.type !== "result") throw new Error("children did not return resolver results")

      expect(a.revision).toBe(2)
      expect(b.revision).toBe(2)
      expect(a.access).toBeDefined()
      expect(b.access).toBe(a.access)

      const calls = (await readFile(marker, "utf8"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      expect(calls).toHaveLength(1)

      const stored = await runFileGraph(
        databasePath,
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          return yield* credentials.get(created.id)
        }),
      )
      expect(stored?.revision).toBe(2)
      expect(stored?.value.type === "oauth" ? stored.value.access : undefined).toBe(a.access)

      expect(await first.exited()).toBe(0)
      expect(await second.exited()).toBe(0)
    } finally {
      await Promise.all([first.terminate(), second.terminate()])
    }
  },
  90_000,
)
