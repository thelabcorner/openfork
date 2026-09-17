# T0 — Design gate (blocking, human decision required)

**Depends on:** nothing  
**Blocks:** everything  
**Deliverable:** a decision log appended to `06-risks-and-open-questions.md`

Do **not** write runtime code in this task. Read 01–05 and the
repository-root `AGENTS.md` first.

## Decisions to resolve

1. **Process ownership.** Confirm where a process-global singleton is
   installed today and mirror it. Verify by reading the global lifecycle
   module and the existing projector initialization, and record the
exact
   hook the runner will use.
2. **Multi-process reality.** Determine empirically whether two app
   processes can share one data directory. If yes, the lease table is
   mandatory as specified. If no, record the evidence — do not remove
   the lease on assumption.
3. **Recurrence dependency.** Choose between a cron parser dependency
and
   a hand-rolled evaluator. `luxon` is already in the lockfile; no cron
   library is. Weigh adding one dependency against owning DST correctness
   yourself. Record the choice and the reason.
4. **Fan-out.** One target per task (v1) or N? This changes the
   idempotency key and is painful to retrofit — see 01 § 3.5.
5. **Permission default.** Confirm `deny` against whatever sandboxing
   actually exists here (03 § 5.1). If a sandbox exists, say so and
   reconsider; if not, `deny` stands.
6. **Goal budgets.** Do unattended scheduled goals get tighter default
   bounds than interactive ones? (03 § 4.1. Recommendation: yes.)
7. **Quota-aware retry.** Does v1 use known quota reset times or plain
   backoff? (03 § 6.)
8. **Navigation.** Global Scheduled pane or per-project? (04 § 10.)
9. **Kill switch.** Confirm a global \"pause all schedules\" control is
in
   v1 scope.

## Exit criteria

- All nine decisions recorded with a one-line rationale each.
- Any decision that contradicts 01–05 is reflected **back into those
  documents**, not left as a contradiction for the implementer to
discover.
