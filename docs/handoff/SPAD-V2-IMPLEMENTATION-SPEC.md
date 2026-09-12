# SPAD v2 implementation specification

Status: normative implementation plan

Date: 2026-09-12

Inputs:

- `docs/handoff/SPAD-V2-FRONTIER-RESEARCH.md`
- `docs/handoff/SPAD-V2-AUDIT-FINAL.md`
- current Phase-0/Phase-1 SPAD implementation and precision gym

This document supersedes ambiguous policy/state-machine language in the research
proposal. The research document remains the literature and design ledger; this
file is the implementation contract.

## 1. Product invariant

SPAD is an asymmetric safety mechanism. A false destructive recovery can erase
healthy, expensive work; a missed loop usually wastes tokens and time. The
production objective is therefore:

> maximize useful loop recall subject to an explicit destructive-false-positive
> budget, with abstention as the default for uncertainty.

Aggregate accuracy and F1 are not promotion metrics.

## 2. Terminology

`evidence`
: A detector observation. Evidence has no authority to mutate output.

`policy`
: The single decision layer that determines whether evidence is allowed to
  become a destructive recovery action in the current phase and context.

`recover`
: Truncate/quarantine generated output and request a fresh provider generation.

`observe`
: Emit telemetry but do not alter provider output.

`abort`
: Stop retrying after the bounded recovery budget is exhausted.

`exact proof`
: Raw-code-unit periodicity verified without normalization, hashing assumptions,
  approximate matching, or semantic judgment.

`heuristic evidence`
: Any canonicalized, approximate, structural, gapped, persisted, tool-loop,
  cross-turn, novelty, grammar, or semantic recurrence signal.

## 3. Normative recovery policy

There is exactly one destructive-authority function. Detector code MUST NOT
construct a recovery merely because a threshold fired.

At Phase 0 and Phase 1:

```text
recover_allowed =
    stage0_hard_gates_pass
    AND phase_authorizes(evidence.source)
    AND recovery_budget_remaining
```

### 3.1 Hard Stage-0 gates

These dominate all detector/lane configuration:

1. User explicitly requests repetition -> observe only.
2. Structured/schema output -> observe only unless a future schema-specific
   validity proof is explicitly authorized.
3. Reasoning channel -> observe only.
4. Part-level observe-only request -> observe only.
5. Raw exact repetition inside a code fence -> observe only by production
   default.

The supervisor, not merely a processor call site, MUST enforce the reasoning
boundary.

### 3.2 Phase authority

Production Phase 0/1 authority matrix:

| Evidence source | Detect | Recover by default |
| --- | --- | --- |
| raw exact period | yes | yes, subject to Stage-0 gates |
| canonical period | yes | no |
| expansion/gapped heuristic | yes | no |
| cross-turn thrash | yes | no |
| tool loop | yes | no |
| persisted motif | disabled by default | no |
| future Hamming period | future | no |
| future parameterized/grammar | future | no |
| future novelty/RQA | future | no |

Capability flags may enable a heuristic lane in explicit tests/experiments, but
that does not constitute production promotion.

### 3.3 Recovery budget

Every destructive recovery and relapse consumes the same bounded retry budget.
When the budget is exhausted, the state machine terminates at `abort`; it MUST
not silently re-enter recovery through another lane.

### 3.4 SPAD tool-loop versus `doom_loop`

OpenCode currently has a separate `doom_loop` permission gate for three
identical tool calls. During Phase 0/1:

- `doom_loop` remains the primary interactive guard for identical tool calls;
- SPAD tool-loop detection is evidence/telemetry by default;
- the two systems MUST NOT independently perform destructive actions on the
  same event;
- if SPAD tool recovery is experimentally enabled, policy ownership and
  precedence MUST be explicit before production promotion.

## 4. Evidence contract

All detectors emit provenance-bearing evidence. Minimum common fields:

```ts
type SpadEvidence = {
  kind: "periodic-attractor"
  lane: SpadLane
  source: SpadEvidenceSource
  channel: "text" | "reasoning"
  runStart: number
  runEnd: number
  runLength: number
  period: number
  exponent: number
  agreement: number
  insideCodeFence: boolean
}
```

Lane-specific raw measurements may be attached, but they MUST remain measurements
rather than hidden decisions. Telemetry records both `source` and the final
`policyReason` so the detector and policy layers can be audited independently.

## 5. State machine

```text
provider delta/tool event
        |
        v
detector(s) ---------------------- no evidence -----------------> continue
        |
        v
SpadEvidence
        |
        v
hard Stage-0 policy gates -------- denied ----------------------> observe
        |
        v
phase authority ------------------ denied ----------------------> observe
        |
        v
recovery budget ------------------ exhausted -------------------> abort
        |
        v
recover -> provider regeneration -> relapse watch -> evidence -> policy again
```

Future calibrated fusion/auditing is inserted between evidence and phase
authority, not beside or underneath policy.

## 6. Stage 1: bounded exact-period proof

The current streaming `PeriodLane` is a candidate/proof hybrid and remains the
production baseline until a replacement wins on measured speed and detection
quality.

The v2 exact verifier MUST be bounded. The audit specifically rejects an
implementation that materializes or rescans an O(span) suffix for every token,
which can become O(n^2) on the exact pathological streams SPAD is meant to stop.

### 6.1 Required invariants

1. Proposal generation is cheap and bounded.
2. Candidate count is capped.
3. Full verification is never performed per generated token.
4. Re-verification uses geometric/checkpoint scheduling or equivalent bounded
   incremental state.
5. The verified span is explicitly capped.
6. Extension past a verified checkpoint must be re-verified before emission.
7. Final destructive evidence does not rely on a hash collision assumption.
8. Instrument verification work so the implementation can demonstrate an
   amortized bound of the form `work_since_verify <= c * generated_delta` for a
   declared constant/cap.

### 6.2 Exact mathematical rules

For a finite raw-code-unit span `w` of length `L`, `p` is a period iff
`w[i] == w[i+p]` wherever both positions exist.

The minimal period is derived from the longest border/prefix function:

```text
p* = L - pi[L - 1]
```

The full word is a non-trivial power only when `p* < L` and `p*` divides `L`.
Do not conflate "minimal period" with "primitive root of a full power".

Fine-Wilf collapse is legal only when:

1. `p` and `q` were verified on the same exact raw span, and
2. `L >= p + q - gcd(p,q)`.

Never apply Fine-Wilf/gcd closure to approximate Hamming periods.

### 6.3 Exact-verifier race

Race at least these candidates before changing production:

1. current `PeriodLane` baseline;
2. current q-gram proposal + bounded deterministic prefix-function verifier;
3. a bounded-window runs/minimal-period implementation if it can plausibly win.

Measure:

- ns per generated code unit;
- allocations per MB;
- peak detector memory;
- p50/p95/p99 push latency;
- detection delay from pathological-loop onset;
- exact-loop recall by period/exponent class;
- candidate proposals and verification code units per MB.

### 6.4 Measured prototype checkpoint, 2026-09-12

The prototype now includes a bounded 8,192-code-unit verifier, candidate-only
exact verification, minimal-period reduction, Fine-Wilf threshold helpers, and
phase-invariant cyclic motif identity. Exhaustive binary cross-checks through
length 12 are green.

Measured on Bun 1.3.14 in `packages/opencode/script/bench-spad-exact-proof.ts`:

- healthy `PeriodLane` baseline is about 20 ns/input code unit on a 1 MiB random
  ASCII stream;
- reusable full exact proof is about 2.0-2.7 ns/span code unit on the tested
  2-4 KiB spans;
- candidate-only exact proof is about 0.45-0.61 ns/span code unit;
- pessimistic candidate-only proof every 1,024 input units adds about 1.5-3.0
  ns/input code unit;
- random ASCII produced 0 candidate additions/MiB;
- healthy generated code produced about 85k candidate additions/MiB;
- healthy Markdown enumeration produced about 122k candidate additions/MiB;
- healthy changing JSONL produced about 161k candidate additions/MiB;
- all three structured healthy streams produced zero threshold passes and zero
  confirmations.

This proposal-rate result fixes the production insertion point. Full proof MUST
NOT run for every q-gram candidate addition. Candidate churn is intentionally
high on repetitive-but-progressing structured text. The safe insertion point is
terminal threshold pass: `PeriodLane` proposes and incrementally validates, then
one bounded independent proof certifies exact periodicity before destructive
authority is granted.

Production raw recovery now follows that rule. `raw-exact-period` evidence is
recoverable only when terminal proof metadata is present; missing proof metadata
fails closed to observation. The original proposed period is retained for
compatibility and threshold accounting, while the computed minimal period is
attached separately.

## 7. Exact/approximate boundary

Approximate evidence MUST NOT borrow the semantics of exact runs.

### 7.1 Hamming-period lane

The first approximate lane, if implemented, uses one declared model:

```text
mismatches = HAM(S[0 .. W-p), S[p .. W))
compared = W - p
```

Required hygiene:

- bounded `W` and bounded `k`;
- `compared >= p` (equivalently `W >= 2p`) before evidence is meaningful;
- retain `{p, W, compared, mismatches, mismatchRate}` directly;
- block-bootstrap/calibration blocks must be larger than the tested period;
- pin the exact indexing convention in code/tests;
- no gcd/Fine-Wilf collapse across approximate periods.

This lane remains observe-only until independently promoted.

### 7.2 Undefined Stage-2 terms

The following research-proposal terms are not implementation-ready and MUST be
defined mathematically or dropped before they enter fusion:

- approximate exponent;
- repeated-cycle count;
- approximate maximality;
- gapped-repeat hash/collision policy;
- structural tokenizer rules;
- "string literals when appropriate";
- LPF normalization denominator;
- entropy estimator/slope;
- resource/narration progress deltas.

Undefined features cannot be calibrated and therefore cannot gain authority.

## 8. Structural evidence rules

### 8.1 Parameterized matching

Consistent-renaming matches must report at least:

- constant coverage;
- number of parameter classes;
- number/density of parameter classes bound more than once;
- matched span length.

All-fresh parameters are effectively wildcards and are weak evidence. Guard,
callee, role, and ordering swaps are adversarial negative cases.

### 8.2 Grammar/code evidence

Grammar evidence is structural evidence only. Repetitive generated code can be
legitimate. It remains observe-only until the code-specific negative registry
and holdout demonstrate acceptable false-positive risk.

### 8.3 Novelty/RQA

Novelty is content-class dependent and cannot use one global null.

If recurrence quantification is explored, call it indicator-kernel RQA unless a
real continuous embedding/norm/epsilon construction exists. Define the codebook,
kernel, recurrence threshold, Theiler exclusion, and sweep procedure explicitly.

Do not apply order-preserving matching directly to a heterogeneous multi-field
feature vector. If used, apply rank-shape reasoning to declared scalar series or
another mathematically valid representation.

## 9. Calibration and fusion

Fusion does not begin until all included features have stable definitions and
provenance.

### 9.1 Data split

Use three disjoint families:

1. development/training;
2. frozen calibration;
3. hash-locked, one-look adversarial holdout.

Group by source session/family. Counterfactual twins stay in the same split.
Never tune a threshold on the final holdout.

### 9.2 Objective

Fit the smallest useful model, initially logistic regression.

Primary optimization:

```text
maximize recall
subject to expected destructive FP / production unit <= B
```

If action cost is explicitly modeled with posterior `p = P(degenerate | F)`, a
Bayes action threshold is:

```text
tau = C_FP / (C_FP + C_FN)
```

Do not use raw model scores as calibrated posterior probabilities.

### 9.3 Prior shift

Gym prevalence is not live prevalence. Apply/measure content-class and
production-prior correction rather than interpreting gym PPV as production PPV.

## 10. Certification and false-positive budgets

The existing synthetic gym is a regression floor, not a measured production
false-intervention rate.

### 10.1 Surfaces

Track separate budgets, for example:

```text
B_total = B_exact + B_fused + B_auditor
```

Choose units before collection; generated tokens are primary, bytes/code units
secondary. Session-level incident rate should also be reported.

### 10.2 Outcome-labeled production nulls

Current-policy observations are selected/censored. Estimation must account for
selection. Use randomized/known-probability sampling of non-intervened traffic
for labeling and Horvitz-Thompson or another justified estimator when needed.

Identification is the first problem; simply increasing synthetic `N` does not
solve biased sampling.

### 10.3 Confidence and multiplicity

For a zero-failure target `p0`, a planning rule of approximately `N >= 3/p0`
gives the familiar 95% zero-event upper-bound scale. Use exact binomial
Clopper-Pearson bounds in reports, not only the rule of thumb.

Correct for lane x content-class multiplicity with Holm or pre-registered
Bonferroni families. Bootstrap/uncertainty should cluster by session/source,
not individual token.

### 10.4 Protected-negative registry

At minimum maintain explicit protected classes for:

- prose;
- source code by major language family;
- Markdown nested lists/tables;
- JSON/JSONL;
- CSV;
- SQL/bulk operations;
- logs/stack traces;
- diffs/patches;
- repetitive generated tests;
- enumerations with changing values;
- quoted/reference corpora;
- user-requested repetition;
- iterative read/edit/test workflows with genuine state progress.

Every promotion gate has per-class floors; strong aggregate performance cannot
hide a regression in a valuable class.

### 10.5 Historical OpenCode database replay checkpoint, 2026-09-12

The current detector stack has been replayed read-only against the user's real
OpenCode database at:

`C:\Users\slooshied\.local\share\opencode\opencode-main.db`

The replay is implemented by `packages/opencode/script/spad-db-replay.ts`. It
uses the persisted parent user prompt for `makeTurnPolicy`, replays assistant
text/reasoning at 32-code-unit chunks, runs the sustained parameterized watch
only over fenced JavaScript/TypeScript code, and reconstructs tool/thrash state
over logical user turns. Historical synthetic `[Internal recovery ...]` user
messages are collapsed back into the preceding genuine turn for the
counterfactual heuristic replay.

Measured exposure:

- 6,011 reconstructed logical user turns;
- 46,779 assistant generations;
- 18,339 visible assistant text parts / 8,937,500 code units;
- 37,538 assistant reasoning parts / 45,585,546 code units;
- 58,127 tool calls, including 9,267 write/edit/patch mutations;
- 356 fenced JS/TS code regions / 2,927 code lines for the structural watch.

Current-policy replay results:

- raw/canonical/expansion detector: zero persisted text detections;
- reasoning detector: zero detections, although reasoning remains a hard
  observe-only boundary regardless;
- sustained parameterized structural watch: zero detections;
- resource-aware tool-loop watch: zero candidate turns after the SQLite
  resource-identity fix described below;
- cross-turn thrash watch: 213 / 6,011 logical turns, or 3.5435%.

The zero text result was sanity-checked by feeding a known exact loop through
the same 32-code-unit replay path. It produced raw evidence with period 33,
run length 231, and independent exact-verified span 231. The structural replay
path was likewise checked against the canonical four-block renamed-code fixture
and produced recurrence 3 with four renamed parameter classes. The zero corpus
counts therefore do not come from a disabled replay path.

The database also contains 434 historical SPAD recovery injections across 157
sessions from the earlier aggressive configuration:

- 345 cross-turn-thrash recoveries;
- 26 tool-loop recoveries;
- 63 raw-output recoveries.

Thus 371 / 434 historical interventions (85.5%) came from heuristic lanes that
have no destructive authority in the current production profile. Of the 63 raw
recoveries, the immediately preceding persisted assistant generation is
reasoning-only in 43 cases, visible-text-bearing in 14, and has neither
persisted text nor reasoning in 6. Because reasoning is now supervisor-enforced
observe-only, at least 414 / 434 historical injections (95.4%) are structurally
impossible under the current v2 authority policy before applying exact proof,
code-fence, structured-output, or explicit-repetition gates.

Do NOT interpret the remaining historical raw cases as labeled positives or
negatives. Old SPAD truncated/quarantined the offending continuation before the
database persisted the final message, and the database contains no
`spad.action` event telemetry from which the excised motif can be reconstructed.
This historical corpus is therefore intervention-censored.

The heuristic replay found one concrete tool-loop false positive before the
final replay: a legitimate database-research turn issued many distinct `sqlite`
queries, but `toolResourceKey()` collapsed all of them to `sqlite:query` because
the generic `action: "query"` field was selected before the SQL body. Resource
identity now special-cases SQL with a bounded normalized-content signature. The
frontier regression suite is 24/24 green after that change, and the full replay
falls from 1 tool-loop candidate to zero across all 58,127 tool calls.

Thrash remains intentionally observe-only. The current watch re-flags 157 of
285 logical turns that historically received a thrash recovery and proposes 56
additional turns that did not. Historical interventions are not ground-truth
labels, so neither set can be called true/false positives without review. The
3.5435% candidate-turn rate is nevertheless far above any plausible destructive
false-positive budget and blocks promotion by itself.

Statistical caution: zero observations on persisted healthy traffic improve the
empirical null but do not identify a live production false-intervention rate.
The corpus is selected by historical model/task mix, old interventions censor
some pathological tails, and individual parts/turns are not independent draws.
Use this checkpoint as a large regression/null corpus, not as a certification
claim.

## 11. SPAD Auditor contract

The auditor is configurable, enabled by default, and subordinate to deterministic evidence. An explicit `experimental.spad_auditor: false` disables it.

### 11.1 Input asymmetry

Give it neutral excerpts and objective features. Do not say "SPAD detected a
loop" or reveal a proposed recovery decision. Randomize excerpt order when the
task permits and record generator/auditor model families for bias analysis.

### 11.2 Runtime

- cheap/small pinned model;
- no filesystem, shell, browser, grep, or repo tools;
- exactly one terminal verdict tool;
- tiny bounded context;
- low temperature;
- one attempt plus at most one protocol repair;
- low-single-digit-second timeout;
- timeout/malformed/unavailable => observe/continue.

### 11.3 Authority

Phase 0/1: auditor has no destructive authority.

Later phases: an auditor may only participate after calibration on the actual
post-detector candidate distribution. A safe promotion form is:

```text
recover = deterministic_floor_D
          AND auditor_decision == degenerate
          AND calibrated_posterior >= tau
          AND Stage-0 gates
          AND phase authority
          AND budget
```

Auditor confidence emitted directly by an LLM is not a calibrated posterior.
The auditor MUST NOT create a destructive positive from otherwise weak evidence.

## 12. Metrics

Primary quality:

- destructive false positives per million generated tokens;
- destructive precision at the chosen operating budget;
- recall by failure class;
- false positives by protected content class;
- detection delay from loop onset;
- healthy-output tokens destroyed;
- aborts/relapses per session.

Systems:

- ns/code-unit and ns/token;
- p50/p95/p99 detector latency;
- allocations/MB;
- peak memory;
- proposal count/MB;
- verification code units/MB.

Auditor:

- invocation percentage;
- p50/p95 latency;
- cost per million generated tokens;
- malformed/timeout percentage;
- incremental FP reduction versus deterministic selector;
- incremental recall loss from vetoes.

## 13. Phase gates

### P0 - safety baseline

Exit criteria:

- explicit opt-in for destructive SPAD recovery; the veto-only auditor may run by default;
- raw exact recovery only in default profile;
- reasoning supervisor-enforced observe-only;
- code-fence recovery disabled by default;
- heuristic lanes observe-only;
- precision gym has zero destructive failures on its protected synthetic set.

### P1 - evidence/policy separation

Exit criteria:

- `SpadEvidence` is distinct from action authority;
- every evidence source has explicit provenance;
- exactly one policy function decides lane authority;
- telemetry records evidence source and policy reason;
- policy matrix is directly unit-tested;
- no SPAD-specific compiler diagnostics;
- focused SPAD suite remains green.

### P2 - exact-verifier race

Exit criteria:

- at least two deterministic verifier designs benchmarked against baseline;
- bounded verification-work counters exist;
- no regression on exact-loop recall corpus;
- no regression on protected negatives;
- winner selected from measured ns/code-unit, p99 latency, memory, and detection
  delay, not theoretical elegance alone.

### P3 - structured/approximate observation

Exit criteria per lane:

- mathematical feature contract frozen;
- counterfactual negative pairs added;
- content-class null measured;
- lane adds measurable information beyond exact evidence;
- lane remains observe-only.

### P4 - calibrated fusion

Exit criteria:

- disjoint train/calibration/holdout;
- source/session grouped split;
- prior-shift handling documented;
- protected-negative floors pre-registered;
- FP/unit budget and confidence interval pre-registered;
- one-look holdout passes without threshold retuning.

### P5 - auditor bakeoff

Exit criteria:

- deterministic selector baseline frozen first;
- multiple cheap judges compared;
- information-asymmetry ablation measured;
- post-detector calibration performed;
- auditor must improve the production-relevant risk/coverage frontier after
  latency/cost, not merely standalone judge accuracy;
- no auditor-only destructive path exists.

## 14. Open research questions that block promotion

1. Approximate-period gcd behavior under mismatches has no accepted general
   closure rule here; do not infer one from exact Fine-Wilf.
2. `P(pathology | exact run AND production gates)` is not yet measured. This is
   the key real-world quantity for promoting/refining raw exact recovery.
3. Suffix-local bounded-window streaming Hamming-period algorithms need an
   implementation-specific complexity/cost study.
4. Parameterized matching now has an initial real-OpenCode retrospective null:
   zero sustained detections across 356 fenced JS/TS regions / 2,927 lines, plus
   zero sustained three-recurrence series in the earlier 11,672-window repo null.
   This is encouraging but still too small/content-specific for promotion;
   broader real-generation traces and positive structural-loop recall remain
   required.
5. Novelty/entropy/RQA estimators need content-class-specific nulls before use.

## 15. Current evidence ledger

As of this spec revision:

- the focused baseline before Phase-1 refactoring was 48 tests / 0 failures /
  1,034 assertions across the core/frontier/gym suite;
- Phase-1 evidence/policy separation plus its policy tests passes 54 tests /
  0 failures / 1,056 assertions across four focused files;
- the repository-wide compiler still has unrelated pre-existing diagnostics,
  but filtering the repo compiler output for SPAD paths reports no SPAD-specific
  diagnostics;
- the localMCP scoped typechecker is currently unusable for certification on
  this workstation because its packaged TypeScript standard-library files are
  missing; the repo compiler is the governing check;
- the historical OpenCode DB replay covers 6,011 reconstructed logical turns,
  46,779 assistant generations, 54,523,046 assistant text/reasoning code units,
  and 58,127 tool calls; current raw/canonical/expansion text replay, sustained
  structural replay, and post-fix tool-loop replay produce zero candidates;
- the same replay produces 213 thrash candidate turns (3.5435%), so thrash is
  explicitly not eligible for destructive promotion;
- 434 historical recovery injections are present in the DB; at least 414
  (95.4%) are structurally blocked by current v2 authority rules, but historical
  truncation/censoring prevents treating the remainder as labeled ground truth;
- no claim is made yet about a live production false-intervention rate. The DB
  replay is retrospective evidence and a strong regression null, not an
  unbiased production-rate estimator.

## 16. Immediate next work

1. Freeze the 213 DB-replayed thrash candidates as a review set and manually or
   auditor-label a session-grouped sample, especially the 56 candidates that did
   not historically receive a thrash recovery.
2. Tighten thrash around explicit progress state rather than threshold tuning:
   distinguish recent mutation/result/resource deltas from long-turn cumulative
   re-access, then replay every change against the same 6,011-turn corpus.
3. Preserve the post-fix zero tool-loop replay as a protected regression and
   add query-like resource identities (SQL/search/API requests) to the fixture
   registry before considering any tool-loop authority change.
4. Benchmark the bounded exact-period proof prototype and retain explicit
   verifier-work counters before changing the raw streaming lane.
5. Expand real structural-loop positives and real generated-code negatives;
   keep parameterized/grammar evidence observe-only.
6. Run the cheap SPAD Auditor bakeoff on a frozen ambiguous-candidate sample,
   including the neutral-versus-biased information-asymmetry A/B, before using
   auditor output for anything beyond telemetry/veto research.
7. Resolve `doom_loop` versus SPAD tool-loop ownership before any tool-loop
   recovery promotion.
