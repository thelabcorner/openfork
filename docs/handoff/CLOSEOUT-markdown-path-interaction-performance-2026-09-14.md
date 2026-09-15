# Closeout: message timeline path matching and interaction campaign

Date: 2026-09-14

Status: **implementation complete, focused verification complete, production builds green**

## 1. Objective

This campaign covered the path-like inline-code interaction in the message timeline:

- detect path and URL targets without adding meaningful timeline render cost;
- resolve human-written relative paths against the correct workspace;
- eliminate intermittent false `path does not exist` outcomes;
- make Reveal / Open / Open With responsive even when fuzzy search returns many stale or duplicate candidates;
- preserve rank semantics, remote-server safety, and old-desktop compatibility;
- optimize using the adaptive experimental-design methodology rather than accepting locally faster guesses without confirmation.

The work started from the existing markdown-target feature introduced by `e8db43e2` and did not redesign its UI.

## 2. Final data flow

```text
completed message markdown
  -> one inline-code decoration pass
  -> inlineCodeKind(text)
  -> data-inline-code-kind="path|url"
  -> one document-level pointerover delegate
  -> parseMarkdownTarget(...)
  -> session-scoped markdown path resolver
      -> strict /find/search basename query
      -> canonical server workspace base
      -> allocation/sort-reduced rankPathMatches
      -> ordered absolute candidates
  -> desktop resolveExistingPath(candidates)
      -> one renderer -> preload -> main IPC
      -> rank 0 single-stat fast path
      -> 8-candidate speculative batch after first miss
      -> 24-candidate batches thereafter
      -> first existing candidate in rank order
  -> Reveal / Open / Open With
```

Old desktop clients that do not expose `resolveExistingPath` still use the previous per-candidate `pathExists` fallback.

## 3. Correctness failures found and fixed

### 3.1 Resolver infrastructure errors masqueraded as missing files

`resolveMarkdownCandidates()` previously converted every resolver rejection into `[]`. A network failure, index failure, or transport problem therefore reached the toolbar as an apparently successful empty search and produced a misleading missing-path toast.

The resolver now preserves failures. A genuine empty search still means no candidate, while infrastructure failures reach the existing request-failure path.

### 3.2 One transient `/find/search` failure could poison the whole session

`file.searchMentions()` previously set `mentionsIndexUnavailable = true` on any failure. A temporary network error or server 5xx permanently forced that mounted file context onto the legacy fallback. That could also remove the server-authoritative `base`, making later path reconstruction incorrect.

The new `mentionSearchEndpointUnavailable()` compatibility classifier only permanently downgrades for endpoint-compatibility responses, currently 404 and 405. Transient failures do not poison future searches.

Path actions call mention search with `strict: true`, so transient search failures are reported rather than silently becoming empty legacy results.

### 3.3 Cross-scope resolver cleanup could remove the wrong active resolver

The toolbar is app-global while file search is session-scoped. The old module-global `current` resolver could be overwritten by a newer session and then cleared by cleanup from an older scope.

Resolver registration is now stack-based. Cleanup removes only the exact resolver that registered it, and the newest remaining resolver stays active.

### 3.4 Home-relative paths were reconstructed under the project root

`~/.config/opencode/...` was correctly classified as a path, and the desktop bridge could expand `~`, but `pathCandidates()` first joined the written path under the workspace. The bridge therefore saw `<workspace>/~/.config/...` and never got a usable tilde path to expand.

`~`, `~/...`, and `~\\...` are now emitted intact as home-relative candidates. The desktop main process expands them using Electron's real home directory before stat/open/reveal.

### 3.5 Candidate probing paid one IPC round trip per candidate

The renderer previously called `pathExists` serially. Duplicate basename searches can return dozens of plausible paths, so one click could become a renderer/main ping-pong chain.

The desktop Platform now exposes optional `resolveExistingPath(paths)`. New desktop builds send the entire ranked candidate vector through one IPC and resolve it in the main process.

### 3.6 Hovered targets could become stale under a stationary pointer

Markdown can be morphed or replaced while the pointer stays over the same DOM location. The toolbar previously trusted the activated text until another pointerover occurred.

The active target now revalidates its parsed kind/text, and a narrowly scoped `MutationObserver` watches only the active target's parent while the toolbar is open. If text changes, location state is invalidated and refreshed; if it stops being actionable, the toolbar closes.

### 3.7 Editor-style locations were not consistently classified

Bare filenames such as `app.ts:42`, `app.ts:42:7`, `README.md#L42`, and `README.md#L42C7` need to be classified against the filename rather than the location suffix.

The final detector uses a backward character scan rather than a replacement regex, and the target parser strips both colon and hash-style locations before filesystem resolution.

## 4. Performance changes

### 4.1 Inline markdown decoration

Path classification and inline-code URL-link decoration used to perform separate `querySelectorAll(":not(pre) > code")` traversals. Completed markdown now decorates both concerns in one pass.

No additional per-message component tree or per-target button nodes were introduced. The toolbar remains a single global delegated interaction surface.

### 4.2 Path ranking

The old ranker:

- regex-normalized every candidate;
- allocated ranking wrapper objects;
- populated three arrays;
- sorted the arrays by depth/index;
- mapped wrappers back to candidates.

The optimized ranker:

- fast-paths already-normal slash paths;
- buckets candidates directly by depth;
- preserves stable source order within depth;
- emits exact, suffix, then basename tiers without sorting wrapper objects.

A generated differential corpus compares the optimized ranker against the original algorithm, not just expected examples.

Hostile 50-duplicate candidate construction:

| State | Median |
| --- | ---: |
| Campaign baseline | 65.165 us/op |
| Optimized | 55.737 us/op |
| Improvement | **14.5%** |

### 4.3 Inline-code classifier

The original classifier measured about **191.81 ns/op** on the campaign microbenchmark.

A first location-suffix implementation increased this to about **253 ns/op** and was rejected. Replacing the regex/allocation path with a backward character scan produced about **199.43 ns/op** while adding the missing `:line[:column]` and `#Lline[Ccolumn]` behavior.

This was intentionally treated as a correctness-for-small-cost trade rather than falsely reported as a classifier speedup.

### 4.4 Repeated toolbar actions

While one target is active:

- concurrent duplicate locate requests coalesce onto one promise;
- a successfully resolved path is cached for 1.5 seconds;
- changing/closing the target invalidates that state.

This avoids repeating mention search and filesystem probing when the user moves between Reveal, Open, and Open With for the same target.

## 5. Adaptive experimental-design ledger

The search procedure followed `presGEN_v2/agent-skills/benchmarking-optimization-scientist/references/adaptive-experimental-design.md`.

### Experiment A: false-missing causal partition

```text
Design: diagnostic bifurcation
Search space / factors: real filesystem miss vs resolver/index/transport failure vs wrong workspace root
Why this design is efficient here: one error-propagation audit partitions several plausible causes at once
Assumptions: missing and infrastructure failure must have observably different control flow
Run/partition matrix: resolver rejection, empty result, stale index row, wrong base, successful later candidate
Concurrency/isolation policy: source/test diagnosis only
Result: resolver failures were collapsed to [], transient search failure could permanently downgrade the session, and canonical base could be lost
Search-space eliminated / narrowed: eliminated filesystem stat itself as the sole cause
Interactions discovered: compatibility fallback and canonical-root reconstruction interacted
Next design/action: make failures strict and compatibility downgrade status-specific
```

### Experiment B: ranker mechanism optimization

```text
Design: OFAT plus differential ablation
Search space / factors: normalization strategy, ranking-object allocation, sort passes
Why this design is efficient here: profiler-sized pure function with clear causal mechanism
Assumptions: ranking semantics must remain byte-for-byte equivalent in candidate order
Run/partition matrix: original algorithm vs optimized bucketed algorithm across generated corpus and hostile duplicates
Concurrency/isolation policy: serialized microbenchmarks
Result: 65.165 -> 55.737 us/op median, about 14.5% faster
Search-space eliminated / narrowed: retained fast normalization + depth buckets; removed wrapper/sort design
Interactions discovered: none decision-relevant after equivalence test
Next design/action: keep optimized ranker
```

### Experiment C: location-suffix matcher candidates

```text
Design: candidate racing / OFAT
Search space / factors: regex suffix cleanup vs manual backward character scan
Why this design is efficient here: two independent implementations with a hot-path cost
Assumptions: no-location inline code is overwhelmingly common
Run/partition matrix: old classifier, regex candidate, char-scan candidate
Concurrency/isolation policy: serialized microbenchmark
Result: old ~191.81 ns/op; regex ~253 ns/op rejected; char scan ~199.43 ns/op retained
Search-space eliminated / narrowed: regex location handling eliminated
Interactions discovered: allocation cost mattered more than branch count on common no-location inputs
Next design/action: keep backward scan
```

### Experiment D: fixed filesystem probe concurrency scout

```text
Design: coarse-to-fine ordered search
Search space / factors: concurrency 1, 2, 4, 8, 16, 32 at candidate ranks 0, 5, 25, 50, and all-miss
Why this design is efficient here: geometric spacing covers the useful range cheaply
Assumptions: same filesystem/stat workload, serialized policy measurements
Run/partition matrix: six widths x five rank positions
Concurrency/isolation policy: candidate policies measured serially; concurrency exists only inside the candidate under test
Result: high concurrency greatly improved deep misses but made rank 0 roughly 6x slower in the scout
Search-space eliminated / narrowed: fixed high concurrency eliminated as a global policy
Interactions discovered: optimal concurrency strongly depends on candidate rank
Next design/action: partition rank 0 from the speculative tail
```

### Experiment E: rank-0-first policy racing

```text
Design: diagnostic partition + randomized candidate racing
Search space / factors: rank 0 alone followed by fixed/widening policies
Why this design is efficient here: preserves the high-probability first hit while searching the tail independently
Assumptions: index ranking makes candidate 0 materially more likely than arbitrary tail candidates
Run/partition matrix: fixed 8/16/32, 8->32, 8->16->32, geometric widening; ranks 0/5/25/50/miss
Concurrency/isolation policy: randomized serialized cells; 57 measured samples/cell after warmup
Result: fixed 8 dominated near-front; 16-32 helped deeper cases; geometric widening was not robust under randomized order
Search-space eliminated / narrowed: misleading ordered-run winner rejected; first tail batch centered at 8 retained
Interactions discovered: first-tail width and later-tail width interact materially
Next design/action: refine second-stage width only
```

### Experiment F: second-stage coarse-to-fine refinement

```text
Design: coarse-to-fine adaptive refinement
Search space / factors: after first width 8, steady width 16, 20, 24, 28, 32
Why this design is efficient here: earlier experiments already fixed rank-0 and first-tail behavior
Assumptions: no value in re-exploring eliminated first-stage widths
Run/partition matrix: five second-stage widths x ranks 5/25/50/miss
Concurrency/isolation policy: randomized serialized cells; 48 measured samples/cell
Result: width 24 gave the best balanced middle/deep frontier without the wider 32-resource burst
Search-space eliminated / narrowed: final schedule frozen at 1 -> 8 -> 24
Interactions discovered: width 20 was strongest at rank 25, width 24 stronger at rank 50, width 32 only marginally best on pure miss
Next design/action: isolated final confirmation against serial
```

### Experiment G: final isolated confirmation / ablation

This uses the actual production `firstExistingPath()` implementation and a serial reference over the same real `fs.stat()` candidates. Cells were randomized. Each result below has **80 measured samples after warmup**.

| Existing candidate | Serial median | Final median | Median speedup | Serial p95 | Final p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| rank 0 | 0.0999 ms | 0.1044 ms | 0.96x | 0.1412 ms | 0.1473 ms |
| rank 5 | 0.5095 ms | 0.2698 ms | **1.89x** | 1.7073 ms | 0.7697 ms |
| rank 25 | 2.0920 ms | 0.7072 ms | **2.96x** | 3.4873 ms | 1.8599 ms |
| rank 50 | 4.1634 ms | 1.1928 ms | **3.49x** | 6.2636 ms | 2.8012 ms |
| no candidate exists | 5.1946 ms | 1.3298 ms | **3.91x** | 7.1322 ms | 2.7103 ms |

Rank 0 pays roughly **4.5 microseconds** median for the generalized production helper, while the expensive tail gains approximately 1.9x to 3.9x.

The final policy is therefore kept.

## 6. Desktop resolver semantics

`packages/desktop/src/main/path-resolution.ts` now enforces:

- at most 128 candidate probes per action;
- candidate 0 is probed alone;
- first speculative tail batch has width 8;
- subsequent batches have width 24;
- all promises in a batch may complete out of order, but the first **ranked** successful result wins;
- one thrown stat cannot hide a later valid path;
- if every probe throws, the infrastructure error is surfaced;
- if at least one probe successfully reports missing and no path exists, the result is a normal miss;
- home-relative expansion happens before probing and the expanded path is returned to Open / Reveal.

## 7. Verification matrix

### Focused app tests

Direct command:

```text
bun test \
  src/components/markdown-path-resolve.test.ts \
  src/components/markdown-target.test.ts \
  src/components/prompt-input/at-mention-search.test.ts \
  src/context/file/mention-search-compat.test.ts
```

Result: **59 pass, 0 fail, 119 expectations**.

Coverage includes:

- POSIX, Windows, UNC and mixed separators;
- home-relative paths;
- canonical server root vs client alias root;
- duplicate-name ranking;
- generated differential equivalence to the original ranker;
- stale/throwing path probes;
- bulk desktop resolver compatibility;
- overlapping resolver scopes;
- strict error propagation;
- line/column target parsing;
- 404/405 compatibility downgrade vs transient failure.

### Desktop resolver tests

Result: **10 pass, 0 fail, 18 expectations**.

Additional coverage includes speculative batch shape, rank preservation under out-of-order completion, tilde expansion, mixed probe errors, and the 128-candidate bound.

### Session UI

The package test command ran its full current unit scope: **205 pass, 0 fail, 1631 expectations across 26 files**.

The session-ui repo-native typecheck also passed after the matcher changes.

### Browser regression E2E

```text
bunx playwright test e2e/regression/markdown-target-actions.spec.ts --project=chromium --workers=1
```

Result: **1 passed in 4.6s**.

The E2E verifies the real app-shell toolbar mount, hover positioning, copy behavior, path-vs-URL actions, web filesystem gating, and dismissal.

### Production app build

`packages/app: bun run build`

Result: **PASS**, 4939 modules, 56.96s.

Relevant emitted chunks in this dirty concurrent worktree:

- session: 634.90 kB raw / 189.38 kB gzip;
- root package: 1169.03 kB raw / 336.65 kB gzip.

These aggregate chunks contain unrelated concurrent changes and must not be used to attribute bundle delta to this campaign alone.

### Production desktop build

`packages/desktop: bun run build`

Result: **PASS**.

- main: 75 modules, `out/main/index.js` 395.38 kB;
- preload: 5 modules, `out/preload/index.js` 11.90 kB;
- renderer: 4945 modules, completed in about 1m03s.

Built-artifact audit confirms:

- main contains `resolve-existing-path`;
- preload contains `resolveExistingPath -> ipcRenderer.invoke("resolve-existing-path", ...)`;
- renderer Platform contains the optional bridge;
- lazy `markdown-target-actions` chunk calls the bulk resolver.

### Diff hygiene

Relevant files pass `git diff --check` after normalizing accidental CRLF churn in the LF-native files.

## 8. Repository-wide blockers not caused by this campaign

Repo-native app/desktop typecheck still reports pre-existing dirty-tree errors in:

- `src/components/context-history/context-history.tsx`;
- `src/components/context-ledger/context-ledger.tsx`;
- `src/context/sdk.tsx` (`TS7056`).

None of the path-matching/path-action files appears in those repo-native diagnostics.

An accidental invocation of the app's complete unit suite produced **1411 pass / 14 fail**. The failures are outside this campaign, including current Project Explorer slice timing, layout-tabs expectations, prompt-submit mocks missing `sync().session.get`, and pretext integration. They were not modified as part of this closeout.

## 9. Files owned by this campaign

### App

- `packages/app/src/components/markdown-path-resolve.ts`
- `packages/app/src/components/markdown-path-resolve.test.ts`
- `packages/app/src/components/markdown-target-actions.tsx`
- `packages/app/src/components/markdown-target.ts`
- `packages/app/src/components/markdown-target.test.ts`
- `packages/app/src/context/file.tsx`
- `packages/app/src/context/file/mention-search-compat.ts` (new)
- `packages/app/src/context/file/mention-search-compat.test.ts` (new)
- `packages/app/src/context/platform.tsx`
- `packages/app/src/pages/session.tsx`

### Session UI

- `packages/session-ui/src/components/markdown-inline-code-kind.ts`
- `packages/session-ui/src/components/markdown-inline-code-kind.test.ts`
- `packages/session-ui/src/components/markdown.tsx`

### Desktop

- `packages/desktop/src/main/ipc.ts`
- `packages/desktop/src/main/path-resolution.ts` (new)
- `packages/desktop/src/main/path-resolution.test.ts` (new)
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.ts`
- `packages/desktop/src/renderer/index.tsx`

Some of these files, especially desktop `ipc.ts` and renderer `index.tsx`, also contain unrelated startup-performance edits from concurrent campaigns. Commit slicing must use hunks, not whole-file ownership assumptions.

## 10. Residual risk and live-desktop note

The source, main/preload/renderer builds, focused tests, E2E, and real-filesystem benchmarks are complete.

The currently running desktop process was **not restarted** solely for this campaign. Main/preload changes only become live after the next normal Electron launch. A future manual smoke should therefore verify Reveal / Open / Open With against:

1. a rank-0 project-relative file;
2. a duplicate basename whose correct target is not first;
3. `~/.config/...`;
4. a deliberately missing path;
5. a temporary server/index failure, confirming it is reported as a request failure rather than `path does not exist`.

No source defect remains known from the automated campaign.

## 11. Closeout decision

The final design moves the useful Pareto frontier:

- false-missing correctness is materially stronger;
- canonical-root and home-relative resolution are correct;
- normal rank-0 interaction remains effectively unchanged;
- candidate-tail filesystem resolution is 1.9x to 3.9x faster in final randomized confirmation;
- pure candidate ranking is about 14.5% faster;
- repeated actions reuse in-flight/recent resolution;
- no permanent transient-error downgrade remains;
- no extra normal-timeline reactive or DOM work was introduced beyond one combined decoration traversal and active-only toolbar observation.

**Campaign status: CLOSED.**

No commit was created as part of this closeout.
