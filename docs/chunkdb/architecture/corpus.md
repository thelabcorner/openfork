# Corpus Architecture & Measurement Discipline

**Author:** benchmark-arch (swarm `chunkdb-ideation`)
**Branch:** `openfork` (v1.18.18 fork). **Architecture chapter — corpus is the load-bearing center of the storage redesign.**
**Supersedes:** the corpus sections of `docs/chunkdb/ideation/benchmark.md` (§2) where they conflict; this is the architecture-level specification, the ideation remains the rationale.
**Related:** `docs/chunkdb/ideation/event-destructuring-real-corpus.md` (the canonical synthetic-model failure this protocol exists to prevent); `docs/chunkdb/ideation/SYNTHESIS.md` §5/§7; peer architecture chapters (`storage.md`, `codec.md`, `migration.md`, `contract.md`).
**Evidence labels** reuse the research-doc legend: [VERIFIED] / [MEASURED] / [CALCULATED] / [PROPOSED].

---

## 0. Why the corpus is the load-bearing center

Every quantitative claim in this architecture is a hypothesis until it is measured on a corpus that represents the production database. The 50-event reference DB cannot size anything (1,377,243 events exist in the sanctioned snapshot). More importantly, the **first measured use of a synthetic corpus produced a wrong design**: the coordinator's `event-destructuring.md` tuned a structural encoder + segment table against schema-built synthetic payloads and reached 0.043–0.051; the real 18 GB snapshot showed the dominant byte class is *full git diff patches* repeated across message versions — a class the synthetic streams neither contained nor tested ([MEASURED], `event-destructuring-real-corpus.md` §0/§1). The synthetic-model failure was not an anomaly; it is the *expected* failure mode when a corpus is not load-bearing.

The corpus therefore has four architectural roles, in priority order:

1. **Calibration target** — the real databases are the distribution source; every synthetic class must be validated against their measured statistics before it may inform a forecast.
2. **Decision evidence** — geometry/codec/locator/dedup choices are made from measured runs on corpus artifacts, never from opinion or from synthetic-only data.
3. **Regression gate** — acceptance gates (G1–G10, `gates.json`) run against frozen corpus artifacts; a gate assertion without a corpus id@version is void.
4. **Truth keeper** — the named-case registry of synthetic-model failures (this document §6.8) keeps the discipline self-correcting.

---

## 1. Tier model

Four tiers. Tier 0 is **referenced read-only**, never replicated into the repo; Tiers 1–2 are **frozen artifacts** with content-hashed identities; Tier 3 is diagnostic only.

| Tier | Name | Contents | Stored where | Can it size forecasts? |
|---|---|---|---|---|
| **T0** | Real sanctioned sources | the 18 GB snapshot + the live DB copy | `D:\opencode-backup\opencode-db-snapshot-20260812\` (referenced, read-only) | **Yes — the only authority** |
| **T1** | Real-derived corpora | sanitized subsets, frozen legacy snapshots, logical op-streams, class slices | committed small tier (`bench/corpus/`) + URL-pinned large tier | Yes |
| **T2** | Synthetic stratified classes | the ideation's class list, calibrated to T0/T1 stats | committed small tier | No (mechanism + regression coverage only) |
| **T3** | Mechanism/stress | 50-event ref DB, 25k expanded trace + entropy-injection, edge/MAX-VAL | committed small tier | **No — mechanism only** |

### 1.1 Tier 0 — real sanctioned sources [VERIFIED]

Two sources exist on the sanctioned machine (`D:\opencode-backup\opencode-db-snapshot-20260812\`, inspected read-only for this document):

| Artifact | File | Size | State |
|---|---|---|---|
| **S0.1 mature snapshot** | `opencode - Copy.db` | 16.75 GiB (≈ 18 GB decimal) | 1,377,243 events; frozen 2026-08-12; the mature-corpus authority |
| **S0.2 live copy** | `opencode.db` | 8.68 GiB | checkpointed (`-wal`/`-shm` empty at inspection); the moving reference, re-snapshotted on a schedule |

**Standing rules for Tier 0 (non-negotiable):**

1. **Read-only, always.** Every connection opens the file read-only (`node:sqlite` `{readOnly:true}` / `bun:sqlite` `new Database(path, true)`); `PRAGMA query_only=ON` is set after open. A read-only open never creates `-wal`/`-shm` against the source.
2. **No in-place mutation, ever.** Any pass that writes (sealer tests, kill-sweeps, migration experiments, VACUUM, framing) operates on a **temp clone** (`%TEMP%`/scratch volume). Tier 0 files are additionally write-protected at the filesystem level (read-only attribute) and hash-pinned in the registry (see §5).
3. **The snapshot is the authority; the live copy is the moving reference.** When the two diverge (they already do: 1.38M vs fewer events), every result names which source it used. The snapshot is re-frozen on a schedule or on significant drift; each freeze is a new version, never an overwrite.
4. **Bounded sampling on Tier 0** — see §4.

[VERIFIED] The 2.5 GiB raw single aggregate (`ses_0361b832bffeGGxp6fIfX6lXY8`, 6,866 events, `chunkdb-readlatency.ts`) lives inside S0.1 and is the canonical heavy-tail replay fixture.

### 1.2 Tier 1 — real-derived corpora

Produced from Tier 0 by sanctioned sampling/sanitization tools (the capture pipeline of the ideation, now given an architecture home). Each T1 corpus is one of:

- **`real-<class>-<n>`**: per-class slices of real sessions (e.g. `real-long-session`, `real-tool-heavy`, `real-jumbo`), selected by aggregate profile (event count, payload percentiles, dedup multiplicity) and frozen with a framing census (`class-report.json`).
- **`logical-<id>`**: the engine-agnostic logical op-stream (ordered storage operations: appends, projection writes, deletes, session-close markers) derived from a real session set — the input the legacy/OSES/OPCL harness ingests identically.
- **`legacy-raw-<id>`**: frozen legacy-format SQLite snapshots **rebuilt from the logical stream** (so `event.data` is plain JSON TEXT — the G6 raw-JSON baseline and G9.3 reverse-export comparison target), *distinct from* a raw capture of a fork DB whose `event.data` is already OCDB-framed.
- **`sanitized-<id>`**: release-quality corpora after the privacy sanitizer (identifier replacement preserving structure, content scrubbing) — the only T1 corpora allowed in shared/URL-pinned storage.

**Framing census is mandatory** on every T1 snapshot: per-table raw TEXT bytes vs OCDB-frame BLOB bytes, plus the preserved `ocdb_seal` journal where present (it is the reverse-export decode manifest and the OSES-sealer Leg-B baseline — see `benchmark.md` §2.1/§6 and `migration.md`). The census also records the **codec registry version (`1=zstd/2=brotli/3=deflate`, frozen/append-only) + startup capability-probe output at capture time**, so a census is reproducible and any (forbidden) registry renumbering would invalidate it loudly rather than silently (opcl-arch's reliance: the D1 tail census must be taken against the frozen registry — no renumbering after D1).

**Three legacy ingestion states** [VERIFIED, contract-arch + migration-arch]: (a) **pristine TEXT** — both measured DBs (S0.1 snapshot *and* S0.2 live copy) are pristine at last inspection (no `ocdb_seal`, no frames; `event.data` all plain JSON TEXT — this makes the file-swap rebuild the primary migration path, migration-arch `migration.md`); (b) **mixed TEXT/OCDB-frame** — possible on other/older copies where the fork sealer ran; (c) **OSES post-cutover**. The capture pipeline and the OSES backfill/reverse-export paths must handle all three; the **framing census is the per-artifact discriminator** that tells the harness which state it is ingesting, so pristine vs framed is measured per copy, never assumed. This supersedes the earlier assumption that the snapshot is fork-framed — it is not.

### 1.3 Tier 2 — synthetic stratified classes

The ideation's class list, now **calibrated to T0/T1 statistics** (the entropy budgets of §6.3):

`short` (<20 events) · `medium` · `long` · `reasoning` · `tool-heavy` · `jumbo-tool` (≥1 MiB tool output; both event history and large OPCL projection rows) · `code-patch` (large diffs, repeated paths) · `high-entropy` (pre-compressed text — the anti-cheat class) · `snapshot-replay` (repeated full-state chains; encodes compaction's keep-`state.output` behavior) · `retry-replay` (retry/repair/duplicate-ID/divergent-replay fixtures + noncanonical incl. bitwise-NOTed event IDs) · `multi-tenant` (many aggregates/workspaces interleaved) · `fork-schema` (with `part_fts`/`session_message`/`idx_message_provider_id` extension pressure).

**New since ideation — the `real-shape` calibration classes:** the coordinator's correction establishes that the *type mix* and *byte-class mix* of the production corpus are the calibration invariants. Tier 2 classes are therefore generated **against a measured target mix**: `message.updated` ~24% rows/~85–90% bytes with `info.summary.diffs`-dominated payloads, `message.part.updated` ~69% rows/~10% bytes (monotonic streaming text, 0% exact-consecutive duplicates), `session.updated` ~7% rows. A synthetic corpus whose type/byte mix does not match the T0 record is a *stress* corpus, not a forecast corpus — it gets an explicit label (§6.3).

### 1.4 Tier 3 — mechanism/stress

The 50-event reference DB (mechanism: harness validation, repetition inventory, exact ground truth 7/7/9/9 — never sizing), the 25k expanded trace with an **entropy-injection variant** (distinct-value diversification so it measures B-tree/index overhead rather than one session repeated), and edge corpora (MAX-VAL varints, jumbo >64 KiB singleton frames, empty payloads, noncanonical IDs).

---

## 2. The Tier-0 baseline record (calibration target)

Frozen from [MEASURED] analysis of S0.1/S0.2 (`event-destructuring-real-corpus.md` §1). This table is the calibration invariant every synthetic class and every forecast is checked against:

| Metric | Value | Why it matters |
|---|---|---|
| Event rows | 1,377,243 (snapshot) | 27.5k× the 50-event reference; the only real scale |
| Type mix (rows) | `message.part.updated.1` 68.6% · `message.updated.1` 24.2% · `session.updated.1` 7.1% · V2 steers 0.015% | **V1-heavy**; steer/snapshot classes the ideation over-weighted are ~7% |
| Type mix (bytes) | `message.updated` ≈ 85–90% of event bytes (live DB: 89.9% of 1.3 GB) | the byte king |
| Dominant payload field | `info.summary.diffs` — full git diff patches (`{"diffs":[{"file":…,"patch":"Index: …"}]}`) | arbitrary text, not JSON structure; LZ window cannot reach repeats |
| Byte-king size range | 3.2 KB (95% diffs) → 548 KB (100% diffs) → max 24 MB snapshot / 6.3 MB live | tail play at extreme scale |
| Version multiplicity | `message.updated` histogram peaks at v=3, tail to v=236 | every version re-carries the session's summary.diffs |
| Dedup elimination potential | ses_0361b832: 1,713 events → 225 distinct summaries (top multiplicity 1,284 → 50% of session bytes = 1.24 GB elim-inable); ses_01e19df4: 689 → 8 distinct (98%) | **the single highest-leverage elimination** — aggregate exact-value dedup. **Evidence class: PROVISIONAL (N=2 mechanism evidence)** — the 35–65% whole-DB band is [CALCULATED] from two sessions blended against a one-fork type mix; it is a hypothesis until D2's bounded whole-DB scan lands (adversary D1). No downstream number (SIZE_THRESHOLD, JUMBO_PROMOTE, value-table compression, geometry) is settled by it. |
| **Headline reduction target (R3 ceiling, adversarial-optimization LOS-4)** | event subsystem ~94–97%; whole-DB ~90–93% | **[HYPOTHESIS]** — the optimization-pass ceiling, pending D2/D3/D7; stated as the *headline target* while the acceptance gates (G6) stay conservative minimums. If the ceiling survives the scans it beats the G6 floor 3–4×; the floor is what the architecture must pass, the ceiling is what it should approach |
| `part.updated` duplicates | 0% byte-identical-consecutive (monotonic streaming text) | stays shared-window LZ territory, not dedup |
| Structural/elision effect | structural ≈ +2%, sessionID elision ≈ +0.2% on diff-dominated payloads | retract as headline mechanisms on THIS corpus; keep elision (free, provable) |
| Max raw aggregate | 2.5 GiB raw / 273 MB framed (`ses_0361b832…`) | cold-resume replay fixture |

**Consequences that flow into the other architecture chapters** ([INFERENCE]): (a) the storage architecture's `event_value` aggregate dedup table targets the measured duplicate class (oses-arch `storage.md`); (b) migration at 18 GB scale uses the size-gated shadow protocol, not the synchronous fence (migration-arch `migration.md`); (c) OPCL projection tail = large tool outputs, decided by the corpus's part-tail measurement (§7 D1), not by the median.

---

## 3. Corpus registry & layout

```
bench/corpus/
  registry.json            # the single index of every corpus artifact
  <id>/
    manifest.json          # id, tier, version, sha256, source, date, class-report hash
    <payload files>        # ops.ndjson | legacy.sqlite | frames | stats — tier-dependent
  gates.json               # pinned acceptance-gate numbers (G1–G10) — see benchmark.md §7
```

`registry.json` entry fields (schema is part of the corpus contract):

```text
id | tier | version | sha256 (of all payload files) | location (path | URL) |
source (S0.1 | S0.2 | generator+seed | none) | class-report hash | freeze date |
sample counts (rows/events/bytes, per class) | framing census hash | holdout: bool
```

**Rules:**
- A corpus id@version is **immutable**: payload hash is verified before every run; a changed hash is a new version or a failed run, never a silent mutation.
- **The harness never writes to a corpus** (generate-at-bench-time remains a veto); derived artifacts (temp clones, kill-sweep copies) live under the run's scratch dir.
- Small corpora (< ~10 MiB) commit to the repo; large T1 corpora are URL-pinned with hash verification; **Tier 0 is never in the repo** — only its registry entry + derived stats are.
- `holdout: true` marks the sealed real-sanitized corpus reserved for final acceptance; it is invisible to tuning runs.

---

## 4. Sampling discipline (read-only, bounded)

The corpus is measured, not mined. Every Tier-0/Tier-1 analysis pass obeys:

1. **Read-only open + `PRAGMA query_only=ON`**; no `-wal`/`-shm` creation against sources (verified: read-only opens in both drivers do not create them).
2. **Temp-clone rule**: anything that could write (VACUUM, `wal_checkpoint`, sealer passes, kill-sweeps, migration experiments, `dbstat` on a mutating DB) runs on a scratch clone on `%TEMP%`/scratch volume, sized by the harness, deleted after the run.
3. **Bounded scans**: aggregate-capped and page-capped queries with explicit limits; the big analyses (dedup sizing scan, full payload census) are **bounded aggregate samples** — the coordinator's §6.1 recommendation is the standing pattern — with the sample frame recorded in the result. An unbounded full-DB payload scan is permitted only on T1 clones, and only with a time/memory budget.
4. **Percentiles from length columns only**: retrieve `length(CAST(data AS BLOB))` (plus `octet_length` for UTF-8 economics — opcl-arch contract), never payload content, into analysis; content stays in the DB. Percentiles computed in the analysis script.
5. **Resource caps**: per-pass wall-clock and peak-memory budgets; a pass that exceeds its budget is failed and recorded, not silently truncated.
6. **Cold-state honesty**: absolute cold numbers run on Linux CI with `drop_caches`; Windows desktop runs are `cold-approx` (OS page cache cannot be dropped from userspace — [VERIFIED] platform fact).
7. **No content exfiltration**: reports carry counts/lengths/percentiles/hashes, never prompt/tool/credential content (research-doc privacy rule, retained).

---

## 5. Versioning

- **T0 snapshot freezes**: S0.1/S0.2 are re-frozen on schedule (proposed: monthly) or on ≥10% drift in (row count, event bytes, type mix). Each freeze = a new registry entry with its own sha256 + derived-stats record. Old freezes are never deleted (rollback/reproducibility: a gate decision cites the exact freeze).
- **T1/T2 versioning**: every artifact is content-hashed; generator versions are recorded (seed + generator commit) so a synthetic class is reproducible byte-for-byte.
- **Runtime-bump re-probes**: capability matrix rows (zstd-dict on Bun, codec byte-stability) and golden vectors are re-verified on every runtime bump and every Bun release — the re-probe result is a corpus-adjacent artifact (provenance, not corpus data).
- **Result provenance**: every benchmark result embeds the corpus id@version of every artifact it read (provenance schema in `benchmark.md` §9); a gate assertion cites result files, which cite corpus versions.

---

## 6. Measurement protocol — preventing synthetic-model failures

Eight rules. Rules 1–5 were in the ideation; rules 6–8 are new, written from the `event-destructuring` incident.

### 6.1 Rule 1 — corpus-first claim labeling
Every quantitative claim carries one of three labels, recorded in the doc or result that makes it:
- **population claim** — measured on Tier 0/1 (may size forecasts);
- **mechanism claim** — measured on Tier 2/3 (proves a mechanism exists; must not size forecasts);
- **hypothesis** — not yet measured anywhere.
A design change must be justified by a population claim for its *dominant* effect, with mechanism claims only for support. The coordinator's correction (§0) was the failure to apply exactly this.

### 6.2 Rule 2 — dominant-byte-class check (pre-design measurement gate)
Before designing any storage mechanism for a class, measure the class's **byte-class distribution on Tier 0/1** (which fields/values dominate bytes; which repeats; which is unique text). The `summary.diffs` finding is the standing example: LZ could not reach cross-version repeats, structural encoding was irrelevant to diff text, and only aggregate exact-value dedup captured the dominant class. **A mechanism designed without its class's byte-class measurement is not a design input.**

### 6.3 Rule 3 — calibration budgets for synthetic classes
Tier 2 classes must fall inside a band (proposed: ±30% relative) of the Tier-0 record on at least: type mix, repeated-string-value share, payload size percentiles, version multiplicity, and byte-class shares. A class outside the band is relabelled **stress** and excluded from forecast gates. This is the direct answer to "how do you keep a benchmark from being gamed with highly-repetitive synthetic data": the real distribution is the referee.

### 6.4 Rule 4 — frozen, pre-generated, holdout
Generate-at-bench-time is a veto. Corpora are frozen and hashed; the sealed holdout is reserved for final acceptance (details: `benchmark.md` §2.3).

### 6.5 Rule 5 — per-class reporting
Every storage gate reports per-class results; an aggregate winner that hides a class regression fails the gate (G6 hardens this: no per-class > 1.15× legacy).

### 6.6 Rule 6 — two-unit accounting where codecs are involved
Byte thresholds and tails are reported in **both** UTF-16 code units (the OCDB threshold gate, `length(data)`) and UTF-8 octets (`octet_length`, the economics) — opcl-arch contract, folded here so the corpus produces both in `class-report.json`.

### 6.7 Rule 7 — sampling frame recorded
Every measurement records its sample frame (aggregate count, row count, bytes, source, date, caps enforced). An undersized sample is reported as **underpowered** with the confidence limit, never silently promoted to population evidence.

### 6.8 Rule 8 — named-case registry of synthetic-model failures
A permanent log of every instance where a synthetic/model-derived claim was corrected by real data, appended with the correction. First entry, canonical:

> **Case 001 — `event-destructuring.md` (2026-08).** Structural-encoder + segment design tuned on schema-built synthetic payloads; claimed 0.043–0.051 and "semantic deltas dead." Real 18 GB snapshot: dominant class is `info.summary.diffs` (git diff patches), 40–70% whole-event-bytes elim-inable by aggregate exact-value dedup; structural encoding ≈ 2%. **Correction:** `event-destructuring-real-corpus.md`; design pivot to aggregate value table. **Rule invoked:** R1 (claim labeling), R2 (byte-class check), R3 (calibration).

New entries require: the wrong claim, the synthetic input, the real measurement, the rule(s) invoked, and the design consequence.

---

## 7. Corpus deliverables at v1 (the gating measurements)

The corpus v1 freeze must produce — each is a decision input to another chapter, and each is currently UNANSWERED by the 50-event reference DB:

| # | Measurement | Consumer | Decides |
|---|---|---|---|
| **D1** | per-`part_type` tail: rows ≥4 KiB and bytes ≥4 KiB (both units) + per-type percentiles; `message.data` ≥4 KiB share. **O4 posture flip (adversarial-optimization): `message.data` IS large** — it mirrors the byte-king `summary.diffs` (projection↔event duplication is the next byte class; OPCL-on-message at ~0.06 compresses ~16×) — so D1 is the **SIZE gate (how much)**, not the yes/no gate; plan for OPCL-on-message | opcl-arch | OPCL-on-message scale + G6 projection clause; per-type tail share of the projection byte class |
| **D2** | whole-DB dedup elimination fraction: bounded aggregate scan of `message.updated`/`session.updated`/`part.updated` distinct-value bytes vs total | oses-arch (storage.md) | `event_value` table scope + the v1 Pareto claim (40–70% blend) |
| **D3** | value-recurrence thresholds: at what serialized size / recurrence count the value table pays for itself per aggregate class | oses-arch | dedup promotion rule (~1 KiB + ≥2 recurrences is the hypothesis, not the law) |
| **D4** | scan for other repeated large sub-values (`info.metadata`, `tool.input`, `result`, …) | oses-arch | whether `summary.diffs` is the only such field |

**The D2/D3/D4 bounded scan must answer (oses-arch `storage.md` spec, schema frozen for this window):** (1) whole-DB elimination fraction — bounded per-aggregate scan of `message.updated` + `session.updated`, distinct vs total bytes; (2) distinct-value histograms **per path** (rule-set paths `["info","summary"]` per versionedType) → `SIZE_THRESHOLD` / `JUMBO_PROMOTE` (hypotheses: ≥1 KiB / ≥1 MiB); (3) other-path scan (`info.metadata`, `tool.input`, `result` — ≥1 KiB AND ≥2×?); (4) per-aggregate distinct-value byte totals (value-table size + the ≥4 GiB-aggregate externalization gate); (5) **first-copy waste fraction** — the single-occurrence rate among values that recur ≥2× (values stored once but referenced once only). It must also answer **whether `session.updated.1`'s `info.summary` repeats like `message.updated`'s** (7.1% of rows, same field path — oses-arch open Q2), and whether `event_value.bytes` compresses (raw vs brotli on git-diff text — open Q3 feeds codec-arch).

**Adversary-strengthening additions to the scan contract (adversarial-evaluation.md A3/C4/D1):** (6) **cross-aggregate duplicate-byte probe** — a bounded global hash histogram across sampled aggregates in the same workspace; per-aggregate scope is confirmed only if the cross-aggregate duplicate byte share is < ~5% (else a global content-addressed table becomes a v1.1 item with evidence — A3); (7) **`part.updated` non-consecutive repeat scan** — dedup does not require consecutiveness (the 1,284× repeats are thousands of events apart); scan `part.updated` sub-values (`tool.input`, `tool.result`) for *non-consecutive* repeats before the ruleset exclusion is locked (C4). The 35–65% whole-DB band and every threshold downstream are **PROVISIONAL until D2 lands** (D1). **Ownership split (codec-arch `codec.md` §11, no double-work):** D2/D3/D4 produce the *promotion thresholds* (SIZE_THRESHOLD/JUMBO_PROMOTE) and *distinct-value histograms* that codec-arch folds into `codec.md` §3.4; the *value-entry codec bench* (compress `event_value.bytes` — brotli q1 vs zstd-l1 on git-diff text), the *splice-offset fuzz*, and the *escape-tax confirm* are codec-arch-owned, consuming my D2/D3 histogram inputs. The dedup frame-worth-it guard is **post-dedup** (frame_stored+index vs refs+unique text; never pre-dedup sizes — codec-arch).
| **D5** | sealing cooling predicate: event-ID clock (`floor(clock/4096)`) vs `session.time_updated` correlation on T0 | oses-arch | frontier cooling rule |
| **D6** | sync-history ordering golden vectors: real multi-segment DB `(seq, append-ordinal)` ordering cross-check | contract-arch | sync-ordering reproduction across sealed+hot |
| **D7** | geometry + locator + codec sweeps (Pareto) on the real corpus — **including the adversary-mandated dimensions**: (a) **two-tier frame policy** as a first-class dimension — small frames (≤8 KiB) for point-read classes (replay idempotency, ID lookup) vs large frames for range/replay classes (B1/G4 reconciliation); (b) **post-dedup byte-class window sensitivity** — the geometry lock is currently argued from *synthetic steer* curves while post-dedup frames are shells+unique text (D2); the sweep must measure the real post-dedup class | benchmark-arch/oses-arch/codec-arch | segment/frame geometry (per-class), Tier A vs B locator, brotli-vs-zstd knee, G4-vs-geometry reconciliation |
| **D8** | 18 GB-scale migration rehearsal artifacts: pre/post snapshot pair + logical stream + kill-sweep clones — **plus the rebuild-cost measurement (adversarial-evaluation-r2 NEW-R8/R9): rebuild/catch-up wall-time measured on the packaged runtime**, not estimated from parse-rate alone; the span-walker runs 50–150 MB/s vs native parse 200–400 MB/s and walks the corpus twice, so the stale "1–3 min CPU" becomes "5–15 min CPU spread over idle windows" and feeds the Tier-M/L pacing constants. **Must include a partially-OCDB-framed input leg** (the population that actually ran the fork sealer; pristine-only numbers are the easy case), and record the disk-space decision (same-volume ≈26–30 GB vs cross-volume rebuild with build space anywhere + one-time swap move) | migration-arch | G9.x gates at scale; size-gate boundary (~25k/256 MiB) validation; Tier-M/L pacing; disk-space gate |
| **D9** | **value-dedup measurements** (contract-arch ask, extended per adversarial-optimization O2): dedup-unit/granularity sweep — **whole `info.summary` object vs per-diffs-entry vs per-patch** (which granularity maximizes elimination at minimum table overhead; per-patch is the compression-headline changer if whole-summary leaves ~50% of message.updated on the table); recurrence/size thresholds per aggregate class; ref-list overhead per event; and the **three-home rehydration differential** (TEXT / OCDB-frame / OSES sealed-with-refs) with rehydration cost + value-cache hit behavior on the 1,284× repeat class | oses-arch + benchmark-arch + codec-arch (splice fuzz) | dedup promotion rule, value cache sizing + admission cap, gates G1/G3/G5/G10 rehydration clauses, O2 gate |
| **D10** | **digest-first idempotency fast path** (adversarial-optimization O1; the only new R3 deliverable). **Proof protocol** (coordinator-routed): on the 1,284×-repeat session (T1), replay-idempotency-check p99 with fast path on/off + digest index bytes/event; G1 differential (identical idempotent/divergent outcomes in both modes across the three-home corpus). **The differential must include one signed-float vector (`-0`/`+0`/NaN-adjacent)** — the digest fast path replaces `isDeepStrictEqual`'s `-0`-sensitivity in the idempotent branch; the write path normalizes `-0` away (`getUsage`'s `Math.max(0,·)`) but `Schema.Finite` admits `-0` in principle, so one vector now is cheaper than a replay-semantics surprise after cutover (contract-arch §4.4 residual 3). The fixture exercises the JSON round-trips `-0`→`0` and `1e400`→`null`: the original-span storage + semantic guard must prove these do **not silently diverge across the three physical homes** (TEXT / OCDB-frame / OSES sealed-with-refs). **Acceptance:** idempotency-check p99 ≥ 10× faster, zero G1 divergence, digest ≤ 32 B/event avg, ≤ 5% replay-throughput regression. **Falsification:** any G1 divergence, or digest > 64 B/event. Format decision (digest in the uncompressed index region) is storage/readpath-arch's; the measurement is the corpus's | readpath-arch + benchmark-arch | G4 byte-king stance (option b), G1 semantic-change review, O1 rank |
**Evidence-class ledger** (adversary D2 — only format *shape* freezes; every locked *number* carries its evidence class, re-tagged as scans land):

| Number | Class now | Freeze status |
|---|---|---|
| `event_value` schema (aggregate_id, value_id, sha256, raw_len, bytes, refs) | **format shape** | FROZEN (D2/D3/D4 window) |
| frame format (OCDB envelope, splice refs, `frame_count` field) | **format shape** | FROZEN |
| 35–65% whole-DB dedup band | **provisional** (N=2, [CALCULATED]) | open until D2 |
| SIZE_THRESHOLD ≥1 KiB / JUMBO_PROMOTE ≥1 MiB | **hypothesis** | open until D2/D3 |
| 16–32 KiB geometry lock | **hypothesis** (argued from synthetic steer curves; post-dedup class unmeasured) | open until D7 (incl. two-tier policy) |
| brotli q1 baseline / zstd-l1 adaptive | **mechanism evidence** (synthetic diff text) + cross-runtime [VERIFIED] | byte-stability LOCKED; adaptive choice open until D7 |
| G4 cold point <500 µs S3 | **unactionable** until reference hardware + cold-chain measurement (D4) | open until hardware authority exists |
| per-aggregate scope | **provisional** (plausible assertion; cross-aggregate probe = scan item 6) | open until D2/D3 |

**Hardware-first ordering (adversary D4):** absolute gates (G4) are pinned in this order — (1) reference-hardware profile + Linux-container authority exists; (2) the full cold point-read chain is measured at the design's own frame size; (3) then the number is pinned in `gates.json`. Pinning a µs number before the authority and the measurement exists is a process failure, not a gate.

---

## 8. Cross-lane contracts

**The corpus provides each lane:**
- oses-arch/storage: D2–D5 measurements, real geometry sweep corpora, the 2.5 GiB heavy-tail replay fixture, dedup sizing evidence.
- codec-arch: golden-vector fixtures (per codec/dict ID with `byteIdentity` manifest), real payload samples for dict experiments (sanitized only), capability-reprobe corpora.
- migration-arch: frozen pre/post snapshots, logical op-streams, G9.3 raw-JSON baseline snapshots, kill-sweep clone policy (temp-clone rule §4.2), the 18 GB rehearsal pair.
- contract-arch: sync-ordering golden vectors (D6), real corpus for adapter differential runs.
- opcl-arch: part-tail/message-tail measurements (D1), per-type byte accounting.

**The corpus requires from each lane:** (a) oses-arch's `event_value` schema stability during the D2/D3 scan window (the dedup measurement must not race a schema change); (b) codec-arch's frozen registry (a codec renumber invalidates every framing census); (c) migration-arch's read-only backfill discipline (the D2/D3 scans are read-only against S0.1; any mutating pass uses the clone rule); (d) opcl-arch's two-unit accounting in its schema reads; (e) contract-arch's logical-level compare contract (never stored-byte equality across engines).

---

## 9. Open questions

1. **Corpus storage policy for large T1 artifacts** — URL-pinned private store vs local sanctioned path; who approves sanitized corpus release. (Coordinator decision; blocks shipping T1 beyond the committed small tier.)
2. **Snapshot re-freeze cadence** — monthly vs drift-triggered; who runs it and where the new freeze is registered.
3. **Sanitizer ownership** — the capture/sanitize pipeline: benchmark-arch's tool vs shared with migration-arch's backup/restore machinery (a capture tool serves both).
4. **Calibration band width** — ±30% relative on the §6.3 invariants is a proposal; corpus v1 should validate it against the T0 record before freezing.
5. **Reference-hardware authority** — the Linux CI container as the arbiter for absolute gates (G4), desktop as relative evidence (from `benchmark.md` §7.3, retained here as corpus-adjacent).
6. **`gates.json` sign-off authority** — who pins the gate numbers at corpus v1 and who owns the negligible-latency waiver.

---

## 10. Bottom line

The corpus is not a fixture collection; it is the **calibration and gate infrastructure** of the whole storage redesign. Tier 0 (the 18 GB sanctioned snapshot + live copy, referenced read-only, bounded-sampled, versioned by freeze) is the only authority for population claims; Tier 1 real-derived artifacts are the frozen, commit-able evidence; Tier 2 synthetic classes are calibrated against the T0 record or demoted to stress; Tier 3 is mechanism-only. The eight measurement rules — above all the **dominant-byte-class check** and the **named-case registry** — are what make a second `event-destructuring` incident structurally impossible rather than merely unfortunate. Every acceptance gate, geometry choice, and migration rehearsal traces to a corpus id@version; a claim that cannot say which corpus measured it is not a claim this architecture accepts.
