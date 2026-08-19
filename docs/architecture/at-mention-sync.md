# At-mention sync — up-to-date file index architecture proposal

> Status: proposal for maintainer review. Synthesized from swarm exploration (m1
> app-side @-mention autocomplete map, m2 server-side file search + index state map)
> and the architecture design (deliverable/m3 — authoritative; blackboard
> `design/mention-sync`). All refs verified on branch `openfork` @ 93e423f1d2.
> Path convention: bare `src/…` paths mean `packages/opencode/src/…`; `packages/core`,
> `packages/app`, `packages/ui`, `packages/desktop`, `packages/schema`, `packages/client`
> are written in full.

## 1. Goal & non-goals

**Goal:** make `@`-mention file autocomplete reflect the current filesystem — new,
renamed, deleted, and untracked files appear in the popup within ~150–250 ms of the
filesystem change, without restarting the server or reopening a session, on every
client (app, TUI, CLI).

**Scope:**

- Server-side: keep the `GET /find/file` V1 endpoint (path-only response, no
  protocol change in P0). V2 protocol routes to `GET /api/fs/find` instead — same
  `FileSystem.find` underneath, so behavior converges (§2).
- Folders stay mentionable — the popup relies on trailing `/` on directory paths
  (server convention) and `mime: application/x-directory` for reference-style folder
  mentions.
- Untracked (non-ignored) files must appear; files matched by ignore rules
  (`.gitignore`, `.ignore`, `Ignore.PATTERNS`) must not.

**Non-goals (explicitly out):**

- **No SQLite persistence of the file index.** The drizzle DB is a single global
  `opencode.db` shared by all projects (`packages/core/src/database/database.ts:67-79`);
  per-event index writes would contend with session/event writes, and a DB adds no
  freshness — the watcher does. Per-project SQLite and db+memory hybrids are rejected
  in §4.
- No changes to session-message search. The `search_backfill`/FTS machinery is
  `SessionSearch` (`packages/core/src/session/search.ts`), unrelated to file search.
- No change to what the popup *shows* beyond freshness — ranking/budget rebalancing
  (files ranked last, 10-item cap) is P2 polish, not part of the freshness fix.
- No `git ls-files`-based tracking: the index must not filter on git-trackedness.

## 2. Current state (verified from m1/m2)

### App side (m1 — `packages/app`)

- Trigger: `handleInput` → `rawText.substring(0, cursorPosition).match(/@(\S*)$/)`
  (`packages/app/src/components/prompt-input.tsx:1000`), then `atOnInput(atMatch[1])`
  (:1004) and `setStore({ popover: "at", ... })` (:1005). Only in non-shell mode
  (:999).
- `useFilteredList<AtOption>` (`prompt-input.tsx:650-692`) wraps `items()` in a
  Solid `createResource` keyed on the filter string
  (`packages/ui/src/hooks/use-filtered-list.tsx:26-30`) — **every keystroke re-runs
  `items()`**, i.e. a fresh `searchFilesAndDirectories` HTTP call. No debounce, no
  `AbortSignal` (`packages/app/src/context/file.tsx:206-223`, `:300`).
  Display uses `grouped.latest` (use-filtered-list.tsx:60) → stale-while-revalidate:
  the previous keystroke's list stays visible during the fetch; Solid commits only the
  latest key, so the lag is display-only, not a correctness bug.
- `items()` composition (`prompt-input.tsx:656-670`): `referenceList()` +
  `agentList()` + `mcpResourceList()` + pinned `recent()` (open file tabs, active
  first — `prompt-input.tsx:237-253`, **not** a persisted MRU), then, for a non-empty
  query, `files.searchFilesAndDirectories(query)` deduped against open paths (:665-669).
- `AtOption` union `agent | resource | reference | file` at
  `packages/app/src/components/prompt-input/slash-popover.tsx:8-20`; popup renders
  `atFlat.slice(0, 10)` (:86) grouped reference→agent→resource→recent→file
  (`prompt-input.tsx:674-690`) — **files ranked last and capped at 10 total**: when the
  first four groups fill the budget, file search results never render.
- Wire call: `api.file.find` → legacy client `find.files` → `GET /find/file` (V1) with
  `query=…&dirs=true&directory=…` (`packages/sdk/js/src/v2/gen/sdk.gen.ts:1991-1995`;
  directory injected from the `x-opencode-directory` header,
  `sdk/js/src/v2/client.ts:18-48`). V2 protocol routes to `GET /api/fs/find` instead
  (generated `FilesFind`, `packages/client/src/generated/client.ts:852-856` →
  `packages/server/src/handlers/fs.ts:30-37`) — same `FileSystem.find` underneath, so
  the type-quirk fix (§4.5) behaves identically on both protocols.
- Folders are mentionable two ways: reference-type options insert
  `mime: application/x-directory` (`prompt-input.tsx:615`); search-result dirs arrive
  with a trailing `/` (server convention) and render as folders
  (`slash-popover.tsx:208-210`).

### Server side (m2 — `packages/opencode` + `packages/core`)

- Route: `FindFileQuery` (dirs/type/limit, limit 1..200)
  (`packages/opencode/src/server/routes/instance/httpapi/groups/file.ts:25-33`),
  endpoint `findFile` at **`/find/file`** — note: Effect HttpApi uses declared endpoint
  paths as-is, no `/file` group prefix; sibling `list` = `/file`, `content` =
  `/file/content` (groups/file.ts:95-102, 118-127), success
  schema `Schema.Array(Schema.String)` — **paths only, no metadata**.
- Handler `FileHttpApi.findFile` (`…/handlers/file.ts:43-60`): `limit = query.limit
  ?? 10` (:47), `type = query.type ?? (dirs === "false" ? "file" : undefined)` (:48),
  calls `FileSystem.Service.find` bound to the workspace directory via
  `LocationServiceMap` (:19-25), returns `found.map(item => item.path)` (:59).
- Index: `FileSystemSearch` (`packages/core/src/filesystem/search.ts`), two layers,
  chosen at :235 by `Flag.OPENCODE_DISABLE_FFF || !Fff.available()`.
  - `ripgrepLayer` (:23-120): walks the whole tree **once at location-layer
    construction** — `ripgrep.find({ pattern: "*", … })` forked into the location
    scope (:35-48) — into frozen in-memory arrays `state.files`/`state.directories`
    (dirs derived from file-path prefixes, trailing sep, :43-45). `find()` = fuzzysort
    over those arrays (:101-117). **No watcher subscription, no invalidation, no
    re-walk.**
  - `fffLayer` (:122-233): `Fff.create({ aiMode: true, disableMmapCache: true,
    disableContentIndexing: true })` (:126-133), live per-query search. **Unreachable
    here**: `OPENCODE_DISABLE_FFF` defaults `true` on win32
    (`packages/core/src/flag/flag.ts:34`) and `Fff.available()` is false on node
    (`packages/core/src/filesystem/fff.node.ts:130-132`). Desktop/CLI run node, so
    ripgrepLayer is effectively everywhere today.
- Index lifetime: location services are per-`Location.Ref`, built lazily on first
  `locations.get(ref)`, cached by `LocationServiceMap` with `idleTimeToLive: "60
  minutes"` (`packages/core/src/location-services.ts:84-112`, esp. :109). The index is
  therefore a snapshot from the **first** file search (or first tool use that touches
  FileSystem) for that directory, frozen until 60-min idle eviction or restart.
- Git filtering: `ripgrep.find` (`packages/core/src/ripgrep.ts:187-217`) runs
  `rg --no-config --files [--hidden?] [--follow?] --glob=!**/.git/** .` — **no
  `--no-ignore`, no `--hidden`**. Default ripgrep semantics: `.gitignore`/`.ignore`
  respected (incl. nested), hidden files skipped, `.git` excluded by glob. This is
  **not** `git ls-files`.
- Watcher: `@opencode/v2/FileWatcher` (`packages/core/src/filesystem/watcher.ts`),
  `@parcel/watcher` native (win32 backend "windows", :38-42). Emits
  `file.watcher.updated` `{ file, event: add|change|unlink }` to EventV2
  (:86-92) with the `location` attached (`packages/core/src/event.ts:419-438`).
  Subscriptions: (a) **project dir only when `location.vcs &&
  OPENCODE_EXPERIMENTAL_FILEWATCHER`** (:109-113; flag default false,
  `flag.ts:37-39`; desktop sets it `"true"`, `packages/desktop/src/main/server.ts:50`)
  → **off by default**; (b) **`.git` dir unconditionally** for git repos
  (:115-124). Consumers of `file.watcher.updated`: app-side only — **zero server
  consumers**.
- Database: single global SQLite (WAL), Drizzle, `opencode.db`
  (`packages/core/src/database/database.ts:67-79`). **No `file`/`entry` table
  exists.** `search_backfill`/`part_search_backfill` + FTS = session-message text
  search, not file search.

### What the prior analysis got right/wrong (m1 verdict)

- **Still correct:** the trigger regex, `<For atFlat.slice(0, 10)>`, the `AtOption`
  union, and the `items()` composition (references + agents + mcp resources + recent
  + file search).
- **Moved:** `slash-popover.tsx` is now `packages/app/src/components/prompt-input/
  slash-popover.tsx` (was `components/slash-popover.tsx`).
- **Corrected:** `recent()` is derived live from currently-open file tabs, not a
  persisted MRU store. Folder detection is by the server's trailing-`/` convention,
  and the server caps file results at 10 — the popup's 10-item total budget with
  files ranked last means file results can be entirely cut off.

## 3. Root cause (m2 verdict)

**Out-of-sync:** the search index is built **once per directory and never updated**.
`FileSystemSearch` ripgrepLayer snapshots the tree with `rg --files` at location-layer
construction into frozen in-memory arrays; `find()` fuzzysorts that snapshot. There is
no watcher feed, no invalidation, no refresh — the snapshot survives until the
`LocationServiceMap` 60-minute idle eviction or a server restart. Files created,
renamed, or deleted *after* the walk never appear (or keep appearing) in `@`-mention
results. This is server-side, not client-side: the app refetches per keystroke and
holds no file cache.

**Untracked-file exclusion:** *not* `git ls-files`. It is `rg --files` default ignore
semantics at build time: `.gitignore`/`.ignore` are respected (ignored files are
excluded whether tracked or not) and hidden files are skipped (no `--hidden`).
Untracked non-ignored files created **before** the index build **are** included. The
dominant cause of "new file missing from @-mention" is the frozen index; ignore
semantics are a secondary contributor for files matching ignore patterns.

**Contributing bugs:** server default limit 10 (`handlers/file.ts:47`); the app sends
`type: "directory"` for mixed search on V2 protocol, so the server returns
directories only (m1 quirk — V1 servers translate `dirs=true` → both, V2 passes `type`
verbatim); popup budget 10 with files ranked last (`prompt-input.tsx:681-690`).

## 4. Recommended architecture (designer's one-pick: in-memory + watcher)

**Pick (b): in-memory index + watcher-driven incremental updates — no SQLite.**

| option | verdict | why |
|---|---|---|
| (a) per-project SQLite tables | **rejected** | global `opencode.db` shared by all projects → write amplification + contention; per-project rows need partitioning; migration + backfill (session-search FTS precedent) buys nothing; a DB does not make results fresher — the watcher does; cold-start seeding would need a freshness validation anyway, so the "skip cold walk" benefit is illusory; a stale DB is worse than none. |
| (c) hybrid db+watcher+memory | **rejected** | second write path + db/memory consistency for zero freshness gain; only theoretical win (restart seed) is already covered by a cheap native rg walk. Revisit only if cold start is *measured* to hurt on huge repos — then a per-project cache **file**, never the global DB. |
| (b) in-memory + watcher | **accepted** | the freshness mechanism already exists and already flows: `@parcel/watcher` publishes `file.watcher.updated` to EventV2 with `location` attached — there is simply **no server consumer**. In-memory is the existing query path (fuzzysort); per-directory state is evicted by `LocationServiceMap` (60-min idle TTL) so memory is bounded; no migrations; iterate on the current ripgrepLayer shape. |

### 4.1 Source of truth

Per directory, inside the ripgrepLayer:

- `Map<relativePath, { mtimeMs, size }>` — files (fingerprint enables no-op skip for
  editor touches and cheap reconcile diffing);
- `Set<relativePath>` — directories, derived from path prefixes, retaining the
  trailing-`/` convention the app relies on (`slash-popover.tsx:208`).

Seeded by the existing rg walk; kept fresh by the EventV2 `file.watcher.updated`
stream.

### 4.2 Incremental update pipeline

- **Location:** `FileSystemSearch` ripgrepLayer (`packages/core/src/filesystem/
  search.ts`) — already per-directory via `makeLocationNode`. Add `EventV2.node` to
  the node's deps (search.ts:239).
- **Subscribe:** `EventV2.Service.subscribe(FileSystemWatcher.Event.Updated)` →
  `Stream`; filter `event.location?.directory === location.directory`; fork in scope
  inside the layer closure with `forkScoped`/`addFinalizer` cleanup. Pure Effect — no
  `EffectBridge` needed here; the native boundary is already bridged inside the core
  `FileWatcher`.
- **Coalesce:** `Stream.groupedWithin(~150 ms)` — editor saves fire bursts
  (tmp + rename); apply the batch as one mutation pass.
- **Apply per event:**
  - `add`: stat; skip if ignored; else `files.set(key, { mtimeMs, size })` + add all
    parent prefixes to the dirs set.
  - `change`: stat; unchanged size+mtime → no-op; else update fingerprint.
  - `unlink`: `files.delete`; prune now-empty dir prefixes.
  - `rename`: watcher reports delete(old)+create(new) (or an update with both paths on
    some backends) — if a delete+create pair with the same basename lands in the same
    batch, treat as a move; otherwise delete+add.
- Keep files and dirs both mentionable.

### 4.3 Untracked files

The watcher is **not** git-aware (`@parcel/watcher` never consults git), so create
events fire for brand-new untracked files. **Do not filter by git-trackedness** —
filter only by ignore rules: `Ignore.PATTERNS` + `.gitignore`/`.ignore` via the
`ignore` npm matcher already used by `handlers/file.ts:73-90`. This satisfies
"untracked must appear" and matches rg's build-time semantics.

### 4.4 Watcher gating (maintainer decision, shapes P0)

The project-dir subscription is gated behind `OPENCODE_EXPERIMENTAL_FILEWATCHER`
(default **off**; desktop sets it on, `desktop/src/main/server.ts:50`; WSL sidecar
disables it, `desktop/src/main/wsl/sidecar.ts:33`).

**Researched gate history (server-mapper, `notes/watcher-gate-history`):**

- **No documented perf/crash rationale.** The flag has been default-off since the
  effectified watcher landed (9e740d9947, Mar 2026); no comment, commit message, or doc
  cites a platform failure. It reads as "new infra ships experimental until proven".
- **The ONE deliberate restriction is git-only, not platform:** f95f877e5f (Jul 2026)
  "fix(core): watch only git projects" added `location.vcs &&` (watcher.ts:109) and
  flipped the test from "watches non-git roots" → "skips non-git roots". Intent =
  bound event volume to git workspaces; non-git roots are unbounded and only the fixed
  `Ignore.PATTERNS` list controls volume.
- **Failure modes are already safe:** native binding lazy+optional (no-op if missing),
  10s subscribe timeout, layer degrades to no-op Service on init failure
  (watcher.ts:127-133). Un-gating adds no crash surface — worst case is "silently no
  events".
- **Desktop ALREADY ships with it ON** (`desktop/src/main/server.ts:50`) — full-dir
  watching is default-on for desktop users (field-tested); the flag only gates
  CLI/TUI servers.

**Recommendation (P0-safe, operator decision — git-only guard REMOVED):** flip the
project-dir subscription default **on** when the native binding exists, **and drop the
`location.vcs &&` git-only guard** — the project-dir watcher must run for ANY root,
git or not (operator requirement: "see ANY file, not git only"; f95f877e5f's event-volume
concern is mitigated by ignore filtering — `Ignore.PATTERNS` + config `watcher.ignore` +
protected paths — not by requiring git). Implemented: `watcher.ts:109` no longer checks
`location.vcs`; `OPENCODE_EXPERIMENTAL_FILEWATCHER` defaults to `true`
(`flag.ts:37-39`). Keep `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER` as the opt-out.
The P1 reconcile-on-open safety net (§4.7) remains as a belt-and-suspenders layer.

### 4.5 Query path (V1)

- Keep `GET /find/file` (InstanceHttpApi "file" group — **not** the experimental
  group). No new route group; no protocol change in P0 → **no SDK regen**. (V2
  protocol uses `GET /api/fs/find` — same `FileSystem.find` behind both, so the
  freshness fix and the type quirk are shared: one fix in `FileSystemSearch` covers
  V1 and V2 simultaneously.)
- Request unchanged (`FindFileQuery`: `query`, `dirs?` (`"true"|"false"`), `type?`,
  `limit?` — V1 compat sends `dirs`, V2 sends `type`).
- Response unchanged: array of relative paths, dirs with trailing `/`.
  **V1-only shape:** the V2 endpoint already returns
  `Location.response(Array(FileSystem.Entry))` — `Entry { path, type }` wrapped in a
  location response (`packages/protocol/src/groups/fs.ts:50-61`); only the V1
  `/find/file` returns plain strings. So the P2 `Entry { path, type }` response
  change + SDK regen is a **V1-only** change; the V2 surface needs no response-shape
  work, just the freshness fix (§4.8).
- **Fix (limits):** server default limit 10 → **30 in P0** (`handlers/file.ts:47`), → **~200 in P1** once the popover is virtualized and the smart scorer returns a guaranteed best→worst total order. The response is paths only, so 200 items is a small payload; the top-K heap (§4.6) makes 200 cheap to compute.
- Matching: the tiered smart matcher with prepared indexes replaces per-keystroke
  fuzzysort over the raw arrays — see §4.6 (indexes land in P1, scoring polish in
  P2; the fuzzysort call in search.ts:109 is the thing being replaced).
- **Client fix (app-mapper lane, P0, verified one-liner):** in
  `packages/app/src/context/file.tsx:206-223` `search()`, change
  `type: dirs === "true" ? "directory" : "file"` → `type: dirs === "true" ? undefined :
  "file"`. Both protocols land on the same `FileSystem.find` with `type` omitted →
  mixed files+dirs:
  - V2: `api.file.find` → generated `FilesFind` → type optional
    (`packages/client/src/generated/types.ts:2600`) → `fs.find` → mixed (search.ts:108).
  - V1: compat `value.type === undefined ? undefined : …` (server-compat.ts:433) → no
    `dirs` → handler maps to undefined (handlers/file.ts:48) → mixed.
  - `searchFiles` ("false") stays `type: "file"` → files only on both.
  - Note for P2: with `type` omitted, V1 compat labels every result
    `{ path, type: "file" }` (server-compat.ts:437) — harmless today (the app reads
    only `.path`; dirs detected by trailing `/` which survives `normalize`), but the
    `Entry { path, type }` P2 response should make V1/V2 labeling consistent.

### 4.6 Matching algorithm — smart + fast

**Why the current matcher is not good enough** (`ripgrepLayer.find`, search.ts:101-117):

1. `[...state.files, ...state.directories]` allocates a fresh O(N) array on **every**
   keystroke; `fuzzysort.go(query, items, {limit})` re-normalizes (lowercases) every
   target on every call — nothing is prepared or indexed. At 100k+ files this is
   wasted work on the hot path.
2. fuzzysort scores the whole relative path with no structural awareness:
   `foo` ties between `foo.tsx` and `very/deep/path/foo.tsx` (same consecutive run, no
   depth penalty); matches never weight basename over path segments.
3. Literal-char matching: `foo_bar` misses `foo-bar`/`fooBar`; `uiBtn` misses
   `uiButton`; no camel-boundary splitting.
4. No extension awareness: `chat.ts` ranks the same as `chat.tsx`.
5. No typo tolerance beyond fuzzysort's gap-heavy subsequence, which also produces
   cross-segment scatter false positives (`x/y/z` matching scattered chars across the
   whole path).
6. No multi-token queries (`src chat`), no path-completion (`src/` → children of
   src), no ancestor constraints (`components/chat` must be inside `components`).
7. mtime is ignored — recency (already tracked by the P0 fingerprint map) is unused.
8. Even a perfect rank is often invisible: the popup caps at 10 results **across all
   groups with files ranked last** — the group-aware budget (§5 P2) is a prerequisite
   for the algorithm to matter.

**Normalization (build-time, per entry, O(N) once + incremental):** NFKD fold
(é→e, ﬁ→fi) → lowercase → split on separators (`/ \ _ - .`) **and camel boundaries**
(`fooBar` → `foo bar`). Each entry yields: `words[]` (basename), `segments[]`
(whole path), and a normalized full-path string. Directory entries are entries too —
basename = last segment, trailing `/` preserved for display.

**Query pipeline:** client debounces (~120 ms) + AbortSignal + skips queries < 2
chars + small LRU of recent query→results (size ~50); server normalizes the query
identically into `queryWords[]`; a trailing `/` selects path-completion mode; a `/`
inside the query adds ancestor constraints.

**Matching tiers — evaluate in order, stop when the limit is reached (early exit
per tier, fill from the next tier only if slots remain):**

| tier | predicate |
|---|---|
| T0 | normalized basename equals query (extension-insensitive: `chat` ≡ `chat.tsx`) |
| T1 | basename starts with a query word at a word boundary (`chat` → `chatroom.tsx`, `chat_box.tsx`) |
| T2 | camel-hump: query words match consecutive word-starts of basename words (`uiBtn` → `uiButton.tsx`) |
| T3 | contiguous substring within a basename word (boundary not required) |
| T4 | any non-final segment matches (directory containment; dirs compete on their own basename) |
| T5 | consecutive run in the full path not starting at a segment boundary |
| T6 | fuzzy: within-word gap ≤ 1 and Damerau-Levenshtein ≤ 2 for queries ≤ 8 chars (`recieve` → `receive.tsx`) |
| T7 | nothing — no cross-segment scattering (explicitly rejects fuzzysort's path-scatter) |

**Scoring (higher wins; tiers dominate):** base tier weight (1000/800/650/500/350/
200/100) − 15 × (segment depth − matched segment index) − 0.5 × unmatched chars in
the entry + 20 per query word starting at a word boundary + 50 for exact-basename +
recency boost `min(30, (7 − daysSinceMtime) × 5)` (from the P0 fingerprint mtime;
0 after 7 days) − 40 if the query has a dot and the extension differs. Tie-breaks:
fewer segments → shorter total → alphabetical. Case is never penalized (normalized).
With a trailing `/`, dirs sort before files; otherwise files first.

**Maximum-optimization strategy (the whole point of the index):**

- **Prepared typed indexes, built once, maintained incrementally by the same P0
  watcher batch (no per-keystroke normalization, no O(N) scans):**
  - `norm: string[]` — parallel lowercase full paths (the fuzzysort.prepare
    equivalent, but free because P0 already owns the array);
  - `basenameWords: Map<string, Int32Array>` — word → sorted entry ids (dirs
    included, flagged);
  - `segmentIndex: Map<string, Int32Array>` — segment word → ids (T4);
  - `bigramIndex: Map<string, Int32Array>` — 2-char bigrams, **only** as the T6
    prefilter (queries ≥ 4 chars);
  - `mtime: Float64Array` — parallel to `files` (fingerprint values).
  - Ids are indices into the existing `files`/`directories` arrays — no copies.
- **Per-keystroke cost:** tokenize query (O(q)) → basename index lookups → candidate
  id set (typically < 100) → score only candidates into a fixed-size top-K heap with
  early exit per tier. Common-word worst case (`index` in a huge repo) is bounded by
  a hard candidate cap (e.g. score at most 2,000, then keep top-K). No full-array
  scans, no re-lowercasing, no allocation of the mixed array.
- **Incremental maintenance:** the debounced watcher batch (P0 §4.3) updates
  `files`/`directories` and all indexes in place (O(words) per entry), so bursts
  amortize; memory is a few MB at 100k entries (typed arrays, no entry copies),
  bounded by the 60-min idle eviction already in place.
- **Client:** debounce + abort + LRU + <2-char skip; stale-while-revalidate stays,
  but the previous list is dropped the moment the new response lands
  (`grouped.latest` already does this).
- The smart matcher replaces fuzzysort in `ripgrepLayer` only; the FFF layer (Bun
  path) keeps its own search. One matcher per layer, no double scoring.

**Rendering: no truncation — full list, best→worst, virtualized.** The current
popover caps at `atFlat.slice(0, 10)` (`slash-popover.tsx:86`) inside a `max-h-80`
box, so most file results — however well-scored — never render. Replaced by:

- **Server returns the ranked list; the client renders it in that order, no client
  re-sort** — the scorer's total order (tier dominance → penalties → tie-breaks) IS
  the sort.
- **Unified scrollable list:** the identity groups (references, agents, MCP
  resources, recent/pinned — few items, identity-pinned) render compactly at the
  top; then **ALL** file/directory results sorted best→worst fill the rest. The
  old "files ranked last can starve under the 10-item cap" failure mode disappears
  by construction — nothing is sliced.
- **Virtualize the list with `@tanstack/solid-virtual`** (already a dependency,
  `packages/app/package.json:81`): fixed-height rows (~30px), windowed render over
  the scroll container, absolute positioning + `max-h` retained. DOM stays bounded
  (~15 rows) even at the full cap — this is what makes the larger limit free at
  runtime. Scrollbar affordance signals more results.
- **Show-more affordance:** the list starts at a focused window (~30 rows) with a
  **"Show more results" footer row** at the bottom (part of the virtual list, so it
  stays reachable by scrolling and by ArrowDown). Activating it (click, or select +
  Enter — ArrowDown past the last result lands on it) raises the rendered window by
  a chunk (+50) until the full server-ranked list is revealed; the footer disappears
  once everything is shown. State resets per query (each keystroke restarts the
  window). This keeps the default view scannable — most queries only need the top
  matches — while guaranteeing nothing is unreachable. The window cap and chunk size
  are constants, tunable after field use.
- **Keyboard nav becomes virtual-index aware:** the selected index can exceed the
  viewport — auto-scroll the active row into view on ArrowUp/Down (mirror the
  existing `scrollSlashActiveIntoView`, prompt-input.tsx:1416) and keep Enter
  selecting the highlighted row. The current `slice(0,10)` nav model is removed
  with the slice.

### 4.7 Failure modes

| failure | mitigation |
|---|---|
| Watcher miss (atomic-save rename: tmp write then rename-over) | debounce batch coalesces; tmp files covered by `Ignore.PATTERNS` (extend with `**/*.tmp`, `**/*~` if needed). If a create is lost entirely: **reconcile on popover open** — when the app opens the popup with an empty query, server triggers a bounded freshness pass (background rg re-walk if `now − lastIndexUpdate > TTL`). Event-driven (user action), **not polling**. |
| Ignore-rule changes | `.gitignore`/`.ignore` change events → recompile matcher + re-walk (rare, cheap). |
| Huge directories | keep the rg 100k-file cap on non-git seed walks; watcher events dropped early for ignored paths; batch apply bounds churn. |
| Network mounts / unsupported backend | `hasNativeBinding()` guard (watcher.ts:51) → fall back to reconcile-on-open; log once. |
| Symlinks | rg doesn't follow dir symlinks; watcher reports symlink creates — explicit policy decision for maintainers (P1). |
| Win32 case sensitivity | index keys may differ in case from later events — normalize (lowercase keys) in P1. |

### 4.8 Proposed files/services (delta)

| file | change |
|---|---|
| `packages/core/src/filesystem/search.ts` | extend ripgrepLayer with watcher feed + fingerprint `Map`/`Set` (P0); replace per-keystroke fuzzysort with prepared typed indexes + tiered scorer (§4.6, P1); keep `export * as FileSystemSearch from "./search"`; non-exported helpers (`applyBatch`, `ignoreFilter`, `dirPrefixes`, `scorer`) below the main export. Add `EventV2.node` to node deps (:239). |
| `packages/core/src/filesystem/watcher.ts` | done — project-dir subscription runs for ANY root (git-only guard removed, `location.vcs &&` dropped at :109) and `OPENCODE_EXPERIMENTAL_FILEWATCHER` defaults to `true` (§4.4, operator decision). |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts` | default limit 10 → 20–30 (:47). |
| `packages/app/src/context/file.tsx` (+ `prompt-input.tsx`) | one-liner: `type: dirs === "true" ? undefined : "file"` (mixed-search quirk, §4.5); keep `useFilteredList` generic (4 consumers) — put ~150 ms debounce in the at `items()` closure (`prompt-input.tsx:657`) or in `file.tsx` `search()`; thread `AbortSignal` through `searchFilesAndDirectories` (`file.tsx:300` drops it). App-mapper lane. |

No SDK regen in P0. P2's `Entry { path, type }` response change is **V1-only** (the V2
endpoint already returns `Location.response(Array(FileSystem.Entry))`,
`packages/protocol/src/groups/fs.ts:50-61`); if pursued, run `bun run generate` from
`packages/client` (per AGENTS.md) for the V1 surface only.

## 5. Phased plan

**P0 — minimal staleness fix (no DB):**
1. Watcher is already un-gated and default-on (§4.4, operator decision) — wire the
   search layer to the `file.watcher.updated` events.
2. Subscribe in ripgrepLayer: location-filtered, debounced (~150 ms) batch apply of
   add/change/unlink + ignore filter + fingerprint map; dirs kept mentionable.
3. Server default limit 10 → 20–30.
4. App: fix the `type: "directory"` mixed-search quirk.

Result: new/renamed/deleted/untracked files appear within ~150–250 ms; no polling;
no DB; no protocol change.

**P1 — index hardening + fast matching:**
- Reconcile-on-open safety net (bounded re-walk when stale; §4.7).
- `.gitignore`/`.ignore` recompile + re-walk on change.
- Rename detection in batch (delete+create, same basename).
- Win32 case normalization (lowercase index keys).
- Symlink policy decision + implementation.
- **Prepared match indexes + tiered scorer (§4.6):** `norm` array, `basenameWords`,
  `segmentIndex`, `mtime` array, maintained by the same watcher batch; T0–T5 scoring
  with depth/length/extension penalties; top-K heap with per-tier early exit;
  client debounce + AbortSignal + LRU + <2-char skip.
- Optional per-project durable seed *only if* cold start is measured to hurt — cache
  file, never the global DB.

**P2 — scoring polish + popup budget:**
- `Entry { path, type }` response — **V1-only** (V2 already returns
  `Location.response(Array(FileSystem.Entry))`, `packages/protocol/src/groups/fs.ts:50-61`)
  + SDK regen for the V1 surface (`bun run generate` from `packages/client`); align
  V1/V2 labeling.
- T6 typo tolerance (DL ≤ 2) + bigram prefilter; multi-token space queries;
  path-completion mode (trailing `/`) and ancestor constraints (`/` inside query);
  recency boost from fingerprint mtime; camel-hump refinement (§4.6).
- Popup budget fix: files ranked last + `slice(0, 10)` can starve file results (m1).
  **Group-aware budget** (app-mapper): cap the non-file groups and guarantee K file
  slots before passing `atFlat` — the hook already exposes `grouped`
  (use-filtered-list.tsx:123), so `prompt-input` can cap reference/agent/resource/
  recent and reserve file slots; raising the cap alone does not fix starvation.
- Per-session client cache with SSE invalidation, if ever needed.

## 6. Open questions (for maintainers)

1. ~~Flip `OPENCODE_EXPERIMENTAL_FILEWATCHER` default on for the project dir, keeping
   the `location.vcs &&` git-only guard?~~ **RESOLVED (operator decision):** the
   git-only guard is removed — the project-dir watcher runs for ANY root, git or not —
   and the flag defaults to `true` with `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER`
   as the opt-out (§4.4; implemented in `watcher.ts:109` / `flag.ts:37-39`).
2. Keep the 100k-file cap on non-git seed walks?
3. Accept reconcile-on-open (re-walk on popup open when stale) as the non-polling
   safety net?
4. OK to add `EventV2` as a dependency of `FileSystemSearch.node`?
5. **Replace fuzzysort outright** in `ripgrepLayer` with the tiered scorer (§4.6), or
   keep fuzzysort as a T6-adjacent fallback? (Recommendation: replace — fuzzysort's
   path-scatter subsequence produces the false positives T7 rejects, and the
   prepared indexes make the tiered scorer strictly cheaper.)
6. **Index sizing on 100k+ repos:** validate the `basenameWords`/`segmentIndex`
   map overhead and common-word candidate cap (2,000) with a real large-repo
   benchmark before P1 lands (cheap to measure, awkward to retrofit).
7. **Recency boost magnitude** (7-day window, ×5/day, cap 30): tune with field data;
   too strong and stale-but-relevant files drown, too weak and it does nothing.
8. **Typo tolerance trade-off:** DL ≤ 2 on short queries is the right ergonomics
   default, but it can surface near-misses over exact matches — confirm the tier
   (T6 ≪ T5) keeps exact-match dominance in practice.
5. Symlinked files: index (mentionable) or skip (rg parity)?
6. Win32: case-normalize index keys?
