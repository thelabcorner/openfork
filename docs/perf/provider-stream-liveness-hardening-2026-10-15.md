# Provider stream liveness hardening — 2026-10-15

## Motivation and evidence

The October 15 runtime had repeated `provider stream idle, 300000ms` failures.
At least two affected physical attempts had their last normalized event at
`step-finish` with zero executing host tools. The previous watchdog measured
only serial processor acceptance, so a local event-handler or SQLite/Git wait
could masquerade as upstream silence. The terminal `finish-step` SDK event is
not the same as the final `finish` event.

An existing `session.processor effect tests reset reasoning state across retries`
test reproduces a different issue: a mock server writes partial reasoning then
destroys the SSE connection; the AI SDK / transport path remains pending even
under a 30-second test deadline. Shortening the test-only provider deadline to
1.5 seconds ends the hang, but prevents its ordinary retry and causes the
existing expected-continuation assertion to fail. This is independent of the
post-step cases; the underlying SDK/HTTP disconnect propagation remains open.

## Implemented production boundaries

1. A per-physical-attempt, content-free progress probe records AI SDK
   `fullStream` event ingress, normalized LLM-event output, normalized response
   counts and per-event local processor phase. No prompt, reasoning, arguments,
   tokens, headers, credentials, or raw event payloads are logged.
2. On watchdog expiry, classify an active local handler or normalized event
   pending processor acceptance as `ProviderConsumerStallError` rather than
   falsely reporting upstream silence. Log phase, elapsed monotonic time and
   event counters. Native runtime has normalized-only witnesses; this is not a
   raw socket/SSE-byte observer.
3. During `step-finish`, Git baseline/join, post-step capture and patch
   enrichment have independent 30-second deadlines. A failed enrichment is
   logged and skipped, without abandoning the durable assistant step, usage or
   tool result. Sequential capture stages can still collectively exceed 30s.
4. A finished provider step now gets a phase-specific watchdog. If finish
   reason is `stop`, stream finalization must arrive within 20 seconds. After
   nonterminal `step-finish` or a subsequent `step-start`, the next response
   uses the first-response budget (default 90 seconds). An actively producing
   unfinished response retains the original 300-second midstream idle budget.
   Executing host tools remain governed by their own lifecycle and are not
   shortened by this rule.
5. The cancellation/stop contract remains a serial stream consumer. Do not add
   a queue that lets provider-owned tool dispatch race ahead of SPAD stopping,
   interactive preemption, or a host abort. A future transport observer may
   independently monitor bytes without delivering events out of order.

## Regression and remaining gates

- Focused watchdog, flush and continuation tests exercised successful streams,
  timeout classification, active host-tool suspension, next-step silence,
  terminal step silence and event order.
- Five-file combined run: 77 passes, one test timeout in the existing midstream
  reasoning reset / retry scenario, first under 5s and then alone under 30s.
- Full package typecheck in the concurrent dirty tree reported multiple
  unrelated TypeScript errors; typecheck of touched paths needs separate review
  after changes settle. No code was committed or deployed by this investigation.

## Follow-up diagnosis / admission criteria

### Subsequent transport repair and verified results

- The shared provider `timeoutFetch` / `wrapSSE` response-body stream
  did not independently propagate request aborts to its downstream
  `ReadableStream`. It now watches the effective combined abort signal,
  errors the downstream stream with the abort reason, cancels its upstream
  reader and removes listeners on finalization. This is independent of
  `chunkTimeout` being enabled. Abort regression tests pass both with a
  1000ms chunk timeout and with `chunkTimeout: false`.
- OpenAI-compatible `text/event-stream` results now recognize the
  required `data: [DONE]` sentinel across byte-chunk boundaries. An
  unexpected normal EOF without the delimiter causes a typed
  `ProviderError.ResponseStreamError`, confirmed to be retryable by
  `SessionRetry.retryable`. This check is deliberately restricted to
  `@ai-sdk/openai-compatible`; it must not impose OpenAI framing on
  unrelated providers. A provider claiming OpenAI compatibility but
  emitting a nonstandard successful SSE termination now fails explicitly.
- The isolated forced-socket-reset regression in
  `test/session/processor-effect.test.ts` **still hangs** beyond 12s and
  previously beyond 30s. The mock server writes partial reasoning,
  destroys its response socket and then awaits `Effect.never`.
  The transport guard protects explicit abort and observed normal EOF;
  it does not prove correct propagation of a remote TCP reset through
  Bun fetch, the SDK adapter and local stream consumer.
- Subsequent lower-level isolation with the installed Bun runtime and
  `ai@6.0.168` demonstrated a successful first SSE reasoning event
  followed by a rejected `ECONNRESET` in both raw `fetch().body.getReader()`
  and standalone AI SDK `streamText().fullStream`. Therefore **do not
  attribute the remaining processor fixture failure to an established
  universal Bun TCP reset or AI SDK failure**. In instrumented fixture
  runs there was only one provider call after 3s and 6s. Flushing response
  headers and pausing before destroying the fixture socket did not fix
  that hang; the experimental fixture edits were reverted. A later
  concurrent run returned `stop` quickly instead of hanging, but still
  failed the expected retry assertion. Investigate the actual
  Effect/session retry and fixture ownership lifecycle on a stable
  checkout, with per-attempt event witnesses enabled.
- No dependency upgrade was applied. The installed AI SDK is
  `ai@6.0.168`, `@ai-sdk/openai-compatible@2.0.41`. The Vercel AI SDK
  issue https://github.com/vercel/ai/issues/15430 documents related
  aborted-stream / unfinished-finish behavior, but is not proof that
  the older installed version includes its upstream fix.
- The full combined provider-timeout/stream tests passed after the
  transport changes. No deployed-runtime soak results or all-session
  concurrency verdict are available yet.

- Confirm a new real incident by observing `lastSdkEvent`,
  `lastNormalizedEvent`, `consumerPhase`, elapsed counters and last
  `completedStepReason` together. Do not infer socket inactivity from
  `fullStream` inactivity: AI SDK itself can be blocked, and consumer
  backpressure can pause the transport reader.
- Reproduce reset/EOF propagation with a raw socket/body witness and AI SDK
  `fullStream` simultaneously. Distinguish unexpected socket closure, a
  legitimately silent upstream, a hung SDK step transition, and downstream
  SQLite/Git event-handler contention; do not invent the winner.
- Re-run the failing reasoning-reset regression against an isolated baseline
  before attributing it to these patches; fix the ownership boundary that
  suppresses the broken-stream error rather than globally replaying provider
  requests with mutating tools.
- Verify under multiple concurrent swarms with SQLite writer pressure and
  worktree snapshot contention. A real provider response must reach terminal
  settlement exactly once, cancellation must close transport, and no completed
  tools may be replayed.