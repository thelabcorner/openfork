# Session / Turn Consumer Provenance Audit Ledger

**Started:** 2026-09-19  
**Status:** current-tree census closed; keep as a watch ledger for concurrently landing producers (especially Swarm)  
**Scope:** every production consumer that reads, classifies, transforms, groups, replays, exports, summarizes, compacts, forks, reverts, searches, shares, syncs, titles, revises, audits, checkpoints, dispatches, or otherwise derives semantics from Sessions, messages, turns, parts, or Session producer metadata.

This ledger is the durable source of truth for the audit. The governing rule is:

> identify the semantic question first, then consume the narrow authoritative projection for that question.

Provider role, Session metadata, part syntheticness, message shape, adjacency, timestamps, and rendered text are not interchangeable semantic facts.

## 0. Semantic axes

Every consumer must be classified against one or more of these independent axes:

1. **Aggregate producer identity** — which subsystem owns the Session aggregate (`SessionMetadataOwnership`).
2. **Turn owner** — user vs host.
3. **Semantic message kind** — user / synthetic / shell / compaction / assistant.
4. **Worker-root eligibility** — may this turn establish the worker objective/model/policy?
5. **Goal authorization** — may this turn authorize user-owned Goal lifecycle creation/action?
6. **Causal lineage** — which canonical worker root does a derived host turn continue?
7. **State semantics + lifetime** — STATE-shaped semantic kind is distinct from
   current replaceable STATE lifetime. Historical STATE retains structural
   identity but never live authority.
8. **Provider projection** — wire role/content required by the LLM provider.
9. **Presentation classification** — how the UI/ACP/CLI labels or renders the turn.
10. **Correlation identity** — durable operation/run/projection identity used for retry/replay/idempotence.

No consumer may answer one axis from another merely because historical V1 shape made them coincide.

## 1. Repository-generation rules

- V1/OpenCode is the mature production execution/runtime target.
- Current/Core is the semantic/reference donor and shared-implementation owner where appropriate.
- V2/new-layout is the primary UI generation, not evidence of current-runtime ownership.
- Shared provenance vocabulary/policy belongs in Schema.
- V1 legacy inference stays centralized in `packages/core/src/v1/session-turn-provenance.ts`.
- Public prompt APIs do not accept caller-authored provenance. Trusted producers stamp it at server/runtime seams.

## 2. Consumer census

### 2.1 Worker execution / authority

| Consumer | Semantic question | Current mechanism | Status |
| --- | --- | --- | --- |
| V1 `SessionPrompt` worker root | canonical objective / causal root | `SessionTurnProvenance.isWorkerPromptTurn`, `causalRootMessageID` | audited; aligned |
| V1 checkpoint root | canonical worker root | `checkpointRootMessageID` | audited; aligned |
| Goal tool authorization | user Goal authorization | `isGoalAuthorizationTurn` | audited; mostly aligned; text extraction still under review |
| Task tool delegated authority | canonical worker root / causal lineage | provenance-aware exact-root reload | audited; aligned |
| Plan tool model/agent root | worker root | `isWorkerPromptTurn` | audited; aligned |
| Session tool model/agent recovery | worker root | `isWorkerPromptTurn` | audited; aligned |
| Scheduled task execution | host worker root + correlation | `scheduled-task.run` via trusted `hostPrompt` | audited; aligned |
| Swarm provenance vocabulary | host worker roots / derived lineage + durable correlation | Schema policy requires host ownership and correlation for assignment/peer/recovery/notice; continuation additionally requires canonical causal root | policy audited; producers are concurrent/in-progress and require E2E census as they land |
| Background shell completion | derived host notification rooted in launch objective | `background.shell.summary` + launch-time `sourceMessageID` + job correlation; stale roots fail closed in `hostPrompt` | repaired + proven |

### 2.2 Goal state / Goal UI / Goal Revisor

| Consumer | Finding | Status |
| --- | --- | --- |
| Goal mutable spec/progress -> worker context | owned by durable `goal.spec` / `goal.progress` STATE projection | aligned |
| Goal Revisor | first-class `goal_revisor` special-agent identity; deterministic Session-owned child transcript; `includeSessionContext:false` changes context injection, not ownership | repaired + proven |
| Goal Revisor provenance | `special-agent.goal-revisor` is distinct from Prompt Revisor | repaired + proven |
| Goal start/update action | immutable `goal.start` / `goal.update` action roots contain canonical server-owned action text; mutable objective/progress remains in Goal STATE | repaired + proven |
| Goal dispatch admission | trusted `POST /session/:sessionID/goal/dispatch` derives text/provenance server-side and validates focused Goal/revision/state | repaired + HTTP E2E proven |
| Goal authorization | Goal action roots are semantic user/worker roots but are not themselves Goal-creation authorization | aligned + proven |

Target architecture:

```text
user Goal action
  -> Goal durable state mutation
  -> GoalProjection publishes/reconciles current STATE
  -> explicit action-intent worker root (start/update), no copied Goal snapshot
```

The action turn should express only the user-authorized operation (for example,
“Begin the focused Goal.” / “Continue with the updated focused Goal.”). Current
Goal details remain exclusively in `goal.spec` / `goal.progress` STATE.

### 2.3 Special agents / host helpers

| Producer | Aggregate identity | Turn source | Durable transcript | Status |
| --- | --- | --- | --- | --- |
| Prompt Revisor | `prompt_revisor` | `special-agent.prompt-revisor` | when Session-owned | aligned |
| Session Title | `session_title` | `special-agent.session-title` | yes | aligned |
| Goal Auditor | `goal_auditor` | `special-agent.goal-auditor` | yes | aligned |
| SPAD Auditor | `spad_auditor` | `special-agent.spad-auditor` | yes | aligned |
| Goal Revisor | `goal_revisor` | `special-agent.goal-revisor` | deterministic Session-owned child | aligned + proven |
| project-copy name helper | ephemeral helper | `host-helper.project-copy-name` | intentionally no child transcript | aligned |

All registered special-agent child Sessions are non-promptable by the normal worker loop. `SpecialAgentSession.settleTurn()` fails unresolved tool calls before ending a provider turn.

Producer-owned aggregate identity is also enforced at the public Session boundary,
not merely at prompt admission. V1 generic public update/delete/fork/share/revert,
pause/resume/abort/title/summarize/init and message/part mutation reject producer-
owned Sessions. Current/Core consumes an O(1) hidden ownership projection from the
shared `session.metadata` row, so Current public mutation/control routes cannot
take over V1 scheduler/special-agent aggregates even though Current `Session.Info`
deliberately does not expose the V1 metadata compatibility bag.

### 2.4 Compaction / fork / revert / summary

| Consumer | Semantic question | Current mechanism | Status |
| --- | --- | --- | --- |
| V1 compaction user-turn counting | semantic user turn | `isSemanticUserTurn` | audited; aligned |
| V1 compaction replay eligibility | semantic user turn | provenance selector | audited; aligned |
| V1 manual summarize | current worker root/model | `findLast(isWorkerPromptTurn)` | audited; aligned |
| V1 fork planner | completed structural turn boundary | STATE-shaped rows are transparent; current STATE is not cloned; historical rows preserve history without authority | audited; aligned |
| V1 revert | live semantic-user rollback boundary | semantic-user + worker-root qualification prevents imported historical users becoming rollback owners | repaired; focused suite exposed unrelated dirty-tree ChunkDB FK/timing failures |
| Current compaction summary | historical events only | live and historical STATE-shaped projections excluded from immutable summary serialization | repaired + 5/5 focused proof |
| V1 compaction summary | historical events only | live and historical STATE-shaped projections excluded from immutable summary serialization | repaired + focused proof |
| Current provider context | live provider projection | historical STATE-shaped rows are transparent; current STATE is reprojected from authoritative owner | repaired + 7/7 message-lowering proof |
| V1 provider context | live provider projection | historical STATE-shaped rows are transparent; current STATE collapses by source immediately before active turn | repaired + focused proof |

### 2.5 Replay / share / CLI / ACP

| Consumer | Finding | Status |
| --- | --- | --- |
| Share full sync model discovery | worker roots only | uses `isWorkerPromptTurn`; aligned |
| ACP replay user chunks | human/semantic-user presentation | uses `isSemanticUserInfo`; aligned |
| CLI replay/session reconstruction | semantic user turns | provenance-aware selectors; aligned |
| CLI session turn extraction | semantic user turn | `isSemanticUserInfo`; aligned |
| CLI import | historical authorship only | producer-owned Session metadata stripped; imported turns stamped `lifetime:"historical"`; orphan Goal STATE omitted, including already-historical STATE-shaped rows | repaired + 9/9 proof |

### 2.6 App / timeline / browser model

| Consumer | Finding | Status |
| --- | --- | --- |
| Browser presentation classification | `userTurnPresentation` uses Schema provenance | aligned |
| Browser worker-root classification | `isWorkerPromptMessage` uses Schema provenance | aligned |
| Current STATE normalization | state snapshots remain transparent to assistant parenting | aligned |
| Historical STATE normalization | remains renderable history but cannot become assistant parent/current STATE | repaired + 8/8 normalization proof |
| Message-page orphan-parent hydration | conversation-parent selector + explicit causal-root pagination; STATE-shaped rows are transparent regardless lifetime | repaired + focused server-session proof |
| Model/agent restoration | latest visible semantic user is filtered again through live worker-root eligibility before restoring execution state | repaired + pure browser-safe selector proof |
| Fork dialog | STATE-shaped rows are not offered as structural fork boundaries regardless lifetime | repaired |
| Session context tab / metrics | uses `part.synthetic` to select visible text | under review: presentation-only unless used as semantic authority |
| Timeline rows/system-injection | uses part syntheticness for rendering | under review |

### 2.7 TUI / mobile / session-ui

Raw role and `part.synthetic` uses remain, but audited action paths now separate
presentation from authority. TUI liveness excludes historical and live STATE;
prompt/model restoration uses worker-root qualification; undo/redo now requires
a live semantic-user worker root and uses transcript order rather than message-ID
lexical ordering. Session-UI throughput treats historical STATE as structurally
transparent without reviving live STATE authority.

### 2.8 Provider / plugin transport

Raw provider-role operations in provider transforms, Claude runtime, Workbuddy, Verdent, etc. are not automatically defects. They operate after semantic lowering in many cases. Each use must be proven to be wire/protocol behavior rather than domain ownership inference before being left unchanged.

Audited examples:

- Claude external runtime's `ModelMessage.role` checks operate after canonical
  lowering; external resume identity comes from explicit OpenCode↔Claude binding,
  not provider role.
- WorkBuddy/Verdent user-message counts operate on provider-wire request arrays,
  not Session ownership.
- Copilot `x-initiator` derives from canonical provenance before provider
  projection; legacy fallback is centralized in the V1 resolver.

### 2.9 Public Session / protocol control

| Surface | Semantic question | Finding | Status |
| --- | --- | --- | --- |
| V1 public prompt/command/shell/init | may a generic caller establish worker execution? | `requireInteractiveSession`: producer-owned roots and child Sessions fail closed | repaired + proven |
| V1 aggregate mutation/control | may a generic caller mutate/control a producer-owned aggregate? | centralized `authorizePublicMutableSession` / `requirePublicMutableSession`; read-only routes remain readable | repaired + proven |
| V1 message/part mutation | may public editing rewrite a host-owned `role:user` turn? | exact-message provenance authorization; live host turns rejected, legacy user rows stabilized before shape edits | repaired + same-role semantic regression |
| Current public mutation/control | can Current mutate a V1 producer-owned row through the shared table while metadata is hidden from Current `Session.Info`? | `SessionV2.producerOwned()` reads only the indexed durable metadata column; public switch/prompt/compact/revert/interrupt/pause/resume/title/checkpoint mutations reject producer ownership | repaired + 36-assertion cross-generation HTTP proof |
| Current public prompt child admission | can provider-role/root shape bypass parent authority? | existing Core `OperationUnavailableError` is now mapped to typed public `InvalidRequestError` | repaired + proven |
| Current permission creation | may a generic caller mint a new human-authorization request on a producer-owned aggregate? | producer ownership checked before `PermissionV2.ask` | repaired + included in cross-generation proof |
| Permission/question reply/reject | may a human answer an exact pending interaction? | exact pending request + Session ownership is the authority; producer-owned Sessions remain answerable | audited; intentionally allowed |
| Current read surfaces | may producer-owned history/message/context/checkpoint state be inspected? | ownership does not block read-only detail/history APIs | audited; intentionally allowed |
| Protocol prompt/create input | can callers forge turn provenance or producer metadata? | neither public prompt nor Current create exposes caller-authored provenance/producer metadata | audited; aligned |

## 3. Checkpoint ownership / rollback proof

- Logical checkpoint identity is `(session_id, user_message_id)`; same-root
  re-entry reopens the existing row, preserving checkpoint ID, ordinal, and the
  original `before_snapshot`.
- `begin()` finalization wait + allocation/reopen + `active` registration are
  one per-Session critical section. A 16-way concurrent begin regression proves
  one authoritative handle.
- Retention refs are owner-scoped:
  `checkpoint/<checkpoint-id>/<before|after>/<tree>`. Identical tree hashes
  retained by separate checkpoints no longer share releasable ownership.
- Reopen replacement is ordered retain-new → durable CAS → release-old.
  Capturing rows preserve the last committed `after_snapshot` as a crash-safe
  recovery anchor.
- Bounded retention reconciliation scans owner refs in pages, preserves in-flight
  capturing ownership, and prunes orphan/stale refs after settlement. Maintenance
  is instance-owned/scoped rather than a global timer retaining `InstanceRef`.
- V1 checkpoint suite: **11/11 passing** with a 30s per-test ceiling; Core
  snapshot suite: **5/5 passing**.
- Worktree contention remains intentionally detect-and-warn. A checkpoint is
  filesystem history, not perfect causal attribution under concurrent writers.

## 4. Historical/imported invariants now proven

1. Historical turns can preserve authorship/presentation but cannot become
   worker roots, Goal authorization, live host authority, causal roots, current
   STATE, or live correlation owners.
2. Historical rows are transparent to current-worker-root discovery; they do not
   erase an earlier live root merely by occupying the tail of history.
3. STATE semantic kind is distinct from current mutable STATE lifetime.
   Historical Goal STATE remains STATE-shaped for structural algorithms while
   `isStateProjection` remains live-only.
4. Historical STATE is transparent to assistant parenting, pagination root
   hydration, throughput turn boundaries, V1/current provider context, and
   compaction summaries.
5. Import strips producer-owned aggregate metadata and cannot reactivate an
   imported special-agent/scheduler Session.

## 5. Census closeout and watchpoints

The current production tree's previously open buckets are classified:

- App timeline row/system-injection and context-tab/model-metric
  `part.synthetic` checks are presentation/audience/performance measurements,
  not ownership or authority.
- Session group SQL metadata predicates are bounded candidate prefilters; semantic
  ownership is resolved through `SessionMetadataOwnership`. Public create/import/
  fork paths cannot mint or clone producer identity.
- Background monitor observations are queued context/wake signals, not durable
  user-shaped authority. Question/Permission gating is explicit. Background shell
  completion is a derived host turn with launch-root lineage and stale-root rejection.
- First-party Core Swarm currently ends at durable delivery/input admission and
  does not yet produce live Session turns. Legacy `packages/opencode/src/tool/swarm/*`
  helpers are not wired as production Session producers. Re-audit any concurrent
  Swarm landing that begins writing Session input/messages; do not infer safety
  merely from the registered Swarm source vocabulary.
- Current/V2 protocol, server, and client reducers preserve provenance and do not
  expose caller-authored provenance. Cross-generation producer ownership is now
  enforced despite Current `Session.Info` hiding the V1 compatibility metadata bag.
- Plugin transforms receive isolated provider-context clones; WorkBuddy/Verdent
  role counts are provider-wire heuristics; Copilot initiator ownership is resolved
  from canonical provenance before lowering.

Already classified/repaired across this campaign:

- `session/reminders.ts`: reminder insertion now targets the latest live
  provenance-qualified worker root, not a historical presentation-user row.
- `tool/plan.ts`: model lookup is worker-root qualified.
- `tool/task.ts`: delegation follows exact canonical causal lineage and
  exact-loads compacted-away roots.
- `session/revert.ts`: rollback snapping cannot select historical semantic users.
- Scheduled tasks: durable run ID + Session metadata + persisted run↔Session
  binding + trusted `scheduled-task.run` host prompt.
- Titles: per-Session/baseline apply semantics prevent an in-flight generated
  title overwriting a manual rename.
- SPAD: audit queue is bounded, excess evidence remains queued, detached work is
  scope-owned and per-audit timeout bounded.
- V1 context compiler/ledger: STATE-shaped records reject/ignore context
  overlays regardless of lifetime. Historical STATE therefore cannot be
  edited/pinned/excluded into a new structural meaning; focused regression green.
- Mobile transcript: semantic-user rendering uses Schema provenance; host
  automation source labels are presentation-only.
- TUI transcript/dialog/fork `part.synthetic` checks are prompt restoration or
  presentation filtering. Fork navigation uses semantic-user presentation;
  execution/undo/model restoration is separately worker-root qualified.
- ACP replay: provider-role gating is followed by
  `isSemanticUserInfo` before emitting user chunks. ACP `part.synthetic`
  audience mapping is wire/presentation metadata only.
- CLI export: role checks discriminate schema fields for lossless/redacted
  serialization; they do not infer authority. CLI run/replay semantic-user
  inclusion is provenance-qualified.

Current watchpoints rather than known open defects:

- Any new Swarm→Session producer must stamp the registered canonical source,
  durable correlation, and required causal worker root at the producer boundary.
- Any new public Session mutation/control endpoint must consume aggregate producer
  ownership before side effects; read-only endpoints should not be fenced merely
  because a Session is producer-owned.
- Any new provider-role `user` consumer must state whether it is answering a wire/
  structural question or an authority question. Authority consumers must use the
  canonical provenance predicates.

## 6. Verification requirements

For every repaired consumer, add a regression that distinguishes at least two turns that share the same provider role but differ semantically (for example real user vs Goal STATE, user Goal action vs host continuation, or Prompt Revisor vs Goal Revisor). Prefer exact semantic assertions over snapshots.

Performance requirements:

- no new full-history scans where an already-loaded projection exists;
- no new per-row UI hydration;
- no duplicate provider/model resolution solely for provenance;
- exact-ID reload is allowed for compacted-away causal roots;
- provenance classification must remain O(1).

### Closeout verification (2026-09-19)

- Background-shell provenance tranche: Schema **4/4**, Core provenance **9/9**,
  background runtime **24/24** — **37/37** focused tests passing.
- V1 public ownership proofs: producer-metadata/update/fork **1/1**; scheduled
  generic interactive/mutation fence **1/1** with **20** assertions; host-owned
  `role:user` part/message mutation **1/1** with **4** assertions.
- Cross-generation Current public ownership proof: **1/1**, **36** assertions,
  covering hidden metadata, switch-agent/model, prompt, compact, revert,
  interrupt, pause/resume, title regeneration, permission creation, checkpoint
  create/revert, durable no-mutation checks, and child-prompt rejection.
- Protocol Session + Permission groups: scoped TypeScript diagnostics **0**.
- Core/Server scoped checks report only pre-existing environment diagnostics
  (`bun:*` typings and missing command text assets); no P0/P1 diagnostic is
  reported in the edited ownership/protocol files.

