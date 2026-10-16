# OXP Token-Usage Estimation Rebuild Plan

**Status:** investigation and implementation plan — empirical rebuild landed;
see `docs/plans/oxp-token-usage-calibration-ledger.md` for implementation
results and `docs/specs/oxp-token-accounting-boundary.md` for the boundary
contract
**Scope:** OpenFork OXP token accounting and surrounding ChatGPT/OpenAI usage estimation  
**Repository:** `WebstormProjects/opencode`  
**Date:** 2026-10-06  
**Primary intent:** replace any conceptually invalid "context exposure / residency / amplification" accounting with a two-stage empirical estimator grounded in what OXP actually observes and what ordinary OpenFork sessions actually measure.

---

## 1. Executive summary

The desired feature is simple in concept, but it has two distinct estimation layers that must never be conflated:

1. **Estimate the token cost of OXP tool calls themselves.**
   - OXP directly sees the request payload that arrives at its boundary and the result payload that it returns.
   - ChatGPT/OpenAI does **not** provide OXP with an authoritative token count for each OXP call.
   - Therefore, OXP tool-call tokens must be estimated from observable payload properties.
   - Ordinary OpenFork sessions provide a large empirical corpus in which tool-call text and model usage are both available. That corpus can be used to calibrate the mapping from OXP-observable payloads to token counts.

2. **Optionally estimate the total/surrounding upstream model usage associated with that OXP activity.**
   - This is a separate statistical estimate.
   - OpenFork sessions expose real per-message usage records such as input, cache-read, cache-write, output, and reasoning tokens.
   - Tool activity in those same messages can be paired with the actual usage record.
   - A model can therefore learn: given the amount and shape of tool activity observable at an OXP-like boundary, what total model usage tends to accompany it?
   - This estimate is intentionally approximate and should be presented as such.

The key conceptual correction is that **OXP is not a timeline of model context residency**. An OXP invocation is a request/response boundary. It does not itself resend prior tool results, nor does it observe ChatGPT's server-side conversation prompt construction. Consequently, "exposure", "unique", and "amplification multiplier" must not be defined as though OXP directly knows that the same tool tokens were repeatedly processed in future model calls.

The old geometric residency model therefore answers a different, poorly identified question and should not survive in the production accounting path.

The live working tree already contains an in-progress replacement with the right high-level direction: `empirical-tool-usage`, direct estimated OXP tokens, and an empirical upstream estimate trained from OpenFork session usage. This plan treats that implementation as **untrusted work-in-progress that must be audited, validated, simplified where necessary, and made semantically rigorous before it is considered complete**.

---

## 2. User intent distilled into explicit requirements

The implementation must preserve the following intent exactly.

### 2.1 What the user actually wants to know

The primary question is:

> "Approximately how many tokens did OXP use on its tool calls?"

That number should mean:

[
T_{OXP} = sum_i left(widehat{T}_{request,i} + widehat{T}_{result,i}ight)
]

where each invocation is counted **once**.

No residency multiplier. No repeated-context assumption. No invented future reprocessing.

A secondary question is:

> "Given this amount/pattern of OXP tool activity, approximately how much total ChatGPT/model usage probably surrounded it?"

That is a second estimator:

[
widehat{T}_{total} = f(	ext{observable OXP activity})
]

and:

[
widehat{T}_{surrounding} =
max(0, widehat{T}_{total} - widehat{T}_{OXP})
]

These three quantities have distinct meanings and should remain distinct in code and UI:

- **Estimated OXP tokens**
- **Estimated surrounding model tokens**
- **Estimated total model tokens**

### 2.2 What must not be claimed

Do not claim that OXP observes:

- ChatGPT's complete server-side prompt;
- the model's exact tokenizer;
- whether a particular result remains in future context;
- how many times prior OXP text was actually reprocessed;
- cache semantics inside ChatGPT;
- semantic memory/context residency;
- exact causal contribution of OXP to all model tokens.

The estimator provides a **relative, empirically calibrated usage concept**, not billing truth.

### 2.3 Bigger is not "better"

These metrics are usage measurements, not quality scores.

- More OXP tokens means more OXP payload/token mass.
- More surrounding tokens means the empirical model predicts more model usage around that tool activity.
- More total tokens means more predicted overall token usage.
- None of those is inherently desirable or undesirable without another objective such as efficiency, task success, or cost.

---

## 3. Current live implementation: what exists now

The live tree has already advanced beyond the earlier geometric implementation.

### 3.1 Production model identity

`packages/core/src/oxp-attribution/attribution.ts` currently declares:

- model kind: `empirical-tool-usage`
- `observedToolPayload: true`
- `estimatedOxpTokens: true`
- `empiricallyEstimatedUpstream: true`
- `geometricResidency: false`
- `availabilitySchema: false`

This is conceptually aligned with the desired direction.

### 3.2 Direct OXP-token estimate

`packages/core/src/oxp-attribution/model.ts` currently computes direct token mass as:

- request Unicode-codepoint chars / calibrated request chars-per-token
- result Unicode-codepoint chars / calibrated result chars-per-token

The calibration currently uses:

- request: approximately **3.32547 chars/token**
- result: approximately **3.57427 chars/token**

Those ratios originate from deterministic tokenization of historical OpenFork tool payload samples with `o200k_base`.

The production projection sums every observed/materialized invocation exactly once.

That is the correct semantic shape for the primary OXP metric.

### 3.3 Empirical surrounding/total model estimate

The live `calibration-v2.json` contains a model trained from ordinary OpenFork session data.

Current corpus:

- 110,495 paired messages
- 2,137 sessions
- 118,438 usage rows
- 165,221 tool rows

Target:

[
input + cacheRead + cacheWrite + output + reasoning
]

Current selected form is a log-space regression with features:

- intercept
- `log1p(requestTokens)`
- `log1p(resultTokens)`
- `log1p(callCount)`
- `log1p(cumulativeTokens)`
- `log1p(cumulativeCalls)`
- `log1p(turnIndex)`
- `log1p(spanSeconds)`

The current production model groups OXP invocations into inferred "turns" using a 1500 ms gap threshold and then estimates total tokens per inferred turn.

### 3.4 Current validation numbers

The live calibration reports approximately:

- cross-validation session WAPE: **25.99%**
- session median APE: **17.97%**
- session P90 APE: **55.76%**
- max absolute fold bias: **23.43%**
- turn-boundary raw error: **1.12%**
- balanced error: **1.62%**

These values are useful, but the model must not be considered validated merely because these metrics exist. The data alignment, target semantics, leakage risk, model-family heterogeneity, calibration stability, and deployment equivalence all need adversarial review.

### 3.5 Old geometric model remains as historical calibration data

`calibration-v1.json` still contains the old geometric-residency calibration, including `rho`, gap threshold, exposure validation, donor statistics, and tokenizer calibration.

The current `calibration.ts` imports it as `legacy` to reuse donor statistics and source metadata.

This is acceptable only if the production behavior is clearly separated from the obsolete geometric semantics. We should strongly consider splitting reusable historical payload/donor/tokenizer data into a neutral artifact rather than retaining a file whose schema semantically advertises an obsolete model.

---

## 4. Why the old model was conceptually wrong for this goal

The previous model performed approximately:

1. infer outer execution clusters from call timing;
2. accumulate request/result "mass";
3. assume a geometric persistence parameter `rho`;
4. carry earlier mass forward into later inferred rounds;
5. sum that modeled exposure;
6. divide by unique token mass to create "amplification".

That gives something like:

[
E = sum_r C_r
]

with recurrence:

[
C_r = ho C_{r-1} + M_r
]

and then:

[
A = E/U
]

where `U` is direct/unique payload mass.

The problem is not primarily mathematical. The problem is **observability and interpretation**.

OXP observes isolated tool request/response events. It does not observe whether ChatGPT later re-inserts those exact payloads into the model prompt. Therefore the recurrence models an unobserved latent behavior.

Even if repeated conversation context often exists in LLM systems, that fact does not license presenting OXP's inferred geometric persistence as measured token usage.

For this product goal, a direct payload token estimate plus a separately trained empirical total-usage proxy is both more defensible and easier to explain.

---

## 5. Canonical semantic model

The rebuilt system should use the following language and equations everywhere.

### 5.1 Layer A — observed OXP payload

For invocation `i`:

- `R_i`: canonical request text visible at the OXP boundary
- `S_i`: canonical result text visible at the OXP boundary

Persist scalar sizes at the boundary whenever possible so historical detail retention is not required for accounting.

### 5.2 Layer B — estimated OXP tokens

Estimate:

[
widehat{T}_{request,i} = g_r(R_i)
]

[
widehat{T}_{result,i} = g_s(S_i)
]

Initially, `g_r` and `g_s` may be calibrated chars-per-token functions.

The aggregate is:

[
widehat{T}_{OXP} =
sum_i widehat{T}_{request,i}
+
sum_i widehat{T}_{result,i}
]

This is the primary metric.

### 5.3 Layer C — estimated total upstream model usage

Define feature vector `x_j` for an empirically meaningful OpenFork message/turn `j`, derived only from signals that an OXP activity can also produce.

Fit:

[
widehat{T}_{total,j} = f(x_j)
]

against actual OpenFork usage records.

For an OXP activity:

[
widehat{T}_{total} = sum_j f(x_j)
]

Then:

[
widehat{T}_{surrounding} =
max(0,widehat{T}_{total} - widehat{T}_{OXP})
]

### 5.4 No "amplification" metric

Do not resurrect:

[
widehat{T}_{total}/widehat{T}_{OXP}
]

under the old name "amplification".

A ratio could theoretically be useful as an analytic diagnostic, but it would mean **predicted total/model usage per estimated OXP token**, not repeated exposure. Unless there is a concrete UX need, omit it.

---

## 6. Phase 0 — preserve the live dirty tree

The repository is highly concurrent and currently dirty.

Relevant files already modified/untracked include:

- `packages/core/src/oxp-attribution/attribution.ts`
- `packages/core/src/oxp-attribution/model.ts`
- `packages/core/src/oxp-attribution/calibration.ts`
- `packages/core/src/oxp-attribution/calibration-v2.json`
- `packages/app/src/pages/oxp/oxp-attribution-panel.tsx`
- `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`

Rules:

1. Do not reset, stash, clean, broad checkout, rebase, or overwrite unrelated changes.
2. Treat current modifications as potentially concurrent legitimate work.
3. Before any implementation edit, inspect focused diffs for every touched file.
4. Reconcile intent with the current file contents, not historical assumptions.
5. Make narrow verified edits only.
6. Do not use upstream source state as authoritative for fork-owned OXP semantics.

---

## 7. Phase 1 — audit the observable OXP boundary

Before changing the estimator further, establish exactly what OXP captures.

### Questions to answer

- What exact request representation is persisted as `context_request_chars`?
- What exact result representation is persisted as `context_result_chars`?
- Are the values measured before or after serialization/wrapping?
- Are hidden envelope fields omitted?
- Does the request scalar correspond to user/model-authored tool arguments only?
- Does the result scalar correspond to the returned model-visible text, structured result object, or another canonical projection?
- How are errors represented?
- How are zero-result, aborted, blocked, permission, and rejected invocations represented?
- Can one invocation produce more than one externally visible result?
- Are non-text/binary/image payloads possible, and how are they accounted?
- Is Unicode length consistently codepoints, UTF-16 code units, or UTF-8 bytes?

### Deliverable

A compact source-of-truth specification:

`docs/specs/oxp-token-accounting-boundary.md`

It should explicitly define the observable accounting unit.

---

## 8. Phase 2 — validate the OXP token estimator itself

The OXP-token estimate must be independently validated before using it as an input to the second-stage model.

### 8.1 Baseline

The current scalar estimator is:

[
tokens approx chars / charsPerToken
]

with separate request/result ratios.

This is cheap and likely sufficient for a rough relative metric, but we should measure its actual error distribution.

### 8.2 Calibration corpus

Use ordinary OpenFork tool-call payloads because they provide realistic argument/result distributions from the same code/tool ecosystem.

For each historical tool invocation, collect:

- tool name
- status
- request canonical text
- result canonical text
- codepoint count
- UTF-8 byte count
- JSON structural properties if cheap
- exact token count under candidate tokenizer(s)
- provider/model family of surrounding generation when known

### 8.3 Candidate token estimators

Compare at least:

1. global chars/token ratio;
2. split request/result ratios;
3. per-tool shrinkage ratios;
4. payload-length buckets;
5. lightweight regression using chars + bytes + structural counts;
6. exact local tokenizer where the tokenizer family is known and cheap enough.

The production goal is not maximum ML sophistication. It is minimum complexity that materially improves error.

### 8.4 Tokenizer-family question

Do not silently assume exact tokenizer equivalence between OpenFork's models and ChatGPT/OXP.

The correct claim is:

- OpenFork's historical payloads can be tokenized with a representative tokenizer such as `o200k_base`;
- this calibrates a useful local text-to-token proxy;
- external ChatGPT model tokenization may differ;
- therefore this is an estimate.

If OpenAI exposes reliable tokenizer-family metadata in the future, the estimator can become model-aware.

### 8.5 Validation metrics

Report:

- aggregate bias
- WAPE
- median APE
- P90/P95 APE
- error by tool
- error by payload-size decile
- request vs result error
- ASCII-heavy vs Unicode-heavy payloads
- structured JSON vs prose/code-heavy results

A model that looks good only at aggregate scale is insufficient.

---

## 9. Phase 3 — reconstruct the empirical OpenFork pairing pipeline

The current `calibrate-upstream-turns.mjs` is directionally correct and should be audited line by line.

Current pairing:

- reads `usage_record`;
- reads tool `part` rows;
- joins by assistant `message_id`;
- estimates tool request/result tokens;
- forms per-message tool summaries;
- uses actual usage-record totals as target.

This directly implements the user's intended "use OpenFork sessions where we know tool calls and costs" idea.

### Required audit checks

#### Join integrity

Verify:

- one usage record maps to the intended assistant message;
- duplicate/retry usage rows are not double-counted;
- messages with multiple generations/restarts are correctly handled;
- tool parts truly belong to the generation whose usage is being targeted;
- provider/model transitions within sessions do not corrupt cumulative features.

#### Target semantics

The current target is:

[
input + cacheRead + cacheWrite + output + reasoning
]

We must explicitly decide whether this is the desired "usage" quantity.

Potential alternatives:

- logical input + output + reasoning;
- provider-metered tokens;
- uncached + cached tokens separately;
- cache-read tokens not double-counted with input depending on provider semantics.

Do not mix provider-specific usage semantics without normalization.

#### Causal wording

The second-stage model estimates **associated/surrounding total usage**, not "tokens caused by OXP".

A message with tools may contain large user text, system prompts, ordinary assistant text, and unrelated context. The regression predicts the total usage accompanying a tool pattern. It does not identify counterfactual usage without OXP.

---

## 10. Phase 4 — rethink the "turn" abstraction

The live implementation groups OXP calls by a 1.5-second gap threshold to approximate ordinary OpenFork assistant-message tool groups.

This is pragmatic, but it is the weakest semantic bridge and deserves focused investigation.

### Why it exists

Ordinary OpenFork calibration has a real `message_id`; external OXP activity does not necessarily expose the upstream ChatGPT generation/message boundary.

Therefore timing is being used to infer which calls belong to one upstream generation.

### Required experiments

Compare:

1. fixed time threshold;
2. learned threshold from OpenFork labeled same-message/different-message gaps;
3. probabilistic boundary model;
4. activity/session metadata already available in OXP;
5. parent tool-call epoch data;
6. request correlation IDs or upstream MCP protocol metadata if available;
7. explicit boundary instrumentation if the tunnel/host can observe a stronger lifecycle signal.

Prefer an actual lifecycle boundary over timing whenever possible.

### Validation

The current labeled gap classifier reports low error, but class imbalance can make raw error misleading.

Continue reporting:

- balanced error
- false merge rate
- false split rate
- precision/recall for generation boundaries
- behavior under parallel/concurrent tool calls
- long-running tools
- rapid successive generations

---

## 11. Phase 5 — improve the surrounding-usage model

The current selected regression has approximately 26% session WAPE. That is probably usable for a rough dashboard concept, but it is not yet strong enough to stop investigating.

### 11.1 Establish baselines

Every candidate must beat simple baselines:

- global average total tokens per tool-bearing message;
- total tokens vs OXP-token scalar ratio;
- linear regression on OXP tokens;
- log-linear regression on OXP tokens + call count;
- per-model or per-provider empirical means.

If an 8-feature model barely beats a simple ratio, prefer the simpler model.

### 11.2 Candidate features

Only include features reproducible at OXP inference time.

Candidates:

- request tokens
- result tokens
- total OXP tokens
- call count
- distinct tool count
- max invocation size
- median invocation size
- request/result ratio
- elapsed tool span
- inferred turn index
- cumulative OXP tokens
- cumulative calls
- activity age
- tool-category histogram
- status/error/blocked counts

Be wary of features that encode session length and create unrealistic extrapolation.

### 11.3 Model-family stratification

OpenFork data may include GPT, Claude, Gemini, DeepSeek, and others with different context usage behavior.

Investigate:

- one global estimator;
- OpenAI-only training corpus;
- model-family conditional estimator;
- hierarchical/global + family correction;
- models selected specifically to resemble the ChatGPT OXP environment.

If the end consumer is ChatGPT/OpenAI, a broad cross-provider model can introduce avoidable bias.

### 11.4 Time split

Current cross-validation partitions by session ID, which protects against session leakage but not temporal drift.

Add:

- strict chronological holdout;
- rolling-origin validation;
- recent-period holdout.

The dashboard should not depend on a historical regime that no longer resembles current model behavior.

### 11.5 Calibration curve

Evaluate prediction calibration by predicted-use decile.

For each decile:

- actual mean
- predicted mean
- bias
- WAPE

This matters because a globally reasonable model may badly overestimate light sessions and underestimate very heavy sessions.

### 11.6 Prediction intervals

If practical, expose uncertainty internally.

For example:

- point estimate
- empirical P50 error
- P90 range

The UI does not need a noisy confidence interval initially, but model diagnostics should retain it.

---

## 12. Phase 6 — separate training artifacts from production runtime

The production runtime should be tiny and deterministic.

### Training/research layer

Keep heavy scripts outside hot runtime:

- corpus extraction
- tokenizer calibration
- candidate model fitting
- cross-validation
- diagnostics
- artifact export

### Production layer

Production should only need:

- persisted request/result scalar measurements;
- small calibration artifact;
- deterministic arithmetic;
- donor fallback for missing historical scalar data;
- optional turn-boundary inference;
- simple model evaluation.

No tokenizer package should be pulled into the hot OXP server path unless benchmarks prove it worthwhile.

---

## 13. Phase 7 — clean up calibration artifact semantics

The current implementation imports `calibration-v1.json` as `legacy` to obtain donor statistics while production behavior comes from `calibration-v2.json`.

That coupling should be cleaned up.

Recommended artifact split:

### `payload-calibration-v1.json`

Contains:

- request/result chars-per-token calibration
- donor statistics
- payload representation schema
- sampling metadata
- payload-estimator validation

### `upstream-usage-calibration-v1.json`

Contains:

- training corpus metadata
- features
- coefficients/model parameters
- turn-boundary calibration
- cross-validation results
- temporal holdout results
- model-family scope
- target definition

This prevents an obsolete `rho`-based artifact from remaining conceptually entangled with the current estimator.

---

## 14. Phase 8 — API contract

The API should express semantics, not implementation accidents.

Recommended conceptual shape:

```ts
{
  totals: {
    calls: number
    activities: number
    inferredTurns: number

    requestChars: number
    resultChars: number

    estimatedRequestTokens: number
    estimatedResultTokens: number
    estimatedOxpTokens: number

    estimatedSurroundingTokens?: number
    estimatedTotalTokens?: number
  }

  coverage: {
    // exact boundary vs historical scalar vs donor fallback
  }

  model: {
    tokenEstimator: {...}
    upstreamEstimator?: {...}
  }
}
```

The existing generic `tokens` field may remain for compatibility if needed, but the public schema and generated SDK should make the meaning impossible to misunderstand.

Do not use:

- `uniqueTokens`
- `exposureTokens`
- `amplification`
- `rho`
- `residency`

for the production feature.

---

## 15. Phase 9 — UI redesign and explanatory language

The current UI direction is much better than the old exposure/amplification panel.

The primary cards should be:

### Estimated OXP tokens

Plain-language tooltip:

> Estimated tokens contained in OXP tool requests and results. Each tool call is counted once. ChatGPT does not report exact OXP token counts, so this is calibrated from comparable OpenFork tool payloads.

### Estimated surrounding tokens

Tooltip:

> Estimated model tokens outside the OXP request/result payloads that tend to accompany a similar amount and pattern of tool activity. This is learned from ordinary OpenFork sessions with measured model usage.

### Estimated total tokens

Tooltip:

> Estimated OXP tokens plus estimated surrounding model usage. This is a relative usage estimate, not an official ChatGPT billing or token count.

### Inferred turns

Tooltip:

> Groups of nearby OXP calls used to approximate upstream model turns when an exact ChatGPT turn boundary is not observable.

### Validation section

Show enough to build trust without pretending to precision:

- calibration corpus size
- validation median error
- WAPE
- last calibrated date

Avoid presenting a false number of significant digits.

---

## 16. Phase 10 — provenance and coverage

A major strength of the existing implementation is that it tracks where payload size came from.

Preserve this.

For each invocation scalar:

- `observed_boundary`: directly recorded at the OXP boundary
- `historical_detail`: derived from retained historical detail
- `calibrated_donor`: imputed from comparable tool/status rows
- `unavailable`: no responsible estimate

The dashboard should distinguish:

- token-estimator error;
- missing-data imputation;
- upstream-usage estimator error.

Those are different uncertainties.

A complete snapshot should not silently imply every row was directly observed.

---

## 17. Phase 11 — adversarial validation matrix

### Payload cases

- empty args
- empty results
- huge source-code results
- huge JSON
- minified text
- Unicode / emoji / CJK
- base64-like text
- long repeated strings
- deeply nested objects
- errors instead of outputs
- cancelled invocations
- permission-blocked invocations
- parallel calls

### Temporal cases

- calls within milliseconds
- calls around the inferred-turn threshold
- long-running tool followed immediately by another call
- multiple concurrent calls
- hour-long activity
- reconnect/retry
- session/activity resumed later

### Corpus cases

- very short sessions
- long coding sessions
- tool-heavy sessions
- prose-heavy sessions
- single-tool sessions
- multi-tool sessions
- different providers
- different GPT generations
- model switching mid-session

### Statistical failure modes

- regression-to-the-mean bias
- huge outlier domination
- leakage through session-derived features
- provider-specific target semantics
- temporal drift
- extrapolation outside training range
- cumulative features exploding over long activities

---

## 18. Phase 12 — tests

### Unit tests

`oxp-attribution-model.test.ts` should verify:

- every direct payload is counted exactly once;
- request and result ratios are applied correctly;
- no historical carry-forward exists;
- no geometric state exists;
- total >= OXP tokens;
- surrounding = total - OXP;
- empty input returns zeros;
- multiple activities do not cross-contaminate cumulative state;
- per-tool totals sum to global direct totals;
- per-source totals sum to global direct totals.

### Property tests

For arbitrary valid rows:

[
T_{OXP}(A cup B) = T_{OXP}(A) + T_{OXP}(B)
]

when accounting direct payload mass.

Direct OXP token accounting must be additive and independent of event ordering except for classification/grouping metadata.

### Golden calibration tests

Given frozen calibration artifact + frozen synthetic activity, production estimates must remain stable.

### Training-pipeline tests

- deterministic fold assignment;
- no session leakage;
- deterministic selected model;
- artifact schema validation;
- target reconstruction correctness;
- expected training corpus counts.

### API tests

Regenerate/update SDK contract and verify old exposure fields are absent.

### UI tests

Verify labels/tooltips do not contain obsolete exposure/residency/amplification wording.

---

## 19. Phase 13 — benchmark runtime cost

The feature is telemetry, so it should not materially tax OXP itself.

Measure:

- scalar recording overhead per invocation;
- snapshot latency at 1k / 10k / 100k / 1M invocation histories;
- allocation footprint;
- DB scan cost;
- cache effectiveness;
- cost of per-activity snapshot;
- UI refresh latency.

Targets should favor linear or better streaming aggregation and avoid reparsing large historical payload blobs.

The production path should operate on persisted scalar lengths wherever possible.

---

## 20. Phase 14 — migration and compatibility

The old geometric API appears to have included concepts such as:

- unique tokens
- exposure
- amplification
- sensitivity/rho
- geometric residency model metadata

The migration should be deliberate.

Steps:

1. inventory all references in:
   - core
   - API schema
   - generated SDK
   - app UI
   - tests
   - docs
   - prototype
2. remove obsolete production fields;
3. regenerate SDK;
4. update mocks/tests;
5. update localization strings;
6. keep historical research artifacts only where useful;
7. make no compatibility promise for fork-owned local APIs unless another OpenFork surface actually requires it.

Because this is a fork-owned local API, semantic correctness is more important than preserving a misleading field.

---

## 21. Phase 15 — calibration lifecycle

A static calibration will eventually drift.

Add a reproducible calibration command that:

1. opens the selected OpenFork DB read-only;
2. extracts eligible usage/tool pairs;
3. records corpus/model/provider/time-window metadata;
4. evaluates token-estimator candidates;
5. evaluates upstream-estimator candidates;
6. performs session-disjoint CV;
7. performs chronological validation;
8. emits a candidate artifact;
9. compares candidate vs production artifact;
10. fails promotion if quality gates regress.

Do not silently auto-train production parameters at runtime.

Calibration should be an explicit offline/research operation.

---

## 22. Quality gates before calling the rebuild complete

### Semantic gates

- OXP tokens count each tool request/result exactly once.
- No production field implies repeated context exposure.
- No production code uses `rho` or geometric residency.
- Upstream usage estimate is clearly separate from OXP token estimate.

### Token estimator gates

- validation documented;
- request/result error distributions measured;
- no severe tool-specific bias left unexplained;
- Unicode and code-heavy payloads evaluated.

### Upstream estimator gates

- session-disjoint CV;
- chronological holdout;
- simple-baseline comparison;
- provider/model-family analysis;
- no data leakage;
- target semantics documented;
- prediction floor rationale validated.

### Engineering gates

- core tests pass;
- API tests pass;
- generated SDK synchronized;
- app typecheck passes;
- focused UI tests pass;
- no unrelated dirty-tree changes touched.

---

## 23. Specific questions that investigation must resolve

1. Does ChatGPT expose any authoritative per-MCP/OXP token metric anywhere in the current protocol? Assume no until proven otherwise.
2. What exact serialized text is model-visible for an OXP request and result?
3. Is `o200k_base` the best practical calibration tokenizer for the current ChatGPT model family?
4. Would exact local tokenization materially improve accuracy enough to justify runtime cost?
5. Should the upstream usage target count cache read/write exactly as the current script does?
6. Which OpenFork model families are valid donors for ChatGPT/OXP behavior?
7. Should training be OpenAI-only?
8. Does the OXP parent tool epoch provide a stronger turn boundary than timing?
9. Can upstream turn boundaries be explicitly instrumented without relying on ChatGPT internals?
10. Does cumulative tool activity genuinely improve out-of-sample prediction, or is it learning session length?
11. How does the estimator behave on activities much larger than the training distribution?
12. Should surrounding usage be presented only when inference lies within the training support?
13. Should uncertainty be shown in the UI or only in diagnostics?
14. Can donor fallback be eliminated for new data by guaranteeing boundary scalar persistence?
15. Which pieces of `calibration-v1.json` remain legitimate reusable payload calibration, and which should be retired?

---

## 24. Recommended implementation order

1. **Freeze semantics in tests first.**
   - Write direct-accounting tests proving no amplification/residency behavior.

2. **Audit the boundary persistence path.**
   - Ensure request/result scalar sizes correspond to the intended canonical payloads.

3. **Audit and strengthen the payload-to-token estimator.**
   - Produce explicit validation metrics.

4. **Audit the OpenFork pairing script.**
   - Verify joins, target semantics, model/provider scope, and leakage.

5. **Benchmark simple upstream-estimation baselines.**
   - Do not assume the current 8-feature model is best.

6. **Add temporal/provider-aware validation.**

7. **Investigate a stronger turn boundary.**

8. **Choose and freeze a production calibration artifact.**

9. **Clean artifact semantics.**
   - Separate obsolete geometric data from reusable donor/tokenizer data.

10. **Finalize API schema.**

11. **Finalize UI wording.**

12. **Regenerate SDK + run focused tests/typechecks.**

13. **Write a calibration/research ledger with measured results and remaining limitations.**

---

## 25. Desired final user-facing mental model

A non-data-scientist should be able to understand the feature in three sentences:

> **OXP tokens** estimate how many tokens were in the requests and results exchanged through OXP; each tool call is counted once.  
> **Surrounding tokens** estimate how much additional model usage usually accompanies a similar pattern of tool activity, based on measured ordinary OpenFork sessions.  
> **Total tokens** combine those two estimates, giving a rough relative picture of overall usage rather than an official ChatGPT token or billing count.

If the implementation cannot be explained that simply without qualification, it is too conceptually muddled.

---

## 26. Current assessment of the live in-progress replacement

The current working-tree direction is substantially closer to the intended feature than the previous geometric-residency system.

Good changes already visible:

- production kind renamed to `empirical-tool-usage`;
- direct OXP payloads are counted once;
- `geometricResidency: false`;
- API exposes estimated surrounding and total tokens;
- calibration uses paired ordinary OpenFork usage/tool records;
- validation is session-disjoint;
- UI now calls out OXP / surrounding / total tokens rather than exposure / unique / amplification.

However, this should **not** be accepted blindly as finished.

The biggest remaining risks are:

1. whether the exact OXP payload measurement matches the text representation being calibrated;
2. whether `o200k_base` proxy error is sufficiently characterized;
3. whether provider/model heterogeneity pollutes the surrounding-usage model;
4. whether the total token target is semantically normalized across providers;
5. whether the 1.5 s inferred-turn heuristic is the best available boundary;
6. whether cumulative features introduce leakage or unstable extrapolation;
7. whether 26% CV WAPE is acceptable relative to much simpler baselines;
8. whether the old calibration-v1 artifact is still creating semantic coupling to the discarded geometric model.

The next engineering pass should therefore be an **adversarial validation and simplification pass**, not another layer of speculative modeling.

---

## 27. Non-goals

This project is not trying to:

- reconstruct ChatGPT's private server-side prompt exactly;
- infer hidden model chain-of-thought;
- calculate official OpenAI billing;
- prove causal token savings from OXP;
- model context-window residency;
- infer semantic memory retention;
- recreate prompt-cache internals;
- optimize for a visually impressive metric.

The objective is a defensible, useful, calibrated estimate of **OXP tool token usage**, with an optional second-order estimate of **surrounding total model usage**.

---

## 28. Definition of done

The feature is done when:

- the primary metric answers "how many estimated tokens went through OXP?" directly;
- every OXP request/result is counted once;
- the estimator is calibrated against real OpenFork tool payload distributions;
- the surrounding model estimate is trained against real OpenFork usage records;
- the two estimates are explicitly separate;
- no geometric residency or amplification semantics remain in production;
- validation and error are quantified honestly;
- API/UI language cannot be mistaken for exact ChatGPT telemetry;
- calibration is reproducible;
- tests enforce the semantics;
- runtime overhead is negligible;
- future maintainers can understand why the model exists without reverse-engineering the research prototype.
