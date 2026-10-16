import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionContextStateTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EffectiveContextCompiler } from "../../src/session/context/compiler"

test("32 concurrent context compiles do not queue behind an unrelated foreground writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-context-reader-"))
  const filename = join(directory, "context.db")
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* Database.Service
          expect(database.readDb).not.toBe(database.db)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const writer = yield* database.db.transaction(
            () => Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }),
            { behavior: "immediate" },
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)

          // The connection's primary permit is held by the foreground writer.
          // A compiler still using db would block here until its release.
          // Session-level compilation is committed-state-only and must use
          // the already-owned WAL reader lane without opening an Instance.
          const finishedBeforeWriterRelease = yield* Effect.race(
            Effect.all(
              Array.from({ length: 32 }, (_, index) =>
                EffectiveContextCompiler.compileForSession({
                  sessionID: `ses_context_concurrency_${index}`,
                  messages: [],
                }),
              ),
              { concurrency: "unbounded" },
            ).pipe(
              Effect.map((results) => {
                expect(results).toHaveLength(32)
                 for (const result of results) {
                   expect(result.effective).toEqual([])
                   expect(result.hadOverlays).toBe(false)
                 }
                return true
              }),
            ),
            Effect.sleep("1500 millis").pipe(Effect.as(false)),
          )
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(writer)
          expect(finishedBeforeWriterRelease).toBe(true)
        }).pipe(Effect.provide(Database.layerFromPath(filename))),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("file-backed cached overlays invalidate after actual writer commits without stale context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-context-revision-"))
  const filename = join(directory, "context.db")
  const sessionID = SessionSchema.ID.make("ses_context_revision_test")
  const messageID = "msg_context_revision_test"
  const messages = [{
    info: { id: messageID, role: "user", sessionID, time: { created: 1 }, agent: "build" },
    parts: [{ id: "prt_context_revision", type: "text", text: "canonical", sessionID, messageID }],
  }] as unknown as Parameters<typeof EffectiveContextCompiler.compile>[0]["messages"]
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, readDb } = yield* Database.Service
      expect(readDb).not.toBe(db)
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/context-test"), sandboxes: [] })
        .onConflictDoNothing().run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values({
        id: sessionID, project_id: Project.ID.global, slug: "context-revision",
        directory: "/context-test", title: "Context revision", version: "test",
      }).run().pipe(Effect.orDie)
      const compile = () => EffectiveContextCompiler.compileForSession({ sessionID, messages })
      const first = yield* compile()
      expect(first.hadOverlays).toBe(false)
      expect(first.effective).toHaveLength(1)
      expect((yield* compile()).hadOverlays).toBe(false)
      yield* db.insert(SessionContextStateTable).values({
        session_id: sessionID, message_id: messageID as any,
        excluded: true, pinned: false, modified_at: 1,
      }).run().pipe(Effect.orDie)
      const excluded = yield* compile()
      expect(excluded.hadOverlays).toBe(true)
      expect(excluded.effective).toHaveLength(0)
      yield* db.update(SessionContextStateTable).set({ excluded: false, override_data: { text: "revised" }, modified_at: 2 })
        .where(eq(SessionContextStateTable.session_id, sessionID)).run().pipe(Effect.orDie)
      const restored = yield* compile()
      expect(restored.hadOverlays).toBe(true)
      expect(restored.effective).toHaveLength(1)
      expect(restored.effective[0]!.parts[0]).toMatchObject({ text: "revised" })
      // Cross the adaptive cache admission threshold. The first projection
      // still reads the authoritative table; the following cached projection
      // must invalidate on the next writer commit.
      yield* db.insert(SessionContextStateTable).values(
        Array.from({ length: 3 }, (_, index) => ({
          session_id: sessionID, message_id: `msg_ctx_extra_${index}` as any,
          excluded: false, pinned: true, modified_at: 3,
        })),
      ).run().pipe(Effect.orDie)
      expect((yield* compile()).effective[0]!.parts[0]).toMatchObject({ text: "revised" })
      expect((yield* compile()).effective[0]!.parts[0]).toMatchObject({ text: "revised" })
      yield* db.update(SessionContextStateTable).set({ override_data: { text: "latest-after-threshold" }, modified_at: 4 })
        .where(eq(SessionContextStateTable.message_id, messageID as any)).run().pipe(Effect.orDie)
      expect((yield* compile()).effective[0]!.parts[0]).toMatchObject({ text: "latest-after-threshold" })
    }).pipe(Effect.provide(Database.layerFromPath(filename)))))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)