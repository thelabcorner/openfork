# Tool Registry Context Audit

## Purpose

Reduce the provider-visible tool prefix without making the coding agent harder to steer.

This audit follows the browser consolidation, where 25 separately registered `browser_*` tools were replaced by one provider-visible `browser` gateway while retaining the mature per-operation implementations internally.

The goal is **not** to minimize tool count at any cost. The goal is to reduce repeated schema/description tokens while preserving fast, reliable capability selection for high-frequency operations.

## Implementation Status — September 12, 2026

This section supersedes the older recommendations below where they conflict with the implemented state.

Completed in the current consolidation pass:

| Area | Implemented state |
| --- | --- |
| Browser | 25 provider-visible `browser_*` tools -> one `browser` gateway |
| Lazy tools | `checkpoint`, `archive`, `json`, and `test` are lazy through the existing `tool` broker |
| Memory | remains direct/non-lazy by design |
| Verification | `typecheck` remains direct; `test` is lazy rather than merged into `verify` |
| Web | `webfetch` + `websearch` -> one fetch-first provider-visible `web` tool |
| Jobs | standalone `monitor` removed; monitor launch/lifecycle now lives under `background` |
| GPT mutation | GPT-family models see `apply_patch` as the only direct mutation surface; it uses the hardened shared patch engine |
| Non-GPT mutation | `edit`, `write`, and `patch` remain direct pending a separate mutation redesign |
| File search | `glob` + `grep` -> one provider-visible `find` tool; legacy leaf implementations remain internal |

The approved lazy set removes approximately **12.36 KB** of raw schema + description from ordinary provider manifests (`checkpoint`, `archive`, `json`, `test`). `memory` intentionally remains direct.

### Implemented file-search consolidation

The provider-facing search surface is now:

```text
find({ glob: "**/*.ts", path?: "src" })
find({ grep: "SessionIngress", path?: "src", include?: "*.{ts,tsx}" })
```

Exactly one of `glob` or `grep` is required. This preserves the model's learned `glob` / `grep` vocabulary while removing one provider registration and avoiding an abstract mode enum.

Measured through the same `ToolJsonSchema` path used for provider schemas:

```text
old glob schema + description   510 + 523 = 1,033 B
old grep schema + description   431 + 665 = 1,096 B
old combined                              = 2,129 B

new find schema + description   564 + 321 =   885 B
reduction                                 = 1,244 B (58.4%)
```

The merge also fixed search semantics rather than merely wrapping the old tools:

- exact-file grep now passes the requested filename to ripgrep instead of accidentally searching the whole parent directory;
- truncation probes `limit + 1`, so exactly 100 results are no longer falsely reported as truncated;
- file discovery includes hidden project files such as `.github`, `.vscode`, and `.opencode` while core ripgrep still excludes `.git`;
- existing `glob` and `grep` permission keys are preserved at execution time;
- composite provider tools (`find`, `web`, `browser`) no longer get incorrectly blocked by a blanket wildcard rule before delegated leaf permissions can run;
- provider prompts, explorer guidance, shell guidance, ACP classification, CLI rendering, session UI, context grouping, result summaries, and i18n were updated for `find`;
- legacy `glob` / `grep` UI renderers remain only for historical session playback.

### Unadvertised legacy-call auto-healing

`glob` and `grep` remain absent from the provider manifest, but execution has a compatibility repair path for models that emit the upstream OpenCode tool names from prior training.

The current upstream OpenCode wire shapes are:

```text
glob({ pattern: string, path?: string })
grep({ pattern: string, path?: string, include?: string })
```

When `find` is available and no real tool owns the requested legacy name, these calls are rewritten before execution:

```text
glob({ pattern, path })
  -> find({ glob: pattern, path })

grep({ pattern, path, include })
  -> find({ grep: pattern, path, include })
```

The repair accepts both object arguments and JSON-encoded arguments used by the AI SDK repair hook. It is deliberately conservative: malformed inputs, unknown fields, or a genuinely registered `glob` / `grep` tool are not rewritten.

The compatibility layer is wired into the AI SDK tool-call repair path, the native `@opencode-ai/llm` dispatcher, GitLab workflow execution, and first-party Claude tool execution. Native and Claude paths normalize both the tool name and arguments before durable transcript events are emitted, so current UI consistently sees `find` rather than a repaired legacy call.

Validation for the file-search consolidation:

- focused OpenCode matrix: **133 passed, 0 failed** across permission, registry, ACP, `find`, `glob`, and `grep` suites;
- session UI result-summary suite: **23 passed, 0 failed**;
- OpenTUI inline-tool suite: **17 passed, 0 failed**; TUI typecheck is clean;
- legacy-call healing/runtime matrix: **29 passed, 0 failed** across the pure translator, native runtime, and first-party Claude runtime;
- direct OpenCode typecheck reports no `find`, registry, permission, or ACP errors; remaining failures are unrelated dirty-worktree errors in SPAD/control-plane/background/test areas;
- session UI typecheck reports only the two pre-existing unrelated errors in `AssistantMessage.model` and missing `session-changes-v2`.

## Browser Consolidation Baseline

The browser family was the clearest registry outlier:

- Previous provider-visible browser tools: **25**
- New provider-visible browser tools: **1** (`browser`)
- Previous browser JSON-schema payload: approximately **11,213 bytes**
- New browser JSON-schema payload: approximately **837 bytes**
- Schema-only reduction: approximately **92.5%**
- The reduction is larger once the 24 eliminated provider-visible descriptions are included.

The consolidated gateway supports:

```text
browser(action="list")
browser(action="describe", operation="...")
browser(action="call", operation="...", args={...})
```

The individual operation implementations remain internal adapters, so their existing validation, permission families, broker behavior, attachments, result formatting, and legacy session rendering remain intact.

Validation at the time of this audit:

- `test/tool/registry.test.ts`: **19 passed, 0 failed**
- `test/browser/browser-shared.test.ts`: **16 passed, 0 failed**
- Targeted typecheck for the changed browser/registry files: **clean**

## Measurement Method

For each root-level built-in tool, the parameter schema was converted through the same `ToolJsonSchema` path used by the provider-facing registry, then serialized to JSON and measured in bytes.

Where a tool imports a dedicated `.txt` description, that source description size was also measured.

These are **byte measurements, not token counts**. They are useful for relative prioritization. Actual provider prompt cost also includes tool names, wrapper JSON, dynamic descriptions, provider encoding, and any plugin modification.

The raw root-level schemas measured approximately **44.4 KB** before accounting for the fact that several heavy tools are already lazy and therefore do not enter the default provider manifest.

## Current Heavy Schemas

Largest measured parameter schemas:

| Tool | Schema bytes | Description bytes | Approx. raw footprint | Current exposure |
| --- | ---: | ---: | ---: | --- |
| `edit` | 5,311 | 4,658 | 9,969 | default on non-GPT mutation path |
| `memory` | 3,200 | 1,773 | 4,973 | default |
| `refactor` | 2,500 | 1,751 | 4,251 | **lazy already** |
| `read` | 2,309 | 1,794 | 4,103 | default |
| `json` | 2,205 | 1,285 | 3,490 | default |
| `checkpoint` | 2,109 | 1,370 | 3,479 | default |
| `session` | 2,087 | 1,111 | 3,198 | default |
| `sympy` | 1,824 | 1,267 | 3,091 | **lazy already** |
| `archive` | 1,756 | 1,566 | 3,322 | default |
| `typecheck` | 1,668 | 1,401 | 3,069 | default |
| `git` | 1,659 | 1,260 | 2,919 | default |
| `symbols` | 1,475 | 1,130 | 2,605 | default |
| `websearch` | 1,418 | 2,800 | 4,218 | provider/flag gated |
| `project` | 1,367 | 1,594 | 2,961 | default |
| `task` | 1,217 | 4,451 | 5,668+ | default, dynamic description grows further |
| `shell` | 1,177 | ~1,314 | ~2,491 | default |
| `monitor` | 1,158 | 2,550 | 3,708 | default |
| `test` | 1,139 | 931 | 2,070 | default |
| `sqlite` | 1,119 | 2,283 | 3,402 | **lazy already** |
| `background` | 1,103 | 2,391 | 3,494 | default |
| `patch` | 1,034 | 388 | 1,422 | default |
| `skill` | 1,003 | 1,392 | 2,395 | default |

`goal` uses `GoalAgent.Input` rather than a local `Parameters` export. Its schema measured approximately **870 bytes**, and its description is short. It is not a high-priority context target.

## Existing Lazy Broker Is the Main Lever

OpenCode already has the right general mechanism in `tool/access.ts`.

Tools marked:

```ts
exposure: "lazy"
```

remain registered and discoverable but are omitted from the provider tool manifest. The stable `tool` broker exposes only a small `list | describe | call` schema. Explicit `@tool-name` references can still resolve the lazy capability.

This is already used by:

- `refactor`
- `sqlite`
- `sympy`

Therefore, a large part of the remaining context optimization should **not** create more custom family brokers. For coherent low-frequency domain tools, lazy exposure is cheaper and architecturally cleaner.

## Priority 1: Demote Coherent Heavy Tools to Lazy

The easiest high-confidence win is to mark several already-coherent domain tools lazy:

### Strong candidates

```text
memory
checkpoint
archive
json
```

Combined measured schema + description footprint:

```text
memory      4,973 B
checkpoint  3,479 B
archive     3,322 B
json        3,490 B
-----------------
total      15,264 B
```

The existing lazy broker is already present in the manifest, so this can remove roughly **15 KB of raw capability text/schema from every ordinary turn** without introducing another provider-visible tool.

Why these are good candidates:

- They are already internally coalesced by `action`/`mode`.
- They are specialized rather than universal coding primitives.
- Their complete schema is useful only when the task actually needs the domain.
- `tool(action="describe", tool="...")` can materialize exact instructions on demand.
- Explicit mentions remain discoverable through the existing lazy-tool path.

### Medium candidate: `session`

`session` is another coherent action tool at approximately **3.2 KB** raw footprint.

It is a reasonable lazy candidate, but should be measured against real orchestration usage first. It is more central than archive/JSON because agents may use it to recover child sessions, inspect messages, fork, or send turns.

Recommendation: **do not demote `session` in the first pass**. Measure usage after the safer four tools move lazy.

## Priority 1: Mutation Surface Redesign

This is probably the largest remaining structural opportunity.

Current mutation capabilities overlap:

```text
edit
write
patch
apply_patch
```

The registry already switches part of the surface by model:

- GPT-like models: `apply_patch` is visible; `edit` and `write` are hidden.
- Other models: `edit` and `write` are visible; `apply_patch` is hidden.
- `patch` remains visible in both paths.

That leaves duplication in both modes.

### GPT-like path

The model can see both:

```text
apply_patch
patch
```

These are overlapping bulk mutation primitives.

Recommendation: converge on **one provider-visible patch capability** while retaining whatever public name gives the model the best prior.

One likely architecture:

```text
provider-visible apply_patch
        |
        v
robust PatchTool execution engine
```

This keeps the familiar `apply_patch` name for GPT-family models while using the newer robust implementation underneath.

### Non-GPT path

`edit` is currently the single largest schema in the registry and is doing too much.

It contains:

- exact string replacement
- replace-all
- line replacement
- range replacement
- insert-at
- deprecated insert-after alias
- append-file
- near-text targeting
- batch operations
- optional typecheck
- a full `patchText` bulk pathway
- patch apply mode
- patch format
- patch diff controls

The `patchText` branch explicitly overlaps the dedicated `patch` tool.

This is an important counterexample to “coalesce everything”: **`edit` is already over-coalesced.** Its 5.3 KB schema plus 4.7 KB description costs almost 10 KB by itself.

Recommendation:

1. Keep one tiny high-frequency single-file edit primitive.
2. Move multi-hunk / multi-file / create-delete-move behavior exclusively to the robust patch engine.
3. Remove deprecated aliases and bulk-patch fields from the direct `edit` schema.
4. Keep `write` only if benchmarks show models materially benefit from a dedicated whole-file create/replace primitive.

This should be benchmarked with representative coding tasks because a smaller mutation schema can save more context than wrapping several small tools behind another broker.

## Priority 2: Coalesce `monitor` Into `background`

This is the strongest true family-coalescing candidate after browser.

The relationship already exists architecturally:

- `monitor` launches a long-running job through the shared shell/background runtime.
- Its output tells the agent to use `background` to inspect, read, send input, wait, or kill it.
- `background` explicitly says monitor jobs share its manager.

Current combined raw footprint is approximately:

```text
monitor      3,708 B
background   3,494 B
------------------
combined     7,202 B
```

Recommended direction:

```text
background(action="start_monitor", ...)
background(action="list", ...)
background(action="status", ...)
background(action="read", ...)
background(action="wait", ...)
background(action="send", ...)
background(action="kill", ...)
```

Alternative naming would be a single `jobs` or `process` capability, but changing the public `background` name has less benefit than simply absorbing monitor start semantics into it.

This removes a whole provider-visible capability and makes the API match the runtime ownership model.

## Priority 2: Web Family

`websearch` and `webfetch` are semantically adjacent:

```text
websearch  ~4,218 B raw
webfetch   ~1,206 B raw
combined   ~5,424 B
```

A unified surface could look like:

```text
web(action="search", ...)
web(action="fetch", ...)
web(action="providers")
```

However, this change has more migration cost than browser:

- `websearch` has provider/feature-flag gating in `ToolRegistry`.
- Several provider prompts explicitly teach the model the `webfetch` name.
- Search and fetch have strong model priors as distinct operations.

Recommendation: **candidate, but not first-wave**. If implemented, update provider prompts and preserve cache-stable gating carefully.

An alternative is to keep `webfetch` direct and make only the heavier `websearch` lazy on configurations where it is rarely used.

## Priority 2/3: Verification Family

`typecheck` and `test` form a coherent verification domain:

```text
typecheck  ~3,069 B raw
test       ~2,070 B raw
combined   ~5,139 B
```

Possible unified surface:

```text
verify(action="typecheck", ...)
verify(action="test", ...)
```

This is conceptually clean, but both operations are common in coding sessions. A broker adds one level of action routing to high-frequency behavior.

Recommendation: benchmark model call accuracy before changing. A better first optimization may be making their schemas more compact while retaining the direct names.

## Completed: File Search Family

`glob` and `grep` have been consolidated into provider-visible `find` while retaining the mature leaf implementations internally.

The public shape deliberately keeps `glob` and `grep` as mutually exclusive argument names rather than introducing `search(mode="files" | "text")`. This preserves strong model priors and makes routing obvious from the schema itself.

The measured provider-facing raw footprint fell from approximately **2,129 B** to **885 B**, a **58.4% reduction**.

`read` remains separate. File discovery and project-wide content search are still distinct from reading known files.

## Keep Direct

These should remain provider-visible unless usage measurements say otherwise:

### `shell`

Core execution primitive. Strong model prior. Keep direct.

### `read`

High-frequency orientation primitive. Its schema is large, but adding a discovery hop would likely cost more in real workflows. Optimize the schema internally instead.

### `task`

Core agent-orchestration primitive. Keep direct. Its static schema is not especially large, but the description is large and the registry dynamically appends all available subagent descriptions. **Description compaction** is a better optimization target than coalescing.

### `project`

Cheap repository orientation. The planned recent/WorkspaceActivity work should improve it without changing its role.

### `git`

Coherent domain tool with one registration already. Direct access is valuable and safer than teaching the model to reproduce mutations through shell.

### `symbols`

Core code-navigation primitive. Already internally action-based.

### `skill`

Discovery/loading mechanism whose purpose is to make additional specialized context available only when needed. Keeping the gateway itself direct is consistent with the context-reduction architecture.

### `question`, `todowrite`

Small user/control-plane primitives with dedicated UI semantics. No worthwhile coalescing gain.

### `goal`

Measured schema is only about 870 bytes and the description is compact. Leave direct while the Goal system is part of ordinary session control.

## Already Correctly Lazy

Keep these behind the existing `tool` broker:

```text
refactor
sqlite
sympy
```

Their existing implementation validates the lazy architecture and should be the template for `memory`, `checkpoint`, `archive`, and `json`.

## Recommended Execution Order

### Wave 1: Low-risk context removal

Mark these lazy and validate explicit `@` discovery / `tool describe` / `tool call` paths:

```text
memory
checkpoint
archive
json
```

Expected raw prefix reduction: approximately **15.3 KB** before provider encoding.

### Wave 2: Fix mutation duplication

Design and benchmark a canonical mutation surface:

- remove `patch` vs `apply_patch` duplication per model
- simplify `edit`
- remove `edit.patchText` overlap with `patch`
- decide whether `write` materially earns its dedicated registration

This potentially produces the largest additional saving on non-GPT model manifests.

### Wave 3: Job family

Absorb monitor creation into `background`, or rename/rebuild both as one jobs capability if a compatibility layer is acceptable.

### Wave 4: Optional family experiments

Benchmark before adopting:

- `websearch` + `webfetch` -> `web`
- `typecheck` + `test` -> `verify`
- `glob` + `grep` -> `search`

### Wave 5: Usage-informed demotion

Collect tool-call frequency and consider lazy exposure for additional coherent tools such as `session` only if real usage is low enough to justify the extra discovery hop.

## What Not To Do

Do not collapse every capability into one giant universal tool.

That would optimize manifest bytes while damaging:

- model capability routing
- tool-call priors
- argument accuracy
- observability
- permission clarity
- UI semantics

The preferred architecture is three layers:

```text
1. Direct core primitives
   read, shell, task, project, git, symbols, browser, ...

2. Coherent family gateways
   browser, background/jobs, possibly web/verify

3. Lazy specialized capabilities behind `tool`
   refactor, sqlite, sympy, memory, checkpoint, archive, json, ...
```

This gives the model a small stable front door while keeping exact, strongly typed specialist schemas available on demand.

## Suggested Benchmark Before Each Migration

For every candidate, compare the old and proposed manifests on a fixed coding workload and record:

- tool-prefix bytes and tokenizer tokens
- prompt-cache hit behavior
- first-call tool selection accuracy
- number of discovery/describe calls
- invalid-argument rate
- average tool calls per completed task
- wall-clock completion time
- total input/output tokens
- task success rate

The target is not merely a smaller manifest. The target is **lower total task cost with no loss of agent reliability**.
