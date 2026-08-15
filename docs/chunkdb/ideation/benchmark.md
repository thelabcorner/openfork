# Benchmark corpus, methodology & acceptance gates — ideation

**Author lane:** benchmark-arch (swarm `chunkdb-ideation`)
**Base:** `docs/chunkdb/architecture-research.md` (§13, 16, 17, 29, 30, Appendix D/G/H, §31)
**Branch:** `openfork` (v1.18.18). **Ideation only — no implementation code.**
**Evidence labels** reuse the research-doc legend: [VERIFIED] / [MEASURED] / [CALCULATED] / [INFERENCE] / [PROPOSED] / [UNRESOLVED].

---

## 0. Executive summary

The research doc gives a correct *skeleton* (workloads §29.1, accounting §29.2, cache states §29.3, corpus classes §29.4, geometry §29.5, gates §29.8, provenance §29.9). This ideation makes it *executable and hard to game*. Five headline recommendations:

1. **Corpus = engine-agnostic logical op-streams + frozen legacy SQLite snapshots**, in two size tiers (committed small, URL-pinned large), with a **holdout corpus** and an **entropy budget** that every synthetic class must meet. Generate-at-bench-time is a veto.
2. **One process, three engines** (legacy / OSES / OPCL) driven from the identical op stream, measured through the raw native driver — **bypassing the one-permit Effect semaphore** ([VERIFIED] both adapters serialize on `Semaphore.make(1)`) — plus a separate production-path microbench through the real layers. Per-statement SQLite I/O counters are *not exposed* by `node:sqlite`/`bun:sqlite`, so "bytes read" must come from codec-layer counters + offline `dbstat` on frozen copies, not runtime instrumentation.
3. **Two-stage geometry sweep**: a screening grid (event-only, one cache state) producing a Pareto front, then full accounting only on the front candidates. Present the **Pareto knee** with per-class heatmaps, sanity anchors (raw + legacy), and pre-registered tie-break rules — never a single ratio winner.
4. **A pre-registered gate list** (`gates.json`, pinned before first run) with concrete proposed numbers and **five hard vetoes** (replay break, crash corruption, unsupported runtime API, pathological write amplification, privacy-poisoned dictionary). Post-hoc gate loosening is the classic gaming vector and is banned without a written amendment.
5. **Cross-runtime = run the identical harness under Bun AND the packaged Electron Node** (`ELECTRON_RUN_AS_NODE=1` against the shipped binary), with golden vectors in both encode directions. Authoritative cold numbers come from a Linux CI container (`drop_caches`); Windows desktop runs are labelled `cold-approx` because the OS page cache cannot be deterministically dropped there.

**Challenged assumptions up front:** the 50-event trace is a *mechanism corpus* only (it proves the harness finds repetition and provides exact ground truth 7/7, 9/9 — §13.8), never a sizing corpus. The 25k expanded trace stays a structural stress test and gains an **entropy-injection variant** so it measures B-tree/index overhead rather than one session repeated. A benchmark is kept from being gamed by freezing corpora, per-class reporting, a holdout, pre-registered gates, and monotonicity rules (the harness must never mutate its corpus).

---

## 1. Grounding facts from the codebase

[VERIFIED] — openfork tree, inspected for this ideation:

| Fact | Evidence |
|---|---|
| Tests run with `bun test` in both `packages/core` and `packages/opencode`; typecheck is `tsgo --noEmit`. No vitest, no Jest. | `packages/core/package.json`, `packages/opencode/package.json` |
| `bench:test` exists but is a *test-suite wall-clock harness* (`script/bench-test-suite.ts`), not a storage benchmark. | `packages/opencode/package.json` |
| A `bench/` directory already exists: `packages/opencode/bench/chunkdb-bench.ts`, `chunkdb-readlatency.ts`, `chunkdb-readpath.ts`, `chunkdb-seal-parallel.ts`, `chunkdb-seal-worker.ts`. These are prototype scripts run under `bun` **and** `node --experimental-strip-types`, sharing a small `Driver` abstraction over `bun:sqlite` / `node:sqlite`. | bench files |
| Both DB adapters serialize **all** DB access on a one-permit semaphore (`Semaphore.make(1)`, `withPermits(1)`); WAL is set unconditionally at startup on both runtimes. | `packages/core/src/database/sqlite.node.ts`, `sqlite.bun.ts` |
| A fork prototype codec already exists: OCDB frame v2 in `packages/core/src/database/json-codec.ts` (magic+version+codec+rawLen+CRC32 header, deflate/brotli/zstd, `THRESHOLD=4096` code units, 128 MiB raw-length pre-cap), plus `chunk-sealer.ts`. | source |
| Current event schema: `event(id text PK, aggregate_id text, seq int, type text, data text json)` + `event_sequence(aggregate_id text PK, seq, owner_id)`. | `packages/core/src/event/sql.ts` |
| Fixtures: `packages/opencode/test/fixtures/recordings/session/*` are *provider HTTP recordings* (not DB corpus); `test/fixture/` holds helper builders. No DB corpus directory exists yet. | tree |
| The reference DB (`opencode-openfork.db`, 50 events) is **not committed**; prototype benches point at a sanctioned working copy (`D:\` backup per `chunkdb-bench.ts` header). | bench header |

**Consequences for the harness:**
- Storage-engine comparison must measure through the **raw native driver** (as the prototype benches already do), not the Effect `SqlClient`, or the semaphore itself becomes the measured bottleneck and every engine looks equally serialized.
- WAL is always on — every write benchmark must account for `-wal`/`-shm` bytes and checkpoint behavior, since that is the production posture.
- Reuse the existing `Driver` abstraction; it already solves the Bun/Node duality the research doc demands (§29.9).

---

## 2. The distinct-session corpus

### 2.1 Two physical forms, one logical source of truth

The harness must run **legacy vs OSES vs OPCL on the same workload** (research §29.4/31.2). The clean way is a corpus with two projections of the same underlying logical data:

- **Logical op-stream** (canonical, engine-agnostic): a versioned, ordered list of storage operations — `event.append(aggregate, seq, id, type, data)`, `event.delete(aggregate)`, `projection.write(message/part, data)`, plus session-close / snapshot markers. Each engine ingests the *identical* stream, so wall-time and byte results are directly comparable. This is the format the differential and active-write benchmarks consume.
- **Frozen legacy SQLite snapshots**: one committed `.db` per corpus class, produced by *ingesting the logical stream through the legacy engine*. Used for whole-DB byte reduction (`legacy bytes` vs `OSES bytes` on the same logical content), cold-read harnesses that need no write replay, and reverse-export verification (coordination with migration-arch's reverse export).
  - **Framing census (fork correction):** on the openfork branch, legacy `event.data` is *already* OCDB-framed for rows ≥ 4096 code units (fork `chunk-sealer.ts`/`json-codec.ts`; confirmed by migration-arch's ground-truth verification). Every frozen snapshot therefore records a **per-table framing census** (raw TEXT bytes vs OCDB-frame BLOB bytes) in its `class-report.json`. Captured real DBs must decode OCDB frames before emitting the logical op-stream, so the canonical logical form is engine-agnostic and not fork-framing-dependent. The **`ocdb_seal` journal is preserved** (not stripped) on captured real DBs — it is frozen as the reverse-export decode manifest and the OSES-sealer Leg-B baseline (oses.md §6.1/§9.4), and is part of the corpus manifest for the G9.3 cross-check.

[PROPOSED] Corpus format: a directory per corpus id
```
bench/corpus/<id>/
  manifest.json        # id, version, hash, source class, provenance, row counts, logical bytes, entropy stats
  ops.ndjson           # logical op-stream (canonical)
  legacy.sqlite        # frozen snapshot from the legacy engine (small corpora only)
  class-report.json    # per-class stats: repeated-string share, distinct-string ratio, payload percentiles
```
`class-report.json` additionally carries the **OPCL gating measurements** (requested by opcl-arch, no data exists today — the reference DB has 9 parts): per-`part_type` tail share of rows ≥ 4 KiB and of bytes ≥ 4 KiB (and per-type size percentiles), plus the share of `message.data` rows ≥ 4 KiB. These are produced at corpus v1 and decide whether message sealing is a declared no-op and how much of the projection tail OPCL actually touches.
`manifest.json` is the versioning unit: corpus `id@version`, content-hashed (`sha256` of all payload files), immutable once published. The runner refuses to run if the on-disk hash does not match the manifest.

### 2.2 Classes (per research §29.4) and their assembly

| Class | Source | Notes |
|---|---|---|
| `mechanism-50evt` | the supplied reference DB | ground truth; validates harness, never decisions |
| `real-sanitized-*` | captured real DBs, sanitized | the only population evidence; see §2.4 |
| `short` / `medium` / `long` | synthetic + sanitized | <20 / 20–500 / >500 events per session |
| `reasoning` | synthetic | long hidden-reasoning streams |
| `tool-heavy` | synthetic | many tool calls, small-medium outputs |
| `jumbo-tool` | synthetic | one tool output ≥ 1 MiB (real max observed ~32.8 MiB, `chunkdb-readlatency.ts`); **produces both the durable event history AND the large OPCL projection rows** (`part.data` large tool output that compaction marks `time.compacted` but never deletes — contract-arch/opcl-arch verified) |
| `code-patch` | synthetic | large diffs, repeated file paths |
| `high-entropy` | synthetic | pre-compressed/random text — the anti-cheat class |
| `snapshot-replay` | synthetic | repeated full-state `session.updated`/`message.updated` chains (the §13.9 pattern) |
| `retry-replay` | synthetic | retry/repair/replay history, duplicate-ID attempts, divergent-replay fixtures, **noncanonical event IDs (incl. bitwise-NOTed 48-bit clocks and UPPERCASE-hex IDs — R2 P10 follow-up: the uppercase-hex fixture exercises the escape path against a real corpus, per oses.md's required golden vector)** |
| `multi-tenant` | synthetic | many aggregates/workspaces/provider strings interleaved (index/row-overhead class) |
| `fork-schema` | real fork DB | includes `part_fts`, `session_message`, `idx_message_provider_id` (the §13.1 extension pressure) |
| `structural-25k` | expanded trace (§17.5) + **entropy-injection variant** | stress test, not forecast |

### 2.3 Anti-gaming rules

1. **Corpora are frozen and pre-generated.** Generation runs in a separate, versioned tool; the harness *only reads* corpora. Generate-at-bench-time is a hard veto — it lets the implementation under test tune its own corpus.
2. **Entropy budget for synthetic classes.** A synthetic class must fall inside a band of the real-sanitized sample on at least: repeated-string-value share (§13.11 metric), distinct-string ratio, payload size percentiles. Classes outside the band are labelled *stress* and excluded from forecast gates. This directly answers "how do you keep a benchmark from being gamed with highly-repetitive synthetic data".
3. **Per-class reporting is mandatory** for every storage gate; an aggregate winner that hides a per-class regression fails (this is research §29.4 verbatim).
4. **Holdout corpus.** One `real-sanitized-*` corpus is sealed away at corpus v1 and never used during tuning; it is ingested only at final gate time. Geometry/codec overfitting to the tuning corpus is the subtle gaming vector this kills.
5. **Monotonicity.** The harness asserts the corpus files are unchanged (`stat`/hash before and after) and that the op-stream is consumed exactly (op count, event count, byte totals logged in the result).

### 2.4 Sanitized real sessions — pipeline and privacy

[PROPOSED] A capture tool (bench-side, not product code) that: opens a user's DB read-only, exports `session`/`message`/`part`/`event`/`session_message` rows to the logical op-stream, then runs a **sanitizer**: replace session/aggregate IDs (keep structure: prefix + length), scrub `prompt`/tool-output bodies only where a field is classified as content, keep sizes/distributions, strip credentials. The sanitizer output must be reviewed before any release. Privacy gate: a corpus is rejectable if any redaction regression is found (spot-check via the same repetition inventory tooling that produced §13.11).

### 2.5 Is the 50-event trace usable at all?

Yes — with an explicit role. It is the **mechanism corpus**: it validated the repetition inventory (§13.11), gave the only exact projection-match ground truth (7/7, 9/9 — §13.8), and is small enough to commit. It must never be the source of a population ratio. The research doc's own §29.8 discipline ("do not freeze a percentage target until a representative corpus exists") is preserved by making every percentage gate in §7 of this doc a *proposed* number pinned at corpus-v1 time.

[UNRESOLVED] Where do large corpora live? Options: (a) git (small tiers only, <10 MiB), (b) a URL-pinned corpus store with hash verification (large tiers — the observed heavy aggregate is 2.5 GiB raw), (c) the existing `D:\` working-copy convention. Recommend (a)+(b): committed small corpora for CI, URL-pinned large corpora for release gates, with a `bench/corpus/registry.json` mapping id→(version, hash, URL). Needs a decision from the coordinator on whether a private corpus store is acceptable.

---

## 3. Harness design

### 3.1 One process, three engines

[PROPOSED] `bench/run.ts` (extending the existing bench/ pattern) takes `--engine legacy|oses|opcl --corpus <id> --geometry <json> --cache <S1..S4> --runtime bun|node`. All three engines run **in one process** against the same op-stream, via a thin engine adapter implementing:

```text
ingest(stream) -> build physical store
append(aggregate, seq, id, type, data)
readAfter(aggregate, after, limit)        // the app's real query
readAggregate(aggregate, type, after, limit)
pointBySeq(aggregate, seq) / pointByID(id)
rangeReplay(aggregate)                    // full history
syncHistory(afterGlobalSeq, limit)        // cross-aggregate sync (contract-arch: (seq ASC, global_append_ordinal ASC) ordering; byte-identity on logical payloads)
deleteAggregate(aggregate)
seal() / checkpoint()                     // OSES sealing; legacy no-op
```

`syncHistory` is a first-class differential op: the contract pins global-seq ordering with tie-break by global append ordinal, so the harness asserts **byte-identical logical payloads AND identical ordering** (including the tie-break) between legacy and OSES on the sync-history workload, not just equal row counts.

The adapter measures the app's *actual* decode path (JSON.parse + schema decode **included** — research §29.2's warning is non-negotiable): the codec layer keeps counters (frames decoded, decompressed bytes, parse/schema-decode time) so "bytes decompressed / frames decoded / parse time" are first-class runtime metrics.

**Semaphore handling:** storage-engine comparison runs against the raw native driver (bypassing the Effect semaphore) so per-engine cost is visible. A second microbench, `bench/prodpath.ts`, runs the same ops through the real Effect `SqlClient` layer to catch integration regressions and to report the production posture where the semaphore is real. Both numbers are reported, labelled `raw-driver` vs `prod-path`.

**Statistical protocol:** interleave A/B (run legacy/OSES alternately per rep to cancel thermal/ASLR/cache drift), warmup reps, ≥1000 samples for ms-scale p99 (10k for sub-ms ops), report bootstrap CI on p99. The runner writes one JSON result per run and a `compare` script prints delta tables keyed by (engine, corpus, geometry, cache-state, runtime).

### 3.2 Metrics per operation

| Metric | How obtained | Honest caveat |
|---|---|---|
| wall p50/p95/p99/max | `performance.now()` on the op | — |
| CPU time | `process.cpuUsage()` deltas per phase | process-level, not per-op |
| WAL bytes added | `stat(<db>-wal)` before/after op | the production reality (WAL always on) |
| main DB bytes after checkpoint | `PRAGMA wal_checkpoint(TRUNCATE)` + `stat(<db>)` | only at phase boundaries |
| decompressed bytes / frames decoded | codec-layer counters | runtime-measurable, exact |
| parse + schema-decode time | wrapped `JSON.parse` + schema decode inside the adapter | exact, included in wall time |
| logical bytes fetched | row/column byte sums from the result set | exact |
| **SQLite bytes read** | **not directly exposed** by `node:sqlite`/`bun:sqlite` (no `sqlite3_stmt_status` surface) | see §3.3 |
| allocation / GC | `global.gc()` + `process.memoryUsage()` delta between phases (run with `--expose-gc`), labelled approximate | do not claim precision |
| index/rows touched | `EXPLAIN QUERY PLAN` identity capture (already in `chunkdb-bench.ts`) | plan identity, not I/O |

### 3.3 The "bytes read from SQLite" honesty problem

[VERIFIED] Neither `node:sqlite` (`DatabaseSync`) nor `bun:sqlite` exposes per-statement I/O counters. Research §29.2 lists "bytes read from SQLite" — as stated it is **not obtainable at runtime** from current bindings. [PROPOSED] Resolution: (a) runtime proxy = logical bytes fetched + codec decompressed bytes (reported as such); (b) physical page-level accounting via **offline `dbstat` on the frozen snapshot copies** (the research doc's own Appendix D pattern), run as a separate analysis pass over the legacy and OSES snapshots; (c) optionally a later native instrumentation build. The gate values in §7 use the obtainable metrics.

---

## 4. Cache-state taxonomy — how each state is forced

Research §29.3 lists four states. The forcing procedures (the part the research doc omits):

| State | Definition | Deterministic forcing |
|---|---|---|
| **S1 hot app frame cache** | codec frame cache + SQLite page cache warm | warmup pass in-process; measure second invocation |
| **S2 warm OS cache / cold frame cache** | OS pages warm, in-memory frame cache cold | clear frame cache (`cache.clear()`), keep process + file open, `PRAGMA cache_size` bounded to force SQLite re-read from OS |
| **S3 cold everything** | fresh process, cold caches | fresh process + **fresh file copy** + first access is the measured op; `PRAGMA cache_size=0`; on Linux CI: `echo 3 > /proc/sys/vm/drop_caches` (root in container) |
| **S4 cold first-launch replay** | the product's first-launch resume | fresh process + fresh copy; op #1 is the session-resume replay sequence |

[PROPOSED] **Cold OS-cache forcing is only exact on Linux with `drop_caches`.** On Windows (the primary desktop target) the OS page cache cannot be dropped from userspace; a fresh file copy leaves residual NTFS cache risk. Therefore: authoritative S3/S4 numbers run in a Linux CI container (root, `drop_caches` between runs, file on a tmpfs/scratch volume), and Windows desktop runs are labelled `cold-approx` with the residual risk stated. Every result row carries its cache-state label + forcing procedure; **an unlabelled read result is rejected** (research §29.3's "do not claim a single cache state is representative" is enforced structurally).

---

## 5. Geometry sweep and Pareto presentation

### 5.1 Dimensions and two-stage design

Dimensions, aligned to oses-arch's final design (`docs/chunkdb/ideation/oses.md`): **segment stored-bytes target 8/16/32/64 KiB** (raw 32–128 KiB is a backstop, not the control), × **microframe raw 8/16/32/64 KiB** (design point raised to 16–32 KiB raw — the workload is range-scan dominated; grid covers it with margins), × dictionary none/structural/trained × codec deflate/brotli/zstd-capability-gated × safety-tail policies (a small set of count/byte/idle rules) × page_size 4/8/16 KiB (offline VACUUM control only). **Codec cells reflect the architecture decision (codec-arch `codec.md`): brotli q1 is the byte-stable baseline [LOCKED], zstd l1 is the per-frame adaptive alternative** (measured on git-diff text: zstd l1 0.042 < brotli q4 0.045 < q1 0.061; zstd l1 byte-stable, no parity risk) — the sweep must include both, plus decode-speed bias for interactively-read classes. **`frame_count=1` is a legal geometry** — microframe independence is optional in the format (corruption containment + cache granularity, not a point-read-latency mechanism), so the sweep must include the single-frame-per-segment cell as a first-class candidate, not a degenerate case. Codecs and dictionary IDs are referenced by the **frozen OCDB v2 registry** (`1=zstd, 2=brotli, 3=raw-deflate` — codec-arch: freeze, append-only; the research doc's Appendix-B numbering conflicts with bytes already on disk). The **anchor safety-tail policy is the fork sealer's actual values** (128 rows/batch, 5000/pass, 48h cooling, `ocdb_seal` journal — opcl-arch verified); variants around it, not a fresh invented policy.

The full grid is ~1300 cells — over-engineered for full accounting. [PROPOSED] **Two stages:**

- **Stage 1 screening** (event-only corpus class `multi-tenant` + `mechanism-50evt`, single cache state S3): all grid cells, cheap metrics only — stored bytes, point-p99, range-p99, CPU. Output: the **Pareto front** (dominance filter over (bytes, point-p99, range-p99, CPU, WAL)).
- **Stage 2 refinement** (front candidates only, maybe 8–20 configs): full accounting — all cache states, all op classes, sealing (§29.6), WAL/checkpoint, prod-path. Output: final geometry recommendation.

### 5.2 Pareto presentation (not a ratio winner)

- **Pareto front table**: every non-dominated config with all five objectives, plus two **sanity anchors**: the `raw` (no compression) and `legacy` (current engine) configs, so the front is interpretable against "do nothing". **Range-read p99 is the primary geometry objective** (oses-arch: workload is range-scan dominated); point-read p99 is reported but is not what segment/microframe sizing optimizes for.
- **Knee**: rank front members by distance from the utopia point (best value per objective), and by max-curvature along the front; report the knee explicitly with both measures.
- **Per-class heatmap**: compression ratio per corpus class × front config, so a config that wins on repetitive sessions but regresses on `high-entropy` is visible at a glance. Per-class regression is a gate input (§7 G6).
- **Tie-break rules (pre-registered)**: equal bytes → prefer lower WAL; equal WAL → prefer stable non-experimental codec (deflate) over zstd; equal ratio → prefer smaller microframe (bounded corruption blast radius, §16.5). These are pinned before Stage 1.

### 5.3 Event-ID locator benchmark

Pinned against oses-arch's physical design (`docs/chunkdb/ideation/oses.md` §7, swarm msg `msg_a57f569701a34c259a01d1171a2790f8`):

**Candidate set (implementable, from the OSES design):**
- **L0 baseline = current schema**: `event.id` TEXT PK — 26-byte ASCII keys over all rows. This is the *de facto* full-string registry today.
- **L1 Tier A (default)**: derived `event_id_registry(event_id BLOB PK, storage_kind, storage_id, ordinal, UNIQUE(storage_kind, storage_id, ordinal))` replacing the TEXT PK; the **packed-ID stream inside the OCE2 segment** (clock stream + 84-bit base-62 suffix stream) is the exact authoritative store; the registry is a derived accelerator, never authoritative.
- **L2 Tier B**: same registry with a **64-bit keyed fingerprint PK** + exact verify. Verify = re-derive packed bytes from storage (segment stream / hot row) and byte-compare against packed(requested ID) — byte-lossless by construction (12-hex clock = low 48 bits of `ts*4096+counter`, suffix = base-62 numeral < 2^84), so the hard "must prove exact equality" constraint is satisfied and the *measured* quantity is the **verify-hit rate** (candidate rows needing verify); birthday bound at 1M events ≈ 2.7e-8, ~0 expected candidates. Verify must also pass for **noncanonical IDs** (incl. bitwise-NOTed clocks — contract-arch fork landmine): the packer round-trips them opaquely, and the corpus's `retry-replay` class carries such IDs so L2's verify path is exercised against them, not only canonical ones.
- **L3**: 128-bit fingerprint variant — run only if L2's measured verify-hit rate or a deliberate attack analysis shows it matters; do not spend the index bytes otherwise.

**Metrics (at 1k / 100k / 1M event scales):**
- **registry DB bytes** (the deciding number for L1 vs L2 — the L1 registry *replaces* the existing TEXT PK index, so it is strictly cheaper than today, not new cost; packed IDs ≈ 12–17 B/event vs 30 B ASCII ≈ 2.4× on the index itself);
- measured verify-hit rate for L2 (uniqueness-check + replay insert paths);
- point-lookup-by-ID p50/p99 — **advisory, not a hard gate**: ID lookups are rare in this workload (uniqueness check + replay only), so this is a secondary metric;
- replay-insert latency (registry row + segment stream append);
- decode complexity (code-size proxy, reviewable).

[RESOLVED with oses-arch] Registry-vs-segment cost split: the **authoritative bytes live in the segment ID streams** (clock stream + suffix stream); the `event_id_registry` is a **derived accelerator** that may be lazily built or dropped for sealed history. The bench still records the split at 1k/100k/1M (how much packed-ID cost is in the stream vs the registry) as data for the lazy-build decision — no longer an open design question.

---

## 6. Sealing benchmark

From research §29.6, made executable. **The benchmark target is the generalized fork ChunkSealer** (same frontier rule, own connection, `oses_seal` journal, append-safe prefix commit — oses-arch). Sealer-lifecycle timeline (correction, now authoritative in oses.md §6.1/§9.3/§9.4): the **fork EVENT sealer runs only through Stage A** — it retires *before Stage B shadow backfill arms*, not at the Stage C flip; from Stage B onward it is OFF and the frozen `ocdb_seal` journal serves as the **reverse-export decode manifest**. Therefore the sealing bench has two legs: (a) the **fork-sealer baseline leg** (Stage A window only — fork sealer + `ocdb_seal` journal, 128/batch/5000-pass/48h cooling values); (b) the **OSES-sealer gate leg** benchmarked against that frozen-journal baseline (identical input set, decode manifest from `ocdb_seal`), from Stage B onward. No third leg exists — there is no window where both sealers run.
- bytes compressed/sec, CPU, candidate-build allocations (heap delta, labelled approx);
- **commit duration** (post-compression txn) p50/p95/p99 — gate G8;
- WAL growth for insert-segment + delete-hot-rows, at default and alternate `wal_autocheckpoint` values;
- impact on concurrent durable-write p99 (the "UI active while sealing" workload);
- startup catch-up with 1 / 10 / 100 / 1000 eligible aggregates (gate G7);
- checkpoint stall duration (max observed).

---

## 7. Acceptance gates with hard vetoes

### 7.1 Pre-registration rule

All numbers below are **[PROPOSED]** and are **pinned in `bench/gates.json` at corpus-v1 time, before the first gate run** (research §29.8 "do not freeze a percentage target until a representative corpus exists… record the proposed threshold before running it"). A gate may be amended only with a written, dated justification recorded next to the pinned value; silent post-hoc loosening is treated as a failed process.

### 7.2 Gate list

| Gate | Metric | Proposed target (to pin at corpus v1) | Measured via |
|---|---|---|---|
| **G1 correctness parity** | differential/fuzz divergence (IDs, seq, replay order, duplicate/divergent-replay behavior, projector state, **syncHistory ordering incl. append-ordinal tie-break**, hard-delete) — extended to the **three-home differential** (TEXT / OCDB-frame / OSES sealed-with-refs): rehydrated logical payloads must be `isDeepStrictEqual` across all three homes. **Byte-identity clause is contingency-typed** (adversarial-evaluation C3): byte-identical payloads on syncHistory hold **unconditionally only if original-span storage ships** (adversary strengthening #1); if the sealed-event contract is canonical-equivalent instead, the gate asserts logical equality for sealed events and byte-identity only for canonical rows. **This decision must be made before gates.json pins** | **0 divergence** (logical, always); byte-identity per the sealed-event contract decision | differential harness (§31.2) |
| **G2 cross-runtime golden bytes** | Node↔Bun, **two tiers** (per codec-arch measurement — byte-identity holds only for brotli and dict-less zstd; `deflateRawSync` emits runtime-specific bytes, cross-decodable but not byte-identical): (a) **cross-decode logical equality — mandatory for every shipped codec/dictionary ID**; (b) **byte-identity fixture equality — asserted only for codecs whose manifest claims byte-identity** (deflate fixtures assert logical equality only, or they flake on any Electron Node patch bump) | (a) exact logical equality; (b) exact byte equality where the codec manifest claims it | golden vectors (§31.1), both directions |
| **G3 active-write p95/p99** | foreground durable-write tail vs legacy baseline, same corpus/run. Hot writes are identity + ref-free by construction (dedup is seal-time only), so the active-write gate is unchanged by value-dedup; **rehydration cost is measured separately in the read gates, not buried in the write gate** | **p95/p99 ≤ +5%**; waived only if absolute latency is negligible (<2 ms) *and* explicitly accepted | interleaved A/B, S1 |
| **G4 cold point-event p99** | point read by (aggregate, seq). **Aligned to the landed readpath.md resolution (R2 pass):** the primary pin is **S2 (warm-OS)**; **S3 is reported secondary**; **S4 (<2 ms) is the real cold guarantee**; reference-hardware-first ordering (§7.3) applies. **Scoped by logical payload class (adversarial-evaluation-r2 NEW-R3):** the primary pin applies to **small-logical-payload point reads**; the **byte-king class (≥64 KiB logical payload — message.updated/session.updated post-dedup materialize 3.2 KB–548 KB)** has a documented separate budget (bounded by logical size; jumbo carve-out extended to ≥64 KiB). Option (b) — a per-event stored logical digest + digest-first replay-idempotency fast path (corpus D10, format decision in the uncompressed index region, adversarial-optimization O1) — is a **gated optimization**: it is a semantic change to the replay fast path, must be covered by G1 differential, and ships only if the byte-king point-read budget proves unpassable at D7 | small-logical class: **< 500 µs p99 S2** / **< 2 ms p99 S4**; byte-king class: separate documented budget (pin at D7); range class: G5 governs | reference-hardware profile (§7.3) + cold-chain measurement before pinning |
| **G4b point-read amplification** | `A_r = decoded_bytes / requested_logical_bytes` (§16.1) at chosen geometry. Per oses-arch, microframe independence is *not* a point-read-latency mechanism (frame_count=1 is legal) — A_r is reported as a **corruption-blast-radius / cache-granularity metric**: decoded unit ≤ microframe stored size is the containment bound; the latency guarantee is G4's absolute p99, not A_r | decoded unit ≤ microframe stored size (containment); A_r reported per geometry | codec counters |
| **G5 range/replay parity** | range read + full-aggregate replay p99 vs legacy | **≤ +10%** (better allowed); replay scan must not evict the interactive working set (§31.9) — the sealed-with-refs replay path adds **value-cache reads** (value cache keyed `(aggregate_id, value_id)` kills the 1,284× repeat BLOB reads); rehydration cost must not push replay beyond the bound | interleaved A/B, S2/S3 |
| **G6 storage reduction** | event-subsystem bytes, whole-DB bytes vs **both** baselines on mature corpus: (a) raw-JSON legacy (what a clean v1.18.18 DB holds — the true product value), (b) fork-framed legacy (current openfork state — the marginal gain). The two numbers are reported side by side, driven by the framing census. **Projection clause (R3 O4 posture flip):** `message.data` is large (mirrors the byte-king class; OPCL-on-message ~0.06 ≈ 16×), so the projection reduction is gated too — sized by D1, not treated as a possible no-op. **Floor-by-design (adversarial-optimization "conservative G6" flag):** these are minimum-acceptable floors pinned pre-measurement; the R3 ceiling hypothesis (event subsystem ~94–97%, whole-DB ~90–93%, pending D2/D3/D7) does **not** raise the floor — a raising amendment requires the D2/D3/D7 evidence plus a written justification per the §7.1 amendment rule. Gates must be passable on the real corpus, not on a hypothesis | event subsystem **≥ 60%** vs raw baseline (≥ 35% vs framed baseline, [PROPOSED]); whole DB **≥ 25%** vs raw (≥ 10% vs framed, [PROPOSED]); projection reduction per D1 sizing; no per-class config > 1.15× legacy (unless explicitly accepted) | snapshot `dbstat` comparison + framing census |
| **G7 startup catch-up** | catch-up sealing of 100/1000 aggregates | no interactive-write p99 impact > 5% during catch-up; catch-up completes within the product threshold (proposed: < 60 s for 1000 aggregates) | prod-path + sealing bench |
| **G8 sealer commit** | post-compression commit duration | **p99 < 10 ms**; no unbounded WAL | sealing bench |
| **G10 corrupt-frame fail-closed** | decode of corrupted/truncated frames — **extended to missing/corrupt value refs**: a `value-ref` whose `event_value` row is missing or whose guard fails must fail closed (never synthesize); bounded allocation. **Contingency (adversarial-evaluation C1):** if the per-value integrity tag (first-8-bytes/crc32 in the ref list, compared before splice) ships, the fault suite adds the tag-mismatch case | deterministic bounded-time failure (no synthesized different event; bounded allocation) | §31.5 mutation suite, timed + value-table fault injection + tag-mismatch case |
| **G11 seal-CPU-contention** (adversarial-evaluation B3; **aligned to readpath.md §8.1 — single definition, R2 NEW-R6**) | interactive render/message read p99 **and** model-token inter-arrival while a seal pass is running, on a 4-core reference machine — G8 covers commit duration only, not the build path (parse+hash+walk+double-stringify CPU in the same process as the model stream; no OS-level nice on Electron). **One number wins: <1% read p99 regression on every listed op + token inter-arrival <1%** — the "never affects the user" directive is the harder, honest expression (G7's 5% is the write-side gate, a different victim) | read/render p99 regression **< 1%** and model-token inter-arrival **< 1%** while seal pass runs | prod-path + sealing bench, concurrent-seal instrumentation |

**G9 migration/rollback gates** — defined by migration-arch (`docs/chunkdb/ideation/migration.md` §10.1), hosted here and pinned in `gates.json` at corpus v1. Harness contract: the runner supplies (a) the **pre-cutover frozen RAW-JSON legacy snapshot**, (b) the **post-cutover OSES snapshot**, and (c) the **logical op-stream**; **kill-sweeps run only on file copies** (never the working corpus). Kill points are enumerated as `K<gate>-<n>` statement boundaries (migration.md §10.2, e.g. G9.2's mid-flip window `K9.2-4` and post-COMMIT `K9.2-6`); the maintenance passes expose `STORAGE_FAULT_KILL=K9.x-n` crash-injection hooks so the harness interleaves kills at real statement boundaries — the same hooks serve the fork's §31.8 fault suite. Gate rows reference their kill points directly; ready to freeze at corpus v1. Gates:

| Gate | Metric | Proposed target | Veto linkage |
|---|---|---|---|
| **G9.1 shadow-backfill resumability** | kill at every chunk boundary + mid-chunk | zero duplicate shadow rows; shadow == legacy by count/id/seq/type/crc | — |
| **G9.2 epoch-flip atomicity** | kill-sweep over the flip-tx statements | exactly one epoch readable; no committed event lost | trips **veto #2 crash corruption** |
| **G9.3 reverse-export correctness** | reverse-export vs the frozen **RAW-JSON** legacy snapshot (reverse export emits plain JSON TEXT, never frames — so this compares against the raw leg of the dual-baseline G6, not the fork-framed leg) | byte/logical equality + `PRAGMA integrity_check` + `foreign_key_check` + FTS row counts | — |
| **G9.4 reverse-export resumability** | kill mid-export | verification rejects partial export; flip-back atomic | — |
| **G9.5 reclaim idempotency** | replay reclaim after kills | idempotent (re-run converges, no orphaned rows) | — |
| **G9.6 old-client boundary** | old binary opens a post-cutover DB | documented failure mode (cannot fail closed — release-policy protected per migration-arch) | — |

### 7.3 Reference hardware definition

[UNRESOLVED → PROPOSED] "Reference desktop hardware" must be pinned or the absolute gates (G4) are unactionable. Recommend: (a) a documented reference profile (mid-2020s laptop: 8-core, 16 GiB, NVMe) with the full spec captured in provenance, and (b) an always-identical CI container (pinned image, known CPU flags) whose cold numbers are authoritative. Gates that are CPU-absolute (G4) run on the CI container; relative gates (G3/G5/G7) are CI-relative.

### 7.4 Hard-veto list (any one trips the whole gate review — not negotiable)

1. **Exact replay break** — any divergence of event ID, sequence, type, or logical payload between legacy and OSES on the differential corpus (including divergent-replay *error* behavior — errors must match too).
2. **Crash corruption** — a killed process (kill at every statement of seal/cutover, §31.7/31.8) leaves a DB that fails `PRAGMA integrity_check` or loses a committed event.
3. **Unsupported runtime API** — any shipped format, codec, or dictionary ID that the packaged Electron/Node (24.15) or Bun runtime cannot decode; or a dictionary ID that decodes to garbage without a hard reject (§17.7). Experimental zstd is capability-gated with a stable fallback; the fallback bytes must match the golden fallback.
4. **Pathological write amplification** — hot-tail append amplification > 8×, or WAL growing without bound during sealing/checkpoint at the configured `wal_autocheckpoint` (research §29.8 "no unbounded WAL growth under sealing").
5. **Privacy-poisoned dictionary** — a release dictionary trained on unsanitized user content (§17.7 privacy rule). Distribution veto, not a perf veto, but it is a hard stop on the codec choice.

---

## 8. Packaged desktop vs Bun CLI path

[VERIFIED] Packaged desktop = Electron 42.3.3 → Node 24.15.0 (`node:sqlite`, `node:zlib` with experimental Zstd); CLI = Bun (`bun:sqlite`). [PROPOSED] Run the *identical* harness under both:

- **CLI path:** `bun bench/run.ts …` (current pattern).
- **Packaged path:** locate the shipped Electron executable and run the harness with `ELECTRON_RUN_AS_NODE=1 bench/run.ts …`, so codec-capability probing (`node:zlib` zstd availability, `node:sqlite` surface) matches the real product runtime exactly — never bench the interactive app.
- **Golden vectors both directions:** encode Bun → decode packaged-node → encode packaged-node → decode Bun, exact logical equality (G2). Vectors are committed fixtures, not generated at gate time.
- **Capability probe is part of provenance and of G2:** if the packaged runtime lacks zstd, zstd-gated configs must fall back and the *fallback path's* golden bytes are what the gate checks. The probe must include a **zstd-dictionary round-trip check**. **Authoritative measured row** (codec-arch, real artifact via `ELECTRON_RUN_AS_NODE=1`, Electron 42.3.3 → Node v24.15.0): Electron Node 24.15 **zstd-dict = OK and fail-closed** (applies the dict, byte-identical to Node v22 output, decompress-with-dict round-trips exactly, decompress-without-dict fails deterministically); **Bun 1.3.14 zstd-dict = BROKEN** (silently ignores the dict on compress; cannot decode a Node-written dict frame even with the dict — `ZSTD_error_corruption_detected`). **Intersection of writable codecs = no zstd-dict**, so a trained zstd dictionary is *not shipable today* (hard-veto #3/#5 trigger); **re-probe on every Bun release in CI** — if a Bun release passes the dict probe, the row flips and trained zstd dicts become gated-eligible. Deflate is byte-stable across Node versions (v22 → 24.15) but *differs from Bun* — the three-leg runtime matrix is what catches the Bun leg.
- CI matrix runs on every gate: `{bun CLI} × {compiled Bun binary (bun build --compile)} × {ELECTRON_RUN_AS_NODE packaged-node}` — the compiled Bun binary is a distinct leg because its runtime behavior (e.g. worker_threads support) can differ from the `bun` CLI, and the packaged desktop path must be the authoritative Node leg.

---

## 9. Provenance record

The runner writes a machine-readable block into every result file (extends §29.9; the §29.9 list plus the deltas below):

```text
run_id / timestamp
git commit (rev-parse HEAD) + branch + working-tree dirty flag
runtime: bun version | node version + process.versions
sqlite: sqlite_version() + PRAGMA compile_options
OS/hardware: platform/release, cpu model + cores, total memory, storage type (NVMe/SSD label)
DB pragmas: page_size, cache_size, journal_mode, synchronous, wal_autocheckpoint
corpus: id@version, manifest hash, row/event counts, logical bytes, class report
cache state: S1..S4 + forcing procedure used + cold-approx flag
sample counts / repetitions per op
parse/schema-decode-included: true
engine + geometry + codec/dictionary IDs
codec capability probe output
generator seed (if synthetic class)
```

Results land in `bench/results/<run_id>.json`; a `compare.ts` renders delta tables. Every gate decision cites a result file — a gate assertion without a result file fails.

---

## 10. Infeasible or over-engineered items in the research doc

1. **"Bytes read from SQLite" per op (§29.2) is not obtainable** from `node:sqlite`/`bun:sqlite` at runtime. Must become: codec-layer decompressed-byte counters (runtime) + offline `dbstat` on frozen snapshots (analysis pass). [INFERENCE — high confidence; this is the single biggest methodology correction.]
2. **Full-accounting geometry grid is over-engineered** as stated (§29.5). ~1300 cells × all cache states × all ops is weeks of machine time. The two-stage screening/refinement (§5.1) delivers the same Pareto answer for a fraction of the cost. [INFERENCE]
3. **The 4-cache-state taxonomy is right but the forcing is underspecified** (§29.3): "cold OS cache" is only deterministically forceable on Linux with `drop_caches`. Windows (primary desktop target) needs the `cold-approx` labelling and Linux-container authority for absolute gates. [VERIFIED — platform capability; the doc's intent is preserved but the execution differs.]
4. **"Temporary allocation bytes / GC pressure" (§29.2)** is not cleanly measurable from JS without `--expose-gc`, and even then it is process-level. Report heap delta + retained-after-GC, labelled approximate, or drop it from gates (keep it in the ledger as informational).
5. **"Sub-millisecond absolute cold point target" (§29.8) is unactionable without a reference-hardware definition.** Pin a reference profile + authoritative CI container (§7.3) or the gate cannot be evaluated.

---

## 11. Open questions

1. **Corpus storage policy** — where do large (`real-sanitized-*`, multi-GiB) corpora live (URL-pinned store vs git vs local convention), and who approves release of sanitized corpora? (Coordinator decision needed; §2.5.)
2. **Reference hardware definition** — does the project accept a pinned CI container as the authority for absolute CPU gates (G4), with desktop machines only as relative evidence? (§7.3.)
3. **Locator coordination** — [RESOLVED] candidate set L0–L3 pinned with oses-arch (§5.3); new sub-question: **sync-ordering golden reproduction across sealed+hot** (oses-arch's open Q — exact `(seq, rowid/append-ordinal)` ordering across segment/hot boundary). The G1 syncHistory differential op is the vehicle; the open item is where the authoritative ordering golden vectors come from (real corpus cross-check vs constructed vectors) — corpus v1 should include a cross-check against a real multi-segment DB's ordering.
4. **Sanitizer ownership** — is the real-session capture/sanitize pipeline this lane's deliverable or shared with migration-arch's backup/restore tooling (a capture tool could serve both)? 
5. **Gate number freeze authority** — who signs off `gates.json` at corpus v1, and is the "negligible-latency waiver" (§29.8) an operator call or a swarm-decision call?
6. **Packaged-Electron zstd-dict probe** — [RESOLVED] measured on the real artifact (codec-arch, Node 24.15 in Electron 42.3.3): zstd-dict OK + fail-closed on the packaged Node; BROKEN on Bun 1.3.14; writable intersection = no zstd-dict; row flips if a future Bun release passes the dict probe. Capability matrix row is authoritative (§8); CI re-probes on every Bun release.

## 12. Concrete recommendations (recap)

1. Build the two-form corpus (logical op-stream + frozen legacy snapshots) with a committed small tier, a URL-pinned large tier, a sealed holdout, and per-class entropy budgets — before any schema change (research Phase 0).
2. Extend the existing `bench/` pattern into `bench/run.ts` (one process, three engines, raw-driver measurement, codec counters, interleaved A/B) plus `bench/prodpath.ts` for the semaphore-real production path.
3. Adopt the two-stage geometry sweep with Pareto-front + knee + per-class heatmap presentation and pre-registered tie-breaks.
4. Pin `bench/gates.json` (G1–G8, G10 numbers above) at corpus v1 and run gates in the Bun × packaged-Node CI matrix; enforce the five hard vetoes.
5. Fix the methodology deltas from §10 (offline dbstat for bytes-read, Linux-container cold authority, reference-hardware profile, heap-delta allocation labels) before the first authoritative run.
