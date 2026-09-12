# SPAD v2 validation checkpoint

Date: 2026-09-12

This checkpoint records the production-safety and performance validation of SPAD v2 after the precision-first redesign and runtime optimization pass.

## Production authority

The default profile permits destructive recovery only for visible-text `raw-exact-period` evidence that has passed the bounded terminal exact-period proof. Reasoning is observe-only. Canonical, expansion, tool-loop, cross-turn thrash, generation-state-cycle, information-recurrence, and persisted-motif evidence do not have default destructive authority.

## Positive gymnasium

The deep deterministic stress run used `SPAD_STRESS_SCALE=3` with the production 4,096-entry anchor table.

- Exact raw positives: 3,026 / 3,026 detected, 100% recall.
- Early detections: 0.
- Proposed-period / exact-minimal-period mismatches: 0.
- Harmonic proposal errors: 0.
- Detection delay beyond the mathematical threshold: median 0 characters, p95 3, p99 6, maximum 16.
- Cases delayed by more than one full period: 0.
- Positive chunk-invariance cases: 360, each exercised under six chunk schedules, 0 mismatches.
- Unicode/UTF-16 positive fixtures: Greek, CJK, emoji/surrogate pairs, combining marks, and Cyrillic/Japanese mixtures all detected under multiple chunk schedules.
- Low-entropy long-period positives: an additional 500 / 500 five-symbol primitive motifs passed in the development stress run, with maximum delay +8 characters. These deliberately create heavy internal q-gram recurrence and candidate pressure.
- Canonical, expansion, tool-loop, information-recurrence, and bounded state-cycle capability fixtures all produced their intended evidence when enabled/eligible.
- The historical malformed-formatting shape is now permanently represented by the exact period-10 `bold-hold-` regression fixture rather than depending on retention of the original database message.

## False-positive gymnasium

The same deep run produced zero destructive false positives across 190,342,854 negative text characters plus stateful tool workflows.

| Corpus | Cases / runs | Characters | Destructive false positives |
| --- | ---: | ---: | ---: |
| Exact threshold minus one | 3,000 | 18,606,382 | 0 |
| Protected 16-class corpus, five chunk schedules | 80 | 2,401,635 | 0 |
| Healthy templated fuzz | 6,000 | 95,699,892 | 0 |
| Quasi-periodic near misses | 3,000 | 73,634,945 | 0 |
| Healthy iterative tool workflows with legacy thrash enabled | 750 | n/a | 0 |
| Read-only repeated-inspection workflows | 360 | n/a | 0 |

Protected classes include prose, Markdown tables and nested lists, JSONL, CSV, SQL, source code, generated tests, diffs, logs, repeated legitimate sections, quoted references, code fences, structured output, explicit repetition requests, and expanding reports.

## Historical OpenCode database replay

The final replay used `C:\Users\slooshied\.local\share\opencode\opencode-main.db` and the fully optimized production engine.

- Assistant messages: 46,779.
- Assistant text/reasoning parts: 55,877.
- Visible text: 8,937,500 characters, 0 period detections in the current snapshot.
- Reasoning: 45,585,546 characters, 0 period detections in the current snapshot.
- Total assistant text/reasoning: 54,523,046 characters.
- JS/TS fenced regions: 356, 2,927 code lines, 0 structural detections.
- Logical turns: 6,011.
- Tool calls: 58,127.
- Mutating calls: 9,743.
- Tool-loop turns: 0.
- Legacy cumulative-thrash turns: 0.
- Bounded recent-state-thrash turns: 0.
- Production supervisor replay produced three non-destructive information-recurrence observations.

The earlier real `bold-hold-` degeneration is absent from the current database: its previously recorded message and part IDs both return zero rows. The behavior is therefore preserved as a permanent regression fixture.

## Anchor-table decision

The deep positive gym was repeated with 8,192 anchors.

| Metric | 4,096 anchors | 8,192 anchors |
| --- | ---: | ---: |
| Positive recall | 100% | 100% |
| p95 detection delay | +3 chars | +2 chars |
| p99 detection delay | +6 chars | +3 chars |
| Worst detection delay | +16 chars | +9 chars |
| Text hot path | 49.23 ns/char | 54.12 ns/char |
| Reasoning hot path | 20.25 ns/char | 22.16 ns/char |
| Text reset | 3.77 us | 4.79 us |
| Text construction | 58.6 us | 81.6 us |
| Cached supervisor anchor storage | 96 KiB | 192 KiB |

The 8,192-entry table improves an already small proposal-admission tail but costs roughly 10% of the per-character hot path, 27% of text reset time, 39% of text construction time, and 96 KiB more retained anchor state per cached supervisor. The production default therefore remains 4,096 entries.

The +16-character worst case was traced to direct-mapped q-gram anchor replacement. The threshold calculation and independent terminal proof remained exact. No detection fired early and no period was misidentified.

## Fresh-seed synthetic holdout

After the engine and the 4,096-anchor decision were frozen, the stress harness was rerun with a new random seed salt (`2585248995`) that had not been used for tuning.

- Normal exact positives: 3,026 / 3,026.
- Five-symbol low-entropy exact positives: 1,500 / 1,500.
- Unicode exact-positive runs: 16 / 16.
- Normal-positive detection delay: median 0, p95 +4, p99 +6, maximum +13 characters.
- Low-entropy maximum delay: +10 characters.
- Harmonic/minimal-period errors: 0.
- Chunk-invariance failures: 0 / 360.
- Negative text: 190,216,971 characters with zero destructive false positives.
- Healthy aggressive-thrash workflows: 750 with zero destructive false positives.
- Read-only repeated-inspection workflows: 360 with zero destructive false positives.
- Canonical, expansion, tool-loop, information-recurrence, and state-cycle capability checks all passed.

The negative holdout contains 13,190 scenario-level cases/runs before the fixed Unicode boundary cases. If those scenarios were independent Bernoulli trials, zero failures would correspond to an approximate one-sided 95% binomial upper bound of 0.0227% on the tested-scenario false-positive probability. This is only a descriptive bound for this synthetic holdout: the scenarios are not guaranteed to be IID or representative of production traffic, so it must not be presented as a production false-positive rate.

## Gym mutation sensitivity

The same harness was run against an intentionally degraded 64-entry anchor table to verify that the gym is capable of failing when recall is materially broken.

- Normal exact-positive recall fell to 120 / 1,026 = 11.7%.
- Low-entropy exact-positive recall fell to 55 / 500 = 11.0%.
- The harness reported 1,351 failures and exited non-zero.
- Negative false-positive checks remained quiet, demonstrating that recall and precision failures are measured independently.

This mutation run is not a candidate configuration. It is a sensitivity check on the validation system itself.

## Optional LLM auditor boundary

The SPAD auditor is enabled by default unless explicitly disabled, but remains deliberately outside deterministic recovery authority. Core contract tests pass 5 / 5 and verify that:

- rendered evidence is neutral and excludes detector labels/proposed actions;
- adversarially large excerpts are bounded;
- invalid confidence values are rejected;
- the auditor is enabled for unset/true configuration and disabled only by explicit false;
- only a high-confidence `legitimate` verdict can veto an ambiguous observation;
- a `degenerate` verdict can never create or authorize recovery.

The frozen auditor corpus SHA-256 remains `ff98725c69a81fc2df1bf72ccbe70d8cc6e899b7bf4cb31398c0043aec9d6f34`; its holdout split contains four cases. No live-model auditor classification result is claimed in this checkpoint. Model-specific quality must be measured separately because it depends on the selected external model and would consume model/API usage. This limitation does not affect the deterministic raw-exact recovery path.

## Runtime checkpoint

Representative improvements from the optimization pass:

- Full visible-text detector: approximately 59.27 to 48.6-49.2 ns/char.
- Production reasoning detector: approximately 20.2 ns/char after exact-only channel specialization.
- Character-weighted detector cost on the measured OpenCode workload: approximately 50% lower than the pre-specialization profile.
- 8,192-symbol terminal proof: approximately 3.12 to 2.42 ns/span-character after direct-ring proofing.
- Allocation-free state-cycle narration scanner: approximately 34.1 to 6.82 ns/char on prose.
- Detector reuse reduced representative short-part lifecycle cost from approximately 75.85 to 13.13 us/part in the earlier lifecycle benchmark.

## Reproducible commands

Focused CI-sized validation:

```sh
bun test test/session/spad-exact-proof.test.ts test/session/spad-frontier.test.ts test/session/spad-gym.test.ts test/session/spad-information-watch.test.ts test/session/spad-policy.test.ts test/session/spad-text-tail.test.ts test/session/spad-thrash-v2.test.ts
```

Deep production gym:

```powershell
$env:SPAD_STRESS_SCALE='3'
bun run script/spad-gym-stress.ts .tmp-spad-gym-stress-deep.json
```

Anchor-table comparison:

```sh
bun run script/bench-spad-anchor-table.ts
```

Full historical replay, with the full forensic report written to disk and concise output printed to the terminal:

```sh
bun run script/spad-db-replay.ts "C:\Users\slooshied\.local\share\opencode\opencode-main.db" .tmp-spad-db-replay-final.json
```
