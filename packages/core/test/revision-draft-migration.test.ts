import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import revisionDraftMigration from "@opencode-ai/core/database/migration/20260920002000_revision_draft"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("RevisionDraft migration", () => {
  test("creates the durable mailbox, generation fence, and unique target index on upgrade", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.applyOnly(db, [revisionDraftMigration])

        expect(
          yield* db.all<{ name: string }>(
            sql`SELECT name
                FROM sqlite_master
                WHERE type = 'table'
                  AND name IN ('revision_draft', 'revision_draft_claim')
                ORDER BY name`,
          ),
        ).toEqual([{ name: "revision_draft" }, { name: "revision_draft_claim" }])

        expect(
          yield* db.get<{ name: string }>(
            sql`SELECT name
                FROM sqlite_master
                WHERE type = 'index'
                  AND name = 'revision_draft_target_idx'`,
          ),
        ).toEqual({ name: "revision_draft_target_idx" })

        expect(
          yield* db.all<{ name: string }>(sql`SELECT name FROM pragma_index_info('revision_draft_target_idx') ORDER BY seqno`),
        ).toEqual([{ name: "target_kind" }, { name: "target_key" }])

        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${revisionDraftMigration.id}`)).toEqual({
          id: revisionDraftMigration.id,
        })
      }),
    )
  })

  test("reconciles safely when an existing journal already claims the migration", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO migration (id, time_completed) VALUES (${revisionDraftMigration.id}, 1)`,
        )

        yield* DatabaseMigration.applyOnly(db, [revisionDraftMigration])

        expect(
          yield* db.all<{ name: string }>(
            sql`SELECT name
                FROM sqlite_master
                WHERE type = 'table'
                  AND name IN ('revision_draft', 'revision_draft_claim')
                ORDER BY name`,
          ),
        ).toEqual([{ name: "revision_draft" }, { name: "revision_draft_claim" }])

        // Re-open/reconcile semantics must stay idempotent.
        yield* DatabaseMigration.applyOnly(db, [revisionDraftMigration])
        expect(yield* db.get(sql`SELECT COUNT(*) AS count FROM revision_draft`)).toEqual({ count: 0 })
        expect(yield* db.get(sql`SELECT COUNT(*) AS count FROM revision_draft_claim`)).toEqual({ count: 0 })
      }),
    )
  })
})
