# Native Swarm Reliability & Agent-Ergonomics Research Ledger

**Status:** Active implementation ledger  
**Date:** 2026-10-02  
**Scope:** OpenFork native Swarm only. **NOT OpenSwarm.**  
**Repository:** `openfork` / `opencode` working tree  
**Primary evidence:** executable source/tests + `openfork-main.db` behavioral telemetry  
**Architecture rule:** source/tests > AGENTS.md > durable architecture docs > this ledger

---

## 0. Executive summary

OpenFork native Swarm already has a strong durable orchestration substrate: roster identity, generation-fenced Session bindings, task DAGs, task leases/runs, peer messaging with durable delivery state, Blackboard shared state, claims, deliverables, managed-root Session materialization, workspace policies, recovery owners, and a first-party UI.

The main defect is not "Swarm lacks features." The main defect is that the **agent-facing protocol exposes too much mechanism and leaves too much lifecycle closure to model behavior**.

Observed production-like behavior in `openfork-main.db`:

- 6 native Swarms
- 22 members
- 15 tasks
- 127 task runs
- 120 task runs superseded
- 7 task runs still marked running
- 0 completed task runs
- 0 failed task runs
- 0 recorded `task.settle` tool calls
- 105 supersessions: `retired after lease_owner_lost`
- 9 supersessions: `retired after lease_expired`
- 6 supersessions: pending assignment revoked
- historical tasks reached 14–28 runs; one task reached lease generation 55
- durable collaboration tables currently contain 0 messages, 0 deliveries, 0 Blackboard rows, 0 claims, 0 deliverables, 0 task dependencies
- Session history nevertheless shows workers *reading* Swarm collaboration channels via the lazy broker, but almost never mutating them

A representative worker eventually said:

> "I have no active task in this session and no Swarm reporting channel here — please stop re-sending ..."

Another later said:

> "No task accepted — stop request still stands. Ignoring this repeated assignment."

This is a model-facing orchestration failure: useful work occurred, but task authority/closure was not made reliable or intuitive enough.

### Core thesis

> **Agents should express intent; OpenFork should resolve authority.**

The host already knows the caller Session, Swarm membership, active member binding, task run, lease generation, task authority, and project scope. The model should not have to manually shepherd opaque IDs and lifecycle machinery that the host can resolve more safely.

---

## 1. Non-goals / hard boundaries

1. This work is **not OpenSwarm**.
2. Do not import OpenSwarm persistence, recursive scheduling, prompts, terminology, or state model.
3. Do not replace canonical Session execution with a second LLM/runtime loop.
4. Do not weaken generation fences, Session admission fencing, human-focus precedence, or external-effect uncertainty semantics merely to improve UX.
5. Do not infer authority from model prose, member names, provider roles, or task text.
6. Do not auto-mark semantic task success solely because an assistant turn emitted prose.
7. Do not overwrite unrelated working-tree changes. The repository is heavily dirty.
8. Do not "solve" discoverability by eagerly exposing the entire 24-action admin tool to every ordinary Session.

---

## 2. Current architecture

```text
                       model / OXP / operator UI
                                |
              +-----------------+-----------------+
              |                 |                 |
       lazy swarm tool      OXP Swarm API      HTTP/UI
              |                 |                 |
              +-----------------+-----------------+
                                |
                          Core SwarmV2
                    packages/core/src/swarm/*
                                |
                         durable SQLite
                                |
            +-------------------+--------------------+
            |                   |                    |
         roster             task DAG             collaboration
       + profiles          + leases/runs      mail / Blackboard /
            |                   |             claims / deliverables
            |                   |
            +----------+--------+
                       |
                Session admission
                       |
           canonical managed root Session
                       |
              normal OpenFork runtime
```

### Authoritative source ownership

- Swarm/member/task/message/shared-state truth: Core Swarm domain + SQLite.
- Live LLM execution: canonical Session runtime.
- Managed worker identity: logical member + generation-fenced Session binding.
- Human input precedence: Session admission/user-focus authority.
- Peer message provenance: sender Session/member binding, persisted by host.
- Workspace isolation: member workspace policy.
- UI: projection/consumer, not source of truth.

---

## 3. Capability inventory

### 3.1 Peer-to-peer messaging — implemented

Native peer mail supports:

- directed member delivery
- broadcast expansion to recipients
- immutable logical messages
- one durable delivery record per recipient
- delivery claim generation + owner
- retry/defer
- expiration
- priority
- correlation IDs
- response-to IDs
- reply-expected flag
- task linkage
- recipient Session/binding fencing
- host-owned peer envelopes
- urgent messages can use steering instead of queue

This is genuine P2P coordination.

### 3.2 Shared state — implemented, but explicit

Blackboard:

- `(swarm_id, key)` authoritative identity
- JSON value
- content type
- author member
- optional task
- version
- CAS overwrite via `expectedVersion`

This is useful **shared working state**, but not shared model memory.

### 3.3 Claims — implemented, currently advisory

Claims have:

- member
- scope
- generation fence
- optional expiry
- release state

But ordinary `edit` / `write` / `patch` do not consult Swarm claims. Claims therefore coordinate socially; they do not currently enforce filesystem mutual exclusion.

### 3.4 Deliverables — implemented as metadata ledger

Deliverables include:

- member
- optional task run
- summary
- refs[]
- files[]
- verdict
- reviewer
- timestamps

`files[]` are path strings. Swarm does **not** currently snapshot, hash, upload, transfer, materialize, merge, or otherwise make the file durable as an artifact.

### 3.5 Filesystem collaboration — indirect

Workspace policies:

- `shared-read`: common directory; runtime hard-denies `edit` and `bash`
- `shared-write`: common directory governed by profile permission boundary
- `worktree`: stable dedicated Git worktree / branch per managed member

This means agents may share files through topology, but there is no first-class cross-member file transport or cross-worktree artifact import.

### 3.6 Shared LLM context — intentionally absent

Each worker is an independent root Session.

There are no Swarm references to `session_context_*` state and no common token window.

This is good as a base invariant. Shared raw context would create token multiplication, stale-context races, instruction contamination, and scaling problems.

The missing feature is **structured knowledge handoff**, not merged context windows.

### 3.7 Long-term memory — absent

There are no Swarm integrations with OpenFork's actual memory facilities.

The permission key `swarm.memory` currently protects Blackboard and claims. This naming overstates semantics.

Candidate rename: `swarm.shared_state`.

---

## 4. Behavioral telemetry from openfork-main.db

### 4.1 Swarms / tasks

Observed durable Swarms:

- PWA startup optimization audit
- OXP runtime delegation verification
- several AlphaGym / H4 / H5 research Swarms

Run-heavy tasks reached:

- OXP verification: 28 runs, lease generation 55
- PWA tasks: 17–18 runs each
- H4/H5 tasks: 14 runs each

All had `semantic_retry_count = 0`.

**Interpretation:** churn was operational lifecycle churn, not semantic task failure.

### 4.2 Run-state distribution

```text
120 superseded
  7 running
  0 completed
  0 failed
```

Supersession reasons:

```text
105 retired after lease_owner_lost
  9 retired after lease_expired
  6 pending assignment revoked: superseded
```

### 4.3 No successful worker settlement in the observed DB

Search across direct and brokered Swarm tool calls found:

```text
task.settle calls = 0
```

This is the strongest behavioral defect currently observed.

Useful assistant work happened, but semantic task state did not close.

### 4.4 Historical assignment prompt was too weak

Persisted assignment envelopes ended with:

> Report progress/results through the Swarm collaboration tools and obey the current task lease/fencing contract.

That does not tell the worker *how* to close the task.

The current dirty working tree already improves `packages/core/src/swarm/render.ts` to give an exact lazy-broker + `task.settle` recipe.

This change is promising but **has not yet been validated by a clean post-change behavioral sample**.

### 4.5 Lazy-tool discovery tax

Managed workers call Swarm through generic `tool` broker:

```text
tool.describe("swarm")
-> receive contract
-> tool.call("swarm", contract, args)
```

Observed managed-worker Swarm broker calls:

- describe: 5
- list: 5
- message.list: 4
- get: 3
- claim.list: 2
- deliverable.list: 2
- blackboard.get: 1
- summary: 1
- state attempts rejected: 4

Observed worker mutations:

- message.send: 0
- blackboard.put: 0
- claim.acquire: 0
- deliverable.publish: 0
- task.settle: 0

Workers inspect collaboration, but do not naturally collaborate through it.

### 4.6 API naming failure: `state`

Several managed workers attempted `state` and received:

> Action requires the recorded coordinator ...

The name reads like a query but actually mutates Swarm lifecycle.

Candidate rename:

`state` -> `set_status`

### 4.7 Schema / argument ergonomics failures

Observed failures include:

- `limit: "50"` where schema requires number
- missing `swarmId`
- broker called with `action:"summary"` instead of broker `action:"call"`
- `tool.call(... args:{})` missing inner Swarm action
- Blackboard write omitted `swarmId`

Many are ordinary LLM serialization/protocol errors.

The current single giant parameter Struct makes almost every action-specific field optional and relies on prose/runtime validation.

### 4.8 Creation trap: semantic tags vs provider capabilities

There are two different concepts:

`MemberCapabilities.tags`
- semantic/routing labels such as research, audit, preregistration

`desiredProfile.requestedCapabilities`
- validated against provider/model runtime capabilities such as:
  tools, reasoning, attachment, image, audio, video, pdf, text, etc.

A persisted Swarm used semantic role tags as `requestedCapabilities`:

- `research`
- `preregistration`
- `audit`
- `adversarial`

Those can never satisfy `supportsCapability()`.

Result: durable Swarm and tasks existed, but workers remained unbound with zero task runs.

**This should be impossible to express in the schema.**

---

## 5. Primary failure model

```text
coordinator delegates task
        |
        v
member Session gets assignment
        |
        v
worker performs useful work
        |
        v
worker emits final prose
        |
        X  no durable settlement
        |
lease/runtime owner later disappears
        |
        v
retirement -> superseded
        |
        v
task becomes dispatchable again
        |
        v
same worker receives task again
        |
        v
repetition / confusion / refusal
```

The system currently conflates:

1. execution ended
2. semantic task outcome settled

These should not be identical facts.

---

## 6. Target architecture principles

### P1. Model expresses intent, host resolves identity/authority

Prefer:

```json
{"action":"done"}
```

over:

```json
{
  "action":"task.settle",
  "swarmId":"swr_...",
  "settlement":"completed"
}
```

The host already knows the caller Session and can resolve:

- Swarm
- member
- binding generation
- active task
- task run
- lease token
- task ID

Opaque authority identifiers should not be model inputs when derivable.

### P2. Separate admin/coordinator interface from worker interface

Proposed surfaces:

**lazy admin tool**
`swarm` or `swarm_admin`

- create/delegate
- inspect
- member lifecycle
- task/DAG administration
- recovery
- Swarm lifecycle

**small always-visible managed-worker tool**
`swarm_member`

Candidate actions:

- `status`
- `done`
- `fail`
- `send`
- `inbox`
- `shared.get`
- `shared.put`
- `publish`

It should derive Swarm/member/task identity from the caller Session.

### P3. Execution completion must not cause infinite replay

If an assistant execution finishes normally but does not explicitly settle:

- do **not** automatically claim semantic success
- do **not** leave the task indistinguishably running forever
- transition into a durable state representing "execution result exists; semantic settlement unresolved"
- release/retire execution authority safely after quiescence
- preserve output/evidence
- allow coordinator/reviewer/recovery logic to accept, request changes, retry, or fail

Existing task statuses `review_pending` / `changes_requested` may be useful.

### P4. Dependencies should carry bounded knowledge

A DAG dependency currently gates readiness but does not propagate predecessor knowledge.

Introduce host-built predecessor handoff data:

- predecessor task identity
- outcome
- bounded summary
- deliverables
- artifact refs
- linked shared-state entries
- relevant decision metadata

Do **not** dump predecessor raw context.

### P5. Make invalid creation states unrepresentable

Before first durable write, preflight:

- agent exists
- provider/model/account resolves
- variant exists
- model requirements are supported
- workspace policy is valid
- hard permission boundary is valid
- task keys/names/reservations valid
- DAG acyclic

Rename/string-enum `requestedCapabilities` to `modelRequirements`.

Semantic routing tags remain separate.

### P6. Collaboration must be discoverable without ceremony

Worker-critical actions should not require:

1. discover lazy tool
2. describe tool
3. retain opaque broker contract
4. call broker
5. include redundant Swarm ID

Administrative breadth can remain lazy.

### P7. File sharing should become artifact sharing

A durable artifact should eventually capture at minimum:

- id
- producer member
- task run
- logical path
- hash
- byte size
- media type
- workspace mode
- commit/patch/blob reference where applicable
- creation timestamp

For worktrees, provide a first-class consume/materialize mechanism rather than assuming paths cross worktrees.

### P8. Claims should have typed semantics

Replace opaque scope conventions with typed claims where practical:

- path claim
- lane claim
- logical resource claim

Potentially integrate path claims into mutation tools as warning/deny policy.

---

## 7. Required invariants

### Authority / safety

1. Human focus remains stronger than Swarm synthetic assignment.
2. Peer text remains conversational/untrusted, never privileged instruction authority.
3. Worker actions derive member identity from caller Session.
4. Stale/rebound Sessions cannot settle old tasks.
5. Task settlement cannot trust model-supplied lease/run/generation.
6. Unknown external side effects remain fail-closed until explicitly contained/resolved.
7. Cross-project Swarm actions fail.
8. Worktree/shared-read workspace promises remain hard runtime boundaries.

### Lifecycle

9. A normally ended worker execution cannot stay `working` indefinitely solely because the model forgot a bookkeeping call.
10. Semantic completion is not inferred from generic final prose.
11. Recovery does not repeatedly replay the same already-produced result without a deliberate retry decision.
12. Old owners cannot revive retired authority.
13. Restart convergence is level-triggered and idempotent.

### Ergonomics

14. Ordinary worker completion should require at most one simple tool call.
15. Host-derivable IDs are not required as worker inputs.
16. Action-specific required fields are encoded structurally, not only in prose.
17. Losslessly coercible scalar serialization noise should not create avoidable failures where safe.
18. Agent-role tags cannot be confused with provider/model capability requirements.

### Collaboration

19. DAG completion may gate readiness without requiring predecessor raw context.
20. Handoff injection is bounded and host-generated.
21. Shared state is durable, versioned, and provenance-bearing.
22. Artifact references do not silently claim bytes are durable unless they are.
23. Claims are explicitly documented as advisory until enforcement exists.

---

## 8. Proposed implementation phases

### Phase A — close the catastrophic lifecycle loop

- introduce execution-finished-without-semantic-settlement handling
- prevent endless replay
- preserve result for review
- add durable reason/provenance
- tests for restart, owner loss, human focus, stale run

**Success metric:** synthetic regression of 100 normal worker completions with omitted `done` produces 0 indefinite `working` rows and 0 uncontrolled replay loops.

### Phase B — worker-native facade

- always-visible tiny worker tool
- Session-derived current Swarm/member/task
- `done`, `fail`, `send`, `inbox`, shared state, publish
- no opaque Swarm/member/task IDs for routine worker operations

**Success metric:** a model can complete a task with one `swarm_member.done` call; no broker discovery required.

### Phase C — creation/preflight schema hardening

- validate full execution profiles before durable creation
- enum model requirements
- rename semantic capability concepts
- discriminated action schemas
- safe scalar coercion where unambiguous
- clearer state mutation naming

**Success metric:** invalid model requirements create **zero durable Swarm rows**.

### Phase D — automatic knowledge handoff

- dependency handoff projection
- bounded predecessor summaries/deliverables/shared-state references
- assignment injection
- no raw predecessor history hydration

### Phase E — artifacts and typed claims

- durable artifact semantics
- worktree handoff path
- optional mutation-tool claim enforcement/warnings

### Phase F — operator lifecycle closure

- effect-unknown acknowledgement/containment
- stale/abandoned Swarm closure
- incomplete `creating` reconciliation
- UI for blocked/review-pending/recovery states

### Phase G — E2E + observability

- managed worker starts -> performs work -> settlement path
- omitted settlement -> review-pending path
- peer message roundtrip
- Blackboard CAS
- DAG handoff
- restart mid-task
- worktree member handoff
- invalid profile preflight
- instrumentation counters for:
  - task assignments
  - explicit settlements
  - implicit execution-end transitions
  - operational supersessions
  - semantic retries
  - member materialization failures
  - peer send/delivery/retry
  - collaboration-tool errors

---

## 9. Ten-agent independent implementation/research lanes

Each delegate must:

- read repository `AGENTS.md` and relevant nested contracts
- read this ledger before work
- inspect live source before changing anything
- preserve unrelated dirty changes
- never use OpenSwarm
- run focused tests for its lane
- report exact files changed, tests, unresolved risks
- prefer narrow architectural ownership over call-site patches
- do not commit unless explicitly instructed
- coordinate through the master; do not assume another delegate's incomplete edits are correct

### Lane 1 — Execution closure / anti-replay lifecycle

Own:
- task-run execution end semantics
- post-execution unresolved settlement state
- safe lease release/retirement
- anti-replay invariants
- recovery tests

Primary areas:
- `packages/core/src/swarm/*`
- `packages/opencode/src/swarm/task-retirement.ts`
- Session execution completion integration
- focused tests

Avoid worker-tool/API design except interfaces required by lifecycle.

### Lane 2 — Worker-native coordination facade

Design/implement smallest always-visible managed-worker tool.

Own:
- Session-derived membership/current-task lookup
- done/fail
- peer send/inbox
- shared get/put
- publish

Primary:
- `packages/opencode/src/tool/*`
- registry/exposure only as required
- Swarm Core APIs reused, not duplicated

Do not change coordinator/admin lifecycle semantics.

### Lane 3 — Delegate creation preflight + profile schema

Own:
- preflight full managed-member execution profiles before first durable write
- `requestedCapabilities` redesign / enum / naming
- semantic routing tags separation
- zero-partial-creation tests

Primary:
- `packages/schema/src/swarm.ts`
- `packages/opencode/src/swarm/command.ts`
- `member-session.ts`
- tests/migrations only if truly required

### Lane 4 — Agent-facing schema ergonomics

Own:
- action schema discrimination
- action names
- safe coercion strategy
- human-facing member/task references where authority remains host-derived
- reduce raw ID burden

Primary:
- `packages/opencode/src/tool/swarm.ts`
- `swarm.txt`
- tests

Must preserve current dirty settlement-description work.

### Lane 5 — DAG knowledge handoff

Own:
- bounded predecessor handoff projection
- summary/deliverable/shared-state linkage
- assignment injection
- token/byte bounds
- provenance/trust fencing

Primary:
- Core swarm task/dependency projection
- `SwarmRender.assignment`
- admission path
- tests

No raw predecessor Session-history hydration.

### Lane 6 — Shared knowledge / Blackboard evolution

Own:
- Blackboard semantics for findings/decisions/constraints
- provenance / tagging / task relevance
- bounded retrieval for assignment handoff
- permission naming analysis (`swarm.memory`)

Primary:
- shared-state schema/domain
- projection APIs
- tests

Do not build autobiographical/global memory.

### Lane 7 — Artifact/file handoff

Own:
- durable artifact model proposal/implementation
- hashes/size/media type/provenance
- shared-write vs worktree semantics
- consume/materialize design

Primary:
- Swarm deliverables/shared state
- worktree integration only where authoritative

Must clearly distinguish "path reference" from "durable artifact bytes".

### Lane 8 — Claims + write collision prevention

Own:
- typed claims
- optional integration with edit/write/patch
- expiration/release semantics
- warning vs deny policy
- deadlock/false-positive analysis

Primary:
- Swarm claims
- mutation tool boundaries

Must not introduce hidden global locks.

### Lane 9 — Recovery / abandoned aggregate closure

Own:
- `effect-unknown` containment/ack path
- old `creating` Swarm recovery/abort
- stale active Swarm closure
- retiring lease operator semantics
- restart convergence

Primary:
- recovery/deadline/retirement services
- Core state machine
- tests

Preserve fail-closed external-effect uncertainty.

### Lane 10 — E2E, telemetry, and operator UX

Own:
- end-to-end test plan and implementation
- instrumentation counters
- UI states/actions for review-pending, blocked, recovery
- prove model-facing workflows rather than only unit APIs

Primary:
- app Swarm panel
- server/OXP test harness
- runtime observability

Must avoid consumer-first reconstruction; use compact authoritative projections.

---

## 10. Cross-lane coordination rules

Potential overlap hotspots:

- `packages/core/src/swarm/render.ts` — currently dirty
- `packages/opencode/src/tool/swarm.ts` — currently dirty
- `packages/schema/src/swarm.ts`
- Core state-machine/schema
- tool registry/exposure

Master coordinator owns final merge decisions.

Delegates encountering overlap should:
1. inspect current diff first;
2. avoid broad reformatting;
3. make minimal additive changes;
4. report conflict explicitly;
5. never discard unknown modifications.

---

## 11. Required test matrix

### Domain

- duplicate member/task validation
- invalid model requirement preflight
- DAG cycles
- dependency readiness
- task lease fences
- stale Session settlement rejection
- execution-end unresolved settlement
- explicit done/fail
- human-focus hold
- lease owner loss
- restart recovery
- peer send/broadcast/delivery retries
- Blackboard CAS
- claims
- deliverables/artifacts

### Runtime

- materialize managed worker with supported model
- fail before Swarm creation for unsupported model requirements
- assignment -> one worker completion -> explicit settle
- assignment -> worker final turn -> no settle -> review-pending, no replay storm
- peer message -> recipient Session
- urgent peer steer
- coordinator vs worker authority
- worktree member
- shared-read hard mutation denial

### Model-facing UX

- no broker needed for routine worker `done`
- no Swarm ID needed for routine member actions
- state mutation naming is unambiguous
- numeric-string safe coercion if adopted
- structured schema rejects missing required action-specific fields before runtime

### E2E

- create 3-member Swarm
- task A and B in parallel
- A publishes finding/artifact
- C depends on A and receives bounded handoff
- B sends peer message to C
- restart runtime mid-run
- all tasks converge without duplicate semantic execution
- final Swarm can reach terminal status cleanly

---

## 12. Quantitative success criteria

Target after implementation:

1. **0 uncontrolled task replay loops** in deterministic restart/owner-loss tests.
2. **100% worker completion-path closure** into completed/failed/review-pending/blocked — never indefinite `working` after execution quiescence.
3. **0 partial durable Swarms** for invalid agent/provider/model/variant/model-requirement input.
4. Routine worker completion requires **1 tool call**.
5. Routine worker actions require **0 opaque Swarm/member/task IDs** when caller Session provides identity.
6. DAG handoff consumes bounded bytes independent of predecessor raw history length.
7. Artifact metadata cryptographically identifies published content if content durability is claimed.
8. E2E test exercises peer write + shared-state write + deliverable/artifact path, not only reads.
9. Observability distinguishes:
   - semantic failure
   - operational owner loss
   - admission conflict
   - user preemption
   - missing settlement
   - model/profile materialization failure

---

## 13. Existing dirty changes that must be preserved

At ledger creation time the relevant Swarm working-tree modifications are:

- `packages/core/src/swarm/render.ts`
  - strengthens assignment envelope with exact lazy-broker `task.settle` instructions
- `packages/opencode/src/tool/swarm.ts`
  - adds `SWARM_ACTIONS`
  - adds per-action requirements prose
  - expands description with those requirements

These are **evidence and active work**, not disposable experiments.

Delegates must diff before edits and merge around them.

---

## 14. Open architectural questions

1. What exact durable state should represent "execution ended, semantic result not explicitly settled"?
2. Should `review_pending` be reused or should a distinct task-run state represent execution closure while task remains unresolved?
3. Should the host ever auto-complete a task based on an acceptance protocol, or should explicit completion/reviewer acceptance always remain required?
4. Should the worker facade be a separate provider-visible tool or a session-scoped synthetic capability?
5. How should tiny worker facade exposure interact with prompt-cache/tool-manifest stability?
6. How much predecessor knowledge should be injected automatically?
7. What is the authoritative artifact storage layer for worktree-to-worktree transfer?
8. Should path claims warn or hard-block mutation?
9. What is the operator protocol for resolving `effect-unknown` after a dead owner?
10. What state transition closes abandoned `creating` or stale `active` Swarms without deleting audit history?
11. Should coordinator-created initial members/tasks remain one fail-closed command, or should there be a durable proposal/preflight object?
12. Which Swarm counters belong in the existing telemetry system vs a Swarm-specific compact projection?

---

## 15. Decision discipline

Every proposed change must identify:

- authoritative owner
- exact invariant strengthened
- failure mode addressed
- behavior under process crash
- behavior under Session deletion/rebind
- behavior under human input
- behavior under stale tool/model output
- migration/storage impact
- boundedness/performance cost
- focused tests
- whether it changes model-facing contract

Prefer removing model responsibilities over adding more prompt prose.

---

## 16. Current working hypothesis

The shortest path to a robust native Swarm is:

1. **close execution lifecycle in the host**
2. **give managed workers a tiny direct intent API**
3. **preflight all creation profiles before durable activation**
4. **make dependencies carry bounded structured knowledge**
5. **promote file references into real artifacts**
6. **finish operator/recovery closure**
7. **measure real Swarm behavior with E2E telemetry**

The backend already contains the hard distributed-systems pieces. The next pass should make those guarantees usable by ordinary models rather than expecting models to correctly operate the distributed system themselves.

---

## 17. Coordinator closeout — 10-agent implementation wave

### 17.1 Delegation record

The implementation/review wave was executed as one supervised OXP batch:

- batch: `grp_f00ce4d8affemEF5smY3QnSVcX`
- model for all delegates: `opencode/space-bunny-free`
- nested delegation: disabled
- repository: the main `/webstormprojects/opencode` worktree only
- OpenSwarm: **not used**
- commits: **none created by this work**

Workers/lane ownership:

1. `ses_f00ce4d87ffeT2XZd1Tz2U7JGu` — execution closure / anti-replay
2. `ses_f00ce4d26ffe9n6o173kVZjUou` — worker-native coordination facade
3. `ses_f00ce4cdeffe0GNHZiRAI6eqPY` — creation preflight / model requirements
4. `ses_f00ce4c64ffedOLnVbqEPoJ2Ze` — admin-tool schema ergonomics
5. `ses_f00ce4badffeygS73kDBhA2DPt` — DAG knowledge handoff
6. `ses_f00ce4accffeRYaY4zK1tfMT87` — Blackboard/shared knowledge
7. `ses_f00ce4a34ffehUOPYrY3BUpVar` — artifact/file handoff semantics
8. `ses_f00ce4a03ffeff916QjsBJLL9m` — typed claims/collision semantics
9. `ses_f00ce4924ffd23BuZCfYs3yM3P` — recovery/effect containment/aggregate closure
10. `ses_f00ce4878ffeNPt1gOhg1XRSGi` — E2E/observability

The coordinator actively inspected live Session output, rejected one out-of-root permission request, redirected overlapping lanes, separated Lane 1 vs Lane 9 recovery ownership, protected concurrent schema edits, caught partially applied patches, rejected an unsound session-wide completion-marker design, and took over the final integration gate rather than accepting delegate output wholesale.

### 17.2 Final accepted lifecycle model

The original DB failure mode was:

```text
worker does useful work
    -> model forgets task.settle
    -> task remains working
    -> owner disappears/expires
    -> run superseded
    -> task ready
    -> same semantic task executes again
```

The final system now separates four different facts that were previously conflated.

#### A. Explicit semantic settlement

Preferred worker path:

```text
swarm_member.done
swarm_member.fail
```

The host derives Swarm/member/task/run/lease authority from the caller Session. The model does not provide opaque authority identifiers.

#### B. Natural execution end without semantic settlement

A normal, non-aborted `session.idle` is host-owned evidence that the local turn ended.

If the exact task run still has active authority after the Session execution owner releases, `SwarmTaskClosure` settles it as:

```text
run.status  = unsettled
task.status = review_pending
```

This prevents immediate replay without pretending semantic success.

Important boundaries:

- arbitrary `poke()` is not completion evidence;
- startup scanning cannot manufacture completion;
- an aborted idle is not completion;
- a live execution owner blocks closure;
- an idle event that races owner release is retried at one bounded timer;
- unresolved tool effects remain fenced.

#### C. Crash after a successful exact assignment cycle

The canonical Session runtime now records completion on the **exact SessionInput row that drove the successful provider cycle**:

```text
session_input.completed_seq
```

`SessionRunner` publishes `SessionInput.complete()` only for the exact cycle source input after a successful, non-yielded, non-provider-failed turn.

This is intentionally stronger than a Session-wide timestamp/high-watermark:

- the assignment input itself must exist;
- it must have been promoted;
- it must not be revoked;
- completion is idempotently projected onto that exact row;
- later peer/user turns cannot retroactively create completion proof for an earlier assignment.

When owner-loss / lease-expiry / recovery retirement wins the race, `SwarmTaskRetirement` inspects the exact run's SessionInput:

```text
completed_seq exists + no unresolved tool hazard
    -> unsettled / review_pending
    -> never immediate redispatch

completed_seq absent
    -> ordinary operational supersession/retry
```

This closes the original crash-after-result replay path without inferring completion from transcript prose or from process death.

Migration note: the accepted mechanism adds nullable `session_input.completed_seq` through
`20261003040000_session_input_completion.ts`. Lane 1B independently replayed the full
migration chain and confirmed the column remains nullable with no default. The migration
registry already had one pre-existing orphan checksum before this pass, and
`packages/core/schema.json` is concurrently dirty from unrelated work; this pass therefore
did not regenerate or rewrite unrelated generator state. The new migration/checksum/import
pair was inserted without remapping existing registered pairs.

#### D. Unknown external effects

Unresolved mutating tool effects remain stronger than either quiet closure or input completion.

```text
effect-unknown
    -> retain fence
    -> recover.effects surfaces it
    -> explicit recover.contain acknowledgement
    -> contained_unknown
    -> review_pending
    -> explicit reviewer decision required
```

Containment never claims whether the external effect happened.

### 17.3 Rejected anti-replay design

An intermediate proposal introduced Session-wide `completed_at` / `completed_through_seq` execution-owner state.

The coordinator rejected and removed it because:

- time is not task identity;
- a later Session cycle could make an earlier task look completed;
- admission/mark/release crash ordering was subtle;
- it created unnecessary Session ownership semantics to solve a per-input problem.

Final repository search confirms no remnants of:

- `session_execution_completed_at`
- `completed_through_seq`
- `completedExecution`
- `markCompleted`

The accepted authority is exact per-input `completed_seq`.

---

## 18. Agent-facing protocol after the pass

### 18.1 Managed workers no longer need the lazy admin broker for routine work

A small `swarm_member` tool is available directly to managed workers.

Core design rule:

> The agent expresses intent; OpenFork resolves authority.

Routine completion is now one call and requires no:

- Swarm ID
- member ID
- task ID
- lease generation
- task-run ID
- binding generation

The assignment envelope explicitly teaches the direct `swarm_member` route. The older lazy `swarm` broker settlement path remains only as a labeled compatibility fallback.

### 18.2 Coordinator/admin surface is still broad and lazy

The broad `swarm` tool remains appropriate for coordinator/operator administration.

Ergonomic improvements include:

- canonical `set_status`; `state` retained as deprecated alias;
- action-specific required-input validation at decode time;
- missing/blank field diagnostics before execution;
- one-of recipient/broadcast validation;
- typed failure requirements;
- rejection of model-supplied settlement authority;
- safe lossless integer-string normalization where interpretation is unambiguous;
- bounds remain strict.

Recovery/review actions now include:

- `recover.effects`
- `recover.contain`
- `task.review`

---

## 19. Creation/profile hardening

The semantic-tag/model-capability ambiguity has been removed from the current contract.

### Current schema

`MemberExecutionProfile.modelRequirements` is a closed vocabulary of provider/model facts.

Semantic routing metadata stays in member capabilities/tags and cannot be supplied as a model requirement.

Legacy `requestedCapabilities` rows are normalized at the durable-to-contract projection boundary:

- recognized runtime aliases -> canonical model requirements;
- known semantic tags -> reported routing tags;
- unknown values -> explicit unproven/fail-closed compatibility signal;
- the retired key is never re-encoded.

### Preflight ownership

One `SwarmProfilePreflight` owner validates:

- agent
- provider/model/account resolution
- model variant
- model requirements
- authoritative workspace-directory identity

It is invoked before durable profile mutation on:

- initial `delegate`
- managed-member materialization
- model-facing `member.add`
- OXP `member.add`
- HTTP `memberAdd`
- HTTP `memberConfigure`

Invalid profiles therefore fail before creating a permanently unbound worker.

---

## 20. Collaboration improvements

### 20.1 Dependency handoff

Task dependencies now transmit bounded structured knowledge, not just readiness.

The host-generated handoff can carry:

- predecessor task identity/title
- durable outcome
- exact successful-run member provenance
- the bounded successful `TaskRun.resultSummary` authored through `swarm_member.done(summary)` / completed `task.settle`
- separately published deliverable summaries and structured deliverables
- relevant shared-state entries
- explicit omission/truncation metadata

Successful-run result and deliverable-summary evidence deliberately remain separate provenance classes.
The worker's successful self-report is stored on the exact TaskRun, not copied onto Task state and
not recovered from final prose. A non-empty successful summary without an exact TaskRun is refused
rather than silently dropped.

Bounds are layered:

- durable successful TaskRun result: **4 KiB UTF-8**
- dependency-handoff successful result per predecessor: **512 UTF-8 bytes**
- deliverable summary budget remains separate
- existing per-predecessor and whole-handoff byte ceilings still apply

It is deterministic, byte-bounded, provenance-bearing, injection-fenced, and never hydrates
predecessor raw Session history. A bounded result that does not fully fit is explicitly marked
`[truncated]`; omission is never presented as full fidelity.

### 20.2 Shared knowledge

Blackboard remains durable shared **working knowledge**, not shared autobiographical/global model memory.

The new knowledge projection:

- ranks receiving-task > related-task > Swarm scope;
- is deterministic;
- charges provenance and value bytes;
- bounds related-task predicates and SQL row hydration;
- reports omitted/truncated retrieval instead of pretending completeness.

### 20.3 Artifact contract

The pass introduced truthful artifact semantics:

- workspace-path references remain path references;
- durable claims require verifiable content identity/backing;
- Git object/content-store forms carry durable identity;
- worktree-to-worktree consumption fails closed unless a safe backing exists;
- media type/path normalization and durability claims are validated.

This is an artifact **contract + consumption plan**, not a claim that OpenFork now has an unlimited general-purpose blob store.

### 20.4 Claims

Claims now have typed path/lane/resource semantics with:

- normalized encoding
- overlap calculation
- liveness/expiry/release handling
- concurrency tests proving exactly one winner for overlapping typed acquisition

Legacy opaque claims remain advisory for compatibility.

The mutation-boundary integration is intentionally conservative: typed claims can be probed for collision, but this pass does not introduce a hidden global filesystem lock or claim that every write tool is hard-blocked by claims.

---

## 21. Recovery and operator closure

Accepted recovery policy:

- heartbeat age is suspicion, never death proof;
- dead-owner authority remains generation fenced;
- unresolved external effects are never auto-sealed;
- explicit containment produces `contained_unknown`, not success/failure;
- contained tasks remain non-dispatchable until review;
- reviewer decisions are fenced to observed lease generation;
- ordinary unattended retirement still uses operational supersession;
- empty abandoned `creating` aggregates may close fail-safe;
- partially materialized `creating` aggregates remain visible;
- idle `active` Swarms are surfaced, not automatically terminated.

---

## 22. E2E and observability

The provider-free E2E harness now exercises production durable owners/projectors rather than mocking task-run state directly:

1. create/activate Swarm topology
2. materialize managed worker bindings
3. claim a DAG-ready task
4. admit synthetic assignment
5. let `SwarmSessionProjector` create the task run
6. promote assignment
7. exercise unsettled closure / explicit settlement / human preemption
8. round-trip peer mail with delivery fencing
9. assert DAG readiness and anti-replay behavior

Compact reliability telemetry distinguishes:

- explicit semantic settlement
- quiet/unsettled closure
- operational supersession
- semantic failure/retry
- unowned live runs
- expired leases
- configured-but-unbound workers
- peer/shared-state/claim/deliverable activity

Coordinator/model-facing observability now also exposes the existing Core `taskRunHistory`
projection as native/OXP `task.runs`:

- newest-first and bounded to 1-200 rows;
- optional task filter;
- exact TaskRun member / Session / binding generation / lease generation;
- failure detail and successful `resultSummary`;
- keyset pagination using the existing `(time_created, id)` cursor (`response.next` -> `runCursor`);
- `swarm.read` authority and the normal project/root fences;
- no Session transcript/history hydration.

HTTP already exposed the same Core run-history projection, so this closes an interface asymmetry
rather than creating a second read model.

This is the correct measurement layer for comparing post-fix behavior to the original DB baseline.

---

## 23. Verification record

Final native-Swarm-focused verification:

| Surface | Result |
|---|---:|
| Core native Swarm suite | **179 / 179 pass** |
| OpenCode native Swarm/runtime/tool/OXP/registry suite | **148 / 148 pass** |
| Schema Swarm contract | **9 / 9 pass** |
| Tool + OXP + HTTP Swarm surfaces | **40 / 40 pass** |
| Registry / OXP / OFXP parity + eager/lazy policy | **38 / 38 pass** |
| Post-flatten broker / registry / direct-create focused gate | **53 / 53 pass** |
| Core package typecheck | **clean** |
| OpenCode package typecheck | **blocked by 1 unrelated concurrent semantic-executor test diagnostic; 0 Swarm diagnostics** |
| Schema package typecheck | **clean** |
| Migration replay / checksum | **28 / 28 pass** |
| Migration generator consistency | **clean — no ungenerated schema changes** |
| SDK v2 generation | **clean — TaskRun.resultSummary generated** |
| Exact SessionInput completion tests | **5 / 5 pass** |
| Exact-input retirement anti-replay tests | **5 / 5 pass** |
| Rejected completion-marker orphan search | **0 matches** |
| Swarm-owned scoped `git diff --check` | **clean** |

The fresh post-flatten OpenCode package-wide typecheck currently has one unrelated concurrent
diagnostic in `test/tool/semantic-executor.test.ts` (a `PolicyDenied` effect typing mismatch).
No `src/swarm/*`, `test/swarm/*`, `src/tool/swarm*`, OXP Swarm, registry/parity, or Swarm HTTP
diagnostics remain. Core and Schema package typechecks are clean.

The working tree was intentionally not committed because it contains substantial unrelated concurrent work.

---

## 24. Live smoke result and remaining validation / product work

### 24.1 First live model-facing smoke: authority boundary + creation-order defect

A fresh smoke was attempted through the real model-facing `swarm` tool rather than through
the OXP delegate facade. Tool discovery succeeded, the native Swarm contract was available,
and profile preflight accepted `opencode/space-bunny-free`.

The smoke coordinator itself was an OXP-supervised Session, so Core correctly rejected it as
a Swarm coordinator:

```text
Swarm members must bind ordinary interactive Sessions; <session> is producer-owned.
```

That rejection is intentional. OXP/scheduled/delegated producer Sessions must not be able to
masquerade as ordinary interactive Swarm members.

The smoke did expose one real creation-order defect, however. Before this correction,
`SwarmCommand.delegate` executed:

```text
validate
-> profile preflight
-> Swarm.create()              # first durable write
-> addMember(coordinator)      # Session authority rejection happened here
```

A deterministic invalid coordinator could therefore leave an empty `creating` aggregate
before the request failed. It was not permanently leaked — existing aggregate recovery
treats a completely empty `creating` Swarm as abandoned after
`ABANDONED_SWARM_STALE_MS = 15 minutes` — but this was unnecessary durable churn and made
the failed creation temporarily unreclaimable through coordinator-scoped native actions.

The accepted fix keeps Session authority in Core:

- Core now exposes a read-only `preflightMemberSession` that reuses the same root /
  producer-ownership / project / workspace checks as real member binding.
- `SwarmCommand.delegate` runs that coordinator preflight before `Swarm.create()`.
- `addMember` still re-runs the authoritative validator inside its commit path, so the
  preflight does not replace transactional race protection.
- the existing abandoned-`creating` recovery remains the fail-safe for genuine crashes or
  TOCTOU races between preflight and coordinator commit.
- external connector-created Swarms with no bound coordinator Session remain supported;
  preflight runs only when a `coordinatorSessionID` is supplied.

Regression coverage proves zero Swarm/member/task rows for coordinator Sessions that are:

- producer-owned;
- child Sessions;
- from the wrong project;
- from the wrong workspace.

The valid coordinator path still creates the coordinator, workers, DAG tasks, dependencies,
and activates exactly once. OXP's connector-owned unbound-coordinator path also remains green.

### 24.2 Ordinary interactive live Swarm — result-loss discovery

The ordinary-root smoke was then run through a real CLI root Session in the repository rather
than through a producer-owned OXP worker.

Smoke identity:

- coordinator Session: `ses_f0040084fffeeGvCUNJHBUfUDX`
- Swarm: `swr_f003f3914ffeR917hKaWrS0x65`
- two managed `opencode/space-bunny-free` workers
- two-task `require_success` DAG
- shared-read workers; no coordinator task settlement

Both workers materialized and self-settled with `swarm_member.done`; the DAG promoted correctly,
semantic retries stayed at zero, recovery surfaces stayed clean, and the Swarm reached
`completed`.

That smoke exposed a second real defect: Task A called `swarm_member.done(summary)`, but the
summary existed only in the immediate tool response. Durable settlement was only
`{ type: "completed" }`, so Task B's generated predecessor handoff contained identity/title,
outcome, and retry count but **not A's substantive result**. With zero separately published
deliverables, B correctly reported the handoff was insufficient.

Accepted correction:

- add nullable/no-default `swarm_task_run.result_summary`;
- migration: `20261003041000_swarm_task_run_result_summary.ts`;
- Core trims and UTF-8-bounds a successful result before the same settlement transaction writes it;
- historical rows remain NULL rather than receiving fabricated results;
- non-empty successful summary without the exact TaskRun is rejected;
- `swarm_member.done(summary)`, native fallback `task.settle(resultSummary)`, and OXP supervised
  settlement all converge on the same Core field;
- handoff carries exact `resultMemberID` + `resultSummary` separately from deliverable evidence;
- terminal-run selection is status-correlated: the run must match the predecessor task's current
  terminal status and is ordered by `ended_at DESC, id DESC`, so a later-created superseded trace
  cannot replace the run that actually explains `task.status=completed`;
- retries select the latest successful completed result, never an earlier failed attempt;
- durable successful-run results are capped at **4 KiB UTF-8** before SQLite;
- handoff keeps at most **1 KiB** of successful-run result, **512 B** of deliverable-summary text,
  **2 KiB per predecessor**, and **16 KiB total**, all with explicit truncation/omission accounting;
- raw predecessor Session history is still never read.

### 24.3 Post-fix live result-handoff smoke — PASS

A second ordinary interactive smoke tested the corrected path with **zero deliverables**, making
the TaskRun result the only possible substantive predecessor handoff.

Identity:

- coordinator Session: `ses_effeab344ffeBE1cR9sMbjCbC3`
- Swarm: `swr_effea63e6ffeglu75U5gpsx4Qw`
- A member: `swm_effea63ddffeFFFLFKEZgurnBv`
- A TaskRun: `swrn_effea639cffe4Xjtyuqpcg8Q1D`
- B member: `swm_effea63d8ffels8XuJB6CGtp23`
- B TaskRun: `swrn_effea4addffeXDhzKABYhUgWIL`

Task A self-settled with a result beginning:

```text
HANDOFF_RESULT_V2_20261003
```

Task B was forbidden to read the ledger or A's Session/history. Its own host-generated assignment
contained:

- predecessor task identity/title;
- `outcome=completed`;
- exact successful-run member provenance;
- the `HANDOFF_RESULT_V2_20261003` marker;
- A's substantive successful-run result, explicitly byte-bounded.

B self-settled and reported the generated handoff **SUFFICIENT** on its own. It explicitly stated
that it did not read predecessor Session history or repository files.

Post-completion native reads showed:

- both tasks completed by worker self-settlement;
- semantic retries: 0;
- messages: 0;
- deliverables: 0;
- unresolved recovery effects: 0;
- unresolved members: 0;
- Swarm lifecycle closed to `completed`.

The handoff's then-current **512-byte** successful-result projection truncated A's longer result and
marked it `[truncated]`. B still had enough information for that task, but the live run established
that 512 B was too aggressive for an ordinary concise multi-fact result. This became empirical input
to the later V3 tuning rather than an excuse to make the handoff unbounded.

### 24.4 Coordinator result observability — gap discovered and closed

The V2 coordinator initially could not independently read either worker's durable result without
opening worker Session history: `get` exposes Task state, not TaskRun result data.

Rather than duplicating result state onto Task, the pass exposed the already-authoritative Core
TaskRun history as `task.runs` on native/OXP surfaces. HTTP already had the equivalent runs read.

The **same coordinator Session** was resumed after this addition and, using `task.runs` only,
verified:

- A's exact run/member/Session/binding/lease provenance;
- A's full durable result and exact marker;
- B's full durable result and explicit `SUFFICIENT` verdict;
- B's explicit declaration that it used the generated handoff only;
- one run per task, no hidden attempts.

The resumed coordinator process exited 0 and performed no mutation. This closes the observability
gap without weakening the no-transcript architecture.

`task.runs` is bounded and keyset-pageable. The prior `get(taskId=...)` misuse discovered during
the smoke now fails at the schema boundary and directs callers to `task.runs` instead of silently
ignoring the filter.

### 24.5 V3 full-fidelity result-handoff smoke — PASS

A third ordinary interactive smoke re-ran the exact same architectural path after increasing only
the successful-run handoff budget. It deliberately used **zero deliverables, zero Blackboard writes,
zero peer messages, and zero predecessor Session/history reads** so the exact TaskRun result was the
only possible substantive handoff.

Identity:

- coordinator Session: `ses_effde5d34ffeCFYDnAuuunkEN2`
- Swarm: `swr_effddacf0ffeikI8FXoVeMdeOg`
- coordinator member: `swm_effddacecffeS4E8UT715W5aXa`
- A member/session:
  `swm_effddace1ffey6YkASXpGEecp5` /
  `ses_swarm_swm_effddace1ffey6YkASXpGEecp5_1`
- B member/session:
  `swm_effddacd9ffeOxnFvAY7NlaZDY` /
  `ses_swarm_swm_effddacd9ffeOxnFvAY7NlaZDY_1`

Task/run evidence:

- A task `swt_effddacd2ffesJVAjlLrM54RWm`
  -> run `swrn_effddac76ffeWYxVcuGaCPEfn0`
  -> `completed`, binding/lease generation **1 / 1**
- B task `swt_effddacd2ffdH96zqYE4L8yNfv`
  -> run `swrn_effdc8804ffexvibh0AV4sJ709`
  -> `completed`, binding/lease generation **1 / 1**
- B was admitted **16 ms after A's run ended**, matching the `require_success` dependency
  without an extra attempt.
- each task had exactly one run; semantic retry count remained 0.

A self-settled with an **837-byte** result whose first and final markers were:

```text
HANDOFF_RESULT_V3_20261003
...
END_HANDOFF_V3
```

B's injected predecessor handoff contained:

- predecessor task identity/title;
- exact successful-run member provenance;
- `outcome=completed`;
- the complete `HANDOFF_RESULT_V3_20261003 ... END_HANDOFF_V3` result;
- **no `[truncated]` marker**.

B explicitly reported that the three facts were fully understandable from the host-generated
handoff alone and that it did **not** open A's Session/history or re-read the repository/ledger.
B then self-settled through `swarm_member.done`.

The coordinator audited both exact TaskRuns through bounded `task.runs`, then transitioned the
Swarm to `completed`. The CLI process exited **0**. There were:

- 0 semantic retries;
- 0 `review_pending` tasks;
- 0 `contained_unknown` outcomes;
- 0 peer messages;
- 0 deliverables;
- 0 shared-state side channels;
- no coordinator settlement on a worker's behalf.

The V2 -> V3 pair gives an empirical bound decision rather than a speculative one:

```text
512 B successful-result handoff -> normal three-fact result truncated
1 KiB successful-result handoff -> 837-byte result transferred in full
```

The system remains hard-bounded at 4 KiB durable result / 1 KiB handoff result / 2 KiB per
predecessor / 16 KiB total; V3 improves fidelity without returning to unbounded context sharing.

### 24.6 Direct-creation UX iteration — nested facade failure -> flattened one-call PASS

The V3 coordinator exposed one remaining model-facing ergonomics defect even though the Swarm
itself succeeded: initial creation through the generic lazy broker took **three attempts**:

1. the model first used the target action `delegate` as the broker action;
2. the second attempt mis-shaped the nested creation arguments;
3. the third brokered call finally created the Swarm.

The broad Swarm surface should remain compressed for prompt-prefix/cache stability, so the accepted
direction was **not** to make all of `swarm` eager and not to add generic broker argument guessing.
OpenFork instead exposes one narrow eager `swarm_create` facade while broad read/admin/recovery
remains on lazy `swarm` and managed workers continue to use eager `swarm_member`.

#### Intermediate eager facade: broker fixed, nested member shape still fragile

The first creation-only facade removed the broker ceremony but initially reused the compatibility
member wire shape:

```text
members[].desiredProfile
members[].workspacePolicy
```

A stricter ordinary-root smoke then required **exactly one** direct creation attempt and prohibited
retries. The model immediately found `swarm_create` and made **0 broker calls**, but placed
`workspacePolicy` at the wrong structural level. Schema validation rejected the call before any
durable write.

Observed acceptance metrics for that failed smoke:

```text
swarm_create calls before stop = 1
broker calls before creation   = 0
creation retries               = 0
durable Swarm writes           = 0
```

This was important evidence: making creation eager solved the broker/action failure class, but merely
moving the same deeply nested creation schema into an eager tool did **not** make creation intuitive.

#### Accepted direct creation contract: flat member projection

The final provider-facing `swarm_create` member wire shape is intentionally flatter than the
lazy/admin/OXP compatibility shape:

```text
name
role
agent
providerID
modelID
permissionBoundary
workspace?          # defaults to shared-read
accountID?
variant?
modelRequirements?
worktreeBaseRef?
capabilities?
```

The adapter reconstructs the canonical Core structures internally:

```text
desiredProfile
workspacePolicy
```

so this is only a better model-facing projection, not a second authority model or scheduler.
Initial tasks/dependencies continue to share the exact lazy/admin task schema.

Additional hardening:

- no `action`, broker `contract`, Swarm/member/task/run ids, project/workspace ids, or coordinator
  Session id can be model-supplied;
- `SwarmCommand.delegate` remains the one creation workflow and still performs profile/coordinator
  preflight before durable activation;
- a broad `swarm: deny` also denies `swarm_create`; an explicit create allow cannot punch through
  the broader deny;
- manifest visibility remains stable for prompt-prefix/cache reuse;
- `swarm_create` is workspace-read-only for Snapshot purposes because the call mutates durable
  orchestration state only. Worktree materialization, when requested, happens later under the
  managed-member runtime owner;
- the generic lazy broker now gives a deterministic routing diagnostic when a target action such as
  `delegate` is mistakenly supplied as the broker action. It never guesses the target, repairs
  arguments, or executes speculative input.

Measured provider JSON-schema cost after flattening:

```text
swarm_create = 3,817 bytes
swarm_member = 2,223 bytes
full swarm   = 11,244 bytes
eager total  = 6,040 bytes
```

Regression gates cap `swarm_create` below **5 KiB** and the two eager Swarm intent surfaces together
below **7 KiB**. A registry regression also asserts that the direct member schema exposes flat
execution fields and never regresses to `desiredProfile` / `workspacePolicy` wrappers.

#### Final ordinary-root one-attempt smoke — PASS

The exact one-attempt smoke was repeated against the flattened provider schema without teaching the
model the field layout. The provider contract itself was the only shape guidance.

Identity:

- coordinator Session: `ses_effbea424ffeCKRTWTQUevXF0e`
- Swarm: `swr_effbe7acbffegnVpLSfJz07l3b`
- coordinator member: `swm_effbe7ac7ffevO6nUmqSQ8YrXU`
- worker member/session:
  `swm_effbe7ac1ffeC8wY6YZ7kR7njN` /
  `ses_swarm_swm_effbe7ac1ffeC8wY6YZ7kR7njN_1`
- task: `swt_effbe7abbffeABHCMNs1Aph5E3`
- TaskRun: `swrn_effbe7a7effeAL1eBEtWv2t1Dn`

The model's **first and only** creation payload correctly placed all worker execution/workspace fields
inside `members[0]`; no legacy wrappers appeared.

Observed chronology:

```text
1. swarm_create(...)               -> success
2. tool(list)                      -> monitoring only
3. tool(describe, swarm)           -> monitoring only
4. swarm get/task.runs             -> audit
5. swarm set_status(completed)     -> terminal lifecycle
```

Acceptance metrics:

- direct `swarm_create` calls: **1**;
- broker calls before creation: **0**;
- malformed creation calls: **0**;
- creation retries: **0**;
- exactly one worker TaskRun;
- worker materialized on binding generation 1;
- worker self-settled through `swarm_member.done`;
- run status: `completed`;
- semantic retry count: 0;
- durable `resultSummary` present on the exact TaskRun;
- no `review_pending` fallback;
- coordinator never called `task.settle` on the worker's behalf;
- final Swarm state: `completed`, revision 2;
- CLI process exited **0**.

The measured coordinator creation path therefore moved through three empirically distinct stages:

```text
lazy composite broker      -> 3 attempts
eager + nested member wire -> 1 failed attempt, 0 writes
eager + flat member wire   -> 1 successful attempt, 0 retries
```

This preserves compressed long-tail administration while making the common creation intent direct
and substantially harder for an ordinary model to mis-shape.

### 24.7 Remaining highest-value experiment: volume telemetry

The basic real-agent happy path, self-settlement, dependency result handoff, coordinator
TaskRun audit, and one-call creation UX are now proven live. The remaining proof obligation is
**distributional** rather than architectural: collect enough fresh real-workload Swarms to compare
post-fix telemetry to the original database baseline.

Capture:

```text
task assignments
explicit swarm_member done/fail
quiet unsettled closures
exact-input crash closures
operational supersessions
semantic retries
member materialization failures
peer messages sent/delivered/retried
Blackboard writes/reads
deliverables/artifacts published
claim acquisitions/conflicts
review_pending -> review decisions
TaskRun result-summary presence/truncation
```

The success criterion remains a dramatic collapse of the historical pattern:

```text
127 runs
120 superseded
0 task.settle
```

A useful worker result should now end in one of:

```text
explicit completed/failed with exact TaskRun provenance
review_pending from natural idle
review_pending from exact SessionInput completion after crash/retirement
contained_unknown awaiting review
deliberate operational retry
```

and never an uncontrolled owner-loss replay loop.

### Operator UI

The backend/control-plane semantics are now substantially richer than the existing operator panel. A later UI pass should expose the new reliability projection, contained-unknown/review flows, and artifact/knowledge detail without reconstructing truth from message history.

### Memory/context terminology

Do not describe the current system as sharing raw LLM context or long-term autobiographical memory.

The supported model is:

```text
independent Session contexts
+ durable peer mail
+ bounded shared knowledge
+ dependency handoffs
+ artifacts
+ claims
```

That scales better and preserves authority boundaries.

---

## 25. Final conclusion

The original diagnosis held: native Swarm's distributed-systems substrate was considerably stronger than its model-facing ergonomics.

This pass moved responsibility from the model into authoritative host machinery:

- routine worker intent is direct and Session-derived;
- initial coordinator creation is one direct bounded `swarm_create` intent with a deliberately flat provider member contract, while broad administration remains lazy;
- invalid workers/coordinators are rejected before durable activation;
- dependency knowledge is host-generated, bounded, and carries exact successful-run result/provenance;
- successful worker self-reports are durable on the exact TaskRun rather than inferred from prose;
- coordinator TaskRun/result audit is bounded and keyset-pageable without reading Session history;
- shared state has relevance-aware retrieval;
- artifacts and claims make fewer false promises;
- effect uncertainty has an explicit operator closure path;
- normal missing settlement no longer causes immediate replay;
- crash anti-replay is bound to the exact completed SessionInput rather than inferred from a Session timestamp or transcript;
- observability can now tell semantic work from operational churn.

The ordinary interactive live path is now proven end-to-end: initial creation succeeds in one direct bounded `swarm_create` call using a flat member projection; managed workers materialize and self-settle; bounded predecessor results carry exact run/member provenance without transcript hydration; and exact durable TaskRun results are auditable through the same Core projection used by HTTP. V2 demonstrated honest truncation at 512 B; V3 transferred an 837-byte three-fact result completely under the final 1 KiB result budget. Creation telemetry progressed from three lazy-broker attempts, through one zero-write nested-facade rejection, to one successful flat-facade call with zero broker calls before creation and zero retries. The remaining proof obligation is longitudinal: gather enough real workload telemetry to establish that the historical supersession/replay distribution has collapsed under sustained use, without weakening the fixed authority, compressed-tool, or bounded-context model.

