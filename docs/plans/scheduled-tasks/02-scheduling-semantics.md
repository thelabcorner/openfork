# Scheduling Semantics — Time, Recurrence, and Hazards

**Read after:** `01-architecture.md`  
**Owns:** every question of the form \"when exactly does this run, and what if it didn't\"

## 1. Why this document is separate

Time is where schedulers actually break. Not in the queue, not in the UI — in the
five lines that turn \"every day at 2:30am\" into an epoch millisecond. Every item
below is a bug that ships in real products every year.

The governing principle:

+ **Wall-clock intent and instant arithmetic are different types.** A user who
+ says \"09:00 daily\" is expressing a *wall-clock intent in a named zone*.
Storing
+ that as \"every 86400000 ms from epoch X\" is a lossy conversion that
silently
+ breaks twice a year.

## 2. Schedule representation

### 2.1 The discriminated union

OpenChamber exposes four kinds (`daily`, `weekly`, `once`, `cron`). Codex exposes
natural-language cadences plus **RFC 5545 RRULE** for advanced cases. We adopt a
union that covers both ergonomics and power:

```ts
// packages/schema/src/scheduled-task.ts
export const Schedule = Schema.Union([
  // Fires exactly once, then next_run_at becomes NULL and enabled flips off.
  Schema.Struct({ kind: Schema.Literal(\"once\"),    at: Schema.Number }),

  // Ergonomic sugar. Stored structurally (NOT lowered to cron at write time)
  // so the editor can round-trip it and the summary string stays honest.
  Schema.Struct({
    kind:   Schema.Literal(\"daily\"),
    times:  Schema.Array(TimeOfDay),        // [{hour, minute}], max 24
  }),
  Schema.Struct({
    kind:     Schema.Literal(\"weekly\"),
    weekdays: Schema.Array(Weekday),        // 0-6, non-empty
    times:    Schema.Array(TimeOfDay),
  }),

  // Full power. Standard 5-field. Seconds field explicitly REJECTED (see §2.3).
  Schema.Struct({ kind: Schema.Literal(\"cron\"),   expression: Schema.String }),

  // Optional — only if T0 accepts the dependency. See §2.4.
  Schema.Struct({ kind: Schema.Literal(\"rrule\"),   rule: Schema.String }),
])
```

**Why not lower everything to cron immediately?** Because `daily at 09:00 and
17:30` lowers to `0 9,17 * * *` — which is **wrong** (it would fire 17:00, not
17:30). The correct lowering is two separate expressions, which single-expression
cron cannot represent. Multi-time daily/weekly schedules are **not expressible as
one cron string**, so the engine must compute `next` as `MIN` over the set.
This is a real bug that appears in naive implementations; the structural
representation prevents it by construction.

### 2.2 The engine contract

`packages/core/src/scheduled-task/recurrence.ts` exposes **one pure function**:

```ts
export function nextOccurrence(input: {
  schedule: Schedule
  timezone: string | undefined      // IANA id
  after: number                   // epoch ms, EXCLUSIVE lower bound
}): number | undefined               // epoch ms, or undefined if exhausted
```

Non-negotiable properties:

1. **Pure.** No `Date.now()`, no DB, no I/O. `after` is always passed in. This
is
   what makes the deterministic clock harness (T2) possible and makes DST
tests
   instant instead of requiring a six-month wait.
2. **Exclusive lower bound.** `nextOccurrence({ after: T }) > T` **strictly**.
This
   single property prevents the classic infinite-fire loop where a task
settles
   at its own scheduled instant and immediately computes itself as due
again.
3. **Total.** Never throws. Malformed input returns `undefined` and the
caller
   records `invalid_schedule`, surfacing it on the task row. A parse
exception
   inside the scan loop would stall **every other task**.
4. **Bounded search.** If no occurrence is found within a horizon (suggest 4
   years, which covers `0 0 29 2 *` — Feb 29 — across a leap cycle),
return
   `undefined`. Without this, `0 0 30 2 *` (February 30th, which never
exists)
   spins forever. This is a known cron-library foot-gun.

### 2.3 Explicit rejections

| Rejected | Why |
|---|---|
| 6-field cron (seconds) | Sub-minute agent runs are not a real workflow and they break the event-rate bound (01 §7.1). Reject at validation with a clear message. |
| `@reboot` | Not a time. If startup tasks are wanted later, model them as a distinct trigger kind, not a fake cron. |
| Non-standard `L` / `W` / `#` extensions | Only if the chosen library supports them **and** the summary renderer can explain them to a user. Silent partial support is worse than rejection. |
| Intervals (\"every 90 minutes\") | Ambiguous anchor (from when? across restarts?). If added, it needs an explicit `anchor_at` column. Defer. |

### 2.4 Library decision (T0 must resolve)

Verified from `bun.lock`: the repository currently has **`luxon@3.6.1`** available
via catalog and **no** `croner`, `cron-parser`, `node-cron`, `cronstrue`, or
`rrule` dependency. That is the factual starting point; everything else below is
a recommendation to be confirmed in T0.

Luxon already being present is significant: it gives IANA-correct zoned datetime
arithmetic (`DateTime.fromObject({...}, { zone })`, `.plus({ days: 1 })` with
proper DST handling) **without a new dependency**. That is enough to implement
`once`, `daily`, and `weekly` correctly today.

What Luxon does *not* give you is cron expression parsing. Options:

A. **Hand-roll a 5-field cron parser over Luxon.**  
     Zero new dependencies. Full control over DST policy. Testable.  
   − Cron field semantics (step ranges, the day-of-month OR day-of-week
     quirk) are easy to get subtly wrong. The DOM/DOW rule — when **both**
are
     restricted, the match is **OR**, not AND — is the most commonly
botched
     detail in homegrown parsers.

B. **Add a focused cron library.**  
     Battle-tested field semantics.  
   − New dependency; must verify its IANA zone handling rather than
assuming.

**Recommendation:** B for cron parsing *only*, with Luxon remaining the
authority for zone arithmetic — **and a conformance suite (T2) that pins the
chosen library's behavior on the hazard cases in §3.** Do not adopt a library
on reputation. Pin it with tests that fail if it changes. RRULE support (`kind:
\"rrule\"`) should be **deferred out of v1** unless T0 finds a concrete demand;
it is a large semantic surface for rare use.

## 3. Timezone and DST hazards

### 3.1 Which zone?

`scheduled_task.timezone` is nullable. Resolution order:

1. Explicit `timezone` on the task (IANA id, e.g. `Europe/Kyiv`).
2. Otherwise, **the host zone resolved at every computation**, not cached at
   create time.

Point 2 matters more than it looks. If you snapshot the host offset when the
task is created, a laptop that flies from Berlin to New York keeps firing on
Berlin time forever with no indication why. OpenChamber's loop files take the
same position — their `timezone` field is optional and \"defaults to the server
zone\".

**Store the *zone id*, never an offset.** Offsets are derived facts with a
shelf life.

### 3.2 The four DST hazard cases

These are the test cases. All four become fixtures in T2.

**Case A — Spring-forward gap (the time does not exist).**  
Zone `America/New_York`, 2026-03-08. Clocks jump 02:00 → 03:00. A `daily at
02:30` task has **no valid instant that day**.  
*Policy:* **fire at the gap boundary** (03:00 local), not skip. A user who
asked for a daily backup expects 365 runs a year, not 364. Record
the run with a `dst_shifted` note so the behavior is visible rather
than mysterious.

**Case B — Fall-back overlap (the time happens twice).**  
Zone `America/New_York`, 2026-11-01. Clocks fall 02:00 → 01:00. A `daily at
01:30` task has **two valid instants**.  
*Policy:* **fire on the first occurrence only.** The `after`-exclusive contract
(§2.2 property 2) gives this almost for free — but only if the engine
advances by *instant* after the first fire. If it advances by *local calendar
day* it will correctly skip the second; if it searches forward from \"01:30
local\" it may re-match. **Write this test first.**

**Case C — Zone with a permanent offset change.**  
Governments change their DST rules (this has happened repeatedly in recent
years). The IANA database ships a fix; Node's bundled ICU updates on upgrade.
A `next_run_at` computed **before** the update is now wrong by an hour.  
*Policy:* accept the one-time drift. Do **not** build a tz-database version
watcher for v1. Do **recompute `next_run_at` for all enabled tasks on process
start**, which makes any ICU update self-healing at the next restart. This is
cheap (one pass over enabled rows) and removes an entire bug class.

**Case D — Cron `0 2 * * *` in a zone where 02:00 is the gap hour.**  
Same as A but via the cron path. The chosen library **may disagree** with our
policy — some skip, some shift, some fire twice.  
*Action:* this is precisely why §2.4 demands a **conformance suite that pins
library behavior**. If the library disagrees with Case A policy, the adapter
layer corrects it — the policy belongs to us, not to a transitive dependency.

## 4. Missed runs and catch-up

The question: the machine was asleep 02:00–10:00 and a `0 3 * * *` task was
due at 03:00. It is now 10:00. What happens?

**There is no universally correct answer, so it is a per-task policy field.**
This is the industry consensus position and matches what general scheduler
design guidance describes — \"catch-up runs every missed period\" suits billing-
like work where every period must execute, while notification and report jobs
generally **should skip** missed runs. For coding agents, report-like semantics
dominate.

```ts
export const CatchUpPolicy = Schema.Literals([
  \"skip\",       // DEFAULT. Ignore the missed instant entirely.
  \"run_once\",   // Fire ONE catch-up run immediately, collapsing N missed.
  \"run_all\",    // Fire every missed instant. DANGEROUS — see below.
])
```

### 4.1 Why `skip` is the default

A \"summarize yesterday's commits\" task that was missed at 09:00 and fires at
17:00 produces a **misleading artifact** — it says \"yesterday\" but runs against
today's state. Worse, under `run_all`, a laptop closed for a two-week vacation
with a hourly task wakes up and tries to fire **336 agent sessions**, each
spending real tokens and potentially mutating the repository. That is not a
hypothetical — it is the default outcome of the obvious implementation.

### 4.2 Mandatory guards for the non-default policies

If `run_once` or `run_all` is selected:

1. **Staleness ceiling.** `policy.catchUpMaxAgeMs` (default 6h). A missed
   instant older than the ceiling is **always** recorded as
   `skipped / stale`, regardless of policy. The run row still gets written —
   silence is the enemy here. A user must be able to see \"this didn't run
   because your machine was off\".
2. **Hard fan-out cap.** `run_all` never expands beyond N instants (suggest
10).
   Beyond that, collapse to one and record the collapse.
3. **Serial execution.** Catch-up runs for the same task execute
one at a
time,
   never concurrently. The `PRIMARY KEY (task_id)` on the lease table
gives
   this automatically.
4. **Startup grace period.** On process start, wait a short window (suggest
   30s) before the first scan. Without it, every app launch immediately
   stampedes every overdue task while the system is already busy booting.

### 4.3 Catch-up interacts with the unique index

Because `scheduled_task_run` is unique on `(task_id, fire_for)`, a `run_all`
catch-up that fires instants T1..T5 naturally produces five distinct rows and
is **inherently idempotent across restarts**. If the process dies after T3, the
next start re-derives T4 and T5 only. This is a direct payoff of storing the
*logical* instant rather than \"now\".

## 5. Timer mechanics and clock jumps

### 5.1 Never sleep for the full delta

```ts
const MAX_SLEEP_MS = 60_000                  // 1 minute
const delay = Math.min(Math.max(nextRunAt - now, 0), MAX_SLEEP_MS)
```

A task due in 14 hours must **not** arm a 14-hour timer. Reasons, all real:

- `setTimeout` delays are not reliable at multi-hour scale and are
  **suspend-unaware** on some platforms — a laptop that sleeps 8 hours may
resume
   with the timer neither fired nor correctly rescheduled.
- A system clock adjustment (NTP step, manual change, VM snapshot restore)
   silently invalidates a long timer.
- A 32-bit `setTimeout` overflow (> ~24.8 days) wraps and fires
   **immediately** — a classic JavaScript bug that turns a monthly task
into
   an instant one.

The 1-minute ceiling makes all three self-correcting within one minute, at a
cost of one cheap wake per minute that does **one indexed query** returning
zero rows when nothing is due. That is an acceptable floor.

### 5.2 Wall-clock sanity check

Each wake, compare elapsed monotonic time against elapsed wall-clock time. A
divergence beyond a threshold (suggest 2 minutes) means suspend/resume or a
clock step occurred. On detection: **recompute `next_run_at` for all enabled
tasks** before scanning. This is the same self-healing pass as §3.2 Case C,
reused.

## 6. Overrun

The 09:00 run is still working at 10:00. Policy field:

```ts
export const OverrunPolicy = Schema.Literals([
  \"skip\",        // DEFAULT. Record `skipped / overrun`, advance the cursor.
  \"queue\",       // Run after the current one finishes. Bounded depth 1.
  \"cancel_prior\", // Abort the running session, start fresh.
])
```

`skip` is the default because the PK-on-`task_id` lease enforces it for free and
because two concurrent agents mutating one working tree is a genuinely bad
outcome. `cancel_prior` needs a loud UI affordance — it discards work.

**Note the interaction with Goal mode:** a task running \"as a goal\" (03 §4)
can legitimately run **for hours**. With a hourly schedule and `skip`, it will
simply never fire again until the goal terminates. That is correct behavior but
**must be visible** in the UI, or it reads as a broken scheduler. Surface
consecutive `overrun` skips as a warning on the task row.

## 7. Jitter and thundering herd

Twenty tasks all set to `0 9 * * *` fire simultaneously and each loads an
Instance. On a laptop this is a visible stall and it is exactly the
concurrent-instance contention class described in `AGENTS.md`.

Two independent mitigations, both required:

1. **Dispatch concurrency limit.** The runner dispatches at most K concurrent
   runs (suggest K = 2, configurable). Excess due tasks wait for the next
   scan tick. Note the `AGENTS.md` caveat though — a semaphore \"does **not**
   make an unnecessary operation architecturally correct.\" Here the operation
   *is* necessary (the user asked for these runs); the limit is bounding
   necessary work, which is the sanctioned use.
2. **Optional per-task jitter.** `policy.jitterMs` (default 0). When set,
the
   *effective* fire time is offset by a **deterministic** pseudo-random
value
   derived from `hash(task_id   fire_for)`, not `Math.random()`.
Determinism
   matters: two processes computing the same offset agree on when the task
is
   due, and a restart does not re-roll it. The **`fire_for` idempotency
key
   remains the unjittered logical instant.** 

## 8. Worked examples

These are the acceptance fixtures. All times `America/New_York` unless stated.

| # | Schedule | Situation | Expected |
|---|---|---|---|
| E1 | `daily @ 09:00` | Normal day | Fires once at 09:00 local |
| E2 | `daily @ 02:30` | 2026-03-08 (spring forward) | Fires at 03:00 local, run noted `dst_shifted` |
| E3 | `daily @ 01:30` | 2026-11-01 (fall back) | Fires **once**, at the first 01:30 |
| E4 | `daily @ 09:00 and 17:30` | Normal day | Two runs; `next_run_at` is MIN over the set |
| E5 | `cron 0 3 * * *`, catchUp=skip | Machine off 02:00–10:00 | No run. Cursor advances to tomorrow 03:00. Optionally one `skipped` row for visibility |
| E6 | same, catchUp=run_once | same | **One** run at ~10:00 with `trigger=catchup`, `fire_for=03:00` |
| E7 | `cron 0 * * * *`, catchUp=run_all | Machine off 14 days | Collapses to the cap (10), rest recorded `skipped / stale` |
| E8 | `once @ T` | Fires | `next_run_at` → NULL, `enabled` → false. Task remains visible with its result |
| E9 | `once @ T` | Created with T already in the past | Rejected at validation — not silently fired |
| E10 | `cron 0 0 30 2 *` | Feb 30 — impossible | Validation rejects, or engine returns `undefined` and task is marked `invalid_schedule`. **Never spins.** |
| E11 | `cron 0 0 29 2 *` | Feb 29 — leap only | Valid. Next occurrence may be ~4 years out. Must not be reported as invalid |
| E12 | any | Task disabled while a run is in flight | In-flight run **completes**; no further runs. `next_run_at` → NULL |
| E13 | any | Schedule edited while a run is in flight | In-flight run completes and settles; cursor recomputed from the **new** schedule |
| E14 | `daily @ 09:00` | Timezone changed from Kyiv to NY on the task | Cursor immediately recomputed; `next_run_at` jumps accordingly |

## 9. What the deterministic harness must support (feeds T2)

The recurrence engine being pure is what makes all of §8 testable in
milliseconds. The harness needs only:

- an injectable `now` (the `after` parameter — already in the signature);
- fixed IANA zone ids in fixtures (never \"local\", which makes CI
  non-deterministic across runners);
- for **runner** tests (not engine tests), a virtual clock so \"advance 14 days\"
  is instant. Effect's `TestClock` is the natural fit given the codebase
  already uses `effect` throughout, including `Schedule` and `Clock` in
  `session/retry.ts`.

A note on rigor: engine tests that assert \"the next run is roughly tomorrow\"
are worthless. Assert **exact epoch milliseconds** against hand-computed
fixtures. If a fixture is hard to hand-compute, that is signal that the
semantics are underspecified, not permission to loosen the assertion.
