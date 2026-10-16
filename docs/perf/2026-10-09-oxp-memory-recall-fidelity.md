# OpenFork Memory retrieval fidelity — 2026-10-09

## Objective

Deliver low-latency historical recall that returns relevant, independently sourced, faithfully scoped evidence. Retrieval quality means exact provenance, current-versus-superseded separation, missing-data honesty, low false-positive context, and bounded runtime—not merely producing five results.

This follows the earlier bootstrap performance incident report at `docs/perf/2026-10-09-oxp-memory-latency.md` and adheres to `AGENTS.md`/tool-surface parity.

## Root-cause audit

1. Core `Memory.search({ includeHistory: true })` still restricted the FTS candidate pool to active entries before result filtering, making superseded/quarantined history structurally unreachable. Eligibility is now active/superseded/quarantined only when history is requested; tombstoned (forgotten) facts remain excluded.
2. Kind filtering happened after a 4x-limit FTS candidate pool. Rare decisions could disappear behind common references despite matching the query. Eligibility now occurs before FTS ranking. Empty kind filters return empty immediately.
3. Saved-memory searches passed long conversational queries to up-to-twelve-token AND-style FTS matching without simplification; many useful entries could never satisfy every token. The shared Exchange planner now gives saved-memory the same bounded focused query plus one labeled fallback on miss.
4. Historical Session fallback could become a ubiquitous single word such as `memory` and return largely irrelevant transcripts. Code/brand identifiers may still stand alone; natural-language fallback preserves two discriminative terms or declines relaxation. The result discloses its actual query and whether it was broadened.
5. Multiple messages from a single long session could consume all historical evidence slots. The session adapter oversamples up to 20 authorized ranked candidates and prioritizes unique Session sources; additional slots retain original ranking order. Duplicate title-only hits are omitted where direct message evidence already covers that session.
6. Projection-level index coverage remains explicitly surfaced, now including V1-part and V2-message readiness when known. The index is not completed by a read request and no full-history hydration or background writer is started from the recall path.

## Executed evidence

- Core Memory tests: **27 passed, 0 failed**, including historical-status retrieval, privacy-safe forgotten exclusion, cross-project boundaries and rare-kind FTS eligibility.
- Exchange Memory tests: **20 passed, 0 failed**, including saved fallback honesty, generic fallback avoidance, code identifier precision, diverse Session ranking, real indexed multi-session fixture and authorization boundaries.
- Indexed two-result fixture: naive recency takes two messages from one Session (1 distinct source); bounded diversity returns evidence from two independent Sessions (2 distinct sources) without exceeding the result budget.
- Fifty-run local benchmark on developer database after these changes: map p50 2.90 ms/p95 7.48 ms; saved-only p50 2.32 ms/p95 3.74 ms; combined p50 6.19 ms/p95 27.18 ms. Combined worst 415.2 ms; map worst 1387.68 ms, with ChunkDB maintenance observed. Different sampling windows prohibit claiming controlled performance causality.
- Full package type checks are not green from existing unrelated diagnostics. These focused suites do pass. The live OXP host has not been rolled or reloaded; externally observed 59–80s outliers and result fidelity remain unverified on the new bundle.

## Source map

- `packages/core/src/memory/index.ts` — scoped pre-FTS status/kind eligibility.
- `packages/opencode/src/exchange/memory-query.ts` — bounded query planner.
- `packages/opencode/src/exchange/memory.ts` — transparent saved query fallback and fidelity metadata.
- `packages/opencode/src/exchange/memory-session.ts` — evidence diversity and detailed index readiness.
- `packages/core/test/memory/memory.test.ts` — history, kind and privacy regressions.
- `packages/opencode/test/exchange/memory-recall.test.ts` and `memory-session.test.ts` — planner and indexed integration fixtures.

## Historical-index completeness investigation

A separate 10-run read-only diagnostic queried the actual developer DB through
the lightweight Exchange reader. It reported **all five historical readiness
flags false**: V1 part FTS, V2 message FTS, current V2 tool projection, V1
exact tool recall, and V2 exact tool recall. This is a completeness *gate*
failure, not evidence that all indexed records are absent. The default
Session Core code intentionally keeps whole-history backfill opt-in because
unbounded writers contend with live interactive SQLite traffic.

The existing `SessionSearch.repairOnOwnConnection` method already implements
a **bounded transactional repair** with resumable rowid cursors, a dedicated
connection and a short deadline. The new
`packages/opencode/script/repair-memory-session-index.ts` provides an
explicit operator-only entry point instead of inventing a second indexer:

```sh
bun run script/repair-memory-session-index.ts --db "<existing absolute DB path>" --rows 32 --timeout-ms 2000
```

One invocation touches **at most 32 rows per underlying store** with an
approximately 2-second bounded attempt, and reports per-store progress and
completion. Acceptable `--rows` range is 1–128; deadline 100–5000 ms.
Re-running is resumable. Do not run this automatically from memory reads,
agent prompts, login, workspace open, or process startup. **No repair was
executed against the live database as part of this task**.

## Outstanding acceptance gates

### Continuation: rank-fusion and real SQL retrieval fixtures

The next pass added `packages/opencode/test/exchange/memory-fidelity.test.ts`,
a throwaway in-memory SQLite integration fixture that calls the real Core
Memory and SessionSearch query implementations through the Exchange adapters.
It checks explicitly identified relevant versus distractor facts, exact
provenance, forbidden project/session scope, forgotten exclusion, and
superseded-history visibility. On its deliberately narrow positive ArcFit and
Nacre queries, expected Recall@5 is **1** with no forbidden rows; this is
**not a representative production evaluation** or an estimate of model-level
semantic reasoning accuracy. Additional public/consented ground-truth data
remain necessary.

Three further ranking faults were identified and corrected:

- `ExchangeMemoryQuery.plan` classified ubiquitous product/runtime names
  such as `OpenFork` and `OpenCode` as a rare PascalCase identifier, allowing
  a detailed search to broaden to a generic product name. The fallback planner
  now treats those names as common anchors while still preserving rare
  code/brand identifiers.
- Core Memory scored only the first eight recorded anchors although records
  index up to 32. It now scores on all bounded anchors, deduplicates
  normalized tokens across anchor kinds, and projects only eight anchors into
  the compact result. A regression places the decisive identifier beyond the
  original display cutoff.
- Core `SessionSearch.mergeMatches` concatenated **all V2 results before all
  V1 part results** in relevance mode, irrespective of per-index relevance.
  It now uses reciprocal rank fusion (RRF, k=60) over the two independently
  BM25-ranked sequences, with one vote per message per index. Duplicate
  matches across independent V1/V2 indexes gain agreement, but multiple
  V1 parts from the **same message** cannot inflate that vote. `recent`
  remains strictly timestamp-ordered. In a synthetic top-three ranking with
  three V2 and two V1 candidates, the relevant V1 result previously had
  zero top-three recall; it now appears alongside V2 evidence. The result
  is a source-coverage regression gate, not an empirical SOTA claim.
- Core Session title fallback treated user-entered `%` and `_` as SQLite
  `LIKE` wildcards, which can cause a query for `%` to report unrelated
  titles as matches. `LIKE ... ESCAPE '!'` now treats user input literally
  while preserving native SQLite ASCII-case-insensitive matching; the
  explicit fixture covers percent signs, underscores, and the escape
  character. This narrows false positives without bypassing session scoping.
- Core Session search previously passed negative `limit` values through to
  SQLite, where `LIMIT -1` means **unbounded**, potentially turning a cheap
  scoped search into an unexpectedly large response. The Core entry point
  now normalizes all finite caller limits to **1..100**, and falls back to
  the documented default for non-finite values; regression tests cover
  negative and zero limits. External adapters continue to impose their
  narrower per-capability caps.

RRF follows Cormack, Clarke & Buettcher, *Reciprocal rank fusion outperforms
Condorcet and individual rank learning methods* (SIGIR 2009),
https://doi.org/10.1145/1571941.1572114 .
FTS5's raw BM25 values are corpus-dependent, so direct numeric V1/V2 score
comparison would be invalid; see https://www.sqlite.org/fts5.html .

The latest focused run passed **65 Core** memory/session-search tests and
**22 Exchange** memory tests, zero failures. Further typechecking and live
OXP rollout remain independent acceptance gates.

### Latest warm-path data and limitations

An additional 50-sample local benchmark after the anchor/rank-fusion changes
measured memory-map p50 **3.53 ms**, p95 **68.35 ms** (worst **1678.49 ms**,
with maintenance present); saved-only p50 **2.73 ms**, p95 **3.66 ms**;
combined p50 **6.87 ms**, p95 **14.37 ms**. This is a different run with
different system load and incomplete historical indexes; no causal throughput
gain or production p99 assurance should be inferred. All five index readiness
flags on the developer DB remained false.

1. Build a permission-safe, consented benchmark with expected memory/session IDs, similar decoys, old-versus-new decisions, scope denials and intentionally incomplete indexes. Measure Recall@5, Precision@5, unique-session coverage, provenance accuracy and p50/p95/p99 time.
2. On a rebuilt running host, compare OXP caller wall-clock latency against `metadata.timingMs` to isolate queues/transports from SQLite and runtime. Do not restart or displace current active sessions without a controlled rollout.
3. Complete historical FTS backfill through explicit maintenance ownership and progress checkpoints; the read path must never trigger index repair. An incomplete index is missing evidence, not proof that no session existed.
4. Preserve the source-diversity/performance Pareto curve: increasing candidate oversample may help diversity but should be A/B measured on realistic sparse/dense corpora. Do not claim superiority without representative retrieval ground truth.

SQLite FTS5 behavior (prefix expressions, implicit conjunction, BM25) is documented at https://www.sqlite.org/fts5.html .

## Continuation: date-fallback failure and exact-anchor candidate recall

An actual (pre-rollout) OXP memory request about the dated OpenFork memory
fidelity handoff broadened to the **single numerical term `2026`** and returned
five timestamped session-title agent records unrelated to the question.
This is not evidence that the requested research is absent: the connector
still has an old running bundle and the Session search indexes are incomplete.

The Exchange query planner has now been patched to:

- Avoid treating year-only/date components or generic `V1`/`V2` labels as
  high-information identifiers eligible for single-token relaxation.
- Prefer content-bearing words when four focused FTS terms are chosen;
  preserve date/numeric terms in short, explicitly constrained searches.
- Keep the last eight distinct query terms alongside the first sixteen in
  long prompts, reserving a focused slot for a real code identifier appearing
  at the end of the question. CamelCase symbols, mixed alphanumeric source
  names, and uppercase acronyms (for example `RRF`) retain exact fallback.
- Require two discriminative nonnumeric content terms for a prose relaxation.

In an in-memory SQLite fixture containing a true rank-fusion decision, an
unrelated `2026` title-agent record, and a forbidden-scope decoy, the
new plan's saved-memory and Session searches recover the true target without
reporting either decoy. Synthetic tests cover explicit year-only searches,
dated complex questions, long preambles, and original `ArcFit` semantics.

Separately, Core's former exact-anchor boost ran **only after the BM25
top-`4 * limit` FTS cutoff**. An exact symbol could be missing from that
candidate set and therefore could never receive its advertised boost. The
new code combines two independently bounded, read-only candidate lanes:

1. The original scope/status/kind-filtered FTS BM25 top-N.
2. A secondary lane starting from the `memory_anchor.normalized` index
   for high-information anchors, then checking the **same FTS expression and
   same visibility/eligibility predicates** before merging by FTS rowid.

The same FTS requirement explicitly prevents this mechanism from becoming
an OR-style weak-anchor search. A test stores **24 repeated-term distractors**
with higher raw BM25, proves the correct row is absent from the initial four
FTS candidates, and asserts that the augmented search retrieves that exact
record at rank 1. Normal invalid/negative limit handling was also hardened.

### Throughput/fidelity tradeoff

The first general-purpose version ran a second indexed query even on common
phrases, regressing the generic saved-only 50-sample median from a prior
**2.73 ms** sample to **4.63 ms** (different run/load; *not* a causal proof).
The final lane selection now skips ubiquitous memory/runtime terms and runs
only for high-information names, uncommon long anchors, or mixed source
identifiers. The subsequent 50-sample local developer-DB run measured:

| Read mode | p50 | p95 | Highest observed |
| --- | ---: | ---: | ---: |
| Memory map | 3.05 ms | 15.27 ms | 1780.52 ms |
| Saved-only (`memory latency`) | 3.39 ms | 5.89 ms | 344.48 ms |
| Combined (`memory latency`) | 8.21 ms | 17.62 ms | 35.82 ms |

ChunkDB background maintenance and unrelated workload remain confounders.
The dev database still reports all five historical Session index-readiness
flags false, so broad historical coverage remains uncertified. Neither
historical repair nor live sidecar restart was attempted. More representative
query-level Recall@5 / Precision@5 and repeatable controlled A/B benchmarks
are required before product-level dominance or p99 claims.

### Verification checkpoint

The final source state retains **29/29 Core Memory** regressions,
**37/37 Core Session-search** regressions (last run before the latest
memory-only changes), and **25/25 Exchange Memory** regressions, all passing.
The combined set is 91 distinct focused test cases, and the targeted
`git diff --check` exited successfully. The new code did not alter existing
authority or action schemas. Core package-wide typecheck still reports
unrelated errors in `script/everything-bench`, `test/search-everything`
and `test/session-attachment`. A source-level test is not proof that a
running OXP host loaded the new bundle.

## Follow-up: bounded repair, explicit completeness, precision-preserving relaxation

Core `test/session-search-repair.test.ts` now exercises the actual durable
historical index path, not mocked rank or cursor results:

- A hermetic in-memory DB with unindexed V1 parts and V2 messages demonstrates
  that ordinary SessionRecall never writes or repairs its indexes. Repeated
  `SessionSearch.repairChunk(db, { maxRows: 1 })` calls move forward by at most
  one row per physical store per pass. All five index readiness flags
  eventually reach true, previously missing V1/V2 conversations become
  searchable, unauthorized directories remain excluded, and a subsequent
  repair pass is an idempotent no-op.
- A separate temporary **file-backed** SQLite fixture leaves its primary
  reader alive while `SessionSearch.repairOnOwnConnection` runs on the same
  file. The first one-row pass does not prematurely report the V2 cursor done;
  the next pass establishes completion and the still-live reader recovers
  the formerly unindexed message. The temporary fixture is deleted afterward.
  **No user/production database was repaired**.
- A legacy cursor adversary sets the old V2 content index and V1 part cursor
  to done but leaves the current V2 extractor's versioned projection undone.
  `SessionRecall.recall.coverage.complete` must remain false. Fixed in the
  shared Core domain because the current extractor adds structural tool-name
  markers that historical pure-text searches may otherwise miss.

The Exchange planner's single-token relaxation was also tightened. Short
recognizable project names and acronyms retain one topical qualifier if
present (`ArcFit geometry`, `RRF fidelity`, `SVG corner`), rather than
falling back to the broad brand alone. Truly long exact code symbols remain
eligible as standalone fallbacks. A new real-SQL adversarial fixture stores
**seven ArcFit pricing memories and no geometry fact**: the naive `arcfit`
query returns five out-of-topic top-five hits; `arcfit geometry` returns
none. That is a 5-to-0 false-positive change **on this single constructed
negative case**, not a representative Precision@5 measurement.

The synthetic evaluator's previous field `precisionAt5` used
`relevant / returned` instead of the strict fixed-k denominator. This was
incorrectly named: a single returned relevant hit would misleadingly score
`Precision@5 = 1`. It now computes `Precision@5 = relevant top-5 / 5`
and reports a separate `precisionReturned = relevant / returned` for
interpretability. Thus, the one-relevant-hit positive fixtures report
**Precision@5 = 0.2**, **precisionReturned = 1**, **Recall@5 = 1**.
Zero-hit negative queries report zero false positives; they do not score
perfect Precision@5 by convention. Test metrics are diagnostic, not
representative estimates.

This protects two independent quality dimensions—historical coverage honesty
and false-positive restraint—without adding read-time backfill or a secondary
search service. Still required: consented multi-project ground-truth queries,
real-world precision/recall under a fully repaired index, latency A/B with
background ChunkDB load controlled, and an operator-controlled OXP rollout.

Final targeted run for this pass: **69 Core tests + 26 Exchange tests = 95
passing**, zero failing (the change to the metric definition was also
retested independently). The full Core package typecheck continues to be
blocked by pre-existing unrelated errors in the benchmark/search/attachment
test sources; this does not certify the whole package build. The active
production/desktop host was not restarted and no live historical backfill
was initiated.

### CLI integration acceptance

`packages/opencode/test/exchange/memory-repair-script.test.ts` now invokes
the **actual repair script in a child Bun process**. The negative test verifies
exit code 2 for omitted DB, relative DB and an illegal negative row budget.
The positive test constructs a disposable file-backed database with an old,
unindexed V2 message, keeps a primary connection open, and executes two
`--rows 1 --timeout-ms 3000` CLI passes:

- First pass: exit 0, `processed = 1`, `done = false`, `complete = false`.
- Second pass: exit 0, `complete = true`.
- Subsequent live-reader query: exact missing message recovered, unrelated
  directory scope still denied.

**2 CLI tests / 14 assertions passed**. This validates CLI parsing,
connection isolation, bounded progress signaling and cold historical
recovery without touching real user data. With these additional tests, the
focused evidence suite contains **97 passing cases** across Core and
Exchange. No automatic index backfill, live sidecar restart or active
database writes were performed.

### Final measured state (local developer DB, not live OXP)

The last 50-sample host-side run occurred with other parallel test and
typecheck processes active. Its results are intentionally retained even
though they are not flattering:

| Operation | p50 | p95 | Worst |
| --- | ---: | ---: | ---: |
| Map read | 4.45 ms | 18.19 ms | 1733.88 ms |
| Saved-memory only | 3.86 ms | 7.52 ms | 8.47 ms |
| Saved+historical | 11.17 ms | 149.30 ms | 2111.71 ms |
| 10 concurrent combined requests (five batches) | 79.66 ms/batch | 118.76 ms/batch | 118.76 ms/batch |

Cold map measured 963.73 ms. All five historical-index readiness flags
remained false, and the benchmark query had no matching distinct sessions.
The 2.1-second combined-search outlier shows that the latency-tail problem
remains open under machine contention; this run cannot establish a
regression from code changes or latency dominance. Repeat under isolated
loads and after a controlled full-index maintenance before acceptance.

The final combined rerun finished with **69 Core / 28 Exchange = 97 focused
tests passed**, zero failed; targeted `git diff --check` passed. Both
package-wide `tsgo --noEmit` runs exited 2 on already-present, unrelated
diagnostics: Core `script/everything-bench`, `test/search-everything`,
`test/session-attachment`; host `script/smoke-acp-sqlite-worker`,
debug support bundle, session HTTP handlers, and unrelated compatibility/
swarm/server test files. No diagnostic was reported in the changed
Memory/SessionRecall/query-planner/repair test paths. This is a *targeted*
verification result, not a green whole-repository typecheck.

## Further fidelity continuation: middle-symbol rescue and safe coverage diagnostics

The four-token Exchange query planner previously retained sixteen initial
and eight final lexical tokens from a long question, potentially omitting
the most distinctive **middle** identifier. A primary query matching
introductory noise could prevent fallback altogether, silently replacing
relevant project history with unrelated memories. The revised query planner:

- Binds lexical inspection to 8 KiB of input (prefix + suffix) and 512 tokens
  so enormous user queries cannot cause an unbounded planning scan.
- Discovers recognizable CamelCase, acronym and code identifiers across the
  inspected body **before** choosing the fixed-size FTS query.
- Places an otherwise discarded middle identifier in the focused query and
  selects a nearby distinctive qualifier for a safe two-term fallback;
  existing short-query and trailing-symbol behavior remains tested.

An in-memory SQLite adversary contains **seven decoy memories** matching
the first four preamble words, a correct `ArcFit geometry` decision in the
middle, and a deliberately forbidden project's `ArcFit geometry` record.
The old-style four-word lookup returns five decoys (**Recall@5 = 0**);
the revised Exchange recall returns the one authorized fact
(**Recall@5 = 1, Precision@5 = 0.2, precisionReturned = 1**).
Scope leakage is zero in both cases. These are synthetic fixture results,
not evidence of population-level retrieval superiority.

The explicitly operator-invoked
`packages/opencode/script/inspect-memory-session-index.ts` provides a
**read-only status check** before a maintenance window:

```sh
bun run script/inspect-memory-session-index.ts --db "<existing absolute DB path>"
```

It opens SQLite with `readonly: true`, `create: false` and
`PRAGMA query_only=ON`, reads only schema names, cursor state and
`MAX(rowid)` for the two canonical source stores, and emits five named
ready/incomplete/missing-cursor/missing-schema statuses. It does **not**
replay historical messages, scan or print message contents, attempt database
migrations, trigger backfill, or infer progress percentages from sparse
rowid ranges. A completed empty store may legitimately retain watermark
`-1`; the authoritative condition is its explicit `done` flag.

The disposable-file CLI integration test now checks inspector output
before and after the existing bounded repair executable, verifies all
five ready states, rejects relative/missing inputs, and confirms the
result contains no original file path. The positive test's timeout was
increased to accommodate several real child-process startups on Windows;
the repair's own time budget remains independently capped by the operator.
No active user database was opened with a write-capable inspection handle.

### Uppercase imperative regression

An additional code-aware query-planning adversary uses genuine all-caps
agent instructions, such as `PROCEED EXHAUSTIVELY AND COMPREHENSIVELY`,
followed by `ArcFit geometry` or `RRF fusion`. The previous identifier
heuristic treated the first all-caps prose token as a unique source acronym,
allowing a generic instruction to suppress the real topic. Query planning
now filters known conversational imperatives, prefers structural CamelCase
and mixed-digit/underscore symbols, and recognizes capitals-only acronyms
only at lengths 3–5. The regression confirms that the qualified technical
topic survives, while existing simple identifier queries remain supported.

This reduces a handoff-specific retrieval failure, but the bounded lexical
planner is still **not** a semantic entailment engine; a proper ground-truth
evaluation must distinguish content recall from superficial keyword matches.

### Latest source-suite and isolated warm-read measurements

After the middle-identifier, uppercase-handoff and inspector changes, the
focused suites passed **69/69 Core** and **31/31 Exchange** tests (100 total),
with zero failures. They include the disposable-file CLI replay and all
existing saved-memory status/security tests. `git diff --check` passed.
Host-wide `tsgo --noEmit` remains exit code 2, with pre-existing errors
in the support-bundle CLI, session HTTP handlers and unrelated compatibility
tests; it reported no errors in the new planner/inspector/test files.

After other test/typecheck processes completed, a separate 50-sample local
developer-DB benchmark measured:

| Read mode | p50 | p95 | Maximum observed |
| --- | ---: | ---: | ---: |
| Map | 2.45 ms | 6.33 ms | 1178.34 ms |
| Saved only | 2.01 ms | 3.53 ms | 292.77 ms |
| Saved+Sessions | 5.35 ms | 7.47 ms | 24.11 ms |
| Concurrent batches of 10 (5 batches) | 55.06 ms/batch | 61.46 ms/batch | 61.46 ms/batch |

Cold map was 390.36 ms. These figures contrast with the older contended
measurement but are **not** paired A/B observations under controlled
machine load and must not be advertised as causal speedups. The five
historical Session index readiness flags remain false on this database;
the benchmark query's unique Session result count is zero. Live-host
bundle parity, fully indexed recall quality and adverse-load tail latency
still need controlled validation. No real historical index repair or host
restart was performed.
