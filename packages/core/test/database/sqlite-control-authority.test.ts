import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "../../src/database/database"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { RuntimeOwner } from "../../src/runtime-owner"
import { AbsolutePath } from "../../src/schema"
import { SessionExecutionOwner } from "../../src/session/execution-owner"
import { SessionSchema } from "../../src/session/schema"
import { SessionTable } from "../../src/session/sql"

test("live Session control survives both primary and interactive SELECT permits being pinned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-control-authority-"))
  const filename = join(directory, "authority.sqlite")
  const layer = AppNodeBuilder.build(
    LayerNode.group([Database.node, RuntimeOwner.node, SessionExecutionOwner.node]),
    [[Database.node, Database.layerFromPath(filename)]],
  )
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, readDb, controlDb } = yield* Database.Service
      const owner = yield* SessionExecutionOwner.Service
      const runtime = yield* RuntimeOwner.Service
      const sessionID = SessionSchema.ID.make("ses_control_authority_fixture")

      yield* db.insert(ProjectTable).values({
        id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [],
      }).onConflictDoNothing().run()
      yield* db.insert(SessionTable).values({
        id: sessionID, project_id: Project.ID.global,
        slug: "control-authority", directory: "/project", title: "control",
        version: "test",
      }).run()

      const primaryEntered = yield* Deferred.make<void>()
      const interactiveEntered = yield* Deferred.make<void>()
      const releasePrimary = yield* Deferred.make<void>()
      const releaseInteractive = yield* Deferred.make<void>()

      const primary = yield* db.transaction((tx) => Effect.gen(function* () {
        expect(yield* tx.get<{ id: string }>(sql`SELECT id FROM session WHERE id = ${sessionID}`))
          .toEqual({ id: sessionID })
        yield* Deferred.succeed(primaryEntered, undefined)
        yield* Deferred.await(releasePrimary)
      }), { behavior: "deferred" }).pipe(Effect.forkScoped)
      const interactive = yield* readDb.transaction((tx) => Effect.gen(function* () {
        expect(yield* tx.get<{ id: string }>(sql`SELECT id FROM session WHERE id = ${sessionID}`))
          .toEqual({ id: sessionID })
        yield* Deferred.succeed(interactiveEntered, undefined)
        yield* Deferred.await(releaseInteractive)
      }), { behavior: "deferred" }).pipe(Effect.forkScoped)

      yield* Deferred.await(primaryEntered)
      yield* Deferred.await(interactiveEntered)
      const started = performance.now()
      const outcome = yield* Effect.gen(function* () {
        const acquired = yield* owner.tryAcquire(sessionID)
        expect(acquired.state).toBe("acquired")
        if (acquired.state !== "acquired") return yield* Effect.die("acquire failed")
        expect((yield* owner.snapshot(sessionID)).ownerID).toBe(acquired.token.ownerID)
        expect((yield* owner.snapshotMany([sessionID])).get(sessionID)?.generation).toBe(acquired.token.generation)
        expect(yield* runtime.snapshot(runtime.id)).toMatchObject({ id: runtime.id })
        const interrupt = yield* owner.requestInterrupt(sessionID, "handoff", acquired.token.generation)
        expect(interrupt).toMatchObject({ state: "requested", interruptGeneration: 1 })
        expect((yield* owner.snapshot(sessionID)).interruptReason).toBe("handoff")
        expect((yield* runtime.snapshot(runtime.id))?.controlEpoch).toBe(1)
        // Concurrent stop/handoff requests must serialize through exactly one
        // control writer without lost epochs, despite both UI/history lanes
        // being unavailable for their entire lifetime.
        const concurrent = yield* Effect.forEach(
          Array.from({ length: 16 }, () => undefined),
          () => owner.requestInterrupt(sessionID, "handoff", acquired.token.generation),
          { concurrency: 16 },
        )
        expect(concurrent.every((row) => row.state === "requested")).toBe(true)
        expect((yield* owner.snapshot(sessionID)).interruptGeneration).toBe(17)
        expect((yield* runtime.snapshot(runtime.id))?.controlEpoch).toBe(17)
        const blocked = yield* owner.tryClaimRecovery(sessionID)
        expect(blocked).toMatchObject({ state: "blocked", snapshot: { generation: acquired.token.generation } })
        expect(yield* owner.release(acquired.token)).toBe("released")
        expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
      }).pipe(Effect.timeout(2_000), Effect.exit)
      const durationMs = performance.now() - started

      // Release both blocked readers before reporting an assertion failure.
      yield* Deferred.succeed(releasePrimary, undefined)
      yield* Deferred.succeed(releaseInteractive, undefined)
      yield* Fiber.join(primary)
      yield* Fiber.join(interactive)
      expect(Exit.isSuccess(outcome)).toBe(true)
      expect(durationMs).toBeLessThan(2_000)
      expect(yield* controlDb!()).not.toBe(db)
      expect(yield* controlDb!()).not.toBe(readDb)
    }).pipe(Effect.provide(layer))))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}, 30_000)
