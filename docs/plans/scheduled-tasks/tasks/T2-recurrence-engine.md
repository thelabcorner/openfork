# T2 — Pure recurrence engine   deterministic clock harness

**Depends on:** T0  
**Blocks:** T3  
**Read first:** `02-scheduling-semantics.md`, `05-verification.md` § 2 Tier A

## Scope

One pure module. **No database, no Effect services, no I/O, no
`Date.now()`.**

```ts
nextOccurrence(input: {
  schedule: Schedule
  timezone: string      // IANA zone id
  after: number         // epoch millis, exclusive
}): number | null

occurrencesBetween(input: { ...; from: number; to: number; limit: number }):
number[]
```

`occurrencesBetween` is what catch-up (02) and the `preview` endpoint (04 §
1.1) both consume. One implementation, three callers — that is the point.

Also deliver the **deterministic clock harness** described in 05 § 3. T3, T4
and T9 all depend on it, so it is owned here rather than reinvented three
times.

## Implementation notes

- Use whatever T0 decision 3 selected. `luxon` is already in the lockfile
  and handles IANA zones and DST arithmetic correctly; a cron *parser*
is
  a separate question from *zone math*.
- DST policy is documented in 02. Implement the **documented** behaviour
  and assert it; do not inherit whatever a library happens to do and
  backfill the doc afterwards.
- Return `null` (not an exception) for terminal schedules — a `once`
  schedule in the past has no next occurrence and that is normal.

## Verification

- Table-driven test over **every** E-fixture in 02. The fixtures are the
  contract.
- All five \"easy to omit\" cases in 05 § 2 Tier A covered.
- Pin the tzdata version used by tests.
- Property check: for any recurring schedule,
  `nextOccurrence(after: X) > X` strictly, always. No fixed-point loops.
