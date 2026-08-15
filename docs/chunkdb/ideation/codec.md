# Codec, Dictionary & Cross-Runtime Compatibility Ideation

**Lane:** codec-arch · **Swarm:** chunkdb-ideation · **Branch:** `openfork` (v1.18.18) · **Date:** 2026-08-14
**Companion docs:** `architecture-research.md` (baseline), `ideation/benchmark.md`, `ideation/migration.md`
**Status:** ideation — no implementation code. Numeric IDs and thresholds are proposals to freeze at implementation time.

---

## 0. Evidence legend

| Label | Meaning |
|---|---|
| **[MEASURED]** | Directly measured this session on Bun 1.3.14 and Node v22.23.2 (probes in §3). |
| **[VERIFIED]** | Read from the `openfork` tree or runtime artifacts this session. |
| **[INFERENCE]** | Architectural conclusion from the above. |
| **[PROPOSED]** | Design value/format decision to freeze at implementation start. |
| **[UNRESOLVED]** | Must be closed by the packaged-artifact benchmark phase. |

**Probe environment this session (three runtimes):** Bun 1.3.14 (`process.version` reports `v24.3.0`), Node `v22.23.2`, and **the actual packaged runtime — Electron 42.3.3's bundled Node v24.15.0** (verified `ELECTRON_RUN_AS_NODE=1 electron.exe --version` → `v24.15.0`, matching the research doc's claim from `packages/desktop/package.json:51`). **The Electron probe is now DONE and its results are authoritative for the desktop path (§3).** The remaining unprobed artifact is the Bun-`--compile` standalone binary (probe must run against it in CI — benchmark-arch's three-leg matrix).

---

## 1. Executive summary — headline recommendations

1. **The fork already ships a codec: OCDB frame v2 (`packages/core/src/database/json-codec.ts`) with registry `1=zstd, 2=brotli, 3=raw-deflate`, default brotli q1, hand-rolled CRC32, 14-byte header.** Freeze THAT registry now (bytes are already on disk); the research doc's proposed registry (`1=raw DEFLATE, 2=Brotli, 3=Zstd`) and Appendix B (`1=deflate-raw-l1…`) **conflict with shipped bytes and must be corrected**. New codec IDs go above 3; never renumber.
2. **Byte-for-byte cross-runtime identity is NOT a property of deflate — it IS a property of brotli and (dict-less) zstd.** Measured: `deflateRawSync` produces different bytes on Bun vs Node for the same input/level (different embedded zlib versions); brotli q1/q4 and zstd l1/l9 are byte-identical. Recommendation: **brotli (already the fork default) is the byte-stable baseline; deflate is demoted to a compat/fallback codec; zstd (dict-less only) is the ratio-optimization candidate.**
3. **Zstd + dictionary is broken on Bun 1.3.14 in both directions** — Bun silently *ignores* the dictionary on compress, and *cannot decode a Node-written zstd-dictionary frame even when given the correct dictionary* (`ZSTD_error_corruption_detected`). **Trained/shared zstd dictionaries must NOT be a mandatory shipped codec today.** Deflate+preset-dictionary IS cross-runtime interoperable (verified both directions) but not byte-identical.
4. **Capability detection must be a startup probe, and the WRITE policy must be the intersection of codec capabilities across every shipped runtime, frozen at release — not the local runtime's set.** A writer may emit only codecs in the intersection; a reader fails closed on anything unknown (§5).
5. **Checksum: keep CRC32-over-decompressed-bytes semantics (frame layout unchanged), but swap the hand-rolled bitwise implementation for `node:zlib.crc32`** — verified identical output on both runtimes and native speed. CRC is corruption-detection only, never a MAC.

---

## 2. Ground truth: what the fork actually ships (and what the research doc got wrong)

### 2.1 The shipped codec (OCDB frame v2)

`packages/core/src/database/json-codec.ts` [VERIFIED]:

```
offset 0  4B  magic "OCDB"
offset 4  1B  format version (2; v1 = 10-byte header, no CRC, still decodable)
offset 5  1B  codec: 1=zstd, 2=brotli, 3=raw-deflate
offset 6  4B  raw UTF-8 byte length, little-endian
offset 10 4B  CRC32 of DECOMPRESSED raw bytes, little-endian
offset 14 n   compressed payload
```

- `THRESHOLD = 4096` **UTF-16 code units**; rows under it stay TEXT forever.
- Default codec: **brotli q1**; `level` default 1. Zstd is codec 1 but is NOT the default — the fork already made brotli the default.
- `toDriver` is IDENTITY: hot writes are plain TEXT (`JSON.stringify`), byte-identical to today. The **background sealer is the only frame producer**.
- Hand-rolled bitwise CRC32 (poly `0xedb88320`) — **[MEASURED] byte-identical to `node:zlib.crc32`** (`40a509bd` on the probe payload) on both runtimes, but ~8 bit-iterations/byte in JS.
- `dataType()` returns `text` with TEXT affinity, but a bound `Uint8Array` still stores under the BLOB storage class [VERIFIED — comment + sealer `typeof(data)='text'` eligibility]. The sealer and any future codec **depend on this**: never change column affinity such that BLOB gets coerced to TEXT.

### 2.2 The sealer

`packages/core/src/database/chunk-sealer.ts` [VERIFIED] — per-row `event.data` framing outside any event/projector transaction, with a partial index `idx_event_seal_candidates` (~68× eligibility speedup measured in fork) and an `ocdb_seal(table_name, row_id, raw_bytes, stored_bytes, time_sealed)` journal. Parallel bench (`packages/opencode/bench/chunkdb-seal-parallel.ts`) already uses a **`node:worker_threads` pool with byte-balanced chunks (~16 MiB)** — the execution-context pattern recommended in §9 already exists and is runtime-neutral.

### 2.3 Runtime topology (unchanged from research doc §5, re-verified)

- **Packaged desktop V1 server** = Electron 42.3.3 utility process (`sidecar.ts` ← `server.ts`) running the Node-targeted bundle → `node:sqlite` + Node 24.15's `node:zlib`. **[VERIFIED]** `electron.vite.config.ts` resolves `virtual:opencode-server` to `../opencode/dist/node/node.js`.
- **Standalone CLI** = Bun `--compile` binary (`script/build.ts`, `conditions: ["bun","node"]` → `sqlite.bun.ts`; `bun:sqlite` + Bun's `node:zlib`).
- **Opt-in V2 desktop** = staged `opencode-cli` (Bun) that can discover and open the same state home (`background-cli.ts`).
- Both SQLite adapters are **single-connection, one-permit semaphore, synchronous native calls** (`sqlite.node.ts`/`sqlite.bun.ts`). `cache_size = -64000` (~64 MiB).
- The shared codec module (`json-codec.ts`) imports only `node:zlib` — already the correct cross-runtime surface. Bun resolves `node:zlib` to its own implementation, which is where the parity divergence lives.

### 2.4 Research-doc corrections (codec lane)

| Research doc claim | Reality in `openfork` | Disposition |
|---|---|---|
| Registry §22.2: `0=raw, 1=raw DEFLATE, 2=Brotli, 3=Zstd`; Appendix B `1=deflate-raw-l1, 2=deflate-raw-dictionary-l1, 3=zstd-l1, 4=brotli-q1` | Shipped registry: `1=zstd, 2=brotli, 3=raw-deflate` (frames already on disk) | **Correct to the shipped registry; freeze it.** |
| §1.6 / §33.14: "Stable baseline candidate: raw Deflate at a low level" | Deflate is NOT byte-stable across runtimes (§3) — brotli is | **Correct: brotli = byte-stable baseline** (which the fork default already is). |
| §17.2: deflate+dict L1 best ratio on independent rows | Directionally fine, but trained dict via zstd is unusable on Bun today (§3.4) | **Qualify: structural deflate dict OK; zstd trained dict gated.** |
| §5.6 probe (sqlite version/compile opts) marked UNRESOLVED | Still unresolved; fold into the codec capability probe (§5) | **Adopt.** |
| §22.2 "Actual numeric assignments must be frozen only when implementation begins" | Implementation HAS begun (frames on disk) | **Freeze now; append-only from here.** |

---

## 3. [MEASURED] Cross-runtime codec facts — the table that decides everything

Probes: identical input bytes + identical options under `bun` and `node` (and cross-runtime file exchange). Payloads: session-like JSON with heavy repetition (3 generated + 1 tiny). Summary:

| Codec / op | Bun 1.3.14 vs Node v22.23.2 vs **Electron Node 24.15.0** | Interoperable (A writes, B reads)? | Byte-identical? |
|---|---|---|---|
| `deflateRawSync` L1/L6/L9 | **Node v22 == Electron Node 24.15 byte-for-byte** (same zlib lineage); Bun differs — different bytes AND different lengths every sample (e.g. sample0 L1: 2094 vs 1662 B; gzip L6 1253 vs 1270 B) | **Yes** (standard DEFLATE; cross-decode verified) | **No across Bun/Node; YES across Node↔Electron-Node** — zlib version skew is the divergence driver |
| `brotliCompressSync` q1 / q4 | Identical bytes + length on all samples across **all three runtimes** | Yes | **Yes (all three)** |
| `zstdCompressSync` l1 / l9 (no dict) | Identical bytes + length on all samples across **all three runtimes** | Yes | **Yes (all three)** |
| `node:zlib.crc32` | Identical value across all three | Yes | Yes (and == fork's bitwise impl) |
| `deflateRawSync` + `dictionary` | Applied on all three; Node↔Electron-Node bytes match, Bun differs | **Yes** (Node-write → Bun-inflate verified `equal=true`); missing dict → all fail ("invalid distance too far back") | **No across Bun/Node** |
| `zstdCompressSync` + `dictionary` | **Node v22 AND Electron Node 24.15 apply the dict identically (50 B, byte-identical); Bun IGNORES it (236 B == no-dict output)** | **NO on Bun — cannot decode a Node-written dict frame even WITH the dict: `ZSTD_error_corruption_detected`. Node/Electron side: fully correct, fail-closed.** | Node↔Electron: yes. Bun: broken |

### 3.1 Why deflate diverges

Deflate output is a function of the zlib library version (match-finder/strategy details), not just the options. Node's `node:zlib` (zlib 1.2.13) and Bun's embedded zlib are different builds → different bytes for `level`/`windowBits`/`memLevel`/`strategy` even when semantically identical. **Deflate is a standard and universally cross-decodable, but its compressed bytes are NOT a stable oracle across runtimes or even across Electron Node patch bumps.**

### 3.2 Why brotli/zstd agree

Brotli and zstd are fully deterministic given (algorithm, quality/level, input): no history-dependent match-finder state, and both runtimes embed spec-faithful reference implementations. **This is the property a golden-vector and dedup strategy needs.**

### 3.3 CRC32

`node:zlib.crc32` exists and matches on both runtimes; the fork's bitwise implementation is a correct but slow oracle. Swap implementation, keep semantics.

### 3.4 The zstd-dictionary bug (Bun 1.3.14) — why it's a hard gate, not a nit

Measured sequence:

1. Node v22 AND **Electron Node 24.15 (packaged runtime, verified)** compress dict-like input with `{dictionary, ZSTD_c_compressionLevel: 3}` → 50 B (dictionary actively used), **byte-identical between the two Node runtimes**. Bun same call → 236 B, byte-identical to its own no-dict output. **Bun silently ignores the dictionary on compress.**
2. Bun decompresses a Node-written 49–50 B dict frame — **with or without the correct dictionary** → `ZSTD_error_corruption_detected`. **Bun cannot read dict frames at all, and fails the same way it would on corruption — indistinguishable error path.**
3. Node/Electron decompress the same dict frame with the dict → exact round-trip; **without** the dict → deterministic `ZSTD_error_corruption_detected` (correct fail-closed). **The Node side is fully correct on the exact packaged runtime — the defect is Bun-only.**

Consequences:

- A Node writer + Bun reader on the same DB: every zstd-dict frame is unreadable on Bun → **hard veto trigger** (benchmark.md G-hard-veto #3 "unsupported runtime API / cannot decode").
- A Bun writer: dict is ignored, so frames are dict-less (accidentally decodable), but the writer believes it used a dict it did not — wasted cycles, and it will not be byte-stable with a fixed Bun later.
- The corruption-class error on read means a naive sealer could *lose data detectability*: the frame is fine, the runtime is broken. Capability probe must catch this at startup, not at first read of a 2-year-old segment.

**Disposition:** zstd-dictionary is a *runtime-gated experimental* codec. It is admissible only as: (a) capability-probed at startup on every runtime, and (b) written only when the *intersection* policy (§5.2) admits it — i.e. effectively only once every shipped runtime passes the dict probe. Re-probe on each Bun release; this is a moving target, not a design decision that can be frozen today.

---

## 4. Codec registry design

### 4.1 Registry (freeze at implementation start; append-only)

| codec_id | Codec | Default level | Byte-stable across runtimes? | Status | Notes |
|---:|---|---|---|---|---|
| 0 | RAW (uncompressed, in-envelope) | — | Yes (identity) | [PROPOSED] reserved | For OSES frame-directory RAW frames and any future in-envelope raw use; today TEXT covers raw outside envelopes |
| 1 | zstd | 1 | **dict-less: yes; with dict: no (Bun broken)** | shipped | Existing fork ID — keep. Dict mode capability-gated (§5) |
| 2 | brotli | 1 | **yes** | shipped, **default** | Existing fork ID — keep. Stable baseline |
| 3 | raw-deflate | 1 | no | shipped (compat) | Existing fork ID — keep. Interoperable fallback; do NOT use for golden byte fixtures |
| 4+ | (future: zstd-dict-when-fixed, brotli-higher-q variants, etc.) | | | append-only | Never reuse an ID; never silently change meaning |

Rules: an ID's meaning is permanent once any frame references it. Adding a codec = new ID. Removing a codec = stop *writing* it; decoders stay forever (or a complete reverse migration exists — migration.md).

### 4.2 Codec identity vs runtime preference — keep them in separate layers

- **On disk (format):** `codec_id`, `dictionary_id`, `format_version`, `raw_len`, `stored_len`, checksums. Levels/strategies are never on disk.
- **In the writer (runtime config):** level, which codec to try first, adaptive thresholds, worker count. Purely process-local.
- **Rule:** a frame written at level 9 must decode identically to one written at level 1; no runtime preference may ever leak into bytes (it would violate byte-stability and create cross-runtime skew).
- **Corollary:** dedup/content-addressing must be keyed on *decompressed* identity (`codec_id + dictionary_id + sha256(raw)`), never on compressed bytes — compressed bytes are only stable for brotli/zstd-dict-less, and even then only within one codec ID.

---

## 5. Capability detection and the writer/reader contract

### 5.1 Startup probe (both runtimes, one module)

Run once per process (cache the result; persist the *version* of the result, not runtime-specific detail, if needed). Probe every candidate codec with a tiny fixed vector:

1. `zlib` surface presence: `deflateRawSync`, `inflateRawSync`, `brotliCompressSync`, `brotliDecompressSync`, `zstdCompressSync`, `zstdDecompressSync`, `crc32`, `constants`.
2. **Round-trip probe** per codec: compress → decompress a fixed 2–4 KiB synthetic vector, assert byte-equality of output.
3. **Zstd-dictionary probe** (the E5 gate): compress a small vector *with* a fixed probe dictionary; assert (a) output length < no-dict output (proves dict was applied), (b) decompress-with-dict succeeds and round-trips, (c) decompress-without-dict fails (proves fail-closed semantics). Bun 1.3.14 fails (a) and (c).
4. `sqlite_version()` + `PRAGMA compile_options` (closes research §5.6's unresolved probe; feeds migration.md's VACUUM-INTO portability decision).
5. `process.versions` snapshot (node/bun) — recorded in every benchmark provenance record (benchmark.md §9).

Probe cost: microseconds, once per process; run in the sidecar at startup, not per-DB-open.

### 5.2 Writer/reader contract — intersection, not local set

- **Read side:** a runtime must decode any frame whose `codec_id` is in its *local* capability set, else **fail closed** (typed storage error identifying row/segment — research §26.1; never silent, never "try without dictionary").
- **Write side:** a runtime may **emit only codecs in the intersection of all shipped runtimes' capability sets** (`node24-electron ∩ bun-standalone`), frozen per release. Rationale: the DB is portable; a Bun CLI must never find a frame it cannot read, and vice versa. Concretely today: brotli (intersection, byte-stable) and deflate (intersection, interoperable) and dict-less zstd (intersection, byte-stable) are writable; **zstd+dict is NOT writable** (Bun fails the probe).
- Enforce at two points: (a) the codec layer's *writer policy* refuses non-intersection codecs even when the local runtime supports them; (b) CI runs the capability probe against the packaged Electron binary (`ELECTRON_RUN_AS_NODE=1`, benchmark.md §8) and the compiled Bun CLI and asserts the intersection equals the frozen manifest.
- The `compression_dictionary`/codec capability **must not be a runtime-typed global** — codec identity travels in the frame; capabilities are a property of the *runtime*, recorded in provenance.

---

## 6. Dictionary strategy

### 6.1 What is feasible on the `node:zlib` surface today (measured)

| Dictionary kind | Deflate (codec 3) | Brotli (codec 2) | Zstd (codec 1) |
|---|---|---|---|
| Preset/raw dictionary | **Yes** (`dictionary` option, both runtimes; interoperable cross-runtime, NOT byte-identical) | No (node:zlib exposes no custom brotli dict; only built-in LZ77 dict) | **Broken on Bun 1.3.14** (ignore on compress; undecodable on read) |

So the *only* cross-runtime-safe custom dictionary today is **deflate + preset dictionary**. Brotli has no custom-dict knob; zstd custom dict is Bun-broken.

### 6.2 Structural dictionary (recommended, ship first)

- Built **only** from schema/property names, enum strings, JSON keys, identifier prefixes (`evt_`, `ses_`, `msg_`, `prt_`), provider/model IDs that are *code constants*, and deterministic JSON syntax tokens (`{"`, `":`, `,"`, `"}`). **[INFERENCE]** This recovers the 17.2-style key-name redundancy (research §11.2: 6,058 B of JSON key bytes across 1,038 occurrences) with **zero privacy risk by construction** — no user content can appear because no user content is an input.
- **Zero-privacy-claim:** the build input is the schema registry + identifier.ts + provider/model constant tables, nothing else. Enforce with a provenance file (input hashes) and a content-lint gate in CI: assert the dictionary bytes contain none of a seeded "private-token" list and that the input set is exactly the schema-derived set (privacy-poisoned dictionary = hard veto, benchmark.md §7.4 #5).
- **Identity:** `dictionary_id` is a registry row; the **SHA-256 of dictionary bytes is the content-addressed identity** used for portability/verification (load-time assert `sha256(bytes) == stored sha256`). A structural dictionary regenerated from the same inputs must hash identically; if the schema changes, the dict changes → **new dictionary_id**, old stays decodable (frames reference their own dict).
- Storage: keep bytes **in the DB** (`compression_dictionary` table per research §20.10) so the file is self-contained — migration.md §9 already recommends this; embed-a-copy-in-the-binary remains a bootstrap fallback for first-open-before-migration.

### 6.3 Trained dictionary (gated experiment, do NOT ship yet)

- Corpus: sanitized synthetic + opt-in sanitized sessions through the benchmark.md §2.4 pipeline (prompts/tool outputs/code/paths stripped or replaced), with provenance. **Never train a release dictionary on unsanitized user content** (research §17.7/§28.1; hard veto).
- Algorithm: zstd `ZSTD_trainFromBuffer`-class training (or zlib `Z_FIXED` preset for deflate if zstd stays gated). Note Node's `node:zlib` does **not** expose a training API — training is a build-time/offline step producing a static `Uint8Array`, not a runtime op. (Node exposes no `zstd_train`; verify Bun's surface in the probe.)
- **Why gated:** (a) Bun zstd-dict bug (§3.4) — a trained zstd dict cannot be the mandatory codec until every runtime passes the dict probe; (b) ROI uncertain on microframes whose local window already captures cross-event redundancy — the 15–20% gain in research §17.2 is for *independent rows*, not 8–16 KiB frames (§6.5).
- Release cadence: a trained dictionary is a **release artifact with an immutable ID + SHA-256**, versioned like the schema. Ship it only with the golden vectors for its exact ID.

### 6.4 Per-event-family dictionaries

Rejected as default (research §17.7 #3 agrees): added selection metadata + cache cost per frame/segment for an unproven marginal gain over one structural dict. Revisit only if the benchmark shows family-selective dictionaries beating the shared dict by a material, reproducible margin on the *distinct-session* corpus.

### 6.5 Challenged assumption: is a shared dictionary worth it for short sessions?

- **For independent OPCL rows (message/part): yes.** Research §17.2 measured ~15–21% fewer bytes with a dict on independent frames; short sessions have no local window, so the dict IS the window. Structural dict is cheap (a few KiB), zero-privacy, and works today via deflate. **Ship it.**
- **For OSES microframes: not proven.** An 8–16 KiB microframe already contains a multi-KiB local window; the dict's marginal contribution shrinks. The first microframe of every aggregate and tiny segments are the plausible win spots. **Benchmark before committing** (benchmark.md §5.1 geometry × dictionary dimension). If the win is <~3% on the distinct-session corpus, drop the dict for OSES and keep it only for OPCL — one codec surface, less machinery.
- **The privacy cost of a trained dict is asymmetric with its benefit:** one leaked substring in a release dictionary is a permanent, distributable privacy incident (research §28.1). Given the uncertain ratio win, the rational default is *structural-only* until the trained-dict benchmark beats it by a pre-registered margin.

### 6.6 Decoder contract

Unknown/required-but-missing `dictionary_id` = hard decode error, never "try without dictionary" (research §22.8). For deflate, decompressing a dict-compressed stream without the dict fails ("invalid distance too far back" — measured); a "try without" fallback would produce garbage. Cache the resolved dict per `(codec_id, dictionary_id)` process-locally; memory-bounded.

---

## 7. Cross-runtime golden-vector strategy

### 7.1 Define byte-parity precisely — two distinct properties

1. **Cross-decode compatibility (mandatory for every shipped codec/dict):** any frame written by runtime A decodes in runtime B to the identical *logical* value (`JSON.parse` → deep-equal), including UTF-8/JSON semantics and exact event-ID reconstruction. This holds for deflate/brotli/dict-less-zstd today and for deflate+dict (verified).
2. **Byte identity (only where the codec guarantees it):** A and B produce identical compressed bytes for identical input+options. Only **brotli** and **dict-less zstd** hold today (verified across all three probed runtimes). Deflate and deflate+dict are **excluded from byte-identity assertions**: measured deflate bytes are stable within the Node lineage (Node v22 ↔ Electron Node 24.15 byte-identical) but diverge on Bun's embedded zlib — so a deflate byte fixture fails on the Bun leg by construction. Their fixtures assert logical equality only, and must be regenerated (or relaxed) on any zlib bump in either runtime.

Both properties are asserted per codec ID; a codec's manifest declares whether byte-identity is guaranteed.

### 7.2 Fixture corpus (fixed, frozen, versioned)

Per benchmark.md §7.2 + research §31.1, codec-lane specifics:

- empty payload; 1-byte; THRESHOLD boundary (±1 byte AND ±1 code unit — the fork's threshold is in UTF-16 code units but the header is UTF-8 bytes; pin both edges);
- typical session JSON (repetition-heavy); event-family full-state; large tool result; **already-compressed/high-entropy bytes** (exercises the RAW/no-gain path);
- canonical + escaped/noncanonical event IDs;
- a payload whose dict-shaped substrings appear and one that does not (dict-correctness + no-gain path).

### 7.3 Matrix and execution

- Every (codec_id × dictionary_id × format_version) vector is encoded on **both** runtimes; each side decodes the other's bytes. Logical equality is asserted everywhere; byte equality only where the manifest claims it.
- **Real artifacts:** Node side is **done — verified on the actual Electron 42.3.3 binary** (`ELECTRON_RUN_AS_NODE=1`, embedded Node 24.15.0): brotli/zstd/crc32 byte-identical to Bun; deflate differs from Bun; zstd-dict correct + fail-closed (§3). Bun side must run against the **compiled `opencode` standalone binary**, not `bun` dev (compile-target differences are exactly what must not surprise us; benchmark-arch's three-leg matrix covers it).
- **Release gate (G2):** zero logical divergence; byte-identity where claimed. Fallback-path golden bytes (when zstd is capability-gated off) are the ones the gate checks — benchmark.md §8.
- **Fuzz + differential** (research §31.2–31.5) stay in `packages/core/test`; the golden vectors additionally pin the *compressed fixture hex* so any zlib bump that silently changes deflate bytes breaks the test loudly instead of drifting.

### 7.4 What "identical Node and Bun decode results" means operationally

The assignment's phrase is satisfied by: every shipped codec/dict vector decoding to byte-identical *logical* values on both runtimes **and** — for the codecs we choose as byte-stable — byte-identical *compressed* fixtures too. Anything less (deflate) is marked explicitly as interoperable-not-identical and excluded from byte fixtures.

---

## 8. Frame-level adaptive storage (RAW vs compressed per frame)

- The fork already applies the principle at row level: frame only if `stored_len + HEADER + 24 < raw_len` (net-gain gate, `compressText`). Formalize it for both OPCL rows and OSES microframes with one policy core:
  - **min_byte_gain** (proposed: `HEADER + 8` bytes, benchmark-gated) — never store a frame whose net saving is smaller than its own envelope overhead;
  - **min_relative_gain** (proposed: skip if savings < 2% of raw, CPU-weighted — decompression of a frame that saves 12 B of 16 KiB is not worth the decode cost; research §20.15 agrees);
  - **RAW codec (codec_id 0)** for in-envelope raw frames (OSES frame directory) and TEXT (no envelope) for OPCL — keep both paths; RAW-in-envelope only where the envelope is already paid for (segments).
- **Codec fallback ladder (bounded):** if the default codec fails the gain gate, try the next (proposed order: brotli q1 → zstd l1 (if enabled) → deflate l1 → RAW/TEXT), each attempt gated by the same net-gain check; stop at the first pass or the ladder end. Deterministic ladder order keeps writers deterministic (important for byte-stability of whatever wins).
- **Never compress twice:** if the payload is already-compressed/high-entropy, the gain gate returns RAW/TEXT with zero added CPU beyond the first codec attempt — measure the first-attempt cost on high-entropy rows (this is the tool-result tail; research §11.3).
- Jumbo events: singleton frame/segment as in research §20.7/§24.7; the same gain gate applies (a 1 MiB already-compressed tool output should stay raw).

---

## 9. Compression execution context

Ground truth: both adapters are synchronous single-connection; compression must never sit inside the durable write transaction or block the sidecar's event loop for long. The fork's `chunkdb-seal-parallel.ts` already encodes the right shape: **worker pool for compression, main thread for SQLite writes, byte-balanced batches, one `BEGIN IMMEDIATE … COMMIT` per batch** [VERIFIED].

Recommendations:

- **Worker strategy = `node:worker_threads`** (works on Node and Bun — the fork bench already targets both). Transfer `ArrayBuffer`s via structured-clone transfer list (zero-copy postMessage) — already done in `chunkdb-seal-worker.ts`.
- **Inline below a measured crossover, worker above.** Proposed start: inline for raw payloads ≲ 4–8 KiB or aggregate batch ≲ 64 KiB; worker above. The crossover is a *benchmark* output (benchmark.md §6), never a magic constant. Rationale: brotli q1 of 1 KiB is tens of µs — thread dispatch dominates.
- **One bounded pool, backpressured:** cap concurrent workers (proposed ≤ `availableParallelism()`), cap queue depth; when the queue is full, the sealer yields — never spawn unbounded threads (low-end machines; research §34.14).
- **Runtime-neutral abstraction:** worker strategy is scheduling, not format. Never reference workers in on-disk format; never make a Node-only worker mechanism (Bun supports `node:worker_threads`, but the *fallback* when workers are unavailable in a compiled binary must be inline — probe at startup).
- The sealer already runs outside transactions and yields between batches; keep it. Startup catch-up uses the same pool with a bytes/sec budget (research §20.14).

---

## 10. Checksum strategy

- **Semantics (frozen):** CRC32 (IEEE, poly `0xedb88320`) over the **decompressed** raw bytes, stored LE u32 at header offset 10. This is what makes the checksum cross-runtime-safe even for non-byte-identical codecs: raw bytes ARE identical across runtimes (verified), so CRC matches.
- **Implementation:** swap the hand-rolled bitwise loop for `node:zlib.crc32` (exists on both runtimes; verified identical output; native speed). Keep the bitwise version only as a unit-test oracle for the zlib binding. **[PROPOSED]** — no format change.
- **Coverage:** row/frame CRC mandatory; segment-level CRC mandatory (research §20.5/F.7). Per-frame CRC for OSES microframes: keep — 4 B/8–16 KiB frame is cheap and localizes corruption; benchmark the cost on replay (research §22.7).
- **Security posture:** CRC is corruption detection, **not** a MAC — no integrity claims against tampering (research §28: encryption-at-rest is out of scope; CRC stays). Do not overload codec_id with checksum/encryption meaning; those belong to separate format layers if ever introduced (research §28.5).
- **Validation order** on decode: length caps BEFORE decompression (already `RAWLEN_PRE_CAP`), then CRC, then JSON parse (research §22.9). `RAWLEN_PRE_CAP` (128 MiB) is a decompression-bomb guard — keep and test.

---

## 11. Codec identity vs runtime preference — separation rules (summary)

1. **Format bytes** carry: `codec_id`, `dictionary_id`, `format_version`, `raw_len`, `stored_len`, CRC. Nothing else.
2. **Writer config** (level, ladder order, thresholds, worker count) never reaches disk.
3. **Capabilities** are a runtime property, probed at startup, recorded in provenance; they never define the format.
4. **Intersection policy** (all shipped runtimes) governs what writers may emit; local capability governs what readers may decode.
5. **Unknown format state** (codec/dict/version) → fail closed with identity (row/segment); never overwrite, never guess.

---

## 12. Challenged assumptions

1. **"Shared dictionary is worth it for short sessions."** — True for independent OPCL rows (measured 15–21% in research §17.2), unproven for OSES microframes. Structural dict ships; trained dict is gated on the benchmark + Bun zstd fix. Don't buy the trained-dict complexity for the first microframe only.
2. **"Deflate is the stable baseline."** — Wrong for byte parity (measured). Brotli is the byte-stable baseline; deflate is a compat codec. The fork's existing default (brotli q1) is already the right choice — this is a happy accident worth documenting.
3. **"Zstd is a serious experimental candidate."** — Yes for dict-less zstd (byte-stable, faster-than-brotli at comparable ratio — must benchmark), NO for zstd-dict until Bun fixes the ignore/undecodable bug. The research doc's §1.6/§17.8 enthusiasm predates the measured Bun behavior.
4. **"What breaks if Bun and Node produce different bytes?"** — Nothing, *if* the design respects three rules: (a) checksums over decompressed bytes; (b) no content-addressing/dedup keyed on compressed bytes; (c) golden fixtures assert logical equality for non-deterministic codecs. What breaks without those rules: dedup false-misses, cache-key skew, golden fixtures that flake on every Electron Node patch, and silent mis-verification of "byte parity" claims. Deflate violates byte-identity but satisfies (a)–(c), so it stays a valid shipped codec — just not a byte-oracle.
5. **"Dictionary identity by incremental integer is fine."** — Weak. Use SHA-256 as the content-addressed identity with an integer registry handle for compactness (research §20.10 already has `sha256 BLOB UNIQUE`). Content-addressing makes dictionary portability and provenance checkable across DB copies and runtimes.

---

## 13. Open questions

1. **zstd-dictionary across runtimes — first half CLOSED, second half open.** **[MEASURED on the packaged artifact]** Electron 42.3.3 (Node 24.15.0) applies the dictionary identically to Node v22 (byte-identical 50 B frame) and fails closed without it — the Node path is correct on the real desktop runtime. The blocker is **Bun 1.3.14 only** (ignore-on-compress, undecodable-on-read). Remaining probe: does any newer Bun release fix it? If yes, trained zstd dictionaries become gated-eligible; if no, they stay permanently out of the intersection. Re-probe in CI on every Bun release (§14 #1).
2. **Is `node:worker_threads` reliable inside the Bun `--compile` standalone binary** (the product), or must the sealer fall back to inline when workers are unavailable? The fork bench runs under `bun` dev; the compiled binary is what ships.
3. **What is the Pareto knee for brotli q1 vs zstd l1 (byte-stable pair) on the distinct-session corpus — size, CPU, WAL — and does the structural dictionary survive inside 8–16 KiB microframes?** (§6.5, benchmark.md §5.1.)
4. **Bun's `zstdCompressSync` param handling:** the probe showed `ZSTD_c_enableDedicatedDictSearch` is rejected as "not a valid zstd parameter" on BOTH runtimes — does Bun's `node:zlib` support the full zstd param set Node 24.15 does, or only a subset? (Matters for level/param portability of the writer policy.)
5. **Cost of the fork's row-level sealer vs OSES segments on WAL growth:** current per-row UPDATE+journal adds WAL per row; OSES segment insert+delete amortizes. Benchmark to size the OSES case (research §34.9).

---

## 14. Must-benchmark list (codec lane; benchmark.md owns methodology)

1. **Cross-runtime probe suite** (§3) against real artifacts — **Electron leg DONE (42.3.3, Node 24.15.0): results in §3 table.** Remaining: compiled Bun `opencode` binary (benchmark-arch's three-leg matrix), incl. a **Bun-release re-probe of the zstd-dict bug** (Q1's open half). Gate: intersection == frozen manifest.
2. **Codec × level sweep** on the distinct-session corpus: brotli q1/q2/q4 × zstd l1/l3/l9 × deflate l1/l6, reporting size, encode/decode p50/p95/p99, CPU — pick the byte-stable Pareto knee for OPCL rows and OSES frames separately.
3. **Dictionary dimension** (§6.5): none / structural / trained (gated) × microframe 4/8/16/32 KiB — answer "does the dict survive inside microframes?" with a pre-registered margin (benchmark.md anti-gaming rules).
4. **Threshold edges:** the fork's `THRESHOLD=4096` code units vs UTF-8 bytes; the `min_byte_gain`/`min_relative_gain` constants; the inline-vs-worker crossover (§9).
5. **High-entropy/jumbo tool results:** first-attempt codec cost on already-compressed rows (RAW path must stay cheap).
6. **Golden-vector regen drill:** force a zlib patch bump in a throwaway build and confirm the deflate-byte drift is detected by the fixture harness (proves the alarm works before a real bump).

---

## 15. Research-doc corrections (summary, codec lane)

1. **Registry conflict (§22.2 / Appendix B):** shipped registry is `1=zstd, 2=brotli, 3=raw-deflate` — freeze it, append-only. Research doc's numbering must not be applied to the fork.
2. **"Stable baseline: raw Deflate" (§1.6):** deflate is not byte-stable cross-runtime (measured). Baseline = brotli (already the fork default).
3. **Zstd "serious experimental candidate" (§1.6/§17.8/§33.14):** true for dict-less; false for zstd-dict on Bun 1.3.14 (ignore-on-compress, undecodable-on-read). Capability-gate both, per §5.
4. **Appendix B's `CodecID` list and `PayloadCodec` interface:** fine as an *interface sketch*, wrong as *registry*; the fork's `json-codec.ts` is the real interface. Cross-reference, don't duplicate.
5. **§17.2 deflate+dict numbers** remain a valid OPCL signal; they are *independent-row* numbers and must not be extrapolated to OSES microframes without re-measurement.
6. **CRC32 (§22.1/Appendix B "checksum"):** specify IEEE CRC32-over-decompressed-bytes LE u32 — which the fork already implements correctly — and prefer `node:zlib.crc32` for speed. (Research doc never pinned the algorithm; the fork did.)

---

## 16. Phased recommendations

- **Phase A (now):** freeze the shipped registry; add codec 0 (RAW) reservation; ship the startup capability probe; swap CRC implementation to `node:zlib.crc32` (format unchanged); write the golden-vector harness against real artifacts; add the zstd-dict probe to CI.
- **Phase B (with OSES):** structural deflate dictionary (schema-only provenance) for OPCL rows; frame-directory codec overrides + RAW frames in OSES; per-frame CRC; worker pool with inline/worker crossover; intersection-manifest enforcement.
- **Phase C (gated):** trained dictionary — only if (a) every shipped runtime passes the dict probe, (b) the benchmark beats structural by a pre-registered margin on the distinct-session corpus, (c) provenance + content-lint gates pass. Otherwise structural-only, indefinitely.

---

*Prepared by codec-arch. All [MEASURED] claims reproducible via the probe scripts described in §3 (thrown away after use; the results table is the artifact).*
