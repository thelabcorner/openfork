# Local provider `step-finish` stalls: snapshot ownership and bounded enrichment (2026-10-16)

## Production evidence

The live `~/.local/share/openfork/log/openfork.log` contains three October 16, 2026 warnings from the same Workmark project:

- 18:28:25.147Z: `ses_eba1ba2baffedr2eqOKKi9ZUgE`, `consumerBusyMs=120008`
- 18:28:37.913Z: `ses_eba196c30ffevIByJRiAiOScw2`, `consumerBusyMs=120004`
- 18:29:44.651Z: `ses_ebef6186effeoAYSLjEJONT5KE`, `consumerBusyMs=120000`

All had `consumerEvent=step-finish`, `consumerPhase=snapshot-post-step`, `lastSdkEvent=finish`, `lastNormalizedEvent=finish`, `pendingHostTools=0` and `classification=local-consumer`. These are direct runtime witnesses: the provider had finished its SDK response and OpenFork's serialized post-step handler was stuck on auxiliary snapshot work. They do **not** prove which Git operation held the shadow-index/mutation locks; avoid attributing this to SQLite, network latency or a specific lock without a corresponding trace.

Earlier October 15 traces contain repeated five-minute `snapshot capture timed out` warnings for Workmark, showing that the shared snapshot materialization subsystem already had long-lasting captures under concurrent development.

## Authoritative data flow

`packages/opencode/src/snapshot/index.ts` owns shadow Git capture, the project mutation barrier, the per-gitdir semaphore and revision-sensitive memoization. `packages/opencode/src/session/processor.ts` consumes normalized provider events, performs optional baseline/post-step/patch snapshot enrichment and persists the authoritative step/assistant records. `packages/opencode/src/session/first-content-deadline.ts` observes whether this serialized handler is stuck; its 120-second local-consumer ceiling is a last-resort watchdog, not a suitable budget for optional Git work.

The original `Effect.cached` shared capture executed under its first caller. Interrupting that caller interrupted a sibling waiter as well; this was reproduced directly using the installed Effect runtime. Reusing the memo after failure could also replay a cached interrupted outcome.

## Changes

1. Snapshot producer runs once per project materialization revision in an independently owned Effect fiber admitted under the existing `SynchronizedRef.modifyEffect` lock. Each Session uses `Fiber.join` to await it. Interrupting the first/sibling waiter does **not** interrupt the shared producer or its neighbors.
2. A completed tree is retained only when the project inventory supplies its existing freshness/coverage proof. Failed/interrupted producer fibers evict their own memo token; completed but uncovered captures are likewise evicted. Old captures cannot overwrite a newly installed revision token.
   The capture owner records its current phase (`waiting-mutation-barrier`, `waiting-shadow-git-lock`, `git-capture`, or `capture-settlement`) in the existing five-minute timeout warning; this helps attribute the underlying lock or Git bottleneck on a future occurrence.
3. Optional step enrichment runs through a separately interruptible waiter. Its deadline does not await an uninterruptible Git/process cancellation finalizer. Cancellation of the waiter no longer cancels the project-owned producer.
4. Baseline join, post-step track and patch generation share **one 30-second monotonic budget**, rather than three independent 30-second budgets. When exhausted, optional snapshot metadata is omitted with a phase-tagged warning. The actual provider `finish`, authoritative step/message persistence, tool mutation barriers and session status are not skipped.
5. The prior 120-second consumer deadline and five-minute snapshot producer deadline remain independent safety mechanisms. Neither is increased. No provider API, routing, authentication, auto-retry or executable tool contract changed. A local consumer stall still must **not** initiate automatic mutation replay.

## Verification and limits

- Targeted deadline/stream tests: 28 passed (initial patch).
- Real V1 SessionProcessor/mock-HTTP integration, terminal finish, original capture-timeout tests: 36 passed before final shared-producer change.
- Shared producer cancellation isolation, producer expiry/replacement, detached waiter cancellation, uninterruptible-cleanup release: 7 passed after producer change.
- Combined six-file V1 processor/terminal-stream/snapshot regression suite after shared producer change: **53 passed, 0 failed, 228 assertions**.
- Six independent snapshot waiters with one cancellation and one real producer: **1 passed, 4 assertions**, one shared capture; five siblings unaffected.
- Capture phase diagnostic assertion: **passed**, including `capturePhase=git-capture` in the timeout warning.
- `bun run typecheck` from `packages/opencode`: **exit 0** for the patched source (2026-10-16).
- The user-visible source patch must be built and activated in a new sidecar/runtime process before it affects already-running OpenFork instances. The active instance was **not** restarted, and no user worktree was reset or committed.
- Live six-session desktop replay under concurrent Git changes and actual Workmark tool mutations is still a separate deployment gate. Targeted simulated timeouts establish mechanism, not proven elimination of all filesystem/snapshot contention.
- A `finish` reaching the local event queue without subsequent successful persistence remains a distinct fatal consumer problem requiring its own persistence diagnostics; this patch does not pretend to make failed authoritative storage writes optional.
