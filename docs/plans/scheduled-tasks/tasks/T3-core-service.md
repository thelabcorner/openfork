# T3 — `ScheduledTask` core service (CRUD, due cursor, lease)

**Depends on:** T1, T2  
**Blocks:** T4, T6  
**Read first:** `01-architecture.md` § 2 and § 4; `goal/automation.ts`

## Scope

A **Tier 0** Effect service in the core package. It may depend on the
database, the bus, the clock, and the T2 engine. It may **not** import
`InstanceStore` or anything that transitively loads a workspace runtime.

Surface: `create`, `update`, `remove`, `setEnabled`, `get`, `list`,
`listRuns`, `acknowledge`, `due(now)`, `nextDueAt()`, `claim`, `heartbeat`,
`release`, `recoverStale`, `recordRunStart`, `settleRun`.

## The one invariant that matters

`next_run_at` is recomputed in the **same transaction** as every mutation
that could change it: create, update, enable/disable, run settlement,
and timezone-data invalidation. Nowhere else.

Write a shared test helper `assertCursorConsistent(taskID)` that
recomputes from the pure engine and compares. Call it at the end of
**every** test in this task. That helper is what catches the ninth
mutation path someone adds next year.

## Lease protocol

Mirror `goal/automation.ts` structurally: a conditional `UPDATE ... WHERE
owner IS NULL` (or conditional insert on the unique lease index) so
that **the database adjudicates the race**, not application logic. Return
a lease handle or `null`; never throw to indicate \"someone else won\"
— losing a race is normal operation, not an error.

`recoverStale` reclaims leases whose heartbeat is older than the TTL
and marks their runs `abandoned`. Run it on startup **and** periodically.

## Verification

- All Tier B tests from 05.
- Concurrency fixtures C1, C3, C4 (C2 and C7 land in T4).
- No instance import (this is half of D7).
