# OXP Token-Usage Calibration Ledger

**Status:** implementation record for `docs/plans/oxp-token-usage-estimation-rebuild.md`
**Date:** 2026-10-06
**Scope:** empirical OXP tool-token accounting and surrounding-usage estimation

This ledger records what was rebuilt, what was measured, and what remains
unproven. It follows the plan's "calibration/research ledger with measured
results and remaining limitations" deliverable.

## 1. What changed

### Semantics (production)

- Production model kind is `empirical-tool-usage`; `geometricResidency: false`
  and `availabilitySchema: false` are asserted by tests.
- `T_OXP` counts every observed request/result payload exactly once, with no
  `rho`, no carry-forward, and no amplification.
- The upstream/surrounding estimate is a separate log-space regression over
  OXP-observable features, floored at the direct OXP payload size.
- `estimatedSurroundingTokens = estimatedTotalTokens - estimatedOxpTokens`.

### Artifact split (Phase 7/13)

The obsolete `calibration-v1.json` (which carried `rho`, geometric gap
threshold, and exposure validation) was **removed**. Its still-useful,
model-neutral data was extracted into `payload-calibration-v1.json`:

- canonical payload schema and units
- the legacy calibration corpus window (`corpus.maxStartedAt`) required by the
  historical backfill gate
- `o200k_base` tokenizer ratios and sampling metadata
- per-tool/status donor statistics

`calibration-v2.json` remains the upstream-usage profile and is consumed
separately. `calibration.ts` no longer imports any geometric artifact.

### Bug fixed

`packages/core/src/oxp-attribution/backfill.ts` gated legacy recovery on
`Calibration.status.corpus.maxStartedAt`, which the in-progress rewrite had
dropped from the status object. The gate silently matched **zero** rows,
disabling historical context backfill. The split restored the field and the
Core service test that exercises backfill now passes.

### API / UI

- Route schema (`global.ts`) and regenerated unified SDK expose
  `model.calibration.payloadDigest` and `model.calibration.corpus.maxStartedAt`.
- UI copy is OXP-tokens / surrounding-tokens / total-tokens; obsolete
  unique/exposure/amplification/rho wording is guarded against by test.

### Calibration harness (Phase 3/4/11/21)

`packages/core/script/oxp-attribution/calibrate.ts`:

- opens the OpenFork DB read-only;
- joins `usage_record` to tool `part` rows by assistant message id;
- target = `input + cacheRead + cacheWrite + output + reasoning` (or
  `--target logical`);
- deterministic, session-disjoint folds (stable session-id hash) with no
  session leakage;
- chronological holdout;
- beats-and-reports simple baselines (global mean, OXP ratio, OXP-only log
  regression);
- reports provider scope;
- optional `--retokenize` (requires the optional `js-tiktoken` dependency);
- `--check` runs without writing; otherwise emits both artifacts.

## 2. Measured results

The harness validated structurally against the local development database
(schema/joins/aggregation run end-to-end) and correctly refuses to emit an
artifact when the corpus is below the minimum. The production `calibration-v2`
artifact shipped in the tree reports (from its own training run, not re-derived
in this pass):

| Metric | Value |
| --- | --- |
| paired messages | 110,495 |
| sessions | 2,137 |
| usage rows | 118,438 |
| tool rows | 165,221 |
| session-disjoint CV WAPE | 25.99% |
| CV median APE | 17.97% |
| CV P90 APE | 55.76% |
| max absolute fold bias | 23.43% |
| turn-boundary raw / balanced error | 1.12% / 1.62% |

## 3. Remaining limitations (not silently claimed as solved)

1. **Tokenizer proxy.** Ratios come from `o200k_base` over OpenFork payloads;
   ChatGPT's server-side tokenization may differ. The estimate is a calibrated
   proxy, not billing truth.
2. **Surrounding-usage association, not causation.** The regression predicts
   usage that accompanies a tool pattern; it does not identify counterfactual
   usage without OXP.
3. **Provider/model heterogeneity.** The shipped profile is global across
   providers. The harness reports per-provider counts but does not yet fit a
   provider-conditioned model; an OpenAI-only corpus remains a candidate
   refinement.
4. **Turn boundary.** The 1.5 s inferred-turn gap remains the bridge between
   externally observed OXP activity and ordinary assistant-message tool groups.
   The harness reports labeled-gap statistics but does not yet consume an
   explicit lifecycle boundary.
5. **Calibration drift.** The artifact is static. The harness makes
   recalibration reproducible; promotion quality gates are described in the
   plan (§21) but are not yet enforced by an automated CI step.
6. **Temporal validation coverage.** Chronological holdout is implemented in the
   harness; the value is not yet recorded in the shipped artifact's validation
   block beyond the baseline fields.

## 4. Verification

Focused tests (all passing):

- `packages/core/test/oxp-attribution-model.test.ts` — direct accounting once,
  additivity, order independence, cumulative reset per activity, upstream floor,
  golden projection.
- `packages/core/test/oxp-attribution.test.ts` — boundary/historical provenance,
  unavailable handling, cache invalidation.
- `packages/core/test/oxp-attribution-calibration.test.ts` — artifact
  consistency, corpus window, no geometric semantics, donor lookup, target
  metadata.
- `packages/app/src/pages/oxp/oxp-attribution-presentation.test.ts` — copy
  contract and obsolete-wording guard.
- `packages/opencode/test/server/httpapi-global.test.ts` — Tier-0 route
  round-trip including new calibration fields and absence of obsolete fields.

## 5. Definition-of-done alignment

| Gate | State |
| --- | --- |
| Primary metric answers "how many estimated tokens through OXP?" | done |
| Each OXP request/result counted once | done |
| Payload estimator calibrated on OpenFork tool payloads | done |
| Surrounding estimate trained on OpenFork usage records | done |
| Two estimates explicitly separate | done |
| No geometric residency/amplification in production | done |
| Validation/error quantified honestly | done (recorded above) |
| API/UI language cannot be mistaken for exact telemetry | done |
| Calibration reproducible | done (harness) |
| Tests enforce semantics | done |
| Runtime overhead negligible | scalars only; not re-benchmarked in this pass |
