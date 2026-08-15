# Adversarial Evaluation — ROUND 2 (post-strengthening pass)

**Author:** adversary, swarm `chunkdb-ideation` · **Date:** 2026-08-15
**Round 1 baseline:** `docs/chunkdb/architecture/adversarial-evaluation.md` (13 attacks, 10 proposals).
**Targets (strengthened):** `architecture/{storage,contract,codec,readpath,corpus}.md` (revised 11:58–12:02), `ideation/oses.md` (12:04), `ideation/benchmark.md` (11:59). **migration.md (architecture) was NOT revised** (timestamp 11:47 — before the Round-1 deliverable; byte-identical size). Evidence labels: [LANDED] / [PARTIAL] / [MISSING] / [NEW].

---

## PART 1 — AUDIT OF ROUND-1 FIXES (verify, don't assume)

| # | Round-1 proposal | Verdict | Evidence |
|---|---|---|---|
| P1/A1 original-span storage + real guard | **PARTIAL** | storage.md §1.3/§2.2, codec.md §3.2/§3.3, contract.md §3.3 all landed: span-walker extracts from ORIGINAL event TEXT, stored bytes = original span, guard = `original == canonical re-serialization` (mismatch → store original anyway), vacuous guard deleted, non-canonical vectors (`1e21`/`-0`/`1.2300`/`1e400`) added to golden vectors (codec.md §7.1 #2). **BUT the guard still cannot distinguish a *walker mislocation* from a *non-canonical serializer* — see NEW-R1.** The "store original anyway" branch is only safe for serializer-non-canonicality. |
| P2/A4 compress `event_value.bytes` | **PARTIAL (cross-chapter stale)** | storage.md §1.1 + §10.3 (compressed by default, raw below ~64 KiB, sha256 over raw), codec.md §3.5 (v1 default), contract.md §3.4 (adopted). **BUT readpath.md §3.4/§10 and contract.md §7 still carry "raw in v1" (three stale spots directly contradicting the adopted default — NEW-R4).** |
| P3/B1 G4 triangle resolved | **PARTIAL** | readpath.md §1.4 resolves it three-cornered: S2-primary pin + Tier P 16 KiB zstd / ≤8 KiB brotli + reference-hardware-first ordering (corpus.md §7 "Hardware-first ordering"). **Two residuals: (a) G4's semantic shift cold→warm-OS must be recorded in gates.json (the number is no longer a cold bound; S3 is reported-secondary, S4 <2 ms is the real cold guarantee); (b) the byte-king point-read class still busts even S4 — NEW-R3.** |
| P4/B2 lazy per-ref / eager only replay / admission cap | **LANDED** | readpath.md §3.1 (mode-aware: eager for REPLAY/RANGE with 16 MiB segment-buffer cap; lazy per-ref for point reads), contract.md §3.2 (fetch policy), storage.md §2.1 (admission cap). The gigabytes-per-point-read blowup is closed. |
| P5/C1 per-value integrity tag | **LANDED** | storage.md §2.1/§2.3 (segment value directory carries `crc32(raw)` per value_id, verified before splice on cache-miss; G10 case added), contract.md §4.2 (required read step, not optional). Sound: tag is computed over RAW bytes pre-compression and verified over decompressed bytes post-fetch — lossless codecs make the two identical. |
| P6/B3 sealer commit pinned + G11 | **PARTIAL** | storage.md §6: sealer BUILD+COMMIT pinned to the `withBackfillDb` own connection, "shared connection" alternative REMOVED — LANDED. **G11 is defined TWICE with different budgets — benchmark.md §7.2: ≤+5% read p99 / ≥95% model-token; readpath.md §8.1: <1% read p99 regression / token inter-arrival <1% — NEW-R6.** One number must win. |
| P7/A6 frame_count=1 v1 policy | **LANDED** | storage.md §4.3 (v1 policy for ALL segments, format field kept, multi-frame machinery deferred to D7). Tier P/Tier R survive as a *placement* policy over single-frame segments (a segment is either Tier P 16 KiB or Tier R 32 KiB) — the point-read accelerator is not weakened by the cut (segment blob = frame blob; registry `(frame_idx, offset)` becomes `(0, offset)`). |
| P8/A3 cross-aggregate histogram | **LANDED** | storage.md §11.5 + corpus.md D2/D3 scan item 6 (bounded global hash histogram across same-workspace sessions; per-aggregate confirmed only if <~5% cross-aggregate share). |
| P9/C4 part.updated non-consecutive scan | **LANDED** | storage.md §11.4 + corpus.md scan item 7 + contract.md §6 (exclusion "measurement-pending, not locked") + codec.md §4/§10.6 (classification conditional on D4). |
| P10/C2 uppercase-hex ID escape | **LANDED on disk (after coordinator's routing)** | ideation/oses.md §3.1–3.2 (revised 12:04, after the coordinator's "pending" note): canonical = `evt_` + **12 LOWERCASE hex** + base62; uppercase hex / wrong length / non-base62 → escape path with byte-exact round-trip; golden vector for uppercase-hex required. **No other chapter contradicts it** (benchmark.md §5.3's "byte-lossless by construction" holds because uppercase now escapes). Corpus `retry-replay` should add an uppercase-hex fixture to exercise it (oses.md now demands the vector). |
| A5 pure-ref-frame-skip contradiction | **LANDED** | storage.md §4.2 + §12.4: skip instruction DELETED, worth-it guard = single source of truth, "shell/pure-ref frames COMPRESS". codec.md §4 confirms "no explicit skip instruction anywhere". readpath.md §2.2 carries a stale note claiming storage.md §12 still has the skip line — **that note is itself stale** (storage.md v3 fixed it). **BUT codec.md §4 still predicts the guard "naturally keeps a pure-ref frame raw" — the opposite outcome from storage/readpath's "compress 20–40×" for the same class — NEW-R5.** |

**Cross-chapter contradiction sweep (JOB 2g):** three live contradictions found — NEW-R4 (value-entry raw-vs-compressed), NEW-R5 (pure-ref guard outcome), NEW-R6 (G11 double definition) — plus two stale internal cross-refs (readpath.md §2.2's flag; codec.md §3.5's alignment flag) and one stale internal spot (contract.md §7 "v1 = raw").

---

## PART 2 — NEW ATTACKS ON THE STRENGTHENED STATE

### NEW-R1 [CORRECTNESS-RISK] The encode guard still cannot tell a walker bug from a non-canonical serializer — "store original anyway" propagates a wrong-span splice silently

**Attacked:** storage.md §1.3/§2.2, codec.md §3.3, contract.md §3.3 — the guard `original_span_bytes == canonical_re-serialization(JSON.parse(original_span_bytes))`, mismatch → "store the original span bytes anyway (dedup stays correct, byte-exactness preserved)".

That branch is correct **only** when the mismatch is caused by serializer non-canonicality (`1e21` etc.). But the span-walker is new machinery with its own failure modes — mislocated span, wrong duplicate-key occurrence, exotic-but-parseable JSON — and a walker bug produces a span that is **not** the sub-value at all. For such a span:
- if the wrong bytes happen to round-trip canonically (the common case — the walker sliced some neighboring string/number), the guard **passes**, the wrong bytes are stored, and every read of that event silently splices a different summary than the event carried;
- the replay path catches it later (`isDeepStrictEqual` divergence → fail-closed), but ordinary `readAggregate`/sync-history reads serve the wrong data silently — the exact silent-corruption hole C1 closed for *value-row* corruption is reopened for *walker* corruption.

**Fix (near-free):** the guard must add a **semantic check**: `JSON.parse(original_span) deep-equal parsed_event[path]` (the event is already parsed in the sealer for elision — one deep-equal per candidate, ~zero cost). Only spans that pass BOTH the byte check and the semantic check are promotable; anything else falls back to inline (never store, never "store original anyway" for a span that is not the path value). This is the one-line addition that makes the guard robust against its own new dependency.

### NEW-R2 [CORRECTNESS-RISK] The span-walker's offset space is unspecified — UTF-16 code units vs UTF-8 bytes diverge on astral content

**Attacked:** codec.md §3.3 — "offsets = UTF-8 BYTE offsets"; the walker "maps versionedType-path → byte span over the original event text"; the splice list records those offsets.

A JS `JSON.parse`/string-walker operating on the decoded JS string indexes **UTF-16 code units**. SQLite TEXT is UTF-8 bytes. For any astral character (CJK, emoji, most non-BMP) inside or adjacent to the spliced span, a code-unit index ≠ byte offset. If the walker emits code-unit offsets into a splice list that decode interprets as byte offsets, the splice lands in the middle of a multi-byte character → invalid UTF-8/JSON → either fail-closed (lucky) or a shifted-but-valid splice (silent wrong data). codec.md §7.1 #3's splice-offset fuzz covers astral content but the **walker input source is unspecified**: does it walk the JS string (re-encoded to bytes — an extra full-copy of every event, doubling the seal allocation) or the exact stored UTF-8 bytes directly? **Fix: pin the walker input = the exact stored TEXT bytes (UTF-8) as a Uint8Array, offsets emitted in bytes; the walker must be UTF-8-aware (multi-byte sequence skipping), and golden vectors must include astral content at the *boundary* of a spliced span** (not just inside).

### NEW-R3 [PERF-RISK] G4's budget table calibrates the parse at "1–4 KiB shell" — the class the design itself identifies as point-read materializes 100s of KB

**Attacked:** readpath.md §1.2 (JSON.parse row: "1–4 KiB shell ~5–20 µs") vs §2.2 ("message.updated/session.updated post-dedup are exactly the point-read candidates") and §1.3 (G4 pin <500 µs S2-primary, S4 <2 ms hard bound; jumbo carve-out >4 MiB only).

A point read of a sealed `message.updated` event (the replay-idempotency check IS a point read, contract.md §4.1) requires the **full data object** — the splice re-inserts the entire summary (≥1 KiB by SIZE_THRESHOLD, typically 3.2 KB–548 KB, max 24 MB), and JSON.parse of the spliced payload is linear in that size. A 548 KB summary parse is ~1–5 ms — **10–100× over the primary pin and over the S4 2 ms hard bound**, and the jumbo carve-out (>4 MiB) does not cover the 100 KB–1 MB middle. The budget table's parse row describes a *small* event; the identified point-read class is not small. The "decompress tens of µs" closer (compressed frame) is real for the *frame* but the *value materialization* is the actual point-read cost of this class, and it is unbudgeted.

**Fix (pick one, state it):** (a) scope G4's primary pin explicitly to "small logical-payload point reads" and give the byte-king class a documented separate budget (e.g. "point-read of a ≥64 KiB-logical event is bounded by its logical size; jumbo carve-out extended to ≥64 KiB"), or (b) add a per-event **stored logical digest** (crc32/sha256 of the canonical data, ~8–32 B/event at seal) to the point-read accelerator and make the replay-idempotency check digest-first (on digest match → idempotent without materializing; on mismatch → full materialize+deep-equal). (b) changes the replay fast path — it must be reviewed as a semantic change and covered by G1 differential, but it is the only way a byte-king point read becomes cheap. Recommend (a) for v1 honesty + (b) as a gated optimization.

### NEW-R4 [CONTRADICTION] The A4 fix landed in three chapters but three stale "raw in v1" spots remain

**Attacked:** readpath.md §3.4 ("read-path vote is **raw in v1** — a compressed value entry would put a decompress on every splice"), readpath.md §10 rows ("CONFIRMS §3.5's open toward raw"), contract.md §7 ("[PROPOSED] v1 = raw; compression is a Pareto refinement") — all directly contradicting storage.md §1.1/§10.3, codec.md §3.5, contract.md §3.4 (compressed by default).

The readpath objection ("decompress on every splice") is also wrong under its own cache design: the segment buffer + value LRU (§3.1/§3.3) mean a compressed value decompresses once per cache residency, then splice is memcpy — identical to the raw case. **Fix: delete the three stale spots; the compressed-by-default decision is unanimous and the readpath chapters should record the cache-absorbed decode cost instead.**

### NEW-R5 [CONTRADICTION] codec.md §4 predicts the guard "keeps a pure-ref frame raw"; storage.md/readpath.md predict it "compresses 20–40×" — the G4 arithmetic hangs on which is right

**Attacked:** codec.md §4 table ("frame is tiny; the guard's MIN_GAIN naturally keeps a pure-ref frame raw") vs storage.md §4.2/§12.4 and readpath.md §2.2 ("shell frames are repetitive JSON that brotli crushes ~20–40× to ~1–2 KB stored ... the guard predicts these frames compress").

Both cite the same guard as the single source of truth and predict **opposite outcomes for the same frame class**. The reconciliation is a frame-size threshold (16 KiB of shells → compress; a few-KB frame → raw via MIN_GAIN), but neither chapter states it, and readpath's G4 closer ("point-read decompress = tens of µs") only holds if Tier P shell frames actually compress at 16 KiB. **Fix: one explicit sentence in codec.md §4** — "at the Tier P 16 KiB target, shell frames compress (≈1–2 KB stored); frames below ~MIN_GAIN+overhead stay raw" — so the G4 arithmetic is grounded, not assumed.

### NEW-R6 [CONTRADICTION] G11 is defined twice with different budgets

benchmark.md §7.2: "interactive read/render p99 ≤ +5% and model-token throughput ≥ 95% of idle". readpath.md §8.1: "<1% p99 regression on every listed op" + token inter-arrival <1%. The same gate number, a 5× different read budget. readpath.md even argues 1% *because* G7 is 5%; benchmark kept 5%. **Fix: one definition in gates.json** — recommend readpath's <1% (the directive's "never affects the user" is the harder, honest expression; G7's 5% is the write-side gate, a different victim), and align benchmark.md's row.

### NEW-R7 [HOLE] File-swap recovery rule (c) is ambiguous between "rebuild in progress" and "swap pending" — the normal completed-rebuild startup can be stuck aborting

**Attacked:** migration.md §4.2 step 4(c): "both `opencode.db` and `opencode.db.new` present → abort, log, keep current" — running "at every startup, BEFORE opening".

During Tier-L rebuild (multi-session), every startup sees both files and rule (c) correctly aborts. But the same rule fires when the rebuild is **complete and the swap is pending** — the design never distinguishes them, and the swap decision (step 2) vs the recovery check (step 4) have **no pinned ordering**. As written, the most common startup state (rebuild done, swap should happen) hits (c) and aborts — the swap is unreachable without manual intervention. The kill-point table (K-SW-0..3) covers mid-swap crashes but not the pre-swap "ready" state.

**Fix:** introduce an explicit **swap-pending marker** (e.g. `oses_migration.phase='verified'` in the new file, or a sidecar flag set when catch-up lag ≈ 0) and pin the startup ordering: (1) recovery rules handle crash windows *first* (opencode.db missing → complete/restore per (a)/(b)); (2) then, **only if** the swap-pending marker exists and verification passes → run step 2 renames; (3) rule (c) fires only for the genuinely-unexpected "marker absent but both files present" state. The "never both/neither" invariant survives; the normal path becomes reachable.

### NEW-R8 [HOLE] The disk formula assumes same-volume rebuild; migration.md was never revised — Round-1 D3 items still open

**Attacked:** migration.md §6 — "≈26–30 GB free to migrate the 18 GB DB **in place on the same volume**"; §6.1/§6.2 unchanged from Round 1.

(a) **Cross-volume rebuild is not considered**: `opencode.db.new` can be built on a scratch/backup volume (its only writer is the rebuild; the swap's renames are same-volume, so the new file must be moved/copied to the DB volume at swap time — but that final move is a one-time copy, not the multi-hour build). This relaxes the hardest user-facing gate from "26–30 GB free on the DB volume" to "WAL headroom on the DB volume + build space anywhere". Propose it as the default for Tier L with a free-disk decision at swap time. (b) **migration.md was not touched in the strengthening round** (timestamp pre-Round-1) — Round-1 D3 items remain open: rebuild/catch-up throughput numbers are pristine-TEXT-only, and the partially-OCDB-framed input leg is unspecified in the estimates; the D8 rehearsal must include a framed-input leg, and the catch-up-vs-busy-writer escape (open Q2) is still an open question.

### NEW-R9 [PERF-RISK] The span-walker doubles the rebuild's walking cost — the 1–3 min CPU estimate was JSON.parse-only

**Attacked:** codec.md §3.3 (walker, one pass per event) + migration.md §3.3 (two-pass rebuild: pass 1 hash inventory, pass 2 re-read + promote) + migration.md §3.2 estimate ("JSON.parse+hashing of 18 GB ≈ 1–3 min CPU").

A hand-rolled JS JSON tokenizer with path→span tracking is slower than `JSON.parse` (typically 50–150 MB/s vs 200–400 MB/s for V8's native parse). The rebuild walks the corpus **twice** (pass 1 + pass 2, per aggregate — migration.md §3.3 says total re-read ≤ 2× legacy bytes), plus per-candidate guard re-serialization (NEW-R1's semantic check adds one deep-equal per candidate, cheap). 36 GB of walking ≈ 4–12 min CPU, plus the walker's allocations — the estimate should be revised to "5–15 min CPU, spread over idle windows", and the seal ledger (codec.md must-benchmark #7) should measure it. Async and budgeted, so not blocking — but the number quoted everywhere ("1–3 min") is stale.

### NEW-R10 [MINOR] Stale internal cross-refs and one terminology drift

- readpath.md §2.2 table row: "storage.md §12 headline 4 still carries a stale 'skip compression' line — flagged to oses-arch" — **stale** (storage.md v3 fixed it; the flag should be removed).
- codec.md §3.5: "storage.md §1.1's 'bytes stored raw in v1' contradicts this — oses-arch revision must change the default" — **stale** (already changed).
- codec.md §4 guard formula: "payload_raw = Σ **canonical** JSON bytes" vs §3.3 "payload_bytes = **ORIGINAL** (elided) event text" — terminology must be unified on "original" now that span storage is the stance.

---

## PART 3 — UPDATED RANKED IMPROVEMENTS (strengthened state)

Ranking = (impact) × (probability it matters on the real corpus).

| # | Proposal | New/Remaining | Impact |
|---|---|---|---|
| 1 | **Semantic guard on the span-walker** (`JSON.parse(span)` deep-equals `parsed[path]`; on failure → inline, never store) — closes the walker-mislocation corruption path | NEW-R1 | The only remaining silent-corruption path in the headline mechanism; ~free (event already parsed) |
| 2 | **Pin the walker to exact stored UTF-8 bytes + byte offsets** (astral-boundary golden vectors) | NEW-R2 | Prevents a format-level splice corruption that golden vectors may miss until astral content appears |
| 3 | **Scope G4's pin to small-logical-payload point reads; give the byte-king class a stated budget (or add a stored logical digest + digest-first idempotency fast path, reviewed as a semantic change)** | NEW-R3 | G4 is currently unpassable for the exact class the design calls the point-read class; honesty + a path to fix |
| 4 | **Resolve the three stale "raw in v1" spots** (readpath §3.4/§10, contract §7) to match the adopted compressed-by-default | NEW-R4 | Removes a PLAN-blocking contradiction; one-line changes |
| 5 | **State the pure-ref frame-worth-it threshold** (compress at Tier P 16 KiB; raw below MIN_GAIN) so the G4 "tens of µs" closer is grounded | NEW-R5 | Grounds the arithmetic G4 depends on |
| 6 | **Single G11 definition** (recommend readpath's <1% read-p99 + token inter-arrival; align benchmark.md) | NEW-R6 | One gate number, or the gate is ambiguous at pin time |
| 7 | **Swap-pending marker + pinned startup ordering in the file-swap recovery** | NEW-R7 | Makes the normal completed-rebuild swap actually reachable |
| 8 | **Cross-volume rebuild for Tier L + a framed-input leg in D8; revise the walker-cost estimate (5–15 min, not 1–3)** | NEW-R8/R9 | Relaxes the hardest user gate; fixes the stale estimate; closes the Round-1 D3 gap |
| 9 | **Uppercase-hex ID fixture in the retry-replay corpus class** (C2's golden vector, corpus-side) | P10 follow-up | Exercises the escape path against real corpora |
| 10 | **Clean stale cross-refs + unify "original" terminology in codec.md §4** | NEW-R10 | Hygiene; prevents future misreads |

**Still standing from Round 1 (unchanged, still open):** D2/D3/D4 scans are the gate that turns every number downstream of the 35–65% band into a measured claim (corpus.md §2/§7 evidence-class ledger — correctly tagged provisional). The 16–32 KiB geometry lock remains argued from synthetic steer curves until D7's post-dedup byte-class sweep (corpus.md §7 now requires it). Value-entry codec choice (brotli q1 vs zstd l1) stays open until the real distinct-value distribution lands (D2/D3).

---

## PART 4 — VERDICT: ready for PLAN.md?

**Conditional readiness — the architecture survives the second pass structurally, but not with a clean bill.**

What is now genuinely strong: original-span storage + real (byte) guard, per-value crc32 integrity tag on the read path, mode-aware value preload (eager-replay / lazy-point), sealer commit pinned to a dedicated connection, frame_count=1 with a surviving Tier P/Tier R placement split, cross-aggregate + non-consecutive scans added to D2/D3/D4, evidence-class tagging of every number, G11 drafted, and C2's uppercase-hex escape landed on disk.

What must land **before PLAN.md is written** (all small, targeted — this is a reconciliation round, not a third full pass):
1. NEW-R1 (semantic guard) — a genuine correctness hole in the headline mechanism; fold into storage.md §1.3 + codec.md §3.3 + contract.md §3.3.
2. NEW-R2 (walker byte-offset pin) — format-spec decision; fold into codec.md §3.3 + golden vectors.
3. NEW-R3 (G4 scope for the byte-king class) — decide stance (a) or (b); fold into readpath.md §1.3/§1.4 + corpus.md gates.
4. NEW-R4/R5/R6 (three contradictions) — one-line reconciliations across readpath/contract/codec/benchmark.
5. NEW-R7/R8 (migration holes) — migration.md is the one chapter that never got a strengthening pass; it needs the swap-pending marker, the cross-volume option, and the D8 framed-input leg.

These are five small edits across the chapters, not a design reversal. If the coordinator folds them in, the architecture is ready for PLAN.md; the D2/D3/D4 scans then do their job of converting hypotheses to numbers, and the gates get pinned at corpus-v1 with the G4 semantics stated honestly (S2-primary, S3 reported, S4 hard, byte-king class scoped). **Recommend: one targeted reconciliation round (R1–R8), then PLAN.md.**
