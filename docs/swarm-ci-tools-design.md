# CI Code-Intelligence Tools — `project`, `symbols`, `test` — Implementation-Ready Design

Status: **AMENDED TO MATCH SHIPPED IMPLEMENTATION — all three tools built & ratified** (2026-08-15)
Owner: ci-designer · Consumers: project-builder, symbols-builder, test-builder · Verifies: ci-verifier
Date: 2026-08-15
Companion docs: `docs/swarm-sqlite-design.md` (native-tool conventions, §2), `docs/swarm-tool-upgrade-design.md` (suite conventions).

> **Amendment record (this doc tracks the shipped surface, not the pre-build spec):**
> - `test` (§6): ratified build deviations — local-bin resolution (no npx/npm/.cmd), runtime auto = harness-native + explicit mismatch errors, temp-dir fixtures + hermetic live spawns, vitest `--outputFile` probe, failures cap 50.
> - `symbols` (§5): ratified build deviations — import-binding defs (kind="import"), same-file refs attributed only when import-reached, JS class names = `identifier` (field-based name extraction).
> - `project` (§4): ratified build deviations + coordinator/user additions — `action` discriminator, `recent` (§4.9), `toolchain` (§4.10), git/worktree awareness + init summary (§4.11), worktree-root file listing with manifest walk-up, `+RipgrepBinary.node` registry dep (permission model unchanged: one `read` ask, §9).
> - Flags: wasm ABI (was §12.1) and TS node-kind names (was §12.2) RESOLVED by build verification.

---

## 0. TL;DR

Three new native default tools, each a single `Tool.define(id, ...)` with a `Schema.Struct`
of optional params (mode/action-style discriminators), XML-ish output, and `Effect.orDie`:

| id | one-liner | actions | key infra |
|---|---|---|---|
| **`project`** | codebase orientation snapshot — stack/framework detection, .gitignore-aware bounded tree, annotated scripts, entry points/configs/CI, stats, git/worktree awareness, init summary | `action: snapshot (tier: summary \| structure \| full) \| recent \| toolchain` (default `snapshot`, tier `summary`) | ripgrep file lists + manifests only; **never reads source bodies** |
| **`symbols`** | code intelligence — find definitions, file outline, find usages (JetBrains-style) | `search \| outline \| usages` | grep-anchored tree-sitter indexing (TS/TSX/JS), mtime-keyed outline cache, regex fallback |
| **`test`** | multivariate engine-aware test runner | `run` (default) \| `list` | harness detection (bun/vitest/jest/node:test), per-harness reporter strategy, child process + timeout + kill + spill, dedicated `test` permission |

All three: token-lean output with caps + `N more` hints, spill-to-file via the existing
truncation mechanism, worktree-bound path guards, `assertExternalDirectoryEffect`,
`.pipe(Effect.orDie)`, `DESCRIPTION` from a `*.txt` sidecar. All three are registered
**additively** in `src/tool/registry.ts` (multiple lanes edit that file concurrently —
append-only discipline, §8).

---

## 1. Settled Decisions (binding)

| # | Decision |
|---|---|
| D1 | tool ids `project`, `symbols`, `test`; each a native default tool in `src/tool/<id>.ts` (+ `<id>.txt`) |
| D2 | `project`: `action` discriminator — `snapshot` (default; `tier` summary \| structure \| full) + ratified additions `recent` (N newest files) + `toolchain` (installed runtimes/env) + git/worktree awareness + init summary; **never reads source bodies** — only manifests/config (capped), ripgrep file lists/line counts, and `fs.stat` metadata |
| D3 | `project` stack detection across ecosystems: package.json / pyproject.toml / Cargo.toml / go.mod / pom.xml / requirements.txt / Gemfile / composer.json + framework-deps + lockfile type + monorepo/workspaces |
| D4 | `project` tree is .gitignore-aware (ripgrep `--files` semantics, which respect ignore files), depth-bounded (default 3, max 5), entry-bounded (default 200, max 500), grouped by importance with subtree byte sizes |
| D5 | `symbols` actions: `search {query, path?, kind?, lang?}` \| `outline {file}` \| `usages {query \| file+line}`; indexing v1 = **grep-anchored**: ripgrep candidate files, then tree-sitter classify; regex declaration-scanner fallback for languages without a grammar |
| D6 | `symbols` grammars first-class: TS/TSX/JS (tree-sitter-typescript + tree-sitter-javascript); others additive later. Usages precision via tree-sitter name nodes only (`identifier`/`type_identifier`/`property_identifier` — strings/comments structurally excluded), declaration-vs-reference by parent node kind, import-aware cross-file attribution, **unattributed bucket** for same-name-different-binding files (never pretend usages) |
| D7 | `symbols` outline cache is `InstanceState`-scoped, keyed by file mtime; staleness → refetch |
| D8 | `test` actions: `run` (default) \| `list`. Harness detection from config+deps: bun test / vitest / jest / node:test first-class; mocha/ava/playwright best-effort |
| D9 | `test` reporter strategy **per harness** (verified on this machine, `research/test-reporters`): JSON for jest/vitest; **TAP13** for node:test (json reporter is node 23+ only); **text-parse** of bun's default console output (bun 1.3.14 has no json reporter — only `junit`+`dots`); text/TAP as the universal fallback |
| D10 | `test` `runtime: auto \| bun \| node` — ratified at build: `auto` = harness-native runner; explicit runtime on a mismatched harness errors. Binary resolution local-bin only (no npx/npm/.cmd spawning) |
| D11 | `test` child process: spawn + stream, bounded tail, `ctx.abort`, hard timeout → kill; full output spilled to file; output = `N passed / N failed / N skipped (dur)` + failing list (file:line — name — first assertion line, capped) + full-output path |
| D12 | `test` filters: `path` + `testNamePattern` (mapped per harness); dedicated **`test` permission** whose pattern is the resolved runner command (git.ts precedent: key + command-as-pattern) |
| D13 | registry.ts edited concurrently by multiple lanes — build must merge **additively** (append-only; exact insertion snippet §8) |
| D14 | tree-sitter wasm loading reuses `shell.ts`'s `resolveWasm` pattern via a shared helper module (`src/tool/tree-sitter.ts`); shell.ts may adopt it later (flagged, not required) |
| D15 | pure-test plan: fixture repos (committed `packages/opencode/src/tool/__fixtures__/ci/` for project/symbols; **ratified deviation** for test: temp-dir fixtures + hermetic live bun/node spawns via the tool, plus canned-output parser tests); no live browser, no network, never spawns repo test files |

---

## 2. Native Conventions (recap — grounded)

Same shape as the suite (verified against `json.ts`, `archive.ts`, `git.ts`, `typecheck.ts`, `grep.ts`, `sqlite.ts`):

- `export const Parameters = Schema.Struct({ ... })` with `.annotate({ description })` per field; optional via `Schema.optional(...)`. Use `NonNegativeInt`, `PositiveInt`, `optional` from `@opencode-ai/core/schema`.
- `export const <Id>Tool = Tool.define("<id>", Effect.gen(function* () { const svc = yield* Service; return { description: DESCRIPTION, parameters: Parameters, execute: (params, ctx) => Effect.gen(function* () { ... }).pipe(Effect.orDie) } }))`
- `DESCRIPTION` imported from `./<id>.txt` (sidecar; content in §7).
- Path resolution: `InstanceState.context` → `{ directory, worktree }`; join relative params to `directory`; `path.relative(worktree, abs)` for rel paths; **worktree-bound guard** (reject `..`/absolute-escape — typecheck.ts:245 precedent).
- `yield* ctx.ask({ permission, patterns, always, metadata })` — permission keys are **free-form strings** (`PermissionV1.Rule.permission: Schema.String`); dedicated keys already in use: `git`, `typecheck`, `grep`, `read`, `edit`. `always` = auto-allow once approved.
- `assertExternalDirectoryEffect(ctx, abs, { kind: "file" | "directory" })` for external-dir checks (grep.ts:56 precedent).
- Return `{ title, output, metadata }`; `output` is XML-ish text; set `metadata.truncated` when you self-truncate.
- Ripgrep service `@opencode-ai/core/ripgrep`: `find({cwd, pattern, limit, hidden, follow, signal})` → `Entry[]` (respects ignore files — **never pass `--no-ignore`**; hidden excluded unless `hidden:true`); `grep({cwd, pattern, include, limit, signal, file})` → `Match[]` with `{ entry.path (posix rel), line, offset, text (≤2k chars), submatches: {text,start,end}[] }` (JSON records, `--no-messages`).
- Child processes: `AppProcess.Service` (`app.run(ChildProcess.make(cmd, args, {cwd, stdin:"ignore", stdout:"pipe", stderr:"pipe"}), { maxOutputBytes, timeout, signal })` → `RunResult { stdout, stderr, exitCode, outputTruncated, stdoutTruncated, stderrTruncated }`) — typecheck.ts:102 precedent. For streaming: `process.spawn` + `collectStream(handle.stdout, max)` (ripgrep.ts:112 precedent) + `handle.exitCode` + `Effect.raceFirst(waitForAbort(signal))`.
- Truncation: `Truncate.Service` (`truncate.output(text, opts, agent)` writes spill file + returns hint) — the default tool wrapper already truncates; tools that self-manage size set `metadata.truncated` and spill via `Truncate.write`. Spill files land in `Global.Path.data/tool-output/` (`truncation-dir.ts`).
- Config for per-tool output limits: `tool_output.max_lines / max_bytes` (truncate.ts:91).

---

## 3. Shared Infrastructure

### 3.1 Tree-sitter wasm loading (`src/tool/tree-sitter.ts`)

Reuse `shell.ts`'s exact pattern (verified, shell.ts:92-97 and :393-418):

```ts
// src/tool/tree-sitter.ts
import { fileURLToPath } from "url"
import { lazy } from "@/util/lazy"
import type { Language, Parser } from "web-tree-sitter"

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}
```

- `lazy()` singleton `parser` like shell.ts: `Parser.init({ locateFile: () => resolveWasm(treeWasm) })` once, then `Language.load(resolveWasm(grammarWasm))` per grammar, one `Parser` per language.
- Grammar registry (new deps in `packages/opencode/package.json`): `tree-sitter-typescript` (grammars `typescript` + `tsx`), `tree-sitter-javascript` (grammars `javascript` + `jsx`); both loaded via `await import("tree-sitter-<pkg>/<file>.wasm" as string, { with: { type: "wasm" } })` exactly as shell.ts does for bash/powershell.
- **⚠ FLAG (build-time verify):** `web-tree-sitter` is pinned `0.25.10`. The published `tree-sitter-typescript`/`tree-sitter-javascript` `.wasm` bundles must be ABI-compatible (v0.25 era). If the published wasm rejects `Language.load` (ABI mismatch), build the grammar wasm from source (`npx tree-sitter build-wasm <grammar-dir>` at the pinned version) and commit the `.wasm` under `packages/opencode/src/tool/` alongside `resolveWasm` handling, matching how shell.ts ships its grammars. **Verify with a 5-line smoke test before wiring the tool.**
- Shared, so `shell.ts` can adopt it later (refactor flagged, not required — do not touch shell.ts this lane).

### 3.2 Outline cache (`InstanceState`)

`symbols` caches per-file outlines keyed by **mtime** (size + mtimeMs are the key; content hash not needed for v1 — stale-if-mtime-changed is sufficient because the cache is per-session `InstanceState`):

```ts
type OutlineCache = Ref.Ref<Map<string, { mtimeMs: number; size: number; outline: FileOutline }>>
// InstanceState.make<Ref.Ref<OutlineCache>>(...) — registry.ts:182 precedent
```

Cache lives for the session; entries evicted above MAX_CACHE_ENTRIES = 500 (LRU-ish: clear-oldest on insert past cap). Read-then-parse only on miss/stale.

### 3.3 Ripgrep anchoring

Both `project` and `symbols` anchor on ripgrep for candidate discovery:
- `project`: `ripgrep.find({ cwd, pattern: "*", limit: N })` for file lists (ignore-aware, hidden-excluded).
- `symbols` search: `ripgrep.grep({ cwd, pattern: \b<escaped>\b, include, limit })`.
- `symbols` usages: same word-boundary grep across scope, then classify per file.
- Escape the user query with `escapeRegex` before building `\b<q>\b`; handle `\b` edge at non-word boundary positions (empty query → error; query starting/ending with non-word chars → fall back to plain `escapeRegex` match, no `\b`).

### 3.4 Spill + caps

- Self-managed caps set `metadata.truncated = true` and write full content via `Truncate.write(text)` (returns spill path); include the hint line (mirror truncate.ts:145-153 wording): `Full output saved to: <path> — use Read with offset/limit or Grep to inspect.` (task-tool variant when the agent has task permission).

---

## 4. Tool `project` — codebase orientation snapshot

File: `src/tool/project.ts` + `project.txt`. No new deps (uses `Ripgrep` + `fs`).

### 4.1 Parameters (exact)

```ts
export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["snapshot", "recent", "toolchain"])).annotate({
    description: "What to do (default snapshot). snapshot = the orientation snapshot with tier; recent = N newest files; toolchain = installed runtimes + env.",
  }),
  tier: Schema.optional(Schema.Literals(["summary", "structure", "full"])).annotate({
    description: "Detail level for snapshot (default summary). summary = lean stack+scripts+entry+stats one-liners; structure = adds bounded tree with sizes; full = everything + annotated scripts + config/CI lists.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Subdirectory to scope the snapshot to (default: project root). Relative to the working directory.",
  }),
  depth: Schema.optional(Schema.Int).annotate({ description: "Tree depth for structure/full tiers (default 3, max 5)" }),
  maxEntries: Schema.optional(Schema.Int).annotate({ description: "Tree/entry cap (default 200, max 500)" }),
  recent: Schema.optional(Schema.Int).annotate({ description: "recent: how many newest files to list (default 15, max 50)" }),
})
```

Permission: **one ask per call** — `permission: "read"`, `patterns: [scopeRel]`, `always: [scopeRel]`, `metadata: { action, tier?, path, recent? }` where `scopeRel` is the analyzed dir/file path relative to worktree (mirrors read.ts file-scoped ask; the tool derives everything from metadata of that scope). Read-only, no writes.

### 4.2 What it reads (and what it never reads)

**Reads:** manifest/config files only — `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `requirements.txt`, `Gemfile`, `composer.json`, `tsconfig.json`, lockfiles (existence only, except parse of `workspaces`/`packageManager` fields), CI files (existence only). Each file capped at 256 KB (`if (stat.size > 256_000) → note "skipped: too large"`).
**Never reads:** any other file's body. File lists via `ripgrep.find`; sizes via `fs.stat`; LOC via ripgrep line-count (below). No `readFile` on source files. This is a hard rail — verifier checks there is no source-body read in `project.ts` (only `manifestText(path)` helper opens the allowlisted manifest paths).

### 4.3 Stack/framework detection

`detectStack(directory)` reads manifests present in the scope root, in ecosystem priority order; missing → skip.

**Node** (`package.json`): `name`, `version`, `packageManager`, `engines.node`, `workspaces` (array or `{packages}` → monorepo), `dependencies`+`devDependencies` keys → framework map (first hit, then up to 3 total):
`react, react-dom → React; next → Next.js; vue → Vue; svelte → Svelte; @angular/core → Angular; express → Express; fastify → Fastify; @nestjs/core → NestJS; astro → Astro; tauri → Tauri; electron → Electron; hono → Hono; solid-js → Solid; preact → Preact; remix → Remix; gatsby → Gatsby; vite → Vite; webpack → Webpack; eslint → ESLint; typescript → TypeScript; zod → Zod; vitest → Vitest; jest → Jest; playwright → Playwright`.
Scripts are NOT consumed here (that's §4.5).

**Python** (`pyproject.toml`): `[project]` name/requires-python; deps → `fastapi → FastAPI; django → Django; flask → Flask; pydantic → Pydantic; sqlalchemy → SQLAlchemy; pytest → pytest; celery → Celery`. Detect `[tool.poetry]` (Poetry), `[tool.uv]` (uv), `[tool.ruff]`, `[tool.black]`. `requirements.txt` present → line-list (cap 50 entries, `#` comments + `-r`/`-e` lines shown as-is, count reported).

**Rust** (`Cargo.toml`): `[package]` name/edition; `[dependencies]` → `tokio, axum, actix-web, serde, clap, rocket, tonic`. Detect `[workspace]` → monorepo. `Cargo.lock` → lockfile.

**Go** (`go.mod`): `module <path>`, `go <ver>`; `require` blocks → count + notable first-party-adjacent deps (cap 20 names). `go.sum` → lockfile. Main detection (presence-only): `main.go` at scope root or any dir under `cmd/` (via `ripgrep.find` glob `cmd/**/main.go` + `main.go`) → entry points.

**Java** (`pom.xml`): parse with a light XML tokenizer (no full DOM — regex over `<groupId>/<artifactId>/<dependencies>`): groupId:artifactId, `spring-boot-starter → Spring Boot; junit-jupiter → JUnit 5; lombok; kotlin-maven-plugin`. `pom.xml`+`mvnw` presence.

**Ruby** (`Gemfile`): gem names (cap 50) → `rails → Rails; sinatra → Sinatra; rspec → RSpec`. `Gemfile.lock` → lockfile.

**PHP** (`composer.json`): `require` keys → `laravel/framework → Laravel; symfony/* → Symfony`. `composer.lock` → lockfile.

**Lockfile / version pins** (existence-only probes): `package-lock.json` (npm), `yarn.lock` (yarn), `pnpm-lock.yaml` (pnpm), `bun.lockb`/`bun.lock` (bun), `poetry.lock`, `uv.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`, `.nvmrc`, `.node-version`, `.python-version`, `.tool-versions`, `.ruby-version` (read 1-line content each — tiny, allowlisted).

**Rendering (summary head, always):**
```
<stack ecosystem="node" monorepo="true" packageManager="bun@1.3.14" lockfile="bun.lock">
  <framework name="Next.js" />
  <framework name="TypeScript" />
  <entry points="src/main.ts, next.config.js" />
  <ci github="3 workflows" />
</stack>
```

### 4.4 .gitignore-aware bounded tree (`structure` + `full` tiers)

- Source of truth: `ripgrep.find({ cwd, pattern: "*", limit: MAX_TREE_FILES })` (ignore-aware; hidden excluded) → relative paths. This is the entire guarantee: **the tree honors .gitignore because ripgrep honors .gitignore** (never `--no-ignore`, never `--hidden`).
- Group files into an importance-ordered tree:
  1. `src/` (and language-natural source roots: `lib/`, `app/`, `cmd/`, `packages/`, `crates/`)
  2. config + tooling files (root-level `*.config.*`, `tsconfig*`, `*rc`, `Dockerfile`)
  3. tests (`**/*.test.*`, `**/*.spec.*`, `test/`, `tests/`, `__tests__/`)
  4. docs + meta (`README*`, `docs/`, `LICENSE*`)
  5. everything else
- Depth cap: `depth ?? 3` (max 5); entry cap: `maxEntries ?? 200` (max 500). Beyond caps render `… (N more files, M more dirs)`.
- Sizes: per-file `fs.stat.size`, summed per directory; render humanized (KB/MB). Collapsed dirs still report subtree size.
- Render (structure/full):
```
<tree depth="3" entries="184" totalFiles="412">
  src/ (48 files, 1.2 MB)
  ├── components/ (12 files, 310 KB)
  │   ├── Button.tsx           4.1 KB
  │   └── … (10 more files, 296 KB)
  ├── lib/ (8 files, 180 KB)
  └── … (46 more files, 690 KB)
  config (14 files, 92 KB)
  tests (23 files, 210 KB)
  docs (6 files, 88 KB)
  … (325 more files, 4.1 MB)
</tree>
```

### 4.5 package.json scripts — annotated (`full` tier)

Parse `scripts` object (cap 40 scripts); classify each name by prefix/regex:
`dev|serve|start → dev · build|compile|bundle → build · test|test:*|e2e → test · lint|check → lint · typecheck|types|tsc → typecheck · format|prettier → format · db:* → db · publish|release → release · * → other`.
Also annotate `postinstall`/`preinstall`/`prepare` as lifecycle. Script value shown truncated to 120 chars.
```
<scripts total="12">
  <script name="dev"        category="dev"      cmd="bun run src/dev.ts" />
  <script name="build"      category="build"    cmd="bun run build.ts" />
  <script name="test"       category="test"     cmd="bun test" />
  <script name="typecheck"  category="typecheck" cmd="tsc --noEmit" />
</scripts>
```

### 4.6 Entry points + configs + CI

**Entry points** (presence + manifest fields): package.json `main`/`bin`/`exports`/`module`; `src/main.ts|js|tsx`, `src/index.ts|js`, `index.js`, `src/main.py`, `main.py`, `app.py`, `src/main.rs`, `src/lib.rs`, `main.rs`, Go `main.go` + `cmd/**`, `manage.py` (Django), `bot.py`. Cap 10.
**Config files** (presence only): `tsconfig.json`, `jsconfig.json`, `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `.babelrc*`, `babel.config.*`, `vitest.config.*`, `jest.config.*`, `playwright.config.*`, `next.config.*`, `vite.config.*`, `webpack.config.*`, `.editorconfig`, `.env*` (presence, **never content** — secrets), `Dockerfile`, `.dockerignore`.
**CI** (presence + count): `.github/workflows/*.{yml,yaml}` (count), `.gitlab-ci.yml`, `.circleci/config.yml`, `Jenkinsfile`, `azure-pipelines.yml`, `appveyor.yml`, `.buildkite/pipeline.yml`, `bitbucket-pipelines.yml`, `travis.yml` (legacy, still noted).

### 4.7 Stats

- **File counts by type:** `ripgrep.find` full list (cap 20 000 — beyond: `more=…`), bucket by extension in-process. Render top 12 extensions + `other`.
- **Est LOC:** line-count via ripgrep count form: run the rg binary directly (path from `@opencode-ai/core/ripgrep/binary` `RipgrepBinary.Service` → `binary.filepath`) with `rg --no-config --count-matches "^"` scoped to the file list, capped at `MAX_LOC_FILES = 2000` files (largest-first by stat size; others estimated as `avg × remaining`, labeled `estimated`). No bodies returned — counts only.
- Render:
```
<stats files="412" loc="~34,800 (estimated, 2,000/412 sampled)" totalBytes="6.9 MB">
  <type ext=".ts" files="231" loc="~24,100" />
  <type ext=".json" files="52" />
  <type ext=".css" files="18" />
  … (9 more types)
</stats>
```

### 4.8 Tier composition

- `summary` (default): stack head + lockfile + monorepo flag + top scripts (the 5 classified categories, ≤1 per category, `name→cmd` truncated 80) + entry points (≤5) + CI presence + stats one-liner. Target **≤ 40 lines**.
- `structure`: summary + `<tree>`.
- `full`: stack detail (all frameworks, dep highlights) + annotated `<scripts>` + `<tree>` + `<entry>`/`<config>`/`<ci>` lists + `<stats>` detail.

### 4.9 Action `recent` — newest files (ratified addition)

- `recent` param (default 15, max 50) → N most recently modified files, mtime-sorted newest-first, grouped by directory, relative timestamps (`2m ago` / `1h ago`).
- Source list = `ripgrep.find` (git-ignored excluded), stat-only (mtime via `fs.stat`, no body reads). Cap + `… N more` hint.
```
<project-recent files="15" total="412">
  <group dir="src/lib">
    <file name="client.ts" mtime="2m ago" />
    <file name="cache.ts" mtime="1h ago" />
  </group>
  ...
</project-recent>
```

### 4.10 Action `toolchain` — installed runtimes (ratified addition; feeds `test` runtime detection)

- Probes installed runtimes + versions via `which`/PATH resolution + `--version` (5s timeout each): bun, node, npm, pnpm, yarn, python, go, rustc.
- Key env vars surfaced **never secrets**: PATH first entry, NODE_ENV, CI, VIRTUAL_ENV, GOPATH, CARGO_HOME, BUN_INSTALL.
- Output:
```
<toolchain>
  <runtime name="bun" path="..." version="1.3.14" />
  <runtime name="node" path="..." version="22.23.2" />
  <runtime name="go" present="false" />
  <env key="NODE_ENV" value="development" />
</toolchain>
```

### 4.11 Git/worktree awareness + init summary (ratified additions, all snapshot tiers)

- `git rev-parse --show-toplevel` (logical root, worktree-aware) + `--git-common-dir` (linked-worktree detection) + branch + `status --porcelain` count → `<git root="." branch="master" changed="7" />`.
- **Non-git repo → block skipped entirely (graceful).** File listing for the tree comes from the worktree root (scoping finding resolved: probes root-relative, tree/stats scope-relative, manifests walked UP from scope to root — nearest wins, so `path:"src"` still reports the repo's ecosystem).
- Init summary — one-glance "is this project initialized": `<init manifest="package.json" git="master" lockfile="bun.lock" deps="42" />` + which dev scripts exist (dev/build/test/lint/typecheck present flags).

### 4.12 project edge cases

| case | behavior |
|---|---|
| no manifests found | `stack ecosystem="unknown"` + hint `no manifest detected (package.json/pyproject/Cargo/go.mod/…)`; still render tree+stats |
| empty / binary-only repo | stats with 0 source files; tree minimal; no error |
| huge repo | file list capped 20k (`more=` note); LOC sampled; tree entry-capped with `N more` |
| manifest > 256 KB | skip body, note `skipped: <path> too large (N KB)` |
| permission-denied subtree | ripgrep `--no-messages` silently skips; note if a manifest was unreadable |
| non-UTF8 / binary files | counts still work (paths/sizes); never read bodies so no decoding risk |
| `path` param outside worktree | reject (worktree-bound guard, typecheck.ts:245 precedent) |
| symlink loops | ripgrep doesn't follow by default (`follow` unset) — safe |
| concurrent edits (scripts changed mid-run) | snapshot reads; no locking; acceptable staleness within one call |
| non-git repo | `<git>` block omitted; tree from directory; `--git-common-dir`/`--show-toplevel` guarded |
| `recent` in empty repo | `files="0"` + no error |
| toolchain runtime missing | `present="false"` per runtime; no error; probe timeout 5s each (never blocks on PATH hang) |

---

## 5. Tool `symbols` — code intelligence

Files: `src/tool/symbols.ts` (entry, params, dispatch) + `src/tool/symbols/outline.ts` + `src/tool/symbols/search.ts` + `src/tool/symbols/usages.ts` + `src/tool/symbols.ts.txt` → `symbols.txt`. New deps: `tree-sitter-typescript`, `tree-sitter-javascript` (see §3.1).

### 5.1 Parameters (exact)

```ts
export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["search", "outline", "usages"])).annotate({
    description: "Operation (default search). search = find definitions; outline = all symbols in a file; usages = find all references (JetBrains Find Usages).",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Symbol name (search/usages). Word-boundary matched; empty → error. Search ranks exact > prefix > substring > fuzzy.",
  }),
  file: Schema.optional(Schema.String).annotate({
    description: "outline: file to outline (required). usages: file whose identifier at `line` is the symbol (alternative to query).",
  }),
  line: Schema.optional(PositiveInt).annotate({
    description: "usages: 1-based line within `file`; the identifier there is resolved to the symbol name (requires file).",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "search: scope to search (dir or file; default project root).",
  }),
  kind: Schema.optional(Schema.Literals(["function", "class", "interface", "type", "variable", "const", "enum", "method", "property", "parameter", "import", "module"])).annotate({
    description: "search: restrict result kinds.",
  }),
  lang: Schema.optional(Schema.Literals(["ts", "tsx", "js", "jsx"])).annotate({
    description: "search: restrict candidate files by language (default: auto from extensions ts/tsx/js/jsx).",
  }),
  maxResults: Schema.optional(Schema.Int).annotate({ description: "search/usages: cap (default 50 search / 200 usages, max 500)" }),
})
```

Permission: **`grep`** key — `permission: "grep"`, `patterns: [query ?? "outline", scopeRel]`, `always: ["*"]`, `metadata: { action, query?, file?, path? }`. Rationale: the tool scans content but never returns bodies beyond capped one-line snippets (the same content class grep already surfaces); per-file `read` asks would be 200× noise. Worktree-bound guard on `file`/`path`.

### 5.2 Grammar mapping (verify node-kind names against the pinned grammar at build — table is the working contract)

Node-kind → symbol kind for **declarations** (parent kind determines role):

| parent node kind (TS/TSX) | kind | name field |
|---|---|---|
| `function_declaration` / `generator_function_declaration` / `function_signature` | function | `name` |
| `class_declaration` / `abstract_class_declaration` | class | `name` |
| `interface_declaration` | interface | `name` |
| `type_alias_declaration` | type | `name` |
| `enum_declaration` | enum | `name` |
| `lexical_declaration` / `variable_declaration` (per `variable_declarator`) | variable (const if `lexical` + `const` keyword) | declarator `name` |
| `method_definition` / `abstract_method_signature` / `method_signature` | method | `name` |
| `public_field_definition` / `property_signature` / `class_property` | property | `name` |
| `required_parameter` / `optional_parameter` | parameter | `pattern`→`identifier` |
| `import_specifier` | import | `name` (alias `import X as Y` → binding name `Y`) |
| `internal_module` / `module` / `namespace_definition` | module | `name` |
| `export_statement` wrapping a declaration | (same as inner declaration) | — |

> **Name-node types (verified by symbols-builder against the pinned grammars):** the `name` field of class/interface/enum/type-alias declarations is a **`type_identifier`** node (TS grammars); method/property/parameter names are **`property_identifier`**; function/variable/import/module names are **`identifier`**. **JS-grammar caveat (ratified at build):** tree-sitter-javascript has no `type_identifier` — JS class/interface-less names are `identifier`. **Prefer field-based name extraction** (`node.childForFieldName("name")`, compare via `Node.equals`) over hard-coded node-type lists so the TS/JS grammar differences don't leak into the walker. **Search/usages must walk all three node types when matching a name** (`descendantsOfType("identifier") + ("type_identifier") + ("property_identifier")`) — walking only `identifier` silently misses class/interface definitions and property references. A reference rule below applies to whichever node type matched.

**References:** any `identifier`/`type_identifier`/`property_identifier` node whose ancestors do **not** include a declaration kind from the table. A `member_expression` property (`foo.bar`) is a *reference to `bar`* only when the query targets `bar` and a declaration for `bar` exists (import-aware, §5.4); otherwise it lands in the unattributed bucket.
**Comments/strings are structurally excluded:** inside `comment`/`string`/`template_string` nodes the text is `comment`/`string_fragment` nodes, never `identifier` — walking only `identifier`-typed nodes (via `descendantsOfType("identifier")` or an equivalent walk) gives the precision guarantee; no ad-hoc filtering needed. Verify with the tiny negative fixture (string/comment containing the query must yield 0 refs).

**Regex declaration-scanner fallback** (languages without a grammar, and any file whose tree-sitter parse fails): line-oriented patterns, best-effort, labeled `fallback=regex`:
```
^(?:export\s+)?(?:async\s+)?function\s+(\w+)       → function
^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)        → class
^(?:export\s+)?interface\s+(\w+)                    → interface
^(?:export\s+)?type\s+(\w+)\s*=                     → type
^(?:export\s+)?(?:const|let|var)\s+(\w+)            → variable
^(?:export\s+)?enum\s+(\w+)                         → enum
```
Fallback treats every match as a declaration (no ref classification) and is only used when `lang` is not ts/tsx/js/jsx or the parse errored.

### 5.3 Action `search` — find definitions

1. Validate `query` (non-empty, ≤ 200 chars).
2. `ripgrep.grep({ cwd: scope, pattern: \b<escaped>\b, include: langGlob ?? "*.{ts,tsx,js,jsx}", limit: 2000 })` → candidate `(file, line, text, submatch)` rows.
3. For each candidate file (dedup, cap `MAX_PARSE_FILES = 100`): get cached outline (§3.2); classify each name-node (`identifier`/`type_identifier`/`property_identifier`, §5.2) whose text matches `query` (case-sensitive exact first); keep **declarations**.
4. Rank: exact > case-insensitive exact > prefix > substring > fuzzy (subsequence, ≤ 2 skips). Within a rank: by kind order (class/interface/type/function/const…) then file depth then line.
5. Render — one line per hit, defs first:
```
<symbols-search query="Session" kind="all" files="4" results="12" capped="false">
  <def kind="class" name="Session" sig="Session" file="src/session/session.ts:120" />
  <def kind="interface" name="Session" sig="Session" file="src/session/schema.ts:41" />
  ...
  <next>… 3 more results (maxResults=50). Narrow with path= or kind=.</next>
</symbols-search>
```
`sig` = the declaration's text (name + params/type constraints) trimmed to 80 chars. Capped at `maxResults ?? 50` with `N more` hint. Zero hits → `<symbols-search query=… results="0">` + hint `Try the grep tool with a looser pattern or a substring query.`

### 5.4 Action `usages` — Find Usages

Resolution of the symbol: `query` given → name is `query`; `file`+`line` given → outline `file`, find the name-node (`identifier`/`type_identifier`/`property_identifier`) whose byte range covers the line (or the one whose line == `line`, col nearest), take its text as the name; `file` alone → error (`usages needs query or file+line`).

Pipeline:
1. **Defs:** search step 3-4 → declarations of the name (top 20), **including import-binding declarations (kind="import", ratified at build)** — an import IS a binding in the importing file. If zero defs, still proceed — output reports `defs="0"` and classifies matches as refs/unattributed by the rules below.
2. **Candidates:** `ripgrep.grep` word-boundary across scope (include ts/tsx/js/jsx), limit 2000.
3. **Per-file classification** (cache outline per file, parse cap `MAX_USAGE_FILES = 200`, beyond → `more` note):
   - Parse the file's **imports** (TS: `import_statement` — `import_clause`/`import_specifier`/`namespace_import`, `export_statement` with `export_clause`; JS: same + `require(...)` calls + dynamic `import(...)`). Build `fileImports: { from: string; bindings: string[] }[]`.
   - For each name-node matching the name (`identifier`/`type_identifier`/`property_identifier`):
     - role `decl` if parent is a declaration kind → goes in the **declarations** group of that file (shown under defs).
     - role `ref` if any import in this file binds the name, **and** that import's `from` resolves to a file that declares the name (resolution: `from` relative → join dirname, try `.ts/.tsx/.js/.jsx/.mjs/.cjs/index.*`, match against def files; absolute/bare specifiers → compare against def-file module paths best-effort). → **attributed usage**.
     - refs **in a declaring file, attributed only when that file is import-reached** (i.e. some other file imports its declaration). A self-declaring file that nobody imports (c.ts case) is treated as a possible different binding → its refs land in **unattributed** (ratified at build: stricter honesty; an internal-only symbol's own-file refs are the small accepted cost).
     - otherwise → **unattributed** (same-name-different-binding or unknown-module): the file is reported but honestly labeled.
4. Render — defs first, then grouped-by-file with counts, capped snippet lines:
```
<symbols-usages query="Session" defs="2" files="3" refs="14" unattributed="2" capped="false">
  <defs>
    <def kind="class" name="Session" file="src/session/session.ts:120" />
    <def kind="interface" name="Session" file="src/session/schema.ts:41" />
  </defs>
  <group file="src/session/session.ts" refs="9" attributed="true">
    <ref line="132" col="5">  export class Session implements…</ref>
    <ref line="205" col="3">  const session = new Session()</ref>
    <next>… 7 more refs in this file</next>
  </group>
  <group file="src/server/routes.ts" refs="3" attributed="true">
    <ref line="12" col="1">  import { Session } from "../session/session"</ref>
    ...
  </group>
  <unattributed files="1" refs="2">
    <file name="src/other/state.ts" note="declares its own 'Session'; matches may be unrelated" />
  </unattributed>
  <next>Full output saved to: <spill path> — Read with offset/limit to inspect.</next>
</symbols-usages>
```
   - Snippet = the matched line trimmed to 120 chars (from ripgrep `match.text`, never a fresh read).
   - Caps: `maxResults ?? 200` global ref lines; per-file group cap 20 lines then `<next>… N more refs in this file</next>`; spill full list to file via `Truncate.write` when capped or when `refs > 200`.
   - **Honesty rule:** a file that imports the name but its module can't be resolved, or a file that declares its own same-name binding, is ALWAYS reported under `unattributed`, never counted as refs. The header counts make it explicit: `refs="14" unattributed="2"`.

### 5.5 Action `outline`

1. Resolve + worktree-guard + stat `file`; size cap `MAX_OUTLINE_BYTES = 1 MB` (beyond → error with hint to grep).
2. Cached outline (§3.2): parse with the grammar for the extension (`ts`/`mts`/`cts` → typescript, `tsx` → tsx, `js`/`mjs`/`cjs` → javascript, `jsx` → jsx); collect all declaration nodes (walk top-level + class bodies for members), each `{ name, kind, sig (trimmed 80), line }`.
3. Group: `functions / classes / interfaces / types / enums / variables / members (methods+properties) / imports / modules`; classes render members indented under them.
4. Render:
```
<symbols-outline file="src/session/session.ts" lang="ts" symbols="47" capped="false">
  <group kind="class">
    <symbol name="Session" kind="class" line="120" sig="class Session implements…" />
    <symbol name="  prompt" kind="method" line="141" sig="prompt(input: PromptInput): …" />
    <symbol name="  resume" kind="method" line="178" sig="resume(id: SessionID): …" />
  </group>
  <group kind="interface">
    <symbol name="SessionInfo" kind="interface" line="41" sig="interface SessionInfo { … }" />
  </group>
  ...
</symbols-outline>
```
Cap `maxResults ?? 200` symbols, `… N more symbols — narrow with grep or Read`. Errors in the file → note `parseErrors="N"` (tree-sitter `ERROR`/`MISSING` nodes) but still list what parsed.

### 5.6 symbols edge cases

| case | behavior |
|---|---|
| query not found | `results="0"` + suggest grep/looser query |
| query with regex metachars / `\b` boundary issues | escape; drop `\b` when query edges aren't word chars |
| huge/minified file | outline size cap 1 MB → error+hint; usages snippet always 120-char trim |
| syntax errors in a file | best-effort parse; `parseErrors="N"` note; regex fallback only if parse yields zero identifiers |
| file deleted between grep and parse | cached outline refetch on mtime mismatch; miss → skip file with `skipped` note |
| case sensitivity | search: exact case-sensitive match wins; case-insensitive exact is rank 2 (documented) |
| unicode identifiers | word-boundary grep uses `\b` with unicode-aware escape; identifiers matched by text equality, not bytes |
| `file`/`line` for usages points at a string/comment | name-node resolution finds no node → error `no identifier at <file>:<line>` |
| lang filter + path filter combined | both applied (include glob AND path scope) |
| binary/decoy matches (node_modules) | ripgrep ignore-aware by default; never `--hidden`/`--no-ignore` |

---

## 6. Tool `test` — multivariate engine-aware runner

File: `src/tool/test.ts` + `test.txt`. Deps: existing (`AppProcess`, `RipgrepBinary` for detection reads). No new deps.

### 6.1 Parameters (exact)

```ts
export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["run", "list"])).annotate({
    description: "What to do (default run). run = execute tests; list = enumerate test files (and names when the harness supports it cheaply).",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Filter: file or directory to run/list (relative). Default: harness default scope.",
  }),
  testNamePattern: Schema.optional(Schema.String).annotate({
    description: "Filter: test-name pattern (regex or substring per harness; mapped per harness, see design §6.4).",
  }),
  runtime: Schema.optional(Schema.Literals(["auto", "bun", "node"])).annotate({
    description: "Runtime (default auto: prefer the repo's runtime). Explicit value forces the runner even when the repo looks like the other.",
  }),
  timeoutMs: Schema.optional(Schema.Int).annotate({
    description: "Hard timeout for the run (default 120000; max 600000). On expiry the child is killed.",
  }),
  full: Schema.optional(Schema.Boolean).annotate({
    description: "Always spill the full output to a file and report the path (default: spill only on truncation/failure).",
  }),
})
```

Permission: **dedicated `test` key** — `permission: "test"`, `patterns: [resolvedCommand]`, `always: [resolvedCommand]`, `metadata: { harness, runtime, path, testNamePattern, command }` where `resolvedCommand` is the exact argv joined by spaces (e.g. `bun test --reporter=dots src/foo.test.ts -t NAME`). The ask happens **after** detection resolves the command but **before** spawn, so the user approves the exact thing that runs (git.ts:229 precedent).

### 6.2 Harness detection (config + deps, no execution)

From `package.json` in the directory (fall back to nearest up-tree within the worktree): read `scripts.test` and `devDependencies`/`dependencies` (≤ 256 KB guard).

| priority | signal | harness |
|---|---|---|
| 1 | `devDeps.vitest` or script matches `vitest` | vitest |
| 2 | `devDeps.jest` or script matches `jest` | jest |
| 3 | script test contains `bun test` / `bunx` / `bun.lockb` present | bun |
| 4 | script test contains `node --test` or test files import `node:test` | node:test |
| 5 | `mocha` dep → mocha · `ava` dep → ava · `@playwright/test` → playwright | best-effort |

Detection is a pure function `detectHarness(dir) → { harness, reason, script }` — unit-testable against fixture dirs with **no spawn** (D15).

### 6.3 Reporter strategy (verified — `research/test-reporters`)

| harness | primary invocation | parse | fallback |
|---|---|---|---|
| vitest | `vitest run [path] --reporter=json [--outputFile=<tmp>]` (2+/3 may require outputFile — probe once: run with outputFile; if the file appears, read it; else text) | jest-compatible JSON (schema below) | text |
| jest | `jest [path] --json` (stdout) | jest JSON | text |
| bun | `bun test [path]` (default console) | **text-parse** default output | text |
| node:test | `node --test [path] --test-reporter=tap` | TAP13 (below) | text |
| mocha | `mocha --reporter json [path]` | mocha event JSON | text/TAP |
| ava | `ava [path]` | TAP (default) | text |
| playwright | `playwright test [path] --reporter=json` | playwright JSON | text |

**Jest-compatible JSON schema** (shared by jest + vitest): `{ numTotalTests, numPassedTests, numFailedTests, numPendingTests, numTodoTests, success, testResults: [{ name, status, message?, assertionResults: [{ ancestorTitles[], fullName, title, status, duration?, failureMessages[] }] }] }` — map `fullName` → name, `status: passed/failed/pending/todo` → passed/failed/skipped, first `failureMessages[i]` split on first `\n` → first assertion line.

**TAP13 (node:test)**: `ok 1 - name` / `not ok 2 - name` (+ `# SKIP` suffix for skipped), YAML blocks carry `location: 'file:line:col'`, `error: '<msg>'`, `expected/actual`; footer `# tests N / # pass N / # fail N / # skipped N / # duration_ms X`. Suites nest as subtests (`failureType: 'subtestsFailed'` on suite nodes) — **only leaf `ok/not ok` lines count as tests**; suite-level `not ok` with `subtestsFailed` is not double-counted. `location` gives the failing-list `file:line`.

**bun text output** (verified 1.3.14): lines `(pass) <name> [ms]`, `(skip) <name>`, `(fail) <name> [ms]`; failure block `Expected: …` / `Received: …` + `at <file>:<line>:<col>`; footer `N pass / M skip / K fail` then `Ran T tests across F files. [dur]`. Parse with `^(\(pass\)|\(skip\)|\(fail\))\s+(.+?)(?:\s+\[\d+(?:\.\d+)?ms\])?$`.

**Text fallback (universal)**: detect `PASS/FAIL`/`✓/✗`/`ok N/not ok N` lines; if unparseable, return raw bounded tail + `parsed="false"` and treat exit code as the only signal.

### 6.4 Filter mapping per harness

| harness | path | testNamePattern |
|---|---|---|
| vitest | positional `[path]` | `-t <pattern>` (regex) |
| jest | positional `[path]` | `-t <pattern>` (regex, substring-ok) |
| bun | positional `[path]` | `-t <pattern>` (substring) |
| node:test | positional `[path]` | `--test-name-pattern=<pattern>` (regex) |
| mocha | positional | `--grep <pattern>` |
| ava | `[path]` | `--match=<glob>` (translate: wrap `*name*`) |
| playwright | `[path]` | `-g <pattern>` |

User-supplied patterns are treated as regex where the harness takes regex, else substring; always passed as a single argv (no shell interpolation). Document in `test.txt`.

### 6.5 runtime resolution (ratified per test-builder's build)

- `auto` (default): **harness-native runner** — bun→`bun test`, node:test→`node --test`, vitest/jest/mocha/ava/playwright→their local bin. Simplest and honest: each harness's runner is its native runtime; no cross-runtime guessing.
- Explicit `runtime=bun|node` on a mismatched harness → clear error explaining the mismatch (e.g. `runtime=node with harness vitest`), instead of silently forcing.
- Binary resolution: **local-bin only** — resolve `node_modules/<pkg>/package.json` `bin` (read the field; spawn `node <bin>` for node-based bins). **No `npx`/`npm`/`.cmd` spawning** (Windows spawn without shell; zero implicit-install / network risk). Missing local bin → clear error with install hint (`run bun install first, or run the harness via the shell tool`).
- `runtime=bun` requested but no bun binary → error with resolution hint.
- Windows: argv arrays (no shell string); quote via argv (ChildProcess.make handles); no `&`/`&&` composition.

### 6.6 Child process lifecycle

Follow ripgrep.ts's spawn pattern (`process.spawn` + `collectStream`), with typecheck.ts's timeout semantics:

1. `yield* ctx.ask({ permission: "test", patterns: [cmd], always: [cmd], metadata })`.
2. `spawn(ChildProcess.make(argv[0], argv.slice(1), { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" }))`.
3. Stream `stdout` (decodeText + splitLines): **tee** every line to the spill file (`Truncate.write` incremental — write once at end is fine, but incremental via `fs.appendFile` into a temp `tool_<id>.log` in the truncation dir preferred so a kill still leaves the tail) and keep a **bounded tail ring** (last 400 lines / 64 KB).
4. `stderr` → bounded error buffer (8 KB, collectStream).
5. Exit: `handle.exitCode`; parse the collected output with the §6.3 parser.
6. Abort: wrap the collect in `Effect.raceFirst(waitForAbort(ctx.abort))` (ripgrep.ts:144 precedent).
7. Timeout: `Effect.timeoutOrElse(collect, { duration: timeoutMs })` → on timeout: `handle.kill()` (SIGKILL via platform default), report `status="timed-out"`, parse whatever output arrived (partial JSON/TAP still yields counts; mark `partial="true"`).

### 6.7 Output templates

**run:**
```
<test-run harness="bun" runtime="bun" status="failed" exit="1" duration="1.2s" passed="2" failed="1" skipped="1" partial="false" parsed="true">
  <summary>2 passed / 1 failed / 1 skipped (1.2s)</summary>
  <failures count="1">
    <failure file="src/foo.test.ts" line="12" name="adds numbers" detail="Expected: 3&#10;Received: 4" />
  </failures>
  <tail lines="12">(pass) adds numbers [1ms]
(pass) subtracts [1ms]
(fail) multiplies [2ms]
Expected: 6
Received: 7
…</tail>
  <fullOutput path="<abs spill path>" />
  <next>Fix failures first (1). Re-run with path=src/foo.test.ts -t add to narrow.</next>
</test-run>
```
`detail` = first assertion line (or first 2 lines) trimmed to 160 chars; `failures` hard-capped at 50 (no `maxResults` param on `test`) + `… N more failures — see fullOutput`. `tail` = bounded tail (only on failure/timeout/partial). Success keeps it lean: `<summary>` + counts + `fullOutput` only if `full:true`.

**list:**
```
<test-list harness="vitest" files="6" names="41">
  <file path="src/a.test.ts" tests="12" />
  <file path="src/b.test.ts" tests="9" />
  … (4 more files)
  <next>names from config/manifests; exact names require a run. Run with --reporter=json and read testResults for precise names.</next>
</test-list>
```
File enumeration: harness config `include`/`testMatch` when parseable (vitest `include`, jest `testMatch`/`roots`, bun default `**/*.test.{ts,tsx,js,mjs,cjs}` + `test/**`, node default `**/*.test.*`), else default globs — implemented via `ripgrep.find` globs (ignore-aware). Names: best-effort — jest `--listTests` gives files only (name count unknown); per-harness cheap enumeration only when available (documented; `names="?"` + note when not). **list never executes tests.**

### 6.8 test edge cases

| case | behavior |
|---|---|
| no harness detected | error listing what was found + hint: `run via npm test with the shell tool` |
| harness binary missing locally | local-bin resolution fails → clear error with install hint (`bun install` first, or run via shell); no npx/npm spawning |
| timeout | kill child, report `status="timed-out"`, `partial="true"`, parsed counts if any |
| vitest json requires outputFile | probe with `--outputFile=<tmp>`; read file on success; else text fallback |
| jest exit≠0 but valid JSON | parse JSON anyway; `status="failed"` from `success:false`/counts |
| node:test json on node 22 | never requested (TAP instead) — json reporter absent < node 23 |
| playwright interactive/watch config | best-effort; timeout is the backstop; never `--ui`/`--watch` (append `--reporter=json`, pass `CI=1` env) |
| `testNamePattern` regex invalid for harness | pass through; harness errors → report stderr tail |
| path outside worktree | reject (worktree-bound guard) |
| run inside `node_modules` or `.git` | rg-ignored; explicit path there → error |
| empty test file set | `files="0"` + `no test files matched path` |

---

## 7. `*.txt` sidecars (teach when-to-use; sent to the model verbatim)

**`project.txt`:**
```
Codebase orientation snapshot — a token-lean map of what a project is and where
things live. Use BEFORE reading code: to identify stack/framework, entry points,
scripts, CI, and rough stats for an unfamiliar repo (e.g. at session start, when
landing in a new checkout, or when deciding which package to work in).

Tiers:
  summary   (default) — stack, lockfile, monorepo flag, key scripts, entry
            points, CI presence, stats one-liner (~40 lines)
  structure — summary + .gitignore-aware bounded tree with directory sizes
  full      — stack detail + annotated package.json scripts + tree + entry/
            config/CI lists + detailed stats

Actions (beyond snapshot): recent — N newest modified files (mtime-sorted,
git-ignored excluded); toolchain — installed runtimes + versions + key env
vars (never secrets), feeds the test tool's runtime detection. Git/worktree
awareness (branch, changed-file count) + an init summary (manifest/git/
lockfile/deps + which dev scripts exist) appear in every snapshot.

It NEVER reads source bodies: only manifests/config (capped), ripgrep file
lists/line counts, and file sizes — so it is always cheap and safe. Prefer it
over grep/glob/read when the question is "what kind of repo is this and what
can I run in it?" For precise structure use glob; for content use grep; for
files use read.
```

**`symbols.txt`:**
```
Code intelligence for TS/TSX/JS: find definitions, outline a file, and find
usages (JetBrains Find Symbol + Find Usages). Use when you need to know where
a symbol is DECLARED (search), what a file contains (outline), or everywhere a
symbol is REFERENCED including cross-file imports (usages).

Actions:
  search  — find definitions of a name, ranked exact > prefix > substring >
            fuzzy; optional kind=/path=/lang= filters; one-line results.
  outline — all symbols in one file, grouped by kind (classes show members).
  usages  — all references to a symbol (by name, or by file+line). Defs first,
            grouped by file with counts; references in files that import the
            symbol are attributed; same-name-different-binding files land in
            an honest 'unattributed' bucket — never pretended usages.

Tree-sitter based (comments/strings excluded); grep-anchored candidate search
keeps it fast on large repos. For plain-text search across files use grep; for
whole-file reading use read; prefer usages over grepping a name when you need
references rather than raw matches.
```

**`test.txt`:**
```
Engine-aware test runner: run or enumerate the repo's tests with the right
harness and a parseable reporter. Use when the agent needs to run tests, check
whether a change broke something, or discover what tests exist.

Actions:
  run  (default) — run tests; reports 'N passed / N failed / N skipped (dur)',
        a capped failing list (file:line — name — first assertion line), a
        bounded output tail, and a full-output file path.
  list — enumerate test files (and names when the harness supports it
        cheaply). Never executes tests.

Harnesses: bun test, vitest, jest, node:test (first-class); mocha, ava,
playwright (best-effort). runtime=auto|bun|node; path and testNamePattern
filters mapped per harness. Runs in a child process with a hard timeout
(default 120s) and kills on expiry. Every run is gated by a dedicated 'test'
permission whose rule pattern is the exact resolved command.
```

---

## 8. registry.ts additive entries (exact, append-only)

`src/tool/registry.ts` is concurrently edited by other lanes. **Append-only rule:**
- add the three imports in the existing import block (alphabetical near `TypecheckTool`),
- add three `yield*` bindings after `const typechecktool = yield* TypecheckTool` (line ~153),
- add three `Tool.init(...)` entries inside the existing `Effect.all({ ... })` object (after `typecheck: Tool.init(typechecktool),` ~line 215),
- add three entries to the `builtin` array (after `tool.typecheck,` ~line 269).

**Do NOT** reorder, reformat, or touch any existing line. Patch snippet:

```diff
  import { TypecheckTool } from "./typecheck"
+ import { ProjectTool } from "./project"
+ import { SymbolsTool } from "./symbols"
+ import { TestTool } from "./test"
  import { RefactorTool } from "./refactor"
...
    const typechecktool = yield* TypecheckTool
+   const projecttool = yield* ProjectTool
+   const symbolstool = yield* SymbolsTool
+   const testtool = yield* TestTool
    const refactortool = yield* RefactorTool
...
          typecheck: Tool.init(typechecktool),
+         project: Tool.init(projecttool),
+         symbols: Tool.init(symbolstool),
+         test: Tool.init(testtool),
          refactor: Tool.init(refactortool),
...
            tool.typecheck,
+           tool.project,
+           tool.symbols,
+           tool.test,
            tool.refactor,
```

Tool ids must be unique — `project`/`symbols`/`test` collide with nothing in the current `builtin` list (verified: shell, read, glob, grep, edit, write, task, fetch, todo, search, skill, archive, json, background, sqlite, git, typecheck, refactor, patch, patchTool, question, lsp, plan, browser*, execute).

## 9. Permission model (summary)

| tool | permission key | patterns | always |
|---|---|---|---|
| project | `read` | `[scopeRel]` | `[scopeRel]` (metadata `{ action, tier?, path, recent? }`) |
| symbols | `grep` | `[queryOrOutline, scopeRel]` | `["*"]` |
| test | `test` (new dedicated key) | `[resolvedCommand]` | `[resolvedCommand]` |

- `test` is a **new** permission key — like `git`/`typecheck`, it is a free-form string (`PermissionV1.Rule.permission`); no schema change needed. The pattern is the exact argv so the user sees exactly what will execute (`bun test src/foo.test.ts -t add`), matching the git-tool precedent where the pattern encodes the operation.
- All three are read-only in effect (test spawns a child but writes nothing in the repo); no `edit` asks anywhere.
- Metadata surfaces `{ tier }` / `{ action, query, file }` / `{ harness, runtime, path, testNamePattern, command }` respectively for permission UIs.

## 10. Implementation checklists (ordered)

### 10.1 `project` (project-builder) — DONE, ratified
1. `project.txt` sidecar (§7). 2. `project.ts` skeleton: `Parameters` (+`action`, `recent`), `Tool.define`, InstanceState, worktree guard, single `ctx.ask` (§4.1). 3. `manifestText()` allowlist helper (path allowlist + 256 KB cap). 4. `detectStack()` per-ecosystem (§4.3) — node first, then python/rust/go/java/ruby/php. 5. lockfile + version-pin probes. 6. `annotateScripts()` (§4.5). 7. entry/config/CI presence probes (§4.6). 8. `buildTree()` via `ripgrep.find` (worktree-root listing; tree/stats scope-relative; manifests walked up) + stat sizes, importance grouping, caps (§4.4). 9. stats: file buckets + rg line-count via `RipgrepBinary.filepath` (§4.7). 10. tier composition + render templates (§4.8). 11. `recent` (§4.9) + `toolchain` (§4.10) + git/worktree awareness + init summary (§4.11). 12. registry: +`RipgrepBinary.node` dep in `ToolRegistry.node` deps (tool yields `RipgrepBinary.Service`). 13. typecheck + tests (§11).

### 10.2 `symbols` (symbols-builder)
1. Add deps `tree-sitter-typescript`, `tree-sitter-javascript`; **wasm ABI smoke test first** (§3.1 flag). 2. `src/tool/tree-sitter.ts`: `resolveWasm`, lazy parser factory, grammar registry (§3.1). 3. `outline.ts`: parse → declaration list + identifier-node map; grammar mapping table §5.2 (verify node kinds). 4. regex fallback scanner. 5. InstanceState outline cache keyed by mtime (§3.2). 6. `search.ts`: grep-anchor, classify, rank, render (§5.3). 7. `usages.ts`: defs, candidates, import parse + attribution, unattributed bucket, render + spill (§5.4). 8. `outline` action render (§5.5). 9. `symbols.ts` entry + params + dispatch + permission ask. 10. `symbols.txt`. 11. typecheck + tests (§11).

### 10.3 `test` (test-builder)
1. `test.txt`. 2. `detectHarness(dir)` pure fn + unit tests against fixtures (§6.2). 3. `resolveCommand()` — harness → argv incl. reporter flags, path/name filters, runtime resolution (§6.3-6.5). 4. permission ask with resolved command (§6.1). 5. spawn + stream + tail ring + spill + abort + timeout-kill (§6.6). 6. parsers: jest JSON, TAP13, bun text, generic text fallback (§6.3) — as pure fns, tested against canned fixtures. 7. `run` render (§6.7). 8. `list`: config-aware file globs via ripgrep + best-effort names. 9. `test.ts` entry wiring. 10. typecheck + tests (§11).

### 10.4 shared (any builder touching it)
`registry.ts` additive diff (§8) — apply LAST, after each tool's file lands, to avoid blocking peers; coordinate via swarm so only one builder writes registry at a time.

## 11. Pure-test plan (no live test runs / no live browser / no network)

Fixture tree under `packages/opencode/src/tool/__fixtures__/ci/` (committed):

```
ci/
  stack-node/        package.json (react+next, workspaces, scripts dev/build/test/lint/typecheck), bun.lockb, .gitignore
  stack-python/      pyproject.toml (fastapi), requirements.txt, .python-version
  stack-rust/        Cargo.toml (tokio+axum), Cargo.lock, src/main.rs
  stack-go/          go.mod, go.sum, main.go, cmd/serve/main.go
  stack-empty/       README only
  symbols/           ts: src/a.ts (decls+refs), src/b.ts (import {A} from './a'), src/c.ts (local same-name A), imports.ts (aliased import), strings.ts (name inside string+comment)
  symbols-js/        js/jsx files incl. require() + dynamic import
  tests-bun/         bun test files (pass/fail/skip) — canned OUTPUT only
  tests-vitest/      vitest.config.ts + tests + canned jest-json output
  tests-jest/        jest.config.js + tests + canned jest-json output
  tests-node/        node:test files + canned TAP13 output
  tests-text/        canned unparseable text output
```

**Test matrix (bun test, run from `packages/opencode`, no network, no spawned harness):**

| test | what it asserts |
|---|---|
| project.stack.node / .python / .rust / .go | framework, lockfile, monorepo flags (§4.3) |
| project.stack.empty | `ecosystem="unknown"` + hint |
| project.tiers | summary ≤ 40 lines / structure contains `<tree>` / full contains `<scripts>` + `<ci>` (feed a fixture dir, assert output XML shape + caps) |
| project.noBodyReads | no source-body read: `project.ts` contains no `readFile` outside `manifestText` (static guard test) — and fixture assertion: a fixture source file with a unique sentinel string never appears in output |
| project.treeIgnore | `.gitignore`-ignored dir/file absent from `<tree>` |
| project.caps | tree `… N more` present when maxEntries exceeded |
| project.recent | newest-first order, `n` cap, git-ignored files excluded |
| project.toolchain | runtimes present/absent + versions; env keys; never secrets |
| project.git | `<git>` block (branch, changed count); non-git repo → block omitted gracefully |
| project.init | `<init>` block manifest/git/lockfile/deps + dev-script presence flags |
| project.scopedPath | `path:"src"` reports ecosystem via manifest walk-up (nearest wins) + scope-relative tree/stats |
| project.noBodyReads | no source-body read: `project.ts` contains no `readFile` outside `manifestText` (static guard test) — and fixture assertion: a fixture source file with a unique sentinel string never appears in output (all actions/tiers) |
| symbols.search.basic | ranked order exact > prefix > substring; one-line defs |
| symbols.search.kindFilter | kind=function excludes class hits |
| symbols.search.notFound | `results="0"` + grep hint |
| symbols.outline | grouped output; class members indented; `parseErrors` absent |
| symbols.usages.attributed | b.ts import → refs counted under attributed group |
| symbols.usages.unattributed | c.ts (same-name) → `unattributed` bucket, `refs` count excludes it |
| symbols.usages.stringsComments | strings.ts → 0 refs (negative precision test) |
| symbols.usages.fileLine | resolve name from file+line |
| symbols.fallbackRegex | non-TS lang via regex fallback labeled `fallback=regex` |
| symbols.cacheStale | outline cache refetch on mtime change (touch fixture file, assert re-parse) |
| test.detect.vitest / jest / bun / node / none | harness + reason per fixture dir (pure fn, no spawn) |
| test.parse.jestJson / vitestJson / tap13 / bunText / fallback | canned output → correct passed/failed/skipped counts + failing-list entries + `parsed=true/false` |
| test.parse.tapSuite | suite-level `not ok … subtestsFailed` not double-counted |
| test.commands | resolved argv per harness incl. filters (`-t`, `--test-name-pattern`), runtime override, local-bin resolution + missing-bin error (no spawn) |
| test.permissionPattern | `ctx.ask` receives `permission:"test"` + exact command pattern (assert via a stub ctx in a unit test) |
| test.list | file enumeration respects config globs + ignore; `names="?"` noted for vitest |
| test.timeoutKill | (optional, gated `@skip` in CI) spawn a fixture that sleeps; timeoutMs=100 → `status="timed-out"`, `partial="true"` — requires real child process, runs locally |

Verifier (ci-verifier) additionally checks: no network calls anywhere (`fetch`/npx implicit install absent), the test suite spawns only bun/node on temp fixtures (never repo test files), `.pipe(Effect.orDie)` on every execute, worktree-bound guards, additive registry diff only.

## 12. Ambiguities / flagged for coordinator & builders

1. **tree-sitter wasm ABI (§3.1)** — RESOLVED: verified by symbols-builder (tree-sitter-typescript@0.23.2 + tree-sitter-javascript@0.25.0 load under web-tree-sitter@0.25.10).
2. **Exact TS grammar node-kind names (§5.2)** — RESOLVED: verified at build; JS-grammar caveat (class names = `identifier`, no `type_identifier`) + field-based name extraction ratified.
3. **`symbols` permission key** — in use as `grep` (built). If the coordinator prefers a distinct `symbols` key, it's a one-line change in §5.1 (D-key unaffected).
4. **`test` list name enumeration** — names best-effort (`names="?"`); ratified as built.
5. **bun `--reporter=json`** — absent on 1.3.14 (verified); text parser retained as fallback. Future-proofed.
6. **`project` LOC method** — RESOLVED: direct rg `--count-matches "^"` via `RipgrepBinary.filepath`, chunked argv 200 files/run, largest-first 2000 sample, labeled estimated (built as designed). Verifier: assert `estimated=` label presence, not exact numbers.
7. **registry.ts merge** — test-builder + symbols-builder applied their additive diffs (no reordering); project-builder's applied with +`RipgrepBinary.node` dep (required — the tool yields `RipgrepBinary.Service`). All three now present; verify final file has all 3×4 insertions + 1 dep, and no reformatting of sibling lines.
8. **`project` action additions** (recent / toolchain / git awareness / init) came from the coordinator + user after the initial spec — ratified into §4.9-4.11, §7, §9, §10.1, §11. The `read`-permission one-ask model is unchanged.

---

*End of design. Consumers: project-builder (§4, §10.1), symbols-builder (§5, §10.2), test-builder (§6, §10.3), ci-verifier (§11).*
