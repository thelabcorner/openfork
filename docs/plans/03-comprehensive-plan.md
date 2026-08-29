# Comprehensive Overhaul Plan — Premium UX for All Tools

Source: `docs/plans/01-toolcall-error-analysis.md` + `docs/plans/02-session-ux-friction-analysis.md`
DB: `C:\Users\slooshied\.local\share\opencode\opencode-main.db` (42 tables, 190 sessions, 19,211 messages, 359,938 events)
Audit date: 2026-08-28
Protocol: Direct `sqlite` + `grep`/`read` source inspection (subagent unavailable; executed inline)

---

## 1. Problem Statement (DB Evidence + Source Audit)

### Confirmed Problems (Real DB Data)
- **No `tool_call` audit table** — zero visibility into which tool is used, which fails, and how agents recover.
- **33:1 average input/output ratio** — 200.1M input tokens / 6.0M output tokens. Agents burn massive context on unstructured bash workarounds.
- **164,098 partial message updates** (45.6% of all events) — agents receive fragmented tool results without durable settlement.
- **90 `swarm` + 75 `build` agent sessions** (86.8%) — these are the agents interacting with tools; they suffer most from missing premium features.
- **20 model-switch events** — context continuity broken mid-session.
- **Peak session (`ses_fd074...`)**: 1,117 messages, 10.81M input, cost 0.35 — a single session consuming 5.4% of all input tokens.
- **Highest-cost session (`ses_fbbce...`)**: cost 17.73, 5.11M input, 107K reasoning — likely complex bash-based debugging loops.

### Confirmed Source Gaps (Direct Read/Grep Audit)
- `read` premium: `resolveReadPath` (5 rewrites), `renderHeal`, `file_path` alias — **DONE**.
- `typecheck` premium: `heal` banner, filters (`maxErrors:30`, `filePattern`), `HINT` — **DONE** (restored at `registry.ts:482`).
- `edit`/`write`/`patch`/`grep`/`glob`/`project`/`symbols`/`test`/`archive`/`sqlite`/`background`/`git`/`refactor`/`lsp`: **NO PREMIUM FIXES APPLIED**.

---

## 2. Architecture Principles

### Premium UX Pattern (Established by `read` + `typecheck`)
Every premium tool must implement:
1. **Heal / Rewrite Layer** (`resolveReadPath`-style) — path resolution with automatic rewrites, `.gitignore` awareness, and `Did you mean` suggestions.
2. **Self-Heal Banner** (`renderHeal`-style) — visible banner showing what was healed, with metadata.
3. **`HINT` Footer** (`read.ts:34`, `typecheck.ts:571`) — cross-tool suggestions so agents don't fall back to bash.
4. **Alias Support** (`filePath` + `file_path`) — prevents `path` vs `filePath` confusion.
5. **Filter / Cap Params** — prevents `bash | grep` bypass (e.g., `maxResults`, `caseSensitive`, `filePattern`, `maxErrors`).
6. **Durable Audit Trail** (`tool_call` table) — enables future DB-level analysis.

---

## 3. Goals (Prioritized by Impact)

| Priority | Goal | DB Evidence / Source Gap | Impact |
|---|---|---|---|
| **P0** | Add `tool_call` audit table | Zero tool visibility; 359,938 events untracked | Enables all future optimization |
| **P0** | Extract heal module (`src/tool/heal/path.ts`) | `edit`/`write`/`patch`/`grep`/`glob` have no heal | Reduces bash bypass; cuts 33:1 ratio |
| **P0** | Reuse `resolveReadPath` for 8 tools | Raw `path.resolve` in `edit`/`write`; no `Did you mean` | Fixes path errors that trigger retries |
| **P1** | Add `caseSensitive`/`maxResults`/`type` to `grep` | Agents `bash: rg` for `-i`/`-A`; high input ratios | Cuts bash workarounds |
| **P1** | Add `around` hint + banner to `edit` | Raw `throw new Error` on `oldString not found`; 98,062 `message.updated.1` events | Reduces edit retry loops |
| **P1** | Normalize `edit` typecheck filters | `edit.ts:676` hard `maxErrors:30` ignores `typecheck` filters | Consistent filtering |
| **P1** | Add `filter` to `test`; `maxResults`/`filter` to `test`/`typecheck` | `test` has no filter params; `typecheck` filters done | Prevents `bash: bun test --grep` |
| **P2** | Add `file_path` alias everywhere | Only `read` has it (`read.ts:386`) | Reduces param confusion |
| **P2** | Unhide `lsp`; surface `project` with `HINT` | `lsp` hidden (`registry.ts:482`); `project` rarely called (3 test cases) | Improves discoverability |
| **P2** | Cross-tool `HINT` footers (`grep` → `read`, `glob` → `read`) | 164,098 partial updates suggest fragmented tool results | Reduces redundant reads |
| **P2** | `glob` `.gitignore` + `exclude` param; `archive` self-heal | Agents `bash: find` / `bash: unzip -l` | Cuts bash bypass |
| **P3** | `sqlite` `HINT` for file patterns; `git` `HINT` for path outside worktree | No `HINT` on missing path; same guard as `typecheck` | Reduces error confusion |
| **P3** | Add `tool_call` DB schema to `opencode-main.db` | Zero audit; 42 tables, no tool tracking | Enables automated optimization |

---

## 4. Implementation Plan (By File / Module)

### Module A: Heal Layer (`docs/plans/01-toolcall-error-analysis.md` proposal #2, #3)

**File: `src/tool/heal/path.ts`** (NEW — extracted from `read/path.ts:104`)
- Extract: `resolveReadPath` (5 rewrites: POSIX-on-Windows `Users/Users`, extension flip, `**/basename`, absolute check, `.gitignore` check).
- Extract: `renderHeal` (banner + `metadata.healed`).
- Extract: `healPath` (rewrite logic + `Did you mean` candidates).
- Add: `bypassCwdCheck` flag (`read.ts:455`).

**Files to update (reuse `resolveReadPath` + `renderHeal`):**
- `src/tool/edit.ts`: Replace raw `path.resolve` + `throw new Error` with `resolveReadPath` + `renderHeal` + `around` hint on `oldString not found`.
- `src/tool/write.ts`: Replace raw `path.resolve(directory, filePath)` with `resolveReadPath`.
- `src/tool/patch.ts`: Replace raw validation (`throw new Error("Invalid patch: ...")`) with `resolveReadPath` + `HINT` for `filePath` vs `path` confusion.
- `src/tool/apply_patch.ts`: Same.
- `src/tool/grep.ts`: Replace `Directory not found` with `resolveReadPath` + `Did you mean`.
- `src/tool/glob.ts`: Add `resolveReadPath` + `exclude` param + `.gitignore` awareness.
- `src/tool/project.ts`: Add `resolveReadPath` for `path` param.
- `src/tool/symbols.ts`: Add `resolveReadPath` + `file_path` alias.
- `src/tool/test.ts`: Add `resolveReadPath` + `filter` param.

**Expected DB impact:** Fewer `message.updated.1` events (98,062) from edit retries; fewer `message.part.updated.1` events (164,098) from fragmented bash workarounds.

---

### Module B: Filter / Cap Params (`docs/plans/01-toolcall-error-analysis.md` proposal #4, #5, #6)

**File: `src/tool/grep.ts`:**
- Add params: `caseSensitive` (default `true`), `maxResults` (default 50, cap 200), `type` (file type filter), `contextLines` (default 3).
- Prevents `bash: rg -i -A 3 ...` bypass.

**File: `src/tool/test.ts`:**
- Add params: `filter` (test name regex or substring), `filePattern` (file filter), `maxResults`.
- Prevents `bash: bun test --grep` bypass.

**File: `src/tool/edit.ts` (line 676):**
- Change hard `maxErrors:30` to forward to `typecheck` tool's filters (`maxErrors`, `filePattern`).
- Use `TypecheckScope.runScopedTypecheck` only when no `typecheck` tool call is needed; otherwise delegate.

**File: `src/tool/typecheck.ts`:**
- Confirm filters (`maxErrors:30`, `filePattern`) are preserved and not overridden by `edit`.

---

### Module C: Alias + HINT (`docs/plans/01-toolcall-error-analysis.md` proposal #7, #9, #10, #11, #12)

**All files:** Add `file_path` alias to parameter schema (like `read.ts:386`).
- `edit.ts`, `write.ts`, `patch.ts`, `grep.ts`, `glob.ts`, `project.ts`, `symbols.ts`, `test.ts`.

**File: `src/tool/edit.ts`:**
- On `oldString not found`: add banner `oldString not found — try read({action:"around", symbol:"<name>"}) or grep({pattern:"<text>"})` + `metadata.healed`.

**File: `src/tool/grep.ts`:**
- Add footer `HINT: read({filePath:"<file>", pattern:"<pat>"}) to see context without opening 20 files`.

**File: `src/tool/project.ts`:**
- Add `HINT: project({action:"toolchain"})` when `typecheck` fails with `No tsconfig`.

---

### Module D: Discoverability (`docs/plans/01-toolcall-error-analysis.md` proposal #7, #8)

**File: `src/tool/registry.ts` (line 482):**
- Remove `experimentalLspTool` flag requirement for `lsp`.
- Add `lsp` to default tool registry.

**File: `src/tool/project.ts`:**
- Surface `recent` and `toolchain` actions with `HINT` banners.
- Make `project` call more discoverable (e.g., `project({action:"snapshot"})` as default).

---

### Module E: Archive / SQLite / Git / Background (`docs/plans/01-toolcall-error-analysis.md` proposal #13, #14, #15)

**File: `src/tool/archive.ts`:**
- Add `resolveReadPath` + self-heal banner (`archive list` vs `archive extract` confusion).
- Add `HINT` for `bash: unzip -l` bypass.

**File: `src/tool/sqlite.ts`:**
- Add `HINT: sqlite({action:"schema", table:"<name>"})` for file pattern confusion.

**File: `src/tool/git.ts`:**
- Add `HINT` for `path` outside worktree (`git` has `GIT_TERMINAL_PROMPT=0` but no `Did you mean`).

**File: `src/tool/background.ts`:**
- Add `HINT` for `ps` vs `bash: ps` confusion.

---

### Module F: Audit Schema (`docs/plans/01-toolcall-error-analysis.md` proposal #16)

**File: `src/db/migrations/` or `docs/plans/03-comprehensive-plan.md` schema definition:**
- Add `tool_call` table to DB schema:
  ```sql
  CREATE TABLE tool_call (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES session(id),
    message_id TEXT REFERENCES message(id),
    tool_name TEXT NOT NULL,
    args_json TEXT,
    status TEXT (success/error),
    error_message TEXT,
    token_input INTEGER,
    token_output INTEGER,
    duration_ms INTEGER,
    time_created INTEGER NOT NULL
  );
  ```
- This enables future automated analysis (`SELECT tool_name, error_rate FROM tool_call GROUP BY tool_name`).

---

## 5. Success Metrics (Measurable from DB + Source)

| Metric | Current | Target (Post-Overhaul) | Measurement Method |
|---|---|---|---|
| `tool_call` audit table exists | 0 (absent) | 1 (exists) | `sqlite` `SELECT name FROM sqlite_master` |
| Tool-level error rate visibility | 0% | 100% | `sqlite` query on `tool_call.status` |
| `edit` errors with `oldString not found` + `around` hint | 0% | 100% | Source inspection (`edit.ts`) |
| `write` path heal coverage | 0% | 100% | Source inspection (`write.ts`) |
| `patch` validation `HINT` coverage | 0% | 100% | Source inspection (`patch.ts`) |
| `grep` filter params (`caseSensitive`, `maxResults`, `type`) | 0 params | 4 params | Source inspection (`grep.ts`) |
| `test` filter params (`filter`, `filePattern`) | 0 params | 2 params | Source inspection (`test.ts`) |
| `file_path` alias on 8 tools | 1 (`read`) | 9 (all) | Source inspection (parameter schemas) |
| `project` call frequency (test count) | 3 | >10 | `sqlite` event count (after adding `tool_call`) |
| `lsp` hidden flag | Hidden (`experimentalLspTool`) | Unhidden | Source inspection (`registry.ts`) |

---

## 6. Execution Order (Next Steps)

1. Write `docs/plans/03-comprehensive-plan.md` (this file) — DONE.
2. Launch `task` agent to implement Module A (heal module extraction) — `src/tool/heal/path.ts`.
3. Run `task` agent for Module B (filter params) — `grep.ts`, `test.ts`, `edit.ts` line 676.
4. Run `task` agent for Module C (alias + HINT) — all 8 files.
5. Run `task` agent for Module D (discoverability) — `registry.ts`, `project.ts`.
6. Run `task` agent for Module E (archive/sqlite/git/background) — 5 files.
7. Create DB migration for Module F (`tool_call` table) — `sqlite` `run`.
8. Verify all fixes: `sqlite` `SELECT ... FROM sqlite_master`, `grep` source verification, `test` verification.

---

## 7. References

- `docs/plans/01-toolcall-error-analysis.md` — DB schema, event stats, error patterns, recommendations.
- `docs/plans/02-session-ux-friction-analysis.md` — Session-level token ratios, peak sessions, cost outliers, cross-tool friction projections.
- `C:\Users\slooshied\.local\share\opencode\opencode-main.db` — Source DB (42 tables, 190 sessions, 359,938 events).
- `src/tool/read/path.ts:104` — `resolveReadPath` (premium heal layer source).
- `src/tool/edit.ts:1` — 45235 B, raw error handling, `runTypecheck:true` bypass.
- `src/tool/write.ts:1` — No heal layer, raw `path.resolve`.
- `src/tool/patch.ts:1` — 6216 B, `Invalid patch` validation.
- `src/tool/apply_patch.ts:1` — Same validation gap.
- `src/tool/grep.ts:1` — 4187 B, `Ripgrep.Service`, no `caseSensitive`/`maxResults`.
- `src/tool/glob.ts:1` — 2971 B, no `exclude`, no `maxResults`.
- `src/tool/project.ts:1` — Rarely called, `snapshot/recent/toolchain`.
- `src/tool/symbols.ts:1` — Hidden, no heal.
- `src/tool/test.ts:1` — No filter params.
- `src/tool/typecheck.ts:571` — `HINT` banner, filter params.
- `src/tool/registry.ts:482` — `experimentalLspTool` flag.
