# OpenSwarm → OpenFork First-Party Overhaul

**Status:** **CURRENT ARCHITECTURE + IMPLEMENTATION SOURCE OF TRUTH** — native
Swarm is implemented in OpenFork; OpenSwarm is historical requirements and a
possible migration input only.

**Date:** 2026-09-18

**Repositories inspected:**

- OpenSwarm: `/openswarm`
- OpenFork: `/webstormprojects/opencode`

**Authority:** this document supersedes the architectural recommendations in the
August 2026 swarm-port drafts where they conflict with current OpenFork
architecture. The older documents remain useful historical evidence and UX /
behavior inventories; they are not the implementation source of truth.

**Companion decision records:**

- `01-capability-disposition.md` — explicit preserve / redesign / delete / defer matrix.
- `03-provenance-messaging-runtime.md` — detailed integration with the active V1/V2 turn-provenance architecture, peer trust, delivery idempotency, and Session admission.
- `06-implementation-roadmap-v2.md` — architecture-gated implementation order, migration, concurrency proofs, and performance closure.

`00-first-party-redesign.md` is an earlier September synthesis. It is useful
archaeology, but this overhaul is newer and authoritative where they differ.
Companion documents are subordinate to this document and should be updated rather
than silently chosen over it.

---

## 0. Executive decision

The native swarm must **not** be a port of OpenSwarm's runtime.

It should be a first-party collaboration domain built on top of OpenFork's
existing Session runtime.

The central model is:

```text
Session                         = runtime / addressable conversational actor
Task subagent                   = parent-owned child Session
Swarm member                    = independently addressable ROOT Session
Swarm                           = durable collaboration aggregate over Sessions
Goal                            = objective / verification domain
Special agent                   = host-owned maintenance / protocol role
```

This preserves the most important property of OpenSwarm — every member is a real
chat that the user can open and message, while members can message each other —
without importing the plugin's second runtime, second database, polling loops,
heuristic self-healing, duplicated model/permission state, or giant supervisor.

The closest existing implementation analogue is **not one subsystem**:

- `task.ts` is the best reference for how an agent Session is created, resumed,
  modelled, permissioned, and run.
- current Session / `SessionInput` is the correct primitive for durable
  message admission and execution wakeup.
- Goal is the best reference for durable host-authored provenance, causal
  lineage, reservations, and user-preemption semantics.
- Scheduled Tasks are the best reference for durable leases, revalidation before
  provider spend, unconditional settlement, and single-timer/event-driven
  runtime architecture.
- Session Groups are the correct navigation/UI projection for a set of related
  Sessions, but must not become the source of truth for swarm membership.

Therefore:

> **Reuse the Session execution substrate that `task.ts` already uses; do not
> put the Swarm domain inside `task.ts`.**

---

## 1. Non-negotiable product semantics

These are the OpenSwarm behaviors worth protecting even if every implementation
line underneath them changes.

### 1.1 Member sessions are first-class chats

A swarm member is a root Session, not a hidden child and not a special agent.

Consequences:

- The user can open a member Session directly.
- The user can send a normal human prompt directly to it.
- Its transcript, model, tools, permissions, pause state, telemetry, checkpoints,
  and context are normal Session state.
- It has a stable Session ID that is independently addressable.
- Peer messages are delivered into that Session through the same durable Session
  admission mechanism used elsewhere in OpenFork.

This is the decisive distinction from ordinary `task.ts` subagents.

### 1.2 Peer-to-peer communication is a domain feature

Members can send:

- direct peer messages,
- request/response messages,
- findings,
- blockers,
- handoffs,
- broadcasts,
- references to shared artifacts and tasks.

The coordinator does not need to relay every message.

### 1.3 Collaboration state survives process failure

The durable domain includes:

- swarm identity and policy,
- membership,
- task graph and ownership,
- peer messages / recipient receipts,
- blackboard/shared state,
- path/lane claims,
- important handoffs / artifact references,
- recovery-relevant leases.

Live fibers, timers, Session runners, cache entries, and wakeups are not durable
domain state.

### 1.4 Human authority remains stronger than swarm machinery

Peer messages, scheduler prompts, recovery prompts, and coordinator notices are
host-authored orchestration turns. They must never be mistaken for a human
instruction merely because the provider sees them in a `user` role.

The current turn-provenance architecture is mandatory for this distinction.

---

## 2. Why the OpenSwarm plugin architecture cannot be transplanted

OpenSwarm solved a difficult problem from outside the host. Many of its ugly
mechanics are consequences of that boundary rather than bad product ideas.

The plugin currently has to impersonate host/runtime behavior:

- call back into OpenCode through an HTTP client,
- subscribe to / scrape host events that are not directly owned by the plugin,
- poll as a backstop when event surfaces are incomplete,
- maintain its own SQLite / ChunkDB database,
- mirror Session/model/permission state,
- infer human-vs-self-injected prompts,
- run broad periodic sweeps,
- reconcile IDs and names heuristically,
- repair state after host changes it outside the plugin.

Those workarounds are inappropriate when the feature becomes first-party.

### 2.1 Concrete code-level findings

The architectural concerns are not hypothetical. The current OpenSwarm code
contains direct examples of domain semantics being coupled to plugin/runtime
workarounds:

- `HumanChatTracker` classifies host injections by an in-memory message-ID set
  plus a list of exact text prefixes such as `[SWARM INBOX —`,
  `[ASSIGNED TASK`, `[WATCHDOG]`, and even `You are \``.
- `Scheduler.buildAssignmentPrompt` contains a comment requiring its first line
  to keep matching that human-chat prefix classifier. Prompt wording has become
  a control-plane API.
- `Broker` batches logical messages into one formatted prompt, then treats a
  successful `promptAsync` call as the transition toward “delivered”.
- Recovery compares Swarm's mirrored member state against the host Session
  runtime and repairs divergence after the fact.
- The runtime adapter carries V1 and V2 clients simultaneously, including a
  second V2 event stream plus permission polling backstops.
- Scheduler state combines task ownership, mirrored member run status,
  human-chat timestamps, path claims, annotations, model state, and prompt
  kickoff in one pass.

These are exactly the kinds of cross-layer ownership violations current
`AGENTS.md` is intended to prevent.

### 2.2 Structural warning signs in the current plugin

The present `src/plugin.ts` has become an omnibus orchestration layer containing
tool registration, event handling, recovery, scheduler triggering, mailbox
delivery, model resolution, permission handling, watchdog behavior, emergency
controls, notices, and many caches / dedupe maps.

This creates several forms of duplicated authority:

```text
OpenCode Session status       <-> SwarmMember.status
OpenCode Session model        <-> SwarmMember.model
OpenCode permission state     <-> plugin permission mirrors / pending rows
OpenCode input/run queue      <-> plugin mailbox/wake machinery
OpenCode events               <-> plugin event/poll reconciliation
host SQLite                   <-> plugin SQLite/ChunkDB
```

The native redesign should remove duplicated truths rather than make those
mirrors faster.

### 2.3 Algorithmic findings

Several useful algorithms exist, but their current orchestration cost is not a
native target:

- `recomputeReadiness(tasks, deps)` filters the entire dependency array for
  every task: **O(T × D)**.
- affinity ordering scores every free task against the idle-member set and sorts
  candidates per task: approximately **O(R × I log I)** before assignment.
- claim warnings compare ready tasks against active claims.
- Hive hesitation compares ready tasks against aggregated annotation paths.
- the plugin then performs these computations from broad store snapshots during
  repeated scheduler sweeps.

The pure invariants are worth keeping; the broad recomputation strategy is not.

Native Core should make the common path proportional to changed entities:

- dependency settlement updates affected descendants,
- indexed ready-task queries return a bounded candidate set,
- member eligibility is projected once,
- advisory claim/Hive analysis is computed only when requested or when the
  relevant task/path changes.

### 2.4 The existing OpenFork `tool/swarm/*` code is not a foundation

The current partial files under:

`packages/opencode/src/tool/swarm/`

are tool-layer helpers with a hand-written `SwarmStore` abstraction. They are
not registered as a complete first-party swarm runtime and do not match current
bottom-up ownership rules.

Treat them as exploratory code / behavior clues, not architecture to extend.

**Planning disposition:** replace rather than grow them after the new domain
contracts are implemented.

---

## 2A. Architecture alternatives considered

### Alternative A — expand `task.ts` into Swarm

**Attractive because:**

- it already creates/resumes agent Sessions,
- it already supports detached execution,
- permission/model/session logic is nearby.

**Rejected as the domain boundary because:**

- TaskTool child Sessions are deliberately parent-owned,
- direct user prompting of a child is rejected,
- task identity and Session identity are intentionally coupled,
- peer-to-peer membership/message semantics do not belong to a parent tool call.

**Use instead:** extract/reuse the Session execution/admission substrate beneath
TaskTool.

### Alternative B — model every member as a Goal/SpecialAgent

**Attractive because:**

- Goal has strong durable provenance and autonomous continuation architecture.

**Rejected because:**

- swarm members are ordinary user-addressable peers,
- a Goal Auditor is a host-owned protocol worker,
- “special agent” would encode the wrong authority and UI semantics.

**Use instead:** reuse Goal's provenance, reservation, preemption, and
idempotency patterns.

### Alternative C — transplant OpenSwarm runtime into `packages/opencode`

**Attractive because:**

- fastest superficial feature parity,
- hundreds of existing tests,
- known UX already works.

**Rejected because:**

- creates a second Session runtime inside the host,
- preserves duplicate storage/state,
- preserves broad timers/sweeps,
- preserves runtime HTTP/SSE adapters that are meaningless first-party,
- makes future architecture cleanup harder than starting correctly.

### Alternative D — root Session actors + durable Swarm aggregate

**Selected.**

It is the only option that simultaneously provides:

- real user-messageable member chats,
- peer-to-peer addressability,
- one Session runtime,
- one permission/model authority,
- durable collaboration state,
- typed provenance,
- scalable event/lease-driven execution.

---

## 3. The relationship to `task.ts`

### 3.1 What `task.ts` gets right

`packages/opencode/src/tool/task.ts` already has several primitives swarms need:

- a Session is the actual execution context,
- the same Session can be resumed with stable identity,
- foreground/background is an observation/waiting mode, not a different kind of
  agent,
- model/agent selection is delegated to existing host services,
- permissions are derived before execution,
- execution is serialized by Session machinery,
- the parent can continue a running Session with additional host-authored input.

Those are excellent implementation precedents.

### 3.2 What makes a task subagent fundamentally different

TaskTool creates a child Session:

```text
parentID = invoking Session
```

and Session promptability enforces the ownership distinction:

- host-owned machinery may drive the child,
- ordinary direct user prompting of the child is rejected.

That is exactly the behavior wanted for a bounded subagent and exactly the wrong
behavior for a swarm peer.

### 3.3 Target extraction

The architectural goal is reusable Session primitives **under**
`TaskTool`, not a `swarm=true` branch inside `task.ts`.

Conceptually:

```text
                         +--------------------+
                         | Session runtime     |
                         | create / input /    |
                         | wake / interrupt    |
                         +---------+----------+
                                   |
                 +-----------------+-----------------+
                 |                                   |
        +--------v---------+                +--------v---------+
        | Task adapter     |                | Swarm execution  |
        | child Session    |                | adapter          |
        | parent-owned     |                | ROOT Sessions    |
        +------------------+                +------------------+
```

The shared substrate should own only generic Session concerns:

- create / resolve Session identity,
- topology-specific provisioning,
- trusted host prompt admission,
- deterministic input identity,
- queue/steer delivery,
- wake / resume / interrupt.

Do **not** prematurely replace those pieces with one new
`AgentSessionExecutionManager`-style service. Current OpenFork already has
several deliberately small primitives; compose them first and extract additional
shared glue only after Task and Swarm prove the duplication.

TaskTool remains responsible for:

- parent-child ownership,
- `task_id` semantics,
- subagent depth,
- return-to-parent behavior,
- parent authorization for agent selection.

Swarm remains responsible for:

- membership,
- peer addresses,
- task graph,
- peer communication,
- shared collaboration state,
- swarm-specific policy.

### 3.4 Existing `SessionHostChild` confirms the topology split

Current Core already contains:

`packages/core/src/session/host-child.ts`

Its contract is intentionally narrow: idempotently provision a **host-owned
child** Session from the parent's durable project/location identity without
materializing a workspace runtime.

That is excellent architecture for:

- Goal Auditor,
- special-agent Sessions,
- other host-owned child protocols.

It is **not** the Swarm member primitive. A swarm member must be a root Session,
so routing it through `SessionHostChild.ensure()` would encode exactly the
parent-owned topology we are trying to avoid.

The current primitives therefore point toward composition rather than a new
monolith:

```text
child/special agent
  SessionHostChild.ensure
        +
  typed host SessionInput
        +
  SessionExecution

swarm peer
  current root Session.create
        +
  typed inter-session/host SessionInput
        +
  SessionExecution
```

TaskTool can migrate toward the same current typed-admission path without
changing its child ownership semantics.

### 3.5 What should remain TaskTool-specific

Several things visible in current `task.ts` are **not** generic agent-runtime
concerns and should not be copied into Swarm:

- foreground/background attachment is parent-tool observation semantics;
- `task_id` is the child Session's parent-facing continuation handle;
- background result injection returns a child outcome into the parent transcript;
- subagent depth is a parent/child recursion policy;
- TaskTool derives child permissions from the invoking Session/subagent policy;
- the parent chooses/authorizes the subagent type.

Swarm can independently offer “run this peer in background” UX, but that should
mean normal Session execution plus UI observation; it should not import
TaskTool's parent-return protocol.

### 3.6 Session, Task, and Swarm are three policies over one Session control plane

Current code has independently grown three overlapping agent-facing surfaces:

- `tool/session.ts` — inspect/create/fork/send to Sessions;
- `tool/task.ts` — create/resume/drive a parent-owned child Session;
- nascent `tool/swarm/*` — create/revive/spawn/wake/manage peer Sessions.

The duplication is architectural, not merely cosmetic. All three need variants
of:

- resolve a Session target,
- validate/resolve execution profile,
- create or resume Session identity,
- admit host-authored input,
- wake execution,
- observe completion/status,
- interrupt/pause/resume,
- read compact history,
- return stable identifiers.

Do **not** keep three implementations of those mechanics.

The converged model is:

```text
                         Session control plane
                 create / fork / admit / wake / wait
                  inspect / profile / interrupt / pause
                                  |
               +------------------+------------------+
               |                  |                  |
        generic Session       Task delegation     Swarm domain
           policy               policy              policy
               |                  |                  |
      root/independent       child + parent       root + peer
        Session control      return protocol      collaboration
```

This is **not** a generic "agent graph" authority. Session remains the executable
conversation; Task and Swarm retain their own ownership facts.

### 3.7 Shared backend surface: small capabilities, not a god service

Do not create one `AgentManager` that owns Session, Task, Swarm, permissions,
background jobs, and scheduling.

Instead converge the shared mechanics behind a small Session-owned command
surface, conceptually:

```ts
interface SessionControl {
  inspect(...)
  createRoot(...)
  createChild(...)
  fork(...)
  admit(...)
  wake(...)
  interrupt(...)
  pause(...)
  resume(...)
  wait(...)
}
```

The exact module boundaries should follow existing Core primitives:

```text
Session.Service
SessionInput
SessionExecution
SessionRunCoordinator
Session/Permission
LocationProfileResolver
SessionTelemetry
```

The "control plane" may therefore be a composition/facade over those services
rather than another stateful owner.

It must **not** own:

- Swarm membership,
- Swarm task leases,
- TaskTool parent/child result semantics,
- BackgroundJob's parent observation mode,
- Goal continuation reservations,
- permission authority,
- SessionGroup membership.

Those remain domain adapters around the common endpoint.

### 3.8 One trusted admission primitive; producer-specific provenance

Current duplication already exposes the correct abstraction accidentally.

Today:

- TaskTool drives a child through `TaskPromptOps`;
- the agent-facing Session tool also uses `TaskPromptOps.dispatch`;
- both therefore ultimately rely on the same host-prompt machinery.

The current Session tool description says `send` adds a new "user prompt", but
its implementation dispatches through the trusted **host** path. That contract
must be corrected during convergence.

Native current semantics:

```text
human types into Session UI/API
  -> SessionInput.User
  -> owner=user

agent calls session.send/create-with-input/fork-with-input
  -> SessionInput.Synthetic
  -> producer="session.message"
  -> actor=source Session from Tool.Context

TaskTool delegates/continues child
  -> SessionInput.Synthetic
  -> producer="task.delegate"
  -> actor=parent Session

Swarm peer delivery
  -> SessionInput.Synthetic
  -> producer="swarm.peer"
  -> actor=source peer Session

Swarm assignment/recovery
  -> SessionInput.Synthetic
  -> producer="swarm.assignment" / "swarm.recovery"
```

No tool may manufacture a semantic User turn merely because the provider later
needs role `user`.

### 3.9 Session addressing must not bypass relationship authority

A generic `session.send` is more powerful than it first appears: if it can send
to every Session unconditionally, it can bypass Task parent ownership or Swarm
membership/message policy.

Introduce one relationship-aware addressing check before cross-Session
admission.

Conceptually:

```ts
type SessionRoute =
  | { type: "self" }
  | { type: "owned-child"; parentSessionID: SessionID }
  | { type: "swarm-peer"; swarmID: Swarm.ID; sourceMemberID: SwarmMember.ID; targetMemberID: SwarmMember.ID }
  | { type: "independent"; grant: SessionCommunicationGrant }
  | { type: "denied"; reason: string }
```

The route is **derived** from canonical domain state; it is not persisted as a
second relationship graph.

Rules:

- TaskTool knows the exact parent-owned child and may drive it through Task
  semantics.
- Swarm peers communicate through the Swarm message domain so delivery,
  correlation, membership, expiry, and audit remain intact.
- Generic `session.send` must not silently route around Swarm policy just
  because the caller knows the target Session ID.
- if source and target share multiple Swarms, the collaboration domain must be
  explicit rather than guessed.
- direct independent Session-to-Session messaging, if retained, requires normal
  Session-tool permission plus an explicit communication policy/grant.

This preserves Session as the endpoint without making Session ID knowledge equal
communication authority.

### 3.10 Shared observation should be event-driven locally and durable cross-process

Current surfaces have diverged:

- TaskTool waits through BackgroundJob Deferreds;
- `session.messages(wait:true)` polls Session status every 200 ms;
- Swarm would otherwise be tempted to add another wait loop.

Converge on one Session observation primitive:

```text
wait(sessionID, condition, timeout, abort)
  condition:
    execution-idle
    drained
    next-assistant
    input-terminal
```

Same-process waits subscribe to a narrow canonical event and perform a durable
condition recheck before/after subscription to avoid lost wakeups. EventV2 live
PubSub is process-local, so explicit cross-process waits additionally use a
bounded adaptive durable recheck while the waiter exists.

There is no always-on polling loop and no relationship-specific Session wait
implementation. Local events are a latency optimization; durable Session input
and execution ownership are correctness truth.

The more important cross-process lost-wakeup race is closed at ownership release:
the execution owner may clear its lease only in a transaction that proves no
eligible durable Session work remains. Input committed first keeps the current
owner draining; release committed first lets the admitting process acquire the
next execution generation.

TaskTool may continue using BackgroundJob for its **parent attachment/detachment
UX**, but the underlying Session completion observation should converge on the
same Session observation surface.

### 3.11 Provider-visible tool convergence is a separate decision

Backend convergence does **not** require one giant provider tool.

Current tool definitions are part of the prompt-cache-sensitive provider prefix,
and TaskTool has strong learned/semantic affordances. Evaluate these shapes:

#### Candidate A — three thin semantic façades (**preferred initial shape**)

```text
session
  generic Session inspection/control

task
  bounded parent-owned delegation

swarm
  one composite collaboration tool
```

All three call the same backend Session control primitives.

This preserves crisp authority boundaries and model tool-selection semantics
while deleting backend duplication.

#### Candidate B — `session` absorbs `task`

```text
session action=delegate
```

and `task` remains a temporary compatibility alias.

Potential benefit:

- smaller tool count,
- one Session-oriented mental model.

Risks:

- much larger discriminated schema,
- weaker model routing between "inspect another conversation" and
  "delegate isolated work",
- Task-specific model/agent authorization becomes easier to bypass accidentally,
- prompt-prefix/token/cache cost may increase.

Do not choose this without a tool-selection/schema-size benchmark.

#### Candidate C — one `agent` mega-tool

Reject as the default architecture.

It collapses unrelated authority domains into one schema and makes per-action
permission auditing harder. Fewer tool names is not sufficient justification for
a giant union.

### 3.12 Shared agent-facing schema fragments

Even when provider-visible tools remain separate, do not hand-roll the same
fields repeatedly.

Reuse typed fragments for truly identical semantics:

```text
SessionTarget
SessionInspectOptions
SessionWaitOptions
ExecutionProfileSelector
DispatchReceipt
SessionCompactSummary
```

Do **not** reuse a field merely because the JSON shape looks similar.

Examples:

- Task `subagent_type` is parent-authorized delegated-agent selection;
- Session `agent` is generic Session profile selection;
- Swarm desired member profile is durable managed-worker intent.

Those may share underlying Agent/Model references while retaining different
authorization rules.

### 3.13 Human-facing frontend convergence: one Session UI, relationship facets

Swarm members must remain ordinary human-interactable Sessions.

There should be no "Swarm chat renderer" beside the normal Session chat.

The UI architecture should be:

```text
                         Session screen
                    timeline + composer + tools
                              |
               +--------------+--------------+
               |                             |
        Session runtime               relationship projection
                                            |
                          +-----------------+----------------+
                          |                                  |
                      Task child                         Swarm member
                 parent/task context              swarm/member/task context
```

The same Session page handles all message streaming, history, context metrics,
files, permissions, model display, and human composer behavior.

Relationship-specific UI is decoration/action context:

- badge/chip: ordinary / task child / Swarm member / special agent;
- Swarm/member name and role;
- active Swarm task/lease summary;
- parent Task origin for child Sessions;
- permission-blocked / paused / user-focus indicators;
- links to parent/peer/Swarm/task surfaces.

Do not fork the chat state store or timeline component.

### 3.14 Session affiliation is a read model, never a new authority table

The UI and generic Session tool need to answer:

> "What relationships does this Session currently participate in?"

Provide a composite read model, conceptually:

```ts
type SessionAffiliation =
  | { type: "task-child"; parentSessionID: SessionID }
  | { type: "swarm-member"; swarmID: Swarm.ID; memberID: SwarmMember.ID; role: string; managed: boolean }
  | { type: "special-agent"; kind: string; ownerSessionID?: SessionID }
```

It is projected from canonical owners:

- Session parent/special-agent metadata,
- Swarm membership,
- future domain relationships.

Do not create a generic `session_relationship` write table. That would recreate
the dual-authority problem in a more abstract form.

The read model can power:

- sidebar grouping,
- Session header/context tabs,
- tool authorization hints,
- diagnostics,
- navigation.

### 3.15 Hard invariant: Swarm member Sessions remain directly human-addressable

For every bound Swarm member Session:

1. it is a root Session;
2. the user can navigate to it through the ordinary Session UI;
3. the ordinary composer admits a semantic User input;
4. user input does not leave the Swarm or destroy membership;
5. user input wins Session arbitration over already-admitted synthetic work;
6. new Swarm deliveries/assignments respect the user-focus admission fence;
7. pause/resume/permission UI remains the normal Session UI;
8. the user can inspect peer-authored Synthetic turns with visible attribution;
9. task settlement remains an explicit Swarm-domain transition, never "the
   latest assistant message means done".

This is not optional UX. It is a first-party Swarm acceptance criterion.

### 3.16 Human interaction while a member owns Swarm work

Direct user chat and Swarm task ownership are different facts.

When the user addresses a member that currently owns a Swarm task:

```text
in-flight provider/tool step
  -> settles safely

next provider boundary
  -> user cycle wins

new Swarm work
  -> withheld during focus grace

current task lease
  -> remains fenced to this member during a bounded human-focus hold
```

Do **not** immediately release/reassign the active task merely because the user
said hello; that can create duplicate external side effects while the original
worker is merely yielding conversational priority.

Likewise, do not hold the task forever.

Recommended policy:

- no new assignments while user-focused;
- current lease remains owned during a bounded `humanFocusGrace`;
- due-lease evaluation checks canonical Session user-focus state before
  reassigning;
- if focused, transition the lease to `human_hold` and suppress new task
  continuations immediately;
- the maximum hold begins **retirement**; it does not authorize parallel
  replacement execution;
- retirement first revokes an unpromoted task input, or otherwise waits for the
  member Session's shared execution owner to reach a proven quiescent boundary;
- only after that barrier may the old run become superseded, the task lease
  generation advance, and replacement work become claimable;
- explicit user/operator "release task" or member stop bypasses the grace and
  begins the same retirement protocol immediately.

No `member.humanChatAt` mirror is needed. The scheduler reads the latest durable
User admission from generalized `session_input`.

The user may explicitly instruct the member to complete/release/reprioritize its
task through normal tools, but an assistant response generated during a human
cycle does **not** implicitly settle the Swarm task.

This is not a human-focus-only rule. Lease expiry, member rebind/self-heal,
operator release, and recovery must use the same
`retire -> quiesce -> supersede/release -> reassign` protocol. Timeout alone
does not prove that an old Session executor can no longer perform external side
effects.

### 3.17 Human and agent messaging must remain visually distinguishable

Swarm peer messages should be visible in the Session timeline, but they are not
human messages.

Presentation should preserve:

```text
human
  You

peer
  Researcher · via Swarm X

host
  Task assignment / recovery / scheduler
```

without changing provider lowering.

This makes the Session genuinely inspectable by a human while preserving the
authority distinction needed by tools, Goal, checkpointing, and permissions.

---

## 4. Swarms are not Goal special agents

Goal architecture is a valuable reference but not the Swarm object model.

The Goal Auditor is intentionally a host-owned special-purpose child Session with
a constrained protocol. A swarm peer is a normal, independently addressable
root Session participating in a collaboration.

What Swarm should reuse from Goal is **architecture doctrine**:

- durable state is the admission authority,
- host-authored continuation is explicitly distinguished from human input,
- causal lineage is durable,
- correlation / reservation IDs provide idempotency,
- user input can supersede host automation,
- execution ownership/leases are explicit,
- failures do not get reconstructed from prompt text.

What Swarm must **not** inherit:

- special-agent identity,
- hidden child-session ownership,
- single terminal protocol,
- Goal Auditor's read-only role,
- Goal-specific continuation state machine.

---

## 5. Provenance is a first-class Swarm requirement

The current V1 provenance campaign corrected a core modelling error:

```text
provider role == "user"
```

does **not** imply:

```text
human owns this turn
```

The same distinction is mandatory for swarm messaging.

### 5.1 Four independent facts

For a message delivered into a member Session, keep these concepts separate:

1. **Conversational ownership**
   - human/user
   - host

2. **Semantic kind**
   - user
   - synthetic
   - shell
   - compaction
   - assistant
   - current-model equivalents

3. **Collaboration authorship**
   - which Swarm member / Session authored the peer message

4. **Provider projection**
   - what provider role is required on the eventual LLM request

A peer message is normally:

```text
turn owner:        host
semantic kind:     synthetic / orchestration input
peer author:       member_<id> / session_<id>
provider role:     potentially "user" after lowering
```

Peer authorship never grants human authority.

Current Schema doctrine already points at the intended convergence:

- current `SessionMessage.User` is a real user semantic turn,
- current `SessionMessage.Synthetic` is host/runtime context,
- both may lower to a provider `user` role,
- V1 `UserTurnProvenance` exists because the legacy representation historically
  collapsed those semantic kinds.

Native Swarm should target the **current semantic distinction**, while V1
compatibility maps that distinction into its durable provenance field.

### 5.1.1 Peer messages are synthetic in authority, but not invisible in UX

There is an important distinction inside the current semantic model.

For the recipient Session, a Swarm peer message is **not** a human/user-owned
turn. It therefore fits the authority semantics of
`SessionMessage.Synthetic`:

- the runner lowers current Synthetic to provider role `user`,
- `toolUserTurn()` selects only `SessionMessage.User`,
- therefore a peer message cannot become the user's causal tool-intent merely
  because the provider protocol sees a user role.

That is exactly the desired security boundary.

However, current Synthetic is intentionally generic and mostly structural in the
timeline. Current app grouping hides synthetic roots rather than presenting them
as normal human chat bubbles. A peer message is different: its authorship is a
product-visible fact and users should be able to inspect the collaboration.

**Recommendation:** do not introduce a Swarm-specific Session message type yet.
First extend the current generic Synthetic contract with typed source/lineage
attribution sufficient to distinguish:

```text
host automation
  -> Goal continuation
  -> task assignment
  -> recovery/scheduler input

inter-session input
  -> source Session ID
  -> optional source Session message ID
  -> durable domain ref / correlation
```

The current best candidate is deliberately generic and does **not** overload a
bare message ID as cross-session causality:

```ts
type SessionTurnRef = {
  sessionID: SessionID
  messageID: SessionMessage.ID
}

type SyntheticActor =
  | {
      type: "host"
    }
  | {
      type: "session"
      sessionID: SessionID
      messageID?: SessionMessage.ID
    }

type SyntheticOrigin = {
  // Stable namespaced semantic producer, e.g. "goal.continuation",
  // "scheduled-task", "swarm.peer", "swarm.assignment".
  producer: string

  // Who immediately authored/caused this host-owned turn boundary.
  actor: SyntheticActor

  // Producer-domain correlation only. This is attribution/idempotency data,
  // never a permission grant.
  ref?: string

  // Optional cross-session lineage. Consumers MUST check session identity
  // before using this for any local checkpoint/revert behavior.
  cause?: SessionTurnRef
}
```

The exact field names may still change during Schema review, but these semantic
dimensions should not collapse.

Properties:

- generic to Session, not Swarm-specific,
- typed and browser-safe,
- produced once at admission,
- durable,
- separate from provider role,
- separate from presentation styling,
- sufficient for attribution/lineage without text sniffing,
- **not itself an authorization token**.

Why `SessionTurnRef` must include the Session ID:

- current V1 `sourceMessageID` is used as a same-Session checkpoint/worker-root
  pointer;
- a peer turn can originate in Session A and execute in Session B;
- carrying only `msg_...` across that boundary would invite B's checkpoint,
  revert, Goal-root, or UI code to interpret a foreign turn as a local root.

For V1 compatibility, a current `cause` may be lowered to V1
`sourceMessageID` **only when the referenced Session is the same Session**.
Cross-session lineage stays typed in the current model and must not be squeezed
into the legacy field.

Swarm-specific member/task/message IDs remain authoritative in the Swarm domain;
the Session input carries only the cross-domain reference required to explain
where the turn came from.

The UI can then render `origin.type === "session"` as visible inter-session
traffic while ordinary host automation stays structurally hidden or receives a
source-specific automation treatment. Do **not** add a generic
`presentation: "show"` flag to persistence merely to steer one component.

Only introduce a new top-level current Session message kind if a prototype proves
that Synthetic + typed origin cannot express the required history, replay,
authorization, search, or UI semantics.

### 5.2 Required causal metadata

Native swarm-produced Session inputs need structured correlation from their
trusted producer.

Candidate source taxonomy (names are not frozen yet):

- `swarm.peer`
- `swarm.assignment`
- `swarm.continuation`
- `swarm.notice`
- `swarm.recovery`

Each should be able to carry:

- source / semantic producer,
- stable `ref` to the Swarm message, task, delivery, or lease,
- optional typed `SessionTurnRef` lineage when useful,
- peer member/session identity in the Swarm domain record.

The important rule is not the exact strings. It is:

> **The producer stamps provenance once; downstream consumers never infer it
> from message text, prefixes, titles, or timing.**

### 5.3 Why this matters beyond display

Correct provenance controls:

- whether a new input supersedes autonomous work,
- whether a turn counts as human activity,
- checkpoint / rollback roots,
- explicit agent authorization inherited from a causal user turn,
- title/objective selection,
- compaction labels,
- UI replay,
- sharing / export,
- prompt-cache stability,
- security decisions around peer-authored content.

It does **not** automatically transfer tool/permission authority across Sessions.
A peer instruction executes under the recipient Session's own permissions and
member policy. If a future workflow needs explicit delegated capability, model
that as a narrow capability/delegation contract with its own issuer/scope/lifetime
rather than treating `origin.cause` as authorization.

### 5.4 TaskTool follow-on implication

The current TaskTool path is already moving in the correct direction: it receives
an exact `authorizedAgentNames: ReadonlySet<string>`, and the requested
`subagent_type` is checked against that set before falling back to a permission
ask. The V1 Session loop derives the set from the worker root message's explicit
agent parts and passes it through `SessionTools.resolve`.

That is a concrete example of provenance-derived capability being narrower than
“this is a user-role message”.

The remaining convergence requirement is to make sure that exact capability
survives current typed host admission/continuation paths without being
reconstructed from whatever happens to be the latest provider-role `user`
message.

Swarm must not duplicate that bug by treating “coordinator requested this”,
“peer sent this”, or “host injected this” as generic authority.

---

## 6. Current Session architecture is the Swarm runtime

The most important new finding versus the August plan is that current OpenFork
already has the native message-admission primitive OpenSwarm had to emulate.

### 6.1 `SessionInput`

Current Core has a durable `session_input` queue with:

- caller-supplied stable message ID,
- Session ID,
- prompt payload,
- explicit delivery mode,
- durable admitted sequence,
- durable promoted sequence,
- idempotent admission,
- conflict detection,
- ordered promotion.

Delivery modes are:

- `steer`
- `queue`

This queueing/admission machinery is exactly what Swarm should reuse.

**However, the current payload contract is not yet general enough for Swarm.**

Today `SessionInput` stores a `Prompt`, and promotion publishes
`session.next.prompted`, which projects to `SessionMessage.User`. That is
correct for public human prompting and incorrect for a peer-authored Swarm
message.

Calling the existing public `Session.prompt` from Swarm would therefore
re-create the semantic bug the provenance project is removing: host-owned peer
input would be persisted as a genuine current user message.

### 6.2 Generalize admission, do not fork another queue

The first-party prerequisite is to generalize durable Session admission so the
producer supplies the semantic input kind.

Conceptually, the admitted item should distinguish at least:

```text
human prompt
  semantic projection -> SessionMessage.User
  ownership           -> user

host/synthetic input
  semantic projection -> SessionMessage.Synthetic
  ownership           -> host
  source/ref/causal root stamped by producer
```

Both kinds can still use the **same**:

- durable admission sequence,
- `steer` / `queue` ordering,
- deterministic input ID,
- pause behavior,
- wake coalescing,
- Session runner.

Do not create `SwarmInputQueue` beside `SessionInput`; that would duplicate
the exact runtime primitive we are trying to consolidate.

The final shape might be a tagged `SessionInput.Item` union or an equivalent
current Session admission contract. The name is secondary; the ownership rule is
not.

The current SQL shape makes this prerequisite concrete:

```text
session_input
  id
  session_id
  prompt          <-- Prompt JSON only today
  delivery
  admitted_seq
  promoted_seq
  time_created
```

The durable queue/order/index design is good. The payload shape is the part to
generalize.

Preferred target:

```text
session_input
  id
  session_id
  input           <-- tagged current SessionInput.Item JSON
  kind            <-- user | synthetic
  admission_class <-- user | host | automatic
  delivery
  admitted_seq
  promoted_seq
  revoked_seq?
  revoked_reason?
  time_created
```

where `input` can project deterministically to the correct current semantic
message event/kind.

Do not bolt on a nullable `swarm_payload` column and do not create a parallel
`swarm_session_input` execution queue. If compatibility requires a staged SQL
migration, preserve the old prompt column temporarily behind one Core decoder,
then converge to one canonical tagged payload.

### 6.2.1 Ownership must survive promotion and execution

Generalizing only the stored payload is insufficient.

The current runner is allowed to make this shortcut because every
`SessionInput` is currently a genuine prompt:

```text
has pending SessionInput
  => "user work"
  => cancel Goal automation
  => non-automatic afterTurn origin = "user"
```

That invariant becomes false the instant peer/task/recovery inputs share the
queue.

The generalized Session input contract therefore needs semantic ownership/kind
available to:

- pending queries,
- promotion,
- the active run cycle,
- Goal/autonomous preemption,
- tool-intent selection,
- telemetry / replay where relevant.

Do not replace one bad binary with another. In particular:

```text
automatic == false
```

must **not** continue to mean:

```text
human user == true
```

Recommended direction:

- every admitted item has a semantic kind from which ownership is known plus a
  separate admission class from which scheduling source is known,
- pending queries can distinguish user/host/automatic work without decoding
  payload JSON,
- promotion returns a compact semantic summary (or promoted identities), not
  merely an integer count,
- user preemption is a typed pending-input policy, never inferred from source
  text,
- Goal's current `origin: "user" | "automatic"` API becomes the generalized
  cycle source `user | host | automatic`, with automatic continuation carried
  by SessionInput rather than a separate process-owned reservation.

The common hot path should remain allocation-light. A promotion result such as:

```ts
{
  selected,
  promoted,
  staleRevoked,
  kind,            // "user" | "synthetic"; one kind per promotion
  admissionClass,  // "user" | "host" | "automatic"; one class per promotion
  maxPromotedSeq
}
```

is preferable to reloading full message bodies merely to classify the cycle.
`promoted`, not `selected`, controls whether provider execution begins: a
selected row may legitimately lose the projector CAS to revocation. Mixed-source
promotion should be structurally impossible rather than represented as several
counters.

### 6.2.2 Event semantics must converge with the input contract

Current promotion always publishes `session.next.prompted`, which necessarily
projects to `SessionMessage.User`.

A generalized input queue therefore also needs a semantic promotion boundary.
Possible implementation strategies include:

- versioning/replacing the current prompt admission/promotion event with a typed
  Session-input event, or
- retaining prompt events for user prompts while adding a parallel *event kind*
  for synthetic admission/promotion that shares the same `session_input` row.

The architectural constraint is:

> one durable admission queue; semantic event/message kind chosen from the
> admitted item's producer-stamped type.

Do not publish `Prompted` and then try to repair ownership in a downstream
projector.

### 6.2.3 Candidate current `SessionInput.Item` contract

The smallest useful current contract is:

```ts
type SyntheticContent = {
  text: string
  files?: readonly Prompt.FileAttachment[]
}

type DelegatedTurnAuthority = {
  // Exact, trusted delegation only. Omit when the producer has no delegation.
  authorizedAgentNames?: readonly Agent.ID[]
}

type SessionInputItem =
  | {
      type: "user"
      prompt: Prompt
    }
  | {
      type: "synthetic"
      content: SyntheticContent
      origin: SyntheticOrigin
      delegated?: DelegatedTurnAuthority
    }
```

Important negative decisions:

- Synthetic does **not** carry model/agent/permission overrides. Those belong to
  Session/member policy and explicit model/agent switching services.
- Synthetic does **not** reuse the full `Prompt` shape. It may carry text plus
  bounded file references because Task delegation already supports structured
  `@file` / `@directory` inputs and first-party convergence should not regress
  that capability.
- Synthetic does **not** carry `Prompt.AgentAttachment` as authority-bearing
  content. Peer/host text such as `@agent` cannot grant subagent capability.
- If a trusted producer must propagate exact delegated agent authority (for
  example TaskTool recursively carrying an explicitly authorized subagent set),
  it uses the separate `delegated.authorizedAgentNames` field. Swarm peer input
  has no delegated agent authority by default.
- `origin` is mandatory for all **new** synthetic admissions. Historical
  projected Synthetic messages may lack it for compatibility.
- `type` determines semantic ownership:
  - `user` => user-owned,
  - `synthetic` => host-owned.

The core rule is:

> **content is not authority.**

Current V1 derives `authorizedAgentNames` by scanning `agent` parts on a
worker-root message. That was a practical compatibility mechanism, but it is too
implicit for a shared first-party admission plane. Current-model execution should
use a typed helper:

```text
authorizedAgents(User)
  -> explicit user Prompt.agents

authorizedAgents(Synthetic)
  -> trusted item.delegated.authorizedAgentNames only
```

Never scan Synthetic text/file/reference content to infer capability.

The delegated set must itself be attenuated at creation:

- Task child <= exact authority delegated from its parent/user causal boundary;
- Swarm peer = none unless a separate explicit grant exists;
- scheduled/recovery host input = none unless its durable producer contract
  carries an already-authorized delegation.

This turns recursive subagent authorization into durable typed state rather than
an accidental property of prompt rendering.

Do not add a second persisted `owner` truth when it is a total function of the
tagged item. The SQL projection may store the item discriminator separately for
indexing, but it must be derived by the one projector from the same event.

Recommended physical projection:

```text
session_input
  id
  session_id
  kind            # "user" | "synthetic", indexed discriminator
  admission_class # user | host | automatic, indexed execution class
  user_preemptible# pending item yields terminally to newer semantic User
  input           # canonical tagged SessionInput.Item JSON
  delivery        # steer | queue
  admitted_seq
  promoted_seq
  revoked_seq
  revoked_reason
  time_created
```

Hot pending index:

```text
(session_id, admission_class, delivery, admitted_seq)
WHERE promoted_seq IS NULL AND revoked_seq IS NULL
```

Human-preemption index:

```text
(session_id, admitted_seq)
WHERE user_preemptible = 1
  AND promoted_seq IS NULL
  AND revoked_seq IS NULL
```

This preserves the current O(index lookup) lifecycle while making ownership
and execution class available without decoding JSON.

Constraints:

```text
kind=user      -> admission_class=user
kind=synthetic -> admission_class=host | automatic
automatic      -> delivery=queue   # initial protocol
automatic      -> user_preemptible=true
promoted_seq IS NULL OR revoked_seq IS NULL
```

`revoked_seq` is a causal aggregate sequence, not a unique row sequence. One
User admission can revoke multiple older pending user-preemptible inputs at that
same sequence. Automatic input is always user-preemptible; trusted host
producers may opt into the same policy (for example a pending Swarm assignment
that must yield to direct member chat).

Do **not** persist an opaque integer `priority` that silently becomes another
authority surface. Priority is a small protocol over `admission_class` +
`delivery`; semantic ownership remains `kind` + typed provenance.

#### Compatibility shape

The public current `Session.prompt` HTTP/SDK contract should remain a genuine
human Prompt API. It does not need to expose the generic internal item union.

Implementation may therefore distinguish:

- an internal generic SessionInput record/item,
- the existing public prompt-admission return shape.

Do not force a public SDK break merely to make the storage type prettier.

### 6.2.4 Preserve semantic event names; do not redefine “prompted”

The safest event migration is additive.

Keep these meanings unchanged:

```text
session.next.prompt.admitted
session.next.prompted
```

They continue to mean a genuine semantic user Prompt.

Add a queued synthetic lifecycle, conceptually:

```text
session.next.synthetic.admitted
session.next.synthetic.promoted
```

Both event families project into the **same** `session_input` table:

```text
PromptAdmitted       -> Item.User pending
Prompted             -> Item.User promoted + SessionMessage.User
SyntheticAdmitted    -> Item.Synthetic pending
SyntheticPromoted    -> Item.Synthetic promoted + SessionMessage.Synthetic
```

The existing historical/direct `session.next.synthetic` event remains
decodable for replay. New queue-backed host producers should use the admitted /
promoted lifecycle instead of redefining the old event or sending fake prompts.

Why not turn `session.next.prompted` into a v2 union?

- the durable event system can version event definitions, but live subscribers
  still see the same unversioned event type;
- an existing consumer is entitled to interpret “prompted” as user input;
- making that type sometimes mean peer/host input would preserve bytes while
  corrupting semantics.

### 6.2.5 Owner-aware pending arbitration

The current runner's lane priority is `steer > queue > Goal automatic`.
Do not preserve Goal automatic as a fifth queue outside SessionInput. Separate
semantic kind from execution/admission class:

```text
semantic kind:
  User | Synthetic

admission class:
  user | host | automatic

ordering:
  1. user + steer
  2. user + queue
  3. host + steer
  4. host + queue
  5. automatic + queue
```

This ordering is deliberate:

- a human queue is still human authority and outranks host automation;
- `steer` retains its meaning *within one admission class*;
- host urgency is expressed as `steer`, not by inventing a hidden numeric
  priority that can outrank the user;
- Goal autonomous continuation is a Synthetic SessionInput with
  `admission_class=automatic`, not a second runnable-work mechanism;
- automatic work only runs when no user/host Session input is eligible.

Initial automatic work is queue-only. Do not create an automatic steer lane
without a demonstrated semantic need.

Within the selected class preserve today's semantics:

- steer: promote all selected-kind steers through the captured durable cutoff;
- queue: promote exactly one selected-kind queue item, then selected-kind steers
  through that cutoff;
- FIFO remains `admitted_seq`;
- concurrent promotion remains event/projector-idempotent.

User admission also atomically revokes older still-pending
`user_preemptible` inputs at the User event's aggregate sequence. Automatic
work is always user-preemptible; host producers such as Swarm may opt into the
same policy. If promotion committed first, the historical/running input remains
and User wins the next provider boundary. If User admission committed first,
later promotion cannot succeed.

The implementation should benchmark two obvious indexed selection shapes rather
than guess:

1. short-circuit point lookups over the five fixed lanes;
2. one bounded query returning the earliest pending row per class.

The protocol order above is fixed; the SQL formulation is a benchmark decision.

### 6.2.6 Provider cycles are homogeneous by source class

A logical provider cycle has exactly one source:

```text
user
host
automatic
```

Do not let a different-class steer silently mutate the cycle's origin.

Rules:

- same-class steers may be promoted between provider steps and remain part of
  the current logical cycle;
- a user input arriving during a host cycle becomes the next user cycle at the
  next safe provider-step boundary;
- a user input arriving during an automatic cycle supersedes further autonomous
  continuation at the next safe boundary;
- host input arriving during a user cycle waits;
- host input arriving during an automatic cycle outranks the **next**
  autonomous cycle but need not tear apart an in-flight tool continuation.

This preserves one-thread-per-Session execution while keeping attribution honest.

The current pattern:

```text
automatic provider turn
  + pending steer
  -> mutate cycleAutomatic / call afterTurn as "user"
```

must disappear. The already-started automatic work remains automatic even if a
human arrives while it is streaming.

### 6.2.7 Revalidate priority immediately before provider spend

Admission/promotion selection can race with a higher-priority arrival.

Before each new provider request:

- user cycle: no ownership class can preempt it automatically;
- host cycle: if a newer user-owned input is pending, do not spend another host
  provider request first;
- automatic cycle: if any Session input is pending, do not spend another
  autonomous provider request first.

If a synthetic item was already promoted before the newer user arrived, keep the
committed history entry. The runner can promote the user and issue **one user
cycle** whose context contains the older host message followed by the newer user
message rather than wasting an avoidable host-only provider call.

This is a revalidation rule, not a rollback rule.

### 6.2.8 Goal integration: automatic work is SessionInput, not a second lease

Goal's current `origin: "user" | "automatic"` is too small once host-owned
Session input exists.

Target conceptual source:

```ts
type WorkerCycleSource = "user" | "host" | "automatic"
```

The cycle source comes from the promoted SessionInput admission class.
Automatic Goal continuation no longer needs a process-owned reservation claim:
it is a Synthetic `admission_class=automatic` SessionInput.

Semantics:

- **user**
  - genuine user authority,
  - transactionally revokes older pending user-preemptible inputs,
  - may establish a fresh continuation chain after audit;
- **host**
  - real worker output caused by peer/task/scheduled/recovery input,
  - does not become user authority,
  - may be audited and may produce a fresh future continuation when policy
    permits,
  - must not call the user-cancellation path merely because it is Session input;
- **automatic**
  - carries an exact Goal continuation/input correlation ID,
  - pending input is always user-preemptible,
  - stale/superseded input cannot reconcile Goal state or manufacture another
    continuation,
  - next automatic admission uses an exact latest-User sequence fence.

If a genuine user input arrives while a host/automatic provider cycle is in
flight:

- finish/settle already-started provider/tool state safely,
- do not let that older non-user cycle manufacture a new automatic SessionInput
  after the user has taken control,
- move to the user cycle.

For automatic cycles, SessionInput lifecycle + Goal correlation provide the
fence. Host cycles use the same latest-User supersession fact without pretending
they own Goal execution authority.

The runner should supply that fact explicitly (for example “superseded by newer
user admission”) rather than Goal querying Session history or reconstructing
timing.

#### Goal continuation is intrinsic, not a budgeted mode

**Superseded 2026-10-02:** Goal Mode no longer has continuation-policy
guardrails such as turn counts, no-progress counts, duration ceilings, or token
budgets. A runnable Goal exists specifically to keep cycling worker →
independent auditor → worker until the auditor verifies completion, concludes
failure, or identifies a real blocker.

User/host supersession still fences stale autonomous work, but it does not
change the Goal's continuation semantics. Scheduler/provider safety limits
belong to their owning domains rather than being encoded as Goal policy.

Freeze this with Goal-specific regression tests before changing persisted
counter semantics.

### 6.3 Current provenance convergence

Do not make new/current Swarm code depend on the V1 provenance namespace.

The target should be a current semantic input/provenance contract in
`packages/schema` (for example, an origin/source attached to admitted host
input), with the V1 compatibility path mapping it to
`SessionV1.UserTurnProvenance` when legacy messages must still be produced.

This follows `packages/schema/AGENTS.md`:

- current `User` / `Synthetic` / `Shell` / `Compaction` are the semantic
  architecture,
- V1 provenance is a compatibility bridge,
- provider-role lowering is a runtime concern.

### 6.4 Public `Session.prompt`

Current Session prompt:

- only accepts direct prompts for root Sessions,
- writes through `SessionInput.admit`,
- verifies idempotent equivalence,
- wakes Session execution,
- admits without running while a Session is paused.

Keep that public API semantically human-owned.

Swarm should use a trusted internal host-admission API that shares the same
underlying `SessionInput` machinery but projects a current synthetic/host input.
TaskTool, Goal continuations, recovery, scheduled automation, and Swarm should
ultimately converge on that same host-admission primitive rather than each
inventing a different injection path.

### 6.4.1 Exact current host-admission seam: useful compatibility path, not the target

The current V1 runtime already exposes `SessionPrompt.hostPrompt` and TaskTool's
dispatch path uses it. That seam has several correct behaviors worth preserving:

- producer explicitly chooses `origin: "host"`,
- host input does not execute the genuine-user Goal-preemption path,
- caller can provide a stable message ID,
- `noReply` supports admit-first / run-later dispatch,
- normal Session promptability and pause semantics remain in force.

But it is still a **V1 compatibility implementation**:

```text
SessionPrompt.hostPrompt
  -> promptInternal(origin="host")
  -> createUserMessage(...)
  -> SessionV1.User { role:"user", provenance:{ owner:"host", ... } }
```

Its generic source is currently `HostPrompt`, and semantic host ownership is
recovered through `SessionV1.UserTurnProvenance`.

That is not the long-term Swarm contract. The current Session service already has
the better durable primitive:

```text
Session.prompt
  -> SessionInput.admit
  -> session.next.prompt.admitted
  -> ordered steer/queue promotion
  -> session.next.prompted
  -> SessionMessage.User
  -> SessionExecution.wake
```

The missing operation is therefore narrow and concrete:

> generalize the current SessionInput item/event/promotion contract so a trusted
> producer can admit a current `Synthetic` item with typed origin while reusing
> the same durable ordering, idempotency, pause, and wake machinery.

Do **not** build native Swarm by calling V1 `hostPrompt` and declaring the
provenance problem solved. V1 should consume/map the new semantic contract during
compatibility convergence, not define it.

### 6.5 `SessionExecution`

Session execution already owns:

- wake coalescing,
- active execution,
- resume,
- interrupt,
- location routing.

Therefore Swarm must not create a second per-member execution runtime.

---

## 7. Target first-party architecture

### 7.1 Ownership diagram

```text
packages/schema
  browser-safe Swarm IDs/entities/events only
          |
          v
packages/core
  Swarm durable aggregate + projectors + DB invariants
  SwarmTask durable graph / leases
  SwarmMail logical messages / recipient receipts
  SwarmMemory blackboard / claims / artifact refs
  Session execution-boundary policy
          |
          | Tier-2 profile resolution / Tier-3 execution
          v
packages/opencode
  LocationProfileResolver (Tier 2, narrow)
    -> declarative agent/model catalog only
    -> member profile validation/resolution
  SwarmExecution bridge (Tier 3, thin)
    -> trusted typed SessionInput admission for peer/task input
    -> SessionExecution wake/interrupt
          |
          v
server / tools / app / desktop / TUI
  adapters + compact projections only
```

### 7.2 Core is the durable authority

Core should own the facts that must survive:

- swarm identity,
- member ↔ Session membership,
- role / capability metadata that is actually Swarm-specific,
- task graph,
- task ownership / leases / reservations,
- peer messages,
- recipient delivery receipts,
- blackboard / claims,
- artifact references / handoff records,
- swarm lifecycle,
- exact migration/import metadata.

Core should **not** mirror:

- Session run status,
- Session model if Session already owns it,
- Session permissions if Session already owns them,
- Session transcript,
- Session pause state,
- live provider phase,
- live timers/fibers.

One apparent exception is not a mirror: a managed member may need a durable
**desired execution profile** so its logical identity can survive destruction of
its backing Session. That profile is creation/rebind intent, not an observation
of the Session's current runtime state. Keep the distinction explicit:

```text
SwarmMember desired profile
  -> durable recreation intent

Session agent/model/execution boundary
  -> current execution materialization

Session telemetry/events
  -> observed live runtime truth
```

Do not periodically reconcile Session state back into Swarm merely because the
two representations share fields.

### 7.3 OpenCode/OpenFork runtime bridge stays thin

Current inspection shows that root `Session.create()` itself is durable Core
work: it records a Session identity/location/agent/model and does not require
provider execution. Therefore do **not** invent an asynchronous member
"provisioning queue" merely to create a Session.

The runtime bridge exists only for operations that actually require execution:

- admit host-owned input into member Session,
- wake or interrupt Session execution,
- execute provider/tool work.

It should look closer to ScheduledTaskExecutor than OpenSwarm's
`OpenCodeRuntime` adapter.

### 7.4 Profile admission is Tier 2, not Tier 3

There is still a real prerequisite before a managed member Session can be
created: deterministic validation/resolution of its execution profile.

The existing convenient location path is **too heavy** for this job. Current
`LocationServiceMap` builds a graph containing, among other things:

- config + policy,
- Agent and Catalog,
- plugins,
- filesystem/index/watchers,
- PTY,
- Permission,
- ToolRegistry,
- snapshots/checkpoints,
- SessionRunner,
- title/prompt-revisor services.

Using that graph just to answer "is this agent/model/variant valid here?" would
turn a Tier-2 admission into a hidden Tier-3 bootstrap.

Create a narrow location-keyed profile resolver, conceptually:

```text
LocationProfileResolver
  input:
    Location.Ref
    MemberProfileIntent

  owns:
    declarative workspace config
    built-in/config agent catalog
    canonical model/provider catalog projection
    model capability + variant validation
    permission-boundary derivation

  explicitly does NOT own:
    ToolRegistry/tool schemas
    MCP process startup
    LSP/formatter/watchers
    PTY
    snapshots/checkpoints
    SessionRunner/LLM client
    provider generation
```

The resolver must use the **same catalog-building functions** as the full runtime,
not a separately maintained "lite catalog". Refactor catalog seed/transform
logic into reusable deterministic loaders and let both Tier 2 and Tier 3 consume
those functions.

First-party/config-defined agents and models must be resolvable without executing
arbitrary external plugin code. A third-party plugin that only creates an agent
or model by running arbitrary plugin logic is not a deterministic Tier-2 spawn
target. Fail closed with a typed "runtime-only profile" / unavailable-profile
error until the plugin ecosystem has an explicit declarative catalog-manifest
contract.

This follows the repository invariant:

> validate deterministic Session configuration at admission; do not persist an
> unrunnable Session and wait for asynchronous execution to discover it.

### 7.5 Desired member profile versus Session materialization

For managed worker members, persist a small typed desired profile:

```ts
type MemberExecutionProfile = {
  agent: Agent.ID
  model: Model.Ref
  permissionBoundary: Permission.Boundary
  requestedCapabilities?: readonly ModelCapability[]
}
```

The concrete model/variant selected at admission is persisted so revive/rebind is
deterministic. A capability request (for example image/PDF) is selection input;
do not repeatedly re-run "cheapest capable model" during every continuation.

Store selection rationale only if the product needs to explain it. Do not store
duplicated price/capability catalog data.

Coordinator/external-member Sessions need not be Swarm-managed profiles merely
because they participate in a Swarm. Their pre-existing Session remains its own
profile authority.

### 7.6 Generic Session execution boundary

Current PermissionV2 evaluates agent permissions plus saved project approvals.
It does not yet have a current-model Session-level hard restriction. Native Swarm
should not reintroduce the V1 pattern of copying a mutable permission ruleset
into Swarm state.

Add a generic Session execution boundary owned by Session/Permission. Keep it
out of the dense public `Session.Info` navigation object; expose/read it only
where execution/permission code needs it.

Conceptually, permission evaluation becomes:

```text
agent configured decision
        INTERSECT
Session execution boundary
        INTERSECT
workspace/domain hard constraints
        THEN
saved human approvals may resolve ASK -> ALLOW
but can never override a DENY from any hard boundary
```

For one `(action, resource)`, use an explicit restriction lattice:

```text
DENY < ASK < ALLOW
```

Evaluate each policy independently, take the most restrictive result, then allow
an existing user approval to resolve `ASK` only when no policy says `DENY`.

This is a reusable current-model primitive for:

- Swarm managed workers,
- TaskTool delegated Sessions,
- scheduled/unattended execution,
- future sandbox/delegation features.

Do not encode this as order-sensitive "append these Swarm rules last" behavior.

---

## 8. Recommended durable data model

Do not copy the plugin schema table-for-table. Normalize around host ownership.

### 8.1 Swarm

Candidate canonical row:

```text
swarm
  id                         PK
  project_id                 FK -> project
  directory                  canonical absolute target directory
  workspace_id?              optional native Workspace ID
  name
  status                     creating | active | paused | stopping |
                             completed | failed | archived
  coordinator_member_id?     logical member identity, never Session identity
  policy                     typed JSON
  revision                   optimistic mutation revision
  created_at
  updated_at
  completed_at?
  archived_at?
```

The directory/workspace is execution **scope intent**, not a Session mirror. It
must survive loss of the coordinator Session so managed members can still be
recreated deterministically.

Do not store `coordinator_session_id`; resolve the currently bound Session
through the coordinator member.

Constraints/indexes:

- `UNIQUE(project_id, name)` only if product semantics still require names to
  be unique; stable ID remains mutation authority;
- index `(project_id, status, updated_at DESC)` for project dashboards;
- coordinator transitions verify that the referenced member belongs to the same
  Swarm inside the owning transaction.

### 8.2 Member

Canonical membership row:

```text
swarm_member
  id                         PK
  swarm_id                   FK -> swarm ON DELETE CASCADE
  name                       stable human/model address within Swarm
  kind                       coordinator | managed_worker | external | guest
  role                       descriptive role label, not authorization
  lifecycle                  active | held | stopping | stopped
  session_id?                FK -> session ON DELETE SET NULL
  binding_generation         monotonically increasing rebind fence
  desired_profile?           typed MemberExecutionProfile JSON
  workspace_policy           shared-read | shared-write | worktree + refs
  capabilities?              scheduler-facing typed capability metadata
  created_at
  updated_at
  stopped_at?
```

Important separations:

- `lifecycle` is Swarm membership intent, not Session `working/idle/retrying`;
- `desired_profile` is recreation intent for managed workers, not a live
  Session-model mirror;
- direct Session pause/status/telemetry stays in Session;
- no `current_task_id`;
- no `human_chat_at`;
- no `last_active_at`.

Constraints/indexes:

- `UNIQUE(swarm_id, name)`;
- partial `UNIQUE(swarm_id, session_id) WHERE session_id IS NOT NULL`;
- index `(session_id)` for exact principal/membership resolution;
- index `(swarm_id, lifecycle, kind)` for roster/scheduler candidates.

Every bind/rebind increments `binding_generation`. Any asynchronous execution
or settlement tied to a member Session carries:

```text
(member_id, session_id, binding_generation)
```

and is rejected if the current binding no longer matches.

Do not globally unique `session_id`: one coordinator Session may intentionally
participate in several Swarms.

### 8.3 Task

Do not mix task semantics, current lease ownership, and execution-attempt history
in one row.

Canonical task:

```text
swarm_task
  id                         PK
  swarm_id                   FK -> swarm ON DELETE CASCADE
  title
  description?
  status                     pending | blocked | ready | working |
                             review_pending | changes_requested |
                             completed | failed | cancelled
  priority
  created_by_member_id?
  reserved_member_id?        preferred/intended member, not ownership
  reserved_until?
  reservation_revision
  lease_generation           monotonic fencing source
  semantic_retry_count
  acceptance                 typed JSON
  metadata                   bounded typed/extensible JSON
  ready_at?
  created_at
  updated_at
  completed_at?
```

Task dependency:

```text
swarm_task_dependency
  task_id
  depends_on_task_id
  requirement                require_success | require_terminal
  PRIMARY KEY(task_id, depends_on_task_id)
  CHECK(task_id != depends_on_task_id)
```

Reverse index:

```text
(depends_on_task_id, task_id)
```

Do **not** persist `unmet_dependency_count` in the foundational schema.
`task.status` is already the materialized readiness projection. Maintain it
change-locally:

```text
prerequisite settles or dependency edge changes
  -> reverse-index affected dependent IDs only
  -> for each affected row, check forward prerequisites
  -> transition blocked <-> ready in the same domain transaction
```

Phase-0 Bun/SQLite prototype at 10k tasks:

- 10 affected dependents: ~0.23 ms;
- 100: ~0.38 ms;
- 1,000: ~2.44 ms;
- 5,000: ~12.4 ms.

`EXPLAIN QUERY PLAN` for the corrected statement is driven by
`dep(depends_on_task_id, task_id)`, performs task PK lookups for only the
affected set, and then uses the forward dependency index for prerequisite checks.
It does not scan the task graph.

This is preferable to a second denormalized readiness counter unless future
benchmarks show an extreme fan-out workload where the extra consistency burden
is justified.

Current ownership is a separate lease:

```text
swarm_task_lease
  task_id                    PRIMARY KEY / FK -> swarm_task
  generation                 equals task.lease_generation
  owner_member_id            FK -> swarm_member
  owner_session_id           binding snapshot
  owner_binding_generation   binding snapshot
  lease_owner_process        process/runner claim identity
  state                      active | human_hold | retiring
  hold_user_seq?
  hold_started_at?
  hold_deadline?
  retire_reason?
  retire_requested_at?
  acquired_at
  expires_at
  renewed_at?
```

Execution history is a run:

```text
swarm_task_run
  id                         PK
  task_id                    FK -> swarm_task
  member_id                  logical actor
  session_id                 Session snapshot
  binding_generation         member fence
  lease_generation           task fence
  session_input_id           stable assignment-input identity
  status                     admitted | running | completed | failed |
                             cancelled | superseded
  failure_kind?
  failure_detail?
  admitted_at?
  started_at?
  ended_at?
  created_at
```

The pair

```text
(binding_generation, lease_generation)
```

is the execution fence. A stale Session cannot act for a rebound member, and a
stale run cannot settle a reassigned task.

Hot indexes:

- ready queue:
  `(swarm_id, status, priority DESC, ready_at, created_at, id)`;
- due lease:
  `(expires_at, task_id)`;
- member lease:
  `(owner_member_id, task_id)`;
- run history:
  `(task_id, created_at DESC, id DESC)`;
- `UNIQUE(session_input_id)` on task run.

No transaction remains open while provider/tool execution occurs.

The lease's `retiring` state is a safety fence, not permission to continue
task work. A retiring lease may remain owned/renewed beyond a policy deadline
until the old Session executor reaches the shared quiescence barrier. Do not let
ordinary expiry bypass this fence.

### 8.4 Message and delivery must be separate

OpenSwarm currently combines logical content and recipient delivery state too
tightly.

Native schema should use:

```text
swarm_message
  id
  swarm_id
  sender_member_id
  kind
  body / structured refs
  task_id?
  correlation_id?
  response_to?
  priority
  created_at
  expires_at?

swarm_delivery
  id
  message_id
  recipient_member_id
  state
  session_input_id
  claim_generation
  claim_owner?
  claim_expires_at?
  next_attempt_at?
  attempt_count
  admitted_session_id?
  admitted_seq?
  admitted_at?
  error?
```

Advantages:

- one immutable logical message,
- broadcast snapshots recipients once without duplicating message bodies,
- one delivery receipt per target,
- idempotent retry by delivery ID,
- clean distinction between “message exists” and “member received/admitted it”.

Recommended constraints/indexes:

- `UNIQUE(message_id, recipient_member_id)`;
- `UNIQUE(session_input_id)`;
- message stream: `(swarm_id, created_at, id)`;
- correlation: `(swarm_id, correlation_id)` when present;
- recipient mailbox: partial
  `(recipient_member_id, created_at, id) WHERE state='pending'`;
- dispatcher due path: partial
  `(next_attempt_at, id) WHERE state='pending'`;
- stale-claim recovery: partial
  `(claim_expires_at, id) WHERE state='claimed'`.

Prefer partial hot-state indexes here because terminal/admitted history is
expected to dominate table size. There is no reason for settled delivery rows to
remain in the dispatcher's working-set index.

Delivery claim is fenced by `claim_generation`; settlement/release requires the
same generation. Admission resolves the recipient's **current** member binding
immediately before SessionInput admission. A binding lost before commit leaves
the receipt retryable; a committed Session admission records the exact Session
that accepted it and is never duplicated into a replacement Session.

Do not add a “model understood/read this” state. `admitted` is transport truth;
reply/task settlement is semantic truth.

Phase-0 Bun/SQLite prototype with 300k delivery rows / 10k pending:

- atomically claim 64 due rows: ~0.74 ms;
- recipient pending-mail lookup: ~0.5 µs median / 0.7 µs p95;
- next global due delivery: ~0.3 µs median / 0.4 µs p95.

The claim plan is:

```text
partial pending due index -> bounded 64 ids -> delivery PK update
```

with no settled-history scan.

### 8.5 Shared memory

Phase-one shared memory should remain deliberately small:

- CAS blackboard entries,
- path/lane claims,
- artifact/deliverable references.

Do not make “belief”, “resonance”, or “corpse/gold” heuristics part of the
foundational scheduler schema until their value is independently validated.

Canonical Phase-1 forms:

```text
swarm_blackboard
  swarm_id
  key
  value
  content_type
  version
  author_member_id
  task_id?
  created_at
  updated_at
  PRIMARY KEY(swarm_id, key)
```

Writes use:

```text
UPDATE ... SET version = version + 1
WHERE swarm_id=? AND key=? AND version=expected
```

```text
swarm_claim
  swarm_id
  member_id
  scope
  generation
  expires_at?
  released_at?
  created_at
  updated_at
  PRIMARY KEY(swarm_id, member_id, scope)
```

Reclaim updates the canonical row and increments `generation`. EventV2 provides
history; do not retain an ever-growing row per expired advisory claim merely to
reconstruct history.

```text
swarm_deliverable
  id
  swarm_id
  member_id
  task_run_id?
  summary
  refs
  files
  verdict?                   accepted | rejected
  verdict_by_member_id?
  created_at
  verdict_at?
```

Typed blackboard contracts can be an optional adjacent table when that feature
ships. Belief/resonance/subscription-derived caches are not foundational tables.

### 8.6 Tables intentionally absent

Do **not** create native equivalents of:

- `swarm_event` — EventV2 owns durable history;
- `swarm_pending_permission` — Permission owns pending requests;
- `member.current_task_id` — active task lease owns execution;
- member working/idle/provider-status columns — Session telemetry owns them;
- member current-model mirror — Session owns live model;
- `human_chat_at` — generalized SessionInput's latest semantic User admission
  owns user activity;
- SessionGroup membership copies — virtual read projection;
- separate Swarm DB / ChunkDB runtime tables.

### 8.7 Generation rules are part of the data model

Use monotonically increasing generations anywhere expiry/replacement cannot
revoke already-running code:

| Domain | Fence | Rejects |
|---|---|---|
| member binding | `binding_generation` | old Session acting after revive/rebind |
| task ownership | `lease_generation` | old owner settling after reassignment/expiry |
| delivery claim | `claim_generation` | old dispatcher settling a reclaimed receipt |
| optional grant | grant revision/chain | revoked/superseded delegated authority |

Expiry supplies liveness. Generation supplies stale-writer safety.

---

## 9. Peer messaging: Swarm semantics over SessionInput transport

### 9.1 Send path

The target flow should be:

```text
peer invokes swarm message action
  -> authorize sender from exact membership
  -> write immutable swarm_message
  -> snapshot recipient(s) into swarm_delivery
  -> commit durable domain state
  -> SwarmExecution admits a HOST/SYNTHETIC recipient input into SessionInput
       using deterministic input identity
  -> SessionExecution wakes/coalesces
  -> receipt records admission
```

### 9.2 Idempotency

Allocate one stable target Session-input/message ID per `swarm_delivery` and
persist it with the receipt before attempting delivery. The mapping itself is
then deterministic even if the ID was randomly generated.

The host database gives us a stronger settlement boundary than the external
plugin had. EventV2's durable publish path supports a local `commit(seq)` hook
inside the same SQLite transaction as the Session event/projectors.

Preferred delivery protocol:

```text
TX A — Swarm aggregate
  create immutable swarm_message
  create recipient swarm_delivery rows
  preallocate each delivery.session_input_id
  state = pending
COMMIT

for each recipient:
  TX B — recipient Session aggregate
    publish typed Session input admission
    SessionInput projector inserts the input row
    local commit hook:
      UPDATE swarm_delivery
      SET state='admitted', admitted_seq=?, admitted_at=...
      WHERE id=? AND state='pending'
  COMMIT
```

This deliberately does **not** attempt to publish two durable aggregate events in
one transaction.

- The Swarm aggregate owns logical message/recipient intent.
- The Session aggregate owns input admission.
- The receipt row is the compact cross-domain projection joining those facts.

If a durable Swarm-history entry for “admitted” is eventually required, derive
or append it after the authoritative Session admission; do not make correctness
depend on atomically appending events to two aggregates.

Crash outcomes are unambiguous:

- crash before TX A commit: no message exists,
- crash after TX A / before TX B: pending receipt is retryable,
- TX B failure: both Session admission and receipt transition roll back,
- crash after TX B commit: both Session admission and receipt say admitted.

The retry path remains idempotent:

1. dispatcher retries same delivery,
2. typed SessionInput admission sees the same preallocated input ID,
3. equivalent input is returned rather than duplicated,
4. Swarm marks receipt admitted.

This is materially stronger than plugin-era “send prompt then infer what
happened” recovery and removes the admission/receipt crash window altogether.

### 9.3 Do not claim impossible exactly-once semantics

The domain can guarantee:

- exactly one logical Swarm message row,
- exactly one recipient receipt row,
- idempotent semantically-correct Session input admission.

It should **not** describe provider execution or external tool side effects as
magically exactly-once. Those require their own idempotency boundaries.

### 9.4 Direct vs broadcast

Keep these semantically distinct:

- direct: specific member address, optionally request/response,
- broadcast: one logical publication with a recipient snapshot.

The sender should not receive its own broadcast unless explicitly requested.

### 9.5 Delivery policy: `steer` vs `queue`

Do not allow arbitrary model text to accidentally choose high-impact delivery.
Map Swarm message semantics to Session delivery policy.

Initial policy candidate:

| Swarm input | Session delivery |
|---|---|
| urgent blocker / critical finding relevant to active work | `steer` |
| ordinary peer finding while recipient is working | `steer` with flood/coalescing policy |
| new task assignment | `queue` |
| handoff requiring a distinct response | `queue` |
| coordinator recovery continuation | `queue` unless it is explicitly a steer |
| low-priority broadcast/status | do not necessarily create a provider turn; expose through digest/context projection |

This table needs micro-prototype testing against current Session runner behavior
before freezing.

---

## 10. Human chat / “yield to the user”

OpenSwarm's product behavior is good; its detection mechanism should die.

### 10.1 Preserve

When a human directly chats with a member:

- do not stampede that Session with unrelated new autonomous assignments,
- do not let scheduler churn fight the user's conversation,
- keep peer mail durable,
- resume normal automation after an explicit or policy-defined release.

### 10.2 Replace heuristics with producer-owned state

Do not use:

- text prefixes,
- title conventions,
- self-injection ID caches,
- “recent message looked like X” scans.

The Session producer already knows whether an admitted turn is human-owned or
host-owned.

If Swarm scheduling needs “member is currently human-focused”, read the latest
semantic User admission directly from `session_input`; do not create another
interaction table merely to cache two fields.

Recommended partial covering index:

```sql
(session_id, admitted_seq DESC, time_created)
WHERE kind = 'user'
```

Then:

```text
latestUserAdmission(sessionID)
  -> admitted_seq
  -> time_created
```

is the canonical fact.

Phase-0 Bun/SQLite prototype with **1,000,000 mixed SessionInput rows**:

- median ~0.9 us;
- p95 ~1.6 us;
- query plan = covering partial-index lookup by `session_id`.

That is cheaper and more truthful than maintaining a second projection.

Do not persist `humanChatAt` independently on every Swarm member. A Session can
participate in more than one collaboration and each Swarm may choose a different
lull policy. Session owns the fact “a human prompt arrived at T/seq”; Swarm owns
the policy “hold autonomous collaboration for N ms after that fact.”

### 10.2.1 Close the user-vs-peer admission race

A simple timestamp check before calling Session admission is not sufficient:

```text
dispatcher reads "not chatting"
human prompt commits
dispatcher admits peer steer
```

would put host work after the user's new instruction.

Use the latest User admission as an optimistic fence:

1. dispatcher reads latest User `admitted_seq`,
2. dispatcher decides whether policy allows delivery,
3. Session synthetic admission runs,
4. inside the same Session event transaction, the delivery commit hook verifies
   the latest User admission sequence is still the expected value,
5. if it changed, fail/roll back admission and leave the Swarm receipt pending.

Because Session durable writes serialize, the race has deterministic outcomes:

- peer admission commits first, then the later human prompt has the later
  Session sequence and wins conversational ordering;
- human prompt commits first, then peer admission sees the changed fence and is
  deferred.

This gives human chat priority without text sniffing, process-local ID sets, or a
global lock.

When the lull expires, the Swarm lease runner can re-attempt pending delivery.
Use the same earliest-due timer strategy as other time-based Swarm work; do not
create one timer per member.

#### Admission boundary versus already-admitted work

The human-focus grace applies primarily **before Session admission**:

- new peer mail/task assignments stay durable in the Swarm domain while the
  member is user-focused;
- the admission fence prevents them from racing in behind a newer user turn.

Do not try to “un-admit” a synthetic Session input that committed before the
human prompt. Once SessionInput accepted it, it is part of the Session's durable
history contract.

If a human prompt arrives after an older synthetic input was admitted but before
that input consumed a provider request:

- owner-aware Session arbitration promotes/runs the user first;
- the older synthetic item remains durable;
- it may run after the user cycle unless a domain-specific explicit
  cancel/expiry operation invalidates the upstream Swarm work.

This distinction keeps collaboration grace policy out of the generic Session
queue while still making human priority deterministic.

### 10.3 Do not conflate human focus with manual pause

`paused_at` means the operator explicitly paused a Session. It is a durable
execution gate.

Human focus/lull is a collaboration scheduling policy.

They may both suppress autonomous Swarm work, but they are not the same state.

User input should also retain the Session runner's stronger priority semantics.
A genuine user input admitted after an earlier host input receives a later
durable Session sequence but still wins the **next provider-cycle selection** by
semantic priority. A host producer attempting to race *after* that user input
must pass the admission fence above rather than relying on coincidental prompt
ordering.

---

## 11. Task scheduler redesign

The scheduler should own task **intent and claims**, not Session execution.

### 11.1 Event-driven first

Trigger targeted scheduling on:

- task creation/change,
- dependency settlement,
- task release,
- member addition/removal,
- lease expiry,
- explicit retry/reassign.

Avoid “scan every swarm every 10 seconds”.

### 11.2 One earliest-due timer

For time-based leases/retries, follow the ScheduledTask runner pattern:

- compute earliest due time,
- arm one scoped timer,
- wake,
- re-read the clock/state,
- process bounded due work,
- re-arm.

Cross-process correctness lives in DB leases/CAS, not timer ownership.

### 11.3 Revalidate before provider spend

A scheduler can choose a task, then the world can change before a member Session
actually starts.

Before admitting assignment work:

- verify task generation/lease is still current,
- verify member still belongs to swarm,
- verify member is eligible,
- verify Session exists and is not explicitly paused,
- verify assignment was not superseded.

This mirrors the ScheduledTask “lease then revalidate immediately before spend”
pattern.

### 11.4 Incremental DAG work

OpenSwarm's deterministic DAG logic is worth preserving conceptually, but the
native implementation should avoid repeated O(tasks × dependencies × members)
full sweeps.

Prefer:

- indexed dependency edges,
- affected-descendant readiness updates,
- materialized unresolved-dependency counts if benchmarks justify them,
- bounded candidate queries ordered by priority,
- pure affinity scoring over a small ready candidate set.

Measure before adding complexity.

### 11.5 Task settlement authority

Completion must be generation/owner scoped.

A member that lost ownership by reassignment cannot later settle the task with a
stale response.

The DB transition, not an in-memory member object, is the authority.

---

## 12. Supervision and recovery

The native system does not need a giant “Supervisor” that repeatedly rebuilds
host truth.

### 12.1 Recover durable leases, not processes

On restart:

- Session rows still exist,
- Swarm member Session IDs still exist,
- SessionInput persists,
- task/mail leases can be reconciled,
- event-driven runtimes can re-arm from durable due state.

The process-local runner is disposable.

### 12.2 Session deletion is a real domain event

If a user deletes a member Session:

- membership becomes broken/stopped according to explicit policy,
- owned task is released or marked interrupted atomically,
- UI reports the missing Session,
- recovery may offer an explicit replacement.

Do not silently “adopt” another Session or fuzzy-match a replacement.

### 12.3 Liveness should consume Session telemetry/state

Do not scan entire transcripts looking for the last activity timestamp.

Use existing compact Session phase/status/telemetry projections. If Swarm needs
an additional semantic liveness signal, Session should produce it once.

### 12.4 Watchdog policy becomes smaller

The plugin's watchdog has to infer whether a remote Session is alive. First-party
code can observe:

- active Session execution,
- retry state,
- pending permissions/questions,
- durable input,
- explicit pause,
- telemetry phase,
- task lease.

Escalation can therefore become a small typed state machine rather than
silence-time heuristics plus self-nudges.

---

## 13. Permissions

Native Swarm must use the host permission engine as authority.

### 13.1 Member Session owns permissions

Swarm may define a desired spawn/rebind profile from which the Session execution
boundary is derived, but the effective permission decision belongs to
Session/Permission.

Do not persist a parallel “effective permission” truth in Swarm.

The Swarm profile may persist the **boundary intent** required to recreate a
managed worker after Session loss. That is not effective permission state and
must not be used directly by tools. PermissionV2 evaluates the Session
materialization of the boundary.

### 13.2 Peer content does not grant permission

A peer message can suggest:

> edit X

but it cannot confer the human authority needed to widen permissions.

This is another reason provenance and collaboration authorship must remain
separate dimensions.

Current Core already gives us a useful negative invariant here:
`toolUserTurn()` finds only the latest current `SessionMessage.User`. It
ignores `Synthetic`.

The Swarm implementation must preserve that property:

> a peer-authored Session input may lower to provider role `user`, but it must
> not become the causal user turn supplied to tool authorization / intent-aware
> execution.

### 13.3 Pending permission state should be consumed, not rediscovered

The plugin currently needs dual V1/V2 interception and polling. Native code
should consume the host's canonical pending permission state/events directly.

No self-SSE subscription. No polling the same server from inside itself.

### 13.4 Automation may attenuate authority; it may not mint human authority

OpenSwarm's permission-escalation UX protects an important product invariant:
headless workers must not silently hang behind an invisible permission prompt.
Preserve that visibility, but change the authority mechanics.

A coordinator **model** is not the human merely because it has the coordinator
role. Therefore:

- coordinator/peer models may observe that a member is permission-blocked;
- they may notify the user, reroute/cancel work, or reject/abandon their own
  delegated work when domain policy permits;
- they may not answer another member's permission request with `once` or
  `always` if that widens authority beyond an already-issued user boundary;
- a human/operator principal may answer through the normal Permission service;
- a future explicit delegated capability may authorize a bounded subset, but
  the capability must pre-exist the request and be independently verifiable.

This is the same least-authority rule as peer provenance: causality does not
create capability.

---

## 14. Model identity and selection

The host owns model availability, pricing, capabilities, variants, and the
Session's current model.

Therefore:

- delete the duplicated OpenSwarm model catalog in the native path,
- let member Session model changes remain Session truth,
- have spawn policy resolve through the host provider/model services,
- if the Swarm task requests a capability, resolve the model once through the
  canonical catalog and record the selection reason only if product UX needs it.

Do not copy the **observed current Session model** into `swarm_member` merely to
make status rendering easy. Use existing batched Session projections.

A managed worker's desired profile may contain a concrete model ref because that
is durable recreation/pinning intent. This is intentionally different from a
live mirror:

```text
member.profile.model  = desired model for managed worker creation/rebind
Session.model         = actual model of the currently bound Session
```

Explicit Swarm model-management actions update the desired profile and, when a
managed Session is bound, apply the corresponding Session model mutation. Do not
run a background "sync whatever the Session currently says back into Swarm"
loop.

If product UX allows a user to change the model directly from a managed member's
chat, that UI action should be Swarm-aware and perform one explicit profile
transition rather than relying on event sniffing/reconciliation. Coordinator or
guest Sessions that participate in several Swarms remain Session-owned and are
not pinned independently by every membership.

---

## 15. Session Groups

Session Group support is already first-party and should be reused for UI
organization.

### 15.1 Projection, not membership authority

```text
SwarmMember rows = canonical collaboration membership
SessionGroup       = navigation / presentation projection
```

Do not create bidirectional ambiguity.

The current SessionGroup implementation already demonstrates why this boundary
must be explicit: group membership has its own durable edge table, locking,
owner metadata, reconciliation, and mutation APIs. If native Swarm blindly
creates another ordinary mutable group, the same relationship would have two
authoritative mutation surfaces.

The current audit closes that choice:

> **Native Swarm membership is a virtual SessionGroup read model. Do not
> materialize `session_group_member` edges for Swarm.**

Why:

- `session_group_member` is itself a mutable ownership graph;
- `SessionTable.group_id` is only a legacy/primary-group compatibility pointer
  and cannot represent many-to-many membership faithfully;
- generic SessionGroup mutation APIs can remove edges, auto-delete empty groups,
  and rewrite the primary pointer;
- OpenSwarm already permits one coordinator Session to participate in multiple
  Swarms;
- duplicating Swarm membership into either group representation would require
  reconciliation forever.

Do not allow generic `SessionGroup.removeSession` to mutate Swarm membership.
The user-facing action must route to the Swarm domain, which can then update the
navigation projection.

### 15.2 Native virtual representation

Add an explicit output/read-model semantic:

```text
SessionGroup.Kind += "swarm"
SessionGroup.MemberOrigin += "swarm"
```

But distinguish **readable kinds** from **client-creatable/mutable kinds**.
Public generic SessionGroup create/resolve payloads must not let a caller submit
`kind:"swarm"`.

Conceptual projection:

```text
SessionGroup.Info
  id                = pure groupIDForSwarm(swarm.id)
  kind              = "swarm"
  name              = swarm.name
  ownerPlugin       = undefined
  ownerRef          = swarm.id
  anchorSessionID   = coordinator member's currently bound Session, if any
  position          = stable Swarm presentation order / creation order

SessionGroup.Member
  id                = bound member Session ID
  locked            = true
  origin            = "swarm"
  originRef         = swarm_member.id
  position          = deterministic roster order
  lightweight Session projection joined in the same bounded read
```

No `session_group` row is required for identity. No
`session_group_member` row exists. No Swarm membership writes
`SessionTable.group_id`.

The virtual group ID must be:

- deterministic from Swarm ID,
- reversible or otherwise collision-free by construction,
- a valid `SessionGroup.ID`,
- generated by one Schema helper rather than hand-built at call sites.

When native Swarm ID is defined, choose compatible opaque suffixes, e.g.:

```text
swr_<opaque>
grp_swarm_<same opaque>
```

The exact prefix is less important than one canonical pure mapping.

### 15.2.1 Composition belongs in the SessionGroup read service

SessionGroup list/detail reads become a composite projection:

```text
persisted groups
  user / subagent / plugin
        +
virtual groups
  Swarm summary + SwarmMember bindings + lightweight Session rows
        =
SessionGroup.Info / Detail[]
```

The composition must remain Tier 0/1:

- no Instance materialization,
- no Session history fetch,
- no per-member Session lookup,
- no N+1 query.

The Swarm Core service should expose a bounded navigation projection or batched
read suitable for this composition. The SessionGroup service should consume that
projection rather than reaching into Swarm tables with ad-hoc business queries.

### 15.2.2 Logical members may outlive backing Sessions

Native `swarm_member.session_id` should be nullable/rebindable. A deleted Session
must not cascade-delete the logical member.

Recommended relational behavior:

```text
swarm_member.session_id -> session.id ON DELETE SET NULL
```

or equivalent explicit Session-deletion transition if the database architecture
requires the domain event to run first.

The virtual SessionGroup contains only currently bound Sessions. A Swarm with
zero bound Sessions may disappear from Session navigation while remaining fully
visible in the first-party Swarm management surface as a recoverable/broken
collaboration.

If the coordinator Session is missing:

- `anchorSessionID` becomes absent,
- remaining bound peers can still appear as an ordinary managed container,
- rebinding the coordinator restores the structural anchor without changing
  Swarm or virtual group identity.

### 15.2.3 Multi-membership is intentional

Do not make `session_id` globally unique in `swarm_member`.

At minimum preserve the proven OpenSwarm behavior where one coordinator Session
can coordinate multiple Swarms. Prefer the more general invariant:

```text
UNIQUE (swarm_id, session_id)    # when session_id is non-null
UNIQUE (swarm_id, member_name)   # scoped human address
```

without a global one-Swarm-per-Session restriction.

The existing sidebar/titlebar already knows how to merge several managed
structural groups sharing one anchor. Extend its managed-kind predicate to
include `swarm`; do not create a parallel navigation renderer.

### 15.2.4 Mutation routing is domain-owned, not lock-owned

For a virtual `kind:"swarm"` group, generic SessionGroup mutations must not
attempt to mutate missing projection rows or rely on `locked:true` as the
security boundary.

Generic operations should be rejected/rerouted explicitly:

| Generic group action | Native Swarm behavior |
|---|---|
| rename | invoke Swarm rename from Swarm-aware UI/API |
| delete group | invoke explicit Swarm archive/delete lifecycle |
| add Session | invoke Swarm add/rebind member |
| remove Session | invoke Swarm remove/stop member policy |
| reorder members | Swarm roster presentation operation if/when supported |
| set automatic group policy | unsupported; Swarm policy owns automation |
| create/resolve `kind:"swarm"` | host-only Swarm projection; reject generic caller |

The SessionGroup service should identify virtual group IDs/kinds before touching
the persisted group tables and return a typed managed-projection error for
unsupported generic mutation.

The UI should avoid presenting misleading generic actions in the first place.

### 15.2.5 Event/cache invalidation

Do not emit a second durable SessionGroup membership timeline for virtual Swarm
groups.

Canonical Swarm events such as:

- Swarm renamed,
- member bound/unbound/added/removed,
- coordinator changed,
- Swarm archived/deleted,

invalidate both:

- Swarm read caches,
- the composite SessionGroup list/detail query.

The app currently invalidates group queries from `session_group.*` events.
Extend that cache dependency to canonical Swarm events instead of fabricating
duplicate SessionGroup events. An ephemeral compatibility notification is
acceptable only if a legacy client requires it; it is never durable authority.

### 15.3 User reordering

Initial native order should require no extra projection table:

- coordinator first when bound,
- remaining members by deterministic Swarm roster order (creation order is an
  acceptable first baseline).

If explicit member drag ordering becomes product-relevant, store that
presentation order on the canonical Swarm member/roster domain or a dedicated
UI-preference projection—never by creating shadow membership edges.

Dragging a Session out of the group must **not** silently remove it from the
Swarm unless the UI action explicitly says “remove member from swarm” and goes
through Swarm authorization.

---

## 16. Blackboard, artifacts, and the Hive layer

OpenSwarm's shared-memory ideas contain useful mechanisms, but they should not
all enter the first-party core at once.

### 16.1 Phase-one primitives

Keep:

- CAS/versioned blackboard,
- lane/path claims,
- artifact/deliverable references,
- task-linked evidence,
- search/probe over explicit collaboration records.

These have clear semantics and measurable utility.

### 16.2 Quarantine heuristic intelligence

Defer behind an experimental boundary:

- whisper/shout belief tiers,
- automatic confidence reinforcement,
- resonance,
- consolidation,
- anti-entropy belief digest,
- corpse/gold scheduler bias,
- automatic need routing based on fuzzy context match.

They may be valuable, but none should become a foundational correctness
dependency without independent benchmarks/evaluations.

### 16.3 Prefer artifact references to transcript copying

Large outputs should live in files/artifacts/shared structured state with compact
references sent between peers.

This reduces token amplification and avoids a “game of telephone” through a
coordinator.

---

## 17. Exact addressing; eliminate fuzzy authority

OpenSwarm's fuzzy reference resolution and coordinator adoption are useful UX
patches at a plugin boundary but dangerous first-party authority semantics.

Native policy:

- canonical operations use exact typed IDs,
- unique names may be accepted only after exact scoped resolution,
- ambiguous names fail,
- UI/tool error may offer non-binding “did you mean?” suggestions,
- suggestions never execute mutation,
- no fuzzy member/task/swarm binding,
- no silent coordinator adoption.

The model should learn from a precise error rather than the system guessing at a
different destructive target.

---

## 18. External guests

OpenSwarm currently auto-registers a nonmember Session as a guest when it sends a
message into a Swarm.

Do not carry that implicit mutation forward unchanged.

Preferred model:

- a nonmember sender can be represented as an external sender/address for a
  specific message, or
- joining as a guest is an explicit membership action.

Sending a message should not secretly change long-lived membership/authorization
state.

This needs a product decision before implementation.

---

## 19. Events and projections

The old plan targeted `GlobalBus` directly. Current architecture should target
the canonical EventV2/domain event path.

### 19.1 Durable semantic events

Candidate event families:

- swarm created/updated/archived,
- member added/removed/replaced,
- task created/claimed/reassigned/released/settled,
- message created,
- delivery expired/failed where those are Swarm-domain outcomes,
- blackboard changed,
- claim acquired/released,
- recovery action,
- migration/import action.

Events should be emitted at the producer transition, not synthesized by the UI.

Do not duplicate current Session input admission as a second “delivery admitted”
durable event merely for Swarm symmetry. The Session admission event is already
the authoritative event; `swarm_delivery` is the cross-domain receipt
projection.

### 19.2 Compact read models

Provide O(1) / bounded projections for dense UI:

- Swarm summary,
- active task counts,
- member count and health,
- unresolved blocker count,
- unread/recent peer-message count,
- latest activity,
- Session IDs for batched SessionTelemetry fetch.

Do not make sidebar components scan:

- Session histories,
- Swarm event logs,
- message bodies,
- task graphs.

Detail pages may explicitly request detail/history.

---

## 20. First-party tool/API surface

Tools are adapters over domain services, not the domain itself.

Preserve useful OpenSwarm ergonomics where possible:

- delegate/create,
- spawn/add member,
- message/reply,
- task list/claim/reassign/complete/fail,
- status/roster,
- blackboard/memory,
- probe/find,
- stop/remove/delete,
- release/resume collaboration hold.

But do not preserve an old tool shape if it requires architectural lying.

Examples:

- “delivery succeeded” should mean a defined durable state such as Session input
  admitted, not “provider definitely consumed it”.
- exact IDs should replace fuzzy mutation targets.
- lifecycle status should come from canonical Session/task state.

### 20.1 Principals are derived at trusted boundaries

Never accept `senderMemberID`, `actorMemberID`, host provenance, or equivalent
authority as model-supplied truth.

For an agent tool invocation the trusted principal starts with:

```text
Tool.Context
  sessionID
  messageID
  callID
```

Resolve membership from `ctx.sessionID` and the explicitly addressed Swarm.
If one Session participates in several Swarms, `swarmID` disambiguates the
domain; the service then verifies that the Session is actually bound to a member
of that Swarm.

The model may supply a **target** member/task/message ID. It never supplies its
own identity.

Public authenticated HTTP/SDK calls are an **operator principal**, not a fake
peer member. API operations must record operator authorship or invoke an
administrative domain action; they must not expose "send as arbitrary member".

Internal executors use a host/service principal and construct trusted
`SyntheticOrigin` themselves. There is no public endpoint that accepts an
arbitrary host-owned origin object.

### 20.2 Authority matrix

Initial authority contract:

| Operation | Human/operator | Coordinator member tool | Worker member tool | Host executor |
|---|---:|---:|---:|---:|
| read Swarm/roster/task/mail summaries | yes | yes | yes, same Swarm | yes |
| send/reply as peer | operator notice, not impersonation | yes | yes | host notice only |
| create task | yes | yes | policy-limited/self proposals only | recovery only |
| claim ready task | yes/admin | yes | self only | scheduler claim |
| complete/fail/release task | yes/admin | own or admin | **own active fenced lease only** | fenced recovery |
| reassign/reserve task | yes | yes | no | scheduler policy only |
| add/spawn managed member | yes | yes when Swarm policy grants | no by default | recovery/rebind only |
| remove/stop peer | yes | yes when policy grants | self-stop only | bounded recovery |
| set managed worker model/profile | yes | yes | no (unless future self-profile policy) | materialize desired profile |
| revive/rebind member Session | yes | yes when policy grants | self request only | exact recovery intent |
| answer Permission ASK with allow | **yes** | no unless explicit delegated grant | no | no |
| reject/cancel blocked delegated work | yes | yes | own work | typed recovery |
| archive Swarm | yes | yes if reversible + permitted | no | no |
| hard purge/delete durable Swarm history | **human/operator only** | no | no | no |
| emergency global stop | yes | policy-limited coordinator stop of own Swarm | self only | fail-safe stop only |

Every mutating row additionally passes normal tool/host permission policy. Domain
role is necessary but not sufficient authority.

### 20.3 Irreversible operations need real authority, not confirmation strings

OpenSwarm-style model-supplied `confirm:"DELETE"` strings do not prove human
intent. They only prove the model can copy a token.

Use:

- normal Permission/user confirmation for agent-tool initiated destructive
  actions;
- authenticated operator API/UI actions for administrative mutation;
- reversible archive/stop as the normal model-accessible lifecycle primitive;
- hard purge only behind operator authority.

### 20.4 External guests and cross-Swarm messaging

Delete silent guest auto-registration and `force:true` authority bypasses.

Rules:

1. if the calling Session is already a member of the target Swarm, normal
   same-Swarm messaging applies;
2. if the Session belongs to several Swarms, the explicit target Swarm selects
   which membership is acting;
3. if it is not a member, the call fails unless there is an explicit guest/join
   grant or bridge capability;
4. cross-Swarm communication never pretends the sender belongs to the
   destination Swarm.

If external-participant/cross-Swarm messaging remains a product requirement,
introduce an explicit attenuated grant rather than a boolean bypass:

```ts
type SwarmGrant = {
  subject: Session.ID | SwarmMember.ID
  swarmID: Swarm.ID
  scopes: readonly SwarmScope[]
  expiresAt?: number
  issuer: OperatorRef | SwarmMember.ID
  parentGrant?: SwarmGrant.ID
}
```

Delegated grants may only narrow scopes/lifetime. This is capability attenuation,
not causal-message inheritance. Do not make `SwarmGrant` a Phase-1 requirement
unless guest/cross-Swarm behavior is included in the first milestone.

### 20.5 API ownership tiers

Split routes by actual ownership, following the ScheduledTask precedent:

```text
Tier 0/1 — durable/global
  list/get Swarms
  task/message/blackboard reads
  create/archive/update durable Swarm intent
  task graph mutations
  CAS blackboard

Tier 2 — explicit LocationProfileResolver
  validate member profile
  create/update managed worker desired profile
  create/rebind root Session identity after profile validation

Tier 3 — runtime
  wake/execute Session
  live recovery action that truly needs runtime
```

An operation such as `delegate` may orchestrate Tier 1 + Tier 2 work in one
service workflow and then enqueue/wake Tier 3 execution asynchronously. The
public request must not block on provider generation.

---

## 21. What to reuse, rewrite, or delete

| OpenSwarm area | Native disposition | Reason |
|---|---|---|
| User-visible root-member model | **Preserve** | Core product differentiator |
| P2P message kinds/threading | **Preserve semantics; redesign storage/transport** | Good interaction model, wrong plugin transport |
| DAG / dependency rules | **Preserve invariants; rewrite implementation** | Valuable behavior; optimize around host DB/events |
| Atomic task claims / leases | **Preserve concept and tests** | Correct concurrency primitive |
| Blackboard CAS | **Preserve** | Clean shared-state primitive |
| Path/lane claims | **Preserve, advisory** | Useful anti-collision signal |
| Handoff/artifact ledger | **Preserve concept** | Avoid transcript-only coordination |
| `plugin.ts` runtime | **Delete** | Omnibus duplicate runtime |
| HTTP runtime adapter | **Delete** | First-party code calls services directly |
| SQLiteStore runtime | **Delete after importer** | Host DB is authority |
| ChunkDbStore runtime | **Delete after importer** | No second runtime store |
| Broker prompt transport | **Replace with SessionInput** | Host already owns durable input |
| pending-mail polling/sweep | **Delete** | SessionInput + event/lease runner |
| SSE self-subscription | **Delete** | Direct EventV2 consumption |
| permission polling/backstops | **Delete** | Consume canonical host state |
| duplicated model catalog | **Delete** | Host provider catalog |
| fuzzy self-heal/adoption | **Delete** | Typed IDs + exact authority |
| human-chat prefix sniffing | **Delete** | Provenance / producer-owned projection |
| title emoji identity | **Delete as authority** | UI projection only |
| broad 10s omnibus sweep | **Delete** | Event-driven + earliest-due timer |
| watchdog transcript scans | **Delete/reduce** | Session status/telemetry |
| NoticeAggregator mechanics | **Re-specify** | Prefer durable/coalesced semantic events |
| Hive belief algorithms | **Experimental / evaluate** | Not foundational correctness |
| tests/docs | **Mine aggressively** | Best record of hard-won behavior |

---

## 22. Performance doctrine

Performance is part of the architecture, not a later cleanup.

### 22.1 Idle cost target

With zero active Swarms:

- no periodic Swarm polling,
- no Session-history scans,
- no additional SSE loop,
- no per-Swarm timers,
- no extra DB connection,
- no duplicated model/permission reconciliation.

### 22.2 Scaling targets

Cost should scale primarily with:

- changed tasks,
- messages actually sent,
- due leases,
- active Sessions.

It should not scale every N seconds with:

```text
all swarms × all members × all tasks × all messages
```

### 22.3 DB shape

Use narrow indexed queries and conditional updates.

Never hold a DB transaction open across:

- provider calls,
- filesystem/network work,
- Session execution.

### 22.4 Prompt/token cost

Peer messages should be compact and structured.

Do not continuously inject full:

- roster,
- task graph,
- blackboard,
- peer histories,
- hive state.

Use refs + query tools/projections when details are needed.

### 22.5 Cache behavior

Do not preserve plugin-era cache assumptions as architecture folklore.

Benchmark current OpenFork with native root member Sessions and measure:

- cache read ratio,
- fresh input tokens,
- prompt-prefix churn,
- effect of peer-message steer vs queue,
- cost of shared system/doctrine prefixes,
- compaction behavior.

Only then freeze cache-specific optimizations.

---

## 23. Concurrency / failure invariants

The native implementation should be designed around explicit invariants:

1. One Swarm member row identifies one logical peer membership.
2. One task generation has at most one active owner.
3. A stale task generation cannot settle a newer assignment.
4. One logical peer message exists once.
5. One broadcast snapshots each recipient at most once.
6. One delivery maps to one deterministic Session input identity.
7. Retrying delivery cannot duplicate an equivalent Session input.
8. User-owned input cannot be manufactured by peer/host machinery.
9. Peer input cannot widen permissions.
10. Session deletion cannot silently retarget membership.
11. No fuzzy lookup is allowed to authorize mutation.
12. Runtime fiber death cannot erase durable task/message intent.
13. A timer firing twice cannot create two provider starts for one claim.
14. Multiple OpenFork processes must race through DB admission/lease CAS, not
    through in-memory “is running” flags.

---

## 24. Test migration strategy

Do **not** port the 800+ OpenSwarm unit-test declarations mechanically.

Classify each test into one of five buckets:

### A. Product behavior contract

Port the behavior.

Examples:

- peer messaging,
- direct member chats,
- DAG dependencies,
- reassignment invalidates old authority,
- blackboard CAS,
- remove/delete authorization.

### B. Domain concurrency invariant

Re-express against the new DB/domain layer.

Examples:

- racing claims,
- stale leases,
- duplicate delivery retry,
- concurrent reassign/complete,
- crash between Swarm delivery write and SessionInput admission.

### C. Plugin workaround regression

Delete after proving the workaround no longer exists.

Examples:

- prefix-based self-injection recognition,
- self-SSE reconnect,
- V1/V2 permission polling fallbacks,
- title emoji identity,
- runtime HTTP adapter behavior.

### D. Behavior made impossible by host invariant

Replace with an integration proof at the lower host layer.

Example:

- duplicate prompt admission should be proven by SessionInput idempotency rather
  than a custom Swarm broker lock.

### E. Questionable product behavior

Do not silently preserve.

Examples:

- fuzzy target auto-correction,
- coordinator auto-adoption,
- implicit guest registration,
- heuristic Hive scheduler bias.

These require an explicit design decision.

### 24.1 Concrete preservation ledger from the current test corpus

The current tests are valuable archaeology. Their names/comments often document
bugs that took multiple iterations to discover. Preserve the **invariant** when
it is real, not the plugin mechanism that happened to enforce it.

#### KEEP — native product/domain contract

| Existing test family / examples | Native contract to preserve |
|---|---|
| `core.test`, `tools.test` root member/spawn cases | A Swarm peer is backed by a stable root Session that the user can open directly. |
| `messaging.test`, `cross-swarm.test`, `messaging-guards.test` | Direct and broadcast addressing are explicit; self-send is guarded; recipient set is deterministic; replies retain correlation. |
| `dag.test` | Dependencies are acyclic and readiness is deterministic from dependency settlement. |
| `core.test`: atomic spawn claim; `scheduler-bundle.test`: no second active task | One task generation has one owner and one member cannot silently strand an earlier owned task by accepting another. |
| `tools.test`: reassign then old owner complete rejected | Reassignment invalidates stale settlement authority. |
| `reservation.test`, `scheduler-stickiness.test` | Explicit intended-owner/reassignment intent is durable and cannot be silently stolen by opportunistic affinity while valid. |
| `leases-retries.test`, `scheduler-watchdog-budget.test` | Leases expire deterministically; genuine task failure and infrastructure/runtime recovery are different retry-accounting causes. |
| `subscriptions.test`: session deletion releases task | Deleting a member Session cannot leave an owned task permanently stranded. |
| `subscriptions.test`: late idle never resurrects stopped/failed/interrupted | A late runtime event cannot reverse a stronger terminal/operator lifecycle transition. |
| `store.test`: terminal delivery cannot resurrect | Expired/failed collaboration delivery is monotonic unless an explicit new delivery is created. |
| `core.test`, `store.test`, `contracts.test` blackboard CAS | Shared-state overwrite is version/CAS controlled; no silent last-writer-wins where a versioned contract is promised. |
| `wip-aura.test` active path claims | If path/lane claims ship, claim identity/TTL/release semantics are explicit and deterministic. |
| `tools.test` lifecycle controls | Destructive stop/remove/delete/reassign operations have explicit authorization and confirmation boundaries. |
| `cross-swarm-status.test`, stale-binding tests | A member/task identity from Swarm A cannot mutate Swarm B merely because IDs or cached state are stale. |

These tests should be rewritten against Core/Session services and database
constraints, not through tool strings or a fake HTTP runtime.

#### KEEP THE UX/SAFETY INTENT — replace the mechanism

| Existing family | Preserve | Replace |
|---|---|---|
| `humanchat.test` | Human direct chat makes autonomous Swarm machinery yield for the configured policy window. | Self-injection ID sets, text prefixes, per-member `humanChatAt` mirrors → latest semantic User admission in SessionInput + optimistic sequence fence + safe task retirement barrier. |
| `delivery-audit.test`, `messaging.test` | A logical delivery has observable pending/admitted/failed/expired state and retry is idempotent. | `promptAsync` success + broker scheduled/delivered repair → typed SessionInput admission + atomic receipt projection. |
| `subscriptions.test`, `failure-detection.test`, `stalls.test` | Operator abort, provider retry, hard execution failure, missing Session, lease expiry, and permission wait are distinct causes. | Regex/status reconstruction and broad supervisor sweep → canonical Session/Permission/Telemetry events + small typed recovery state machine. |
| `permission-wall-*`, `permissions-escalation.test` | A blocked permission is visible/actionable and peer orchestration cannot silently widen authority. | V1/V2 interception, polling, mirrored pending rows → canonical Permission domain state/events. |
| `autopermissions.test` | Derived member policy must never exceed the authority explicitly allowed by host/user policy. | Plugin copying/clamping of external rulesets → normal Session/Agent permission derivation. |
| `model-selection.test`, `model-management.test`, `model-variant.test` | Explicit spawn/model intent and variants should resolve truthfully and Session model changes should take effect. | Swarm model mirror/catalog/family heuristics → host Catalog/Model/Session services. |
| `session-groups.test` | Swarm Sessions appear together and remain navigable. | Plugin capability negotiation/owned group membership → first-party Swarm projection. |
| `notice-aggregator.test`, `notices*.test` | Burst/churn notifications should be low-noise, bounded, and truthful. | Plugin prompt-mail debounce as state authority → compact domain event projection/digest. |
| `deliverables.test` | Handoffs/artifacts have stable authorship, task refs, and review status where enabled. | Prompt-only handoff convention → first-class artifact/deliverable records plus compact peer refs. |

#### DELETE AFTER LOWER-LAYER PROOF — plugin boundary workarounds

The following are not native feature requirements:

- `humanchat.test` self-injection ID registry and known-text-prefix
  classification;
- `scheduler-bundle.test` requirement that an assignment prompt literally
  starts with `You are \`` so the classifier does not think it is human;
- `runtime.test` structural SDK/HTTP adapter mapping;
- `transport-resilience.test` retry/error recognition for the plugin calling
  back into its own host transport;
- `probe-compat.test` “Case A/B/C” feature probing;
- V1-vs-V2 permission endpoint routing/polling backstops in
  `permission-lifecycle.test`;
- plugin SessionGroup capabilities-route fallback/ownership negotiation;
- duplicated SQLite-vs-ChunkDB runtime parity tests after the one-time importer
  is proven;
- plugin schema-copy drift tests once there is one canonical host schema;
- model-family fuzzy resolver/cache tests whose responsibility already belongs
  to the host catalog;
- recovery tests whose only purpose is reconciling a duplicated
  `SwarmMember.status/model` mirror with Session truth.

Where one of these tests currently hides a real safety invariant, create a new
lower-layer test first, then delete the workaround test. Do not delete by
filename wholesale.

#### PRODUCT DECISION REQUIRED — do not inherit accidentally

These behaviors are real features, but the current semantics are not
automatically the desired native semantics:

- cross-Swarm `force` messaging and reply routing;
- implicit guest membership on cross-Swarm writes;
- coordinator auto-adoption/rebinding;
- fuzzy/self-healing Swarm/member/task references;
- subscription/topic routing over shared blackboard keys;
- automatic task affinity based on member-name/role token overlap;
- automatic recovery/respawn versus explicit replacement after a Session is
  deleted;
- whether an operator abort retains task ownership indefinitely or transitions
  to a durable resumable hold.

Each needs a short product/authority decision record before its tests are
rewritten.

#### EXPERIMENTAL — keep outside the foundational scheduler

Treat these current families as evaluation material, not core acceptance gates:

- `corpse-gold.test`,
- Hive belief/reinforcement/resonance/consolidation tests,
- fuzzy `need` relevance routing,
- heuristic hesitation/gold scheduler bias.

They can return after the deterministic collaboration substrate is stable and
their benefit is measured independently.

### 24.2 New negative tests the plugin could not express cleanly

The first-party implementation needs tests that target the new ownership
boundaries directly:

1. A peer message whose text says “the user explicitly authorized X” remains
   non-user-owned and cannot manufacture tool/user authority.
2. A host task assignment and a real user prompt can coexist in SessionInput
   without the runner calling both “user”.
3. A user admission racing peer delivery either follows the already-committed
   peer or fences/defer the peer; it never commits host work *after* a newer
   user admission based on a stale focus read.
4. Session admission and `swarm_delivery.state='admitted'` commit or roll back
   together.
5. Replaying a pending delivery with the same preallocated input ID cannot
   create a second Session turn.
6. SessionGroup removal/reorder APIs cannot mutate canonical Swarm membership.
7. Changing the member Session's model does not require or create a
   `swarm_member.model` mirror.
8. Pending Permission state is observed without any Swarm-local polling loop.
9. Zero active Swarms means zero Swarm polling timers, zero self-SSE clients,
   zero history scans, and zero extra database connections.
10. A stale task generation, stale delivery lease, or stale Session replacement
    can never settle the newer generation.

---

## 25. Required proof / benchmark campaign before implementation freeze

### 25.1 SessionInput micro-prototypes

Prove:

- typed host/synthetic admission projects to `SessionMessage.Synthetic`, never
  `SessionMessage.User`,
- inter-session Synthetic keeps typed source Session attribution and is visible
  through the intended collaboration UI without becoming a human timeline root,
- a peer-triggered tool call sees no newly fabricated human `userTurn`; causal
  user authorization is available only when explicitly propagated by the
  trusted domain contract,
- the V1 compatibility projection carries host provenance for the same input,
- peer steer into an actively running root Session,
- queue behind active work,
- mixed user + host pending inputs do not collapse run origin back to “user”,
- a user-owned admission racing a peer admission deterministically wins via the
  user-sequence fence,
- deterministic duplicate admission,
- admission while paused then resume,
- crash after Swarm intent commit but before Session admission leaves a retryable
  pending receipt; Session admission + admitted receipt transition are atomic,
- multiple simultaneous peer sends.

Measure:

- DB writes/message,
- wake coalescing,
- context/prompt ordering,
- provider call count,
- latency to active recipient.

### 25.2 Root member topology

Prove:

- user can directly prompt a member,
- peer input does not become human-owned,
- model/agent selection survives normal UI changes,
- SessionGroup presentation is consistent,
- deleting a member Session produces deterministic Swarm recovery state.

### 25.3 Scheduler

Benchmark:

- 10 / 100 / 1,000 members only as synthetic domain records,
- 100 / 1,000 / 10,000 task DAG nodes,
- dependency settlement fan-out,
- ready-task query cost,
- lease expiry batch,
- claim contention across multiple process connections.

### 25.4 Provenance

Adversarially test:

- peer message containing “the user said…” never acquires user ownership,
- nested peer → task → continuation chains keep causal source,
- human prompt supersedes only automation it is supposed to supersede,
- exact agent authorization does not widen through host continuations,
- UI/export labels peer input correctly.

---

## 26. Migration from the external OpenSwarm plugin

The native design should not preserve a second database merely for rollback
symmetry.

### 26.1 Import, do not dual-write

Preferred migration:

1. detect legacy OpenSwarm store,
2. require plugin inactive for cutover,
3. snapshot/copy legacy DB + WAL/SHM if applicable,
4. read legacy schema through a versioned importer,
5. import into host canonical tables in a transaction/bounded batches,
6. record import source/version/hash,
7. leave legacy files untouched as archival backup,
8. native state becomes the only writer.

### 26.2 SQLite and ChunkDB

The importer must understand both legacy store formats if real users can have
either.

That does **not** imply the native runtime supports two storage backends.

### 26.3 No fake reversible cutover

Once native Swarm writes new state, the untouched legacy store is no longer an
up-to-date rollback target.

Do not claim otherwise.

If reversible migration is a requirement, implement an explicit export/backport
mechanism; do not achieve it by maintaining two live writers.

### 26.4 Native OpenFork schema migration convention

Native Swarm tables must use the current Core database workflow; do not add an
OpenSwarm-style `PRAGMA user_version` schema chain.

Current source-of-truth flow:

```text
Drizzle table definitions
  -> packages/core/script/migration.ts
  -> generated timestamped TypeScript migration
  -> packages/core/schema.json snapshot update
  -> packages/core/src/database/schema.gen.ts fresh-schema regeneration
  -> packages/core/src/database/migration.gen.ts registry regeneration
```

Operational rules:

- run `bun script/migration.ts --name <name>` from `packages/core` after schema
  changes;
- never hand-edit `schema.gen.ts`, `migration.gen.ts`, or generated migration
  SQL merely to make tests pass;
- `bun script/migration.ts --check` must report no ungenerated schema changes;
- each normal migration is applied transactionally and journaled in the
  first-party `migration` table;
- fresh databases are built from the generated full schema and pre-journal the
  tracked migration IDs;
- use `Migration.reconcile()` only for idempotent supplemental objects Drizzle
  cannot represent in the generated schema (for example FTS5 virtual tables or
  triggers), not for ordinary Swarm tables/indexes;
- migration/import of the **legacy OpenSwarm store** is a separate data-migration
  concern and must not be confused with native host-schema migration.

The existing migration tests also assert important hot-path index presence.
Swarm should add equivalent schema/index assertions for ready-task, due-lease,
pending-delivery, and summary queries once those tables exist.

---

## 27. Phased implementation plan

This section records the implementation sequence that was used. The blocking
data/provenance and SessionInput proofs are now implemented and certified; live
source plus `06-implementation-roadmap-v2.md` carries current closure evidence.

### Phase 0 — architecture proofs

- finish current provenance audit,
- design/prove generalized typed SessionInput admission,
- remove the runner's implicit “all SessionInput == user work” assumption,
- SessionInput peer-delivery micro-prototypes,
- define root-member Session semantics,
- classify OpenSwarm tests/behaviors,
- benchmark DAG/query options,
- decide guest behavior,
- decide `steer`/queue policy,
- freeze first-party contracts.

### Phase 1 — domain contracts and persistence

- Schema IDs/entities/events,
- Core Swarm/member/task/mail/receipt/blackboard tables,
- typed errors,
- DB constraints/CAS,
- compact projections,
- no runtime execution yet.

### Phase 2 — Session execution bridge

- create root member Sessions,
- deterministic host-owned SessionInput admission,
- provenance/correlation,
- SessionGroup projection,
- basic direct peer message proof.

### Phase 3 — tasks and orchestration

- DAG,
- claim/reassign/settle,
- task assignment through SessionInput,
- lease runner using event-driven + earliest due timer,
- recovery.

### Phase 4 — first-party tool/API/UI parity

- thin tools/routes,
- member/session navigation,
- roster/status projections,
- direct human chat UX,
- pause/focus states,
- peer-message UI.

**Current status (2026-09-19): closed.** Native Tier-0 API/generated SDK,
lazy model tool, virtual Swarm SessionGroups, control panel, SessionTelemetry
overlays, operator mutations, and source-aware Swarm timeline provenance are
implemented and covered by the Phase-4 certification matrix in
`06-implementation-roadmap-v2.md`.

### Phase 5 — shared artifacts/memory

- blackboard,
- lane/path claims,
- deliverables/artifact refs,
- probe/find backed by explicit state/search.

### Phase 6 — legacy import

- SQLite/ChunkDB fixtures,
- dry-run inventory,
- migration,
- plugin conflict detection,
- cutover docs.

### Phase 7 — experimental Hive

Only after measurement:

- beliefs,
- reinforcement,
- relevance routing,
- resonance,
- consolidation,
- scheduler advisory signals.

---

## 28. Architecture gates before any implementation PR

The implementation should not start until these statements can be answered
precisely:

- What is canonical Swarm membership?
- What is canonical Session identity for a member?
- What state belongs to Session vs Swarm?
- How does one peer message become one idempotent Session input?
- Which message kinds steer vs queue?
- How is peer authorship represented without granting user authority?
- How is the causal human root preserved?
- What exact DB transition owns task claim and settlement authority?
- What survives process death?
- What does the earliest-due runner own?
- How are multiple processes prevented from duplicating provider work?
- How does a user direct-chat hold affect scheduling without abusing pause?
- How does SessionGroup mirror membership without becoming another authority?
- Which OpenSwarm behaviors are preserved, intentionally changed, or deleted?

If an implementation PR cannot point to the producer/source-of-truth for one of
these facts, it is not ready.

### 28.1 Phase-0 closure status, updated 2026-09-19

Closed by current-code inspection:

- root member topology: root Session, never TaskTool child/special agent;
- current durable admission substrate: `SessionInput` + `SessionExecution`;
- V1 host admission: useful compatibility seam, **not** the target semantic API;
- current message semantic target: `Synthetic` + typed origin for peer/host
  inputs;
- runner bug to remove before reuse: pending SessionInput must no longer imply
  user-owned work;
- delivery crash boundary: recipient Session admission + admitted receipt can be
  one local EventV2 transaction via the durable publish `commit` hook;
- user-vs-peer race strategy: user-owned admitted-sequence fence;
- SessionGroup authority: projection only;
- first-party SessionGroup `kind:"swarm"`: virtual, read-only, many-to-many
  projection over native Swarm membership;
- public surface: bounded Tier-0 HTTP/generated-SDK reads and authenticated
  operator mutations; member-authored mail/claims/deliverables remain
  member-authored domain operations;
- TaskTool exact agent authorization already uses `authorizedAgentNames`;
- Core database migration/generation convention.

Remaining research/product decisions do not block the implemented native
foundation:

- exact Schema shape/name for `SessionInput.Item` / `SyntheticOrigin`;
- exact Goal automation API after separating reservation origin from input
  ownership;
- legacy SQLite/ChunkDB importer support matrix based on real deployed stores;
- final product decisions for cross-Swarm force messaging, guests, abort/hold
  policy, subscriptions, and any affinity heuristics;
- benchmark budgets and the Phase-0 micro-prototypes in §25.

---

## 29. External architecture research — design implications

The following systems were used as comparative architecture, not as APIs to
copy.

### Microsoft AutoGen Core

References:

- https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/framework/agent-and-agent-runtime.html
- https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/framework/message-and-communication.html
- https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/core-concepts/agent-identity-and-lifecycle.html

Useful principle:

- stable agent identity is an address,
- the runtime owns execution/lifecycle,
- messages are data,
- direct and broadcast communication are distinct primitives.

OpenFork already has the runtime and durable address: Session. Swarm should add
collaboration semantics around it, not create a second agent runtime.

### Dapr virtual actors

References:

- https://docs.dapr.io/developing-applications/building-blocks/actors/actors-features-concepts/
- https://docs.dapr.io/developing-applications/building-blocks/actors/actors-timers-reminders/

Useful principle:

- serialize work per logical actor,
- distinguish lightweight live timers from durable reminders.

OpenFork Session execution already serializes turns; Swarm leases/reminders must
be durable while wake fibers/timers remain disposable.

### AWS transactional outbox guidance

Reference:

- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html

Useful principle:

- avoid dual-write ambiguity,
- preserve ordering,
- consumers must be idempotent because retries/duplicates exist at boundaries.

The native shared host DB plus deterministic SessionInput ID allows Swarm
delivery to use a much stronger local transaction/idempotency design than the
external plugin.

### Anthropic multi-agent research system

Reference:

- https://www.anthropic.com/engineering/multi-agent-research-system

Useful observations:

- parallel agents need precise task boundaries to avoid duplicate work,
- asynchronous coordination improves flexibility but increases state/error
  complexity,
- persistent artifacts reduce “game of telephone” and token overhead.

This supports explicit tasks/claims and artifact references rather than making
peer chat the only coordination substrate.

### OpenAI Agents SDK

References:

- https://openai.github.io/openai-agents-python/
- https://openai.github.io/openai-agents-python/multi_agent/

Useful principle:

- keep orchestration primitives few,
- distinguish manager-owned subagent work from handoff/conversation ownership,
- tracing should reflect logical workflow structure rather than hidden runtime
  heuristics.

OpenFork's TaskTool maps naturally to manager-owned subagent work. Swarm is a
different topology: multiple durable user-addressable Sessions coordinated by a
collaboration aggregate.

### Claude Code subagents / agent teams

References:

- https://www.anthropic.com/engineering/building-c-compiler
- https://resources.anthropic.com/hubfs/Claude%20Code%20Advanced%20Patterns_%20Subagents%2C%20MCP%2C%20and%20Scaling%20to%20Real%20Codebases.pdf
- https://www.anthropic.com/engineering/claude-code-auto-mode

Useful validation:

- Anthropic's current agent-team work uses multiple Claude Code Sessions in
  parallel on a shared codebase; their training material describes agent teams
  as teams of Claude Code Sessions rather than one hidden subagent tree.
- Their security writeup explicitly identifies a delegation-authority hazard:
  inside a subagent, the orchestrator's instruction appears as the subagent's
  user message, so they perform an outbound handoff check while the delegation
  is still recognizable as an agent choice rather than user intent.

OpenFork should solve the underlying semantic problem structurally:

- TaskTool delegation remains host-owned even if the child provider receives it
  as a user-role turn.
- Swarm peer delivery remains peer/host-owned even if the recipient provider
  receives it as a user-role turn.
- causal user authority is explicit data, not reconstructed from the receiving
  model's local role vocabulary.

---

## 30. Current conclusion

The first-party port should preserve OpenSwarm's **behavioral invention** while
discarding most of its **runtime invention**.

The most powerful architecture is not:

```text
OpenSwarm plugin -> copy into packages/opencode
```

and not:

```text
TaskTool + swarm flags
```

It is:

```text
                    OpenFork Session
        (identity + transcript + input + execution)
                         |
        +----------------+----------------+
        |                                 |
 parent-owned child                addressable root peer
        |                                 |
     TaskTool                       SwarmMember
                                          |
                                 durable Swarm domain
                          tasks + mail + receipts + memory
```

This gives us one Session runtime, one storage system, one event system, one
permission system, one model system, explicit provenance, and a first-class P2P
collaboration layer.

That is the architecture the implementation phase should optimize around.

