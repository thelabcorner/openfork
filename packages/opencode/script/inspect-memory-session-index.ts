/**
 * Read-only, O(1)-per-store historical search-index coverage diagnostic.
 *
 * Usage:
 *   bun run script/inspect-memory-session-index.ts --db <existing-absolute-db-path>
 *
 * This is deliberately NOT a migration/repair. Opens a native SQLite reader
 * with readonly+create=false, sets query_only, reads only cursor and MAX(rowid)
 * metadata, never decodes canonical messages and never prints user data/paths.
 */
import { existsSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { Database as SQLiteDatabase } from "bun:sqlite"

const args = process.argv.slice(2)
const index = args.indexOf("--db")
const filename = index < 0 ? undefined : args[index + 1]
if (!filename || !isAbsolute(filename) || !existsSync(filename) || !statSync(filename).isFile()) {
  console.error("Usage: bun run script/inspect-memory-session-index.ts --db <existing-absolute-db-path>")
  process.exit(2)
}
type Source = { name: string; table: string; cursorTable: string; keyColumn: "id" | "source"; key: number | string }
const SOURCES: Source[] = [
  { name: "v1PartIndexReady", table: "part", cursorTable: "part_search_backfill", keyColumn: "id", key: 2 },
  { name: "v2MessageIndexReady", table: "session_message", cursorTable: "search_backfill", keyColumn: "id", key: 1 },
  { name: "v2ToolIndexReady", table: "session_message", cursorTable: "search_backfill", keyColumn: "id", key: 2 },
  { name: "v1ToolRecallReady", table: "part", cursorTable: "session_tool_recall_backfill", keyColumn: "source", key: "v1_part" },
  { name: "v2ToolRecallReady", table: "session_message", cursorTable: "session_tool_recall_backfill", keyColumn: "source", key: "v2_message" },
]
let db: SQLiteDatabase | undefined
try {
  db = new SQLiteDatabase(filename, { readonly: true, create: false })
  db.exec("PRAGMA query_only = ON")
  db.exec("PRAGMA busy_timeout = 0")
  const present = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name))
  const sources = SOURCES.map(({ name, table, cursorTable, keyColumn, key }) => {
    if (!present.has(table) || !present.has(cursorTable)) {
      return { name, ready: false, status: "missing-schema" as const, sourceMaxRowid: null, watermarkRowid: null }
    }
    // Table names and column names come only from the hardcoded whitelist
    // above. The cursor value is always a bound parameter.
    const source = db!.query(`SELECT MAX(rowid) AS value FROM ${table}`).get() as { value: number | null }
    const cursor = db!.query(`SELECT watermark_rowid, done FROM ${cursorTable} WHERE ${keyColumn} = ?`)
      .get(key) as { watermark_rowid: number; done: number } | null
    const ready = cursor?.done === 1
    return {
      name, ready,
      status: !cursor ? "missing-cursor" as const : ready ? "complete" as const : "incomplete" as const,
      sourceMaxRowid: source.value,
      watermarkRowid: cursor?.watermark_rowid ?? null,
      // Rowids can have gaps. This only indicates a watermark before the
      // current source tail; it is NOT a count or a completion percentage.
      sourceTailPastWatermark: cursor !== null && source.value !== null && source.value > cursor.watermark_rowid,
    }
  })
  console.log(JSON.stringify({
    action: "inspect-session-index",
    readOnly: true,
    complete: sources.every((source) => source.ready),
    sources,
    note: "A false readiness flag is incomplete/unknown historical coverage, not proof of absent messages. Rowids are not row counts; this command never repairs indexes.",
  }))
} catch {
  console.error("Index inspection failed. Verify the read-only database connection and schema availability.")
  process.exitCode = 1
} finally {
  db?.close()
}
