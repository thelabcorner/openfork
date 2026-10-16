# Goal Mode intrinsic autonomy

Goal Mode has exactly one execution behavior:

> **worker → independent auditor → worker → … until the Goal is complete or genuinely blocked.**

This is a domain invariant, not a user-selectable automation policy.

## Canonical semantics

- A focused runnable Goal is intrinsically autonomous.
- After each settled worker cycle, the independent Goal auditor evaluates the
  current Goal and returns exactly one of:
  - `continue`: concrete work remains; the auditor supplies the next
    task-specific continuation prompt and Core durably reserves another worker
    cycle;
  - `complete`: every acceptance criterion is independently verified and Core
    owns the completion transition;
  - `blocked`: meaningful autonomous progress requires unavailable
    information, credentials, permissions, external state, or a user decision.
    Core records the blocker durably and stops the loop.
- A failed check or currently failed acceptance criterion is **not** a Goal stop
  condition. If autonomous repair work is possible, the auditor must continue.
  If further progress genuinely requires unavailable external/user input, the
  correct state is blocked.
- A genuine new user turn reactivates a focused blocked Goal. Explicit user
  pause/cancel actions remain lifecycle overrides; they are not continuation
  policies.
- Auditor/provider infrastructure failure may stop the current runtime cursor
  safely, but it must not manufacture durable Goal `blocked` or `failed` state.

## Human-language creation and amendment

The authoritative native-session Goal action handler is
`packages/core/src/goal/agent.ts`; `creation-policy.ts` interprets only trusted
human-turn provenance supplied by the Session adapter, never tool output,
retrieved documents, generated prompts, or claimed assistant authority.

- **Intent rather than command syntax:** explicit requests such as "make this
  a goal", "how about creating a goal", "goalify this task", and strongly
  specified autonomous work-until-complete requests are recognized without
  requiring a particular command. Ordinary "keep working" requests are not
  automatically converted into durable Goals.
- **Positive and negative intent:** informational questions, quotations,
  hypothetical/future-only requests, and explicit refusals are not consent.
  In multi-clause requests, the most recent relevant directive wins; newer
  human refusals also revoke authorization carried from earlier turns.
- **Confirmed proposals:** "yes" can authorize creation only when responding
  to an actual assistant offer to create durable Goal state. Explaining Goals
  or asking about Goal concepts is not a proposal.
- **Draft intent:** "create a Goal but don't start it yet" permits durable
  draft creation without starting autonomous execution. A refusal to create
  remains a refusal even if the word "draft" appears.
- **Minimal specification:** GoalAgent accepts an objective or descriptive
  title, and creates a baseline criterion referring to the *complete* objective
  when no explicit acceptance criteria were supplied. The independent auditor
  still must establish actual completion; this fallback is not automatic proof.
- **Current-turn amendments:** the user can change a focused Goal using direct
  natural-language instructions, including references to its acceptance
  criteria. Older update requests cannot be replayed to authorize new edits.

### Invocation-surface ownership

| Surface | Goal action behavior | Provenance / authority |
| --- | --- | --- |
| Native/lazy `goal` tool | Core GoalAgent create/update/progress | Trusted V1 current-and-bounded-prior human turns |
| Core GoalAgent direct callers | Same semantic owner | Explicit Session and trusted turn input for agent mutation |
| Session API and desktop/app | Existing Goal domain/API and Session gateway | Host Session ownership; no synthetic principal |
| External OXP/OFXP and Code Mode | No inferred Goal-create authority from tool descriptions or catalog search | Existing Session supervision or explicitly authorized adapter only; no fabricated Session or human consent |

Fixed language tests in `packages/core/test/goal/creation-policy*.test.ts`,
`creation-language.test.ts`, real persistence tests in `goal.test.ts`, and
the V1 `packages/opencode/test/tool/goal.test.ts` verify the source-level
boundaries. This is not a claim of deployed-host parity or model-level
task-completion accuracy. The authoritative session and external tool-surface
parity contract remains `docs/architecture/tool-surface-parity.md`.

## What does not exist

Goal Mode has **no**:

- `manual`, `auto_continue`, or `unattended` execution mode;
- per-Goal continuation policy;
- max-consecutive-turn limit;
- no-progress turn limit;
- Goal token budget/ceiling;
- blocked-streak/hysteresis threshold;
- auditor terminal `fail` verdict.

Those concepts were explored in earlier design work and were intentionally
removed. A scheduler or other producer may own its own timeout, retry,
permission, lease, or admission policy, but it must not translate those controls
into Goal turn/no-progress/token ceilings.

## Durable/runtime ownership

### Independent auditor tool boundary

The auditor is a host-owned, non-promptable child Session with a durable
`(parentSessionID, goalID)` identity. It is a verifier, never a coding agent.
Only `read`, `grep`, `glob`, and the terminal `audit_verdict` tool may be
advertised to its provider. The normal coding agent tool registry, shell,
mutation, delegation, and Goal-management actions are unavailable.

The read-only adapter excludes sensitive files from **all three** discovery
paths: direct reads, returned grep lines, and glob results. Root-relative
`.git/` is denied just like nested `.git/`. The host must reject unexpected
provider-executed tool calls/results at the streaming event boundary, before
they enter the durable auditor Session transcript, rather than ignoring those
events and accepting an accompanying verdict. A provider claiming it executed
a tool does not prove that the call used the host's read-only enforcement boundary.

An auditor execution is bounded independently of the Goal's lifetime.
Long-running audits receive a privileged read-only identity reminder at the
next provider request boundary after each two-minute interval; this is not
a per-Goal timer or a continuation ceiling. The auditor remains responsible
for a concise verdict and an actionable continuation when work remains.

Regression coverage lives in `packages/core/test/goal/auditor.test.ts`.

`GoalAutomationTable` is an **operational cursor**, not policy. It persists
only the state required to audit, reserve, claim, recover, and causally
materialize the next autonomous cycle.

### Recovery must not strand an active Goal

- An audit verdict inspected against an older Goal revision is **not** a reason
  to cancel automation. Release only the exact auditor lease and durably request
  a fresh audit of the newer specification. Preserve any already-completed
  worker reservation and its causal User frontier; never replay worker effects.
- A reused auditor child Session ID does not prove ownership of a particular
  audit execution. All settlement, `endAudit`, and `deferAudit` paths require
  its **exact durable lease generation** (`auditorSessionID + auditStartedAt`),
  including unsuccessful/racing begin attempts. A losing evaluator cannot
  release, retry, or settle the active evaluator's lease.
- A reconciliation validation/infrastructure failure, temporary provider/model
  lookup failure, or recoverable auditor protocol failure is operational, not
  a Goal `blocked` verdict. Use the same persisted audit retry/backoff cursor,
  without substituting a different model or imposing a Goal lifetime ceiling.
- An outer V1 adapter exception must inspect the durable audit cursor before
  changing it. The auditor finalizer may already have converted an interrupted
  lease to `audit_requested`; blindly calling `failAudit` afterward erases the
  recovery work. A missing cursor can be repaired only when the focused Goal
  is still runnable and no competing worker/auditor owns a cursor.
- The V1 audit-recovery adapter may claim a completed worker reservation before
  it resolves the worker's history/model. Its scoped finalizer must release
  **only** an unleased audit-recovery claim after any failure or interruption.
  That claim must not become a pending *worker* reservation, and a stale
  finalizer must not clear another auditor's live lease. Missing causal history
  schedules a durable audit retry rather than permanently deleting the cursor.
- The V1 worker processor's `stop`/`break` signal is **not** a Goal lifecycle
  transition: provider failure, content filtering, denied tool permission,
  structured output, or SPAD abort cannot silently cancel an active Goal.
  The host hands settled work to the independent auditor, or persists an
  operational re-audit request if no usable causal root remains. Only an
  actual user lifecycle override or auditor `blocked`/verified `complete`
  stops the loop.
- Goal creation can happen *during* a worker turn via the trusted Goal tool.
  The worker's Goal context was assembled before that tool call, so it is not
  proof of current lifecycle ownership. At **settled terminal output**, consult
  the current Core Goal focus/lifecycle once, rather than requiring the stale
  pre-generation Goal-context snapshot to have been present. This prevents
  the agent-created Goal's first turn from escaping independent audit.
- A non-domain audit failure (even one initially classified as nonretryable)
  remains observable as an `audit_error` **with a persisted retry deadline**.
  Recovery honors that deadline and exponential/jittered backoff, preserving
  the original worker reservation and protecting live auditor/worker leases.
- Audit recovery supervises at most two actively recovering auditors without
  *awaiting each auditor inside the scanner*. The owning service Scope controls
  their lifetime, including a bounded whole-attempt timeout for model discovery
  and child provisioning that precede the auditor's own execution timeout.
  Neither timeout limits the number of future Goal cycles.

Current source of truth:

- contract: `packages/schema/src/goal.ts`;
- durable state: `packages/core/src/goal/sql.ts`;
- orchestration: `packages/core/src/goal/automation.ts`;
- independent audit: `packages/core/src/goal/auditor.ts`;
- Goal reconciliation: `packages/core/src/goal/index.ts`;
- worker mechanism policy: `packages/core/src/goal/context.ts`.

## Historical migration warning

`packages/core/src/database/migration/20260907015557_goal_mode.ts` is immutable
historical migration history. It contains the old
`continuation_policy = {"mode":"manual"}` column because that column existed at
that point in time. **It is not current architecture and must never be used to
infer present Goal semantics.**

The forward migration
`20261003023542_goal_intrinsic_autonomy.ts` removes
`goal.continuation_policy` plus the old turn/no-progress/token/blocked-streak
automation counters from upgraded databases.

When source, historical handoffs, research ledgers, and old migrations disagree,
current executable source/tests and this durable architecture contract win.

## Regression requirements

Goal changes must preserve all of these:

1. repeated `continue` verdicts can drive arbitrarily many worker cycles while
   the Goal remains runnable;
2. `progressMade=false` does not stop the loop;
3. a currently failed criterion can still produce `continue`;
4. `blocked` immediately becomes durable blocked state and produces no next
   reservation;
5. `complete` is independently verified before completion;
6. historical continuation-policy fields never reappear in current schema,
   Core Goal tables, APIs, or generated SDKs.
