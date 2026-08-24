# Checkpoint API — HTTP, Events & Agent UX Design

**Lane:** `checkpoint-api` (API, events & agent UX lead)
**Swarm:** `checkpoint-arch`
**Depends on:** `checkpoint-core` (domain + persistence + `Snapshot.retain/release/epoch/excludedFiles` + revert extension), `checkpoint-lifecycle` (capture orchestration + 4 lifecycle events)
**Source of truth:** `../handoff/t3code-handoff.md` (§37–§39, §40, §82, §85, §91), `docs/checkpoint/lifecycle-design.md`

This document is the **API + event + tool/CLI + UI contract** for the checkpoint feature. It is grounded in the domain model agreed with `checkpoint-core`/`checkpoint-lifecycle` (restated in §1). Implementation is additive to the existing `Session`/`Snapshot`/`SessionRevert` machinery — no second Git engine.

---

## 0. Audit findings (assignment step 1)

### 0.1 `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
- This is the **experimental** `HttpApi` (`HttpApi.make("session")`, group `"session"`, version `0.0.1`). It already exposes `session.diff` (`GET /session/:sessionID/diff`, returns `Snapshot.FileDiff[]`) and `session.revert` / `session.unrevert` (`POST /session/:sessionID/revert`, returns `Session.Info`).
- Patterns to mirror: `SessionPaths` map, `HttpApiEndpoint.get/post(...)` with `params: { sessionID: SessionID }`, `query: <Schema.Struct>`, `success: described(<Schema>, "...")`, `error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError]`, and `OpenApi.annotations({ identifier, summary, description })`.
- It uses `described()` wrappers and `Schema.Array(Snapshot.FileDiff)`. Good template for the checkpoint endpoints.

### 0.2 Client generation (`packages/client`)
- `packages/client/script/build.ts` runs `compile(ClientApi, { groupNames, endpointNames, omitEndpoints })` where `ClientApi = makeDefaultApi(...)` from **`@opencode-ai/protocol/api`** — i.e. the **production** API in `packages/protocol/src/groups/session.ts` (group `server.session`), **not** the experimental `session.ts`.
- `groupNames` maps `server.session → "sessions"`. New endpoints added to the protocol `server.session` group therefore appear in the regenerated SDK as `client.sessions.<endpointName>()`.
- Regeneration command (per AGENTS.md): `bun run generate` from `packages/client`. **Do not hand-edit `src/generated` / `src/generated-effect`.**
- `endpointNames` (in `packages/client/src/contract.ts`) can rename an endpoint's SDK method (e.g. `session.checkpoint.list → "listCheckpoints"`).

**Conclusion:** checkpoint endpoints must be added to the **protocol `server.session` group** (the SDK source). The experimental `session.ts` should mirror them for parity, but the canonical client-facing surface is protocol. All endpoint designs below target the protocol group and follow its `v2.session.*` identifier convention.

### 0.3 Event bridge
- `EventV2Bridge.Service.publish(definition, data)` attaches `InstanceRef`/`WorkspaceRef` location and re-emits on `GlobalBus` as `event` + `sync` (durable) payloads. Durable events flow to the `session.events` SSE endpoint and the sync stream.
- Event schemas are defined with `EventV2.define({ type, durable?, schema })` (see `packages/schema/src/event.ts`). Public event definitions belong in `@opencode-ai/schema` (browser-safe) and are aggregated into a `Definitions`/`inventory(...)` array.

---

## 1. Domain contract (restated from `checkpoint-lifecycle`)

`session_checkpoint` table (Drizzle, `packages/core/src/session/sql.ts`), snake_case:

| column | type | notes |
|---|---|---|
| `id` | text PK | branded `CheckpointID` (`cp_…`) |
| `session_id` | text not null | |
| `user_message_id` | text not null | dedup key = `(session_id, user_message_id)` |
| `assistant_message_id` | text | terminal assistant msg, set at finalize |
| `before_snapshot` | text not null | shadow-git tree hash |
| `after_snapshot` | text | null while `capturing` |
| `status` | text not null | `capturing \| ready \| partial \| error` |
| `diff` | text | JSON(`FileDiff[]`), content-addressed cache |
| `additions` / `deletions` / `files` | integer | summary |
| `excluded` | integer (bool) | large-file (>2 MiB) exclusions present |
| `epoch_mismatch` | integer (bool) | worktree epoch changed mid-capture |
| `created_at` / `finalized_at` | integer | |

`SessionCheckpoint.Service` (implemented by `checkpoint-core`):
`create`, `reconcile`, `finalize` (CAS `capturing→status`), `markError` (CAS `capturing→error`), `transition`, `list`, `get`, `recoverStuck`.

`Snapshot` contract additions (owned by `checkpoint-core` coordination): `retain(hash)`, `release(hash)`, `epoch(): number`, `excludedFiles(from,to): string[]`.

Lifecycle events (published by `CheckpointLifecycle` via `EventV2Bridge`):
- `Checkpoint.Event.Created` `{ sessionID, checkpointID, userMessageID, beforeSnapshot }`
- `Checkpoint.Event.Finalized` `{ sessionID, checkpointID, status, additions, deletions, files }`
- `Checkpoint.Event.Error` `{ sessionID, checkpointID, error }`
- `Checkpoint.Event.Recovered` `{ sessionID, checkpointID }`

---

## 2. HTTP API design (protocol `server.session` group)

### 2.1 Paths
```ts
const CheckpointPaths = {
  list:     "/api/session/:sessionID/checkpoint",
  get:      "/api/session/:sessionID/checkpoint/:checkpointID",
  diff:     "/api/session/:sessionID/checkpoint/diff",
  diffRaw:  "/api/session/:sessionID/checkpoint/diff/raw",
  revert:   "/api/session/:sessionID/checkpoint/:checkpointID/revert",
  create:   "/api/session/:sessionID/checkpoint",   // POST, manual only
} as const
```

### 2.2 Schemas (define in `@opencode-ai/schema/checkpoint`, import into protocol)
```ts
export const CheckpointID = Schema.String.check(Schema.isStartsWith("cp_"))
  .pipe(Schema.brand("Checkpoint.ID"), statics(...))

export const CheckpointKind   = Schema.Literals(["baseline", "turn", "manual", "pre-revert"])
export const CheckpointStatus = Schema.Literals(["capturing", "ready", "partial", "error"])

export const CheckpointExcluded = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["new-file-too-large", "epoch-mismatch"]),
  size: Schema.optional(Schema.Number),
})

export const CheckpointInfo = Schema.Struct({
  id: CheckpointID,
  sessionID: Session.ID,
  ordinal: Schema.Number,
  kind: CheckpointKind,
  status: CheckpointStatus,
  userMessageID: SessionMessage.ID,
  assistantMessageID: Schema.optional(SessionMessage.ID),
  beforeSnapshot: Schema.String,
  afterSnapshot: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  finalizedAt: Schema.optional(Schema.Number),
  summary: Schema.Struct({ files: Schema.Number, additions: Schema.Number, deletions: Schema.Number }),
  // 2MiB / epoch surfacing (assignment: surface partial warnings)
  excluded: Schema.optional(Schema.Array(CheckpointExcluded)),
  epochMismatch: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "CheckpointInfo" })

export const CheckpointListQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  status: Schema.optional(CheckpointStatus),
  kind: Schema.optional(CheckpointKind),
})

export const CheckpointDiffQuery = Schema.Struct({
  // from/to are checkpoint IDs; omit from => previous checkpoint (turn diff);
  // omit to => latest. cumulative forces from = session baseline.
  from: Schema.optional(CheckpointID),
  to: Schema.optional(CheckpointID),
  cumulative: Schema.optional(Schema.Boolean),
  // whitespace toggle (T3 default ignoreWhitespace=true for human diffs)
  ignoreWhitespace: Schema.optional(Schema.Boolean),
})

export const CheckpointDiffRawQuery = CheckpointDiffQuery // same shape, string response

export const CheckpointRevertPayload = Schema.Struct({
  mode: Schema.Literals(["discard-current", "preserve-current"])
    .annotate({ description: "discard-current: overwrite uncommitted working-tree changes. preserve-current: keep them (phase 2; v1 may reject)." }),
})

export const CheckpointCreatePayload = Schema.Struct({
  kind: Schema.Literals(["manual"]).annotate({ description: "Only manual checkpoints may be created via API." }),
  label: Schema.optional(Schema.String),
})
```

### 2.3 Endpoints (added to `server.session` group)
```ts
// list
HttpApiEndpoint.get("session.checkpoint.list", CheckpointPaths.list, {
  params: { sessionID: Session.ID },
  query: CheckpointListQuery,
  success: Schema.Struct({ data: Schema.Array(CheckpointInfo) }),
  error: [SessionNotFoundError, CheckpointUnsupportedError],
}).middleware(sessionLocationMiddleware)
  .annotateMerge(OpenApi.annotations({ identifier: "v2.session.checkpoint.list", summary: "List checkpoints", description: "List durable per-turn checkpoints for a session, newest first." }))

// get one
HttpApiEndpoint.get("session.checkpoint.get", CheckpointPaths.get, {
  params: { sessionID: Session.ID, checkpointID: CheckpointID },
  success: CheckpointInfo,
  error: [SessionNotFoundError, CheckpointNotFoundError],
}).middleware(sessionLocationMiddleware)
  .annotateMerge(OpenApi.annotations({ identifier: "v2.session.checkpoint.get", summary: "Get checkpoint" }))

// structured diff (turn or cumulative)
HttpApiEndpoint.get("session.checkpoint.diff", CheckpointPaths.diff, {
  params: { sessionID: Session.ID },
  query: CheckpointDiffQuery,
  success: Schema.Struct({
    from: CheckpointID, to: CheckpointID, mode: Schema.Literals(["turn", "session"]),
    files: Schema.Array(Snapshot.FileDiff),
    excluded: Schema.optional(Schema.Array(CheckpointExcluded)),
    partial: Schema.optional(Schema.Boolean),
  }).annotate({ identifier: "CheckpointDiff" }),
  error: [SessionNotFoundError, CheckpointNotFoundError, CheckpointEpochError],
}).middleware(sessionLocationMiddleware)
  .annotateMerge(OpenApi.annotations({ identifier: "v2.session.checkpoint.diff", summary: "Checkpoint diff", description: "Structured FileDiff[] between two checkpoints. Turn diff = from→to; cumulative forces from = baseline." }))

// raw unified patch
HttpApiEndpoint.get("session.checkpoint.diffRaw", CheckpointPaths.diffRaw, {
  params: { sessionID: Session.ID },
  query: CheckpointDiffRawQuery,
  success: Schema.String,                 // bounded output (T3 ~10MB ceiling; reuse Snapshot diff size controls)
  error: [SessionNotFoundError, CheckpointNotFoundError, CheckpointEpochError],
}).middleware(sessionLocationMiddleware)
  .annotateMerge(OpenApi.annotations({ identifier: "v2.session.checkpoint.diffRaw", summary: "Checkpoint raw diff" }))

// revert
HttpApiEndpoint.post("session.checkpoint.revert", CheckpointPaths.revert, {
  params: { sessionID: Session.ID, checkpointID: CheckpointID },
  payload: CheckpointRevertPayload,
  success: Session.Info,                 // mirrors existing session.revert
  error: [SessionNotFoundError, CheckpointNotFoundError, ConflictError, CheckpointEpochError, CheckpointUnsupportedError],
}).middleware(sessionLocationMiddleware)
  .annotateMerge(OpenApi.annotations({ identifier: "v2.session.checkpoint.revert", summary: "Revert to checkpoint", description: "Restore filesystem to the checkpoint's after-snapshot and truncate later turns. Preserves unrevert point." }))

// manual create
HttpApiEndpoint.post("session.checkpoint.create", CheckpointPaths.create, {
  params: { sessionID: Session.ID },
  payload: CheckpointCreatePayload,
  success: CheckpointInfo,
  error: [SessionNotFoundError, CheckpointUnsupportedError, ConflictError],
}).middleware(sessionLocationMiddleware)
  .annotateMerge(OpenApi.annotations({ identifier: "v2.session.checkpoint.create", summary: "Create manual checkpoint" }))
```

### 2.4 Validation / errors (new API error classes in protocol `errors.ts`)
- `CheckpointNotFoundError` — `checkpointID` missing or not in this `sessionID`.
- `CheckpointUnsupportedError` — non-git project or `snapshot=false`; payload `{ reason: "project-not-git" | "snapshot-disabled" }`. List/diff/create return this instead of erroring per-turn.
- `CheckpointEpochError` — target checkpoint's worktree epoch ≠ current session epoch (worktree recreated / path reused). Reject cross-epoch diff/revert (handoff §77).
- Busy revert → reuse `ConflictError` (session has an active run).
- All checkpoint endpoints respect `sessionLocationMiddleware` (workspace routing) like the rest of `server.session`.

### 2.5 Client generation
- Add the six endpoints above to `server.session`. After `bun run generate` (from `packages/client`), they appear as `client.sessions.checkpointList(...)`, `.checkpointGet(...)`, `.checkpointDiff(...)`, `.checkpointDiffRaw(...)`, `.checkpointRevert(...)`, `.checkpointCreate(...)`.
- Optionally add `endpointNames` renames in `packages/client/src/contract.ts` for nicer method names.
- Mirror the same six endpoints in the experimental `session.ts` group for parity (same schemas), so both surfaces stay consistent.

---

## 3. Event model (`session.checkpoint.*`)

Defined in `@opencode-ai/schema/checkpoint` via `EventV2.define`, aggregated into `Checkpoint.Event.Definitions`. Published through `EventV2Bridge` (location attached automatically). `created`/`finalized`/`recovered`/`reverted` are **durable** (aggregate = `sessionID`) so they reach the `session.events` SSE + sync stream; `error` is durable too.

```ts
// from checkpoint-lifecycle (§10) — extended with excluded/epochMismatch on Finalized
export const Created = define({
  type: "session.checkpoint.created",
  durable: { version: 1, aggregate: "session" },
  schema: { sessionID: Session.ID, checkpointID: CheckpointID, userMessageID: SessionMessage.ID, beforeSnapshot: Schema.String },
})

export const Finalized = define({
  type: "session.checkpoint.finalized",
  durable: { version: 1, aggregate: "session" },
  schema: {
    sessionID: Session.ID, checkpointID: CheckpointID, status: CheckpointStatus,
    additions: Schema.Number, deletions: Schema.Number, files: Schema.Number,
    excluded: Schema.optional(Schema.Boolean),        // 2MiB surfacing (ADDITIVE)
    epochMismatch: Schema.optional(Schema.Boolean),   // (ADDITIVE)
  },
})

export const Error = define({
  type: "session.checkpoint.error",
  durable: { version: 1, aggregate: "session" },
  schema: { sessionID: Session.ID, checkpointID: CheckpointID, error: Schema.Struct({ code: Schema.String, message: Schema.String }) },
})

export const Recovered = define({
  type: "session.checkpoint.recovered",
  durable: { version: 1, aggregate: "session" },
  schema: { sessionID: Session.ID, checkpointID: CheckpointID },
})

// NEW (revert orchestration, assignment §events) — checkpoint-api owns this
export const Reverted = define({
  type: "session.checkpoint.reverted",
  durable: { version: 1, aggregate: "session" },
  schema: {
    sessionID: Session.ID,
    checkpointID: CheckpointID,         // target reverted TO
    targetSnapshot: Schema.String,      // after_snapshot restored
    preRevertCheckpointID: Schema.optional(CheckpointID), // undo point
    truncatedCheckpoints: Schema.Number,
  },
})

export const Event = { Created, Finalized, Error, Recovered, Reverted,
  Definitions: inventory(Created, Finalized, Error, Recovered, Reverted) }
```

**Coordination note for `checkpoint-lifecycle`:** I am extending `Finalized` with two additive optional booleans (`excluded`, `epochMismatch`) so the 2 MiB / epoch warning can be driven from the event stream without a refetch. If you'd rather keep `Finalized` minimal and have the UI refetch `list`, say so — otherwise I'll align the publisher to emit them.

---

## 4. Revert orchestration (assignment: `Snapshot.restore/checkout` + truncate future rows + refresh index + pre-revert snapshot)

Implemented as a new `SessionCheckpointRevert` service (or an extension of `SessionRevert`) invoked by the `session.checkpoint.revert` handler. It coordinates with `checkpoint-core` (domain rows) and `Snapshot` (filesystem). Acquires the per-worktree capture lock (lifecycle §3.1) to avoid racing a live capture.

```
1. PRECONDITIONS
   - session not busy (ConflictError)
   - checkpoint belongs to session (CheckpointNotFoundError)
   - after_snapshot resolvable (Snapshot.retain already pinned it; CheckpointEpochError if epoch mismatch)
   - no concurrent run generation changed since request

2. SAFETY CAPTURE (pre-revert snapshot)
   preRevert = snapshot.track()                       // current live state
   preRevertCp = Checkpoint.create({                  // undo point, kind "pre-revert"
     sessionID, userMessageID: <synthetic>, beforeSnapshot: preRevert, afterSnapshot: preRevert,
     status: "ready", kind: "pre-revert" })

3. RESTORE FILESYSTEM  (Snapshot.restore/checkout — shadow git only)
   snapshot.restore(checkpoint.afterSnapshot)         // read-tree + checkout-index -a -f
   // does NOT touch user's real HEAD / branch / staging index (shadow repo)

4. REFRESH INDEX
   snapshot.track()                                  // re-sync shadow index to restored state
   // app re-reads worktree via existing filesystem/status events

5. TRUNCATE FUTURE ROWS (logical timeline)
   Checkpoint.transition/delete: drop checkpoint rows with ordinal > target.ordinal
     (keep preRevertCp). Mirrors T3 "delete future checkpoint refs".
   SessionRevert.cleanup-style: remove messages after target causal point
     (target.userMessageID / assistantMessageID), patch parts after target.

6. RECOMPUTE DERIVED STATE
   SessionSummary.computeDiff over remaining messages -> storage.write session_diff
   events.publish(Session.Event.Diff, { sessionID, diff })
   sessions.setRevert / metadata refresh (reuse existing SessionRevert plumbing)

7. PUBLISH (single coherent event, after state consistent)
   events.publish(Checkpoint.Event.Reverted, { sessionID, checkpointID, targetSnapshot,
     preRevertCheckpointID: preRevertCp.id, truncatedCheckpoints })
   return Session.Info                                // client re-renders
```

- **Unrevert preserved:** `preRevertCp` (kind `pre-revert`) is a normal checkpoint, so `session.checkpoint.revert` to it restores the pre-revert state. Existing `SessionRevert.unrevert` semantics are retained for the legacy message-revert path.
- **v1 mode:** `discard-current` only (overwrites uncommitted working-tree changes). `preserve-current` is accepted in the schema but may return `CheckpointUnsupportedError` until stash/merge is built (documented in UX).

---

## 5. 2 MiB partial warnings (assignment: surface partial warnings)

- `Snapshot.excludedFiles(from,to)` reports files blocked by the 2 MiB new-file limit. `CheckpointLifecycle.finalize` sets `excluded = true` and `status = "partial"` when exclusions exist (lifecycle §3.2/§4).
- **API surface:** `CheckpointInfo.excluded: CheckpointExcluded[]` (paths + `reason: "new-file-too-large"` + size) and `epochMismatch: boolean`. `CheckpointDiff.partial` echoes it for the selected range.
- **Event surface:** `Finalized.excluded` / `epochMismatch` booleans (additive, §3).
- **UX:** when `status === "partial"`, the checkpoint chip/timeline row shows a warning state; hovering/expanding lists the excluded paths with sizes and the copy *"Project changes tracked by OpenCode snapshots — files >2 MiB were not captured"* (handoff §73 wording). Never claim "complete filesystem restore point."

---

## 6. Agent tools (assignment: `checkpoint_list/diff/revert/create_manual` so agents recover)

Tools call the domain service directly (not HTTP), registered in `tool/registry.ts`, implemented in `tool/checkpoint.ts` (one file, four `Tool.define`). Dependencies: `SessionCheckpoint.Service`, `Snapshot.Service`, `Session.Service`, extended `SessionRevert`/`SessionCheckpointRevert`.

```ts
// checkpoint_list
Tool.define("checkpoint_list", Effect.gen(function* () {
  const cp = yield* SessionCheckpoint.Service
  const sessionID = yield* currentSessionID()        // resolves from agent context if omitted
  return yield* cp.list(sessionID)
}))
// params: { sessionID?: Session.ID, limit?: number, status?: CheckpointStatus }
// returns CheckpointInfo[]

// checkpoint_diff
Tool.define("checkpoint_diff", Effect.gen(function* () {
  const cp = yield* SessionCheckpoint.Service; const snap = yield* Snapshot.Service
  // resolve from/to checkpoint rows -> diffFull(before, after) or cumulative baseline->after
  ...
}))
// params: { sessionID?, checkpointID?, from?, to?, mode?: "turn"|"session", raw?: boolean }
// returns FileDiff[] (or string when raw)

// checkpoint_revert
Tool.define("checkpoint_revert", Effect.gen(function* () {
  const revert = yield* SessionCheckpointRevert.Service
  return yield* revert.revert({ sessionID, checkpointID, mode })
}))
// params: { sessionID?, checkpointID: CheckpointID, mode?: "discard-current"|"preserve-current" }
// returns Session.Info

// checkpoint_create_manual
Tool.define("checkpoint_create_manual", Effect.gen(function* () {
  const cp = yield* SessionCheckpoint.Service; const snap = yield* Snapshot.Service
  const after = yield* snap.track()
  return yield* cp.create({ sessionID, userMessageID: <synthetic>, beforeSnapshot: after, afterSnapshot: after, kind: "manual", status: "ready", label })
}))
// params: { sessionID?, label?: string } -> CheckpointInfo
```

**Permission gating (premium agent UX — low friction to recover):**
- `checkpoint_list` / `checkpoint_diff` / `checkpoint_create_manual` → read-only / non-destructive → **no permission prompt** (like `read`/`glob`).
- `checkpoint_revert` → destructive filesystem + conversation change → **requires permission approval** (like `edit`/`write`), with a clear confirmation stating which later turns will be removed and that an undo point is saved.

These tools let an agent that "fucked up" a turn: list checkpoints → diff the bad turn → revert to the last known-good checkpoint, all inline. This is the core premium recovery loop.

---

## 7. CLI (assignment: + CLI so agents/users recover)

Following the existing CLI `Spec` + `debug` subcommand pattern (`packages/cli/src/commands/commands.ts`, `handlers/debug/*`):

```
opencode debug checkpoints <session> [--status=] [--limit=]
opencode debug checkpoint <session> <checkpointID>
opencode debug checkpoint-diff <session> [--from=] [--to=] [--cumulative] [--raw]
opencode debug checkpoint-revert <session> <checkpointID> [--mode=discard-current]
opencode debug checkpoint-create <session> [--label=]
```

These call the same domain services (server-side debug handler) and print the `CheckpointInfo` / `FileDiff[]` / confirmation. Mirrors handoff §85 (`opencode debug checkpoints <session>`, `opencode debug checkpoint-diff <session> <ordinal>` — ordinal is resolved to `checkpointID` by the handler).

---

## 8. UI modes: TURN | SESSION | WORKTREE + turn chips (assignment)

Header toggle (handoff §39.2, §91):
- **TURN** — selected turn's `before → after` diff. Chips: `[All] [1] [2] [3] …`.
- **SESSION** — baseline → selected/latest (cumulative). `cumulative=true` on the diff endpoint.
- **WORKTREE** — live current state via existing source-control/diff facilities (NOT a checkpoint); keeps the three concepts distinct (handoff §17, #1590).

**Turn chips** (each top-level user turn → one chip), driven by `list`:
```
[All] [1 · 4f +42 -8] [2 · 12f +88 -15] [3 · 0f] [4 · ⚠ partial]
```
- status color: `ready` normal, `partial` warning (⚠, lists excluded files on hover), `error` destructive/retry affordance, `capturing` subtle spinner only while genuinely pending.
- chip click → loads `session.checkpoint.diff?to=<id>` (TURN) or `?cumulative=true&to=<id>` (SESSION).

**Placement (handoff §91 Concept B + C):** message-attached summary row (`3 files +42 -8 · View changes · Restore`) for quick access, plus a dedicated review sidebar (`Changes / Turn 8 · 5 files …`) for full inspection. Reuse OpenCode's existing structured diff renderer (handoff §39.3) — no second diff library.

**Revert affordance:** checkpoint menu → `View turn diff` / `View changes through here` / `Restore workspace to here…`. Confirmation states precisely: later turns removed, uncommitted changes overwritten (mode), undo point saved, ignored files untouched, >2 MiB files not represented (handoff §39.4).

---

## 9. Open coordination points

- **`checkpoint-core`:** build `SessionCheckpoint.Service` + `session_checkpoint` table + `Snapshot.retain/release/epoch/excludedFiles`; extend `SessionRevert` (or add `SessionCheckpointRevert`) for the §4 flow (truncate future rows, pre-revert row, recompute). API depends on exactly that interface.
- **`checkpoint-lifecycle`:** publish the 4 lifecycle events; confirm the additive `excluded`/`epochMismatch` on `Finalized` (§3) and that `reverted` is owned by the revert path (§3). Capture lock must also be taken by revert (§4 step 1).
- **API surface owner (`checkpoint-api`):** defines the 6 endpoints (§2), the 5 events (§3), the 4 tools + CLI (§6–7), and the UI data contract (§8). Regenerates the SDK after protocol edits.

## 10. Acceptance mapping (handoff §82)
- #9/10/11 branch/staging/ignored untouched → shadow-git only (§4 step 3).
- #12/13 existing revert still works → §4 reuses `SessionRevert` plumbing; legacy path unchanged.
- #14 unrevert retained → `pre-revert` checkpoint (§4 step 2, §7).
- Enhanced: file summaries without giant raw diff (§2.3 structured), content-addressed diff cache (lifecycle §9), epoch mismatch rejected (§2.4), large-file exclusions visible (§5), manual checkpoint API without schema redesign (§2.2 `kind: manual`).
