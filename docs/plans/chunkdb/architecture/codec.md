# Codec Architecture — Real Payload Classes

**Author:** codec-arch · **Swarm:** chunkdb-ideation · **Branch:** `openfork` (v1.18.18) · **Date:** 2026-08-15
**Parent:** `` (chapter; executive plan lives in `PLAN.md` — coordinator-owned)
**Supersedes for codec decisions:** `ideation/codec.md` (byte-stability/registry — survives) where it conflicts with the corrected Pareto; `ideation/event-codec.md` (frame geometry — survives as mechanism); `ideation/event-destructuring.md` (structural thesis — retracted on real corpus).
**Corpus grounding:** `ideation/event-destructuring-real-corpus.md` (THE correction, T0 real) + blackboard `corpus/ground-truth-v2`; claim labels per benchmark-arch's 8 measurement rules (`architecture/corpus.md`).

---

## 0. Evidence legend

| Label | Meaning |
|---|---|
| **[T0-MEASURED]** | Measured on the sanctioned 18 GB real snapshot (1,377,243 events), read-only. Cited from the correction doc / ground-truth. |
| **[MEASURED]** | Measured this session (Bun 1.3.14 / Node v22.23.2 / Electron 42.3.3 Node 24.15, `node:zlib`), mechanism-class probes. |
| **[VERIFIED]** | Read from the `openfork` tree or runtime artifacts. |
| **[LOCKED]** | Swarm-settled decision (`ideation/SYNTHESIS.md`) — not re-opened here. |
| **[PROPOSED]** | Design value/mechanism to freeze at the format-freeze/implementation gate. |
| **[UNRESOLVED]** | Needs corpus/benchmark closure (`architecture/corpus.md` gates D1–D8). |

---

## 1. The corrected Pareto, restated for the codec layer

The correction doc's revised Pareto (whole event subsystem, T0 real):

```
A. Aggregate exact-value dedup of summary.diffs   → 50–98% of message.updated bytes  [T0-MEASURED]
   (the codec-level form: a per-aggregate content-addressed VALUE TABLE — the real "dictionary")
B. Shared-window LZ frames (OSES segments)        → part.updated unique text + post-dedup remainder
C. Structural encoding + elision                  → ~2–3% on this corpus; V2-steer-class only [T0-MEASURED]
D. Semantic deltas                                → dead [T0-MEASURED]
```

**What the codec layer owns** under this Pareto (ownership boundaries vs peer chapters):

| Mechanism | Owner | Codec-layer contribution |
|---|---|---|
| A — `event_value` table (DDL, scan, thresholds, GC) | oses-arch (`architecture/storage.md`) | **value-ref frame encoding, original-span identity + canonicality/semantic guards, golden vectors** — this chapter |
| B — OSES frames (geometry, sealer) | oses-arch | **frame codec choice, frame-worth-it guard, per-frame adaptive policy** |
| C — structural encoding / elision | oses-arch (elision) / codec-arch (deferred flag) | reserved hooks; elision accounting |
| Registry / byte-parity / capability probe | codec-arch | frozen registry, two-tier golden rule, intersection write policy **[LOCKED]** |

The division is crisp: **the store decides what is dedup'd; the codec decides how a value-ref is encoded into a frame and how the remaining bytes are compressed** — and both must be byte-stable across runtimes.

---

## 2. Codec posture under the corrected Pareto

What survives from `ideation/codec.md` — **[MEASURED], unchanged, still locked:**

1. **Frozen registry** `1=zstd, 2=brotli, 3=raw-deflate` (OCDB frame v2 header, 14 B), append-only. `0=RAW` reserved for frame-directory use. **[LOCKED]**
2. **Brotli q1 = byte-stable baseline** (fork's shipped default). Verified byte-identical across Bun 1.3.14, Node v22.23.2, and the **packaged Electron 42.3.3 / Node 24.15.0** runtime.
3. **Deflate = interoperable-only compat** — byte-divergent across Bun/Node (different embedded zlib); never a byte-golden fixture; logical-equality only.
4. **zstd (dict-less) = byte-stable** across all three probed runtimes; legitimate ratio-optimization candidate.
5. **zstd+DICTIONARY = broken on Bun 1.3.14** (ignore-on-compress; undecodable-on-read even with the dict). Node/Electron side verified correct + fail-closed. Capability-probe-gated; **not in the writable intersection**. **[MEASURED, packaged runtime]**
6. **Writer policy = intersection** of all shipped runtimes' codecs; reader fails closed on unknown codec/dict. Capability probe at startup (codec round-trips, zstd-dict probe, `sqlite_version()`+compile_options, `process.versions`). **[LOCKED]**

**New posture from the corrected Pareto (this chapter):**

- The **codec's compression target has changed class**. Pre-correction, frames were "JSON with heavy structural repetition" (steers) — a world where brotli's LZ window recovered most of it and structural encoding competed. Post-correction, **the dominant frame content after dedup is unique text** (`part.updated` monotonic streaming text; post-dedup `message.updated` diffs). The codec decision is now about **text compression, not structure compression**.
- **Measured on git-diff-shaped text** (this session, mechanism-class): on a ~220 KB patch corpus, **zstd l1 = 0.042, brotli q4 = 0.045, brotli q1 = 0.061** — zstd l1 beats brotli q4 on ratio on this class while being far cheaper to compress and decode. This is a *signal, not a forecast* (synthetic text; real-diff bench via corpus D1/D4).
- **Decision (LOCKED + D7-gated default-flip, adversarial optimization O3 / LOS-2 record):** brotli q1 stays the byte-stable baseline default **[LOCKED — SYNTHESIS]**; **zstd l1 becomes the per-frame adaptive alternative** for text-heavy frames — byte-stable, so the switch costs no parity risk. **O3 additionally proposes promoting zstd l1 to the DEFAULT for Tier R frames AND value entries** (~1.5–2× faster decode, better ratio on the dominant text class, byte-stable across all three probed runtimes): recorded as **SHOULD-IT-BE-DEFAULT pending D7's real-corpus sweep + the value-entry bench (codec-arch §11 #3)** — brotli q1 as Tier R default is flagged as a decode-speed + ratio loss vs zstd l1 (LOS-2), and the D7 gate decides. brotli q4 remains the second alternative for steer-heavy frames where the worth-it guard + CPU budget justify it (brotli decode speed is quality-independent, so q4 costs compress-CPU only, which the sealer already budgets).

---

## 3. The value table AS the codec dictionary — value-ref splicing

### 3.1 Why it is the right "dictionary"

The corrected Pareto's move A is, at the codec layer, **a per-aggregate content-addressed dictionary of exact values** — and it dominates every trained/shared dictionary candidate in the prior ideation:

| Property | Value table (aggregate dedup) | Trained/shared dictionary |
|---|---|---|
| Coverage | Exact repeated bytes — the user's own data | Approximate statistical model of someone else's corpus |
| Privacy | **Zero exposure by construction** (the data is already in the user's own DB; nothing leaves it) | Ship-risk: one leaked substring = permanent distributable incident |
| Cardinality | Unbounded (per-aggregate ordinal space) | Bounded/shipped artifact |
| Reaches across frames? | Yes — any distance (content-addressed, not window-limited) | Yes, but only for corpus-shaped content |
| Exactness | Hash-verified exact bytes | None (statistical) |

The measured LZ-limitation that motivates it: a value repeated **1,284 events apart** (T0) cannot be back-referenced by any window — brotli's max 16 MB window included. A content-addressed table can. **[T0-MEASURED]**

### 3.2 Value identity: hash of ORIGINAL span bytes (+ canonical form as the guard's reference)

The dedup key is `sha256(exact bytes)` of the repeated sub-value **[LOCKED — event_value.sha256 UNIQUE per aggregate]**. **Which bytes? The ORIGINAL span bytes from the stored event text — not the sealer's re-serialization.** (Adversarial strengthening A1/C3; the span-walker that finds them lives in §3.3.)

- **[MEASURED]** `JSON.stringify` of an identical nested object graph is **byte-identical across Bun and Node** (length 698, SHA-256 `f61415226aa557bf` on both) — canonical JSON is cross-runtime deterministic. This determinism is what makes the *guard* (below) meaningful across runtimes.
- **The risk A1 closes:** JSON round-trips are NOT byte-stable for every serializer — `1e21`, `-0`, `1.2300`, `1e400` parse to the same object yet re-serialize to different bytes **[MEASURED by adversary]** (case: `1e21` → `1e+21`). A row written by another fork/older version/hand-edit can therefore carry original bytes that differ from the canonical re-serialization of the same logical value. Deduping on the *re-serialization* would (a) store bytes the event never carried, silently changing sealed text on reverse export, and (b) make the encode guard vacuous (it compared the re-serialization to its own hash).
- **The fix (adopted — stance (a)):** hash and store the **original span bytes**. The dedup key is then exact for *all* rows, canonical or not; splice rehydration restores the original bytes; reverse export is byte-exact; G1/G2 byte gates pass unconditionally (§7 / adversarial C3 — deep-equality replay remains the *floor*; byte-identity is the stronger property we get for free and no longer contradicts the invariant).
- **Canonical re-serialization's role is now the guard's reference, not the identity:** `original_span_bytes == canonical_re-serialization(JSON.parse(original_span_bytes))` — on mismatch, **store the original bytes anyway** (dedup stays correct, byte-exactness preserved) and log the non-canonical row. The guard is real: it fires on the original-vs-canonical mismatch, the actual risk A1 identified.
- **Golden-vector contract (§7):** non-canonical rows (`1e21`, `-0`, `1.2300`, `1e400`) must round-trip byte-exactly through seal → splice → reverse export, on both runtimes.

### 3.3 Frame encoding: JSON with spliced refs (no structural commitment)

The tension: dedup operates on *sub-values* (`info.summary`, and later individual `patch` strings), but the winning frame approach is **"JSON stream + shared-window LZ"** (event-codec.md's 23× mechanism), and the full structural-encoding thesis (field ordinals, key interning) is **retracted** (~2% on this corpus). The value-ref must therefore be expressible **inside a JSON frame without committing to structural encoding**.

**[PROPOSED] splice-ref encoding** (per event, inside the frame):

```
event = type_key uvarint | flags byte | splice_list | payload_bytes
splice_list = uvarint n | { uvarint value_id | uvarint offset | uvarint marker_len }*   // offsets = UTF-8 BYTE offsets, ascending
payload_bytes = ORIGINAL (elided) event text, with each dedup'd sub-value's byte-range
                replaced by a fixed marker (any fixed byte pattern; the splice list defines
                the ranges, so the marker is never ambiguous)
```

- **Encode (at seal) — span-walker in ORIGINAL space (adversarial A1/A2/R1/R2 strengthening, replaces the canonical-diff trick):** a **UTF-8-aware** JSON tokenizer/walker maps `versionedType`-path → byte span over the **exact stored event TEXT bytes** (the `Uint8Array` as stored in the TEXT row — SQLite TEXT is UTF-8; also available after decompressing an OCDB-framed row, since the fork sealer frames the original TEXT). **Pin (R2): the walker's input is the exact stored UTF-8 bytes, never the decoded JS string; offsets are emitted in BYTES; the walker skips multi-byte sequences so an astral character can never be split.** One walk locates the elision span (`sessionID`) and the candidate sub-value spans in a single pass — **no parent re-serialization**. For each candidate span: hash the original span bytes (§3.2), look up/insert in the aggregate table, splice in the marker, record `(value_id, offset, marker_len)`.
- **Two-tier guard at encode (R1 — distinguishes walker bugs from non-canonical serializers):**
  1. **Semantic check:** `JSON.parse(original_span_bytes)` must **deep-equal** `parsed[path]` (the sealer already parsed the event for elision). **Failure ⇒ walker mislocation ⇒ the value is INLINE, never stored, never spliced** — this is the only remaining silent-corruption path and it is now closed, ~free (event already parsed, one deep-equal per candidate).
  2. **Canonicality check:** `original_span_bytes == canonical_re-serialization(JSON.parse(original_span_bytes))` — mismatch after a PASSING semantic check means a non-canonical serializer, not a wrong span ⇒ **store the original bytes anyway** (dedup stays correct, byte-exactness preserved), log the non-canonical row.
- **Fallback (canonical re-serialization)** is used only when original text is genuinely unavailable to the sealer (a future logical-object source); it is the documented second-class path, byte-exact only for canonical rows.
- **Decode:** read the splice list, replace each marker range with `event_value.bytes` (original span bytes), rehydrate the elided field from the envelope, `JSON.parse` the reconstructed JSON, schema-decode.
- **Exactness guard (fail-closed, both directions):** on encode, the *original* span bytes are the identity — the guard detects original-vs-canonical mismatch but never blocks storing the original (dedup remains exact; byte-exactness is unconditional). On decode, the rehydrated value flows through the existing schema decode — `isDeepStrictEqual` replay semantics preserved. **[LOCKED: never synthesize]** (Same invariant, independently derived, in contract.md §2 — the rehydration helper is store-internal and shared by Tier A+B; `refs are storage-local — the wire always carries full values`, so remote replay never needs the source `event_value`.)
- **Why not field ordinals:** splice-ref needs **no schema field tables** — it works on any JSON subtree (summary object today, `patch` string tomorrow, whole payload eventually) and adds no per-`versionedType` versioning. This is the key separation from the retracted structural thesis: **refs are positional byte mechanics; structural encoding is schema semantics. The format commits to the former now and defers the latter.**
- **Per-event digest field — RESERVED NOW (adversarial optimization O1, format decision):** the per-event payload-index entry (the *uncompressed* metadata region of the segment — where the splice list already lives; the frames are the only compressed region) reserves a `has_digest` flag + optional **128-bit digest** (`sha256` of canonical `JSON.stringify(schema-encoded)` data, truncated to 128 bit). **Empty until gated** — the reservation is what prevents a format break later. Purpose: digest-first replay idempotency — `commitDurableEvent` on a sealed seq compares stored digest vs `digest(re-encoded incoming)` (~5–20 µs, index slice + 32 B compare, **zero frame decompress / value fetch / materialization**) instead of the current ~1–5 ms materialize-and-deep-equal on the byte-king class — a 100–1000× read-path win, and G4's idempotency budget becomes trivially met at ANY summary size. Semantics **[O1, VIABLE-GATED]**: `isDeepStrictEqual` remains the *authority* via a full-compare fallback (test/config mode); digest match = idempotent, mismatch = divergence, corrupt digest = fail-closed divergence error (index region is segment-CRC-protected); digest computed at seal, publish path untouched; digest over canonical data is cross-runtime deterministic **[MEASURED §3.2]**. **If the digest were inside the compressed stream the fast path would die — it MUST live in the uncompressed index entry, alongside the splice list** (coordination: oses-arch's OCE2 per-event payload-locator stream owns the layout; codec-arch owns the digest semantics + golden vectors).
- **Marker ambiguity is impossible by construction:** decode replaces exact byte ranges from the splice list; the marker is never matched by content. A user string that happens to equal the marker inside a *non-spliced* region is untouched.
- **Reverse-export consequence (migration.md §5.2, stated per A1):** with original-span storage, reverse export emits the **original bytes** for sealed events — byte-identical to what the row carried for *all* rows, so G1's byte-identity on syncHistory passes unconditionally. (Had we kept canonical-only storage, reverse export would emit canonicalized text, byte-different for non-canonical rows — the contradiction the strengthening eliminates.)
- **Sealer CPU (A2):** original-space extraction costs one single-pass walk over the event text + one sha256 per candidate span + one sub-value re-serialization per candidate for the guard (no parent re-serialization — strictly cheaper than the retired canonical-diff trick). For a 24 MB summary event that is ~1–2× 24 MB allocations per heavy event, in the sealer process. **Add `seal-path allocation per event` (and per-value hash+guard cost) to the seal-cost ledger / pacing-controller input (storage.md sealer pacing; benchmark.md B3) — the heavy-session seal must not starve the model stream.**

### 3.4 Granularity and scope

- **v1 granularity = the measured one:** the whole repeated sub-value (`info.summary` for `message.updated`) — that is what T0 measured (225 distinct / 1,713 events). **[T0-MEASURED]**
- **Refinement path without a format break:** splice-ref works at any subtree depth, so per-`patch` or per-`diffs[]`-entry granularity is a sealer-policy change, not a format change. Gate it on corpus D2/D3 (per-aggregate distinct-value scans) — if `message.updated` summaries differ only in one file's patch across versions, finer granularity wins more; if whole summaries repeat, v1 granularity is enough.
- **Scope = per-aggregate** (not global): hard-delete cascades cleanly, session-specific diffs never collide, refcount GC is free (cascade). Global content-addressing = later measured decision. **[LOCKED]**
- **Storage:** value entries live in SQLite (`event_value`), inside the same transactional/backup domain as events — **not** the file-backed `Storage` service. **[LOCKED]**

### 3.5 Value-entry compression (v1 default, per adversarial A4)

The table stores each unique value **once**; compress each entry with the **existing OCDB frame envelope**. This is a **v1 default, not a later tweak** — leaving the distinct-value table raw leaves a 10–20× residual on the second-largest byte class (a 1.25 GB distinct-value aggregate at 0.042–0.061 → ~50–75 MB compressed **[CALCULATED from A4]**):

- **Codec-layer supported representation (so storage.md and codec.md agree):** `sha256` in `event_value.sha256` stays over the **RAW original span bytes** — the dedup key never changes, compressed or not. The OCDB envelope wraps the *stored* bytes (codec 2 brotli q1 default; zstd l1 candidate per §2; raw only when the worth-it guard fails). Decode = one decompress per **value-cache miss** (contract.md's `(aggregate_id, value_id)` cache); the 1,284× splice fan-out is then memcpy. Adversary's read-latency objection is answered by the cache, so compression costs nothing user-visible.
- A 24 MB repeated diff becomes **one** envelope-compressed entry instead of 1,284 frame copies. Whole-value-table compression is NOT needed (per-entry keeps random access per value).

---

## 4. Frame-worth-it rules re-derived for real content

The pre-correction guard (event-codec.md §3.3) compared `frame_stored + index` vs `sum(raw events) + index` — but it had no dedup, so "raw events" meant pre-dedup bytes. **The corrected guard must measure what is actually stored — the post-dedup bytes.**

```
per frame (evaluated at seal, after dedup + elision):
  payload_raw  = Σ ORIGINAL (elided) event-text bytes of each event payload, with sub-values REPLACED by refs
                 (i.e., the payload WITH marker + splice list is what lands in the frame)
  index_cost   = per-event envelope (type_key, flags) + splice-list bytes + ordinal/offset/length
                 + frame's share of segment header/type_set
  stored       = compress(frame payloads concatenated) + index_cost
  keep compressed  iff  stored + MIN_GAIN < payload_raw + index_cost
  else store frame RAW (codec 0 / uncompressed concatenation)
```

**Frame-size reconciliation (R5 — resolves the codec.md vs storage.md/readpath.md contradiction on the same guard):** the guard's outcome is a *frame-size threshold*, not a class property. At the Tier P 16 KiB frame target, shell/pure-ref frames are repetitive JSON and **compress ~20–40× to ~1–2 KB stored** (storage.md §4.2, readpath.md §2.2 — the G4 arithmetic's assumption); a frame whose `payload_raw` is genuinely tiny (a few KB of refs with nothing to repeat) falls below `MIN_GAIN + overhead` and **stays raw**. Both outcomes come from the same formula — no explicit per-class skip instruction anywhere.

Consequences for the real content classes:

| Frame content (post-dedup) | Typical shape | Guard outcome |
|---|---|---|
| `part.updated` text | monotonic streaming text, high compressibility *(unique-text classification CONDITIONAL on corpus D4's non-consecutive-repeat scan — adversarial C4: `tool.input`/`tool.result` repeats across retries would make part.updated sub-values dedup candidates too; the ruleset registry (storage.md) extends if D4 finds them)* | compress nearly always wins (window sensitivity: 16–32 KiB frames, ratio 0.04–0.09 **[MEASURED, mechanism]**) |
| `message.updated` post-dedup | refs + small unique fields (path/tokens/ids) | frame is tiny; the guard's `MIN_GAIN` naturally keeps a pure-ref frame raw — **the worth-it guard is the SINGLE source of truth; no explicit "skip compression" instruction anywhere** (adversarial A5 — storage.md §4.2.3's skip instruction is deleted in the oses-arch revision) |
| mixed | refs + text | guard on the post-dedup sum; text part drives the win |
| already-compressed / base64 tool output | high entropy | guard returns RAW (the fork's net-gain gate, generalized to frames) |

**The re-derivation in one line:** after dedup, the frame's compressible content is unique text; the guard compares against the *post-dedup* raw, so a frame whose bytes are mostly refs is never wastefully compressed, and a frame whose bytes are mostly text is nearly always compressed. `MIN_GAIN` = header + splice overhead + a CPU-weighted floor (proposed ≥ 8 B or ≥ 2% of payload_raw; benchmark-gated).

---

## 5. Structural encoding — deferred, flagged, V2-steer-class only

- **[T0-MEASURED]** structural encoding is ~2% on this corpus (diff-dominated payloads have no keys/IDs to encode). V2 `session.next.*` steers are 0.015% of rows. **[LOCKED: defer]**
- **The format does not commit to it.** Splice-ref (§3.3) achieves the Pareto-A win with positional byte mechanics and no per-type schema tables; full structural encoding (field ordinals, key interning, varint numbers) remains a **future V2-steer-class feature behind a flag**.
- **Minimum it would need if it ever ships** (spec now, so it is not foreclosed): per-`(versionedType, physicalFormat)` field-ordinal tables, **append-only ordinal stability** (a new field appends; an old ordinal never changes meaning), versioned by the `versionedType` string (`"${type}.${version}"`, **[VERIFIED]** `../../../../packages/schema/src/event.ts`), and its own golden/property/fuzz gates. The `dictionary_id` field (reserved codec IDs 4–7) is the designated extension point. **[LOCKED]**
- **Interaction with splice-ref:** if structural encoding ever ships, splice-ref composes with it (a value-ref is just another value tag). No conflict — but no dependency either.

---

## 6. Elision — stays, but stated at its real size

- `sessionID` elision (publish-enforced invariant: `data.sessionID === aggregate_id`, enforced in `commitDurableEvent`) stays — it is free, provable, and removes a per-aggregate string no dictionary can cover. **[LOCKED]**
- **On this corpus it is ~0.2%** (`sessionID` appears once per payload, not 100×) **[T0-MEASURED]** — stated as such, not as a headline. Its real value is the cold first-frame of an aggregate and the OPCL per-row path, both of which lose the shared window. Keep the rule; drop the marketing.
- Elision and splice-ref compose: elided payloads shrink before framing, refs shrink within frames.

---

## 7. Golden vectors + capability probe

### 7.1 Golden-vector matrix (extends the locked two-tier rule **[LOCKED]**)

New vectors required by the corrected Pareto, in addition to the existing per-codec fixtures. **Stance on byte-identity vs logical-equality for sealed events (adversarial C3 — DECIDED, stance (a)): byte-identity is the gate for sealed events.** Deep-equality replay is and remains the floor (the `event.ts` idempotency check is `isDeepStrictEqual(parsed, encoded)` — sufficient for replay and the wire), but original-span storage (§3.2) makes byte-identity real for *all* rows, so G1 (byte-identical syncHistory) and G2 (byte-equality golden vectors) keep their byte gates — no contradiction at corpus v1:

1. **Value-ref round-trip:** extract a summary-like sub-value's original span → hash → splice into a payload → decode → deep-equal the original object **and, for canonical rows, byte-equal the original text**. Both runtimes, both directions.
2. **Dedup-hash exactness:** identical logical value → identical original-span bytes → identical SHA-256 on both runtimes (pins §3.2). **Plus the real guard vector (adversarial A1):** a NON-canonical row (`1e21` / `-0` / `1.2300` / `1e400` serializers) — original span ≠ canonical re-serialization → sealer stores the ORIGINAL bytes, and the seal → splice → reverse-export round-trip reproduces the original text byte-for-byte. This is the vector that would have caught the vacuous guard.
3. **Splice-offset exactness (R2-pinned):** splice offsets are **UTF-8 byte offsets in ORIGINAL space — never UTF-16 code units**; the walker input is the exact stored TEXT bytes as a `Uint8Array` (UTF-8-aware, multi-byte skipping). Vectors include astral content (CJK/emoji/multi-byte) **inside AND at the exact boundary of a spliced span** — a boundary-split must never occur; offsets must be byte-exact.
4. **Cross-runtime byte parity for shipped frame codecs** on post-dedup content: brotli q1/q4 and zstd l1 byte-identity fixtures (byte-stable); deflate logical-equality only. **[LOCKED two-tier rule]**
5. **Value-entry compression:** a repeated jumbo value stored once, envelope-compressed with `sha256` over the RAW bytes — decode both runtimes; verify the dedup key is unchanged by compression.
6. **Pure-ref frame:** 128 events all referencing one value → guard keeps the frame raw (or minimally framed) — decode exact.
7. **Seal-path allocation accounting:** per heavy event, record span-walk + hash + guard allocations in the seal ledger (adversarial A2) — fixture asserts the accounting is populated, not a perf number.
8. **Digest computation + digest-first idempotency (adversarial optimization O1):** (a) the 128-bit digest of the same canonical event must be identical on both runtimes (hashing contract: `sha256(canonical JSON.stringify(schema-encoded data))` truncated to 128-bit, cross-runtime deterministic **[MEASURED §3.2]**); (b) an idempotent-replay vector: seal → replay `commitDurableEvent` with the identical event → digest match ⇒ idempotent with **zero frame decompress/value fetch**; (c) a divergence vector: mutated event → digest mismatch ⇒ divergence error, fail-closed; (d) a corrupt-digest vector: flip a digest bit in the (segment-CRC-protected) index → fail-closed divergence, never a wrong idempotent answer; (e) the full-compare authority path (test config) asserts identical outcomes to the fast path across the three-home corpus (G1 differential, D10 gate).

### 7.2 Capability probe (startup, both runtimes)

Unchanged from ideation **[LOCKED]** plus one addition: a **hash-determinism vector** (SHA-256 of a fixed payload must equal the pinned digest — cheap, asserts the value-path foundation). The zstd-dict probe stays the gate that blocks trained zstd dictionaries; re-probe on every Bun release. Probe runs in the same sidecar-boot window as the Stage-C fence **[LOCKED — contract.md §12a]**.

### 7.3 Matrix legs

The packaged-Electron leg is **done** (42.3.3 / Node 24.15.0 — results in §2). The compiled-Bun-`--compile` leg is the remaining artifact leg (benchmark-arch's three-leg matrix). **[MEASURED + UNRESOLVED]**

---

## 8. Jumbo / codec interaction (the 24 MB diff)

| Case | Path | Codec decision |
|---|---|---|
| 24 MB diff **repeats** (the T0 reality: top value repeated 1,284×) | value table, stored **once** | one envelope-compressed entry (brotli q1 default; q4/zstd only if the real-tail bench says so); **codec choice is nearly irrelevant vs dedup** |
| 24 MB diff **unique** | singleton frame (jumbo policy **[LOCKED]**) | worth-it guard decides raw vs compressed; if compressed: **[MEASURED]** zstd l1 (0.042) < brotli q4 (0.045) < brotli q1 (0.061) on diff-shaped text → zstd l1 or brotli q4 preferred when CPU budget allows (sealer CPU is budgeted, not free) |
| 24 MB **already-compressed** (base64 tool output) | singleton frame | guard returns RAW; never pay to compress entropy **[LOCKED]** |
| Jumbo read back interactively | value entry or frame decode | **decode speed matters on the read path**: zstd decodes ~1.5–2× faster than brotli (mechanism fact), brotli decode is quality-independent — factor into the adaptive choice for interactively-read classes; ≤5% p99 gate **[LOCKED]** |

**Jumbo + dedup ordering is mandatory:** dedup runs at seal BEFORE framing, so repeated jumbo content never enters a frame and never hits the frame-worth-it guard. The sealer scans candidate sub-values (≥ 1 KiB, ≥ 2 recurrences — threshold **[PROPOSED]**, gated on corpus D2/D3) and promotes repeats to the table; hashing cost is sha256 (~GB/s), amortized over the eliminated bytes.

---

## 9. Challenged assumptions — measured answers

1. **"Is brotli even right for git-diff-heavy content?"** — **[MEASURED]** the escape-tax question first: brotli on **escaped** JSON patch text (0.061 q1) ≈ brotli on **raw** patch text (0.063 q1) — within noise. The JSON escaping (`\n`, `\"`) costs ~2.9% raw bytes and **zero** compressed ratio; consistent escape tokens do not break LZ matching. **The de-escape pre-transform is rejected with measurement** — the codec loses nothing seeing escaped JSON, and canonical-escaped bytes keep the exactness guard trivial. Beyond that: on diff text, **zstd l1 beats brotli q4** (0.042 vs 0.045) — so the answer is "brotli is *fine* (byte-stable, locked), zstd l1 is *better on this class* and byte-stable too"; the adaptive switch is the right mechanism, not a format change.
2. **"LZ4-style / git-patch-aware pre-transform?"** — Rejected: LZ4 is a *speed* play with no `node:zlib` surface and worse ratio; a patch-aware transform against the *file blob* is **illegitimate for the format** (decode must be self-contained — the workspace file may not exist at decode time); patch-structure stripping is fragile/semantic-risk. The only transform that survived measurement (de-escape) is dead (§9.1). **The real "diff-aware" optimization is dedup itself** — it eliminates repeated diffs entirely, which no codec transform can.
3. **"Value table = the old 'shared dictionary' idea?"** — No: a trained/shared dictionary is a statistical, privacy-sensitive, corpus-shaped approximation. The value table is **exact, user-local, privacy-free by construction, unbounded** — it is the dictionary the prior ideation wanted, achieved with the user's own data. It subsumes the structural-deflate-dictionary hook (which survives only as a cold-first-frame nicety, deferred).
4. **"Does dedup break byte-stability?"** — No: the dedup key is sha256 over ORIGINAL span bytes (§3.2, deterministic); the guard's canonical reference is cross-runtime-identical **[MEASURED §3.2]**; refs are positional byte mechanics; frame codecs keep their byte-stability. Golden vectors pin all four. Byte-identity through seal→decode→reverse-export holds for ALL rows (canonical and non-canonical) because original bytes are what is stored.
5. **"Frame-worth-it guard must see pre-dedup sizes?"** — No: **[PROPOSED]** it compares post-dedup bytes (§4). Comparing pre-dedup would hide the ref-win and mis-fire on pure-ref frames.

---

## 10. Open questions

1. **Value-table granularity/scope on the real corpus:** whole-summary (v1) vs per-patch splicing — does per-patch win on real aggregates where summaries partially change? (corpus D2/D3; oses-arch owns the scan, codec-arch owns the splice mechanism that makes the choice a policy flip.)
2. **Value-entry compress choice on the real tail:** brotli q1 vs zstd l1 vs raw for the stored unique values — the diff-text probe favors zstd l1, but the real tail must decide (D1/D4).
3. **Adaptive codec selector cost model:** the sealer-side rule "zstd l1 on text-heavy frames, brotli q1 elsewhere" needs a cheap pre-classification (e.g., first-frame heuristic or type-based hint) that does not itself cost a full extra compress attempt; benchmark the ladder order.
4. **Splice + elision ordering:** elide first (shrinks payload) vs splice first (offsets vs elided shape) — must be a fixed, golden-vector-pinned order; implementation detail but a correctness trap. (The span-walker in §3.3 locates both spans in one pass; the ordering pins which byte offsets the splice list refers to.)
5. **Hash-collision policy at scale:** 64-bit truncation of SHA-256 vs full digest for the per-aggregate `UNIQUE` key — the value table at millions of rows makes the collision calculus real; full digest costs 32 B/value, truncation risks a (detectable — guard) collision. Gated on D2 sizing.
6. **part.updated non-consecutive repeats (adversarial C4):** the "0% byte-identical-consecutive" T0 stat does NOT test non-consecutive repeats — retry-replay (`tool.input` repeated across a retry) is a plausible in-`part.updated` dedup candidate. D4 must scan `part.updated` sub-values for non-consecutive repeats before the ruleset exclusion is locked; my §4 "unique text" classification is conditional on that result.
7. **Seal-path allocation budget (adversarial A2):** original-span walk + per-candidate sha256 + guard re-serialization add ~1–2 full-value allocations per heavy event in the sealer process; the seal-cost ledger + pacing controller must account for it (heavy-session seal must not starve the model stream).

---

## 11. Must-benchmark (codec lane; corpus gates D1–D8 own methodology)

1. **Real-tail codec sweep on post-dedup content** (corpus T1/T2): brotli q1/q4 × zstd l1/l3 × raw on (a) `part.updated` monotonic text, (b) post-dedup `message.updated` unique summaries, (c) real git diffs — ratio + compress/decode p50/p95/p99 + WAL.
2. **Escape-tax confirm on real diffs** (probe says ≈0; confirm on T0/T1 diff patches, incl. non-ASCII/unicode diffs where escapes are 6-byte `\uXXXX` — the one case where the tax is real).
3. **Value-entry compression** (q1/zstd/raw) on the real distinct-value distribution + read-path decode latency for rehydrated refs (correction doc §5.3's "cheaper than decompression" claim, measured on the packaged runtime).
4. **Threshold calibration** for value promotion (≥ 1 KiB, ≥ 2 recurrences) against table overhead (D2/D3 sizing).
5. **Splice-offset stress:** fuzz payloads with astral-plane content, deeply nested refs, adjacent refs — byte-exact offsets + round-trip, in ORIGINAL space (span-walker against raw stored text, incl. non-canonical rows).
6. **Pure-ref frame path** at scale (replay of a heavily-dedup'd session) — index/splice-list bytes per event must stay in the ~5–10 B/event budget (event-codec.md §3.4).
7. **Seal-path cost ledger (adversarial A2/R9):** measure span-walk + per-candidate sha256 + two-tier guard (semantic deep-equal + canonicality re-serialization) allocations and CPU per heavy event (24 MB summary class) on the packaged runtime; feed the sealer pacing controller — the heavy-session seal must not starve the model stream. **Walker-cost estimate (R9 — replaces any stale parse-only number):** a hand-rolled UTF-8-aware JSON tokenizer runs ~50–150 MB/s vs V8's native `JSON.parse` ~200–400 MB/s, and the migration rebuild walks the corpus up to twice (pass 1 + pass 2) → the 18 GB rebuild is **~5–15 min CPU spread over idle windows, not 1–3 min** (migration.md §3.2 estimate must be revised accordingly); the ledger measures the real number.
8. **D4 part.updated non-consecutive scan (adversarial C4, corpus lane):** `tool.input`/`tool.result` sub-values across retries — before the ruleset exclusion is locked; if repeats found, the extractor registry extends and my §4 classification flips.

---

## 11a. Adversarial strengthening pass (round 1) — what changed and why

Coordinator-routed revisions from `adversarial-evaluation.md` (devil's-advocate pass). All four items adopted:

| # | Attack | Disposition | Change |
|---|---|---|---|
| A1/A2 | Splice span in canonical space → byte-non-exact for non-canonical rows; vacuous encode guard; seal CPU | **Adopted (stance (a))** | §3.2/§3.3 rewritten: span-walker extracts sub-value spans from the **ORIGINAL event text** (single pass, also locates the elision span); dedup key + stored bytes = original span; guard is now real (`original == canonical re-serialization`, store original on mismatch); reverse export is byte-exact for ALL rows; seal-path allocations added to the seal ledger. |
| C3 | Byte-identity vs logical-equality gates contradict the invariant for non-canonical rows | **Adopted (stance (a))** | Byte-identity is the gate for sealed events (G1/G2 keep byte gates); deep-equality remains the replay floor; original-span storage removes the contradiction — decided now, golden vectors updated (§7.1). |
| A4 | `event_value.bytes` raw leaves 10–20× residual on the second-largest byte class | **Adopted** | §3.5: entry compression is v1 default (brotli q1, zstd l1 candidate, guard-fallback raw); `sha256` stays over RAW bytes; decode = one decompress per value-cache miss; storage.md §1.1 "raw" flagged for oses-arch alignment. |
| A2 | Sealer CPU (2× 24 MB allocations per heavy event) | **Adopted** | §3.3 ledger item + must-benchmark #7; original-space walk avoids the retired parent re-serialization trick (cheaper). |

Not routed here: C2 (uppercase-hex event-ID → oses-arch packer), A5 (pure-ref-frame-skip → storage.md §4.2.3 skip instruction deleted; guard is single source of truth — §4 cross-ref), C4 (D4 part.updated scan → corpus lane, conditional in §4).

### Round-2 reconciliation (`adversarial-evaluation-r2.md`)

| # | Attack | Disposition | Change |
|---|---|---|---|
| R1 | Encode guard can't distinguish walker mislocation from non-canonical serializer — "store original anyway" silently propagates a wrong span | **Adopted** | §3.3 guard is now **two-tier**: (1) semantic check `JSON.parse(span)` deep-equals `parsed[path]` — failure ⇒ walker bug ⇒ **inline, never store**; (2) canonicality check — mismatch after a passing semantic check ⇒ non-canonical serializer ⇒ store original, log. ~free (event already parsed). |
| R2 | Walker offset space unspecified — UTF-16 vs UTF-8 diverge on astral content | **Adopted** | §3.3 pins: walker input = exact stored TEXT bytes as `Uint8Array` (UTF-8), offsets emitted in **bytes**, UTF-8-aware multi-byte skipping; §7.1 #3 golden vectors add astral content **at the span boundary**. |
| R5 | §4 "pure-ref frame stays raw" vs storage/readpath "compresses 20–40×" — same guard, opposite predictions | **Adopted** | §4 adds the frame-size reconciliation: at Tier P 16 KiB, shell frames compress to ~1–2 KB stored; frames below `MIN_GAIN + overhead` stay raw — both from one formula, grounding readpath's G4 closer. |
| R9 | Span-walker doubles rebuild walk cost; "1–3 min" estimate stale | **Adopted** | must-benchmark #7 revised: walker ~50–150 MB/s vs native parse 200–400 MB/s, corpus walked ≤2× → **5–15 min CPU over idle windows**; migration.md §3.2 estimate flagged for revision. |
| R10 | Hygiene: stale §3.5 alignment flag; "canonical JSON bytes" terminology in §4 | **Adopted** | §3.5 stale flag removed (storage.md already changed); §4 guard formula unified on **ORIGINAL (elided) event-text bytes**. |

Not routed here: R3 (G4 byte-king scoping → readpath.md/corpus.md), R4 (stale "raw in v1" in readpath.md §3.4/§10 + contract.md §7 — their edits), R6 (G11 double definition → benchmark.md), R7/R8 (migration.md recovery/cross-volume — never revised), R10's contract.md stale spot (their edit).

### Round-3 optimization (`adversarial-optimization.md`)

| # | Proposal | Disposition | Change |
|---|---|---|---|
| O1 | Per-event logical digest + digest-first replay idempotency (100–1000× on the byte-king class's idempotency check) | **Adopted — format field reserved NOW** | §3.3: `has_digest` flag + optional 128-bit digest (`sha256` of canonical data, truncated) reserved in the **uncompressed per-event index entry**, alongside the splice list — empty until gated; if it were in the compressed stream the fast path dies. §7.1 #8: digest golden vectors (cross-runtime determinism, idempotent/divergence/corrupt-digest, full-compare authority parity, G1 differential via D10). |
| O3 | zstd l1 default-flip for Tier R frames AND value entries | **Adopted — SHOULD-IT-BE-DEFAULT, D7-gated** | §2 records the flip candidate + LOS-2 loss flag (brotli q1 Tier R default loses decode speed + ratio vs zstd l1); both byte-stable so parity-safe; D7 + the value-entry bench (§11 #3) decide. |
| LOS-2 | brotli q1 Tier R default = decode-speed + ratio loss | **Adopted** | Recorded in §2 with the D7 gate. |

Not routed here: O2 (per-patch granularity → D9, already in §3.4/§10.1), O4 (OPCL-on-message → opcl-arch/D1), O5 (global table → oses-arch/D2), O6 (64-bit truncated UNIQUE key → oses-arch, my §10.5 already has the collision calculus), O7/O8 (pages/checkpoint → storage/benchmark), O13 (decoded tail cache → readpath, keep OFF), O11/O12 (structural/semantic-deltas → already cut, confirmed NOT-VIABLE).

---

## 12. Corrections to prior docs (vs the corrected Pareto)

| Prior claim | Correction | Where |
|---|---|---|
| "Structural deflate dict = the only ship-first dictionary" (ideation/codec.md) | **Subsumed by the value table.** The exact per-aggregate content-addressed table is the ship-first dictionary; structural deflate dict survives only as a cold-first-frame nicety, deferred. | §3.1, §9.3 |
| "Zstd = ratio-optimization candidate" (ideation/codec.md) | Promoted for the **diff/text class**: measured zstd l1 < brotli q4 on diff text, byte-stable. Still adaptive, not default. | §2, §9.1 |
| "Elision is a headline free win" (ideation/event-destructuring.md) | ~0.2% on this corpus **[T0-MEASURED]**; keep the rule, drop the headline. | §6 |
| "Structural encoding 0.043–0.051" (ideation/event-destructuring.md) | Retracted — measured on synthetic steer-heavy payloads; ~2% on real diff-dominated corpus. Splice-ref achieves the real Pareto-A win WITHOUT structural encoding. | §3.3, §5 |
| "Per-frame worth-it guard vs sum(raw events)" (ideation/event-codec.md) | Guard compares **post-dedup** raw; pure-ref frames must skip compression. | §4 |
| De-escape pre-transform (hypothesized in this chapter's brief) | Rejected with measurement: escape-tax ≈ 0; canonical-escaped bytes kept. | §9.1 |

---

## 13. Locked decisions this chapter relies on (cross-ref)

Frozen registry `1=zstd/2=brotli/3=raw-deflate`; brotli q1 byte-stable baseline; deflate interop-only; zstd-dict capability-gated; intersection writer policy; two-tier golden vectors; `node:zlib.crc32`; `sessionID` elision; value table per-aggregate content-addressed with `sha256 UNIQUE`; frame (not event) is the compression unit; microframes 16–32 KiB; jumbo singleton frames; codec probe before first post-cutover write. — all in `ideation/SYNTHESIS.md` §2/§5; not re-opened.

---

*Prepared by codec-arch. Claim labels per benchmark-arch's corpus rules: [T0-MEASURED] cites the sanctioned snapshot; [MEASURED] is mechanism-class probe data (reproducible via the probe described in §2/§9). This chapter feeds `PLAN.md` (coordinator).*
