# `sqlite` Tool — Implementation-Ready Design

Status: READY FOR BUILD (analyst deliverable for `default-tools-upgrade` sqlite lane)
Owner: analyst · Consumes: sqlite-builder · Verifies: sqlite-verifier
Date: 2026-08-15
Companion doc: `docs/swarm-tool-upgrade-design.md` (suite conventions, §2, §4, §5 apply here).

---

## 0. TL;DR

A new native default tool, id **`sqlite`**, giving the agent structured, safe access to
SQLite database files via **bun:sqlite** (`Database` from `bun:sqlite`), **no ORM**, one
action per call:

`tables` · `schema [table]` · `query` · `run` · `explain` · `export`

Read actions open the connection **readonly** (`{readonly:true}` + explicit existence
check) with **prepared statements + bound params**. `run` (writes + DDL) is gated on the
**`edit`** permission for the db file, executes inside a **transaction**, is **dry-run by
default** (execute then ROLLBACK), reports `changes`/`lastInsertRowid`, and surfaces
**destructive-pattern detection** (DROP / DELETE / UPDATE-without-WHERE) in the permission
ask metadata. Results render **psql-style aligned tables** with row/byte caps, elapsed ms,
and a spill-to-file hint; `export` streams a query result to CSV/JSON in the workspace for
token savings. `bun:sqlite`'s `Statement.iterate()` (verified in installed bun-types
1.3.13, `sqlite.d.ts:666`) enables lazy row capping and streaming export.

---

## 1. Settled Decisions (coordinator, binding)

| # | Decision |
|---|---|
| D1 | tool id `sqlite` (user-confirmed) |
| D2 | engine = `bun:sqlite` (`Database` from `bun:sqlite`), **no ORM** |
| D3 | stateless per call — open the db per call, close after; `db` path param + optional `attach: string[]` |
| D4 | single tool, `action` discriminator: `tables` / `schema [table]` / `query` / `run` / `explain` / `export` |
| D5 | read actions open `{readonly:true}` (+ must-exist semantics); prepared statements for all params |
| D6 | result rendering = psql-style aligned table, capped rows+bytes, elapsed ms, truncation hint, spill-to-file hint |
| D7 | `run` = writes+DDL gated on `edit` permission on the db file; transactional; `dryRun` (execute→ROLLBACK); report changes/lastInsertRowid; destructive-pattern detection surfaced in ask metadata |
| D8 | `explain` = `EXPLAIN QUERY PLAN` |
| D9 | `export` = query result to CSV/JSON in the workspace (token savings) |
| D10 | permissions reuse `read`/`edit` + `assertExternalDirectoryEffect` |
| D11 | edge cases: non-sqlite file → clear error; missing db → read errors / run may create (defined §6); blob → hex preview; huge results → caps + export |
| D12 | registry.ts is concurrently edited by two other swarms — build must merge additively |

---

## 2. Native Conventions (recap)

Same shape as the suite: `Tool.define("sqlite", ...)`, `Parameters` = `Schema.Struct`,
`DESCRIPTION` from `sqlite.txt`, `InstanceState.context` for path resolution,
`ctx.ask({ permission, patterns, always, metadata })`,
`assertExternalDirectoryEffect(ctx, abs, { kind: "file" })`, return
`{ title, output, metadata }`, `.pipe(Effect.orDie)`. Use
`import { optional } from "@opencode-ai/core/schema"` for optional props and
`NonNegativeInt` where applicable. Per-call connection lifecycle:
`Effect.acquireRelease(Effect.sync(() => new Database(...)), db => Effect.sync(() => db.close()))`.

bun:sqlite surface used (verified in installed bun-types 1.3.13):
`new Database(filename, { readonly, readwrite, create, safeIntegers, strict })`,
`db.prepare(sql)`, `stmt.all(...params)` / `stmt.values(...params)` / `stmt.get(...)`,
**`stmt.iterate(...params): IterableIterator`** (lazy — cap/stream), `stmt.run(...)`
returns `{ changes, lastInsertRowid }`, `stmt.columnNames`, `stmt.columnTypes`
(`"INTEGER"|"FLOAT"|"TEXT"|"BLOB"|"NULL"|null`), `db.close()`, `db.filename`.

> **Note (deviation from D5 wording, same semantics):** `fileMustExist` is **not** present
> in the installed `DatabaseOptions` (only `readonly/create/readwrite/safeIntegers/strict`).
> `{ readonly: true }` alone gives must-exist semantics (SQLITE_OPEN_READONLY without CREATE
> fails on a missing file) — and we add an explicit `fs.stat` pre-check for a **friendly
> error message**. No type/behavior gap.

---

## 3. Parameters (exact)

```jsonc
{
  "action":    { "enum": ["tables","schema","query","run","explain","export"], "required": true },
  "db":        { "type": "string", "required": true },          // db file path (worktree-relative or absolute)
  "attach":    { "type": "array", "items": { "type": "string" }, "maxItems": 8 },   // optional extra db files
  "table":     { "type": "string" },                            // schema [table]
  "sql":       { "type": "string" },                            // query / run / explain / export
  "params":    { "type": "array", "items": { "anyOf": [         // positional bound params (? / ?NNN)
                 { "type": ["string","number","boolean","null"] },
                 { "type": "string", "contentEncoding": "hex" } // BLOB bytes as hex string
               ] } },
  "dryRun":    { "type": "boolean", "default": true },          // run only
  "limit":     { "type": "integer", "default": 200, "minimum": 1, "maximum": 5000 },  // rows rendered
  "format":    { "enum": ["csv","json"], "default": "csv" },    // export only
  "outputPath":{ "type": "string" },                            // export only (required)
  "overwrite": { "type": "boolean", "default": false },         // export only (refuse existing)
  "maxRows":   { "type": "integer", "default": 1000000, "minimum": 1 },  // export safety cap
  "maxBytes":  { "type": "integer", "default": 52428800, "maximum": 536870912 }  // export output cap (50MB)
}
```

**Effect Schema notes:** `params` is `Schema.Array(Schema.Union([...]))` — BLOB values are
encoded as hex strings and decoded to `Uint8Array` (or passed as hex into SQLite via
`Uint8Array.from(hex, 'hex')`); use the `optional(...)` helper for all non-required fields
so `undefined` keys are omitted. `limit`/`maxRows`/`maxBytes` via `NonNegativeInt` + range
checks.

**Strategy/dispatch:** switch on `action`; unknown action → `InvalidArgumentsError`-style
message. No overloading — one action per call (mirrors `archive`'s `action` discriminator).

---

## 4. Path & Connection Safety

- **Path resolution:** `db`/`attach`/`outputPath` resolve like other tools
  (`path.isAbsolute ? p : path.join(instance.directory, p)`; win32 → `FSUtil.normalizePath`).
- **Reject up front:** `:memory:` (stateless per call ⇒ pointless), empty string, NUL bytes,
  paths starting with `-`, path is a directory.
- **Outside worktree:** `assertExternalDirectoryEffect(ctx, abs, { kind: "file" })` for every
  db, attach, and export target outside the worktree.
- **SQLite header check** (all actions, before constructing `Database`): read first 16 bytes;
  must equal `SQLite format 3\0`. Mismatch → clear error: `"Not a SQLite database: <rel>
  (first bytes <hex>; expected 'SQLite format 3')"`. **`run` also refuses** — never create/
  clobber a file that already exists but isn't SQLite.
- **Missing file:** read actions (tables/schema/query/explain, and export's source) →
  `fs.stat` pre-check, error `"Database file not found: <rel>"`. `run` **may create** the
  file (D11) — see §6. `run` on a missing file whose **parent dir** is missing: create
  parents (`fs.mkdir recursive`) — consistent with the `write` tool. (Flagged §9.)
- **Readonly open:** no `attach` → `new Database(abs, { readonly: true })`. Any write
  statement naturally fails with `attempt to write a readonly database` — no token
  heuristics needed; catch and report `"write statement on a read-only connection — use
  action:'run'"`.
- **Read + attach:** `ATTACH` cannot run on a readonly main connection, so read actions
  **with** `attach` open readwrite and immediately set `PRAGMA query_only = ON` — every
  connection (main + attached) now rejects writes with the same SQLITE_READONLY behavior.
  Attach paths are validated like `db` (exists + header check + external-dir assert) and
  aliased `attach0`, `attach1`, … (collision-proof; document `attachN.` prefix usage in
  `sqlite.txt`). Main db alias stays `main`.
- **Statement discipline:** every `query`/`run`/`explain`/`export` uses
  `db.prepare(sql)` + bound positional params. **Single statement per call** — reject SQL
  with an interior `;` (allow one trailing `;`): clear error telling the model to issue one
  statement per call. This keeps `run` atomic and prevents `DROP x; …` chaining.
- **Timeout/busy:** set `PRAGMA busy_timeout = 5000` on the connection; rely on
  `iterate()` + row caps for runaway reads; document that pathological queries are bounded
  by caps + export streaming, not by execution cancellation (bun:sqlite has no async
  cancel in the installed API — flagged §9).

---

## 5. Actions

### 5.1 `tables`
- `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`
- Render psql-style `name | type` table; metadata `{ action, db, tables: n, views: m }`.
- No per-table row counts in v1 (expensive on big dbs) — note in description.

### 5.2 `schema [table]`
- `table` given: `SELECT sql FROM sqlite_master WHERE type IN ('table','view','index') AND name = ?` (bound param) + `PRAGMA table_info("...")` (identifier double-quote-escaped) → print the CREATE statement, then a `cid|name|type|notnull|pk|dflt` column table. Unknown table → clear "no such table" + nearest-name suggestion (via a `LIKE` query, 3 results).
- No `table`: render every table/view's CREATE statement, capped at `maxBytes`; hint to narrow with `schema {table}`.

### 5.3 `query`
- Readonly open. `db.prepare(sql)`, bind `params`, `stmt.iterate(...params)`.
- Pull rows until `limit` reached or byte cap (50 KB) reached or iterator done. `stmt.iterate()` is lazy, so **the true total row count is unknowable once you stop early** — never fabricate it (see §7 footer).
- Render §7 table. Truncation hint when stopped early: `(Showing 200 rows, 31 KB — use action:'export' to save the full result, or add LIMIT)` — no "of M" total, since M is not knowable without exhausting the iterator. If rows exceeded `limit` → also suggest the `limit` param.
- `SELECT`-only expectation is enforced by the readonly connection (any write → error with guidance to `run`).

### 5.4 `run` (writes + DDL) — the gated action
1. Resolve + header-check + external-dir assert (as §4). Missing file → may create (parents mkdir-recursive).
2. **Single statement** check (reject interior `;`).
3. **Destructive-pattern detection** (pure helper, case-insensitive, comments/whitespace stripped):
   - `DROP` (any `DROP ...`)
   - `DELETE FROM <x>` **without** `WHERE`
   - `UPDATE <x> SET ...` **without** `WHERE`
   - `ALTER ... DROP` / `DELETE FROM sqlite_*` etc. → classified `destructive: true`
   - Non-destructive writes/DDL (`INSERT/UPDATE-with-WHERE/CREATE TABLE/INDEX/ALTER ADD...`) → `destructive: false`
   Detection is **advisory metadata**, not a gate (the edit ask is the gate) — flagged §9 for coordinator if a confirm-token is wanted.
4. **Permission ask:** `ctx.ask({ permission: "edit", patterns: [rel], always: ["*"], metadata: { filepath, statement: <kind>, destructive: { isDestructive, pattern, hasWhere }, dryRun } })` — the destructive flag is visible in the UI prompt.
5. **Transactional + dryRun:**
   - `dryRun` (default **true**): `BEGIN` → execute → **`ROLLBACK`** → report the effect that *would* have happened: `dryRun:true, rolledBack:true, changes:N, lastInsertRowid:M` (+ first `limit` result rows if the statement returns rows, e.g. `INSERT … RETURNING`).
   - `dryRun:false`: `BEGIN` → execute → `COMMIT`. Same report minus the rolledBack flag. Any thrown error → `ROLLBACK`, rethrow as a clean message (with sqlite error text).
   - Transaction wrapper: `Effect.acquireRelease`-style with explicit BEGIN/COMMIT/ROLLBACK via `db.exec` (do **not** use `db.transaction()` autocommit wrapper — we need explicit ROLLBACK for dryRun).
6. Result rendering: DML → report block (`changes`, `lastInsertRowid`, dryRun status); DDL → `"schema changed"` (+ `changes` if applicable); row-returning → psql table (same caps as query).

### 5.5 `explain`
- `EXPLAIN QUERY PLAN <sql>` on a readonly connection, bound params not needed (planner only) but bind anyway if present.
- Render `id | parent | notused | detail` psql table (default `limit` 200). The `detail` column is the useful output — description should tell the model to read it.

### 5.6 `export`
- Source: same read path as `query` (readonly connection). `sql` + `params` + `limit`-independent streaming via `stmt.iterate()`.
- Output: `outputPath` **required** (explicit; workspace-relative or absolute + external-dir assert). Refuse if the file exists and `overwrite !== true` (never silently clobber). Write with `fs.mkdir`-recursive parents.
- Formats:
  - **csv** (default): header row = `columnNames`; RFC4180-minimal escaping (quote fields containing `,` `"` `\n` `\r`; double the quotes). `NULL` → empty field; BLOB → `0x<hex>`; numbers/ints as-is.
  - **json**: array of objects keyed by column name (like `stmt.all()`); `NULL` → `null`; BLOB → `0x<hex>` string; numbers as-is (note: >2^53 integer precision loss — acceptable, documented).
- Caps: stop at `maxRows` (default 1M) or `maxBytes` (default 50 MB) → report `truncated:true` with the reason. Overwrite denied by default.
- Permissions: `read` ask on the db (pattern rel), `edit` ask on the output file (`metadata: { filepath, format, rows, bytes }`), external-dir asserts for both when outside worktree.
- Return: `title` = output rel path, output = `Exported <n> rows (<bytes>) to <rel> (csv/json, <ms> ms)`; metadata `{ action, db, format, rows, bytes, truncated, outputPath }`.

---

## 6. Edge-Case Matrix (D11, explicit)

| Case | Behavior |
|---|---|
| Missing db file, read action | clear error `Database file not found: <rel>` (no create) |
| Missing db file, `run` | **may create** (parents mkdir-recursive); DML on a fresh empty db fails naturally ("no such table") |
| File exists but not SQLite (bad header) | clear error for **all** actions incl. `run` (never clobber) |
| Path is directory / `:memory:` / `-`-leading / NUL | rejected up front |
| Write SQL on read action | SQLITE_READONLY surfaced as `write statement on a read-only connection — use action:'run'` |
| BLOB column in results | `0x<hex>` preview, truncated cell (e.g. `0x48656c6c6f... (12 bytes)`) |
| Huge result set | `iterate()` lazy stop at `limit`/byte cap; truncation hint + spill-to-file hint; `export` for the full result |
| WAL db with missing `-wal`/`-shm` | surface the underlying sqlite error verbatim (usually CANTOPEN/readonly-journal) — documented, no special handling |
| `attach` on read action | query_only connection (readwrite open + `PRAGMA query_only=ON`) |
| Statement returns nothing (DDL/PRAGMA) | report `schema changed` / PRAGMA result rows if any |
| Attach alias collision / `main`/`temp` | reject with clear message |
| Export target exists, `overwrite` false | refuse (never clobber) |
| Interior `;` (multi-statement) | reject single-statement rule |

---

## 7. Output Format — psql-style Table

```
 id | name   | created_at
----+--------+--------------------
 1  | alice  | 2026-01-01T10:00:00
 2  | bob    | 2026-01-02T11:30:00
(2 rows, 1.2 ms)
```

Rendering rules (pure helper, unit-testable):
- Column width = max(header length, max **display** cell length), capped at 40 chars/cell
  (longer → truncate with `…` and note `(truncated)` on the row; BLOB → hex preview).
- Numeric columns (`columnTypes` = `INTEGER`/`FLOAT`) right-aligned; `TEXT`/`NULL`/`BLOB`
  left-aligned. Separator row `-`-dashes per width.
- Footer: `(N rows, X ms)` where **N = rows rendered**. When truncated: `(Showing 200 rows, 31 KB — use action:'export' for the full result)` — **never print "of M"**: with lazy `iterate()` capping the total is unknowable without exhausting the iterator, and a fabricated count would mislead (builder deviation, accepted). `limit`-aware totals are only known when the iterator was fully consumed (no truncation).
- Byte cap 50 KB for the rendered text (like `read`'s cap); `elapsedMs` from `performance.now()`.

Metadata shape (all actions): `{ action, db, rows, truncated, elapsedMs, ... }` plus
per-action extras (`changes`, `lastInsertRowid`, `dryRun`, `rolledBack`, `destructive`,
`format`, `bytes`, `outputPath`, `tables`, `views`).

---

## 8. Permission Model

| Action | `ctx.ask` | Patterns / always | Extra |
|---|---|---|---|
| tables / schema / query / explain (no attach) | `read` | `[rel]` / `["*"]` | external-dir assert if outside worktree |
| same + `attach` | `read` | `[rel]` (+ each attach rel) | external-dir assert per attach path |
| run | `edit` | `[rel]` / `["*"]` | `metadata: { filepath, statement, destructive, dryRun }`; transaction + dryRun rollback |
| export | `read` (db) + `edit` (output) | db rel, output rel | external-dir asserts; overwrite guard |

Rationale (matches suite §4): read-only = one ask with patterns; writes = `edit` ask with
diff/effect metadata; the **destructive flag rides in the ask metadata** so the UI surfaces
`DROP`/unbounded `DELETE`/`UPDATE` before approval. No new permission key needed (reuses
`read`/`edit` per D10) — unlike `git`/`typecheck` which introduce their own keys.

---

## 9. Implementation Checklist (ordered)

1. **`sqlite/core.ts`** — pure, unit-testable helpers (no I/O):
   - `isSqliteHeader(bytes)` (magic check)
   - `classifyStatement(sql)` → `{ kind: select|insert|update|delete|create|drop|alter|pragma|other, destructive, hasWhere }`
   - `detectDestructive(sql)` (DROP / DELETE-no-WHERE / UPDATE-no-WHERE, comments stripped, case-insensitive)
   - `sanitizeIdentifier` / `attachAlias(stem, used)` (collision-safe aliases)
   - `renderTable(columns, columnTypes, rows, opts)` (psql-style, width/byte caps, hex blobs)
   - `toCsv(columns, rows)` / `toJson(columns, rows)` writers (RFC4180-escaping; hex BLOB)
   - `sqliteErrorToMessage(err)` (SQLITE_READONLY → guidance, "unable to open" → friendly)
2. **`sqlite.ts`** — `Tool.define("sqlite", ...)`: `Parameters` (§3), action dispatch (§5),
   per-call `acquireRelease` connection lifecycle, path/header/attach guards (§4), permission
   asks (§8), transaction + dryRun rollback for `run` (§5.4), `iterate()`-based caps and
   streaming export (§5.3/§5.6).
3. **`sqlite.txt`** — description: action docs with examples, attach alias note, `run`
   safety contract (dryRun default, edit-permission gate, destructive detection), caps,
   `export` guidance, permission-key note (reuses `read`/`edit`).
4. **registry.ts** — **purely additive merge**: `import { SqliteTool } from "./sqlite"`,
   `const sqlitetool = yield* SqliteTool`, `sqlite: Tool.init(sqlitetool)` in `Effect.all`,
   `tool.sqlite` in `builtin`. Do not reorder/reformat existing entries (two other swarms
   edit this file concurrently).
5. **Tests** (`packages/opencode/test/tool/sqlite.test.ts`) — §10. Run `bun test` from
   `packages/opencode` (never repo root). `bun typecheck` from `packages/opencode`.

---

## 10. Test Plan

| Area | Cases |
|---|---|
| core helpers | header magic true/false; destructive detection: DROP/`DELETE FROM t` (no WHERE)/`UPDATE t SET` (no WHERE)/`delete from t where id=1` (safe)/case+comment-insensitive; classifyStatement kinds; renderTable alignment, right-align numeric, 40-char truncate, hex blob, separator row, footer counts; toCsv escaping (comma/quote/newline), NULL→empty, BLOB→hex; toJson null/blob; attachAlias collision |
| connection/paths | missing file read error; non-sqlite file error on **every** action incl. run (no clobber); `:memory:`/empty/`-`/NUL/directory rejected; outside-worktree triggers external-dir ask |
| query | binds positional params (`?`), named not required; write SQL on readonly → guidance error; `limit` cap + truncation hint + spill hint; byte cap; elapsed ms present |
| run | dryRun default rolls back (row count unchanged after call); `dryRun:false` commits; reports changes/lastInsertRowid; single-statement rejection (`SELECT 1; DROP x`); missing file creates + DDL works, DML fails naturally; DROP ask metadata has `destructive:true`; interior-`;` rejected |
| explain | EXPLAIN QUERY PLAN renders id/parent/notused/detail |
| export | csv+json written with correct content; existing file refused without `overwrite`; overwrite works; streaming stops at maxRows/maxBytes with `truncated:true`; output outside worktree → external-dir ask |
| attach | read action with attach aliases; write on attached db via run is possible (documented) but read actions are query_only-protected |
| registry | additive merge compiles against live concurrent edits; tool id resolves |

---

## 11. Ambiguities / Flagged for Coordinator & Builder

1. **`fileMustExist` unavailable** in installed bun-types 1.3.13 → implemented as
   `{readonly:true}` + explicit `fs.stat` pre-check (identical semantics). Non-blocking.
2. **Read + `attach` needs a readwrite open** (ATTACH can't run on a readonly main
   connection) — guarded by `PRAGMA query_only=ON` so writes still fail. If you'd rather
   forbid `attach` on read actions entirely, say so.
3. **`run` has no confirm token** beyond the `edit` permission ask (coordinator didn't
   settle one). The destructive flag rides in ask metadata; `dryRun` defaults true so a
   destructive op is visible before any commit. **Option:** require `dryRun` first for
   `destructive:true` statements (2-call flow) — cheap to add, say the word.
4. **JSON export BLOB representation:** hex string (`0x...`) chosen for consistency with
   preview. Alternative: base64. Flag if you prefer base64.
5. **`outputPath` required** for export (explicit > defaulted). Alternative: default to
   `<dbstem>_<ts>.<fmt>` next to the db. Flag if you prefer a default.
6. **`run` creates missing files with mkdir-recursive parents** (consistent with `write`).
   If you want to refuse creation entirely when the parent dir is missing, adjust.
7. **No execution cancellation** for runaway queries (bun:sqlite installed API has no async
   cancel) — bounded by `iterate()` caps + export streaming. `PRAGMA busy_timeout=5000` set.
   Acceptable for v1; note in description.
8. **Registry merge** is the only shared-file risk: purely additive, merge against the live
   file at edit time (two other swarms own concurrent edits).
