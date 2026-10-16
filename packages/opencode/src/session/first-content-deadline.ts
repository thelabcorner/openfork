import { Effect, Queue } from "effect"
import type { LLMEvent } from "@opencode-ai/llm"

type ProgressEvent = Pick<LLMEvent, "type"> & { readonly id?: string; readonly reason?: string }

/** Transport-independent, content-free per-attempt SDK and consumer witnesses. */
export function createProviderStreamProbe() {
  let sdkEvents = 0
  let normalizedEvents = 0
  // The consumer ignores 'step-start' when counting response progress. Keep
  // the queue comparison in that same domain to prevent a permanent +1 skew
  // from misclassifying every real upstream idle as local backpressure.
  let normalizedResponseEvents = 0
  let lastSdkEvent = "none"
  let lastNormalizedEvent = "none"
  let lastSdkAt: number | undefined
  let lastNormalizedAt: number | undefined
  let handling: { type: string; since: number; phase: string } | undefined
  return {
    sdk(type: string) {
      sdkEvents++
      lastSdkEvent = type
      lastSdkAt = performance.now()
    },
    normalized(type: string) {
      normalizedEvents++
      if (type !== "step-start") normalizedResponseEvents++
      lastNormalizedEvent = type
      lastNormalizedAt = performance.now()
    },
    begin(type: string) { handling = { type, since: performance.now(), phase: "accepted" } },
    phase(label: string) { if (handling) handling.phase = label },
    end() { handling = undefined },
    snapshot(now = performance.now()) {
      return {
        sdkEvents,
        normalizedEvents,
        normalizedResponseEvents,
        lastSdkEvent,
        lastNormalizedEvent,
        sdkIdleMs: lastSdkAt === undefined ? undefined : Math.round(now - lastSdkAt),
        normalizedIdleMs: lastNormalizedAt === undefined ? undefined : Math.round(now - lastNormalizedAt),
        consumerEvent: handling?.type,
        consumerPhase: handling?.phase,
        consumerBusyMs: handling === undefined ? 0 : Math.round(now - handling.since),
      }
    },
  }
}

export class ProviderConsumerStallError extends Error {
  override readonly name = "ProviderConsumerStallError"
  constructor(readonly eventType: string, readonly timeoutMs: number) {
    super(`Local provider event processing stalled (${eventType}, ${timeoutMs}ms)`)
  }
}

/** Distinguish a host progress watchdog from upstream HTTP/network timeouts. */
export class ProviderProgressTimeoutError extends Error {
  override readonly name = "ProviderProgressTimeoutError"
  constructor(
    readonly phase: "waiting for first content" | "provider stream idle",
    readonly timeoutMs: number,
  ) {
    super(`Provider response timed out (${phase}, ${timeoutMs}ms)`)
  }
}

// Bound *both* silent first-response admission and stalled midstream responses.
// Once a host tool starts, its own timeout/lifecycle owns the pending interval.
export const PROVIDER_IDLE_TIMEOUT_MS = 5 * 60 * 1000
export const PROVIDER_IDLE_TIMEOUT_ENV = "OPENFORK_PROVIDER_IDLE_TIMEOUT_MS"
// A silent first-response wait must not occupy an interactive Session for five minutes.
// Once provider output arrives, the longer idle budget still protects expensive streams.
export const PROVIDER_FIRST_RESPONSE_TIMEOUT_MS = 90 * 1000
export const PROVIDER_FIRST_RESPONSE_TIMEOUT_ENV = "OPENFORK_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS"
// A finished AI SDK generation step must produce either a final completion or
// the next step. This is distinct from long-running *unfinished* reasoning.
export const PROVIDER_STEP_FINALIZATION_TIMEOUT_MS = 20 * 1000
// The *provider* post-step finalization window must not cut off local snapshot
// enrichment, which has separately bounded 30-second sub-operations.
export const PROVIDER_LOCAL_CONSUMER_TIMEOUT_MS = 120 * 1000

/** Correlatable request identity only; never include credentials or content. */
export interface ProviderProgressIdentity {
  readonly sessionID: string
  readonly messageID: string
  readonly providerID: string
  readonly modelID: string
  readonly routeKind?: "account" | "public"
}

/** A bounded operator override also permits short deterministic integration tests. */
export function configuredProviderIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PROVIDER_IDLE_TIMEOUT_ENV]
  if (!raw || !raw.trim()) return PROVIDER_IDLE_TIMEOUT_MS
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 50 && value <= 30 * 60 * 1000
    ? value
    : PROVIDER_IDLE_TIMEOUT_MS
}

export function configuredProviderFirstResponseTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PROVIDER_FIRST_RESPONSE_TIMEOUT_ENV]
  if (raw?.trim()) {
    const value = Number(raw)
    if (Number.isSafeInteger(value) && value >= 50 && value <= 30 * 60 * 1000) return value
  }
  // Respect pre-existing per-installation timeout overrides without requiring migration.
  return env[PROVIDER_IDLE_TIMEOUT_ENV]?.trim()
    ? configuredProviderIdleTimeoutMs(env)
    : PROVIDER_FIRST_RESPONSE_TIMEOUT_MS
}

export function isProviderResponseEvent(event: ProgressEvent) {
  return event.type !== "step-start"
}

export function withProviderProgressDeadline<A, E, R>(
  work: (
    observe: (event: ProgressEvent) => Effect.Effect<void>,
    consumer: { begin: (type: string) => void; phase: (label: string) => void; end: () => void },
  ) => Effect.Effect<A, E, R>,
  timeoutMs = configuredProviderIdleTimeoutMs(),
  hostToolState?: (id: string) => "pending" | "running" | "settled",
  firstResponseTimeoutMs = Math.min(timeoutMs, configuredProviderFirstResponseTimeoutMs()),
  probe = createProviderStreamProbe(),
  stepFinalizationTimeoutMs = PROVIDER_STEP_FINALIZATION_TIMEOUT_MS,
  identity?: ProviderProgressIdentity,
): Effect.Effect<A, E | Error, R> {
  return Effect.gen(function* () {
    // Monotonic clock: NTP adjustments or manual wall-clock changes must not
    // silently extend a pending request beyond its configured idle budget.
    // A bounded one-slot wake-up prevents stale long sleeps when a finish-step,
    // local handler, or subsequent step changes the active deadline. No polling
    // fiber or per-token timer is needed, even with many concurrent sessions.
    const changes = yield* Queue.bounded<number>(1)
    const wake = () => { Queue.offerUnsafe(changes, 1) }
    let lastProgressAt = performance.now()
    const startedAt = lastProgressAt
    let firstContent = false
    let observedEvents = 0
    let lastEventType = "none"
    let awaitingStepCompletion = false
    let awaitingNextStepContent = false
    let completedStepReason: string | undefined
    // Handler completion only resets the provider clock for real response
    // progress. Repeated SDK start-step markers are not model output.
    let handlerProgress = false
    const pendingTools = new Set<string>()
    const observe = (event: ProgressEvent): Effect.Effect<void> =>
      Effect.sync(() => {
        if (event.type === "step-start") {
          handlerProgress = awaitingStepCompletion
          if (awaitingStepCompletion) {
            lastProgressAt = performance.now()
            awaitingNextStepContent = true
          }
          awaitingStepCompletion = false
          completedStepReason = undefined
          wake()
          return
        }
        if (!isProviderResponseEvent(event)) return
        handlerProgress = true
        firstContent = true
        lastProgressAt = performance.now()
        observedEvents++
        lastEventType = event.type
        awaitingStepCompletion = event.type === "step-finish"
        awaitingNextStepContent = false
        completedStepReason = awaitingStepCompletion ? event.reason : undefined
        if (event.type === "tool-call" && event.id) pendingTools.add(event.id)
        if ((event.type === "tool-result" || event.type === "tool-error") && event.id)
          pendingTools.delete(event.id)
        if (event.type === "step-finish" || event.type === "finish" || event.type === "tool-call" ||
          event.type === "tool-result" || event.type === "tool-error") wake()
      })
    const deadline = Effect.gen(function* () {
      while (true) {
        // Only a genuinely executing tool owns its own lifetime; merely
        // receiving a provider tool-call does not prove execution.
        if (pendingTools.size > 0) {
          let active = false
          for (const id of pendingTools) {
            const state = hostToolState?.(id) ?? "running"
            if (state === "running") active = true
            if (state === "settled") {
              pendingTools.delete(id)
              lastProgressAt = performance.now()
            }
          }
          if (active) {
            yield* Effect.sleep("1 second")
            continue
          }
        }
        const budgetMs = probe.snapshot().consumerEvent !== undefined
          ? Math.min(timeoutMs, PROVIDER_LOCAL_CONSUMER_TIMEOUT_MS)
          : !firstContent
            ? firstResponseTimeoutMs
            : awaitingStepCompletion
              ? Math.min(timeoutMs, completedStepReason === "stop"
                ? stepFinalizationTimeoutMs
                : firstResponseTimeoutMs)
              : awaitingNextStepContent ? Math.min(timeoutMs, firstResponseTimeoutMs) : timeoutMs
        const remaining = budgetMs - (performance.now() - lastProgressAt)
        if (remaining > 0) {
          yield* Effect.raceFirst(Effect.sleep(`${remaining} millis`), Queue.take(changes))
          continue
        }
        const phase = firstContent ? "provider stream idle" : "waiting for first content"
        // A zero-event timeout can mean long first-token latency; a midstream
        // timeout can mean a stalled provider, transport or event consumer. Log
        // only bounded metadata, not streamed content or tool arguments.
        const witness = probe.snapshot()
        // A normalized event already emitted by the adapter but not accepted
        // by the serial consumer cannot be a silent upstream provider. The
        // consumer might be starved between queue/dequeue or flushing deltas.
        const localStage = witness.consumerEvent ??
          (witness.normalizedResponseEvents > observedEvents ? "normalized-event-queue" : undefined)
        const localStall = localStage !== undefined
        yield* Effect.logWarning(localStall ? "local provider event consumer stalled" : "provider progress watchdog expired", {
          ...(identity ?? {}),
          phase,
          classification: localStall ? "local-consumer" : "provider-or-sdk-idle",
          timeoutMs: budgetMs,
          observedEvents,
          lastEventType,
          idleMs: Math.round(performance.now() - lastProgressAt),
          attemptMs: Math.round(performance.now() - startedAt),
          pendingHostTools: pendingTools.size,
          awaitingStepCompletion,
          awaitingNextStepContent,
          completedStepReason,
          ...witness,
        })
        if (localStage) return yield* Effect.fail(new ProviderConsumerStallError(localStage, budgetMs))
        return yield* Effect.fail(new ProviderProgressTimeoutError(phase, budgetMs))
      }
    })
    // Provider finalization can only advance when the serial consumer releases
    // the preceding step. Do not charge local snapshot/telemetry/persistence
    // time against the subsequent provider finalization grace window.
    const consumer = {
      begin: (type: string) => { probe.begin(type); wake() },
      phase: probe.phase,
      end: () => {
        probe.end()
        if (handlerProgress) lastProgressAt = performance.now()
        handlerProgress = false
        wake()
      },
    }
    return yield* Effect.raceFirst(work(observe, consumer), deadline)
  })
}