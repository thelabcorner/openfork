# T4 — Process-global runner (timer, claim, dispatch, settle)

**Depends on:** T3  
**Blocks:** T9  
**Read first:** `01-architecture.md` § 2 and § 4; `02-scheduling-semantics.md`

## Scope

One process-global singleton, installed at the hook T0 decision 1 identified.
It owns **exactly one timer** and nothing else.

```
start     -> recoverStale() -> arm()

arm()     -> nextDueAt() -> if null, stay idle (0 timers armed is fine)
           -> else schedule one timer for (nextDueAt - now), clamped to +0

wake()    -> due(now) -> for each, bounded-concurrency dispatch -> arm()

dispatch -> claim -> (lost? skip silently) -> recordRunStart -> heartbeat
fiber
            -> executor.execute() -> settleRun -> release -> arm()

mutation event -> arm()             (re-arm on any cursor change)
```

## Hard rules

- **One timer, not N.** No `setInterval` polling loop. An idle runner
issues
  zero queries (regression D3).
- Dispatch concurrency is **bounded** (02 § dispatch cap). 100 simultaneous
  due tasks must not start 100 sessions.
- The heartbeat fiber is **scoped to the run fiber** so it cannot outlive
it.
- `settleRun` is unconditional — the executor cannot fail the effect (03 §
  1), so there is no path that skips it.
- Suspend/resume: on wake, **always** re-read the clock and re-query rather
  than trusting the timer fired on time. Sleeping laptops make timers
lie.

## Verification

- C1, C2, C6, C7, C8 from 05 — **C1/C2 with two real processes**.
- D3 (idle = 0 queries) and D4 (N tasks = 1 timer).
- Kill -9 a runner mid-run; confirm reclaim and `abandoned` on restart.
