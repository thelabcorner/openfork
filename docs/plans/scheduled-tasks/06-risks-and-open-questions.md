# Risks, Confidence, and Open Questions

## 1. Confidence levels

| Claim | Confidence | Basis |
| --- | --- | --- |
| OpenChamber ships scheduled tasks (cron/daily/weekly, run-as-goal,
markdown loop files) | High | Its README and `scheduled-tasks` docs page |
| Codex/ChatGPT ships scheduled tasks with an inbox-style Scheduled view and
worktree isolation | High | OpenAI help centre and automations docs |
| This repo has no existing scheduler and no cron dependency | High | grep
over `packages/*/src` and `bun.lock` |
| `goal/automation.ts` is the right lease precedent | High | Read
directly: reservation id   owner   claim/release |
| The executor can originate a session headlessly | **Medium** | Inferred
from the prompt/ingress surface; **T5 must verify** |
| Two app processes can share one data directory | **Low** | Not
verified; T0 decision 2 |
| The existing filesystem watcher can be subscribed to for loop files |
**Low** | Not verified; why T7 is optional |

Rows marked Medium or Low are **not design weaknesses to hide** — they are
the precise places where the plan could be wrong, and each is assigned to
a task that will find out early.

## 2. Top risks

1. **Duplicate unattended runs.** The worst outcome: two agents editing
one
   repository simultaneously at 3am. Mitigated by the lease   the
   `(task_id, fire_for)` unique index — **two independent mechanisms
on
   purpose**. Tested by C1/C3/C7.
2. **Catch-up storm after sleep.** Mitigated by an explicit catch-up
policy
   with `latest` as the default and a max-age bound. Tested by C8  
   manual QA 1.
3. **Unsupervised permission escalation.** Mitigated by `deny` default
and
   the `pause` mode. This is a *policy* mitigation, not a sandbox —
say
so
   plainly rather than implying stronger guarantees than exist.
4. **Silent cost growth.** Scheduled goals can burn tokens indefinitely.
   Mitigated by tighter unattended budgets, the circuit breaker, and
the
   inbox surface.
5. **Architectural rot.** The Tier 0 boundary is only real if it is
   enforced. Mitigated by the D1–D7 negative tests, especially the
static
   import assertion D7.
6. **DST correctness.** Mitigated by fixtures over intuition, and by
   storing the IANA zone rather than an offset.

## 3. Explicit non-goals for v1

- No delegation to `launchd` / `systemd` / `schtasks`.
- No second autonomy mechanism parallel to `Goal`.
- No natural-language schedule *storage* (generation only, phase 2).
- No multi-target fan-out unless T0 decides otherwise.
- No silent defaults for catch-up, overrun, jitter, or retry.

## 4. Decision log (filled in by T0)

| # | Decision | Resolution | Rationale | Date |
| --- | --- | --- | --- | --- |
| 1 | Process ownership hook | _pending_ | | |
| 2 | Multi-process shared data dir | _pending_ | | |
| 3 | Recurrence dependency | _pending_ | | |
| 4 | Fan-out in v1 | _pending_ | | |
| 5 | Permission default | _pending_ | | |
| 6 | Unattended goal budgets | _pending_ | | |
| 7 | Quota-aware retry | _pending_ | | |
| 8 | Navigation placement | _pending_ | | |
| 9 | Global kill switch | _pending_ | | |

## 5. Counter-arguments worth taking seriously

A fair review should weigh these against the plan:

- **\"Just shell out to the OS scheduler.\"** There is a community
plugin
  for this approach and it is dramatically less code. The case
against
it
  is ownership — no shared run history, no inbox, no cross-platform
  parity, and the scheduler lives outside the app's data model. But
if
  the goal were \"ship something this week\", that approach would win.
- **\"The lease table is over-engineering.\"** True *if* only one process
  ever runs. T0 decision 2 exists to test that assumption rather than
  assume it in either direction.
- **\"Run history should be per-attempt.\"** The plan collapses retries
into
  one row for inbox clarity. If forensics matter more than clarity,
add
a
  child table — do not relax the unique index.
