# Provider progress idle timeouts — October 15, 2026

## Incident / verified evidence

OpenFork's production V1 `SessionProcessor` wraps provider-event consumption in `withProviderProgressDeadline` (`packages/opencode/src/session/first-content-deadline.ts`). The default threshold is **300,000 ms of no observed provider progress**, not 300,000 ms of total generation. The timer excludes genuine in-progress host-executed tools when the executor reports them running.

Three local incidents, all in `/openfork/log/openfork.log`:

| Session / message | Provider + model | Request logged (UTC) | Error logged (UTC) | Duration from logged start |
| --- | --- | --- | --- | --- |
| `ses_ebfdc5b06ffeXQBKWcHF5Ezv62` / `msg_1403e7c6b0010VTVaN4gFw0bB9` | `opencode-go/deepseek-v4.1-flash` | 15:46:39.351 | 15:51:59.067 | ~319.7 s |
| `ses_ebfdfc45bffe3BToFbDTUIGRqc` / `msg_14047c669001BHGxG6n216yy5T` | `opencode-go/deepseek-v4.1-flash` | 15:56:48.118 | 16:02:05.988 | ~317.9 s |
| `ses_ebfdc5b06ffeXQBKWcHF5Ezv62` / `msg_1404877c5001E2Hee4gQkxtExF` | `opencode-go/cat-jam-free` | 15:57:17.714 | 16:02:41.204 | ~323.5 s |

All three were `Provider response timed out (provider stream idle, 300000ms)`, rather than `waiting for first content`. Thus *at least one* response-progress event had been seen, followed by a 300-second idle interval. The ~18–24 seconds on top of 300 seconds represent activity between the stream-start log and the final progress event, plus timeout scheduling; they do **not** prove slow watchdog execution.

Around these incidents, logs also show repeated short-interval Goal Auditor provider requests, and snapshot contention: at 16:02:17 UTC a snapshot reported a timeout with `captures=1165` and `invalidations=1333`; a separate session's cleanup also timed out. These are correlated workload signals, **not proof** they caused provider silence.

## Why the exact upstream cause remains open

The watchdog observes normalized `LLMEvent` progress at the processor consumer. Existing logging does **not** independently report timestamped raw HTTP/SSE bytes, upstream request IDs, heartbeat frames, adapter-normalization progress, or per-request consumer queue lag. Therefore the name *provider stream idle* currently proves an **observable application-level progress gap**, not that the model provider sent zero network bytes. Candidate causes remain:

1. Provider/gateway stops emitting model events after initial text/reasoning/tool output (including very long post-tool inference).
2. Network stream stalls while TCP stays open or upstream sends only heartbeats ignored by the normalizer.
3. AI SDK event normalization / backpressure stops advancing, despite received bytes.
4. A blocked local event consumer or resource contention. Snapshot and auditor activity justify checking this, but neither is yet causal evidence.

All three incidents share the OpenCode Go provider route and the AI SDK runtime. Because two distinct models exhibited the signature, investigating common gateway/adapter/host behavior is higher leverage than blaming a single model. No external provider health or upstream network trace was available in the inspected evidence.

## Implemented recovery

- Add a typed `ProviderProgressTimeoutError` while retaining the existing user-facing error text and *non-retryable physical SDK policy* (the five-minute watchdog must not be multiplied by five physical retries).
- After tool/part settlement, `SessionPrompt` conditionally admits a **durable synthetic continuation**, using canonical `SessionInput.admitSynthetic`, with source `provider.timeout.continuation`. No fresh human request is fabricated and no tool is directly replayed.
- Preserve provider, model, account/variant, execution route intent, worker causal root, and durable tool history. Prompt explicitly instructs the next model to trust completed tool results and inspect interrupted/uncertain mutating operations before repeating them.
- `admissionClass=automatic`, `delivery=queue`, `userPreemptible=true`, and a pre-provider `expectedLatestUserSeq` fence. Newer human input wins, including a cross-process admission race.
- Budget of **two automatic continuations** per consecutive watchdog chain, encoded in durable synthetic provenance rather than RAM. A third timeout stops normally. Goal Mode retains its independent worker→auditor recovery; its failure path is not duplicated.
- Existing recovery card conventions reused with a distinct localized English label.
- Diagnostic log at watchdog expiration: phase, timeout, count of observed normalized events, last event type, idle duration, pending host-tool count. Payload, credentials, tool arguments and stream text are deliberately not logged.

## Validation

- `bun test test/session/provider-timeout-continuation.test.ts test/session/first-content-deadline.test.ts test/session/retry.test.ts`: **90 pass**, 0 fail.
- Filtered `bun test test/session/prompt.test.ts --test-name-pattern 'auto-continues a provider progress timeout'`: **1 pass**, end-to-end mock-provider stall → durable continuation → completed response.
- Filtered `bun test test/session/prompt.test.ts --test-name-pattern 'provider-timeout continuations'`: **1 pass**, three stalls produce exactly two continuations.
- `packages/schema/test/v1-turn-provenance.test.ts`: **4 pass**.
- Full package TypeScript check was attempted; the Node TS process hit the default ~4 GiB V8 heap ceiling without diagnostics. That run is **not** a typecheck pass.
- A later focused user-preemption test could not initialize while an unrelated concurrent edit to `packages/core/src/goal/auditor.ts` called `Schema.String.annotations` (absent in the active Effect Schema runtime). This should be rerun after the concurrent edit is repaired; do not attribute the unrelated import-time failure to timeout recovery.

## Next decisive diagnostic

Instrument **three separate sparse clocks** per provider attempt: (1) raw upstream SSE byte/frame ingress at the transport boundary, (2) normalized event emission in the AI SDK adapter, and (3) processor-consumer acceptance. Report only last monotonic timestamps, byte/event counts, response status/request ID when supplied, event-loop-lag sample, and active-host-tool state **when an attempt times out**. This allows distinguishing a true remote silent stream from a normalization/consumer stall at minimal steady-state overhead. Avoid logging content or building a full stream trace.

Then reproduce under both a quiet single-session run and a high-concurrency Goal Auditor/snapshot workload, grouped by provider/model/route and request size. Require measured evidence before changing the 300-second threshold. Raising the threshold alone disguises the problem rather than resolving it.
