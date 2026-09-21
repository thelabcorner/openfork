export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

// The initial checksum rollout (5489cd7531) committed two registry fingerprints
// that did not match the exact tracked migration source bytes. Databases opened
// by that build correctly persisted those generated values, so treat only these
// exact stale -> canonical pairs as journal metadata repairs. The canonical hash
// is part of the match on purpose: any later source mutation still fails closed.
const checksumCorrections = new Map<string, ReadonlyMap<string, string>>([
  [
    "20260919235500_oxp_parent_activity",
    new Map([
      [
        "357ae708c1e188cd672b39bbac599ab1a6c2d6851bd8774015518cdf080c479c",
        "e010f3f0a9b9e5b457e5e38cc91dcb08e3555d02b9fc5753434abdc5461d13ef",
      ],
    ]),
  ],
  [
    "20260920034100_schema_convergence",
    new Map([
      [
        "b2ef21144060c67f7a5d9f33c97c83e5fa186357464f354b230b9ee8aacda23c",
        "b757a6bd6c240aea8dba0bb88abffeefd13fe6690759c4166ebe5d2b1735ab56",
      ],
    ]),
  ],
])

export type Migration = {
  id: string
  /**
   * SHA-256 of the tracked migration source, injected by migration.gen.ts.
   * Directly imported migrations used by focused tests may omit it, but the
   * production registry fingerprints every migration so completed history is
   * immutable rather than merely identified by filename.
   */
  checksum?: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
  // Idempotent DDL for objects drizzle-kit cannot express (FTS5 virtual tables,
  // triggers). Fresh databases are built from the generated full schema and
  // pre-journal every migration id WITHOUT executing it, so anything that only
  // lives in up() never gets created there; reconcile runs on every open so
  // those objects exist (or are repaired) regardless of how the database was
  // born.
  reconcile?: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* reconcileSupplements(tx, migrations)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL, checksum TEXT)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed, checksum) VALUES (${migration.id}, ${Date.now()}, ${migration.checksum ?? null})`,
            ),
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL, checksum TEXT)`,
    )
    const journalColumns = yield* db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('migration')`,
    )
    if (!journalColumns.some((column) => column.name === "checksum")) {
      yield* db.run(sql`ALTER TABLE ${sql.identifier("migration")} ADD COLUMN checksum TEXT`)
    }
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        const named = (yield* db.all<{ name: string }>(
          sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`,
        )).some((column) => column.name === "name")

        if (named) {
          yield* db.run(sql`
            INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
            SELECT name, ${Date.now()}
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE name IS NOT NULL
          `)
        }

        if (!named) {
          const entries = yield* db.all<{ created_at: number; prefix: string | null }>(sql`
            SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE created_at IS NOT NULL
          `)

          for (const entry of entries) {
            const migration = input.find((item) => item.id.startsWith(`${entry.prefix}_`))
            if (!migration) {
              return yield* Effect.die(
                new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`),
              )
            }
            yield* db.run(sql`
              INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
              VALUES (${migration.id}, ${Date.now()})
            `)
          }
        }
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    // A migration id is not sufficient proof of history: if the source behind
    // an already-completed id changes, silently trusting the journal can leave
    // the database claiming a schema transition that no longer corresponds to
    // the code being shipped. Legacy rows predate checksums and are enrolled
    // once against the current tracked source; after that any mutation fails
    // closed before new migrations execute.
    const journal = yield* db.all<{ id: string; checksum: string | null }>(
      sql`SELECT id, checksum FROM ${sql.identifier("migration")}`,
    )
    const byID = new Map(input.map((migration) => [migration.id, migration]))
    for (const row of journal) {
      const migration = byID.get(row.id)
      if (!migration?.checksum) continue
      if (row.checksum && row.checksum !== migration.checksum) {
        const corrected = checksumCorrections.get(row.id)?.get(row.checksum)
        if (corrected === migration.checksum) {
          yield* db.run(
            sql`UPDATE ${sql.identifier("migration")} SET checksum = ${migration.checksum} WHERE id = ${row.id} AND checksum = ${row.checksum}`,
          )
          continue
        }
        return yield* Effect.die(
          new Error(
            `Migration checksum mismatch for ${row.id}: database=${row.checksum} source=${migration.checksum}`,
          ),
        )
      }
      if (!row.checksum) {
        yield* db.run(
          sql`UPDATE ${sql.identifier("migration")} SET checksum = ${migration.checksum} WHERE id = ${row.id} AND checksum IS NULL`,
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed, checksum) VALUES (${migration.id}, ${Date.now()}, ${migration.checksum ?? null})`,
          )
        }),
      )
    }

    // Self-heal: databases whose journal already claims a reconcile migration
    // (e.g. created from the generated full schema before the objects existed)
    // get their supplements created here. All statements are IF NOT EXISTS, so
    // this is a cheap no-op for healthy databases.
    if (input.some(hasReconcile)) {
      yield* db.transaction((tx) => reconcileSupplements(tx, input))
    }
  })
}

function hasReconcile(migration: Migration): migration is Migration & Required<Pick<Migration, "reconcile">> {
  return migration.reconcile !== undefined
}

function reconcileSupplements(tx: Transaction, input: Migration[]) {
  return Effect.forEach(input.filter(hasReconcile), (migration) => migration.reconcile(tx)).pipe(Effect.asVoid)
}
