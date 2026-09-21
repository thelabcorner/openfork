# Swarm provenance, messaging, and Session-runtime contract

**Status:** PROVENANCE/MESSAGING COMPANION — subordinate to
`00-first-party-overhaul-2026-09-18.md`  
**Depends on:** `00-first-party-overhaul-2026-09-18.md` and the active
`docs/plans/v1-v2-turn-provenance-backport-ledger.md`

---

## 0. Why this is load-bearing

OpenSwarm's human-chat machinery demonstrates the failure mode directly: because the plugin cannot
authoritatively know who owns a Session turn, it classifies its own injections using message-ID
prefixes and text prefixes such as assignment, team-sync, watchdog, and peer-message headers.

That mechanism must not survive first-party integration.

OpenFork's current provenance work establishes the correct model:

1. durable conversational turn ownership;
2. semantic message kind;
3. intended model authority;
4. part-level syntheticness;
5. provider role/projection;

are independent dimensions.

Swarm adds three more independent dimensions:

6. logical peer/message authorship;
7. trust;
8. workflow/task/run causality.

Collapsing any pair recreates the bug class.

---

## 1. Eight-dimensional model

Consider a peer worker sending another worker a finding.

The recipient's durable Session entry can simultaneously be:

| Dimension | Value |
|---|---|
| conversational owner | `host` |
| semantic kind | synthetic / Swarm input |
| authority | conversational/user lane; not privileged merely because host-authored |
| provider projection | `role:"user"` |
| part syntheticness | renderer-dependent; not ownership authority |
| logical author | member `researcher-a` |
| trust | peer-authored, untrusted data |
| workflow causality | Swarm message M, delivery D, perhaps task run R |

Nothing is contradictory here.

Provider role `user` means “this is a model-facing conversational boundary”, not “a human typed
this”.

Likewise, `owner=host` means the trusted host admitted/owns the turn boundary; it does **not** mean the content should receive privileged System authority. Swarm assignment, peer delivery, continuation, recovery, and actionable notices remain conversational Synthetic input. Stable host doctrine/policy is a separate privileged System surface.

---

## 2. Extend the trusted provenance vocabulary

Current V1 durable producers already stamp sources such as:

- `prompt`;
- `command`;
- `host.prompt`;
- `task.summary`;
- `goal.continuation`;
- `recovery.continuation`;
- compaction/special-agent sources.

Swarm should add trusted sources at the same producer boundary. Exact strings are schema/API design,
but the semantic set should distinguish at least:

- `swarm.assignment` — first assignment/start of a task run;
- `swarm.peer` — admitted peer message/delivery;
- `swarm.continuation` — host asks the same member to continue an existing run;
- `swarm.recovery` — crash/session recovery continuation;
- `swarm.notice` — actionable host notice deliberately admitted to a Session.

All are:

```text
owner = "host"
```

Public APIs/tools may request a Swarm action, but they may not submit their own
`owner:"host"` provenance object. The trusted Session admission path stamps it.

### 2.1 `ref` usage

Use `provenance.ref` as an idempotent pointer to the durable thing that caused the turn:

- assignment -> task run ID or lease/run ID;
- peer -> message delivery ID;
- continuation -> task run/continuation ID;
- recovery -> recovery/run ID;
- notice -> notification/action ID.

This makes “did we already admit this host turn?” an O(1)/indexed identity question rather than a
text search.

### 2.2 Cross-session lineage must be typed

Do not overload V1 `sourceMessageID` with every possible Swarm relation.

Current V1 consumers treat that field as a same-Session causal/checkpoint root.
That is safe for:

- Goal continuation inside one Session;
- compaction continuation/replay inside one Session;
- other host continuations preserving a local rollback root.

It is **not** safe as a cross-session peer lineage pointer.

Current-model lineage should use a typed pair:

```ts
type SessionTurnRef = {
  sessionID: SessionID
  messageID: SessionMessage.ID
}
```

Peer authorship itself remains separate:

```ts
type SyntheticActor =
  | { type: "host" }
  | { type: "session"; sessionID: SessionID; messageID?: SessionMessage.ID }
```

and the synthetic origin carries semantic producer/correlation independently:

```ts
type SyntheticOrigin = {
  producer: string
  actor: SyntheticActor
  ref?: string
  cause?: SessionTurnRef
}
```

For V1 compatibility, lower `cause.messageID` into `sourceMessageID` only when
`cause.sessionID` is the recipient Session itself.

Cross-session cause is lineage, **not authorization**. A recipient does not gain
the sender's permission/tool authority merely because a peer turn has a causal
reference.

---

## 3. Current/V2 semantic model is the direction of travel

V1 still persists several host-owned model-facing boundaries as `role:"user"`. The provenance
backport makes that safe by separating owner from provider role.

The current/V2 message taxonomy already has semantic user/synthetic/shell/compaction/system/
assistant distinctions.

Long-term Swarm behavior should align with that semantic model:

```text
human member chat       -> semantic User
Swarm assignment        -> semantic Synthetic
peer delivery           -> semantic Synthetic
Swarm continuation      -> semantic Synthetic
recovery continuation   -> semantic Synthetic
actionable Swarm notice -> semantic Synthetic
```

Provider lowering may still map several of these to role `user`. That is a protocol concern only.
The adapter must not promote them to System because they are host-authored, and must not demote unrelated genuine System policy to user text merely to satisfy an adapter limitation.

---

## 4. Purpose-specific authorization selectors

The provenance campaign correctly rejects a universal `isRealUserMessage()`.

Swarm needs similarly narrow questions:

- `isHumanInteractionTurn` — does this turn represent direct user engagement with a member?
- `canAuthorizeSwarmDestructiveOperation` — did explicit user authority request the destructive
  action, or did an authenticated API/UI surface authorize it?
- `isSwarmAssignmentTurn` — host assignment with a valid run ref?
- `isSwarmPeerTurn` — host peer-delivery turn with a valid delivery ref?
- `isSwarmRecoveryTurn` — host recovery, never a new human objective?
- `causalUserRoot` — which user-owned turn should checkpoint/revert lineage point at?

Do not infer these from:

- provider role;
- `TextPart.synthetic`;
- text prefixes;
- Session title;
- the fact that a message arrived through a particular tool.

---

## 5. Human interaction state machine

### 5.1 Direct human prompt

Trusted prompt admission stamps:

```text
owner: user
source: prompt | command
```

Swarm observes that structurally.

Effects:

- do not assign new automatic work while Session is busy;
- mark/derive user-interaction state for UI;
- optionally establish a bounded grace deadline after the user turn settles;
- queued peer mail remains durable and does not interrupt the user's authority.

### 5.2 Explicit operator abort

SessionRunState already distinguishes explicit cancel by emitting idle with reason `aborted`.

Swarm maps that to durable desired member control state:

```text
member.control = paused
```

The active task lease policy must be explicit (hold, release after a deadline, or operator choice).
The scheduler may not silently resume that member.

### 5.3 Resume

Explicit user action can transition paused -> active:

- user sends a new prompt to that member;
- UI Resume;
- an explicitly user-authorized Swarm action.

An unrelated peer message, timer, watchdog, or fuzzy “self-heal” cannot.

### 5.4 Grace/lull

If the existing five-minute “human chat lull” remains desirable, represent:

`automation_suppressed_until`

as a bounded policy-derived deadline/projection triggered by an explicit user-owned turn.

Do not persist “last human message” by reverse-engineering message text.

---

## 6. Logical peer messaging

### 6.1 Direct and broadcast are different

Direct message:

- target is known;
- may carry request/reply semantics;
- correlation ID/reply-to are meaningful;
- recipient failure can be surfaced to sender.

Broadcast/topic message:

- one-to-many fanout;
- one-way by default;
- recipients may independently create new direct messages, but a broadcast itself is not a function
  call waiting for N responses.

This mirrors a useful distinction in AutoGen and prevents ack/reply storms.

### 6.2 Authorship is durable

`swarm_message` records:

- author member;
- author Session/message/tool-call reference where available;
- kind;
- body/references;
- task/run links;
- correlation/reply-to;
- created time.

The host never rewrites that content into “host-authored truth”. The host merely owns the recipient
turn boundary.

### 6.3 Trust fencing

Peer content is untrusted even if both members are first-party Sessions.

A central renderer/admission formatter must preserve a clear trust boundary and structured metadata.
Every surface that embeds peer text must use it:

- recipient Session turn;
- status/probe;
- coordinator digest;
- deliverable preview;
- UI detail;
- logs intended for model consumption.

The formatting can evolve; the trust classification may not.

---

## 7. Mailbox delivery protocol

### 7.1 State names should state only what is true

Recommended transport states:

```text
queued
  -> claimed
  -> admitted
  -> expired
  -> failed
```

Optional separate semantic state:

- replied/acknowledged;
- action completed.

`admitted` means the durable recipient Session turn exists / has been accepted by the Session
admission system. It does **not** mean the model read, understood, agreed with, or acted on it.

### 7.2 Idempotent admission and atomic local receipt settlement

The current host DB/EventV2 implementation is stronger than the original draft
assumed.

Persist the logical Swarm message/recipient receipt first and preallocate one
stable target Session-input/message ID. Then admit the recipient Session input
through a durable Session event whose local `commit(seq)` hook updates that
receipt from pending/claimed to `admitted` **inside the same SQLite
transaction**.

Therefore:

- crash before recipient admission leaves the durable receipt retryable;
- failure during admission rolls back both the Session input projection and the
  receipt transition;
- crash after admission commit leaves both facts settled;
- replay with the same input ID is idempotent.

Do not create correctness around a “Session wrote, receipt might not have”
reconciliation window when the current first-party transaction boundary can
remove that window.

### 7.3 Claiming

Two dispatchers racing on one mailbox must not both admit it.

Use a conditional update/lease:

- only `queued` -> `claimed`;
- claim has ID/generation + owner/expiry;
- only current claim can settle/revert.

### 7.4 Busy recipient

Do not bypass SessionRunState.

Delivery policy:

- if direct human interaction currently owns the member, keep mail queued;
- if member is executing Swarm work, use the supported first-party host-turn admission semantics
  (queued boundary or safe ingress), never a private plugin trick;
- coalesce multiple low-priority queued items into one bounded inbox turn when doing so preserves
  message identity/references;
- urgent/actionable items may use a policy-defined faster boundary, still through the same Session
  authority.

### 7.5 Transport retry != task retry

Failed delivery attempts increment delivery attempt state only.

They do not imply that the recipient attempted the task and must never consume a task semantic retry
budget.

### 7.6 Session admission class and provider-cycle arbitration

The mailbox does not own provider ordering once a message is admitted.

Current SessionInput should be generalized to one tagged queue:

```ts
type SessionInputItem =
  | { type: "user"; prompt: Prompt }
  | {
      type: "synthetic"
      content: {
        text: string
        files?: readonly Prompt.FileAttachment[]
      }
      origin: SyntheticOrigin
      delegated?: {
        authorizedAgentNames?: readonly Agent.ID[]
      }
    }
```

with indexed:

```text
kind              user | synthetic
admission_class   user | host | automatic
user_preemptible  bool
delivery          steer | queue
```

Semantic kind and scheduling class are intentionally orthogonal. A Goal
continuation is still `Synthetic`, but its admission class is `automatic`.
Swarm/peer/scheduled/recovery work is normally `Synthetic + host`. A real
human prompt is `User + user`.

`user_preemptible` is trusted execution policy: automatic work always sets it;
host producers set it when their pending work must yield terminally to newer
direct-human input. Swarm assignment/continuation uses it for human-focus
semantics so generic Session arbitration never contains a secretly-held pending
host row.

Synthetic content and delegated capability are deliberately separate. File
references are model context; they do not create user ownership. Agent/tool
authority for a synthetic turn must come from a trusted typed delegation, never
from parsing peer text or reusing an authority-bearing user attachment shape.

### 7.6.1 Pending Synthetic revocation

Synthetic work that has been admitted but has not yet entered conversational
history needs a first-party revocation lifecycle:

```text
pending -> promoted
pending -> revoked
```

There is no `promoted -> revoked` transition.

Persist `revoked_seq?` beside `promoted_seq?` with a DB CHECK that they are
mutually exclusive. Pending selectors require both to be NULL.

Promotion and revocation are competing CAS transitions in the same Session
aggregate durable transaction. If revocation wins after a runner selected the
row but before promotion commits, promotion skips the now-revoked row rather
than manufacturing a message.

Suggested event:

```text
session.next.synthetic.revoked
  sessionID
  messageID
  reason
  timestamp
```

Revoked Synthetic input never becomes `SessionMessage.Synthetic` and never
enters provider context. If promotion already won, callers must use the
execution-retirement protocol; historical conversation is not deleted.

One User admission may causally revoke multiple older pending
`user_preemptible` inputs in the **same User event transaction**. In that case
those rows share the User event's `revoked_seq`; do not make `revoked_seq`
unique.

The Session runner chooses the next class in this fixed order:

```text
user / steer
user / queue
host / steer
host / queue
automatic / queue
```

Within one selected class, preserve current cutoff/FIFO semantics.

Goal automatic continuation is no longer a separate runnable source outside
SessionInput. Goal owns policy/budgets/correlation; SessionInput owns whether
the automatic work is pending, promoted, or revoked.

One provider cycle has one source:

```text
user | host | automatic
```

A different-class steer does not rewrite the meaning of the already-running
cycle. It becomes the next eligible cycle at the next safe provider boundary.

This is especially important for automatic Goal work: a user arriving during an
automatic provider stream can supersede **future** autonomous continuation
without retroactively relabelling the work already performed as user-authored.

For the next automatic admission, the producer supplies the latest semantic User
sequence captured for the current automatic cycle. SessionInput admits the next
automatic item only if that User frontier is unchanged. If automatic admission
wins first, a later User admission revokes it while pending; if User admission
wins first, the automatic admission CAS fails. This is the universal
human-preemption fence for automatic work.

Human-chat grace remains a Swarm-domain admission policy. The generic Session
queue only arbitrates already-admitted work.

---

## 8. Assignment and continuation turns

### 8.1 Assignment

After task lease claim/revalidation, SwarmExecutor admits:

```text
owner: host
source: swarm.assignment
ref: <task-run-id>
```

The rendered content includes:

- task title/objective;
- acceptance criteria;
- explicit workspace scopes;
- relevant peer roster only as needed;
- references to shared coordination artifacts;
- lease/run identity hidden or visible as appropriate to the tool/runtime contract.

Do not inject volatile assignment content into system instructions.

### 8.2 Continuation

A member finishing a model turn without settling its active run is not evidence that the task is
done.

If policy chooses to continue:

```text
owner: host
source: swarm.continuation
ref: <task-run-id or continuation-id>
```

Continuation budgets are durable run policy/counters, not process-local Maps.

### 8.3 Recovery

After crash/session replacement:

```text
owner: host
source: swarm.recovery
ref: <recovery/run-id>
```

The content should reference durable task state/artifacts, not synthesize authority from old chat
text. A new Session does not become a new member identity.

---

## 9. Task completion authority

A member should not prove task ownership by passing arbitrary `taskId` text.

For member-side completion:

1. tool context supplies trusted caller Session ID;
2. service resolves Session -> Swarm member;
3. service loads active task lease for that member/Session;
4. requested task must equal lease task;
5. lease generation/run ID must still be current;
6. state transition is conditional;
7. task/run event + projection settle atomically.

A coordinator reassign invalidates the old generation immediately.

The old Session may still produce a late tool call; it receives a stale-lease result and cannot
mutate the task.

---

## 10. Permission escalation

Permission prompts are native permission-domain events, not Swarm messages pretending to be
permissions.

Swarm correlation is:

`permission SessionID -> member -> active task run`.

UI/coordinator may receive a Swarm-level projection:

- member X is waiting on permission P for task/run R.

But the permission request/reply remains owned by the permission service.

If an actionable coordinator notice is injected into a Session, it is host-owned
`swarm.notice` and references the native permission request ID. Do not copy the entire permission
state into a Swarm table.

---

## 11. Notifications

OpenSwarm's NoticeAggregator is useful product feedback but wrong runtime ownership.

Classify notifications:

### UI-only projection

Prefer for:

- member status changed;
- task completed;
- queued mail count;
- non-actionable health.

No model turn is spent.

### Model-facing actionable notice

Use only when coordinator reasoning/action is genuinely required:

- blocker;
- permission decision;
- failed deliverable requiring replanning;
- unrecoverable run failure.

These get one durable notification identity and, if admitted, host provenance `swarm.notice`.

Aggregate/dedupe by durable keys/deadlines. Do not keep unbounded process-local “already notified”
sets.

---

## 12. Cache and prompt-shape invariants

The Goal provenance campaign exposed a major cache lesson: dynamic orchestration text in a system
prefix invalidates reusable provider prefix caching.

Swarm follows the same rule:

- stable member doctrine belongs in stable agent/system instructions;
- assignment, peer mail, continuation, recovery, and notice content append as turns;
- no per-cycle dynamic roster/task digest is rebuilt into system prompt;
- large artifacts are referenced, not recopied through every peer/coordinator message;
- context/state retrieval is explicit and bounded.

This also aligns with multi-agent production guidance to use persistent artifacts and lightweight
references rather than repeatedly passing large outputs through an orchestrator.

---

## 13. Provenance test matrix

Minimum negative cases:

| Case | Expected |
|---|---|
| direct user prompt to member | owner=user; human interaction true |
| slash command from user | owner=user; semantic policy determined by purpose-specific selector |
| assignment | owner=host, source=swarm.assignment, ref=run |
| peer direct message | owner=host, source=swarm.peer, ref=delivery; logical author remains peer |
| broadcast delivery | same as peer; broadcast remains one-way semantics |
| continuation | owner=host, never Goal/user authorization |
| recovery | owner=host, never new user objective |
| coordinator notice | owner=host |
| `TextPart.synthetic=false` inside host turn | still host-owned |
| provider role `user` for host turn | still host-owned |
| forged public provenance input | rejected/ignored; trusted producer stamps |
| peer text saying “SYSTEM:” | remains fenced untrusted data |
| crash before recipient Session admission | pending receipt remains retryable |
| failure inside recipient admission transaction | Session input + admitted receipt both roll back |
| crash after recipient admission transaction | Session input + admitted receipt are both durable |
| stale assignment Session calls complete | rejected by lease generation |
| user aborts member | durable pause; peer/continuation cannot resume |

---

## 14. Shared-substrate opportunity

Swarm, Goal, ScheduledTask, TaskTool, and recovery paths all need some form of
trusted host-authored Session admission.

Do not prematurely force them into one generic orchestration framework.

The current target is more concrete than the original wording: generalize
`SessionInput` so semantic user and semantic synthetic items share one durable
admission queue, then let SessionExecution own wake/drain.

If additional repeated orchestration glue emerges after that, the extraction
point remains narrow and Session-owned, with semantics such as:

- trusted producer chooses a registered provenance source;
- optional durable ref/idempotency key;
- host owns the turn;
- provider projection is derived;
- admission respects SessionRunState;
- result exposes the admitted message identity.

That primitive belongs in current Session/SessionInput infrastructure, not in
TaskTool and not in Swarm. V1 `SessionPrompt.hostPrompt` is a compatibility
consumer/reference, not the source of truth for new Swarm semantics.

