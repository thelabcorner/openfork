import { Effect, Schema } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { NonNegativeInt, optional } from "@opencode-ai/core/schema"
import * as Core from "./sqlite/core"
import DESCRIPTION from "./sqlite.txt"

// Runtime detection: Bun reports process.versions.bun even though
// process.release.name is "node". Electron's Node sidecar must not be
// mistaken for Bun.
const isBun =
  typeof process === "object" &&
  typeof process.versions?.electron !== "string" &&
  typeof process.versions?.bun === "string"

type UnifiedStatement = {
  readonly columnNames: string[]
  readonly columnTypes: Array<string | null | undefined>
  iterate(...params: Array<string | number | boolean | null>): Iterable<Record<string, unknown>>
  all(...params: Array<string | number | boolean | null>): Array<Record<string, unknown>>
  get(...params: Array<string | number | boolean | null>): Record<string, unknown> | undefined
  run(...params: Array<string | number | boolean | null>): { changes: number; lastInsertRowid: number | bigint }
}
type UnifiedDatabase = {
  exec(sql: string): void
  prepare(sql: string): UnifiedStatement
  query(sql: string): {
    get(...params: Array<string | number | boolean | null>): Record<string, unknown> | undefined
    all(...params: Array<string | number | boolean | null>): Array<Record<string, unknown>>
  }
  close(): void
}
// Keep old names as aliases so the rest of the file needs no churn
type Database = UnifiedDatabase
type Statement = UnifiedStatement

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 5000
const RENDER_BYTE_CAP = 50 * 1024
const SCHEMA_BYTE_CAP = 50 * 1024
// The EXPLAIN detail column is the useful output (design §5.5); give it a
// wider cell cap than the default 40 so longer query plans stay readable.
const EXPLAIN_CELL_WIDTH = 120
const DEFAULT_EXPORT_MAX_ROWS = 1_000_000
const DEFAULT_EXPORT_MAX_BYTES = 50 * 1024 * 1024
const MAX_ATTACH = 8

export const Parameters = Schema.Struct({
  action: Schema.Literals(["tables", "schema", "query", "run", "explain", "export"]).annotate({
    description: "What to do: 'tables' lists tables/views, 'schema' shows DDL, 'query' runs a read-only SELECT, 'run' executes writes/DDL transactionally, 'explain' shows the query plan, 'export' writes a query result to a CSV/JSON file",
  }),
  db: Schema.String.annotate({
    description: "Path to the SQLite database file (relative to the working directory or absolute)",
  }),
  attach: optional(Schema.Array(Schema.String)).annotate({
    description: "Optional extra database files to ATTACH (aliased attach0, attach1, ...; reference as attachN.<table>)",
  }),
  table: optional(Schema.String).annotate({
    description: "Table name for the 'schema' action (omit for the whole-database schema)",
  }),
  sql: optional(Schema.String).annotate({
    description: "SQL statement for 'query' / 'run' / 'explain' / 'export' (one statement per call)",
  }),
  params: optional(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]))).annotate({
    description: "Positional parameters bound to '?' placeholders (strings bind as TEXT; use X'...' literals for BLOBs)",
  }),
  dryRun: optional(Schema.Boolean).annotate({
    description: "For 'run': execute inside a transaction and roll back (default true). false commits.",
  }),
  limit: optional(NonNegativeInt).annotate({
    description: "Maximum rows to render (default 200, max 5000)",
  }),
  format: optional(Schema.Literals(["csv", "json"])).annotate({
    description: "Export file format (default csv)",
  }),
  outputPath: optional(Schema.String).annotate({
    description: "Required for 'export': destination file path (relative to the working directory or absolute)",
  }),
  overwrite: optional(Schema.Boolean).annotate({
    description: "For 'export': allow overwriting an existing file (default false)",
  }),
  maxRows: optional(NonNegativeInt).annotate({
    description: "For 'export': safety cap on rows written (default 1,000,000)",
  }),
  maxBytes: optional(NonNegativeInt).annotate({
    description: "For 'export': safety cap on output bytes (default 50 MB)",
  }),
})

type Metadata = {
  action: string
  db: string
  rows: number
  truncated: boolean
  elapsedMs: number
  changes?: number
  lastInsertRowid?: number
  dryRun?: boolean
  rolledBack?: boolean
  destructive?: boolean
  tables?: number
  views?: number
  format?: string
  bytes?: number
  outputPath?: string
}

type Resolved = {
  abs: string
  rel: string
}

type ConnectionMode = "readonly" | "query_only" | "readwrite"

const resolvePath = (instance: { directory: string; worktree: string }, p: string): Resolved => {
  const abs = path.isAbsolute(p) ? p : path.join(instance.directory, p)
  const normalized = process.platform === "win32" ? FSUtil.normalizePath(abs) : abs
  const rel = path.relative(instance.worktree, normalized).split(path.sep).join("/")
  return { abs: normalized, rel }
}

const validatePath = (abs: string, label: string) => {
  if (abs === ":memory:" || abs === "") throw new Error(`${label}: in-memory databases are not supported`)
  if (abs.includes("\0")) throw new Error(`${label}: NUL bytes are not allowed in paths`)
  if (path.basename(abs).startsWith("-")) throw new Error(`${label}: paths starting with '-' are rejected`)
}

const readHeader = async (abs: string): Promise<{ ok: boolean; hex: string }> => {
  const handle = await fs.open(abs, "r")
  try {
    const buf = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buf, 0, 16, 0)
    const hex = buf.subarray(0, bytesRead).toString("hex")
    return { ok: Core.isSqliteHeader(new Uint8Array(buf.subarray(0, bytesRead))), hex }
  } finally {
    await handle.close()
  }
}

const requireDbFile = Effect.fn("SqliteTool.requireDbFile")(function* (resolved: Resolved) {
  const stat = yield* Effect.promise(() => fs.stat(resolved.abs).catch(() => undefined))
  if (!stat) throw new Error(`Database file not found: ${resolved.rel}`)
  if (stat.isDirectory()) throw new Error(`Not a database: ${resolved.rel} is a directory`)
  const header = yield* Effect.promise(() => readHeader(resolved.abs))
  if (!header.ok) {
    throw new Error(
      `Not a SQLite database: ${resolved.rel} (first bytes ${header.hex || "(empty)"}; expected 'SQLite format 3')`,
    )
  }
  return stat
})

const readAsk = Effect.fn("SqliteTool.readAsk")(function* (ctx: Tool.Context, resolved: Resolved) {
  yield* ctx.ask({
    permission: "read",
    patterns: [resolved.rel],
    always: ["*"],
    metadata: { filepath: resolved.abs },
  })
  yield* assertExternalDirectoryEffect(ctx, resolved.abs, { kind: "file" })
})

const wrapBunStatement = (stmt: import("bun:sqlite").Statement): UnifiedStatement => {
  const getColumnNames = () => stmt.columnNames as string[]
  const getColumnTypes = (): Array<string | null | undefined> => {
    try {
      return stmt.columnTypes as Array<string | null | undefined>
    } catch {
      return getColumnNames().map(() => null)
    }
  }
  return {
    get columnNames() {
      return getColumnNames()
    },
    get columnTypes() {
      return getColumnTypes()
    },
    iterate: (...params: Array<string | number | boolean | null>) => stmt.iterate(...params) as Iterable<Record<string, unknown>>,
    all: (...params: Array<string | number | boolean | null>) => stmt.all(...params) as Array<Record<string, unknown>>,
    get: (...params: Array<string | number | boolean | null>) => stmt.get(...params) as Record<string, unknown> | undefined,
    run: (...params: Array<string | number | boolean | null>) => {
      const r = stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint }
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
    },
  }
}

const wrapBunDatabase = (db: import("bun:sqlite").Database): UnifiedDatabase => ({
  exec: (sql: string) => db.exec(sql),
  prepare: (sql: string) => wrapBunStatement(db.prepare(sql)),
  query: (sql: string) => {
    const q = db.query(sql) as { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
    return {
      get: (...params: Array<string | number | boolean | null>) => q.get(...params) as Record<string, unknown> | undefined,
      all: (...params: Array<string | number | boolean | null>) => q.all(...params) as Array<Record<string, unknown>>,
    }
  },
  close: () => db.close(),
})

type NodeStatement = {
  columns(): Array<{ column: string; name: string; type: string | null }>
  iterate(...params: unknown[]): Iterable<Record<string, unknown>>
  all(...params: unknown[]): Array<Record<string, unknown>>
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
}
type NodeDatabaseSync = {
  exec(sql: string): void
  prepare(sql: string): NodeStatement
  close(): void
}

const wrapNodeStatement = (stmt: NodeStatement): UnifiedStatement => ({
  get columnNames() {
    return stmt.columns().map((c) => c.name)
  },
  get columnTypes() {
    return stmt.columns().map((c) => c.type as string | null | undefined)
  },
  iterate: (...params: Array<string | number | boolean | null>) => stmt.iterate(...(params as unknown[])) as Iterable<Record<string, unknown>>,
  all: (...params: Array<string | number | boolean | null>) => stmt.all(...(params as unknown[])) as Array<Record<string, unknown>>,
  get: (...params: Array<string | number | boolean | null>) => stmt.get(...(params as unknown[])) as Record<string, unknown> | undefined,
  run: (...params: Array<string | number | boolean | null>) => {
    const r = stmt.run(...(params as unknown[])) as { changes: number; lastInsertRowid: number | bigint }
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
  },
})

const wrapNodeDatabase = (db: NodeDatabaseSync): UnifiedDatabase => ({
  exec: (sql: string) => db.exec(sql),
  prepare: (sql: string) => wrapNodeStatement(db.prepare(sql)),
  query: (sql: string) => {
    const stmt = db.prepare(sql)
    return {
      get: (...params: Array<string | number | boolean | null>) => stmt.get(...(params as unknown[])) as Record<string, unknown> | undefined,
      all: (...params: Array<string | number | boolean | null>) => stmt.all(...(params as unknown[])) as Array<Record<string, unknown>>,
    }
  },
  close: () => db.close(),
})

const openConnection = (abs: string, mode: ConnectionMode, attaches: Resolved[]) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      if (isBun) {
        const bunSqliteSpecifier = "bun:" + "sqlite"
        const { Database } = await import(bunSqliteSpecifier)
        const opts =
          mode === "readonly"
            ? { readonly: true as const }
            : { readwrite: true as const, create: mode === "readwrite" }
        const db = new Database(abs, opts)
        db.exec("PRAGMA busy_timeout = 5000")
        for (let i = 0; i < attaches.length; i++) {
          db.prepare("ATTACH DATABASE ? AS " + Core.attachAlias(i)).run(attaches[i].abs)
        }
        if (mode === "query_only") db.exec("PRAGMA query_only = ON")
        return wrapBunDatabase(db)
      }
      // Node 22+ fallback: `node:sqlite` (DatabaseSync)
      let NodeDatabaseSync: new (path: string, opts?: unknown) => NodeDatabaseSync
      try {
        const mod = await import("node:sqlite")
        NodeDatabaseSync = (mod as { DatabaseSync: new (path: string, opts?: unknown) => NodeDatabaseSync }).DatabaseSync
      } catch (e) {
        throw new Error(
          `SQLite tool: no suitable driver found (tried bun:sqlite and node:sqlite). Under Node, requires Node 22+ with --experimental-vm-modules or install Bun (https://bun.sh). Cause: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      const opts = mode === "readonly" ? { readOnly: true } : { readOnly: false }
      // `node:sqlite` will create the file if readOnly is false; for
      // readonly/query_only the file must already exist (checked by requireDbFile
      // or the run-path mkdir logic).
      const db = new NodeDatabaseSync(abs, opts)
      db.exec("PRAGMA busy_timeout = 5000")
      for (let i = 0; i < attaches.length; i++) {
        db.prepare("ATTACH DATABASE ? AS " + Core.attachAlias(i)).run(attaches[i].abs)
      }
      if (mode === "query_only") db.exec("PRAGMA query_only = ON")
      return wrapNodeDatabase(db)
    }),
    (db) => Effect.sync(() => db.close()),
  )

const withConnection = <A>(
  abs: string,
  mode: ConnectionMode,
  attaches: Resolved[],
  fn: (db: Database) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* openConnection(abs, mode, attaches)
      return yield* fn(db)
    }),
  )

type Collected = {
  rows: Array<Array<unknown>>
  total: number
  truncated: boolean
}

const cellBytes = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  if (typeof v === "bigint") return String(v).length
  if (v instanceof Uint8Array) return v.length + 8
  return String(v).length + 1
}

// Pull rows lazily via stmt.iterate(), stopping at `limit` rows or `byteCap`
// rendered bytes. `total` counts rows seen; truncated=true when a cap was hit.
const collectRows = (
  stmt: Statement,
  params: ReadonlyArray<string | number | boolean | null>,
  limit: number,
  byteCap: number,
): Collected => {
  const columns = stmt.columnNames
  const rows: Array<Array<unknown>> = []
  let bytes = 0
  let total = 0
  for (const row of stmt.iterate(...params)) {
    total++
    const values = columns.map((c) => (row as Record<string, unknown>)[c])
    const rowBytes = values.reduce<number>((acc, v) => acc + cellBytes(v), 4)
    if (rows.length >= limit || bytes + rowBytes > byteCap) {
      return { rows, total, truncated: true }
    }
    rows.push(values)
    bytes += rowBytes
  }
  return { rows, total, truncated: false }
}

// bun:sqlite throws when reading columnTypes off a non-read statement
// (INSERT/UPDATE/DELETE, even with RETURNING). Fall back to null types so
// rendering just left-aligns cells.
const safeColumnTypes = (stmt: Statement): Array<string | null | undefined> => {
  try {
    return stmt.columnTypes
  } catch {
    return stmt.columnNames.map(() => null)
  }
}

const runStatement = (
  db: Database,
  stmt: Statement,
  params: ReadonlyArray<string | number | boolean | null>,
  limit: number,
): { collected: Collected; changes: number; lastInsertRowid: number } => {
  const rowReturning = stmt.columnNames.length > 0
  if (rowReturning) {
    const collected = collectRows(stmt, params, limit, RENDER_BYTE_CAP)
    const eff = db.query("SELECT changes() AS c, last_insert_rowid() AS id").get() as {
      c: number
      id: number
    }
    return { collected, changes: eff.c, lastInsertRowid: eff.id }
  }
  const r = stmt.run(...params)
  return { collected: { rows: [], total: 0, truncated: false }, changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) }
}

const renderCollected = (
  columns: string[],
  columnTypes: Array<string | null | undefined>,
  collected: Collected,
  elapsedMs: number,
  maxCellWidth?: number,
) =>
  Core.renderTable(columns, columnTypes, collected.rows, {
    elapsedMs,
    truncated: collected.truncated,
    ...(maxCellWidth !== undefined ? { maxCellWidth } : {}),
  })

const actionTables = Effect.fn("SqliteTool.tables")(function* (
  ctx: Tool.Context,
  instance: { directory: string; worktree: string },
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const start = performance.now()
  const db = resolvePath(instance, params.db)
  validatePath(db.abs, "db")
  const attaches = yield* resolveAttaches(instance, params)
  yield* requireDbFile(db)
  yield* readAsk(ctx, db)

  const result = yield* withConnection(db.abs, attaches.length ? "query_only" : "readonly", attaches, (connection) =>
    Effect.gen(function* () {
      const stmt = connection.prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      const rows = stmt.all() as Array<{ name: string; type: string }>
      const tableCount = rows.filter((r) => r.type === "table").length
      const viewCount = rows.filter((r) => r.type === "view").length
      const collected: Collected = { rows: rows.map((r) => [r.name, r.type]), total: rows.length, truncated: false }
      const output = renderCollected(["name", "type"], ["TEXT", "TEXT"], collected, performance.now() - start)
      return {
        title: db.rel,
        output,
        metadata: {
          action: "tables",
          db: db.rel,
          rows: rows.length,
          tables: tableCount,
          views: viewCount,
          truncated: false,
          elapsedMs: performance.now() - start,
        } satisfies Metadata,
      }
    }),
  )
  return result
})

const resolveAttaches = Effect.fn("SqliteTool.resolveAttaches")(function* (
  instance: { directory: string; worktree: string },
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const paths = params.attach ?? []
  if (paths.length > MAX_ATTACH) throw new Error(`Too many attach databases (max ${MAX_ATTACH})`)
  const resolved: Resolved[] = []
  for (const p of paths) {
    const r = resolvePath(instance, p)
    validatePath(r.abs, "attach")
    yield* requireDbFile(r)
    resolved.push(r)
  }
  return resolved
})

const actionSchema = Effect.fn("SqliteTool.schema")(function* (
  ctx: Tool.Context,
  instance: { directory: string; worktree: string },
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const start = performance.now()
  const db = resolvePath(instance, params.db)
  validatePath(db.abs, "db")
  const attaches = yield* resolveAttaches(instance, params)
  yield* requireDbFile(db)
  yield* readAsk(ctx, db)

  const result = yield* withConnection(db.abs, attaches.length ? "query_only" : "readonly", attaches, (connection) =>
    Effect.gen(function* () {
      const table = params.table
      if (table !== undefined) {
        const create = connection
          .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view','index') AND name = ?")
          .get(table) as { sql: string | null } | undefined
        if (!create) {
          const suggestions = (
            connection
              .prepare("SELECT name FROM sqlite_master WHERE name LIKE ? ORDER BY name LIMIT 3")
              .all(`%${table}%`) as Array<{ name: string }>
          ).map((r) => r.name)
          const hint = suggestions.length ? `\nDid you mean: ${suggestions.join(", ")}` : ""
          throw new Error(`no such table: ${table}${hint}`)
        }
        const cols = connection.prepare(`PRAGMA table_info(${Core.quoteIdentifier(table)})`).all() as Array<{
          cid: number
          name: string
          type: string
          notnull: number
          dflt_value: string | null
          pk: number
        }>
        const ddl = create.sql ? `${create.sql};` : `-- ${table}: no CREATE statement recorded`
        const header = ["cid", "name", "type", "notnull", "pk", "dflt"]
        const columnRows: Array<Array<unknown>> = cols.map((c) => [c.cid, c.name, c.type, c.notnull, c.pk, c.dflt_value])
        const output = [
          ddl,
          "",
          Core.renderTable(header, ["INTEGER", "TEXT", "TEXT", "INTEGER", "INTEGER", "TEXT"], columnRows, {
            elapsedMs: performance.now() - start,
            truncated: false,
          }),
        ].join("\n")
        return {
          title: `${db.rel}:${table}`,
          output,
          metadata: {
            action: "schema",
            db: db.rel,
            rows: columnRows.length,
            truncated: false,
            elapsedMs: performance.now() - start,
          } satisfies Metadata,
        }
      }

      const all = connection
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Array<{ name: string; type: string; sql: string }>
      let bytes = 0
      const parts: string[] = []
      let truncated = false
      for (const row of all) {
        const block = `${row.sql};\n`
        if (bytes + block.length > SCHEMA_BYTE_CAP) {
          truncated = true
          break
        }
        parts.push(block)
        bytes += block.length
      }
      const output = parts.join("\n") + (truncated ? `\n-- (schema truncated at ${SCHEMA_BYTE_CAP / 1024} KB — use schema {table} to narrow)\n` : "")
      return {
        title: db.rel,
        output,
        metadata: {
          action: "schema",
          db: db.rel,
          rows: all.length,
          truncated,
          elapsedMs: performance.now() - start,
        } satisfies Metadata,
      }
    }),
  )
  return result
})

const actionQuery = Effect.fn("SqliteTool.query")(function* (
  ctx: Tool.Context,
  instance: { directory: string; worktree: string },
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const start = performance.now()
  const db = resolvePath(instance, params.db)
  validatePath(db.abs, "db")
  const sql = params.sql
  if (!sql) throw new Error("query action requires 'sql'")
  if (Core.hasInteriorSemicolon(sql)) {
    throw new Error("Single statement per call: ';' inside the statement is not allowed (one statement per call)")
  }
  const attaches = yield* resolveAttaches(instance, params)
  yield* requireDbFile(db)
  yield* readAsk(ctx, db)
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const bind = params.params ?? []

  const result = yield* withConnection(db.abs, attaches.length ? "query_only" : "readonly", attaches, (connection) =>
    Effect.gen(function* () {
      let stmt: Statement
      try {
        stmt = connection.prepare(sql)
      } catch (err) {
        throw new Error(Core.sqliteErrorToMessage(err))
      }
      let collected: Collected
      try {
        collected = collectRows(stmt, bind, limit, RENDER_BYTE_CAP)
      } catch (err) {
        throw new Error(Core.sqliteErrorToMessage(err))
      }
      const output = renderCollected(stmt.columnNames, stmt.columnTypes, collected, performance.now() - start)
      return {
        title: db.rel,
        output,
        metadata: {
          action: "query",
          db: db.rel,
          rows: collected.total,
          truncated: collected.truncated,
          elapsedMs: performance.now() - start,
        } satisfies Metadata,
      }
    }),
  )
  return result
})

const actionRun = Effect.fn("SqliteTool.run")(function* (
  ctx: Tool.Context,
  instance: { directory: string; worktree: string },
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const start = performance.now()
  const db = resolvePath(instance, params.db)
  validatePath(db.abs, "db")
  const sql = params.sql
  if (!sql) throw new Error("run action requires 'sql'")
  if (Core.hasInteriorSemicolon(sql)) {
    throw new Error("Single statement per call: ';' inside the statement is not allowed (keeps run atomic)")
  }
  const attaches = yield* resolveAttaches(instance, params)
  const dryRun = params.dryRun !== false
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const bind = params.params ?? []
  const classification = Core.classifyStatement(sql)
  const destructive = Core.detectDestructive(sql)

  const stat = yield* Effect.promise(() => fs.stat(db.abs).catch(() => undefined))
  if (stat?.isDirectory()) throw new Error(`Not a database: ${db.rel} is a directory`)
  if (stat) {
    const header = yield* Effect.promise(() => readHeader(db.abs))
    if (!header.ok) {
      throw new Error(
        `Not a SQLite database: ${db.rel} (first bytes ${header.hex || "(empty)"}; expected 'SQLite format 3')`,
      )
    }
  } else {
    yield* Effect.promise(() => fs.mkdir(path.dirname(db.abs), { recursive: true }))
  }

  yield* ctx.ask({
    permission: "edit",
    patterns: [db.rel],
    always: ["*"],
    metadata: {
      filepath: db.abs,
      statement: classification.kind,
      destructive,
      dryRun,
    },
  })
  yield* assertExternalDirectoryEffect(ctx, db.abs, { kind: "file" })

  const result = yield* withConnection(db.abs, "readwrite", attaches, (connection) =>
    Effect.gen(function* () {
      connection.exec("BEGIN")
      let changes = 0
      let lastInsertRowid = 0
      let collected: Collected = { rows: [], total: 0, truncated: false }
      let columns: string[] = []
      let columnTypes: Array<string | null | undefined> = []
      try {
        const stmt = connection.prepare(sql)
        columns = stmt.columnNames
        columnTypes = safeColumnTypes(stmt)
        const out = runStatement(connection, stmt, bind, limit)
        changes = out.changes
        lastInsertRowid = out.lastInsertRowid
        collected = out.collected
        if (dryRun) connection.exec("ROLLBACK")
        else connection.exec("COMMIT")
      } catch (err) {
        connection.exec("ROLLBACK")
        throw new Error(Core.sqliteErrorToMessage(err))
      }

      const isDdl = classification.kind === "create" || classification.kind === "drop" || classification.kind === "alter"
      const lines: string[] = []
      lines.push(`-- ${classification.kind} ${dryRun ? "DRY RUN" : "COMMITTED"}`)
      if (dryRun) lines.push("-- rolled back; set dryRun:false to commit")
      if (isDdl) {
        lines.push(`schema changed`)
      } else if (columns.length > 0) {
        const body = renderCollected(columns, columnTypes, collected, performance.now() - start)
        lines.push(body)
      } else {
        lines.push(`${changes} row(s) changed, last insert rowid ${lastInsertRowid}`)
      }
      const output = lines.join("\n")

      return {
        title: db.rel,
        output,
        metadata: {
          action: "run",
          db: db.rel,
          rows: collected.total,
          truncated: collected.truncated,
          elapsedMs: performance.now() - start,
          changes,
          lastInsertRowid,
          dryRun,
          rolledBack: dryRun,
          destructive: destructive.isDestructive,
        } satisfies Metadata,
      }
    }),
  )
  return result
})

const actionExplain = Effect.fn("SqliteTool.explain")(function* (
  ctx: Tool.Context,
  instance: { directory: string; worktree: string },
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const start = performance.now()
  const db = resolvePath(instance, params.db)
  validatePath(db.abs, "db")
  const sql = params.sql
  if (!sql) throw new Error("explain action requires 'sql'")
  if (Core.hasInteriorSemicolon(sql)) {
    throw new Error("Single statement per call: ';' inside the statement is not allowed")
  }
  const attaches = yield* resolveAttaches(instance, params)
  yield* requireDbFile(db)
  yield* readAsk(ctx, db)
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const bind = params.params ?? []

  const result = yield* withConnection(db.abs, attaches.length ? "query_only" : "readonly", attaches, (connection) =>
    Effect.gen(function* () {
      let stmt: Statement
      try {
        stmt = connection.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      } catch (err) {
        throw new Error(Core.sqliteErrorToMessage(err))
      }
      let collected: Collected
      try {
        collected = collectRows(stmt, bind, limit, RENDER_BYTE_CAP)
      } catch (err) {
        throw new Error(Core.sqliteErrorToMessage(err))
      }
      const output = renderCollected(stmt.columnNames, stmt.columnTypes, collected, performance.now() - start, EXPLAIN_CELL_WIDTH)
      return {
        title: db.rel,
        output,
        metadata: {
          action: "explain",
          db: db.rel,
          rows: collected.total,
          truncated: collected.truncated,
          elapsedMs: performance.now() - start,
        } satisfies Metadata,
      }
    }),
  )
  return result
})

const actionExport = Effect.fn("SqliteTool.export")(function* (
  ctx: Tool.Context,
  instance: { directory: string; worktree: string },
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const start = performance.now()
  const db = resolvePath(instance, params.db)
  validatePath(db.abs, "db")
  const sql = params.sql
  if (!sql) throw new Error("export action requires 'sql'")
  const outputPath = params.outputPath
  if (!outputPath) throw new Error("export action requires 'outputPath'")
  if (Core.hasInteriorSemicolon(sql)) {
    throw new Error("Single statement per call: ';' inside the statement is not allowed")
  }
  const attaches = yield* resolveAttaches(instance, params)
  yield* requireDbFile(db)
  yield* readAsk(ctx, db)

  const out = resolvePath(instance, outputPath)
  validatePath(out.abs, "outputPath")
  const exists = yield* Effect.promise(() => fs.stat(out.abs).then(() => true).catch(() => false))
  if (exists && params.overwrite !== true) {
    throw new Error(`Export target already exists: ${out.rel} — pass overwrite:true to replace it`)
  }

  const format = params.format ?? "csv"
  const maxRows = Math.max(params.maxRows ?? DEFAULT_EXPORT_MAX_ROWS, 1)
  const maxBytes = Math.max(params.maxBytes ?? DEFAULT_EXPORT_MAX_BYTES, 1)
  const bind = params.params ?? []

  const collected = yield* withConnection(db.abs, attaches.length ? "query_only" : "readonly", attaches, (connection) =>
    Effect.gen(function* () {
      let stmt: Statement
      try {
        stmt = connection.prepare(sql)
      } catch (err) {
        throw new Error(Core.sqliteErrorToMessage(err))
      }
      const columns = stmt.columnNames
      const rows: Array<Array<unknown>> = []
      let bytes = 0
      let truncated = false
      let total = 0
      try {
        for (const row of stmt.iterate(...bind)) {
          total++
          const values = columns.map((c) => (row as Record<string, unknown>)[c])
          const rowBytes = values.reduce<number>((acc, v) => acc + cellBytes(v), 4)
          if (rows.length >= maxRows || bytes + rowBytes > maxBytes) {
            truncated = true
            break
          }
          rows.push(values)
          bytes += rowBytes
        }
      } catch (err) {
        throw new Error(Core.sqliteErrorToMessage(err))
      }
      const text = format === "json" ? Core.toJson(columns, rows) : Core.toCsv(columns, rows)
      return { text, rows: rows.length, total, truncated, bytes: Buffer.byteLength(text, "utf8") }
    }),
  )

  yield* ctx.ask({
    permission: "edit",
    patterns: [out.rel],
    always: ["*"],
    metadata: {
      filepath: out.abs,
      format,
      rows: collected.rows,
      bytes: collected.bytes,
    },
  })
  yield* assertExternalDirectoryEffect(ctx, out.abs, { kind: "file" })

  yield* Effect.promise(() => fs.mkdir(path.dirname(out.abs), { recursive: true }))
  yield* Effect.promise(() => fs.writeFile(out.abs, collected.text, "utf8"))

  const output = `Exported ${collected.rows} rows (${collected.bytes} bytes) to ${out.rel} (${format}, ${(performance.now() - start).toFixed(1)} ms)${collected.truncated ? ` — truncated at ${format === "json" ? maxRows + " rows" : maxBytes + " bytes"}` : ""}`
  return {
    title: out.rel,
    output,
    metadata: {
      action: "export",
      db: db.rel,
      rows: collected.rows,
      truncated: collected.truncated,
      elapsedMs: performance.now() - start,
      format,
      bytes: collected.bytes,
      outputPath: out.rel,
    } satisfies Metadata,
  }
})

export const SqliteTool = Tool.define<typeof Parameters, Metadata, ChildProcessSpawner>(
  "sqlite",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          switch (params.action) {
            case "tables":
              return yield* actionTables(ctx, instance, params)
            case "schema":
              return yield* actionSchema(ctx, instance, params)
            case "query":
              return yield* actionQuery(ctx, instance, params)
            case "run":
              return yield* actionRun(ctx, instance, params)
            case "explain":
              return yield* actionExplain(ctx, instance, params)
            case "export":
              return yield* actionExport(ctx, instance, params)
            default:
              throw new Error(`Unsupported sqlite action: ${(params as { action?: unknown }).action}`)
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SqliteCore from "./sqlite/core"
