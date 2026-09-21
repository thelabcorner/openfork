# OpenSwarm -> OpenFork: first-party redesign architecture

**Status:** EARLIER SEPTEMBER SYNTHESIS — subordinate to
`00-first-party-overhaul-2026-09-18.md`  
**Date:** 2026-09-18  
**Scope:** first-party Swarm architecture only; no implementation in this campaign phase  
**Repositories audited:** `/openswarm`, `/webstormprojects/opencode`

> **Supersession note (2026-09-18):** the later overhaul document is the single
> architecture source of truth. In particular it supersedes this draft's
> SessionPrompt-centric host-admission wording with generalized current
> `SessionInput`, atomic Session-admission/Swarm-receipt settlement, and the
> user-admission sequence fence.

---

## 0. Executive decision

The correct project is not “port OpenSwarm into OpenFork.”

The correct project is:

> **Define the smallest first-party Swarm domain that OpenFork should own, then re-express
> OpenSwarm's proven product behavior on top of OpenFork's existing durable state, session runtime,
> event, provenance, permission, grouping, and UI projection architecture.**

OpenSwarm proved several valuable interaction models. Its plugin mechanics, however, compensate for
being outside the host. Making those mechanics first-party would fossilize the plugin boundary
inside OpenFork.

The architecture therefore uses a strict rule:

> **Behavior is the compatibility target. Plugin implementation structure is not.**

The existing `packages/opencode/src/tool/swarm/` prototype is also not a valid base. It currently
places domain/recovery logic in the tool layer, defines a local pseudo-store interface, and is not
wired into the normal ToolRegistry. When implementation begins, it should be removed or replaced
wholesale after its useful UX strings/tests have been harvested.

No Swarm production code is changed by this document.

---

## 1. Governing OpenFork architecture

The current repository rules imply a bottom-up design order:

1. authoritative durable producer/store;
2. service owner and lifetime;
3. ownership tier;
4. durable event/projection;
5. narrow runtime execution seam;
6. server/tool transport;
7. UI.

Consumer-first reconstruction is explicitly rejected. A Swarm sidebar must not reconstruct member
status by loading session histories. A scheduler must not infer user intervention from text. A tool
must not become the owner of task state merely because it is where an LLM asks for a task.

### 1.1 Ownership tiers

Swarm spans several tiers and must keep them separate:

| Operation | Tier | Rule |
|---|---:|---|
| list/get/create/update/archive Swarms | 0/1 | durable catalog/location state; no Instance materialization |
| task graph mutation, mailbox enqueue, blackboard CAS | 0/1 | database-owned domain transitions |
| summary counts / UI projections | 0 | compact indexed state; no histories |
| model/agent capability lookup | 2 | reuse existing provider/agent catalogs |
| create/rebind a member Session | 3 | runtime executor only |
| admit a host-authored member turn | 3 | runtime executor only |
| execute an agent turn | 3 | existing Session runtime owns it |

**Negative invariant:** listing 1,000 Swarms or drawing a sidebar may not load one project Instance.

### 1.2 Reuse the ScheduledTask pattern, not its tables

ScheduledTask now contains the strongest nearby first-party architectural precedent:

`durable spec -> materialized cursor -> one owner -> CAS lease -> Tier 3 executor -> run row -> compact EventV2 projection`.

Swarm should reuse that *shape*:

`durable graph/mailbox -> indexed runnable state -> bounded dispatcher -> CAS lease/claim ->
Tier 3 Session admission -> append-only run/delivery outcome -> compact projection`.

It should not depend on ScheduledTask tables or Goal tables.

### 1.3 `task.ts` is a reference, not the Swarm runtime

`packages/opencode/src/tool/task.ts` is valuable evidence for:

- Session creation;
- delegated permission derivation;
- background/foreground run semantics;
- cancellation;
- result injection;
- reuse of one child Session.

Swarm is not a TaskTool mode. Swarm members have different topology and lifetime: they are durable,
peer-addressable, user-openable Sessions participating in a persistent coordination domain.

If Swarm and Task reveal a genuinely generic primitive (for example delegated-session permission
derivation or host-turn admission), extract that primitive into the Session/agent runtime layer.
Do not make Swarm call TaskTool and do not make TaskTool own Swarm state.

---

## 2. What OpenSwarm actually proved

The following are product semantics worth carrying forward:

- members are real chats a user can open and speak to;
- member identity is stable across runtime/session recovery;
- a coordinator can delegate bounded work to peers;
- peers can communicate directly instead of routing every fact through the coordinator;
- task dependencies, atomic ownership, retries, and explicit reassignment matter;
- mail must survive restart and expose truthful delivery outcomes;
- direct user interaction takes priority over automation;
- operator stop/pause is authority, not noise to “self-heal” around;
- peer-authored content is untrusted and must stay fenced;
- a CAS blackboard is useful shared coordination state;
- explicit lane/path claims reduce duplicate work;
- handoffs/deliverables benefit from durable references and verdicts;
- grouping member Sessions under a stable Swarm identity is valuable UX.

Those are the compatibility targets.

The following plugin-era mechanics are not compatibility targets:

- the plugin singleton runtime;
- its second SQLite/ChunkDB state universe;
- the 10-second full-system sweep;
- per-swarm/per-member timer and dedup maps;
- SSE subscription to the host's own server;
- permission polling backstops;
- title/prefix/message-ID heuristics used to distinguish human and host turns;
- fuzzy “self-heal” that can mutate ownership;
- duplicate model catalog/pricing logic;
- a shadow pending-permission store;
- a duplicate `swarm_event` timeline beside EventV2;
- local “anti-entropy” over a database that is already the one canonical copy.

---

## 3. Target package ownership

The durable domain belongs below tools and UI.

### 3.1 `packages/schema`

Browser-safe contracts only:

- branded Swarm/member/task/message/delivery/run IDs;
- public entity/snapshot schemas;
- compact event payloads;
- policy/config wire shapes where genuinely public;
- SessionGroup extensions needed to represent first-party Swarms;
- new trusted V1 provenance source constants while V1 compatibility remains.

No runtime services, database calls, or scheduling behavior.

### 3.2 `packages/core/src/swarm/`

Own durable Swarm semantics and tables:

- Swarm catalog/specification;
- membership identity and desired control state;
- task graph and dependency invariants;
- task leases/runs/fencing generations;
- message envelope and recipient-delivery state;
- blackboard/CAS coordination;
- lane/path claims;
- optional deliverable ledger;
- durable domain events + compact projections;
- pure DAG/candidate/routing functions;
- bounded recovery queries.

Core is the authority because these facts outlive any particular OpenCode Instance.

### 3.3 `packages/opencode/src/swarm/`

Own only runtime integration that actually requires OpenCode execution services:

- member Session create/rebind;
- SessionGroup projection synchronization;
- delegated permission derivation/application;
- model/agent runtime resolution at the moment it is needed;
- current typed host/synthetic admission through generalized SessionInput +
  SessionExecution (V1 SessionPrompt remains a compatibility/reference path);
- settlement back into Core as values;
- typed observation of Session lifecycle events.

This layer must not grow a second database or mirror Session status.

### 3.4 Tools/routes/UI

Tools are thin adapters. Routes are thin adapters. UI consumes compact projections.

If a tool contains a scheduler, recovery policy, membership state machine, fuzzy identity mutation,
or database abstraction, the architecture has regressed.

---

## 4. Durable data model

Do **not** clone OpenSwarm's tables one-for-one. Each native row should exist because it has a unique
writer, lifetime, or failure meaning.

### 4.1 `swarm` — durable specification

Suggested responsibilities:

- stable Swarm ID;
- project/location identity;
- human name;
- coordinator member ID / presentation anchor;
- lifecycle (`active | paused | completed | archived`, exact taxonomy TBD);
- revision for optimistic mutation;
- explicit policy;
- timestamps;
- compact materialized summary fields only where they eliminate dense-UI work.

Do not store runtime busy/idle truth here.

### 4.2 `swarm_member` — stable logical identity

Suggested responsibilities:

- stable member ID;
- Swarm ID;
- name/role/declared capabilities;
- current backing Session ID, nullable/rebindable;
- desired control state such as `active | paused | stopped`;
- optional **model policy**, not a duplicate of the Session's actual current model;
- timestamps.

Do not persist `working`, `idle`, provider retry state, or live model as independent truth when
SessionStatus/SessionTelemetry/Session already own those facts.

### 4.3 `swarm_task` — graph node/specification

Suggested fields:

- task ID / Swarm ID;
- title/description/acceptance criteria;
- priority;
- explicit scopes (workspace paths/areas) and capability requirements;
- durable state;
- `unmet_dependency_count`;
- `ready_at`;
- preferred/reserved member identity and expiry if product semantics require it;
- retry policy counters that describe *task* attempts, not transport failures;
- revision/timestamps.

### 4.4 `swarm_task_dependency`

Edges are authoritative. Insert/edit validates acyclicity.

Default dependency semantics should be explicit:

- predecessor **success/completion** satisfies the edge;
- predecessor failure/cancellation blocks or propagates failure by policy;
- an optional edge policy can allow failure if a workflow explicitly wants “run anyway”.

OpenSwarm currently treats completed/failed/cancelled predecessors as equivalent in readiness
recomputation. Native Swarm must not inherit that ambiguity.

### 4.5 `swarm_task_lease` — active ownership

Separate operational ownership from task specification.

Suggested identity/invariants:

- one active lease per task;
- one active task lease per member/session by default;
- lease ID/generation is an unforgeable fencing token;
- member ID, Session ID, task ID, acquired/heartbeat/expiry;
- owner process/runtime identity only if required for crash reasoning.

Every completion/release/reassign path must validate the current lease generation. A late response
from a stale Session must be unable to complete a task that has already been reassigned.

### 4.6 `swarm_task_run` — append-only attempt trace

One row per admitted assignment attempt:

- run ID;
- task/member/session;
- lease generation;
- causal turn/message references;
- start/admit/settle timestamps;
- outcome/error classification;
- output/deliverable references, not copied giant bodies.

This is the Swarm-level analogue of trace/task spans. It answers “what happened?” without making
the current task row an audit log.

### 4.7 `swarm_message` + `swarm_message_delivery`

Normalize logical message from delivery:

`swarm_message`
- sender member;
- kind;
- body/reference payload;
- thread/correlation/reply-to;
- task/run links;
- trust/source metadata;
- creation time.

`swarm_message_delivery`
- message ID + recipient member ID (unique);
- resolved target Session ID when admitted;
- state;
- claim/attempt;
- expiry;
- preallocated admitted Session message ID;
- admitted/settled timestamps;
- last transport error.

Broadcast is one logical message with N delivery rows, not N independent authored messages.

### 4.8 Coordination state

Keep first-party:

- `swarm_blackboard`: versioned CAS values, author/task/evidence references;
- `swarm_claim`: explicit advisory path/scope ownership with TTL;
- `swarm_deliverable`: optional durable handoff output + verdict ledger.

Do not create a second `swarm_event` table. EventV2 already owns durable event history.

Do not create `swarm_pending_permission`. Permission state remains owned by the permission system;
Swarm stores only correlations/references required by its own runs.

---

## 5. Event and projection model

### 5.1 Current state and history are different products

Normalized Swarm rows answer current state. Durable EventV2 answers transition/audit history.

Do not rebuild hot current state by replaying the event stream on every request.
Do not duplicate every event as a bespoke Swarm timeline table.

Use EventV2's durable-event + atomic local projection support where the transition and projection
must commit together.

### 5.2 Aggregate shape

Exact event names are deferred to schema design, but useful semantic families are:

- Swarm created/changed/lifecycle;
- member attached/rebound/control-state changed;
- task became ready/claimed/admitted/settled/released/reassigned;
- message created/delivery claimed/admitted/expired/failed;
- blackboard key revised;
- lane claim opened/released;
- deliverable published/verdict changed.

Events should carry compact IDs/scalars. Large peer bodies stay in their canonical tables and are
opened on demand.

### 5.3 UI projections

A compact `SwarmSummary` should make a dense list cheap:

- id/name/lifecycle;
- member counts;
- running/ready/blocked task counts;
- unread/action-needed count;
- last meaningful transition;
- coordinator anchor;
- perhaps a health/error scalar derived at settle time.

Member rows combine:

`Swarm membership projection + batched SessionTelemetry/SessionStatus projection`.

No message-history scan is permitted to decide whether a member is “thinking”, “tooling”, “idle”,
or which model it currently runs.

---

## 6. Scheduler redesign

The scheduler should be primarily event-driven and incrementally maintain runnable state.

### 6.1 DAG algorithm

At graph mutation:

- detect cycles in O(V + E);
- materialize each task's unsatisfied dependency count.

At predecessor success:

- load only outgoing dependency edges;
- decrement affected children transactionally;
- children crossing 1 -> 0 become ready and receive `ready_at`.

Cost becomes proportional to the changed frontier, not “scan every task and filter every edge on
every sweep”.

### 6.2 Dispatch

One bounded dispatcher owns scheduling wakeups for the process/database realm.

Wake causes:

- task became ready;
- member became available;
- lease released/expired;
- member rebound/recovered;
- policy changed.

It queries indexed ready tasks and eligible members, claims with DB CAS, revalidates, then crosses
the Tier 3 boundary.

No per-Swarm polling loop.

### 6.3 Candidate selection

Authority order:

1. explicit reservation/assignment;
2. required capability compatibility;
3. explicit path/scope non-conflict;
4. load/concurrency policy;
5. deterministic optional affinity/tie-break.

OpenSwarm's token overlap between member role/name and task prose may survive as a low-weight
tie-breaker, never as assignment authority.

Likewise “gold/corpse” hints may advise ranking only after tasks carry explicit scopes; title/path
substring coincidence must not steer authoritative scheduling.

### 6.4 Leases and stale completion

Claiming a task is not enough. Native Swarm needs fencing:

1. DB claim creates lease generation G;
2. assignment turn provenance references the run/lease;
3. completion/release resolves caller Session -> member -> active lease;
4. mutation succeeds only if generation is still G;
5. reassignment creates G+1; G can never settle G+1's task.

This prevents late tool calls from old Sessions from corrupting current ownership.

### 6.5 Retry taxonomy

Separate:

- **task failure** — consumes task retry budget;
- **provider/runtime/admission failure before work starts** — does not consume task budget;
- **permission wait** — not a failure;
- **operator pause/abort** — authority transition, not automatic retry;
- **session missing** — recovery/rebind condition.

The current OpenSwarm code already learned some of these distinctions through bug fixes. Native
Swarm should encode them as types/state transitions rather than catch-block conventions.

---

## 7. Durable deadlines, not timer forests

OpenSwarm contains sweep timers, debounce timers, cooldown maps, watchdog maps, digest timers, and
other process-local temporal state.

Native rule:

> Durable semantics are represented by durable deadlines/cursors. One shared owner wakes for the
> earliest relevant deadline.

Examples:

- task lease expiry;
- message expiry;
- reservation expiry;
- optional user-interaction grace;
- notification aggregation deadline.

The dispatcher can query `MIN(deadline)` or indexed due rows and arm one process-level timer.
Crash recovery is then “query overdue durable state”, not “recreate a constellation of lost JS
timers”.

High-frequency Session progress remains event-driven through SessionStatus/Telemetry and does not
belong in this deadline driver.

---

## 8. Member Session runtime

### 8.1 Members remain real root Sessions

This OpenSwarm decision remains correct for the desired UX:

- independently openable;
- direct human conversation;
- stable cache/history per member;
- peer-addressable identity;
- no dependence on TaskTool parent/child lifetime.

Swarm membership is first-party data, not encoded in title text.

### 8.2 SessionGroup is the navigation projection

Extend SessionGroup to represent a first-party structural kind such as `swarm`.

Desired properties:

- stable group identity keyed by Swarm ID;
- coordinator Session can be presentation anchor without becoming group identity;
- member Session rebind updates group membership without replacing Swarm/group identity;
- membership rows remain authoritative in Swarm; SessionGroup is the navigational projection.

The current plugin-owned `ownerRef` mechanism proves the stable-identity concept, but a first-party
Swarm should not masquerade as `kind: "plugin"`.

Generalize stable structural ownership rather than adding a second grouping subsystem.

### 8.3 Session runtime is authoritative for live execution

Reuse:

- SessionRunState for one-run admission / cross-process run lease;
- SessionStatus for busy/idle/retry and explicit `idle(reason:"aborted")`;
- SessionTelemetry for live phase/model/token/cost projection;
- current SessionInput + SessionExecution for native admission/execution; V1
  `SessionPrompt.hostPrompt` is a compatibility/reference seam;
- native Session lifecycle events.

Swarm member rows should not shadow those states.

---

## 9. Permissions and model selection

### 9.1 Permissions

OpenSwarm's V1/V2 permission interception, SSE subscription, polling, and pending-permission shadow
table are plugin boundary artifacts.

First-party flow:

1. derive delegated permission policy at Session creation/rebind;
2. attach native Session permission state;
3. observe native permission events directly;
4. correlate an ask to member/task/run by Session ID;
5. expose the native ask to UI/coordinator;
6. native permission service resolves it.

The security invariant remains monotonic:

> Swarm delegation may preserve or narrow authority; it may never silently widen the user's
> authority.

If TaskTool and Swarm need the same derivation, extract the derivation primitive; do not duplicate
policy engines.

### 9.2 Models

Do not port the plugin's model catalog or persist “current model” on the member as parallel truth.

Store only durable **intent** when necessary, e.g.:

- inherit coordinator/current;
- fixed provider/model/variant;
- cheapest model satisfying capability C;
- user-selected member policy.

At execution, resolve against the live first-party provider catalog. The actual backing Session's
model remains Session truth and SessionTelemetry provides current UI projection.

---

## 10. Messaging, trust, and provenance

The detailed contract is in `03-provenance-messaging-runtime.md`.

The architectural rule is:

> **Turn ownership, provider role, peer authorship, trust, and task causality are separate facts.**

A peer message delivered to a member is:

- a host-owned admitted Session turn;
- semantically synthetic/Swarm input;
- often lowered to provider role `user`;
- authored by another Swarm member;
- untrusted content;
- causally linked to a durable Swarm message/delivery row.

No one of those facts substitutes for the others.

This removes OpenSwarm's text-prefix/message-ID “is this human?” detector completely.

---

## 11. Human interaction model

Direct human conversation is a first-class state transition because new turns carry explicit
provenance.

When a real user-owned prompt enters a member Session:

- Session runtime owns the turn;
- Swarm sees `owner:"user"`, not “text did not match a synthetic prefix”;
- new automatic assignments to that Session are suppressed while it is busy;
- an optional post-turn grace period, if retained for UX, is an explicit bounded deadline derived
  from the user-owned interaction;
- an explicit operator abort becomes durable member control state `paused`;
- automation may not “self-heal” through the pause.

The user can resume by explicit interaction/UI action.

The arbitrary five-minute OpenSwarm lull is therefore a product policy, not an identity detector.
We can keep, shorten, or remove it independently after UX testing.

---

## 12. Hive redesign

Do not allow “Hive” to become a second architecture inside Swarm.

### Phase A — coordination substrate

Ship first:

- CAS blackboard;
- explicit lane/path claims;
- deliverable references/verdicts;
- topic subscriptions only if a real use case requires them.

### Phase B — evidence-bearing knowledge

Evaluate after core orchestration is stable:

- facts/knowledge with author + evidence;
- search/relevance using the same principles as first-party Memory (scope before ranking, bounded
  retrieval, evidence not authority);
- duplicate/reinforcement semantics only when independent evidence can actually be proven.

### Delete from native baseline

- “anti-entropy” digest over one canonical database;
- periodic consolidation just to prove the same store agrees with itself;
- scheduler authority based on fuzzy prose/path overlap;
- confidence math without evidence-quality semantics.

Whisper/shout/resonance may return later as **knowledge visibility/evidence policies**, not as an
always-on scheduling subsystem.

---

## 13. Tool/API surface

OpenSwarm's many tools are useful product vocabulary but expensive provider schema if all are
always visible.

OpenFork already has a lazy-tool broker specifically to avoid provider-manifest expansion and cache
churn.

Recommended strategy:

- implement canonical service operations first;
- expose common/high-value actions as a very small stable surface;
- register heavy/rare `swarm_*`, `hive_*`, admin, model, revive, contract, and forensic tools as
  lazy capabilities;
- preserve compatibility aliases during migration only after the canonical service exists;
- make UI call the same service/API, never tool code.

Tool schemas must not dictate database shapes.

Global destructive operations should require explicit operator authority. A model merely being the
coordinator is not sufficient evidence that the human asked to destroy all Swarms.

---

## 14. External architecture research and what we adopt

The redesign is consistent with several production multi-agent/runtime patterns without copying
their APIs:

- Anthropic's multi-agent research write-up emphasizes an orchestrator/worker topology, clear task
  boundaries to avoid duplicated work, separate context windows, and persistent artifacts instead
  of repeatedly relaying large outputs through the coordinator.
- OpenAI Agents SDK deliberately exposes a small number of orchestration primitives and separates
  manager-style delegation from handoffs. Its tracing hierarchy separates workflow/task/agent/turn/
  tool/handoff spans rather than collapsing causality into one status field.
- AutoGen explicitly separates direct request/response messages from one-way topic broadcast.
- The transactional-outbox pattern reinforces the need to commit authoritative domain state and
  durable notification intent together; OpenFork's EventV2 durable commit/projection mechanism is a
  stronger local primitive than inventing a second broker database.
- Orleans distinguishes process-local timers from durable reminders; Swarm should similarly encode
  durable deadlines in storage and keep one shared runtime owner rather than trusting per-object
  timers across restarts.

References:

- https://www.anthropic.com/engineering/multi-agent-research-system
- https://openai.github.io/openai-agents-python/multi_agent/
- https://openai.github.io/openai-agents-python/tracing/
- https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/framework/message-and-communication.html
- https://microservices.io/patterns/data/transactional-outbox
- https://learn.microsoft.com/dotnet/orleans/grains/timers-and-reminders

---

## 15. Performance closure targets

These are design targets to verify, not benchmark claims.

### Idle

- no 10-second “scan every Swarm” loop;
- no per-Swarm timers;
- no polling Session histories/status;
- one bounded deadline owner only when a deadline exists;
- event subscriptions are process-owned and typed/location-scoped.

### Scheduler

- graph edit validation O(V + E);
- predecessor settlement O(out-degree) for readiness propagation;
- ready-task selection from an index;
- assignment claim O(log N)/indexed DB operations;
- candidate ranking bounded by eligible members, not all historical members.

### Messaging

- enqueue is one message insert + batched recipient inserts;
- recipient mailbox is indexed by recipient/state/priority/time;
- no N+1 member-name/session lookups when a batch can join/project them;
- multiple queued low-priority peer messages may be admitted as one bounded inbox turn where
  semantics allow it.

### UI

- list view requires compact Swarm rows/projection only;
- roster live state fetched in a batch from SessionTelemetry/Status;
- no transcript hydration to draw status/model/count badges.

### Provider/cache

- changing assignment/peer/continuation text is appended as a new host-owned turn, never inserted
  into a changing system prefix;
- stable agent/system doctrine remains cache-friendly;
- avoid spawning fresh members when an existing healthy member can continue, because fresh
  Sessions forfeit context/cache warmth.

---

## 16. Negative invariants

Implementation is not complete until tests prove the following *cannot* happen:

1. a tool or UI component becomes the durable Swarm source of truth;
2. listing/status materializes an OpenCode Instance;
3. one process creates a timer per Swarm/member;
4. a host turn is classified as human because its provider role is `user`;
5. a human turn is inferred from message text or `TextPart.synthetic`;
6. peer-authored content reaches a member unfenced/trusted;
7. one task has two active leases;
8. one member Session owns two active task leases when policy is single-task;
9. a stale lease generation settles a reassigned task;
10. task dependency failure silently satisfies a success-required edge;
11. a broadcast is treated as request/response by accident;
12. one logical broadcast becomes N independently-authored messages;
13. a crash after Session-turn admission causes the same delivery to be injected twice;
14. a runtime/provider admission failure consumes the task's semantic retry budget;
15. operator abort is auto-resumed without explicit user policy;
16. fuzzy name matching mutates ownership/coordination authority;
17. a Swarm member row shadows Session busy/idle/model as independent truth;
18. Swarm duplicates the permission engine's pending-request authority;
19. Swarm reconstructs current state from event-history replay on a hot read;
20. Swarm creates a second durable event timeline beside EventV2;
21. ChunkDB/legacy plugin storage becomes a permanent native runtime backend;
22. an API caller can spoof `provenance.owner = "host"`;
23. coordinator model authority substitutes for explicit user authority on destructive global ops;
24. SessionGroup becomes the membership source of truth instead of a navigation projection;
25. a dense UI list performs per-row Session/history fetches.

---

## 17. Decision summary

The first-party Swarm architecture is therefore:

```text
User / Agent intent
      |
      v
Schema-validated Core Swarm command
      |
      +--> normalized durable state
      |       task graph / lease / run
      |       message / delivery
      |       blackboard / claim
      |
      +--> durable EventV2 transition + compact projection
      |
      v
bounded dispatcher / deadline owner
      |
      | successful CAS + revalidation only
      v
OpenCode SwarmExecutor (Tier 3)
      |
      +--> Session + SessionGroup + permission/model resolution
      +--> trusted host-owned turn provenance
      +--> SessionRunState admission
      |
      v
normal Session runtime
      |
      v
settle by run/lease/delivery fencing id
```

OpenSwarm's successful experience survives. Its plugin scaffolding does not.

