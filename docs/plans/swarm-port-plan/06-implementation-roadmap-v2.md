# First-party Swarm implementation roadmap v2

**Status:** ACTIVE NATIVE IMPLEMENTATION RECORD — subordinate to
`00-first-party-overhaul-2026-09-18.md`; Phase 4 surface tranche closed
2026-09-19.  
**Constraint:** OpenSwarm is requirements/migration archaeology only. Native
Swarm owns its schema, storage, runtime, API, tools, and UI.

---

## 0. Philosophy

The August plan said “contract-preserving port first, elegance later.”

That is explicitly superseded.

The current OpenSwarm implementation contains structural assumptions that are unacceptable as a
first-party baseline. Porting them first would create migration debt immediately.

The new rule is:

> **Preserve behavioral invariants, rebuild the mechanics once.**

OpenSwarm source and tests are a requirements mine. OpenFork architecture is the implementation
authority.

---

## Phase 0 — close architecture before code

### Deliverables

- [x] bottom-up audit of OpenSwarm domain/runtime/storage/tool structure;
- [x] audit current OpenFork Session, EventV2, SessionGroup, ScheduledTask, Goal/provenance, lazy tool
  primitives;
- [x] classify preserve/redesign/delete/defer;
- [x] define provenance/messaging separation;
- [x] adversarial architecture review against current `AGENTS.md`, Session,
  provenance, Goal, EventV2, SessionGroup, TaskTool, and OpenSwarm regression
  corpus;
- [ ] inventory every OpenSwarm test file -> behavioral invariant -> destination/deletion reason;
- [x] confirm exact current Database/Drizzle migration conventions;
- [x] confirm exact V1 SessionPrompt host-admission seam and prove it is a
  compatibility/reference path rather than the native target;
- [x] freeze candidate generalized `SessionInput.Item`, typed synthetic origin,
  additive synthetic event lifecycle, owner-aware arbitration, and homogeneous
  provider-cycle semantics;
- [x] freeze pending-Synthetic revocation lifecycle and promote-vs-revoke CAS;
- [x] freeze shared cross-process Session execution ownership/handoff model;
- [x] freeze bounded human-focus retirement as the same handoff protocol used by
  expiry/rebind/operator recovery;
- [x] micro-prototype SessionInput pending/revocation indexes, latest-User
  lookup, Session execution-owner hot paths, and cross-process release ordering;
- [x] freeze RuntimeOwner process-incarnation identity separately from
  domain-specific lease/retry semantics;
- [x] freeze Goal automatic continuation as Synthetic /
  `admission_class=automatic` SessionInput rather than a fifth runnable queue;
- [x] micro-prototype User-vs-automatic ordering, indexed
  `user_preemptible` revocation, fenced interrupt requests, and normalized
  RuntimeOwner hot paths;
- [ ] replay/property-test generalized SessionInput arbitration + Goal cutover
  against the real EventV2 projector before production implementation;
- [ ] prove foreground process containment strongly enough to permit automatic
  dead-Session-owner recovery on every supported OS;
- [x] confirm SessionGroup schema generalization for `kind:"swarm"`;
- [x] decide exact public HTTP/SDK surface vs tool-only/internal operations;
- [ ] decide migration support matrix for legacy SQLite and ChunkDB files;
- [ ] define quantitative benchmark fixtures and budgets.

### Exit gate

No Swarm runtime code starts until every source-of-truth row has:

- an owner;
- a writer;
- a lifetime;
- a failure meaning;
- an index/read path;
- an event/projection story;
- a recovery story.

---

## Phase 1 — schema + pure Core domain

Build bottom-up.

### 1A. Wire contracts

- branded IDs;
- Swarm/member/task/message/delivery/run schemas;
- policy/state enums;
- compact summary/detail projections;
- durable event definitions;
- provenance source additions;
- SessionGroup first-party Swarm kind contract.

No generated SDK edits by hand.

### 1B. Core tables

Initial minimal set:

- `swarm`;
- `swarm_member`;
- `swarm_task`;
- `swarm_task_dependency`;
- `swarm_task_lease`;
- `swarm_task_run`;
- `swarm_message`;
- `swarm_message_delivery`;
- `swarm_blackboard`;
- `swarm_claim`;
- optional `swarm_deliverable` if required for parity milestone.

Explicit non-goals:

- no `swarm_event`;
- no pending-permission copy;
- no second database;
- no ChunkDB runtime adapter;
- no belief/digest tables in core milestone;
- no Session status/model mirror columns.

### 1C. Pure algorithms

- DAG cycle validation;
- incremental dependency satisfaction;
- candidate compatibility/ranking;
- state-transition validators;
- message target expansion;
- trust/fence rendering primitives where dependency direction permits;
- retry/failure classifier inputs as typed domain values.

### 1D. Core transactional services

- create/archive/revise Swarm;
- member identity attach/rebind/control;
- task create/dependency mutation;
- lease claim/fencing/release/settle;
- message enqueue/recipient expansion/delivery claim;
- blackboard CAS;
- claim lifecycle;
- compact summary materialization;
- durable EventV2 + projection commit.

### Phase 1 verification

- [x] property test DAG invariants;
- [x] concurrent N-claim tests;
- [x] stale fencing generation tests;
- [x] dependency failure-policy tests;
- [x] broadcast normalization tests;
- [x] CAS conflict tests;
- [x] no Instance/runtime dependency/import from Core tests;
- [x] query-plan/index assertions for ready/mailbox/summary/navigation hot paths.

#### Phase 1 closure evidence — 2026-09-19

- `packages/schema/test/swarm.test.ts`: **3/3** contract tests pass, including
  disjoint IDs, wire optionality, and trusted Swarm conversational provenance.
- `packages/core/test/swarm/`: **23/23** tests pass across algorithms, schema,
  aggregate service, leases, messaging/shared state, and the dependency-boundary
  regression.
- DAG verification now includes 128 deterministic generated DAGs with injected
  back-edge cycles plus a 12,000-node deep chain, exercising the iterative
  O(V+E) validator without recursive stack growth.
- The task settlement transaction now incrementally promotes directly affected
  dependents with one set-oriented SQL update. `require_success` remains blocked
  after semantic prerequisite failure while `require_terminal` becomes ready;
  both become ready after prerequisite completion.
- The existing 16-way concurrent task-claim test still proves exactly one lease
  winner. Stale generations are exercised for member binding, task lease,
  delivery claim, and advisory claim authority.
- Broadcast fanout/reply correlation, Blackboard CAS conflict behavior,
  immutable deliverables/one-shot verdicts, and rebind-safe delivery admission
  are all covered by the Core corpus.
- `packages/core/test/swarm/boundary.test.ts` mechanically restricts Core Swarm
  imports to durable Tier-0/1 owners. It excludes Instance, Location runtime,
  plugins, workspace execution, Session runtime/history/projector services, and
  other Tier-3 materialization paths.
- `EXPLAIN QUERY PLAN` assertions prove use of `swarm_task_ready_idx`,
  `swarm_message_delivery_due_idx`, `swarm_message_delivery_recipient_pending_idx`,
  `swarm_member_roster_idx`, and `swarm_member_bound_session_idx` on the Phase-1
  ready/mailbox/summary/navigation hot paths.
- `packages/opencode/test/session/group.test.ts`: **11/11** tests pass. Swarm
  groups are composed from `Swarm.Service.navigation()` outside persisted-group
  caches, never materialize `session_group` / `session_group_member` rows or
  `SessionTable.group_id`, support one Session in multiple Swarms, disappear when
  zero-bound without deleting Swarm state, preserve other bound members when the
  coordinator binding disappears, and refresh coordinator rebinds immediately
  without changing the virtual group ID.
- `bun script/migration.ts --check` from `packages/core` is clean. The single
  unreleased `swarm_foundation` migration remains the schema foundation; no
  follow-up migration was generated.

**Phase 1 status:** closed. Runtime/executor work may proceed only under the
Phase-2 authority, admission, provenance, and handoff contracts below.

---

## Phase 2 — Tier 3 runtime executor

Only now touch Session execution.

### 2A. Member Session lifecycle

Before runtime implementation, the model-tool authority boundary is a hard
prerequisite:

- provider `session` is inspection-only;
- Task child mutations flow through the shared subagent-delegation backend, not
  `TaskTool` as infrastructure;
- Swarm peer/task/member mutations flow through Swarm domain services/executors,
  never generic Session tool mutation;
- UI/API/OXP adapters may invoke Session lifecycle/runtime control only under
  their own authenticated/domain authorization;
- `08-shared-session-control-and-human-interaction.md` §3.4 is the normative
  operation-ownership matrix for Phase 2-4 surface work.

Static regression tests must fail if backend/runtime source imports TaskTool or
SessionTool as an implementation dependency or if ToolRegistry re-exposes Task as
an internal named backend handle.

- create root member Session;
- bind/rebind stable member ID;
- apply delegated permission policy;
- resolve model policy from native catalog;
- synchronize first-party SessionGroup projection;
- observe Session deletion/replacement without duplicating live status.

#### 2A realization evidence — 2026-09-19

The managed-member lifecycle is now a first-party Tier-3 service rather than a
caller convention:

- deterministic candidate identity is `member_id + binding_generation`, so a
  crash/retry converges on the same root Session instead of creating siblings;
- materialization validates the saved agent/model/account/variant/capability
  profile against the native catalogs before binding;
- worktree policy is recovered deterministically and shared-read adds a hard
  edit/shell deny ceiling without mutating the durable desired policy;
- the execution boundary is installed before the generation-fenced member bind;
- V1 Session owns actual root creation through the trusted, non-public
  `createManagedRoot` seam. Existing candidates are adopted only when root,
  project, directory, workspace, agent, model, account, and variant all match;
- global reconciliation depends only on normalized Core Session projections for
  reads. It does not pull location-scoped Session execution into the global app
  graph and crosses into V1 only under explicit `InstanceStore.provide`;
- orphan cleanup tests normalized input/message existence directly rather than
  hydrating transcript history; non-empty candidates are preserved;
- one process-global event-driven runner performs an initial level-triggered
  scan and wakes on `swarm.member.updated`, `swarm.updated`, and
  `session.deleted`. Wake bursts coalesce to one active scan plus at most one
  fresh authoritative rescan; there is no per-member polling/watch fiber;
- SessionGroup remains a read-only virtual Swarm projection and therefore needs
  no lifecycle-side synchronization/materialization.

Focused certification: `member-session.test.ts`,
`member-session-policy.test.ts`, and `member-session-runner.test.ts` are green
(6 tests / 30 assertions). The runner test also caught and forced removal of an
invalid global -> location-scoped `SessionV2.node` dependency before this phase
was considered complete.

**2A status:** closed for the managed-worker lifecycle slice. Phase 2B may build
only on the trusted typed Synthetic admission contract below.

### 2B. Host-turn admission

Implement/reuse trusted producer path for:

- assignment;
- peer delivery;
- continuation;
- recovery;
- actionable notice.

Every admission gets explicit provenance and durable correlation.

The underlying current Session contract is one tagged durable queue:

- user Prompt -> semantic User;
- synthetic text + typed origin -> semantic Synthetic.

The queue also carries an execution/admission class:

- User -> `user`;
- Swarm/peer/scheduled/recovery Synthetic -> normally `host`;
- Goal autonomous continuation -> `automatic`.

Public `Session.prompt` remains user-owned. Synthetic admission is a trusted
internal producer capability, not a public provenance field clients can forge.

Runner priority:

```text
user steer > user queue > host steer > host queue > automatic queue
```

Provider cycles are homogeneous `user | host | automatic`; a different-class
arrival becomes the next cycle rather than mutating the current cycle's source.

Before Swarm depends on this path, SessionInput also implements:

- pending Synthetic revocation;
- mutually exclusive promoted/revoked lifecycle;
- User-admission transaction revokes older pending `user_preemptible` work;
- an optimistic `expectedLatestUserSeq` admission fence for automation that
  must yield to newer human input.

#### 2B realization evidence — 2026-09-19

The trusted host-turn ingress is now an explicit Session-owned capability, not
an ad-hoc Swarm prompt path:

- `SessionInput.SyntheticAdmission` carries typed content/origin/delegation,
  stable message identity, `host | automatic` admission class, delivery mode,
  and optional human-focus fence;
- host admissions may opt into `expectedLatestUserSeq` as an optimistic human
  focus fence; automatic admissions require the fence and remain queue-only;
- `user_preemptible` pending Synthetic work is revoked by newer semantic User
  admission in the same durable Session event transaction;
- promotion and revocation are terminal CAS competitors, so a revoked Synthetic
  input cannot later materialize as transcript history;
- provider-cycle arbitration is the fixed five-lane order and promotion batches
  remain homogeneous by `user | host | automatic` admission class;
- `SessionPrompt.admitSynthetic` is a trusted internal producer seam. It durably
  admits first, then treats local execution wake as a latency optimization;
- `SyntheticAdmission.commit(seq)` composes a trusted local side effect into the
  same Session EventV2 transaction. This is the required Phase-2D seam for
  `Swarm.commitDeliveryAdmission(...)`, eliminating the admission/receipt crash
  window without publishing a second aggregate event;
- Swarm provenance source kinds (`swarm.assignment`, `swarm.peer`,
  `swarm.continuation`, `swarm.recovery`, `swarm.notice`) are schema-owned and
  correlation requirements are validated before durable admission.

Focused certification: `packages/core/test/session-input-lifecycle.test.ts` is
green (13 tests / 43 assertions), covering host fencing, automatic fencing,
User supersession, promote-vs-revoke, five-lane priority, homogeneous promotion,
and tagged-input persistence.

**2B status:** closed for the generic trusted admission primitive. Swarm task and
mail executors must consume this seam; they must not create a parallel prompt or
provenance path.

### 2C. Task executor

```text
Core lease claim
 -> revalidate
 -> resolve/load target runtime
 -> shared Session execution ownership
 -> host assignment turn
 -> task_run admitted
 -> normal Session runtime
 -> explicit task completion/failure tool/event
 -> fenced settle
```

All failure exits return values to the Core service; no hidden process-local ownership.

Task handoff never jumps directly from expiry/release to reassignment:

```text
retire
 -> revoke unpromoted input OR wait Session quiescence
 -> supersede/release exact old generation
 -> only then requeue/reassign
```

### 2D. Mail executor

- claim delivery;
- preallocate/persist target message identity;
- respect human/operator control;
- admit fenced host peer turn;
- atomically settle `admitted` in the recipient Session durable-event
  transaction via EventV2's local commit hook;
- retry only receipts that never completed that transaction.

### Phase 2 verification

- kill process at every boundary in assignment and mail admission;
- prove no duplicate turn after restart;
- prove user + synthetic SessionInput replay rebuilds the same pending/promoted
  projection after process/database re-open;
- prove user queue outranks host Synthetic steer;
- prove same-class steer cutoff semantics remain identical to today's runner;
- prove an automatic cycle that receives a user steer remains labelled
  automatic while its already-started work settles, then user runs next;
- prove a host cycle cannot create user tool authority;
- prove a newer user input prevents an older host/automatic cycle from
  manufacturing a fresh autonomous continuation;
- prove stale Session cannot settle reassigned task;
- prove operator abort cannot be auto-resumed;
- prove direct human prompt is detected by provenance only;
- prove peer “SYSTEM:” text remains fenced;
- prove permission wait does not burn task retry;
- prove provider failure before admission does not burn task retry;
- prove promote-vs-revoke has one winner and revoked Synthetic never becomes a
  Session message;
- prove one User admission atomically revokes every older pending
  `user_preemptible` SessionInput while leaving already-promoted history
  intact;
- prove admission racing cross-process Session release cannot strand durable
  input;
- prove heartbeat timeout alone cannot steal an active Session execution owner;
- prove Goal worker continuation requires no Goal-specific process owner after
  SessionInput cutover;
- prove Goal Auditor owns/fences its child Session independently of the worker;
- prove interrupt request is generation-fenced and does not transfer ownership;
- prove hard-dead owner recovery does not auto-replay outcome-uncertain tools;
- prove human-focus max hold begins retirement rather than parallel reassignment;
- prove expired Swarm lease and member rebind use the same quiescence barrier.

---

## Phase 3 — dispatcher, deadlines, recovery

### 3A. Event-driven dispatcher

One process-owned bounded dispatcher:

- subscribes only to relevant durable/domain events;
- batches/coalesces wakeups;
- selects indexed ready work;
- claims before Tier 3 execution;
- bounded concurrency;
- no per-Swarm fibers/timers.

### 3B. Deadline owner

One next-deadline timer for:

- lease expiry;
- delivery expiry;
- reservation expiry;
- user-interaction grace if retained;
- notification aggregation if model-facing aggregation exists.

Due scan is indexed and bounded.

### 3C. Startup recovery

Recover only unresolved durable work:

- active leases with stale ownership/dead Session;
- claimed deliveries not admitted/settled;
- runs left in transitional states;
- member bindings whose Session was deleted.

Do not scan entire histories or “repair” healthy rows for reassurance.

### Phase 3 performance gates

Build synthetic fixtures such as:

- 1,000 Swarms / 10,000 members / no active work — idle cost should remain effectively flat;
- large DAG with fanout/fanin — settlement work proportional to affected edges;
- 10,000 queued deliveries — indexed recipient claim;
- concurrent dispatchers — DB constraints prevent double claim;
- 200-session sidebar — no per-row history/Instance work.

Record:

- query count;
- p50/p95 transition latency;
- CPU idle;
- heap retained by dispatcher;
- EventV2 bytes/events per transition;
- Session/provider prompt bytes;
- cache-read ratio where provider telemetry exposes it.

Targets must be set before accepting implementation, then measured rather than guessed.

---

## Phase 4 — API, tools, and UI

### 4A. Read API first

Expose cheap:

- [x] list summaries;
- [x] detail/roster/tasks;
- [x] paged message/delivery history;
- [x] paged run history;
- [x] paged blackboard/claims/deliverables.

Route placement follows ownership tier. Cheap catalog/status reads must not sit behind Instance
materialization middleware.

### 4B. Mutation API

Expose schema-validated service operations. Runtime-requiring mutations may enqueue/claim work but
the API handler does not become the execution owner.

- [x] delegate/create native Swarm;
- [x] exact-revision aggregate state mutation;
- [x] managed-member create/stop/resume;
- [x] stopped/unbound exact-generation member profile reconfiguration;
- [x] operator-authored task creation and dependency replacement;
- [x] bounded recovery wake request;
- [x] stale revision/binding conflicts preserved as HTTP 409;
- [x] operator task creation cannot forge member authorship.

### 4C. Tool surface

Rebuild tools from scratch over the service.

Use existing lazy-tool broker for large/rare schemas.

Only after this phase:

- delete/replace `packages/opencode/src/tool/swarm/` prototype;
- add compatibility aliases if migration requires them.

Never copy prototype domain logic into the new tools.

Current native tool surface is lazy and service-backed. It does not depend on
OpenSwarm or re-roll the Swarm domain inside model-facing tool code.

### 4D. UI

Session navigation:

- [x] first-party SessionGroup `swarm` structural grouping;
- [x] one Session may appear in multiple native Swarms without membership collapse;
- [x] root member Sessions use compact member projections, not transcript hydration;
- [x] stable virtual group identity across Session rebind;
- [x] Swarm membership is read-only from generic SessionGroup mutation surfaces.

Swarm panel:

- [x] lazy compact summary/detail;
- [x] task graph/state with O(V+E) indexing for dense rendering;
- [x] member live SessionTelemetry/model overlay;
- [x] pending delivery/action counts;
- [x] live Permission/Question correlations from canonical Session state;
- [x] blackboard/claims/deliverables;
- [x] paged peer-message/task-run history on explicit open;
- [x] operator controls for Swarm/member/task/profile/recovery operations;
- [x] source-aware timeline presentation for assignment, peer, continuation,
  recovery, notice, and genuine human input.

No component scans transcripts to recover status.

### Phase 4 closure evidence — 2026-09-19

- Root `/swarm` HTTP/SDK reads and mutations are Tier 0. The ownership test
  builds them without `InstanceStore`, Location, Provider, Plugin, MCP, or a
  workspace runtime and passes **9/9** tests.
- HTTP mutation certification proves stale aggregate revision and stale member
  binding generation remain explicit **409** conflicts. The operator task route
  strips an injected `createdByMemberID`; the Core input contains no member
  authorship.
- The generated V2 SDK was rebuilt from the live HTTP schema. No generated
  Swarm client file is hand-maintained.
- `packages/core/test/swarm/` passes **47/47** tests (**668 assertions**);
  `packages/opencode/test/swarm/` passes **31/31** (**149 assertions**);
  model-facing `tool/swarm.test.ts` passes **3/3** (**20 assertions**); and
  SessionGroup projection tests pass **11/11** (**80 assertions**).
- App Swarm/navigation tests pass **21/21** (**74 assertions**). The panel's
  narrow data contract cannot address Session transcript/prefetch APIs; history
  and shared-state projections remain explicit lazy surfaces.
- Dense projection indexing is one-pass over roster/tasks/DAG edges; the test
  fixture indexes 2,000 members, 5,000 tasks, and 10,000 dependency edges without
  per-task edge scans.
- The production Vite build succeeds. `swarm-panel` is emitted as a separate
  lazy chunk (~36.6 kB minified / ~8.3 kB gzip), so ordinary Session routes do
  not eagerly load the panel.
- `packages/session-ui` provenance presentation tests pass **9/9** and package
  typecheck is clean. Human prompts remain the normal user surface while native
  Swarm host turns are visibly attributed by semantic source.

**Phase 4 status:** closed for the native API/tool/UI surface. Phase 5+ may
continue parity hardening and migration evaluation without reintroducing the
OpenSwarm plugin as a runtime dependency.

---

## Phase 5 — behavioral parity hardening

Re-evaluate the **legacy OpenSwarm behavior inventory** against real usage.
Preserve useful product semantics only; do not restore the plugin architecture.

### High-priority parity

- delegate/create;
- explicit task binding;
- DAG dependencies;
- direct peer messaging/reply;
- broadcast;
- user-worker chat;
- manual pause/resume;
- restart recovery;
- permission escalation;
- status/roster/probe;
- blackboard;
- claims;
- deliverables;
- member model policy/capability selection.

### Compatibility tests

Preserve externally valuable tool-output semantics only where users/scripts rely on them.
Do not preserve internal IDs/table quirks merely for byte parity.

---

## Phase 6 — Hive/knowledge evaluation

Only after scheduler/messaging/runtime are stable.

Candidate sequence:

1. evidence-bearing artifact annotations;
2. indexed scoped knowledge search;
3. independent-evidence reinforcement;
4. need routing using capabilities/tasks/knowledge;
5. evaluate whether whisper/shout/resonance adds measurable value.

No local anti-entropy subsystem.

Any mechanism allowed to influence authoritative scheduling must graduate through explicit evals,
false-positive analysis, and scope semantics first.

---

## Phase 7 — legacy migration

### Principle

Legacy storage is an **import format**, not a native backend.

### Process

1. detect legacy OpenSwarm store(s);
2. verify plugin is not actively controlling the same Swarm;
3. open legacy store read-only;
4. map schema version/backends explicitly;
5. import logical identities/tasks/messages/blackboard/artifacts into native tables;
6. preserve old IDs in migration metadata/reference mapping where useful;
7. validate counts/invariants/checksums;
8. record migration marker;
9. leave legacy file untouched for forensic rollback/export;
10. native becomes sole writer after explicit cutover.

Do not maintain two live controllers writing a mutually compatible database.

If ChunkDB legacy support is required, implement a bounded read/import adapter only. It must not
become a permanent `SwarmStore` abstraction in native runtime.

---

## Phase 8 — delete plugin-era architecture

After migration/parity gates:

- [x] native runtime has no OpenSwarm plugin requirement;
- delete migration-only OpenSwarm detection/import code when its support window closes;
- remove any temporary compatibility bridge;
- archive migration-only paths behind clear version policy;
- delete obsolete OpenFork tool/swarm prototype;
- remove compatibility source tags/aliases only when V1 deprecation policy permits.

---

## Cross-phase review checklist

Before each phase exits, answer all of these:

1. What is the authoritative row/service for every new fact?
2. Is any fact duplicated from Session/Permission/Provider state?
3. Is any list/status path accidentally Tier 3?
4. Can a crash between two writes duplicate execution?
5. What is the idempotency/fencing key?
6. Can a stale actor still mutate current state?
7. Are all timers/deadlines durably reconstructible?
8. Is peer content still untrusted on every model-facing surface?
9. Is turn ownership stamped by the trusted producer?
10. Does provider role remain separate from user authority?
11. Could this be event-driven instead of polled?
12. Did we add an N+1 query or per-row Session fetch?
13. Did a tool/UI gain domain behavior?
14. Did we expand the provider tool manifest unnecessarily?
15. Can the feature be tested without mocking the architecture away?

If any answer is unclear, the phase is not closed.

