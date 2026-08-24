import { Database } from "bun:sqlite"

type AttachResolved = { abs: string; rel: string }

type WorkerRequest = {
  action: "tables" | "schema" | "query" | "run" | "explain" | "export"
  db: string
  attaches: AttachResolved[]
  mode: "readonly" | "query_only" | "readwrite"
  sql?: string
  params?: unknown[]
  limit?: number
  byteCap?: number
  exportLimit?: number
  exportByteCap?: number
  dryRun?: boolean
  table?: string
}

type TableInfoRow = {
  cid: number
  name: string
  type: string
  notnull: number
  pk: number
  dflt_value: string | null
}

type WorkerOk = {
  ok: true
  columns?: string[]
  columnTypes?: Array<string | null | undefined>
  rows: unknown[][]
  total: number
  truncated: boolean
  changes?: number
  lastInsertRowid?: number
  isDdl?: boolean
  tableInfo?: TableInfoRow[]
  ddl?: string
  tableCount?: number
  viewCount?: number
}

type WorkerErr = { ok: false; error: string }

type WorkerResponse = WorkerOk | WorkerErr

const attachAlias = (index: number): string => `attach${index}`

const cellBytes = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  if (typeof v === "bigint") return String(v).length
  if (v instanceof Uint8Array) return v.length + 8
  return String(v).length + 1
}

type Collected = {
  rows: Array<Array<unknown>>
  total: number
  truncated: boolean
}

const collectRows = (
  stmt: import("bun:sqlite").Statement,
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

const safeColumnTypes = (stmt: import("bun:sqlite").Statement): Array<string | null | undefined> => {
  try {
    return stmt.columnTypes
  } catch {
    return stmt.columnNames.map(() => null)
  }
}

const sqliteErrorToMessage = (err: unknown): string => {
  if (err instanceof Error) {
    const msg = err.message
    const code = (err as { code?: string }).code
    if (code === "SQLITE_READONLY" || /readonly database/i.test(msg)) {
      return "write statement on a read-only connection — use action:'run'"
    }
    if (/unable to open database file/i.test(msg)) {
      return `unable to open database file — check the path and that it is a readable SQLite file: ${msg}`
    }
    if (/file is not a database/i.test(msg)) {
      return `not a SQLite database: ${msg}`
    }
    return msg
  }
  return String(err)
}

const openConnection = (abs: string, mode: string, attaches: AttachResolved[]): Database => {
  const opts =
    mode === "readonly"
      ? { readonly: true as const }
      : { readwrite: true as const, create: mode === "readwrite" }
  const db = new Database(abs, opts)
  db.exec("PRAGMA busy_timeout = 5000")
  for (let i = 0; i < attaches.length; i++) {
    db.prepare("ATTACH DATABASE ? AS " + attachAlias(i)).run(attaches[i].abs)
  }
  if (mode === "query_only") db.exec("PRAGMA query_only = ON")
  return db
}

const classifyStatement = (sql: string): { kind: string; destructive: boolean; hasWhere: boolean } => {
  const noise = stripSqlNoise(sql)
  const upper = noise.toUpperCase()
  const hasWhere = /\bWHERE\b/.test(upper)
  const kw = /^\s*([A-Za-z]+)/.exec(noise)
  let kind = "other"
  if (kw) {
    const k = kw[1].toUpperCase()
    if (k === "SELECT" || k === "WITH" || k === "VALUES") kind = "select"
    else if (k === "INSERT" || k === "REPLACE") kind = "insert"
    else if (k === "UPDATE") kind = "update"
    else if (k === "DELETE") kind = "delete"
    else if (k === "CREATE") kind = "create"
    else if (k === "DROP") kind = "drop"
    else if (k === "ALTER") kind = "alter"
    else if (k === "PRAGMA") kind = "pragma"
  }
  const destructive =
    kind === "drop" ||
    (kind === "delete" && !hasWhere) ||
    (kind === "update" && !hasWhere) ||
    (kind === "alter" && /\bDROP\b/.test(upper))
  return { kind, destructive, hasWhere }
}

const stripSqlNoise = (sql: string): string => {
  let out = ""
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (c === "'") {
      out += "''"
      i++
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`

const handleAction = (db: Database, req: WorkerRequest): WorkerOk => {
  const { action, sql, params, limit, byteCap, exportLimit, exportByteCap, dryRun, table, attaches } = req
  const bind = params ?? []

  switch (action) {
    case "tables": {
      const stmt = db.prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      const rows = stmt.all() as Array<{ name: string; type: string }>
      const tableCount = rows.filter((r) => r.type === "table").length
      const viewCount = rows.filter((r) => r.type === "view").length
      return {
        ok: true,
        rows: rows.map((r) => [r.name, r.type]),
        total: rows.length,
        truncated: false,
        columns: ["name", "type"],
        columnTypes: ["TEXT", "TEXT"],
        tableCount,
        viewCount,
      }
    }

    case "schema": {
      if (table !== undefined) {
        const create = db
          .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view','index') AND name = ?")
          .get(table) as { sql: string | null } | undefined
        if (!create) {
          const suggestions = (
            db
              .prepare("SELECT name FROM sqlite_master WHERE name LIKE ? ORDER BY name LIMIT 3")
              .all(`%${table}%`) as Array<{ name: string }>
          ).map((r) => r.name)
          const hint = suggestions.length ? `\nDid you mean: ${suggestions.join(", ")}` : ""
          throw new Error(`no such table: ${table}${hint}`)
        }
        const cols = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableInfoRow[]
        const ddl = create.sql ? `${create.sql};` : `-- ${table}: no CREATE statement recorded`
        return {
          ok: true,
          rows: cols.map((c) => [c.cid, c.name, c.type, c.notnull, c.pk, c.dflt_value]),
          total: cols.length,
          truncated: false,
          columns: ["cid", "name", "type", "notnull", "pk", "dflt"],
          columnTypes: ["INTEGER", "TEXT", "TEXT", "INTEGER", "INTEGER", "TEXT"],
          tableInfo: cols,
          ddl,
        }
      }
      const all = db
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Array<{ name: string; type: string; sql: string }>
      let bytes = 0
      const parts: string[] = []
      let truncated = false
      const SCHEMA_BYTE_CAP = 50 * 1024
      for (const row of all) {
        const block = `${row.sql};\n`
        if (bytes + block.length > SCHEMA_BYTE_CAP) {
          truncated = true
          break
        }
        parts.push(block)
        bytes += block.length
      }
      return {
        ok: true,
        rows: [],
        total: all.length,
        truncated,
        ddl: parts.join("\n") + (truncated ? `\n-- (schema truncated at ${SCHEMA_BYTE_CAP / 1024} KB)\n` : ""),
        columns: [],
        columnTypes: [],
      }
    }

    case "query": {
      if (!sql) throw new Error("query action requires 'sql'")
      const stmt = db.prepare(sql)
      const collected = collectRows(stmt, bind as unknown as ReadonlyArray<string | number | boolean | null>, limit ?? 200, byteCap ?? 51200)
      return {
        ok: true,
        rows: collected.rows,
        total: collected.total,
        truncated: collected.truncated,
        columns: stmt.columnNames,
        columnTypes: safeColumnTypes(stmt),
      }
    }

    case "run": {
      if (!sql) throw new Error("run action requires 'sql'")
      const classification = classifyStatement(sql)
      const isDdl = classification.kind === "create" || classification.kind === "drop" || classification.kind === "alter"
      db.exec("BEGIN")
      let changes = 0
      let lastInsertRowid = 0
      let columns: string[] = []
      let columnTypes: Array<string | null | undefined> = []
        let collected: Collected = { rows: [], total: 0, truncated: false }
      try {
        const stmt = db.prepare(sql)
        columns = stmt.columnNames
        columnTypes = safeColumnTypes(stmt)
        const rowReturning = stmt.columnNames.length > 0
        if (rowReturning) {
          collected = collectRows(stmt, bind as unknown as ReadonlyArray<string | number | boolean | null>, limit ?? 200, byteCap ?? 51200)
          const eff = db.query("SELECT changes() AS c, last_insert_rowid() AS id").get() as { c: number; id: number }
          changes = eff.c
          lastInsertRowid = eff.id
        } else {
          const r = (stmt as unknown as { run: (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint } }).run(...(bind as unknown[]))
          changes = r.changes
          lastInsertRowid = Number(r.lastInsertRowid)
        }
        if (dryRun) db.exec("ROLLBACK")
        else db.exec("COMMIT")
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      }
      return {
        ok: true,
        rows: collected.rows,
        total: collected.total,
        truncated: collected.truncated,
        columns,
        columnTypes,
        changes,
        lastInsertRowid,
        isDdl,
      }
    }

    case "explain": {
      if (!sql) throw new Error("explain action requires 'sql'")
      const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      const collected = collectRows(stmt, bind as unknown as ReadonlyArray<string | number | boolean | null>, limit ?? 200, byteCap ?? 51200)
      return {
        ok: true,
        rows: collected.rows,
        total: collected.total,
        truncated: collected.truncated,
        columns: stmt.columnNames,
        columnTypes: safeColumnTypes(stmt),
      }
    }

    case "export": {
      if (!sql) throw new Error("export action requires 'sql'")
      const stmt = db.prepare(sql)
      const columns = stmt.columnNames
      const rows: unknown[][] = []
      let truncated = false
      let total = 0
      const maxRows = exportLimit ?? 1_000_000
      const maxBytes = exportByteCap ?? 50 * 1024 * 1024
      let bytes = 0
      for (const row of (stmt as unknown as { iterate: (...args: unknown[]) => Iterable<unknown> }).iterate(...(bind as unknown[]))) {
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
      return {
        ok: true,
        rows,
        total,
        truncated,
        columns,
        columnTypes: safeColumnTypes(stmt),
      }
    }

    default:
      throw new Error(`Unsupported action: ${action}`)
  }
}

const req = (await Bun.stdin.json()) as WorkerRequest
const db = openConnection(req.db, req.mode, req.attaches)
try {
  const result = handleAction(db, req)
  console.log(JSON.stringify(result))
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.log(JSON.stringify({ ok: false as const, error: msg }))
} finally {
  db.close()
}
