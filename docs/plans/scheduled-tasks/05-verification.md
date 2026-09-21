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

The conversational admission service is also proved at this tier with real
SQLite but no execution runtime: root Session ownership is derived durably;
child Sessions and unsolicited creation are rejected; safe defaults and
agent/model inheritance persist; wall-clock schedules without an explicit IANA
timezone fail closed rather than inheriting the server's ambient zone;
`source=agent + sourceMessageID` round-trips; and exact provider
replay returns the existing row rather than creating a duplicate.

### Tier C — Concurrency, recovery, and cross-process liveness (T4, T9)

The hard tier separates **safety** from **liveness**. Lease/idempotency races
that depend on independent SQLite connections use real OS processes. Timer
mechanics use Effect TestClock so the 60-second reconciliation bound is
deterministic rather than making CI sleep.

| ID | Scenario | Assertion |
| --- | --- | --- |
| C1 | Two processes race one due task | Exactly one run row; the other loses cleanly |
| C2 | Runner killed mid-run | Lease reclaimed after TTL; run becomes `abandoned` |
| C3 | Same `(task_id, fire_for)` inserted twice | Unique index rejects the second |
| C4 | Task disabled between claim and fire | Run becomes `skipped`, no session |
| C5 | Task edited mid-run | In-flight run completes on the old spec |
| C6 | Timer wake overlaps another wake while 100 tasks are due | One dispatch batch at a time; global in-flight peak never exceeds the cap |
| C7 | Clock jumps backward (NTP) | No duplicate fire for an already-fired instant |
| C8 | Clock jumps forward 14 days | Catch-up policy honored exactly |
| C9-storage | Peer process queues manual work and exits | SQLite trigger increments durable scheduler generation; another process observes it |
| C9-runner | Durable generation changes but EventV2 wake is absent | Idle runner discovers it within one reconciliation interval and dispatches the queued run |
| C10 | ChunkDB semantic-prune writer overlaps foreground scheduler mutation | Foreground read-modify-write transactions complete without `SQLITE_BUSY_SNAPSHOT`; scheduler mutation transactions reserve the SQLite writer with `BEGIN IMMEDIATE` |
| C11 | Scheduled run outcome overlaps generic Session/push lifecycle and retries | Scheduled Sessions suppress generic done/failed pushes; `never` suppresses outcomes; retryable failures stay quiet; only the current terminal logical run may notify |

**C9 is intentionally split in two.** The storage leg proves cross-process
visibility with two real processes. The runner leg proves generation-to-dispatch
behavior with virtual time. Together they falsify the post-commit writer-death
case without a 60-second wall-clock test.

**C10 is a transaction-ownership regression.** A DEFERRED transaction that reads
and then upgrades to a write can fail with SQLite extended error
`SQLITE_BUSY_SNAPSHOT` (517) if the maintenance connection commits in between.
`busy_timeout` does not help because the snapshot itself is stale. Scheduler
read-modify-write transactions therefore begin IMMEDIATE; the low-priority
ChunkDB writer keeps its short timeout/backoff behavior.

**C11 is an ownership/revalidation proof.** PushV2 consumes the immutable
Scheduled Session metadata only to classify generic Session notifications, while
`scheduledTask.runSettled` is a live wake signal for outcome notification.
Before sending, PushV2 re-reads the current run/task/lease state and rejects stale
attempt projections. The Scheduled inbox/run row remains durable truth; Web Push
delivery is best-effort attention.

### Tier D — Ownership regressions (T9)

These are **negative** tests. They assert that expensive or duplicated work does
not appear as the architecture evolves.

| ID | Assertion | Why |
| --- | --- | --- |
| D1 | Listing tasks causes **0** Instance loads | Tier-0 HTTP ownership |
| D2 | Reading run history causes **0** Instance loads | Same |
| D3 | Unchanged idle generation causes **0 task/run scans, recurrence evaluation, dispatch, and Instance loads** | Liveness floor stays scalar and bounded |
| D4 | Any task count, including zero, produces at most **1** runner timer | Shared timer ownership |
| D5 | Executor never reads `process.cwd()` | Explicit target invariant |
| D6 | Deleting a task leaves its sessions intact | Run/session references are scalar |
| D7 | No `scheduled-task` module imports `InstanceStore` except `executor.ts` | Tier boundary, greppable |
| D8 | Scheduled Session completion/failure never also emits a generic Session outcome push | One producer owns one user-facing outcome notification |
| D9 | Public Session metadata cannot forge Scheduled origin; metadata replacement cannot erase/overwrite it; forks do not inherit it | Session producer identity is producer-owned, not caller-controlled compatibility metadata |
| D10 | Conversational scheduling imports/uses no `InstanceStore`, `InstanceState`, runner, or executor; it derives ownership through durable `SessionStore` and delegates to the Tier-0 writer | Model-facing admission must not collapse creation into execution |
| D11 | The latest worker root must itself be a live human durable-action root; a newer host/scheduled root cannot borrow stale human scheduling consent | Provenance authority is causal/current, not “find any old user message” |
| D12 | Public Scheduled HTTP creation cannot submit `source=agent` or `sourceMessageID`; exact same-origin/spec tool replay is idempotent while conflicting same-name authorization fails closed; `once` normalizes irrelevant timezone before replay comparison | Producer-owned attribution + canonical retry convergence |
| D13 | `ToolRegistry.ids()` and the actual provider-visible manifest both expose one direct `scheduled_task` capability, including the ACP runtime's fork-owned tool set | Natural-language scheduling must not depend on a hidden lazy-tool lookup, client-specific omission, or a duplicate scheduling frontend |
| D14 | An explicit `scheduled_task=deny` permission keeps the provider manifest stable but its execute closure fails before the scheduling body runs | Prompt-cache stability must not weaken per-agent/session authority over durable future automation |
| D15 | A well-formed Scheduled **root** Session accepts ordinary human input through the normal V1 Session prompt transport while generic host takeover still fails; trusted scheduler admission retains `scheduled-task.run` provenance; aggregate/control mutations remain producer-owned; malformed/partial Scheduled origin fails closed before async acknowledgement | User-drivability must not collapse producer admission or aggregate ownership authority |
| D16 | Project-scoped global root census includes root Sessions whose physical directory differs from the canonical worktree and executes with **0** workspace/Instance runtime ownership | Scheduled roots must appear through the canonical Session projection, not a Scheduled-specific sidebar query |
| D17 | V2 Chats applies foreign-directory `session.created|updated|deleted` roots to the canonical project index using durable Session `projectID`, with no Scheduled list/inbox reads or per-event root refetch; directory-only startup state cannot make the event path depend on Scheduled state | Late project identity and live convergence must not create stale/missing/duplicated sidebar rows |
| D18 | A human prompt admitted while a Scheduled provider turn is active becomes the shared `SessionInput` User frontier and is the worker root for the next provider cycle after the current safe boundary; older user-preemptible autonomous input cannot overtake it | Human focus must reuse generalized Session steering semantics, not a Scheduled-only interrupt/queue implementation |
| D19 | 24h/7d/30d calendar enumeration uses one bounded Tier-0 agenda request per visible window and performs no per-task preview fanout | Dense calendar presentation must consume one compact domain projection |
| D20 | Agenda/list/session-binding reads perform **0** Instance loads | Calendar and continuity metadata remain Tier 0 |
| D21 | Auto Session rotation compares the durable `SessionInput.latestUserSeq` frontier; Scheduled code performs no transcript/message/part scan to infer human interaction | Human focus is durable semantic state, not a heuristic |
| D22 | A User admission racing Auto scheduled admission invalidates the expected User frontier; stale scheduled work cannot enter the old Session and rotation/retry converges on a fresh binding | Close the human-input TOCTOU race |
| D23 | Reuse/Auto binding installation is task-revision/CAS fenced; an old run cannot install a Session after target/session-policy edits | Operational binding must not overwrite newer user specification |
| D24 | An Existing/pinned Session remains user-owned and receives no Scheduled aggregate-origin metadata; missing pinned Session fails config rather than silently substituting | Explicit Session selection must not transfer aggregate ownership or degrade intent |
| D25 | Trusted `scheduled-task.run` host admission is authorized from durable run→Session/attempt correlation rather than immutable Session run metadata | Reusable Sessions cannot truthfully own one run ID |
| D26 | Generic Session completion/failure push suppression applies only to the Scheduled-owned worker root/run; later human turns in reused/pinned Sessions retain normal notification ownership | Session reuse must not suppress user notifications forever |
| D27 | An explicit task execution model is honored on every run and unavailable explicit models fail `config` without fallback; task rows/calendar render without provider-catalog hydration | Model choice is durable execution policy while catalog resolution stays Tier 2 |
| D28 | Scheduled Prompt Revisor can change only task prompt text; schedule, model, Session policy, target, and safety policy are unchanged; stale in-flight revision output cannot overwrite a newer draft | Revision reuses one backend without becoming a second task editor |
| D29 | Multi-time daily/weekly schedules survive editor open/edit/save without losing any time entry | UI must not collapse a richer domain schedule to `times[0]` |
| D30 | Existing Session picker uses the compact root Session projection with no history hydration or per-row request and excludes non-user-drivable roots | Session selection must reuse canonical navigation/index ownership |
| D31 | Reuse/Auto reject unstable/per-run execution directories; Existing/pinned Session project+directory is revalidated at fire time and mismatch fails config with no fallback | Session continuity cannot outrun durable location ownership |
| D32 | Run-as-Goal creates one auditable Goal per logical Scheduled run and never steals an unrelated or active Goal focus from a reused/pinned Session | Session reuse must preserve Goal's one-focus-per-Session ownership |

D3 deliberately does **not** mean "zero SQLite reads." That older invariant was
falsified by the cross-process lost-wake case. Correctness requires one
primary-key generation read per reconciliation interval while truly idle; the
negative invariant is that an unchanged generation does not escalate into
expensive work.

**D7 remains one of the highest-value tests** because it mechanically prevents a
cheap catalog/enqueue path from accreting Tier-3 runtime ownership.

D10–D14 are the equivalent guardrail for the model-facing frontend: adding a
tool must not create a second backend scheduler, widen public provenance
authority, make provider retries duplicate durable future work, or silently hide
the capability from the provider expected to invoke it. Stable provider schemas
must likewise never bypass an explicit execution deny.

D15–D18 close the original Session/UI ownership loop. D19–D32 extend that
contract for the first-class scheduler workspace and reusable Session model:
calendar enumeration remains compact/Tier 0, Auto rotation is fenced by durable
User input, reusable bindings are CAS-owned, pinned Sessions remain user-owned,
run authority moves to durable run→Session correlation, notifications remain
producer-correct, model selection stays explicit, Prompt Revisor remains narrow,
and the editor cannot destroy richer schedule semantics.

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
   reopen. Expect exactly one catch-up run (under `run_once` policy), not
   four. This is the single most common real-world failure and it is
   very hard to simulate faithfully.
2. **Two desktop instances.** Launch twice against one data directory.
   Expect one run per instant total, not one per process.
3. **Real DST boundary.** Set the system clock to the day before a
   transition and leave it running across it.
4. **Permission pause round-trip.** Schedule a task that will ask for
   permission, confirm it parks as `waiting`, answer it hours later,
   confirm the run resumes and settles.
5. **Mobile push click.** With notifications enabled, trigger one Session-backed
   scheduled failure and one failure before Session creation. The first must open
   the run Session through the canonical mobile deep link; the second must land on
   the mobile home surface rather than an unsupported Scheduled route.

## 5. Performance budget

From `AGENTS.md` § performance closure: state the budget *before*
implementing, then measure against it.

| Scenario | Budget |
| --- | --- |
| Idle runner, no due cursor | 1 primary-key generation read / 60s, 1 timer, 0 task scans, 0 Instance loads |
| List 500 tasks | one indexed query, <10ms, 0 instance loads |
| Inbox across 50k runs | indexed, <20ms |
| Timer re-arm after settle | one `MIN(next_run_at)` query |
| 100 tasks firing at once | bounded by dispatch cap, not unbounded
fan-out |
| Conversational create, uncontended | 1 Session PK read + 1 normal IMMEDIATE create transaction (whose duplicate-name check uses the indexed `(project_id,name)` key); 0 extra preflight lookup, 0 Instance loads |
| Conversational exact replay/name conflict | normal create attempt + 1 indexed recovery lookup; no list scan, 0 Instance loads |

Latest semantic-prune-enabled measurement (2026-09-18), median of three
isolated runs:

| Scenario | Measured |
| --- | ---: |
| List 500 tasks | 7.37 ms |
| `nextDueAt` over 500 tasks | 1.76 ms |
| 1,000 idle generation reads | 98.31 ms total / 98.31 µs each |
| Inbox newest 50 over 50k runs | 1.31 ms |
| Unread count over 50k runs | 0.56 ms |

Latest 2026-09-19 conversational-admission rerun (semantic pruning enabled)
measured 100 sequential uncontended agent-created schedules at **242.94 ms total /
2.429 ms each**. The same run measured list-500 at 5.30 ms, `nextDueAt` at
1.41 ms, generation reads at 106.63 µs/read, inbox-50/50k at 1.39 ms, and
unread count at 0.53 ms. Conversational creation therefore stays in the Tier-0
millisecond regime while adding no Instance load and no common-path
idempotency preflight.

Latest post-promptability closeout rerun on 2026-09-19 measured list-500 at
**7.97 ms**, `nextDueAt` at **2.71 ms**, 1,000 idle generation reads at
**123.10 µs/read** average, inbox-50/50k at **1.32 ms**, unread count at
**0.54 ms**, and 100 sequential uncontended conversational creates at
**302.17 ms total / 3.022 ms each**. The hard list/inbox budgets remain met;
the rerun is recorded separately instead of replacing the earlier lower medians.

If any budget is missed, the close-out note must say so explicitly
rather than silently re-baselining — that is the documented expectation
for performance work in this repo.

## 6. Definition of done

The feature ships when all of these are true:

1. Every E-fixture in 02 passes.
2. Cross-process storage scenarios use **two real processes**; timer-bound scenarios use deterministic virtual time.
3. Every D-regression (currently D1–D32) passes and is wired into CI (not a manual script).
4. The performance table above is measured, not assumed.
5. The SDK is regenerated through the canonical build command, the generated
   Scheduled contract is current, and the workspace/typecheck evidence is
   recorded. The generator itself must not depend on host-specific shell
   redirection semantics.
6. Manual QA 1–5 have been performed once on a real machine.
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
- If a future execution change makes host-origin session creation require an
  interactive client, the scheduled E2E must fail; that would invalidate the
  Tier-3 executor contract.
- If any mutation can create runnable scheduler state without transactionally
  advancing the durable generation, the C9 liveness proof is false.
- If the supported process topology stops sharing one SQLite database, re-evaluate the lease/generation machinery for that topology — but do not remove it without proving every desktop/server mode changed too.
- If the generation-only idle probe ceases to stay scalar/cheap, replace the transport or storage optimization without making notifications authoritative.
