# V1 Product-API, Sync/Replay & Desktop-Surface Contract Ideation

**Lane:** storage layer invisible above the repository boundary
**Branch baseline:** `openfork` (fork of v1.18.18, pinned commit `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`)
**Peers:** OSES physical design (oses-arch), OPCL projection codec (opcl-arch), codec/dictionary compatibility (codec-arch), migration/epoch (migration-arch), benchmark corpus (benchmark-arch)
**Status:** IDEATION — no implementation code. Signatures are contract sketches, not code.
**Evidence labels:** [VERIFIED] = read directly from the openfork working tree on 2026-08-14; [MEASURED/INFERENCE] = derived; [PROPOSED] = this document's recommendation; [UNRESOLVED] = must be closed by benchmark/implementation.

Companion document: `../architecture-research.md` (the shared research doc). This document *extends* it with the adapter/sync/streaming/desktop contract work; where the research doc is contradicted by the actual fork source, this document calls it out and the fork source wins.

---

## 0. Executive position

The storage redesign (OPCL projections + OSES durable event store) is **invisible above the repository boundary only if we first close the three seams where the boundary is already violated today**:

1. **`sync.ts` handler and `workspace.ts` `sessionWarp` read `EventTable` directly**, bypassing `EventV2` entirely. Today's "EventV2 service" is *not* an abstraction — its storage code is inline and its read helpers are free functions that take `db` as an argument.
2. **`EventV2`'s transactional plan is fused with the row-gateway SQL.** The exact replay/divergence/uniqueness/sequence semantics live in `commitDurableEvent`'s inline queries, so any physical redesign must preserve *that code path's semantics* rather than inventing parallel semantics.
3. **Live SQL-level JSON dependencies on `message.data` exist in production fork code** (`session/usage.ts`, `fork/credentials.ts`, `session/search.ts`, plus the `idx_message_provider_id` JSON expression index). OPCL cannot write BLOB payloads until these are routed to native columns — this is a harder constraint than the research doc states ("an index" — it is indexes *and live query paths*).

The headline contract recommendation: **define one storage-neutral `EventStore` row-gateway + read API in `packages/core/src/event/store.ts`, reimplement `EventV2` on top of it (zero V1 wire-shape change), and route every direct `EventTable` consumer through it.** Then, and only then, OSES/OPCL can swap the physical layer underneath without touching the V1 HTTP surface, the SSE stream shapes, or the desktop renderer.

The V1 HTTP/API contract genuinely does **not** need to change — the wire shapes, route paths, pagination cursors, SSE event types, and `SessionV1.WithParts` object shapes all live above the seam. But "zero change" applies only to the *public* surface; four *internal* seams must move (see §12).

---

## 1. Verified ground truth (openfork tree, 2026-08-14)

### 1.1 The V1 read path is projection-only; events are write-path material

[VERIFIED] `../../../../packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`:
- `GET /session/:sessionID/messages` → `session.messages(...)` or `MessageV2.page(...)` — both read `MessageTable`/`PartTable` (SQL: `../../../../packages/core/src/session/sql.ts`), never `EventTable`.
- `GET /session/:sessionID/message/:messageID` → `MessageV2.get` → same projection tables.
- The `session.messages` full-fetch loops `MessageV2.page` in 50-row blocks (`session.ts:841-864`); `findMessage` does the same.
- `MessageV2.hydrate` shape is exactly **1 message query + 1 parts `IN (...)` query + N in-memory decodes** (`message-v2.ts:98-123`) — the OPCL-compatible shape the research doc assumes is present and confirmed.

[VERIFIED] `message.data` / `part.data` are `text({ mode: "json" })` columns (`packages/core/src/session/sql.ts:69-103`) — Drizzle `mode: "json"` means *application-side* JSON serialize/parse, so the DB column is ordinary TEXT. The payload boundary is currently JSON TEXT at the app boundary; there is no binary payload anywhere in the projection path today.

**FORK LANDMINE (missed by the research doc — pristine-v1.18.18 source has none of this):** the openfork tree ships a *ChunkDB prototype slice* for `event.data`:
- `../../../../packages/core/src/database/json-codec.ts` defines a `compressedJson` Drizzle `customType` (OCDB frame v2: magic `OCDB`, 14-byte header, zstd/brotli/raw-deflate, CRC32) whose `toDriver` is **identity** (hot writes are byte-identical to today) and whose `fromDriver` fail-closed decodes plain TEXT *or* frames.
- `../../../../packages/core/src/database/chunk-sealer.ts` defines a background cold-row sealer service (`ocdb_seal` journal) that frames `event.data` rows ≥ 4096 chars for dormant sessions (`typeof(data)='text'` eligibility predicate), one batch = one short transaction, off the hot path.
- `packages/opencode/bench/chunkdb-*.ts` exercise the same mechanism.

This sealer is a **precursor/overlap of OSES**, and it creates real contract landmines:
1. **`EventTable.data` in fork-produced DBs may already contain OCDB frames** (v1 10-byte / v2 14-byte, zstd/brotli/deflate). The current live schema is still `text({ mode: "json" })` — it does **not** use `compressedJson` — so *any* code reading a framed row through the current schema would JSON.parse garbage. The legacy adapter's `readByAggregateSeq` idempotent comparison (`isDeepStrictEqual(stored.data, encoded)`) and the sync/`sessionWarp` exporters must either decode frames before comparison/export, or the migration must first decode every framed row back to TEXT.
2. **OSES backfill must decode frames first** (migration-arch has flagged the same): `event.data` frames must be decompressed to logical JSON before re-encoding into OSES; the `ocdb_seal` journal is the authoritative list of which rows are framed.
3. **Retire-or-absorb decision:** the fork sealer's eligibility policy (≥4096 chars, dormant 48 h, owner-null) and journal predate OSES. OSES sealing subsumes it; the fork sealer is **gated off before Stage B shadow backfill arms** (oses.md §9.3 — earlier than the epoch flip), so the OSES backfill reader never races the fork sealer on the same rows; its journal freezes and becomes the reverse-export decode manifest, then Stage-E reclaim inventory (with migration-arch). Post-flip there is exactly one frame producer; `generation` + `UNIQUE(aggregate_id, first_seq)` guard multi-process OSES sealers. The `compressedJson` codec itself is a useful reference for OPCL but its identity-`toDriver` + background-sealer split is exactly the pattern the research doc §17 rejects for projections and §20 adopts for events — this fork slice is effectively "OSES-lite" and should be reconciled, not duplicated.
   - **Codec-registry freeze (codec-arch):** the shipped OCDB v2 registry is `1=zstd, 2=brotli, 3=raw-deflate` — bytes are already on disk, so the research doc §22.2 numbering (`1=deflate…`) is wrong for this fork; the registry is frozen and append-only. Any OPCL reuse of the frame (opcl-arch's recommendation: reuse OCDB v2 for `message.data`/`part.data`, no second envelope) inherits this frozen registry.

[VERIFIED] V1 writes flow: `Session.updateMessage/updatePart/removeMessage/removePart` → `events.publish(SessionV1.Event.*)` → `EventV2.commitDurableEvent` (`packages/core/src/event.ts:205-367`) → one `BEGIN IMMEDIATE` transaction that (a) reads `event_sequence`, (b) runs replay checks, (c) encodes, (d) runs projectors (which upsert `message`/`part`/`session` rows **plus fork `search_text` columns**), (e) runs the commit hook, (f) upserts `event_sequence`, (g) INSERTs the `event` row. **The projection write and the event append are one atomic transaction.** OSES must preserve this exact atomicity boundary (§5).

### 1.2 Token deltas are transient — confirmed at both the schema and the call site

[VERIFIED] `SessionV1.PartDelta = define({ type: "message.part.delta", schema: {...} })` with **no `durable` option** (`packages/schema/src/v1/session.ts:633-642`), while `Created/Updated/Deleted/MessageUpdated/MessageRemoved/PartUpdated/PartRemoved` all carry `durable: { aggregate: "sessionID", version: 1 }` (line 502-507, applied at 572-631). `DurableEventManifest` filters `definition.durable !== undefined` (`packages/schema/src/durable-event-manifest.ts:12-13`), so PartDelta never reaches `EventTable`.

[VERIFIED] Call sites: `SessionProcessor` reasoning-delta and text-delta streams call `session.updatePartDelta(...)` (`processor.ts:301`, `:513`), which publishes PartDelta to the **in-memory pubsub only** (`session.ts:890-898` → `EventV2.notify`); the persistent part row is written by `updatePart` (durable `PartUpdated`) at start/end and state transitions. **Conclusion confirmed: no per-token durable write exists, therefore no per-token compression is needed and none should be added.** The app renderer accumulates deltas client-side (`part_text_accum_delta` in `packages/app/src/context/server-session.ts:1205-1247`) and resets on the durable part update.

[VERIFIED] The HTTP layer already keeps the codec boundary out of the streaming path: `../../../../packages/opencode/src/server/routes/instance/httpapi/middleware/compression.ts` excludes `/event`, `/global/event`, and `POST /session/:id/{message,prompt_async}` from response gzip/deflate (lines 11-12, 48-49). So at the *wire* layer, streaming is uncompressed today and that is intentional.

### 1.3 Every direct `EventTable` read/write in production code (the leak inventory)

[VERIFIED] Production (non-test) direct access sites, all of which must route through the adapter:

| # | Site | Operation | Must become |
|---|---|---|---|
| E1 | `core/src/event.ts:78-88` `readAggregate` | range `WHERE aggregate_id=? AND seq>? AND type IN (...) ORDER BY seq LIMIT n+1` | adapter `readAggregatePage` |
| E2 | `core/src/event.ts:263-290` `commitDurableEvent` | idempotent-replay check: `SELECT * FROM event WHERE aggregate_id=? AND seq=?` then deep-equal compare | adapter `readByAggregateSeq` |
| E3 | `core/src/event.ts:303-315` `commitDurableEvent` | event-ID uniqueness: `SELECT aggregate_id,seq FROM event WHERE id=?` | adapter `eventIDLookup` |
| E4 | `core/src/event.ts:336-348` `commitDurableEvent` | `INSERT INTO event` | adapter `insert` (inside the same txn) |
| E5 | `core/src/event.ts:541-552` `readAfter` | durable-stream catch-up: `WHERE aggregate_id=? AND seq>? ORDER BY seq` | adapter `readAfter` |
| E6 | `core/src/event.ts:514-523` `remove` | `DELETE event_sequence` + `DELETE event` by aggregate | adapter `removeAggregate` |
| E7 | `core/src/event.ts:21-32` `latestSequence` | `SELECT seq FROM event_sequence WHERE aggregate_id=?` | adapter `latestSequence` |
| E8 | `opencode/src/server/routes/instance/httpapi/handlers/sync.ts:72-85` `history` | **cross-aggregate** `SELECT * FROM event WHERE NOT(agg<=seq) ORDER BY seq` (global seq, no tie-break) | adapter `syncHistory` iterator |
| E9 | `opencode/src/control-plane/workspace.ts:645-663` `sessionWarp` | per-aggregate full read `ORDER BY seq` → POST `/sync/replay` to remote workspace | adapter `readAggregate` (full) |
| E10 | `opencode/src/control-plane/workspace.ts:320-330` | sync state: latest seq per aggregate from `event_sequence` | adapter `syncState` (map) |
| E11 | `opencode/src/control-plane/workspace.ts:920-930` | `event_sequence` lookup for an id list | adapter `syncState` (map) |

[VERIFIED] Test-only direct access (kept for the legacy adapter's differential suite): `../../../../packages/core/test/event.test.ts`, `session-create.test.ts`, `session-runner.test.ts`, `session-runner-recorded.test.ts`, `session-prompt.test.ts`, `session-title.test.ts`, `session-projector.test.ts`, `session-tool-progress.test.ts`. These assert exact row/type/seq behavior and are the natural seed of the legacy-vs-OSES differential gate (§6.3).

**This is the full inventory.** There is no other production code path that touches the event tables. Notably, `SessionRevert` and `SessionSummary` read the *projection* (via `session.messages`), not events — so revert is not an event-table consumer, it is a Storage-service consumer (§9).

### 1.4 The cross-aggregate ordering problem — verified, and sharper than the research doc

[VERIFIED] `EventTable` is a plain rowid table (`packages/core/src/event/sql.ts:10-25`): `id TEXT PK`, `aggregate_id`, `seq`, `type`, `data`, with `UNIQUE(aggregate_id, seq)` and `(aggregate_id, type, seq)` index. **There is no global sequence column.** `seq` is per-aggregate (each aggregate starts near -1 and increments independently via `event_sequence`).

[VERIFIED] `/sync/history` orders the cross-aggregate result with `orderBy(asc(EventTable.seq))` **only** (`sync.ts:82`). When two aggregates share a `seq` value — which is the normal case (every aggregate has a `seq 0` first event, `seq 1`, …) — SQLite breaks the tie by rowid. For an ordinary rowid table that is **insertion order in practice**, but it is *not* a documented contract, and it is exactly the ordering an OSES iterator must reproduce. The research doc's §23.9 flags this ("preserve the current query's deterministic behavior exactly as tested") but does not identify the tie-break mechanism. The tie-break **is** the implicit global-append-ordinal (rowid). This matters: OSES must carry a global append ordinal per event (or per segment + base) so the iterator reproduces `(seq ASC, global-append-ordinal ASC)` exactly. See §7.

### 1.5 Live SQL JSON dependencies (the OPCL precondition inventory)

[VERIFIED] Beyond the fork's JSON expression index, live *query paths* depend on `json_extract(message.data, ...)`:

- `packages/core/src/session/usage.ts:113` creates `idx_message_provider_id ON message(json_extract(data,'$.providerID'))`; lines 120-144 run usage queries with `json_extract` on `cost`, `time.created`, `providerID`, `role`.
- `packages/opencode/src/fork/credentials.ts:133-136, 247-268` — fork credential backfill/export reads `json_extract(message.data, '$.time.created'/'$.providerID'/'$.role'/'$.cost'/'$.tokens.*')`.
- `packages/core/src/session/search.ts:227` — `json_extract(m.data, '$.role')`.
- `packages/core/src/session/sql.ts:69-103` — `message.data`/`part.data` are `text({mode:"json"})`; Drizzle `mode: "json"` itself deserializes on read and serializes on write, which is an *application-level* dependency, not SQL-level.

Any of these executing against an OPCL BLOB fails or silently yields garbage. The migration order (native routing columns → backfill → verify → switch queries → drop JSON index → only then BLOBs) is therefore a **hard precondition**, not an appendix nicety.

### 1.6 Event-ID structure — research doc confirmed

[VERIFIED] `packages/schema/src/identifier.ts:6-30`: `create()` yields 26 chars = 12 hex chars (48-bit `timestamp × 4096 + counter`) + 14 base62 random chars (via `chars[byte % 62]`). `Event.ID` prefixes `evt_`. This validates the research doc's §1.5 structural packing claim (48-bit clock + ~84-bit suffix). One nuance the packing must preserve: the 12 hex chars are **not** a plain UTC timestamp — they encode `descending ? ~(ts*4096+counter) : ts*4096+counter` (the `descending()` variant flips bits), so the packer must treat the 48-bit value opaquely and round-trip the exact hex string, not re-derive a timestamp.

### 1.7 Desktop runtime topology — research doc confirmed

[VERIFIED] `packages/desktop/scripts/prebuild.ts:10` → `bun script/build-node.ts` (`target: "node"`), Electron utility process forks `sidecar.js` (`packages/desktop/src/main/server.ts:57-69`), V1 unless `OPENCODE_SIDECAR_V2=1` (`packages/desktop/src/main/index.ts:53-65`). Node adapter = `node:sqlite` `DatabaseSync` with a one-permit semaphore (`packages/core/src/database/sqlite.node.ts:115-129`); CLI = Bun (`bun:sqlite`). Both serialize through one connection in-process; cross-process safety is SQLite WAL + `busy_timeout=5000` (`database.ts:21-36`).

### 1.8 Feature-flag pattern — the precedent exists

[VERIFIED] `../../../../packages/opencode/src/effect/runtime-flags.ts` establishes the `enabledByExperimental(name)` pattern (`OPENCODE_EXPERIMENTAL` master toggle, or the per-feature var independently). Storage gates should follow the identical shape so operators get one coherent switchboard (§11).

---

## 2. Where the seam leaks today (challenge to "invisible above the boundary")

The research doc's layering diagram (Renderer/SDK/V1 HTTP → Session services → payload codec boundary → SQLite) describes the *projection* path correctly, but it omits three leaks:

1. **Handler-level `Database.Service` access.** `sync.ts` yields `Database.Service` and destructures `db` in the handler. Any handler today can bypass every abstraction. The adapter contract must make "touch the event tables" an *adapter-only* privilege; handlers keep service handles only.
2. **EventV2's storage code is inline and its read API is free-function-on-db.** `readAggregate`, `readAfter`, `latestSequence` are exported free functions taking `db` — callers can implement their own event queries with zero ceremony, which is exactly what `sync.ts` and `workspace.ts` did. A real `EventStore` interface with a service layer closes this.
3. **The "repository boundary" is two boundaries.** Projection reads (MessageTable/PartTable/SessionTable) go through Drizzle + `message-v2.ts`; durable reads go through `EventV2`/raw SQL. OSES changes only the event side; OPCL changes only the projection side. The adapter work here is *event-side only*; the projection-side contract is opcl-arch's lane but the boundary rule is shared: neither side may reach into the other's tables.

The consequence of not closing these: an OSES cutover would leave `sync/history` and `sessionWarp` reading a table that no longer exists (or a legacy table that stops being written), breaking workspace sync invisibly and non-deterministically.

---

## 3. The storage-neutral EventStore adapter contract (PROPOSED)

### 3.1 Placement and shape

`packages/core/src/event/store.ts` — a service (Effect `Context.Service`) plus a *synchronous row-gateway* interface used inside the existing write transaction. Two implementations: `store-legacy.ts` (current EventTable semantics, byte-identical behavior) and `store-oses.ts` (hot + sealed merge). Selection is a runtime flag/layer choice; both satisfy the identical interface.

The split is deliberately **two tiers**:

**Tier A — row gateway (transactional primitives).** These run *inside* `commitDurableEvent`'s `BEGIN IMMEDIATE` and must be implemented by both stores with exactly the current transactional semantics. They are synchronous with respect to the transaction (no Effect, or Effect that must not open its own transaction). `event_sequence` remains the authority for `latestSeq`/`ownerID` — the sync fence — and the adapter may delegate to it directly (it is never moved or rewritten; oses.md §9.3).

```ts
// Contract sketch — signatures, not implementation.
interface EventRowGateway {
  // E7 — read latest committed seq + owner for an aggregate (-1 if none)
  latestSeq(aggregateID: string): { seq: number; ownerID?: string }

  // E2 — exact point read for idempotent-replay comparison
  readByAggregateSeq(aggregateID: string, seq: number): StoredEvent | undefined

  // E3 — exact event-ID uniqueness check (must be exact, never fingerprint-only)
  //      MUST return { aggregateID, seq } — the E3 die message ("Event already
  //      exists at aggregate X sequence Y") needs both; a boolean is insufficient
  eventIDLookup(id: string): { aggregateID: string; seq: number } | undefined

  // E4 — append one event (called in the SAME transaction as the projector writes)
  insert(event: StoredEvent): void

  // E6 — hard delete of an aggregate's whole history
  removeAggregate(aggregateID: string): void
}
```

**Tier B — read API (service level, Effect).** Used by `EventV2.readAggregate`, the durable stream, sync, and workspace warp.

```ts
interface EventReadAPI {
  readAggregatePage(input: { aggregateID; after; limit; types? }): { events: StoredEvent[]; hasMore: boolean }
  readAfter(aggregateID: string, after: number): StoredEvent[]
  syncHistory(exclude: Map<aggregateID, lastKnownSeq>): StoredEvent[]   // E8 — ordering contract in §7
  syncState(aggregateIDs: string[]): Map<aggregateID, number>           // E10/E11 — latest seq per aggregate
  allForAggregate(aggregateID: string): StoredEvent[]                   // E9 — sessionWarp full read
}
```

`StoredEvent` is the *logical* row `{ id, aggregate_id, seq, type, data }` — the exact shape `/sync/history` returns and the shape `commitDurableEvent` compares against. **The adapter's contract is: any caller sees exactly the legacy logical event, regardless of physical storage (hot row, sealed microframe, semantic-elided, packed-ID).** This is the research doc §12.3 requirement, now pinned to concrete methods.

### 3.2 Why two tiers and not one

- The write transaction must not acquire its own locks or start nested transactions — the current code is `db.transaction(..., { behavior: "immediate" })` and projectors + commit hooks run inside it. Tier A operations are plain calls on the same connection; OSES's hot-insert must be exactly as cheap as today's row insert and must never compress in-transaction (§5).
- The read API is allowed to open read transactions / use cursors / batch, so it lives in the service layer. Sealing is a *maintenance* path, gated and serialized (§10), separate from both tiers.

### 3.3 How EventV2 refactors onto it (contract-level, not code)

`../../../../packages/core/src/event.ts` keeps its role as the *durable-event orchestration* layer (pubsub, projector registry, notify, replay, replayAll, claim, commit hooks) and becomes adapter-consumer:

- `commitDurableEvent`'s transaction body replaces its five inline `EventTable`/`EventSequenceTable` statements with Tier-A calls (E2→`readByAggregateSeq`, E3→`eventIDLookup`, E4→`insert`, sequence read→`latestSeq`, sequence upsert stays a gateway primitive). All *semantics* — the `isDeepStrictEqual` idempotency check, the `Seq mismatch` / `Replay diverged` / `already exists` deaths, the owner check, the `seq <= latest` fast path — move verbatim into an orchestration helper that both stores share, because they are **store-independent policy**.
- `readAggregate` / `readAfter` / `latestSequence` become thin delegations to Tier B.
- `remove` delegates to `removeAggregate`.
- `replay`/`replayAll` stay unchanged: they already operate on logical `SerializedEvent[]`, which is the store-neutral currency.

**Zero-change proof obligation:** the entire V1 HTTP/API surface (handlers, groups, SSE `session.*` events, `SessionV1.WithParts`, cursors) is a *consumer* of `Session.Service` + `MessageV2` + `EventV2Bridge.Service`. None of it imports `EventTable`. The only two files that import event tables outside `core/src/event.ts` are `sync.ts` and `workspace.ts`, and both are fixed by routing through Tier B. Therefore the public contract is preserved by construction once those two files move. This should be verified mechanically in CI: **a lint/import guard that forbids `@opencode-ai/core/event/sql` imports anywhere except `core/src/event/store*.ts`.** That guard is the enforcement of "invisible above the repository boundary."

**Adapter diff vs oses.md §9.2 (alignment record, 2026-08-14):** oses-arch's `EventStore` interface mirrors this §3 Tier A/B split — `insertHot`↔`insert`, `uniqueID`↔`eventIDLookup`, `readAt`↔`readByAggregateSeq`, `readRange`↔`readAggregatePage`, `history(exclude?)`↔`syncHistory`, `removeAggregate`↔`removeAggregate`. Two deltas recorded:
1. **`uniqueID(id): boolean` is insufficient for E3** — the die message ("Event `X` already exists at aggregate `A` sequence `S`", `event.ts:309-315`) needs `{aggregateID, seq}`. Either the interface returns the richer shape (as here) or the message is degraded; richer shape costs nothing.
2. **`readAfter`/`syncState` are not separate interface members in oses.md** — `durable()` reuses the readRange merge and workspace sync-state reads `event_sequence` raw (which is correct: the sync fence never moves). This §3 keeps `readAfter`/`syncState` as Tier-B conveniences that both stores implement by delegation; either shape satisfies the contract.

---

## 4. Sync/replay exactness — the semantics that must survive verbatim

These behaviors are the acceptance gate for any physical representation. All are [VERIFIED] from `commitDurableEvent` (`packages/core/src/event.ts:205-367`):

1. **Idempotent replay (exact).** If `input.seq <= latest` and the stored row's `id === event.id && type === versionedType(def.type, def.durable.version) && isDeepStrictEqual(stored.data, encoded)` → no-op (optionally backfills `owner_id`), return. **Any of the three inequalities → `Replay diverged` die.** The OSES store must reconstruct `data` from hot/segment storage *exactly* (semantic elision must rehydrate before this comparison — elided fields must deep-equal the originals, and the `encoded` side is the schema-encoded data, so elision rules must operate on the same encoding the projector sees).
2. **Divergent replay rejection.** Same as above, distinct die.
3. **Event-ID uniqueness.** `eventIDLookup(id)` must be **exact**. A fingerprint locator (research doc §20.8 Tier B) may only be an accelerator that narrows candidates; the final equality check is against the exact packed ID. A hash collision can cause extra work, never a false duplicate or false match.
4. **Sequence discipline.** Fresh event: `seq = input?.seq ?? latest + 1`; if `input.seq !== latest + 1` → `Sequence mismatch` die. `replayAll` additionally requires same-aggregate and contiguous `seq` from `events[0].seq` (`event.ts:480-512`).
5. **Owner fencing.** `strictOwner` + owner mismatch → die; `row.ownerID && ownerID` mismatch without strictOwner → silent skip. OSES aggregates carry `owner_id` in the dictionary row (`event_aggregate.owner_id`) — the adapter must surface it through `latestSeq` unchanged.
6. **Cross-aggregate history.** `/sync/history` excludes aggregates where the client's `lastKnownSeq >= stored.seq` and returns everything else (E8). The workspace sync loop posts this to a remote `/sync/replay`, which runs `replayAll` per aggregate. Exactness here = the response's *logical* events are exact and the ordering contract of §7 holds.

**Differential test contract:** the legacy adapter and OSES adapter must produce identical observable results for: latest seq; aggregate range pages (including `hasMore` at the `limit+1` boundary); event-ID lookup; idempotent replay no-op vs. divergence die; sequence-mismatch die; `syncHistory` ordering; `removeAggregate` cascade; hard-delete result. The existing `core/test/event.test.ts` suite already covers most of this against the legacy store — run it against both implementations (§6.3).

**Compare at logical level, never at stored bytes (codec-arch's hard boundary — adopted):** legacy TEXT rows and OCDB-framed rows hold *different stored bytes for the same logical event* (that is the entire point of cold-only sealing). The differential harness and the adapter compare **decoded logical events** — deep-equal of `data` + exact `id`/`type`/`seq` — and must **never assert stored-byte equality across representations** (and deflate is not even byte-stable across runtimes per codec-arch's two-tier rule). Every payload read in the compare must go *through* the codec boundary (`fromDriver`/`restoreText`); a raw SQL SELECT on `event.data` returns frames (BLOB) on sealed rows and would report false divergence. This is another reason the import guard matters: no `core/event/sql` outside `store*.ts` means no raw framed reads by construction. The legacy leg of the suite must tolerate **both** TEXT and OCDB-framed legacy rows, and the OCDB decoder stays alive forever (reverse export + differential) even after the fork sealer is retired — frames written pre-cutover remain readable indefinitely.

---

## 5. Preserving the atomic write boundary

[VERIFIED] Today the durable publish path is: one `BEGIN IMMEDIATE` → read seq → check → encode → projectors (message/part/session/search_text writes) → commit hook → sequence upsert → event insert → COMMIT; then pubsub notify + SSE fan-out after commit. `EventV2Bridge` additionally attaches `location` and emits the `sync` event on the global bus post-commit (`event-v2-bridge.ts:35-62`).

Contract constraints for OSES:

- **No compression of a shared segment inside this transaction.** The hot-row insert (Tier-A `insert`) writes a direct representation (`raw_len` tracked). The research doc §20.4 policy (small → raw; large → pre-compressed independent frame or jumbo singleton, benchmark-gated) is fine as long as the bytes are ready *before* the transaction. Sealing is a separate, non-overlapping maintenance path.
- **The projector work must stay inside the transaction.** Projectors write `message`/`part`/`session` (V1) and `session_message`/`session_input`/`session_context_epoch` (V2) plus `search_text` FTS columns. If OPCL compresses projection payloads, the encode happens inside the same transaction today (`projector.ts` runs within `commitDurableEvent`). OPCL encoding cost therefore contributes to the write critical section — this is the constraint that forces thresholded OPCL (skip tiny rows; compress large rows with a fast codec) and is a core benchmark input (§14).
- **Post-commit fan-out stays on logical events.** SSE consumers (renderer `apply()` in `server-session.ts`) and the workspace sync SSE path (`workspace.ts: connectSSE`) consume *decoded logical events*, never raw rows. Unchanged.

---

## 6. Sync/replay & the cross-aggregate ordering problem (detailed)

### 6.1 What the legacy behavior actually is

[VERIFIED] Legacy `sync/history` = `SELECT * FROM event WHERE <exclude> ORDER BY seq ASC` over a rowid table. Order = `seq ASC`, ties broken by rowid = **global append order**. Because `event` is a rowid table and rows are never reordered, this is deterministic per-database-state: replaying the same event sequence twice yields the same array; appending an event after a query point cannot retroactively reorder earlier ties (a later row has a larger rowid, so it sorts after any same-seq earlier row).

There is one subtlety: `remove` (hard delete) deletes rows; deleted rowids are *not* reused (no `AUTOINCREMENT`, but SQLite does not reuse the *last* rowid... actually it can reuse rowids after the max row is deleted without AUTOINCREMENT — e.g. delete the highest-rowid row, then insert reuses it). In practice events are only deleted via aggregate hard delete, and the sync client excludes known aggregates, so this edge is latent. The adapter should not rely on rowid-reuse behavior either way; it should maintain its **own explicit global append ordinal** (see below), which also survives OSES sealing.

### 6.2 The contract for the storage-neutral iterator

[PROPOSED] Define the sync-history ordering as a *documented two-key contract*:

```
order = (seq ASC, global_append_ordinal ASC)
```

- Legacy store: `global_append_ordinal` = event rowid (with the caveat above, which the differential tests must cover by including a hard-delete-then-recreate case).
- OSES store (per oses-arch's design, oses.md §9.4): **the hot tail IS the existing `event` table** (no `event_hot` rewrite), so the ordinal for hot rows is simply the existing `event.rowid` — no new column on the write path. Sealed segments carry **per-segment base + per-event uvarint rowid deltas** captured at seal read time; the iterator reconstructs ordinals for every sealed event so a same-`seq` tie between a sealed event and another aggregate's hot row orders correctly. The cross-aggregate iterator is a k-way merge over per-aggregate ordered runs on `(seq, ordinal)`, streaming in pages with `limit + 1` / `hasMore` semantics preserved.
- The merge must stream (bounded memory) rather than materialize the whole table: the sync payload can be large; the iterator yields `StoredEvent[]` in pages.

**Why not invent a better global order?** The research doc says "preserve the current deterministic behavior exactly as tested." Agreed — because the *client* (workspace sync loop) already tolerates any cross-aggregate order (it replays per aggregate through `replayAll`, which validates within-aggregate contiguity only). Changing the order would break golden tests for zero product benefit. The only defensible improvement is *documenting* the tie-break so the OSES iterator and the legacy iterator are provably identical.

### 6.3 Golden/differential test obligations

[PROPOSED] The migration gate (§11) must include:
- `sync/history` golden runs on a fixture with ≥3 aggregates interleaved so `seq` ties are dense, plus one hard-deleted aggregate to pin the ordinal-reuse edge.
- Differential fuzz: identical random interleaved publishes through legacy vs OSES adapters; assert byte-identical `/sync/history` output arrays (id, aggregate_id, seq, type, data deep-equal) and identical `hasMore`/page boundaries.
- The existing `core/test/*.test.ts` EventTable assertions stay green against `store-legacy` unchanged, then are parameterized over both stores.

---

## 7. Streaming deltas & the codec boundary (confirmed + contract)

[VERIFIED, §1.2] Token deltas are non-durable, in-memory pubsub → SSE, never `EventTable`, never the projection DB. Therefore:

- **There is no per-token durable compression, and there must never be one.** OPCL/OSES design must not add a delta-accumulation table for streaming text; the renderer already accumulates (`part_text_accum_delta`) and reconciles against the durable `message.part.updated`.
- **The codec boundary stays out of the delta path by construction**: deltas carry `{field, delta}` strings through the SSE pipeline untouched (they are not JSON-encoded payloads that need the codec). The only codec-touching writes in an active turn are the durable `PartUpdated` frames at part start/end + state transitions — which is exactly the low-frequency write pattern OPCL is designed for.
- **Streaming response compression is an HTTP-layer concern, already decided**: `compression.ts` excludes streaming paths. Keep it that way — do not "help" by compressing SSE frames; it would add latency and break `text/event-stream` semantics.
- [PROPOSED] One contract addition: the durable `PartUpdated` that closes a streamed part must be written *with the final accumulated text*, atomically replacing the start frame, exactly as today. OPCL re-encoding of that part happens at that write; the *renderer* continues to see the delta path until the durable update lands. No change to the SSE event shape (`message.part.delta` / `message.part.updated` payloads) is permitted.

---

## 8. Large tool results & compacted-but-retained output

[VERIFIED] `compaction.ts`:
- `prune` (lines 273-317) walks backward, and for old completed tool parts sets `part.state.time.compacted = Date.now()` then `session.updatePart(part)` — a durable `PartUpdated`. The **stored part retains the full `state.output`**; compaction only marks it.
- Model-context serialization then *omits/truncates* it: `toModelMessagesEffect` renders `"[Old tool result content cleared]"` when `part.state.time.compacted` is set (`message-v2.ts:293-296`) and `truncateToolOutput` truncates long outputs for context (`compaction.ts:51-52`, `message-v2.ts:49-53`).

So: **compacted tool output is a "cold-but-retained" payload — perfect compression target, and not eligible for deletion.** Three contract points:

1. **Hydration shape is already OPCL-friendly.** The page/hydrate path (`MessageV2.hydrate`) decodes exactly the rows it returns; a compacted 1 MB tool result is decoded only when the user actually opens that message — bounded amplification. OPCL independent-row framing is sufficient; no shared-chunk scheme (rejected by the research doc) and no eager decode.
2. **The `search_text` column must keep the *searchable* (typically truncated/derived) text, not the raw megabyte.** [VERIFIED] `partSearchText(part)` is computed at write time inside the projector (`projector.ts:338,342`) and FTS triggers consume it; search never decodes payloads. Contract: routing/search projections never depend on decoding OPCL BLOBs. (This is opcl-arch's projection-lane detail; the contract here is that search stays a write-time projection.)
3. **Externalization is a later, measured decision** (§9). For the first cut, compacted tool output stays in the row (OPCL) and its durable history stays in OSES frames (jumbo-singleton rules per research doc §24.7). The `time.compacted` flag is *not* a GC license — the research doc §1.9/24.6 rejection of archive-as-GC applies equally to compacted-as-GC: revert/import/repair and the workspace-warp export (§E9) still read history.

**OPCL framing sufficiency verdict:** yes for the projection side, *provided* the write-time thresholds benchmark a 1 MB tool-result row (encode cost inside the write txn, decode p99 on first open, WAL growth). The research doc's §11.3 "large tool results are the most important active-turn codec benchmark class" is endorsed; the corpus must include compacted-large-output sessions specifically (§14).

---

## 9. The file-backed Storage service — reconciliation

[VERIFIED] `../../../../packages/opencode/src/storage/storage.ts`:
- File-backed JSON key-value store rooted at `Global.Path.data/storage`; key → `<dir>/<key...>.json`; `read/update/write/remove/list` with a per-file `TxReentrantLock` (`RcMap`) and a `migration` marker.
- Consumers today: `SessionRevert` writes `session_diff/<sessionID>.json` (`revert.ts:77`), session summary diffs, `Storage.migration.1/2` legacy-file migration (root/session/message/part JSON trees from the pre-SQLite era), and plan files (`session.plan`).
- **Not transactional with SQLite, not content-addressed, no reference counting, no manifest.** A crash between "event commit" and "Storage write" leaves divergent state; backup is "copy the tree".

Reconciliation contract (PROPOSED):

1. **Storage stays exactly where it is for its current consumers.** Session diffs, plans, snapshots are *product artifacts*, not canonical storage-engine payloads. Do not migrate them into OSES/OPCL — they are already outside the storage redesign's blast radius and forcing them in adds migration risk for zero storage win.
2. **Storage is NOT the OSES segment store.** OSES segments live in SQLite (`event_segment`/`event_segment_blob`) for the first production design (research doc §20.17). This keeps backup/restore single-resource and crash-atomic.
3. **Large-object externalization is deferred behind a measured gate** — exact-duplicate rate and size distribution of large tool outputs, *across* projection rows, durable events, and any Storage artifacts. If justified, the design must be one of the research doc §19.5 options, not an ad-hoc third store:
   - (a) transactional SQLite content objects (`object` + `object_ref` with FK/reference-count GC), or
   - (b) extending Storage into a crash-safe content-addressed object store with a **transactional manifest protocol coordinated with SQLite** (object creation durable *before* any event referencing it commits; no event may reference a missing object after crash; ref/GC correctness; manifest-aware backup; reverse-export back to inline data).
4. **Missing guarantees today (if (b) is ever pursued):** write-before-event ordering, reference counting, tombstone/GC, crash-atomic manifest, backup consistency with the DB. The contract explicitly forbids a pointer-in-event-format design until all five exist (research doc §F.15).

---

## 10. Desktop/Electron & cross-runtime contract

[VERIFIED §1.7] Production V1 desktop server = Node 24.15 in an Electron utility process (`node:sqlite`, one-permit semaphore); standalone CLI = Bun (`bun:sqlite`); WSL path = Bun in WSL with its own data tree; `OPENCODE_SIDECAR_V2=1` desktop = staged Bun CLI. All can legitimately open the same `opencode.db` in various product modes.

Contract (PROPOSED):

1. **On-disk format is runtime-independent.** Every OPCL envelope and OSES segment/ID/dictionary vector is byte-defined by format version + codec ID + dictionary ID; Node-written rows must decode identically in Bun and vice versa. Golden vectors are a release gate (research doc §31.1), and this document adds: **golden vectors must be executed in the *packaged* Electron utility-process runtime, not just a dev Node** — the packaged runtime is the compatibility target.
2. **Writers must not emit codecs the other supported runtime cannot decode.** Zstd (Node 24.15: Stability 1/Experimental) is emission-gated: a writer must resolve *both* runtimes' capability before choosing a codec for a shared DB, and default to the stable codec. The research doc §27 matrix is endorsed. Cross-referencing codec-arch's measured beliefs (hive):
   - **Deflate is interoperable-but-not-byte-identical** across runtimes (embedded zlib version skew) — exclude deflate from byte-golden fixtures; assert logical equality only.
   - **Brotli q1/q4 and dict-less zstd l1/l9 are byte-identical** across Bun 1.3.14 and Node — brotli q1 is the correct byte-stable baseline (which is also the fork's OCDB v2 default, a happy coincidence to preserve).
   - **Zstd + dictionary is broken on Bun** (silently ignored on compress; corrupt on decode) — trained/shared zstd dictionaries must never be mandatory; they are capability-probe-gated, and emission policy = intersection of capabilities across all shipped runtimes.
3. **Cross-process write gating.** SQLite WAL + `busy_timeout` handles concurrent DB access between the sidecar and a CLI. The new constraints are maintenance paths:
   - **Sealing (OSES) and dictionary/epoch maintenance are single-writer operations.** Gate them to one process at a time (a maintenance lease row/`storage_epoch` + `generation` verify inside the seal txn — research doc §20.13) so a CLI and a sidecar cannot seal the same prefix concurrently. **Recommended default: only the V1 server sidecar performs sealing; CLI reads+appends hot rows only**, with the lease mechanism as the escape hatch for CLI-initiated maintenance (e.g. `opencode db vacuum`-style commands).
   - **`opencode db` raw SQL + external `sqlite3` keep full read access to routing/metadata columns but lose payload readability on BLOB rows.** This is a diagnosability regression to acknowledge and document (research doc §5.5 matrix row), not a contract change. The routing plane (native columns) is the supported SQL surface.
4. **Which runtime writes what — explicit ownership table:**

| Operation | Desktop V1 sidecar (Node) | Standalone CLI (Bun) | Contract |
|---|---|---|---|
| Hot event append (via adapter) | yes | yes | identical format emission |
| Projection writes (message/part/session) | yes | yes | identical encode |
| OPCL compression decision | yes | yes | identical policy + codec IDs |
| OSES sealing / shadow build | **primary owner** | only via maintenance lease | single-writer, `generation`-verified |
| Dictionary training/install | one-time release artifact | one-time release artifact | immutable ID + digest; never trained on private payloads |
| Reverse export / epoch rollback | yes | yes | migration-arch's lane, must work in both |

5. **The `OPENCODE_SIDECAR_V2` path must read (not write) the new format** without migrating V1 behavior onto V2 (research doc §5.2): V2 staging reads a shared state home and can encounter OSES/OPCL data — its decoder set is a subset, never a writer.

---

## 11. Feature gates & rollout sequencing

[VERIFIED] The `enabledByExperimental(name)` pattern (`runtime-flags.ts:11-14`) gives per-feature toggles plus an `OPENCODE_EXPERIMENTAL` master. Storage gates follow the same shape, **never all-on at once**, with explicit dependency ordering:

| Gate (env, PROPOSED) | Depends on | Unlocks | Reversible |
|---|---|---|---|
| `OPENCODE_STORAGE_READ_OSES` | — | read hot+sealed through the OSES adapter (writes still legacy) | yes (no data touched) |
| `OPENCODE_STORAGE_SHADOW_OSES` | READ_OSES | build/verify shadow segments (legacy authoritative) | yes |
| `OPENCODE_STORAGE_WRITE_HOT_OSES` | READ_OSES + shadow verified | new events append to `event_hot` | yes (stop appending; legacy readable) |
| `OPENCODE_STORAGE_SEAL_OSES` | WRITE_HOT | background sealing + startup catch-up | yes (seal pauses; hot grows) |
| `OPENCODE_STORAGE_EPOCH_OSES` | SEAL + differential gate | `storage_epoch` cutover; reverse export enabled | **requires reverse export** (migration-arch) |
| `OPENCODE_STORAGE_DICTIONARY` | codec gate | trained/structural dictionary emission | yes (new frames only) |
| `OPENCODE_STORAGE_ID_LOCATOR_FINGERPRINT` | READ_OSES | Tier-B locator (exact-verify) | yes (rebuild) |
| `OPENCODE_STORAGE_OPCL_WRITE` | projection routing columns live + JSON deps migrated | compress `message.data`/`part.data` | yes (stop writing BLOBs; decode remains) |
| `OPENCODE_STORAGE_LARGE_OBJECT_DEDUP` | measured duplicate gate | content-addressed externalization | yes |
| `OPENCODE_STORAGE_HISTORY_GC` | product replay/checkpoint proof | prune pre-checkpoint events | **no — semantic change** |

**Product-visible ordering rule:** the desktop app flips gates in lockstep with the canary release channel; `OPENCODE_EXPERIMENTAL` users get read-only gates first (opt-in shadow), and default-on requires the benchmark gates (§14). The runtime flags live in `RuntimeFlags` (which the desktop sidecar and CLI both load) so the two runtimes agree on the active gate set — no gate asymmetry between Node and Bun writers.

[PROPOSED] Also expose a diagnostic `pause storage maintenance` control (research doc §32.3) as a runtime flag (`OPENCODE_STORAGE_PAUSE_MAINTENANCE`) honored by the sealer in both runtimes.

---

## 12. Challenging the "does V1 really need zero change?" assumption

**Public wire contract: zero change, and that is enforceable** — see §3.3's import guard + the fact that no handler imports event tables today.

**Internal seams that MUST change (the honest answer):**

1. `sync.ts` + `workspace.ts` stop importing `@opencode-ai/core/event/sql` (§2). This is a code move, not an API change.
2. `EventV2` read helpers stop being free functions on `db`; they become adapter methods. Internal API change within `core`, invisible to handlers.
3. Live SQL JSON dependencies (`usage.ts`, `fork/credentials.ts`, `search.ts`, `idx_message_provider_id`) migrate to native routing columns *before* OPCL writes. This is the sharpest hidden dependency — a fork-specific index the research doc noted but the *live query paths* make it a hard gate, not a cleanup.
4. `opencode db` / external `sqlite3` payload readability degrades for BLOB rows (documented, supported via routing plane).

**Where the seam still leaks even after the adapter exists:** any code that takes `Database.Service` can still run arbitrary SQL against `event_hot`/`event_segment`. That's acceptable (it's a local DB with an intentional `db` command), but the *supported* path is the adapter. The import guard is the boundary; raw SQL is an escape hatch that must not appear in product code.

**The one place I'd push back on "preserve exactly":** the implicit rowid tie-break in `/sync/history` ordering. We preserve it *behaviorally* (via the explicit global-append-ordinal) but we should document it as a contract instead of leaving it implicit — "preserve exactly as tested" + "document the tie-break" is strictly better than either alone, because it makes the OSES iterator *provably* equivalent rather than accidentally.

---

## 12a. Desktop lifecycle & the Stage C catch-up window (response to migration-arch's open question)

migration-arch asked whether Stage C catch-up can run in a startup/shutdown idle window on desktop, or needs a mid-run fence. Contract answer:

[VERIFIED] The desktop V1 server is a **long-lived Electron utility process** (`packages/desktop/src/main/server.ts:57-69` forks sidecar; `sidecar.ts` starts the server once). There is no dependable "shutdown idle window": app quit kills the sidecar, and relaunch latency is user-visible.

[PROPOSED] **Stage C runs at server boot, before the HTTP listener starts**, guarded by migration-arch's single-row epoch UPDATE (`WHERE value='legacy'`) + `PRAGMA user_version` mirror + WAL write-lock. Rationale:

- Because Stage B keeps shadow history current with a safety margin, Stage C catch-up is bounded to events published since the last shadow pass — small for a live DB. The ≤25k-events/256MiB synchronous-conversion path (migration-arch's size gate) covers the rare cold-boot-on-huge-DB case inside the startup budget, mirroring how the fork already tolerates startup migration + search backfill work.
- A mid-run fence would have to drain in-flight prompt loops and reject all new publishes through `EventV2` for the whole sidecar — a product-visible freeze and a larger contract surface. Rejected as the default; it remains an option only for the multi-GB tail where shadow lag is unacceptable, and only behind an explicit maintenance gate.
- The fence must also win against a concurrently-running CLI (`opencode db` / a second session): an app-level fence is insufficient — the guarded epoch UPDATE + WAL write-lock is what actually excludes other writers.
- **Startup-latency budget is a hard gate**: catch-up must fit the app's load-to-ready budget (benchmark §14); if not, the shadow protocol runs longer pre-cutover rather than blocking boot.
- **Codec capability probe runs in the same boot window (codec-arch tie-in — adopted):** the writer-policy intersection across all shipped runtimes (Node 24.15 Electron + Bun standalone; zstd-dict gate per boot, never assumed) must be established **before the first post-cutover write**, so the first OSES/OPCL frame emitted already respects the intersection. The probe is a prerequisite step of Stage C, ordered ahead of the epoch flip.

---

## 13. Open questions

1. **Global-append-ordinal lifecycle — RESOLVED (oses-arch, oses.md §9.4):** **per-segment base + per-event positive uvarint deltas** over the `event` rowid, captured at seal read time (base u64 in the segment fixed header; `uvarint(rowid_i − rowid_{i−1})` per event, ~2–5 B). Rejected: per-event u64 (2 KiB/segment index) and a new write-path append-ordinal column (hot-path change). The cross-aggregate iterator is a k-way merge on `(seq, ordinal)` with watermarks + limit preserved — exactly the two-key contract in §6.2. **The one thing the merge must retain:** the ordinal stream must be reconstructed for *every* sealed event (not just segment heads) so a same-`seq` tie between a sealed event and another aggregate's hot row orders correctly — the delta stream provides this; the frame index must expose per-event ordinals to the iterator.
2. **`sync/history` payload size:** today it can return the entire event table in one response. With OSES, does the iterator stream pages over HTTP, or does the sync loop keep the full-array shape? The client (`workspace.ts` sync loop) currently receives `HistoryEvent[]` whole; changing to streaming is a client contract change — is that acceptable under "zero change" or does the iterator just materialize? (Recommend: keep the array shape for v1 of the contract; add `after`/`limit` pagination as a *separate, additive* endpoint if the benchmark shows materialization is pathological.)
3. **CLI-initiated sealing:** is the maintenance lease (one sealer per DB) enough, or should the CLI be permanently excluded from sealing and forced to a read-only maintenance role? This decides how much lease machinery ships.
4. **Where does `search_text` live for OPCL?** The fork's `part.search_text`/`part_fts` are populated at write time from the *decoded* part. If OPCL compresses `part.data`, the write path must compute search text *before* encoding — confirm the projector's decode→encode sequence preserves this (opcl-arch + projector lane).
5. **Is `data` ever read back via `sqlite`-level JSON by anything we missed?** The grep covered `packages/core|opencode|app`; a fork-specific plugin or the `opencode db` command surface could still assume TEXT. Requires a final live-schema scan (research doc §Appendix E) at migration time.

---

## 14. Must-benchmark (contract-specific additions to the research doc's §29 list)

1. **Adapter hot-insert regression:** legacy row insert vs OSES hot insert inside `commitDurableEvent` (p95/p99 of the *transaction*, incl. projector + OPCL encode when enabled) — the research doc gate (≤5%) is endorsed; measure on the packaged Electron runtime.
2. **`sync/history` equivalence & cost:** legacy vs OSES iterator on an interleaved multi-aggregate fixture — output array byte-identity *and* p95 for full-history responses; drives the §13.2 streaming decision.
3. **Large tool-result OPCL row:** 100 KB–5 MB tool outputs — encode-in-txn cost, first-open decode p99, WAL delta, vs. raw TEXT. Plus the compacted-but-retained read path (cold open of an old message with a 1 MB retained output).
4. **Cross-runtime golden vectors in the packaged runtime:** encode Node→decode Bun and reverse for every shipped (format, codec, dictionary) vector, executed against the *packaged* Electron utility process and the compiled CLI.
5. **Event-ID packing throughput:** packed-ID round-trip (canonical + `descending()`-variant + noncanonical escape) on 100k events — the 48-bit opaque value must round-trip exactly; measure encode/decode p99 inside the seal path.
6. **Global-ordinal overhead:** cost of maintaining the append-ordinal column/stream on hot writes and segment headers; confirms the per-segment-base assumption or forces per-event ordinals.
7. **Fingerprint locator vs exact registry** on a large ID set (research doc §29.7) — the contract requires exactness either way; benchmark only decides index bytes vs lookup latency.
8. **Sealer concurrency vs CLI:** two processes (sidecar + CLI) with the maintenance lease — no lost events, no overlapping segments, WAL/checkpoint behavior (research doc §31.6/31.7).
9. **Projection tail distribution (opcl-arch's gating measurement, cross-referenced):** real `part.data` % rows/bytes ≥ 4096 chars per `part_type`, and whether `message.data` ever exceeds 4 KiB in production. If the part tail is dominated by large tool outputs, OPCL-on-projection is a *tail play* and message sealing may be a declared no-op — this shapes how much of the write critical section the codec touches (§5).

---

## 15. Alternatives considered (beyond the research doc's §33)

1. **Gate `sync/history` behind the adapter but keep `EventV2` as-is.** Rejected: `readAggregate`/`readAfter`/`commitDurableEvent` would still bind to the legacy table, so OSES couldn't swap the read side without touching `event.ts` anyway. The adapter has to own both tiers.
2. **A "read model" service (`SyncHistory.Service`) instead of a generic adapter.** Attractive for the ordering problem specifically, but it duplicates the merge logic (workspace warp needs per-aggregate, sync needs cross-aggregate); a single iterator with a per-aggregate filter is simpler and both callers share it.
3. **Normalize the global ordering by adding a real global `gseq` column.** Cleaner conceptually, but changes `/sync/history` output (a new column) and rewrites replay semantics for zero product benefit; rejected in favor of the documented two-key contract.
4. **Move revert/plan Storage artifacts into the adapter.** Rejected (§9.1): orthogonal product data, no storage win, extra migration.
5. **Let OPCL encode only `part.data`, not `message.data`.** Viable cost-cut for the first OPCL cut (message rows are small and normalized already — research doc §13.6 median 407 B); keep `message.data` raw until the projection corpus justifies it. Endorsed as a Phase-4 sequencing option.

---

## 16. Headline recommendations (summary)

1. **Create `core/src/event/store.ts` with the two-tier adapter** (Tier-A transactional row gateway + Tier-B read API) and two implementations (legacy, OSES). Reimplement `EventV2` on it, moving all replay/divergence/uniqueness/sequence policy into store-independent orchestration. Enforce with an **import guard banning `core/event/sql` imports outside `store*.ts`**.
2. **Route E8/E9 (`sync/history`, workspace `sessionWarp`) through the adapter and define the documented two-key sync order `(seq ASC, global_append_ordinal ASC)`**, with the ordinal carried into sealed segments — preserving legacy behavior exactly *and* making it provable.
3. **Treat live SQL JSON dependencies (`usage.ts`, `fork/credentials.ts`, `search.ts`, `idx_message_provider_id`) as a hard OPCL precondition**, migrating to native routing columns before any BLOB write; never let search/FTS depend on decoding payloads.
4. **Keep token deltas non-durable and out of the codec path** (confirmed current design — codify it as a contract), and keep HTTP streaming paths compression-exempt as today.
5. **Reconcile Storage explicitly**: it remains the product-artifact store (diffs/plans/snapshots); it is *not* the OSES segment store; large-object externalization waits on a measured duplicate gate and then uses only a SQLite-manifest or extended-Storage design with full transactional guarantees.
6. **Gate everything per the §11 matrix**, default-on only after the §14 benchmarks pass on the *packaged* Electron runtime, with single-writer sealing (sidecar primary, CLI via lease).
7. **Zero V1 public contract change is real and enforceable** — the four internal seams (§12) are the actual work.

---

## 17. Research-doc corrections vs the openfork tree

0. **The fork already ships a ChunkDB prototype slice for `event.data` — the research doc (written against pristine v1.18.18) omits it entirely.** `json-codec.ts` (OCDB frame v2, identity `toDriver` + fail-closed `fromDriver`) and `chunk-sealer.ts` (background cold-row sealer, `ocdb_seal` journal, ≥4096-char threshold, dormant-session eligibility) plus `bench/chunkdb-*.ts`. Consequences: (a) fork-produced DBs may contain framed `event.data` rows that the *live* `text({mode:"json"})` schema cannot read — the legacy adapter and any export/backfill must decode frames (or migrate them to TEXT first); (b) OSES sealing subsumes the fork sealer — it must be disabled before cutover so two background sealers never race; (c) the `compressedJson` codec is a useful OPCL reference and its identity-`toDriver`+background-sealer split validates the research doc's hot/cold separation. migration-arch independently flagged (a) for backfill — corroborated here.

1. **Live JSON deps are worse than stated.** §21.4 of the research doc notes "the supplied fork has an index using `json_extract(data,'$.providerID')`." The openfork tree also has **live query paths** (`session/usage.ts`, `fork/credentials.ts`, `session/search.ts`) doing `json_extract` on `message.data`; any OPCL write without routing-column migration breaks usage reporting and fork-credential backfill, not just one index.
2. **The sync ordering tie-break is identified.** §23.9 says "cross-aggregate global seq values are not globally unique/order-defining… preserve current deterministic behavior exactly as tested." This document pinpoints the deterministic mechanism (rowid = global append order on the plain rowid `event` table) and converts it into the explicit `(seq, append-ordinal)` contract with an OSES field requirement.
3. **Event-ID packing nuance.** §1.5/§22.5 assumes a plain monotonic clock; `identifier.ts` shows the 48-bit value may be bitwise-NOTed (`descending()`), so the packer must treat it opaquely and reproduce the exact hex string — a correctness detail the research doc's algorithm would get wrong for descending IDs.
4. **`part.search_text`/`part_fts` + `session_message.search_text`/`session_message_fts` are fork additions with write-path coupling** (research doc §13.1 notes them as fork schema; this document adds that they are populated inside the projector's transactional write and thus must be computed pre-encode for OPCL — a sequencing constraint).
5. **The V1 handler surface is confirmed exactly as claimed** (research doc §6) — `session.ts` handlers call `session.messages`/`MessageV2.page/get`; no correction, but the adapter plan now makes that statement *enforceable* via the import guard rather than by convention.
6. **Cross-runtime codec parity is sharper than the research doc's Zstd-only caution** (per codec-arch's measured beliefs): deflate is *not* byte-identical across runtimes (zlib version skew), brotli q1/q4 and dict-less zstd are byte-identical. The byte-golden-vector gate (§10) must therefore use brotli (or dict-less zstd) as the byte-stable baseline and treat deflate as logical-equality-only — a correction to research doc §17.2/§22.2 which lists raw DEFLATE as the stable baseline candidate.
