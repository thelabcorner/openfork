# CLOSEOUT — Startup/sidebar/project-explorer performance campaign (2026-09-15)

## Executive verdict

This pass closes the September 14-15 startup/sidebar continuation as a
backend-contention campaign. Startup HTTP scheduling, root-session SQL,
accidental cross-workspace initialization, MCP admission, Windows query-cache
identity, group-child session metadata, and passive sidebar metrics are no
longer the dominant first-row bottlenecks.

The remaining first-row wall is predominantly renderer/Vite transform and module
evaluation. Future optimization should start from the corrected `/app-shell.tsx`
Vite probe, not from more HTTP/session-list throttling.

## Accepted mechanisms

### Bootstrap-free global surfaces

- Added/used global, bootstrap-free session/project list surfaces for startup
  consumers that only need session/project metadata.
- Preserved compatibility by falling back only on true fast-path absence
  (`404`/`405`).
- Fixed an old-client fallback regression: the app's pinned
  `@opencode-ai/client` tarball predates the `roots` query parameter and
  silently drops it. The V2 compatibility fallback therefore uses the older
  `parentID: null` contract instead of `roots: true`.

### Directory bootstrap admission

- Directory bootstrap is serialized in staged tiers: critical session/path work
  first, then quiet-window/auxiliary tiers.
- MCP intent is now separated from MCP observer activation. During `loading` or
  `partial` child-store states, `child(..., { mcp: true })` records demand but
  cannot fire reactive `mcp-list`/resource queries ahead of bootstrap staging.
- After the staged MCP tier settles, `onMcpReady` enables reactive observers
  idempotently. If the directory lost MCP interest, no observer is activated.
- Already-complete directories retain immediate MCP activation semantics.

### Canonical directory-scoped query keys

- Directory-scoped TanStack query keys now use a canonical path key while
  preserving the exact directory payload sent to endpoints.
- This removes Windows cache fragmentation where `C:\\...` and `C:/...` were
  treated as different cached queries for the same workspace.
- The trace-confirmed duplicate `agent-list` disappeared after this change.

### Passive sidebar metrics are progressive

- Removed viewport-driven `session.prefetch(id, 200)` as the default for idle
  visible rows.
- Full-session cost and cache-hit percentage are computed directly from the
  materialized `Session` row (`cost` and cumulative `tokens`). This is both
  cheaper and more authoritative than recomputing from a bounded 200-message
  prefetch.
- Rich/history-only metrics remain exact, but hydrate only for selected/working
  rows or after intentional interaction.
- Pointer hover uses a short dwell/cancel gate so pointer sweeps do not create a
  background hydration herd. Keyboard focus and open/pointer-down remain
  immediate warm paths.

### Root-session indexes

- `session_project_directory_root_updated_idx` serves the project+directory root
  startup/sidebar query:
  `WHERE project_id=? AND directory=? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT ?`.
- `session_directory_root_created_id_idx` serves the V2 directory-root query:
  `WHERE directory=? AND parent_id IS NULL ORDER BY time_created DESC, id DESC LIMIT ?`.
- Both indexes are partial on `parent_id IS NULL`, so child sessions do not bloat
  navigation-only indexes.

## Measurements

### Live startup harness

`viewport-metrics-elision-20260915` warm run:

- `predev_done`: **1004ms**
- `vite_ready`: **3715ms**
- `electron_spawn`: **3931ms**
- `window_shown`: **5145ms**
- `sidebar.first-rows`: **5813ms**
- first-row transport: **0 active / 0 queued** requests
- no passive `localMCP-chat` or `getMCP` cold bootstrap during the 12s settle
  window; only the active draft workspace initialized.

Interpretation: visible sidebar rows no longer imply backend workspace
initialization. Post-paint backend work is now coupled to active route or user
interaction.

### SQLite root-session benchmark

300k synthetic session rows, 24 projects, 8 dirs/project, 250 queries:

| query | baseline median | baseline p95 | optimized median | optimized p95 | speedup |
|---|---:|---:|---:|---:|---:|
| project+directory root, updated order | 5.2559ms | 7.0253ms | 0.0297ms | 0.0360ms | ~177x median |
| directory root, created/id order | 31.4408ms | 37.5020ms | 0.0298ms | 0.0364ms | ~1055x median |

Baseline plans used `session_project_idx` or `session_parent_idx` plus temp
B-tree sorting. Optimized plans search the intended partial indexes directly and
avoid temp sorting.

Index build times in the same corpus:

- full composite comparison index: **298.618ms**
- project partial root index: **283.114ms**
- directory partial root index: **181.793ms**

### Corrected Vite renderer probe

The corrected renderer-root entry is `/app-shell.tsx`.

| probe | sync crawl | sync modules | sidebar crawl | sidebar modules | second crawl |
|---|---:|---:|---:|---:|---:|
| `final-app-shell-20260915` | 6208ms | 221 | n/a | n/a | 52ms |
| `final-app-shell-plus-sidebar-20260915` | 3491ms | 220 | 269ms | 170 | 51ms |

Read the two sync crawl times as a warm-machine range rather than a controlled
A/B. The stable conclusion is structural: the initial graph is now about
220-221 modules and the full sidebar body is deferred.

### Production build

Current-tree repository-local Electron-Vite build from `packages/desktop`:

- main SSR bundle: **32.86s**
- preload: **78ms**
- renderer: **4948 modules / 41.90s**
- exit code: **0**

Existing non-fatal warnings remain for CodeMirror/theme dynamic+static chunking
and a wasm sourcemap filename collision.

## Validation gates

- Focused app corpus: **146/146 tests**, 365 assertions.
- Server session-group projection: **5/5 tests**, 24 assertions.
- Desktop production build: **green**.
- Temporary request/caller instrumentation: removed; source-wide search found no
  remaining `[startup-request-*]` instrumentation.
- Scoped changed-file TypeScript check reported no diagnostics in the changed
  production source. Remaining diagnostics are pre-existing ambient/tooling
  issues: `ImportMeta.env/glob`, UI SVG declaration/project-root ambiguity, and
  `bun:test` not present in that tsconfig's type environment.

## Rejected or explicitly discarded work

- Lazy-loading `NewLayout` from `app.tsx` was tested and reverted. The A/B/A was
  too noisy and did not show a defensible improvement.
- An accidental `bunx electron-vite` build from `packages/opencode` was
  discarded. It used a temporary standalone Electron-Vite without the Desktop
  config and failed as expected; it was not used for certification.
- More HTTP/session-list throttling is not the next best target. First rows now
  arrive with the scheduler idle, and root-session SQL is sub-0.04ms p95 in the
  synthetic hot-path benchmark.

## Remaining frontier

The next real frontier is renderer graph/evaluation:

- keep using `raw/vite-lane-renderer-probe.ts` with `/app-shell.tsx`;
- target large synchronous app modules only when the corrected static crawl shows
  they are truly in the first graph;
- avoid reintroducing passive row hydration, eager MCP observers, or raw
  Windows-path query keys;
- treat backend/session-list work as solved unless a new trace shows non-zero
  active/queued scheduler state at `sidebar.first-rows`.

## Dirty-tree note

The repository was already heavily interleaved with other campaigns. This
closeout should be staged narrowly. Do not `git add -A`; include only the files
belonging to the startup/sidebar performance lane and any intentional raw log or
benchmark artifacts.
