# Adversarial Review: the fork's ChunkDB prototype slice

**Reviewer:** coordinator, swarm `chunkdb-ideation`
**Targets:** `../../../../packages/core/src/database/json-codec.ts` (OCDB frame v2), `../../../../packages/core/src/database/chunk-sealer.ts` (sealer service), `packages/opencode/bench/chunkdb-*.ts` (bench/readpath/readlatency/parallel/worker)
**Branch:** `openfork`. **Status:** analysis only — no code changed.

This is a deliberately hostile read of the fork's existing prototype: where it is genuinely better than the research doc, where it is worse than itself (internal inconsistencies), and — most importantly — the top runtime-performance and compression-effectiveness opportunities that the OSES/OPCL synthesis should harvest from it.

---

## 0. What the prototype actually is (verified)

| Piece | File | Facts verified |
|---|---|---|
| Codec | `json-codec.ts` | OCDB frame v2, 14 B header (`OCDB` magic, version, codec 1=zstd/2=brotli/3=deflate, rawLen LE u32, CRC32-of-decompressed LE u32); v1 (10 B, no CRC) still decodes; `THRESHOLD = 4096` **UTF-16 code units**; `RAWLEN_PRE_CAP = 128 MiB`; **identity `toDriver`**; `compressedJson` customType with `dataType() → "text"`; bitwise hand-rolled CRC32; brotli q1 default |
| Sealer | `chunk-sealer.ts` | Effect service `ChunkSealer`; eligibility = `seq <= event_sequence.seq AND owner_id IS NULL AND session.time_updated <= now-48h AND typeof(data)='text' AND length(data)>=4096`, `ORDER BY aggregate_id, seq LIMIT 128`; **one `db.transaction` per row**; `ocdb_seal` journal UPSERT keyed `(table_name, row_id)`; partial index `idx_event_seal_candidates` (measured 68× eligibility speedup); runs on the **shared Semaphore(1) `Database.Service` connection** |
| Bench | `chunkdb-bench.ts` | Same eligibility, but **one `BEGIN IMMEDIATE` per 128-row batch** (comment: "~100× fewer HDD fsyncs… this is a benchmark relaxation; the production sealer can use the same batching") |
| Parallel | `chunkdb-seal-parallel.ts` | `worker_threads` pool, **byte-balanced** chunks (16 MiB, not row-count — comment: giants clump in one worker otherwise), main-thread single-writer tx |
| Readpath | `chunkdb-readpath.ts` | 12 checks: readAfter/readAggregate/full-history/SessionHistory/message-page-hydrate/usage-json_extract/credentials-backfill/byte-identity/full frame audit (**126,715 framed rows** CRC+JSON ok)/corruption fail-closed/v1-decode/sync-history scan |
| Readlatency | `chunkdb-readlatency.ts` | raw-vs-sealed latency on the real DB; heavy aggregate `ses_0361b832` 2.5 GB raw → 273 MB sealed |

**The single most important finding:** the codec is **not wired into the schema** and the sealer is **not wired into production** (grep confirms zero usages of `compressedJson`/`ChunkSealer` outside their own files). `EventTable.data` is still `text({mode:"json"})`. So today the prototype is **bench-only** — if the sealer ever ran against a live DB, the real read path (`EventV2` → Drizzle `text({mode:"json"})`) would receive a `Uint8Array` and `JSON.parse` it as garbage. The read-path harness proves the *codec* works, but **no production code path ever calls `decompressFrame` on `event.data`.** This is the first and most important thing to fix, and it reframes every strength below: the prototype's merits are real but confined to bench territory until the wiring gap closes.

---

## 1. Where the prototype is BETTER than the research doc

These deserve explicit credit — the synthesis should keep them, not replace them.

1. **Real-DB evidence, not a 50-event sample.** The prototype was exercised against a DB with **1.37M event rows, a 2.5 GB raw aggregate (→273 MB), a 32.8 MB max row, and 126,715 framed rows**. The research doc's compression ratios were computed on a 23 KB reference corpus and flagged non-representative. The prototype's numbers, while not a formal gate run, are orders of magnitude more trustworthy as *evidence of mechanism*.

2. **Identity `toDriver` + background sealer is the correct hot/cold split, shipped as working code.** The research doc described this as a proposal; the prototype proves the hot path is perturbed **zero** by construction (hot writes byte-identical to today). This is the single design decision worth more than all the research doc's §20.3/§20.4 hot-tail speculation.

3. **The partial expression candidate index is a genuinely clever idea the research doc never mentioned.** `idx_event_seal_candidates ON event(aggregate_id, seq) WHERE typeof(data)='text' AND length(data)>=4096` — filtering *at the index level* instead of scanning 1.37M rows per batch (measured 8.9 s → 0.13 s, 68×). This is exactly the kind of pragmatic, measurable optimization the research doc's macro-architecture discussion skips.

4. **Byte-balanced parallel compression chunks.** The research doc's §20.16 said "benchmark inline vs worker" without identifying the real problem. The prototype found it empirically: row-count chunks let multi-MB giants stall one worker while others idle, so it splits batches by **bytes** (16 MiB). That's a real optimization insight.

5. **Fail-closed decode with pre-cap BEFORE decompress.** `RAWLEN_PRE_CAP` bounds allocation against a decompression bomb before calling `brotliDecompressSync`/`zstdDecompressSync` — the research doc §26.4 said "must," the prototype implemented it, with a 128 MiB cap (~4× the observed 32.8 MB max, defensible headroom).

6. **v1 frame backward compat.** 10-byte v1 frames (no CRC) remain decodable via the version byte. The research doc worried about format evolution abstractly; the prototype shipped a working compat path and a readpath check for it.

7. **A real journal + restore primitive.** `ocdb_seal` is a per-row audit trail and `restoreText` is a working undo path. The research doc's reverse-export section stayed a design; the prototype has the seed of it.

8. **Dormant-session cooling + settled-frontier + owner-null eligibility** is a sensible, implementable hot/cold boundary that respects sync/owner semantics (`seq <= event_sequence.seq AND owner_id IS NULL`) — better grounded than the research doc's abstract "safety tail."

---

## 2. Where the prototype is worse than ITSELF (internal inconsistencies)

These are self-inflicted: the bench already proves the better behavior, but the production-facing service doesn't use it.

### I1. Per-row transactions in the service; per-batch in the bench
`chunk-sealer.ts:96-108` wraps each candidate in its own `db.transaction(...)` (128 commits per batch). The bench (`chunkdb-bench.ts:228-249`) does one `BEGIN IMMEDIATE` per batch and its own comment says: *"One transaction per batch… ~100× fewer HDD fsyncs… This is a benchmark relaxation; the production sealer can use the same batching and keep the guarantee."* **The service is measurably worse than its own benchmark** — with `synchronous=NORMAL` and WAL, each commit is a WAL sync; 128 rows = 128 syncs. Adopt the batch tx (which also matches OSES's one-commit-per-segment design).

### I2. Shared connection instead of the fork's own proven second connection
`chunk-sealer.ts:39` takes `Database.Service` — the **same Semaphore(1) client** the interactive server uses. The fork already built `Database.withBackfillDb` (second connection, no shared semaphore) for the FTS backfill (`part_search_backfill`), yet the sealer doesn't use it. During a seal pass, every per-row tx contends with interactive reads on the one-permit semaphore. The comment celebrates the 68× eligibility speedup but the writes still serialize behind the app.

### I3. Re-prepared SQL per row
The service loop calls `tx.run(sql`UPDATE…`)` and `tx.run(sql`INSERT…`)` per row — SQL parse + statement build each iteration. The bench correctly uses prepared statements. Trivial fix, real cost at 126k+ rows.

### I4. No negative record for "examined, not worth framing"
`compressText` returns a `string` (skip) when a row is ≥4 KiB but incompressible (or under the 24-byte gain guard). The sealer does `if (typeof frame === "string") continue` and **never records that the row was examined**. The eligibility query is a *persistent* filter (`typeof='text' AND length>=4096`), so an incompressible 100 KB base64 row is re-selected, re-fetched, and re-compressed **on every pass forever**. On the heavy tail this is wasted CPU and I/O with no bound.

### I5. The bench's MAX_ROWS/pass cap vs the service's 5000
The service caps `MAX_ROWS_PER_PASS = 5000` and yields between batches — good. But combined with I1/I2/I3, a 126k-row backfill is 126k transactions on the shared connection before it even reaches the interactive-p99 story. The plumbing exists to do it right; it isn't used.

---

## 3. Runtime-performance weaknesses (ranked by expected impact)

### R1. The codec is dead code in the app — nothing reads frames through the real schema
**Impact: correctness, not just speed.** `EventTable.data` is `text({mode:"json"})`; `compressedJson` is exported but never attached to any schema column; `ChunkSealer` is never composed into a layer. The read-path harness bypasses Drizzle entirely (raw driver + manual `decompressFrame`). If a frame ever lands in `event.data` today, `JSON.parse(Uint8Array)` corrupts the read path silently. **Before anything else, either wire `compressedJson` (or an explicit decode at the `EventStore` adapter boundary) into the actual `EventTable` reads, or gate the sealer hard-off.** The OSES `EventStore` adapter (contract-arch) is the natural home for the decode; the prototype's codec is the payload layer it should call.

### R2. Hand-rolled bitwise CRC32 is the seal-pass hotspot
`json-codec.ts:63-72` iterates **8 bits per byte in JS**. On a 2.5 GB raw aggregate that is ~20 billion bit-ops, purely to compute a checksum that `node:zlib.crc32` produces natively and byte-identically (codec-arch verified identical output on both runtimes). Every sealed row pays this once at compress and once at every read. For the multi-MB tail this is a wall-clock cost before brotli even starts. **Swap for `node:zlib.crc32`** — same semantics, native speed, and it's already measured equivalent.

### R3. No size-tiered codec choice — brotli q1 on everything, including 32 MB jumbos
A 32.8 MB row at brotli q1 blocks a worker for ~1–2 s (the parallel bench's own comment) and, on the shared connection in the service, blocks the app. The prototype has three codecs and always uses the default. **Opportunity:** size-tier the choice — small rows (4–64 KiB) → brotli q1; jumbo rows (>1 MiB) → zstd l1 (byte-stable, faster, often comparable ratio) or **skip framing entirely if pre-compressed/incompressible**. The `RAWLEN_PRE_CAP` at 128 MiB is a bomb-guard, not a tiering policy.

### R4. Incompressible rows are re-attempted forever (I4) — add a skip record
Write an `ocdb_seal` row with `stored_bytes = -1` (or a `(table_name, row_id, attempted)` companion) when a ≥4 KiB row fails the worth-it guard, and exclude attempted rows from eligibility. This bounds total sealer work per row to one attempt — material on a DB whose tail includes base64 blobs, images, and already-compressed artifacts.

### R5. The 24-byte minimum-gain guard is not CPU-aware
`json-codec.ts:115`: `payload.byteLength + HEADER + 24 >= raw.byteLength → skip`. For a 4 KiB row that's ~0.6% threshold — fine. But it also governs a 100 KB row where brotli q1 costs ~1 ms of CPU to save 24 B. The research doc §20.15 is explicit: *"A 12-byte saving on a 16 KiB high-entropy frame is not worth decompression work."* The prototype never weighs CPU. **Make the gain threshold size-relative or codec-tiered** (e.g. require ≥1% for small, ≥0.1% for jumbo, plus an absolute floor), which also feeds the R4 skip-decision.

### R6. Unit mismatch between the gate and the guard
The eligibility gate uses `length(data)` = **UTF-16 code units**; `compressText` computes `raw.byteLength` = **UTF-8 bytes** for the worth-it guard; and the journal stores `candidate.data.length` (code units) in a column named **`raw_bytes`**. For astral-plane content (emoji, CJK tool output), code units < bytes, so a row can pass the 4096-unit gate yet be a byte-minnow — and the "raw_saved" ratio printed by the bench is code-units/bytes, a systematically biased number. **Fix: use one unit (bytes, via `octet_length` in SQL and `encoder.encode(...).byteLength` in JS) throughout** — gate, guard, and journal.

### R7. Eligibility re-scans from the top each batch (benign but wasteful)
The partial index makes the SELECT cheap, but because framed rows drop out of `WHERE typeof='text'`, the scan restarts at the lowest `(aggregate_id, seq)` each batch. Fine at 0.13 s/batch; not a priority — noted for the OSES sealer where per-aggregate cursors will replace this.

---

## 4. Compression-effectiveness weaknesses (ranked)

### C1. Per-row independence discards all cross-event redundancy — the ceiling
This is the structural limit, and it is why the prototype is a *payload codec* and not a *storage engine*. Resetting the compressor every row means:
- the 30-byte `sessionID` that appears in every payload of an aggregate is re-compressed per row (and the research doc measured it 100× in a 50-event sample);
- repeated JSON keys, provider/model strings, and repeated full-state snapshots (`session.updated` ×19) share **zero** window across rows;
- the research doc's shared-stream probe reached single-digit-% of original; per-row brotli q1 measured ~63–70% (§17.2).

The prototype's measured 2.5 GB → 273 MB on the heavy aggregate is dominated by the tool-output tail (large, individually-compressible text), which is exactly where per-row framing is the right tool. It captures **nothing** of the structural repetition that OSES segments + a shared dictionary + `sessionID` elision target. **Framing:** the prototype is the correct *payload layer inside OSES frames*; the segment layer (cross-row sharing, surrogate keys, elision) is the remaining 2–5× on structured history.

### C2. No semantic elision — the one provable rule is unused
`sessionID` is stored in every sealed payload even though the swarm proved it is derivable from the envelope (`commitDurableEvent` enforces `data.sessionID === aggregate_id`). The prototype doesn't strip it. Adding the elision rule (paths `["sessionID"]`, `["info","sessionID"]`, `["part","sessionID"]` with per-event elided/no-elision flags) removes the most-repeated per-aggregate string at zero semantic risk — the single cheapest compression win available, and orthogonal to the codec.

### C3. No dictionary — brotli q1 with a cold window every frame
Brotli in `node:zlib` does **not** accept a custom dictionary, so the prototype's default codec cannot use one. The cross-runtime-safe dictionary path (codec-arch) is **structural deflate + dict** (schema-only, byte-interoperable, not byte-identical) or **zstd + dict once the Bun bug is fixed** (gated). For short sessions and the first microframe of every aggregate, a structural dictionary is the difference between "cold LZ" and "schema-primed LZ." The prototype has no hook for it; the OSES frame header should reserve the `dictionary_id` field the fork's 14 B header omits (codec IDs 4–7).

### C4. No zstd-vs-brotli Pareto choice
Dict-less zstd l1/l9 and brotli q1/q4 are both byte-stable cross-runtime (codec-arch, measured). The prototype hardcodes brotli q1. The ratio/CPU Pareto knee between brotli and zstd is an open benchmark question the prototype never ran on its real tail. (Coupled with R3's size-tiering.)

### C5. Event-ID / aggregate / type routing bytes untouched
The prototype frames payloads but leaves `event.id TEXT PK` (26-char), per-row `aggregate_id`/`type` strings, and their B-tree index entries fully intact — the exact relational-entropy the research doc §1.2 quantified (~1,500 + 905 + 1,500 B in 50 events). Nothing in the prototype attacks this; that is OSES's job (packed IDs, type keys, surrogate keys in segment metadata).

---

## 5. What the synthesis should harvest vs discard

**Harvest into OSES/OPCL (keep, extend, wire):**
1. OCDB frame v2 as the payload frame format inside OSES (magic/version/codec/rawLen/CRC, v1-compat, pre-cap, identity `toDriver`) — frozen registry `1=zstd 2=brotli 3=deflate`.
2. Identity `toDriver` + background sealer as the only frame producer (hot-path-zero by construction).
3. The partial candidate-index trick, generalized per table (`idx_*_seal_candidates`).
4. Byte-balanced worker parallelism + batch commit (already proven in bench) — the sealer execution model.
5. `ocdb_seal` journal → `oses_seal` (add `segment_id`, keep `(table_name,row_id)` audit).
6. `restoreText` → seed of the reverse-export decode path.

**Discard / fix before reuse:**
1. **The wiring gap (R1) — highest priority.** No production read path decodes frames. The OSES `EventStore` adapter is where the decode must live; until then the sealer must stay gated off.
2. Per-row transactions (I1) → batch commit (bench already proves it).
3. Shared-connection writes (I2) → `withBackfillDb`-style own connection.
4. Bitwise CRC32 (R2) → `node:zlib.crc32`.
5. Code-units-as-bytes accounting (R6) → bytes everywhere.
6. No skip-record (I4/R4) → bounded sealer work.
7. brotli-only + no tiering (R3/C4) → size-tiered codec + dict hook in the frame header.
8. No elision (C2) → `sessionID` elision rule per the swarm's one-provable-rule decision.

---

## 6. The top optimization opportunities, consolidated

### Runtime performance
1. **Wire the decode into the real read path** (R1) — correctness first, unlocks everything.
2. **Batch transactions + second connection + prepared statements in the sealer service** (I1–I3) — order-of-magnitude on the seal pass, proven by the bench.
3. **Native CRC32** (R2) — near-free on the multi-MB tail.
4. **Size-tiered codec + skip-incompressible + CPU-aware gain guard** (R3–R5) — bounds worst-case sealer cost and jumbo read latency.

### Compression effectiveness
1. **`sessionID` semantic elision** (C2) — provable, zero-risk, removes the most-repeated per-aggregate string.
2. **Structural dictionary hook** (C3) — reserve `dictionary_id` in the OSES frame header now; ship structural-deflate-dict once benchmarked.
3. **OSES segment layer for cross-event sharing** (C1/C5) — the prototype cannot capture this by itself; it is the payload layer, and the 2–5× on structured history lives in the segment layer (packed IDs, surrogate keys, shared LZ window).

The concise verdict: **the fork prototype is the best thing the codebase has — but it is a well-measured payload codec with a bench harness, not a storage redesign; its own bench already knows how to do the sealer correctly; and its single greatest gap is that nothing in production reads what it writes.** The OSES/OPCL synthesis should absorb its envelope, its sealer execution model (fixed to match its own bench), and its journal — and add the three things per-row framing can never provide: cross-event compression, semantic elision, and routing-string elimination.
