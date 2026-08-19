// Pure, unit-testable helpers for the sqlite tool (no I/O, no bun:sqlite).
// Everything here is deterministic given its inputs so the tool's core logic
// can be tested without touching the filesystem.

export const SQLITE_MAGIC = "SQLite format 3\0"

// 16-byte header magic check ("SQLite format 3" + NUL).
export function isSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false
  }
  return true
}

// Strip -- line comments, /* */ block comments, and replace '...' string
// literals with '' so keywords inside strings never match detection. Double-
// quoted identifiers are kept (they are structural, not keyword noise).
export function stripSqlNoise(sql: string): string {
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

export type StatementKind =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "create"
  | "drop"
  | "alter"
  | "pragma"
  | "other"

export type Classification = {
  kind: StatementKind
  destructive: boolean
  hasWhere: boolean
}

const firstKeyword = (cleaned: string): string => {
  const m = /^\s*([A-Za-z]+)/.exec(cleaned)
  return m ? m[1].toUpperCase() : ""
}

export function classifyStatement(sql: string): Classification {
  const cleaned = stripSqlNoise(sql)
  const upper = cleaned.toUpperCase()
  const hasWhere = /\bWHERE\b/.test(upper)
  const kw = firstKeyword(cleaned)

  let kind: StatementKind = "other"
  if (kw === "SELECT" || kw === "WITH" || kw === "VALUES") kind = "select"
  else if (kw === "INSERT" || kw === "REPLACE") kind = "insert"
  else if (kw === "UPDATE") kind = "update"
  else if (kw === "DELETE") kind = "delete"
  else if (kw === "CREATE") kind = "create"
  else if (kw === "DROP") kind = "drop"
  else if (kw === "ALTER") kind = "alter"
  else if (kw === "PRAGMA") kind = "pragma"

  const destructive =
    kind === "drop" ||
    (kind === "delete" && !hasWhere) ||
    (kind === "update" && !hasWhere) ||
    (kind === "alter" && /\bDROP\b/.test(upper))

  return { kind, destructive, hasWhere }
}

export type DestructivePattern = {
  isDestructive: boolean
  pattern: string | null
  hasWhere: boolean
}

export function detectDestructive(sql: string): DestructivePattern {
  const { kind, hasWhere } = classifyStatement(sql)
  const upper = stripSqlNoise(sql).toUpperCase()

  if (kind === "drop") return { isDestructive: true, pattern: "DROP", hasWhere }
  if (kind === "delete" && !hasWhere) return { isDestructive: true, pattern: "DELETE without WHERE", hasWhere }
  if (kind === "update" && !hasWhere) return { isDestructive: true, pattern: "UPDATE without WHERE", hasWhere }
  if (kind === "alter" && /\bDROP\b/.test(upper)) return { isDestructive: true, pattern: "ALTER ... DROP", hasWhere }
  return { isDestructive: false, pattern: null, hasWhere }
}

// Reject multi-statement input: a single trailing ';' is allowed, any other
// ';' (outside string literals/comments) means the model is chaining statements.
export function hasInteriorSemicolon(sql: string): boolean {
  const cleaned = stripSqlNoise(sql).trim()
  const withoutTrailing = cleaned.replace(/;+$/, "")
  return withoutTrailing.includes(";")
}

// Double-quote an identifier for use inside SQL (PRAGMA table_info("...")).
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

// Collision-proof attach alias: attach0, attach1, ... (never collides with
// main/temp or a user table because SQLite resolves schema.table namespaces).
export function attachAlias(index: number): string {
  return `attach${index}`
}

type Cell = string | number | bigint | boolean | null | undefined | Uint8Array

export function isNumericType(type: string | null | undefined): boolean {
  return type === "INTEGER" || type === "FLOAT" || type === "NUMERIC" || type === "REAL"
}

function blobHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

// Display a single cell: NULL -> "", BLOB -> 0x<hex> preview (truncated with
// a byte count), everything else -> String(v). bigint renders exactly.
export function displayCell(value: unknown, type: string | null | undefined): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) {
    const hex = blobHex(value)
    if (hex.length <= 16) return `0x${hex}`
    return `0x${hex.slice(0, 16)}... (${value.length} bytes)`
  }
  if (typeof value === "boolean") return value ? "1" : "0"
  return String(value)
}

export type RenderOpts = {
  elapsedMs: number
  truncated: boolean
  maxCellWidth?: number
}

const DEFAULT_MAX_CELL_WIDTH = 40

// psql-style aligned table:
//   id | name   | created_at
//  ----+--------+--------------------
//    1 | alice  | 2026-01-01T10:00:00
//  (2 rows, 1.2 ms)
// Numeric columns right-aligned; text left-aligned. Cells longer than the
// column width are truncated with '…' and the row gets a "(truncated)" note.
export function renderTable(
  columns: string[],
  columnTypes: Array<string | null | undefined>,
  rows: Array<Array<unknown>>,
  opts: RenderOpts,
): string {
  const maxCell = opts.maxCellWidth ?? DEFAULT_MAX_CELL_WIDTH
  const cellTexts = rows.map((row) => row.map((v, i) => displayCell(v, columnTypes[i])))
  const widths = columns.map((header, i) => {
    const maxLen = Math.max(header.length, ...cellTexts.map((row) => row[i]?.length ?? 0))
    return Math.min(maxCell, Math.max(1, maxLen))
  })

  const pad = (text: string, width: number, right: boolean) =>
    right ? text.padStart(width, " ") : text.padEnd(width, " ")

  const line = (cells: string[], truncate: boolean) => {
    const body = cells
      .map((text, i) => {
        const right = isNumericType(columnTypes[i])
        if (text.length > widths[i]) text = text.slice(0, widths[i] - 1) + "…"
        return pad(text, widths[i], right)
      })
      .join(" | ")
    return ` ${body}${truncate ? " (truncated)" : ""} `
  }

  const out: string[] = []
  out.push(line(columns, false))
  out.push(columns.map((_, i) => "-".repeat(widths[i] + 2)).join("+"))
  for (let r = 0; r < cellTexts.length; r++) {
    const truncated = cellTexts[r].some((text, i) => text.length > widths[i])
    out.push(line(cellTexts[r], truncated))
  }

  const kb = ((out.join("\n").length + 4) / 1024).toFixed(1)
  if (opts.truncated) {
    out.push(`(Showing ${rows.length} rows, ${kb} KB — use action:'export' to save the full result, or add LIMIT)`)
  } else {
    out.push(`(${rows.length} rows, ${opts.elapsedMs.toFixed(1)} ms)`)
  }
  return out.join("\n")
}

function csvEscape(text: string): string {
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

export function csvField(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) return `0x${blobHex(value)}`
  if (typeof value === "object") return csvEscape(String(value))
  return csvEscape(String(value))
}

export function toCsv(columns: string[], rows: Array<Array<unknown>>): string {
  const out = [columns.map((c) => csvEscape(c)).join(",")]
  for (const row of rows) out.push(row.map(csvField).join(","))
  return out.join("\n") + "\n"
}

export function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) return `0x${blobHex(value)}`
  return value
}

export function toJson(columns: string[], rows: Array<Array<unknown>>): string {
  const objs = rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, jsonValue(row[i])])))
  return JSON.stringify(objs, null, 2) + "\n"
}

// Map a bun:sqlite error to a model-facing message. SQLITE_READONLY gets the
// "use action:'run'" guidance; everything else keeps the sqlite error text.
export function sqliteErrorToMessage(err: unknown): string {
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
