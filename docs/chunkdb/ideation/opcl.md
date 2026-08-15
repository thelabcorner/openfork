# OPCL: OpenCode Payload Codec Layer — message/part projection ideation

**Author:** opcl-arch · **Branch:** `openfork` (v1.18.18 + fork changes) · **Status:** ideation, no implementation
**Scope:** current-state `message` / `part` projections (V1 tables), the routing-plane normalization that must precede any compressed payload BLOB, and how OPCL BLOBs coexist with legacy `TEXT` rows. Durable-event storage is `oses-arch`'s lane; the existing fork event sealer is treated as *shipped precedent*, not new work.

---

## 0. Headline recommendations (TL;DR)

1. **Do not invent a second envelope. Reuse the fork's shipped OCDB frame v2** (`packages/core/src/database/json-codec.ts`) for `message.data` and `part.data`. It already has the exact properties the research doc's "OPCL v1" spec wants — magic/version/codec/raw-length/CRC32, fail-closed decode, cross-runtime golden bytes — plus a proven background-sealer write model (`chunk-sealer.ts`). One frame format, three payload columns, one decoder corpus.
2. **The message routing plane needs exactly three new native columns: `role`, `provider_id`, `cost`.** These are the fields with *live* SQL consumers today (verified: `SessionUsage`, `ForkCredentials`, `SessionSearch`). Reuse the already-native `time_created` for the `time.created` filters — no new column. **Defer `model_id` and all five `tokens_*` message columns** — no live query reads them (the tokens backfill was a one-time migration).
3. **`part.data` is already BLOB-ready.** It has **zero** SQL `json_extract` consumers; the only SQL-touched part columns are `id`, `message_id`, `session_id`, `time_created`, and the fork's native `search_text`. Part sealing does not depend on any routing migration. This is the cheapest first win and the research doc missed it.
4. **Threshold stays at 4096 UTF-16 code units, and the honest framing is that OPCL on projections is a *tail* play, not a *median* play.** Reference-DB medians are `message.data` ≈ 407 B and `part.data` ≈ 29 B; nearly every row stays raw `TEXT`. The byte volume worth compressing is the long tail: large tool outputs (which compaction **never** removes — verified), big text/reasoning parts, patch parts. The routing plane is mandatory regardless: it is the *enabler* for BLOBs and it speeds up the fork's usage queries.
5. **Mutation policy: identity writes + cold-only sealing, exactly like the shipped event sealer.** The codec is **not** re-encoded on each durable update. The projector keeps writing plain JSON `TEXT` (identity `toDriver`); a background sealer frames cold rows only. A sealed row that gets updated (e.g. compaction `prune` marks `state.time.compacted`) reverts to `TEXT` and is re-sealed later — acceptable, and the only place a per-table policy decision is needed (see §7).
6. **Provider expression index migration order is mandatory and the failure mode is silent NULLs, not errors.** SQLite `json_extract(blob, ...)` returns `NULL`, so any query still reading `message.data` JSON *silently* undercounts usage once rows are framed. The research doc's §21.4 order is correct; this doc adds the two consumers the doc missed (`search.ts`'s role lookup and the migration backfill) and the fork's own sealer-journal pattern for the backfill.

---

## 1. Ground truth: what the openfork codebase actually does

### 1.1 Current schema (`packages/core/src/session/sql.ts`)

```ts
MessageTable: id, session_id, time_created, time_updated, data (TEXT json)
PartTable:    id, message_id, session_id, time_created, time_updated,
              data (TEXT json), search_text TEXT NOT NULL DEFAULT ""   // fork addition
SessionMessageTable: id, session_id, type, seq, time_*, data (TEXT json),
              search_text TEXT NOT NULL DEFAULT ""                      // fork addition
```

The fork additions are exactly: `search_text` on `part` and `session_message`, the FTS5 virtual tables + `AFTER INSERT/UPDATE/DELETE` triggers, two resumable backfill cursors (`part_search_backfill`, `search_backfill`), and the `idx_message_provider_id` expression index created ad-hoc by `SessionUsage`.

### 1.2 Every SQL-level JSON dependency on `message.data` (complete inventory)

| # | Consumer | JSON fields | Why it blocks BLOBs |
|---|---|---|---|
| 1 | `packages/core/src/session/usage.ts` — `SessionUsage.rows()` / `.windows()` (live, per-request) | `$.providerID` (WHERE + **expression index** `idx_message_provider_id`), `$.role` (WHERE `= 'assistant'`), `$.cost` (SELECT/SUM), `$.time.created` (WHERE `>=`, MIN) | hard blocker |
| 2 | `packages/opencode/src/fork/credentials.ts` — backfill + `usageByCredential` (live) | `$.providerID`, `$.role`, `$.time.created` (COALESCE), `$.cost` (SUM in window CASE columns) | hard blocker |
| 3 | `packages/core/src/session/search.ts` — V1 part path (live) | `json_extract(m.data, '$.role')` to classify part matches as user/assistant | hard blocker (doc's §21.5 missed this) |
| 4 | `packages/core/src/database/migration/20260510033149_session_usage.ts` (one-time) | `$.cost`, `$.tokens.input/output/reasoning/cache.read/cache.write`, `$.role` | soft — already applied; only matters for fresh DBs and for backfill correctness |

**No other `json_extract`/`json_each` exists in `packages/core` or `packages/opencode` on these tables** (grep verified). `session_message.data` is not JSON-read anywhere either.

**`part.data` JSON dependencies: none.** The only SQL reads of part rows are by `id`/`message_id`/`session_id` + ORM hydration (`message-v2.ts` `hydrate`/`parts`/`get`, `session.ts` `getPart`) and the search backfill which decodes in JS. Conclusion: part.data can be framed with **zero** routing work.

### 1.3 The fork already shipped a frame codec for `event.data`

`packages/core/src/database/json-codec.ts` + `chunk-sealer.ts`:

- Frame v2 header: `"OCDB"` (4 B) · version (1 B) · codec (1 B: 1=zstd, 2=brotli, 3=deflate) · rawLen u32 LE (4 B) · CRC32-of-raw u32 LE (4 B) = **14 B**. v1 frames (10 B, no CRC) still decode.
- `toDriver` is **identity** (`JSON.stringify` only) — hot writes are byte-identical to today's `text({mode:"json"})`.
- A background sealer (`ChunkSealer.runPass`) frames cold rows only: `typeof(data)='text' AND length(data)>=4096`, session `time_updated` cooled ≥ 48 h, batch 128 / 5000 per pass, one short transaction per row (UPDATE + `ocdb_seal` journal UPSERT), partial candidate index `idx_event_seal_candidates`.
- `ocdb_seal` journal is keyed `(table_name, row_id)` — **already shaped for multi-table use**. A restore path (`restoreText`) and a read-path bench (`bench/chunkdb-readpath.ts`) exist and assert `message.data`/`part.data` are currently untouched TEXT.

### 1.4 Write paths and mutation semantics (verified)

- The **projector** (`packages/core/src/session/projector.ts`) is the single durable write point for V1 message/part rows. `MessageUpdated` → `INSERT ... ON CONFLICT(id) DO UPDATE SET data` (note: the conflict branch sets only `data`). `PartUpdated` → upsert setting `data` + `search_text` (`partSearchText`).
- Parts transition `pending → running → completed` via **full-part `PartUpdated` events** (`processor.ts` `ensureToolCall`/`updateToolCall`/`completeToolCall`/`failToolCall`), each a durable rewrite of the whole part row. Text/reasoning stream via `updatePartDelta`, which publishes a `PartDelta` event that has **no durable V1 projection** — the part table is only written at `text-end`. Token deltas are therefore not durable, matching research doc §11.2.
- Compaction `prune` (compaction.ts) sets `state.time.compacted` and calls `updatePart` with the **full output still in `state.output`** — compaction marks but does not delete tool output bytes from storage (matches doc §14.3). This is precisely why the projection tail exists.
- CLI `import.ts` and a few tests write `PartTable.data`/`MessageTable.data` directly as TEXT (identity-compatible).
- FTS is fully decoupled: `part_fts`/`session_message_fts` triggers sync from the **native `search_text` column**, never from `data`. OPCL can never break FTS as long as `search_text` survives.

---

## 2. Routing plane: which fields become native, and why

Rule applied (from the research doc §21.1): *a native column is justified only by actual SQL/query use — filter, join, aggregation, FTS projection, or index — never by JSON existence.*

### 2.1 `message` table

| Column | Type | Verdict | Justification (query evidence) |
|---|---|---|---|
| `role` | TEXT NOT NULL | **ADD** | `usage.ts` WHERE, `credentials.ts` WHERE, `search.ts` part-match typing, migration WHERE. Equality filter, cardinality 2–3. |
| `provider_id` | TEXT | **ADD** | Backs the existing `idx_message_provider_id` expression index; `usage.ts`/`credentials.ts` WHERE. NULL for `role='user'`. |
| `cost` | REAL | **ADD** | `usage.ts` SELECT + window SUM; `credentials.ts` SUM. NULL/0 for non-assistant. |
| `time_created` | — (exists) | **REUSE** | The `$.time.created` filters (`usage.ts`, `credentials.ts`) already have a native twin. Verify equality during backfill; no ALTER needed. |
| `model_id` | TEXT | **DEFER** | **No live SQL consumer.** Research doc §21.1/Appendix A lists it; per its own "do not denormalize" rule it should wait for a query. |
| `tokens_input/output/reasoning/cache_read/cache_write` | INTEGER | **DEFER** | Only the one-time migration reads them from JSON. Session-level `session.tokens_*` already exist and are projector-maintained. |
| `agent`, `mode`, `parent_id`, `finish`, `error`… | — | **STAY IN PAYLOAD** | No SQL use; leave in `data`. |

Proposed indexes (keep minimal):

```sql
CREATE INDEX IF NOT EXISTS idx_message_usage
  ON message (provider_id, role, time_created) WHERE provider_id IS NOT NULL;
```

This replaces `idx_message_provider_id` and serves both `usage.ts` and `credentials.ts` shapes (`provider_id = ? AND role = 'assistant' AND time_created >= ?`). Benchmark vs the current expression index before dropping it (see §10).

### 2.2 `part` table

| Column | Type | Verdict | Justification |
|---|---|---|---|
| `part_type` | TEXT | **ADD (ops/telemetry rationale)** | No query reads it today — but once `part.data` may be a BLOB, `part_type` becomes the **only** SQL-visible discriminator. It is what makes per-type payload-byte accounting (the gating benchmark of §10) and future per-type queries possible *without decoding frames*. It is immutable after part creation (state transitions never change `type`), so it costs nothing to maintain. This is an honest "we need it to measure and operate the feature" justification, not a "future feature" one. |
| `search_text` | — (exists) | **KEEP, never touch** | Already native + trigger-synced. OPCL must never put search text inside the payload. |
| `message_id`, `session_id`, `time_*` | — (exist) | — | Already native; used by pagination/hydration/FK. |

### 2.3 What the research doc got wrong here

- §21.1's message list over-normalizes (`model_id`, five token columns with no live consumers) while **under-listing the actual consumers** — `search.ts`'s `json_extract(m.data,'$.role')` and the fork credential backfill are absent from its consumer map.
- §21.5 claims search is an independent projection. For V1 it is **not**: the search query itself reads `message.data.role` via JSON. The routing plane fixes it, but the doc never says the search path must be rewritten.
- Appendix A's DDL proposes adding `role/provider_id/...` but omits that `time_created` already exists and that the *queries*, not the schema, are what block BLOBs for the time filters.

---

## 3. OPCL envelope format (concrete)

### 3.1 Recommendation: OPCL v1 = OCDB frame v2, unchanged

```text
offset 0   4 B   magic      "OCDB"
offset 4   1 B   version    2
offset 5   1 B   codec      1=zstd  2=brotli  3=raw-deflate
offset 6   4 B   rawLen     decompressed UTF-8 byte length, LE
offset 10  4 B   crc32      CRC32 of decompressed raw bytes, LE
offset 14  n B   payload    compressed JSON UTF-8
```

- **Raw rows are plain `TEXT` — never a "codec 0" frame.** The dual representation is `TEXT | frame-BLOB`; there is no framed-raw case. This is simpler than the research doc §22.1's envelope, which carried `flags`/`dictionary-id`/`payload-length` for cases that never occur.
- **`payload-length` is derivable** (`frame.byteLength - 14`) — the doc's extra field is redundant.
- **`dictionary-id` is the documented extension point, not v1.** Reserve codec IDs 4–7 for dictionary variants and extend the header to 18 B (`+dictID u32`) only when a dictionary proves a post-compression Pareto win. **Cross-runtime facts from `codec-arch`'s ideation (`docs/chunkdb/ideation/codec.md`), measured: brotli q1/q4 and dict-less zstd are byte-identical across Bun/Node; raw deflate is NOT byte-stable (embedded zlib differs) and must be treated as interoperable-only; zstd+dictionary is broken on Bun 1.3.14 (dict silently ignored on compress, Node-written dict frames undecodable) — so **trained zstd dicts cannot ship today**, and a **structural deflate dictionary (schema-only, zero privacy exposure)** is the only cross-runtime-safe dictionary path. Ship-first posture: no dictionary in OPCL v1; if dictionaries are ever added, start with the structural deflate dict and capability-probe every shipped runtime. Never ship a dictionary containing unsanitized user content (doc §17.7 privacy rule).**
- **One magic for all payload columns.** The table is implied by the column; a per-table magic would fragment the golden-vector corpus for no benefit. Existing v1 10-byte frames already in `event.data` decode via the version byte; no re-encode needed.

Rationale for reuse: the fork already has (a) golden cross-runtime behavior exercised by `bench/chunkdb-readpath.ts` on both Bun and Node, (b) fail-closed bounds/CRC/UTF-8 validation, (c) a restore path, (d) an ops journal keyed per-table. Duplicating that as a parallel "OPCL" format would double the decoder-maintenance surface for zero gain.

### 3.2 Envelope sizing vs the doc

Research doc §17.2 modeled a "20-byte OPCL envelope". The shipped frame is 14 B — smaller *and* already implemented. At the 4 KiB threshold, header overhead is ≤0.35% of a sealed row's raw size; it is a non-factor. The doc's "five of nine tiny part rows should remain raw" conclusion is even stronger against a 14 B header, but the fork's 4096 threshold makes the whole median debate moot (§4).

---

## 4. Threshold policy

### 4.1 Keep `THRESHOLD = 4096` UTF-16 code units, with the 24-byte worth-it guard

```ts
// json-codec.ts, unchanged:
if (json.length < THRESHOLD) return json
...
if (payload.byteLength + HEADER + 24 >= raw.byteLength) return json   // only frame if it beats raw
```

Evidence: reference-DB medians are 407 B (`message.data`) and 29 B (`part.data`) (doc §13.6); the fork's own sealer bench tuned 4096 for `event.data`; at 4096 the guard never fires for typical rows and the incompressible tail (e.g. base64-ish content) stays TEXT automatically.

### 4.2 What this means honestly

- **Median parts never seal.** A 29 B part gains nothing and would *grow* with a 14 B header + entropy. Correct outcome — do not lower the threshold to "capture more rows".
- **The projection win is the tail only.** The sealing-yield question is: *how many part rows are ≥ 4 KiB, and what do they weigh?* The reference DB (9 parts) cannot answer this. Until a real multi-session corpus is measured (§10), the projection sealer should be built but **gated** — the plumbing is trivial, the yield is unknown.
- **`message.data` is expected to be a LIVE win, not a no-op (corrected posture, adversary O4).** `message.data` mirrors the last `message.updated` event's `info.summary` — and `summary.diffs` is the corpus byte king (observed up to ~548 KB per summary). A session with N summarized messages duplicates ~N × 548 KB in the projection. Ref-based cross-layer dedup stays NOT-VIABLE (it would couple the projection read path to the event store — readpath §0.2, my §10.9), but **OPCL framing of `message.data` is the right mechanism**: hydrate adds one decompress per row, absorbed by the projection-side decoded working-set cache (readpath §4.4.2). Default posture: **plan for OPCL-on-message**; D1 (≥ 4 KiB share of `message.data` rows/bytes, both units) confirms the magnitude, and the hydrate gate (≤ 5–10% interactive, my §10.4) is the read-side constraint. The earlier "likely a no-op" hypothesis was based on the 7-message reference sample and is superseded by T0 corpus evidence.
- **Measure the gate and the economics in two units.** The sealer's `THRESHOLD=4096` is in **UTF-16 code units** (`length(data)`), while the frame header's `rawLen` and the actual byte economics are **UTF-8 bytes** (`octet_length(data)`). For ASCII-heavy JSON they are ≈ equal; astral-plane content (emoji, CJK in tool output) makes code units *smaller* than bytes, so a row can pass the 4096-code-unit gate yet be a byte-minnow, or vice versa near the edge. The per-type corpus measurement must report **both** columns so the gate and the byte accounting never silently disagree (codec-arch cross-check).
- Do **not** add a per-part-type threshold yet. Wait for the per-type byte distribution; if tool parts dominate the ≥4 KiB population with no other type above it, a single global threshold is already optimal.

### 4.3 Who is excluded from sealing

Mirror the event sealer's eligibility exactly, per table:

- `typeof(data) = 'text'` (idempotent, mixed-representation safe);
- `length(data) >= 4096`;
- **settled:** session `time_updated <= now - COOLING_MS` (48 h) — this excludes parts in `pending`/`running` states in active sessions for free, since active sessions keep bumping `time_updated`; a part stranded mid-turn in an idled session may seal, and the projector's identity write on resume simply reverts it to TEXT (safe; see §7).

---

## 5. Mixed representation during migration (TEXT | BLOB coexistence)

The sealer model makes mixed representation the **steady state**, not a migration phase:

- **New writes are always TEXT** (identity `toDriver`). Zero hot-path change; existing tests/imports keep working.
- **Any row may become BLOB at any time** via the background sealer, and may revert to TEXT on the next update. All readers (`compressedJson.fromDriver` → `parseDriverValue`) already decode both, fail-closed.
- **The only correctness hazard is SQL that reads JSON out of `data`.** That hazard is confined to `message.data` (§1.2). The mandatory order for `message`:

```text
1. add role / provider_id / cost (ALTER TABLE, nullable or defaulted)
2. backfill from JSON while data is still TEXT (batch, resumable — reuse the
   fork's own part_search_backfill idiom: watermark table + dedicated
   connection + retryOnLock; do NOT invent new machinery)
3. validate exact equality (COUNT mismatches; also verify time_created == data.time.created)
4. rewrite usage.ts, credentials.ts, search.ts to native columns
5. create idx_message_usage, validate planner picks it
6. DROP idx_message_provider_id
7. only then enable the message sealer
```

- **`part.data` skips steps 1–6 entirely** — seal it first, measure, then do the message routing work.
- **File-swap rebuild model (migration-arch, `docs/chunkdb/architecture/migration.md` §3) — routing work rides the rebuild.** When migration is a `opencode.db.new` rebuild streaming the legacy file read-only, steps 1–5 of the message order become free: every `message`/`part` row is streamed once, so the rebuild writes native `role`/`provider_id`/`cost`/`part_type` directly, validates equality inline, and simply does not carry `idx_message_provider_id` into the new file. **Deployment coupling:** the `usage.ts` rewrite (native columns, no ad-hoc `CREATE INDEX IF NOT EXISTS idx_message_provider_id`) must ship in the *same release* as the swap — otherwise the new binary recreates the expression index in the new file and the silent-NULL path can re-emerge the moment any projection row is framed. Prefer the post-swap background sealer for framing (keep the rebuild single-purpose); the reverse direction (target release predates OPCL) decodes projection frames back to TEXT per migration.md §3.3.

---

## 6. Search / FTS projection strategy

- **FTS is already safe.** `part_fts` and `session_message_fts` are external-content virtual tables synced by triggers over the native `search_text` column; neither the projector nor any trigger inspects `data`. Framing `part.data`/`message.data` cannot corrupt FTS.
- **One search-path rewrite is required:** `search.ts`'s V1 part query reads `json_extract(m.data, '$.role')` to type part matches. After step 4/5 above it reads `m.role`. This is the consumer the research doc's §21.5 missed.
- **Sealer ↔ trigger interaction:** sealing a part issues `UPDATE part SET data = frame`; the `part_fts_au` trigger then delete+reinserts the *same* `search_text`. Logically correct, physically wasteful (FTS index churn on every sealed row). Acceptable at sealer volumes; if sealing is ever frequent, the trigger can be re-pointed at a `data_updated` sentinel or the sealer can use a no-trigger path (`UPDATE ... SET data = ... WHERE rowid = ...` still fires triggers — so the fix would be trigger-conditioning, not sealer SQL). Note, do not fix yet.

---

## 7. Mutation handling: pending/running/completed and large tool results

Policy: **identity writes; cold-only sealing; never re-encode on a durable update.**

- `pending → running → completed` transitions each issue a full `PartUpdated` → projector writes **TEXT** (identity). Cost per transition: one `JSON.stringify` — identical to today. No codec involvement, no re-encode, no churn.
- **Large tool results:** the completed part is written once, as TEXT, in one durable write. The sealer frames it later if ≥ 4 KiB and the session is cold. A 1 MB output → ~100–300 KB brotli-1 (typical), one background pass, one journal row. No special casing needed. `RAWLEN_PRE_CAP` (128 MiB) keeps pathological outputs TEXT forever.
- **Update-after-seal:** a sealed row that later receives a `PartUpdated` (e.g. compaction `prune` stamping `state.time.compacted`, or a retry rewrite) is written back as TEXT by the identity `toDriver` and re-sealed on a subsequent pass. Correct, and it is the **only** allowed behavior: **write-through is rejected as a codec invariant, not a performance choice** (codec-arch). The entire cross-runtime/byte-stability story rests on `toDriver` staying IDENTITY — hot writes byte-identical to today's TEXT. Any write-path re-encode would (a) put compression inside the durable write transaction, violating the single-connection latency budget, and (b) reopen which codec/level a hot writer should use, fragmenting the frozen registry's meaning. The sealer is and remains the **sole frame producer**.
- **Sealer eligibility needs per-table partial indexes** mirroring the fork's `idx_event_seal_candidates` (`WHERE typeof(data)='text' AND length(data) >= 4096`), which gave a measured 68× eligibility speedup on the event table. Add `idx_message_seal_candidates` and `idx_part_seal_candidates` before enabling each table's sealer; per-part_type byte accounting then reads the native `part_type` routing column, never frame decoding.

---

## 8. Projector: populating routing columns atomically with durable events

The projector is the single point where routing columns can be kept consistent with `data` **in the same statement** as the payload write:

- `SessionV1.Event.MessageUpdated` upsert → set `role`, `provider_id`, `cost` from `event.data.info`, and add `time_created` to the `ON CONFLICT DO UPDATE` set (today only `data` is updated; harmless today because `time.created` is immutable per message, but the routing invariant `time_created == data.time.created` should be enforced defensively).
- `SessionV1.Event.PartUpdated` upsert → set `part_type` alongside `data` + `search_text`.
- Usage accounting (`applyUsage` on `step-finish`, with decrements on part/message removal) stays at session level and is untouched by OPCL.
- Backfill of pre-existing rows uses the fork's own resumable-idiom (`search_backfill`-style watermark + `withBackfillDb` + `retryOnLock`), one short transaction per batch, WAL bounded (§ doc §25.5).
- All of this is *atomic with the event projection* in the sense that each row's routing + payload are written in one `INSERT ... ON CONFLICT` statement inside the projector handler — there is no window where `data` is BLOB and routing is stale (the sealer only frames rows whose routing is already backfilled, because the sealer is enabled only after step 6 of §5).

---

## 9. Challenge the assumptions

1. **"Is compressing `message.data` even worth it?"** — At median 407 B and reference p99 437 B: **no, not for typical rows.** Unless a real corpus shows a meaningful ≥ 4 KiB population (giant error objects, huge `system` prompts, embedded summaries), message sealing is a no-op. That is an acceptable outcome: ship the routing plane regardless (it removes the JSON blocker, fixes usage-query performance, and is the prerequisite for any future message BLOB), and let the sealer prove or disprove message framing with a gate.
2. **"Where is the real byte volume?"** — Durable events dominate (fork bench: aggregates of 379 MB stored / 2.5 GB raw are *event* aggregates). On the projection side the volume is the **part tail**: tool outputs that compaction marks but never deletes (§1.4), plus big text/reasoning and patch parts. `message.data` is small and `session_message.data` (V2) is out of this lane's core scope but equally BLOB-ready.
3. **"Does OPCL need its own codec registry?"** — No. The fork's codec IDs (1=zstd, 2=brotli, 3=deflate) are the registry. Adding a parallel OPCL registry would create two versioning contracts that must be frozen, tested, and reverse-migrated independently.
4. **"Is `part_type` over-normalization?"** — It is the *one* column that looks unneeded on query evidence alone, but it is the column that makes the feature operable (per-type byte accounting without frame decoding). This is the rare justified denormalization; everything else stays in the payload.
5. **"Is the 48 h cooling window too slow for reclaim?"** — For cold sessions yes it's fine; for reclaim urgency the sealer can also be run manually / at idle. Sealing is not a space-reclaim SLA; it is a background compression pass.

---

## 10. What must be benchmarked (acceptance corpus, per doc §29)

Corpus and gate discipline follow `benchmark-arch`'s `docs/chunkdb/ideation/benchmark.md` (two-form corpus, one-process 3-engine harness via the existing `packages/opencode/bench/` driver pattern, pinned gates incl. active-write p95/p99 ≤ +5% and the write-amplification ≤ 8× / unbounded-WAL veto). The OPCL-specific measurements below feed that harness:

1. **Per-type part.data byte distribution** (uses the new `part_type`): n, min, median, p90/p95/p99, max, and **% of rows and bytes ≥ 4 KiB per part type** — reporting **both** `length(data)` (UTF-16 code units, the sealer gate) and `octet_length(data)` (UTF-8 bytes, the frame economics) on a real multi-session corpus. → decides the sealing-yield gate for part, and whether per-type thresholds are ever warranted. *This is the gating measurement* — **corpus deliverable `arch-corpus` D1** (`docs/chunkdb/architecture/corpus.md`), fed by T0 real sources (16.75 GiB / 1.38 M events frozen DB + live copy) with the two-unit accounting rule (6 of 8 in their measurement protocol).
2. **message.data byte distribution**: count of rows ≥ 4 KiB; decides whether message sealing ships or stays disabled. Also measure a "giant error object" presence.
3. **Sealer pass cost per table on a cold copy**: wall time, WAL bytes, and interactive-read p95 during the pass (extend `bench/chunkdb-seal-parallel.ts` and `chunkdb-readlatency.ts` to `message`/`part`).
4. **Hydration decode cost**: `MessageV2.page` (50 msgs + parts) with 0% / 10% / 50% framed parts — p95 before/after; CRC32+inflate cost is expected negligible. This is now a **hard read-latency gate** (≤ 5–10% interactive regression, adversary O4 / readpath §4.4.2), to be absorbed by the projection-side decoded working-set cache where needed.
5. **Differential correctness**: after sealing a subset, run `usage.ts` `rows()`/`windows()`, `credentials.ts` backfill/`usageByCredential`, and `search` end-to-end against a pre-seal snapshot — byte-equal results. This is the test that catches the silent-NULL class of bug.
6. **Routing-query plan**: `idx_message_usage` vs `idx_message_provider_id` on `usage.windows()` — plan + latency, then drop the expression index.
7. **Update-after-seal churn**: simulate a sealed part receiving `PartUpdated` (compaction prune) — measure the TEXT rewrite + re-seal + FTS trigger cost. Informational only (write-through is rejected as an invariant, §7); confirms the accepted cost stays under budget.
9. **Projection duplicate-rate census** (gate for `contract-arch`'s deferred cross-layer dedup, architecture/contract.md): (a) within-projection exact-duplicate value share — payload bytes belonging to values appearing ≥ 2× across `part.data`/`message.data` rows (candidates: repeated file-attachment `data:` URLs, repeated tool-call inputs, compaction/summary text); (b) cross-layer duplicate share — projection payload bytes byte-identical to a sealed `event_value`. Expectation to verify: projection→event duplication is *structural* (projection = latest event state materialized) rather than a repeated-value class, so it is not a dedup target — deduping it would couple the materialized view's read path to the event store and violate the independently-addressable-projection principle (research doc §18.2); within-projection repeats are the only real candidates and are estimated small relative to the OPCL tail. Low census numbers keep cross-layer dedup deferred; a high (b) would force revisiting.

10. **Whole-file metric set** (doc §17.9): logical bytes, main DB, WAL during sealing, post-checkpoint, post-VACUUM, journal, per codec (zstd L1 / brotli q1 / deflate L1) — on a distinct-session corpus, not the 9-part reference DB. Per `codec-arch`: brotli q1 is the byte-stable default baseline (keep the fork's default); zstd and brotli are interchangeable for ratio/CPU Pareto; deflate only as an interoperable fallback; golden vectors are two-tier (logical equality for all codecs, byte-equality fixtures only for brotli/zstd-dict-less). Note: the T0 18 GiB snapshot is pristine TEXT (no ocdb_seal frames) — a clean three-state baseline for projection measurement; framing census records the frozen codec registry version at capture time.
9. **Envelope overhead**: 14 B header + guard as % of sealed bytes — document, do not optimize.

---

## 11. Open questions

1. **What is the real part.data tail?** The entire OPCL-on-projections value proposition hinges on the ≥ 4 KiB part population and its per-type composition — now a `benchmark-arch` corpus deliverable (two-unit: `length(data)` AND `octet_length(data)` per part_type; flagged as underpowered if the sample can't support it).
2. **Does message.data ever exceed 4 KiB in production?** **CORRECTED (adversary O4):** T0 corpus evidence says yes — `message.data` mirrors `info.summary` (byte king, up to ~548 KB), so OPCL-on-message is expected to be a live win. D1 (message.data ≥ 4 KiB share, both units) confirms the magnitude; the hydrate gate (≤ 5–10% interactive with the projection decoded cache) is the binding constraint. Remaining question is *how much* (D1), not *whether*.
3. ~~Write-through or not?~~ **RESOLVED — rejected as a codec invariant.** Identity `toDriver` is the foundation of cross-runtime byte-stability; the sealer is the sole frame producer; a sealed row updated reverts to TEXT and re-seals after cooling (§7).
4. **FTS trigger churn on sealing** — does `part_fts_au` delete+reinsert of identical `search_text` matter at sealer volume? (Suspected: no; trigger-conditioning is the fix if it does.)
5. **Dictionary codecs for projections** — only if per-type volume data shows a post-compression Pareto win; v1 ships without dictionaries. The only cross-runtime-safe candidate is a structural deflate dictionary (codec-arch).
6. **Coordination with OSES cutover** — OPCL sealing of projections must not run during a migration epoch that rewrites the same tables. Governing rule (reconciled between `migration-arch` and `oses-arch`, oses.md §6.1/§9.3/§9.4): **the fork event sealer retires BEFORE Stage B shadow backfill arms** — earlier than "before Stage C catch-up" — so `ocdb_seal` freezes at Stage B shadow-arm and stays a complete reverse-export decode manifest (every row it lists is still a hot framed row at flip time), the backfill sees a quiescent representation (no TEXT→frame churn mid-verification), and Stage C catch-up sees only new TEXT appends. **`ocdb_seal` journal writes (event rows) freeze at fork-sealer retirement; the projection (message/part) sealer freezes at Stage B shadow-arm** (consistent, no shift); both resume only after cutover completes, when the OSES sealer is the sole frame producer (and it decodes pre-Stage-B OCDB frames when it touches them). `ocdb_seal` + `idx_event_seal_candidates` reclaimed at Stage E.

---

## 12. Research-doc corrections vs openfork reality

| Doc claim (§) | Reality on openfork | Action |
|---|---|---|
| OPCL envelope with magic/version/codec/**flags/dict-id/payload-len**/checksum (§22.1) | Fork ships a **14 B OCDB v2 frame** (no flags, no dict-id, no payload-len) already used for `event.data`, with v1 backward decode | Reuse it; drop the extra fields |
| Codec registry 0=raw/1=deflate/2=brotli/3=zstd (§22.2) | Fork registry: 1=zstd, 2=brotli, 3=deflate; **zstd already shipped and benched** | Adopt fork registry |
| Message routing: role/provider/model/cost/**5 token columns** (§21.1, Appendix A) | `model_id` + tokens have **no live consumers** (migration-only); live consumers are providerID/role/cost/time.created | Add role/provider_id/cost only; reuse `time_created`; defer the rest |
| Search is an independent projection (§21.5) | `search.ts` reads `json_extract(m.data,'$.role')` — search is a JSON consumer of `message.data` | Add search rewrite to the migration order |
| Threshold implied "save any byte" / 20 B envelope math (§17.2) | Fork's settled threshold is **4096 code units** + 24 B worth-it guard | Keep 4096 |
| Bounded batch conversion 500 rows / 4 MiB (§25.3) | Fork sealer: 128/batch, 5000/pass, 48 h cooling, `ocdb_seal` journal keyed `(table_name, row_id)` | Adopt fork numbers + journal |
| "part at minimum part_type" (§21.1) — unexamined | `part.data` has **zero** JSON deps; part sealing needs no routing migration at all | Seal part first |
| Zstd is "Stability 1 — Experimental" risk (§1.6, §17.8) | zstd is codec 1 in the shipped `json-codec.ts`, benched in the fork | Risk already accepted; keep brotli fallback |

---

## 13. Suggested file map (implementation, for later phases)

```text
packages/core/src/database/
  json-codec.ts        # EXISTING — OPCL frame = OCDB v2; add nothing in v1
  chunk-sealer.ts      # EXISTING — extend eligibility per table (message/part/event)
packages/core/src/session/
  sql.ts               # + role, provider_id, cost on message; + part_type on part
  projector.ts         # populate routing cols in upserts
  usage.ts             # native-column queries; drop expression index
  search.ts            # m.role instead of json_extract
packages/opencode/src/fork/credentials.ts  # native-column queries
packages/opencode/bench/                    # extend to message/part + differential test
```
