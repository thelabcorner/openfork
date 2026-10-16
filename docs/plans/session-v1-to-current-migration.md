# V1/current Session interoperability and optional shadow-migration research

**Status:** experimental compatibility/audit infrastructure; **not** an approved
V1 retirement or write-authority cutover. Architecture reconciled 2026-10-11
against the repository-wide and Core `AGENTS.md`, `FORK.md`, and
`docs/map/v1-v2.md`.
**Scope:** the OpenFork session execution, durable replay, history, recovery, tool, context,
search, memory, import/export, and GUI APIs. This is distinct from ChunkDB event framing.

## Governing OpenFork architecture decision

**V1 is the supported mature production runtime and local API target.**
Current/V2 is an architectural reference and a source for selective semantic
backports, **not** an automatic migration destination. The preferred new/V2
presentation UI is an independent axis. The product deliberately diverges
from upstream's V1 retirement plans.

The previous heading and implied objective of retiring all V1 storage were
therefore **not an authorized product roadmap**. The experimental V1→current
shadow reducer, compact residue, source-hash probes and event replay tests
remain valuable for validating correctness, recovering historical state,
studying overlapping semantics, and making targeted V1 performance/recovery
improvements. Their existence does not justify dual authority, V1 deletion,
or a new dependency on current Protocol routes.

Before any future V1 retirement, OpenFork requires a **separate explicit
architecture decision with a product reason and proven full parity**. Until
then, optimize and extend the V1 producers at their existing authoritative
owner; share semantics at the lowest correct domain boundary with narrow
adapters. Do not enable automatic shadow scanning or background history
hydration as a routine live-session requirement.

## Authority inventory (verified against live code)

| Surface | Current authority | Key consumers | Retirement gate |
| --- | --- | --- | --- |
| Ordinary prompt/processor | V1 MessageUpdated/PartUpdated → `message`/`part` | `session/prompt.ts`, `processor.ts`, `message-v2.ts` | Current runner emits complete current-model events with replay and tool settlement parity |
| Special-agent messages | `session_message` + event-backed lifecycle/tool overlays | `SessionMessageProjection`, `currentPage/currentGet` | Already current for special agents; do not generate token-rate V1 mirrors |
| Ordinary timeline | V1 `MessageV2.get/page` plus current presentation adapters | session HTTP/UI, history streaming | Per-session complete history proof, not mere presence of one current message |
| Pending/running tools | V1 part facts plus current `session_message_tool_overlay` | startup dead-owner recovery, operator stop | Both sets resolved for each owner generation before claiming quiescence |
| Tool-output retention | V1 `session_tool_output` FK to `message` | tool output paging and retention | Native current tool output mapping, including crash/cancel/unknown outcomes |
| Context compaction | V1 effective-history rules and context facts | Context ledger, prompt compiler, LACE | Byte- and semantic-equivalent current history under signed-reasoning/opaque cases |
| Search/recall | `part_fts`, `session_message_fts`, `session_tool_recall` | exact recall, excerpts, search | Proven index coverage, event-tombstone handling, source identity preservation |
| Input | canonical `session_input.input` with transitional V1 mirrors | promotion/continuation | No remaining user-input reconstruction from V1 message shell/parts |
| Memory/evidence | historical V1 part IDs or current tool-call overlay | memory/evidence scope proof | Both paths verified; must reject cross-session/cross-project forgeries |
| Import/export | V1-compatible wire format | CLI, shares, third-party clients | Stable V1 adapter over current storage, versioned importer, round-trip parity |
| Original event log | `event` / `event_sequence` | projector, replay, ChunkDB | Different migration (OSES); do not conflate with message-model cutover |

**Important:** `MessageV2` is not synonymous with current-model storage. The ordinary
`MessageV2.page/get/makeDrainHistory` implementations still hydrate the V1 `message`
and `part` tables. Only `currentPage/currentGet` read canonical `session_message`.
The existing current→V1 *presentation* adapter already proves the UI can be kept
compatible without token-rate storage dual writes.

## Completed safe compatibility migration slice

- Centralized CASE-gated V1 part metadata queries in `legacy-part-query.ts`:
  kind, status, signed reasoning, OPCL opacity, and unsettled tool detection.
  Only producer-certified projection version 1 skips JSON; version 0 and unknown
  versions retain authoritative historical JSON behavior.
- Removed large V1 JSON deserialization from the tool-output retention identity
  **existence check**. An exact callID probe now uses the indexed sidecar for
  producer-certified parts and JSON only for historical unverified rows.
- Moved context mutation admission, historical tool-recall scanning and V1
  tool-candidate queries to the versioned metadata boundary.
- Made imported V1 parts create producer-equivalent context facts and newly
  inserted tool recall rows instead of introducing new version-0 history.
- Native current-model tool-call overlays can now satisfy exact scoped memory
  evidence without materializing fake V1 ToolParts.
- Existing owner-generation CAS and unsettled-effect retention are unchanged.
- No new large index, irreversible rewrite, or startup-time table rebuild.

### Implemented next slice: V1 tool-call identity index

- Schema migration `20261012012854_v1-tool-call-index` adds a cheap
  `part.tool_identity_version` marker, a new `session_v1_tool_call` sidecar
  with two *initially empty* covering lookup indexes, and a one-row resumable
  background repair cursor. **No CREATE INDEX scans the existing part table.**
- The ordinary V1 projector and the CLI import writer now commit part payload,
  certified identity version, and exact indexed tool-call identity/status in
  the same SQLite transaction. Part deletion cascades to tool identity;
  id-preserving tool→non-tool replacements actively retire old sidecars.
- Operator Stop and tool-output retention use exact `sessionID/callID` (and
  `messageID` when available) index probes. Dead-owner startup reconciliation
  uses per-session indexed unsettled status plus fail-closed historical
  fallback; operator repair materializes content only for selected pending
  tool parts. The current-model `session_message_tool_overlay` remains
  independently authoritative for native V2 calls.
- Background `SessionLegacyToolIndex.repairChunk()` traverses bounded
  `part.rowid` ranges on the existing isolated backfill connection.
  It performs per-row source-value CAS checks, writes index + version
  atomically, and persists its watermark **after** the batch. A crash only
  replays idempotent already-certified rows. Bad/unknown tool metadata
  stops the pass without certifying unsafe absence.
- A 16 KiB rewrite gate deliberately leaves large historical **non-tool**
  payloads on the conservative v0 fallback. The cursor reports traversal,
  not a universal assertion that every source row has been certified.
  This bounds unnecessary massive non-tool SQLite row rewrites.
- Migration chain/fresh schema agreement and `bun script/migration.ts --check`
  passed. Recovery, identity backfill, CLI import, retention and relevant
  existing producer suites pass. `EXPLAIN QUERY PLAN` tests verify exact
  callID and unsettled-status queries hit the new sidecar indexes.
- `V1CurrentInventory.page()` now offers a **read-only, bounded keyset**
  source-shape inventory. It distinguishes candidate V2 Assistant.content
  kinds (text/reasoning/tool), unsupported kinds that require a lossless
  compatibility bridge (nine other V1 kinds), unknown source kinds, and
  unresolved tool effects. Version-certified rows can be classified without
  parsing multi-MiB JSON. Its output is diagnostic only, not a cutover token.

The index is **an intermediate performance/compatibility projection**, not
the final canonical message store. The full ordinary runner still publishes
V1 `MessageUpdated/PartUpdated` events; this implementation deliberately
does not perform a dangerous silent authority switch.

### Implemented next slice: lossless shadow reducer and real-SQLite audit

- `packages/core/src/session/v1-current-bridge.ts` defines **version 1**
  in-memory, *read-only* shadow envelopes. It validates and detaches original
  V1 `WithParts` content, computes a canonical SHA-256 source digest,
  lowers the representable subset into a schema-validated V2 message, and
  maps exact message/part/call identities by ordinal. `verify()` validates
  source and candidate without duplicating the multi-MiB source again;
  `restore()` returns an independent full V1 object only after verification.
  Source hashes establish **internal consistency, not authenticity**; these
  are not signatures, persisted references, rollback certificates or locks.
- The reducer explicitly enumerates **all twelve** V1 part kinds in tests.
  Assistant text/reasoning/tool parts have V2 candidate shapes (all four V1
  tool states covered). Nine other kinds are retained in the full V1 envelope
  and marked as unsupported in V2 Assistant.content. User file source,
  multiple text parts, host provenance, user model/tools/system policy,
  original V1 tool-part identity, reasoning signatures, and assistant
  parent/path metadata remain *explicit bridge blockers*, never silently
  reconstructed from V2 display fields.
- `packages/core/src/session/v1-current-audit.ts` reads real V1 SQLite
  `message` / `part` rows with bounded (time_created,id) message keysets;
  resolves OPCL references; validates the exact V1 source; checks assistant
  parent existence **within the same Session**; reports malformed,
  ambiguous, unresolved-tool, and unsupported-part cases; and emits hashed,
  source-sensitive page digests. `summarize()` composes bounded pages into
  resumable, aggregate counts/digests without retaining whole transcripts.
  Validation diagnostics deliberately omit private payload text.
- `packages/opencode/test/session/v1-current-differential.test.ts`
  exercises the *real existing* V2→V1 display adapter. It proves semantic
  text/tool presentation can agree even while the adapter synthesizes
  different part IDs, omits V1 patch parts and reconstructs different
  assistant paths. That is a concrete falsification of treating visual
  similarity as reversible migration. The shadow envelope restores originals.
- New tests cover all 12 V1 part kinds, 4 tool settlement states, V1
  provenance/source metadata, missing/foreign part identity, duplicate
  identities, source tampering, candidate tampering, paging cursor stability,
  changing source hashes, invalid historical messages and missing ancestry.
  They run in ephemeral databases; **no production session was switched**.

### Implemented next slice: compact lossless portable V1 residue

- `packages/core/src/session/v1-current-residue.ts` is a versioned sparse
  V1 remainder over a schema-valid **current message candidate**. V1 header
  metadata and unsupported kinds remain explicit. When a modeled field
  exactly matches an existing current-model value, the residue substitutes
  a stable binding instead of storing another copy.
- Implemented candidate bindings: user text, user file URI, assistant text
  and reasoning text, tool input, structured metadata, complete tool output,
  and completed-tool attachment URIs. Original part identity, tool-call
  identity, timestamps, status, source metadata, unsupported parts, and the
  exact part ordering remain recoverable by `restore()`.
- `toWire()` and `fromWire()` use schema-native V2 DateTime encoding
  (milliseconds), giving the prototype a genuine **JSON-serializable**
  representation rather than a nonportable JavaScript DateTime object.
  Each decode verifies the SHA-256 original-source digest AND the V2
  candidate differential, and fails closed on missing references.
- Test cases with roughly 520 kB of tool text plus a 100 kB attachment
  URI and separately a 160 kB user file URI demonstrate **one large-payload
  copy in the serialized candidate**, not a duplicate in the residue.
  The synthetic wire-size tests assert less than 5–6% overhead against
  the repeated payload sizes. These are *unit fixture size assertions*,
  **not** production compression-ratio or throughput benchmarks.
- The bridge now rejects a cross-kind V2 content-ID collision (e.g. a V1
  callID matching a text PartID), which would otherwise make native tool
  overlays ambiguous. Sparse templates are typed as incomplete/unknown
  until `restore()` validates the complete V1 schema.
- The sparse-template writer only shallow-copies ancestor objects it edits;
  it does not make a second deep copy of the multi-MiB source field just
  before replacing it with a reference. The validator also avoids redundant
  source-digest passes when comparing candidates and restoring residues.

#### Synthetic benchmark, reproducible, not a production target

`bun script/bench-v1-current-residue.ts` (run from `packages/core`)
creates one synthetic completed tool output of each size, warms up, and
measures reduction and full wire encode/decode + verification + restoration.
On the Windows/Bun 1.4.3 development checkout, a representative run yielded:

| Output bytes | Wire/source JSON bytes | Reduction p50 / p95 | Wire encode+restore p50 |
| ---: | ---: | ---: | ---: |
| 4,096 | 5,619 / 4,717 (+19.12%) | 0.310 / 0.721 ms | 1.777 ms |
| 65,536 | 67,059 / 66,157 (+1.36%) | 0.424 / 1.438 ms | 2.647 ms |
| 1,048,576 | 1,050,099 / 1,049,197 (+0.09%) | 3.050 / 5.696 ms | 26.016 ms |

At 1 MiB, median reduction-only throughput was about 328 MiB/s for this
single, highly compressible fixture. **No compression codec ran**, so the
wire/source ratio measures representational duplication, not compressed
storage or memory allocation. Runs are susceptible to JIT/OS contention
and do not establish p99, peak RSS, real-corpus distribution or a win over
native V1 writes. The 26 ms encode/restore leg is an optimization target.

This closes a central *format feasibility* blocker in code: a serialized V2
candidate plus sparse residue can reconstruct the original V1 source on the
tested fixtures without storing multi-MiB tool output twice. This is **not
a durable database migration yet**. No native writer, replay watermark,
transactional catch-up, rollback fence, or migration authority marker has
been enabled. It is not yet safe to delete V1 data. Future persistence
must avoid unnecessary duplicate event payloads and measure peak memory
during construction as well as final wire bytes.

#### Shadow audit invocation (from existing Effect/Database service)

```ts
import { V1CurrentAudit } from "@opencode-ai/core/session/v1-current-audit"

// db is the existing Database service's read-capable connection. Invoke
// explicitly during diagnostics/maintenance, never in startup hot paths.
const page = yield* V1CurrentAudit.page(db, {
  sessionID, limit: 8,
})
const summary = yield* V1CurrentAudit.summarize(db, {
  sessionID, pageSize: 8, maxPages: 64,
})
// Both results always have cutoverSafe === false.
```

The in-memory shadow envelope temporarily duplicates payload buffers.
The audit is therefore **opt-in**, with explicit page limits; it has not
passed production-size peak-RSS or latency gates. Pages are separate SQLite
reads, not a fenced consistent snapshot. Missing source parents, externally
pruned/opaque data, or concurrent edits must prevent promotion; an apparently
complete report by itself does **not** establish one immutable source revision.

### Regression evidence for this continuation

- Final targeted Core run: **86 passed, 0 failed** across 13 files,
  including prior Session recovery, producer projection, tool retention,
  tool indexing, import-related schema integrity and ChunkDB prune tests.
- Final targeted OpenCode run: **12 passed, 0 failed** across three files,
  including the new presentation-adapter falsification test, CLI import and
  exact memory-evidence validation.
- Core `bun run typecheck` passed; migration
  `bun script/migration.ts --check` reported no pending schema divergence.
  The targeted `git diff --check` passed.
- Full OpenCode package typecheck still reports **32 errors** in unrelated
  pre-existing areas, with none in the modified migration/audit paths.
  The broader typecheck is **not green**; avoid interpreting focused passes
  as production-release verification.
- No database authority marker, live production migration, destructive
  source-table rewrite, cutover or actual desktop cold-start verification
  occurred in this continuation.

### Implemented next slice: durable shadow persistence and event-lowering inventory

- Migration `20261012022358_session-v1-shadow` adds **two initially empty
  tables**: `session_v1_shadow` (one compact, versioned shadow wire payload per
  V1 message, with cascade on source deletion), and
  `session_v1_shadow_cursor` (per-session event-generation + rowid
  maintenance watermark). Its one shadow lookup index is built over the new
  empty table, **never** over the historical multi-gigabyte V1 `part` table.
- `SessionV1Shadow.projectOne()` reads the canonical message and **all**
  message-owned part rows, rehydrates OPCL references and constructs a
  validated sparse candidate outside its short write transaction. The write
  transaction re-reads the message, every part's raw persisted JSON and
  timestamps, and the session `event_sequence.seq`. A changed source or
  generation returns `stale` and **writes nothing**. Identical source and
  wire return `unchanged`; otherwise the small hash/metadata columns and
  compact wire are upserted atomically.
- A V1 part attached to a message but claiming another `session_id` fails
  closed as `foreign-part-session`. A missing assistant parent in the same
  session fails closed as `orphan-parent`. These cases cannot silently lose
  transcript ancestry or parts during conversion.
- `SessionV1Shadow.readVerified()` uses one pinned SQLite transaction snapshot
  for the shadow + current V1 message/parts. It checks the serialized wire
  hash, current raw source fingerprint, event generation, candidate schema,
  full V1 residue reconstruction and the original source digest. It returns
  `cutoverSafe: false` **even when verified**.
- `scanSlice()` processes 1–16 source messages per explicit invocation in
  monotonically increasing SQLite rowid order. Cursor advancement occurs
  **after** the shadow commit and in a separate sequence-fenced SQLite
  transaction; replay after a crash is idempotent. Parallel scanners cannot
  regress a committed watermark. An event-sequence change restarts from
  rowid zero. Newly inserted V1 messages with earlier created timestamps
  are still discoverable via later rowids. All scans remain opt-in; nothing
  was enabled on desktop startup.
- `scanOnOwnConnection(filename, { sessionID, limit })` executes **one
  bounded slice** on the already-established low-priority
  `Database.withBackfillDb` maintenance connection; it does not spawn an
  endless scan loop or contend for the primary in-process query semaphore.
  A cursor's `complete` bit means only that a bounded scanner exhausted
  the observed rowid range at an observed event generation; it is **not**
  a durable snapshot/owner lease/cutover authority certificate. A direct
  V1 SQL rewrite that bypasses event producers still invalidates
  `readVerified()` through exact raw-source fingerprint comparison.
- `SessionV1CurrentEventAudit.page()` uses the **actual V1 and current
  durable definition inventories**, including versioned event types, to
  classify bounded `event` rows as legacy lifecycle, legacy transcript
  mutation, native current event, or unknown version/event. It never
  decompresses event payloads. Gaps in event sequence may reflect historical
  compaction and are never treated as proof that event replay is complete.
  This establishes the explicit event-lowering backlog: V1 message/part
  state transitions must be replayed, not reconstructed from final V1 rows.
- Ephemeral SQL tests prove CAS race rejection, changed same-ID parts,
  changed event generation, integrity hash corruption detection, orphan
  and foreign-session rejection, exact rowid resumption and reset, V1
  authority preservation, event type/version classification, and no
  `session_message` mutation. A **file-backed database restart** test proves
  shadow durability across closed/reopened connections, maintenance-lane
  scanning, and source-deletion cascading.

### Implemented next slice: bounded historical V1 event transition replay

- `SessionV1CurrentReplay.probe()` reads 1–256 stored event metadata rows
  inside **one SQLite snapshot transaction** for a chosen Session/message.
  It fetches and rehydrates only the associated V1 message/part mutation
  payloads, not unrelated native event bodies. It replays
  `message.updated`, `message.removed`, `message.part.updated` and
  `message.part.removed` in exact event-sequence order.
- It retains every observed tool status transition by original tool-part ID
  and callID. A callID replacement, an unsettled transition after settlement,
  a part-kind change, foreign session ownership, malformed message/part
  payload or malformed removal produces a fail-closed **anomaly**.
- When the event range is available, the replay reconstructs the final V1
  message/parts and compares their lossless source digest against the
  **current canonical V1 projection** in that same WAL snapshot. It reports
  `matches`, `mismatch`, `anomaly` or `partial`; there is no native V2
  event writer. Missing/truncated event history or gaps are `partial`,
  never fabricated completeness. A successful `matches` is still only
  a **read-only differential finding**, with `cutoverSafe: false`.
- Tests demonstrate exact pending→completed reconstruction, source mutation
  mismatch, length-limited and gap-limited replay, call identity mutation,
  settlement-state regression, and malformed/foreign events. Historical
  compacted event payloads that are no longer available remain blockers.

**Remaining replay work:** paged incremental replay with an authenticated
snapshot/revision fence rather than this bounded one-shot probe, decoding
all native transition equivalents (text/reasoning/tool streaming,
synthetic-user provenance, compaction and revert), retaining unsupported
V1 metadata in the residue, and differential state-machine testing against
both execution implementations. No V2 write authority is granted.

### Current verification gate (2026-10-11 local / 2026-10-12 UTC)

- Focused Core suites: **100 passing tests, 0 failures** across 16 files,
  including six new shadow-storage adversarial/restart tests, actual
  event-version classification and bounded event-replay tests, together with
  existing recovery, tool index, ChunkDB, import-boundary and projection
  regressions.
- Focused OpenCode suites: **12 passing tests, 0 failures**, including the
  display-adapter differential check, memory evidence and import checks.
- Core `bun run typecheck` passed. Core migration generator
  `bun script/migration.ts --check` reported no pending divergence.
  `git diff --check` for modified tracked schema and docs passed.
- Full OpenCode typecheck remains **32 errors in unrelated existing paths**;
  none of those reported diagnostics references the new shadow/replay code.
- A file-backed create→close→reopen→maintenance-connection→cascade test passed.
  These tests are **not** production database conversion, owner-fenced
  cutover verification, multi-gigabyte throughput benchmarking or a verified
  desktop cold start. Shadow scanning remains **explicit opt-in**.

The shadow schema and tests are now a **real durable migration substrate**
instead of only a format prototype. This remains a deliberately isolated,
opt-in write path; the current-runner still cannot consume the wire as its
canonical transcript. Future promotion additionally needs execution-owner
fencing, event-level historical transition replay, native compaction/revert
parity and full crash/restart testing under multiple processes.

### Remaining known JSON work

The V1 operator-stop path and tool-output retention still use JSON fallback
only for **unverified historical rows**. When an OPCL reference cannot be
rehydrated, the repair pass stops without granting a negative safety proof.
The V1 timeline/raw inspection, Code tool inspection, context compilation, and
canonical history hydration still need actual part content. Replacing a payload
read with only kind/status facts would be a correctness bug. Legacy tool recall
backfill still decodes historical candidate payloads to reconstruct bounded
tool input/search text. These are not safe to delete merely because metadata
probes have been optimized.

## Hypothetical write-authority migration (inactive; not an approved roadmap)

1. **Inventory and differential harness:** classify every V1 event and part kind,
   including rare compaction, tool pending/running/completed/error, reasoning
   signatures, attachment/media, snapshots, tool-output externalization,
   synthetic/provenance, revert, user edit, and deletion. Assert V1 replay and
   current→V1 presentation produce equivalent histories, not just row counts.
2. **Canonical event lowering:** define a deterministic, versioned V1 event →
   current message/event transform. Preserve original message/part/call identity,
   source timestamps, provenance and ordering, or record an explicit identity
   map where models differ. Never derive settlement merely from a stale heartbeat.
3. **Resumable backfill:** create a *per-session* migration record with source
   event watermark, destination watermark, hash/provenance, compatibility
   version, and verification result. Process bounded snapshots on isolated
   scan/maintenance lanes. A retry must be idempotent after crashes.
4. **Live catch-up and fencing:** under the same exact session execution-owner
   generation/transactional boundary, catch up all durable events, compare the
   last replayable sequence, prove tool outputs and pending inputs unchanged,
   and atomically mark the single canonical storage authority. No sessions
   execute concurrently under two independently writable representations.
5. **Readers:** dispatch by verified authority marker, not by the existence
   of *some* `session_message` rows. Current sessions take native current
   readers and the already existing V1 presentation adapter as necessary.
   Never merge partially migrated histories into an apparently complete page.
6. **Writers:** replace V1 `Session.updatePart` and `updateMessage` used by
   prompt, processor, compaction, tool lifecycle, and model-facing history
   with current-model events. Propagate streamed output without recomputing a
   growing assistant BLOB or persisting a V1 part per token.
7. **Retirement:** remove the V1 recovery probe and V1 storage reads only when
   no active/historical session can still be V1-authoritative. Retain a
   versioned import/export adapter as an external wire-compatibility feature.
   Drop V1 schema after tested rollback/reverse-export coverage and release
   compatibility windows—not as a first-stage migration.

### Non-negotiable cutover gates

- **100% round-trip parity** for all supported part kinds and sample real
  histories, including large OPCL/ChunkDB references (no silent truncation).
- **Exactly-once tool settlement fencing:** a crash after spawn but before
  result cannot become a completed tool, nor trigger automatic replay.
- **Deterministic page/stream parity:** timeline, context history, LACE,
  tool recall, user provenance and memory citations agree at snapshot revisions.
- **No lost pending input:** inbox items remain durable and in order during
  generation transfer. Cross-process/reentrant owners cannot both activate.
- **Crash-safe idempotence:** restart after *every* batch, event publication,
  projection, cutover-marker and deletion boundary; verify integrity and
  repeatability under WAL writer contention and busy snapshots.
- **Performance gate:** compare bytes read, peak RSS, startup time, p50/p95/p99
  latency, write amplification, DB size and replay throughput against the
  same database/fixture. Do not claim Pareto wins from a toy dataset.
- **Downgrade contract:** either a tested reverse-export or explicit refusal
  by old binaries once a session has current-only writes. Silent downgrade to
  stale V1 parts is prohibited.

## Next approved architecture-aligned direction

**Next:** harden active V1 session correctness and scalability at its canonical
event/message/part producers, especially exact recovery and tool settlement,
indexed provenance/context projections, and event/part replay safety. Use the
opt-in V1→current **differential audit as a test oracle**, not as a pipeline
to current write authority. This includes fixing read-then-write transaction
ownership (`BEGIN IMMEDIATE`), bounding maintenance by payload bytes as well
as row counts, and adding true concurrent-WAL regression evidence.

If an independently approved architecture decision later reopens V1 retirement,
the additional exploratory requirements below would apply:

Implement V1 event → current event **lowering and replay proof**,
building on the persisted compact shadow format, precise versioned event
inventory, canonical source hashes and resumable maintenance watermarks.
The event reducer must reproduce *each intermediate transition*, including
tool pending/running/settled, text/reasoning deltas, removals, retries,
compaction promotion, revert, user execution provenance and part IDs. A
last-state `message/part` snapshot alone cannot prove historical event
fidelity. Test owner-generation and event-sequence fences under real concurrent
writers before enabling any native Session write authority.
V1 has twelve part kinds: text, reasoning, file, tool, subtask, step-start,
step-finish, snapshot, patch, agent, retry and compaction. Current V2 assistant
content directly models only text, reasoning and tool; user/file attachments
and standalone V2 compaction are *not* a lossless replacement for every V1
file/compaction part. Preserve unsupported metadata/kinds and stable IDs in a
versioned archive/bridge rather than dropping or inventing fields.

The read-only inventory, versioned reducer, durable compact residue,
event-type inventory and persisted read-back verification are implemented.
Next, prove a **durable bidirectional event-level differential replay**
using the lossless extensions already prototyped. Do not assume the
current UI adapter is invertible.
Require historical message IDs, part IDs, call IDs, signed reasoning,
provenance, status transitions, user configuration and event ordering to round
trip before setting any write-authority marker. Retiring V1 tables remains
blocked until actual native V2 prompt/processor/compaction execution parity.