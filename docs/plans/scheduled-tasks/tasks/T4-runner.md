# T4 — Process-global runner (timer, claim, dispatch, settle)

**Depends on:** T3  
**Blocks:** T9  
**Read first:** `01-architecture.md` § 2 and § 4; `02-scheduling-semantics.md`

## Scope

One process-global singleton, installed at the hook T0 decision 1 identified.
While started it owns **exactly one timer**. That timer represents either the
earliest recurrence wake (clamped to 60s) or the idle cross-process
reconciliation floor.

```
start        -> grace -> single-flight recoverStale() -> wake()

arm()        -> nextDueAt()
              -> due cursor exists: arm one min(delta, 60s) timer
              -> no cursor: read generation; arm one 60s idle timer

timer expiry -> atomically consume its timer slot before callback
              -> recurrence timer: wake()
              -> idle timer: read generation
                   unchanged -> re-arm idle only
                   changed   -> wake()

wake()       -> dispatch already active? set wakePending and return
              -> planDue(now)
              -> bounded single dispatch batch
              -> batch drains:
                   wakePending -> one fresh wake()
                   otherwise   -> arm()

dispatch     -> claim -> revalidate -> recordRunStart -> heartbeat
              -> executor.execute() -> settleRun
```

## Hard rules

- **One timer, not N.** No per-task timer and no `setInterval` fanout.
- Truly idle cost is bounded to **one primary-key generation read per 60s**.
  If the generation is unchanged, do not scan the task/run tables, evaluate
  recurrence, or materialize an Instance.
- Durable state owns correctness; EventV2 mutation notifications are only the
  immediate same-process accelerator.
- Dispatch concurrency is **globally bounded per runner**, not merely
  per-batch. Dispatch batches never overlap; concurrent wakes coalesce into one
  `wakePending` follow-up scan.
- Timer ownership is epoch-guarded: an expired/superseded timer cannot erase a
  newer timer, and the callback consumes its slot before re-arming.
- The heartbeat fiber is scoped to the run fiber so it cannot outlive it.
- `settleRun` is unconditional — the executor encodes failures as outcomes.
- Suspend/resume: on wake, always re-read the clock and authoritative durable
  state rather than trusting timer timing.

## Verification

- C1, C2, C6, C7, C8 and C9 from 05. C1/C2/C9-storage use real processes.
- D3: 60 simulated idle minutes produce zero dispatch work while preserving one
  reconciliation timer.
- D4/N2: 200 tasks and an empty task set both preserve the one-timer ceiling.
- C6: an overlapping timer wake + manual poke still peaks at exactly the
  configured dispatch concurrency.
- Kill a runner mid-run; confirm reclaim and `abandoned` on restart.
