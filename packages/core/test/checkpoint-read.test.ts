import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Deferred, Effect, Fiber } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import type * as Scope from "effect/Scope"
import { sql } from "drizzle-orm"
import { Checkpoint } from "@opencode-ai/core/checkpoint"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import checkpointReadProjectionMigration from "@opencode-ai/core/database/migration/20260919011000_checkpoint_read_projection"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import {
  SessionCheckpointTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { RelativePath } from "@opencode-ai/schema/schema"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

async function withCheckpointRead<A, E>(
  body: Effect.Effect<A, E, Database.Service | Checkpoint.ReadService | Scope.Scope>,
): Promise<A> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-checkpoint-read-"))
  const filename = path.join(directory, "checkpoint.sqlite")
  const layer = LayerNode.compile(
    LayerNode.group([Database.node, Checkpoint.readNode]),
    [[Database.node, Database.layerFromPath(filename)]],
  )
  try {
    return await Effect.runPromise(body.pipe(Effect.provide(layer), Effect.scoped))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const seed = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db
    .insert(ProjectTable)
    .values({
      id: "prj_checkpoint_read" as any,
      worktree: "C:/checkpoint-read" as any,
      sandboxes: [],
      time_created: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)

  yield* db
    .insert(SessionTable)
    .values([
      {
        id: "ses_checkpoint_alpha" as any,
        project_id: "prj_checkpoint_read" as any,
        slug: "alpha",
        directory: "C:/checkpoint-read" as any,
        title: "Alpha Search Session",
        agent: "build",
        version: "test",
        time_created: now,
        time_updated: now,
      },
      {
        id: "ses_checkpoint_beta" as any,
        project_id: "prj_checkpoint_read" as any,
        slug: "beta",
        directory: "C:/checkpoint-read" as any,
        title: "Beta Session",
        agent: "plan",
        version: "test",
        time_created: now,
        time_updated: now,
      },
    ])
    .run()
    .pipe(Effect.orDie)

  const largePatch = "x".repeat(32 * 1024)
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `cp_alpha_${String(i + 1).padStart(3, "0")}`,
    session_id: "ses_checkpoint_alpha" as any,
    ordinal: i + 1,
    kind: i === 4 ? "manual" : "turn",
    status: i === 8 ? "partial" : "ready",
    before_snapshot: `tree_before_${i + 1}`,
    after_snapshot: `tree_after_${i + 1}`,
    user_message_id: `msg_alpha_${i + 1}`,
    diff: [
      {
        path: RelativePath.make(i === 7 ? "src\\windows\\RareNeedle.ts" : `src/alpha/file-${i + 1}.ts`),
        status: "modified" as const,
        additions: i + 1,
        deletions: i,
        patch: largePatch,
      },
      {
        path: RelativePath.make(`docs/alpha/doc-${i + 1}.md`),
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        patch: largePatch,
      },
      {
        path: RelativePath.make(`tests/alpha/test-${i + 1}.ts`),
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        patch: largePatch,
      },
      {
        path: RelativePath.make(`extra/alpha/path-${i + 1}.txt`),
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        patch: largePatch,
      },
    ],
    additions: i + 4,
    deletions: i + 2,
    files: 4,
    epoch: "epoch-checkpoint-read",
    created_at: now + i,
    finalized_at: now + i,
  }))
  yield* db.insert(SessionCheckpointTable).values(rows).run().pipe(Effect.orDie)

  yield* db
    .insert(SessionCheckpointTable)
    .values({
      id: "cp_beta_001",
      session_id: "ses_checkpoint_beta" as any,
      ordinal: 1,
      kind: "turn",
      status: "ready",
      before_snapshot: "beta_before",
      after_snapshot: "beta_after",
      user_message_id: "msg_beta_1",
      diff: [
        {
          path: RelativePath.make("src/beta/foreign-hit.ts"),
          status: "added",
          additions: 9,
          deletions: 0,
          patch: largePatch,
        },
      ],
      additions: 9,
      deletions: 0,
      files: 1,
      epoch: "epoch-checkpoint-read",
      created_at: now + 100,
      finalized_at: now + 100,
    })
    .run()
    .pipe(Effect.orDie)
})

describe("Checkpoint.ReadService", () => {
  test("serves bounded summaries with stable session/worktree ordering and exact totals", async () => {
    await withCheckpointRead(
      Effect.gen(function* () {
        yield* seed()
        const checkpoint = yield* Checkpoint.ReadService
        const { readDb } = yield* Database.Service

        const session = yield* checkpoint.list({
          scope: { sessionID: "ses_checkpoint_alpha" },
          limit: 3,
        })
        expect(session.rows.map((row) => row.ordinal)).toEqual([1, 2, 3])
        expect(session.total).toBe(12)
        expect(session.rows[0]?.paths).toEqual([
          "src/alpha/file-1.ts",
          "docs/alpha/doc-1.md",
          "tests/alpha/test-1.ts",
        ])
        expect(Object.keys(session.rows[0] ?? {})).not.toContain("diff")

        const worktree = yield* checkpoint.list({
          scope: { epoch: "epoch-checkpoint-read" },
          limit: 3,
        })
        expect(worktree.rows.map((row) => row.id)).toEqual([
          "cp_beta_001",
          "cp_alpha_012",
          "cp_alpha_011",
        ])
        expect(worktree.total).toBe(13)

        const plan = yield* readDb
          .all<{ detail: string }>(
            sql`EXPLAIN QUERY PLAN
              SELECT id
              FROM session_checkpoint
              WHERE epoch = 'epoch-checkpoint-read'
              ORDER BY created_at DESC
              LIMIT 4`,
          )
          .pipe(Effect.orDie)
        expect(plan.some((row) => row.detail.includes("session_checkpoint_epoch_created_idx"))).toBe(true)
        expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
      }),
    )
  })

  test("search preserves path normalization, suffix semantics, scalar metadata, and projection updates", async () => {
    await withCheckpointRead(
      Effect.gen(function* () {
        yield* seed()
        const checkpoint = yield* Checkpoint.ReadService
        const { db, readDb } = yield* Database.Service

        const byWindowsPath = yield* checkpoint.search({
          scope: { epoch: "epoch-checkpoint-read" },
          touchedPath: "windows/RareNeedle.ts",
          limit: 10,
        })
        expect(byWindowsPath.rows.map((row) => row.id)).toEqual(["cp_alpha_008"])

        const byLongerSuffix = yield* checkpoint.search({
          scope: { epoch: "epoch-checkpoint-read" },
          touchedPath: "repo/src/windows/RareNeedle.ts",
          limit: 10,
        })
        expect(byLongerSuffix.rows.map((row) => row.id)).toEqual(["cp_alpha_008"])

        const byPathText = yield* checkpoint.search({
          scope: { epoch: "epoch-checkpoint-read" },
          query: "src/windows/rareneedle",
          limit: 10,
        })
        expect(byPathText.rows.map((row) => row.id)).toEqual(["cp_alpha_008"])

        const bySessionTitle = yield* checkpoint.search({
          scope: { epoch: "epoch-checkpoint-read" },
          query: "alpha search",
          limit: 2,
        })
        expect(bySessionTitle.rows.map((row) => row.ordinal)).toEqual([12, 11])
        expect(bySessionTitle.total).toBe(12)

        const projection = yield* readDb
          .get<{ paths: string }>(
            sql`SELECT paths FROM session_checkpoint_search WHERE checkpoint_id = 'cp_alpha_008'`,
          )
          .pipe(Effect.orDie)
        expect(projection?.paths).toContain("src/windows/RareNeedle.ts")
        expect(projection?.paths).not.toContain("\\")

        yield* db
          .update(SessionCheckpointTable)
          .set({
            diff: [
              {
                path: RelativePath.make("src/replaced/ProjectedNow.ts"),
                status: "modified",
                additions: 1,
                deletions: 1,
                patch: "",
              },
            ],
            files: 1,
          })
          .where(sql`${SessionCheckpointTable.id} = 'cp_alpha_008'`)
          .run()
          .pipe(Effect.orDie)

        const oldPath = yield* checkpoint.search({
          scope: { epoch: "epoch-checkpoint-read" },
          touchedPath: "RareNeedle.ts",
          limit: 10,
        })
        const newPath = yield* checkpoint.search({
          scope: { epoch: "epoch-checkpoint-read" },
          touchedPath: "replaced/ProjectedNow.ts",
          limit: 10,
        })
        expect(oldPath.rows).toHaveLength(0)
        expect(newPath.rows.map((row) => row.id)).toEqual(["cp_alpha_008"])
      }),
    )
  })

  test("point/detail helpers stay compact while view intentionally returns the full path detail", async () => {
    await withCheckpointRead(
      Effect.gen(function* () {
        yield* seed()
        const checkpoint = yield* Checkpoint.ReadService

        expect(yield* checkpoint.resolveSession("ses_checkpoint_alpha")).toEqual(["ses_checkpoint_alpha"])
        expect(yield* checkpoint.resolveCheckpoint("cp_beta_001")).toHaveLength(1)
        expect((yield* checkpoint.targetByOrdinal("ses_checkpoint_alpha", 5))?.id).toBe("cp_alpha_005")
        expect(yield* checkpoint.ordinals("ses_checkpoint_beta")).toEqual([1])

        const first = yield* checkpoint.firstSnapshots("ses_checkpoint_alpha")
        expect(first).toEqual({ beforeSnapshot: "tree_before_1", afterSnapshot: "tree_after_1" })

        const view = yield* checkpoint.view("cp_alpha_001")
        expect(view?.paths).toEqual([
          "src/alpha/file-1.ts",
          "docs/alpha/doc-1.md",
          "tests/alpha/test-1.ts",
          "extra/alpha/path-1.txt",
        ])

        expect(yield* checkpoint.worktreeStats("epoch-checkpoint-read", "ses_checkpoint_alpha")).toEqual({
          checkpoints: 1,
          sessions: 1,
        })
        expect(
          yield* checkpoint.siblingSessionIDs("epoch-checkpoint-read", ["ses_checkpoint_alpha"]),
        ).toEqual(["ses_checkpoint_beta"])
      }),
    )
  })

  test("interactive checkpoint reads bypass the foreground writer permit", async () => {
    await withCheckpointRead(
      Effect.gen(function* () {
        yield* seed()
        const checkpoint = yield* Checkpoint.ReadService
        const { db } = yield* Database.Service
        const writerEntered = yield* Deferred.make<void>()
        const releaseWriter = yield* Deferred.make<void>()

        const writer = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.run(sql`UPDATE session_checkpoint SET status = 'capturing' WHERE id = 'cp_alpha_001'`)
              yield* Deferred.succeed(writerEntered, undefined)
              yield* Deferred.await(releaseWriter)
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(writerEntered)

        const read = yield* checkpoint
          .list({
            scope: { sessionID: "ses_checkpoint_alpha" },
            limit: 2,
          })
          .pipe(Effect.forkScoped)
        const completedBeforeWriter = yield* Effect.race(
          Fiber.await(read).pipe(Effect.as(true)),
          Effect.sleep("50 millis").pipe(Effect.as(false)),
        )
        expect(completedBeforeWriter).toBe(true)
        expect((yield* Fiber.join(read)).rows[0]?.status).toBe("ready")

        yield* Deferred.succeed(releaseWriter, undefined)
        yield* Fiber.join(writer)
      }),
    )
  })
})

describe("checkpoint read projection migration", () => {
  const runMigration = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
        Effect.scoped,
      ),
    )

  test("backfills historical paths, normalizes separators, builds FTS, and repairs supplements", async () => {
    await runMigration(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE session_checkpoint (
            id text PRIMARY KEY,
            diff text,
            epoch text NOT NULL,
            created_at integer NOT NULL
          )
        `)
        const legacyDiff = JSON.stringify([
          {
            path: "src\\legacy\\Needle.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "payload",
          },
        ])
        yield* db.run(sql`
          INSERT INTO session_checkpoint (id, diff, epoch, created_at)
          VALUES ('cp_legacy', ${legacyDiff}, 'epoch-legacy', 1)
        `)

        yield* DatabaseMigration.applyOnly(db, [checkpointReadProjectionMigration])

        expect(
          yield* db.get<{ paths: string }>(
            sql`SELECT paths FROM session_checkpoint_search WHERE checkpoint_id = 'cp_legacy'`,
          ),
        ).toEqual({ paths: "src/legacy/Needle.ts" })
        expect(
          yield* db.get<{ name: string }>(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_checkpoint_search_fts'`,
          ),
        ).toEqual({ name: "session_checkpoint_search_fts" })
        expect(
          yield* db.get<{ name: string }>(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_checkpoint_epoch_created_idx'`,
          ),
        ).toEqual({ name: "session_checkpoint_epoch_created_idx" })
        expect(
          yield* db.all<{ checkpoint_id: string }>(sql`
            SELECT search.checkpoint_id
            FROM session_checkpoint_search_fts
            JOIN session_checkpoint_search search ON search.rowid = session_checkpoint_search_fts.rowid
            WHERE session_checkpoint_search_fts MATCH '"legacy/needle"'
          `),
        ).toEqual([{ checkpoint_id: "cp_legacy" }])

        yield* db.run(sql`DROP TRIGGER session_checkpoint_search_fts_ai`)
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'session_checkpoint_search_fts_ai'`,
          ),
        ).toBeUndefined()

        // The migration is already journaled; applyOnly must still execute its
        // reconcile hook and recreate supplemental FTS objects.
        yield* DatabaseMigration.applyOnly(db, [checkpointReadProjectionMigration])
        expect(
          yield* db.get<{ name: string }>(
            sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'session_checkpoint_search_fts_ai'`,
          ),
        ).toEqual({ name: "session_checkpoint_search_fts_ai" })
      }),
    )
  })
})
