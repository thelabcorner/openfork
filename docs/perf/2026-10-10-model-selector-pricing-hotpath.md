# Model-selector pricing hot path — 2026-10-10

## Scope and current evidence

Target: `packages/app/src/components/dialog-select-model.tsx`, whose V2 controller
uses `sortByCheapness` after the two-frame/idle first-paint gate. The pricing
algorithm itself is shared with other consumers in
`packages/schema/src/model-select/{cost,usage-yield}.ts`. The change does not
alter how the UI classifies free versus paid models, selects native context
tiers, or blends DeepSeek peak/off-peak rates.

### Implemented

- `priceWorkloadExpected` avoids allocating a diagnostic result and
  cache-adjusted workload for flat and single native-context regimes. All other
  regimes delegate to canonical `priceWorkload`.
- `compilePricingRegimes` skips native pricing object/tier construction for
  ordinary catalog rows that publish neither context tiers nor the legacy
  over-200K tier. DeepSeek time-regime priority remains unchanged.
- `medianPriceForRegimes` preallocates the workload-cost buffer and feeds the
  existing exact median selector without an intermediate `Array.map` callback.
- A standalone, non-gating pricing benchmark was added at
  `packages/app/e2e/performance/unit/model-selector-pricing-benchmark.test.ts`.

### Measurements

Observed via Bun in a local synthetic 16-workload corpus, **not** a production
Electron click-to-paint benchmark. Median over nine benchmark samples; exact
values vary with JIT, load, and machine:

| Models | Regime | Diagnostic pricer | Expected-only pricer | Speedup |
| --- | --- | ---: | ---: | ---: |
| 644 | flat | 0.921 ms | 0.359 ms | 2.57× |
| 644 | native context | 3.857 ms | 0.606 ms | 6.37× |
| 2,000 | flat | 1.704 ms | 0.756 ms | 2.25× |
| 2,000 | native context | 7.415 ms | 0.619 ms | 11.97× |

The flat 10,000-model `compilePricingRegimes` microbenchmark measured 1.313 ms
before the no-tier shortcut and 0.376 ms after on the same Bun runtime; this is
an isolated compilation loop, not an end-to-end ranking result.

### Verification

- The cost/yield model test now performs 22,000 exact `Object.is`-equivalent
  expected-cost comparisons over random workloads, flat/legacy/tiered/time
  regimes, and varied hit rates.
- Regression coverage explicitly checks that the native shortcut does not
  bypass two-row threshold pricing or over-200K/catalog tiers.
- The selector/cost/yield regression set passed 66 tests (zero failures).
- The modified schema/app files passed scoped TypeScript semantic diagnostics.
- Full app typecheck remained blocked by two unrelated
  `project-explorer-tree.tsx` SearchPathSet/ReadonlySet errors; no clean
  package-wide typecheck claim is justified.

### Reproduction and next gates

From `packages/app`:

```sh
bun test ./e2e/performance/unit/model-selector-pricing-benchmark.test.ts
bun test src/utils/model-usage-yield.test.ts src/utils/model-cost.test.ts
```

Next prioritize a controlled browser benchmark using
`e2e/performance/usage-limits-model/model-selector-benchmark.spec.ts` to
measure real cold/warm opens, input dispatch, script/layout CPU, first paint,
virtualized scrolling, and detached-row retention. It starts its own
performance web server/build, so run only in an isolated test environment that
does not collide with active dev sessions. Also quantify rate-update churn in
the WorkBuddy group and continued provider-catalog revision handling.

### Follow-up: exact-coverage pruning and shared Go document lifetime

The merged selector pricing path now passes exact-ID published coverage to
`buildFuzzyPricingFallbackMap`. Published donors remain eligible for other
unpriced models, but an unpriced ID already covered by an exact donor no longer
undergoes redundant normalization, name matching, or candidate scoring. When
every unpriced ID is covered, the merged caller omits fuzzy preparation entirely.
This is safe because `mergePricingFallbacks` always gives exact matches
precedence. Standalone fuzzy callers still receive full results by default.

Reproducible synthetic shared-ID pricing benchmark, median of nine samples
(`e2e/performance/unit/model-selector-pricing-benchmark.test.ts`):

| Catalog | Legacy full merged inference | Exact-covered path | Approximate gain |
| --- | ---: | ---: | ---: |
| 1,000 models | 3.075 ms | 0.039 ms | 79.7× |
| 3,000 models | 8.442 ms | 0.104 ms | 80.9× |

These workloads intentionally have priced/unpriced providers sharing the same
model IDs. Catalogs with genuinely unmatched names still require fuzzy work.
The unchanged standalone fuzzy index remains the general-purpose path.
Randomized duplicate-provider/overlapping-ID tests compare the full merged
result against the pruned path to ensure exact equivalence.

The shared `usage-profile.ts` loader also now has **one in-flight document
fetch and parse** across profile, pricing, and combined consumers (previously
each could independently fetch the same Go document). Pricing is persisted
alongside the historical profile cache for warm process starts. Both cache
objects are schema-validated on read, including timestamp sanity, and a 60s
failed-fetch backoff prevents repeated selector-open requests during outages.
Malformed successful HTTP responses retain the previous usable tables rather
than resetting ranking to empty. A focused deterministic test covers three
simultaneous clients (one HTTP request), persisted pricing, network failures,
retry backoff, and upstream documentation format drift.

An experimental rare-bigram-prefix pruning path was tested against the existing
overlap index; despite passing semantic tests, it increased the 3,000-model
dense-prefix synthetic workload from ~241ms to ~571ms. That branch was removed
from source and is **not** part of this follow-up.

For provider-specific rails other than WorkBuddy, the WorkBuddy quota-sorting
memo now returns before traversing model rows or subscribing to its rate
projections. No live desktop/CDP end-to-end benchmark was performed; the
isolated benchmark must not be represented as a user-facing frame improvement.

The sparse search rank index is now lazy. Previously, its Solid `createMemo`
materialized the entire ranked group-key map as soon as the controller was
created, including when the model selector was closed or there was no search.
`createModelSearchOrderIndexCache` builds that map only for a selective query
that needs the index, then retains a single identity-keyed snapshot until
either the ranked list or group mapping changes. Unit tests assert zero
pre-query indexing, reuse on repeated searches, and invalidation on either
kind of structural change. This removes unnecessary hidden-controller CPU
work without changing query result order or retaining an unbounded cache.