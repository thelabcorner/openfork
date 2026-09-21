# HANDOFF — Goal continuation, turn provenance, and V1/V2 message semantics

**Date:** 2026-09-18
**Status:** Root cause proven and architecture converged. V1 and current/V2 Goal continuations use durable conversational/Synthetic placement instead of worker System injection; V1 crash-recovery/idempotent materialization and causal-root ownership are implemented; replaceable Goal STATE is now transparent across execution, context, fork, throughput, pagination, and presentation boundaries. Focused provenance/Goal verification is green; repository-wide OpenCode/App production checks remain blocked only by unrelated concurrent worktree diagnostics.
**Primary owners:** `packages/schema/src/v1/session.ts`, `packages/core/src/v1/session-turn-provenance.ts`, `packages/opencode/src/session/*`, `packages/core/src/goal/*`.
**Blast radius:** Goal continuation, worker/auditor isolation, prompt caching, compaction/recovery, checkpoints/revert/fork semantics, title/model/Goal provenance, timeline/session inspection.

> **Concurrency supersession note (2026-09-18):** this handoff remains
> authoritative for Goal provenance, durable continuation content, deterministic
> materialization, and causal-root semantics. Its current
> `GoalAutomation.reservation_owner` mechanics are **not** the target
> multi-process execution architecture. The later Swarm concurrency handoff
> protocol standardizes Goal automatic continuation as
> `SessionInput(Synthetic, admission_class=automatic)`, moves worker execution
> exclusivity under shared Session ownership, and makes the independent Goal
> Auditor own/fence its stable child Session. Do not preserve the historical
> assumption that a foreign Goal process owner implies a dead predecessor.

---

## Executive summary

The original Goal bug was real: an auditor-authorized continuation was inserted into the worker's **system prompt array** instead of becoming a durable conversational turn. That caused role contamination, invalidated prompt-cache prefixes on every autonomous cycle, and made the continuation invisible to history/debugging.

That channel/ownership defect is structurally fixed in the live worktree.
V1 Goal continuations are durable host-owned user-role turns with synthetic
content; current/V2 materializes the same orchestration as durable
`SessionMessage.Synthetic`; neither path threads continuation text into the
worker System array.

The adversarial crash window in V1 was also closed. Modern GoalAutomation
reservations now durably carry the causal source, continuation message/part
identity is deterministic from the reservation, and retry repairs the same
logical turn rather than transcript-scanning or appending a duplicate. A
focused fault regression seeds the exact message-without-part crash state and
proves recovery converges to one complete continuation.

The deeper architectural finding is broader than Goal Mode:

> In V1, `role: "user"` is a provider-facing conversation role. It does **not** mean “human/user-owned turn.”

V1 historically overloaded `role: "user"` for human prompts, Goal continuations, compaction followups, recovery turns, shell followups, task/host prompts, and other host-authored context. Code then attempted to recover semantic ownership from `part.synthetic`, message text, or feature-specific metadata.

The current/V2 architecture gives us the right semantic direction. `SessionMessage.User`, `Synthetic`, `Shell`, `Compaction`, `System`, and `Assistant` are distinct semantic message kinds; provider roles are a later projection. Crucially, **host-authored is not synonymous with privileged**: Goal continuations and other host orchestration remain conversational Synthetic state and can lower to provider `user`, while genuinely privileged runtime policy remains System authority.

The V1 backport therefore uses **message-level turn provenance** plus a centralized compatibility classifier. Provider role, durable semantic ownership, semantic kind, and authority are deliberately orthogonal.

### 2026-09-18 convergence addendum

The repository maps were re-read during closeout and sharpened the dependency
direction: current/V2 is the semantic oracle/donor, not a mandate to migrate the
mature V1 runtime. Browser-safe shared policy now lives in Schema where possible;
Core owns domain projections; V1 receives narrow adapters/backports.

Two lifetime classes are now explicit for host conversational data:

```text
EVENT / derived turn
  e.g. goal.continuation
  durable causal boundary; append/replay/fork semantics apply

STATE / replaceable projection
  e.g. goal.spec, goal.progress
  current domain state; visible/model-facing where required but transparent to
  worker-root selection, assistant parenting, throughput turns, context overlays,
  fork boundaries, and timeline grouping
```

This distinction prevents a provider-user compatibility role from turning
replaceable state into a fake conversational turn.

The hybrid App bridge also no longer relies on the stale vendored current client
to define OpenFork provenance semantics. It preserves that vendor's transient
lifecycle union while enriching provenance through one browser-safe compatibility
type backed by Schema policy.

---

## The architecture in one diagram

```text
                     durable / semantic layer

 Human prompt       ────────> kind: user       / authority: conversational
 Goal continuation ────────> kind: synthetic  / authority: conversational
 Goal spec/progress ───────> kind: synthetic  / authority: conversational
 Shell followup     ────────> kind: shell      / authority: conversational
 Compaction         ────────> kind: compaction / authority: conversational
 Host mechanism     ────────> kind: system     / authority: privileged
 Assistant turn     ────────> kind: assistant

                               │
                               │ provider/runtime compiler
                               ▼

                     provider / LLM protocol layer

 user       ───────────────┐
 synthetic  ───────────────┤
 shell      ───────────────┼──> provider role: "user"
 compaction ───────────────┘

 assistant  ──────────────────> provider role: "assistant"
 system     ──────────────────> authority-preserving privileged representation
                                 (system/developer/top-level system/etc.)
```

**Never infer the left-hand semantic kind, ownership, or authority from the right-hand provider role.**

### Canonical semantic axes

For model-visible content, keep these questions separate:

| Axis | Question | Goal continuation example |
| --- | --- | --- |
| authoritative domain owner | which service/table can prove the current state? | GoalAutomation reservation |
| turn ownership/provenance | who caused/owns this durable turn boundary? | host / `goal.continuation` |
| semantic kind | what kind of Session item is it? | Synthetic |
| instruction authority | how strongly should it constrain the model? | conversational/user lane |
| lineage / correlation | what durable cause/state does it derive from? | Goal id/reservation + source worker turn |
| fragment origin | where did an individual content fragment come from? | synthetic text |
| trust class | may embedded bytes themselves carry host authority? | host-authored orchestration text; not privileged policy |
| provider projection | how does this exact API/runtime encode it? | provider `user` |

Do **not** call lineage "causal authority." Causality answers *why this item
exists*; instruction authority answers *how strongly the model should prioritize
its contents*. They are orthogonal.

Permanent laws:

- **Host-authored does not imply privileged.**
- **Provider `role=user` does not imply human-authored.**
- Provenance source does not grant System authority.
- A user authorization does not permanently own mutable derived state. Once a
  Goal exists, the Goal domain owns its current specification/progress; creation
  source-message lineage remains audit provenance.
- A true privileged System policy must never be demoted to provider-user merely because an SDK/route cannot encode chronological System messages. The provider compiler must use an authority-preserving representation or fail closed.
- Provider cache reuse is subordinate to semantic authority; never weaken authority merely to preserve a prefix.

### Goal-specific canonical decomposition

```text
                          Goal domain
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
          ▼                   ▼                    ▼
 stable mechanism policy   specification          progress
 domain owner: host        domain owner: Goal     domain owner: Goal/runtime
 turn owner: host          projection owner: host projection owner: host
 kind: System              kind: Synthetic        kind: Synthetic
 instruction authority:    instruction authority: instruction authority:
 privileged                conversational         conversational
 wire: privileged channel  wire: provider user    wire: provider user

 auditor continuation
   domain owner: GoalAutomation/auditor handoff
   turn owner: host
   kind: Synthetic
   instruction authority: conversational
   lineage: goalID + reservation + worker source turn
   wire: provider user
```

The original user turn that authorized Goal creation is durable origin/audit
lineage. It is **not** the current-state owner. For current Goal projections,
`goalID` plus current revision is the primary semantic lineage/version; use the
creation source message only where audit/authorization history actually needs it.

---

## Historical root cause: Goal continuation was put in `system`

Before the fix, `SessionPrompt` built the worker system array with the claimed Goal continuation appended to it:

```ts
const system = [
  ...env,
  ...instructions,
  ...(mcpInstructions ? [mcpInstructions] : []),
  ...(skills ? [skills] : []),
  ...(goalSystem ? [goalSystem] : []),
  ...(goalReservation ? [goalReservation.prompt] : []),
  ...(monitorContext ? [monitorContext] : []),
]
```

The code also explicitly justified retaining the old user checkpoint/transcript because “no fake user message exists.” That decision collapsed a host-authored turn boundary into privileged worker system context.

Three defects followed from the same structural mistake:

1. **Role contamination.** Auditor-authored orchestration appeared in the worker's highest-authority channel without attribution or a turn boundary.
2. **Prompt-cache destruction.** The per-cycle-changing continuation mutated the system prefix, invalidating downstream prefix-cache reuse for the whole conversation.
3. **Invisibility.** The continuation had no durable Session message/part, so history, timeline, debugging, fork/revert logic, and post-hoc forensic inspection could not observe what the worker received.

The worker/auditor **execution** boundary was not the primary defect; the return channel was.

---

## Immediate structural fix now in the worktree

`packages/opencode/src/session/prompt.ts` now materializes a claimed Goal continuation as a durable user-role message before the next worker request.

Conceptually:

```ts
const continuationUser: SessionV1.User = {
  ...source.info,
  id: MessageID.ascending(),
  provenance: SessionTurnProvenance.host(
    SessionTurnProvenance.Source.GoalContinuation,
    {
      sourceMessageID: source.info.id,
      ref: reservation.id,
    },
  ),
  time: { created: Date.now() },
}

await persist(continuationUser)
await persist({
  messageID: continuationUser.id,
  type: "text",
  text: reservation.prompt,
  synthetic: true,
})
```

The continuation is no longer appended to the worker `system` array.

This fixes the original Goal bug while preserving provider compatibility: V1 still lowers the durable continuation to provider role `user`, but the durable message says that the host owns the turn.

---

## Why `part.synthetic` is not enough

`TextPart.synthetic` remains useful, but it answers a **different question**:

> Was this individual content fragment generated by OpenCode rather than directly supplied as prompt content?

It does **not** authoritatively answer who owns the conversational turn.

A real user-owned prompt can legitimately contain synthetic parts, for example MCP/resource expansion. Conversely, a Goal continuation is a host-owned turn whose text part is synthetic. Slash-command/template expansion may contain host-authored bytes while the user still owns the turn boundary.

Therefore V1 explicitly models message-level turn provenance and part-level syntheticness, while the broader current architecture additionally keeps semantic kind, intended authority, and provider projection independent. Do not collapse these dimensions again.

---

## V1 durable provenance contract

`packages/schema/src/v1/session.ts` now defines `UserTurnProvenance` on V1 `User` messages.

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

`User.provenance` is optional **only for persisted V1 compatibility**. New durable user-role messages should be stamped by their trusted producer.

Important semantics:

- `owner` is the authoritative ownership/security boundary.
- `source` is attribution/correlation, not authority.
- `sourceMessageID` carries causal lineage/checkpoint ancestry for host continuations.
- `ref` carries exact idempotency/correlation identity such as a Goal reservation ID.
- public `PromptInput` must not allow clients to spoof provenance; admission paths stamp it themselves.

No SQL migration is required. `MessageTable.data` already stores the V1 message payload as JSON, and `SessionProjector` persists the full message payload from `MessageUpdated` events.

---

## Centralized V1 compatibility classifier

`packages/core/src/v1/session-turn-provenance.ts` is the sole compatibility boundary for old V1 rows and semantic classification.

It defines stable producer sources including:

- `prompt`
- `command`
- `shell`
- `plan.approval`
- `host.prompt`
- `task.summary`
- `goal.continuation`
- `recovery.continuation`
- `compaction`
- `compaction.replay`
- `compaction.continue`
- special-agent sources for Prompt Revisor and Goal Auditor

The central classifier exposes V2-compatible semantic kinds:

```ts
type SemanticKind =
  | "user"
  | "synthetic"
  | "shell"
  | "compaction"
  | "assistant"
```

For new rows, classification is O(1) from explicit message provenance plus message structure. Only old rows without `provenance` are allowed to use the legacy part-shape inference, and that fallback is marked `confidence: "legacy-inferred"`.

**Do not recreate legacy inference in consumers.** If another subsystem needs semantic ownership, add/reuse a purpose-specific helper in this module.

---

## V2/current semantic taxonomy is the behavioral reference

The backport is intentionally modeled after the current message architecture rather than inventing a permanent V1-only taxonomy.

This statement is intentionally narrow after the cache/context adversarial
review. Current `SessionMessage.User/Synthetic/Shell/Compaction/System` is the
semantic taxonomy reference. It does **not** mean every current V2 Context Epoch,
provider fallback, cache, or publication mechanism is an implementation oracle.
The cache ledger now documents concrete current-V2 hardening needs including
render-version identity, newly-required-source availability and route-aware
privileged System placement.

Relevant current/V2 contract:

- `packages/schema/src/session-message.ts`
  - `SessionMessage.User`
  - `SessionMessage.Synthetic`
  - `SessionMessage.Shell`
  - `SessionMessage.System`
  - `SessionMessage.Compaction`
  - assistant/tool message contracts
- current runner lowering converts semantic non-human kinds to the provider role required by the LLM protocol.

The intended eventual migration is therefore straightforward:

```text
V1 role=user + semantic kind=user       -> current SessionMessage.User
V1 role=user + semantic kind=synthetic  -> current SessionMessage.Synthetic
V1 role=user + semantic kind=shell      -> current SessionMessage.Shell
V1 role=user + semantic kind=compaction -> current SessionMessage.Compaction
```

V1 provenance is a compatibility bridge toward that architecture, not a competing permanent design.

---

## Ownership and semantic kind are deliberately orthogonal

Do not simplify the model to `owner=user => kind=user`.

Examples:

| durable event | owner | semantic kind | provider role |
| --- | --- | --- | --- |
| human prompt | user | user | user |
| slash command | user | user | user |
| user-triggered shell followup | user | shell | user |
| plan-approval generated context | user | synthetic | user |
| scheduled/host prompt | host | synthetic/user-worker-source depending purpose | user |
| Goal continuation | host | synthetic | user |
| recovery continuation | host | synthetic | user |
| compaction continuation | host | compaction/synthetic according to durable shape | user |

This is why consumers need **purpose-specific selectors**, not one vague `isRealUserMessage()` helper.

---

## Purpose-specific selectors

`SessionTurnProvenance` currently exposes helpers such as:

- `isUserOwnedTurn(message)` — ownership only;
- `isHostOwnedTurn(message)` — ownership only;
- `semanticKind(message)` — V2-compatible presentation/runtime kind;
- `isSemanticUserTurn(message)` — actual semantic user-intent turn;
- `isWorkerPromptTurn(message)` — valid source for worker model/objective provenance;
- `isGoalAuthorizationTurn(message)` — valid user-owned turn for Goal lifecycle authorization;
- `checkpointRootMessageID(message)` — causal rollback root for host continuations;
- `hasHostCorrelation(message, source, ref)` — exact host idempotency/correlation.

The distinction is intentional. A shell turn can be user-owned without being a worker-objective prompt. A scheduled `host.prompt` can be a legitimate worker model/objective source without becoming a human-authored user turn. A Goal continuation can lower as provider role `user` while remaining host-owned and semantically synthetic.

---

## Trusted producer rule

Provenance is stamped where the turn is admitted/produced. It is not caller-supplied metadata.

Examples now being migrated/stamped include:

- `SessionPrompt.prompt()` -> user / `prompt`
- command admission -> user / `command`
- `SessionPrompt.hostPrompt()` -> host / `host.prompt`
- shell followup -> user / `shell`
- plan approval -> user-owned / synthetic semantic source
- Goal continuation -> host / `goal.continuation`
- stream/recovery continuation -> host / `recovery.continuation`
- compaction and compaction replay/continue -> host compaction sources
- task summary/followup -> host source
- special-agent internal messages -> special-agent source

If a new autonomous/host producer creates a durable V1 user-role message, it must stamp provenance at construction time.

---

## Broad behavioral rewrite rule

This migration is intentionally broader than Goal Mode.

Any V1 code using `role === "user"` must be classified into one of two categories:

### 1. Semantic ownership / user-intent behavior

These must use provenance / semantic-kind helpers rather than provider role. Examples:

- Goal authorization and Goal objective/model provenance;
- user supersession of autonomous work;
- title-generation source selection;
- current model/worker prompt source selection;
- compaction replay and “newer real user input” decisions;
- revert/fork/composer roots;
- checkpoint ancestry;
- timeline/context-ledger/session-inspection attribution;
- UI labels that say “user” or “you”;
- any permission/authorization decision that depends on user ownership.

### 2. Provider/structural conversation mechanics

These may intentionally remain role-based. Examples:

- V1-to-provider message lowering;
- provider conversation grouping;
- APIs that require a provider-compatible user/assistant alternation;
- low-level transport transformations where host turns must still appear as provider `user`.

Do not mechanically replace every `role === "user"`; replace every **semantic ownership assumption**.

---

## Goal continuation after the provenance backport

The correct Goal flow is now:

```text
human/user-owned prompt
  role=user
  provenance={ owner:user, source:prompt }
        │
        ▼
worker cycle
        │
        ▼
independent auditor child/session
        │
        ▼
auditor verdict = continue
        │
        ▼
Goal continuation reservation
        │
        ▼
durable continuation turn
  role=user                       # provider compatibility only
  provenance={
    owner:host,
    source:goal.continuation,
    sourceMessageID:<original worker prompt>,
    ref:<reservation id>
  }
  text part synthetic=true
        │
        ▼
worker cycle
```

The worker system prompt no longer contains the per-cycle auditor continuation.

---

## Checkpoint / revert / fork semantics

A host continuation creates a durable model-facing turn boundary but **does not create a new user-owned rollback root**.

Goal continuation provenance stores `sourceMessageID` pointing at the original worker/user turn. `checkpointRootMessageID()` resolves that causal root so restart/recovery does not accidentally anchor rollback to an autonomous continuation.

This preserves the intended semantic unit:

> one user-owned Goal run remains one rollback/checkpoint transaction even when it contains multiple autonomous worker/auditor cycles.

Fork/revert/composer surfaces must likewise distinguish semantic user turns from host/synthetic turns when deciding what to restore to the user.

---

## Cache and performance properties

The provenance architecture is intentionally cheap:

- provenance is persisted in the existing `message.data` JSON payload;
- no new SQL table or index is required;
- explicit provenance classification itself adds no history hydration;
- explicit provenance lookup is O(1);
- legacy inference is isolated to old rows only;
- no new workspace `Instance` is created to classify a message;
- provenance is not serialized into provider messages, so it adds **zero prompt tokens**;
- Goal continuation text is appended to transcript history rather than mutating the worker system prefix, preserving prior prefix-cache reuse.

This follows the root `AGENTS.md` source-of-truth rule: the producer stamps the semantic fact once; consumers do not reconstruct it from parts or UI artifacts.

The producer-ownership correction is now implemented for modern V1
reservations. `GoalAutomation` persists the causal source message ID and owns
the reservation identity. V1 derives stable continuation message/part IDs from
that reservation and uses exact keyed lookup rather than hydrated transcript
scans.

The formerly dangerous boundary:

```text
updateMessage(continuation with provenance/ref)
  -> CRASH HERE
updatePart(continuation text)
```

is now a repairable state. Restart resolves the same deterministic message and
part identities; an existing correlated message without its expected text part
is completed rather than mistaken for success or duplicated. Legacy
pre-migration reservations may retain compatibility fallback behavior, but the
modern correctness path is O(1) in transcript length.

---

## UI / observability expectations

Presentation should expose semantic kind/ownership rather than silently rendering every V1 user-role turn as the human user.

Examples:

```text
USER       · prompt
USER       · command
SHELL      · shell
SYNTHETIC  · goal.continuation
SYNTHETIC  · recovery.continuation
COMPACTION · compaction
```

The UI must not recover this by scanning text parts. It should consume the message's explicit provenance/semantic projection.

For old messages without provenance, compatibility inference may be surfaced as legacy/unknown confidence where useful, but clients should not duplicate the inference algorithm.

---

## Legacy compatibility policy

Old persisted V1 rows have no `provenance` field. We are **not** performing a database backfill because many historical rows are intrinsically ambiguous and the message JSON payload already supports additive compatibility.

Only `SessionTurnProvenance.resolve()` is allowed to infer legacy ownership from part shape.

It returns a confidence marker:

```text
explicit
legacy-inferred
```

New code must not treat a legacy inference as stronger evidence than explicit provenance.

---

## Negative invariants required for closure

These tests should remain permanent because they catch the original ownership failure, not merely the current implementation:

1. **No Goal continuation string appears in worker system-role provider messages.**
2. **Each Goal reservation converges to exactly one complete host-owned continuation turn; a correlated empty/partial turn can never suppress recovery.**
3. **A host Goal continuation still lowers to provider role `user`.**
4. **Privileged `[GOAL AUDITOR ...]` system instructions never appear in worker system messages.**
5. **Worker prompt/model/objective resolution never selects a Goal/recovery/compaction continuation.**
6. **Checkpoint/revert recovery for a host continuation resolves to the original source user turn.**
7. **MCP/resource-generated synthetic parts do not make a genuine user-owned prompt host-owned.**
8. **Shell and plan-approval turns do not accidentally authorize Goal creation merely because the user initiated them.**
9. **Provenance does not change provider prompt bytes except where the original continuation placement itself was intentionally fixed.**
10. **Semantic provenance lookup performs no history scan, no extra request, and no workspace bootstrap.**
11. **Public prompt input cannot spoof host ownership.**
12. **New durable user-role producers stamp explicit provenance.**
13. **Modern Goal reservation dedupe and causal-root lookup do not hydrate/scan transcript history.**
14. **Crash/restart after message publication but before content publication converges to one complete continuation or an explicitly retryable reservation.**
15. **Host ownership/provenance alone never grants privileged System authority.**
16. **Conversational host/Synthetic state may lower to provider `user` without becoming human-owned.**
17. **True privileged System policy is never demoted to provider-user merely because one route/runtime cannot encode chronological System; use an authority-preserving projection or fail closed.**

---

## Process audit / why the original defect survived

The wrong assumption was that provider role implied conversational ownership. Once `role: "user"` was treated as “the human's turn,” a host-authored continuation looked like a fake user message, so the implementation avoided creating it and pushed the text into `system` instead.

Earlier tests checked whether the model received the continuation and whether autonomous execution proceeded. They did **not** assert the channel/ownership invariant, so a continuation delivered through `system` still looked functionally correct.

The negative invariant that would have caught the bug immediately is:

> Auditor-authored continuation text may be appended as host-owned conversational context, but must never mutate the worker's privileged system prefix.

The broader invariant is now:

> Provider role is not semantic ownership. Persist semantic provenance where the turn is produced and lower to provider roles only at the LLM boundary.

This lesson is also carried into repository/package `AGENTS.md`, not only this handoff.

---

## Remaining migration work

At the time of this handoff update, the live worktree contains the provenance schema, centralized Core classifier, and multiple producer/consumer migrations, including the Goal continuation path. Continue auditing remaining V1 semantic `role === "user"` consumers against the two-category rule above.

Particular surfaces to finish/verify include:

- ACP/CLI/session-inspection presentation and replay behavior;
- fork/revert/composer restore semantics;
- compaction and recovery edge cases;
- context-ledger/timeline semantic labels;
- generated SDK/browser-safe projections where provenance is exposed;
- GoalAutomation-owned reservation causality/materialization identity so modern
  continuation recovery performs no transcript scan;
- atomic or explicitly idempotent continuation message+part publication with
  failure-point/restart tests;
- complete package tests and production build after the broad migration.

Do not “finish” the migration by replacing every role comparison mechanically. Structural/provider-role code must remain role-based.

---

## Secondary auditor findings from the same campaign

The continuation/provenance issue was not the only Goal Auditor failure discovered during this campaign. Separate fixes/work include:

- truthful `AUDITING`/`AUDIT ERROR` runtime state;
- user-requested verification preemption;
- real auditor child-session lease ownership;
- provider/model-runtime unification with the worker provider stack;
- five-minute auditor generation+tool execution budget, independent from Goal lifetime;
- oversized ripgrep JSON-record handling;
- missing-path filesystem failures becoming recoverable tool failures rather than auditor defects;
- cross-worktree read-only auditing still requiring careful permission/runtime ownership work.

Keep those concerns separate from turn provenance. Provenance fixes the worker/auditor **return-channel and conversational-ownership model**; it is not a replacement for auditor runtime isolation, permissions, or tool error handling.

---

## Key references

| concern | source |
| --- | --- |
| V1 provenance schema | `packages/schema/src/v1/session.ts` — `UserTurnProvenance`, `User.provenance` |
| centralized V1 compatibility/classifier | `packages/core/src/v1/session-turn-provenance.ts` |
| V1 Goal continuation materialization | `packages/opencode/src/session/prompt.ts` |
| V1 provider lowering | `packages/opencode/src/session/message-v2.ts` |
| V1 compaction producers/behavior | `packages/opencode/src/session/compaction.ts` |
| current/V2 semantic message kinds | `packages/schema/src/session-message.ts` |
| current/V2 runner lowering | `packages/core/src/session/runner/` |
| Goal automation reservation/verdict state | `packages/core/src/goal/automation.ts` |
| Goal Auditor runtime/protocol | `packages/core/src/goal/auditor.ts`, `packages/opencode/src/goal/auditor-runtime.ts` |
| repository ownership contract | `AGENTS.md` |
| long-form ownership methodology | `docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md` |
