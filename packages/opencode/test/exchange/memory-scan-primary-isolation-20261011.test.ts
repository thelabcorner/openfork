import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ExchangeMemorySession } from "@/exchange/memory-session"

// File-backed WAL and the production lazy scanDb worker, not a mock of SQLite.
test("six memory recalls finish while an unrelated primary writer owns its connection permit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-recall-lane-"))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, readDb, scanDb } = yield* Database.Service
        yield* db.insert(ProjectTable).values({
          id: ProjectV2.ID.global,
          worktree: AbsolutePath.make("/approved"),
          sandboxes: [],
        }).run().pipe(Effect.orDie)
        const sessionID = SessionSchema.ID.make("ses_scan_recall_sentinel")
        yield* db.insert(SessionTable).values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "scan-sentinel",
          directory: "/approved/project",
          title: "singular scan witness",
          version: "test",
          time_created: 1,
          time_updated: 1,
        }).run().pipe(Effect.orDie)
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const writer = yield* db.transaction((tx) => Effect.gen(function* () {
          yield* tx.update(SessionTable).set({ title: "uncommitted rename" })
            .where(eq(SessionTable.id, sessionID)).run()
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        })).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        // A concurrent primary-connection SELECT must remain blocked until the writer's transaction finishes.
        const blockedPrimary = yield* db.select({ title: SessionTable.title }).from(SessionTable)
          .where(eq(SessionTable.id, sessionID)).get().pipe(Effect.forkScoped)
        const primaryReleasedEarly = yield* Effect.race(
          Fiber.await(blockedPrimary).pipe(Effect.as(true)),
          Effect.sleep("30 millis").pipe(Effect.as(false)),
        )
        expect(primaryReleasedEarly).toBe(false)
        const isolated = yield* scanDb()
        expect(isolated).not.toBe(db)
        expect(isolated).not.toBe(readDb)
        const recall = () => Effect.flatMap(scanDb(), (reader) => ExchangeMemorySession.search(reader, {
          query: "singular scan witness",
          limit: 3,
          directoryPrefixes: ["/approved"],
        }))
        const results = yield* Effect.all(Array.from({ length: 6 }, recall), {
          concurrency: "unbounded",
        })
        expect(results).toHaveLength(6)
        expect(results.every((r) => r.hits.some((h) => h.sessionId === sessionID && h.source === "title"))).toBe(true)
        expect(results.every((r) => r.hits.every((h) => h.sessionId === sessionID))).toBe(true)
        // No query against the primary connection can finish until the held transaction settles.
        expect(yield* Effect.race(
          Fiber.await(blockedPrimary).pipe(Effect.as(true)),
          Effect.sleep("20 millis").pipe(Effect.as(false)),
        )).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(writer)
        expect((yield* Fiber.join(blockedPrimary))?.title).toBe("uncommitted rename")
      }).pipe(
        Effect.provide(Database.layerFromPath(path.join(directory, "isolation.sqlite"))),
        Effect.scoped,
      ),
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
