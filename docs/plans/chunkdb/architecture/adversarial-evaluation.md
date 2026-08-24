# Adversarial Evaluation — chunkdb storage architecture (devil's-advocate pass)

**Author:** adversary, swarm `chunkdb-ideation` · **Date:** 2026-08-14
**Role:** adversarial evaluator — find what is wrong, weak, contradictory, over- or under-engineered, and propose ranked strengthening. No implementation code.
**Targets:** `architecture/{storage,contract,codec,migration,corpus}.md`, `ideation/{SYNTHESIS,event-destructuring-real-corpus,oses,benchmark,event-codec,adversarial-fork-prototype}.md`, `architecture-research.md`, blackboard `corpus/ground-truth-v2` + `architecture/read-latency-first`.
**Method:** every attack cites the claim it attacks; labels: [HOLE] [OVER-ENGINEERED] [PERF-RISK] [CORRECTNESS-RISK] [EVIDENCE-GAP] [STRENGTHEN]. Source claims re-verified against `../../../../packages/core/src/event.ts` and `../../../../packages/schema/src/identifier.ts`; one serialization claim tested empirically (Bun).

---

## 0. Verdict up front

The architecture is strong where it counts: corpus-first discipline, seal-time-only dedup, fail-closed replay posture, file-swap migration, the fork-sealer freeze ordering. It is also internally contradictory in exactly the places the coordinator's challenge targets — the splice invariant is weaker than claimed, the performance gates and the frame geometry are arithmetically inconsistent, and several "settled" decisions rest on the unrun D2/D3/D4 scans. The three most serious issues:

1. **The byte-exact splice invariant is not guaranteed for non-canonical historical rows, and the encode-side "guard" is vacuous** (compares a re-serialization to itself). The mechanism still works for the measured corpus, but the design's core correctness claim is conditional on an assumption it never checks.
2. **G4 (<500 µs cold p99) contradicts the design's own frame-decompression arithmetic** (32 KiB brotli ≈ 0.2–1 ms) — the gates and the geometry cannot both be right as written.
3. **The value table — the headline mechanism — stores its own largest residual footprint raw by decision** (heaviest session ≈ 1.25 GB distinct values uncompressed, where zstd/brotli hit ~0.042–0.061), leaving gigabytes of compressible bytes on the table it exists to eliminate.

The good news: every one of these has a cheap, concrete fix, and none of them invalidate the architecture's direction. The bad news: they must be resolved before `gates.json` is pinned at corpus v1, or the gates will be unpassable, vacuous, or both.

---

## A. ARCHITECTURE / DESIGN HOLES

### A1 [CORRECTNESS-RISK] The "byte-for-byte original JSON text" invariant is conditional — and the encode-side guard cannot fire

**Claim attacked:** contract.md §3.3 — *"the invariant is unchanged: parse input equals the original event JSON text byte-for-byte"*; codec.md §3.2 — *"Canonical serialization = the value as it leaves the existing toDriver path … the same code path that produced the corpus's 1,284× repeats already serializes deterministically"*; storage.md §1.3 — *"the re-serialized sub-value must hash to the stored sha256 … the check is a safety net that fails the seal, never corrupts"*.

**The problem:** the stored `event_value.bytes` are the sealer's *canonical re-serialization* of the extracted sub-value, not the original span bytes from the event row. The two are identical **only when the original row was produced by the same canonical `JSON.stringify` path**. I tested the round-trip in Bun:

```
"1e21"    -> JSON.parse -> JSON.stringify -> "1e+21"   (DIFF)
"1e400"   -> ... -> "null"                              (DIFF — value destroyed!)
"-0"      -> ... -> "0"                                 (DIFF)
"1.2300"  -> ... -> "1.23"                              (DIFF)
"emoji é中文"  -> SAME    "0.1,0.2" -> SAME    nested -> SAME
```

Rows written by *this* codebase's write path are already canonical (the insert stores `JSON.stringify(Schema.encodeUnknownSync(...))` — verified in `event.ts`), so the corpus's repeats are canonical and the splice is byte-exact **for them**. But the invariant is asserted unconditionally while it only holds conditionally:
- events written by other forks / older versions / hand-edited rows whose serializer emitted `1e21`, `-0`, or `1.2300` parse to the same object yet re-serialize to different bytes → the splice restores bytes the event never carried, silently;
- **the encode-side guard is structurally vacuous**: it compares the sealer's re-serialization against the sha256 of the sealer's own re-serialization. It can only fire on a table collision or non-deterministic serialization — never on the original-vs-canonical mismatch that is the actual risk. It is not a "safety net".

**Strengthening (cheap, decisive):** at seal time, extract the sub-value's byte span from the **original event TEXT** (a JSON tokenizer/walker mapping paths to byte spans — the codec.md §3.3 diff trick does this in *canonical* space; do it in *original* space), store the **original span bytes**, and make the guard real: `original_span_bytes == canonical_re-serialization(sub-value)` — on mismatch, store the original span bytes anyway (dedup still correct, byte-exactness preserved). This makes the invariant unconditional, keeps G1/G2 byte-identity gates passable, and costs one span-walker. Alternative (if the walker is deemed too costly): **explicitly downgrade the contract to "sealed text is canonical-equivalent, byte-exactness guaranteed only for canonical rows"** and drop byte-identity from G1/G2 for sealed events. Either way, *decide now* — it changes golden vectors.

### A2 [HOLE] The frame payload is a re-serialization, not the event's stored text — and the double-stringify is the sealer's real CPU cost

**Claim attacked:** codec.md §3.3 — *"locate each dedup candidate sub-value's byte range (deterministic: serialize parent, serialize parent-with-sub-value-replaced-by-null, diff the two byte strings)"*.

The span-detection operates on the sealer's **canonical re-serialization of the whole (elided) event**, so every frame payload in a sealed segment is a re-serialization — including ref-free events. Consequences the design does not state:
- **Reverse export / G1 byte-identity:** sealed event text emitted by reverse export ("plain JSON TEXT", migration.md §5.2) is canonicalized text, not the original bytes. Fine for canonical rows (A1); byte-different for anything else. G1's "byte-identical logical payloads" on syncHistory is therefore a conditional gate.
- **Sealer CPU:** the sealer already parses every event (for elision); span detection adds one full re-serialization of the parent per candidate path, plus the sub-value re-serialization for hashing — for a 24 MB summary event that is ~2 extra 24 MB string allocations per event, in the same process as the model stream. Async, but it is the dominant seal-CPU cost on the heavy session and must be in the B3 budget.

**Strengthening:** per A1 — keep original bytes where possible (copy TEXT for ref-free events; span-extract for ref'd). Also add "seal-path allocation per event" to the seal-cost ledger.

### A3 [HOLE] Per-aggregate scope is justified by an unmeasured assertion about cross-session duplicates

**Claim attacked:** storage.md §1.2 — *"the corpus evidence is per-session (diffs are session-specific — the correction doc notes cross-aggregate LZ doesn't help because diffs are session-specific)"*.

Two sessions were measured (`ses_0361b832`, `ses_01e19df4`). "Diffs are session-specific" is a plausible assertion, **not data**. Sessions in the same workspace/repo frequently share patch text (apply/revert, the same file edited in sibling sessions). LZ-not-reaching-across-sessions is a window argument, not an equality argument. The decision that matters — is there a material cross-aggregate duplicate byte class? — has no measurement, and the design has ruled out a global content-addressed table on the basis of it (plus real refcount-GC complexity, which is a legitimate reason).

**Strengthening:** add one cheap probe to the D2/D3 scan: a **bounded global hash histogram** across sampled aggregates in the same workspace. If the cross-aggregate duplicate byte share is < ~5%, per-aggregate is confirmed; if it's material, a global table with refcount GC becomes a v1.1 item with evidence. Cost: one pass over the already-streamed hashes.

### A4 [HOLE] The value table stores its largest residual footprint RAW — the headline mechanism leaves gigabytes on the table

**Claim attacked:** storage.md §1.1 — *"bytes is stored raw (uncompressed) in v1 … raw bytes make decode a memcpy-splice with zero decompression"*; open Q4 — *"The corpus's heaviest session ≈ 1.25 GB distinct"*; codec.md §3.5 (per-entry compression) is parked as a later tweak.

1.25 GB of distinct git-diff values at the measured 0.042–0.061 (zstd l1 / brotli q1 on diff-shaped text, codec.md §2) → ~50–75 MB compressed. The entire migration exists to shrink an 18 GB DB; leaving the headline mechanism's own table raw is a self-inflicted 10–20× residual on the second-largest byte class (after raw history).

**The read-latency objection is already answered by the design itself:** the value cache (LRU keyed `(aggregate_id, value_id)`, contract.md §3.2) means a value entry decompresses **once per value per cache residency**, then the 1,284× splice is memcpy. Decode-side sha256 is *not* re-hashed on read anyway (storage.md §2.2), so the "raw = memcpy" argument buys one decompress on the first touch of each value and nothing after.

**Strengthening:** compress `event_value.bytes` with the existing OCDB envelope (brotli q1 default, raw when the worth-it guard fails), **sha256 stays over raw bytes** (dedup key unchanged), decode = one decompress per cache miss. Size-tier: raw below ~64 KiB, compressed above. Gate on D2/D3 distinct-value distributions, but flip the default direction — raw-in-v1 is the wrong default for an 18 GB target.

### A5 [HOLE] "Pure-ref frames skip compression" contradicts codec.md §4 — and the point-read reasoning is wrong

**Claim attacked:** storage.md §4.2.3 — *"pure-ref frames skip compression … point reads on the deduped class are nearly free regardless of frame size"*; vs codec.md §4 — the post-dedup worth-it guard *"compress nearly always wins"* on shell content.

A 16–32 KiB frame of `message.updated` shells (path/tokens/ids + `null` markers) is repetitive JSON that brotli crushes ~20–40× (to ~1–2 KB stored). **Skipping compression stores 16–32 KiB where brotli stores ~1–2 KB.** And the point-read benefit the storage chapter claims comes from the *stored* frame being small — which requires *compressing*, not skipping (decompress of 1–2 KB ≈ tens of µs). The two architecture chapters directly contradict each other; the instruction to skip is the wrong one.

**Strengthening:** delete the skip instruction. Shell frames compress; the codec.md §4 post-dedup worth-it guard is the single source of truth (it naturally keeps a genuinely tiny frame raw via MIN_GAIN).

### A6 [OVER-ENGINEERED] Microframe machinery is v1 complexity for a policy the sweep is likely to reject

**Claim attacked:** oses.md open Q1 — *"Does microframe independence survive the real-corpus sweep?"* — while the format (frame directory, per-frame codec override, per-frame CRC, per-event frame-ordinal mapping, RLE type runs) is specified in full.

Under read-latency-first, decompression cost is bounded by **frame size, not frame count**: a single-frame 32 KiB segment decompresses in the same ~0.2–1 ms as a 32 KiB microframe (B1). The stated benefits of microframes — corruption containment granularity and cache granularity — must be quantified against a blast radius that is already bounded at one *per-aggregate* segment (no cross-session damage). The frame_count=1 policy cell is already first-class in benchmark.md §5.1; the honest position is that the **multi-frame machinery is the D7 question, not the v1 answer**.

**Strengthening (the biggest honest cut):** keep the `frame_count` format field (so the sweep can flip the policy later without a format change), ship v1 policy = **frame_count=1** at the locked 16–32 KiB frame size, and defer the frame-directory/RLE/per-frame-override machinery to D7. This removes real implementation and golden-vector surface from v1.

### A7 [HOLE] JUMBO_PROMOTE-on-first is insurance that costs bytes when it doesn't recur — worse under A4

**Claim attacked:** storage.md §1.2 — *"JUMBO_PROMOTE ≥ 1 MiB (promote-on-FIRST … a wasted 1 MiB+ row is cheap insurance vs a 24 MiB inline first copy)"*.

Under raw-in-v1 (A4), a never-recurring 24 MB diff becomes a 24 MB **raw** value row + a ref, instead of a 24 MB inline frame copy that would compress ~16–24×. The insurance then has *negative* byte value on one-offs: same bytes stored, plus a table row and ref-list entry. D3's "first-copy waste fraction" is exactly the measurement this needs — gate promote-on-first on it, and under A4 the waste is strictly larger.

---

## B. PERFORMANCE (read-latency-first is load-bearing)

### B1 [PERF-RISK] G4 (<500 µs cold p99) contradicts the design's own frame-decompression arithmetic

**Claims attacked:** corpus.md G4 — *"cold point-event p99 < 500 µs S3"*; storage.md §4.2.1 — *"32 KiB of brotli ≈ 0.2–1 ms on desktop hardware"*; read-latency-first §4 flags the geometry conflict but the numbers were never reconciled.

The cold sealed point-read chain is: metadata B-tree lookup + BLOB B-tree lookup + ~8-page BLOB read + brotli-decompress 32 KiB (0.2–1 ms) + splice + JSON.parse + schema decode. **The decompress step alone exceeds the entire G4 budget at the design's own frame size**, before any B-tree or I/O is counted. Either the gate, the geometry, or the cache-state definition is wrong.

**Strengthening:** resolve the triangle explicitly before corpus v1 pins `gates.json`:
- (a) define G4 on warm caches (S1/S2) → then it is not a "cold" gate, say so; or
- (b) add a **two-tier frame policy** as a first-class D7 geometry dimension — small frames (≤8 KiB) for point-read classes (replay idempotency, ID lookup), large frames for the range/replay classes (the read-latency-first constraint §4 already demands this reconciliation); or
- (c) raise the cold gate to ~2 ms (the S4 number) with the reference-hardware profile pinned (corpus.md §7.3 is UNRESOLVED — see D4).

### B2 [PERF-RISK] Segment-scoped value preload is wrong for point reads — memory blowup bound is missing

**Claim attacked:** read-latency-first §5 — *"load a segment's referenced values once per segment first-touch into a segment buffer"*.

A segment of ~200 events can reference up to ~200 **distinct** values, each up to 24 MB (the heavy session's measured distribution, storage.md §5). Eager preload on first-touch means a single point read into one segment can pull **gigabytes** into memory to serve one event's splice. Eager preload is correct for *full-segment replay* (one load, then memcpy per event); it is catastrophic for *random point reads scattered across segments* (session open of a cold message, replay idempotency check).

**Strengthening:** lazy per-ref fetch on the point-read path (fetch exactly the `value_id`(s) the decoded event references), eager preload only when the caller is doing a full-segment replay, both behind the existing LRU value cache — plus a per-value cache admission cap so a 24 MB value is never cache-admitted wholesale without a policy decision.

### B3 [PERF-RISK] "Seal never affects the user" has two unclosed holes: commit-connection ambiguity and ungated CPU contention

**Claims attacked:** oses.md §6.2 — *"BEGIN IMMEDIATE on the shared connection (or own connection w/ busy retry)"*; storage.md §6 — *"COMMITTING (BEGIN IMMEDIATE)"* (connection not pinned); migration.md §3.2 — *"JSON.parse+hashing of 18 GB ≈ 1–3 min CPU"*.

- **Commit connection:** if the sealer's COMMITTING runs on the semaphore-serialized `Database.Service` connection (exactly what the fork's `ChunkSealer` does — the prior adversarial pass's I2), an interactive *write* can stall up to `busy_timeout = 5000 ms` behind a multi-MB value+segment commit. The migration lane's `withBackfillDb` second-connection pattern is the proven fix and is already in the codebase — **pin the sealer commit to its own connection** and remove the "shared connection" alternative.
- **CPU contention:** "JSON.parse + hashing of 18 GB ≈ 1–3 min CPU" runs in the same process as the model stream on the user's machine (no OS-level nice on Electron). The gates measure *write*-p99 (G7/G8) but nothing measures CPU starvation of the renderer/model stream while the sealer is hot. G8's <10 ms commit covers commit duration only, not the build path.

**Strengthening:** (a) pin sealer commit to a dedicated connection; (b) add a **seal-CPU-contention gate**: interactive render/message p99 (and model-token throughput where measurable) while a seal pass is running, on a 4-core reference machine; (c) budget the per-event parse+double-stringify+hash cost (A2) inside the sealer pacing controller.

### B4 [PERF-RISK] JSON.parse is the true read tax, and "cache bytes not objects" optimizes the wrong surface

**Claim attacked:** oses.md §8 — *"Cache bytes/frames, not parsed objects. JSON.parse cost dominates reads … parsed-object caching buys little"*; vs read-latency-first §8 — *"Possible decoded-event working-set cache (bounded) since the renderer re-reads the same messages repeatedly"*.

The app's *actual* repeated reads are the **projection rows** (`MessageV2.hydrate` re-renders the same message/part set on every scroll/refresh — verified: hydration reads `MessageTable`/`PartTable`, never events, contract.md §10.2). Those rows are not in OSES at all. The event frame cache serves replay/sync, which is *throughput*-bound, not the interactive hot path. The "bytes not objects" stance is right for the event domain and wrong for the projection domain — the two are conflated, and the cache budget is pointed at the less latency-relevant one.

**Strengthening:** split the cache story under the one budget: (a) event domain — bytes/frames (as designed, plus B1's geometry), (b) projection domain — a small decoded working-set cache keyed by message/part id, sized by the repeated-render hit rate measured at D1. This is the "cache shift to read acceleration" the constraint demands, aimed at the surface the renderer actually re-reads.

---

## C. CORRECTNESS / SEMANTICS

### C1 [CORRECTNESS-RISK] A "valid-but-wrong" value row is served to readers silently — the fail-closed posture has a read-path hole

**Claim attacked:** storage.md §2.3 / contract.md §4.2 — *"If it parses to a valid-but-wrong object, the replay isDeepStrictEqual path catches it; reads return the corrupted object only until integrity_check/event_value rehash audit finds it"*.

With a 1,284×-referenced value, one corrupt/truncated/tampered `event_value` row silently poisons **1,284 event reads** — the app renders wrong summaries with no detection, because reads don't re-hash (storage.md §2.2: "24 MB hashing per read is not a read-path cost"). "Never synthesize" is honored, but "never silently serve corruption" is not — the design trades fail-closed for fail-silent on the read path.

**Strengthening:** a **cheap per-value integrity tag** that is not a full sha256: store the first 8 bytes (or a crc32) of the value bytes in the splice-list entry (or as a column on `event_value`), and compare on read *before* splice. ~8 B/ref, ~zero cost, converts silent corruption into a detected fail-closed error. The "24 MB hashing per read" objection is dissolved: a truncated tag is not a full hash. (G10's fault-injection must add this case.)

### C2 [CORRECTNESS-RISK] Event-ID canonical detection accepts uppercase hex, but the packer re-emits lowercase — a byte-non-exact round trip for a valid historical ID

**Claim attacked:** oses.md §3.1–3.2 — canonical detection *"body[0..11] all hex"* (case-insensitive) vs decode *"format the u48 back to exactly 12 lowercase hex"*; research §22.5 — *"Decoder must reproduce the original byte-for-byte event ID string"*.

The generator emits lowercase (`toString(16)`, verified in `identifier.ts`). But the detector accepts *any* hex case, and an uppercase-hex historical ID (another fork, a hand-edited row, a different generator) would round-trip to **lowercase** — a different string — violating the packer's own hard requirement and the "never reject a valid historical database" rule (a non-canonical-but-valid ID silently rewritten).

**Strengthening:** canonical = `evt_` + **12 lowercase** hex + 14 base62; anything else takes the escape path. One-character change to the detection rule; add a golden vector with an uppercase-hex ID.

### C3 [CORRECTNESS-RISK] Replay correctness needs deep-equality, not byte-identity — the byte gates over-commit and will fight the invariant

**Verified in `event.ts`:** the idempotency check is `stored.id === event.id && stored.type === versionedType(...) && isDeepStrictEqual(stored.data, encoded)` where `stored.data` is the **JSON.parse of stored bytes** and `encoded` is the schema-encoded object. The design's byte-level splice invariant (contract.md §3.3) is *sufficient but not necessary* for replay — deep equality of the parsed objects suffices, for replay and for the wire (remote replay never sees refs — contract.md §4.1, correct).

The over-commit lands on G1 ("byte-identical logical payloads" on syncHistory) and G2 (byte-equality golden vectors): any non-canonical historical row (A1) makes the byte gates fail while logical equality holds. The architecture must pick one stance: (a) enforce original-span storage (A1) so byte-identity is real for all rows, or (b) downgrade G1/G2 to logical-equality for sealed events. **Do not leave the gates and the invariant in contradiction at corpus v1.**

### C4 [CORRECTNESS-RISK] `part.updated` is excluded from dedup on the wrong statistic

**Claim attacked:** ground-truth §5 + contract.md §6 — *"part.updated: 0% byte-identical-consecutive … never value-dedup candidates"*.

Dedup does **not** require consecutiveness — the 1,284× summary repeats are thousands of events apart (that's the whole point of the value table). The measured "0% consecutive-identical" statistic (monotonic streaming text) does not test the property that matters: **non-consecutive repeats**. The retry-replay class (`tool.input` repeated across a retry with a new output) is a plausible in-`part.updated` repeat that the ruleset currently excludes by type.

**Strengthening:** D4 must scan `part.updated` sub-values (`tool.input`, `tool.result`) for **non-consecutive** repeats before the exclusion is locked. If repeats are found, extend the extractor registry; if not, the exclusion is confirmed by the right measurement.

### C5 Quick audits — the rest of the mechanism

- **Event-ID packing:** verified against `identifier.ts` — hex is `(ts*4096+counter) mod 2^48` (top bits truncated), suffix = `chars[byte % 62]`; `62^14 < 2^84` so 84-bit packing is exact; zigzag deltas + escape correctly handle mod-2^48 wraparound and `descending()` NOTed clocks. Sound, modulo C2.
- **Elision:** the `sessionID` rule is genuinely provable (the publish path dies on `data.sessionID !== aggregateID` — verified in `event.ts`), per-event flags + versioned manifest are sound. The elide-vs-splice ordering (codec.md open Q4) must be pinned by golden vectors — flagged, not a defect.
- **`type_set`:** exact delta-varint set; read-time mapping through the `event_type` dict resolves old segment type names against current manifest keys — no false negatives at segment granularity. Sound.
- **Sync append-ordinal:** per-segment base + per-event rowid uvarint deltas reproduces the `(seq, ordinal)` tie-break (rowid = global append order, verified); the fork-sealer-freeze-before-Stage-B ordering correctly freezes `ocdb_seal` as the reverse-export manifest. Sound.
- **Value-table commit atomicity:** value rows + segment + hot-prefix delete in one txn (storage.md §6) means a reader sees a segment and its values together — the crash invariant holds. Good.

---

## D. CORPUS / EVIDENCE

### D1 [EVIDENCE-GAP] The 35–65% headline is N=2 extrapolated, presented as settled while its own measurement is unrun

**Claim attacked:** ground-truth §3 + storage.md §12 — *"aggregate exact-value dedup … ~35–65% event-subsystem reduction before compression"* (headline).

The band is [CALCULATED] from **two sessions** (50% on the 2.5 GB session, 98% on a small session) blended against a whole-DB type mix measured on *one* fork's live DB (89.9% of 1.3 GB = message.updated). What would falsify it: a mature DB where message.updated is a smaller byte share, or where version-multiplicity is lower (summaries written once and updated-in-place rather than re-carried). D2 — the bounded whole-DB dedup scan — is load-bearing for: the band itself, SIZE_THRESHOLD, JUMBO_PROMOTE, the `session.updated` path (open Q2), per-aggregate value_bytes caps, and the externalization gates. **The number is a hypothesis with N=2 mechanism evidence until D2 lands.**

**Strengthening:** label it as such in PLAN.md; freeze the value-table *schema* (correct — the scans depend on it) but treat every number downstream of D2/D3/D4 as provisional. This is the single most important question the corpus scans must answer (see report).

### D2 [EVIDENCE-GAP] Format shape is being frozen on scans that are load-bearing for its numbers

The `event_value` schema freeze for the D2/D3/D4 window is correct and necessary. But decisions already presented as settled rest on unrun scans: SIZE/JUMBO thresholds ("starting values", storage.md §1.2), zstd-l1-adaptive (codec.md §2 — measured on **synthetic** diff text, labelled a signal), the 16–32 KiB geometry lock (storage.md §4.2 — argued from event-codec.md's *synthetic steer* window-sensitivity curve, while **post-dedup frames are a different class**: shells + unique text, not steers), and the per-aggregate scope (A3). The architecture's own Rule 2 (dominant-byte-class check *before* design) is satisfied for summary.diffs but **not** for the geometry lock — no one has measured the post-dedup byte class's window sensitivity.

**Strengthening:** in PLAN.md, tag every locked *number* with its evidence class; only the format *shape* freezes.

### D3 [EVIDENCE-GAP] The rebuild is tuned to the pristine-TEXT easy case; the partially-framed hard case is under-measured

**Claim attacked:** ground-truth §6 (both measured DBs pristine) + migration.md §3.2 (rebuild estimates are TEXT-only: "source scan ≈ 10 s, JSON.parse+hashing of 18 GB ≈ 1–3 min").

Every *other* deployment (users who ran the fork's sealer for months) is partially OCDB-framed — the exact state the fork reality says exists (adversarial-fork-prototype: 126,715 framed rows on the prototype's test DB). For those, the rebuild loop adds `decompressFrame` per framed row, and the value extractor must run on decoded bytes while `ocdb_seal` is preserved as the reverse-export manifest (covered, oses.md §9.4). The missing piece: **rebuild/catch-up throughput numbers are pristine-only**; the D8 rehearsal must include a framed-input leg, or the Tier-M/L pacing constants are wrong for the population they'll actually serve. Also worth stating plainly: the file-swap needs ~26–30 GB free on the DB volume (migration.md §6) — a real user-visible gate; "refuse-and-prompt" leaves heavy users unmigrated. The disk formula + §6.1 estimator are the honest mitigations; pin them at D8.

### D4 [EVIDENCE-GAP] G4 is unactionable until the reference-hardware authority exists — and it interacts with B1

corpus.md §7.3 marks the reference-hardware definition UNRESOLVED, yet G4 is an absolute (µs) number. Combined with B1 (decompress alone exceeds the budget), the absolute gates cannot be pinned at corpus v1 until (a) a reference profile + Linux-container authority exists, and (b) the full cold chain is measured at the design's own frame size. Pin the hardware first, then the number — in that order.

---

## E. STRENGTHENING PROPOSALS — ranked

Ranking = (impact on correctness/perf/simplicity) × (probability it matters on the real corpus).

| # | Proposal | Attacks | Impact | P(matters) |
|---|---|---|---|---|
| 1 | **Store original span bytes + make the encode guard real** (span-extract from original TEXT; guard = original span == canonical re-serialization; on mismatch store original bytes) | A1/A2/C3 | Makes the byte-exact invariant unconditional; keeps G1/G2 byte gates passable; removes the vacuous guard | Med (corpus is canonical) — but near-zero cost, and the current state is a false invariant |
| 2 | **Compress `event_value.bytes` with the OCDB envelope (raw below ~64 KiB); sha256 stays over raw bytes; value cache absorbs decode cost** | A4/A7 | Likely the largest byte win after dedup itself (1.25 GB → ~50–75 MB on the heavy session) | High — measured diff-text ratios are strong |
| 3 | **Reconcile G4 with frame decompression; add two-tier frame policy as a D7 dimension** | B1/D4 | Gates stop contradicting geometry; point-read budget becomes honest | High — arithmetic contradiction, certain to bite |
| 4 | **Lazy per-ref value fetch for point reads; eager preload only for full-segment replay; per-value cache admission cap** | B2 | Kills the gigabytes-of-preload blowup on scattered point reads | High — heavy session's value distribution makes the blowup real |
| 5 | **Cheap per-value integrity tag (first-8-bytes/crc32) in the ref list; compare before splice** | C1 | Closes the silent-corrupted-read hole at ~8 B/ref | Med — corruption is rare, but the 1,284× fan-out makes one corrupt row expensive |
| 6 | **Pin sealer COMMIT to a dedicated connection (kill the "shared connection" alternative) + add a seal-CPU-contention gate** | B3 | Closes the interactive-write stall (fork I2 inherited) and the ungated CPU budget | High — fork reality already hit I2 |
| 7 | **Ship v1 policy = frame_count=1; keep the format field; defer multi-frame machinery to D7** | A6 | Biggest honest cut: removes real v1 implementation + golden-vector surface | Med — open Q1 says the sweep may reject multi-frame anyway |
| 8 | **Add cross-aggregate + cross-layer duplicate-rate probes to D2/D3** | A3 | Evidence-gates per-aggregate scope and the deferred cross-layer dedup | Med — same-workspace sessions plausibly share patches |
| 9 | **D4 scans `part.updated` sub-values for NON-consecutive repeats before locking the ruleset exclusion** | C4 | Replaces a wrong-statistic exclusion with the right measurement | Low-Med — retry tool.input is plausible, unmeasured |
| 10 | **Decide the byte-identity-vs-logical-equality contract for sealed events NOW; fix uppercase-hex ID escape; align G1/G2 wording** | C2/C3 | One decision prevents a golden-vector rework and a gate that cannot pass | High — gates pin at corpus v1, this must precede |

**What to CUT:**
1. Microframe machinery from v1 (A6) — policy `frame_count=1`, keep the field.
2. The "pure-ref frames skip compression" instruction (A5) — compress them; the worth-it guard already decides.
3. Read-recency / `last_read` cooling tracking (read-latency-first §6) — a read-path write violates the no-hot-path-cost rule; the safety tail + frame cache already cover actively-viewed sessions. Measure first; don't build.
4. Tier B fingerprint locator — correctly deferred already; the verify-path cost model should stay a benchmark item, not v1.
5. Semantic elision beyond `sessionID` — correctly demoted; keep the manifest hook only.

**The single most important question the corpus scans must answer:**
> **What is the true whole-DB dedup elimination fraction and distinct-value byte distribution (D2) — does the 35–65% band survive a bounded whole-DB scan, and do the resulting SIZE_THRESHOLD / JUMBO_PROMOTE / value-table-compression / geometry decisions hold on the real distribution?** Every headline number in this architecture traces to that scan.

---

## F. Bottom line for the coordinator

The architecture's direction — per-aggregate exact-value dedup as the headline, seal-time-only, file-swap migration, corpus-first gating — is right, and the cross-lane convergence on the splice mechanism is genuinely good engineering. It is not ready to pin `gates.json` or write PLAN.md as-is, because three correctness claims are conditional, two performance gates contradict the geometry, and the headline mechanism leaves its own biggest residual footprint raw. All ten strengthening proposals are cheap relative to the migration they protect; #1, #2, #3, and #6 should be folded into the owning lanes before the executive plan is written. The D2/D3/D4 scans are not bureaucracy — on this architecture, they are the difference between a hypothesis and a claim.
