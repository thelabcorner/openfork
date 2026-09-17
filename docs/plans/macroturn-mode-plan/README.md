# Macroturn Mode — Planning Index

**Status:** WORKING DRAFT — architecture/research only, no runtime implementation yet  
**Started:** 2026-09-16  
**Former working name:** Expensive Mode

## Goal

Design **Macroturn Mode** as a first-class OpenFork execution mode in which a
primary agent can be continuously supervised by one or more independent
frontier-model sessions at provider-step / macroturn boundaries.

The key realization is that this is **not a second, unrelated multi-agent
architecture**. It is a more tightly coupled topology built from the same ideas
as OpenSwarm:

- real independent OpenCode sessions;
- independent model/provider assignment;
- persistent member identity and lifecycle;
- peer/supervisor messaging and structured state;
- optional alternate workers / reviewers;
- durable recovery and observability.

The architectural difference is **coupling**. A normal swarm member receives
tasks/messages. A Macroturn supervisor is *bound to another session's execution
stream* and is invoked from authoritative macroturn settlement events without
requiring the worker to explicitly message it.

## Working definition

A **macroturn** is one complete provider execution unit:

```text
model generation / reasoning
        ↓
tool call(s)
        ↓
tool settlement / result(s)
        ↓
filesystem + environment effects
        ↓
durable step settlement
```

One user prompt may contain many macroturns:

```text
User prompt
  ↓
Macroturn 1 → Supervisor review 1
  ↓
Macroturn 2 → Supervisor review 2
  ↓
Macroturn 3 → Supervisor review 3
  ↓
Final response
```

Review frequency and intervention frequency are deliberately independent. A
supervisor may review every macroturn while surfacing nothing on clean turns.

## Architecture thesis

Macroturn Mode should become a **supervision capability of the swarm/session
runtime**, not a feature implemented through UI reconstruction or ordinary
swarm task delegation.

```text
Session execution
      │
      ▼
Macroturn settled
      │
      ▼
Canonical effect capsule
      │
      ▼
Supervision binding
      │
      ▼
Independent supervisor session(s)
      │
      ▼
Structured supervisor result
      │
      ▼
Intervention policy
      │
      ├─ silent
      ├─ review / finding
      ├─ strategic steer
      ├─ verification request
      ├─ explicit alternative
      ├─ boundary block (future / narrow)
      └─ branch / alternate worker (future)
```

The generic swarm scheduler/mailbox remains appropriate for ordinary delegated
work. It is **not** the k=1 review hot path: creating a task, claiming it,
delivering mailbox work, and completing it for every provider step would add
unnecessary orchestration overhead and weaken causal coupling.

## Current repository reality

There are three relevant surfaces today:

1. `/openswarm` contains the mature swarm domain/runtime implementation and
   operational semantics (members as real sessions, lifecycle supervision,
   broker, scheduler, hive, recovery, model selection, etc.).
2. `docs/plans/swarm-port-plan/` describes the intended native OpenFork swarm
   port. The complete native `SwarmService` described there has **not** landed as
   a finished subsystem yet, so Macroturn Mode must not silently depend on it.
3. OpenFork already has native `SessionGroup` ownership/presentation support,
   which OpenSwarm is beginning to consume. Session groups are useful for UI
   grouping but are **not** the authoritative supervision relation.

Therefore the plan reuses **swarm semantics and eventual native abstractions**
while placing the macroturn producer and supervision binding at the session
runtime boundary that already exists.

## Research anchors

The plan is informed by the 2025–2026 frontier work discussed during design:

- SWE-PRM (`arXiv:2509.02360`) — online trajectory correction for SWE agents.
- *Steer, Don't Solve* (`arXiv:2606.21811`) — critic capability × frequency ×
  authority interactions; frontier Opus reviewer showed large gains over a
  weaker worker and benefited from more frequent review.
- *Accurate Failure Prediction in Agents Does Not Imply Effective Failure
  Prevention* (`arXiv:2602.03338`) — review accuracy and intervention value are
  separate variables; disruption/recovery must be measured.
- Ctrl-Z (`arXiv:2504.10374`) — structural precedent for high-rate monitoring
  with sparse control action and persistent supervisory state.
- Long-horizon/self-conditioning work (`arXiv:2509.09677`) — early trajectory
  errors can contaminate later reasoning, motivating immediate supervision.

Most published gains are **strong reviewer → weaker worker**. Frontier-peer
supervision remains largely unmeasured, so policy decisions such as k=1,
cross-family review, prescriptive authority, blocking vs async, and Best-of-N
branching must remain experimental parameters rather than architecture laws.

## Documents

1. [`01-runtime-architecture.md`](./01-runtime-architecture.md) — authoritative
   bottom-up architecture, ownership, data model, swarm reuse, execution seams,
   failure behavior, and phased implementation plan.
2. Future follow-up: experimentation/benchmark plan after the runtime contracts
   in document 01 stabilize.

## Decision log (initial)

| Decision | Current position | Confidence |
|---|---|---:|
| Product name | **Macroturn Mode** | High |
| Core abstraction | execution-coupled supervisory binding, swarm-derived | High |
| Worker/supervisor topology | real independent OpenCode sessions | High |
| Macroturn producer | authoritative session runner/processor, never UI history | High |
| Review input | canonical effect-grounded capsule + optional exposed reasoning | High |
| Review rate | configurable; k=1 is a serious candidate | Medium |
| Intervention rate | independent from review rate; silence is valid | High |
| Authority | policy dimension, not hard-coded advisory-only | High |
| Reviewer family | configurable; cross-family is a hypothesis, not a law | Medium |
| Generic swarm task/mailbox for each review | **No** — direct hot path required | High |
| SessionGroup | presentation/grouping projection only | High |
| Async vs blocking | policy dimension; both must be supported architecturally | Medium |
| Branch on disagreement | future swarm-native extension | Medium |
| UI design | last; runtime/domain state first | High |

## Non-goals for the planning phase

- Do not implement a UI toggle first.
- Do not encode k=5, k=1, advisory-only, cross-family, or asynchronous review as
  immutable doctrine before measurement.
- Do not build a second session-history reconstruction pipeline.
- Do not treat GoalAuditor as Macroturn Mode merely because it already calls an
  independent model.
- Do not route every review through generic swarm task claiming / mailbox
  delivery.
- Do not make hidden chain-of-thought availability a requirement.

