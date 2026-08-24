# OpenCode v1.18.18 × ChunkDB Storage Architecture Research

**Implementation-ready research handoff**  
**Repository baseline:** `anomalyco/opencode` `v1.18.18`  
**Pinned commit:** `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`  
**Primary database:** `opencode.db`  
**Product surface:** packaged OpenCode desktop application, with compatibility across every legitimate runtime that can open the database  
**Research date:** 2026-08-14  
**Production API ownership rule:** V1 is the production desktop/app surface; V2 is beta/incomplete infrastructure and is not a migration target for this storage work.

**Strengthened architecture revision:** 2026-08-14 adversarial-review pass. The event log is promoted from an optional cold-history optimization to a first-class storage-engine target. The preferred design is now a dual architecture: **OPCL** for point-readable current-state payloads and **OSES** (OpenCode Segmented Event Store) for durable event history.

---

## Evidence legend

This report uses explicit evidence labels so measured facts do not blur into design proposals.

| Label | Meaning |
|---|---|
| **[VERIFIED]** | Directly established from the supplied `v1.18.18` source or an authoritative runtime/SQLite source. |
| **[MEASURED]** | Measured against the supplied `opencode-openfork.db` or the supplied ChunkDB prototype. |
| **[CALCULATED]** | Arithmetic derived from measured/source facts. |
| **[INFERENCE]** | Architectural conclusion supported by verified or measured evidence. |
| **[PROPOSED]** | Recommended design value, threshold, schema, format, or acceptance gate that still requires implementation benchmarking. |
| **[UNRESOLVED]** | Important question that the implementation/benchmark phase must close. |

The supplied reference database was inspected read-only and only aggregate/sanitized structural data is reported. No prompt, response, tool-output, credential, or other private payload contents are reproduced.

---

# 1. Executive summary

## 1.1 Final recommendation: two purpose-built physical representations, one SQLite authority

The strongest architecture for OpenCode v1.18.18 is **not one universal compression layer**. The workload contains two fundamentally different data classes and should exploit that fact:

1. **Current-state / projection data** (`message.data`, `part.data`, selected large JSON payloads) is point-read and page-hydrated. Keep these records independently addressable and use the **OpenCode Payload Codec Layer (OPCL)**: ordinary SQLite routing columns plus a mixed `TEXT`/self-describing compressed `BLOB` payload.
2. **Durable event history** is append-oriented, aggregate/sequence-addressed, replay-oriented, immutable after commit, extremely repetitive, and disproportionately large in mature V1 databases. Give it its own physical design: the **OpenCode Segmented Event Store (OSES)**.

OSES should use:

- compact integer surrogate keys for repeated aggregate IDs and versioned event type strings;
- a **rowid hot tail** for the newest events so the durable transaction remains cheap and inserts retain SQLite's append-friendly physical path;
- immutable **per-aggregate macro-segments** for cold history;
- independently decompressible **microframes inside each segment** to bound point-read amplification;
- a compact, partially columnar segment header/index separating high-entropy event IDs from highly compressible JSON payloads;
- exact structured packing of OpenCode event IDs;
- versioned, type-specific semantic elision only for fields that are provably derivable from the physical envelope;
- a shared pinned structural/trained dictionary where runtime support and privacy constraints pass the acceptance gates;
- bounded background sealing and WAL-aware scheduling;
- no cross-aggregate chunks and no rewrite of an already sealed segment during normal appends.

SQLite remains authoritative for transactions, foreign keys, migration state, aggregate/type dictionaries, segment metadata, and all product routing. This is a **physical-storage redesign**, not a move away from SQLite and not a migration of V1 product semantics onto V2.

## 1.2 Why the event log is now a primary target

**[VERIFIED]** Durable reads are already expressed as ordered aggregate/sequence scans. `EventV2.readAggregate()` filters by aggregate ID, `seq > after`, event type, and then orders by sequence. The durable subscription path similarly reads `aggregate + seq` ranges. This is almost exactly the access pattern a seekable segment store wants.

**[VERIFIED]** Durable publish is atomic with local projection work. Event publication enters an immediate transaction, computes the next aggregate sequence, invokes registered projectors/commit hooks, updates `event_sequence`, and appends the durable event before committing. OSES therefore must preserve the same atomicity boundary; it must not move compression work for a shared segment into this critical transaction.

**[VERIFIED]** Replay semantics are strict. Existing code rejects divergent replays and checks event-ID uniqueness. OSES must preserve exact event IDs and exact aggregate/sequence ordering; probabilistic deduplication is not acceptable.

**[MEASURED]** The supplied reference database already shows why repeated “small” strings matter. Across just 50 events:

| Repetition source | Measured bytes / occurrences |
|---|---:|
| `event.data` UTF-8 JSON | 23,321 B |
| JSON key occurrences | 1,038 |
| Raw key-name bytes across occurrences | 6,058 B |
| String-value occurrences | 481 |
| Raw string-value bytes | 10,254 B |
| Bytes in repeated string values | 9,471 B |
| Repeated `aggregate_id` column strings | 1,500 B |
| Repeated event type strings | 905 B |
| Repeated event ID strings | 1,500 B |

The same 30-byte session ID occurs **100 times inside event payload string values**, accounting for 3,000 raw bytes by itself in this tiny sample. The event table then also stores aggregate/type/ID routing strings outside the payload and repeats aggregate/type material in B-tree indexes. None of these individual values looks large; collectively they are a major entropy and page-density problem.

The correct response is **not** a giant arbitrary-string intern table. The best division of labor is:

- repeated relational/routing identity -> normalize into compact integer keys;
- provably derivable semantic fields -> omit physically and reconstruct;
- repeated JSON keys and ordinary payload strings -> let the segment compressor/dictionary exploit them;
- large exact cross-representation duplicates -> consider content-addressed storage only above an evidence-based size threshold.

## 1.3 OSES physical model

```text
                 V1/V2 LOGICAL EVENT API
                          │
                          ▼
                  EventStore adapter
                          │
          ┌───────────────┴────────────────┐
          │                                │
          ▼                                ▼
   ROWID HOT TAIL                  SEALED HISTORY
   one row / event                 one SQLite segment row
   append-friendly                 per aggregate only
   raw or singleton codec          immutable
   bounded                         32–128 KiB logical segment
          │                                │
          │                         ┌───────┴────────┐
          │                         ▼                ▼
          │                    metadata/index    microframes
          │                    IDs/types/offsets 8–16 KiB raw
          │                                    independently decoded
          └───────────────┬────────────────────────┘
                          ▼
                  COMPACT ROUTING PLANE
             aggregate_key / type_key / seq
                          │
                          ▼
                        SQLite
```

The macro-segment/microframe split is the key Pareto refinement:

- **macro-segment** amortizes SQLite row headers, B-tree entries, aggregate/type repetition, checksums, and routing overhead;
- **microframe** prevents a single-event lookup from having to decompress an entire 64–128 KiB segment;
- **shared dictionary** recovers much of the structural redundancy that would otherwise be lost when each microframe resets its compressor state;
- sequential replay still reads microframes contiguously and can decode them in order with excellent locality.

Starting experimental ranges—not final constants—should be:

```text
logical segment target:      ~64 KiB raw
segment admissible range:    32–128 KiB raw
microframe target:            8–16 KiB raw
microframe hard ceiling:      32 KiB raw (except jumbo singleton)
event-count ceiling:          128 events / segment
jumbo event:                  own frame, usually own segment
```

All must be selected by benchmark, not ideology.

## 1.4 Hot-tail schema correction: append locality first

The earlier composite-primary-key `WITHOUT ROWID` hot table is rejected. SQLite explicitly recommends ordinary rowid tables for large rows and notes that `WITHOUT ROWID` works best when rows are small. Hot event rows can contain large JSON/tool payloads.

The preferred hot table is an ordinary rowid table:

```sql
CREATE TABLE event_hot (
  hot_id          INTEGER PRIMARY KEY,
  aggregate_key   INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  event_id        BLOB NOT NULL,
  type_key        INTEGER NOT NULL,
  time_created    INTEGER,
  raw_len         INTEGER NOT NULL,
  data            BLOB NOT NULL,
  UNIQUE (aggregate_key, seq)
);
```

Do **not** use `AUTOINCREMENT`; SQLite documents additional CPU/memory/disk/I/O overhead and ordinary `INTEGER PRIMARY KEY` already assigns a generally increasing rowid. The physical table therefore follows global insert order even when many aggregates are active, while the `(aggregate_key, seq)` secondary index provides the logical range path.

`WITHOUT ROWID` remains a candidate only for **tiny locator/dictionary tables with non-integer/composite keys**, and even there only after benchmark.

## 1.5 Structural event-ID packing

OpenCode event IDs are unusually compressible *structurally*, even though their random suffix is high entropy. Source inspection shows an event ID is `evt_` plus a 26-character identifier. The first 12 hex characters encode a 48-bit `timestamp × 4096 + counter`; the remaining 14 characters are base-62 random material.

OSES should therefore encode IDs exactly as:

```text
first event in segment:
  48-bit clock/counter value
  84-bit packed base62 suffix

subsequent events:
  uvarint(delta clock/counter)
  84-bit packed base62 suffix
```

The literal `evt_` prefix is implicit. The 14 base-62 characters carry `14 × log2(62) ≈ 83.36` bits, so 84 bits is sufficient for exact reversible packing. Typical IDs should therefore cost roughly 11–14 bytes/event depending on clock deltas, rather than 30 ASCII bytes, while retaining the exact original logical ID.

Unknown/noncanonical historical IDs must use an escape representation containing exact UTF-8 bytes; the format must never reject a valid historical database merely because an ID is not canonical.

## 1.6 Codec policy after adversarial review

The on-disk format must separate **codec identity** from **runtime codec preference**.

- Stable baseline candidate: raw Deflate at a low level with a pinned structural dictionary.
- Zstd is a serious experimental candidate because the packaged desktop's Electron 42.3.3 runtime contains Node 24.15.0, whose `node:zlib` exposes Zstd compression/decompression and a dictionary option. However those Zstd APIs are explicitly **Stability 1 / Experimental** in Node 24.15.0. OSES must capability-gate Zstd and retain a stable fallback; once a codec ID is shipped, decoders for it become part of the storage compatibility contract.
- Brotli q1 remains a comparison/fallback candidate.
- Shared/trained dictionaries are now a **first-class experiment**, especially for short sessions and small microframes. Dictionary training must use a sanitized representative corpus or a deliberately structural corpus; do not ship user prompt/tool content inside a release dictionary.
- Semantic snapshot/delta encoding remains deferred until it proves a material gain **after** block compression + dictionary compression. Generic LZ-family compression already captures much of the repeated full-state structure inside a segment.

## 1.7 Sealing policy: hybrid byte/count/idle trigger, conservative prefix

Sealing is not “when N events happen.” Track hot-state accounting transactionally per aggregate:

```text
hot_count
hot_raw_bytes
last_append_ms
latest_seq
sealed_seq
generation
```

Schedule a seal when any of these become true:

1. `hot_raw_bytes >= BYTE_HIGH_WATERMARK` — primary trigger;
2. `hot_count >= COUNT_HIGH_WATERMARK` — guard against many tiny events;
3. aggregate has been idle for `IDLE_SEAL_DELAY` — prevents low-volume aggregates from living forever in the hot table;
4. startup/maintenance sweeper finds legacy hot history beyond bounds.

Crucially, a normal append **does not invalidate an in-progress seal**. The sealer snapshots an immutable prefix ending at `cutoff_seq` and compresses only that prefix. New events receive higher sequences and remain hot. The final transaction verifies only that the same prefix has not already been claimed/replaced by another sealer or migration generation.

A starting policy worth benchmarking is:

```text
BYTE_HIGH_WATERMARK = 128 KiB hot raw bytes / aggregate
COUNT_HIGH_WATERMARK = 128 hot events / aggregate
SAFETY_TAIL = 8–32 newest events or ~16–32 KiB, whichever larger
IDLE_SEAL_DELAY = 30 s
GLOBAL_SEAL_COMPRESSION_CONCURRENCY = 1 initially
```

These are hypotheses, not production constants.

## 1.8 Cache and WAL policy

The current database config allocates a negative SQLite cache size of `-64000`, approximately 64 MiB. A decompressed segment cache would otherwise double-buffer compressed pages plus decompressed bytes.

Treat storage cache memory as one budget:

```text
SQLite page-cache budget + OSES decompressed-byte cache <= process storage-cache budget
```

Start with no OSES cache or a small 8–16 MiB byte cache and reduce SQLite cache correspondingly if measurements show benefit. Cache decompressed **bytes/frames**, not parsed JavaScript object graphs. Prefer a scan-resistant byte-LRU/2Q/SLRU admission policy so one long replay cannot evict all interactive data.

Sealing compression happens outside the SQLite write transaction. Only one sealing commit should run at a time initially. Avoid explicit FULL/RESTART checkpoints on interactive paths. SQLite's default auto-checkpoint is PASSIVE at 1000 WAL pages; benchmark whether sealing bursts justify a larger threshold or application-scheduled idle PASSIVE checkpoints. Measure WAL bytes and checkpoint-induced p99, not merely final DB size.

## 1.9 History GC: powerful, but not an archive heuristic

Hard session deletion already removes the aggregate's event history. Archive state is reversible, and experimental sync exposes/replays durable histories. Therefore `archived == safe_to_delete_events` is **not source-supported**.

Future event-history pruning is potentially the largest possible storage win, but it requires a semantic proof such as:

- explicit snapshot/checkpoint declaring history through sequence `N` replaceable;
- every required replica/consumer acknowledges the checkpoint;
- product policy guarantees no feature requires pre-checkpoint event replay.

Until that exists, OSES compresses history; it does not silently discard it.

## 1.10 Go / no-go gates

The architecture should ship only if a representative **multi-session, non-replicated** corpus proves the following:

- exact logical event equivalence across legacy and OSES readers;
- exact replay/divergence/idempotency semantics;
- identical Node and Bun decode results for every shipped codec/dictionary/format vector;
- active durable-write p95/p99 regression within a small agreed budget (proposed initial gate: ≤5%);
- current message/part page hydration remains within the OPCL gates;
- event range/replay p95/p99 is at least competitive with baseline or shows a compelling byte/cache win;
- cold point-event lookup has a bounded absolute latency and no pathological 128 KiB decompression tail because microframes cap amplification;
- total event-subsystem main-DB + WAL bytes fall materially on a distinct-session corpus;
- whole-database bytes fall enough to justify migration/maintenance complexity;
- startup catch-up sealing does not cause interactive p99 or checkpoint stalls;
- corruption of one frame is contained to that frame/segment and reported deterministically.

The old synthetic 25,000-event replication benchmark is retained only as a **structural stress test / upper-bound illustration**. It must not be used as representative production compression evidence.

---

# 2. Scope and non-goals

## Scope

This investigation covers:

- OpenCode `v1.18.18` database runtime topology;
- V1 desktop read/write/session flows;
- Node/Bun SQLite compatibility;
- durable event and current-state projection duplication;
- payload shape and mutability;
- SQL queryability;
- application-level compression and ChunkDB-derived designs;
- crash-safe migration/rollback;
- first-class durable-event segmentation with hot-tail/sealed-history lifecycle;
- reproducible benchmark and acceptance methodology.

## Non-goals

- Migrating V1 product behavior to V2.
- Replacing SQLite with a custom database engine.
- Changing user-visible session semantics.
- Encrypting data at rest. Compression can coexist with encryption, but encryption is not designed here.
- Removing the durable event log without redesigning sync/replay semantics.
- Treating the supplied small reference DB as statistically representative of all OpenCode users.
- Shipping a native SQLite extension merely to obtain compression.
- Using lossy serialization or changing JSON semantics.

---

# 3. Terminology

**Routing plane** — native SQLite columns needed to locate, filter, order, join, paginate, sync, or summarize a record without decoding its large payload.

**Payload plane** — JSON body or other large opaque value that may be independently encoded/compressed.

**Hot row** — a record that can still receive updates or is frequently read interactively.

**Cold row** — a completed historical record whose mutation probability and read frequency are low.

**Durable event** — append-only event persisted in `event` with an aggregate ID and sequence.

**Projection** — current-state row such as `message` or `part`, updated from durable events for efficient V1 reads.

**Macro-segment** — an immutable per-aggregate routing/index unit spanning a bounded contiguous sequence range.

**Microframe** — an independently decompressible subunit inside a macro-segment, sized to cap point-read decompression while retaining segment-level row/index amortization.

**ChunkDB** — here, the family of ideas embodied by the supplied Bun prototype: SQLite as the durable kernel, compressed shared base chunks, a logical directory, point-mutation deltas, caching, and compaction. It does not mean this report recommends porting the prototype literally.

---

# 4. Repository baseline and research methodology

## 4.1 Baseline

The working baseline is OpenCode **v1.18.18**, pinned to commit:

```text
31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d
```

The supplied source slice was independently checked against known Git blob IDs for important files and matched the pinned tag. All OpenCode source links in this document are commit-pinned.

Representative source permalink prefix:

```text
https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/
```

## 4.2 Inputs

**[VERIFIED] Source input**

- `opencode-1.18.18.tar.gz`
- SHA-256: `9962680e6ea7b59e002b2940a1f33f31f147fea4e976df2ea5501bc70ed2fb83`

**[MEASURED] Database input**

- `opencode-openfork.db`
- SHA-256: `6672ea88839297e80dd370a0978d49af700200edc3daab6f9a76d97a17bd4e4a`
- file size: 430,080 bytes

The DB appears to be an OpenCode fork-derived database: it contains several schema additions not present in the supplied baseline source, including FTS search columns/tables and a provider expression index. Those are explicitly separated from baseline v1.18.18 facts.

## 4.3 Method

The investigation proceeded in this order:

1. trace database creation/path/PRAGMAs and migration flow;
2. identify conditional Node/Bun SQLite implementations;
3. trace packaged desktop startup and sidecar runtime;
4. trace standalone CLI and opt-in V2/background paths;
5. reconstruct session/event schema;
6. trace V1 HTTP read/write endpoints to storage functions;
7. distinguish durable full-state updates from transient token deltas;
8. inspect event projector atomicity;
9. inspect the supplied DB read-only via SQLite PRAGMAs, `sqlite_master`, and `dbstat`;
10. measure payload distributions, current-projection/latest-event equivalence, and repeated durable versions;
11. race representative codecs and thresholds on the real payload corpus;
12. run disposable copied-database physical-size experiments;
13. compare candidate architectures against workload constraints;
14. specify a preferred binary envelope, schema evolution, migration, rollback, testing, and rollout plan.

No production database was modified.

---

## 4.4 Adversarial review and correction pass

A second adversarial review was applied after the first architecture draft. Its useful challenges were incorporated directly rather than left as commentary. The revision specifically re-tested:

- `WITHOUT ROWID` suitability for hot rows containing large payloads;
- Node/Electron/Bun Zstd and dictionary capability assumptions;
- synthetic benchmark external validity;
- hot-tail write locality under many concurrent aggregates;
- sealing triggers, races, retry behavior, and startup catch-up;
- event-ID lookup/index growth;
- exact type-filter behavior at segment granularity;
- SQLite page-cache interaction with a decompressed segment cache;
- WAL auto-checkpoint and bulk sealing behavior;
- the existing file-backed `Storage` service before introducing another large-object tier;
- whether archive/close state is actually a safe event-GC boundary;
- semantic-elision regression risk.

The review changed the recommendation in several material ways: event segmentation is now first-class rather than optional; the hot table is rowid-based; event segments contain independently decodable microframes; Zstd is experimental/capability-gated; trained/static dictionaries are a first-class benchmark dimension; semantic elision is versioned by event type and format; and the benchmark plan now requires distinct real sessions plus cold-cache and tail-latency measurements.

Where the adversarial material conflicted with current source/runtime facts, this report resolves the conflict in favor of direct source/primary documentation. In particular, the actual Node 24.15 runtime does expose a Zstd dictionary option, but its Zstd API is Stability 1 / Experimental; and OpenCode archive state is not a proven durable-history GC boundary.

---

# 5. OpenCode runtime topology

## 5.1 Production packaged desktop V1 path

**[VERIFIED]** `packages/desktop/scripts/prebuild.ts:10` runs the OpenCode Node build before Electron packaging:

```ts
await $`cd ../opencode && bun script/build-node.ts`
```

[`packages/desktop/scripts/prebuild.ts#L1-L11`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/scripts/prebuild.ts#L1-L11)

`../../../packages/opencode/script/build-node.ts` uses Bun as a *build tool* but explicitly emits a Node-targeted ESM bundle:

```ts
await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
})
```

[`packages/opencode/script/build-node.ts#L15-L30`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/script/build-node.ts#L15-L30)

Electron Vite resolves `virtual:opencode-server` to that Node bundle:

[`packages/desktop/electron.vite.config.ts#L6-L6`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/electron.vite.config.ts#L6-L6)  
[`packages/desktop/electron.vite.config.ts#L41-L41`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/electron.vite.config.ts#L41-L41)  
[`packages/desktop/electron.vite.config.ts#L64-L69`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/electron.vite.config.ts#L64-L69)

The desktop main process forks `sidecar.js` using Electron's `utilityProcess.fork()`:

[`packages/desktop/src/main/server.ts#L57-L69`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/server.ts#L57-L69)

The utility process dynamically imports the virtual Node-targeted server and starts it:

[`packages/desktop/src/main/sidecar.ts#L51-L66`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/sidecar.ts#L51-L66)

Therefore:

> **The production V1 desktop server is a Node runtime inside an Electron utility process, not Bun.** Bun builds the bundle; Node executes it.

The desktop pins Electron 42.3.3 (`packages/desktop/package.json:51`). Electron's official release metadata states that 42.3.3 embeds Node.js 24.15.0.

- Source: [`packages/desktop/package.json#L36-L58`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/package.json#L36-L58)
- Runtime reference: <https://releases.electronjs.org/release/v42.3.3>

## 5.2 Default V1 versus opt-in V2 desktop sidecar

**[VERIFIED]** Desktop selects V2 only when `OPENCODE_SIDECAR_V2=1`; otherwise it uses V1:

[`packages/desktop/src/main/index.ts#L53-L65`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/index.ts#L53-L65)

The main startup branch confirms this split:

- V2: `startBackgroundCli(...)` at lines 333–347.
- V1: `spawnLocalServer(...)` at lines 373–385.

[`packages/desktop/src/main/index.ts#L327-L405`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/index.ts#L327-L405)

The V2 path invokes a staged `opencode-cli` executable and explicitly searches multiple state-home candidates, so it can encounter an existing user database. It must therefore understand any new physical payload representation even though V2 is not the product surface being redesigned.

[`packages/desktop/src/main/background-cli.ts#L19-L57`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/background-cli.ts#L19-L57)

## 5.3 Standalone CLI

**[VERIFIED]** The standalone OpenCode binary is compiled with Bun. The build uses Bun conditions and a Bun compile target for each OS/architecture:

[`packages/opencode/script/build.ts#L156-L183`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/script/build.ts#L156-L183)

Because the package import map routes `#sqlite` by runtime condition, the standalone Bun path selects `sqlite.bun.ts`; the Node-targeted desktop server selects `sqlite.node.ts`.

[`packages/core/package.json#L25-L40`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/package.json#L25-L40)

## 5.4 WSL desktop server

**[VERIFIED]** The Windows desktop WSL path executes the OpenCode binary *inside the WSL distribution* and forces:

```bash
XDG_STATE_HOME="$HOME/.local/state"
```

[`packages/desktop/src/main/wsl/sidecar.ts#L17-L44`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/wsl/sidecar.ts#L17-L44)

**[INFERENCE]** This normally points at a WSL-local OpenCode data tree rather than the Windows desktop database. It is therefore not normally a concurrent opener of the exact Windows `opencode.db`; however, the codec implementation should still work there because users can copy/import databases and because the same OpenCode storage code runs in that environment.

## 5.5 Runtime compatibility matrix

| Execution path | Host runtime | SQLite binding | Typical database | Codec capabilities | Main compatibility risk |
|---|---|---|---|---|---|
| Packaged desktop default V1 server | Electron utility process / Node 24.15.0 | `node:sqlite` `DatabaseSync` | desktop `opencode.db` | `node:zlib`: Deflate, Brotli, Zstd; `Uint8Array` BLOBs | This is the primary production path; synchronous codec cost contributes directly to server latency. |
| Standalone CLI | Bun-compiled executable | `bun:sqlite` | user's OpenCode data DB | Bun `node:zlib` + native compression APIs; BLOB → `Uint8Array` | Byte-for-byte codec compatibility must be proven with Node. |
| `opencode db <query>` | whichever OpenCode runtime launches command | same runtime binding | same DB | raw SQL | Query can observe BLOB rather than JSON TEXT; `json_extract` no longer works on custom compressed bytes. |
| `opencode db` interactive | external `sqlite3` process | system SQLite CLI | same DB file | no OPCL decoder | Human/raw SQL debugging loses direct payload readability for compressed rows. Routing columns therefore become more important. |
| Opt-in V2 background desktop CLI | staged standalone OpenCode executable | Bun path | may discover same state home | Bun codec | Must decode new format, but storage project must not migrate V1 behavior onto V2. |
| WSL server | OpenCode binary inside WSL | typically Bun | WSL-local data tree | Bun codec | Separate DB in normal configuration; format still needs portability. |

## 5.6 Native runtime facts relevant to codec choice

- Node 24.15.0 `node:zlib` is Stable overall and exposes Deflate, Brotli, Zstd, and `crc32`: <https://nodejs.org/download/release/v24.15.0/docs/api/zlib.html>.
- Node's Zstd-specific APIs are still marked **Stability 1 — Experimental** in that release. This is a reason to gate Zstd rather than making it the only format on day one.
- Node 24.15 `node:sqlite` maps SQLite BLOB values to `Uint8Array`, and extension loading is disabled by default unless `allowExtension` is enabled: <https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html>.
- Bun's `bun:sqlite` maps BLOB values to `Uint8Array`; its SQLite driver supports `loadExtension`, but Bun documents an extra macOS requirement for extensions when using Apple's SQLite build: <https://bun.sh/docs/runtime/sqlite>.
- Bun documents `node:zlib` as fully supported and exposes Deflate/Brotli/Zstd functions: <https://bun.sh/reference/node/zlib>.

**[UNRESOLVED / REQUIRED PROBE]** The exact SQLite library version and compile-option set used by the packaged Electron `node:sqlite` path and each shipped Bun target should be recorded from the running artifacts with `SELECT sqlite_version()` and `PRAGMA compile_options`. The application source chooses the bindings but does not itself constitute a reliable statement of every packaged platform's SQLite build. The codec design intentionally avoids depending on SQLite-version-specific compression features.

**[INFERENCE]** An application-level codec built on standard `node:zlib` is substantially less packaging-sensitive than a SQLite extension, custom VFS, or Node-only native addon.

---

# 6. V1 versus V2 API ownership

The storage design must preserve the current product/API boundary rather than taking the existence of newer session-core tables as permission to migrate user behavior.

## V1 production evidence

The V1 session API defines message routes under `/session` and returns `SessionV1.WithParts`:

[`../../../packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts)

The V1 handlers call `session.messages`, `MessageV2.page`, and `MessageV2.get`:

[`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L105-L158`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L105-L158)

The app-side session synchronization code calls those V1 SDK endpoints rather than a V2 storage API.

## Constraint

Any compression layer must be invisible above the storage/repository boundary:

```text
Renderer / SDK / V1 HTTP API
            │
            ▼
     Session services
            │
            ▼
  payload codec boundary
            │
            ▼
 SQLite TEXT or BLOB
```

The V1 response object after decode must be byte-for-byte/semantically equivalent to the current JSON-derived object. No V2 endpoint migration is required or recommended.

---

# 7. SQLite driver and cross-runtime analysis

## 7.1 Common database service

`../../../packages/core/src/database/database.ts` constructs the shared Drizzle/SQLite service and immediately applies these PRAGMAs:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA wal_checkpoint(PASSIVE);
```

Then it applies database migrations.

[`packages/core/src/database/database.ts#L21-L36`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/database.ts#L21-L36)

The database path resolves to `opencode.db` for production/beta/latest channels unless an explicit `OPENCODE_DB` override or channel-specific rule applies:

[`packages/core/src/database/database.ts#L43-L57`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/database.ts#L43-L57)

## 7.2 Node adapter

The Node adapter uses `node:sqlite` `DatabaseSync` and `drizzle-orm/node-sqlite`:

[`packages/core/src/database/sqlite.node.ts#L1-L2`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/sqlite.node.ts#L1-L2)

A one-permit semaphore serializes access to the single connection:

[`packages/core/src/database/sqlite.node.ts#L115-L129`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/sqlite.node.ts#L115-L129)

The native database is opened synchronously and WAL is enabled unless disabled/read-only:

[`packages/core/src/database/sqlite.node.ts#L145-L164`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/sqlite.node.ts#L145-L164)

## 7.3 Bun adapter

The Bun adapter mirrors the architecture using `bun:sqlite` and `drizzle-orm/bun-sqlite`:

[`packages/core/src/database/sqlite.bun.ts#L1-L2`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/sqlite.bun.ts#L1-L2)

It also uses a one-permit semaphore and single native database object.

## 7.4 Database-wide consumers

A repository-wide source scan shows `Database.Service` is not session-only. It is used by event persistence, account/credential state, projects/directories, permissions, import/stats commands, sharing, worktree/control-plane paths, session services, and HTTP middleware. The built-in `opencode db` command also exposes raw SQL and can launch an external `sqlite3` shell against `Database.path()`.

**[INFERENCE]** This is another reason not to replace `opencode.db` with a bespoke file format or sidecar store. OPCL changes only selected payload values while leaving the shared SQLite database contract intact for unrelated tables.

## 7.5 Consequences for storage design

1. **Synchronous compression is acceptable only if bounded and very fast.** Both adapters are synchronous at the native SQLite layer and serialize through one connection. A slow codec can extend the critical section/transaction path.
2. **BLOB is the natural portable binary carrier.** Both runtimes return `Uint8Array`-compatible bytes.
3. **Native-extension approaches add disproportionate packaging risk.** Node extension loading must be explicitly enabled; Bun/macOS has additional SQLite-build constraints.
4. **A sidecar payload database would weaken atomicity.** Current durable event + projection writes occur inside one SQLite transaction. Splitting payloads across files/databases complicates crash consistency and backup semantics.
5. **Codec bytes, dictionary ID, and checksum behavior must be identical across runtimes.** A Node-written row can later be read by Bun and vice versa.

---

# 8. Current schema relevant to compression

## 8.1 V1 current-state session tables

`MessageTable`:

```text
message
├── id TEXT PRIMARY KEY
├── session_id TEXT NOT NULL FK -> session(id) ON DELETE CASCADE
├── time_created INTEGER
├── time_updated INTEGER
└── data JSON TEXT NOT NULL

index: (session_id, time_created, id)
```

`PartTable`:

```text
part
├── id TEXT PRIMARY KEY
├── message_id TEXT NOT NULL FK -> message(id) ON DELETE CASCADE
├── session_id TEXT NOT NULL
├── time_created INTEGER
├── time_updated INTEGER
└── data JSON TEXT NOT NULL

indexes:
(message_id, id)
(session_id)
```

Source: [`packages/core/src/session/sql.ts#L68-L101`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/session/sql.ts#L68-L101)

The `session` row already normalizes many fields that might otherwise require JSON extraction: project/workspace/parent, title, version, usage cost, token counters, agent, timestamps, etc. Some smaller structured values remain JSON TEXT (`summary_diffs`, `metadata`, `revert`, `permission`, `model`).

Source: [`packages/core/src/session/sql.ts#L22-L66`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/session/sql.ts#L22-L66)

## 8.2 Newer session-core tables

`session_message` normalizes `type`, `seq`, session, and timestamps while retaining a JSON `data` body. `session_input` stores a JSON prompt plus routing/admission sequence. `session_context_epoch` stores a JSON snapshot.

Source: [`packages/core/src/session/sql.ts#L119-L176`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/session/sql.ts#L119-L176)

**[INFERENCE]** These tables already demonstrate the design principle recommended here: move route/order/type metadata into native columns and leave a structured payload body. They are not, however, a reason to move V1 desktop behavior to V2.

## 8.3 Durable event tables

```text
event_sequence
├── aggregate_id TEXT PRIMARY KEY
├── seq INTEGER NOT NULL
└── owner_id TEXT

event
├── id TEXT PRIMARY KEY
├── aggregate_id TEXT NOT NULL FK -> event_sequence
├── seq INTEGER NOT NULL
├── type TEXT NOT NULL
└── data JSON TEXT NOT NULL

UNIQUE (aggregate_id, seq)
INDEX  (aggregate_id, type, seq)
```

Source: [`packages/core/src/event/sql.ts#L4-L25`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/event/sql.ts#L4-L25)

This is particularly compression-friendly because all lookup/range metadata is already native.

## 8.4 Other potential payloads

The project table contains `icon_url`, `icon_url_override`, and JSON `commands`:

[`packages/core/src/project/sql.ts#L5-L21`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/project/sql.ts#L5-L21)

Credential/account/workspace tables also contain JSON, but they were not storage drivers in the supplied sample and should not be first targets.

---

# 9. Database lifecycle and migrations

## 9.1 Startup migration behavior

The database service applies PRAGMAs and then `DatabaseMigration.apply(db)` during service construction. Initial schema creation and each pending migration are transactionally journaled.

Source: [`../../../packages/core/src/database/migration.ts`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/migration.ts)

The migration layer creates/uses a `migration` table and migrates prior Drizzle journal state when necessary. This is good for schema evolution.

## 9.2 Why bulk payload conversion should not be a normal startup migration

**[INFERENCE]** A multi-gigabyte production database should not be recompressed in one schema migration transaction during startup. That creates:

- long startup blocking;
- large WAL growth;
- significant temporary disk requirements;
- difficult progress reporting;
- painful restart behavior after interruption;
- a large rollback blast radius.

The schema capability should be installed by a normal migration, but **data conversion should be a separate resumable migration job** with its own progress state and bounded transactions.

## 9.3 Existing historical JSON SQL dependency

A v1.18.18 migration that introduced normalized usage columns rebuilt them using `json_extract(message.data, ...)` for assistant cost/token fields:

[`packages/core/src/database/migration/20260510033149_session_usage.ts#L1-L55`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/migration/20260510033149_session_usage.ts#L1-L55)

This migration is historical after completion, but it proves that migration logic can depend on payload JSON queryability. Any future migration authored under the compressed format must use native routing columns or application decode logic rather than assuming `json_extract(data, ...)` is universally legal.

---

# 10. V1 read paths

## 10.1 Page hydration

`MessageV2.hydrate()` takes selected message rows, queries all associated parts using one `IN (...)` query, orders them, groups them by message, then reconstructs V1 `WithParts` objects.

Source: [`packages/opencode/src/session/message-v2.ts#L80-L123`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/message-v2.ts#L80-L123)

This is a strong existing shape:

```text
1 SQL query: select message page
1 SQL query: select parts for page message IDs
N independent payload decodes in memory
```

The recommended codec preserves this shape exactly.

## 10.2 Pagination

`MessageV2.page()` filters by `session_id`, uses `(time_created, id)` cursor ordering, fetches `limit + 1`, hydrates selected rows, and returns a cursor.

Source: [`packages/opencode/src/session/message-v2.ts#L425-L467`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/message-v2.ts#L425-L467)

The session service repeatedly pages in blocks of 50 when a caller requests all messages.

## 10.3 Point reads

`MessageV2.parts(messageID)` and `MessageV2.get({sessionID,messageID})` are explicit point operations:

[`packages/opencode/src/session/message-v2.ts#L492-L519`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/message-v2.ts#L492-L519)

## 10.4 Product API path

The V1 HTTP handler routes session message list requests to `session.messages()` or `MessageV2.page()`, and single-message requests to `MessageV2.get()`:

[`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L105-L158`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L105-L158)

**[INFERENCE]** A session-local or large fixed multi-record chunk conflicts with the actual access pattern. Independent payload frames preserve the existing efficient SQLite lookup plan and bound decompression to the rows that are already being returned.

---

# 11. Write and streaming-update paths

## 11.1 Durable full-state writes

`Session.updateMessage()` publishes the durable `MessageUpdated` event. `Session.updatePart()` publishes durable `PartUpdated` with a structured clone of the full part.

These flow through the durable event service and projector.

## 11.2 Token deltas are not durable

This is one of the most important findings in the workload analysis.

During reasoning streaming, `SessionProcessor` appends to the in-memory reasoning text but calls `updatePartDelta()` for each delta. During normal assistant text streaming it does the same.

[`packages/opencode/src/session/processor.ts#L286-L305`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/processor.ts#L286-L305)  
[`packages/opencode/src/session/processor.ts#L486-L523`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/processor.ts#L486-L523)

The schema definition for `PartDelta` is not declared durable, unlike `PartUpdated`.

**[VERIFIED] Consequence:** OpenCode does **not** rewrite a compressed growing JSON part for each token. The persistent part is typically written at text/reasoning start and completion, plus discrete state transitions. This removes the single worst amplification concern for per-row compression.

## 11.3 Tool results remain a hot storage concern

Tool calls transition through pending/running/completed/error states. A completed tool result can contain a large string output and metadata, and `session.updatePart()` persists the full state. Those durable full states are mirrored into the current projection.

**[INFERENCE]** Large tool results are the most important active-turn codec benchmark class. A codec that is acceptable for 500-byte metadata may still be too costly on a 1 MB tool result inside the durable transaction.

---

# 12. Durable event log and projection behavior

## 12.1 Atomic commit ordering

The durable event service opens an immediate database transaction. Within that transaction it:

1. reads current aggregate sequence;
2. validates/replay-checks the event;
3. encodes event data;
4. invokes registered projectors;
5. invokes optional commit hook;
6. updates `event_sequence`;
7. inserts the durable `event` row.

Source: [`../../../packages/core/src/event.ts`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/event.ts)

The session projector handles `MessageUpdated` and `PartUpdated` by upserting current state into `message` and `part`.

Source: [`../../../packages/core/src/session/projector.ts`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/session/projector.ts)

## 12.2 Implication

The durable event log is not a disposable duplicate cache. It is part of sync/replay semantics, while the projection exists to make product reads cheap. Deleting either representation is not an ordinary compression optimization.

## 12.3 Sync and replay dependency

Workspace sync reads `event` rows by sequence and transmits durable data; replay handlers reconstruct serialized durable events and feed them back through event replay logic.

**[INFERENCE]** OSES must live below these services behind a storage-neutral event adapter. Sync/replay must receive the exact same logical `{id, aggregateID, seq, type, data}` events regardless of whether history came from `event_hot` rows or sealed segments. Aggregate/type/sequence routing stays queryable without payload decompression.

## 12.4 High-value future optimization: semantic event deltas

The supplied DB shows that repeated durable snapshots often change only one or a few paths. This makes event delta/checkpoint encoding mathematically attractive. It is **not part of the first OSES format** because it changes replay random-access, dependency-chain, checkpoint, and corruption semantics. Benchmark it only after macro-segment/microframe compression + dictionaries establish the remaining post-compression redundancy.

---

# 13. Real-database observations

## 13.1 Important sample limitation

The supplied DB is small and fork-modified. It should be treated as a **structural and mechanism validation corpus**, not as a population-level sizing corpus.

Fork-specific schema visible in the DB but absent from the supplied v1.18.18 source includes:

- `part.search_text` plus `part_fts` and maintenance triggers;
- `session_message.search_text` plus `session_message_fts`;
- `session.paused_at`;
- `idx_message_provider_id ON message(json_extract(data,'$.providerID'))`;
- fork credential/backfill structures.

These additions matter because they reveal real extension pressure: a compression layer must accommodate local/fork indexes and search features, not just pristine upstream schema.

## 13.2 SQLite/file metrics

**[MEASURED]** Read-only reference metrics:

| Metric | Value |
|---|---:|
| DB file | 430,080 B (420 KiB) |
| analyzer SQLite | 3.46.1 |
| page size | 4,096 B |
| page count | 105 |
| freelist pages | 0 |
| auto-vacuum | 0 |
| WAL supplied with reference | no |
| SHM supplied | no |
| `dbstat` | available |

The read-only immutable copy reports `journal_mode=delete`; this does **not** contradict source behavior. The source unconditionally sets WAL at application startup. A standalone copied `.db` without its WAL does not preserve the live connection's journal-mode context in a way that should be used to characterize OpenCode runtime behavior.

## 13.3 Row counts

| Table | Rows |
|---|---:|
| `event` | 50 |
| `event_sequence` | 1 |
| `message` | 7 |
| `part` | 9 |
| `session` | 1 |
| `project` | 2 |
| `migration` | 41 |
| `session_message` | 0 |
| `session_input` | 0 |
| `session_context_epoch` | 0 |
| `part_fts` | 9 |
| `fork_credential` | 2 |
| `fork_message_credential` | 2 |

## 13.4 Physical page allocation

Largest `dbstat` consumers:

| Object | Bytes | Pages | SQLite payload bytes |
|---|---:|---:|---:|
| `project` | 81,920 | 20 | 81,796 |
| `event` | 36,864 | 9 | 27,624 |
| `sqlite_schema` | 24,576 | 6 | 16,421 |
| `message` | 4,096 | 1 | 2,694 |
| `part` | 4,096 | 1 | 2,265 |
| `idx_message_provider_id` | 4,096 | 1 | 59 |
| most empty tables/indexes | 4,096 each | 1 each | near zero |

**[INFERENCE]** On a tiny DB, minimum B-tree pages dominate. Compression cannot reclaim a 4 KiB page from every tiny table/index simply by shrinking a few hundred bytes of row payload. Mature databases should show much closer coupling between logical payload reduction and physical page reduction.

## 13.5 Large project payload outlier

One `project.icon_url_override` value occupied 79,901 logical bytes; `icon_url` contributed another 1,726 bytes. This explains why `project` is the largest physical table in this sample.

This is useful as a demonstration that OPCL should be reusable for other large opaque values, but it must not be generalized into “project icons dominate OpenCode databases.” There is only one such outlier in this reference.

## 13.6 Payload distributions

| Column | n | Total bytes | Min | Median | p90 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `message.data` | 7 | 2,141 | 151 | 407 | 437 | 437 | 437 | 437 |
| `part.data` | 9 | 914 | 21 | 29 | 231 | 254 | 272 | 277 |
| `event.data` | 50 | 23,321 | 224 | 499 | 633 | 633 | 656 | 656 |

The sample's part distribution is an excellent warning against blindly compressing every JSON value: the median part is only 29 bytes.

## 13.7 Event classes by payload bytes

| Event type | Rows | Raw `data` bytes |
|---|---:|---:|
| `session.updated.1` | 19 | 11,867 |
| `message.updated.1` | 19 | 7,715 |
| `message.part.updated.1` | 11 | 3,259 |
| `session.created.1` | 1 | 480 |

The session itself had 19 full `session.updated` durable records despite only one current `session` row.

## 13.8 Projection/event duplication

**[MEASURED]** Current-state equivalence check:

- message projection vs latest durable `message.updated`: 7 / 7 matched exactly;
- part projection vs latest durable `message.part.updated`: 9 / 9 matched exactly;
- exact matched current payload bytes: 3,055.

Version-count histogram across the 16 message/part entities:

| Durable versions | Entity count |
|---:|---:|
| 1 | 7 |
| 2 | 5 |
| 3 | 3 |
| 4 | 1 |

Therefore 9 / 16 objects had more than one durable full-state version.

Message/part durable-event bytes total 10,974 versus 3,055 current projection bytes. **[CALCULATED]** The durable event representation consumes 3.59× the JSON payload bytes of the current projection for those entities in this sample.

## 13.9 Repeated session snapshot delta potential

For the 19 `session.updated.1` events:

- raw full-state event bytes: 11,867;
- median changed JSON paths between consecutive states: 1;
- mean changed paths: 1.28;
- the most common changes were `info.time.updated` and title;
- a simple experimental patch-like representation for versions after the first required only 935 bytes.

**[CALCULATED]** That crude patch size is ~12.7× smaller than the full raw history. It is an upper-level research signal, not a production format recommendation.

## 13.10 VACUUM result

The baseline had `freelist_count=0`. VACUUM left the file at 430,080 bytes. In this particular sample there was no free-page windfall to claim before compression.

That result must not be generalized: every target corpus should measure pre/post VACUUM and page allocation independently.

---

## 13.11 Repetition inventory: small strings accumulate into a large structural tax

A recursive structural scan of the supplied 50-event reference corpus was performed without reporting private payload content.

| Metric | Value |
|---|---:|
| event rows | 50 |
| `event.data` UTF-8 bytes | 23,321 |
| JSON key occurrences | 1,038 |
| key-name bytes across occurrences | 6,058 |
| string-value occurrences | 481 |
| string-value bytes | 10,254 |
| bytes belonging to string values occurring more than once | 9,471 |
| repeated `event.aggregate_id` bytes | 1,500 |
| repeated `event.type` bytes | 905 |
| repeated `event.id` bytes | 1,500 |

The top structural keys repeat dozens of times: `sessionID`, `id`, `time`, `info`, `created`, `agent`, `providerID`, token/cost/cache keys, model/path/title/version fields, and others. The aggregate session ID appears 100 times in payload string values and consumes 3,000 bytes of the 23,321-byte payload corpus before considering the aggregate column/index copies.

This supports a three-part optimization strategy:

1. **relational normalization** for aggregate/type/foreign routing strings because compressors cannot shrink the copies stored in independent B-tree keys;
2. **semantic elision** for envelope-derivable values such as an aggregate/session ID, but only under versioned type-specific rules;
3. **block/dictionary compression** for repeated JSON key syntax and ordinary string values, rather than a global arbitrary-string intern table.

A generic string-intern table is deliberately not the default: it adds lookups, write contention, reference management, random I/O, and failure modes to save strings that a shared segment compressor can often encode at negligible marginal cost.

---

# 14. Workload characterization

## 14.1 Mutable vs immutable

| Data | Lifecycle | Read shape | Mutation shape | Compression implication |
|---|---|---|---|---|
| `session` row | mutable | point/list | repeated small field updates | keep most metadata normalized; compress only unusually large JSON adjuncts. |
| `message.data` | mutable but low-frequency after completion | point/page | durable full-state transitions | independent frame; never shared session chunk. |
| `part.data` text/reasoning | start → transient deltas → final | point/page/hydration | durable start/end; deltas transient | independent frame; tiny start row raw; final text compress. |
| `part.data` tool | state machine | point/page/hydration | several durable transitions; output can be huge | independent frame; strong size gate; benchmark large outputs. |
| `event.data` | append-only | aggregate/range/sync/replay | immutable after insertion | strongest target for OSES hot-tail + sealed segment/microframe storage. |
| `session_message.data` | current projection | by session/type/seq | can update current assistant/shell | independent row if later targeted. |
| `session_input.prompt` | mostly append/admission lifecycle | pending/ordered reads | promotion metadata normalized | compress only after V2-specific measurement. |
| context snapshot | snapshot-like | session point | replacement | likely good large-frame candidate later. |

## 14.2 Hot/cold distinction that actually matters

The crucial distinction is not simply “recent vs old.” It is **shared-chunk safety**:

- A completed message can later be involved in revert/cleanup/import/schema migration.
- A tool part can be marked compacted later.
- Current projections must remain cheaply point-addressable.
- Durable events are fundamentally immutable and therefore have the cleanest cold-chunk semantics.

This is why projections do not require a sealing state at all: messages/parts remain independently addressable, while the durable event log alone receives OSES sealing.

## 14.3 Compaction does not delete old tool output from storage

OpenCode's compaction/prune logic marks older completed tool results with a compacted timestamp so they can be omitted/truncated when building model context, but it persists the updated part. The original output remains in the stored part object.

Source: [`../../../packages/opencode/src/session/compaction.ts`](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/compaction.ts)

**[INFERENCE]** Old compacted tool outputs are excellent disk-compression targets: they can be large, are rarely needed interactively, and cannot currently be reclaimed merely because model context pruning occurred.


# 15. ChunkDB architecture and transferable principles

The supplied ChunkDB prototype is a Bun-native experiment that retains SQLite as the durability/index kernel while storing logical objects through a compressed record layer.

## 15.1 Prototype model

The prototype's central physical structures are:

```text
application
   │ get / put / getMany / putMany / delete
   ▼
ChunkDB
   ├── decoded-chunk LRU
   ├── logical directory: key → chunk_id / slot
   ├── immutable compressed base chunks
   └── compressed delta rows for point mutations
                       │
                       ▼
                    SQLite
```

Point mutations shadow a base chunk via a delta table rather than rewriting the full chunk; compaction later merges deltas into new immutable chunks. The prototype is therefore intentionally LSM-like.

The supplied prototype's later optimization pass uses:

- macrochunks of ~2,048 logical records;
- independently compressed microblocks;
- `point` profile: ~32 records/microblock;
- `balanced`: ~128;
- `ratio`: ~512;
- adaptive Zstd/libdeflate/raw decisions;
- a decoded-block LRU;
- batched directory maintenance.

## 15.2 Prototype measurements

**[MEASURED — prototype, not OpenCode]** On a supplied 50k structured-record synthetic workload using Bun 1.3.14:

| Format | Bulk write | 10k random reads | SQLite file | Payload ratio |
|---|---:|---:|---:|---:|
| plain SQLite JSON | ~205 ms | ~56 ms | 12.18 MB | — |
| individually compressed row | ~645 ms | ~111 ms | 9.99 MB | — |
| ChunkDB balanced | ~178–202 ms | ~109–117 ms | 2.66 MB | ~0.152 |

The prototype achieved roughly a 78% footprint reduction on that synthetic distribution while retaining approximately plain-SQLite bulk-write time. Its random point reads were roughly twice the plain baseline before warm-cache effects.

These numbers are useful evidence that shared structural redundancy can be enormous. They are **not** transferable OpenCode performance numbers: OpenCode has different record sizes, mutation patterns, SQLite bindings, event semantics, and product latency requirements. The supplied README excerpt also does not preserve a complete hardware/methodology record for those timings, so they should be treated as indicative prototype results rather than authoritative performance claims.

## 15.3 Transferable principles

The following ChunkDB ideas transfer well:

1. **Separate routing from payload.** Lookup metadata should not be trapped inside compressed bytes.
2. **Compress only when it wins.** Tiny/incompressible values should remain raw.
3. **Use format/codec IDs per object.** Mixed generations/codecs must coexist during migration.
4. **Bound random-read amplification.** Independently decodable units are more important than maximum shared-stream ratio.
5. **Treat hot and cold data differently.** Shared compression is safest after immutability is established.
6. **Make compaction background/resumable.** Never require a full store rewrite for every mutation.
7. **Cache decoded shared blocks only when shared blocks exist.** Do not add an LRU merely because ChunkDB has one.
8. **Measure SQLite file/WAL effects.** Logical compression ratio is not sufficient.

## 15.4 Non-transferable details

The following should *not* be ported literally into V1 message/part storage:

- 2,048-record macrochunks;
- 128-record default point-decode units;
- a separate logical directory for rows SQLite already indexes perfectly;
- a delta table for every message/part mutation;
- JSON array chunk serialization;
- Bun-specific codec APIs in shared core storage code.

OpenCode already has high-quality B-tree indexes and strong row identities. Replacing those with a second logical directory would duplicate functionality and complicate foreign keys/cascades.

---

# 16. Impedance mismatch: literal ChunkDB vs OpenCode

## 16.1 Random access

ChunkDB improves ratio by sharing compression context across records. OpenCode's V1 UI performs point reads and bounded page hydration. If 128 messages/parts share one frame, a single visible message could force unrelated history to be read and decompressed.

Define point-read amplification:

\[
A_r = \frac{B_{decoded\ unit}}{B_{requested\ logical\ payload}}
\]

For an independent row, `A_r ≈ 1` plus envelope overhead. For a session chunk, `A_r` can be orders of magnitude larger.

## 16.2 Mutation semantics

OpenCode's token deltas are transient, so the database does not face per-token chunk rewrites. Nevertheless, tool-state transitions, message completion, summary/error updates, revert cleanup, and migration can update individual rows. Shared message/part chunks would require one of:

- rewrite whole chunk;
- introduce a delta layer;
- copy-on-write generation plus directory update.

All three add machinery that independent row frames avoid.

## 16.3 Foreign keys and cascade semantics

The current schema relies on ordinary message/session row identity and foreign-key cascades. Packing logical rows into opaque chunk slots weakens direct FK enforcement and makes deletion/repair more application-owned.

## 16.4 Queryability

OpenCode ships an arbitrary SQL `db` command and its ecosystem/forks can create JSON expression indexes. A packed logical store makes ad hoc SQL much less useful. Independent compressed payloads already reduce JSON queryability; large shared chunks would reduce row-level observability further.

## 16.5 Corruption blast radius

With independent frames, one corrupted payload damages one logical row. With a 128-record shared frame, one corrupt frame can affect 128 records unless the format adds inner checksums/frames. The durable event log in particular should not increase corruption blast radius casually.

## 16.6 Conclusion

> **Literal ChunkDB is a poor fit for OpenCode's hot V1 message/part projections, but its routing/payload separation, thresholding, dictionaries, and cold immutable chunking concepts are strong fits.**

---

# 17. Compression and serialization experiments

## 17.1 Evidence hierarchy

Three classes of measurement are intentionally separated:

1. **Reference-DB measurements** — real bytes/shapes from the supplied `opencode-openfork.db`, but only 50 events and therefore statistically weak.
2. **Structural synthetic stress tests** — useful for measuring B-tree/index/row overhead under scale, but not representative of production entropy when a tiny seed trace is expanded.
3. **Future acceptance corpus** — the only evidence allowed to choose production thresholds/codecs: many distinct real/sanitized sessions, multiple providers/tools/workloads, warm/cold runs, and full p50/p95/p99 accounting.

No synthetic compression ratio is treated as a forecast of production savings.

## 17.2 Independent-row OPCL results on the reference DB

| Column | Raw | Deflate-raw L1 | Deflate+dict L1 | Brotli q1 | Brotli q4 | Zstd L1 |
|---|---:|---:|---:|---:|---:|---:|
| `message.data` | 2,141 | 1,524 (71.2%) | **1,209 (56.5%)** | 1,702 (79.5%) | 1,559 (72.8%) | 1,634 (76.3%) |
| `part.data` | 914 | 707 (77.4%) | **567 (62.0%)** | 822 (89.9%) | 730 (79.9%) | 799 (87.4%) |
| `event.data` | 23,321 | 14,684 (63.0%) | **12,344 (52.9%)** | 16,326 (70.0%) | 14,923 (64.0%) | 15,676 (67.2%) |

These rows were compressed independently, resetting the compressor every row. The result explains why a preset structural dictionary helps OPCL and also why an independently compressed event row leaves substantial cross-event redundancy unused.

With the modeled 20-byte OPCL envelope, five of nine tiny part rows should remain raw even under an aggressive “save any byte” policy. This remains evidence for thresholded OPCL on projections.

## 17.3 Shared event-stream result: the compression opportunity moves upward

Compressing many event payloads together collapses repeated JSON keys, repeated IDs/paths/model strings, and repeated full-state snapshots far more aggressively than per-row compression. In the tiny reference event stream, low-cost block codecs reduced the combined payload to roughly the high-single-digit percentage range of the original stream in directional probes.

That result is **not** a production forecast. It demonstrates only the mechanism: event history contains cross-record redundancy that independent frames reset away.

The architectural conclusion is still strong because it does not depend on the exact ratio: a segment store also removes repeated SQLite row headers, aggregate/type strings, and index keys that no payload compressor can touch.

## 17.4 Repetition inventory from the real reference corpus

Across 50 events:

```text
event.data JSON                          23,321 B
JSON key-name occurrences                1,038
key-name bytes across occurrences        6,058 B
string-value bytes                       10,254 B
repeated string-value bytes               9,471 B
aggregate_id column copies                1,500 B
type column copies                          905 B
event-id column copies                    1,500 B
```

The same session ID alone appears 100 times inside payload strings. This validates the user's core observation: “small” repeated strings become a large storage class in aggregate.

## 17.5 Event-schema structural stress test

A disposable event-only benchmark expanded the 50-event trace to 25,000 rows and compared three **event-subsystem-only** SQLite layouts. Therefore the earlier criticism that the baseline included unrelated projection tables does **not** apply to this particular test; both sides were event-only.

Measured structural stress-test sizes:

| Event-only layout | File bytes | Change vs row-string baseline |
|---|---:|---:|
| existing-style string row schema | 18,595,840 | baseline |
| integer-normalized row schema | 12,132,352 | -34.8% |
| segmented, ~32-event groups | 2,822,144 | -84.8% |
| segmented, ~64-event groups | 2,813,952 | -84.9% |
| segmented, ~128-event groups | 2,813,952 | -84.9% |

`dbstat` showed why normalization matters even before compression: the baseline event table was ~15.06 MiB and its aggregate/type indexes together consumed ~2.51 MiB; the integer-normalized table fell to ~10.78 MiB and corresponding indexes to ~0.64 MiB.

However, the benchmark expanded a tiny seed trace. That **systematically over-represents repeated payload content** compared with a genuinely diverse months-long history. Treat the 84.9% figure as an optimistic structural bound/stress test, never as an expected production gain.

One finding is still directly useful: in the segmented database, the exact per-event ID registry consumed ~680 KiB of a ~2.81 MiB file—roughly one quarter of the resulting event store. Once payloads compress well, event-ID indexing becomes a first-order design target.

## 17.6 Why semantic deltas remain deferred

Successive `session.updated` snapshots in the reference corpus often differ in very few logical paths. A semantic patch can look dramatically smaller than the raw next snapshot. But a shared LZ-family compression window already captures much of that similarity.

Therefore the correct test is not:

```text
raw snapshot vs semantic delta
```

but:

```text
compressed full-state microframes/segments
vs
compressed checkpoint + delta chain
```

Delta encoding adds chain dependency, checkpoint policy, random-access amplification, migration/version complexity, and a larger corruption domain. It should be accepted only if it produces a substantial *post-compression* Pareto improvement.

## 17.7 Shared dictionaries are now a first-class experiment

A shared dictionary is particularly attractive for:

- short sessions that never accumulate a large local compression window;
- the first microframe of every aggregate;
- independent OPCL rows;
- OSES microframes, whose small size intentionally caps random-read amplification.

Dictionary candidates:

1. **structural dictionary** constructed only from schema/property names, enum strings, and deterministic JSON syntax;
2. **trained release dictionary** built from a sanitized representative corpus;
3. **per-event-family dictionaries** only if the added dictionary-selection metadata/cache cost clearly beats one shared release dictionary.

A release dictionary must have an immutable ID and cryptographic digest. The decoder must reject an unknown required dictionary ID rather than silently producing garbage.

Privacy rule: never train a distributable dictionary directly on unsanitized user prompts, tool outputs, code, credentials, file paths, or other private content.

## 17.8 Codec capability facts

**[VERIFIED]** Electron 42.3.3 bundles Node 24.15.0.

**[VERIFIED]** Node 24.15's `node:zlib` exposes `ZstdOptions.dictionary` for compression/decompression, but the Zstd classes are marked **Stability 1 — Experimental**. This supersedes the older adversarial claim that dictionary decompression is unavailable in the actual target runtime; the compatibility risk is API maturity, not absence of the option.

**[PROPOSED]** Production policy:

- ship a stable codec path first;
- capability-test Zstd/dictionary support in the exact packaged Node and Bun artifacts;
- include golden cross-runtime bytes for every codec/dictionary ID;
- never silently change what an existing codec ID means;
- keep decoders for every codec ever written until a complete reverse migration removes those frames.

## 17.9 Physical SQLite outcome remains the real metric

The supplied DB is only ~420 KiB, so page/index minima dominate. Compressing logical payloads strongly did not translate proportionally into whole-file savings. Every future benchmark must report:

```text
logical bytes
main DB bytes
WAL bytes during writes/sealing
post-checkpoint bytes
post-VACUUM bytes
dictionaries / side storage bytes
```

Codec ratio alone is not an acceptance metric.

---

# 18. Candidate architecture analysis

## 18.1 Revised architecture classes

| Architecture | Compression | Point read | Range/replay | Hot write | Index density | Complexity | Verdict |
|---|---|---|---|---|---|---|---|
| SQLite tuning only | low | excellent | excellent | excellent | baseline | low | Phase 0/1 baseline |
| OPCL independent frames everywhere | medium | excellent | good | good | baseline event indexes remain | medium | correct for projections, insufficient for huge event log |
| row-normalized event table only | low/medium | excellent | excellent | good | **much better** | medium | useful fallback / migration intermediate |
| one huge session chunk | very high | poor | excellent | poor if mutable | excellent | high | reject |
| per-aggregate sealed segment, one codec frame | high | potentially poor first miss | excellent | excellent with hot tail | excellent | high | better, but point amplification too wide |
| **OSES macro-segment + microframes** | **high** | **bounded** | **excellent** | **excellent** | **excellent** | high | **preferred event design** |
| semantic delta/checkpoint chain | potentially highest | variable | variable | complex | excellent | very high | research only after OSES |
| sidecar/custom VFS | potentially high | variable | variable | variable | variable | extreme | reject for first production path |

## 18.2 Why the preferred design is hybrid rather than universal

The central mistake in a universal chunking design is assuming all compressed bytes share one access pattern.

- `message`/`part` projections are the UI's materialized view. They should be independently addressable.
- durable events are historical/replay material. Their dominant key is `(aggregate, seq)` and they are immutable after commit.
- giant exact payloads may eventually warrant object-level deduplication, but only above a large threshold and only after reconciling with OpenCode's existing file-backed `Storage` service.

The architecture therefore intentionally uses **different physical representations by lifecycle and access pattern** while retaining one transactional SQLite authority.

## 18.3 Weighted decision criteria

Recommended weights for the implementation decision matrix:

| Criterion | Weight |
|---|---:|
| correctness / crash safety | 20 |
| active-write p99 / WAL behavior | 15 |
| V1 interactive p95/p99 | 15 |
| total on-disk savings | 15 |
| cross-runtime compatibility | 10 |
| replay/range throughput | 8 |
| point-event first-miss latency | 5 |
| migration/rollback safety | 5 |
| memory/allocation behavior | 4 |
| implementation/maintenance complexity | 3 |

No weighted score is allowed to hide a hard veto: any architecture that breaks exact replay, corrupts on crash, requires unsupported runtime APIs, or creates pathological active-write amplification is rejected regardless of compression score.

---

# 19. Comparative decision details

## 19.1 Tuning only

Keep as the control and always do the low-risk work first: correct redundant indexes, VACUUM/free-page problems, page-size experiments, routing normalization, and WAL/checkpoint instrumentation. Tuning alone cannot remove the repeated event routing strings/full-state history shown by the workload.

## 19.2 Independent OPCL row frames

This remains the preferred representation for `message.data`, `part.data`, and selected current-state payloads because it preserves point reads, cursor pagination, FK/cascade semantics, and corruption isolation.

Using it for every event is no longer the final recommendation. It preserves the existing one-row-per-event overhead and throws away the strongest cross-event redundancy.

## 19.3 OSES macro-segments + microframes — preferred event architecture

OSES obtains compression/performance gains at four different physical levels:

```text
1. relational entropy elimination
   aggregate/type strings -> integer surrogate keys

2. row/index amortization
   many cold events -> one segment metadata/BLOB pair

3. structural semantic elimination
   seq implicit by ordinal; evt_ prefix implicit; type-specific derivable fields omitted

4. entropy coding
   JSON payloads -> independent 8–16 KiB microframes with shared dictionary
```

This is stronger than the earlier 4–8-event “microchunk” concept because it decouples **logical segment size** from **decompression unit size**. A 64 KiB segment may contain four to eight independently compressed frames. A range scan decodes them sequentially; a point lookup decodes only the target frame.

## 19.4 Why not globally intern every repeated string?

Global interning is attractive on paper because session IDs, provider/model names, paths, event types, and JSON keys repeat heavily. It is the wrong default abstraction for arbitrary payload values.

Normalize strings when they are:

- relational identifiers;
- routing/filter keys;
- present in B-tree indexes;
- low-cardinality enums with stable semantics.

Compress them when they are:

- arbitrary payload strings;
- high-cardinality values;
- not independently queried;
- naturally co-located in the event compression window.

A global string dictionary for arbitrary payload values introduces random lookups, lock/contention paths, reference/GC bookkeeping, and corruption dependencies. The compressor's LZ/dictionary model is effectively a cheaper local string dictionary with no relational maintenance cost.

## 19.5 Large-object deduplication

The previous proposal invented a new `payload_object` concept too casually. OpenCode already has a file-backed `Storage` service under `Global.Path.data/storage`; it stores JSON files and is already used for artifacts such as session diffs.

However, that service is **not automatically a safe canonical event-object store**:

- it is file-backed rather than SQLite-transactional;
- its ordinary write path serializes JSON files;
- it is not inherently content-addressed;
- backup/restore and crash atomicity are different from the database transaction that commits an event.

Therefore large-object dedup is deferred until exact-duplicate rates are measured. If justified, choose one of two explicit designs:

1. transactional SQLite content objects with FK/reference GC; or
2. extend `Storage` into a crash-safe content-addressed object store with a transactional manifest protocol coordinated with SQLite.

Do not add a second ad-hoc object store and do not externalize tiny repeated strings.

## 19.6 History deletion versus compression

Hard deletion already removes durable history for the aggregate. Archive is reversible and therefore not a safe implicit GC boundary. Event-history pruning before hard deletion is a protocol/product semantic change requiring explicit proof that historical replay is no longer needed.

---

# 20. Recommended architecture: OPCL + OpenCode Segmented Event Store (OSES)

## 20.1 Architectural split

```text
SQLite transaction/index kernel
│
├── current-state routing tables
│   ├── session
│   ├── message
│   └── part
│        └── OPCL mixed TEXT/BLOB payloads
│
└── durable event store
    ├── event_aggregate      compact aggregate dictionary + counters
    ├── event_type           versioned type dictionary
    ├── event_hot            globally append-friendly rowid tail
    ├── event_segment        small segment metadata/index summary
    ├── event_segment_blob   compressed immutable payload/index body
    └── event_id_locator     compact lookup accelerator, exact-verify semantics
```

The logical `EventV2` interface does not expose whether an event came from a hot row or a sealed frame.

## 20.2 Event routing dictionary

`aggregate_id` and versioned `type` strings should be stored once and referred to by integer keys throughout hot and sealed storage.

```sql
CREATE TABLE event_aggregate (
  aggregate_key    INTEGER PRIMARY KEY,
  aggregate_id     TEXT NOT NULL UNIQUE,
  owner_id         TEXT,
  latest_seq       INTEGER NOT NULL DEFAULT -1,
  sealed_seq       INTEGER NOT NULL DEFAULT -1,
  hot_count        INTEGER NOT NULL DEFAULT 0,
  hot_raw_bytes    INTEGER NOT NULL DEFAULT 0,
  last_append_ms   INTEGER NOT NULL DEFAULT 0,
  generation       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE event_type (
  type_key         INTEGER PRIMARY KEY,
  type_name        TEXT NOT NULL UNIQUE
);
```

The public API continues to use exact strings. Integer keys are a physical implementation detail.

`generation` changes only for storage-representation operations that can invalidate a sealing candidate (migration/rebuild/competing sealer), not for ordinary higher-sequence appends.

## 20.3 Hot tail: ordinary rowid table

```sql
CREATE TABLE event_hot (
  hot_id          INTEGER PRIMARY KEY,
  aggregate_key   INTEGER NOT NULL
                  REFERENCES event_aggregate(aggregate_key) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  event_id        BLOB NOT NULL,
  type_key        INTEGER NOT NULL
                  REFERENCES event_type(type_key),
  time_created    INTEGER,
  raw_len         INTEGER NOT NULL,
  data            BLOB NOT NULL,
  UNIQUE (aggregate_key, seq)
);

CREATE INDEX event_hot_aggregate_seq_idx
  ON event_hot(aggregate_key, seq);
```

The duplicate explicit index may be unnecessary because the UNIQUE constraint creates one; final DDL should use exactly one physical `(aggregate_key, seq)` index. It is shown separately here only to emphasize the access path.

Why rowid:

- `hot_id INTEGER PRIMARY KEY` is the physical rowid and follows global insert order in the normal case;
- interleaved sessions do not scatter the table's primary physical insertion point by aggregate;
- payloads can be large without forcing large keys/content into internal nodes of a WITHOUT ROWID table;
- `(aggregate_key, seq)` remains indexed for logical reads.

Do not use `AUTOINCREMENT` unless a future correctness requirement needs never-reused rowids; ordinary rowids are sufficient for ephemeral hot-storage identity.

## 20.4 Hot payload encoding

Default hot-event policy should optimize commit latency, not compression ratio:

```text
small/normal event -> raw canonical UTF-8 JSON bytes
large event        -> benchmark-gated independent frame or jumbo singleton segment
```

The event row carries `raw_len` so `hot_raw_bytes` can be maintained without remeasuring JSON. If the schema retains SQLite dynamic storage classes, hot `data` may be TEXT/BLOB; the adapter should normalize it to bytes internally to avoid repeated UTF-8 transcoding decisions.

No shared segment compression happens in the durable transaction.

## 20.5 Segment metadata and BLOB separation

```sql
CREATE TABLE event_segment (
  segment_id       INTEGER PRIMARY KEY,
  aggregate_key    INTEGER NOT NULL
                   REFERENCES event_aggregate(aggregate_key) ON DELETE CASCADE,
  first_seq        INTEGER NOT NULL,
  event_count      INTEGER NOT NULL,
  frame_count      INTEGER NOT NULL,
  raw_len          INTEGER NOT NULL,
  stored_len       INTEGER NOT NULL,
  format_version   INTEGER NOT NULL,
  codec_id         INTEGER NOT NULL,
  dictionary_id    INTEGER NOT NULL DEFAULT 0,
  type_set         BLOB NOT NULL,
  header_crc32     INTEGER NOT NULL,
  payload_crc32    INTEGER NOT NULL,
  time_sealed      INTEGER NOT NULL,
  UNIQUE (aggregate_key, first_seq)
);

CREATE INDEX event_segment_aggregate_seq_idx
  ON event_segment(aggregate_key, first_seq);

CREATE TABLE event_segment_blob (
  segment_id       INTEGER PRIMARY KEY
                   REFERENCES event_segment(segment_id) ON DELETE CASCADE,
  payload          BLOB NOT NULL
);
```

Separating metadata from the large BLOB lets common segment planning/type filtering fetch metadata without materializing compressed payloads. It also leaves `event_segment_blob` as an ordinary rowid table compatible with SQLite's C incremental-BLOB API if a future runtime binding exposes it.

Do **not** architect the first implementation around `sqlite3_blob_open()`: Node 24.15's `node:sqlite` and Bun's current documented APIs do not expose the C incremental-BLOB handle directly. The schema should merely avoid preventing that optimization later.

## 20.6 `type_set`: precise specification

Replace the vague `type_bitmap` with a format-versioned exact set:

```text
uvarint type_count
uvarint first_type_key
uvarint delta_to_next_type_key
...
```

Keys are sorted ascending and delta-uvarint encoded. Segment planning can therefore answer “can this segment contain any of requested type keys?” without loading the payload BLOB.

A Bloom filter is unnecessary initially because type cardinality per segment is small and exact sets are cheap. Add a Bloom only if measured type-set sizes become material.

## 20.7 Macro-segment + microframe geometry

A segment is a logical routing/index unit, not necessarily one compressor stream.

Starting experiment:

```text
segment target raw bytes: 64 KiB
segment min/max:           32 / 128 KiB
microframe target:          8–16 KiB
microframe maximum:        32 KiB except jumbo singleton
event maximum per segment: 128
```

Frame builder rules:

1. keep event sequence contiguous;
2. never mix aggregates;
3. do not split a normal event across frames;
4. if an event exceeds the normal frame ceiling, give it a singleton frame;
5. if it dominates the segment target, give it a singleton segment;
6. align frame boundaries to event boundaries, not arbitrary bytes.

The frame index maps event ordinal -> frame number + offset within decompressed frame.

## 20.8 Event-ID locator: exact correctness with compact indexing

Global event-ID uniqueness must remain exact. Two implementation tiers should be benchmarked:

### Tier A — simple exact packed registry

```sql
CREATE TABLE event_id_registry (
  event_id_packed  BLOB PRIMARY KEY,
  storage_kind     INTEGER NOT NULL,
  storage_id       INTEGER NOT NULL,
  ordinal          INTEGER NOT NULL
);
```

This is straightforward and lets SQLite enforce uniqueness directly. It may remain the preferred first production implementation because correctness/debuggability are excellent.

### Tier B — compact fingerprint locator with exact verification

When registry size becomes a first-order cost, store a 64- or 128-bit keyed fingerprint as the B-tree routing key and keep the exact packed event ID authoritative in `event_hot` / segment ID stream.

Lookup:

```text
fingerprint(requested ID)
  -> candidate locator rows
  -> load candidate ID stream only
  -> exact packed-ID equality check
  -> only then declare match/duplicate
```

A hash collision can therefore create extra work but **cannot create a false duplicate or false match**. The check+insert path runs under the same serialized write transaction/uniqueness protocol as durable commit.

Tier B is a higher-complexity optimization and should ship only if its measured page/index savings justify the extra exact-verification path.

## 20.9 Type-specific semantic elision

Never write generic rules such as “remove every field named `sessionID`.” The safe abstraction is a versioned manifest keyed by **versioned durable event type + physical format version**.

Conceptually:

```ts
type ElisionRule = {
  physicalFormat: number
  versionedType: string
  path: readonly string[]
  source: "aggregate_id" | "event_id" | "sequence" | "type"
}
```

Encode rule:

```text
read value at path
derive expected value from envelope
if exact deep equality:
    omit field physically
else:
    preserve field and record no-elision bit / use non-elided variant
```

Decode rehydrates the field **before** schema decoding.

Every new elision rule requires:

- golden round-trip vectors;
- property/fuzz tests over missing/null/extra/wrong-typed values;
- old/new event-version fixtures;
- intentionally failing equality cases;
- cross-runtime byte compatibility.

Failure to validate must fall back to storing the field, never to corruption.

## 20.10 Dictionary registry

Dictionary identity belongs in the storage format, not process-global hidden state.

```sql
CREATE TABLE compression_dictionary (
  dictionary_id    INTEGER PRIMARY KEY,
  codec_id         INTEGER NOT NULL,
  format_version   INTEGER NOT NULL,
  sha256           BLOB NOT NULL UNIQUE,
  bytes            BLOB NOT NULL,
  source_class     TEXT NOT NULL,
  time_created     INTEGER NOT NULL
);
```

A built-in release dictionary may instead be compiled into the application if and only if the exact bytes are addressable by a stable ID/digest and old decoder binaries retain them. Storing dictionary bytes in the DB makes backup/self-containment stronger but costs repeated database bytes only once; embedding makes runtime deployment simpler. Benchmark both operational models.

## 20.11 OSES read path

Aggregate range read:

```text
resolve aggregate_id -> aggregate_key
resolve requested event type names -> type_keys
read overlapping event_segment metadata + matching hot rows
skip segment whose exact type_set has no requested type
for each needed segment in sequence order:
    load segment blob
    parse small binary index
    decode only frames intersecting requested sequence/type page
    reconstruct seq = first_seq + ordinal
    reconstruct packed event ID -> exact string
    reverse semantic elision
    JSON.parse + schema decode
merge with hot tail
limit + hasMore exactly as current API requires
```

For long replay, frames are decoded sequentially and can be streamed to the consumer rather than building one enormous JS array when the API permits.

## 20.12 Point event read

Point lookup by aggregate+seq:

1. if `seq > sealed_seq`, query `event_hot`;
2. else find greatest segment `first_seq <= seq` for aggregate;
3. derive ordinal;
4. consult frame index;
5. decompress exactly one microframe;
6. decode one event.

This bounds first-miss decompression near the microframe target instead of the full segment ceiling.

## 20.13 Sealing algorithm: append-safe immutable-prefix conversion

```text
scheduler chooses aggregate A
  ↓
read event_aggregate counters
choose cutoff_seq <= latest_seq - safety_tail
read contiguous hot prefix [sealed_seq+1 .. cutoff_seq]
verify size-positive candidate
build OSES segment + frames OUTSIDE write txn
  ↓
BEGIN IMMEDIATE
re-read aggregate generation / sealed_seq
verify candidate prefix still exists and is contiguous
verify no competing segment covers prefix
INSERT event_segment metadata
INSERT event_segment_blob
INSERT/update ID locators
DELETE exactly candidate event_hot rows
UPDATE event_aggregate:
    sealed_seq = cutoff_seq
    hot_count -= N
    hot_raw_bytes -= rawBytes
COMMIT
```

Ordinary appends above `cutoff_seq` do not invalidate the segment candidate. A retry is required only if another sealer/migration changed the same sealed prefix/generation or SQLite write-lock acquisition failed.

## 20.14 Sealing scheduler

Initial scheduling rules:

- global compression workers: 1;
- global sealing commit concurrency: 1;
- foreground write latency has priority;
- pause/slow sealing if WAL grows past a configured soft limit, recent event-write p99 degrades, CPU is saturated, or migration is active;
- startup catch-up uses a token bucket / bytes-per-second budget rather than sealing every aggregate immediately;
- idle force-seal handles low-event-count aggregates when compression is space-positive;
- if a tiny aggregate cannot produce a net-positive segment, leaving a bounded handful of hot rows is correct.

## 20.15 Per-frame adaptive storage: never pay to compress entropy

Even inside a compressed segment, each microframe should independently decide whether compression is net-positive:

```text
compressed = codec(frame, dictionary)
if stored_header + compressed.length >= raw_frame.length - minimum_gain:
    store frame codec = RAW
else:
    store compressed frame
```

This prevents already-compressed/high-entropy tool data from expanding and allows a segment to contain a mixture of raw and compressed frames. The segment's default codec is only a default; frame metadata may override it.

Minimum gain should include not only bytes but CPU policy. A 12-byte saving on a 16 KiB high-entropy frame is not worth decompression work.

## 20.16 Compression execution context

“Outside the SQLite transaction” is necessary but not sufficient: synchronous compression on the same Node event loop can still hurt API latency.

Benchmark two execution modes:

1. **inline bounded compression** for very small candidate frames where worker dispatch costs more than the codec;
2. **dedicated maintenance worker** for larger segment/frame batches, transferring byte buffers where possible so CPU work does not occupy the foreground server event loop.

The abstraction must work in both packaged Node/Electron and Bun paths. Do not make a Node-only worker mechanism part of the on-disk format; worker strategy is a runtime scheduling optimization. A reasonable adaptive policy is “inline below measured crossover, worker above,” with the crossover determined by packaged benchmarks.

## 20.17 Existing file-backed Storage service

OpenCode's `Storage` service is real and relevant: it stores `.json` files under the data directory and already carries artifacts such as session diffs. It should be reused conceptually where appropriate, but it is not a drop-in canonical OSES segment store because its normal writes are not part of the SQLite durable-event transaction and it is not inherently content-addressed.

OSES segments remain inside SQLite for the first production design. Large-object externalization is a separate later experiment with explicit transactional/reference semantics.

## 20.18 Current-state OPCL remains independent

OPCL continues to use mixed legacy JSON `TEXT` and self-describing compressed `BLOB` values for large `message.data`, `part.data`, and selected other payloads. Routing fields needed by SQL filters/stats/search stay native.

OSES does **not** justify chunking the projection tables. The point-read/page-hydration reasoning remains unchanged.

---

## 20.19 Second-order whole-database relational ID compaction

The user's repeated-ID observation extends beyond events. Current high-volume rows repeat public string identifiers such as session/message IDs in child columns and indexes. After OSES proves the event-store win, benchmark rebuilding selected relational tables around compact internal integer keys while preserving public IDs exactly once per entity.

Conceptual direction:

```sql
CREATE TABLE session_vnext (
  session_key INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  ...
);

CREATE TABLE message_vnext (
  message_key INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  session_key INTEGER NOT NULL REFERENCES session_vnext(session_key),
  ...
);

CREATE TABLE part_vnext (
  part_key    INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  message_key INTEGER NOT NULL REFERENCES message_vnext(message_key),
  session_key INTEGER NOT NULL REFERENCES session_vnext(session_key),
  ...
);
```

The API still sees `ses_*`, `msg_*`, and `prt_*`; repeated FK/index entries become small integers.

This can improve both space and B-tree cache density, but it is **not bundled into first OSES migration** because it requires invasive table rebuilds, FK rewiring, and broad query changes. Measure `dbstat` bytes attributable to repeated text FKs/indexes on a mature DB first. Apply the same principle selectively to project/workspace/account IDs only when volume/cardinality supports it.

Do not replace external IDs with integers at API boundaries and do not remove the unique external-ID mapping.

# 21. Proposed routing schema

## 21.1 Projection routing plane

Before OPCL writes any compressed `message.data` / `part.data`, every field used by SQL filtering, usage reporting, FTS population, pagination, joins, or indexes must be native or deterministically projected.

Illustrative message columns:

```sql
ALTER TABLE message ADD COLUMN role TEXT;
ALTER TABLE message ADD COLUMN provider_id TEXT;
ALTER TABLE message ADD COLUMN model_id TEXT;
ALTER TABLE message ADD COLUMN cost REAL;
ALTER TABLE message ADD COLUMN tokens_input INTEGER;
ALTER TABLE message ADD COLUMN tokens_output INTEGER;
ALTER TABLE message ADD COLUMN tokens_reasoning INTEGER;
ALTER TABLE message ADD COLUMN tokens_cache_read INTEGER;
ALTER TABLE message ADD COLUMN tokens_cache_write INTEGER;
```

Illustrative part columns should be more conservative: at minimum `part_type`, and only fields proven necessary for routing/search/statistics.

Do not denormalize fields merely because they exist in JSON. Each native column has write/update/index cost.

## 21.2 Event routing plane

OSES replaces repeated text routing with:

```text
logical aggregate ID string  -> event_aggregate.aggregate_key
logical versioned type       -> event_type.type_key
logical sequence             -> segment first_seq + ordinal, or event_hot.seq
logical event ID             -> exact packed ID in hot/segment stream + locator
```

The public sync/replay APIs reconstruct the exact legacy strings/objects.

## 21.3 Event type dictionary lifecycle

`event_type.type_key` is an internal database key, not a protocol-stable global enum. New durable event versions insert a new type string/key. A segment stores integer type keys plus a `type_set`. Backups include the dictionary table, so segments remain self-describing at database scope.

Do not renumber existing type keys during VACUUM/migration. Compaction may rebuild a database only if it rewrites every dependent segment atomically/offline under a new storage epoch.

## 21.4 Fork-specific JSON index migration

The supplied fork has an index using `json_extract(data, '$.providerID')`. Any payload converted to BLOB would break that expression path. The migration order is therefore mandatory:

```text
add provider_id native column
backfill from JSON while data is TEXT
validate exact equality
create native provider index
switch queries
remove JSON expression index
only then allow BLOB payloads
```

The same rule applies to every other SQL-level JSON dependency discovered in the target fork.

## 21.5 Search projection

FTS/search columns should remain an independent searchable projection. OSES/OPCL compression must never require SQLite FTS to understand compressed bodies. Search-index maintenance extracts text before encoding and writes the dedicated search plane transactionally with the logical state change.

---

# 22. Binary formats: OPCL v1 and OSES v1

## 22.1 OPCL v1 remains the projection frame

OPCL is a self-describing independent row envelope:

```text
magic / version / codec / flags / dictionary-id
raw-length / payload-length / checksum
compressed-or-raw UTF-8 JSON payload
```

The decoder validates bounds before allocation, then checksum, decompression, UTF-8/JSON/schema semantics.

Legacy SQLite `TEXT` requires no envelope and remains valid indefinitely for small/incompressible rows.

## 22.2 OPCL codec registry

Codec IDs are immutable semantic contracts. Suggested registry:

```text
0 = raw UTF-8 JSON (inside envelope only when necessary)
1 = raw DEFLATE
2 = Brotli
3 = Zstd (experimental-runtime capability gated)
```

Actual numeric assignments must be frozen only when implementation begins. Never reuse an ID.

## 22.3 OSES segment container (`OCE2` working name)

Working binary layout:

```text
Fixed header
  magic = "OCE2"
  format_version
  flags
  aggregate_key?          [normally DB metadata, omit from blob unless self-check desired]
  first_seq?              [same]
  event_count
  frame_count
  dictionary_id
  header_bytes
  index_bytes
  id_stream_bytes
  type_stream_bytes
  payload_index_bytes
  frames_bytes
  header_crc32
  payload_crc32

Variable metadata streams
  ID clock stream
  ID random-suffix stream
  type-key stream
  frame directory
  per-event payload locator stream
  semantic-elision bit/rule stream if required

Frame region
  frame[0]
  frame[1]
  ...
```

All integers are little-endian fixed-width in the fixed header and unsigned varints in variable streams unless otherwise specified. The exact format must be documented byte-for-byte before implementation and covered by golden vectors.

## 22.4 Sequence representation

Events in a segment are contiguous. Do not store `seq` per event:

```text
seq(event ordinal i) = first_seq + i
```

If migration ever encounters a hole, that candidate cannot be represented by this segment version and must remain hot/direct or use a future format explicitly supporting holes.

## 22.5 Packed event-ID representation

Canonical `evt_` IDs:

- strip implicit `evt_`;
- decode first 12 hex chars to 48-bit clock/counter;
- store first value fixed 48-bit;
- store subsequent positive/nonnegative deltas as uvarints;
- map each 14-character base62 suffix to an integer and store exactly 84 bits;
- escape noncanonical IDs into an exact UTF-8 side stream.

Decoder must reproduce the original byte-for-byte event ID string.

## 22.6 Type stream

Store `type_key` per event using the cheapest deterministic encoding selected by format version:

- uvarint keys for generality;
- optional RLE for repeated adjacent type keys if it wins;
- do not use a mutable global Huffman table that would complicate random access.

Segment metadata contains the exact `type_set` to support prefiltering without reading the BLOB.

## 22.7 Payload index and microframes

Per event, store:

```text
frame_delta / frame_id
uncompressed_offset_within_frame
uncompressed_length
semantic_rule_bits / payload flags
```

Offsets/lengths are varints. Because frames are small, most values are one or two bytes.

Each frame is independently decompressible and includes or references:

```text
codec_id
raw_len
stored_len
checksum (optional per frame; segment checksum still required)
```

A per-frame checksum provides superior corruption localization and should be benchmarked against its overhead. For 8–16 KiB frames, four bytes/frame is normally inexpensive.

## 22.8 Dictionary identity

Every compressed frame that requires a dictionary records an immutable `dictionary_id`; dictionary bytes must be resolvable before decompression. Unknown dictionary IDs are a hard decode error, never a “try without dictionary” fallback.

## 22.9 Validation order

Decoder validation:

1. magic/version known;
2. fixed header lengths within configured maxima;
3. event/frame counts within maxima;
4. stream lengths sum without overflow and fit BLOB size;
5. first_seq + event_count cannot overflow logical integer domain;
6. frame directory offsets monotonic/in range;
7. payload event locators in range;
8. checksum(s) valid;
9. dictionary known;
10. decompressed frame length equals declared length and stays below cap;
11. packed ID streams decode exactly expected event count;
12. type keys exist in dictionary;
13. semantic-elision reconstruction valid;
14. JSON/schema decode succeeds.

Never allocate directly from an untrusted claimed raw length without checking a configured maximum.

## 22.10 Corruption semantics

Corruption must identify:

```text
aggregate / segment / frame / ordinal where possible
```

One damaged frame should not make unrelated aggregates unreadable. Other frames in the same segment may be structurally readable, but normal logical replay should fail deterministically rather than silently skip an event and break sequence semantics.

Repair tooling may export all verified frames and report the exact missing/corrupt range.

---

# 23. Detailed read/write algorithms

## 23.1 OPCL encode/decode

Projection row encode remains:

```text
serialize canonical JSON
if below size threshold -> TEXT
else compress selected codec/dictionary
if savings do not beat minimum byte/% threshold -> TEXT
else -> OPCL BLOB
```

Decode branches on SQLite storage class, validates the envelope, decompresses with strict output cap, parses JSON, and applies the existing schema.

## 23.2 Durable event insert

```text
logical publish(definition, data)
  ↓
validate definition / aggregate field
encode logical data using existing schema
resolve/create aggregate_key
resolve/create type_key
pack exact event ID
BEGIN IMMEDIATE (existing event transaction boundary)
  read event_aggregate latest_seq/owner
  enforce replay/owner/divergence semantics
  invoke projectors/commit hook exactly as today
  INSERT event_hot(raw direct representation)
  INSERT/update exact event-ID locator
  UPDATE event_aggregate:
      latest_seq
      owner_id if needed
      hot_count += 1
      hot_raw_bytes += raw_len
      last_append_ms = now
COMMIT
publish notifications
schedule asynchronous sealing if watermark crossed
```

No multi-event compression occurs inside this transaction.

## 23.3 Replay of an already-present sequence

The legacy code compares stored ID, versioned type, and deep logical data for idempotent replay. OSES must reconstruct the exact logical event from hot/segment storage and perform the same comparison.

A fast precheck may compare packed ID/type/declared digest, but any divergence decision must be logically equivalent to the current exact check.

## 23.4 Aggregate range read

Plan over both regions:

```text
sealed region: event_segment rows overlapping requested seq range
hot region:    event_hot rows after sealed_seq / requested after
```

Use `type_set` to skip sealed segments incapable of satisfying requested type keys. Decode only intersecting microframes. Merge by sequence and apply `limit + 1` semantics so `hasMore` remains exact.

## 23.5 Point lookup

For `(aggregate, seq)`:

- hot if `seq > sealed_seq`;
- otherwise locate segment by `aggregate_key` + greatest `first_seq <= seq`;
- compute ordinal and target microframe;
- decode one frame.

For event-ID lookup:

- use exact packed registry or fingerprint locator;
- exact-verify candidate ID before returning.

## 23.6 Seal candidate selection

Candidate builder reads `event_aggregate` counters and chooses a prefix that:

- begins at `sealed_seq + 1`;
- ends before the configurable safety tail;
- is contiguous;
- fits segment raw/count ceilings;
- yields at least one net-positive frame/segment unless the aggregate is being force-normalized for operational reasons.

Compression is performed after releasing any application-level read lock and before the SQLite write transaction.

## 23.7 Seal commit

The commit transaction verifies:

- `sealed_seq` still equals candidate predecessor;
- aggregate storage `generation` unchanged;
- candidate hot rows still exist with exact seq/count/raw-byte totals;
- no segment already claims the range.

It then inserts metadata/BLOB/locators, deletes hot rows, updates counters, and commits.

Higher-sequence appends are allowed to have occurred concurrently and do not invalidate the candidate.

## 23.8 Low-volume aggregate behavior

Idle trigger attempts to seal a small prefix. If the encoded segment plus DB-row/index overhead is not smaller and there is no operational reason to seal it, leave it hot. The hot tail is bounded by idle/count/byte policies and small low-volume aggregates do not meaningfully threaten database growth.

A hard-delete of the aggregate deletes both hot rows and sealed segments through FKs/cascade and removes its aggregate dictionary row.

## 23.9 Sync history

The experimental `/sync/history` path currently selects raw `EventTable` rows across all aggregates and orders by sequence. OSES requires a storage-neutral history iterator that yields the same logical shape:

```text
{id, aggregate_id, seq, type, data}
```

Because cross-aggregate global `seq` values are not globally unique/order-defining in the schema, preserve the current query's deterministic behavior exactly as tested rather than inventing a new global-order semantic. The migration must include sync golden tests against the legacy implementation.

## 23.10 Semantic-elision encode/decode

Encode:

```text
rule = manifest[versionedType, physicalVersion]
for each rule:
  expected = derive(envelope)
  actual = readPath(data)
  if deepEqual(actual, expected): mark elided and remove physical path
  else preserve value
serialize reduced data
```

Decode performs the inverse and then passes the reconstructed object through the existing schema decoder.

## 23.11 Cache lookup

Cache key should include at least:

```text
segment_id + frame_ordinal + format_version/dictionary identity
```

Cache value is decompressed raw bytes plus validated small frame index, not parsed event objects. Apply a byte cap and scan-resistant admission.

## 23.12 Delete

Aggregate/session hard delete should remove:

```text
event_hot rows
event_segment metadata
event_segment_blob rows
event ID locators
event_aggregate row
```

in one SQLite transaction/cascade plan. No orphan segment BLOBs are acceptable.

---

# 24. Hot / warm / cold lifecycle

## 24.1 Projection lifecycle

`message`/`part` rows remain physically independent regardless of hot/cold age. OPCL may re-encode a row when it is naturally updated or during explicit migration, but there is no session-wide projection compactor.

## 24.2 Event lifecycle

```text
new durable event
   ↓
event_hot (rowid, direct representation)
   ↓   byte/count/idle scheduler
eligible immutable prefix
   ↓
OSES sealed macro-segment
   ├── compact metadata/index
   └── independently decodable microframes
```

Sealed events never return to hot form for normal appends. Replay of an already-stored event validates against the sealed representation. A storage-format migration creates a new segment generation/shadow representation rather than mutating a segment in place while readers are active.

## 24.3 Sealing triggers

Primary trigger is bytes, not count:

```text
if hot_raw_bytes >= byte_high_watermark -> eligible
else if hot_count >= count_high_watermark -> eligible
else if idle_age >= idle_seal_delay -> consider force seal
```

Maintain counters transactionally so the scheduler does not repeatedly `COUNT(*)` or sum payload lengths.

## 24.4 Safety tail

Keep a small newest tail unsealed while an aggregate is active. This is not because committed events are mutable—they are not—but because it:

- avoids creating tiny segments immediately before more events arrive;
- reduces sealing frequency on active sessions;
- keeps the most likely debug/point-read events direct;
- creates a natural buffer for foreground activity.

Tune tail by bytes and count, not a fixed “last 100 events” dogma.

## 24.5 Idle and low-event aggregates

Idle sealing solves the adversarial low-event-count case. A workspace/project aggregate with only a few events can be sealed after idle if doing so is space-positive, or remain as a few hot rows if segment overhead would be worse. “Hot” is a physical representation, not proof that an aggregate is actively changing.

## 24.6 Archive is not finality

Archive state may be reversed; do not use it as permission to destroy event history. Hard deletion already removes event history. Future GC needs an explicit replay/sync-safe checkpoint contract.

## 24.7 Jumbo events

A jumbo tool/result payload must not force unrelated events into a huge decompression frame. Policy:

```text
raw_len > jumbo_frame_threshold
  -> singleton microframe
raw_len > segment_target or output would dominate segment
  -> singleton segment
```

Optionally independent-compress a jumbo event before it ages out of hot storage if the write-latency/WAL benchmark shows a clear win.

---

# 25. Migration, cutover, rollback, and compatibility

## 25.1 Migration principle: shadow event store, no sustained dual-write

The event-store migration is more structural than OPCL row conversion. Use a shadow-store protocol:

### Stage A — reader-capable schema

- add OSES tables/dictionaries/meta;
- deploy binaries that can read both legacy `event` rows and OSES but continue writing legacy rows;
- add projection routing columns required before OPCL BLOBs;
- keep `storage_epoch = legacy`.

### Stage B — bounded historical shadow backfill

For each aggregate:

1. read legacy events in sequence batches;
2. populate OSES shadow aggregate/type keys;
3. build sealed segments outside the write transaction;
4. commit shadow representation and a verified high-water mark;
5. retain legacy event rows as authority.

Because writers continue on legacy tables, backfill can lag safely.

### Stage C — short catch-up + atomic epoch cutover

Acquire an exclusive migration fence / stop legitimate sibling writers:

1. record per-aggregate legacy high-water marks;
2. backfill/catch up remaining events;
3. verify counts, IDs, types, sequences, logical hashes against legacy;
4. set `storage_epoch = oses-v1` in the same protected cutover operation;
5. switch new event writes to OSES;
6. release fence.

This avoids indefinitely doubling WAL traffic through dual-writing every event.

### Stage D — rollback window

Retain the old event tables read-only for a defined release/rollback window. New OSES writes make the old table stale, so downgrade requires **reverse export of post-cutover OSES events** before the epoch can return to legacy.

### Stage E — reclaim

Only after rollback policy permits:

- drop/rename legacy event structures;
- checkpoint;
- optionally VACUUM when operationally safe;
- measure actual reclaimed bytes.

## 25.2 OSES migration state

Use explicit resumable state with aggregate/sequence high-water marks, not the simple completion-only migration table.

```sql
CREATE TABLE oses_migration (
  name              TEXT PRIMARY KEY,
  phase             TEXT NOT NULL,
  aggregate_cursor  INTEGER,
  sequence_cursor   INTEGER,
  rows_done         INTEGER NOT NULL DEFAULT 0,
  raw_bytes_done    INTEGER NOT NULL DEFAULT 0,
  stored_bytes_done INTEGER NOT NULL DEFAULT 0,
  time_started      INTEGER NOT NULL,
  time_updated      INTEGER NOT NULL,
  time_completed    INTEGER
);
```

Progress advances in the same transaction as the corresponding shadow writes.

## 25.3 OPCL migration

Projection OPCL can still use mixed `TEXT`/`BLOB` rows and bounded batch conversion after all routing/index dependencies have been normalized.

Suggested batch bound is whichever comes first:

```text
500 rows
or 4 MiB uncompressed input
```

Tune from WAL/p99 measurements.

## 25.4 Disk-space model

During OSES backfill, both legacy and shadow history coexist. Required free space is therefore based on:

```text
legacy DB
+ expected OSES shadow
+ migration WAL high-water
+ safety margin
```

Do not assume “compression means migration needs little free disk.” Refuse/pause migration when headroom falls below the measured safe bound.

## 25.5 WAL/checkpoint migration policy

- compression outside transactions;
- one sealing/backfill commit at a time initially;
- bounded bytes per transaction;
- do not issue FULL/RESTART checkpoints on an interactive path;
- monitor WAL pages/bytes and commit latency;
- consider temporarily increasing `wal_autocheckpoint` or scheduling PASSIVE checkpoints during idle only if benchmark proves the default 1000-page behavior causes sealing/migration stalls.

SQLite's automatic checkpoints are PASSIVE, but the commit that crosses the threshold can still inherit checkpoint work. This must be measured on the packaged desktop hardware/runtime.

## 25.6 Old-client compatibility

Once `storage_epoch = oses-v1` or any OPCL BLOB exists, an old OpenCode binary is not assumed compatible. New binaries should refuse ambiguous/incompatible epochs explicitly.

Rollback to an old binary requires:

1. stop OSES/OPCL writers;
2. reverse-export every OSES-only event into exact legacy event rows;
3. decode every OPCL BLOB back to canonical legacy JSON TEXT;
4. rebuild required legacy JSON expression indexes;
5. verify event counts/sequences/IDs/logical data and projection rows;
6. `integrity_check` + `foreign_key_check`;
7. set legacy epoch;
8. only then launch old binary.

## 25.7 Backup/restore

A self-contained backup must include:

- all OSES tables;
- dictionary bytes or guaranteed immutable decoder dictionary assets;
- format epoch/meta;
- OPCL rows;
- no missing live WAL state.

Use a clean shutdown/checkpoint or SQLite backup API rather than copying only `opencode.db` while WAL is active.

If future large objects move to file-backed `Storage`, backup becomes multi-resource and needs an explicit manifest/snapshot protocol. That is another reason not to externalize canonical OSES payloads in the first version.

---

# 26. Failure handling and corruption containment

## 26.1 Failure table

| Failure | Required behavior |
|---|---|
| unknown OPCL/OSES format version | fail closed with typed storage error; never overwrite unknown representation |
| unknown codec ID | fail closed; identify row/segment safely |
| missing dictionary ID | fail closed; retain every dictionary required by live frames |
| malformed segment/header length | reject before allocation or decompression |
| declared raw/frame length above configured cap | reject as corruption/resource-limit condition |
| per-frame checksum failure | identify aggregate/segment/frame; logical replay fails rather than skipping sequence |
| segment checksum failure | reject segment; repair tool may inspect independently verified frames only |
| invalid packed event ID | reject exact event; never synthesize alternative ID |
| unknown type key | reject until dictionary/schema is available |
| semantic-elision reconstruction mismatch | fail decode; never guess a field |
| crash while building segment outside transaction | no DB mutation; hot rows remain authoritative |
| crash during seal transaction before COMMIT | SQLite rollback; hot prefix remains authoritative |
| crash immediately after seal COMMIT | segment authoritative; hot prefix already deleted atomically |
| competing sealer changes generation | discard/rebuild candidate; no overlapping segments |
| normal higher-seq append during build | candidate remains valid; append stays hot |
| missing optional Zstd capability on writer | writer must not emit Zstd; use supported stable codec |
| decoder encounters already-stored Zstd without support | incompatible runtime; do not mutate DB |
| old client opens OSES/OPCL DB | unsupported; reverse migration required |
| copied DB without live WAL | may be stale/inconsistent independent of compression; use SQLite-aware backup |

## 26.2 Repair possibilities

Projection rows can sometimes be reconstructed from the latest valid durable event. A historical event generally cannot be reconstructed from a current projection because prior versions are lost.

Repair must be an explicit command/tool, not an ordinary read side effect:

1. identify exact corrupt aggregate/segment/frame;
2. validate unaffected sequence ranges;
3. find an independently trusted source (sync peer/backup/projection only where semantically sufficient);
4. reconstruct into a shadow representation;
5. transactionally replace only after exact sequence/ID/type/data verification;
6. emit aggregate metadata only—never private decoded content—to logs.

## 26.3 Corruption blast radius

- OPCL: one row.
- OSES: normally one microframe for physical decompression damage, but the logical aggregate replay cannot silently cross a missing event. The segment/frame boundaries still help diagnostics and targeted repair.
- No segment crosses aggregates, so one corrupt block never destroys multiple sessions/workspaces.

## 26.4 Resource-exhaustion containment

Validate all counts, lengths, offsets, dictionary IDs, and frame totals before allocating. Cap:

```text
maximum segment stored bytes
maximum segment raw bytes
maximum frame raw bytes
maximum event raw bytes
maximum event count/frame count
maximum JSON/schema decode depth where practical
```

A locally corrupted DB must not become a decompression bomb.

---

# 27. Compatibility matrix

| Scenario | Supported? | Required behavior |
|---|:---:|---|
| New binary + untouched v1.18.18 DB | **Yes** | legacy event + JSON projection readers work |
| New binary + OSES shadow tables but legacy epoch | **Yes** | legacy rows authoritative; shadow ignored/verified |
| New binary + OSES epoch + mixed hot/sealed history | **Yes** | storage-neutral EventStore adapter merges both |
| New binary + mixed OPCL projection TEXT/BLOB | **Yes** | transparent dual-read |
| Old v1.18.18 binary + untouched DB | **Yes** | unchanged |
| Old binary + OSES cutover DB | **No** | old code expects legacy `event` rows; reverse export required |
| Old binary + any OPCL BLOB | **No** | old JSON path can encounter binary payloads |
| Node desktop writes OSES -> Bun CLI reads | **Must be yes** | release-gated golden vectors/integration DB |
| Bun CLI writes -> Node desktop reads | **Must be yes** | same |
| writer supports Zstd, reader supported runtime does not | **No emission permitted** | writer selects common supported codec |
| external `sqlite3` queries routing/meta | **Yes** | tables/keys remain ordinary SQLite |
| external `sqlite3` expects decoded segment payload | **No** | custom OSES BLOB requires decoder |
| FTS/search projection | **Yes** | search text stays separate/native |
| JSON expression index on OPCL body | **No** | migrate to native routing column before BLOB writes |
| interrupted shadow backfill | **Yes** | legacy authority + resumable high-water state |
| interrupted seal | **Yes** | transaction chooses hot or segment authority atomically |
| codec/dictionary upgrade | **Yes** | immutable IDs; mixed generations readable |
| backup/restore | **Yes** | include DB + required dictionary assets and proper WAL-consistent snapshot |
| live DB file copied without WAL | **Not guaranteed** | standard SQLite WAL caveat |

## Compatibility conclusion

OSES is a real storage-format epoch, not an invisible schema tweak. There is no way to reclaim legacy event-row/index bytes while keeping an old binary that only knows `EventTable` fully functional. The architecture therefore prioritizes a tested reverse exporter and explicit minimum-reader epoch over pretending backward readability can be preserved for free.

---

# 28. Security and privacy considerations

## 28.1 Dictionary privacy

Do not train a distributable dictionary on unsanitized user databases. Dictionaries can contain literal substrings from training material. Prefer schema-derived structural dictionaries or carefully sanitized representative training corpora with provenance.

## 28.2 Routing metadata

Aggregate/type/provider/model/role/token/cost routing remains plainly queryable in SQLite. Most is already plaintext today, but a future encryption-at-rest design must explicitly decide which routing plane fields remain visible.

## 28.3 Hash/fingerprint locators

If Tier-B event-ID fingerprint indexing is used, the fingerprint is only an accelerator. Exact packed ID comparison is mandatory. A keyed hash can reduce adversarial collision construction if the threat model includes malicious imported event IDs; the key must be stored/recoverable with the DB if deterministic lookups must survive restart.

## 28.4 Decompression resource limits

Treat every stored length/offset as untrusted. Bounded frames are a defense as well as a latency optimization. Reject unknown codecs/dictionaries and oversized declared output before allocating.

## 28.5 Compression then encryption

If encryption is introduced later:

```text
logical event/object -> semantic physical encoding -> compression -> encryption -> SQLite
```

Encryption destroys redundancy and therefore follows compression. Encryption metadata/version belongs in a separate format layer rather than overloading codec IDs.

## 28.6 Logging

Allowed metrics/log fields:

- aggregate key or hashed/opaque ID where needed;
- segment/frame ordinal;
- codec/dictionary ID;
- raw/stored lengths;
- timing/WAL/checksum status.

Never log decoded payload text, compressed bytes, prompt/tool content, credentials, file paths from private events, or dictionary training content.

## 28.7 Dictionary/cache memory

Dictionaries and decompressed frames are sensitive local data after decode. Keep cache bounded, process-local, and non-persistent unless explicitly designed otherwise. Do not expose frame contents in crash telemetry.

---

# 29. Performance model and benchmark acceptance thresholds

## 29.1 Workloads that must be measured

Projection workloads:

- one small message point read;
- message + all parts;
- session pagination;
- initial load / long scrolling;
- user message insert;
- assistant part/tool transitions;
- large tool-result projection;
- usage/search queries.

Event workloads:

- durable event append while UI is active;
- aggregate range read of 1, 10, 50, 500, and full history;
- first-launch/cold-cache replay;
- point event by `(aggregate, seq)`;
- point event by event ID;
- replay duplicate/idempotency check;
- sync history over many aggregates;
- sealing one active aggregate;
- startup catch-up sealing many aggregates;
- hard delete of a large aggregate;
- migration backfill/cutover/reverse migration.

## 29.2 Accounting per operation

Record at least:

```text
wall-clock p50 / p95 / p99 / max
CPU time where obtainable
bytes read from SQLite
bytes decompressed
number of frames decompressed
JSON.parse + schema-decode time
temporary allocation bytes / GC pressure
rows / indexes touched
WAL bytes added
checkpoint time attributable to workload
main DB bytes after checkpoint
```

A “38 µs segment read” that excludes JSON parse/schema decode while the baseline includes decoded objects is invalid.

## 29.3 Cache conditions

Every read benchmark must clearly label:

1. hot application frame cache;
2. warm SQLite/OS page cache but cold OSES frame cache;
3. cold process/application cache;
4. cold-ish first-launch replay after OS/file cache perturbation where reproducible.

Do not claim a single cache state is representative of every user operation.

## 29.4 Corpus requirements

The production decision corpus must contain **distinct sessions**, not replication of one trace. Stratify by:

- short (<20 event) sessions;
- medium sessions;
- very long sessions;
- reasoning-heavy streams;
- tool-heavy sessions;
- very large tool output;
- code patches/diffs;
- high-entropy/already-compressed text;
- repeated session updates/snapshots;
- multiple provider/model/agent strings;
- multiple projects/workspaces/paths;
- sessions with retry/replay/repair history.

Report both per-class and aggregate results so one highly compressible class cannot hide a regression in another.

## 29.5 Geometry sweep

Benchmark at least:

```text
segment target raw:  16, 32, 64, 128 KiB
microframe raw:        4, 8, 16, 32 KiB
dictionary:            none / structural / trained
codec:                 deflate / brotli / zstd-capability-gated
hot safety tail:       several count/byte policies
SQLite page_size:      4, 8, 16 KiB as an offline/VACUUM control where practical
```

Plot compression ratio against point-read p99, range-read p99, CPU, and WAL bytes. Select the Pareto knee rather than maximizing ratio alone.

## 29.6 Sealing benchmark

Measure:

- bytes compressed/sec;
- CPU utilization;
- candidate-build allocations;
- commit duration after compression is complete;
- WAL growth for insert segment + delete hot rows;
- impact on concurrent durable-write p99;
- checkpoint behavior at default and alternate `wal_autocheckpoint` values;
- startup catch-up with 1, 10, 100, 1000 eligible aggregates.

## 29.7 Event-ID locator benchmark

Compare:

- full string ID registry;
- exact packed ID registry;
- 64-bit fingerprint + exact verify;
- 128-bit fingerprint + exact verify.

Measure DB bytes, index pages, collision-candidate frequency, point lookup latency, replay insert latency, and implementation complexity. A compact locator that cannot prove exact equality is rejected.

## 29.8 Proposed acceptance gates

These are engineering gates, not measured claims:

- zero semantic divergence over differential/fuzz corpus;
- Node/Bun golden compatibility for every format/codec/dictionary;
- foreground durable-write p95/p99 ≤ baseline +5% unless total latency is still negligible and explicitly accepted;
- message/part OPCL interactive gates from the original report remain ≤5–10% depending operation;
- event range/replay p99 no worse than baseline or materially better after accounting for decode;
- cold point-event p99 should remain under an absolute sub-millisecond target on reference desktop hardware and should not regress catastrophically with segment size; microframes exist specifically to satisfy this;
- no unbounded WAL growth under sealing;
- no startup catch-up p99 spike beyond the product threshold;
- event-subsystem storage reduction must be substantial on a distinct-session mature corpus;
- whole-DB reduction must be material enough to justify the schema/migration complexity.

Do not freeze a percentage target until a representative corpus exists; record the proposed threshold in the implementation experiment plan before running it to avoid post-hoc goal shifting.

## 29.9 Benchmark provenance

Every authoritative result must record:

```text
OpenCode commit
Electron/Node/Bun versions
SQLite version + compile options
OS/hardware/storage
page_size / cache_size / journal / synchronous / wal_autocheckpoint
corpus identity + row/event counts + logical bytes
warm/cold procedure
sample count / repetitions
whether parsing/schema decode included
```

The old 25k replicated-trace result remains labelled “structural synthetic stress test” everywhere it appears.

---

# 30. Phased implementation plan

## Phase 0 — instrumentation and corpus

- implement read-only event/projection size profiler;
- collect aggregate payload statistics without content disclosure;
- record index/dbstat/WAL/page-cache behavior;
- assemble distinct-session benchmark corpus;
- add workload benchmarks before changing schema.

**Gate:** no architecture default chosen from the 50-event sample alone.

## Phase 1 — relational entropy + queryability

- normalize every SQL-level JSON dependency for OPCL;
- introduce event aggregate/type surrogate-key schema in a benchmark branch;
- remove redundant string-expression indexes only after native replacements validate;
- benchmark integer-normalized event rows against legacy as an independent low-risk control.

**Rollback:** schema additive / legacy data remains authoritative.

## Phase 2 — OSES reader + shadow writer tooling

Implement:

- OSES binary parser/validator;
- packed event IDs;
- exact `type_set`;
- macro-segment/microframe encoder;
- dictionary registry;
- dual legacy/OSES read adapter;
- shadow backfill and differential verifier;
- no production write cutover yet.

**Gate:** differential + fuzz + Node/Bun golden vectors pass.

## Phase 3 — OSES cutover experiment

- rowid hot tail;
- transactional aggregate counters;
- exact event-ID locator tier A;
- hybrid sealing scheduler;
- bounded background sealer;
- storage epoch cutover/reverse exporter;
- WAL/cache telemetry.

Run behind an explicit experimental flag on copied/test DBs first.

**Gate:** active-write p99, replay, point, WAL, startup and storage gates all pass.

## Phase 4 — OPCL projection payloads

Enable thresholded independent compression for `message.data` / `part.data` after routing/queryability migration. Event storage does not depend on OPCL being enabled first.

## Phase 5 — Pareto refinements

Benchmark, independently gated:

- trained/shared dictionary versus structural dictionary;
- fingerprint event-ID locator with exact verification;
- adaptive microframe geometry by event class;
- jumbo-event direct singleton compression;
- scan-resistant decompressed-frame cache;
- content-addressed large-object dedup if exact duplicate rate is material;
- whole-database internal integer FK keys for session/message/part/project/workspace IDs if `dbstat` proves repeated text keys are material.

## Phase 6 — semantic deltas/checkpoints, only if still justified

Compare compressed full-state OSES against checkpoint+delta representations. Proceed only on measured post-compression benefit.

## Phase 7 — protocol-safe history GC

Only after product/sync semantics provide a proof that old events are no longer required. Archive state alone is not sufficient.

---

# 31. Testing strategy

## 31.1 Byte-format golden vectors

For OPCL and OSES, freeze vectors containing:

- empty/small/large payloads;
- every codec ID;
- every dictionary ID;
- canonical and escaped event IDs;
- one/many event types;
- multiple microframes;
- jumbo singleton frame;
- every semantic-elision rule state.

Encode in Node -> decode Bun, encode Bun -> decode Node, and require exact logical equality.

## 31.2 Differential logical-store test

Run identical randomized event sequences through:

```text
legacy EventTable implementation
vs
OSES implementation
```

After every operation compare:

- latest sequence;
- aggregate range output;
- event-ID lookup;
- replay duplicate behavior;
- divergent replay errors;
- projector state;
- sync-history logical output;
- hard-delete result.

## 31.3 Semantic-elision property tests

For each rule:

- equality => field may be elided and reconstructs exactly;
- inequality => field is physically preserved;
- missing/null/wrong type => no silent substitution;
- unknown future event version => no rule applies unless explicitly registered;
- random nested object mutation => encode/decode logical deep equality.

No new elision rule merges without this suite.

## 31.4 Segment geometry fuzzing

Randomize:

- event counts/sizes;
- frame boundaries;
- varint lengths;
- noncanonical IDs;
- type-key distributions;
- jumbo events;
- maximum legal values.

Validate every point/range lookup against a flat logical array.

## 31.5 Corruption and truncation

Mutate:

- magic/version;
- header lengths;
- varints;
- frame directory;
- checksums;
- compressed bytes;
- dictionary ID;
- event-ID streams;
- type keys;
- semantic-elision metadata.

Decoder must fail deterministically, bound allocations, and never synthesize a different logical event.

## 31.6 Sealing concurrency

Generate sustained appends while the sealer repeatedly snapshots prefixes. Assert:

- no committed event lost;
- no duplicate sequence;
- no segment overlaps;
- appends above cutoff do not force candidate recompression;
- competing sealers resolve through lease/generation verification;
- crash before commit leaves hot rows authoritative;
- crash after commit leaves segment authoritative and hot prefix removed.

## 31.7 WAL/checkpoint fault tests

Interrupt at every statement in the seal transaction and migration cutover. Test with long-lived readers, multiple legitimate process paths, low disk space, busy timeouts, and WAL thresholds around checkpoint boundaries.

## 31.8 Migration fault injection

Kill/restart during:

- shadow backfill;
- catch-up;
- epoch cutover;
- reverse export;
- legacy-table reclaim;
- OPCL backfill.

All phases must be resumable/idempotent or explicitly require restoring a known snapshot.

## 31.9 Cache behavior

Test replay scans that exceed cache capacity. A scan-resistant policy must prevent a one-time long history replay from evicting the entire interactive working set.

## 31.10 Delete/cascade

Hard-delete a large session with hot rows, many segments, locators, dictionaries shared by other sessions, and projection rows. Verify no orphan event BLOB/locator remains and shared dictionary assets are not incorrectly removed.

---

# 32. Observability and rollout controls

## 32.1 Event-store metrics

Track at minimum:

```text
oses.hot_rows
oses.hot_raw_bytes
oses.sealed_segments
oses.segment_raw_bytes
oses.segment_stored_bytes
oses.frame_count
oses.seal_queue_depth
oses.seal_build_ms
oses.seal_commit_ms
oses.seal_conflicts
oses.seal_bytes_per_sec
oses.point_read_ms p50/p95/p99
oses.range_read_ms p50/p95/p99
oses.frames_decoded_per_read
oses.frame_cache_hits/misses/bytes
oses.event_id_locator_bytes / lookup_ms
oses.dictionary_hits/failures
oses.decode_failures by reason
sqlite.wal_bytes
sqlite.checkpoint_ms
sqlite.page_cache budget
```

## 32.2 OPCL metrics

Keep per-table:

- raw logical bytes;
- stored bytes;
- compressed/raw row counts;
- encode/decode p95/p99;
- skipped-by-threshold / skipped-no-gain;
- codec/dictionary distribution;
- checksum/decode failures.

## 32.3 Adaptive sealer controls

The background sealer should respond to product health:

- suspend or reduce concurrency when recent foreground DB p99 breaches threshold;
- cap bytes compressed per second;
- cap maximum WAL growth attributable to maintenance;
- prioritize aggregates farthest beyond byte watermark;
- de-prioritize currently active sessions unless the hot tail exceeds hard cap;
- expose a diagnostic “pause storage maintenance” control.

## 32.4 Feature gates

Separate flags:

```text
read OSES
shadow backfill OSES
write OSES hot tail
seal OSES
trained dictionary
fingerprint ID locator
OPCL message/part writes
large-object dedup
history GC
```

Do not couple all experimental optimizations into one irreversible switch.

## 32.5 Rollout sequence

1. readers + instrumentation;
2. shadow build/verify on developer DBs;
3. opt-in experimental OSES cutover;
4. canary packaged desktop + standalone CLI cross-runtime testing;
5. staged default-on only after telemetry gates;
6. advanced dictionary/locator/cache refinements independently;
7. old legacy tables reclaimed only after rollback window.

---

# 33. Rejected and deferred alternatives

## 33.1 Literal ChunkDB macrochunks for `message` / `part` — rejected

Projection access is point/page oriented; shared macrochunks would add visible read/write amplification.

## 33.2 One compressor frame per whole session — rejected

Excellent ratio, terrible point-read amplification/corruption blast radius, and awkward session mutation. OSES never chunks across aggregates and uses microframes inside segments.

## 33.3 Tiny 4–8 OSES segment/microframes as the final event design — superseded

They preserve too much SQLite row/index overhead. Macro-segments amortize database overhead while microframes bound decompression, giving a better separation of concerns.

## 33.4 `WITHOUT ROWID` hot payload table — rejected

Hot rows can be large. Ordinary rowid tables better fit large payloads and globally append-friendly insertion. `WITHOUT ROWID` is reserved for small-key tables only when benchmarked beneficial.

## 33.5 Global arbitrary-string interning — rejected as default

Normalize relational/routing strings; compress arbitrary payload strings. Global interning introduces too much random lookup/GC/contention complexity.

## 33.6 Cross-session event segments — rejected

Marginal dictionary/repetition gains do not justify delete/read/corruption/cache amplification. A shared release dictionary captures cross-session structure without physically mixing sessions.

## 33.7 Content-defined chunking — rejected for event primary layout

Event sequence and byte-bounded microframes already provide deterministic locality. CDC adds hashing/boundary CPU and poor mutation semantics without a clear benefit.

## 33.8 Sidecar canonical event payload store — rejected for first implementation

SQLite transaction atomicity and backup coherence are more valuable. Existing file-backed `Storage` is acknowledged but not transactionally equivalent to the event DB.

## 33.9 Attached SQLite DB / custom VFS / virtual table — rejected for first implementation

All add packaging/compatibility/recovery complexity before the application-level OSES design proves the value.

## 33.10 SQLite JSONB — benchmark control, not the main event solution

JSONB can reduce parse overhead/storage for individual JSON values but does not remove repeated relational strings/index entries or exploit cross-event redundancy like OSES.

## 33.11 MessagePack / CBOR — deferred

Serialization compactness alone is not enough. They may be benchmarked inside OPCL/OSES frames but must preserve exact schema semantics and beat compressed JSON after CPU costs.

## 33.12 Full semantic snapshot deltas — deferred

Only after compressed OSES proves insufficient. Compare post-compression size/latency, not raw patch size.

## 33.13 Event history GC on archive — rejected

Archive is reversible and sync/replay uses history. Hard deletion already removes events. Earlier GC requires explicit protocol-safe checkpoint semantics.

## 33.14 Experimental Zstd as the only codec — rejected

Node 24.15 Zstd is Stability 1 / Experimental. It may be a codec option after packaged runtime validation, never the only readable format without a stable fallback/reverse path.

---

# 34. Risks and unresolved questions

## 34.1 Representative event entropy

The largest unknown remains mature real-world diversity. The 50-event reference trace proves repetition exists but cannot estimate production ratio. The replicated 25k stress test exaggerates literal recurrence.

## 34.2 Best segment/microframe geometry

64 KiB / 8–16 KiB is a hypothesis. The Pareto knee may differ for short sessions, tool-heavy sessions, or different storage hardware.

## 34.3 Zstd lifecycle

Node 24.15 exposes Zstd dictionaries but marks Zstd experimental. A shipped Zstd codec requires exact packaged-runtime golden tests and long-term decoder retention. Stable Deflate/Brotli remain important controls.

## 34.4 Dictionary corpus/privacy

A trained dictionary can accidentally embed private corpus substrings. Prefer structural/sanitized training and inspect dictionary contents. Treat dictionary construction as a release artifact with provenance.

## 34.5 Event-ID locator complexity

Exact packed registry is simple but can become a significant fraction of a highly compressed store. Fingerprint+exact-verify can reduce index cost but complicates replay uniqueness. Benchmark before adopting Tier B.

## 34.6 Sync-history physical query

The experimental sync handler currently reads the event table directly across aggregates. OSES needs a storage-neutral iterator and golden behavioral tests; do not silently change ordering semantics.

## 34.7 Cache double buffering

SQLite currently receives ~64 MiB cache budget. OSES cache must not blindly add another 64 MiB. Tune the combined budget and measure OS page cache/GC effects.

## 34.8 Incremental BLOB I/O availability

SQLite C supports partial BLOB reads by rowid, but the current JS bindings do not expose that API directly. OSES metadata/BLOB separation provides most header-skipping benefit without depending on an unavailable binding and leaves future room for native partial I/O.

## 34.9 Sealing/checkpoint interference

Even a short final transaction writes a segment BLOB and deletes many hot rows, potentially adding many WAL frames. Concurrency, transaction size, checkpoint threshold, and maintenance pacing require packaged runtime measurements.

## 34.10 Semantic-elision future event versions

A generic omission rule can silently corrupt future schemas. Rules must be versioned by durable type + physical format and default to “preserve everything.”

## 34.11 Large-object dedup threshold

The duplicate rate and size distribution for giant tool results across event/projection/storage layers are unknown. Do not build content-addressing until measured exact duplicates justify it.

## 34.12 Old-client downgrade

OSES is structurally incompatible with old binaries after cutover. Reverse export must be real, tested code—not a theoretical rollback paragraph.

## 34.13 Multi-process legitimate writers

Desktop Node sidecar and Bun CLI paths can legitimately touch the same DB depending product mode. Format/capability gates must prevent one runtime from writing a codec another supported runtime cannot decode.

## 34.14 CPU budget on low-end machines

Compression performed outside the write transaction can still compete for CPU with model streaming/UI. Sealer pacing must be adaptive and benchmarked on slower CPUs, not only high-end developer hardware.

---

# 35. Source references

## 35.1 OpenCode v1.18.18 source

All links are pinned to commit `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`.

### Database core

- Database startup, PRAGMAs, path:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/database.ts>
- Node SQLite adapter:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/sqlite.node.ts>
- Bun SQLite adapter:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/sqlite.bun.ts>
- Migration driver:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/migration.ts>
- Data-migration completion table:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/data-migration.sql.ts>
- Historical session usage JSON migration:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/database/migration/20260510033149_session_usage.ts>

### Session/event schema and projections

- Session/message/part/session-core schema:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/session/sql.ts>
- Event schema:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/event/sql.ts>
- Durable event service:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/event.ts>
- Session projector:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/session/projector.ts>
- V1 schema/event definitions:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/schema/src/v1/session.ts>

### V1 product read/write paths

- Message V1/V2 compatibility storage functions:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/message-v2.ts>
- Session service:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/session.ts>
- Streaming processor:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/processor.ts>
- Compaction:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/compaction.ts>
- V1 HTTP API session group:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts>
- V1 session handlers:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts>
- Sync handler:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts>
- Workspace sync/control plane:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/control-plane/workspace.ts>
- Direct DB CLI:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/cli/cmd/db.ts>

### Desktop/runtime build

- Desktop package/runtime version:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/package.json>
- Desktop prebuild:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/scripts/prebuild.ts>
- Node-target OpenCode build:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/script/build-node.ts>
- Bun standalone build:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/script/build.ts>
- Electron Vite sidecar bundle resolution:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/electron.vite.config.ts>
- Desktop server spawn:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/server.ts>
- Utility sidecar:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/sidecar.ts>
- V1/V2 sidecar switch:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/index.ts>
- V2 background CLI path:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/background-cli.ts>
- WSL sidecar:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/desktop/src/main/wsl/sidecar.ts>

## 35.2 Primary runtime and SQLite references

- Electron 42.3.3 release / Node 24.15.0:  
  <https://releases.electronjs.org/release/v42.3.3>
- Node 24.15 `node:zlib`:  
  <https://nodejs.org/download/release/v24.15.0/docs/api/zlib.html>
- Node 24.15 `node:sqlite`:  
  <https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html>
- Bun SQLite:  
  <https://bun.sh/docs/runtime/sqlite>
- Bun `node:zlib` reference:  
  <https://bun.sh/reference/node/zlib>
- Bun Node compatibility:  
  <https://bun.sh/docs/runtime/nodejs-compat>
- SQLite JSON / JSONB:  
  <https://www.sqlite.org/json1.html>
- SQLite WAL:  
  <https://www.sqlite.org/wal.html>
- SQLite VACUUM:  
  <https://www.sqlite.org/lang_vacuum.html>
- SQLite VFS:  
  <https://www.sqlite.org/vfs.html>

### Additional primary references used in the strengthened event-store revision

- SQLite WITHOUT ROWID guidance (large rows and non-integer/composite-key use):  
  <https://www.sqlite.org/withoutrowid.html>
- SQLite rowid table behavior:  
  <https://www.sqlite.org/lang_createtable.html>
- SQLite AUTOINCREMENT overhead:  
  <https://www.sqlite.org/autoinc.html>
- SQLite WAL/checkpoint behavior and default auto-checkpoint:  
  <https://www.sqlite.org/wal.html>
- SQLite `wal_autocheckpoint`:  
  <https://www.sqlite.org/c3ref/wal_autocheckpoint.html>
- SQLite incremental BLOB I/O (`sqlite3_blob_open` / `sqlite3_blob_read`):  
  <https://www.sqlite.org/c3ref/blob_open.html>  
  <https://www.sqlite.org/c3ref/blob_read.html>
- Electron 42.3.3 runtime version:  
  <https://releases.electronjs.org/release/v42.3.3>
- Node 24.15 `node:zlib` Zstd/dictionary API:  
  <https://nodejs.org/download/release/v24.15.0/docs/api/zlib.html>
- Node 24.15 `node:sqlite`:  
  <https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html>

Additional OpenCode source references:

- Structured identifier generator:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/schema/src/identifier.ts>
- Event ID/definition schema:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/schema/src/event.ts>
- File-backed Storage service:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/storage/storage.ts>
- Session revert/session-diff Storage usage:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/revert.ts>
- Sync API shapes:  
  <https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/server/routes/instance/httpapi/groups/sync.ts>

## 35.3 Research artifacts generated during this investigation

The analysis used disposable scripts/results against a copy/read-only view of the supplied DB:

```text
analyze_reference_db.py
reference_db_analysis.json
reference_db_analysis.txt
db_experiments.py
db_experiment_results.json
```

The final recommendation does not depend on hidden benchmark numbers: all load-bearing measured results are reproduced in this document.

---

# 36. Appendices

## Appendix A — illustrative Phase-1 DDL

The exact migration should be generated through OpenCode's migration conventions, but the target shape is:

```sql
-- Routing plane first. Payload remains legacy TEXT during this phase.
ALTER TABLE message ADD COLUMN role TEXT;
ALTER TABLE message ADD COLUMN provider_id TEXT;
ALTER TABLE message ADD COLUMN model_id TEXT;
ALTER TABLE message ADD COLUMN agent TEXT;
ALTER TABLE message ADD COLUMN cost REAL;
ALTER TABLE message ADD COLUMN tokens_input INTEGER;
ALTER TABLE message ADD COLUMN tokens_output INTEGER;
ALTER TABLE message ADD COLUMN tokens_reasoning INTEGER;
ALTER TABLE message ADD COLUMN tokens_cache_read INTEGER;
ALTER TABLE message ADD COLUMN tokens_cache_write INTEGER;

ALTER TABLE part ADD COLUMN part_type TEXT;

-- Keep index count minimal; this is only an example justified by provider/time usage queries.
CREATE INDEX message_provider_time_idx
ON message(provider_id, time_created)
WHERE provider_id IS NOT NULL;
```

Backfill/verification should occur before compression. Once native routing is verified, fork-specific JSON expression indexes can be replaced.

## Appendix B — illustrative TypeScript codec interface

```ts
export type PayloadStorage = string | Uint8Array

export type CodecID =
  | 1 // deflate-raw-l1
  | 2 // deflate-raw-dictionary-l1
  | 3 // zstd-l1
  | 4 // brotli-q1

export interface PayloadPolicy {
  minBytes: number
  minAbsoluteSavings: number
  minRelativeSavings: number
  codec: CodecID
  dictionaryID: number
  maxRawBytes: number
}

export interface PayloadCodec {
  encodeJSON(value: unknown, policy: PayloadPolicy): PayloadStorage
  decodeJSON(value: PayloadStorage): unknown
}
```

The core codec module should depend only on APIs that work in both Node and Bun. Do not import `bun:zstd` directly from shared core code if that forces the Node bundle down a Bun-only path.

## Appendix C — proposed implementation file map

A plausible implementation boundary after the strengthened design:

```text
packages/core/src/database/
  payload-codec.ts
  payload-codec-format.ts
  payload-dictionaries.ts
  payload-policy.ts
  storage-epoch.ts

packages/core/src/event/
  store.ts                      # storage-neutral EventStore interface
  store-legacy.ts               # current EventTable adapter
  store-oses.ts                 # hot + segment adapter
  oses-format.ts                # OCE2 parser/encoder
  oses-id.ts                    # exact event-ID packing
  oses-frame.ts                 # microframe builder/decoder
  oses-elision.ts               # versioned semantic rules
  oses-sealer.ts                # scheduler/candidate/commit
  oses-cache.ts                 # optional bounded byte cache
  oses-migration.ts             # shadow/backfill/reverse export

packages/core/src/event/sql.ts
  legacy schema retained during migration
  event_aggregate / event_type / event_hot
  event_segment / event_segment_blob
  dictionary / locator tables

packages/core/src/session/sql.ts
  message/part routing fields + OPCL payload mapper

packages/core/src/session/projector.ts
  populate projection routing fields from typed objects

packages/core/src/database/migration/
  <timestamp>_projection_routing.ts
  <timestamp>_oses_shadow_schema.ts
  <timestamp>_storage_epoch.ts

packages/core/test/event/
  oses-format.test.ts
  oses-id.test.ts
  oses-differential.test.ts
  oses-sealing.test.ts
  oses-corruption.test.ts
  oses-migration.test.ts
  oses-golden-node-bun.test.ts

packages/core/test/database/
  payload-codec.test.ts
  payload-migration.test.ts

packages/opencode/test/session/
  storage-v1-api.test.ts
  storage-streaming.test.ts
  sync-history-storage.test.ts

bench/storage/
  corpus.ts
  repeated-string-analysis.ts
  event-layout.ts
  segment-geometry.ts
  event-id-locator.ts
  dictionary-training.ts
  sqlite-physical.ts
  wal-workload.ts
  cold-warm-read.ts
  node-bun-golden.ts
```

The implementation agent should prefer the smallest coherent boundary that preserves testability; this map is not an instruction to create abstraction layers with no measured use.

---

## Appendix D — read-only DB measurement SQL

Use against a copy or read-only connection:

```sql
SELECT sqlite_version();
PRAGMA page_size;
PRAGMA page_count;
PRAGMA freelist_count;
PRAGMA auto_vacuum;
PRAGMA journal_mode;
PRAGMA compile_options;

SELECT type, name, tbl_name, sql
FROM sqlite_master
ORDER BY type, name;

SELECT name,
       sum(pgsize) AS bytes,
       count(*) AS pages,
       sum(payload) AS payload,
       sum(unused) AS unused
FROM dbstat
GROUP BY name
ORDER BY bytes DESC;

SELECT count(*),
       sum(length(CAST(data AS BLOB))),
       min(length(CAST(data AS BLOB))),
       max(length(CAST(data AS BLOB)))
FROM message;

SELECT count(*), sum(length(CAST(data AS BLOB))) FROM part;
SELECT count(*), sum(length(CAST(data AS BLOB))) FROM event;
```

Percentiles are easier to compute in a small analysis script after retrieving only lengths. Do not export payload content into reports.

## Appendix E — SQL dependency scan

Before enabling compressed writes, search both source and live schema:

```bash
rg -n 'json_extract|json_each|json_type|json_valid' packages/core packages/opencode packages/app
```

And live schema:

```sql
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE lower(sql) LIKE '%json_extract%'
   OR lower(sql) LIKE '%json_each%'
   OR lower(sql) LIKE '%json_type%';
```

Also inspect triggers/views/FTS projection code that derives searchable text from payloads.

## Appendix F — OSES implementation specification

### F.1 Design goals

OSES is optimized for the durable-event workload, not general SQLite rows:

- foreground append remains one direct event row plus compact dictionary/locator updates;
- historical aggregate ranges are compact and sequential;
- point reads have bounded decompression;
- routing strings/indexes are normalized;
- exact replay/ID semantics are preserved;
- sealed history is immutable;
- maintenance is bounded and crash-safe;
- every format remains cross-runtime decodable.

### F.2 Illustrative DDL

```sql
CREATE TABLE event_aggregate (
  aggregate_key   INTEGER PRIMARY KEY,
  aggregate_id    TEXT NOT NULL UNIQUE,
  owner_id        TEXT,
  latest_seq      INTEGER NOT NULL DEFAULT -1,
  sealed_seq      INTEGER NOT NULL DEFAULT -1,
  hot_count       INTEGER NOT NULL DEFAULT 0,
  hot_raw_bytes   INTEGER NOT NULL DEFAULT 0,
  last_append_ms  INTEGER NOT NULL DEFAULT 0,
  generation      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE event_type (
  type_key        INTEGER PRIMARY KEY,
  type_name       TEXT NOT NULL UNIQUE
);

CREATE TABLE event_hot (
  hot_id          INTEGER PRIMARY KEY,
  aggregate_key   INTEGER NOT NULL REFERENCES event_aggregate(aggregate_key) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  event_id        BLOB NOT NULL,
  type_key        INTEGER NOT NULL REFERENCES event_type(type_key),
  time_created    INTEGER,
  raw_len         INTEGER NOT NULL,
  data            BLOB NOT NULL,
  UNIQUE(aggregate_key, seq)
);

CREATE TABLE event_segment (
  segment_id      INTEGER PRIMARY KEY,
  aggregate_key   INTEGER NOT NULL REFERENCES event_aggregate(aggregate_key) ON DELETE CASCADE,
  first_seq       INTEGER NOT NULL,
  event_count     INTEGER NOT NULL,
  frame_count     INTEGER NOT NULL,
  raw_len         INTEGER NOT NULL,
  stored_len      INTEGER NOT NULL,
  format_version  INTEGER NOT NULL,
  codec_id        INTEGER NOT NULL,
  dictionary_id   INTEGER NOT NULL DEFAULT 0,
  type_set        BLOB NOT NULL,
  header_crc32    INTEGER NOT NULL,
  payload_crc32   INTEGER NOT NULL,
  time_sealed     INTEGER NOT NULL,
  UNIQUE(aggregate_key, first_seq)
);

CREATE TABLE event_segment_blob (
  segment_id      INTEGER PRIMARY KEY REFERENCES event_segment(segment_id) ON DELETE CASCADE,
  payload         BLOB NOT NULL
);

CREATE TABLE compression_dictionary (
  dictionary_id   INTEGER PRIMARY KEY,
  codec_id        INTEGER NOT NULL,
  format_version  INTEGER NOT NULL,
  sha256          BLOB NOT NULL UNIQUE,
  bytes           BLOB NOT NULL,
  source_class    TEXT NOT NULL,
  time_created    INTEGER NOT NULL
);
```

The exact event-ID locator table remains a benchmark decision between exact packed registry and fingerprint candidate index with exact verification.

### F.3 Segment invariants

For every segment:

```text
first_seq >= 0
event_count > 0
last_seq = first_seq + event_count - 1
no gap in sequence
no overlap with another segment for same aggregate
all events belong to aggregate_key
frame_count > 0
all event ordinals mapped to exactly one frame
sum frame logical events = event_count
raw/stored lengths within configured caps
```

`event_aggregate.sealed_seq` is the largest sequence represented by a committed contiguous sealed prefix. Hot rows may exist only above that prefix under normal operation.

### F.4 Microframe builder

Pseudocode:

```ts
function buildSegment(events, policy, dictionary) {
  assertContiguous(events)

  const frames = []
  let frame = []
  let bytes = 0

  for (const event of events) {
    const physical = encodePhysicalEvent(event) // elision + JSON bytes

    if (physical.length > policy.jumboThreshold) {
      flush(frame)
      frames.push(encodeFrame([physical], dictionary))
      continue
    }

    if (frame.length && bytes + physical.length > policy.frameTarget) {
      flush(frame)
      frame = []
      bytes = 0
    }

    frame.push(physical)
    bytes += physical.length
  }

  flush(frame)
  return encodeContainer(events, frames)
}
```

Builder should consider **net stored size including frame/index/header overhead**, not just compressed payload bytes.

### F.5 Event-ID packing algorithm

Canonical detection:

```text
startsWith("evt_")
body.length == 26
body[0..11] all hex
body[12..25] all base62
```

Encode clock:

```text
clock0 = parseHex(body0[0..12])   // 48-bit
store 6 bytes
for i > 0:
  clock_i = parseHex(...)
  if clock_i >= clock_{i-1}:
     store uvarint(clock_i - clock_{i-1})
  else:
     use signed/escape form
```

Encode suffix:

```text
v = base62Decode14(body[12..26])
store v in 84 bits exactly
```

The decoder must format the 48-bit clock back to exactly 12 lowercase hex characters and base62 value back to exactly 14 characters with leading zero-symbol preservation.

### F.6 `type_set` encoding

```ts
const keys = [...new Set(typeKeys)].sort((a,b) => a-b)
writeUVarint(keys.length)
let prev = 0
for (let i=0;i<keys.length;i++) {
  const delta = i === 0 ? keys[i] : keys[i]-prev
  writeUVarint(delta)
  prev = keys[i]
}
```

Membership can binary-search decoded keys. Cache the decoded set with segment metadata if beneficial; it is tiny.

### F.7 Frame directory

For each frame:

```text
first_event_ordinal
logical_event_count
compressed_offset
compressed_length
raw_length
codec_id override?    [omit if same as segment]
checksum
```

For each event:

```text
frame_ordinal
raw_payload_offset
raw_payload_length
flags/elision bits
```

Use delta-varints where monotonic.

### F.8 Point lookup cost model

For a sealed event:

```text
1 metadata B-tree lookup
+ 1 segment BLOB lookup
+ small index parse
+ 1 microframe decompression
+ 1 JSON parse/schema decode
```

The goal is to make decompressed bytes approximately `O(frame_target)`, not `O(segment_size)`.

### F.9 Range lookup cost model

For `k` events across `f` frames and `s` segments:

```text
SQLite rows ≈ s metadata + s BLOB rows
frames decompressed ≈ f
JSON parses = k
```

Compared with row-per-event history, this trades `k` SQLite table/index row accesses for a small number of sequential BLOB/frame reads.

### F.10 Sealer state machine

```text
IDLE
  -> QUEUED when watermark/idle trigger
QUEUED
  -> BUILDING when global worker acquired
BUILDING
  -> READY when candidate encoded
  -> IDLE if no net-positive candidate
READY
  -> COMMITTING when SQLite writer acquired
COMMITTING
  -> IDLE on success
  -> QUEUED/BACKOFF on generation conflict/busy
```

Normal appends do not force BUILDING to restart because candidate covers an immutable prefix.

### F.11 WAL-aware pacing

Maintain moving windows:

```text
foreground_db_p99
wal_size_bytes
seal_commit_p99
seal_cpu_utilization
seal_queue_depth
```

If foreground p99 exceeds threshold, lower/pause sealer budget. If WAL exceeds soft cap, stop scheduling new maintenance and request/await safe PASSIVE checkpoint behavior according to measured policy.

### F.12 Cache budget

Example—not fixed production values:

```text
total storage cache = 64 MiB
SQLite page cache   = 48–56 MiB
OSES frame cache    = 8–16 MiB
```

Tune based on hit rate and replay scans. Do not add 64 MiB OSES cache on top of the existing 64 MiB SQLite cache by default.

### F.13 Dictionary experiment matrix

For each geometry run:

```text
none
structural static dictionary
trained sanitized global dictionary
trained event-family dictionary (only if justified)
```

Measure ratio, compression/decompression p99, dictionary memory, and short-session benefit.

### F.14 Semantic-elision manifest example

```ts
const rules = {
  "session.updated.1": [
    { path: ["sessionID"], source: "aggregate_id" },
    { path: ["info", "id"], source: "aggregate_id" }, // only if source schema proves equality
  ],
  "message.part.updated.1": [
    { path: ["part", "sessionID"], source: "aggregate_id" },
  ],
} as const
```

This example is illustrative; implementation must derive the exact safe rules from source schemas and property tests. Never infer rules solely from field names.

### F.15 Large-object interaction

Do not put a pointer to a file-backed object in the canonical event format until the object store can guarantee:

- object creation durability before event commit;
- no event can reference a missing object after crash;
- ref/GC correctness;
- atomic/manifest-aware backup;
- rollback/export back to legacy inline data.

Until then, jumbo frames stay self-contained in SQLite.

### F.16 GC semantics

```text
hard session delete -> delete aggregate OSES storage now
archive -> retain events
idle -> retain events, may seal/compress
checkpoint acknowledged by all required consumers -> future optional prune candidate
```

Compression and deletion are separate policy layers.

### F.17 Why this is stronger than the original microchunk proposal

Original approach:

```text
4–8 events -> one compressed row
```

Strengthened approach:

```text
32–128 KiB logical segment
  -> compact one-time routing/index metadata
  -> several 8–16 KiB independently decodable frames
  -> optional shared dictionary across frames/sessions
```

This simultaneously reduces SQLite row/index overhead and bounds point-read decompression. It is the central dual-objective improvement from the adversarial review.

---

## Appendix G — measured reference DB summary JSON equivalent

For implementation-agent convenience:

```json
{
  "db_bytes": 430080,
  "page_size": 4096,
  "page_count": 105,
  "freelist": 0,
  "rows": {
    "event": 50,
    "message": 7,
    "part": 9,
    "session": 1,
    "project": 2
  },
  "payload_bytes": {
    "message.data": 2141,
    "part.data": 914,
    "event.data": 23321
  },
  "event_repetition": {
    "json_key_occurrences": 1038,
    "json_key_name_bytes": 6058,
    "string_value_occurrences": 481,
    "string_value_bytes": 10254,
    "repeated_string_value_bytes": 9471,
    "aggregate_id_column_bytes": 1500,
    "event_type_column_bytes": 905,
    "event_id_column_bytes": 1500,
    "aggregate_id_occurrences_in_payload_strings": 100,
    "aggregate_id_payload_string_bytes": 3000
  },
  "projection_latest_event_exact_matches": {
    "message": "7/7",
    "part": "9/9"
  },
  "message_part_event_bytes": 10974,
  "message_part_projection_bytes": 3055,
  "deflate_dictionary_20B_model": {
    "raw_message_part_event": 26376,
    "stored_message_part_event": 15392
  },
  "physical_copy_experiment": {
    "baseline_minus_expression_index": 425984,
    "compressed_message_part_event": 413696,
    "saved_bytes": 12288,
    "saved_percent": 2.8846
  }
}
```

## Appendix H — weighted-scoring reminder

The decision score should be recomputed after real packaged benchmarks. In particular, measured p99 or WAL failures should reduce scores more aggressively than an extra few percentage points of compression improves them.

A useful general objective is:

\[
Score = w_s S_{space}
      - w_{99} \Delta L_{p99}
      - w_w A_w
      - w_r A_r
      - w_m M_{peak}
      - w_c C_{complexity}
\]

subject to hard constraints:

```text
correctness = true
V1 behavior preserved = true
Node/Bun decode parity = true
migration crash-safe = true
```

Do not trade a hard constraint for a higher scalar score.

## Appendix I — implementation order in one page

```text
1. Build distinct-session corpus + physical/WAL/cold-warm benchmark harness.
2. Add/validate native projection routing columns; remove JSON-expression dependencies.
3. Implement OSES binary parser, packed IDs, exact type-set, microframes, dictionaries.
4. Add OSES shadow schema + legacy/OSES differential reader; writes remain legacy.
5. Backfill shadow history and verify every aggregate/seq/id/type/logical payload.
6. Prove Node/Bun golden vectors and packaged runtime codec capabilities.
7. Implement rowid hot tail + aggregate counters + exact event-ID locator.
8. Implement immutable-prefix sealer with one bounded worker/commit path.
9. Benchmark geometry, dictionaries, WAL/checkpoints, cold point and range p99.
10. Provide reverse exporter; then run experimental OSES epoch cutover.
11. If OSES gates pass, enable staged production rollout and later reclaim legacy rows.
12. Implement OPCL projection compression after queryability routing is safe.
13. Pareto-tune ID locator, cache, trained dictionaries, jumbo policy.
14. Only then test semantic delta/checkpoint encoding against compressed OSES.
15. Event-history GC only after explicit replay/sync-safe product semantics exist.
```

---

## Appendix J — adversarial review resolution matrix

This appendix records how the supplied adversarial analyses changed the design. “Adopted” means the critique exposed a real gap. “Qualified” means the concern was valid but the proposed fix/claim needed source/runtime correction.

| Adversarial point | Disposition | Strengthened resolution |
|---|---|---|
| Large-payload `event_hot` as `WITHOUT ROWID` | **Adopted** | ordinary rowid hot table with `INTEGER PRIMARY KEY`; composite aggregate/seq is secondary unique path |
| Zstd dictionary unavailable in Node | **Corrected/qualified** | actual Node 24.15 docs expose dictionary for Zstd encode/decode, but Zstd is Stability 1 Experimental; capability-gate + stable fallback |
| 84.9% benchmark potentially apples/oranges | **Partly corrected** | benchmark was event-subsystem vs event-subsystem, but tiny-trace replication makes entropy unrealistically repetitive; demoted to structural stress test |
| no sealing trigger | **Adopted** | byte + count + idle hybrid triggers with transactional hot counters |
| vague `type_bitmap` | **Adopted** | exact delta-varint `type_set` with defined membership semantics |
| event-ID registry grows forever | **Adopted** | exact packed IDs first; benchmark compact fingerprint locator with exact verification; registry footprint is explicitly measured |
| low-event aggregates never seal | **Adopted** | idle force-seal if net-positive; otherwise bounded tiny hot residue is acceptable |
| trained/shared dictionary omitted | **Adopted** | dictionary geometry is first-class benchmark dimension with privacy/provenance rules |
| app cache duplicates SQLite page cache | **Adopted** | one combined storage-cache budget; small/off default OSES cache; scan-resistant byte cache |
| incremental BLOB I/O opportunity | **Qualified** | SQLite C supports it, but current JS bindings do not expose direct API; metadata/BLOB split preserves future path without depending on it |
| bulk sealing can create WAL/checkpoint stalls | **Adopted** | one bounded sealer commit, compression outside txn, adaptive pacing, benchmark auto-checkpoint policy |
| synthetic benchmark methodology opaque | **Adopted** | require page/cache/WAL/runtime/hardware metadata, warm/cold runs, parse/schema time, p50/p95/p99 |
| history GC should be near-term on session close/archive | **Rejected as stated** | hard delete already removes events; archive is reversible and sync/replay needs history; pruning needs explicit semantic checkpoint/ack |
| hot-tail composite key hurts global append locality | **Adopted** | global rowid physical insertion + logical aggregate/seq secondary index; avoid AUTOINCREMENT overhead |
| existing large-data Storage layer ignored | **Adopted/qualified** | existing file-backed JSON Storage is documented/reconciled; not transactionally equivalent to canonical event storage |
| point read ~7× median regression understated | **Adopted** | macro-segment + independently decompressible microframes bounds cold point amplification; full tail distributions required |
| event ID structure not exploited | **Adopted** | exact 48-bit clock-delta + 84-bit packed base62 suffix stream, with escape form |
| sealing invalidated by concurrent appends | **Adopted** | seal immutable prefix; higher-seq appends never invalidate candidate; only competing storage-generation changes do |
| semantic elision can silently corrupt future types | **Adopted** | versioned per-type manifest, equality assertion/fallback, golden/property/fuzz gate |

The resulting proposal is intentionally more complex than the first draft **only where the complexity buys an explicit compression/performance/correctness advantage**. Tempting complexity such as global arbitrary-string interning, immediate semantic delta chains, cross-session chunks, and archive-based history deletion remains rejected.

---

# Final recommendation

The strongest evidence-backed architecture for OpenCode v1.18.18 is a **hybrid SQLite-native storage system**:

### 1. OPCL for current-state projections

Keep `message`, `part`, and similar UI-facing records independently addressable. Normalize SQL/query/search metadata into native columns and use thresholded self-describing compressed payloads only where they are net-positive.

### 2. OSES for durable event history

Promote event storage to a first-class storage-engine redesign:

```text
integer aggregate/type routing
+ globally append-friendly rowid hot tail
+ per-aggregate immutable macro-segments
+ independently decodable 8–16 KiB microframes
+ exact structured event-ID packing
+ exact type-set filtering
+ versioned semantic elision of provably derivable fields
+ shared structural/trained dictionaries where validated
+ bounded background sealing
+ WAL/cache-aware maintenance
```

This directly targets the real source of runaway V1 database growth: not only large JSON bodies, but millions of individually small repeated IDs, type strings, JSON keys, paths, model/provider strings, full-state event versions, SQLite row headers, and B-tree index keys.

The design deliberately spends complexity only where it produces a dual compression/performance benefit:

- integer routing keys shrink both disk and comparison/index working sets;
- rowid hot storage preserves foreground append locality;
- segmentation amortizes SQLite overhead and captures cross-event redundancy;
- microframes bound point-read decompression;
- dictionaries recover structural redundancy for small frames/short sessions;
- structured ID packing removes deterministic ASCII overhead without sacrificing exactness;
- semantic elision removes information that is already present in the envelope, but only under strict versioned proofs;
- current projections remain independent, so UI reads are not dragged through event-history chunks.

### 3. Do not overfit to the tiny reference corpus

The supplied DB strongly establishes *mechanisms*—repetition, event/projection duplication, structured IDs, aggregate/range access—but not population-wide ratios. The 25k expanded-trace benchmark is a structural stress test, not a production compression forecast. Final geometry/codec/dictionary choices require a diverse multi-session corpus and full warm/cold p50/p95/p99 + WAL methodology.

### 4. Codec posture

Do not make experimental Zstd a mandatory storage dependency. The target Node runtime exposes Zstd dictionaries, but Zstd is still Stability 1 / Experimental. Ship a stable codec path, capability-gate optional Zstd, pin dictionary identity, and preserve decoders forever or provide complete reverse migration.

### 5. Event GC is separate from compression

Hard deletion already removes event history. Archive is not a safe GC boundary. Event pruning can eventually dominate every compression technique, but only after an explicit protocol/product guarantee proves old history is no longer required for replay/sync/debug semantics.

### 6. Implementation order

```text
instrument/corpus
→ normalize routing/queryability
→ implement OSES reader/format + shadow verifier
→ cut over OSES experimentally
→ enable OPCL projections
→ tune dictionaries/ID locator/cache/geometry
→ research deltas only if still useful
→ add protocol-safe history GC only if semantics permit
```

The result is not “ChunkDB transplanted into OpenCode.” It is a workload-specific storage architecture that uses ChunkDB's best principle—**separate compact routing from compressed payload representation**—and extends it with an event-store design tailored to OpenCode's append/replay semantics.

**Recommended implementation target:** **OPCL + OSES macro-segment/microframe architecture.**
