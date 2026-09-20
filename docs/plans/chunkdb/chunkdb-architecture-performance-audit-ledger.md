# ChunkDB Architecture + Performance Audit Ledger

**Date:** 2026-09-18
**Status:** closed / converged on 2026-09-18; future work requires new evidence
**Scope:** current `packages/core/src/database/*` ChunkDB implementation, its read projections in `packages/core/src/event.ts`, and storage benches.

## 1. Governing invariants

- Work from authoritative durable producer -> representation -> ownership/lifetime -> maintenance mutation -> read projection.
- Foreground SQLite work owns priority. Read-before-write foreground transactions reserve the writer with `BEGIN IMMEDIATE`; maintenance keeps its dedicated connection, short busy timeout, bounded idempotent retry/yield, and small write slices.
- Preserve exact logical replay, ordering/idempotency, crash consistency, bounded allocation/decompression, fail-closed unknown/corrupt representations, and representation-epoch compatibility.
- No foreground compression work unless measured effectively free. No optimization is accepted from a synthetic throughput number alone.
- Evidence labels in this ledger are **population**, **mechanism**, or **hypothesis**. Old architecture documents are research history, not current truth.

## 2. Current architecture reconstructed from code

### Write and ownership topology

- Foreground `Database.Service.db`: WAL, `synchronous=NORMAL`, 5 s busy timeout, 64 MiB SQLite cache.
- Foreground `readDb`: separate query-only native handle for file-backed DBs, 250 ms busy timeout, 32 MiB cache. This prevents interactive/history reads from queueing behind the primary client's single permit.
- Maintenance: `withBackfillDb()` owns a separate WAL connection with 100 ms busy timeout. `runPassV2()` performs candidate discovery/compression outside transactions, then commits <=8-row / <=512 KiB write slices with `{ behavior: "immediate" }`, 35 ms busy retry, yield, and 15 ms inter-slice pause.
- One process-local sealer owner plus cross-process `Flock` prevents duplicate maintenance loops. Periodic WAL checkpointing is PASSIVE and separately elected.

### Durable representations

- Hot ordinary event writes remain JSON TEXT. Candidate rows are old enough or outside the 256-event hot tail, >=4 KiB, and not already journaled. Jumbo foreground values are now a separate content-addressed staged representation: 256-KiB text chunks are committed cooperatively before the tiny semantic event reference, with explicit refcounted lifecycle metadata and age-gated orphan cleanup.
- `ocdb_seal` is a bounded audit/decision journal; old rows are pruned after 30 days.
- `event_value` is aggregate-scoped exact-content storage keyed by `(aggregate_id, sha256)` and referenced by small `{ "$cdbRef": value_id }` event/projection values.
- Representation epochs currently reach `user_version=5` and include v3 CRC-over-compressed frames, v4 1 MiB segmented jumbo frames, and historical v5 `delta_ref` values plus explicit dependency edges. Current source has retired new v5 emission; reader/integrity/GC compatibility remains mandatory.
- Semantic pruning materializes compact semantic identity tables, proves supersession against current projections, rewrites/deletes cold redundant history, and garbage-collects unreachable `event_value` rows through the v5 dependency closure.
- New ChunkDB files use 8 KiB pages and `auto_vacuum=INCREMENTAL`; maintenance performs bounded incremental reclaim, with an explicit drain mode for large freelists. Optional startup compact/rebuild uses file-swap machinery.

### Read projection

- `$cdbRef` reads consult the decoded-object cache before storage and batch `event_value` lookup only for misses; decode/CRC/SHA remains fail-closed. Parsed objects are memoized in a per-database refs-weighted 64 MiB / 1024-entry cache.
- v4 jumbo frames can decode segment-by-segment with scheduler yields when workers are off.
- Optional decompression workers clone compressed input to workers, transfer raw output back, and serialize large `JSON.parse` operations to one per event-loop turn. Retained input+raw completion bytes are bounded to 64 MiB.
- v5 reads remain historical-compatibility code. Ordinary event batch hydration now parses loaded v5 children first, preloads missing bases in one aggregate-scoped query, rejects nested-v5 bases, memoizes decoded base bytes per replay page, applies the correction, and SHA-checks the reconstructed value.

## 3. Documentation drift / obsolete assumptions

1. `architecture/PLAN.md` describes an OSES segment/index design with packed IDs and one shared frame per segment. The production code is instead a per-row OCDB + aggregate `event_value` system with semantic pruning, projection collapse, v4 segmentation, v5 deltas, and physical reclaim. Treat the PLAN as lineage, not implementation documentation.
2. Old docs describe brotli-q1 / zstd-l1 as defaults. The audited ordinary-value frontier is now narrower: <=64 KiB uses Brotli-11 once; >64 KiB ordinary values compare zstd-19 and zstd-9; rare v4 jumbo segments retain the full zstd 19/15/9/1 byte-minimizing race. `chooseCodec()` remains the single-candidate ratio hint for delta correction streams.
3. Old benches in `packages/opencode/bench/chunkdb-*` still model epoch-1 per-row framing and old cooling assumptions. They remain useful historical mechanism probes but are not sufficient evidence for the current semantic/dedup/delta/reclaim system.
4. The old shared-window result remains important: independent row frames structurally discard cross-event LZ redundancy. The current system recovers exact duplicates and superseded snapshots, but it still frames the residual non-deduped rows independently.

## 4. Measurements captured in this audit

### M1 — current synthetic end-to-end harness (**mechanism evidence**)

Command: `bun run test/bench-chunkdb.ts` on the current workstation/runtime.

| Metric | Result |
|---|---:|
| baseline SQLite size | 57.6 MB |
| ChunkDB SQLite size | 34.9 MB |
| physical reduction | 1.65x |
| synthetic dedup collapse | 29.3% (2000 events -> 1415 values) |
| promotion | 13.943 s / 2000 rows = 143 rows/s |
| rehydration p99 reported by harness | 1477 us |
| byte/logical parity | pass |
| post-checkpoint WAL | 0 MB |
| freelist | 0 pages |

This is not population evidence: the corpus is deliberately synthetic and unusually compressible.

### M2 — codec and worker race (**mechanism evidence**)

Current harness, median-3 mixed synthetic 8/32/128 KiB:

| Codec | encode | decode | ratio |
|---|---:|---:|---:|
| zstd-1 | 100 MB/s | 435 MB/s | 87.82x |
| zstd-3 | 80 MB/s | 580 MB/s | 87.68x |
| brotli-1 | 502 MB/s | 583 MB/s | 85.19x |

Worker result on 200 x 32 KiB: compression 1.21x faster, but decompression pool was ~1 MB/s versus ~603 MB/s synchronous on this small-payload workload. This strongly validates the existing 64 KiB read-worker threshold and shows that worker dispatch/cloning is not a general decode win.

Jumbo synthetic result: one ~17.6 MB decoded JSON value was 85 ms sync versus 61 ms pooled, but 16 concurrent decodes were 596 ms sync versus 740 ms pooled (0.81x). Worker value is therefore responsiveness/isolation, not guaranteed aggregate throughput; concurrency and retained-byte policy need foreground-interference measurement rather than a "parallel = faster" assumption.

### M3 — v5 delta cost probes (**mechanism evidence**)

- Highly compressible ~500 KiB repetitive JSON: full frame 82 B, delta 62 B, but full compression ~10.1 ms versus delta ~37.2 ms. Delta saves only 20 B while costing ~3.7x encode time.
- ~500 KiB pseudo-random text with a 3-byte mutation: full frame 299,818 B, delta 94 B; full ~112.4 ms, delta ~116.0 ms. Here delta is a decisive ratio win for roughly equal CPU.
- Therefore the existing `delta < full * 0.7` **stored-byte gate is necessary but not sufficient**: the encoder pays full-frame compression first and then pays delta matching/compression before it can apply that gate. The population question is whether current event classes contain enough "poorly independently compressible but highly base-similar" values to repay that speculative CPU + dependency/read cost.

### M4 — shared-window residual probe (**mechanism evidence**)

Synthetic 6 KiB repetitive event shells compressed independently versus one shared aggregate frame:

| rows | independent bytes | shared bytes | shared / independent |
|---|---:|---:|---:|
| 8 | 1,092 | 218 | 0.200 |
| 32 | 4,507 | 404 | 0.090 |
| 128 | 18,398 | 1,041 | 0.057 |

This reconfirms the *mechanism* behind the old OSES result: shared windows can remove an order of magnitude of residual frame bytes on tiny repetitive rows. It does **not** establish a production win after current semantic pruning/dedup; that requires a post-prune real-corpus sweep with point-read/read-amplification accounting.

### M5 — stratified current-corpus physical baseline (**bounded population evidence**)

A full online copy of the 16.52-GiB live database was attempted through SQLite's
online backup API, but the managed process died after ~4.2 GiB and the partial
file was not a database. It was discarded. No writes were made to the live DB.

The replacement population corpus contains **24 complete real sessions** selected
across six history-length bands (`<20`, `20-99`, `100-499`,
`500-1999`, `2000-4999`, `5000+`), including a 13,311-sequence heavy-tail
session:

| Metric | Baseline |
|---|---:|
| complete sessions | 24 |
| event rows | 49,902 |
| event payload bytes | 633,444,780 |
| message projections | 3,630 |
| part projections | 15,510 |
| SQLite file bytes | 791,814,144 |
| page size / freelist | 8 KiB / 0 |
| integrity / FK violations | ok / 0 |

This is **stratified bounded-population evidence**, not a claim about the entire
509,992-event live database.

### M6 — semantic convergence defect + physical frontier (**correctness + bounded population evidence**)

The first convergence run indexed ~45.9k semantic rows but compacted only one
aggregate (355 events) and returned `hasMore=false`. Root cause: when a pass
**successfully compacted the final page of an aggregate**, it did not probe for a
later eligible aggregate. The outer sealer therefore confused “this aggregate is
exhausted” with “semantic work is globally exhausted.” Mismatch-only aggregates
already performed that later-aggregate probe.

The owner-level fix makes a successful final page probe `nextAggregate` before
returning. A two-aggregate regression proves drain mode stays active after both
mismatch-only exhaustion and successful exhaustion.

After rebuilding the exact corpus and rerunning to true convergence:

| Metric | Result |
|---|---:|
| semantic passes | 46 |
| semantic maintenance time | 18.43 s |
| rows indexed | 45,911 |
| events compacted | **26,763 / 49,902 (53.6%)** |
| event payload bytes | **633,444,780 -> 123,682,848 (-80.5%)** |
| bitmap growth | 6,239 B |
| projection mismatches / compatibility rejects | 0 / 0 |
| SQLite after VACUUM | **791,814,144 -> 268,525,568 B (-66.1%)** |

Semantic elimination is therefore the dominant physical-storage mechanism on this
population; downstream representation experiments must compete on the **post-prune
residual**, not the original event stream.

### M7 — current >=4-KiB sealer on the converged residual (**bounded population evidence**)

Running current `runPassV2` with workers and delta emission disabled:

- 2,350 residual large events were promoted, representing **107,048,203 raw B**.
- **0 exact dedup repeats** were observed.
- 2,347 canonical `event_value` rows stored ~20.02 MB of compressed payload.
- After VACUUM the database fell **268,525,568 -> 180,125,696 B**.
- Worker-off promotion took ~65.7 s, reinforcing the importance of the codec-CPU
  simplification measured earlier.

Every one of the 2,347 retained `event_value` rows later measured `refs=1`.
On this post-semantic corpus, `event_value` is empirically a **canonical
large-value heap with dedup capability**, not primarily a dedup store.

### M8 — independent small-row physical frontier (**bounded population evidence**)

After semantic convergence + current >=4-KiB sealing, cold eligible TEXT below
4 KiB comprised:

| size | rows | raw bytes |
|---|---:|---:|
| <256 | 66 | 14,919 |
| 256-511 | 8,978 | 3,241,185 |
| 512-1023 | 8,122 | 5,739,759 |
| 1-2 KiB | 2,041 | 2,981,231 |
| 2-4 KiB | 1,582 | 4,657,551 |

Physical A/Bs started from the exact same **180,125,696-B** database. Experimental
rows remained independently decodable v3 frames, retained the existing 24-B gain
gate, source-TEXT revalidation, per-event journal records, SHA round-trip
verification and `integrity_check=ok`:

| policy | physical SQLite bytes |
|---|---:|
| current >=4 KiB | 180,125,696 |
| Brotli-1 >=256 | 175,071,232 |
| Brotli-1 >=512 | 174,710,784 |
| Brotli-5 >=256 | 173,981,696 |
| **Brotli-5 >=512** | **173,899,776** |
| Brotli-9 >=512 | 173,858,816 |
| Brotli-5 >=1024 | 175,554,560 |
| Brotli-5 >=2048 | 176,766,976 |

Important result: **512 B physically beats 256 B** despite refusing to compress
8,978 extra rows. Their framing/journal/cardinality cost exceeds their payload
saving. Brotli-9 buys only 40,960 B beyond Brotli-5 at roughly 2x codec CPU.
Thus Brotli-5 at 512 B is the storage/CPU candidate frontier, but it is **not
production policy** because writer-contention acceptance is not yet proven.

Replacing the partial candidate index floor from 4096 to 512 on the framed corpus
added **zero whole-file pages**, took ~22 ms to build, remained an indexed scan,
and measured ~1.1 us warm p50 / 34.6 us worst-of-20 for the bounded candidate
query. Index geometry is not the blocker.

### M9 — small-row writer contention (**mechanism evidence; production gate remains closed**)

Simply lowering `THRESHOLD` would reuse the large-value sealer's 8-row /
512-KiB / 15-ms writer geometry and create ~1,469 slices for 11,745 values.
Scratch two-process probes therefore compared per-row SQL and TEMP-staged
set-based application under a competing foreground `BEGIN IMMEDIATE` writer.

Set-based slices have excellent **uncontended** writer residence:

| rows/slice | uncontended p50 | uncontended p99 |
|---:|---:|---:|
| 8 | ~0.12 ms | ~0.21 ms |
| 16 | ~0.17 ms | ~0.69 ms |
| 32 | ~0.69 ms | ~1.00 ms |
| 64 | ~1.53 ms | ~2.41 ms |

However, on this Windows/Bun SQLite environment any collision between two writers
produced an approximately **15-17 ms foreground wait tail**, even when the
maintenance body itself was ~0.1-0.6 ms. Randomized 4-16-ms foreground arrivals
and 50/100-ms maintenance pauses preserved ~15-16 ms p95/p99 collision tails.
Disabling `wal_autocheckpoint` did not change the tail; it merely grew WAL to
~38.2 MB and moved ~104 ms of PASSIVE checkpoint work later.

This does **not** disprove the 512-B storage policy; it shows that production
writer scheduling must be compared with the repository's sanctioned foreground
latency methodology before admission. Do not hide the result with larger busy
timeouts, and do not ship “THRESHOLD=512” as a knob-only change.

### M10 — decoded-object cache retained memory (**bounded population evidence**)

`RehydrateCache` charges UTF-8 `raw_len` but retains parsed JS object graphs.
With workers off, SQLite cache reduced to 2 MiB, forced Bun GC around samples and
the real 2,347-row `event_value` population:

| cache state | charged raw bytes | heap delta | external delta | combined / charged |
|---|---:|---:|---:|---:|
| 512 values | 9.88 MB | ~17.6 MB | ~16.9 MB | ~3.49x |
| 1024 values | 24.12 MB | ~39.1 MB | ~37.9 MB | ~3.19x |
| after 2,347 loads / eviction | 66.33 MB | ~123.2 MB | ~121.7 MB | **~3.69x** |

Dropping the cache released ~120.7 MB of heap and ~119.6 MB of external/runtime
memory after GC. RSS remained allocator/high-water noisy and is not used as the
retained-object proof.

Therefore the configured “64 MB” is a **logical raw-source admission budget, not
a process-memory cap**. Runtime cache stats now expose `chargedBytes`, and source
documentation says this explicitly. No blunt 4x budget reduction was accepted:
the largest aggregate alone has ~20.65 MB of canonical raw values, so a 16-MiB
LRU-like budget can create cyclic warm-replay thrash. A new admission policy must
beat the current cache on both retained memory and warm replay before shipping.

Also, all 2,347 real `event_value` rows had `refs=1`, so refs-weighted eviction
degenerates to its LRU tiebreak on this population.

### M11 — staged jumbo lifecycle ownership (**correctness findings + fixes**)

The `$eventPayload` representation is now fully included in the ownership map:
foreground staging owns content-addressed chunk creation at `refs=0`; the final
semantic event transaction atomically claims ownership; replay validates chunk
cardinality/order/SHA/JSON; semantic backfill resolves the representation;
semantic prune and aggregate deletion release ownership.

Audit fixes:

1. Ref acquisition had already been converted from read-modify-write to atomic
   `UPDATE refs = refs + 1 ... RETURNING`.
2. Ref release previously used `max(0, refs-count)`, silently masking
   double-decrement/accounting corruption. The shared decrement primitive now
   normalizes duplicate IDs and updates **nothing unless every requested lifecycle
   row exists with sufficient refs**, then verifies exact affected-row count.
   Underflow/missing metadata fail closed with zero partial mutation.
3. Physical zero-ref chunk reclamation was **startup-only**, capped at 8 payloads.
   A long-lived host could therefore accumulate chunks released by semantic prune
   or aggregate deletion indefinitely. Reclamation now lives in the shared
   `event-payload` authority, retains its 24-h grace + IMMEDIATE recheck, and is
   also invoked by the dedicated low-priority sealer after semantic/sealing backlog
   drains. `hasMore` joins the existing 15-s reclaim-drain cadence.

Focused regressions cover duplicate decrement normalization, underflow atomicity,
missing metadata, bounded stale-orphan reclamation, jumbo replay/incomplete
fail-closed behavior, concurrent shared ownership, and semantic-prune release.

### M12 — shared-window residual framing after the independent frontier (**bounded population + mechanism evidence**)

The final OSES-style question was tested **after semantic pruning, current >=4-KiB
sealing, and against the physical Brotli-5 >=512 independent baseline**. The
prototype kept aggregate-local sequence windows, per-event audit rows, a compact
16-B member ref, valid CRC-checked frames and whole-file VACUUM accounting.

| representation | file bytes | vs independent | cold point p99 | p99 raw read amplification |
|---|---:|---:|---:|---:|
| independent q5 >=512 | **173,899,776** | baseline | **67.4 us** | 1x |
| shared 16 KiB | 174,350,336 | **worse** | 303.3 us | 29.5x |
| shared 32 KiB | 171,188,224 | -1.56% | 327.2 us | 60.0x |
| shared 64 KiB | 170,139,648 | -2.16% | 405.9 us | 120.6x |

Sequential aggregate replay can exploit one decompression per window:

- independent: ~48.2k rows/s,
- shared 32 KiB: ~83.9k rows/s (**1.74x**),
- shared 64 KiB: ~93.3k rows/s (**1.94x**).

That is useful mechanism evidence for a possible **derived replay cache/transport
optimization**, but not enough to justify a new coupled durable format. The
32/64-KiB formats buy only ~1.6-2.2% whole-file bytes while making cold point
reads ~4.9-6x slower and amplifying raw reads ~60-121x at p99, before paying for
migration, corruption/index semantics and another cache policy. Shared-window
storage is therefore rejected as the default durable representation on the
current frontier.

### M13 — v5 and read-path residuals (**bounded population + code-state evidence**)

- On 24 deterministic adjacent post-prune pairs, only **1/24 (4.17%)** passed the
  old `delta < full * 0.7` gate; speculative delta construction added ~220 ms
  beside ~273 ms of required full-frame work across the sample.
- Current concurrent source has now retired **new** v5 emission and records a
  separate whole-corpus result in its code comment: 8,244 live children plus
  support bases occupied 7.8% more bytes than independent children before
  dependency metadata/read/GC cost. This audit did not independently reproduce
  that larger measurement. Historical v5 read/integrity/dependency-GC support
  remains required.
- Batch event hydration no longer performs one base SELECT per v5 child. It
  preloads missing bases in one aggregate query and decodes a shared base once
  per replay page.
- Warm decoded-object hits are classified before `event_value` BLOB retrieval,
  so fully warm values avoid canonical BLOB reads.
- `bench-rehydration.ts` had an invalid fused/non-fused comparison: the old
  non-fused leg omitted `JSON.parse`. With equivalent work, fused decode measured
  only ~**1.06x**. The corrected harness remains the authority.

## 5. Bottlenecks / risks ranked by current evidence

1. **Decoded-object cache memory accounting/policy** — high-confidence bounded
   population evidence. The 64-MiB raw budget retained ~240 MB combined heap +
   external memory at the measured frontier. Observability is fixed; admission
   policy still needs a no-thrash memory/replay Pareto design.
2. **Physical reclaim of staged jumbo payloads** — correctness/lifetime gap fixed;
   continue measuring real-world reclaimed bytes when the representation becomes
   populated.
3. **Read worker pool remains narrow** — large/jumbo responsiveness can improve
   while small or highly concurrent batches regress. Keep the 64-KiB dispatch
   floor unless foreground event-loop evidence moves it.
4. **Eligibility constants (256-event tail / 1 h cooling / 64-KiB aggregate
   externalization)** remain evidence-derived historical knobs rather than proven
   current-population optima. They are lower priority now that semantic pruning is
   known to dominate physical bytes.

## 6. Correctness / ownership findings

- **Fixed:** successful semantic aggregate exhaustion could falsely report global
  convergence. The semantic owner now probes later aggregates before returning.
- **Fixed:** staged-jumbo decrement underflow/missing lifecycle metadata could be
  hidden by clamping; release is now atomic/fail-closed.
- **Fixed:** staged-jumbo zero-ref physical cleanup was startup-only; shared
  lifecycle reclamation now also runs on the dedicated maintenance connection.
- Maintenance still owns its dedicated connection, short busy timeout and
  `BEGIN IMMEDIATE` write slices. Foreground remains the priority owner.
- Candidate compression stays outside writer transactions; durable writes
  revalidate exact source representation before publishing derived state.
- Historical v5 dependencies remain explicit and GC follows the live transitive
  base closure; aggregates with unknown delta edges remain quarantined from value
  deletion.
- No new durable format was introduced by this audit.

## 7. Candidate work after convergence, ranked

| Priority | Candidate | Expected benefit | Confidence | Complexity | Admission gate |
|---|---|---|---|---|---|
| P0 | Parsed-cache admission/retained-size policy | reduce ~240-MB measured retained footprint without warm-replay collapse | high | medium | same-corpus warm replay + GC-stabilized heap/external Pareto |
| P1 | Persist current-state benchmark harness/corpus recipe | make lock/WAL/memory/physical regressions repeatable | high | medium | measurements reproduce from clean scratch |
| P1 | Worker threshold/concurrency under token-stream load | bound event-loop interference | medium-high | low | no foreground token/read p99 regression |
| P2 | Re-evaluate hot-tail/cooling/externalization thresholds | reduce maintenance churn/backlog | medium | low | population evidence, not knob intuition |
| future | Shared-window *derived replay* cache, not durable storage | 1.7-1.9x sequential residual replay in prototype | medium | medium | must avoid cold point-read amplification / durable coupling |

## 8. Disproved / rejected ideas

- "Semantic pruning is only a modest byte optimization" — disproved after the
  convergence bug fix: -80.5% event payload bytes and -66.1% whole-file bytes on
  the stratified corpus.
- "Post-prune event_value is primarily a dedup store" — not supported on this
  population: 2,350 promotions, zero repeats, and every retained canonical row
  had `refs=1`.
- "256 B is better than 512 B because it compresses more source bytes" —
  physically disproved by SQLite metadata/cardinality overhead.
- "Brotli-9 earns its extra small-row CPU" — rejected: ~40 KiB whole-file gain
  beyond q5@512.
- "Shared windows should replace independent framing" — rejected on the current
  durable frontier: <=2.2% physical gain does not repay 4.9-6x cold point-read p99
  and 60-121x read amplification.
- "The 64-MiB decoded cache is a ~64-MiB memory bound" — disproved; it is only
  a raw-source charge and measured ~3.7x combined retained heap+external bytes.
- "Workers are always faster" — disproved by the earlier worker probe.
- "Delta is automatically cheaper when its stored output is smaller" —
  disproved; construction/base/dependency/read costs matter.
- Blind page-size, retry, batch, cache-budget or threshold tuning remains rejected.
- Sharing the primary DB permit for maintenance or hiding collisions behind large
  retries remains architecturally rejected.

## 9. Convergence plan

1. Keep semantic pruning first. It is the highest-return representation transform
   and must converge globally before ratio experiments are interpreted.
2. Preserve the current independent-value durable representation. Do not add
   shared-window storage on current evidence.
3. Keep the measured q5 >=512 small-row policy inside the existing independent
   v3 representation. It is production background policy now; do not split it
   into a second maintenance state machine or reintroduce a dedicated duplicate
   candidate index.
4. Design cache admission from actual retained memory. A raw-byte multiplier alone
   is insufficient if it destroys whole-session warm replay.
5. Keep staged-jumbo lifetime logic centralized in `event-payload.ts`; both
   foreground and maintenance consume that authority.
6. Keep historical v5 readers/integrity/GC even though new emission is retired.
7. Persist benchmark recipes that report logical bytes, whole SQLite bytes,
   WAL/checkpoint, lock p50/p95/p99, cold/warm point and aggregate reads, heap /
   external memory, and foreground interference.

## 10. Audit status

Current convergence: **do not introduce another durable representation.** The
largest correctness defect found in this tranche was semantic false convergence;
after fixing it, semantic deletion plus today's independent >=4-KiB ChunkDB moved
the stratified physical database from **791.81 MB -> 180.13 MB (~77.3% smaller)**.
Independent q5 >=512 reaches **173.90 MB (~78.0% smaller from the same
baseline)** and is now integrated into the ordinary production sealer using the
existing independently-decodable v3 format plus the cross-process quiet gate.
Shared-window storage is not a Pareto win once cold reads and whole-file geometry
are counted.

Implemented audit changes that survived evidence:

- semantic global-drain convergence fix + regression;
- ordinary codec candidate simplification with preserved jumbo frontier;
- warm-cache-before-BLOB lookup and batched historical-v5 base preload;
- corrected rehydration benchmark;
- staged-jumbo atomic fail-closed ref release and periodic low-priority orphan
  reclaim;
- truthful cache charged-byte observability/documentation;
- measured Brotli-5 512..4095 small-row framing integrated into the ordinary
  sealer without a new durable representation;
- removal of the duplicate standalone small-row sealer and its redundant partial
  candidate index.

No shared-window format, page-size change, hot-tail/cooling change, or
cache-budget reduction is accepted without new evidence.


### M14 — contention-methodology normalization + cache-budget sweep (**mechanism + bounded population evidence**)

The small-row q5 writer investigation reached an important methodological correction.
The experimental 8-row set-based maintenance statement itself is extremely short when
uncontended (~117 us p50 / ~210 us p99 writer residence in the focused probe), but
a competing foreground writer can still observe ~15 ms collision tails. This is
consistent with SQLite writer-lock acquisition/retry granularity dominating the
tail rather than the maintenance statement body.

The historical semantic-prune comment (256 rows -> ~2.3 ms foreground p99) is
not currently reproducible from a checked-in harness: the benchmark recipe was
recorded only as a code comment in the original semantic-compaction commit. An
apples-to-apples scratch fixture was therefore constructed around the actual
current runSemanticPrunePass, with 8,193 proven full-message snapshots and
8,192 superseded candidates. After advancing the scratch-only historical-index
watermarks (the first fixture correctly refused mutation until backfill
completion), current semantic prune compacted all 8,192 candidates successfully
across repeated fixtures. The experiment exposed that the prior p99 number cannot
be used as a mechanically reproducible acceptance oracle until its foreground
sampling process is persisted. Do not tune the q5 lane to a historical number
whose methodology is unavailable. Production now relies on the stronger
cross-process quiet-gate ownership rule rather than that historical number. A
checked-in common contention harness remains useful future regression work, not a
closeout blocker.

The normalized measurements now quantify that ownership rule. Without the gate,
the actual semantic writer deleted 8,192 rows in ~576 ms while the same
foreground process measured ~92.7 us p50 / ~1.60 ms p95 / ~5.72 ms p99 /
~15.57 ms max writes. `PRAGMA data_version` was then validated as the
cross-process activity signal: own commits do not advance the maintenance
connection's observed value, external commits do, and the probe cost measured
~1.9 us p50 / ~4.9 us p99.

With the production 100-ms quiet gate:

- semantic prune idle: **8,192 deletions in ~438 ms**;
- semantic prune during a 1.5-s foreground burst: **~1.86 s maintenance**,
  foreground ~22.4 us p50 / ~147 us p95 / ~265 us p99 / ~1.73 ms max;
- integrated `runPassV2` q5>=512 idle: **11,745 rows in ~3.92 s**, final physical
  size **173,907,968 B** after VACUUM, zero residual eligible small TEXT;
- the same q5 pass during a 1.5-s / 2-ms-cadence foreground burst: **~5.49 s**
  maintenance, foreground ~21.6 us p50 / ~153.5 us p95 / ~262.2 us p99, with
  one isolated ~16.7-ms maximum; all 11,745 rows drained and
  `integrity_check=ok`.

Thus maintenance absorbs foreground activity by waiting for quiet instead of
making foreground commits absorb maintenance. Idle drain also improves because
fixed inter-slice sleeps are unnecessary once the connection is demonstrably
quiet.

Cache admission produced a clearer result on the seven largest ref-bearing
aggregates in the post-prune stratified corpus (about 93.7 MiB of the corpus's
102.1 MiB canonical raw bytes). Each aggregate was replayed four times with the
same refs-weighted cache policy while only the raw-byte budget changed:

| raw cache budget | cold sweep | mean warm sweep | warm hit rate | max charged |
|---|---:|---:|---:|---:|
| 8 MiB | 1284.1 ms | 657.6 ms | 31.97% | 8.00 MiB |
| 16 MiB | 1265.1 ms | 216.8 ms | 60.48% | 16.00 MiB |
| 32 MiB | 1150.4 ms | 111.7 ms | 66.67% | 19.69 MiB |

The 32-MiB budget never charged more than 19.69 MiB because cache ownership is
per live DB and this benchmark resets between aggregates; it therefore captures
the dominant single-session replay domain rather than a cross-session global
working set. Most importantly, shrinking to 8 MiB causes severe replay thrash
(~5.9x slower warm sweep than 16 MiB), while 16 MiB is still ~1.94x slower than
the 32-MiB run. Combined with the earlier retained-memory measurement, this
rejects a blind global budget reduction: raw-byte accounting is not a truthful
heap cap, but simply shrinking the existing admission budget destroys useful
warm-session locality. A production improvement needs a better retained-size /
admission policy, not a smaller constant.


## 11. Final closeout

The architecture audit is **closed**, not abandoned. The evidence converged on
the existing architecture after correcting several ownership/correctness defects:

1. semantic elimination is the highest-return transform and runs before
   representation compression;
2. retained large values stay independently encoded, with `event_value` treated
   primarily as a canonical large-value heap rather than assuming dedup wins;
3. the measured 512..4095 residual is independently Brotli-5 framed in v3 rather
   than introducing shared-window coupling;
4. new v5 delta emission is retired, while historical reader/integrity/GC support
   remains durable;
5. staged jumbo ownership/refcount/reclaim remains centralized;
6. foreground SQLite writers retain priority through dedicated maintenance
   connections, IMMEDIATE write slices, non-blocking admission/retry, and a
   cross-process quiet gate.

The final stratified physical frontier measured:

`791.81 MB baseline -> 268.53 MB semantic -> 180.13 MB ordinary sealing -> 173.90 MB q5>=512`.

That is ~78.0% whole-file reduction without adopting another durable format.
Shared-window storage was rejected; q9 small framing was rejected; 256-byte
small framing was rejected; blind cache-budget reduction was rejected.

Closeout verification on the current worktree:

- **96/96** database tests pass;
- **58/58** EventV2 tests pass;
- scoped changed-source typecheck has no ChunkDB-source diagnostics; the two
  reported diagnostics are pre-existing/environmental (`bun:sqlite` type
  resolution and an unrelated LLM `TextDecoder` type-use error).

Open items are deliberately **future research**, not blockers for this audit:
truthful parsed-cache retained-memory admission, a persisted common contention
benchmark, token-stream worker interference, and remeasurement of historical
eligibility constants. None justifies further mutation in this closeout.
