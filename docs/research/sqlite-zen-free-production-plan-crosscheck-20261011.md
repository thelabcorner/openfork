# SQLite 2026-10-11: Zen Free scan contention production-SQL cross-check

## Incident

The October 11 Desktop dev log (`run=95cbf50a`, 11:59–12:02 UTC) records `sqlHash=e3be8ca2`, `sqlLen=692`, `sqlShape=tables=part,message,usage_record`, `sqlOrigin=Usage.ZenFree.snapshot`, `lane=scan`, with other scan readers waiting. Repeated slow SELECTs took 4,072 and 3,371 ms. This is separate from the prior `c2b111a6` FTS investigation. The trace identifies `packages/opencode/src/usage/zen-free.ts` as the direct source; it is not evidence that the observed OXP project-root error was itself a SQLite error.

The historical path drove the query from `part.time_created` across a 90-day window, extracting JSON and joining messages and usage records per part. On a long-lived store that is a hot startup and quota-read cost. The **concurrently developed** modified `zen-free.ts` now drives from `usage_record` with `usage_record_model_completed_idx` and performs indexed lookups; it also rechecks and publishes the 30s cache under a singleflight permit, and stops issuing ad-hoc `CREATE INDEX` on service startup. I did NOT overwrite the other engineer's dirty production source or their two new regression/benchmark files.

## Newly added independent production-query regression (this work)

`packages/opencode/test/usage/zen-free-production-plan-20261011.test.ts` executes the **real ZenFreeUsage service** with a mock Database.Service backed by an actual isolated in-memory SQLite VM (2,000 irrelevant assistant messages plus genuine public free steps, account-routed free-looking steps, and a genuine limit hit). It renders the *actual* Drizzle query produced by the live service, feeds that SQL to SQLite, and runs `EXPLAIN QUERY PLAN` on both statements. This is deliberately different from hand-copied SQL microbenchmarks.

Assertions:
- Actual production query starts from a provider-indexed `usage_record` seek and part lookups seek by message through `part_message_id_id_idx`, never a 90-day `part` scan.
- Two public `step-finish` events enter the learner; paid/account traffic does not. One genuine limit error has two prior requests. No fabricated quota data.
- Twenty overlapping calls reuse one immutable snapshot result and execute exactly two SQL statements, not 40.
- The plan assertion permits unrelated SQLite `CO-ROUTINE` nodes, and checks seek order rather than brittle first-row identity.

## Verification

- Before/after SQL comparison in existing *other-owned* benchmark `packages/opencode/test/usage/zen-free-scan-plan-20261011.ts`, 40,000 usage records / 120,000 parts / six? (script actually five) repetitions per query: request old average 139.416 ms, new 6.405 ms (**21.8x**), error old 9.849 ms, new 2.639 ms (**3.7x**). Real SQLite plans changed from starting at part-time index / scanning all usage records to starting with provider-ID index and indexed message/part seeks. Synthetic microbenchmark on disposable memory DB, not production 7 GB latency.
- `cd packages/opencode && bun test test/usage/zen-free-production-plan-20261011.test.ts test/usage/zen-free-scan-permit-20261011.test.ts test/usage/zen-free.test.ts`: **4/4 PASS**, 41 assertions, ~3.15s. Two sibling-owned tests assert native query shape and startup no-DDL, and the original fixture asserts quota semantic behavior. My new test asserts the actual rendered SQL plan and end-to-end snapshot equivalence.
- No user database writes, no backend restart, no commits, resets, staging, or removal of any concurrent dirty work.

## Outstanding certification

- The new source is not automatically activated in the live desktop sidecar: source watchers stage a new candidate and `runtime.refresh` requires explicit activation. The observed 3–4s SELECTs came from the pre-fix backend.
- Run a nonintrusive post-activation 25–100-session load with concurrent quota refresh, OXP supervision/cancel, and search. Record scan/primary/interactive permit wait p95/p99, max statement duration, and zero stuck workers; compare original fingerprint versus new fingerprint.
- The scan connection is still a **shared single-permit worker** by default, so another unrelated expensive read can still obstruct other scan consumers. Full cancellation of already-running synchronous native SQLite SQL is not implemented and remains a distinct architectural blocker.
- `oxp-sync-project-roots` failed during startup in the same log, but there is no proven causal relation to this quota query.

## Adjacent heavy-read / OXP regression cross-check

While the source changes were being prepared concurrently, independent clean-worktree inspection showed two Memory Session recall callers newly routing via `scanDb()` in `packages/opencode/src/exchange/memory.ts` and `memory-read-runtime.ts`. Those are not my edits. The sibling's real file-backed WAL fixture pins the primary writer permit and proves six Memory recalls return from the scan worker without waiting for the held primary permit.

Ran `cd packages/opencode && bun test test/exchange/memory-scan-primary-isolation-20261011.test.ts test/exchange/memory-session.test.ts test/exchange/session-search.test.ts test/oxp/session.test.ts`: **22/22 PASS**, 138 assertions, 7.06s. This covers current OXP search root authority and cancellation, Exchange relevance/recency, Memory scope, and the pinned-primary negative control. It does NOT prove that two simultaneous long reads on the same single scan worker never block each other.

Full `packages/opencode bun run typecheck` exited **2** with existing errors in CLI support-bundle, global/session-read HTTP handler types, test compatibility/fixtures, and other non-Zen modules. No diagnostics referenced the new `zen-free-production-plan-20261011.test.ts`, Zen source, or Memory/OXP scan routing. This is not a green package-wide typecheck.
