# Shared Session control plane and human-interactable agent surfaces

**Status:** architecture companion — 2026-09-18  
**Authority:** subordinate to `00-first-party-overhaul-2026-09-18.md`  
**Scope:** agent-facing `session` / `task` / first-party `swarm` surfaces and
the human-facing Session UI. Planning only.

---

## 1. Thesis

OpenFork should have **one executable conversational primitive: Session**.

`session`, `task`, and Swarm are not three runtimes:

```text
Session
  = durable conversation + execution endpoint

Task
  = parent-owned child-Session delegation relationship

Swarm
  = peer/root-Session collaboration relationship
```

The implementation should therefore converge at two different layers:

1. **shared backend Session control mechanics**;
2. **shared human Session UI**, decorated by relationship context.

Provider-visible tools remain separate semantic façades unless measured evidence
shows that merging improves model behavior and prompt cost.

---

## 2. Why this is necessary

The original audit found independently implemented Session creation, prompting,
model selection, waiting, and wake behavior in multiple model-facing façades.
That was not merely duplicated code: it created alternate authority paths.

As of the 2026-09-19 hardening pass:

- the provider-visible `session` tool is **inspection-only** (`list`, `get`,
  `status`, `messages`);
- model-side Session `create`, `send`, and `fork` were removed rather than
  discouraged in prose;
- `task` is a thin provider adapter over `session/subagent-delegation.ts`;
- `SessionPrompt.handleSubtask()` calls that shared delegation backend directly,
  never `TaskTool.execute()`;
- `ToolRegistry.named()` no longer exposes Task as an internal backend handle;
- the first-party Swarm surface must follow the same rule: frontend adapter over
  canonical Swarm + Session owners, never a parallel runtime.

The old unregistered Swarm seed remains disposable research/UX evidence, not an
implementation foundation.

---

## 3. Backend target

### 3.1 Existing primitives remain owners

Do not create a giant new stateful manager.

Reuse:

```text
Session.Service
SessionInput
SessionExecution
SessionRunCoordinator
Permission
SessionTelemetry / status
LocationProfileResolver        # planned Tier-2 primitive
BackgroundJob                  # parent observation only where needed
```

### 3.2 Shared control facade

A small façade may compose those primitives so tools stop duplicating glue:

```ts
interface SessionControl {
  inspect(...)

  createRoot(...)
  createChild(...)
  fork(...)

  admit(...)
  wake(...)

  pause(...)
  resume(...)
  interrupt(...)

  wait(...)
}
```

The facade owns **no canonical state**. It translates one trusted command into
existing Session-domain primitives.

### 3.3 Explicit principal

Every control operation receives a trusted principal constructed outside model
arguments:

```ts
type SessionControlPrincipal =
  | {
      type: "human"
      // authenticated operator/user identity if available
    }
  | {
      type: "session"
      sessionID: SessionID
      messageID: SessionMessage.ID
      callID: string
    }
  | {
      type: "host"
      producer: string
      ref?: string
    }
```

Agent tool calls derive the principal from `Tool.Context`.

The model never supplies its own sender/session/member identity.

### 3.4 Operation ownership matrix

Shared low-level Session mechanics do **not** imply shared mutation authority.
The semantic domain owns the operation; adapters may only invoke that owner.

| Operation | Canonical owner | Provider/model façade | Other legitimate adapters | Forbidden shortcut |
|---|---|---|---|---|
| inspect Session/list/status/messages | Session inspection/projection | `session` read-only tool | UI, HTTP, OXP supervision | hydrate runtime/history for cheap list metadata |
| ordinary human prompt into interactive root Session | Session user admission | none | UI / authenticated public Session API | model fabricates a User turn |
| create/fork ordinary user-facing Session | Session lifecycle | none | UI / authenticated API/product action | model-side generic `session create/fork` |
| delegate child worker | Task/subagent delegation domain over Session | `task` | trusted Session subtask adapter; future OXP delegation policy may reuse backend | generic Session send/create or direct child prompt |
| resume/foreground/background Task child | Task/subagent delegation + BackgroundJob | `task` | trusted Task adapters | generic Session mutation by ID |
| Swarm membership/bind/rebind | Swarm aggregate | future `swarm` | Swarm UI/API | Session metadata/group mutation as source of truth |
| Swarm peer message/reply | Swarm message + delivery domain | future `swarm` | Swarm UI/API | generic Session send to peer Session ID |
| Swarm task assignment/continuation | Swarm task/lease/run domain | future `swarm` | Swarm executor | direct host prompt that bypasses lease/fence/run state |
| pause/resume/interrupt a Session | Session runtime control with caller-specific authorization | not generic model `session` | UI/API; OXP supervision under OXP authority; domain executor where explicitly owned | resident model using generic Session tool as cross-Session control plane |
| member/worker agent-model policy | owning delegation/Swarm policy + native catalog | `task` or future `swarm`, respectively | corresponding trusted domain UI/API | generic Session model mutation that bypasses owner policy |
| permission reply | Permission owner / authenticated human or explicitly authorized supervisor | no implicit model authority | Permission UI/API, narrowly authorized supervisor | coordinator/member model minting permission by text/tool shortcut |

The backend implementation may converge on `SessionInput`, Session execution
ownership, prompt contracts, and runtime control. The **operation owner does not
converge away**. This matrix is a phase-exit invariant, not presentation advice.

---

## 4. Admission is the common execution seam

The same durable SessionInput queue serves:

```text
human prompt
agent-to-Session message
Task delegation
Swarm peer mail
Swarm assignment
scheduled/recovery host work
```

What changes is the semantic item and policy.

### 4.1 Human

```text
SessionInput.User
owner=user
```

### 4.2 Agent/host

```text
SessionInput.Synthetic
owner=host
origin=typed producer/actor/ref
```

Examples:

```text
task               producer=task.delegate
swarm message      producer=swarm.peer
swarm task         producer=swarm.assignment
```

There is intentionally no generic model-side `session.send` producer. Ordinary
human Session input is User admission; cross-Session model communication must
flow through its owning Task/Swarm/delegation domain.

The provider may later see role `user`; the durable semantic kind remains
Synthetic.

---

## 5. Structured content must not become authority

Task delegation currently resolves `@file`, `@directory`, and `@agent`
references into structured V1 prompt parts.

Native current-model convergence should preserve useful structured file context
without preserving the authority ambiguity.

```ts
type SyntheticContent = {
  text: string
  files?: readonly Prompt.FileAttachment[]
}

type DelegatedTurnAuthority = {
  authorizedAgentNames?: readonly Agent.ID[]
}
```

Rules:

- files are context, not user ownership;
- Synthetic does not reuse `Prompt.AgentAttachment` as capability;
- an `@agent` string in peer/task content never grants spawn authority;
- recursive Task delegation carries an exact trusted delegated set separately;
- Swarm peer mail carries no delegated-agent authority by default.

The execution helper becomes:

```text
authorizedAgents(User)
  = explicit User Prompt.agents

authorizedAgents(Synthetic)
  = Synthetic.delegated.authorizedAgentNames
```

Never infer authority from rendered text.

---

## 6. Relationship-aware routing

Knowing a Session ID must not equal permission to message it.

Before cross-Session admission derive a route:

```ts
type SessionRoute =
  | { type: "self" }
  | { type: "owned-child"; parentSessionID: SessionID }
  | {
      type: "swarm-peer"
      swarmID: Swarm.ID
      sourceMemberID: SwarmMember.ID
      targetMemberID: SwarmMember.ID
    }
  | { type: "independent"; grant: SessionCommunicationGrant }
  | { type: "denied"; reason: string }
```

This is a derived authorization/read result, not another persisted relationship
table.

### Routing rules

- Task parent -> child: Task domain.
- Swarm peer -> peer: Swarm message/delivery domain.
- generic Session tool cannot bypass those domains merely by knowing Session ID.
- shared membership in multiple Swarms is ambiguous unless the Swarm is explicit.
- unrelated root-to-root messaging requires explicit Session communication
  permission/grant if the feature is retained.

---

## 7. Human-interactable Swarm Session is a hard invariant

Every bound Swarm member is a **root Session** and stays a normal chat target.

The user can:

- open it from normal Session navigation;
- type in the ordinary composer;
- inspect all ordinary Session history/tools/files/context;
- pause/resume it through normal Session controls;
- answer permissions through normal Permission UI;
- change managed profile through a Swarm-aware UI action;
- see peer/task automation in the same timeline with distinct attribution.

There is no parallel Swarm transcript.

### 7.1 Why root topology matters

Current V1 human HTTP prompting explicitly rejects Sessions with `parentID`.
TaskTool children therefore correctly remain host-owned.

A Swarm peer being root means the existing interactive Session path accepts it
without adding a special takeover API.

### 7.2 User input does not dissolve collaboration

A direct user turn:

- does not remove Swarm membership;
- does not implicitly release the active task;
- does not convert peer input into user input;
- does not rewrite previous cycle provenance;
- does suppress new autonomous collaboration admission during configured focus.

---

## 8. Human focus while a Swarm task is active

This is the hardest interaction case.

```text
member owns task T
  |
  +-- provider/tool step may currently be in flight
  |
human sends prompt
```

Correct behavior:

1. already-started provider/tool side effects settle safely;
2. at the next safe provider boundary, User wins Session arbitration;
3. scheduler withholds **new** assignments;
4. existing task lease remains fenced to the member for bounded focus grace;
5. task completion remains explicit domain state, never inferred from the human
   reply;
6. after bounded maximum hold, the task begins retirement; replacement execution
   waits until pending task input is revoked or already-started Session execution
   reaches quiescence.

### 8.1 No duplicate focus state

Swarm does not persist `humanChatAt`.

It reads Session-owned admission history directly:

```text
latest SessionInput where kind=user
  -> admitted_seq
  -> time_created
```

Use a partial covering index:

```sql
(session_id, admitted_seq DESC, time_created)
WHERE kind = 'user'
```

Phase-0 prototype:

```text
1,000,000 mixed SessionInput rows
latest User admission
  median ~0.9 us
  p95    ~1.6 us
```

No second `session_interaction` table is justified.

### 8.2 Existing lease

When a due lease belongs to a user-focused member:

- revalidate canonical Session focus;
- transition `active -> human_hold` without changing task generation;
- suppress new task continuations immediately;
- pending Swarm assignment/continuation inputs are admitted
  `user_preemptible=true`, so the User-admission transaction revokes them
  immediately instead of leaving secretly-held executable work in SessionInput;
- revoking that pending input does **not** release the task lease or consume a
  semantic task retry;
- if focus clears during grace, the same task owner/generation may re-admit a
  fresh run/continuation input;
- at the maximum hold, transition to `retiring` rather than forcing a parallel
  owner;
- if already promoted, wait for shared Session execution quiescence;
- only then release/supersede and permit a newer task generation.

This prevents user interaction from accidentally causing two workers to perform
the same external task.

The same retirement primitive is used for lease expiry, member rebind/self-heal,
operator release, and crash recovery.

---

## 9. One human-facing Session UI

### 9.1 Shared core surface

Reuse the normal Session:

- timeline;
- composer;
- streaming;
- context metrics;
- files/artifacts;
- permissions;
- model display;
- pause/resume;
- export/share where allowed.

### 9.2 Relationship facets

Decorate that surface using a read-only affiliation projection:

```ts
type SessionAffiliation =
  | {
      type: "task-child"
      parentSessionID: SessionID
    }
  | {
      type: "swarm-member"
      swarmID: Swarm.ID
      memberID: SwarmMember.ID
      role: string
      managed: boolean
    }
  | {
      type: "special-agent"
      kind: string
      ownerSessionID?: SessionID
    }
```

This is derived from canonical owners, never written independently.

### 9.3 Session header/context

Potential shared UI:

```text
[ Researcher ] [ Swarm: Compression Audit ] [ Task: benchmark parser ]
[ model ] [ working ] [ permission blocked ] [ human focus ]
```

Actions route to their owning domain:

- Session pause -> Session;
- remove from Swarm -> Swarm;
- release task -> Swarm task;
- change managed worker profile -> Swarm profile + Session materialization;
- child cancel -> Task/parent execution semantics.

### 9.4 Swarm command center

A dedicated Swarm page/panel is still useful for:

- roster;
- task DAG;
- mailbox;
- blackboard;
- deliverables;
- health.

Selecting a member opens the **same normal Session** rather than a Swarm-specific
chat implementation.

---

## 10. Agent-facing tools: backend merge, frontend separation

### 10.1 Recommended initial provider surface

```text
session
task
swarm
```

#### `session`

Generic Session inspection only:

- list/get/status/messages;

The provider-visible Session tool deliberately cannot create, fork, prompt,
pause, resume, interrupt, or mutate model/agent selection. Those actions remain
available through their owning human/product/domain surfaces where appropriate.
Knowing a Session ID is not mutation authority.

#### `task`

Specialized bounded delegation:

- exact parent-owned child Session;
- task/resume handle;
- foreground/background attachment;
- return-to-parent result;
- exact delegated agent/model authority.

#### `swarm`

One composite collaboration tool:

- inspect/list/status;
- roster lifecycle;
- message/reply;
- task graph/claim/settle;
- shared blackboard;
- deliverable/review;
- bounded recovery.

Avoid many `swarm_*` provider tools.

### 10.2 Composite Swarm permissions

Expose one stable provider tool while checking leaf permissions internally:

```text
swarm.read
swarm.message
swarm.task
swarm.member
swarm.memory
swarm.review
```

The provider prefix stays stable; Session execution-boundary policy controls the
leaf action.

### 10.3 Why not merge Task into Session immediately?

Measured current provider-facing payload:

```text
session
  schema       2,118 bytes
  description  1,111 bytes
  total        3,229 bytes

task
  schema       1,217 bytes
  description  4,483 bytes
  total        5,700 bytes
```

Current separate schema bytes:

```text
3,335 bytes
```

A prototype discriminated `Session | { action:"delegate", ...Task }` union:

```text
3,363 bytes
```

So the merged schema is **28 bytes larger**, before descriptions.

Task's cost is dominated by semantic guidance about:

- when delegation is appropriate;
- parallel fan-out;
- isolation;
- ownership partitioning;
- resume versus restart;
- foreground/background.

Those instructions do not disappear if the action is renamed
`session.delegate`.

Therefore there is no current prompt-size case for merging the provider tools.

### 10.4 Future tool-surface experiment

Only reconsider after an evaluation comparing:

- tool-prefix token count;
- prompt-cache hit rate;
- tool-selection accuracy;
- invalid argument rate;
- accidental Session-send where Task was intended;
- accidental Task delegation where Session inspection was intended;
- first-call latency;
- recovery/resume correctness.

Keep `task` as an alias during any experiment.

---

## 11. Shared typed frontend fragments

Separate tools can still reuse exact DTO/schema fragments:

```text
SessionTarget
SessionCompactSummary
SessionWaitOptions
SessionDispatchReceipt
ExecutionProfileRef
FileReference
```

Do not reuse schemas whose JSON shape matches but authority differs.

Examples:

- generic Session agent selector;
- parent-authorized Task subagent type;
- Swarm managed-worker desired profile.

Those are distinct semantic contracts.

---

## 12. Event-driven observation

Delete tool-specific fixed-interval wait polling.

Current `session.messages(wait:true)` polls Session status every 200 ms while
TaskTool has a separate Deferred-backed BackgroundJob wait path.

Create/reuse one Session observation primitive backed by compact cross-process
Session execution ownership:

```ts
wait({
  sessionID,
  condition:
    | "execution-idle"
    | "drained"
    | "next-assistant"
    | "input-terminal",
  inputID?,
  afterSeq?,
  timeout?,
  abort,
})
```

Correct lost-wakeup pattern:

```text
read compact durable condition
subscribe narrow same-process event
read durable condition again
wait for local event OR adaptive cross-process durable recheck
```

There is no always-on polling loop and no relationship-specific Session wait
loop. Explicit cross-process waits may use an adaptive bounded recheck because
EventV2 live PubSub is process-local; correctness comes from durable state while
local events are only a latency optimization.

Execution release itself closes the more important lost-wakeup race: the current
owner clears its execution ownership only in a transaction that proves no eligible
durable Session work is pending. If another process admitted work first, the
owner keeps ownership and drains again; if release committed first, the admitting
process can acquire the next execution generation.

Task's BackgroundJob may still track whether the **parent caller** is attached or
detached; that is parent UX, not Session execution truth.

---

## 13. Read-model performance

The shared frontend must remain batched.

Prototype:

```text
100 virtual Swarm groups
2,000 bound member Sessions
10,000 total Sessions
```

One member->Session join:

```text
median ~1.42 ms
p95    ~1.64 ms
```

No per-member Session resolve is required.

A partial visible-Swarm index:

```sql
(project_id, updated_at DESC, id)
WHERE status != 'archived'
```

removes the temporary order-by B-tree from the group-list plan. At 100k Swarms
distributed across 100 projects, the bounded 200-row list was ~80 us median on
the Phase-0 machine.

Performance invariants:

- zero N+1 Session hydration for structural groups;
- no Instance bootstrap from sidebar projection;
- no history read for group/list status;
- one compact telemetry batch for visible Sessions;
- canonical events invalidate the projection.

---

## 14. Migration order

### Phase A — shared semantic substrate

1. generalize current SessionInput User/Synthetic;
2. add typed Synthetic origin;
3. add bounded Synthetic file content;
4. separate delegated authority from content;
5. add revocable pending Synthetic lifecycle;
6. owner-aware arbitration and homogeneous cycle source;
7. shared cross-process Session execution ownership;
8. hybrid event/durable Session observation.

### Phase B — migrate existing tools

1. **done:** remove agent-facing `session.send/create/fork` instead of preserving
   a generic cross-Session mutation route;
2. **done:** split Session-owned `prompt-contract.ts` from the model tool façade;
3. **done:** extract Task execution into shared `session/subagent-delegation.ts`;
4. **done:** make both `TaskTool` and `SessionPrompt.handleSubtask()` adapters over
   that backend while retaining Task parent/BackgroundJob semantics;
5. **done:** remove `TaskPromptOps` from production and remove
   `ToolRegistry.named().task` as an internal backend handle;
6. **gate:** backend/runtime source must never import or invoke TaskTool/SessionTool
   as infrastructure. Static architecture tests enforce this boundary.

### Phase C — first-party Swarm

1. build canonical Core Swarm aggregate;
2. use root Session creation/profile resolver;
3. deliver messages/tasks through shared Synthetic admission;
4. add virtual SessionGroup projection;
5. add Session affiliation projection;
6. add Swarm command center using the existing Session UI.

### Phase D — provider-tool experiment

Only after behavior is stable, evaluate whether `task` should remain dedicated
or become a compatibility alias for a shared composite surface.

---

## 15. Existing Swarm seed disposition

The current unregistered `packages/opencode/src/tool/swarm/*` seed contains
useful product intent but should be architecture-quarantined.

Preserve:

- delegate/spawn convenience;
- wake/revive UX;
- batch model management;
- roster limits if still desired;
- friendly error messages;
- one-call workflows.

Delete/rebuild:

- `SwarmStore` abstraction as a parallel runtime;
- model catalog duplication/fuzzy selection authority;
- mirrored member status;
- automatic dead-member eviction as hidden mutation;
- auto-revive during ordinary target lookup;
- permission replies that let a coordinator model mint authority;
- typo/self-heal mutation behavior;
- implicit create/revive on lookup;
- any Session/runtime operation that bypasses the shared Session control plane.

---

## 16. Rejected architectures

### Separate Swarm chat runtime

Rejected. Duplicates Session history, tools, permissions, streaming, context and
human interaction.

### Swarm members as TaskTool children

Rejected. Child promptability correctly blocks normal human interaction and
encodes parent ownership.

### One giant `AgentManager`

Rejected. Centralizes unrelated authorities and creates a new god object.

### One giant provider-visible `agent` tool

Rejected absent evidence. Schema size does not improve and authority/tool
selection becomes less legible.

### Generic writable Session relationship graph

Rejected. Parent/child and Swarm membership already have canonical owners.
Project relationships as a read model instead.

### Polling status for all agent types

Rejected. Session execution already has event/state machinery.

---

## 17. Novel/generalizable architecture direction

The resulting design is more general than Swarm:

```text
Session = durable executable actor

relationship domains =
  parent delegation
  peer collaboration
  scheduled execution
  special-agent ownership

typed SessionInput =
  common mailbox

typed provenance + delegated authority =
  causal/capability envelope

SessionAffiliation =
  read-only graph projection
```

This resembles durable-actor/message systems, but with one important property:
the same actor remains **directly human-addressable**.

That creates a useful research direction for agent harnesses:

> autonomous and human interaction do not require separate agents or takeover
> runtimes; they can be two typed principals sharing one serialized durable
> Session mailbox, with priority/capability rules enforced before execution.

The Swarm implementation is therefore not merely a multi-agent scheduler. It can
become a proof that **human/host/peer collaboration can share one conversational
state machine without collapsing authority**.

