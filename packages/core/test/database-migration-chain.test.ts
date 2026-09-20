import { Database as BunDatabase } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { Effect } from "effect"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

function build(filename: string, mode: "fresh" | "chain") {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      if (mode === "fresh") yield* DatabaseMigration.apply(db)
      else yield* DatabaseMigration.applyOnly(db, migrations)
    }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
  )
}

type ColumnShape = {
  type: string
  notnull: number
  default: string | null
  pk: number
}

const query = <T>(db: BunDatabase, source: string) => db.query(source).all() as T[]
const escape = (value: string) => value.replaceAll("'", "''")
const normalizeDefault = (value: string | null) => (value === "false" ? "0" : value === "true" ? "1" : value)

function names(db: BunDatabase, type: "table" | "index" | "trigger") {
  return query<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map((row) => row.name)
}

function columns(db: BunDatabase, table: string) {
  return Object.fromEntries(
    query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(
      db,
      `PRAGMA table_info('${escape(table)}')`,
    )
      .map(
        (row) =>
          [
            row.name,
            {
              type: row.type,
              // INTEGER PRIMARY KEY is SQLite's ROWID alias. Even when
              // table_info reports notnull=0, a NULL insert allocates a ROWID
              // rather than storing NULL, so explicit NOT NULL does not change
              // the persisted invariant. Do not normalize TEXT primary keys:
              // SQLite really can store NULL there unless NOT NULL is explicit.
              notnull: row.notnull || (row.pk > 0 && row.type.toUpperCase() === "INTEGER") ? 1 : 0,
              default: normalizeDefault(row.dflt_value),
              pk: row.pk,
            },
          ] as const,
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, ColumnShape>
}

function foreignKeys(db: BunDatabase, table: string) {
  return query<{
    table: string
    from: string
    to: string
    on_update: string
    on_delete: string
    match: string
  }>(db, `PRAGMA foreign_key_list('${escape(table)}')`)
    .map((row) => ({
      table: row.table,
      from: row.from,
      to: row.to,
      onUpdate: row.on_update,
      onDelete: row.on_delete,
      match: row.match,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function indexShape(db: BunDatabase, name: string) {
  const escapedName = escape(name)
  const row = query<{ tbl_name: string; sql: string | null }>(
    db,
    `SELECT tbl_name, sql FROM sqlite_master WHERE type='index' AND name='${escapedName}'`,
  )[0]
  if (!row) return null
  const flags = query<{ unique: number; partial: number }>(
    db,
    `SELECT "unique", partial FROM pragma_index_list('${escape(row.tbl_name)}') WHERE name='${escapedName}'`,
  )[0]
  const info = query<{ seqno: number; name: string | null; desc: number; coll: string; key: number }>(
    db,
    `PRAGMA index_xinfo('${escapedName}')`,
  ).map((entry) => ({
    seqno: entry.seqno,
    name: entry.name,
    desc: entry.desc,
    coll: entry.coll,
    key: entry.key,
  }))
  const where = row.sql?.toLowerCase().split(/\bwhere\b/, 2)[1]?.replace(/["`\s]/g, "") ?? ""
  const normalizedWhere = where.replaceAll(`${row.tbl_name.toLowerCase()}.`, "")
  return { unique: flags?.unique ?? null, partial: flags?.partial ?? null, info, where: normalizedWhere }
}

function triggerShape(db: BunDatabase, name: string) {
  const sql = query<{ sql: string | null }>(
    db,
    `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='${escape(name)}'`,
  )[0]?.sql
  return sql?.replace(/["`\s;]/g, "").toLowerCase() ?? null
}

function databaseShape(db: BunDatabase) {
  const tables = names(db, "table")
  const indexes = names(db, "index")
  const triggers = names(db, "trigger")
  return {
    tables: Object.fromEntries(
      tables.map((table) => [table, { columns: columns(db, table), foreignKeys: foreignKeys(db, table) }]),
    ),
    indexes: Object.fromEntries(indexes.map((name) => [name, indexShape(db, name)])),
    triggers: Object.fromEntries(triggers.map((name) => [name, triggerShape(db, name)])),
  }
}

describe("database migration chain", () => {
  test("uses a unique durable timestamp prefix for every tracked migration", () => {
    const seen = new Map<string, string>()
    for (const migration of migrations) {
      const match = /^(\d{14})_.+$/.exec(migration.id)
      expect(match, "invalid migration id: " + migration.id).not.toBeNull()
      const timestamp = match![1]!
      const previous = seen.get(timestamp)
      expect(
        previous,
        "duplicate migration timestamp " + timestamp + ": " + previous + " and " + migration.id,
      ).toBeUndefined()
      seen.set(timestamp, migration.id)
    }
  })

  test("converges structurally with a fresh generated-schema install", async () => {
    await using tmp = await tmpdir()
    const freshPath = path.join(tmp.path, "fresh.sqlite")
    const chainPath = path.join(tmp.path, "chain.sqlite")

    await build(freshPath, "fresh")
    await build(chainPath, "chain")

    const fresh = new BunDatabase(freshPath, { readonly: true })
    const chain = new BunDatabase(chainPath, { readonly: true })
    try {
      expect(query(fresh, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }])
      expect(query(chain, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }])
      expect(query(fresh, "PRAGMA foreign_key_check")).toEqual([])
      expect(query(chain, "PRAGMA foreign_key_check")).toEqual([])
      expect(databaseShape(chain)).toEqual(databaseShape(fresh))
    } finally {
      fresh.close()
      chain.close()
    }
  }, 30_000)
})
