# OXP Usage workload inspector — UI evidence (timeline + drilldown)

Date: 2026-10-11. Owner: OpenFork. Scope: presentation-only rework of the OXP
workload inspector. No server/Core/SDK surface changed; no i18n, Usage
Performance, native `UsageWorkloadPanel`, main ledger, or cost estimator touched.

## What changed

- `packages/app/src/pages/oxp/oxp-workload-panel.tsx` — replaced the flat
  leaderboard table + bar chart with a **timeline-inspired inspector**:
  - header → compact 7-cell summary strip → full-width **volume/failure
    timeline band** → **expandable leaderboard** with a **real inline
    drilldown** into each tool's outcome timings.
  - Leaderboard rows are **28px**; column headers **27px**; the whole surface
    sits in the 27–32px dense-row band with hairline rules, tabular numerals,
    and the attribution surface's quiet `--oxpa-*` zinc ramp.
  - Every timeline bucket is a focusable button; selecting one shows its exact
    window, call count, successes and failures.
  - Every leaderboard tool is a focusable button (`aria-expanded`,
    Enter/Space); expanding reveals the tool's **already-materialized**
    `Success / Failed / Denied / Cancelled / Interrupted / Running / Unknown`
    outcome counts and its `P50 / P95 / accumulated wall / measured / missing /
    failure rate` timings.
- `packages/app/src/pages/oxp/oxp-workload-model.ts` (new) — pure, testable
  model: tool → icon/label mapping, failure-rate denominator, and deterministic
  ranking. No JSX, no fetches.
- `packages/app/src/pages/oxp/oxp-workload-model.test.ts` (new) — isolated unit
  tests for the model.
- `packages/app/src/pages/oxp/oxp-attribution.css` — narrowly scoped additions
  under `[data-slot="oxp-workload"]…` only.

## Invariants honored

1. **No per-row fetch.** The drilldown reads only `OxpWorkloadProfile` scalar
   metrics the server already returned; expanding a tool performs zero network
   or transcript work.
2. **Bounded top-volume / top-failure.** The panel renders `tools`,
   `topFailures`, and `topTime` exactly as the bounded server projection
   produced them (≤12 each), plus the `otherTools` / `otherCalls` remainder
   row. No client-side expansion of the top-N.
3. **No fabricated external GPT attribution.** OXP calls are labelled
   "observed at the tool boundary with no known upstream model"; no provider or
   model name is invented for a leaderboard row or its inspector.
4. **Keep the cost estimator + current panel functional.** `OxpApiCostPanel`
   and the `OxpAttributionPanel` / `UsagePageOxp` mounting (`profile` prop) are
   unchanged; `OxpWorkloadProfile` / `OxpWorkloadMetrics` exports are preserved.
5. **Dense, keyboard-first.** Rows/headers are 27–28px; the expand control is a
   real button (Enter/Space), the timeline buckets are real buttons, and sort
   headers announce `aria-sort`.
6. **Failure-rate truth.** The inspector re-derives `failed / (failed +
   succeeded)` from the same denominator the server uses and never mixes
   denial/cancel/interrupt/running/unknown into it (asserted in tests).

## Verification (run and green)

- `oxp-workload-model.test.ts` — icon/label mapping, failure-rate null and
  denominator semantics, ranking (descending, tiebreak, null-percentile last,
  no mutation). Passed.
- Scoped TypeScript typecheck of the touched files. Passed.
- No changes outside `packages/app/src/pages/oxp/*` + `docs/plans` in this
  diff.

## Not checked (do not over-claim)

- Visual/pixel E2E and live large-DB rendering remain unexercised here; the
  prior evidence doc still owns that gap.
- The inspector intentionally does **not** link a tool row to its underlying
  invocations — the workload endpoint is scalar-only by design, and the
  transcript (`oxp-timeline.tsx`) remains the surface that owns per-invocation
  detail. Linking the two would require a new bounded server projection and is
  explicitly out of scope for this presentation change.
