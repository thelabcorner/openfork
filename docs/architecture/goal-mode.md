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

`GoalAutomationTable` is an **operational cursor**, not policy. It persists
only the state required to audit, reserve, claim, recover, and causally
materialize the next autonomous cycle.

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
