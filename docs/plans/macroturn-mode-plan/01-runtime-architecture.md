# Macroturn Mode — Runtime Architecture Blueprint

**Status:** WORKING DRAFT v0.1 — planning only  
**Architecture doctrine:** source of truth → domain service → transport → client projection → UI.

---

## 1. Executive summary

Macroturn Mode is a **high-frequency, execution-coupled supervision topology** built from the same core ideas as OpenSwarm.

Normal swarm cooperation is task/message coupled:

```text
task → member session → work → handoff/message → peer/coordinator
```

Macroturn supervision is execution coupled:

```text
worker provider step settles
        ↓
runtime emits canonical macroturn capsule
        ↓
supervision binding selects independent supervisor session
        ↓
supervisor evaluates the just-settled execution
        ↓
policy decides whether/how to affect the worker's next boundary
```

The supervisor is a real OpenCode session with its own model, context, lifecycle, and potentially its own persistent private state. The new primitive is the **binding** between a worker's execution stream and that supervisor.

The architecture should reuse swarm/session primitives for identity, model assignment, persistence/recovery, grouping, and future branching, while adding a dedicated low-overhead supervision path for macroturn events.

Supervisor authority is an experimental policy dimension:

```text
monitor    — detect / score only
review     — identify a concern and evidence
strategy   — suggest a direction or missing verification
operator   — propose an explicit alternative approach
co-solver  — contribute concrete implementation content
```

These are materially different inference architectures. Do not hard-code "review" to mean gentle advisory prose.

---

## 2. Authoritative runtime boundary

Macroturn Mode is Tier-3 execution/runtime work. The UI must never reconstruct macroturns from session history when the producer already owns the exact state.

### 2.1 V2 / core runner

`packages/core/src/session/runner/llm.ts::runTurnAttempt` currently:

1. resolves session, agent, model, and context;
2. captures the pre-step filesystem snapshot concurrently with provider dispatch;
3. consumes provider reasoning/text/tool events;
4. settles local tool calls in fibers;
5. awaits **all** tool fibers;
6. captures the post-step snapshot;
7. calculates changed files;
8. publishes durable `SessionEvent.Step.Ended`;
9. settles telemetry and usage;
10. returns whether another provider step is required.

The clean V2 macroturn seam is **after tool settlement and durable `Step.Ended`, before the next `runTurnAttempt`**.

### 2.2 V1 / production processor

`packages/opencode/src/session/processor.ts` owns the V1 stream. On `step-finish` it currently:

1. captures the completed snapshot;
2. settles exposed reasoning parts;
3. writes model usage/telemetry;
4. persists the `step-finish` part and assistant message;
5. compares the pre/post immutable snapshots and persists a patch part when files changed;
6. launches summary work.

The V1 seam is the **post-step-finish settlement after the effect/patch record is durable, before the owning prompt loop initiates the next provider generation**.

### 2.3 One semantic producer

Both paths must feed one semantic producer contract. V1 and V2 may have different adapters, but they must not define different meanings of "macroturn."

---

## 3. Macroturn contract

### 3.1 Definition

A macroturn is one provider execution step plus its externally visible effects:

```text
generation/reasoning
    + tool-call batch
    + tool settlements/results
    + filesystem/environment delta
    + usage/timing/outcome settlement
```

Parallel tool calls inside one provider step remain **one macroturn**. Review occurs after their settlement unless a separately designed future pre-execution safety gate is introduced.

### 3.2 Stable identity

Every reviewable macroturn needs identity independent of UI ordering:

```ts
type MacroturnRef = {
  sessionID: string
  macroturnID: string
  ordinal: number
  assistantMessageID: string
  settledEventSequence?: number
  startSnapshot?: string
  endSnapshot?: string
}
```

Exact naming is not frozen. `sessionID + durable step identity + ordinal` must be enough to deduplicate work and reject stale reviews.

### 3.3 Canonical effect capsule

The capsule is constructed at the producer boundary, not by rereading the whole conversation:

```ts
type MacroturnCapsule = {
  ref: MacroturnRef

  task: {
    activeUserInstruction?: string
    activeGoal?: string
    acceptanceCriteria?: readonly string[]
  }

  worker: {
    agent: string
    providerID: string
    modelID: string
    variant?: string
  }

  output: {
    visibleReasoning?: string
    text?: string
    finish?: string
  }

  tools: readonly {
    callID: string
    name: string
    input: unknown
    outcome: "success" | "failure" | "interrupted"
    resultSummary?: unknown
    outputPaths?: readonly string[]
  }[]

  effects: {
    startSnapshot?: string
    endSnapshot?: string
    changedFiles?: readonly string[]
    boundedDiff?: string
  }

  verification: {
    testsObserved?: readonly unknown[]
    typecheckObserved?: readonly unknown[]
  }

  telemetry: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    requestSentAt?: number
    firstTokenAt?: number
    streamedAt?: number
    completedAt?: number
  }

  signals: {
    spad?: unknown
    repeatedResources?: readonly string[]
    toolFailures?: number
    mutationCount?: number
  }
}
```

This is illustrative, not a frozen wire schema.

### 3.4 Host facts vs model claims

The capsule must distinguish **host-owned facts** from model-authored interpretation. A frontier reviewer should not infer facts OpenFork already knows:

- process exit code;
- whether the snapshot changed;
- exact changed files;
- whether a test invocation failed;
- whether a tool returned zero results;
- whether the same resource was repeatedly read;
- whether a mutation was later reverted.

Frontier inference should spend compute on semantic judgment, not reconstructing runtime truth from prose.

### 3.5 Reasoning availability

Visible/provider-exposed reasoning can enrich the capsule. Hidden chain-of-thought is **not** a dependency. The contract must remain useful from observable rationale/actions/results/effects alone.

---

## 4. Relationship to OpenSwarm

### 4.1 Reuse the proven topology

The current `/openswarm` implementation already proves several pieces:

- members are real independent OpenCode root sessions;
- model/provider/variant can differ per member;
- sessions have durable member identity/lifecycle;
- a supervisor already reduces session lifecycle events into durable state;
- members exchange structured message kinds including `review` and `finding`;
- scheduler/broker/recovery logic handles concurrent members;
- SessionGroup integration can present related sessions together;
- future alternate-worker branching is conceptually native to swarm execution.

Macroturn Mode should not duplicate these concepts.

### 4.2 New primitive: execution-coupled supervision binding

Normal members are peers driven by tasks/messages. Macroturn supervisors need an explicit runtime-owned relationship:

```ts
type SupervisionBinding = {
  id: string
  targetSessionID: string
  supervisorSessionID: string

  boundary: "macroturn"
  frequency: SupervisionFrequency
  authority: SupervisorAuthority
  execution: "blocking" | "speculative" | "hybrid"
  surfacing: SurfacingPolicy

  enabled: boolean
}
```

The worker must not be responsible for remembering to notify the supervisor. **The runtime owns the binding.**

### 4.3 Do not put k=1 through generic swarm scheduling

A naive reuse would perform:

```text
macroturn settled
→ create swarm task
→ scheduler pass
→ claim
→ mailbox enqueue
→ wake supervisor
→ deliver prompt
→ complete task
→ send review message
```

That is unnecessary work in the execution hot path. The binding already knows both sessions and why the review exists.

The intended fast path is:

```text
macroturn settled
→ build capsule
→ SupervisionRuntime.submit(binding, capsule)
→ run/continue supervisor inference
→ persist structured result
→ intervention policy
```

Generic swarm tasks/mailboxes remain useful for **coarse delegated work**, especially future branch-on-disagreement workflows.

### 4.4 Native swarm port status

`docs/plans/swarm-port-plan/` describes a first-class native `SwarmService`, but the complete service described there has not landed as a finished subsystem. Macroturn Mode therefore must not depend on imaginary native APIs.

Current lean: place the macroturn producer/supervision primitive close to the session runtime first, then let the eventual native swarm subsystem consume it.

### 4.5 SessionGroup is presentation, not supervision ownership

Native SessionGroup already has stable owner/plugin references, anchor sessions, locked membership, and UI projections. It is useful for grouping worker + supervisor sessions visually.

It must not become the source of truth for supervision semantics. Grouping answers **which sessions belong together**. A supervision binding answers **who observes whom, at what boundary, with what authority and policy**.

---

## 5. Runtime topology

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Session execution                                                    │
│                                                                     │
│  V1 SessionProcessor             V2 SessionRunner                    │
│          │                              │                            │
│          └──────── MacroturnProducer ───┘                            │
│                         │                                           │
│                         ▼                                           │
│               Canonical MacroturnCapsule                            │
│                         │                                           │
│                         ▼                                           │
│                SupervisionRuntime                                   │
│          ┌──────────────┼────────────────┐                          │
│          │              │                │                          │
│       bindings       review jobs      ledger                        │
│          │              │                │                          │
│          ▼              ▼                ▼                          │
│               SupervisorSession(s)                                  │
│                         │                                           │
│                         ▼                                           │
│               StructuredSupervisorResult                            │
│                         │                                           │
│                         ▼                                           │
│                 InterventionPolicy                                  │
│          │        │       │       │       │                         │
│        silent   review  steer   verify  alternative                 │
└──────────┼────────┼───────┼───────┼───────┼─────────────────────────┘
           └────────┴──── worker context/control boundary              │
```

Future disagreement path:

```text
supervisor → spawn/delegate alternate swarm worker → compare/merge
```

### Ownership boundaries

- **MacroturnProducer** — adapts V1/V2 settlement into one semantic capsule.
- **SupervisionRuntime** — owns binding lookup, review lifecycle, stale-result checks, persistence, and intervention orchestration.
- **SupervisorSessionRuntime** — uses ordinary OpenCode session/model machinery with a specialized supervisor doctrine/context compiler.
- **InterventionPolicy** — translates a structured review into no-op/context/control action.
- **SupervisionLedger** — durable reviews, timing, policy decisions, and measurement data.

These names describe responsibilities, not mandatory class/module boundaries. Collapse adjacent pieces where existing host services already provide a cleaner seam.

---

## 6. Supervisor session model

### 6.1 Real session, specialized role

The supervisor should remain a **real OpenCode session**, consistent with swarm architecture. Benefits:

- independent provider/model/variant;
- prompt-cache identity;
- independent context and compaction;
- observable lifecycle/errors;
- durable recovery;
- user inspectability;
- future transition from reviewer to operator/co-solver without a second inference runtime.

Its input path is supervision-runtime owned rather than ordinary human/swarm mailbox semantics.

### 6.2 Private supervisor state

Worker-visible review history and supervisor-private memory should be separate.

Candidate private state:

```text
verified facts
architectural invariants
open concerns
resolved concerns
rejected hypotheses
already-surfaced findings
```

The supervisor sees this state; the worker only sees selected interventions.

### 6.3 Stable prompt/cache shape

Preferred reviewer context:

```text
[stable supervisor doctrine]
[stable task anchor]
[compact private supervisor state]
[new macroturn capsule]
```

Avoid resending/reconstructing the worker's full conversation when the capsule already supplies the relevant delta. The goal is prefix stability and review cost proportional to new work rather than session age.

---

## 7. Structured supervisor result

The runtime needs a machine-readable result before any worker-facing prose:

```ts
type SupervisorAuthority =
  | "monitor"
  | "review"
  | "strategy"
  | "operator"
  | "co-solver"

type StructuredSupervisorResult = {
  macroturnID: string
  reviewedSnapshot?: string

  surface: boolean
  confidence: number
  severity: "none" | "low" | "medium" | "high" | "critical"

  findings: readonly {
    category:
      | "specification"
      | "reasoning"
      | "tool-strategy"
      | "architecture"
      | "mutation"
      | "verification"
      | "coordination"
      | "efficiency"
      | "evidence"
    claim: string
    evidenceRefs?: readonly string[]
  }[]

  strategy?: string
  explicitAlternative?: string
  proposedVerification?: readonly string[]
  supervisorStateDelta?: unknown
}
```

**Review completion is not intervention.** A result with `surface:false` creates no worker-visible context. The durable ledger may still record it for measurement.

This permits:

```text
review rate       = 100%
intervention rate = 5–30%
```

without forcing clean-review prose into worker context.

---

## 8. Intervention authority

### Level 0 — silent

Persist review only.

### Level 1 — finding

Append a concise evidence-backed concern.

### Level 2 — strategic steer

Suggest what class of uncertainty should be resolved without supplying a full implementation.

### Level 3 — verification request

Request/check a concrete verification boundary before additional risky work.

### Level 4 — explicit alternative / operator

Give a concrete competing architecture or action. This must remain architecturally available because strong-reviewer research shows prescriptive assistance can materially outperform weak advisory assistance when the reviewer has a large capability advantage.

For peer-frontier review this remains an experiment, not doctrine.

### Level 5 — control/branch (future)

Potential future actions include boundary pause, alternate worker spawn, independent implementation, verifier comparison, and trajectory selection/merge.

Level 5 is not required for v1.

---

## 9. Blocking, speculative, and hybrid execution

### Blocking

```text
worker N settles
review N completes
intervention decision
worker N+1 starts
```

Maximum causal correction; maximum review latency.

### Speculative

```text
worker N settles
├─ worker N+1 starts
└─ review N runs concurrently
```

Requires a staleness/relevance check before surfacing. N+1 may already self-condition on N's error.

### Hybrid

Policy-driven blocking for some classes and speculative review for others.

Example only, not doctrine:

```text
large mutation / failed verification / architecture checkpoint → blocking
simple read/discovery                                      → speculative
```

The runtime must support the policy dimension even if v1 exposes only a subset.

---

## 10. Frequency, observation, and intervention

Macroturn Mode distinguishes three rates:

```text
observation rate
review rate
surface/intervention rate
```

The producer observes 100% of macroturns. Review and intervention are policy.

Candidate frequency policies:

```ts
type SupervisionFrequency =
  | { type: "every-macroturn" }
  | { type: "every-n"; n: number }
  | { type: "settlement-class"; classes: readonly string[] }
  | { type: "adaptive"; policyID: string }
```

`every-macroturn` is a serious first-class candidate. Do not optimize Macroturn Mode into "cheap mode" before measuring frontier-to-frontier behavior.

An adaptive policy may later use deterministic host signals such as mutation, verification failure/absence, diff size, SPAD signals, repeated resources, tool failures, macroturn ordinal/horizon, architecture-critical files, and unresolved prior concerns.

---

## 11. Interaction with existing systems

### OpenSwarm

Reuse real-session topology, model selection concepts, lifecycle/recovery semantics, durable identity, SessionGroup presentation, and future branch/delegate/reviewer/integrator topology.

Do not use generic task creation, scheduler sweeps, mailbox delivery, or ordinary wake/cooldown semantics for every macroturn review.

### Goal Mode / GoalAuditor

Keep semantic authority separate:

```text
Macroturn supervisor: "Was the just-executed step sound?"
Goal auditor:          "Is the outer autonomous goal complete/blocked/continuing?"
```

They may share independent-model/protocol infrastructure but not verdict semantics or continuation authority.

### SPAD

SPAD remains the cheap online degeneration detector. Macroturn review consumes SPAD signals rather than duplicating them.

```text
SPAD                 = fast pathology detection / recovery signal
Macroturn supervisor = semantic process oversight
```

### Telemetry / usage

Session telemetry/usage is a natural capsule and experiment-ledger input. Reviewer prompts must not reconstruct token/timing facts from messages.

### Compaction

Durable full reviews belong in the supervision ledger. Worker context should retain unresolved/high-value findings and compact resolved history rather than accumulating every old review forever.

---

## 12. Persistence and eventing

Exact schema is deferred, but durable state is needed for:

### Binding

- target session;
- supervisor session;
- policy/config;
- enabled state;
- lifecycle timestamps.

### Review

- macroturn identity/snapshot;
- reviewer model/provider/variant;
- token accounting and latency;
- structured verdict/findings;
- surfaced/intervention action;
- stale/discarded/failure status.

### Outcome measurement

- worker changed direction;
- verification later passed/failed;
- relevant edit later reverted;
- worker independently discovered the same issue;
- user later corrected the worker;
- branch spawned/selected (future).

Internal review lifecycle should publish through the host event plane so UI and telemetry are projections of runtime truth rather than pollers.

---

## 13. Failure and recovery

### Reviewer provider failure

Default behavior should preserve worker integrity:

- persist review failure;
- blocking mode may retry within bounded policy;
- after timeout/retry budget, normally fail open and continue the worker;
- future strict/safety modes may deliberately choose otherwise.

### Supervisor session loss

Distinguish transient provider failure, deleted session, manual stop, compaction/overflow, and runtime restart. Reuse OpenSwarm recovery principles, but never auto-respawn against explicit operator stop authority.

### Stale result

Every speculative result carries the macroturn/snapshot it reviewed. Before surfacing:

- still relevant → surface;
- partially relevant → downgrade to observation;
- superseded/resolved → persist only.

---

## 14. Security / trust boundary

The supervisor consumes worker text, tool output, repository content, and potentially swarm/peer content. These are untrusted data, not supervisor instructions.

Carry forward OpenSwarm's trust-fence doctrine:

- host-owned supervisor doctrine is authoritative;
- capsule fields clearly distinguish host facts from untrusted text;
- supervisor mutation permissions are denied by default;
- reviewer tools, if added, start read-only and bounded;
- operator/co-solver output is still advice/content unless direct mutation authority is separately designed.

---

## 15. UI direction — deliberately last

Potential surfaces after runtime contracts exist:

- Macroturn Mode toggle/preset;
- supervisor model/provider/variant selector;
- frequency and authority advanced settings;
- grouped worker + supervisor presentation via SessionGroup;
- inspectable supervision channel including silent reviews;
- metrics for review count, surface count, added cost/latency, recoveries, and harm.

The UI must never discover macroturn state by scanning messages/parts.

---

## 16. Experimental dimensions the architecture must preserve

### Frequency

```text
off / k=10 / k=5 / k=3 / k=2 / k=1 / adaptive
```

### Authority

```text
monitor / review / strategy / operator / co-solver
```

### Capability relationship

```text
same model, independent invocation
same family, different model
cross-family peer
stronger supervisor
multiple heterogeneous supervisors
```

### Execution

```text
blocking / speculative / hybrid
```

### Surfacing

```text
all / confidence threshold / severity threshold / adaptive
```

### Evidence

```text
trajectory prose
+ tool facts
+ snapshot/diff/verification
+ visible reasoning
```

### Equal-compute comparator

```text
single worker + more reasoning
Best-of-2 + selector
worker + continuous supervisor
worker + multiple supervisors
adaptive branch-on-disagreement
```

If these comparisons require architecture rewrites, the initial runtime is too narrow.

---

## 17. Future: disagreement-triggered swarm branching

The strongest convergence with full swarm architecture is adaptive branching:

```text
Primary worker A
      │
macroturn N
      │
supervisor B
      │
      ├─ agrees / small concern → continue one trajectory
      │
      └─ material disagreement / uncertainty
              │
              ▼
       spawn alternate worker C
          A path       C path
              \       /
               verifier/integrator
                      │
                   continue
```

This may capture Best-of-N benefits without paying for parallel trajectories from the beginning of every task. It is **not v1 scope**, but it is a major reason to keep Macroturn Mode swarm-compatible.

---

## 18. Phased implementation plan

### Phase 0 — planning + measurement contract

- Freeze semantic macroturn definition.
- Define capsule fields and truncation/bounding rules.
- Define structured supervisor result.
- Define experiment/telemetry fields before behavior changes.
- Decide persistence ownership and schema location.
- Reconcile with the native swarm-port roadmap.

### Phase 1 — observation only

- Add one Macroturn producer abstraction across V1/V2.
- Materialize capsules/telemetry without reviewer inference.
- Prove zero behavior change to normal sessions.
- Prove no second full-history scan and no redundant filesystem snapshot.

### Phase 2 — shadow supervision

- Add supervision bindings and real supervisor sessions.
- Invoke reviewer at configurable frequency.
- Persist structured results.
- **Never inject review into worker context.**
- Measure precision, lead time, cost, and outcome correlations.

### Phase 3 — controlled active intervention

- Enable `surface:false` and append-only surfaced findings.
- Add blocking/speculative experiment modes.
- Add matched OFF/ON harness for disruption/recovery measurement.
- Keep higher authority supported but dark until measured.

### Phase 4 — frontier policy experiments

- k=10/5/3/2/1 response surface;
- authority × frequency interaction;
- same/cross-family frontier reviewer comparison;
- effect-grounding and reasoning ablations;
- equal-dollar Best-of-2 comparator.

### Phase 5 — swarm-native extensions

- multiple supervisors;
- specialist reviewers;
- disagreement-triggered branching;
- alternate worker + verifier/integrator;
- operator/co-solver workflows.

---

## 19. Performance invariants

Macroturn Mode is intentionally expensive in **inference**, not accidentally expensive in host/runtime work.

Required negative invariants:

1. No UI/message-history scan to discover macroturn state.
2. No extra full filesystem scan when the owning step already captured snapshots.
3. No generic swarm task/scheduler/mailbox round-trip per k=1 review.
4. No unbounded reviewer queue per session.
5. No unbounded global reviewer concurrency.
6. No reviewer failure that corrupts durable worker settlement.
7. No silent stale-review injection.
8. No clean review text appended merely to prove the reviewer ran.
9. No normal-session performance regression while Macroturn Mode is OFF.
10. Reviewer cost, latency, and queue depth are observable.

Review work must be bounded in count and in actual expensive dimensions: capsule bytes/tokens, concurrent frontier calls, reviewer context growth, and worker-visible injected context.

---

## 20. Open questions ledger

### Q1 — Native ownership relative to swarm port

Should the first implementation live as a session-domain `SupervisionRuntime` that the eventual native SwarmService consumes, or land directly under a future native `swarm/supervision` service?

Current lean: **session-domain primitive first, swarm integration second**, because macroturn production is session-owned and the native swarm port is incomplete.

### Q2 — Persistence shape

Are bindings/reviews generic session-supervision records or swarm-specific records? Avoid making a general execution relationship depend on one optional swarm feature.

### Q3 — Worker-context injection representation

Should surfaced review be a dedicated session message/event type, synthetic context entry, system overlay, or another first-class context channel?

Generic V2 `synthetic` currently maps to user-role model context, which may be the wrong semantics for privileged supervisor guidance.

### Q4 — Reviewer context construction

How much worker context accompanies the capsule? Target: stable task anchor + compact supervisor state + delta, with bounded read-only repository inspection only when needed.

### Q5 — Reviewer tools

Do effect-grounded capsules remove the need for tools in v1, or should supervisors receive bounded read/grep/symbol/diff verification tools?

### Q6 — Blocking seam

Where exactly should V1/V2 wait for a blocking supervisor without duplicating prompt-loop logic or holding inappropriate DB/tool resources?

### Q7 — Human steering precedence

If user steer/input arrives while blocking review is pending, explicit user authority must outrank autonomous supervision. Define cancellation/promotion semantics.

### Q8 — Compaction semantics

How are surfaced reviews represented across compaction while preserving open concerns but shedding resolved prose?

### Q9 — SessionGroup representation

Should worker+supervisor sessions use an ordinary plugin-owned group, a future `supervision` group kind, or remain ungrouped until UX work? This is presentation-only and must not affect runtime ownership.

### Q10 — Multi-supervisor arbitration

When supervisors disagree, does policy use confidence, consensus, specialist authority, or an integrator? Defer until one-supervisor measurements exist.

---

## 21. Architecture checkpoint

Before implementation, review every proposal against this bottom-up ownership path:

```text
provider/tool execution
→ authoritative step settlement
→ canonical macroturn capsule
→ supervision binding/runtime
→ independent supervisor session
→ durable structured review
→ intervention policy
→ worker context/control boundary
→ compact client projection
→ optional UI visualization
```

If implementation starts with a settings toggle, message-history scan, generic swarm task, or frontend-derived turn reconstruction, it is moving top-down and should stop.

