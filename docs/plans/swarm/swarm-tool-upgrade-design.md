# Default Tool-Suite Upgrade — Implementation-Ready Design

Status: READY FOR BUILD (analyst deliverable for `default-tools-upgrade`)
Owner: analyst · Consumes: builder · Verifies: verifier
Date: 2026-08-15

---

## 0. TL;DR

Upgrade the native `edit`/`write`/`read`/`skill` tools with **additive** parameters
borrowed from the presGEN plugin tools (`C:\Users\slooshied\WebstormProjects\presGEN_v2\.opencode\src\tools\`),
add **safety rails** to `edit` to prevent code-mangling, and build **three new tools**:
`git`, `refactor`, `typecheck`. `json` is **audit-only** (already built natively by the
coordinator — do not rebuild). All changes to `registry.ts` are purely additive and must be
merged against the live file (the `shell-background` swarm is concurrently editing
`registry.ts`, `shell.ts`, `background.*` — do not touch `shell.ts`/`background.ts`).

Order of implementation: **edit → typecheck → git → refactor → skill → write → read**.

---

## 1. Scope & Constraints

| Item | Decision |
|---|---|
| presGEN edit.ts | → upgrade default `edit` (packages/opencode/src/tool/edit.ts). **Safety rails are the #1 requirement.** |
| presGEN write.ts | → upgrade default `write`. |
| presGEN read.ts | → upgrade default `read` (minimal; bulk read flagged optional). |
| presGEN skill.ts | → upgrade default `skill`. |
| presGEN json.ts | **AUDIT-ONLY.** Native `json.ts` + `json/core.ts` already exist. Note gaps, no rebuild. |
| presGEN git.ts | → **BUILD NEW** tool id `git`. |
| presGEN refactor.ts | → **BUILD NEW** tool id `refactor` (plan-first, dry-run by default). |
| presGEN typecheck.ts | → **BUILD NEW** tool id `typecheck` (scoped tsgo/tsc). |
| Do NOT touch | `packages/opencode/src/tool/shell.ts`, `shell/*`, `background.*` (other swarm owns them). |
| registry.ts | Additive only: new imports + `yield*` + `Tool.init` entries + `builtin` pushes. Merge against live file at edit time. |
| File style | Effect + Schema params, `Tool.define`, `InstanceState`, `ctx.ask`, `*.txt` DESCRIPTION, `Tool.init` in registry (see §2). |

---

## 2. Native Tool Conventions (builder recap)

Every native tool follows this shape — new tools must too:

```ts
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./git.txt"          // plain-text description, imported
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const Parameters = Schema.Struct({ ... }) // all params here

export const GitTool = Tool.define(
  "git",
  Effect.gen(function* () {
    // yield services here
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) => Effect.gen(function* () {
        const instance = yield* InstanceState.context
        // resolve paths against instance.directory / instance.worktree
        // yield* ctx.ask({ permission, patterns, always, metadata })
        // yield* assertExternalDirectoryEffect(ctx, abs, { kind })
        return { title, output, metadata }
      }).pipe(Effect.orDie),
    }
  }),
)
```

- **Registration (additive):** in `registry.ts` add `import { GitTool } from "./git"`, then inside the layer `const git = yield* GitTool`, then `git: Tool.init(git)` in the `Effect.all({...})`, then `tool.git` in the `builtin: [...]` array. **Never reorder or reformat existing entries** — the other swarm merges this file live.
- **Permissions:** free-form action strings (`"edit"`, `"read"`, `"glob"`, `"grep"`, `"bash"`, `"todowrite"`, ...). New tools may introduce `"git"`; reuse `"edit"`/`"read"` where the semantics match.
- **Output:** `{ title, output, metadata }`; XML-ish text for the model, structured `metadata` for the UI. `metadata.filediff = { file, patch, additions, deletions }` is consumed by the desktop diff view.
- **Locks:** `edit` keeps a per-file `Semaphore` (`locks` map) — new write paths must funnel through the same lock.

---

## 3. Per-Tool Analysis

### 3.1 edit (UPGRADE) — centerpiece

#### 3.1.1 presGEN features (source of inspiration)

| Feature | presGEN behavior | Risk |
|---|---|---|
| Line-targeted | `line` + optional `oldText` verify + `newText` | Stale line numbers if file changed; safe when `oldText` given |
| Range replace | `startLine`/`endLine` + `newText` | Can clobber a large span at a wrong location |
| insertAfter / append | `insertAfter` line, `appendFile: true` | **presGEN BUG: `appendFile` calls `prependFile` — it prepends!** Fix in native build |
| Context-anchored | `nearText` + `oldText` + `newText` within ±5 lines | Anchor absent → silently no-op; must reject instead |
| Exact replace | first occurrence only | **Mangles when the string appears 2+ times** (default native edit already rejects multi-match — keep that) |
| Batch | `edits: [{line,newText}|{oldString,newString}]` | Partial failure mid-batch leaves half-written file |
| Auto-typecheck | scoped tsc after edit | Slow; native edit already surfaces LSP diagnostics |
| filediff metadata | `metadata.filediff` for UI | Already present in native edit |

#### 3.1.2 Current default strengths (keep intact)

Native `edit.ts` already has:
- Multi-match **rejection** (`replace()` throws "Found multiple matches") with `replaceAll` opt-in.
- Empty-`oldString` rejection, identical old/new rejection.
- `isDisproportionateMatch` guard (refuses to replace a much larger span than `oldString`).
- A chain of fuzzy replacers (LineTrimmed, BlockAnchor, WhitespaceNormalized, IndentationFlexible, EscapeNormalized, TrimmedBoundary, ContextAware, MultiOccurrence) — **existing behavior, do not change**.
- Line-ending + BOM preservation, per-file lock, `ctx.ask` with the unified diff, LSP diagnostics after edit, `filediff` metadata.

These are the "reliable path". The upgrade must **add** cheaper strategies without weakening any of this.

#### 3.1.3 Recommended change (additive)

Add new **optional** Schema fields to `Parameters`; the exact `oldString`/`newString` path is untouched and keeps priority. Strategy dispatch:

1. If `oldString` is present (even alongside other params) → **exact path, unchanged** (back-compat; cheaper params ignored).
2. Else dispatch on first matching param group, **in this order**: `edits[]` (batch) → `line` → `startLine+endLine` → `insertAfter` → `appendFile` → `nearText`.
3. If more than one group is present → **reject with a clear error** listing the groups found (ambiguity guard — never guess).
4. If none → existing "No edit strategy detected" error.

All strategies compute `newContent` in memory, then funnel through **one** write under the existing `lock(filePath)` — same as today.

#### 3.1.4 Edit-safety design (the mandated rails)

The exact compromise between presGEN's token-efficiency and the user's safety requirement:

- **Cheap strategies are allowed because they are index-bounded and verified; the exact strategy stays the only fuzzy path.**
- Cheap strategies must carry **verification data** (oldText/anchor) whenever their blast radius exceeds one line.

Rails (implement as pure helpers, unit-testable like `replace()`):

- **R1 No-op detection.** If `newContent === oldContent` → return `applied=0` result, **never write, never ask**. (presGEN already does this; keep.)
- **R2 Empty old.** Exact path rejects empty `oldString` (existing). Cheap strategies reject missing required fields with a strategy-specific message.
- **R3 Uniqueness.** Exact path: exactly one match required unless `replaceAll:true` (existing). `nearText` strategy: the anchor must match ≥1 line AND `oldText` must occur in exactly one line of the ±5 window — if 2+ candidate lines contain `oldText`, **reject and list the candidate line numbers** (require a unique anchor). Never pick the first of several.
- **R4 Line verify.** `line` op: bounds-checked; if `oldText` provided, `lines[line-1].includes(oldText)` must hold, else reject with the actual line snippet (first 80 chars). Line replace without `oldText` is allowed (whole-line replace is inherently bounded) but the result must surface `oldPreview` so the model sees exactly what was replaced.
- **R5 Range verify.** `startLine..endLine`: bounds-checked, `startLine <= endLine`. If the range is **>5 lines** it requires `oldText` (must be contained in the joined range) or a `startAnchor` (first line of the range must include it) — otherwise reject. Rationale: a wide range replace with no anchor is a code-mangling vector.
- **R6 Anchor verify.** `nearText`: if no line contains `nearText` → **reject** (do not proceed to a different location). `oldText` must be found within the ±5 window, else reject with the anchor line number.
- **R7 Append.** `appendFile` appends to the **end** of the file (fix the presGEN prepend bug). Never requires verification.
- **R8 Diff always.** Every successful write path computes the unified diff (via `createTwoFilesPatch` + `trimDiff`) and passes it in `ctx.ask.metadata.diff` and returned `metadata.filediff` — identical to today's exact path.
- **R9 Atomic batch.** `edits[]` is applied in memory **and fully validated (R1–R6 per op) before any write**. If any op fails validation → reject the whole batch, write nothing. The single write under the lock makes the batch atomic.
- **R10 TypeScript post-check.** **Default OFF.** Native edit already reports LSP diagnostics after `touchFile` — that is the primary signal. Expose `runTypecheck: boolean` (default false) to opt into the presGEN-style scoped tsc run. (Preserves token-latency budget; avoids double work with LSP.)

Token-efficiency vs safety, stated explicitly:

| Concern | Compromise |
|---|---|
| Model wants to save tokens by not repeating a full line | `line + newText` (one line, bounded). No oldText needed; old line echoed back in output. |
| Model wants to save tokens on a big block | `startLine/endLine + newText` allowed only for ≤5 lines without anchor; larger ranges must verify (R5). |
| Model only half-remembers the text | `nearText + oldText + newText` — but must be unique (R6/R3). |
| Model wants reliability | Exact `oldString/newString` path — fully unchanged, still multi-match-rejecting. |
| Model is unsure | Any ambiguity → reject with guidance. The tool never guesses a location. |

#### 3.1.5 Param table (additive; exact path fields unchanged)

```jsonc
{
  "filePath":     { "type": "string", "required": true },               // unchanged
  "oldString":    { "type": "string" },                                  // unchanged (exact path)
  "newString":    { "type": "string" },                                  // unchanged
  "replaceAll":   { "type": "boolean", "default": false },               // unchanged
  "line":         { "type": "integer", "minimum": 1 },                   // NEW: replace this 1-based line with newText
  "oldText":      { "type": "string" },                                  // NEW: verify line/range contains this
  "startLine":    { "type": "integer", "minimum": 1 },                   // NEW: range replace start
  "endLine":      { "type": "integer", "minimum": 1 },                   // NEW: range replace end
  "insertAfter":  { "type": "integer", "minimum": 1 },                   // NEW: insert newText after this line
  "appendFile":   { "type": "boolean" },                                 // NEW: append newText at EOF
  "nearText":     { "type": "string" },                                  // NEW: context anchor for nearText+oldText+newText
  "edits":        { "type": "array", "items": { "anyOf": [               // NEW: batch
                    { "properties": { "line": {"type":"integer"}, "newText": {"type":"string"}, "oldText": {"type":"string"} } },
                    { "properties": { "oldString": {"type":"string"}, "newString": {"type":"string"} } } ] } },
  "runTypecheck": { "type": "boolean", "default": false }                // NEW: opt-in scoped tsc after edit
}
```

Dispatch priority: `oldString` present → exact (ignore others). Else `edits[]` → `line` → `startLine+endLine` → `insertAfter` → `appendFile` → `nearText`. Multiple groups (besides exact) → reject.

**Compile note (verifier):** the `edits[]` "anyOf" above is JSON-schema shorthand — in Effect Schema it must be a union: `Schema.Array(Schema.Union([Schema.Struct({ line: ..., newText: ..., oldText: optional }), Schema.Struct({ oldString: ..., newString: ... })]))`. Mind the optional-prop decoding — within `packages/opencode` the established import is `import { optional } from "@opencode-ai/core/schema"` (core re-exports the schema helper; see `provider.ts:28`), not `@opencode-ai/schema` directly.

---

### 3.2 write (UPGRADE)

**presGEN:** `content` + `filePath` + optional `runTypecheck` (default true for TS), writes with mkdir -p, returns diff + typecheck block.

**Current default:** `content` + `filePath`, `ctx.ask` edit permission with diff, LSP diagnostics, BOM handling, event publishing. Solid.

**Recommended change (minimal, additive):**
- Add `runTypecheck: boolean` (default **false**, same rationale as edit R10 — LSP already covers it).
- When `runTypecheck` is true, run the scoped check from the typecheck tool's shared helper (see §3.8) and append a `<typecheck status=...>` block to output.
- No param changes otherwise. `write` stays the full-file hammer; it is intentionally separate from `edit` (no verification needed — it's an explicit whole-file overwrite gated by the edit permission prompt showing the full diff).

---

### 3.3 read (UPGRADE)

**presGEN:** massive — index-backed autocomplete, bulk/context/pack modes, symbol search, chain pipelines. This is a **separate product**, not a drop-in upgrade; porting it wholesale is out of scope for this workstream.

**Current default:** `filePath` + `offset` + `limit`, line-numbered `<content>`, directory listing, image/PDF attachments, binary rejection, LSP warm-up, instruction reminders, `ctx.ask` read. Already the correct primitive.

**Recommended change (minimal, additive, optional):**
- Add `filePaths: string[]` (bulk read) — reads up to N=8 files in one call, each rendered as its own `<file path=...>` block (compact), joined with `\n\n`. This is the single highest-value token saver from presGEN (`bulk`) and is trivially safe (read-only).
- Add `limit`-per-file semantics already exist; bulk reuses them.
- **Do not** port index/symbol/chain/autocomplete modes — flag as a future workstream if desired.

Param table (additive):

```jsonc
{ "filePaths": { "type": "array", "items": { "type": "string" }, "maxItems": 8 } }
```

---

### 3.4 skill (UPGRADE)

**presGEN:** discovers `agent-skills/` local SKILL.md files (frontmatter: description/triggers/tags/pairs-with), modes `list` / `load(name|names)` / `search` / `tags` / `bundle`, `resolvePairs`, `loadTop`.

**Current default:** `name` param only; loads a **registered** skill via `Skill.Service.require`, asks `permission: "skill"`, lists the skill dir via ripgrep. Registered skills are injected into the system prompt as `available_skills`.

**Recommended change (additive):**
- Keep `name` → `require()` path **exactly as is** (back-compat; registered skills stay the source of truth for system-prompt skills).
- Add `names: string[]` (load several registered skills in one call), `mode: "list"` (enumerate all registered skills with their descriptions), `mode: "search"` + `query` (filter registered skills by substring across name/description), `tags: string[]` (filter by tags), `resolvePairs` (only meaningful if the native skill registry gains `pairs-with` — **defer**; do not build bundle discovery in this workstream).
- If the model requests a name that is not registered, return the `list`/`search` suggestion text instead of dying (soft failure with guidance).
- **Do not** scan `agent-skills/` directories — that is presGEN's local convention and would conflict with the registered-skill model. (Note in doc; builder decision.)

Param table (additive):

```jsonc
{
  "name":   { "type": "string" },                          // unchanged
  "names":  { "type": "array", "items": { "type": "string" } },
  "mode":   { "enum": ["load", "list", "search"], "default": "load" },
  "query":  { "type": "string" },
  "tags":   { "type": "array", "items": { "type": "string" } }
}
```

---

### 3.5 json (AUDIT-ONLY — do not rebuild)

Native `packages/opencode/src/tool/json.ts` + `json/core.ts` already implement the full presGEN mode set: `validate, scaffold, query, search, schema, format, patch, diff, stats`, with pure core logic, `dryRun` default true, and — **better than presGEN** — real `ctx.ask` permission prompts (`read` for input, `edit` with diff for writes) instead of the `confirm:"JSON_WRITE"` string. `DEFAULT_LIMITS` covers maxBytes/depth/keys/items/nodes/results/diffs; `__proto__`/`prototype`/`constructor` keys are rejected.

**Gaps vs presGEN (worth noting, not blocking):**
1. presGEN lets `format`/`patch` operate on `jsonText` input without a file — native supports that already (input.source = "jsonText").
2. presGEN emits `beforeHash`/`afterHash`; native computes them but returns them in metadata — parity confirmed.
3. No `previousRunId`-style diff history (presGEN json doesn't have it either — N/A).
4. Native `json.txt` description is accurate. No action.

**Verdict: no work. Ensure registry already registers it (`json: Tool.init(jsontool)` — present in live registry).**

---

### 3.6 git (NEW tool id `git`)

Inspired by presGEN git.ts (hardened, worktree-bound, argv-array, confirm tokens). **Do not copy the code** — re-implement in Effect/Schema style.

#### 3.6.1 Param table (exact)

```jsonc
{
  "mode":          { "enum": ["help","status","summary","diff","log","show","stage","unstage","restore","commit","shell"], "default": "status" },
  "paths":         { "type": "array", "items": { "type": "string" }, "maxItems": 500 },   // plain relative repo paths
  "ref":           { "type": "string" },                                                   // diff/log/show revision
  "staged":        { "type": "boolean" },                                                  // diff --cached
  "maxBytes":      { "type": "integer", "default": 80000, "minimum": 2000, "maximum": 500000 },
  "maxCount":      { "type": "integer", "default": 20, "minimum": 1, "maximum": 200 },     // log
  "contextLines":  { "type": "integer", "default": 3, "minimum": 0, "maximum": 200 },      // diff
  "message":       { "type": "string", "maxLength": 30000 },                               // commit
  "dryRun":        { "type": "boolean", "default": true },                                 // commit preview
  "confirm":       { "type": "string" },      // "STAGE_ALL" | "UNSTAGE_ALL" | "RESTORE_WORKTREE" | "RESTORE_BOTH" | "RESTORE_ALL" | "COMMIT"
  "allowEmpty":    { "type": "boolean" },
  "sign":          { "type": "boolean", "default": false },                                // --no-gpg-sign default
  "restoreTarget": { "enum": ["worktree","staged","both"], "default": "worktree" },
  "argv":          { "type": "array", "items": { "type": "string" }, "maxItems": 80 }      // restricted read-only shell fallback
}
```

#### 3.6.2 Behavior contract

- **Bound to worktree:** verify `context.worktree` is a git worktree via `git rev-parse --is-inside-work-tree` (timeout 5s); resolve `--show-toplevel`; all paths resolve inside it. Absolute paths, `..` escapes, pathspec magic (`:(`, `:/`), `-`-leading paths, and NUL bytes → reject.
- **Read-only by default.** `status/summary/diff/log/show/help` never write. `stage/unstage` write the index only. `restore`/`commit` write the worktree/history.
- **Confirm-token gating** (in-tool, mirrors presGEN; independent of the permission ask):
  - `stage` with no `paths` → requires `confirm:"STAGE_ALL"`.
  - `unstage` with no `paths` → requires `confirm:"UNSTAGE_ALL"`.
  - `restore`: no `paths` → `confirm:"RESTORE_ALL"`; with paths → `confirm:"RESTORE_WORKTREE"` (or `RESTORE_BOTH` for target "both"). Refuses when conflicts are present.
  - `commit` → always dry-run first (`git commit --dry-run`); requires `confirm:"COMMIT"` to execute. Refuses on unmerged files; requires staged changes unless `allowEmpty`.
- **argv arrays only**, never shell strings. `safeEnv`: `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `PAGER=cat`, `LC_ALL=C`, `GIT_LITERAL_PATHSPECS=1`. Global args: `--no-pager --no-optional-locks -c color.ui=false ... -C <root>`.
- **`shell` mode:** restricted fallback — only read-only subcommands (`status,diff,log,show,branch,rev-parse,ls-files,grep,describe,remote(-v),config(get/list),show-ref,for-each-ref,name-rev,merge-base,cat-file,check-ignore,blame,shortlog`); forbidden args (`-C,-c,--git-dir,--work-tree,--force*,--hard,--delete,-d,-D,...`) rejected. Anything else → refusal with pointer to typed modes.
- **Output:** XML-ish text + metadata. Status parsed from `porcelain=v1 -z`; commit output includes `git log -1` echo; every write echoes a fresh `status` after the operation.

#### 3.6.3 Permission model

- `permission: "git"` for **all** modes (introduce this action string; the in-tool confirm tokens are the *additional* safety layer on top of the permission prompt).
- `patterns`: mode-specific, e.g. `git:status`, `git:diff:<relpath>`, `git:commit:<message-preview>`. For read-only modes patterns are `always: ["*"]`-able; for writes list the touched rel paths.
- Rationale: a dedicated action lets users grant/deny git writes independently of `bash`; the confirm token remains inside the tool so a single ask can't silently push a destructive op.

---

### 3.7 refactor (NEW tool id `refactor`)

Semantic, symbol-aware, multi-file transformations using the TypeScript Language Service. **Plan-first: dry-run by default; writes require `dryRun:false` + `confirm:"REFACTOR"`.** Never a textual grep-replace engine.

#### 3.7.1 Param table (exact)

```jsonc
{
  "mode":              { "enum": ["resolveSymbol","findReferences","renameSymbol","organizeImports","updateImportSource","moveFileUpdateImports","preview"], "required": true },
  "filePath":          { "type": "string" },
  "files":             { "type": "array", "items": { "type": "string" } },
  "line":              { "type": "integer", "minimum": 1 },
  "column":            { "type": "integer", "minimum": 1 },
  "newName":           { "type": "string", "pattern": "^[A-Za-z_$][A-Za-z0-9_$]*$" },   // renameSymbol
  "from":              { "type": "string" },   // old import source / source file (mode-dependent)
  "to":                { "type": "string" },   // new import source / destination file
  "scope":             { "enum": ["file","files","changed","project"], "default": "project" },
  "includeComments":   { "type": "boolean", "default": false },
  "includeStrings":    { "type": "boolean", "default": false },
  "dryRun":            { "type": "boolean", "default": true },
  "confirm":           { "type": "string" },   // required "REFACTOR" for writes
  "previewId":         { "type": "string", "pattern": "^[A-Za-z0-9_-]{8,80}$" },
  "runTypecheck":      { "type": "boolean", "default": true },   // diagnostic delta gate
  "rollbackOnFailure": { "type": "boolean", "default": true },
  "allowGenerated":    { "type": "boolean", "default": false },
  "overwrite":         { "type": "boolean", "default": false },  // move destination
  "maxFiles":          { "type": "integer", "default": 80 },
  "maxEdits":          { "type": "integer", "default": 1500 },
  "maxDiffBytes":      { "type": "integer", "default": 60000 }
}
```

#### 3.7.2 Plan-first contract (the safety core)

1. **`dryRun` default true.** Every write-capable mode produces a `RefactorPlan` = `{ id, mode, summary, createdAt, changes: [{file, rel, kind: modify|create|delete, before, after, edits}], fingerprints: {file → {exists, sha256, size, mtimeMs}} }` and **saves it** to `.opencode/cache/refactor-preview/<id>.json` (TTL 6h).
2. Output for dry-run: `<refactor status="preview" previewId=...>` + per-file change list + unified diff (truncated at `maxDiffBytes`) + **the exact next call** (`refactor({ previewId, mode, dryRun:false, confirm:"REFACTOR" })`).
3. **Apply requires the saved plan id** — args alone are never enough to write.
4. **Stale-check:** before applying, re-fingerprint every touched file; if any changed since preview → **reject** ("Preview is stale…") and require a fresh dry-run.
5. **Diagnostic delta gate:** compute LSP/TS syntactic+semantic diagnostics for touched files before and after; if `after.count > before.count` and `rollbackOnFailure` → restore backups and report `status="rolled-back"`.
6. **Backups:** every changed file is backed up in memory before writes; any exception during apply restores all.
7. **Overlap safety:** `applyTextEdits` rejects overlapping spans; edits sorted by descending start.
8. **Path safety:** worktree-bound resolve; refuses `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, generated patterns (`*.generated.ts`, `__generated__/`) unless `allowGenerated`; refuses `.d.ts` as a write target; never targets repo root.
9. **Limits:** `maxFiles`/`maxEdits` enforced at plan time (reject before any write).

#### 3.7.3 Modes

| Mode | Behavior |
|---|---|
| `resolveSymbol` | quick info + rename info + definitions + reference count at `filePath:line:column` |
| `findReferences` | semantic references grouped by file (worktree-only), snippet + definition flag |
| `renameSymbol` | TS `findRenameLocations` across project; identifier validation; strings/comments opt-in |
| `organizeImports` | TS `organizeImports` per file in scope |
| `updateImportSource` | **AST-only** rewrite of `import/export` module specifiers + dynamic `import()` (never text search) |
| `moveFileUpdateImports` | move file + rewrite its relative imports + rewrite importers; refuses existing dest unless `overwrite` |
| `preview` | re-render a saved plan by `previewId` |

#### 3.7.4 Permission model

- Read-only modes (`resolveSymbol`, `findReferences`, dry-run plans, `preview`): `permission: "read"` on the target file(s).
- Apply (writes): `permission: "edit"`, one ask per touched file with `patterns: [rel]`, `always: [rel]`, `metadata: { filepath, diff }` — identical to edit/write asks. The `confirm:"REFACTOR"` token is the extra in-tool gate on top.

---

### 3.8 typecheck (NEW tool id `typecheck`)

Fast scoped typechecking. **Reuses the repo's own compiler invocation** (packages/opencode `"typecheck": "tsgo --noEmit"`), not a bespoke parser.

#### 3.8.1 Compiler invocation (resolved)

- **Primary:** `tsgo` — resolve as `node_modules/@typescript/native-preview/bin/tsgo.js` (workspace root first, then the worktree). Invoke: `node <tsgo.js> --project <tmpTsconfig> --noEmit --pretty false`.
- **Fallback:** `node <typescript>/lib/tsc.js --project <tmpTsconfig> --noEmit --pretty false` when `@typescript/native-preview` is absent.
- **Scoped project:** write a temp tsconfig in the tsconfig's dir (name `.opencode-typecheck-<rand>.json`, always cleaned up in a `finally`): `{ "extends": "./tsconfig.json", "include": [<relFiles>], "compilerOptions": { "noEmit": true } }` — the presGEN `runScopedTsc` approach. This is why scoped modes are fast while `full` is slow.
- `full` mode shells the repo script (`bun run typecheck` from the package dir) with a `reason` requirement + long timeout.

#### 3.8.2 Param table (exact)

```jsonc
{
  "mode":             { "enum": ["file","files","folder","changed","bottomUp","full","explain"], "default": "file|changed" },
  "filePath":         { "type": "string" },
  "files":            { "type": "array", "items": { "type": "string" } },
  "folder":           { "type": "string" },
  "tsconfig":         { "type": "string" },
  "maxErrors":        { "type": "integer", "default": 80, "maximum": 500 },
  "maxFiles":         { "type": "integer", "default": 60, "maximum": 500 },
  "depth":            { "type": "integer", "default": 2, "minimum": 0, "maximum": 5 },   // bottomUp
  "includeTests":     { "type": "boolean", "default": false },
  "includeUntracked": { "type": "boolean", "default": false },   // changed
  "includeImporters": { "type": "boolean", "default": false },   // bottomUp
  "reason":           { "type": "string" },                      // REQUIRED for full
  "timeoutMs":        { "type": "integer", "default": 30000 }
}
```

Mode resolution: `filePath` given → `file`; `files[]` → `files`; `folder` → `folder`; else `changed`.

#### 3.8.3 Scope computation

- **file/files:** direct, worktree-bound.
- **folder:** recursive scan, skipping `node_modules/dist/build/.next/.turbo/coverage/.git/__pycache__` and generated paths; `includeTests` toggle.
- **changed:** `git diff --cached + --name-only --diff-filter=ACMR` + unstaged + (opt) untracked; filter to TS files.
- **bottomUp:** seed files + local-import dependency closure to `depth` (regex import parse is fine here — it only *selects files*), topological order, optional nearby tests/importers.
- **full:** guarded (requires `reason`), warns it is slow.

#### 3.8.4 Diagnostics reporting

Parse `tsc`/`tsgo` output lines (`path(line,col): error TS<code>: msg`) with continuation lines, capped at `maxErrors`. Report (XML-ish):
- `<scope>` (which files, why), `<tsconfig>`, `<summary>`.
- **Triage:** severity P0–P3 + category counts via a compact code→category map (2307/6142/1259 import-resolution; 2322/2345/2769 type-mismatch; 2305/2448 missing-export; 2304/2552 undeclared; 2531/2532/18047 null-undefined; 17004 jsx-config; 6133/6196 unused; 1005/1109 syntax).
- Per-diagnostic: file/line/column/code/category + **suggestion** (small curated map, fallback generic).
- **Clusters:** group by `code::normalized-message` with occurrence/file counts, ordered P0→P3 — tells the model what to fix first.
- `<next>`: contextual guidance (e.g. "Fix in P0→P1 order", self-healing hints like missing `@/*` paths mapping / missing `jsx: react-jsx`).
- **No storage/diff-history DB** (presGEN's SQLite brotli store) in v1 — `changed`-mode coverage is the fast path; diff-reporting can be added later if needed.

#### 3.8.5 Permission model

Prompt on every call, mirroring the native norm (every tool asks — the closest analog `lsp` prompts with `permission: "lsp", patterns: ["*"], always: ["*"]` at `lsp.ts:56`):

```ts
yield* ctx.ask({
  permission: "typecheck",        // dedicated action key (new, like "glob"/"grep"/"lsp")
  patterns: ["*"],
  always: ["*"],
  metadata: { mode, scope: { files, tsconfig }, full: mode === "full" },
})
```

- `patterns: ["*"]` / `always: ["*"]` matches the lsp shape exactly — auto-allowed under default rulesets, but gives users a `typecheck` config key when they want to gate or deny it.
- `full` mode gets the same ask; the `reason` string is the extra in-tool gate on top (an expensive, non-scoped run deserves both).
- This supersedes the earlier "no ask" draft, whose stated rationale ("like the lsp tool, which does not prompt") was factually wrong — lsp does prompt. The permission key costs nothing (auto-allow by default) and keeps the trust surface consistent.

### 3.9 Cross-tool safety rail mapping (coordinator request: mirror R1–R9)

The edit rails generalize to the new tools. The builder must implement the applicable rails per tool; where a rail does not apply, say why in the code comment.

| Rail | edit | git | refactor | typecheck |
|---|---|---|---|---|
| **R1 no-op → applied=0, never write/ask** | yes (unchanged) | commit: dry-run shows nothing staged → refusal, no commit; stage/unstage/restore on empty pathspec → status-only | plan with **0 real changes** (`makeChange` returns null for `before===after`) → return `status="noop"`, never save a plan, never ask | N/A (read-only) — but `full` without `reason` is refused |
| **R2 empty/required-field reject** | empty oldString | empty `message` rejected; empty `argv` rejected | `newName`/`from`/`to`/positional required, identifier regex-validated | `reason` required for `full`; `folder`/`filePath`/`files` per mode |
| **R3 uniqueness / no guessing** | multi-match reject (exact), nearText window ambiguity reject | shell mode: subcommand must be in readonly allowlist, else refusal (never silently runs something else) | rename/locate spans come from TS LS (never text search); `updateImportSource` rewrites only AST module specifiers, one target per op | N/A (analysis) |
| **R4 verify target before change** | line contains oldText | pathspec normalization rejects escapes/absolutes/`-`-leading before any command | path safety (`safeResolve`, skip-dirs, generated patterns) checked at plan time **before any write** | scope files resolved & worktree-bound before compiling |
| **R5 wide-operation anchor** | ranges >5 lines need oldText/startAnchor | `restore` without paths needs RESTORE_ALL; `stage`/`unstage` without paths need *_ALL tokens | `moveFileUpdateImports` refuses existing dest unless `overwrite`; `renameSymbol` requires a renameable symbol (LS `canRename`) | `full` requires `reason` (analogous anchor for an expensive op) |
| **R6 anchor-verify (reject, don't relocate)** | nearText anchor must match or reject | `assertWorktree` rejects non-git dirs; commit refuses on conflicts | stale-preview check re-fingerprints every file; changed file → reject, require fresh dry-run | tsconfig discovery failure → clear error, no silent default |
| **R7 correct primitive** | appendFile appends at EOF (fixes presGEN prepend bug) | argv arrays only, no shell strings; `-C`/`--git-dir` blocked | AST/LS edits only — never regex-replace on source text | scoped temp tsconfig include — never a full-project default for scoped modes |
| **R8 diff always surfaced** | all strategies return diff + filediff metadata | status echoed after every write; commit echoes `git log -1` | dry-run diff in plan output + `ctx.ask` diff per touched file on apply | N/A (no writes) — diagnostics ARE the diff signal |
| **R9 atomic batch / all-or-nothing** | `edits[]` validated fully in memory, one write under lock | each git op is a single command (atomic); commit = single commit | **validate the WHOLE plan (limits + fingerprints + path safety) before the first write**; backups for every file; any exception → restore all; diag-increase → rollback all | N/A |

Consequence for refactor (explicit): `applyPlan` must perform `verifyPreviewFresh` + `assertPlanLimits` + path-safety for **every** change **before** touching the first file — the current presGEN order already does this; keep it, and add the R1 no-op plan rejection.

---

## 4. Permission Model Summary

| Tool | Action id | Prompts | In-tool gates |
|---|---|---|---|
| edit (upgraded) | `edit` | all writes (diff in metadata) | R1–R9 rails, multi-match reject, atomic batch |
| write (upgraded) | `edit` | all writes (diff in metadata) | none extra (whole-file overwrite) |
| read (upgraded) | `read` | every read | none |
| skill (upgraded) | `skill` | every load (name as pattern) | soft-fail with suggestions on unknown name |
| git (new) | `git` | every call (mode+paths in patterns) | confirm tokens: STAGE_ALL/UNSTAGE_ALL/RESTORE_*/COMMIT; readonly shell allowlist |
| refactor (new) | `read` (probes) / `edit` (apply) | reads: target files; applies: per-file edit ask | plan-first, previewId + confirm:"REFACTOR", stale-check, diag-delta rollback |
| typecheck (new) | `typecheck` | every call (patterns/always `*`, like lsp) | full-mode `reason` gate |
| json (exists) | `read` / `edit` | reads + writes | dryRun default true (native already) |

Rules of thumb: **read-only = prompt once with patterns; destructive = prompt + explicit confirm token; multi-file = plan-first with a saved plan id.**

---

## 5. Output / Metadata Conventions

- `title`: short human label (rel path for file ops, mode for others).
- `output`: XML-ish text the model parses. Every write includes a diff summary (`+a/-d lines`); every edit includes `strategy:`.
- `metadata`:
  - file ops: `{ filepath, diff, filediff: { file, patch, additions, deletions } }`.
  - git: `{ mode, ok, exitCode, truncated }` + structured status/log in output.
  - refactor: `{ mode, status: "preview"|"applied"|"rolled-back", previewId?, changedFiles, edits }`.
  - typecheck: `{ mode, status: "passed"|"failed", files, errors, truncated }`.
- `truncated` flag must be set when output is capped (truncate service appends it otherwise).

---

## 6. Implementation Checklist (ordered)

1. **edit.ts** — add strategy params + dispatch + rails R1–R9 (pure helpers exported for tests: `replaceLine`, `replaceLines`, `insertAfterLine`, `appendToFile`, `replaceNear`, `applyBatch`), `runTypecheck` opt-in calling the shared scoped-tsc helper. Update `edit.txt`. Keep exact path byte-for-byte.
2. **Shared helper** — extract `findNearestTsconfig` + scoped-tsconfig write/run/cleanup into `packages/opencode/src/tool/typecheck-scope.ts` (used by edit opt-in, write opt-in, typecheck tool).
3. **typecheck.ts + typecheck.txt** — new tool, modes + reporting (§3.8). Register in registry (additive).
4. **git.ts + git.txt** — new tool (§3.6). Register (additive).
5. **refactor.ts + refactor.txt** — new tool (§3.7). Register (additive).
6. **skill.ts + skill.txt** — additive params, soft-fail suggestions (§3.4).
7. **write.ts + write.txt** — additive `runTypecheck` (§3.2).
8. **read.ts + read.txt** — optional additive `filePaths[]` bulk (§3.3).
9. **registry.ts** — one additive merge at the end (imports + `yield*` + `Tool.init` + builtin pushes), against the live file. Re-run `bun run generate` from `packages/client` only if the Protocol/HttpApi changed (it should NOT for tool-only changes).
10. **Tests** — see §7. Run `bun test` from `packages/opencode` (never repo root).

---

## 7. Test Plan

| Area | Cases |
|---|---|
| edit rails | no-op returns applied=0 and doesn't write/ask · empty oldString rejected · multi-match exact rejected · replaceAll replaces all · line with wrong oldText rejected showing snippet · range >5 lines without anchor rejected · nearText anchor missing rejected · nearText ambiguous (2 lines contain oldText) rejected listing candidates · insertAfter bounds · appendFile appends at EOF (regression: must NOT prepend) · batch is atomic (one bad op → nothing written) · line-ending/BOM preserved on all strategies · exact path behavior unchanged (existing tests still pass) |
| edit fuzzy path | disproportionate-match still refused · multi-match message unchanged |
| typecheck | file/files/folder/changed/bottomUp resolve correct include sets · temp tsconfig cleaned up on success AND failure · tsgo path used when present, tsc fallback otherwise · full requires reason · diagnostics parsed with continuation lines · cap at maxErrors |
| git | worktree assertion fails cleanly outside a repo · absolute/escaping pathspec rejected · stage-all needs STAGE_ALL · commit dry-run by default; COMMIT executes and echoes log · restore refuses on conflicts · shell mode rejects write subcommands and forbidden args · `-C`/`--git-dir` blocked |
| refactor | dry-run writes plan to cache and returns previewId · apply without confirm rejected · stale preview rejected after file edit · renameSymbol renames across files (strings/comments off by default) · organizeImports idempotent · updateImportSource AST-only (a matching string literal inside a comment/string is untouched) · moveFileUpdateImports updates importers · rollback fires when diagnostics increase · overlapping edits rejected |
| skill | names[] loads multiple · list/search soft-fail on unknown name · single name path unchanged |
| write | runTypecheck false default; true appends typecheck block · existing behavior unchanged |
| read | filePaths[] bulk renders each file · single-path path unchanged |
| registry | additive merge compiles with the shell-background swarm's live changes · tool ids all resolve |

---

## 8. Ambiguities Flagged for Builder / Coordinator

1. **`skill` scope:** I scoped the skill upgrade to *registered* skills only (no `agent-skills/` scan). If the user expects presGEN's local SKILL.md discovery to become default, that's a follow-up decision — flag in the handoff.
2. **`read` bulk:** `filePaths[]` is optional in this plan. If the builder skips it, nothing else depends on it.
3. **`runTypecheck` default off** in edit/write (LSP is the primary signal). presGEN defaults it on. If the user wants parity with presGEN's "typecheck after every edit" UX, flip the default — cheap change.
4. **`git` permission action `"git"`** is a new action string; users with strict permission configs will see a new prompt family. Alternative is reusing `"bash"` — rejected because it conflates git writes with arbitrary shell.
5. **refactor depends on `typescript`** being resolvable from the worktree (root `node_modules/typescript`, then `client/node_modules`, then bare `typescript` via `createRequire`). For this repo the root `node_modules/typescript` exists — verified.
6. **tsgo availability:** `node_modules/.bin/tsgo` is not linked at root in this repo; the typecheck tool must invoke `node node_modules/@typescript/native-preview/bin/tsgo.js` directly (verified present). If a repo lacks `@typescript/native-preview`, the tsc.js fallback covers it.
7. **presGEN edit bug confirmed:** `appendFile: true` path calls `prependFile` — the native build fixes this (appends at EOF, R7).
