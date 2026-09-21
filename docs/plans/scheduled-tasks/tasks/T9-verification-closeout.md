# T9 — Negative invariants, concurrency proofs, closeout

**Depends on:** T4, T5, T8  
**Blocks:** nothing (this is the gate)  
**Read first:** `05-verification.md` in full

## Scope

This task owns the **negative** evidence. Everything else proves the
feature works; T9 proves it did not quietly break the architecture on
the way in.

## Deliverables

1. **D1–D32** from 05 § 2 Tier D, all wired into CI. Start with **D7**
   (static import-graph assertion: only `executor.ts` may import
   `InstanceStore`). It is the cheapest to write and the most valuable
   over time.
2. **C1–C11** from 05 § 2 Tier C. C1/C2 and the C9 storage leg use two real
   processes against one database file. The C9 runner leg uses TestClock so
   the 60-second liveness bound is deterministic rather than a wall-clock
   sleep. Fiber-only tests remain insufficient for lease/SQLite visibility races.
3. **Performance measurement** against the budget table in 05 § 5. Record
   actual numbers, including the average cost of the idle generation probe, not
   assertions that it "feels fast".
4. **Manual QA 1–5** from 05 § 4, performed once on a real machine and
   written up. Automated substitutes may increase confidence but do not convert
   this release gate into an automated-only gate.
5. **Closeout note** in `docs/handoff/` following the existing
   `CLOSEOUT-*` convention.
6. **Conversational-admission proof:** `scheduled_task` is provider-visible,
   but its Core creation path remains Tier 0, derives ownership from the
   durable root Session, requires the active human worker root, rejects stale
   consent/child Sessions/ambiguous wall-clock timezone, and is idempotent for
   exact provider replay.
7. **Session-convergence proof:** a Scheduled run root is directly human
   promptable through the ordinary Session composer/prompt API; a
   foreign-directory root belonging to a project appears through the
   bootstrap-free project-scoped Session census, converges through ordinary
   Session create/update/delete events, and opening Chats performs no Scheduled
   list/inbox read.

## What the closeout note must contain

- The measured numbers next to the predicted budget. If a budget was
  missed, say so plainly rather than silently re-baselining — that is
  the documented expectation for performance work in this repo.
- How each T0/post-T0 decision **actually** resolved, including the
  cross-process liveness decision added after the lost-wake proof. Record later
  refinements rather than silently preserving superseded assumptions.
- Which Medium/Low confidence claims in 06 were confirmed or
  falsified. The headless-session assumption (T5) and the
shared-data-dir
  assumption (T0 #2) are the two that matter most.
- Anything deferred, with a reason and a suggested trigger for
  revisiting it.

## Do not declare done until

All seven items in 05 § 6 \"Definition of done\" are true. Partial
completion is fine to report — quietly redefining \"done\" is not.
