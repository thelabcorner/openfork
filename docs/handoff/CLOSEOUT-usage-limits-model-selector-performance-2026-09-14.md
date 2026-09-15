# Usage / Limits / Model Selector performance campaign: final evidence ledger

Date: 2026-09-14

## Verdict

This campaign is closed for the scoped Usage dashboard, Limits pane, and model selector work.

The final state is evidence-bounded rather than target-by-assertion:

- Usage keeps 1,000-row stress data sets bounded in the DOM and performs one summary request.
- Limits keeps a 50-provider / 300-window stress fixture at eight mounted provider cards, produces no hidden-pane mutations or hidden-pane quota requests, and reuses the already-warm shared quota transport on open.
- Model selector DOM admission remains constant at 21 mounted options from 644 through 2,000 models with the final main-selector overscan of 8. Search matcher CPU is no longer the scaling bottleneck. Cold open is still dominated by browser style / popper / portal work, and net post-debounce search task time is not consistently below 16 ms in repeated production-browser samples.
- Forty realistic selector open/close cycles do not show a linear heap leak. The retained heap rises in the first 20 cycles and falls slightly in the second 20 after forced GC.
- A real browser connect -> reopen -> model click flow exposed one final crash on legacy pricing payloads without `cost.cache`; that boundary is now defensive and the real-click flow passes 3/3.

No speculative optimization was kept when its measured A/B did not justify the change.

## Worktree safety

This closeout only mutates files belonging to this campaign. Concurrent startup, desktop, server-build, multitenant planning, and other worktree changes were treated as foreign and left untouched.

## Final architecture and changes

### Usage

- Large model, session, and maintenance-model tables admit 50 rows initially and expand explicitly in 200-row pages.
- Sorting and filtering still operate on the complete data set. Only DOM admission is bounded.
- Repeated chart geometry / maxima are memoized rather than rebuilt on hover paths.
- Usage summary cache identity is keyed by the logical query rather than refresh revision, so refresh invalidates instead of fragmenting the cache.
- The production-browser fixture stresses 1,000 models, 1,000 maintenance rows, and 400 periods.

### Limits

- `useLimits()` accepts an `active` gate. Provider discovery, quota projection, and focus refresh are suppressed while the owning surface is inactive.
- Renderer transport is shared per `ServerSDK` through a `WeakMap`, with in-flight single-flight plus a five-second renderer snapshot dedupe window.
- Limits admits eight provider cards initially and expands by 16. Full provider data remains available to global cadence aggregation.
- Provider order is stable and independent of live remaining-percent changes, avoiding whole-list reshuffles on quota ticks.
- Countdown display uses the shared `useNow` clock rather than per-row timers.
- Provider-focus retry timers are cleanup-bound.
- The benchmark now measures whole-page Chromium `TaskDuration` for equivalent visible and hidden 1.15-second windows in addition to panel-local mutations and request deltas.

### Model selector

- Ranking remains deferred from admission, with a stable per-open order so enrichment cannot reorder rows under the pointer.
- Optional row usage/stretch enrichment is now strictly open-scoped. It stays false while closed, waits for two paints before idle admission, and cancels pending RAF / idle / timeout work on close or effect replacement.
- Search fields are pre-normalized once. Canonical/provider and account-variant search metadata is prepared structurally rather than lowercased and rebuilt on every keystroke.
- Shared schema search matching now stores delimiter-safe aggregate normalized/compact fields, reducing matching to two native `includes()` checks per token while preserving field boundaries.
- Account-only search expands only the matching account variants. Canonical/provider matches stay collapsed.
- Render navigation uses memoized indexes / sets rather than repeated row scans in interaction paths.
- Limits polling owned by the selector is inactive while closed.
- The benchmark measures Chromium Task, Script, Layout, and RecalcStyle durations, subtracts an equal idle window from search TaskDuration, supports source-level CPU profiles, and supports forced-GC lifecycle stress.
- Missing cache pricing in stale / legacy model payloads is treated conservatively as ordinary input pricing. A missing cache discount can no longer crash ranking or make a model look artificially cheap.

## Final browser evidence

All values below are production Chromium unless stated otherwise.

### Usage, five repeats

Fixture: 1,000 models, 1,000 maintenance rows, 400 periods.

| Metric | Median / invariant |
|---|---:|
| Initial page visible | 572.27 ms |
| Models tab switch | 61.50 ms |
| Activity tab switch | 47.10 ms |
| Maintenance tab switch | 31.50 ms |
| Warm Models switch | 45.70 ms |
| Warm Activity switch | 46.90 ms |
| Warm Maintenance switch | 23.70 ms |
| Model search | 16.40 ms |
| Overview nodes | 332 |
| Models nodes | 837 |
| Filtered-search nodes | 248 |
| Maintenance nodes | 732 |
| Usage summary requests | 1 |

All 5 repetitions passed. DOM counts were identical across all five runs.

The initial-visible value includes route / application startup and is not presented as pure Usage render CPU. The useful invariants are bounded node counts, one request, and stable tab-local work.

### Limits, five repeats

Fixture: 50 configured fixture providers, six windows each. The client also injects the product's automatic quota providers, so the initial fixture performs 52 quota reads in total.

| Metric | Median / invariant |
|---|---:|
| Pane open | 138.20 ms |
| Mounted provider cards | 8 |
| Panel nodes | 556 |
| Provider-list requests total | 1 |
| Quota requests total | 52 |
| Provider-list delta caused by open | 0 |
| Quota delta caused by open | 0 |
| Visible 1.15 s whole-page Task CPU | 56.85 ms |
| Hidden 1.15 s whole-page Task CPU | 40.25 ms |
| Median visible-minus-hidden Task CPU | 12.12 ms |
| Hidden character mutations | 0 |
| Hidden child-list mutations | 0 |
| Hidden provider-list request delta | 0 |
| Hidden quota request delta | 0 |

All 5 repetitions passed. The visible/hidden CPU metric is deliberately whole-page Chromium TaskDuration, so the non-zero hidden baseline includes unrelated application/browser work. Panel-local evidence is stricter: the hidden pane produced zero observed mutations and zero network deltas.

### Model selector catalog matrix, three repeats per size

The final matrix completed 9/9 tests.

| Catalog | Cold open median | Warm open median | Cold Task CPU median | Search net Task CPU median | Search Script CPU median | Mounted options |
|---:|---:|---:|---:|---:|---:|---:|
| 644 | 171.00 ms | 50.60 ms | 182.82 ms | 22.60 ms | 7.00 ms | 21 |
| 1,000 | 176.30 ms | 47.50 ms | 189.08 ms | 20.24 ms | 6.51 ms | 21 |
| 2,000 | 178.90 ms | 62.50 ms | 182.61 ms | 26.90 ms | 9.83 ms | 21 |

Every run had zero selector-open quota-request delta.

The matrix is intentionally interpreted by medians because cold browser work is noisy. The important scaling result is that 644 -> 2,000 models produces essentially no median cold-Task growth in this run while mounted DOM remains 21. Search Script CPU stays below 10 ms median even at 2,000 models. Net search TaskDuration is higher because Solid reconciliation, virtualizer work, style, frame scheduling, and other browser work remain around the matcher.

The prior goal of consistently keeping net post-debounce search TaskDuration below 16 ms is therefore **not proven** by the final repeated matrix. The algorithmic matcher itself is no longer the blocker.

### Search hot-path microbenchmark

Pure prepared-field matching over 2,000 synthetic models, before -> after the aggregate-field matcher:

| Query shape | Previous median | Final median | Approx. speedup |
|---|---:|---:|---:|
| Broad `m` | 0.332 ms | 0.067 ms | 4.9x |
| Broad `model` | 0.338 ms | 0.074 ms | 4.6x |
| Selective `Model 1999` | 0.404 ms | 0.139 ms | 2.9x |
| Provider tokens | 0.911 ms | 0.114 ms | 8.0x |

This isolates the search algorithm from renderer/frame noise and confirms that the remaining browser search time is not dominated by string matching.

### Selector cold-open attribution

An isolated unprofiled 644-model sample before the final lifecycle cleanup measured roughly 146 ms of cold main-thread TaskDuration but only about 24 ms of ScriptDuration; style recalculation alone was about 32 ms and layout about 7 ms.

The corresponding CPU profile source-mapped its largest named application frame to `packages/ui/src/components/scroll-view.tsx:updateThumb`, with Floating UI geometry and Kobalte popper style reads also visible. A narrowly scoped attempt to coalesce initial ScrollView geometry reads was measured and reverted because it did not improve the browser result.

The remaining cold long task is therefore primarily portal / popper / style geometry work rather than model ranking or search-string work. No global UI primitive rewrite is justified by this campaign's evidence.

### Selector overscan A/B

The earlier overscan experiment was invalid because the wrong virtualizer was changed during one side of the A/B. It was discarded and repeated from scratch with the OpenRouter endpoint virtualizer held at 4 and only the main selector changed. Five repetitions at 644 models were run per setting.

| Setting | Cold wall median | Cold Task CPU median | Warm wall median | Search Task CPU median | Mounted options |
|---|---:|---:|---:|---:|---:|
| Overscan 4 | 182.70 ms | 184.88 ms | 55.00 ms | 22.48 ms | 17 |
| Overscan 8 | 193.80 ms | 198.84 ms | 50.60 ms | 22.83 ms | 21 |

Overscan 4 does reduce the mounted window by four rows and modestly lowers the cold medians, but it does not provide a coherent overall latency win: warm open is slower, search is effectively tied, and the overscan-4 sample had substantially larger cold outliers. Because overscan is also the pre-render buffer for fast scrolling, the final code conservatively retains 8 rather than trading interaction headroom for four fewer mounted rows without a dedicated scroll-stutter win.

### Forty-cycle forced-GC lifecycle stress

Final current-code run, 644 models, realistic close teardown pacing:

| Metric | Value |
|---|---:|
| Heap before | 16,069,784 B |
| Heap after 20 cycles | 17,048,348 B |
| Heap after 40 cycles | 16,972,056 B |
| First-half delta | +978,564 B |
| Second-half delta | -76,292 B |
| Total delta | +902,272 B |
| Quota request delta across 40 cycles | +3 |

The curve is inconsistent with a linear per-open leak: retained heap grows during the first half, then decreases after another 20 cycles and forced GC. The remaining ~0.9 MB is treated as one-time warmed/cache state unless a longer independent soak shows renewed monotonic growth. This lifecycle run was repeated after the overscan bookkeeping correction on the exact final selector configuration.

The three additional quota reads occur after the shared renderer snapshot's five-second dedupe window expires during the minute-long stress test. They are a bounded refresh cycle, not per-open fanout. Cold and immediate warm opens themselves add zero quota requests.

An earlier rapid stress loop falsely failed repeated reopens because it considered content teardown complete as soon as the menu was invisible. Kobalte's focus scope performs unmount autofocus/stack cleanup from a zero-delay timer after content disconnect. The final harness waits for actual DOM disconnect, closed trigger state, that macrotask boundary, paint settlement, and a short human-realistic pacing interval before reopening.

### Real-click model selection

The full browser user story was repeated three times:

1. create/open a project session,
2. open the model UI,
3. connect OpenCode Go,
4. reopen the model selector,
5. click `go-model-1` through Playwright's trusted browser click path,
6. verify the composer displays `Go Model 1`.

The first validation attempt uncovered a real crash in deferred ranking when a legacy model cost supplied `input`/`output` without `cache`. The pricing engine now falls back to the input price for missing cache-read pricing. After that fix, the complete browser flow passed 3/3.

## Correctness and validation

- Focused selector / cost / usage-yield suite: **47 passed, 0 failed, 93 assertions**.
- Real-click model-selection browser regression: **3 passed, 0 failed**.
- Final selector matrix: **9 passed, 0 failed**.
- Final Usage benchmark: **5 passed, 0 failed**.
- Final Limits benchmark: **5 passed, 0 failed**.
- Final 40-cycle selector lifecycle stress: **1 passed, 0 failed**.
- `packages/schema`: `bun run typecheck` passes.
- App E2E TypeScript: `bun run typecheck:e2e` passes.
- Production Vite build completed successfully as the web-server build for the final performance runs after the final source changes.
- Full `packages/app` `bun run typecheck` remains blocked by unrelated existing errors, including React-only context-history/context-ledger files, SDK inferred-type serialization, and chat-sidebar typing. The scoped checker likewise reports project/import-environment diagnostics outside the campaign files; no new source diagnostic was identified in the campaign implementation.

## Adversarial static audit

The final static pass specifically looked for work that can multiply with row count, wall-clock ticks, open/close cycles, or simultaneous surfaces.

### Confirmed bounded

- Usage model/session/maintenance detail DOM is capped at 50 initial rows with explicit 200-row expansion.
- Usage filtering/sorting is memoized over the full data set, then sliced for DOM admission.
- Limits provider-card DOM is capped at eight initial entries with explicit 16-entry expansion.
- Limits global cadence aggregation intentionally scans the full provider/window snapshot, but does not mount the full snapshot and is driven by quota-data changes rather than one timer per row.
- Limits uses one shared display clock and passes `now` to leaf rows.
- Hidden/inactive Limits surfaces do not trigger provider discovery or quota fetches.
- Renderer quota single-flight/dedupe is shared per SDK; the `WeakMap` lifetime follows the SDK and its provider maps are bounded by provider ids.
- Selector virtual DOM remains constant at 21 measured options from 644 through 2,000 models with final overscan 8.
- Selector row refs, account-group cache, tooltip listeners, RAFs, idle callbacks, focus timers, and search debounce are cleanup-bound.
- Optional selector usage enrichment cannot become ready while the selector is closed.
- Search normalization is structural/prepared work; keystrokes do not rebuild normalized strings for every field/account variant.
- No per-row `useLimits()` instantiation was introduced in the selector rows or Limits cards.

### Intentionally retained full-data work

- Selector ranking and structural grouping still inspect the complete catalog when their source revisions change. That is required to produce a correct global rank and provider structure. The final catalog matrix shows this is not causing DOM scaling.
- Usage sort/filter still inspects complete result arrays. This preserves correct global ordering/search while DOM stays bounded.
- Limits global bucket math still inspects complete provider windows. This is necessary for the product's aggregate 5h/weekly/monthly view.

### Rejected optimizations

- Global ScrollView initial-measurement coalescing: measured noise-to-regression, reverted.
- Selector overscan 8 -> 4: reduced mounted options 21 -> 17 and modestly improved cold medians, but warm open regressed, search was effectively tied, and cold variance worsened. Retained 8 for pre-render/scroll headroom.

## Remaining frontier, not a closeout blocker

Two performance frontiers remain visible, but neither justifies additional speculative mutation in this campaign:

1. **Cold selector portal/style work.** Cold open still contains one browser long task and is dominated by style/popup geometry rather than ranking JS. A future campaign should profile Kobalte/Floating UI/ScrollView as a UI-primitive stack with representative menus, not special-case the model selector.
2. **Net search frame budget.** Search ScriptDuration is approximately 6.5-9.8 ms median across 644-2,000 models, but repeated net TaskDuration is approximately 20-27 ms median. Further work should target reconciliation/virtualizer/style scheduling and use TaskDuration plus frame traces, not optimize the matcher again.

Those are explicitly recorded frontiers, not unmeasured claims that the current path is perfect. The scoped campaign's correctness, bounded-work, request-locality, lifecycle, and scaling goals now have direct browser evidence.
