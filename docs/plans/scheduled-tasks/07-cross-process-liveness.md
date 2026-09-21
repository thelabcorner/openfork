# Cross-Process Liveness and Lost-Wake Proof

**Status:** normative architecture  
**Added:** 2026-09-18  
**Read with:** `01-architecture.md` § 6–9, `05-verification.md` Tier C/D, `06-risks-and-open-questions.md` decision 10

## 1. Why this document exists

The scheduler originally had a strong **safety** story and an incomplete
**liveness** story.

Safety was already database-adjudicated:

- `scheduled_task_lease` serializes active ownership;
- `UNIQUE(task_id, fire_for)` makes a logical instant idempotent;
- stale leases are recovered by heartbeat TTL;
- the executor revalidates immediately before spending provider work.

Those mechanisms prevent duplicate execution. They do **not** prove that durable
work will eventually be discovered.

The missing failure case was:

```text
Process A
  BEGIN
    INSERT queued manual run
  COMMIT
  process dies
  EventV2 publication never happens

Process B
  shares the same SQLite database
  has no future recurrence cursor
  therefore has no recurrence wake scheduled
```

The queued row is correct, durable state. No duplicate exists. Nothing is
corrupt. Yet without another source of wakeup it can remain stranded forever.

That is a liveness failure, not a safety failure.

## 2. Architectural rule

The scheduler uses four distinct mechanisms with four distinct responsibilities:

```text
durable SQLite state        -> truth
generation reconciliation  -> liveness
EventV2                     -> low-latency same-process wake
lease + unique key          -> execution safety
```

These responsibilities must not be collapsed.

In particular:

> **Notifications are accelerators, never durability or liveness authorities.**

If EventV2 disappears entirely, scheduled work may become slower to notice, but
it must not become permanently undiscoverable.

## 3. Durable generation

`scheduled_task_control` contains an internal monotonic `generation`.

It is not part of the public control projection. It is scheduler coordination
state.

SQLite triggers advance the generation **inside the same transaction** as
scheduler-relevant mutations:

- insert/update/delete of `scheduled_task`;
- creation of a `scheduled_task_run` whose status is `queued`;
- transition of an existing run into `queued`;
- global pause/resume transition.

The critical property is transactional coupling:

```text
runnable durable state committed
        <=>
generation advancement committed
```

There is no application-level dual write such as:

```text
write database
then
publish generation
```

because a process can die between those operations.

The database itself owns the invalidation token.

## 4. Migration invariant

OpenFork has two database birth paths:

### Existing database

A tracked migration executes `up()`:

```text
ALTER scheduled_task_control ADD generation
reconcile supplementary objects
journal migration
```

### Fresh database

Fresh databases are created from `schema.gen.ts`.

Migration IDs are then pre-journaled, so ordinary `up()` functions are not
replayed. Non-schema objects such as triggers therefore **must** be installed
through the migration system's `reconcile()` hook.

The scheduler generation migration follows that contract:

```text
up()
  add column for old databases
  reconcile()

reconcile()
  INSERT OR IGNORE singleton control row
  CREATE TRIGGER IF NOT EXISTS ...
```

This distinction is load-bearing. A generation column without the triggers looks
valid to TypeScript and Drizzle but does not provide the liveness guarantee.

## 5. Runner state machine

A started runner owns at most one timer.

That timer has one of two semantic roles:

1. recurrence wake;
2. idle generation reconciliation.

```text
start
  -> startup grace
  -> single-flight recoverStale()
  -> wake()

wake
  -> dispatch active?
       yes -> wakePending = true; return
       no  -> planDue(now)
              -> plans?
                   yes -> one bounded dispatch batch
                   no  -> arm()

arm
  -> nextDueAt(now)
       value -> one timer at min(next-now, 60s)
       none  -> generation()
                -> one 60s idle reconciliation timer

idle timer expires
  -> generation()
       unchanged -> re-arm idle timer only
       changed   -> wake()
```

The idle unchanged path does **not** scan the task table, run table, recurrence
engine, Instance store, sessions, providers, or tools.

## 6. Timer ownership

The timer itself is fenced by a monotonically increasing local epoch.

Installation uses a start gate so a zero-delay timer cannot execute before its
Fiber handle and ownership epoch have been committed into runner state.

Expiration follows the reverse rule:

1. verify the timer still owns the current epoch;
2. atomically consume its timer slot;
3. only then execute the callback.

This prevents two subtle races:

### Superseded timer erases newer timer

Without fencing:

```text
T1 armed
T2 replaces T1
T1 callback resumes late
T1 clears state.timer
=> T2 is alive but runner believes no timer exists
```

Epoch ownership makes the stale callback a no-op.

### Timer re-arms by interrupting itself

An expired callback consumes its slot before invoking `wake()` or
`reconcileIdle()`.

The callback therefore never encounters itself as the currently owned timer and
does not rely on self-interruption semantics.

## 7. Dispatch coalescing

The dispatch concurrency limit applies to the **runner**, not merely to each
individual batch.

A prior implementation could produce:

```text
timer wake
  -> fork batch A, concurrency 2

manual/event wake while A is active
  -> fork batch B, concurrency 2

observed total concurrency = 4
```

That violated the intended resource bound even though each batch independently
obeyed its local limit.

The runner now has one `wakePending` bit:

```text
wake during active batch
  -> wakePending = true
  -> return

batch drains
  -> wakePending?
       yes -> clear bit and run one fresh authoritative wake
       no  -> arm
```

Multiple concurrent wakes collapse into one follow-up scan. This is safe because
the wake is level-triggered: the follow-up query asks SQLite for current truth
rather than replaying individual notification payloads.

## 8. Why one scalar read per minute is intentional

The original design target said an idle runner should perform zero queries.

That target is incompatible with the supported topology:

- multiple healthy processes can share one SQLite database;
- EventV2 is process-local;
- a process may have no recurrence cursor and therefore no future recurrence
  wake;
- a peer can commit runnable work and die before an in-memory notification.

There are only a few broad solution families.

### A. Zero reads, no cross-process wake

Rejected: permanent lost-wake liveness hole.

### B. Poll scheduler tables

Rejected: correctness works, but idle cost scales with scheduler data and turns a
cheap reconciliation floor into recurring domain work.

### C. New cross-process IPC bus

Possible future latency optimization, but not a good primary correctness layer.
It adds listener discovery, authentication/identity, port/socket lifecycle,
process death handling, retry, platform differences, and a new failure domain.
It also still needs a durable fallback if a notification is lost.

### D. Watch SQLite/WAL files

Rejected as an authority. File watchers are noisy, platform-specific, may
coalesce events, and expose storage implementation details as scheduling
semantics.

### E. SQLite `update_hook`

Insufficient: the hook is connection/process local.

### F. `PRAGMA data_version`

Useful only when queried, so it does not remove the need for a bounded poll.
It is also database-wide, whereas the scheduler generation encodes exactly the
domain invalidation we care about.

### Chosen design

One indexed singleton generation read per 60 seconds while truly idle.

The unchanged path performs no scheduler scan.

This is a deliberately tiny correctness tax for a bounded liveness guarantee.

## 9. Proof decomposition

C9 is split into two tests because the two claims have different failure
boundaries.

### C9-storage — real OS processes

Process B queues a manual run against a shared SQLite file and exits.

Process A opens/uses an independent database connection and observes that the
durable generation is greater than before the peer commit.

This proves:

- trigger installation;
- transactionally durable epoch advancement;
- WAL/shared-database visibility;
- independence from EventV2.

### C9-runner — deterministic virtual time

The runner starts with no recurrence cursor.

A queued run is inserted directly through SQL, deliberately bypassing EventV2.

The test advances TestClock by one reconciliation interval.

The runner must:

1. observe changed generation;
2. execute the normal authoritative due planner;
3. claim the run;
4. execute it once;
5. settle it.

This proves generation-to-dispatch behavior without making CI wait 60 real
seconds.

Together:

```text
peer durable commit
  -> generation visible cross-process
  -> idle reconciliation observes change
  -> authoritative scan
  -> safe execution
```

## 10. Negative invariants

The liveness mechanism is acceptable only while these stay true:

1. **One timer per started runner.**
2. **One scalar generation read per idle reconciliation interval.**
3. **Unchanged generation performs zero task/run scans.**
4. **Unchanged generation performs zero recurrence evaluation.**
5. **Unchanged generation performs zero Instance materialization.**
6. **EventV2 loss cannot strand durable work indefinitely.**
7. **Concurrent wakes cannot create overlapping dispatch batches.**
8. **Dispatch concurrency never exceeds the configured runner cap.**
9. **A stale timer callback cannot clear a newer timer.**
10. **Fresh and migrated databases install equivalent generation triggers.**

## 11. Latency bound

The generation floor gives a worst-case discovery delay of approximately one
reconciliation interval, currently 60 seconds, plus ordinary scheduling and
execution overhead.

Same-process EventV2 normally makes mutation-to-wake latency immediate.

The 60-second value therefore serves two purposes:

- long-timer clamp for suspend/manual-clock correction;
- cross-process liveness bound while idle.

Keeping one shared constant avoids two independent periodic mechanisms with
different failure semantics.

If product requirements later demand sub-second cross-process manual-run
latency, add a peer wake transport **above** this architecture. Do not remove the
generation floor; the peer transport should be an accelerator with the same
relationship EventV2 has today.

## 12. Extension points

### Peer wake accelerator

A future authenticated localhost/IPC notification may reduce cross-process
latency:

```text
commit
  -> durable generation trigger
  -> best-effort peer signal

peer signal received
  -> wake immediately

peer signal lost
  -> generation floor recovers
```

No correctness change is required.

### Loop-file ingestion

T7 loop files should mutate the same durable scheduled-task domain.

The file watcher is therefore an **input adapter**, not another scheduler. Once
a loop definition is reconciled into SQLite, the same generation, timer, lease,
and executor model applies.

### Remote/cloud mutation

If scheduled tasks later synchronize from another process or service, the local
database projection must still advance the generation transactionally when
runnable local state changes.

Again, the source of the mutation does not change scheduler correctness.

## 13. Architectural summary

The scheduler is intentionally **level-triggered**.

Events say:

> something probably changed; look now.

Generation says:

> durable scheduler truth definitely changed since your last idle observation.

SQLite rows say:

> this is the truth you must act on.

Leases and the logical-run unique key say:

> only one actor may spend work for this firing.

That separation is the durability boundary.

A future optimization is valid only if deleting it degrades latency or
throughput—not correctness.

