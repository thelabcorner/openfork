# V1 / Current Turn Provenance Convergence / Adversarial Architecture Ledger

**Status:** Architecture converged; focused verification complete; repository-wide production checks remain blocked by unrelated concurrent worktree diagnostics
**Started:** 2026-09-18
**Scope:** V1 Session message semantics, Goal continuation isolation, V2 behavioral backport, ownership-sensitive consumers, provider/cache correctness, fork/compaction/replay behavior, CLI/ACP/share projections, and adjacent Goal Auditor findings exposed by this work.

This document is the **living source of truth for this campaign**. Update it whenever a new architectural fact, regression, invariant, benchmark, or unresolved risk is discovered. Do not rely on chat context as the canonical record.

---

## 0. Working Rules

The governing repository contracts are:

- root `AGENTS.md`
- `packages/core/AGENTS.md`
- `packages/opencode/AGENTS.md`
- `packages/schema/AGENTS.md`
- package/test-specific `AGENTS.md` files where applicable

The important architecture rules applied throughout this work are:

1. **Producer-owned source of truth.** If a producer knows a semantic fact when creating durable state, persist it there. Do not reconstruct it later from history, content shape, UI state, or text markers.
2. **Bottom-up cross-layer design.** Schema/durable state -> domain helpers -> runtime consumers -> transport/client projections -> UI.
3. **No dependency inversion.** Core cannot import OpenCode runtime semantics merely because OpenCode currently has a convenient helper.
4. **Provider protocol is not domain semantics.** A provider-required role such as `"user"` must not become the domain's definition of human/user ownership.
5. **Prefer O(1) materialized metadata over history scans.**
6. **Do not hand-edit generated SDK output.** Regenerate from the authoritative wire/API surface.
7. **Preserve the shared dirty worktree.** No broad resets, stashes, normalization, or staging.
8. **Performance is architectural.** Avoid introducing extra DB reads, message scans, instance creation, prompt bytes, provider cache busting, or duplicate runtime stacks.

### 0.1 Repository-map alignment

The repository maps (`docs/map/v1-v2.md`, `architecture.md`, `packages.md`,
`surfaces.md`, `upstream-fork.md`, and `source-tree.md`) make an important
boundary explicit:

- **V1 remains a first-class OpenFork production surface.** It is not a legacy
  runtime that should be mechanically rewritten into current/V2.
- **Current/V2 is a semantic/reference architecture and selective backport
  donor.** Reuse superior ownership laws and mechanisms; do not pursue parity
  merely by copying its storage/execution shape.
- **Shared laws belong at the lowest correct shared owner.** Browser-safe
  provenance vocabulary/policy belongs in Schema; Core owns durable/runtime
  projection and the V1 legacy resolver; OpenCode owns only V1-specific runtime
  adaptation.
- **Presentation consumes browser-safe semantics.** App/session-ui must not
  import Core runtime ownership logic just because provider compatibility uses
  `role=user`.

For this campaign, "convergence" therefore means semantic agreement and correct
ownership/lifetime boundaries, not V1 -> V2 structural replacement.

---

## 1. Original Root Cause: Goal Continuation Was Put in Worker System Context

The original Goal continuation architecture had a structural defect:

```text
auditor verdict
  -> continuation prompt
  -> worker SYSTEM prompt array
  -> worker generation
```

The continuation was host-authored orchestration, but because no durable user-role turn was created, the only remaining channel was the privileged system channel.

This caused three observable defect classes:

### 1.1 Role contamination

Auditor/orchestration language appeared in the worker's highest-authority context. The worker could reason about:

- waiting for the auditor,
- whether it should behave like an auditor,
- whether the cycle was complete,
- whether it should stop rather than continue concrete work.

This looked like the auditor process had become the worker. The process runtimes were actually separate; the **return channel** was contaminated.

### 1.2 Provider-cache destruction

The continuation text changed every audit cycle because it embedded fresh rationale / continuation instructions.

Because it lived in the system prefix, each changed continuation invalidated the cached prefix after that insertion point. In long sessions this destroys otherwise reusable conversation cache.

The correct architecture appends changing continuation text as a new model-facing turn, leaving the prior system/transcript prefix stable.

### 1.3 Invisibility

The continuation was request-only system context, not a durable Session message. Therefore:

- timeline/UI could not show it correctly;
- replay/export could not distinguish it;
- checkpoint/fork logic could not identify its lineage;
- debugging required inspecting provider requests rather than durable state.

---

## 2. The Central Architecture Finding

The old V1 model conflated three independent facts:

```text
message.info.role === "user"
part.synthetic
who owns the conversational turn boundary
```

These are not equivalent.

The correct model has separate dimensions:

### 2.1 Durable turn ownership / provenance

Who owns the conversational boundary?

- `owner: "user"`
- `owner: "host"`

### 2.2 Semantic message kind

What kind of conversation entry is this?

- `user`
- `synthetic`
- `shell`
- `compaction`
- `assistant`

### 2.3 Part-level syntheticness

Was an individual content fragment synthesized by the host?

`TextPart.synthetic` remains useful for this narrower purpose.

### 2.4 Provider projection

What role does the LLM API need to receive?

Host-owned synthetic, shell, and compaction turns may all legitimately lower to:

```text
role = "user"
```

That is a transport/protocol decision, not a durable ownership fact.

---

## 3. Current/V2 Is the Semantic Reference / Backport Donor

The current/V2 architecture in this repository already models semantic message kinds directly.

Relevant current schema kinds include:

- `User`
- `Synthetic`
- `Shell`
- `Compaction`
- `System`
- `Assistant`

The current LLM lowering path intentionally maps several non-human semantic kinds to provider role `"user"`.

Therefore the desired V1 compatibility model is:

```text
Durable semantic kind               Provider projection

user          ------------------+
synthetic     ------------------+
shell         ------------------+--> role = "user"
compaction    ------------------+

assistant     ---------------------> role = "assistant"
system        ---------------------> role = "system"
```

This is not a new speculative model. Where OpenFork deliberately adopts this
capability, V1 should converge on the **semantic law** while retaining its mature
runtime/storage architecture unless a separate concrete defect justifies a
structural migration.

---

## 4. V1 Compatibility Contract

### 4.1 Message-level provenance

V1 user-role messages now have an optional durable provenance field for compatibility with historical rows.

Conceptually:

```ts
type UserTurnProvenance =
  | {
      owner: "user"
      source: string
    }
  | {
      owner: "host"
      source: string
      sourceMessageID?: MessageID
      ref?: string
    }
```

The field is optional only because old persisted rows predate the contract.

**All newly created durable V1 user-role turns should be explicitly stamped at their trusted producer.**

### 4.2 No SQL migration needed for provenance

V1 `MessageTable.data` already persists the entire V1 message payload as JSON.

Therefore provenance adds:

- no table,
- no join,
- no secondary projection,
- no history index,
- no extra database read.

This is important for the performance contract.

### 4.3 Public callers must not choose provenance

Ordinary public prompt input must not be allowed to claim:

```json
{ "owner": "host" }
```

The trusted admission/producer path stamps provenance.

Examples:

- user prompt admission -> user-owned
- slash command admission -> user-owned
- host prompt / scheduled dispatch -> host-owned
- Goal continuation -> host-owned
- compaction continuation -> host-owned

---

## 5. Central Compatibility Module

Authoritative V1 compatibility logic lives in:

`packages/core/src/v1/session-turn-provenance.ts`

This is intentionally the **only place legacy inference is allowed**.

Current source tags include:

- `prompt`
- `command`
- `shell`
- `plan.approval`
- `host.prompt`
- `scheduled-task.run`
- `task.summary`
- `goal.spec`
- `goal.progress`
- `goal.continuation`
- `recovery.continuation`
- `provider.unknown-finish.continuation`
- `compaction`
- `compaction.replay`
- `compaction.continue`
- `special-agent.prompt-revisor`
- `special-agent.session-title`
- `special-agent.goal-auditor`
- `special-agent.spad-auditor`
- `host-helper.project-copy-name`

Current semantic classifier:

```text
user | synthetic | shell | compaction | assistant
```

Important helpers currently include:

- `resolve(message)`
- `resolveInfo(info)`
- `semanticKind(message)`
- `semanticKindInfo(info)`
- `isUserOwnedTurn(message)`
- `isHostOwnedTurn(message)`
- `isSemanticUserTurn(message)`
- `isSemanticUserInfo(info)`
- `isWorkerPromptTurn(message)`
- `isWorkerPromptInfo(info)`
- `isGoalAuthorizationTurn(message)`
- `checkpointRootMessageID(message)`
- `hasHostCorrelation(message, source, ref)`

### 5.1 Why purpose-specific selectors are required

A single helper such as `isRealUserMessage()` would be another modeling error.

Examples:

- a shell invocation is user-owned but should not become the authoritative worker objective;
- a plan-approval click is user-owned but the generated durable text is semantically synthetic;
- a host-scheduled prompt may legitimately be the worker's objective even though its owner is host;
- a Goal continuation is host-owned and semantically synthetic, but must remain a provider-user turn.

Different behaviors need different predicates.

---

## 6. Producer Audit

The producer audit is intended to make explicit provenance the normal path and legacy inference exceptional.

### 6.1 Durable V1 producers already stamped

The following producer classes are currently stamped:

- ordinary prompt admission
- slash/command admission
- host prompt admission
- scheduled-task run admission (`owner=host`, semantic Synthetic worker root,
  `ref=scheduled_task_run.id`)
- shell invocation
- plan approval
- task-tool summary continuation
- Goal continuation
- Goal recovery continuation
- compaction marker turn
- compaction replay
- compaction continuation
- Prompt Revisor host operation transcript
- Session Title host operation transcript, including the mature V1 production title path
- Goal Auditor host operation transcript
- SPAD Auditor host operation transcript

### 6.2 Provider-only user-role anchors are non-durable but still explicitly owned

Some `role: "user"` constructions are not persisted V1 conversational turns at all.

Examples include:

- special-agent V1 provider compatibility anchors
- temporary model-generation prompts
- provider transforms
- project-copy name-generation prompts
- provider-specific compatibility messages

These remain provider-role constructs and do **not** become durable V1 turns merely
to satisfy the legacy LLM API. However, any such object that enters the V1 LLM
stack now carries explicit ownership when its semantic producer is known. In
particular:

- Prompt Revisor, Session Title, Goal Auditor, and SPAD Auditor V1 anchors are
  `owner=host`, semantic Synthetic, and cannot become worker roots or Goal
  authorization turns;
- project-copy name generation uses `host-helper.project-copy-name` rather than
  falling through to the legacy unstamped-human compatibility rule;
- compaction is different: it already owns a durable `host/compaction` V1 row,
  and that exact row remains its LLM anchor.

Do **not** manufacture a durable V1 message solely for request preparation, but
also do not leave known host helpers unstamped and let legacy inference classify
them as human-owned.

### 6.3 Special-agent aggregate ownership and turn provenance are separate axes

`SessionMetadataOwnership` protects the small producer-owned Session metadata
envelope (`specialAgent`, owner kind/id) used for aggregate lifecycle, grouping,
and execution admission. That metadata does not grant conversational authority.

Turn provenance independently records who/what authored each conversational
turn. `SpecialAgentSession.SourceByKind` is exhaustive over the closed special
agent kind set, so adding a first-party special agent requires assigning a
canonical provenance source. Each logical special-agent operation publishes one
durable host-owned Synthetic origin prompt into its deterministic child Session.

The normal worker loop rejects every special-agent aggregate, regardless of
whether the attempted caller is user- or host-originated. This is aggregate
ownership enforcement, not a substitute for worker-root/Goal-authority selectors.

Special-agent provider-turn settlement is also fail-closed. Producers publish
the real success/error result for every interpreted tool call before `Step.Ended`;
`SpecialAgentSession.settleTurn()` then fails any tool still unresolved in the
publisher-owned current-turn registry. Replay therefore cannot contain a
successfully ended special-agent assistant with a dangling pending/running tool.

### 6.4 Special-agent provenance/settlement verification

Focused closeout after the shared settlement fail-safe and SPAD producer E2E:

- Core Session Title: 28 passed / 0 failed / 75 assertions;
- Core Prompt Revisor: 40 passed / 0 failed / 175 assertions;
- Core Goal Auditor: 17 passed / 0 failed / 96 assertions;
- OpenCode protected special-agent worker admission + SPAD auditor E2E:
  5 passed / 0 failed / 14 assertions;
- V1 production title HTTP generation/repair: 3 passed / 0 failed / 17 assertions;
- browser-safe provenance schema: 4 passed / 0 failed / 24 assertions;
- V1 provenance compatibility schema: 3 passed / 0 failed;
- V1 special-agent compatibility anchor: 1 passed / 0 failed / 16 assertions.

The Session Title suite includes a direct fail-safe regression: a provider-hosted
tool intentionally receives no producer settlement while `generated_title`
completes normally. The shared `SpecialAgentSession.settleTurn()` boundary marks
the forgotten tool `error` and leaves zero `pending`/`running` tool parts.

The SPAD runner regression uses deterministic canonical-period gray-zone evidence
and proves the real asynchronous auditor path publishes a host-owned Synthetic
origin prompt, cannot become a worker root or Goal authorization turn, completes
`spad_verdict`, and leaves zero dangling tools.

---

## 7. Goal Continuation Backport

The Goal continuation path has been structurally changed.

Old:

```text
auditor continuation
  -> worker system array
```

New:

```text
auditor continuation
  -> durable synthetic user-role V1 message
     provenance.owner = host
     provenance.source = goal.continuation
     provenance.sourceMessageID = originating worker prompt
     provenance.ref = reservation id
  -> provider lowering => role "user"
```

### 7.1 Idempotency

Reservation correlation is now message-level:

```text
provenance.source = goal.continuation
provenance.ref = reservation ID
```

This replaces feature-specific text-part metadata as the canonical correlation source.

### 7.2 Checkpoint lineage

The continuation also stores:

```text
provenance.sourceMessageID
```

Checkpoint recovery can therefore preserve the original user-owned rollback root even after restart.

The synthetic continuation is a durable model-facing turn boundary, not a new user-owned rollback boundary.

### 7.3 Provider/cache invariant

The changing continuation text is no longer inserted into system context.

Provider lowering still presents the durable synthetic continuation as role `"user"`, preserving protocol behavior while stabilizing the system prefix.

---

## 8. Broad Consumer Migration Completed So Far

The backport is intentionally broader than Goal Mode.

Ownership-sensitive V1 behavior already moved or started moving onto provenance / semantic kind includes:

### Goal / worker provenance

- Goal lifecycle authorization
- worker-objective selection
- worker model fallback
- Goal continuation lineage
- Goal reservation idempotency

### Session prompt/runtime

- title source selection
- worker prompt discovery across long histories
- checkpoint root selection
- user-visible text extraction for worker policy
- recovered Goal continuation behavior

### Compaction

- user-turn counting
- overflow replay source selection
- concurrent newer-user detection
- compaction serialization labels:
  - `[User]`
  - `[Shell context]`
  - `[Compaction context]`
  - `[Synthetic context]`
- replay and continuation provenance

### Revert / fork

- revert semantic-user roots
- fork composer restore only for semantic user turns

### Reminders

- user-directed reminders attach to semantic user input rather than a newer host continuation

### Session inspection / tools

- returned rows expose semantic `kind`
- owner/source attribution is available
- worker-model selection uses worker-prompt provenance

### Context ledger

The ledger projection now distinguishes synthetic/shell semantics rather than representing every user-role record as human `user`.

### HTTP/session projection

- current prompt/agent restoration uses worker-prompt provenance

### CLI

- prompt history excludes host synthetic continuations
- persisted replay does not render host continuation as human input
- live direct-mode reducer tracks semantic kind separately from provider role
- `includeUserText` renders only semantic user text

### ACP

- replay suppresses host synthetic user-role messages as human chunks
- configuration/model restore selects worker-prompt provenance rather than the latest provider-user continuation

### Share full sync

Full model sync already filters messages through `isWorkerPromptTurn`.

---

## 9. Remaining Raw `role === "user"` Audit

Every remaining raw role check must be classified. Do not mechanically replace all of them.

### 9.1 Intentionally structural/provider-role uses

These classes should generally remain role-based:

- V1 -> provider message lowering
- provider transforms
- provider/plugin compatibility logic
- Claude/provider message formatting
- tool-result/provider ordering repair
- structural user/assistant turn grouping
- assistant `parentID` grouping
- compaction marker/summary pairing
- `filterCompacted` ordering mechanics
- fork completed-turn snapping where a synthetic provider-user message is still a completed conversation boundary
- wire-shape narrowing after provenance gating

The rule is:

> If the code asks “what does the provider/conversation structure require?”, role may be correct.

### 9.2 Ownership-sensitive findings closed by this campaign

#### A. Incremental Share model synchronization — resolved

`packages/opencode/src/share/share-next.ts`

The historical incremental message watcher did approximately:

```ts
if (info.role !== "user") return
provider.getModel(info.model...)
```

Full sync already filtered to worker-prompt provenance. Incremental sync now does
the same: every durable message still synchronizes, but Provider model
resolution/model synchronization runs only for provenance-qualified worker
prompts.

**Status:** resolved and proven end-to-end. A focused Share regression publishes
Goal STATE + a derived continuation through the real subscriber, observes both
messages with provenance intact at the sync endpoint, and observes **zero**
Provider `getModel` calls.

#### B. `bypassAgentCheck` in `SessionPrompt`

Current code finds the latest provider-user message and checks whether it has an `agent` part.

A newer host continuation can become that “latest user” and mask the authoritative worker prompt's agent part.

**Finding:** confirmed ownership leak **and a broader authorization-shape defect**.

An `AgentPart` means the user explicitly invoked one named agent. Prompt materialization injects:

```text
Use the above message and context to generate a prompt and call the task tool with subagent: <name>
```

But the runtime reduces that explicit authorization to:

```ts
bypassAgentCheck: boolean
```

and `TaskTool` currently skips its permission check for **any**
`params.subagent_type` when the boolean is true.

Therefore:

1. a newer host continuation can accidentally **lose** the original explicit
   authorization because it has no AgentPart; and
2. the existing boolean is itself too broad because `@agent foo` can suppress
   permission checks for a model-supplied `bar`.

Need determine the intended behavior:

- replace the boolean with the exact set of agent names explicitly authorized
  by the causal user turn;
- resolve that causal root through message-level provenance
  (`sourceMessageID`) for Goal/compaction/recovery continuations;
- skip Task permission only when `params.subagent_type` is in that exact set;
- keep background/subagent restrictions based on actual session/agent ownership,
  not this authorization set.

This preserves explicit user authorization across host-owned continuations of
the **same logical turn** without widening it to unrelated agent names.

**Status:** open / P0; tool-context migration required.

#### C. Other raw role checks

Remaining role checks in compaction/fork/context compiler/provider paths are being individually classified. Most observed so far are structural and should remain role-based.

---

## 10. Fork / Ordering Adversarial Investigation

An earlier broad suite produced:

```text
MessageV2.filterCompacted
fork remaps compaction tail_start_id

expected retained messages: 6
observed: 5
```

Initial debugging showed the child had only seven raw messages from an eight-message parent, so the first hypothesis was fork boundary selection rather than `filterCompacted`.

### 10.1 Current evidence

The live test fixture has since been updated so completed assistants explicitly persist:

```ts
time.completed
```

An adjacent regression now explicitly verifies:

> a `finish` value alone does not make an assistant durably complete.

After that fixture correction, the isolated fork/compaction test passes.

Fresh observed parent chronology was:

```text
u1
a1 completed
u2
a2 completed
compaction user
summary assistant completed
u3
a3 completed
```

The fork then passed.

### 10.2 Architectural conclusion

The completed-turn boundary should use durable completion/error state, not merely provider `finish`.

No provenance-specific production fork fix is currently required.

Temporary fork diagnostics were removed after proof.

### 10.3 V2 ordering discovery

Current/V2 `SessionMessageTable` has an authoritative per-session:

```text
seq
```

and pages history by sequence.

V1 compatibility `MessageTable` still reconstructs chronology using:

```text
(time_created, id)
```

This is a significant architectural difference.

**Do not scope-creep into a V1 sequence migration unless another concrete ordering defect requires it.**

If V1 ordering defects recur, V2's durable sequence should be evaluated as the long-term backport rather than accumulating timestamp/ID heuristics.

---

## 11. Tests / Evidence Collected

### 11.1 Core provenance

Latest focused result recorded:

```text
5 pass
0 fail
27 assertions
```

Coverage includes:

- V2-equivalent semantic classification
- explicit ownership
- legacy compatibility fallback
- info-only classification
- user-owned-but-synthetic cases
- worker-prompt selection
- Goal authorization selection
- host correlation / lineage

### 11.2 Focused OpenCode provenance matrix

Latest recorded focused result:

```text
126 pass
0 fail
```

Includes:

- provider lowering
- CLI history/live/replay
- ACP replay
- ACP configuration restore
- provenance/generated SDK integration

### 11.3 Goal continuation integration

The Goal test now asserts message-level provenance rather than retired part metadata:

- exactly one host Goal continuation
- `source = goal.continuation`
- non-empty reservation ref
- sourceMessageID points at the originating semantic user turn
- continuation absent from worker system context
- privileged `[GOAL AUDITOR ...]` markers absent from worker system-role messages
- continuation still appears in the worker provider request
- assistant response is parented to the synthetic continuation

### 11.4 Provider/cache invariant

Regression evidence confirms the provenance field does not change provider lowering semantics:

```text
host-owned synthetic V1 continuation
  -> provider role "user"
```

Provenance is not serialized as prompt prose.

### 11.5 Type diagnostics

A scoped typecheck previously reached:

- zero diagnostics in 22 provenance-owned source/test files
- remaining diagnostics outside the selected provenance scope

Final scoped diagnostics on 2026-09-18:

- `packages/schema`: package `typecheck` passes.
- `packages/session-ui`: package `typecheck` passes.
- `packages/client`: package `typecheck` passes.
- `packages/sdk/js`: package `typecheck` passes.
- provenance-owned Core files: **0 P0 / 0 P1**; remaining diagnostics are
  environment/import typing outside the selected files (`bun:*`, text assets,
  `TextDecoder`).
- provenance-owned App files: **0 P0 / 0 P1**; remaining diagnostics are
  existing Vite/asset/compiler-environment issues outside the selected files.
- selected OpenCode files have no selected-file provenance diagnostic; the
  compiler program is presently red from unrelated concurrent control-plane,
  sync, SPAD, shell-WASM, server-contract, and archive typing work.

The repository-wide OpenCode/App checks therefore cannot honestly be recorded as
green in this shared worktree, but no final P0/P1 is attributable to the
provenance/state slice.

### 11.6 Broad suite

An earlier broad run recorded:

```text
206 pass
16 skip
8 fail
1 error
```

At that point:

- multiple SPAD/status failures were pre-existing concurrent reds;
- the Goal test still contained stale part-metadata expectations;
- the fork test failed before the durable-completion fixture correction.

These numbers are historical, **not the current final verdict**.

Do not use the historical broad result as the final provenance verdict. The
focused final matrix below supersedes it; a repository-wide green run requires
the unrelated concurrent red work to converge first.

### 11.7 Final focused convergence matrix — 2026-09-18

Green focused evidence now includes:

- Core V1 provenance: 8/8.
- Core current/V2 provenance: 5/5.
- GoalProjection: 3/3, 51 assertions.
- runner history projection: 4/4, including zero-read hot-path proof.
- Core compaction: 5/5.
- V1 `message-v2`: 44/44.
- V1 context/conversation control: 5/5.
- Goal normal autonomous cycle, recovered reservation repair, and compaction
  reset regressions: green.
- fork causal provenance remapping/state exclusion: green.
- delegated authority rejection from provider-user STATE: green.
- Share subscriber provenance regression: green; STATE + continuation sync while
  provider `getModel` calls remain exactly zero.
- CLI replay: 14/14.
- CLI live/session-data: 15/15.
- ACP event/replay: 17/17; configuration: 16/16; session: 8/8.
- App current reducer: 12/12; server-session: 94/94; normalization: 7/7;
  current timeline: 11/11.
- generated client provenance contract and unified JS SDK provenance contract:
  green.
- database migration suite: 19/19; canonical `migration --check` reports no
  schema changes.

Generated client and unified SDK generation were each run to a second fixed
point; provenance-relevant generated files retained identical SHA-256 hashes on
the second canonical generation.

Production/build closure on the same dirty worktree:

- App `vite build` passes.
- OpenCode production build reaches native target packaging and emits fresh
  Windows x64 and x64-baseline binaries at `0.0.0-main-202609190151`; build-time
  version and ChunkDB capability smoke checks pass.
- Full package typechecks were also run as a diagnostic gate. Schema,
  session-ui, generated client, and JS SDK are green. Core/OpenCode/App remain
  red only on unrelated concurrent worktree changes (ChunkDB/readDb fixtures,
  checkpoint/SPAD/control-plane/sync/server contracts, stale LLM mocks, React
  context surfaces, and other fixture drift); no remaining full-package error
  points at this provenance/STATE implementation.
- The build did not create unexpected dependency churn. The relevant lock diff
  remains the already-present Luxon entries plus the intentional
  `session-ui -> schema` workspace dependency.

---

## 12. Performance Audit

The provenance architecture is intentionally cheap.

### 12.1 Hot-path cost for new rows

Explicit provenance classification:

```text
O(1) property reads
```

No part scan is required for modern rows.

### 12.2 Legacy rows

Only old rows without explicit provenance require part inspection.

Legacy ambiguity is quarantined inside the compatibility module.

### 12.3 Database cost

No provenance-specific:

- extra query
- extra table
- extra join
- extra index
- extra instance
- extra event projection

is required.

### 12.4 Prompt/cache cost

Provenance metadata is not provider prompt text.

The Goal continuation move actually **improves provider caching** by moving variable continuation content out of system context and into an appended turn.

### 12.5 History scans

Consumers should use:

- explicit provenance on already-loaded messages, or
- purpose-specific `findMessage` when a historical source must be found.

Do not introduce additional full-history scans merely to classify ownership.

### 12.6 Share incremental optimization

Closed. The incremental Share watcher uses worker-prompt provenance. A focused
subscriber regression proves host STATE and derived continuations still sync as
messages with provenance intact while causing **zero** provider model lookups.

### 12.7 STATE hot-path / presentation cost

Replaceable STATE remains transparent rather than becoming a request/turn
boundary in throughput, app parenting, timeline grouping, and pagination. The
throughput calculator remains a pure O(n) pass. Context preview now derives its
earliest effective mutation from the already-materialized ledger instead of
performing a second SQLite state read.

---

## 13. Security / Authority Invariants

These are permanent negative invariants.

1. Public prompt input cannot spoof host provenance.
2. Host provenance is stamped by trusted producers.
3. Provider role is never accepted as proof of human ownership.
4. Part-level `synthetic` is never the modern canonical turn-ownership source.
5. Goal continuation cannot authorize a new Goal lifecycle action as if the human requested it.
6. Compaction/recovery continuation cannot become the authoritative worker objective.
7. A shell turn cannot accidentally become Goal authorization merely because it is user-owned.
8. Synthetic turns must not render as human user text in CLI/ACP/history surfaces.
9. Provider lowering may still use `role=user` for synthetic/shell/compaction where protocol semantics require it.
10. No provenance migration may add user-visible prompt text or silently change provider cache bytes.
11. `owner=host` or a host provenance source must never be interpreted as privileged/System authority by itself.
12. Host-authored conversational state (Goal continuation/spec/progress, scheduled/peer/recovery input, observations) may lower to provider `user` while remaining non-human and non-privileged locally.
13. Genuinely privileged OpenFork policy must never be demoted to provider-user as a compatibility fallback; the exact provider/model/runtime compiler must preserve authority or fail closed.
14. Provider wire role is a derived projection and must never overwrite durable ownership, semantic kind, causal lineage, or trust semantics.

---

## 14. Legacy Compatibility Policy

Do not backfill the entire old V1 database merely to add provenance.

For old rows:

- full-message resolver may inspect parts;
- info-only resolver cannot disambiguate old user-role rows without parts and therefore preserves historical behavior with `confidence = legacy-inferred`.

This uncertainty must remain centralized.

New feature code should not add new local legacy heuristics.

---

## 15. Documentation / Enforcement Already Updated

The architecture is also recorded in:

- root `AGENTS.md`
- `packages/opencode/AGENTS.md`
- `packages/schema/AGENTS.md`
- `docs/handoff/HANDOFF-goal-continuation-architecture-2026-09-17.md`

The key documented invariant is:

> Provider role is not semantic ownership. Persist semantic provenance where the turn is produced and lower to provider roles only at the LLM boundary.

The stronger canonical form is:

> **Ownership/provenance, semantic kind, authority, fragment origin, and provider projection are independent facts. Host-authored does not imply privileged; provider-user does not imply human-authored.**

This ledger is more detailed and remains the active implementation record.

---

## 16. Related Goal Auditor Findings Exposed During This Campaign

These are adjacent to provenance but should remain tracked because they motivated several architecture corrections.

### 16.1 Auditor/worker runtime separation

The actual Goal Auditor uses a separate host-owned child Session and independent runtime.

Defense-in-depth now rejects running the ordinary worker loop directly on a Goal Auditor child.

### 16.2 Worker system-channel isolation

Tests assert privileged `[GOAL AUDITOR ...]` system instructions never appear in worker system-role provider messages.

### 16.3 Manual verification preemption

User-requested verification is an explicit preemption command:

```text
request verification
  -> durable audit request
  -> interrupt worker generation/tool
  -> finalize interrupted worker/tool state
  -> parent session idle
  -> real auditor lease
  -> AUDITING
```

### 16.4 Auditor timing

Goal lifetime is not the auditor timer.

The intended auditor budget is one absolute five-minute execution budget beginning after the real auditor lease is acquired and covering provider generation + read-only tool rounds.

### 16.5 Ripgrep large-record failure

The previous `rg --json` adapter could die when one JSON record exceeded 64 KiB before normal output truncation.

The auditor path was hardened so valid large matches do not kill the entire audit.

### 16.6 Filesystem defects

Auditor read/grep/glob wrappers must turn filesystem failures into recoverable tool failures rather than Effect defects that kill the entire auditor.

### 16.7 Cross-worktree auditor read access

Still architecturally relevant:

- a multi-worktree Goal cannot assume every relative evidence path belongs to the parent Session root;
- the auditor must not parse free-form Goal prose into filesystem authority;
- production should reuse the host's existing read-only tool / `external_directory` permission semantics rather than duplicate a path permission engine in Core.

This remains separate from the turn-provenance backport and should not be lost.

---

## 17. Adversarial Questions That Must Stay Answerable

As implementation continues, continually ask:

1. Can any host-owned turn still be mistaken for human input?
2. Can any semantic user turn be incorrectly hidden because one of its parts is synthetic?
3. Can a provider-role transformation change durable ownership?
4. Can Goal continuation/recovery/compaction become the worker objective?
5. Can a synthetic turn overwrite model/agent restoration?
6. Can a host turn enter prompt history / replay / ACP as a human chunk?
7. Can a newer host continuation mask an earlier user agent selection?
8. Can compaction race detection confuse host synthetic followups with newly admitted human input?
9. Does fork/revert use semantic ownership only where human semantics matter, while preserving structural provider-user boundaries where required?
10. Does any new provenance check require loading parts/history unnecessarily?
11. Does any client reconstruct ownership instead of consuming persisted provenance?
12. Does any migration alter provider prompt bytes or cache prefix stability?
13. Are old rows still readable without pretending legacy inference is authoritative?
14. Are current/V2 semantics still the appropriate semantic reference/backport donor for this capability, without forcing structural V1 parity?
15. Is any code deriving privileged authority merely from `owner=host`, provenance source, or semantic origin?
16. Is any true System policy being wrapped/demoted into provider-user merely because an adapter lacks chronological System support?
17. Does the provider compiler derive wire representation from exact provider/model/runtime capability without changing the durable semantic meaning?

---

## 18. Remaining Implementation Queue

### P0 — finish semantic leak audit

- [x] Incremental Share model sync now uses worker-prompt provenance, matching full sync. Host continuations still sync as messages but no longer trigger redundant Provider model resolution/model sync.
- [x] Replace boolean `bypassAgentCheck` with exact `authorizedAgentNames`. Task permission bypass is now name-scoped rather than global.
- [x] Direct host subtask dispatch authorizes only the requested task agent; background monitor restrictions rely on actual agent mode instead of the unrelated bypass flag.
- [x] Finish causal-root wiring for automatic continuations so exact `@agent` authorization and other worker-root capabilities survive only along explicit provenance lineage. Modern reservations now persist the causal source; compacted-away roots are reloaded by exact ID.
- [x] Persist unknown-finish provider recovery as a durable host synthetic turn instead of a request-only invisible provider message.
- [x] Re-audit remaining `role === "user"` / `role !== "user"` call sites after those patches. Remaining inspected sites are structural/narrowing or explicitly provenance-qualified where semantics/authority matter.
- [x] Add comments/semantic adapters at non-obvious STATE/compatibility boundaries so provider-user wire shape is not mistaken for a turn boundary.

### P0 — regression closure

- [x] Re-run Core provenance tests.
- [x] Re-run Goal orchestration tests.
- [x] Re-run compaction/fork/revert suites.
- [x] Re-run CLI history/live/replay.
- [x] Re-run ACP replay/configuration.
- [x] Re-run share tests and add focused Share provenance regression.

### P1 — generated/public surfaces

- [x] Re-run generated client and unified SDK generation after final schema/source changes; both reach a byte-stable second fixed point.
- [x] Verify generated provenance shape through client + SDK contract tests.
- [x] Re-run scoped type diagnostics across provenance-owned files; no scoped P0/P1 remains in Core/App, and Schema/session-ui/client/SDK package checks pass.

### P1 — performance / hygiene

- [x] Confirm no new full-history scan on modern STATE paths; current runner maintains an incremental state projection and modern classification is O(1).
- [x] Confirm no duplicate provider model lookups from host continuations (focused Share spy: zero calls).
- [x] Confirm provenance remains metadata rather than provider prompt prose through provider-lowering regressions.
- [x] Run scoped `git diff --check` on provenance-owned files: clean. A broader check also reports pre-existing/concurrent CRLF whitespace in `session-ui/message-part.tsx`, outside the provenance hunks.
- [x] Scan provenance-owned production files for temporary `console.log`/`console.debug`, `debugger`, provenance TODO/FIXME instrumentation: none found.

### P1 — production proof

- [x] Run exact-tree App/OpenCode production builds. App Vite build passes. OpenCode reaches native packaging; fresh Windows x64 + x64-baseline artifacts report `0.0.0-main-202609190151`, and the build smoke stage reports version + ChunkDB capability checks passing.
- [x] Run full package typechecks and classify failures. Schema/session-ui/client/SDK are green; Core/OpenCode/App remain red only on unrelated concurrent ChunkDB/checkpoint/SPAD/control-plane/sync/server/React/fixture work. Do not misattribute those diagnostics to provenance.
- [x] Record final focused pass/fail matrix here.

### P2 — long-term V1/V2 convergence

- [ ] Consider whether more V1 APIs should expose semantic kind directly.
- [ ] If V1 ordering defects recur, evaluate V2-style durable message `seq` rather than adding timestamp heuristics.
- [ ] Eventually retire the V1 compatibility resolver as old role-only storage ages out / migration completes.

---

## 19. Current Decision Log

### Decision: provenance is message-level

**Accepted.**

Reason: ownership is a turn fact, not a part fact.

### Decision: retain `TextPart.synthetic`

**Accepted.**

Reason: part-level authorship remains useful and is orthogonal to turn ownership.

### Decision: provider `role=user` remains for host synthetic turns

**Accepted.**

Reason: this is required provider/conversation protocol behavior and matches V2.

### Decision: broad semantic rewrite, not Goal-only patch

**Accepted.**

Reason: Goal Mode exposed a general modeling defect in V1.

### Decision: no provenance SQL backfill/migration

**Accepted.**

Reason: V1 message JSON already persists the new fact; legacy resolver is sufficient and cheaper.

### Decision: current/V2 is a semantic/reference donor, not V1's destination runtime

**Accepted.**

Reason: current architecture already separates semantic message kinds from
provider projection, while the repository maps explicitly preserve V1 as a
supported production surface. Backport the semantic law at the lowest correct
owner; do not replace mature V1 architecture merely for parity.

### Decision: replaceable STATE is not a turn or authority root

**Accepted.**

`goal.spec` and `goal.progress` are complete current-state projections. They may
lower through provider-user compatibility, but they remain transparent to active
worker-root selection, assistant parenting, fork/checkpoint roots, delegated
authority, throughput turn boundaries, timeline turn grouping, and compaction
history. If compaction/reset removes their effective presence, the authoritative
producer reprojects current state.

### Decision: browser-safe provenance policy belongs in Schema

**Accepted.**

Schema owns the unbranded/browser-safe source vocabulary and classification
policy. Core's V1 helper adds runtime brands, causal-root construction, and the
single legacy part-inspection fallback. App/session-ui consume Schema policy
rather than importing Core runtime ownership logic.

### Decision: transitional client types do not own OpenFork semantics

**Accepted.**

The app's vendored current-client tarball remains useful for transient lifecycle
compatibility, but it is stale with respect to OpenFork provenance. One central
compatibility type enriches the vendor lifecycle union with Schema-owned
provenance/current fields; runtime payload bytes remain unchanged and casts are
not scattered across consumers.

### Decision: do not migrate all raw role checks

**Accepted.**

Reason: structural/provider-role checks are valid and must remain distinct from ownership decisions.

### Decision: no V1 `seq` migration during this backport without a concrete blocker

**Accepted for now.**

Reason: V2 sequence is architecturally superior, but adding it to legacy V1 storage is a separate migration with wider persistence/query cost and risk.

### Decision: explicit agent authorization is a name set, not a boolean

**Accepted.**

Reason: an explicit `@agent foo` turn authorizes `foo`; it does not authorize arbitrary model-selected subagents. Host continuations may inherit only the exact authorization carried by their causal source turn.

### Finding: unknown-finish continuation was an invisible synthetic turn

**Resolved in current tree.**

The `UNKNOWN_FINISH_CONTINUATION_PROMPT` was appended directly to provider messages and explicitly never persisted. This was the remaining continuation variant from the same architectural family as the old Goal system injection.

It is now persisted as a durable host-owned synthetic turn with source
`provider.unknown-finish.continuation`. The turn carries the causal worker
root as `sourceMessageID` and the interrupted assistant id as `ref`.

The loop now distinguishes:

- the **structural current provider-user turn** used for assistant parenting/protocol ordering; and
- the **causal worker-root turn** used for inherited user/task capabilities such as explicit agent authorization and lazy-tool mentions.

The causal root comes from persisted provenance, not a history/text heuristic.

The focused regression proves:

- generation 1 does not contain the recovery instruction;
- generation 2 sees the synthetic continuation as provider role `user`;
- the Session persists exactly one matching host synthetic turn;
- semantic kind is `synthetic`;
- lineage points back to the authoritative worker prompt.

Latest focused result:

```text
loop continues when finish is unknown
1 pass
0 fail
12 assertions
```

### Finding: agent authorization boolean was over-broad

**Resolved in current tree.**

`bypassAgentCheck: boolean` has been replaced by the exact
`authorizedAgentNames` set.

- `TaskTool` skips permission only when the requested `subagent_type` is in
  that set.
- direct host subtask execution authorizes only its requested agent;
- ordinary worker execution derives authorization from the causal worker-root
  turn;
- background-monitor restrictions no longer reuse this unrelated permission
  bit and instead inspect actual agent mode.

Focused proof:

```text
SessionTools
9 pass
0 fail

Task exact-name authorization
1 pass
0 fail
```

### Finding: incremental Share model sync treated every provider-user message as a model source

**Resolved in current tree.**

Incremental message synchronization still transmits every durable message, but
model lookup/model synchronization now runs only for
`isWorkerPromptInfo(info)`, matching the existing full-sync path.

This removes redundant Provider work for Goal/compaction/recovery
continuations without hiding those messages from sharing.

Owning Share suite:

```text
7 pass
0 fail
```

### Finding: V1 Session metadata mixed caller-owned data with producer-owned aggregate identity

**Resolved in current tree.**

Scheduled runs and host-owned special-agent transcripts both stamp durable
Session-level identity into the legacy V1 Session metadata bag. That bag is also
publicly replaceable through V1 Session create/update compatibility APIs. Before
this correction, a generic metadata replacement could therefore erase producer
identity, and public creation could spoof it. V1 fork also cloned the entire
metadata object, manufacturing false producer identity on a newly derived Session.

The shared rule is now:

```text
trusted producer create
  -> may stamp producer-owned Session origin metadata

public/general create
  -> caller metadata admitted
  -> producer-origin keys removed

generic metadata replacement
  -> caller-owned keys keep replacement semantics
  -> current producer-owned origin survives exactly
  -> incoming origin cannot introduce/overwrite ownership

fork / derived Session
  -> caller-owned metadata may carry forward
  -> producer-owned origin is removed
```

`packages/core/src/session/metadata-ownership.ts` is the single registry/policy
surface. Current immutable aggregate-origin families are:

- Scheduled Task: `scheduledTaskID`, `scheduledTaskRunID`;
- special-agent transcript: `specialAgent`, `specialAgentOwnerKind`,
  `specialAgentOwnerID`, with current Goal Auditor relation details retained
  across replacement.

Special-agent identity composition is also producer-wins: arbitrary producer
extras can no longer override the reserved identity keys by object-spread order.

This deliberately does **not** convert V1 metadata into merge semantics. Ordinary
caller keys still replace the old caller metadata exactly as before. It also does
not classify mutable internal policy such as `localMcp` as immutable origin;
that policy has legitimate trusted post-create updates and is a separate
authority contract.

No SQL migration or extra read was introduced. V1 already persists Session
metadata in the Session row, the mutation path already reads the current Session
before publishing its replacement projection, and fork already cloned metadata.
The change is O(number of metadata keys) local object work only.

Regression proof:

- pure ownership policy: 6 passed / 0 failed / 8 assertions;
- V1 public create/PATCH/fork integration: 1 passed / 0 failed / 5 assertions;
- special-agent grouping: 7 passed / 0 failed / 37 assertions;
- strict mutable `localMcp` policy regressions remain green;
- Scheduled Core/OpenCode matrices remain 51/51 and 34/34 respectively.

### Decision: aggregate producer identity does not propagate through Session fork

**Accepted.**

A fork is a new Session aggregate. It may inherit effective conversational
history and ordinary caller metadata, but it must not inherit the source
aggregate's scheduler/special-agent ownership. Turn-level causal provenance is
remapped separately by the fork planner; aggregate producer identity is not.

---

## 20. Ledger Update Discipline

Every substantial discovery should be added to this file before moving far beyond it.

For each new finding record:

1. **Observed symptom**
2. **Authoritative source / proof**
3. **Root cause**
4. **Architecture decision**
5. **Files/systems affected**
6. **Performance implications**
7. **Regression added**
8. **Current status**

Do not allow chat summaries to become the only record of architectural discoveries.
