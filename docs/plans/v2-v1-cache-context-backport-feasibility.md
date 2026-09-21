# V2 -> V1 Cache / Context Semantics Backport Feasibility

**Date:** 2026-09-18  
**Status:** adversarially re-audited architecture plan; V1 provenance overhaul is concurrently in progress  
**Scope:** V1 session prompt/cache behavior, V2 `SystemContext` + context-epoch semantics, provider prefix-cache preservation, deterministic proof without paid inference  
**Related:** `docs/plans/cache-bust-research-ledger.md`

---

## Executive summary

Backporting the useful cache-preserving semantics of the current session
architecture into V1 is now substantially easier than it first appeared because
V1 is concurrently gaining an explicit message-level turn-provenance model.
However, the adversarial review changed the target: **do not backport the current
V2 Context Epoch mechanics unchanged. Harden the shared semantic primitives
first, then give V1 the thinnest compatibility adapter toward that stronger
architecture.**

The key architectural rule is:

> **Conversational ownership, provider role, content-fragment origin, and
> privileged context authority are four different facts. Do not collapse them.**

The in-progress V1 provenance work correctly separates the first three:

- `SessionV1.User.provenance.owner` says who owns the durable turn boundary;
- `SessionV1.User.provenance.source` attributes/correlates that turn;
- `TextPart.synthetic` says whether an individual content fragment was generated
  by OpenCode;
- provider lowering remains free to emit `role: "user"` for a host-owned turn.

That directly solves the most expensive V1 cache-bust pattern exposed by Goal
Mode: a changing host continuation no longer needs to be inserted into the
system-prefix array. It can be appended as a durable host-owned user-role turn,
leaving the previously cached prefix byte-stable.

This does **not** mean provenance should be used to encode true system-context
updates. V2 `SystemContext` carries privileged host context and produces
chronological System updates. A V1 backport must preserve that distinction.
Provider lowering must never inspect `provenance.source` and decide that one
user-role message is secretly privileged. If V1 receives V2-like chronological
system updates, they need a dedicated typed representation / lowering seam.

The adversarial pass adds a fifth independent fact:

- **request-series / provider-cache identity** says whether the exact prepared
  route, tool/header surface and earlier model-visible bytes are still reusable.

It must not be used as a reason to change conversational ownership or privilege.

Most importantly, a provider route that cannot represent a chronological
privileged System update must **not** receive that update disguised as user text
merely to keep the earlier cache prefix. The correct fallback is to rebuild the
current complete privileged head and classify the request as a new series.

### Updated hardness estimate

| Slice | Hardness | Reason |
| --- | ---: | --- |
| Goal / host continuation semantic placement | **3 / 10 implementation, 5 / 10 proof** | Provenance + Synthetic placement is straightforward; current V1 materialization is not crash-atomic and performs producer-state reconstruction through history scans. |
| Local-fork V2 Goal continuation correction | **2 / 10 implementation, 5 / 10 proof** | V2 already has durable `Synthetic` lowering; proof must include reservation ownership, restart/failure points and no duplicate/lost continuation. |
| Complete V1 producer provenance coverage | **3.5 / 10** | Mostly census + purpose-specific selector migration. Main risk is semantic misclassification, not implementation size. |
| Provider cache-policy parity in `@opencode-ai/llm` | **4 / 10** | Native request compilation is already testable without sending. Provider-specific capability drift remains. |
| Harden shared `SystemContext` source contract | **6.5 / 10** | Needs semantic/render versions, complete source snapshots, required/optional availability semantics and source-level equivalence tests. |
| Route-aware privileged-context projection | **7 / 10** | Exact route capability must be resolved before choosing append vs privileged-head replacement; both AI-SDK and native paths must preserve authority. |
| Thin V1 adapter to hardened shared context | **5.5 / 10** | Becomes simpler after the shared owner is correct; V1 still has legacy-only contributors and two runtime paths. |
| Whole V2 runner transplant | **9-10 / 10, reject** | Duplicates/replaces too much execution machinery and violates the narrowest-owner-change principle. |

The recommended project is therefore **not** “port the V2 runner” and not even
“copy V2 Context Epochs.” It is:

1. finish V1 turn provenance;
2. move Goal reservation correlation/materialization ownership out of transcript
   scans and make continuation publication crash-safe;
3. harden the shared Context Source/epoch contract before migrating more V1
   producers;
4. resolve exact model/route capability before choosing chronological privileged
   append versus complete privileged-head replacement;
5. give V1 a thin typed adapter onto those shared semantics;
6. keep provider-specific cache behavior under `@opencode-ai/llm`;
7. prove every cache claim through deterministic request compilation before any
   live provider call.

---

## 1. Repository contracts governing this work

This plan is constrained by the root, Core, OpenCode, and session-LLM
`AGENTS.md` files.

The contracts were re-read after concurrent V1-overhaul edits changed the files.
The current repository guidance now explicitly codifies the architecture this
plan depends on:

- turn ownership/provenance is separate from provider role;
- `part.synthetic` is content-fragment provenance, not whole-turn ownership;
- current `SessionMessage.User/Synthetic/Shell/Compaction` is the compatibility
  target for V1;
- Goal/auditor continuations must be durable host-owned turns and must never be
  changing worker-system entries;
- chronological privileged System updates are a separate LLM semantic surface;
- untrusted retrieved/tool/web content must stay in ordinary user/tool channels,
  not privileged System updates.

That last rule directly reinforces the monitor-ingress classification later in
this document.

### 1.1 Ownership first

The authoritative path is:

```text
semantic producer
  -> Core-owned durable/session state
  -> context/turn projection
  -> session request compiler
  -> runtime adapter
  -> provider protocol
```

The reverse path must never become:

```text
provider request / UI artifact
  -> scan parts/history
  -> infer what the producer must have meant
```

For new rows, the producer stamps semantics once at admission.

### 1.2 A cache may not make a wrong producer acceptable

Rejected fixes include:

- memoizing V1's currently rebuilt system string;
- moving changing Goal continuation text behind a cache breakpoint but leaving
  it in the privileged head;
- adding debounce/TTL around repeated prompt reconstruction;
- client-side reconstruction of “real user” state from parts;
- provider-specific prompt mutations scattered through `prompt.ts`.

Those can improve a benchmark while preserving the ownership defect.

### 1.3 Performance closure requires negative invariants

Latency/hit-rate numbers are insufficient. Closure must also prove:

- no new workspace instance for cache/provenance reads;
- no new history scan for modern turn classification;
- no per-session timer/subscription introduced by the backport;
- no second authoritative context store;
- no provider-role decision derived from provenance ownership;
- no dynamic host continuation in the stable system prefix;
- bounded behavior at 1 / 3 / 6+ concurrent sessions.

---

## 2. The canonical semantic model

The V1 overhaul started by separating facts that legacy `role` had collapsed.
The cache/trust/Goal audits have made more axes explicit as needed. They are
orthogonal; this does **not** imply one giant persisted provenance object or that
every message must materialize every axis.

### 2.1 Turn ownership

Durable conversational ownership:

```ts
owner: "user" | "host"
```

Examples:

```text
direct prompt                 owner=user
slash command                 owner=user
user-triggered shell turn     owner=user
Goal continuation             owner=host
compaction continuation       owner=host
scheduled-task admission      owner=host
recovery continuation         owner=host
```

Ownership is authoritative. Source is not a security boundary.

### 2.2 Source / correlation

`source` answers “which trusted producer created this turn?” and optional
`sourceMessageID` / `ref` provide causal/idempotency correlation.

It is useful for:

- Goal reservation idempotency;
- checkpoint root selection;
- scheduled-task attribution;
- timeline/debugging labels;
- recovery correlation;
- observability.

It must **not** determine privilege or provider role.

### 2.2.1 Authorization/origin lineage is not instruction authority

Some domain state exists only because a particular user act authorized it. Keep
that origin durable when audit/recovery needs it, but do not let it become a
second owner or an instruction-priority surrogate.

Goal Mode demonstrates the distinction:

```text
human user turn
  -> authorizes Goal creation
  -> creation audit records sourceMessageID

Goal domain
  -> becomes authoritative owner of current specification/progress
  -> current version is goalID + revision

host projection turn
  -> kind=Synthetic
  -> owner=host
  -> instruction authority=conversational
  -> provider role=user
```

Later Goal specification edits/progress can come from different legitimate
actors. Consumers needing current truth must read the Goal owner/revision, not
reconstruct current meaning from the original authorizing message.

### 2.3 Part origin

`part.synthetic` remains a narrow fragment-level fact:

> Was this individual content part generated by OpenCode rather than supplied
> directly as prompt content?

A user-owned message can contain synthetic MCP/resource expansion while still
remaining user-owned.

### 2.4 Instruction authority and provider role

Instruction authority is the semantic priority lane; provider role is a
request-lowering concern. Do not call causal lineage "authority" because it makes
these two meanings easy to collapse.

A Goal continuation may be:

```text
durable owner = host
durable source = goal.continuation
provider role = user
```

That is correct.

A true `SystemContext` update is different:

```text
durable semantic kind = system/context update
privilege = system host context
provider lowering = system when supported, explicit route fallback otherwise
```

It is **not** merely another `owner=host` user turn.

### 2.5 Trust class

Content trust is independent from both turn ownership and provider role.

```text
trusted host policy
user-authored content
untrusted external observation/tool/retrieval content
```

A host-owned turn can carry untrusted external bytes. That does not make those
bytes privileged. Monitor ingress is the concrete example: the host owns delivery,
while the payload is explicitly `untrusted-external-data`.

Do not infer trust from `owner=host`.

### 2.6 Provider encoding

The semantic layer decides whether content is User/Synthetic/System/etc. The
selected provider route decides how that semantic kind can be encoded.

Encoding may not silently change semantic authority. If a route cannot represent
a required later privileged update with its intended semantics, the semantic
compiler must choose a complete privileged-head projection rather than accepting
a lower-authority user wrapper as equivalent. Cache-series consequences are
derived diagnostics/optimization, not a license to change authority.

### 2.7 Request-surface / cache identity

Whether earlier provider bytes are reusable is independent from the Session's
semantic continuity:

```text
semantic context epoch
derived request-surface continuity/break reason
provider cache-domain identity
```

These must remain separate diagnostics/state dimensions. Only the Context Epoch
and provider cache domain are necessarily durable semantic/remote facts;
OpenCode should not persist a Harness-style request series unless later
correctness work proves it is required.

### 2.8 Do not over-model

Not every message needs all seven axes persisted. Persist a fact at the producer
only when downstream correctness needs it:

- V1 user-role turns need explicit conversational provenance;
- external runtime observations may need source/trust metadata;
- provider route capability belongs on route/model metadata, not Session
  provenance;
- cache-series diagnostics can remain derived/test/debug state when they are not
  product authority.

The architecture goal is orthogonality, not metadata proliferation.

---

## 3. Current V1 overhaul: what is already structurally right

The current dirty worktree contains an in-progress implementation. Do not treat
these observations as a clean committed baseline.

### 3.1 Schema

`packages/schema/src/v1/session.ts` now defines optional
`UserTurnProvenance` on `SessionV1.User`.

That is the correct storage location because the existing legacy `MessageTable`
stores message data as JSON. No SQL table/index/backfill is required merely to
add provenance.

### 3.2 Central compatibility resolver

`packages/core/src/v1/session-turn-provenance.ts` is the correct architectural
shape:

- explicit provenance wins;
- only this module performs legacy inference from parts;
- the resolved result exposes `explicit | legacy-inferred` confidence;
- semantic callers use purpose-specific helpers rather than a universal
  `isRealUserMessage()` predicate.

Current helpers include:

- `isUserOwnedTurn()`;
- `isHostOwnedTurn()`;
- `isWorkerPromptTurn()`;
- `isGoalAuthorizationTurn()`;
- `checkpointRootMessageID()`;
- `hasHostCorrelation()`.

This follows the Core rule: materialize semantic state at the producer and
quarantine compatibility reconstruction.

### 3.3 Producers already moving to explicit provenance

The live tree currently stamps or is in the process of stamping:

- ordinary prompt -> `prompt`;
- command -> `command`;
- shell -> `shell`;
- task summary -> `task.summary`;
- Goal continuation -> `goal.continuation` + source message + reservation ref;
- recovery continuation -> `recovery.continuation`;
- compaction marker -> `compaction`;
- compaction replay -> `compaction.replay`;
- compaction continuation -> `compaction.continue`.

Goal continuation is now being materialized as a durable host-owned synthetic
user-role turn rather than appended to the system array. This is exactly the
cache-preserving direction required by this research program.

### 3.4 WIP inconsistencies must be treated as WIP, not architectural evidence

At the time of this document, parts of `packages/opencode/test/session/prompt.test.ts`
still assert the older Goal-specific part metadata keys even though the new
producer path is moving those correlations onto message provenance.

Do not preserve the legacy metadata merely to satisfy a stale test. Update the
test to prove the new owner/source/ref contract once the concurrent provenance
campaign reaches that file.

### 3.5 The compatibility layer is already converging on current semantic kinds

The concurrent V1 work has advanced since the first research pass.
`SessionTurnProvenance` now exposes a V1 compatibility classifier:

```text
user | synthetic | shell | compaction | assistant
```

and focused tests prove, for example:

- a human prompt -> semantic `user`;
- a host Goal continuation -> semantic `synthetic` while durable V1 provider role remains `user`;
- a user-triggered shell turn -> semantic `shell`;
- a plan approval can remain user-owned while semantically projecting as synthetic;
- compaction remains a distinct semantic kind.

This is a positive convergence signal, but the classifier must remain a
**compatibility view**, not a second permanent Session model. Current/V2 already
owns the first-class semantic message kinds directly.

---

## 4. One refinement: trusted host admission needs specific provenance

The current `hostPrompt(input)` seam correctly prevents an ordinary network/user
caller from claiming host ownership. That boundary should remain.

However, all trusted host callers currently converge on generic `host.prompt`.
For example, the scheduled-task executor calls `hostPrompt()` after creating a
session whose metadata contains `scheduledTaskID`.

This is safe for ownership but loses source precision.

### Recommended internal API shape

Do **not** add provenance to public `PromptInput`.

Prefer a trusted internal admission descriptor:

```ts
type HostPromptOrigin = {
  source: string
  sourceMessageID?: MessageID
  ref?: string
}

hostPrompt(input, origin)
```

or an equivalent trusted internal method.

Examples:

```text
scheduled task:
  owner=host
  source=scheduled-task
  ref=<task id>

subagent/task dispatch:
  owner=host
  source=task.dispatch
  sourceMessageID=<parent prompt>

recovery:
  owner=host
  source=recovery.continuation
  sourceMessageID=<root turn>
```

The network schema still has no way to request host ownership.

---

## 5. Purpose-specific selectors are part of correctness

The V1 migration must audit every semantic `role === "user"` check rather than
mechanically replacing all of them.

Some role checks are still correct because they ask a provider/conversation
shape question. Others are ownership bugs.

### Correct role-shaped questions

Examples:

- “What is the latest user-role provider turn?”
- “Which message is this assistant's provider parent?”
- “Does the serialized provider history contain a user-role item?”

These may remain role-based.

### Ownership-shaped questions

Examples:

- “Did the human/user supersede autonomous execution?” -> `isUserOwnedTurn()`;
- “Which turn defines worker objective/model provenance?” ->
  `isWorkerPromptTurn()`;
- “Can this turn authorize Goal creation?” -> `isGoalAuthorizationTurn()`;
- “Which turn owns the rollback boundary?” -> checkpoint-root selector;
- “Is this the same host reservation already materialized?” ->
  `hasHostCorrelation()`.

### A concrete review target

The live V1 loop currently derives `bypassAgentCheck` from the last user-role
message's `agent` part. Once a Goal continuation becomes the latest user-role
message, that continuation contains only its synthetic orchestration text.

That may be exactly correct, or it may accidentally discard the original
user-owned agent mention for the next automatic cycle. This is not a reason to
change it blindly; it is a proof obligation:

> classify whether `bypassAgentCheck` belongs to the current provider turn or
> the worker-root turn, then encode that semantic explicitly.

The same review should be applied to every remaining role-based selector.

---

## 6. What to preserve from V2 — and what must be hardened first

V2 does not have one cache trick. It has several useful reinforcing invariants,
but the adversarial pass proved they are not all sufficient as-is.

### 6.1 Current V2: exact admitted baseline + semantic checkpoint

The current dirty tree keeps the immutable admitted baseline idea but replaces
the typed-value reconciliation state with a versioned provider-neutral
checkpoint:

```text
baseline: exact rendered Context Epoch head
baseline_seq: chronological-System floor only
checkpoint:
  exact SystemSurface snapshot
  + inactive | active(cumulative-privileged | replace-complete)
```

Ordinary conversational history is not truncated by `baseline_seq`; compaction
owns that floor separately.

### 6.2 Current V2: complete-section producers + shared reconciliation

`SystemContext` now owns only the producer boundary:

- stable namespaced source identity;
- authoritative `load()`;
- exact complete `render(value)`;
- explicit `absent` versus temporary `unavailable`;
- required/optional availability.

`SystemSurface` centrally owns byte comparison, ordering/replacement/removal,
projection-version compatibility, admitted-byte reuse and fail-closed
availability. `observeSurface()` observes each source once with bounded
concurrency 8. Source-authored equality, typed snapshot codecs, partial update
prose and removal prose are not part of the live correctness engine.

The pre-SystemSurface typed snapshot schema remains only for lazy durable
migration. Legacy rows are never reverse-engineered into supposedly exact
historical bytes; the current complete surface is freshly observed and
rebaselined once.

### 6.3 Current behavior: capability-specific projection

The V2 runner resolves the exact model before non-initial Context Epoch
projection and passes the native effective System capability into
`SessionContextEpoch.prepare`. `SystemProjection` then seals one exact witness:

```text
HEAD_ONLY
  -> any semantic change => complete current head

CUMULATIVE_PRIVILEGED
  -> true ordered suffix addition => append only the added complete sections
  -> replacement/removal/reorder => complete current head

REPLACE_COMPLETE
  -> semantic change => append the complete current surface
```

Unknown or unsupported native capability is `HEAD_ONLY`. A capability/model
switch does not itself rewrite semantic state; only retained chronological
System history that would be reinterpreted under the new semantics forces one
complete rebaseline.

Initial epoch creation may precede model resolution because there is no retained
chronological privileged suffix to interpret. It stores an inactive complete
baseline.

### 6.4 Explicit replacement boundary

A head rebaseline computes the current durable aggregate frontier and replaces
the epoch row transactionally. `baseline_seq` then means: “this complete
privileged baseline supersedes chronological System rows through sequence N.”
Ordinary user/assistant/tool history survives.

Chronological Context updates advance the checkpoint inside the durable event
commit boundary, preventing snapshot-ahead-of-event state. Completed compaction
and incompatible active-history capability changes also trigger complete
rebaseline. Do not conflate this System-history floor with conversation
compaction.

### 6.5 Provider cache policy stays below the session owner

The session runner supplies stable semantic messages. `@opencode-ai/llm` owns
protocol-specific cache hints, breakpoint placement and provider wire shape.

The V1 adapter should reproduce the valid semantic invariants, not the V2
runner's exact control flow or its current wrapped-user fallback.

### 6.6 Audit correction: model/provider switches do not end the current Context Epoch

An earlier research pass inherited a stale historical assumption that a model
switch was a Context-Epoch replacement boundary. That is no longer the current
V2 contract.

Current upstream `specs/v2/session.md`, `CONTEXT.md`, and the June 22 schema
changelog all agree:

```text
model / provider switch
  -> applies at the next provider-turn boundary
  -> preserves the current immutable Context Epoch baseline
  -> preserves chronological System Context updates
  -> naturally enters a different provider-side cache domain
```

Completed compaction, Session movement, and an incompatible Context Source
transition remain legitimate epoch-ending/rebaseline cases.

This distinction matters. **Provider cache coldness after a model switch is not a
reason to rewrite OpenCode's durable baseline.** The provider/model identity
changes the remote cache domain; the semantic Context Epoch can remain intact.

Historical June 4 changelog entries that mention model-switch replacement are
superseded by the June 22 simplification and must not be treated as the current
design authority.

Primary upstream references:

- https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md
- https://github.com/anomalyco/opencode/blob/dev/CONTEXT.md
- https://github.com/anomalyco/opencode/blob/dev/specs/v2/schema-changelog.md

### 6.7 Resolved fork-local V2 regression: Goal continuation now uses Synthetic history

The local fork previously diverged from upstream V2 by threading
`goalContinuation?: string` into the worker System array, reproducing the V1
authority/cache defect.

The current tree removes that request-head argument and materializes a claimed
Goal reservation through the existing semantic primitive:

```text
GoalAutomation reservation
  -> deterministic SessionEvent.Synthetic
  -> SessionMessage.Synthetic
  -> toLLMMessages(...)
  -> provider role=user
```

True privileged context remains independently owned by System/Context machinery.
The automatic-cycle audit also receives the exact claimed reservation ID,
preserving lease identity through worker -> auditor reconciliation.

The focused V2 integration assertion is inverted accordingly: continuation text
must be durable Synthetic history, must be visible to later worker provider
requests as conversational/user-role content, and must never appear in
`LLMRequest.system`.

Keep this as a permanent local-vs-upstream regression fixture.

### 6.8 Backport warning: Context Epoch correctness depends on source completeness

Auditing the local fork's earlier combined `GoalContext` exposed an important
failure mode that must shape the entire backport: **the Context Epoch algorithm
can be correct while a Context Source is semantically incomplete.**

The pre-fix source put full Goal constraints into its baseline while leaving
`constraints` outside its typed snapshot, and its chronological `update()`
omitted current objective/title/constraints and changed criterion/step text.
Because those fields are mutable, the old design could preserve stale privileged
meaning even while reconciliation correctly noticed a revision change.

The adversarial pass then challenged the deeper premise that all mutable Goal
state belongs in privileged System Context. The pre-fix renderer combined three
different authority/lifetime classes:

- user-owned specification state: objective, constraints, acceptance intent and
  automation/spec policy;
- host/tool-produced progress state: lifecycle status, blocker and
  criterion/step progress;
- stable host mechanism policy: worker != auditor, verification gate and Goal-tool
  behavior.

The Goal tool explicitly describes objective edits, cancellation and automation
policy as user-owned. Elevating that combined surface to System gives user-owned
task state more authority than later user messages and also creates a highly
volatile privileged cache surface.

The preferred split is therefore:

```text
stable Goal mechanism policy
  -> privileged System policy

Goal specification snapshot
  -> sourced Synthetic/user-role context

Goal progress snapshot
  -> sourced Synthetic/user-role runtime context

auditor continuation
  -> host-owned Synthetic/user-role turn
```

The current dirty tree now implements that authority/lifetime split:
`GoalContext` contributes only stable `goal/mechanism` privileged policy,
while mutable Goal specification/progress are separate conversational Synthetic
snapshots. This decomposition is preferred over introducing clever hand-written
deltas to a large combined Goal System source.

The split is semantic, not merely a cache optimization:

- Goal specification/progress may be **host-projected** while still carrying conversational/user-lane authority. Their normal provider representation is therefore a user-role conversational message, not privileged System.
- Goal continuation is likewise host-owned Synthetic orchestration and lowers to provider-user.
- Stable Goal mechanism policy is genuinely host-privileged and belongs on the System surface.
- `owner=host`, provenance source, and `Synthetic` origin do not by themselves grant System authority.
- If an exact provider/runtime cannot preserve a required privileged System representation, the compiler must use a conservative privileged-head projection or fail closed. Wrapping System policy as user text is not a valid semantic fallback.

Therefore the V2 -> V1 effort needs **two proof layers**:

```text
Context Epoch mechanism proof
  AND
rendered-section admission/composition proof
```

For every source that remains genuinely privileged after authority
classification, require:

1. one observation yields exactly one of `present(rendered)`, `absent`, or
   `unavailable`;
2. `present(rendered)` contains all model-visible meaning owned by that section;
3. the framework compares exact rendered bytes, not a surrogate typed value;
4. `absent` removes the section while `unavailable` preserves only a compatible
   last-admitted rendering;
5. stable section composition/order has one framework owner;
6. post-compaction reprojection yields exactly the same current semantic System
   state without summarizing old System state;
7. a projection-version change does not itself create prompt churn when a fresh
   observation produces byte-identical rendering.

And separately prove the source loader's **producer freshness**. A correct
complete-section renderer over a stale upstream catalog is still wrong. The
current `SkillGuidance -> SkillV2.list()` path is the concrete warning: the
guidance source can be semantically complete while the confirmed Skill reload
cache gap feeds it stale authoritative input.

The full source-admission checklist is therefore:

```text
authoritative producer freshness
  AND
rendered-section completeness
  AND
absence/unavailability correctness
  AND
epoch admission/replay correctness
```

This source-level contract should be tested before a source is admitted to the V1
backport. Cache hit rate is downstream of semantic completeness.

### 6.9 Keep three different continuity domains separate

The upstream/Harness comparison makes one source of design confusion explicit:

```text
OpenCode Context Epoch continuity
  != request/message-series continuity
  != remote provider cache-domain continuity
```

Examples:

- a model/provider switch preserves the OpenCode Context Epoch, because the
  durable semantic baseline/history did not become false;
- the destination model can still have a completely cold provider cache domain;
- DeepSeek Harness does not automatically treat a provider/model swap as a new
  message series for SystemPromptProjection; its own `REPLACE_COMPLETE`-style
  in-history capability can still append the changed complete rendering because
  the cache miss is already paid by the route change;
- a tool-schema/surface replacement can start a new request series without
  changing the conceptual conversation or necessarily changing provider/model;
- completed compaction intentionally starts a new OpenCode Context Epoch and also
  changes the active message surface.

The V1 backport should therefore never use one boolean like `cacheInvalidated` to
stand in for all three domains. Tests/diagnostics should record them separately.
OpenCode need not persist Harness's request/message-series concept unless later
correctness work proves it is semantic state rather than a derived optimization.

### 6.10 Direct upstream-diff results for the architecture-critical files

A local `git diff upstream/dev` over the V2 cache/context spine produced a useful
audit snapshot:

- `runner/to-llm-message.ts` has no local delta: Synthetic/System canonical
  lowering is upstream-aligned;
- `SystemContext` semantics are aligned; the fork bounds observation concurrency
  at 8 instead of upstream's unbounded fan-out;
- `SessionContextEpoch` semantics are aligned; the fork adds a dedicated `readDb`
  for stored-epoch/compaction reads;
- Session-message/event local deltas around this area are telemetry/lifecycle
  additions, not a redefinition of Synthetic/System meaning;
- local V2 runner has a large fork delta around Goal Automation; the historical
  `goalContinuation` System injection was the cache-critical semantic divergence
  and is now corrected to durable Synthetic history;
- current compaction selection is bounded by token budget in both current local
  and `upstream/dev`; local policy constants differ materially and require
  measurement.

This is stronger than treating "V2" as one opaque implementation: the useful
Context Epoch and message semantics remain close to upstream, while the former
Goal-continuation placement was a narrow fork-owned regression that is now pinned
by a local negative invariant.

---

## 7. DeepSeek Harness as a design reference

DeepSeek Harness independently converges on several of the same principles and
is useful as an external architecture seed.

Relevant references:

- `https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md`
- `https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md`
- `https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-projection.md`
- `https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md`
- `https://api-docs.deepseek.com/guides/kv_cache/`

### 7.1 System prompt changes are modeled by cache effect

Harness documentation explicitly distinguishes:

- replacing a head system node, which loses prefix reuse from the first changed
  token;
- an `in-history` prompt update, which appends after retained history and keeps
  the preceding prefix reusable.

That is the same optimization goal as V2's Context Epoch, but Harness is stricter
about the route-capability decision: the projection chooses in-history placement
only for an exact prepared route that declares the capability. This distinction
matters because OpenCode currently creates the chronological System semantic
message before provider lowering discovers whether the selected route can
preserve that authority.

### 7.2 Dynamic runtime context is not forced into the stable system head

Harness documents dynamic prompt context as durable/sourced user-role snapshots
when appropriate. That is strong external support for the V1 provenance model:
changing host runtime/orchestration material should not automatically become a
head rewrite.

### 7.3 Projection caches are accelerators, not authority

Harness session projection caching treats the canonical session log as authority
and persisted projection checkpoints as bounded restart/read accelerators.

This matches the OpenFork rule:

> a cache may trail, but it must never become a second semantic truth.

### 7.4 Stable tool-schema composition is part of cache shape

Harness explicitly documents schema set/order changes as KV-cache busts.

OpenCode should therefore consider stable tool definition ordering and stable
visibility decisions part of the request-prefix contract, not unrelated request
metadata.

### 7.5 Harness uses two different projections for two different authority classes

The current Harness implementation is stronger evidence than the earlier broad
"append dynamic context" summary because it deliberately keeps two mechanisms
separate:

**`SystemPromptProjection`**

- owns genuinely privileged system-prompt state;
- commits it as `system/message` derived history;
- replaces/consolidates the head when the route cannot honor in-history system
  updates or when a new request series begins;
- appends a changed non-empty system node after retained history only when the
  exact prepared route declares `systemPromptUpdate: "in-history"` and the
  request remains in the same series.

**`RuntimeContextProjection` / `PromptContext`**

- owns dynamic runtime facts that do not need system privilege;
- materializes a complete sourced **user-role snapshot**;
- appends only when that complete snapshot changes;
- keeps producer/source identity separate from provider role.

That is almost exactly the distinction this V1/V2 audit arrived at independently:

```text
privileged context change -> typed System semantic path
host/runtime orchestration -> typed Synthetic/user-role semantic path
```

Do not collapse them merely because both can improve prefix-cache reuse.

Primary Harness references:

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/system-prompt.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md

### 7.6 Audit correction: cache-safe append is request-series scoped

The earlier wording "append-only preserves the prefix" was incomplete.

Harness makes the missing condition explicit:

> append-only is cache-preserving only while the earlier system text, tool
> schemas, retained history, provider/model route, and route capability remain
> compatible within the same request series.

A new series can be caused by changes such as the effective request header/tool
surface or a surface replacement. On a new series, `SystemPromptProjection`
consolidates the current effective system state at the head instead of blindly
appending another in-history update.

For OpenCode's deterministic cache lab, therefore distinguish:

```text
message mutation mode:
  append | replace | reorder | remove

request-series transition:
  continue | break

provider cache-domain transition:
  same | changed
```

Only the combination `append + continue + same` supports the strongest reusable-
prefix expectation.

### 7.7 Harness records enough request identity to reconstruct why a series changed

Harness persists/logs separate request facts rather than inferring them later:

- `request/header` owns canonical call config + assembled tool schemas and records
  `initial | resume | change | series` reasons;
- `request/context` records provider, model, context window, and
  `systemPromptUpdate` capability when changed;
- model-visible messages are derived from the authoritative Session log;
- derived message identities and request envelopes are frozen before dispatch.

This is a useful **observability/proof pattern**, not necessarily a direct data
model to clone. OpenCode's cache-bust lab should be able to explain a miss in the
same dimensions:

```text
history changed?
system generation changed?
tool/header changed?
provider/model route changed?
system-update capability changed?
series broke?
```

That is substantially more diagnostic than a single prompt digest.

### 7.8 The adversarial comparison reveals three Harness advantages worth adopting

The comparison is now strong enough to identify concrete mechanisms where
Harness is a better reference than current OpenCode V2:

1. **Projection versioning.** Projection cache units carry an explicit
   `stateVersion`; an incompatible persisted projection is discarded/rebuilt
   rather than trusted because its value happens to decode. OpenCode's
   `SystemContext.SourceSnapshot` has no equivalent render/semantic version.
2. **Complete prompt surface.** System-prompt projection works from the complete
   effective prompt surface. A change does not rely on each source author writing
   a perfectly complete semantic delta by hand.
3. **Route-aware placement.** The exact prepared route's
   `systemPromptUpdate` capability participates in whether the changed prompt is
   appended in history or consolidated at the head.

These are principles to absorb, not a data model to copy wholesale. In
particular, OpenCode should not introduce another projection database merely
because Harness has one. The source-of-truth rule remains: one durable semantic
owner, with any projection/cache subordinate to it.

---

## 8. Recommended V1 backport architecture

### Phase A — finish provenance first

Complete the concurrent V1 provenance overhaul before attempting generalized
context epochs.

Requirements:

- all new durable user-role producers stamp ownership;
- trusted host producers retain specific source/ref identity;
- compatibility inference exists in exactly one Core module;
- purpose-specific selectors replace semantic role/part heuristics;
- provider lowering ignores provenance;
- Goal-specific correlation metadata is no longer authoritative.

This phase already removes a major class of prefix busts.

### Phase B — harden the shared Context Source contract before migrating V1

Do **not** move more V1 producers onto the current `SystemContext` API until the
shared primitive itself closes the adversarial findings.

Required hardening:

1. persist exact admitted rendered bytes rather than treating typed source value
   equality as provider-visible identity;
2. model source availability policy explicitly so a newly introduced required
   source cannot fail open;
3. distinguish `absent` from temporary `unavailable` explicitly;
4. own stable ordering/composition once in the framework, not in every persisted
   source row;
5. make one framework projection version govern whether unavailable persisted
   bytes may be carried across code-format changes;
6. compose exact current privileged state from admitted rendered sections;
7. prove source loader freshness all the way back to its authoritative producer.

The preferred conceptual contract is:

```ts
{
  key
  observe: () => present(rendered) | absent | unavailable
  availability: "required" | "optional"
}
```

with durable admitted state conceptually like:

```ts
{
  projectionVersion
  sections: Record<SourceKey, string>
}
```

Custom `update(previous,current)` and `removed(previous)` prose should be deleted
from the correctness path. GoalContext demonstrates why: detecting a changed
typed value does not prove that hand-written delta text fully supersedes the
previous privileged meaning. `absent` means remove the section from current
state; `unavailable` means retain a compatible last-admitted section if one
exists.

Do **not** force a provider-visible replacement merely because implementation
version changed. If a source is available and renders byte-identically under the
new code, current semantic/cache state is unchanged. Projection version matters
when a source is unavailable: old persisted bytes may be retained only when that
checkpoint format is declared compatible. Otherwise a required unavailable
source blocks generation until it can be observed again.

### Phase B.1 — make the System surface exact before optimizing placement

The next adversarial pass found that today's `SessionMessage.System` is not a
single trustworthy model-visible semantic surface. `ContextUpdated` is used by
Context Epoch **and** by host-owned special agents.

Some special-agent System rows are durable transcript markers that never appear
in the outbound provider request:

- Goal Auditor's `[GOAL AUDIT CYCLE] ...` marker;
- Prompt Revisor's revision-cycle marker.

Other paths publish one correction marker but inject different System text on the
next request. Reminder/time-pressure paths more often publish and inject the same
text.

Therefore do not add a `state | directive` flag to the existing event and call
the problem solved. The preferred invariant is stronger:

> **One semantic System state is the complete effective privileged prompt. A
> durable provider-visible System entry must mean the model actually receives
> privileged content derived from that state; non-model-visible lifecycle
> annotations are non-surface events.**

What currently looks like a privileged “directive” is usually better modeled as
an active policy overlay feeding the complete System surface:

```text
base agent/host policy
  + ambient privileged Context Sources
  + active reminder overlay
  + active protocol-correction overlay
  + active time-pressure overlay
  -> complete effective System prompt
```

The special-agent implementations already point in this direction:
`activeReminder` and `timePressure` are persistent local state rather than
fundamentally one-shot messages.

If a genuinely turn-scoped privileged overlay is needed, model its lifetime
explicitly. Provider-native turn-scoped features may project that lifetime
without rewriting the head; on incapable routes the compiler can include/remove
the overlay through the route's normal head/current-state strategy.

Current Anthropic `clear_at: "next_user_message"` is now a concrete reference
for this class. It preserves the historical message byte-for-byte but stops
rendering/costing it after a later user message.

### Phase B.2 — `SystemContext` is not the final privileged owner

Current OpenCode has privileged contributors outside the Context Source registry.
V1 request preparation composes provider/model base policy, selected-agent policy,
caller system input and `PromptInput.system`, then allows
`experimental.chat.system.transform` to mutate the final system array. Current V2
also places `agent.info?.system` beside the Context Epoch baseline.

Therefore the final authority boundary must sit above `SystemContext`:

```text
provider/model policy
agent policy
ambient privileged Context Sources
stable host mechanism policy
active privileged overlays
authorized plugin transformation
             │
             ▼
       SystemSurface assembler
             │
             ▼
 exact complete privileged state / section bytes
             │
             ▼
 provider projection strategy
```

`SystemContext` should own current ambient sections, not claim that its baseline
is the entire provider System surface.

Legacy plugin transforms are especially important. An arbitrary final-system
transform destroys trustworthy section boundaries. During migration, treat the
plugin's transformed result as one opaque complete privileged section rather than
attempting to reconstruct which underlying section changed. A later section-aware
plugin API may recover granular diffs without weakening correctness.

### Phase C — move Goal reservation/materialization ownership to its producer

This is logically independent from privileged Context Sources and should be fixed
before generalized V1 context work.

Current V1 Goal continuation materialization reconstructs two facts from
transcript history:

- whether the reservation was already materialized;
- which worker/root message owns the causal boundary.

That violates the root ownership rule because `GoalAutomation` already creates
and durably owns the reservation. The reservation record should carry the causal
root and enough stable materialization identity to make publication idempotent
without scanning `WithParts` history.

Current V1 also publishes the continuation message and text part separately.
Therefore closure requires a crash-point proof:

```text
before message
after message / before part
after part / before reservation transition
after reservation transition
restart at each point
```

At every point, the system must converge to exactly one **complete** continuation
or an explicitly retryable reservation. A correlated empty turn must never count
as completion.

The narrow implementation could be:

- one composite durable append-turn-with-parts boundary if the existing event
  architecture can own it cleanly; or
- deterministic/stored message + part IDs plus idempotent upserts and an explicit
  materialization-complete state owned by GoalAutomation.

Do not add a transcript index/cache merely to make the existing scans faster.

### Phase D — resolve exact route capability before privileged-context projection

This is the hardest shared architectural slice and is the point where the earlier
"backport V2" plan was too optimistic.

The **legacy/V1** failure order remains:

```text
reconcile / assemble context without exact effective capability
  -> persist or emit chronological System intent
  -> resolve/lower provider request
  -> unsupported route may demote System into wrapped user text
```

The hardened V2 Context Epoch path now implements the authority-preserving order
for its ambient/context-source slice:

```text
resolve exact model + native effective capability
  -> observe/reconcile exact current System sections
  -> project according to exact capability:
       HEAD_ONLY
         => complete current state at privileged head
       CUMULATIVE_PRIVILEGED
         => true ordered suffix addition may append privileged history
         => replacement/removal/reorder rebaseline complete head
       REPLACE_COMPLETE
         => append complete current state only when provider contract says so
  -> provider-specific encoding
```

Initial epoch creation may occur before model resolution because there is no
chronological privileged history to reinterpret: it stores an inactive complete
baseline. On subsequent turns the exact model is resolved before
`SessionContextEpoch.prepare`.

This is still not the final all-contributor privileged assembler. Selected-agent
System policy, provider/model policy, caller System, overlays, and legacy V1
plugin transformation remain outside the Context Epoch `SystemSurface` cutover
and must be unified above their respective authoritative producers.

The session layer should consume a provider-neutral **effective** capability; it
must not know Anthropic/OpenAI wire syntax or model-name tables. The effective
capability is the intersection of provider/model semantics and the selected
runtime/adapter's encoder support:

```text
provider/model capability
  ∩ runtime adapter capability
  = effective projection capability
```

Unknown is `HEAD_ONLY`. Never emit a raw in-history System role merely because a
provider family sometimes accepts it.

Current `SessionMessage.System` is only a safe semantic target after its
contract is narrowed to exact model-visible privileged surface. A wrapped user
message is **not** an equivalent implementation of that kind.

DeepSeek Harness independently validates the `REPLACE_COMPLETE` branch:
`systemPromptUpdate: "in-history"` explicitly means the latest System message is
the complete effective prompt. It must not be generalized into a cross-provider
definition of “supports chronological System.”

Current Anthropic is instead `CUMULATIVE_PRIVILEGED`: later System instructions
apply from their point onward and later conflicts beat earlier System
instructions. Omission does not structurally revoke old non-conflicting policy.
Anthropic documents state-change and exit-notice use cases, but that is not a
provider-defined arbitrary keyed-state replacement primitive. The initial
compiler should therefore use cumulative placement for additive/scoped updates;
general replacement/removal remains head-projected until a mechanical patch
protocol is separately proven.
Current OpenAI docs establish useful later developer-message suffixes for cache
stability, but not complete-replacement semantics; arbitrary state replacement
therefore remains fail-closed to the head until a stronger exact route contract
is proven.

### Phase D.0 — close the current Anthropic runtime divergence first

This is now a concrete no-send bug class, not only a future abstraction concern.

Current local native behavior:

```text
anthropic-messages + exact claude-opus-4-8
  -> inline privileged System

other Anthropic models
  -> escaped user-role fallback
```

Installed default-runtime `@ai-sdk/anthropic@3.0.111` behavior, proven with a
local converter micro-test:

```text
[System("BASE"), User("work"), System("REMINDER")]
  -> top-level system = BASE
  -> messages += role:"system", content:"REMINDER"
  -> beta += mid-conversation-system-2026-04-07
```

The converter performs no model capability check.

Current Anthropic primary docs instead support ordinary mid-conversation System
on Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 4.8 and Opus 5; explicitly not
Sonnet 5; and require no beta header for ordinary System updates. Turn-scoped
`clear_at` is a separate beta capability.

Before generalized System-surface migration, deterministic tests must prove that
unsupported model/runtime combinations are rejected or projected head-only
**before network send**, and that native/AI-SDK runtime selection cannot silently
change the semantic authority/validity of the same request.

### Phase D.0.1 — do not persist “request series” prematurely

Harness persists request/header series because its surface architecture uses that
fact directly. Current OpenCode has no equivalent authoritative aggregate.

Treat `request series` initially as a **derived cache/projection diagnostic**:

```text
history/system/tool/header/model/runtime fingerprint changed?
  -> classify continuation/break reason for diagnostics and optional rebaseline
```

Do not introduce a durable `RequestSeries` table/event/state machine unless a
semantic correctness requirement, rather than a cache optimization, proves it is
necessary. A known tool/header prefix break may justify opportunistically
consolidating old System tails, but failing to do that optimization must not
change authority.

### Phase D.1 — compaction is a projection reset, not an authority translator

Current V2 compaction serializes `SessionMessage.System` into the summarizer as
`[System update]: ...`. The summary then returns as provider-user historical
context while Context Epoch separately re-establishes current privileged state.

That can fossilize stale privileged state into a lower-authority summary.

The migration rule is:

```text
stateful projection
  -> do not summarize old copies
  -> reproject current authoritative state after compaction

historical event
  -> may be summarized according to normal relevance policy
```

Accordingly:

- complete System surface state is excluded from conversational summary;
- sourced Goal specification/progress snapshots are excluded and reprojected
  current after compaction;
- Goal continuation remains historical orchestration and may participate in
  summary/history;
- monitor observations remain historical observations rather than current-state
  projections.

### Phase E — migrate V1 sources one at a time through a thin adapter

Only after B-D are correct should V1 converge source-by-source:

1. environment/date;
2. ambient instructions;
3. skill guidance;
4. project reference guidance;
5. stable Goal mechanism policy only if it remains a distinct privileged source
   after Goal authority decomposition.

For each source:

- prove V1 semantic parity;
- prove producer freshness;
- prove render-version behavior;
- prove unavailable behavior;
- prove both route strategies (chronological System vs head rebaseline);
- delete the legacy producer after cutover.

Do not retain both legacy and shared rendering in production after migration.

### Phase E.1 — classify every V1 model-visible contributor before migrating it

The current V1 loop has several model-visible inputs with different authority and
lifetimes. They must not all become `SystemContext` merely because they are
currently assembled near `system`.

| Current contributor | Semantic class | Recommended owner / migration | Cache-series expectation |
| --- | --- | --- | --- |
| provider/model base prompt (`SystemPrompt.provider(model)`) | route-scoped privileged identity | request/compiler route boundary; stable within exact model route | model/route switch changes cache domain |
| explicit agent prompt | selected-agent privileged identity | agent-selection / SystemSurface owner | stable while selected agent prompt is unchanged |
| environment/location/date | privileged ambient facts | hardened Core Context Source section | exact rendered-section change; projection chosen by effective capability |
| ambient `AGENTS.md` instructions | privileged user/repository policy | hardened `InstructionContext` section | exact rendered-section change; capability-specific projection |
| project references | privileged discovery guidance | hardened `ReferenceGuidance` section | exact rendered-section change; capability-specific projection |
| available-skill guidance | privileged capability guidance | hardened `SkillGuidance` section | exact rendered-section change; capability-specific projection |
| stable Goal mechanism policy | privileged host/runtime rule | small stable System source or agent/tool policy seam | changes rarely; route-aware privileged update/rebaseline |
| Goal specification snapshot | user-owned durable task specification, host-projected | sourced Synthetic/user-role projection correlated to Goal/user root | append complete spec snapshot only when specification changes |
| Goal progress snapshot | host/tool-observed durable task progress | sourced Synthetic/user-role runtime projection | append compact complete progress snapshot only when progress changes |
| Goal auditor continuation | host orchestration, not privileged context | durable Synthetic / V1 host-owned user-role provenance | append after retained history; prior bytes remain unchanged |
| monitor ingress (`untrusted-external-data`) | host-observed untrusted runtime data | sourced Synthetic/user-role runtime observation; durability decided by retry semantics | append after retained history, never system-head merely to label data untrusted |
| MCP server instructions | unresolved trust/authority class | decide trust first; then privileged Context Source **or** sourced user-role context | connect/permission/instruction changes need explicit update/series rules |
| structured-output guidance + output tool | request-local output/control surface | request-format/header owner, not durable ambient Context Source | intentional request-surface break when format/tool surface changes |
| `PromptInput.system` | explicit per-turn privileged override | preserve as caller-selected request/turn contract unless redesigned | intentional privileged-surface mutation |
| `experimental.chat.system.transform` output | plugin-owned privileged mutation | plugin/request-compiler seam with deterministic generation identity | included in final prepared/native digest |
| explicit lazy-tool mention context | request-local sourced capability metadata | existing request-only user-role tail unless durability is proven necessary | append-only; global tool manifest stays stable |
| unknown-finish continuation | attempt-local recovery guidance | request-only user-role tail unless replay semantics require durability | append-only |

The semantic class is chosen from authority/lifetime first. Cache economics are a
consequence, never the classifier.

### Phase E.2 — monitor ingress is a confirmed authority **and loss** defect

`SessionIngress.MonitorIngressEvent` explicitly marks payload as
`trust: "untrusted-external-data"`. `formatMonitorEvents()` further says these
observations are not user messages, not permission decisions, and have no user
authority. V1 nevertheless places the complete formatted batch into the
privileged system array.

A privileged wrapper saying “treat the following data as untrusted” does not
change the provider role of the embedded data. Structurally, DeepSeek Harness's
runtime-context model is a better match: sourced dynamic facts become user-role
snapshots, separate from system-prompt sections.

The follow-up audit proves the current request-local implementation is not merely
an open durability choice:

- `drain()` destructively removes the complete in-memory session queue;
- `formatMonitorEvents()` renders only the newest 8 batches;
- a 10-batch micro-prototype rendered only batches 3-10;
- failure/restart after the destructive drain has no durable admission record to
  reconstruct what the model did or did not receive.

The target should therefore be a bounded admitted Synthetic/user-role observation
with producer/source identity, or an equivalent bounded take/ack protocol where
ack occurs only after durable admission. Do not persist a second raw stream if the
background-job owner already has an authoritative log; project the minimum
model-visible observation from the owner.

### Phase E.3 — MCP instructions require a trust decision before a cache design

V1 currently takes MCP handshake instructions from connected servers, sorts them
by configured server name, permission-filters them according to associated tool
visibility, and injects them into the privileged system array every generation.

That creates a cache surface on connect/disconnect, instruction text, and
permission changes. More importantly, it promotes external server-authored text
to privileged instructions.

DeepSeek Harness currently avoids making that authority decision: its released
MCP client bridges tools only, and its own documentation/discussion says MCP
server instructions are not currently forwarded to the model and that an
injection design remains unresolved.

Do not blindly port V1 MCP instructions into `SystemContext`. First establish the
trust contract. If the intended semantics are privileged, make the complete
ordered/permission-filtered set one typed source with full supersession/removal.
If they are advisory/untrusted external context, use sourced user-role runtime
context. In either design, canonical ordering and permission coupling belong in
the source/request identity.

### Phase F — keep provider-specific cache mechanics in `packages/llm`

The V1 session owner should emit stable semantic requests. It should not know
about Anthropic cache-control syntax, OpenAI cache option syntax, Bedrock
cache-points, or DeepSeek disk-cache details.

Extend `@opencode-ai/llm` policy/capability support where frontier provider
semantics have advanced.

---

## 9. AI-SDK versus native runtime: the real implementation wrinkle

`packages/opencode/src/session/llm/AGENTS.md` makes the runtime boundary clear:

- AI SDK is still the default execution path;
- the native `@opencode-ai/llm` runtime is opt-in;
- both converge on the same downstream `LLMEvent` stream.

The native stack already has explicit chronological System-update protocol logic,
but today it also has a wrapped-user fallback for routes that cannot express an
in-history privileged system role. Focused Anthropic/OpenAI provider tests confirm
that this downgrade is deliberate current behavior.

The adversarial conclusion is that **neither runtime may own that semantic
fallback**. Runtime selection is below the context-authority decision.

Both execution paths must consume the same route/model capability and the same
already-chosen semantic request strategy:

```text
semantic compiler:
  native chronological System
  OR complete privileged-head replacement/new series

AI-SDK adapter:
  encode chosen strategy

native adapter:
  encode chosen strategy
```

If native and AI-SDK disagree on whether a route can preserve chronological
System authority, the request compiler does not have a trustworthy capability
contract. Fix the capability owner rather than papering over the disagreement in
one adapter.

---

## 10. Zero-paid-inference proof program

Paid model calls are unnecessary for almost all implementation proof.

### Layer 0 — pure semantic tests

Use existing `SystemContext` tests as regression evidence, then add tests for
the newly identified framework gaps. Current tests are not a complete oracle.

Prove:

- byte-identical `present(rendered)` -> `Unchanged`;
- changed rendering -> changed semantic System state;
- `absent` -> section removed from current state;
- admitted source temporarily `unavailable` under compatible projection version
  -> exact last-admitted bytes retained;
- newly introduced **required** source `unavailable` -> block, never silently omit;
- newly introduced optional/advisory source `unavailable` -> explicit documented
  omission policy;
- incompatible projection version + required unavailable admitted source -> block
  until a fresh observation is available;
- projection version changes + fresh byte-identical observations -> `Unchanged`;
- duplicate source keys -> hard failure;
- stable source composition is deterministic regardless of registration timing;
- no source-authored `update(previous,current)` or removal prose participates in
  correctness.

No transport or model is involved.

### Layer 1 — differential semantic-reference tests

The existing V2 runner suite proves high-value behavior such as:

- one durable baseline is reused after producer changes;
- a chronological System update is appended under current behavior;
- updates survive model switches;
- temporary source unavailability does not rewrite the baseline;
- removed context is represented chronologically;
- completed compaction rebaselines;
- replay reconstructs the same semantic state.

Treat those as regression evidence for current behavior, not the desired final
surface contract. New tests must additionally prove that provider-visible System
entries correspond exactly to the strategy selected from current semantic state
and effective provider/runtime capability, and that non-model-visible
special-agent markers never masquerade as System surface.

Run the same mutation scenarios through the V1 adapter and compare an abstract
request model:

```ts
{
  baseline,
  orderedContextUpdates,
  orderedConversationTurns,
  toolManifest,
  modelRoute,
}
```

V1 does not need identical storage rows to V2. It must produce the same semantic
turn kinds and the hardened shared context behavior.

**Do not use the historical local-fork V2 Goal continuation behavior as an
oracle.** That fork-only System injection was a confirmed audit finding and has
now been corrected to the existing `SessionMessage.Synthetic` semantic path.
For Context Epoch behavior, use current upstream V2 as regression evidence, not
unquestioned authority: rendered-byte identity, new-required-source
availability, route/runtime capability and exact model-visible surface truth are
still known gaps in the current shared mechanism.

### Layer 2 — V1 local provider capture

V1 already has `TestLLMServer` support in `packages/opencode/test/session/prompt.test.ts`.

Use fixed local responses and capture every outbound body.

Scenarios:

1. normal user -> assistant -> user growth;
2. Goal continuation;
3. recovery continuation;
4. compaction continuation/replay;
5. instruction change;
6. agent switch;
7. tool visibility change;
8. compaction;
9. model switch;
10. projection-version upgrade with fresh byte-identical source rendering;
11. projection-version upgrade while a required admitted source is unavailable;
12. newly required source unavailable;
13. same privileged mutation under `HEAD_ONLY`, `CUMULATIVE_PRIVILEGED`, and
    `REPLACE_COMPLETE` strategies;
14. same provider/model under AI SDK versus native runtime capability;
15. supported Claude versus unsupported Sonnet 5 no-send/head-only behavior.

No paid provider is required.

### Layer 3 — compile-once provider wire translation validation

`packages/llm` exposes both `LLMClient.prepare()` for pure request compilation and
`LLMClient.compile()` for a stronger proof: `compile()` returns the provider-native
preview and a stream backed by the **same private compiled transport object**.
This removes the epistemic gap where a test inspected one compilation and
production independently recompiled before dispatch.

Use `prepare()` for cheap shape matrices and `compile()` when proving that the
inspected body is the artifact that will actually be dispatched. Snapshot:

- Anthropic Messages;
- OpenAI Chat / Responses;
- DeepSeek's OpenAI-compatible route;
- Bedrock;
- Gemini where relevant.

This proves cache markers/order/body shape without inference cost. A captured
transport test additionally proves `compiled.prepared.body` equals the body sent
by that compiled stream.

### Layer 4 — cache-bust digest harness — initial implementation complete

The initial test-only request-shape analyzer now lives in
`packages/llm/test/cache-shape-lab.test.ts` and is 9/9 green.

For each prepared request derive ordered cache-relevant regions:

```text
route/model identity
cache-isolation metadata
cache mechanics
cache diagnostics/observation metadata
system / instructions
tool schemas in provider order
message 0
message 1
...
generation fields that participate in provider cache identity
```

Record for each region:

- byte length;
- stable digest;
- cumulative digest;
- first differing region/tokenizable text boundary versus previous request.
- derived request-surface continuation/break reason; do not persist a series ID
  merely for this lab;
- effective provider/model route;
- selected runtime/adapter;
- tool/header digest;
- effective System capability
  (`head-only | cumulative-privileged | replace-complete`, plus turn-scoped flag).
  A
  wrapped-user encoding may still exist as a low-level protocol helper, but the
  semantic cache lab must never classify it as authority-equivalent System.

The lab canonicalizes object-key order, preserves array order, represents absent
regions explicitly, and computes both per-region and cumulative framed-prefix
digests. Its first matrix already distinguishes semantic prefix mutation from
`prompt_cache_key` isolation changes, cache-mode changes, and the observational
`comparison_response_id` diagnostic cursor.

The important metric is not merely “request changed.” It is:

> **where is the first cache-relevant difference?**

Expected Goal continuation result:

```text
request N:
  [stable system][stable tools][history........................]

request N+1:
  [same system  ][same tools ][same history....................][new continuation]
                                                                    ^ first difference
```

The current broken architecture instead behaves like:

```text
request N+1:
  [system ... changing continuation ...][history]
              ^ first difference
```

### Layer 5 — prefix-cache simulator

Implement provider-policy simulators over the prepared request shape.

They do not need to predict provider internals perfectly. They only need to
detect **OpenCode-caused deterministic invalidation**.

Examples:

- DeepSeek: overlapping prefix / persisted request-boundary units;
- Anthropic: explicit breakpoint coverage;
- OpenAI: model/cache-key/options + stable prefix boundaries;
- Bedrock: cache-point placement.

The simulator must report separately whether a miss was caused by **message
mutation**, a **derived request-surface break**, or a **provider cache-domain
change**. Otherwise an append after a tool-schema/model transition can be
incorrectly reported as a cache-preserving append.

The simulator should report:

```text
reusable prefix bytes/tokens-estimate
first bust region
reason
intentional vs accidental
```

### Layer 6 — restart/replay determinism

Persist a session, dispose/recreate the relevant runtime layers, then compile the
next provider request again.

Assert:

- same admitted baseline;
- same ordered retained history;
- same tool ordering;
- same provider-visible text;
- same cache-policy markers;
- no update disappears because an in-memory cache was ahead of durability.

This is especially important for context epochs.

Add explicit failure-point injection around host-turn materialization:

```text
before continuation message
after message / before part
after part / before reservation completion
after reservation completion
```

Restart from each boundary and prove convergence to one complete continuation or
an explicitly pending/retryable reservation. Also record history rows touched:
modern reservation recovery must not require a transcript scan.

### Layer 7 — property/fuzz sequences

Generate random sequences of:

```text
user prompt
host continuation
system-context source change
source unavailable / available
tool manifest change
model change
compaction
restart/replay
```

Compare V1 adapter state against a hardened pure semantic model, using existing
V2 behavior only where it satisfies the new invariants.

Useful invariants:

- provider-visible authority never depends on whether AI SDK or native runtime
  happened to be selected;
- snapshot never advances before durable update publication;
- projection-version change with fresh byte-identical rendering causes no
  provider-visible semantic churn;
- required unavailable bytes are never reused across an incompatible projection
  version;
- newly required unavailable context blocks rather than disappearing;
- a model/provider switch alone does not replace the OpenCode Context Epoch;
- a later privileged message occurs only when effective provider/model/runtime
  capability preserves the intended semantics;
- a `HEAD_ONLY` request receives the complete current privileged head rather than a
  lower-authority wrapped-user substitute;
- cumulative state replacement/removal is never encoded as simple omission;
- `REPLACE_COMPLETE` is used only when the provider contract defines the newest
  privileged message as the complete effective state;
- every host continuation has explicit provenance;
- provenance never changes provider content bytes;
- no Goal reservation correlation/causal-root lookup requires scanning message
  parts/history for modern rows.

### Layer 8 — local performance closure

Run 1 / 3 / 6+ simultaneous sessions against the fixed local LLM server.

Measure:

- request preparation p50/p95;
- CPU time;
- SQLite reads/writes;
- serialized request bytes;
- history rows touched per turn;
- `SystemContext` source loads;
- number of workspace/Instance materializations;
- memory retained per session;
- event count per logical turn.

Required shape:

- O(1) provenance lookup for modern rows;
- no new N-per-message ownership classification;
- no new poller/timer;
- no new full-history read solely for cache policy;
- context reconciliation cost scales with registered context sources, not total
  transcript length.

---

## 11. Optional live-provider confirmation budget

Live calls should be a final external confirmation, not the development loop.

The merge should be defensible with **zero** paid inference calls.

If external confirmation is desired after all deterministic tests pass, use a
tiny pre-registered matrix:

```text
per provider:
  call A: fixed stable prefix + short user suffix
  call B: same prefix + appended short suffix
  call C: deliberately mutate one early prefix field
```

Observe only cache accounting/TTFT metadata needed to confirm the predicted
shape.

For OpenAI Responses on GPT-5.6+, prefer the provider's diagnostics-only
`comparison_response_id` mechanism for this optional confirmation. It compares a
current response against one stored reference response without loading the prior
conversation or changing cache behavior; returned diagnostics can classify a hit
or miss and expose reusable/missed token counts. Treat this as an **optional live
oracle**, not normal production telemetry or Session state.

The installed AI SDK currently lags this native Responses capability, so do not
make diagnostic parity across AI SDK/native runtimes a semantic requirement.
Likewise, the current OpenAI Responses reference lists `prewarm`, but its exact
lifecycle/cost contract remains insufficiently specified for this backport; leave
it unsupported until the provider documents the ownership semantics precisely.

DeepSeek is particularly useful because its API documents disk context caching
as an overlapping-prefix mechanism and exposes cache-hit/cache-miss token
accounting. A three-call microcase is enough to seek **positive external
confirmation** of the harness, not dozens of expensive agent turns.

Do not make one missing hit a hard failure: DeepSeek documents cache operation as
best-effort and says cache construction can take seconds. The deterministic
`LLMClient.prepare()` / request-digest proof remains authoritative for whether
OpenCode changed the prefix. A live experiment should use a bounded, predeclared
delay/retry allowance and treat cache-hit tokens as positive confirmation rather
than treating one provider miss as proof of an OpenCode regression.

Do not use live inference to discover basic request-shape bugs that
`LLMClient.prepare()` could have proven locally.

---

## 12. Cache-bust scenario matrix

| Mutation | Expected cache behavior | Backport rule |
| --- | --- | --- |
| New ordinary user turn | append-only | prior system/tools/history remain stable |
| Goal continuation | append-only | host-owned user-role turn; never system-head mutation |
| Scheduled-task first turn | new request surface | explicit host provenance; no spoofable public field |
| Recovery continuation | append-only | correlate to checkpoint/root user turn |
| Ambient instruction content changes | capability-specific privileged projection | compare exact rendered section bytes; `HEAD_ONLY` rebases, cumulative defaults to head for replacement/removal, replace-complete may append full state |
| Skill/reference list changes | same capability-specific rule | stable source key/composition; exact rendered-byte identity |
| Goal state revision changes | user-role sourced state after authority split | current Goal specification/progress snapshots; never partial privileged status delta |
| Tool set changes | expected cache bust from first changed schema | canonical ordering; no incidental reorder |
| Tool order changes with identical set | no change unless order is explicitly semantic | canonical deterministic order or explicit durable/tool-config order |
| OpenAI GPT-5.6+ `prompt_cache_key` changes with identical input | provider cache-domain/isolation break only | do not mislabel as semantic prompt mutation; reuse scope requires explicit confidentiality/accounting owner |
| OpenAI GPT-5.6+ implicit ↔ explicit cache mode with identical input | cache mechanic changes, semantic input unchanged | classify separately; do not rebuild Session semantics |
| OpenAI GPT-5.6+ `comparison_response_id` changes | diagnostic observation only | never treat as input/cache-mechanic mutation or persist as Session state |
| OpenAI GPT-5.6+ manual `CacheHint` | explicit content-block breakpoint on exact supported route | capability-gated; no proxy inference |
| Model/provider changes | new provider cache domain expected; Context Epoch baseline remains semantically unchanged | do not rebaseline merely because the remote cache domain changed |
| Compaction | intentional replacement | explicit rebaseline boundary |
| Previously admitted source temporarily unavailable | no semantic change when checkpoint compatible | retain exact last-admitted rendered bytes; do not erase context |
| Newly introduced required source unavailable | block provider dispatch | never silently omit required privilege/policy |
| Projection version changes; source freshly renders identical bytes | no provider-visible change | version does not create churn by itself |
| Projection version changes; required admitted source unavailable | block until fresh observation | do not carry persisted bytes across incompatible projection format |
| Provider/model supports later System but selected runtime encoder does not | head-only | effective capability is provider ∩ runtime, never provider-only guess |
| Unsupported Sonnet 5 with AI SDK capable of serializing later System | head-only/no raw later System | encoder ability cannot create provider capability |
| Restart with unchanged durable state | identical request shape | deterministic replay |

---

## 13. Hardness by implementation seam

### 13.1 V1 provenance completion — low/moderate

The schema/storage path is cheap because JSON persistence already carries the
message payload.

Risk is semantic coverage:

- missing producer stamping;
- overly broad selector;
- treating generic `host.prompt` as enough attribution;
- stale legacy heuristic leaking outside the compatibility module.

### 13.2 Shared Context Source hardening — moderate/high

The current reconciliation algorithm is compact, but the adversarial pass proved
that its durable identity is incomplete. The hard part is making semantic
interpretation explicit without creating another source of truth.

Required work:

- persist/compare exact admitted rendered section bytes rather than typed-value
  surrogates;
- explicit `present | absent | unavailable` observation state;
- framework projection version only for deciding whether persisted unavailable
  bytes are still compatible, not as an automatic prompt-bust token;
- required-vs-optional availability policy;
- deterministic framework-owned section composition/order;
- no model-visible closure-only state or source-authored partial-delta correctness;
- producer freshness proof.

### 13.3 Goal continuation publication — moderate proof burden

The semantic placement is easy. Crash-safe publication is not.

Current V1 has two separate durable writes (message, then part) plus transcript
scans for correlation/root recovery. The correct fix must eliminate those scans
and prove every interruption boundary.

The code size should remain small because GoalAutomation already owns a durable
reservation row. The difficulty is choosing the narrowest composite/idempotent
publication seam without introducing a second reservation state machine.

### 13.4 Route-aware privileged-context projection — high

This is the main remaining architectural problem.

It crosses:

```text
Core semantic message
  -> selected exact model/route capability
  -> append-vs-rebaseline semantic decision
  -> V1/current durable representation
  -> MessageV2 / request conversion
  -> AI SDK default path
  -> native LLM path
  -> provider encoding
```

That breadth, not algorithmic difficulty, is why it scores highest.

### 13.5 Thin V1 source convergence — moderate

Once 13.2 and 13.4 are shared/correct, V1 should contain only compatibility
adapters and source cutover logic. The main risk is accidentally leaving the old
producer alive and duplicating privileged prompt bytes.

### 13.6 Provider cache policy — moderate and isolated

Provider cache features evolve. The correct owner is already isolated in
`packages/llm`, so the blast radius is bounded if the abstraction stays there.

---

## 14. Rejected architectures

### 14.1 “Cache the V1 system string”

Rejected: optimizes reconstruction but preserves head mutation and duplicate
authority.

### 14.2 “Everything synthetic is host-owned”

Rejected: fragment origin and turn ownership are different facts.

### 14.3 “Every role=user is human/user-owned”

Rejected: Goal/compaction/scheduled/recovery turns intentionally use provider
user role.

### 14.4 “Use provenance.source to emit provider system role”

Rejected: source attribution becomes a privilege boundary and violates the
canonical contract.

### 14.5 “Keep V1 legacy prompt producers and also add SystemContext”

Rejected after transition: duplicate prompt tokens and competing authority.

### 14.6 “Replay/scan all messages each turn to derive context updates”

Rejected: consumer-first reconstruction and transcript-length scaling.

### 14.7 “Backport the whole V2 runner”

Rejected: far larger execution/concurrency blast radius than required.

### 14.8 “Wrapped user text is a safe fallback for privileged System”

Rejected: it preserves chronological placement by changing authority. A
`HEAD_ONLY` effective route/runtime must receive the complete current privileged
head and pay any resulting cache reset.

### 14.9 “Typed value equality is enough to persist Context Epochs across upgrades”

Rejected: a typed value is only a surrogate for provider-visible meaning. Persist
the exact admitted rendering. On upgrade, freshly render available sources and
compare bytes; use projection version only to decide whether unavailable persisted
bytes are compatible.

### 14.10 “Make Goal reservation scans cheaper”

Rejected: the reservation producer already owns correlation and causality.
Indexing/caching the transcript scan optimizes the wrong owner.

---

## 15. Required negative invariants

The backport is not closed until tests prove at least the following.

| Invariant | Required |
| --- | --- |
| Public/network PromptInput can claim `owner=host` | **Impossible** |
| New ordinary prompt is user-owned | **Yes** |
| Trusted host admission is host-owned | **Yes** |
| Trusted host caller can preserve exact source/ref without public spoofing | **Yes** |
| Goal continuation is host-owned | **Yes** |
| Goal continuation still lowers as provider user role | **Yes** |
| Goal continuation appears in worker system head | **Never** |
| Crash after Goal message but before text part can suppress recovery | **Never** |
| Modern Goal reservation dedupe/root lookup hydrates transcript history | **Never** |
| Local V2 Goal continuation is threaded through `runTurn(...goalContinuation)` | **Never after correction** |
| V2 Goal continuation is represented by durable `SessionMessage.Synthetic` (or its exact owned equivalent) | **Yes** |
| Goal continuation rewrites prior provider-visible bytes | **No** |
| Synthetic MCP fragment makes entire user prompt host-owned | **Never** |
| Modern provenance lookup walks parts/history | **No** |
| Legacy part inference occurs outside compatibility resolver | **No** |
| Host continuation can become original worker objective accidentally | **No** |
| Checkpoint anchors autonomous continuation instead of causal root | **No** |
| Provenance itself changes provider-visible prompt bytes | **No** |
| Privileged system role is derived from provenance source | **Never** |
| Provider-visible System strategy is chosen without selected-runtime capability | **Never** |
| Provider capability is inferred from a Claude-looking model id through an unaudited proxy transport | **Never** |
| Sonnet 5 receives raw later System merely because AI SDK can serialize it | **Never** |
| Cumulative privileged state removal is encoded by omission alone | **Never** |
| `REPLACE_COMPLETE` is used without a provider contract defining latest privileged message as complete state | **Never** |
| Durable `SessionMessage.System` contains a lifecycle marker the provider never received | **Never** |
| Conversational compaction summarizes stateful System projection into user-role history | **Never** |
| `HEAD_ONLY` effective route receives a lower-authority wrapped-user substitute for required System authority | **Never** |
| Projection version changes + fresh byte-identical render forces provider-visible churn | **Never** |
| Incompatible projection version reuses required unavailable persisted section bytes | **Never** |
| Newly introduced required source is unavailable and silently omitted | **Never** |
| Section observation depends on hidden model-visible state not represented in its rendered result | **Never** |
| Model/provider switch by itself replaces Context Epoch baseline | **No** |
| Later privileged message occurs when effective provider/model/runtime capability cannot preserve its semantics | **Never** |
| A derived request-surface break is mislabeled as an ordinary cache-preserving append | **Never** |
| Temporary source failure erases admitted context | **No** |
| Monitor `drain()` removes batches that are then dropped by the formatter cap | **Never** |
| Tool definition order depends on incidental registration timing when order is not semantic | **Never** |
| Restart changes request shape without durable semantic change | **No** |
| Cache handling creates another workspace Instance | **No** |
| Cache policy requires a new full-history scan | **No** |
| 6 sessions imply 6 new cache timers/streams | **No** |

---

## 16. Suggested implementation order

### Stage 1 — finish the live provenance campaign

1. complete producer census;
2. give trusted host callers precise source/ref attribution;
3. replace semantic role/part heuristics with purpose-specific selectors;
4. update stale Goal tests away from legacy part metadata;
5. add provider-byte-equivalence tests for provenance.

### Stage 2 — close Goal materialization ownership/crash semantics

1. persist/derive causal root at Goal reservation creation;
2. give the reservation stable materialization identity;
3. eliminate history scans for modern dedupe/root lookup;
4. make message+content publication atomic or explicitly idempotent/complete;
5. inject crashes at every publication boundary and restart.

Do not continue generalized context work while an autonomous continuation can be
silently lost.

### Stage 3 — build the deterministic cache-bust lab

1. add request-region digest helper;
2. add V1 `TestLLMServer` scenarios;
3. add `LLMClient.prepare()` provider snapshots;
4. add first-difference reports;
5. establish current V1/V2 baselines before context migration.

Also pin the **upstream-V2 versus local-fork delta** so later merges cannot
silently reintroduce fork-only head mutations. The now-removed Goal continuation
System argument is the first permanent regression fixture.

Do this before generalized context changes so every later patch has measurable
cache consequences.

### Stage 4 — harden shared Context Source semantics

The V2 ambient/context-source slice now implements the core stage:

1. exact rendered-section observation (`present | absent | unavailable`);
2. required-vs-optional availability policy;
3. framework-owned projection version for unavailable-byte compatibility;
4. deterministic section composition/order;
5. source producer-freshness separation;
6. tests proving fresh byte-identical rerenders do not churn.

The current Goal split is also aligned: only stable Goal mechanism policy remains
a privileged Context Source; mutable specification/progress are conversational
Synthetic projections.

Remaining Stage 4 work is broader than `SystemContext`: the final all-contributor
SystemSurface assembler still has to integrate provider/model policy, selected
agent policy, caller System, overlays, and plugin transformation without creating
a second authority owner.

### Stage 5 — make privileged projection route-aware

For the native V2 Context Epoch path, the core projection seam is now wired:

1. provider/model semantics are separated from encoder capability;
2. native resolution intersects them before non-initial Context Epoch projection;
3. `HEAD_ONLY | CUMULATIVE_PRIVILEGED | REPLACE_COMPLETE` are preserved as
   distinct semantics;
4. unsupported/unknown native combinations fail closed to `HEAD_ONLY`;
5. `SystemProjection` chooses exact head/append behavior before provider lowering;
6. request-surface continuation/break remains derived rather than durable Session
   identity.

Still outstanding: unify the native and AI-SDK/V1 runtime capability decision at
the final shared privileged assembly boundary, and implement turn-scoped lifetime
only when the selected encoder actually supports it.

### Stage 6 — converge low-risk V1 Context Sources

Suggested order after shared hardening:

1. environment/date;
2. ambient instructions;
3. skill/reference guidance;
4. stable Goal mechanism policy only if it is not better owned by the agent/tool
   policy surface.

After each source migrates, remove the legacy duplicate producer.

### Stage 7 — provider cache frontier pass

Update `packages/llm` cache-policy capabilities from current provider docs.

Verify purely with `LLMClient.prepare()` first.

### Stage 8 — performance closeout

Run 1 / 3 / 6+ local concurrent sessions and the negative-invariant suite.

Only after that consider the tiny optional live-provider confirmation matrix.

---

## 17. Final assessment

The V1 overhaul changes the strategic answer.

Before message-level provenance, backporting V2 cache semantics risked building a
compatibility subsystem around an ambiguous legacy message model. With explicit
turn ownership, V1 now has a durable place to represent host orchestration
without contaminating the stable system prefix or pretending provider role means
human authorship.

That removes the most immediate cache-destruction problem and provides the right
causal model for Goal continuation, compaction, recovery, scheduled tasks and
future automation.

The adversarial review changes the final question. Rewriting the admitted System
head is sometimes the **correct** result: specifically when the effective
provider/model/runtime capability cannot preserve the required later privileged
semantics, or when a cumulative provider cannot safely express a state removal.

The remaining hard problem is:

> **How does one shared System-surface compiler preserve exact context authority
> while projecting the same semantic state through `HEAD_ONLY`,
> `CUMULATIVE_PRIVILEGED`, `REPLACE_COMPLETE`, and optional turn-scoped provider
> capabilities without allowing runtime selection to change meaning?**

Solve that on top of exact rendered-section admission/availability, keep provider
wire mechanics in `@opencode-ai/llm`, and make V1 a thin projection adapter
rather than a second epoch implementation. Treat request-series identity as a
derived optimization/diagnostic unless correctness later proves it must be
durable.

Under those constraints, the backport is a **moderate architectural migration,
not a rewrite**, and essentially all correctness/cache claims can be established
without spending meaningful money on inference.

### Current focused proof snapshot (dirty worktree)

The 2026-09-18 closure pass verifies the hardened Context Epoch bridge and the
provider/cache mechanism separately:

```text
SystemContext complete-section producers                     10/10 pass
SystemSurface reconciliation                                 20/20 pass
SystemProjection witnesses                                    8/8 pass
SessionContextEpoch bridge + legacy migration                 4/4 pass
SessionRunner capability/context matrix                       9/9 pass
native System capability resolver                             4/4 pass
provider/model System-capability matrix                      26/26 pass
focused Anthropic chronological-System authority cases        7/7 pass
OpenAI Responses native protocol                             59/59 pass
OpenAI Chat native protocol                                  29/29 pass
deterministic request-shape/cache-domain lab                  9/9 pass
GPT-5.6+ cache economics                                      7/7 pass
packages/llm native typecheck                                  pass
```

The dedicated epoch proof now checks more than output shape:

- `replace-complete` retains the original admitted baseline, appends one
  aggregate-scoped durable System event containing the **complete latest**
  surface, stores the latest complete checkpoint, and produces no duplicate
  event or checkpoint churn on an unchanged observation;
- old typed snapshots migrate by a fresh exact-current-surface rebaseline and
  advance `baseline_seq` to the **current durable aggregate frontier**, not the
  stale sequence carried by the old row;
- required unavailability across an incompatible projection version blocks
  rather than reusing incompatible admitted bytes;
- malformed persisted state fails closed.

The runner matrix proves complete-head behavior on head-only routes, true-suffix
append on cumulative routes, conservative rebaseline on cumulative replacement,
safe capability switches with active history, ordinary-history survival while
the System floor advances, compatible unavailable-byte reuse, compaction
rebaseline, and model re-resolution before a tool-driven continuation.

A full `session-runner.test.ts` run reached **87/93 pass**. Its six failures are
outside this cache/context slice: global application-tool registration, request
correlation headers, child-session prompt policy, question-dismissal timing, and
two provenance-qualified worker-root stream-error tests. The focused 9/9
cache/context matrix is green and no full-suite failure is in
`SystemContext`/SystemSurface/ContextEpoch projection.

The package-native Core typecheck remains globally red because the dirty
worktree contains concurrent failures in DB `readDb` mocks, branded paths/model
IDs, LLM test mocks missing `compile`, provenance additions, session harness
types, and other active campaigns. After repairing one branded-key assertion in
the SystemContext proof, the rerun reports **no diagnostics in the campaign
source files or SystemContext proof**. `packages/llm` typecheck is clean.

Earlier stale-render and newly-required-unavailable reproductions are now
**historical adversarial evidence**: exact-byte SystemSurface reconciliation
makes those failure modes explicit and tested. The monitor drain bug and other
unrelated cache/source-owner findings remain separate work.

The Goal integration also evolved concurrently in the intended direction:
stable privileged Goal mechanism policy is separated from mutable conversational
Goal specification/progress snapshots. That change is relevant architectural
evidence but is not claimed as part of this cache/context patch's ownership.
