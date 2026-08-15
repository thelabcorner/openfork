# Product-API & Adapter Architecture (architecture phase)

**Author:** contract-arch, swarm `chunkdb-ideation`
**Phase:** architecture-planning (follows ideation; feeds coordinator `PLAN.md`)
**Supersedes:** `ideation/contract.md` where the value-dedup correction changes the design (it does — §2).
**Data authority:** `ideation/event-destructuring-real-corpus.md` (THE correction, measured read-only on the 18 GB snapshot) + blackboard `corpus/ground-truth-v2`.
**Corpus discipline (benchmark-arch standing rule):** no claim without a corpus id@version — the quantitative claims here trace to `corpus/ground-truth-v2` (Case 001, the summary.diffs correction); everything else is marked [PROPOSED]/[UNRESOLVED] pending corpus-v1 (D1–D8 deliverables).
**Evidence labels:** [VERIFIED] = read from the openfork tree / measured corpus; [INFERENCE]; [PROPOSED] = this chapter's contract decision; [UNRESOLVED].

---

## 1. Scope and the one-line contract

The storage redesign now centers on **aggregate exact-value deduplication** of repeated `summary.diffs` payloads inside OSES segments. The contract question is unchanged from ideation and now harder: **all of it must be invisible above the repository boundary** — legacy TEXT rows, OCDB-framed rows, OSES hot rows, OSES sealed frames, and `value-ref`s that rehydrate from `event_value`.

One-line contract: **every event read path (replay, aggregate range, durable stream, sync history, workspace export, V2 projector) sees the identical logical event `{id, aggregate_id, seq, type, data}` with `data` fully rehydrated, regardless of physical representation; the value table, the refs, and the rehydration are visible only inside `core/src/event/store*.ts`; and replay's `isDeepStrictEqual` compares the rehydrated value exactly.** The import guard is the enforcement mechanism.

The V1 public wire surface (routes, shapes, SSE events, cursors) does **not** change — §10 traces why, and confirms `MessageV2.hydrate` is projection-only so the adapter remains the single seam.

---

## 2. The correction, stated in contract terms

[VERIFIED, corpus] The byte king of the real corpus is `message.updated.1` (24.2 % rows, ~85–90 % of event bytes), and its payload is 95–100 % `info.summary.diffs` — full git diff patches. The same diff is re-carried by every message version: session `ses_0361b832` has 1,713 `message.updated` events, 225 distinct summary values, top value repeated **1,284×**; `ses_01e19df4`: 689 events, 8 distinct values, top repeated 516×. LZ cannot reach across versions thousands of events apart; only **per-aggregate exact-value dedup** captures it. Whole-DB estimate: 35–65 % of event bytes eliminated *before* compression.

[VERIFIED, corpus] `part.updated` (68.6 % rows, 9.8 % bytes) shows **0 % *consecutive*-identical values** — tool parts grow monotonically (unique text). Exact dedup of the *consecutive* class: none. **Non-consecutive repeats (e.g. `tool.input` across retries) are unmeasured and must be scanned by D4 before the `part.updated` exclusion is locked** (adversarial C4); shared-window LZ is the right tool for its unique-text class either way.

[VERIFIED, corpus] The 18 GB snapshot and the live DB have **no `ocdb_seal` table and no framed `event.data`** (pristine TEXT, `journal_mode=delete` on the snapshot). The fork chunk-sealer has not run on these DBs. Migration must handle **three legacy states**: pristine TEXT, partially OCDB-framed, OSES.

[INFERENCE/CALCULATED — labelled per adversarial B4] The 35–65 % whole-DB event-subsystem reduction is a **hypothesis with N=2 mechanism evidence** (50 % on the 2.5 GB session, 98 % on a small session) blended against one fork's live-DB type mix (89.9 % of 1.3 GB = `message.updated`). It is load-bearing for thresholds, the `session.updated` path, per-aggregate caps, and the externalization gates — **D2 (bounded whole-DB dedup scan) is the gate that turns this into a measured number.** Every downstream number is provisional until D2–D4 land.

Contract consequences:

1. **Dedup scope = per-aggregate `event_value` table, content-addressed by sha256 of exact bytes** (`ideation/event-destructuring-real-corpus.md` §3 DDL). This is the research doc §19.5 option (a) — *transactional SQLite content objects* — chosen with evidence, not deferred.
2. **Dedup target = the serialized `info.summary` sub-value** (and any other large repeated sub-value ≥ 1 KiB, ≥ 2 recurrences, per the corpus-scan items).
3. **Dedup is a seal-time transformation, never a hot-write transformation** (§6).
4. **Value-refs are a local physical representation only** — the wire (sync history, workspace export, `/sync/replay`) always carries full logical values (§4.3).

---

## 3. The EventStore adapter, extended for value-refs

### 3.1 Three physical representations → one logical event

| Physical | Where | Decode step |
|---|---|---|
| Legacy TEXT row (`event.data` TEXT JSON) | `event` hot rows written before any framing | `JSON.parse` |
| OCDB-framed row (`event.data` BLOB, magic `OCDB`) | `event` hot rows after the fork sealer ran | `decompressFrame` → `JSON.parse` |
| OSES hot row | `event` rows written post-cutover (identity, ref-free) | `JSON.parse` |
| OSES sealed frame | `event_segment_blob` | frame decode → **value-ref rehydration** → `JSON.parse` |

The adapter's decode layer is the **only** place that knows the difference. `StoredEvent = { id, aggregate_id, seq, type, data }` with `data` fully rehydrated is what every Tier-A/B caller sees.

### 3.2 Where rehydration lives in the tiers

[PROPOSED] **Rehydration is a store-internal decode helper (`rehydrateValue`), shared by both tiers — not a third public tier.**

- **Tier A** (`readByAggregateSeq`): replay's idempotent comparison needs the *rehydrated* value. A sealed event's `readByAggregateSeq` therefore runs frame decode + rehydrate. It runs inside the publish transaction on the same connection — a point read of `event_value(aggregate_id, value_id)` is transaction-consistent (the value row was committed with the segment that references it; segments are immutable).
- **Tier B** (`readAggregatePage`, `readAfter`, `syncHistory`, `allForAggregate`): range reads decode frames and rehydrate per event. A small **value cache** (LRU keyed `(aggregate_id, value_id)` → decompressed bytes, bounded, within the combined storage-cache budget of research doc §1.8) removes repeat `event_value` reads during a replay/sync pass where the same value_id recurs 1,284× — the cache is the difference between one BLOB read (+ one decompress) and 1,284. **Fetch policy (adversarial B2 strengthening):** point reads fetch **lazily, per-ref** (exactly the `value_id`s the decoded event references — a session-open of a cold message or a replay idempotency check must not pull a segment's whole value set); **eager segment-scoped preload only** when the caller is doing a full-segment replay (one load, then memcpy per event); plus a **per-value cache admission cap** so a 24 MB value is never cache-admitted wholesale without a policy decision (jumbo values: fetch-and-splice without residency, or admission under an explicit budget).
- **`eventIDLookup`**: never rehydrates — it reads the locator/registry and returns `{aggregate_id, seq}` (the E3 die needs both; oses-arch adopted this shape).
- **`insert`/`insertHot`**: never sees refs — hot writes are identity (§6).

### 3.3 The rehydration invariant: byte-level splice, then parse

[PROPOSED — the correctness core] For `isDeepStrictEqual(stored.data, encoded)` in replay to hold **exactly**, rehydration must reproduce the *original serialized event JSON text* before `JSON.parse`. The splice mechanism is now settled with the storage lane (hive belief 6af586c6): **positional null-placeholder splice**.

```
encode (promotion, seal time):
  find candidate sub-value in the event's JSON text
  replace it with the 4-byte JSON literal `null`        // frame stays valid JSON end-to-end
  record a ref-list entry (value_id) + the placeholder's
  byte offset/length in the per-event payload index

decode:
  text = frame.event_text                                 // valid JSON even before splice
  for each ref-list entry:
    valueBytes = valueCache.get(aggregate_id, value_id)   // miss → fail-closed (§4.2)
    assert sha256(valueBytes) == event_value.sha256       // store-level integrity
    text = text[0..offset] + valueBytes + text[offset+len..]   // null (4 B) replaced by exact bytes
  data = JSON.parse(text)
```

- **The invariant is unchanged:** parse input equals the original event JSON text byte-for-byte, because the placeholder is *replaced* by the exact stored bytes at a recorded offset. **Offset space is pinned to exact stored UTF-8 bytes (round-2 R2 — consistent with this chapter's wording since v1; format-spec + astral-boundary golden vectors owned by codec lane):** the splice-list `(offset, len)` values are UTF-8 byte offsets into the decompressed frame text, never UTF-16 code units — astral content must have golden vectors so a walker counting code units cannot corrupt a splice. `null` is the placeholder precisely because it is valid JSON at any value position — the frame payload parses even without `event_value` (a degraded read shows `null` at the deduped path: fail-visible, never garbage), the compression path (brotli over valid JSON) is unchanged, and no escaping/collision logic is needed (a real `null` can never occupy a ≥1 KiB deduped slot; and even in the degenerate case the ref-list entry is authoritative for the splice).
- **Encode-side guard (promotion, seal time) — strengthened twice (adversarial A1/C3 + round-2 R1):** the stored value bytes are the **original byte span of the sub-value extracted from the event's JSON text** (span-extract at the recorded path), **not** a re-serialization. For current-write-path rows (the corpus: `JSON.stringify` of schema-encoded objects) the span *is* canonical, so this costs nothing; for imported/non-canonical rows — number-formatting edges where re-serialization byte-differs from the original (`1e21` → `1e+21`, `-0` → `0`, `1.2300` → `1.23`, `1e400` → `null`, adversary-measured in Bun) — storing the original span keeps the splice byte-exact **universally**, not conditionally. **Two independent checks, both required — a span failing either falls back to inline (never stored):** (a) `sha256(original_span) == sha256(canonical_re-serialization(JSON.parse(span)))` — the original-vs-canonical guard (non-vacuous: it catches serializer divergence; mismatch → store original bytes anyway *and* flag); (b) `JSON.parse(span)` **deep-equal** `parsed_event[path]` — the round-2 R1 semantic check that closes the span-*walker mislocation* hole (wrong span, wrong duplicate-key occurrence): a wrong-but-canonical-round-tripping span passes (a) but fails (b) and is never stored. The sealer already parses each event for elision, so (b) is ~free. Either check failing ⇒ the sub-value stays inline in the frame; the value table only ever holds spans that reproduce the exact event at the recorded path.
**Stance on byte-identity vs logical-equality (adversarial C3 — DECIDED):** with original-span storage (§3.3), byte-identity is real for all rows, canonical and imported — so **the G1 `syncHistory` byte-identical differential and the G2 byte-equality golden vectors are passable for sealed events and are kept as specified.** Logical-equality (`isDeepStrictEqual` of parsed objects) remains the correctness floor for replay and the wire; byte-identity is the stronger, retained property. No downgrade of G1/G2 to logical-equality is needed *provided* the sealer stores original spans (A1). If a future format version ever drops span storage, the gates must be re-examined then — not now. The differential suite asserts both: byte-identical `syncHistory` output across physical homes (§5) and deep-equal replay outcomes (§4.3).

- **Decode-side guard:** after splice, `JSON.parse` must succeed and, where the caller compares (`isDeepStrictEqual`), the parsed value must equal the schema-encoded value. Any mismatch or parse failure is a fail-closed storage error, never a synthesized value.

The value-ref stream is a **frame-format feature of OSES v1** (gated by `OPENCODE_STORAGE_VALUE_DEDUP`, §9). Until the gate flips, segments carry full values and the ref stream is empty — decode of a ref-free segment is identical to today.

### 3.4 Value lifecycle

```
hot write (publish txn):        full value in event.data (identity)   — NO refs, NO hashing
seal/backfill (off-txn):        per-aggregate two-pass promotion (memory-flat):
                                pass 1 stream sha256 hashes + counts of ruleset-selected
                                sub-values → promote-on-second via event_value_pending ledger;
                                pass 2 re-read → promote (≥1 KiB; JUMBO_PROMOTE ≥1 MiB) →
                                substitute null placeholders + ref-list entries →
                                build segments (value promotion PRECEDES segment building,
                                same commit tx; the OSES rebuild pass IS the backfill)
decode (any read):              frame → splice refs from event_value (value cache) → JSON.parse
hard delete (aggregate):        FK cascade removes event_value rows with the aggregate
```

- **Migration variant (migration lane, arch):** the shadow backfill is a **file-swap rebuild** (build `opencode.db.new` streaming the legacy file read-only, swap at the next startup fence; the new file is born `oses-v1`, no in-file epoch tx). The value promotion is identical in both worlds — per-aggregate two-pass, promotion precedes segment building, refs substituted at frame build — the rebuild pass *is* the backfill in either case. Contract-wise this is invisible: the adapter sees a DB whose hot rows and segments are consistent regardless of how they were produced.

- **Promotion ruleset** (storage lane, frozen): per `(versionedType, path)` — v1: `message.updated.1` and `session.updated.1` → path `["info","summary"]`; `SIZE_THRESHOLD ≥ 1 KiB`; `JUMBO_PROMOTE ≥ 1 MiB`; `refs` maintained at promotion; `time_promoted` recorded. **`event_value` schema is FROZEN for the corpus D2/D3/D4 window**: `(aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)`, `PRIMARY KEY(aggregate_id, value_id)`, `UNIQUE(aggregate_id, sha256)`, cascade FK → `event_sequence` (storage.md §1.1/§13).
- **Refcount/GC:** within a live aggregate, a value referenced by an immutable sealed segment is referenced forever; values are never garbage-collected in v1. `refs` is maintained at promotion for audit and for a future segment-rebuild/orphan-detection pass. Hard-delete cascade is the only removal path.
- **Externalization gates (storage lane, v1 decision):** SQLite `event_value` beats externalization for v1 (transactional replay, crash, backup, rollback); externalization is gated at `≥ 4 GiB aggregate value_bytes` or `≥ 64 MiB single value` — above which the research doc §19.5 option (b) (manifest-coordinated object store) becomes the home. The contract consequence: the adapter's rehydration path has a second backing store *only* past those gates, behind the same `(aggregate_id, value_id)` key abstraction, so no caller changes.
- **Value-entry compression (adversarial strengthening + round-3 LOS-1, storage lane to adopt):** the v1 "store raw bytes" decision leaves the heaviest session's ~1.25 GB of distinct values raw on the very table built to shrink them — git-diff text measures 0.042–0.061 compressed (zstd l1 / brotli q1). Compress `event_value.bytes` with the OCDB envelope for **every promoted value (≥ 1 KiB); raw only when the per-value worth-it guard fails** (no size tier); **sha256 stays over the raw bytes** (dedup key unchanged). The read-latency objection is answered by the value cache: decompress **once per `(aggregate_id, value_id)` per cache residency**, then 1,284× splices are memcpy. The splice invariant is unaffected — it operates on decompressed bytes. Gate on the D2/D3 distinct-value distributions; the value cache holds decompressed bytes either way.
- **Backfill interplay:** if `VALUE_DEDUP` is off during shadow backfill, backfilled segments carry full values; flipping the gate later means new segments get refs while old segments keep full values — decode handles both, so the gate is independently flippable in both directions without an epoch change.

### 3.5 Import guard extended

The ideation guard ("no `@opencode-ai/core/event/sql` outside `core/src/event/store*.ts`") extends to the value table: `event_value` is an event-domain table owned by `store*.ts`. **No handler, service, or app file imports `event_value` or the ref stream.** Enforcement: one import guard covering `core/event/sql` + the value-table module (whether it lands in `event/sql.ts` or a sibling `event/value.sql.ts`).

---

## 4. Sync/replay exactness THROUGH dedup

### 4.1 Every path where `event_value` must be consulted

| Path | Site (verified) | Value consult |
|---|---|---|
| Idempotent replay check | `core/event.ts` `commitDurableEvent` (E2, `readByAggregateSeq`) | yes — sealed seq → rehydrate before `isDeepStrictEqual(stored.data, encoded)` |
| Divergent replay rejection | same | yes — same rehydrate; a wrong/missing value must surface as divergence or storage error, never a false match |
| Event-ID uniqueness | `eventIDLookup` (E3) | no — locator only |
| Aggregate range read | `readAggregate` (E1) | yes |
| Durable stream catch-up | `readAfter` (E5) / `durable()` | yes |
| Sync history | `handlers/sync.ts:76` (E8) | yes — logical events on the wire |
| Workspace warp export | `control-plane/workspace.ts:653` (E9) | yes — logical events POSTed to remote `/sync/replay` |
| V2 projector / SessionRunner replay | `EventV2.readAggregate` consumers | yes (adapter-mediated) |
| Reverse export / rollback | migration lane | yes — rehydrate to plain JSON TEXT (migration-arch target) |
| Hard delete | `EventV2.remove` (E6) | cascade — values removed, never consulted |

**The wire always carries full values** (sync history, workspace export, `/sync/replay`): value-refs are a storage-side physical representation, so a remote workspace replays a session without the source's `event_value`. This is a required correctness property, not a nicety — dedup must not change the sync protocol's payload semantics.

### 4.2 Fail-closed matrix (never synthesize) — with read-path integrity tag (adversarial C1)

The fail-closed posture had a **read-path hole**: with a 1,284×-referenced value, one corrupt/truncated/tampered `event_value` row silently poisons 1,284 event reads — "never synthesize" was honored, but "never silently serve corruption" was not (reads do not re-hash 24 MB). **Strengthening: a cheap per-value integrity tag** — the first 8 bytes (or crc32) of the value bytes stored in the splice-list entry (and/or a column on `event_value`) — **compared on read before splice** (~8 B/ref, ~zero cost; dissolves the "24 MB hashing per read" objection, since a truncated tag is not a full hash). Full sha256 remains the promotion-time guarantee; the tag is the read-time detection.

| Condition | Behavior |
|---|---|
| `event_value` row missing for a referenced `value_id` | typed storage error: aggregate_id + value_id + owning segment/frame; replay/render fails deterministically; no placeholder, no skip |
| **integrity-tag mismatch on read (corrupt/truncated/tampered value)** | detected fail-closed error *before* splice — never served silently; identify aggregate/value/segment; repair via reverse-export/rebuild; **G10 fault-injection must add this case** |
| sha256 mismatch on rehydrate (promotion-time / audit) | storage error (corruption); same reporting; repair via reverse-export/rebuild path |
| splice produces invalid JSON | storage error; same reporting |
| `refs` undercount / orphan values | not v1 errors (values only GC'd by cascade); audit log at promotion |
| external `sqlite3`/`opencode db` deleted a value row | decode fails closed on the first touching read (tag check or missing-row error) — the app must detect and report, never fabricate |

The "never synthesize" rule is absolute: a replayed event whose value cannot be reconstructed must **not** produce a partial event, because replay's `isDeepStrictEqual` would then compare against an altered object and either false-pass (data divergence hidden) or false-fail. Both are unacceptable; fail-closed is the only correct option (matches the ideation hard veto "exact-replay break").

**Replay equivalence note (adversarial C3 — validation):** the byte-splice invariant is *sufficient but not necessary* for replay — `isDeepStrictEqual(stored.data, encoded)` compares the *parsed objects*, so deep equality of the parsed values suffices, and the wire (remote replay, which never sees refs — §4.1) is correct either way. The byte-exact invariant is retained anyway because it buys byte-identity on the G1/G2 golden vectors and universal exactness for canonical *and* imported rows.

### 4.3 Replay equivalence with and without dedup

- Hot aggregate (no sealing): `readByAggregateSeq` returns the identity-written `data` — replay compares it as today, byte-exact.
- Sealed aggregate (refs): `readByAggregateSeq` returns the rehydrated `data` — identical logical object. The differential suite must assert that a given event yields the **same deep-equal result** whether it is read from hot TEXT, hot OCDB-frame, or sealed-with-refs. (This is a new differential vector: same logical event, three physical homes.)

### 4.4 Digest-first replay idempotency (adversarial optimization O1 — ADOPTED, format decision pinned)

The replay idempotency check on a **sealed** seq currently costs full materialization (frame decompress + value fetch + splice + JSON.parse) to run `isDeepStrictEqual` — ~1–5 ms on the byte-king class (24 MB summaries). O1 converts it to an index-compare:

```
fast path (digest present, gated):
  read the event's per-event payload-index entry in the UNCOMPRESSED index region
  digest_stored  (16–32 B, sha256 truncated to 128-bit, computed at seal over
                  canonical JSON.stringify of the schema-encoded logical event)
  compare vs digest(canonical JSON.stringify of the incoming encoded data)
  match    → idempotent (skip rehydrate entirely)
  mismatch → divergence error (fail-closed — no rehydrate, no materialize)
  no digest → legacy path: rehydrate + isDeepStrictEqual exactly as §4
```

Contract requirements:

1. **Format reservation NOW (the decision the adversary flags as "must be pinned"):** the per-event `has_digest` flag + optional 16–32 B digest lives in the **uncompressed metadata/index region** of the segment (OCE2 header + ID/type/frame-directory streams are uncompressed; frames are the only compressed region). If it were inside the compressed stream, the fast path would need a full segment decompress and the win evaporates. Reserve the field in v1, empty until the `OPENCODE_STORAGE_DIGEST_FASTPATH` gate flips; it is not a format break later.
2. **Digest is seal-funded and read-free:** computed once per event at seal over canonical data (sha256 cross-runtime identical, [MEASURED] deterministic) — publish untouched, no hot-path cost, no value fetch.
3. **Authority preserved:** `isDeepStrictEqual` remains the authority via a **full-compare fallback in config/test mode**; the G1 differential asserts identical idempotent/divergent outcomes with fast path on and off across the three-home corpus. **Residual edge (documented):** canonical-serialization equality is exact for deep-equality except the `-0` vs `0` boundary (canonical stringify maps both to `0`). Corpus exposure is zero today — the write path normalizes away `-0` (`getUsage`'s `Math.max(0, ·)` in `session.ts`) — but `Schema.Finite` would *admit* `-0` in principle, so the G1 differential includes a **signed-float fixture (`-0`/`+0`/NaN-adjacent)** as cheap insurance against a future producer or plugin emitting `-0` (one vector now beats a replay-semantics surprise after cutover; if no schema ever permits a signed number, the documented residual stands as-is). Imported non-canonical rows are already flagged by the §3.3 span guard.
4. **Corruption:** the digest lives in the segment-CRC-protected index region — a bit-flip in the digest is caught by the segment CRC before the digest is trusted (fail-closed at segment level); a valid-but-wrong digest yields a mismatch → divergence error, never a false idempotent skip. Add to G10 fault injection.
5. **Gates:** `D10` measures idempotency-check p99 fast-path on/off on the 1,284×-repeat session + digest index bytes/event; acceptance = ≥10× faster, zero G1 divergence, digest ≤ 32 B/event avg. The G4 budget for the idempotency check becomes trivially met at any summary size.

---

## 5. Sync append-ordinal contract — unchanged by dedup

[PROPOSED, carried from ideation §6.2/§13.1, now settled with oses-arch] `/sync/history` order = `(seq ASC, global_append_ordinal ASC)`, where:

- hot rows: ordinal = existing `event.rowid`;
- sealed segments: per-segment base u64 + per-event positive uvarint rowid deltas (captured at seal read time), the frame index exposes **per-event ordinals** to the iterator (a `(seq, ordinal)` tie can be between a sealed event of one aggregate and a hot row of another).

Value-refs do not touch this contract: the ordinal stream and the ref stream are independent per-event metadata inside the frame. Rehydrating a value does not change the event's ordinal. Golden tests (§5.1 of ideation/contract.md) remain valid; the differential must now also run on segments that contain refs and assert identical `syncHistory` output arrays.

---

## 6. Streaming deltas + codec boundary: no value-dedup on the hot path

[VERIFIED, corpus + schema] `PartDelta` (`message.part.delta`) is non-durable (no `durable` in `define`); token deltas flow pubsub → SSE only. The durable `PartUpdated` that closes a streamed part carries **unique, monotonically growing text** — the corpus shows 0 % consecutive-identical part values. Two contract decisions:

1. **`part.updated` is excluded from the v1 dedup ruleset — but the exclusion is measurement-pending, not locked (adversarial C4).** The corpus shows 0 % *consecutive*-identical values, which does **not** prove 0 % *non-consecutive* repeats — the 1,284× summary repeats are thousands of events apart, and `tool.input`/`tool.result` across a retry-replay are plausible in-`part.updated` repeats. **D4 must scan `part.updated` sub-values for non-consecutive repeats before the exclusion is final; if repeats are found, extend the extractor registry.** The contract consequence for the hot path is unchanged regardless: no hashing/promotion in the publish transaction (dedup stays seal-time); only the *candidate set* may grow.
2. **No hashing or ref-checking in the publish transaction, ever.** The hot write path stays identity (full value in `event.data`), exactly as today. Dedup work (hashing ≥1 KiB sub-values, sha256, table upsert) happens only in the seal path, off the critical section — this preserves the ideation gate "no hot-path cost" and the streaming latency budget.
3. **Codec boundary stays out of the delta path** (unchanged): `message.part.delta` SSE frames are raw `{field, delta}` strings; HTTP streaming paths stay compression-exempt; the only codec-touching write in an active turn is the durable `PartUpdated` (start/end + state transitions).

---

## 7. Storage-service reconciliation: the values live in SQLite `event_value`

[PROPOSED — decided] With diffs up to 24 MB, the repeated values are **stored as BLOBs in the transactional `event_value` table** — not the file-backed `Storage` service, not a sidecar store. Rationale, in contract terms:

1. **Transactional/replay constraint decides it:** a sealed frame referencing `value_id` must never exist without the value row. Only same-database transactionality gives that (segment commit + value rows + hot-prefix delete are one SQLite transaction; a crash before commit leaves the hot prefix authoritative with full values). The file-backed `Storage` service has no such guarantee (research doc §20.17 / §F.15: no write-before-event ordering, no ref/GC, no manifest backup).
2. **Hard delete cascade:** `event_value` is FK-cascaded on `event_sequence.aggregate_id`; session deletion removes values with the events, no orphan sweeps.
3. **Backup/restore stays single-resource:** SQLite snapshot includes the values; no two-resource manifest protocol (research doc §25.7).
4. **BLOB viability:** SQLite handles the size class (fork rows already reach 32.8 MB); a 24 MB value is one row, stored once.
5. **This is research doc §19.5 option (a)** — transactional SQLite content objects with FK/reference GC — selected on measured evidence (option (b), extended Storage, is rejected for the event domain).

**Boundary statement:** `event_value` is **event-domain only**. The projection (`message.data`, `session.summary_diffs`) keeps its own OPCL-framed copies (opcl-arch's lane). Cross-layer dedup (event_value ↔ projection) is a later, measured decision (research doc §19.5's "content-addressed storage above an evidence-based threshold" — the event-side evidence exists; the projection-side duplicate rate has not been measured). **Round-3 refinement (adversarial R3-ceiling):** D1 (currently treated as possibly-a-no-op) will likely show `message.data` *is* large — its `info.summary` mirrors the last `message.updated` event's `info.summary`, and `session.summary_diffs` carries it a third time; the projection↔event duplication class is the plan's biggest *unclaimed* win. The win is captured by **OPCL compression on `message.data`** (opcl-arch's lane, ~0.06 → 16×) — *not* by cross-layer dedup, which stays deferred on opcl-arch's structural grounds (materialized current-vs-history byte-identity would couple the projection read path to the event store and break the independently-addressable-projection principle). This chapter's boundary is unchanged: event_value stays event-domain-only; the projection side's answer is OPCL, gated on D1. The file-backed `Storage` service remains the **product-artifact** store (session_diff files consumed by the app's prompt-input diff display, plans, snapshots) — unchanged scope.

**Value-entry storage class — DECIDED (adversarial A4 + round-2 R4 + round-3 LOS-1):** `event_value.bytes` is **compressed with the OCDB envelope for every promoted value (≥ 1 KiB); raw only when the per-value worth-it guard fails** — the earlier "raw below ~64 KiB" tier is removed (it was a ~20× loss on the 1–64 KiB band, and the value cache already absorbs decode). sha256 stays over the raw bytes — the dedup key never changes; decode = one decompress per cache miss, then memcpy splices. "v1 = raw" is retired — it left the heaviest session's ~1.25 GB of distinct values raw on the very table built to shrink them. **Codec default within the frozen registry is codec-lane's D7 call** (brotli q1 is the byte-stable baseline; zstd l1 is the round-3 LOS-2 candidate for the post-dedup text class — byte-stable, faster decode, better ratio on diff text). Gate on the D2/D3 distinct-value distributions; the default direction is compressed (per round-2 reconciliation; this §7 supersedes the earlier "v1 = raw" wording).

---

## 8. Desktop/cross-runtime contract with value-refs

1. **Refs add no codec dependency.** A value-ref is a `(value_id, byte_offset, byte_length)` tuple; rehydration is a sha256 + BLOB read + byte splice. `node:crypto`/Bun `crypto` produce identical sha256; SQLite returns identical BLOBs. Node sidecar (V1 server) and Bun CLI both read/write `event_value` with identical semantics — no new capability probe beyond the existing codec probe.
2. **Writers' intersection rule applies to value-entry compression too (round-2 R4 + round-3 LOS-1):** with A4, `event_value.bytes` is compressed with the OCDB envelope (frozen registry; default per codec-lane's D7 call) for every promoted value. The existing rule — emit only the intersection of all shipped runtimes' codecs — therefore covers both the *frames* carrying refs and the *value entries* they reference; a value entry must never be emitted in a codec a supported reader runtime cannot decode, and the value cache decompresses via the same registry. No new capability probe beyond the existing codec probe.
3. **Sealing remains single-writer** (sidecar primary, CLI via maintenance lease — SYNTHESIS §3.19): value promotion happens inside the sealer, so the single-writer rule already serializes all `event_value` writes. A CLI that only appends hot rows never touches `event_value`.
4. **Reverse export (migration lane) must rehydrate refs to plain JSON TEXT** — the export target stays logical events; value bytes are the input, never the output.
5. **`opencode db` / external `sqlite3`:** `event_value` is an opaque table (routing plane + opaque-frame stance, SYNTHESIS landmine #11). No SQL consumer may assume value bytes are queryable JSON. Shell deletion of a value row is detected fail-closed on the first touching read (§4.2).

---

## 9. Feature gates: where VALUE_DEDUP sits

[PROPOSED] Gate chain (each depends on the previous; product never flips all at once):

| Gate | Depends on | Unlocks |
|---|---|---|
| `OPENCODE_STORAGE_READ_OSES` | — | OSES adapter reads hot+sealed; **ref-decode capability is compiled in from here** (no refs exist yet, but the decoder ships) |
| `OPENCODE_STORAGE_SHADOW_OSES` | READ | shadow segments built (full values; refs off) + differential verify |
| `OPENCODE_STORAGE_WRITE_HOT_OSES` | READ + shadow verified | new events append to `event` hot tail |
| `OPENCODE_STORAGE_SEAL_OSES` | WRITE_HOT | background sealing + startup catch-up (full values in frames) |
| `OPENCODE_STORAGE_VALUE_DEDUP` | SEAL | seal-time promotion of repeated sub-values + ref emission; refs appear in new segments only; old segments stay full-value (mixed decode) |
| `OPENCODE_STORAGE_EPOCH_OSES` | SEAL + differential + reverse export | `storage_epoch` flip; **VALUE_DEDUP is epoch-independent — may be on before or after** |
| `OPENCODE_STORAGE_DICTIONARY` | codec gate | structural dict emission |
| `OPENCODE_STORAGE_OPCL_WRITE` | routing columns live | project payload compression |
| `OPENCODE_STORAGE_LARGE_OBJECT_DEDUP` | measured projection duplicate rate | cross-layer dedup (deferred) |
| `OPENCODE_STORAGE_HISTORY_GC` | replay/checkpoint proof | prune (deferred, semantic) |

Key property: **VALUE_DEDUP can flip independently of EPOCH**, because refs are a frame-format feature decodable from READ_OSES onward, and reverse export rehydrates them. Rolling it back = stop promoting; existing ref-carrying segments remain readable (decoder stays), and reverse export still works. This keeps the gate chain honest — the product never depends on dedup being on for correctness, only for storage footprint.

---

## 10. Critical challenges

### 10.1 Does the adapter need to expose values to external SQL consumers?

**No — routing plane + opaque-frame stance is enough.** Verified consumers of event data are: (a) `sync/history` and workspace warp (both migrate to the adapter), (b) `EventV2.*` (adapter), (c) V2 projector (adapter), (d) `opencode db` / `sqlite3` — which already loses payload readability for framed rows and is documented as routing-plane-only (SYNTHESIS landmine #11). `event_value` adds nothing to the SQL surface: seq/type/aggregate routing lives in `event`/`event_segment` metadata, and payload content was already opaque post-OPCL/OSES. Exposing values would re-introduce a JSON-queryable surface the whole redesign is removing.

### 10.2 Is 'zero V1 public change' still true with value-ref rehydration? — trace

[VERIFIED] The V1 hydration path is **projection-only**:

```
GET /session/:id/messages  → session.messages / MessageV2.page
GET /session/:id/message/:mid → MessageV2.get
        └─ MessageV2.hydrate: 1 message SELECT + 1 part IN(...) SELECT
           (MessageTable / PartTable — never EventTable, never event_value)
```

`message.data`/`part.data` may become OPCL-framed (opcl-arch lane), but that codec boundary sits inside the projection read — not the event adapter. **Value-refs appear only in event-domain reads**, all of which already route (or will route) through the adapter: `EventV2.readAggregate`/`readAfter`/`durable` (E1/E5), `sync/history` (E8), workspace warp (E9), and replay's idempotent check (E2). The SSE stream delivers `session.*`/`sync` events from post-commit `notify` — hot, ref-free. Replayed events (`/sync/replay`) are re-inserted as hot identity rows — ref-free.

Therefore: **the adapter is the only seam that knows about value-refs, and it sits below every V1-visible read. Zero V1 public change holds**, enforced by the import guard (§3.5) plus the existing handler-surface check (no handler imports `core/event/sql`).

The one residual honesty note (unchanged from ideation): the four internal seams are the actual work (sync.ts + workspace.ts stop importing event tables; `EventV2` read helpers become adapter methods; live SQL JSON deps migrate to native routing columns before OPCL; `opencode db` payload readability degrades to the routing plane).

---

## 11. Open questions (contract-lane)

1. ~~**Value-splice mechanics in the frame format** — RESOLVED by convergence: codec-arch (codec.md) and storage-arch (storage.md) independently arrived at the same positional **null-placeholder splice** this chapter specifies (4-byte JSON `null` + per-event `(offset,len,value_id)` splice list in the payload index); it operates on **decompressed payload bytes** so it survives brotli frames unchanged; `event_value` schema is frozen for the corpus D2/D3/D4 window. The contract only requires the invariant (parse input == original JSON text); the mechanism is settled.~~
2. **`event_value` storage class for jumbo values** — 24 MB BLOB as one row is fine, but the value cache's admission policy for jumbo values (never cache > N MB? stream splice?) needs a benchmark input (codec-arch owns the value-entry codec bench).
3. **Projection-side duplicate rate** — opcl-arch answered: within-projection duplicates are small; cross-layer projection↔event_value duplication is **structural** (materialized-view current-vs-history), not a repeated-value class, and deduping it would couple the projection read path to the event store — **stays deferred** unless the D1-adjacent census surprises. Aligned.
4. **Promotion thresholds (SIZE_THRESHOLD, JUMBO_PROMOTE)** — [PROPOSED] 1 KiB / 1 MiB pending benchmark-arch's corpus deliverables D2/D3/D4 (distinct-value histograms per path, whole-DB elimination fraction, first-copy waste fraction), which migration-arch captured verbatim in migration.md §10.2; oses-arch's five "bounded scan must answer" items are owned by the corpus lane, not this one.
5. **Dedup unit: `info.summary` whole object vs sub-values** — benchmark-arch's new D9 (dedup-unit/granularity sweep) owns this; opcl-arch flags the message-side whole-object unit as "the one to watch" across the projection fence. [PROPOSED] whole `summary` object (schema-encoded unit; short title/body; corpus sweep decides).

---

## 12. Must-benchmark additions (contract-lane, feeds benchmark-arch's gates)

1. **Rehydration cost in the replay/sync path** (G3/G5): hash-map + value-cache + splice + JSON.parse vs plain JSON.parse, p50/p95/p99 on the packaged Electron runtime; the 1,284×-recurrence session is the stress case. **The frame-worth-it guard must be computed POST-dedup** (frame_stored + index vs post-dedup raw = refs + unique text; codec-arch re-derived this) — never compare pre-dedup sizes, or the guard will misjudge ref-dominated frames.
2. **Value-cache policy:** hit rate / byte budget for LRU keyed `(aggregate_id, value_id)` under sync-history and workspace-warp passes; admission for jumbo values (G5 now covers the cache read path; benchmark-arch folded it).
3. **Differential with refs (G1):** same logical event read from hot TEXT, hot OCDB-frame, and sealed-with-refs must produce identical `isDeepStrictEqual` outcomes and identical `syncHistory` arrays — the three-home differential (benchmark-arch G1 extension).
4. **Missing/corrupt value fail-closed (G10):** deterministic bounded-time failure, no synthesized event, correct aggregate/segment/value_id reporting; **G10 fault-injection must add the corrupted-value-row case** — a tampered/truncated `event_value` row must be caught by the read-path integrity tag and fail closed, never render a wrong summary silently (adversarial C1); the promotion-time sha256 guard is exercised separately.
5. **Dedup-ratio sweep (G6 input):** promotion threshold × value-size × recurrence on real aggregates (the 225-distinct/1,284-repeats session vs a 8-distinct/516-repeats session) — benchmark-arch's D9 (dedup-unit/granularity sweep) + oses-arch's five D2/D3/D4 scan items.
6. **Seal-time promotion cost:** hashing ≥1 KiB sub-values + sha256 + table upsert inside the seal/rebuild path (not the publish txn) — bytes/sec, CPU, WAL (migration's file-swap rebuild is the 18 GB-scale variant).
7. **Value-entry codec bench + splice-offset fuzz** (codec-arch ownership): the splice path under corrupt offsets, escaped-JSON interaction, and cross-runtime byte identity of the splice list.

---

## 13. Headline contract decisions (for the coordinator's PLAN.md)

1. **One logical event, four physical homes** (TEXT / OCDB-frame / OSES hot / OSES sealed-with-refs), all normalized to `{id, aggregate_id, seq, type, data}` by the store decode layer; rehydration is a store-internal helper shared by Tier A and Tier B, invisible to every caller.
2. **Rehydration = positional null-placeholder splice → exact original JSON text → `JSON.parse`** — the mechanism that makes `isDeepStrictEqual` exact through dedup; **converged independently by contract (this chapter), storage, and codec lanes** (frame stays valid JSON end-to-end, compression path unchanged, degraded read = fail-visible `null`). **Original-span storage (A3) makes byte-identity real for all rows → G1/G2 byte gates passable for sealed events (C3 stance, decided);** encode-side guard = original span vs canonical re-serialization (non-vacuous; mismatch detected, original stored anyway). Read path carries a **per-value integrity tag** (first-8-bytes/crc32, compared before splice — C1: required, not optional) plus decode-side fail-closed (never synthesize).
3. **Value-dedup is seal-time only**: hot writes stay identity and ref-free; no hashing in the publish transaction; `part.updated` values are never candidates (unique text, 0 % repeats); the streaming/codec boundary is untouched. `event_value` schema FROZEN (`aggregate_id,value_id,sha256,raw_len,bytes,refs,time_promoted`; PK(agg,value_id), UNIQUE(agg,sha256), cascade FK).
4. **`event_value` lives in SQLite** (research doc §19.5 option (a)): transactional with segment/rebuild commit, FK-cascade on hard delete, single-resource backup; externalization gated at ≥ 4 GiB aggregate value_bytes / ≥ 64 MiB single value (storage lane). The file-backed `Storage` service stays the product-artifact store; cross-layer dedup deferred (opcl-arch: structural, not a repeated-value class).
5. **`VALUE_DEDUP` is an independent gate after `SEAL`** (epoch-independent, reversible, mixed-segment decode) — the product never depends on dedup for correctness. The backfill/rebuild pass *is* the value promotion (migration: file-swap rebuild, promotion precedes segment building).
6. **The wire always carries full values** (sync history, workspace export, `/sync/replay`) — refs are storage-local; remote replay works without the source's value table.
7. **Zero V1 public change holds**: hydration (`MessageV2.hydrate`) is projection-only; every event read routes through the adapter; import guard extended to `event_value`. The frame-worth-it guard is computed POST-dedup only.
8. **Digest-first replay idempotency (O1, adopted):** per-event 16–32 B logical digest (sha256→128-bit over canonical data) in the segment's **uncompressed index region**, reserved in the v1 format now (empty until gated); sealed-seq replay becomes an index-compare (~5–20 µs vs ~1–5 ms materialization), with `isDeepStrictEqual` preserved as the authority via a test-mode full-compare fallback, segment-CRC protecting the digest, and the documented `-0`/`0` residual bounded to imported non-canonical rows. Digest is seal-funded; publish untouched.

---

## 14. Corrections to prior docs (this lane's record)

1. **`ideation/contract.md` §8/§9 assumed no repeated-value class** — the real corpus adds one: `info.summary.diffs` at 50–98 % of `message.updated`. This chapter adds the value table, the ref contract, and the seal-time placement; §3.3's byte-splice invariant is new.
2. **`ideation/event-destructuring.md` (v1, synthetic) is superseded by `event-destructuring-real-corpus.md`** — its structural-encoding thesis (0.043–0.051) is retracted to ~2 % on the real corpus; the value-dedup design in the correction doc is the reference. Its value-ref *mechanics* (content-address, exactness guard, fail-closed) survive and are formalized here.
3. **Ground-truth correction:** the 18 GB snapshot is pristine TEXT (no `ocdb_seal`, no frames) — so the adapter's "three legacy states" (§3.1) is not hypothetical; reverse export and backfill must handle all three (migration lane).
4. **Research doc §19.5** deferred large-object dedup "until exact-duplicate rates are measured" — the gate is met by the real-corpus measurement; option (a) (transactional SQLite content objects) is now the decided home.
