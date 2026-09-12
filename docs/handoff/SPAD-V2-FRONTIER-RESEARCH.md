# SPAD v2 frontier research and architecture

Status: research / design proposal

Date: 2026-09-12

## Executive conclusion

SPAD should not be a single repetition detector with a larger collection of heuristics. The current false-positive problem comes from collapsing several fundamentally different phenomena into one intervention decision:

1. exact periodic repetition,
2. approximate/noisy periodic repetition,
3. copied or gapped restatement,
4. structural repetition with changing identifiers/values,
5. semantic/procedural stagnation across generations,
6. unsupported factual/progress claims.

These require different evidence models. The production architecture should therefore become a precision-first cascade:

`policy gates -> mathematical detectors -> calibrated fusion -> optional cheap auditor -> action`

Only mathematically high-confidence exact repetition should be able to recover without a second-stage review. Heuristic lanes should produce evidence, not directly mutate a response.

The desired operating point is intentionally asymmetric: a false recovery destroys healthy work; a missed loop wastes some tokens. Therefore SPAD should optimize destructive-intervention precision first, then improve recall subject to a measured false-positive budget.

## Current implementation diagnosis

The existing `PeriodLane` is a useful lightweight streaming primitive, but it is not a complete model of repetitions in strings:

- It proposes periods from repeated rolling q-grams.
- One anchor is retained per hash-table slot, so collisions and replacement affect candidate discovery.
- Only `maxCandidates` candidate periods are tracked.
- Confirmation uses manually selected period/coverage/exponent bands.
- Harmonic periods are independent candidates rather than being reconciled through a periodicity theorem.
- The canonical lane only lowercases ASCII and collapses whitespace.
- The expansion, cross-turn thrash, tool-loop, and persisted-motif paths are different statistical problems but historically fed the same destructive action type.

The production safety profile now correctly disables heuristic recovery by default. That should remain true while v2 is developed.

## Research findings from stringology and adjacent mathematics

### 1. Runs / maximal repetitions should be the conceptual foundation for exact repetition

A **run** is a maximal periodic substring. Bannai et al. proved that a string of length `n` has fewer than `n` runs and that the sum of their exponents is bounded linearly; their Lyndon-word characterization also yields a linear-time algorithm for computing all runs.

Why this matters for SPAD:

- Instead of treating every repeated q-gram distance as an unrelated hypothesis, an exact-loop detector can reason about maximal periodic objects.
- A run gives a principled tuple `(start, end, minimalPeriod, exponent)`.
- Maximality helps distinguish a sustained attractor from a coincidental local repeat.
- The primitive/minimal period prevents multiple harmonic representations of the same loop from inflating confidence.

Source: Bannai et al., *The Runs Theorem*, SIAM Journal on Computing, 2017. https://doi.org/10.1137/15M1011032

### 2. Fine-Wilf gives a rigorous way to collapse competing periods

The Fine-Wilf periodicity theorem states that when a string is long enough to possess periods `p` and `q`, specifically length at least `p + q - gcd(p,q)`, then `gcd(p,q)` is also a period.

SPAD use:

- If q-gram anchors suggest 96, 192, and 288 byte periods over the same long suffix, they should not be scored as three independent signals.
- Fine-Wilf can collapse compatible period hypotheses toward the primitive period.
- Incompatible periods that do not satisfy the required overlap can remain separate evidence rather than being accidentally compounded.

This should substantially simplify candidate management and make confidence mathematically interpretable.

Reference overview: Jeffrey Shallit, *Fifty Years of Fine and Wilf*. https://cs.uwaterloo.ca/~shallit/Papers/finewilf.pdf

### 3. Prefix/Z functions are inexpensive suffix-period verifiers

The KMP prefix function is online and linear. For a bounded suffix window, prefix/Z-function computations can derive borders and candidate minimal periods without probabilistic hashing.

Potential SPAD role:

- Keep the current streaming q-gram lane as a very cheap proposal mechanism.
- Before destructive recovery, run a deterministic suffix verifier over only the suspected span.
- Derive the primitive period with the prefix function and verify the exact run boundaries.

This moves hashes out of the final decision path while preserving a cheap hot path.

Reference: https://cp-algorithms.com/string/prefix-function.html

### 4. Lyndon / Booth / Duval algorithms provide canonical motif identity

Lexicographically minimal rotation gives a canonical identity for a cyclic motif regardless of phase. Booth and Duval-style algorithms do this in linear time; Duval's Lyndon factorization also underlies the modern runs theorem.

SPAD use:

- Normalize `ABCABC...`, `BCABCA...`, and `CABCAB...` to one motif key.
- Combine this with primitive-root reduction so harmonic variants do not become different learned motifs.
- If cross-session motif learning is ever reintroduced, persist canonical primitive motifs plus provenance/confidence, never raw phase-dependent slices.

Reference: https://cp-algorithms.com/string/lyndon_factorization.html

### 5. Streaming k-period algorithms formalize approximate repetition

Ergün et al. define a `k`-period `p` when the overlapping prefix and suffix differ in at most `k` positions and give streaming algorithms using poly(`k`, `log n`) space. El Ghazi and Starikovskaya extend streaming periodicity to improved Hamming-distance handling, wildcards, and edit-distance periods.

SPAD use:

- Replace fuzzy canonical repetition with an explicit error budget.
- Candidate evidence becomes `(period, compared, mismatches, mismatchRate)` rather than a vague canonical duplicate ratio.
- A bounded candidate implementation can be much simpler than the papers while preserving their central definition: count disagreements against a proposed period.
- Use Hamming first. Edit-distance periodicity is more expensive and should be evaluated offline before entering a streaming hot path.

References:

- Ergün et al., *Streaming Periodicity with Mismatches*, APPROX/RANDOM 2017. https://doi.org/10.4230/LIPIcs.APPROX-RANDOM.2017.42
- El Ghazi & Starikovskaya, *Streaming Periodicity with Mismatches, Wildcards, and Edits*, ISAAC 2025. https://doi.org/10.4230/LIPIcs.ISAAC.2025.36

### 6. Approximate runs and tandem-repeat literature gives a better fuzzy model

Stringology has explicit algorithms for maximal approximate runs and approximate tandem repeats under Hamming/edit distance. This is a better theoretical model than globally normalizing case/whitespace and then pretending the result is exact.

SPAD implication:

- Preserve exact raw evidence.
- Introduce error-tolerant repetition as its own lane with an explicit distance measure and tolerance.
- Never mix normalization loss with repetition confidence.

References:

- Amit et al., *Locating maximal approximate runs in a string*, TCS 2017. https://doi.org/10.1016/j.tcs.2017.07.021
- *Speeding up the detection of tandem repeats over the edit distance*, TCS 2014. https://doi.org/10.1016/j.tcs.2013.04.021

### 7. Alpha-gapped repeats are a strong model for expanding-copy loops

An alpha-gapped repeat is `u v u` where the gap is bounded relative to the repeated arm. There are `O(alpha n)` maximal alpha-gapped repeats and algorithms with matching asymptotic time.

This maps better onto SPAD's expanding-copy problem than the current line-anchor heuristic:

- repeated block = `u`,
- newly inserted material = `v`,
- growth loop = a sequence of strong gapped-repeat observations whose repeated arm dominates the gap.

A line-hash alphabet can make this cheap. For example, operate on normalized line IDs rather than raw characters, then score arm length, gap/arm ratio, maximality, and recurrence across cycles.

Reference: Crochemore, Kolpakov & Kucherov, *Optimal searching of gapped repeats in a word*. https://arxiv.org/abs/1509.01221

### 8. Parameterized pattern matching is directly useful for changing identifiers

Parameterized matching allows a consistent one-to-one renaming of selected symbols. It was originally motivated in part by source-code duplication, and streaming variants exist.

SPAD use:

- Treat identifiers, generated IDs, numbers, paths, and selected literals as parameter symbols.
- Preserve syntax/keywords/punctuation as constants.
- Detect repeated templates such as `read module_1 -> inspect result_1`, `read module_2 -> inspect result_2` without falsely requiring the concrete names to match.
- Unlike global canonicalization, consistent renaming retains structure and therefore gives far stronger evidence.

This is likely one of the highest-value ideas for OpenCode because agent output contains paths, identifiers, line numbers, hashes, IDs, and changing numeric values.

References:

- Baker, *A theory of parameterized pattern matching: algorithms and applications*, STOC 1993.
- Clifford et al., *Parameterized Matching in the Streaming Model*. https://arxiv.org/abs/1109.5269

### 9. Grammar-aware repetition is particularly important for code

ACL 2025 work on code generation argues that structural repetition is broader and more prevalent than literal content repetition and demonstrates a grammar-aware approach to identifying it.

SPAD use:

- Fenced code should not merely raise an exact-repeat threshold.
- Parse or cheaply tokenize code into grammar/syntax classes.
- Detect repetition over structural symbols while treating identifiers/literals separately.
- Recovery should still be conservative because repetitive code can be intentional; structural detection is evidence for an auditor, not an automatic destructive signal initially.

Reference: Dong et al., *Rethinking Repetition Problems of LLMs in Code Generation*, ACL 2025. https://aclanthology.org/2025.acl-long.48/

### 10. Order-preserving matching can detect repeated trajectory shape

Order-preserving pattern matching considers numeric sequences equivalent when their relative order is the same rather than their values being equal.

This is not a text matcher by itself, but it suggests a useful SPAD representation. Convert each sentence/line/generation into a compact feature vector such as:

- length,
- lexical-novelty count,
- number of identifiers,
- number of numeric literals,
- number of tool references,
- repeated-shingle ratio,
- progress/evidence delta,
- punctuation/Markdown depth.

Then detect recurring *shape* despite changing absolute values. This could identify "same analysis loop, slightly rewritten" without pretending two paragraphs are textually identical.

Reference: Kim et al., *Order Preserving Matching*. https://arxiv.org/abs/1302.4064

### 11. Suffix automata / longest-previous-factor / LZ give a novelty signal

Suffix automata can be built online in linear total time and support repeated-substring queries. LZ77's longest previous factor asks how much of the new suffix can be copied from earlier text. Lempel-Ziv complexity measures the rate at which new patterns appear; highly regular strings introduce fewer new phrases.

SPAD use:

- Maintain a **novelty rate**, not just a repeat count.
- A healthy long answer may reuse many words while continuing to introduce genuinely new substrings.
- A loop shows collapse in longest-previous-factor ratio / phrase novelty.
- Use novelty as a supporting feature only. Code, JSON, tables, and templates are legitimately compressible.

References:

- Suffix automaton overview: https://cp-algorithms.com/string/suffix-automaton.html
- LZ complexity as pattern-generation rate / entropy surrogate: https://pmc.ncbi.nlm.nih.gov/articles/PMC12939360/

### 12. Repeated-subsequence entropy is an interesting long-range feature

ACL 2026 work compares human and GPT text through repeated-subsequence distributions and higher-order Rényi entropy, finding systematic differences in long-range organization that surface-level fluency metrics miss.

This is not an intervention rule, but it suggests a useful offline/gym feature family:

- repeated substring counts by scale,
- entropy growth across block lengths,
- changes in that growth over the course of a generation.

Reference: Tanaka-Ishii, *Repeated Sequences Reveal Gaps between Large Language Models and Natural Language*, ACL 2026. https://aclanthology.org/2026.acl-long.379/

### 13. Recurrence quantification suggests an attractor detector rather than a motif detector

Recurrence Quantification Analysis (RQA) measures recurrence rate, deterministic diagonal structure, line lengths, trapping/laminarity, and recurrence-time statistics in dynamical systems.

The direct recurrence matrix is too expensive for SPAD's hot path, but a hashed symbolic approximation is plausible:

- map short semantic/structural states to compact IDs,
- measure repeated state transitions,
- track recurrence intervals,
- track longest repeated trajectory,
- detect a sharp transition from exploratory/high-novelty behavior to a low-dimensional recurrent state.

This is especially interesting for cross-generation agent thrash, where the failure is an attractor in `(narration, resources, actions)` rather than repeated text.

Reference overview: https://www.recurrence-plot.tk/rqa.php

### 14. Statistical calibration should replace arbitrary static thresholds

Periodicity work in other symbolic domains shows that raw autocorrelation/Fourier peaks can produce harmonic/subharmonic mistakes and that statistical significance procedures such as blockwise bootstrap can materially improve confirmatory testing.

SPAD does not need an online bootstrap per token. The lesson is architectural:

- learn empirical null distributions from healthy OpenCode traces,
- stratify by content class (prose/code/log/table/JSON/tool-heavy),
- calibrate each feature and fused score against held-out negatives,
- target a measured false-intervention rate rather than choosing intuitive thresholds.

Reference: *Statistical methods for detecting periodic fragments in DNA sequence data*, Biology Direct 2011. https://pubmed.ncbi.nlm.nih.gov/21527008/

### 15. Selective classification / conformal risk control matches SPAD's asymmetric cost

Selective classification explicitly permits abstention when confidence is insufficient. Modern selective/conformal risk-control work is designed around controlling error on the subset where a system chooses to act.

This maps almost perfectly to SPAD:

- `recover` = positive classification,
- `observe/continue` = abstain,
- false positive = expensive destructive error,
- missed loop = lower-cost abstention.

Therefore v2 should report a calibrated risk/score and optimize **precision at chosen coverage**, not ordinary balanced accuracy.

References:

- Gangrade et al., *Selective Classification via One-Sided Prediction*, AISTATS 2021. https://proceedings.mlr.press/v130/gangrade21a.html
- Tayebati et al., *CAP: Conformalized Abstention Policies...*, ACML 2025. https://proceedings.mlr.press/v304/tayebati26a.html

## What current LLM degeneration research contributes

### Repetition is a genuine autoregressive failure mode, but occurrence alone does not imply pathology

Holtzman et al. established the classic neural-text-degeneration problem: likelihood-maximizing decoding can collapse into bland/repetitive output. Welleck et al. showed standard likelihood training can over-assign probability to repetitive sequences. More recent RAP work explicitly treats reduction of repetition as a trade-off against task performance, reinforcing that "less repetition" cannot be the sole objective.

References:

- Holtzman et al., *The Curious Case of Neural Text Degeneration*. https://arxiv.org/abs/1904.09751
- Welleck et al., *Neural Text Generation with Unlikelihood Training*. https://arxiv.org/abs/1908.04319
- Huang et al., *RAP*, NAACL 2025. https://aclanthology.org/2025.naacl-long.69/

### Hidden-state degeneration signals are interesting but usually unavailable to OpenCode

Contrastive Search penalizes a candidate when its representation is excessively similar to previous context. This is a useful conceptual signal: degeneration can appear in representation space before verbatim repetition. However, OpenCode normally receives provider output streams rather than hidden states, so SPAD should not depend on this signal.

If a provider later exposes token logits/hidden-state proxies, they can become optional evidence rather than a core requirement.

Reference: Su et al., *A Contrastive Framework for Neural Text Generation*. https://arxiv.org/abs/2202.06417

### Current frontier research distinguishes tight loops from knowledge-driven doom loops

A 2026 study on Gemma 4 finds reproducible long-enumeration repetition and separately discusses "doom looping": non-convergent self-correction around missing/uncertain facts. Their intervention can reduce some literal looping but cannot supply missing knowledge.

This distinction matters enormously for SPAD:

- exact loop => string/process detector can be decisive,
- repeated self-correction around an unknown fact => semantic/progress problem, not a string-period problem.

Reference: Lazaridis et al., *Can Editing 1 Neuron Fix Repetition Loops in LLMs?* https://arxiv.org/abs/2606.13705

## Proposed SPAD v2 architecture

### Stage 0: intent and content-policy gates

Before scoring repetition:

- explicit repetition requested -> never auto-recover,
- structured/schema output -> observe unless a schema-aware detector proves invalidity,
- signed reasoning -> observe only,
- code fence -> exact text repetition may be observed, structural lane may score, but no destructive action by default,
- quoted/reference material -> strongly down-weight intervention,
- known generated bulk formats (diff, JSONL, CSV, logs, tables) -> use their own null distribution.

Do not ask an LLM to rediscover these deterministic facts.

### Stage 1: exact suffix-run proof lane

Goal: extremely high precision with low latency.

Pipeline:

1. Current streaming q-gram mechanism remains a proposal filter, or replace it with another cheap suffix candidate generator.
2. When a candidate becomes interesting, deterministic verifier materializes only the suspected suffix/window.
3. Compute primitive/minimal period via prefix/Z/run machinery.
4. Reconcile candidate periods with Fine-Wilf.
5. Extend to maximal boundaries.
6. Canonicalize primitive motif by minimal rotation for identity/telemetry.
7. Emit exact evidence:
   - period,
   - primitive period,
   - run length,
   - exponent,
   - maximal boundaries,
   - exact agreement,
   - content class.

Only this lane should initially be eligible for deterministic immediate recovery.

### Stage 2: approximate and structural evidence lanes

These do **not** recover directly.

#### A. Hamming-period lane

For a small number of proposed periods, maintain compared symbols and mismatches. Produce mismatch rate and approximate exponent.

#### B. Gapped-repeat lane

Operate primarily on line/sentence hashes. Produce arm length, gap length, arm/gap ratio, maximality, and repeated-cycle count.

#### C. Parameterized structural lane

Tokenize constants vs parameters. Candidate parameter classes:

- identifiers,
- filesystem paths,
- UUIDs/hashes,
- line numbers,
- numeric literals,
- generated call IDs,
- string literals when appropriate.

Use consistent-renaming matching, not global deletion/replacement.

#### D. Grammar lane

For fenced source code, use language-aware token classes or Tree-sitter when cheap enough. Compare grammar-rule or AST-shape sequences rather than raw code.

#### E. Novelty lane

Track longest-previous-factor ratio, distinct q-gram growth, LZ-like phrase novelty, and multi-scale repeated-subsequence statistics.

#### F. Agent-progress recurrence lane

Represent each generation/tool step as a low-dimensional state:

`{resource-set delta, mutation delta, test delta, narration signature, tool-family, error-state}`

Detect repeated trajectories / recurrence without assuming that re-reading a file is intrinsically bad.

### Stage 3: calibrated evidence fusion with abstention

Do not manually add lane scores.

Start with a deliberately simple calibrated model trained on gym traces:

- logistic regression is the first choice,
- tiny gradient-boosted trees if important nonlinear interactions remain,
- isotonic/Platt calibration or conformal/selective thresholds on frozen calibration data.

Features should be interpretable. Example:

- exact exponent / coverage,
- primitive period,
- Hamming mismatch rate,
- gapped arm/gap ratio,
- LPF / novelty ratio,
- repeated-subsequence entropy slope,
- parameterized-match coverage,
- structural recurrence length,
- generation count,
- resource re-access ratio,
- resource discovery rate,
- mutation/test/progress deltas,
- content-class flags,
- user repetition-intent flags.

The classifier has three outcomes:

1. `safe-high-confidence-degenerate`
2. `safe-high-confidence-legitimate`
3. `gray-zone`

Only (1) can recover without an LLM audit, and initially it should largely coincide with the exact proof lane.

## Proposed cheap SPAD Auditor special agent

An LLM can add value, but only as a **false-positive veto / gray-zone adjudicator**, not as SPAD's primary detector.

### Why an LLM auditor is plausible

The hard false positives are contextual:

- "this repeated table is exactly what the user requested",
- "these similar code blocks are separate required overloads",
- "the model is rechecking the same file because a mutation changed it",
- "this enumeration has a repeated template but genuinely new items",
- "this is a quote/reference corpus rather than generated degeneration".

A tiny judge can understand those distinctions better than a raw string metric.

### Why it must not be an oracle

LLM judges have documented position, superficial-quality, and self-evaluation biases. Recent hallucination work also finds confirmation bias when a verifier is shown the original generator's framing. Therefore the auditor must be structurally subordinate to deterministic evidence.

References:

- Chen et al., *Humans or LLMs as the Judge? A Study on Judgement Bias*, EMNLP 2024. https://aclanthology.org/2024.emnlp-main.474/
- Shi et al., *Judging the Judges: A Systematic Study of Position Bias in LLM-as-a-Judge*, IJCNLP/AACL 2025. https://aclanthology.org/2025.ijcnlp-long.18/
- Xu et al., *Pride and Prejudice: LLM Amplifies Self-Bias in Self-Refinement*, ACL 2024. https://aclanthology.org/2024.acl-long.826/

### Information asymmetry is essential

MARCH (ACL 2026) reports a useful design principle: its checker validates atomic propositions against evidence while being deprived of the solver's original output framing, specifically to reduce confirmation bias.

Apply the same principle to SPAD:

- Do **not** tell the auditor "SPAD thinks this is a loop."
- Do **not** include a recovery recommendation.
- Present neutral excerpts A/B/C plus objective measurements.
- Ask whether truncating at the candidate boundary would likely destroy legitimate requested content.
- Hide the upstream model identity when possible.

Reference: Li et al., *MARCH: Multi-Agent Reinforced Check for Hallucination*, ACL 2026. https://aclanthology.org/2026.acl-long.1828/

### Auditor input

Keep it small and bounded, approximately 1.5-4 KB rather than whole conversation context:

- user instruction excerpt relevant to repetition intent,
- 1-2 short pre-candidate context slices,
- repeated/structural candidate slices,
- post-candidate slice if available,
- deterministic feature vector,
- content type,
- progress events relevant to the candidate.

For a live streaming decision we usually do not have meaningful post-candidate text; that field remains optional.

### Auditor tools

None, except one terminal verdict tool.

No filesystem, grep, shell, browser, or repo read. If external evidence is required, the correct decision is `uncertain`, not tool escalation in the generation hot path.

### Verdict schema

Keep it tiny:

```ts
type SpadAuditVerdict = {
  decision: "degenerate" | "legitimate" | "uncertain"
  confidence: number // calibrated later; never trusted raw initially
  reason:
    | "exact_loop"
    | "approximate_loop"
    | "structural_loop"
    | "semantic_stagnation"
    | "intentional_repetition"
    | "structured_content"
    | "code_structure"
    | "genuine_progress"
    | "insufficient_evidence"
}
```

No free-form rationale is required in the production hot path. A short debug rationale can be allowed only behind telemetry/debug configuration.

### Model selection

Reuse the existing special-agent infrastructure and cheap-model cascade rather than inventing a provider path:

1. optional `experimental.spad_auditor_model`,
2. configured `small_model`,
3. provider's catalog-selected small model,
4. if no cheap model is available, skip audit and fail open.

The existing `SessionTitle.resolveModel()` already demonstrates a suitable `small_model -> provider small -> session model` cascade. For SPAD I would *not* fall all the way back to an expensive session model by default; failure to obtain a cheap auditor should mean `observe`.

### Runtime contract

Reuse `special-agent-completion.ts` terminal-tool semantics, but create a much smaller policy than Goal Auditor:

- temperature: 0 or minimum supported,
- max output: ~128-256 tokens,
- exactly one `spad_verdict` tool,
- no ordinary prose,
- one attempt; at most one protocol-repair retry,
- hard timeout in the low-single-digit seconds, not the shared five-minute default,
- cancel upstream immediately on terminal tool call,
- cache system prompt where provider supports prompt caching.

The Goal Auditor is intentionally deep and repo-aware; the SPAD Auditor should be the opposite: stateless, tiny, no tools, bounded context, one classification.

### Decision policy

Recommended initial policy:

```text
mathematical exact proof + production policy allows it
    -> recover immediately

strong heuristic fused score, clearly above calibrated high threshold
    -> initially observe; later may recover after gym evidence

gray-zone score
    -> cheap SPAD Auditor
       degenerate + calibrated auditor confidence -> recover
       legitimate -> continue
       uncertain / timeout / malformed / unavailable -> continue

low score
    -> continue
```

The auditor therefore can mostly **remove** false positives from an already suspicious region. It should not create destructive positives from weak deterministic evidence.

## "Bunk claims" should be a separate evidence-auditing subsystem

If by bunk claims we also mean statements such as:

- "tests pass",
- "the server restarted",
- "I changed all call sites",
- "this API supports X",
- factual claims in generated prose,

then this should not be folded into SPAD's repetition score.

### Local agent/action claims: deterministic evidence first

OpenCode already has stronger ground truth than an LLM judge for many claims. Build an evidence ledger from host events:

- `tests pass` -> test-run result ID / exit code,
- `typecheck clean` -> typecheck result,
- `file changed` -> write/edit/patch event and resulting diff,
- `commit pushed` -> git remote/ref evidence,
- `server reachable` -> actual health request,
- `tool returned X` -> tool-result event.

The LLM should never be asked whether these happened when the host can know.

### External factual claims: claim decomposition + evidence evaluation

For factuality, FActScore, SAFE, VeriScore and newer systems converge on claim-level decomposition rather than whole-answer judgment. PROBE (ACL 2026) goes further and decomposes hallucination detection into claim decomposition, evidence finding, evidence evaluation, and hallucination localization, reporting better performance when evaluated as a multi-step process.

That argues for a future **Claim Auditor** separate from SPAD:

1. deterministically/cheaply identify candidate factual claims,
2. classify whether they are host-verifiable, externally verifiable, subjective, or unverifiable,
3. attach evidence,
4. evaluate entailment/contradiction,
5. only then ask for repair if needed.

References:

- FActScore: https://aclanthology.org/2023.emnlp-main.741/
- SAFE / LongFact: https://arxiv.org/abs/2403.18802
- VeriScore: https://aclanthology.org/2024.findings-emnlp.552/
- PROBE: https://aclanthology.org/2026.findings-acl.2099/

Semantic entropy is useful for detecting a subset of confabulations, especially when multiple samples disagree in meaning, but it requires extra sampling and therefore belongs in an offline or selectively invoked factuality system, not the SPAD streaming hot path.

Reference: Farquhar et al., *Detecting hallucinations in large language models using semantic entropy*, Nature 2024. https://doi.org/10.1038/s41586-024-07421-0

## SPAD v2 gym design

The gym is the main product. No heuristic should be promoted to destructive recovery because it "looks right" on a few fixtures.

### Corpus classes

#### Healthy negatives

- ordinary technical prose,
- long implementation explanations,
- Markdown nested lists,
- Markdown tables,
- CSV / JSON / JSONL,
- SQL bulk operations,
- log streams,
- diffs and patches,
- source code in multiple languages,
- generated tests with repeated setup,
- repetitive documentation templates,
- legitimate enumerations,
- user-requested repeated output,
- quoted/reference text,
- progress reports with repeated headings,
- repeated tool reads after actual mutation,
- build/test-debug loops that make measurable progress,
- long reasoning with recurring vocabulary but changing conclusions.

#### Positive failure modes

- single-token/character attractors,
- short phrase loops,
- sentence loops,
- paragraph loops,
- phase-shifted exact loops,
- harmonic-period loops,
- noisy Hamming loops,
- insert/delete drift loops,
- expanding `A / AB / ABC` copy loops,
- alpha-gapped restatements,
- identifier-renamed structural loops,
- grammar-structural code loops,
- repeated tool/action cycles with no state delta,
- self-correction circles around an unresolved fact,
- factual enumeration collapse onto one repeated item.

### Counterfactual pair generation

For every positive, generate a nearby legitimate negative and vice versa:

- same repeated structure but values genuinely progress,
- same files revisited but a mutation occurred,
- same list template but every item is novel,
- same code skeleton but required distinct functions,
- same prose recurrence but user explicitly requested it.

These near-boundary pairs are more valuable than hundreds of easy random negatives.

### Frozen holdouts

Maintain three sets:

1. development gym,
2. frozen calibration set,
3. frozen adversarial holdout that threshold tuning cannot see.

Real false-positive incidents should enter the corpus, but not all into the development split. Some must be retained as future unseen holdouts.

### Metrics

Primary:

- destructive precision,
- destructive false positives per million generated characters/tokens,
- false-positive rate by content class,
- detection recall by failure class,
- characters/tokens wasted before detection,
- healthy-output characters destroyed by intervention.

Systems:

- CPU ns/character,
- allocations/MB generated,
- peak detector memory,
- p50/p95/p99 detection overhead,
- auditor invocation rate,
- auditor p50/p95 latency,
- auditor cost per million generated tokens/characters,
- timeout/malformed-verdict rate.

Calibration:

- precision/coverage curve,
- risk/coverage curve,
- reliability diagram for fused score,
- per-lane and per-content calibration drift.

### Promotion gate

A lane can move from `observe` to `recover` only when it clears a pre-registered precision requirement on frozen holdouts and does not regress protected negative classes.

Do not promote based on aggregate accuracy or F1. A detector can have excellent F1 and still be unacceptable if its false positives occur on long valuable coding responses.

## Recommended implementation phases

### Phase 0 - safety baseline

Already in progress/current worktree:

- SPAD requires explicit `experimental.spad_recovery: true`.
- only exact raw text recovery is enabled in the production config profile,
- code-fence exact recovery is disabled,
- canonical/expansion/persisted/tool/thrash recovery are disabled by default,
- reasoning is observe-only,
- new precision gym establishes a zero-destructive-FP baseline over current synthetic/adversarial cases.

Keep this baseline until v2 beats it.

### Phase 1 - evidence model + telemetry

Create a `SpadEvidence` object independent of `SpadAction`.

Every lane reports evidence; one policy layer decides actions. This prevents another lane from accidentally acquiring destructive authority merely by returning a `PeriodDetection`.

Record content class, lane, raw features, fused score, decision path, and eventual intervention result.

### Phase 2 - exact mathematical verifier

Implement and race prototypes for:

- prefix/Z suffix verifier,
- run/minimal-period verifier,
- Fine-Wilf candidate collapse,
- primitive-root + minimal-rotation motif identity.

The current q-gram proposal path may remain if it is fastest.

### Phase 3 - structured/approximate lanes

Prototype separately and measure marginal value:

- Hamming-period candidate tracker,
- line-level gapped repeats,
- parameterized matching,
- grammar-token structural repetition,
- LPF/LZ novelty,
- recurrence/progress trajectory features.

Do not merge a lane that does not improve the precision/coverage frontier.

### Phase 4 - calibrated fusion

Train the smallest model that works. Begin with logistic regression, not a neural classifier. Freeze and version calibration coefficients with the gym dataset revision.

### Phase 5 - SPAD Auditor

Add the no-tools, small-model, fail-open special agent only for the gray zone. Benchmark it against:

- deterministic fusion alone,
- a tiny local classifier,
- several cheap models,
- auditor with/without information asymmetry,
- auditor with/without detector feature labels.

The acceptance criterion is **fewer destructive false positives at useful coverage**, not impressive standalone judge accuracy.

### Phase 6 - claim/evidence auditor (separate project)

Build host-attested claim verification first. Add external fact verification only when requested/needed; do not make every coding token pay for general factuality auditing.

## Concrete architecture sketch

```text
provider stream
    |
    v
[content + intent classifier]  -- deterministic
    |
    +--> exact proposal ----------> exact verifier ----> exact proof
    |
    +--> hamming-period evidence
    +--> gapped-repeat evidence
    +--> parameterized evidence
    +--> grammar evidence
    +--> novelty / LPF evidence
    +--> progress recurrence evidence
                     |
                     v
             [SpadEvidenceVector]
                     |
                     v
             [calibrated selector]
               /      |       \
       legitimate   gray     degenerate-proof
           |          |             |
        continue      v          recover
                [SPAD Auditor]
                /    |      \
          legitimate ?    degenerate
              |       |        |
           continue continue  recover
```

Default failure behavior at every uncertain edge is `continue + telemetry`, never destructive recovery.

## Highest-value experiments to run next

1. **Exact verifier race**: current `PeriodLane` vs q-gram proposal + deterministic prefix/Z verification vs bounded-window runs implementation. Measure ns/char, detection delay, and exact-loop recall.
2. **Fine-Wilf ablation**: count how often current candidate streams contain harmonic periods and whether collapse reduces candidate churn.
3. **Parameterized matching prototype**: transform real OpenCode narration/tool traces into constant/parameter token streams and measure separation of legitimate progress vs renamed loops.
4. **Gapped-repeat prototype**: replace the expansion lane on the existing expansion corpus and add legitimate repeated-ledger/report negatives.
5. **Novelty features**: compute LPF/LZ-style novelty over known healthy and degenerate sessions and inspect distributions before deciding whether they deserve hot-path state.
6. **Auditor bakeoff**: label several hundred genuinely ambiguous candidates and compare cheap LLM auditor, logistic model, and deterministic fusion. The LLM only wins a production slot if its incremental FP reduction justifies latency/cost.
7. **Information-asymmetry ablation**: compare an auditor told "SPAD detected a loop" against a neutral auditor given only excerpts/features. Expect the neutral setup to be less confirmation-biased; measure rather than assume.

## Bottom line

The strongest redesign is not "SPAD plus an LLM judge." It is:

**formal string evidence + structural representations + empirical calibration + abstention, with a tiny independent LLM auditor only at the ambiguity boundary.**

That preserves the speed and determinism that made SPAD attractive while adding contextual judgment exactly where classical algorithms stop being authoritative.
