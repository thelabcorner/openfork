# T9 — Negative invariants, concurrency proofs, closeout

**Depends on:** T4, T5, T8  
**Blocks:** nothing (this is the gate)  
**Read first:** `05-verification.md` in full

## Scope

This task owns the **negative** evidence. Everything else proves the
feature works; T9 proves it did not quietly break the architecture on
the way in.

## Deliverables

1. **D1–D7** from 05 § 2 Tier D, all wired into CI. Start with **D7**
   (static import-graph assertion: only `executor.ts` may import
   `InstanceStore`). It is the cheapest to write and the most valuable
   over time.
2. **C1–C8** from 05 § 2 Tier C. C1 and C2 **must** use two real
   processes against one database file. Two fibers in one process do
not
   prove anything — in-process scheduling serializes them by accident.
3. **Performance measurement** against the budget table in 05 § 5.
Record
   actual numbers, not assertions that it \"feels fast\".
4. **Manual QA 1–4** from 05 § 4, performed once on a real machine and
   written up.
5. **Closeout note** in `docs/handoff/` following the existing
   `CLOSEOUT-*` convention.

## What the closeout note must contain

- The measured numbers next to the predicted budget. If a budget was
  missed, say so plainly rather than silently re-baselining — that is
  the documented expectation for performance work in this repo.
- How each of the nine T0 decisions **actually** resolved, including
any
  that changed during implementation.
- Which Medium/Low confidence claims in 06 were confirmed or
  falsified. The headless-session assumption (T5) and the
shared-data-dir
  assumption (T0 #2) are the two that matter most.
- Anything deferred, with a reason and a suggested trigger for
  revisiting it.

## Do not declare done until

All seven items in 05 § 6 \"Definition of done\" are true. Partial
completion is fine to report — quietly redefining \"done\" is not.
