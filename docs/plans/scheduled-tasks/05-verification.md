# Verification

**Read after:** all of 01–04  
**Owns:** the definition of \"done\"

## 1. Why this feature needs unusual test rigor

Most features fail visibly. This one fails **at 3am, on a machine that
was asleep, in a timezone that just changed offset, to a user who is not
watching.** The bug report arrives weeks later as \"I think it ran twice
once?\" — unreproducible by construction.

Therefore: every temporal and concurrency behavior must be tested
**deterministically and in simulated time**. A test suite that actually
waits for timers is both slow and unable to reach the interesting cases
(DST transitions, 14-day downtime, lease expiry).

## 2. The four test tiers

### Tier A — Pure recurrence (T2)

No database, no Effect runtime, no I/O. Input: `(schedule, timezone,
afterEpochMs)`. Output: `nextEpochMs | null`.

Drive it from the **E1–E14 acceptance fixture table in 02 § \"Acceptance
fixtures\"** as a literal table-driven test. The fixtures are the
contract; if a fixture and the implementation disagree, the fixture wins
until someone edits 02 with justification.

Critical cases that are easy to omit:

- Spring-forward into a **nonexistent** local time (02:30 on a day where
  02:00 jumps to 03:00). Assert the documented policy, not \"whatever the
  library does\".
- Fall-back into an **ambiguous** local time (01:30 occurring twice).
  Assert **exactly one** fire.
- A timezone whose **standard offset itself changed** between tzdata
  releases. 02 describes the invalidation path; prove it recomputes.
- `once` schedules in the past return `null`, not a fire.
- Leap day and month-end (\"31st of every month\" in February).

### Tier B — Service units with a virtual clock (T3)

Real SQLite (in-memory or temp file), injected clock, **no executor**.
Substitute a fake executor that returns a scripted `ExecutionOutcome`.

This tier is where `next_run_at` recomputation lives. Assert the 01 § 4
invariant directly: after every mutating operation, `next_run_at` equals
the pure engine's answer for the current spec. Make it a **shared
assertion helper** called at the end of every Tier B test — that is how
you catch the path someone adds later that forgets to recompute.

### Tier C — Concurrency and recovery (T4, T9)

The hard tier. Two **real runtimes against one database file**, not two
fibers in one process. Fiber-level tests cannot detect a missing
`WHERE reservation_id IS NULL` guard because in-process scheduling
serializes them by accident.

| ID | Scenario | Assertion |
| --- | --- | --- |
| C1 | Two runners, one due task | Exactly one run row; the other loses
cleanly |
| C2 | Runner killed mid-run | Lease reclaimed after TTL; run becomes
`abandoned` |
| C3 | Same `(task_id, fire_for)` inserted twice | Unique index rejects
the second |
| C4 | Task disabled between claim and fire | Run becomes `skipped`, no
session |
| C5 | Task edited mid-run (revision bump) | In-flight run completes on
old spec |
| C6 | 100 tasks due at the same instant | Dispatch concurrency cap
respected |
| C7 | Clock jumps backward (NTP) | No duplicate fire for an already
fired instant |
| C8 | Clock jumps forward 14 days | Catch-up policy honored exactly |

**C7 deserves special attention.** A backward clock jump is the one case
where \"compute the next time and sleep\" silently re-fires. The
`(task_id, fire_for)` unique index is the backstop — C7 exists
specifically to prove the backstop works, not just that it is declared.

### Tier D — Ownership regressions (T9)

These are **negative** tests. They assert that something *does not*
happen, and they are the only thing standing between this feature and
slow architectural rot.

| ID | Assertion | Why |
| --- | --- | --- |
| D1 | Listing tasks causes **0** instance loads | httpapi `AGENTS.md`
asks for this probe explicitly |
| D2 | Reading run history causes 0 instance loads | Same |
| D3 | The idle runner performs 0 queries | No polling loop |
| D4 | N tasks produce **1** timer, not N | `AGENTS.md` concurrency
section |
| D5 | Executor never reads `process.cwd()` | 03 § 2.3 |
| D6 | Deleting a task leaves its sessions intact | 01 § 3.3 |
| D7 | No `scheduled-task` module imports `InstanceStore` except
`executor.ts` | Tier boundary, greppable |

**D7 is the most valuable test in the whole suite** and the cheapest to
write — it is a static import-graph assertion, not a runtime test. It
mechanically prevents the \"just this once\" instance load that would
otherwise appear in month three and quietly undo the architecture.

## 3. The deterministic clock harness

One harness, built in T2, reused by T3/T4/T9. Requirements:

- **Injectable `now`** everywhere. No `Date.now()` in feature code — add
  a lint or grep assertion if practical.
- **Advance by delta**, and advancing runs every timer that would have
  fired in that window, in order.
- **Freeze at an instant** for race construction.
- **Fixed tzdata.** Pin the IANA database version in tests so a node
  upgrade does not spontaneously break DST fixtures — this happens and
  it is infuriating to diagnose.

Effect's test clock covers most of this natively. Prefer it over a
hand-rolled fake; the runtime already depends on it.

## 4. Manual QA that automation cannot cover

Some things genuinely require a human and a laptop:

1. **Sleep/wake.** Create a 5-minute task, close the lid for 20 minutes,
   reopen. Expect exactly one catch-up run (under `latest` policy), not
   four. This is the single most common real-world failure and it is
   very hard to simulate faithfully.
2. **Two desktop instances.** Launch twice against one data directory.
   Expect one run per instant total, not one per process.
3. **Real DST boundary.** Set the system clock to the day before a
   transition and leave it running across it.
4. **Permission pause round-trip.** Schedule a task that will ask for
   permission, confirm it parks as `waiting`, answer it hours later,
   confirm the run resumes and settles.

## 5. Performance budget

From `AGENTS.md` § performance closure: state the budget *before*
implementing, then measure against it.

| Scenario | Budget |
| --- | --- |
| Idle runner, 0 due tasks | 0 queries, 1 armed timer, +0% CPU |
| List 500 tasks | one indexed query, <10ms, 0 instance loads |
| Inbox across 50k runs | indexed, <20ms |
| Timer re-arm after settle | one `MIN(next_run_at)` query |
| 100 tasks firing at once | bounded by dispatch cap, not unbounded
fan-out |

If any budget is missed, the close-out note must say so explicitly
rather than silently re-baselining — that is the documented expectation
for performance work in this repo.

## 6. Definition of done

The feature ships when all of these are true:

1. Every E-fixture in 02 passes.
2. Every C-scenario passes with **two real processes**.
3. Every D-regression passes and is wired into CI (not a manual script).
4. The performance table above is measured, not assumed.
5. The SDK is regenerated and the workspace typechecks.
6. Manual QA 1–4 have been performed once on a real machine.
7. A close-out note exists in `docs/handoff/` following the existing
   CLOSEOUT-* convention, recording what was measured and what the
T0
   decisions actually resolved to.

## 7. What would falsify this design

Stated so reviewers have something concrete to attack:

- If the due-cursor invariant cannot be held under some mutation path
  (e.g. timezone data changing while a run is in flight), the single
  timer design needs a reconciliation sweep and 01 § 4 is wrong as
  written.
- If the host runtime cannot actually originate a session without an
  interactive client attached, the Tier 3 boundary in 03 is optimistic
  and T5 will discover it first.
- If two desktop processes turn out not to share one database file, the
  lease table solves a problem that does not exist and could be
  simplified — but verify that before removing it, because the cost of
  being wrong is duplicate unattended runs.
