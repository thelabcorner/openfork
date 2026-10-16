# OpenFork provider stream stalls — phase-aware repair and verification (2026-10-15)

## Operational scope

The live OpenFork V1 execution path is `packages/opencode/src/session/processor.ts` → `session/llm.ts` → `packages/llm` / AI SDK → upstream hosted provider. The fork owns its local consumer, adapter and timeout policy, not the remote OpenCode Go service. See root `AGENTS.md`, `docs/map/README.md`, `docs/map/v1-v2.md`, and `docs/architecture/compatibility-boundary.md`.

The October 15 runtime incidents in `docs/perf/provider-idle-timeout-2026-10-15.md` and the later 20:15 UTC watchdog entries exhibited 300,000 ms of *consumer-observed* stream inactivity. Two later incidents' last observed event was `step-finish`, with no executing host tool. This did **not** establish whether the provider, SDK normalization, consumer, snapshot, or DB stalled.

## Bottom-up ownership and changes

1. The provider adapter now attaches lightweight, request-local counters and monotonic timestamps for AI SDK `fullStream` parts (already parsed by the SDK), normalized LLM events, and events actually admitted by the serial session processor. These are not HTTP byte-level ingress probes; avoid describing them as network receipts.
2. The session processor tracks active event-processing phases at the producer/consumer seam, including snapshot baseline, post-step capture, reasoning settlement, telemetry, part/message persistence and patch creation. The watchdog distinguishes an active local handler from provider/adapter silence.
3. A normalized response already emitted but not consumed is classified as **local event-queue starvation**, without initiating a provider-timeout synthetic continuation. Event-domain counts exclude `step-start` from the compared progress counters to prevent permanent off-by-one misclassification.
4. After `step-finish`, a silent final step is subject to a short finalization budget (20 s for `reason=stop`; bounded 90 s for other step transitions). Long unfinished reasoning remains subject to the ordinary idle budget; no global timeout was blindly shortened.
5. The local handler's own budget remains separate (at most 120 s with the default 300 s idle policy), so it cannot be preempted by the 20-second upstream finalization timer while performing legitimate 30-second snapshot work. Local handler settlement restarts the provider-finalization clock.
6. Snapshot enrichment at the V1 step boundary has 30-second bounds for baseline, post-step capture and patch materialization. Ordinary capture/patch failures are logged and treated as missing optional enrichment; genuine interrupts propagate. Snapshot ownership remains in the Snapshot service; this does not add a second snapshot worker or bypass mutation barriers.
7. The normalized terminal `finish` event ends stream consumption without waiting for an underlying SDK async iterable to reach EOF. A mere `step-finish` does **not** falsely complete the request.
8. Provider progress timeouts remain physically non-retryable and may use bounded durable synthetic recovery according to the existing input-admission policy. Local consumer stalls have a separate error and must never trigger an automatic provider-timeout continuation that might duplicate completed mutations.

## Further verified failure mechanisms (continuation)

9. **Stale phase timer**: the watchdog previously slept until a budget computed for an older phase. A one-slot event-driven `Queue` now wakes deadline computation on step transitions and local handler entry/exit; this does not introduce a polling fiber. Repeated `step-start` SDK markers do not extend first-response admission when no response content arrives. A 30 ms first-response regression previously expired only after ~100 ms; the corrected test passes.
10. **Uninterruptible delta finalizer**: `consumeWithFlushDeadline` previously ran `options.flush` unbounded in an `Effect.ensuring` finalizer. A blocking publication therefore prevented the watchdog from settling the attempt even when it correctly recognized `delta-flush` as local work. The final best-effort delta publication now skips when no delta is pending, is explicitly interruptible, and has a 2-second default bound (test override supported). Full text-part durability is handled separately by Session cleanup.
11. **Hung SDK iterator.close**: the AI SDK `fullStream` async iterator can be cancellable while `next()` is outstanding but block indefinitely awaiting an ignored or hung `return()`. The `llm.ts` AI SDK adapter now wraps each physical attempt in `abortableProviderIterable`: early return aborts its own transport `AbortController` **before** awaiting SDK teardown, and bounds best-effort return to 1 second. Abort/cleanup failures after deliberate closure cannot overwrite a terminal `finish` event. Native-provider Effect streams retain their own cancellation contract; no global provider wire compatibility is changed.
12. A pending locally normalized response that has not been accepted by the serial consumer is distinguished from provider silence; the counters compare response events only, excluding SDK `step-start` markers. Delta flush is also instrumented as a local consumer stage.
13. **Session transport abort ownership**: OpenFork previously interrupted the runner but could leave its physical provider HTTP stream alive; that leaked a running request into the test HTTP server's scope teardown. After an abort signal was delivered *before* joining the runner, the formerly reproducible `busy → idle` test passed. The final implementation is the lightweight `session/llm/provider-transport.ts` owner, with a process-shared symbol registry of actual attempt-local AbortControllers. The SessionRunState does **not** depend on the entire LLM/Auth/Provider graph to signal cancellation. Physical attempt scope-release unregisters the controller, regardless of success, error or interruption. No extra DB ownership or provider wire API is introduced.
14. **Generation-fenced shutdown**: An old service graph can hold a stale runner while a successor owns the same Session ID. Both explicit cancellation and instance disposal check the exact durable owner ID/generation before aborting process-wide transports, preventing a stale runner from killing its successor's provider request. The stale runner's own stream scope is still interrupted. A direct regression registers a successor transport and proves stale-runner cancellation leaves that signal un-aborted.
    The normal Stop and provider-switch paths reuse the exact generation proof
    returned by their existing durable `requestInterrupt` operation instead
    of introducing another SQLite lookup before network cancellation. The
    independently invoked active-handle fallback still reads ownership to
    fail closed when no proof was provided.
15. **Correlatable, payload-free watchdog reports** now include Session/assistant message IDs, provider/base-model identity, optional route kind, consumer classification, and attempt duration, while excluding credentials, account IDs, token text, prompt content and arguments. Stage counters remain post-AI-SDK parsing rather than raw HTTP wire frames.
16. **No second unbounded delta flush from cleanup**: once stream teardown makes its bounded best-effort UI delta publication attempt, the V1 SessionProcessor cleanup must not await that same optional `updatePartDelta` again. Cleanup now discards only the unpublished delta buffers and writes complete text/reasoning parts from their independent, intact canonical content buffers. This avoids a repeated SSE/SQLite bottleneck after the watchdog has already interrupted the physical provider request. Authoritative part writes remain required and are not silently bypassed.
17. **Synthetic timeout continuation user admission** is limited to an actual durable User message (role guard added to the V1 prompt owner) and remains bounded by its existing two-attempt provenance. The continuation instructs the model to inspect uncertain side effects; this language is *not* a deterministic guarantee against reissuing a semantically identical mutating tool with a new call ID. Avoid claiming exactly-once execution without a separate durable admission fence.

## Verification

- Final focused validation after the event-phase, step-finalization, local
  snapshot-failure and retry-classifier fixes:
  `bun test test/session/first-content-deadline.test.ts test/session/provider-progress-post-step-20261015.test.ts test/session/provider-finish-terminal-20261015.test.ts test/session/stream-flush-deadline.test.ts test/session/provider-timeout-continuation.test.ts test/session/retry.test.ts`:
  **109 passed, 0 failed** (2026-10-15).
- A separately selected `processor-effect.test.ts` smoke test,
  `session.processor effect tests capture llm input cleanly`, passed after
  the snapshot error-handling edits.
- Updated focused post-fix suite spanning eight files
  (`abortable-provider-iterable`, hanging iterator, phase watchdog,
  post-step/flush, terminal completion, continuation, and retry):
  **119 pass, 0 fail**, 255 assertions.
- Three scoped real SessionProcessor HTTP-mock scenarios (text first-token
  time, reasoning rendering, AI SDK tool execution): **3 pass, 0 fail**.
- `bun run typecheck` was run; package-wide typecheck is still **red** for
  unrelated files including `src/cli/cmd/debug/support-bundle.ts`,
  `src/server/routes/instance/httpapi/handlers/*`, `src/session/prompt.ts`,
  and tests for T3/account aliases. The compiler output did not report
  errors from the added watchdog, flush or SDK cancellation modules. The test
  `fixedProcessor` mock was updated to implement the required
  `providerTimedOut` field.
- `loop sets status to busy then idle` initially reproduced a scope teardown
  hang after its body and filesystem cleanup completed. After transport-first
  cancellation it passed repeatedly (e.g. 1,161 ms; cancel ~13 ms), together
  with three additional cancellation lifecycle tests (**4/4 passing**).
- `reset reasoning state across retries` passes in the repository's
  supported 30-second Effect test harness (2.51–3.09 seconds, four assertions
  in its isolated run). The earlier five-second-harness failure must not be
  described as a production reasoning regression.
- `bun test test/session/first-content-deadline.test.ts test/session/provider-progress-post-step-20261015.test.ts test/session/provider-finish-terminal-20261015.test.ts`: **22 passed, 0 failed** (2026-10-15 after phase-aware budget changes).
- New dedicated regression cases cover blocked post-step processing, post-step provider silence, raw SDK activity without normalized response, serial handler release, interruption finalizers, queued normalized events, `step-start` counter parity, post-local settlement budget reset, semantic terminal completion without EOF, and nonterminal step behavior.
- The earlier focused watchdog/flush/continuation suite passed **12/12** before the later phase changes.
- A broad run of `processor-effect.test.ts`, `prompt.test.ts`, `llm-native.test.ts`, and `retry.test.ts` returned **233 passed, 14 skipped, 10 failed, 2 errors** after 135.91 s. Failures spanned pre-existing/shared dirty-tree surfaces (Goal, SPAD, prompt tasks/status), plus `session.processor effect tests reset reasoning state across retries`, which failed again in isolation due to an internal 5-second test timeout. Do **not** claim this broad run green or assume causation without a before/after baseline. These regressions require separate isolation.

## Remaining release gates

- Run a clean targeted verification after concurrent edits quiesce and validate no active failures in retry/Goal/SPAD paths.
- Under real concurrent streams, inspect a watchdog incident with SDK-event count, normalized count, consumer count/phase and local snapshot diagnostics. Only live production traces can establish whether the original hang occurred on upstream transport, SDK parsing, or local processing.
- If the SDK shows no new events while HTTP bytes still arrive, add provider-compatible, bounded byte/frame ingress instrumentation in the exact transport adapter. Do not split the HTTP response into a second unbounded reader, log tokens/keys, or break upstream OpenCode-hosted wire contracts.
- Repeat 1 / 3 / 6+ simultaneous-session load tests with synthetic stalled SDK streams, snapshot contention, SQLite busy and tool-executor cancellations. Confirm no ambiguous mutating-tool replay, no hidden fire-and-forget consumers, bounded memory, and convergent teardown.
- Synthetic 1/3/6 concurrent deadline and cancellation attempts now pass,
  including both remote-idle and blocked-local-handler classification; these
  are mechanistic tests, not real six-session desktop load.
- A real V1 SessionPrompt + SessionRunState + LLM mock HTTP test ran **three**
  physically concurrent hung streams, cancelled only one while preserving the
  other two and then cancelled all; it passed **three successive runs**
  (1,298 / 1,940 / 1,437 ms; 27 total assertions).
- A second real V1 mock-HTTP integration test ran **six simultaneously hung
  provider requests**, cancelled the third while verifying all five neighbors
  remained busy, then closed the remaining requests and reached idle for all
  six (**1,485 ms, 18 assertions, zero failures**).
- Lightweight transport registry, SDK iterator, actual provider EOF, and
  watchdog integration tests: **27/27 pass, 113 assertions**. A broader
  updated focused suite of **ten** files after the cleanup patch and
  2,048-attempt/32-Session registry stress test: **144/144 pass,
  425 assertions**.
- Nine real SessionProcessor integration tests after the full-part cleanup
  change: **9/9 pass, 58 assertions**, covering text, reasoning, retry
  recovery, completed tools, aborted-tool settlement, idle lifecycle,
  interruption recording and provenance.
- A separate six-live-Session mock-provider test passed after generation
  fencing (**1,485 ms, 18 assertions**); the companion three-live-Session
  test passed repeated independently and in the prompt-cancellation group.
- A dedicated transport-registry stress case registered **2,048 physical
  attempts across 32 Session IDs**, verified per-Session abort counts, and
  verified all 32 keys were removed after out-of-order teardown. This
  exercises registry lifecycle rather than claiming production CPU throughput.
- Generation-fence regression for cancellation after Session ownership
  changes: **pass, five assertions**; the new successor AbortController remains
  live. The broader `run-state-abort.test.ts` initially had **14 pass / 1 fail**
  for same-runtime durable-orphan recovery. After concurrent edits to the
  core execution-owner/recovery code, that isolated test passed and the
  **full ownership suite passed 15/15 (58 assertions)**. This receipt
  validates the current shared tree; it does not attribute the concurrent
  recovery-owner implementation changes to this provider-timeout patch.
- After restoring the original LLM service interface and moving physical
  cancellation into the standalone transport owner, package `bun run
  typecheck` still exits nonzero; a fresh final pass reported **40 errors** in
  other areas of this dirty multiagent tree, including pre-existing
  `prompt.test.ts` ToolState/provenance narrowing errors. There were no
  compiler errors against the added stream / watchdog / transport / RunState
  implementations, or the `prompt.ts` provider-continuation role guard.
  This is **not** a global TypeScript green gate.
- The working tree is shared and extremely dirty; do not stage, commit, reset or restart a user's active desktop instance indiscriminately. The source patch is not equivalent to deployment validation.
