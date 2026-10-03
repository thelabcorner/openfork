export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

const LEGACY_DIRECTORY_GUARD_MIGRATION = "20260924022626_directory_maintenance_guard"
const DIRECTORY_GUARD_MIGRATION = "20260924042906_directory_maintenance_guard"

const legacyDirectoryGuardColumns = [
  "directory",
  "guard_id",
  "owner_id",
  "generation",
  "state",
  "acquired_at",
  "released_at",
  "updated_at",
] as const

const canonicalDirectoryGuardColumns = [
  "directory",
  "guard_id",
  "owner_id",
  "acquisition_id",
  "generation",
  "state",
  "acquired_at",
  "released_at",
  "updated_at",
] as const

function sameColumns(actual: readonly string[], expected: readonly string[]) {
  if (actual.length !== expected.length) return false
  const left = [...actual].sort()
  const right = [...expected].sort()
  return left.every((value, index) => value === right[index])
}

/**
 * One pre-release database shape briefly shipped in the live dev channel with
 * the predecessor migration id above. It predates acquisition_id, so replaying
 * the canonical CREATE migration cannot work and, more importantly, blindly
 * inventing an active acquisition would weaken the guard's authority model.
 *
 * Preserve every row and fail closed instead: released rows remain released;
 * any held legacy row becomes reconcile_required under a deterministic,
 * per-directory legacy acquisition identity. The target migration is journaled
 * only after this transaction has produced the canonical table shape.
 */
function convergeLegacyDirectoryMaintenanceGuard(tx: Transaction) {
  return Effect.gen(function* () {
    const table = yield* tx.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'directory_maintenance_guard'",
    )
    if (!table) {
      return yield* Effect.die(
        new Error(
          LEGACY_DIRECTORY_GUARD_MIGRATION +
            " is journaled but directory_maintenance_guard is missing",
        ),
      )
    }

    const columns = (
      yield* tx.all<{ name: string }>(
        "SELECT name FROM pragma_table_info('directory_maintenance_guard')",
      )
    ).map((column) => column.name)

    if (sameColumns(columns, canonicalDirectoryGuardColumns)) return
    if (!sameColumns(columns, legacyDirectoryGuardColumns)) {
      return yield* Effect.die(
        new Error(
          "Cannot converge unknown directory_maintenance_guard predecessor shape: " +
            columns.join(","),
        ),
      )
    }

    yield* tx.run(
      "ALTER TABLE directory_maintenance_guard RENAME TO directory_maintenance_guard_legacy_20260924",
    )
    yield* tx.run(
      "CREATE TABLE directory_maintenance_guard (" +
        "directory text PRIMARY KEY," +
        "guard_id text NOT NULL," +
        "owner_id text NOT NULL," +
        "acquisition_id text NOT NULL," +
        "generation integer NOT NULL," +
        "state text NOT NULL," +
        "acquired_at integer NOT NULL," +
        "released_at integer," +
        "updated_at integer NOT NULL," +
        "CONSTRAINT fk_directory_maintenance_guard_owner_id_runtime_owner_id_fk " +
          "FOREIGN KEY (owner_id) REFERENCES runtime_owner(id)," +
        "CONSTRAINT directory_maintenance_guard_state_check " +
          "CHECK(state in ('active', 'released', 'reconcile_required'))," +
        "CONSTRAINT directory_maintenance_guard_release_check " +
          "CHECK((state = 'released' and released_at is not null) " +
            "or (state <> 'released' and released_at is null))," +
        "CONSTRAINT directory_maintenance_guard_acquisition_check " +
          "CHECK(length(acquisition_id) > 0)" +
      ")",
    )
    yield* tx.run(
      "INSERT INTO directory_maintenance_guard (" +
        "directory,guard_id,owner_id,acquisition_id,generation,state," +
        "acquired_at,released_at,updated_at" +
      ") SELECT " +
        "directory,guard_id,owner_id," +
        "'directory-maintenance:legacy:' || lower(hex(directory))," +
        "generation," +
        "CASE WHEN state = 'released' THEN 'released' ELSE 'reconcile_required' END," +
        "acquired_at,released_at,updated_at " +
      "FROM directory_maintenance_guard_legacy_20260924",
    )
    // The renamed predecessor still owns the globally named legacy indexes.
    // Drop it only after the data copy, then recreate indexes on the canonical
    // table under their stable names.
    yield* tx.run("DROP TABLE directory_maintenance_guard_legacy_20260924")
    yield* tx.run(
      "CREATE INDEX directory_maintenance_guard_guard_idx " +
        "ON directory_maintenance_guard (guard_id,state)",
    )
    yield* tx.run(
      "CREATE INDEX directory_maintenance_guard_owner_idx " +
        "ON directory_maintenance_guard (owner_id,state)",
    )
    yield* tx.run(
      "CREATE INDEX directory_maintenance_guard_acquisition_idx " +
        "ON directory_maintenance_guard (acquisition_id,state)",
    )
  })
}

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
  [
    "20260924060000_directory_maintenance_guard_triggers",
    new Map([
      // Pre-release hardening repair: a database that already reconciled the
      // first (generation-too-strict, REPLACE-bypassable) trigger definitions
      // while this migration was uncommitted journaled the replaced source.
      // Only this exact stale pair is repaired; any other value still dies.
      [
        "d18299abd87cd4d189e1359ea07de03bdfc7513d709af8bc54fb76a60b0ba40d",
        "dcc9e91d342605b0f833eebcd812daaf69e067f284b7c3d4c70567c40d16db93",
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

    const directoryGuardTarget = byID.get(DIRECTORY_GUARD_MIGRATION)
    if (
      directoryGuardTarget &&
      completed.has(LEGACY_DIRECTORY_GUARD_MIGRATION) &&
      !completed.has(DIRECTORY_GUARD_MIGRATION)
    ) {
      if (!directoryGuardTarget.checksum) {
        return yield* Effect.die(
          new Error(
            "Legacy directory-maintenance-guard convergence requires the canonical target checksum",
          ),
        )
      }
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* convergeLegacyDirectoryMaintenanceGuard(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed, checksum)
                VALUES (${directoryGuardTarget.id}, ${Date.now()}, ${directoryGuardTarget.checksum})`,
          )
        }),
      )
      completed.add(DIRECTORY_GUARD_MIGRATION)
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
