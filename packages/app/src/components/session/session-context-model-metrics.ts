import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2/client"
import { isFreeUsageCost, type SubsidyTokens } from "@/utils/usage-subsidy"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

export type ModelCostRate = {
  input: number
  output: number
  cache: { read: number; write: number }
}

type Model = {
  name?: string
  limit: {
    context: number
  }
  cost?: ModelCostRate
}

export type CostBreakdown = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export type ModelContextMetrics = {
  key: string
  providerID: string
  modelID: string
  providerLabel: string
  modelLabel: string
  messageCount: number
  toolCallCount: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  /** Exact $0 turns and their token bundle. Kept separate while aggregating so
   * mixed paid/free histories never need to pro-rate tokens by message count. */
  freeMessageCount: number
  freeTokens: SubsidyTokens
  cacheHitPercent: number | null
  tokensPerSecond: number | null
  generatedSeconds: number
  toolSeconds: number
  ttftSeconds: number | null
  /** Upstream TTFT: time from request dispatch to first token, averaged across turns. */
  upstreamTTFTSeconds: number | null
  firstMessageTime: number
  lastMessageTime: number
  costRate?: ModelCostRate
  costBreakdown?: CostBreakdown
  /** Money saved by cache hits vs. billing those tokens at the fresh-input rate. */
  cacheSavings?: number
}

export type SessionContextTotals = {
  messageCount: number
  toolCallCount: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  cacheHitPercent: number | null
  tokensPerSecond: number | null
  generatedSeconds: number
  toolSeconds: number
  ttftSeconds: number | null
  /** Upstream TTFT: time from request dispatch to first token, averaged across turns. */
  upstreamTTFTSeconds: number | null
  costBreakdown?: CostBreakdown
  costBreakdownComplete: boolean
  /** Sum of available per-model cache savings — undefined only when no used model has a rate card. */
  cacheSavings?: number
}

export type SessionModelBreakdown = {
  session: SessionContextTotals
  models: ModelContextMetrics[]
}

type Accumulator = ModelContextMetrics & {
  durationSeconds: number
  durationTokens: number
  ttftSum: number
  ttftCount: number
  upstreamTTFTSum: number
  upstreamTTFTCount: number
}

const isAssistant = (msg: Message): msg is AssistantMessage => msg.role === "assistant"

const tokenTotal = (msg: AssistantMessage) => {
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const countToolCalls = (parts: Part[] | undefined) => {
  if (!parts) return 0
  return parts.reduce((count, part) => count + (part.type === "tool" ? 1 : 0), 0)
}

/**
 * Wall-clock time actually spent streaming model output, in seconds — the
 * precise signal, when it's available and trustworthy.
 *
 * Text and reasoning parts each carry their own `time.start`/`time.end`
 * bounding just the span they were streamed over, so summing those spans
 * (not `max(end) - min(start)`, which would re-include any tool-call gap
 * between them) isolates actual generation time from tool execution (shell
 * commands, batch/subagent calls, etc.) that can run between generation
 * steps. Synthetic/ignored text (e.g. compaction summaries) and parts still
 * missing an end timestamp (aborted mid-stream) are excluded rather than
 * guessed at.
 *
 * This can still read as near-zero if a proxy or provider buffers and
 * flushes a burst of tokens near-simultaneously instead of truly streaming
 * them — see `isPlausibleRate` and `approximateGenerationSeconds` below for
 * how that case is handled.
 */
const measuredGenerationSeconds = (parts: Part[] | undefined) => {
  if (!parts) return 0
  let seconds = 0
  for (const part of parts) {
    if (part.type !== "text" && part.type !== "reasoning") continue
    if (part.type === "text" && (part.synthetic || part.ignored)) continue
    const time = part.time
    if (!time || time.end === undefined) continue
    const span = (time.end - time.start) / 1000
    if (span > 0) seconds += span
  }
  return seconds
}

/**
 * Total time tool calls (shell, batch/subagent, etc.) spent executing within
 * a turn, in seconds.
 *
 * Finished calls (`completed`/`error`) always count via their own
 * start/end. A still-`running` call only counts when a `now` cutoff is
 * given — its elapsed-so-far (`now - start`) is added — which the live
 * in-progress ticker needs (a shell command that's still running shouldn't
 * be invisible to it) but the historical/completed-message paths don't:
 * without a `now`, `running` calls are ignored, matching the old
 * pending/running-have-no-end-yet behavior for messages that have already
 * finished (where nothing should still be `running` anyway).
 */
const toolExecutionSeconds = (parts: Part[] | undefined, now?: number) => {
  if (!parts) return 0
  let seconds = 0
  for (const part of parts) {
    if (part.type !== "tool") continue
    const state = part.state
    if (!state) continue
    if (state.status === "completed" || state.status === "error") {
      const span = (state.time.end - state.time.start) / 1000
      if (span > 0) seconds += span
    } else if (state.status === "running" && now !== undefined) {
      const span = (now - state.time.start) / 1000
      if (span > 0) seconds += span
    }
  }
  return seconds
}

/**
 * Time-to-first-token: the delay between a message being created and the
 * first text/reasoning token arriving. Prefers the server-stamped
 * `time.firstTokenAt` directly — it's authoritative and doesn't depend on
 * part data having synced to the client. Falls back to scanning for the
 * first timestamped text/reasoning part (the only signal available before
 * `firstTokenAt` existed, or for providers that don't report it). Returns
 * seconds, or null when neither signal is usable.
 */
const timeToFirstToken = (msg: AssistantMessage, parts: Part[] | undefined): number | null => {
  const firstTokenAt = msg.time.firstTokenAt
  if (firstTokenAt !== undefined) {
    const delayMs = firstTokenAt - msg.time.created
    return delayMs > 0 ? delayMs / 1000 : null
  }

  if (!parts) return null
  for (const part of parts) {
    if (part.type !== "text" && part.type !== "reasoning") continue
    if (part.type === "text" && (part.synthetic || part.ignored)) continue
    const time = part.time
    if (!time || time.start === undefined) continue
    const delayMs = time.start - msg.time.created
    return delayMs > 0 ? delayMs / 1000 : null
  }
  return null
}

/**
 * Upstream TTFT: the delay between the provider HTTP request being dispatched
 * (`requestSentAt`) and the first visible text/reasoning token arriving
 * (`firstTokenAt`). This isolates the provider-side latency from client-side
 * request preparation overhead. Returns seconds, or null when the message
 * lacks the upstream timing fields.
 */
const upstreamTimeToFirstToken = (msg: AssistantMessage): number | null => {
  const requestSent = msg.time.requestSentAt
  const firstToken = msg.time.firstTokenAt
  if (requestSent === undefined || firstToken === undefined) return null
  const delayMs = firstToken - requestSent
  return delayMs > 0 ? delayMs / 1000 : null
}

/**
 * Fallback duration when the precise text/reasoning-part signal is missing
 * or fails the plausibility check.
 *
 * Anchors on `time.firstTokenAt` when available — generation only actually
 * starts once the first token arrives, so anything before that (request
 * queueing, network round-trip, the model "thinking" before it streams
 * anything) is TTFT/latency, not generation time, and folding it into this
 * window would make the resulting tokens/sec look slower than reality.
 * `time.created` is used only when `firstTokenAt` isn't available (older
 * data, or a provider that doesn't report it) — that anchor is coarser since
 * it includes TTFT, so it still tends to *understate* speed rather than
 * overstate it, which is why it exists: a provider/proxy that only ever
 * delivers text in one non-streamed burst has no usable part-level timing at
 * all, and would otherwise always show "unavailable".
 *
 * Either way, known tool execution time within the window is subtracted, and
 * the remainder is floored at 0 in case clock skew or an inverted timestamp
 * pair briefly produces a negative window.
 */
const approximateGenerationSeconds = (msg: AssistantMessage, parts: Part[] | undefined) => {
  const completed = msg.time.completed
  const anchor = msg.time.firstTokenAt ?? msg.time.created
  if (!completed || completed <= anchor) return 0
  const window = (completed - anchor) / 1000
  return Math.max(0, window - toolExecutionSeconds(parts, completed))
}

export type LiveGenerationProgress = { generatedSeconds: number; toolSeconds: number }

/**
 * Faux-realtime progress for a turn that hasn't finished yet (`time.completed`
 * unset), for a UI-layer ticker to display while streaming — this only makes
 * sense against a live `now`, so it's kept separate from the pure historical
 * aggregation above rather than folded into `aggregateSessionContextByModel`
 * (which has no concept of "the current time" and shouldn't need one to stay
 * deterministically testable).
 *
 * `toolSeconds` counts finished tool calls the same way as the historical
 * path, plus any *currently running* tool call's elapsed time up to `now` —
 * without that, a live "Generated Time" ticker would keep counting up while
 * a long-running shell command is still executing, exactly the bug the
 * historical estimator was built to avoid.
 *
 * `generatedSeconds` only starts ticking once `time.firstTokenAt` is known —
 * before that the turn is still in TTFT/latency, not generation, so there's
 * nothing to report yet (both fields read 0 rather than something misleading).
 */
export const liveGenerationProgress = (
  msg: AssistantMessage,
  parts: Part[] | undefined,
  now: number,
): LiveGenerationProgress => {
  const toolSeconds = toolExecutionSeconds(parts, now)
  if (msg.time.completed) return { generatedSeconds: 0, toolSeconds: 0 }

  const anchor = msg.time.firstTokenAt
  if (anchor === undefined || now <= anchor) return { generatedSeconds: 0, toolSeconds }

  const window = (now - anchor) / 1000
  return { generatedSeconds: Math.max(0, window - toolSeconds), toolSeconds }
}

/**
 * Cache-hit ratio denominator is cache reads plus fresh input tokens (the
 * total prompt tokens processed for the turn). Undefined/zero denominator
 * means no evidence either way, not a 0% hit rate.
 */
const cacheHitPercent = (cacheRead: number, input: number) => {
  const denominator = cacheRead + input
  if (denominator <= 0) return null
  return Math.round((cacheRead / denominator) * 1000) / 10
}

/**
 * Tokens/sec is derived only from turns with measurable generation time
 * (see `generationSeconds`); turns without it are excluded from both the
 * numerator and denominator rather than assumed instantaneous.
 */
const tokensPerSecond = (generatedTokens: number, seconds: number) => {
  if (seconds <= 0 || generatedTokens <= 0) return null
  return Math.round((generatedTokens / seconds) * 10) / 10
}

/**
 * No publicly documented single-request LLM decode throughput exceeds this
 * as of writing (fast inference stacks top out in the hundreds of tok/s per
 * request). `time.start`/`time.end` are stamped by the server the instant it
 * observes the SSE `text-start`/`text-end` boundary — if a proxy or provider
 * buffers and then flushes a burst of tokens near-simultaneously, the
 * *measured* span can be a few milliseconds even though real generation took
 * much longer, producing nonsense like "16,000 tok/s". Since one such
 * message can dominate a weighted-average sum, a per-message turn whose
 * implied rate exceeds this ceiling is treated as an untrustworthy
 * measurement and excluded entirely, the same as a turn with no timing data
 * at all — better to under-report than to publish a number known to be
 * physically impossible.
 */
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1000

const isPlausibleRate = (generatedTokens: number, seconds: number) => {
  return generatedTokens / seconds <= MAX_PLAUSIBLE_TOKENS_PER_SECOND
}

/**
 * Derived from the model's published $/1M-token rate card, not the actual
 * billed `message.cost` — used to split cost by token category since the
 * provider only reports a single total per message. May not sum exactly to
 * the billed total (promos, peak pricing, rounding), so callers should
 * present this as an estimate alongside the real total.
 */
const costBreakdown = (
  rate: ModelCostRate | undefined,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): CostBreakdown | undefined => {
  if (!rate) return undefined
  const input = (tokens.input / 1_000_000) * rate.input
  const output = (tokens.output / 1_000_000) * rate.output
  const cacheRead = (tokens.cacheRead / 1_000_000) * rate.cache.read
  const cacheWrite = (tokens.cacheWrite / 1_000_000) * rate.cache.write
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

const sumCostBreakdown = (breakdowns: CostBreakdown[]): CostBreakdown | undefined => {
  if (breakdowns.length === 0) return undefined
  return breakdowns.reduce(
    (sum, item) => ({
      input: sum.input + item.input,
      output: sum.output + item.output,
      cacheRead: sum.cacheRead + item.cacheRead,
      cacheWrite: sum.cacheWrite + item.cacheWrite,
      total: sum.total + item.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  )
}

/**
 * What those cache-read tokens would have cost at the model's fresh-input
 * rate, minus what they actually cost at the (cheaper) cache-read rate —
 * i.e. money saved specifically by cache hits. Doesn't net out cache-write
 * cost (the cost paid to populate the cache in the first place); that's
 * shown separately as its own cost-breakdown category rather than folded in
 * here, since "how much did hits save" and "how much did writes cost" are
 * different questions. Clamped at 0 in case a rate card is ever configured
 * with cache reads priced at or above the fresh-input rate, where "savings"
 * would otherwise go negative.
 */
const cacheSavings = (rate: ModelCostRate | undefined, cacheReadTokens: number): number | undefined => {
  if (!rate) return undefined
  return Math.max(0, (cacheReadTokens / 1_000_000) * (rate.input - rate.cache.read))
}

/**
 * The model that actually served a message when it differs from the
 * configured/requested one (e.g. an OpenRouter `free`/`auto` router slug).
 * Undefined when the router didn't resolve to a different model, so callers
 * fall back to the configured `providerID`/`modelID`.
 */
export function effectiveModel(msg: AssistantMessage) {
  const served = msg.servedModel
  if (!served || served.modelID === msg.modelID) return undefined
  return served
}

/** Grouping key for per-model metrics — the served model when one exists. */
export function modelKey(msg: AssistantMessage) {
  const served = effectiveModel(msg)
  return served ? `${served.providerID ?? msg.providerID}:${served.modelID}` : `${msg.providerID}:${msg.modelID}`
}

const emptyAccumulator = (msg: AssistantMessage, providers: Provider[]): Accumulator => {
  const served = effectiveModel(msg)
  const providerID = served?.providerID ?? msg.providerID
  const modelID = served?.modelID ?? msg.modelID
  const provider = providers.find((item) => item.id === msg.providerID)
  const model = provider?.models[modelID]
  return {
    key: modelKey(msg),
    providerID,
    modelID,
    providerLabel: served?.providerID ?? provider?.name ?? msg.providerID,
    modelLabel: model?.name ?? modelID,
    messageCount: 0,
    toolCallCount: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    freeMessageCount: 0,
    freeTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cacheHitPercent: null,
    tokensPerSecond: null,
    firstMessageTime: msg.time.created,
    lastMessageTime: msg.time.created,
    costRate: model?.cost,
    durationSeconds: 0,
    durationTokens: 0,
    generatedSeconds: 0,
    toolSeconds: 0,
    ttftSeconds: null,
    ttftSum: 0,
    ttftCount: 0,
    upstreamTTFTSeconds: null,
    upstreamTTFTSum: 0,
    upstreamTTFTCount: 0,
  }
}

export function aggregateSessionContextByModel(
  messages: Message[] = [],
  parts: Record<string, Part[] | undefined> = {},
  providers: Provider[] = [],
): SessionModelBreakdown {
  const byModel = new Map<string, Accumulator>()

  const totals = {
    messageCount: 0,
    toolCallCount: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    durationSeconds: 0,
    durationTokens: 0,
    toolSeconds: 0,
    ttftSum: 0,
    ttftCount: 0,
    upstreamTTFTSum: 0,
    upstreamTTFTCount: 0,
  }

  for (const msg of messages) {
    if (!isAssistant(msg)) continue
    if (tokenTotal(msg) <= 0) continue

    const entry = byModel.get(modelKey(msg)) ?? emptyAccumulator(msg, providers)
    const toolCalls = countToolCalls(parts[msg.id])

    entry.messageCount += 1
    entry.toolCallCount += toolCalls
    entry.input += msg.tokens.input
    entry.output += msg.tokens.output
    entry.reasoning += msg.tokens.reasoning
    entry.cacheRead += msg.tokens.cache.read
    entry.cacheWrite += msg.tokens.cache.write
    entry.total += tokenTotal(msg)
    entry.cost += msg.cost
    if (isFreeUsageCost(msg.cost)) {
      entry.freeMessageCount += 1
      entry.freeTokens.input += msg.tokens.input
      entry.freeTokens.output += msg.tokens.output
      entry.freeTokens.reasoning += msg.tokens.reasoning
      entry.freeTokens.cacheRead += msg.tokens.cache.read
      entry.freeTokens.cacheWrite += msg.tokens.cache.write
    }
    entry.firstMessageTime = Math.min(entry.firstMessageTime, msg.time.created)
    entry.lastMessageTime = Math.max(entry.lastMessageTime, msg.time.created)

    totals.messageCount += 1
    totals.toolCallCount += toolCalls
    totals.input += msg.tokens.input
    totals.output += msg.tokens.output
    totals.reasoning += msg.tokens.reasoning
    totals.cacheRead += msg.tokens.cache.read
    totals.cacheWrite += msg.tokens.cache.write
    totals.cost += msg.cost

    const generated = msg.tokens.output + msg.tokens.reasoning
    if (generated > 0) {
      const measured = measuredGenerationSeconds(parts[msg.id])
      const seconds =
        measured > 0 && isPlausibleRate(generated, measured)
          ? measured
          : approximateGenerationSeconds(msg, parts[msg.id])
      if (seconds > 0 && isPlausibleRate(generated, seconds)) {
        entry.durationSeconds += seconds
        entry.durationTokens += generated
        totals.durationSeconds += seconds
        totals.durationTokens += generated
      }
    }

    const toolTime = toolExecutionSeconds(parts[msg.id])
    entry.toolSeconds += toolTime
    totals.toolSeconds += toolTime

    const ttft = timeToFirstToken(msg, parts[msg.id])
    if (ttft !== null) {
      entry.ttftSum += ttft
      entry.ttftCount += 1
      totals.ttftSum += ttft
      totals.ttftCount += 1
    }

    const upstreamTTFT = upstreamTimeToFirstToken(msg)
    if (upstreamTTFT !== null) {
      entry.upstreamTTFTSum += upstreamTTFT
      entry.upstreamTTFTCount += 1
      totals.upstreamTTFTSum += upstreamTTFT
      totals.upstreamTTFTCount += 1
    }

    byModel.set(entry.key, entry)
  }

  const models = [...byModel.values()]
    .map(({ durationSeconds, durationTokens, ttftSum, ttftCount, upstreamTTFTSum, upstreamTTFTCount, ...entry }) => ({
      ...entry,
      generatedSeconds: durationSeconds,
      ttftSeconds: ttftCount > 0 ? ttftSum / ttftCount : null,
      upstreamTTFTSeconds: upstreamTTFTCount > 0 ? upstreamTTFTSum / upstreamTTFTCount : null,
      cacheHitPercent: cacheHitPercent(entry.cacheRead, entry.input),
      tokensPerSecond: tokensPerSecond(durationTokens, durationSeconds),
      costBreakdown: costBreakdown(entry.costRate, entry),
      cacheSavings: cacheSavings(entry.costRate, entry.cacheRead),
    }))
    .sort((a, b) => b.total - a.total)

  const availableBreakdowns = models.flatMap((model) => (model.costBreakdown ? [model.costBreakdown] : []))
  const availableSavings = models.flatMap((model) => (model.cacheSavings !== undefined ? [model.cacheSavings] : []))

  const session: SessionContextTotals = {
    messageCount: totals.messageCount,
    toolCallCount: totals.toolCallCount,
    input: totals.input,
    output: totals.output,
    reasoning: totals.reasoning,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    total: totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite,
    cost: totals.cost,
    cacheHitPercent: cacheHitPercent(totals.cacheRead, totals.input),
    tokensPerSecond: tokensPerSecond(totals.durationTokens, totals.durationSeconds),
    generatedSeconds: totals.durationSeconds,
    toolSeconds: totals.toolSeconds,
    ttftSeconds: totals.ttftCount > 0 ? totals.ttftSum / totals.ttftCount : null,
    upstreamTTFTSeconds: totals.upstreamTTFTCount > 0 ? totals.upstreamTTFTSum / totals.upstreamTTFTCount : null,
    costBreakdown: sumCostBreakdown(availableBreakdowns),
    costBreakdownComplete: models.length > 0 && availableBreakdowns.length === models.length,
    cacheSavings: availableSavings.length > 0 ? availableSavings.reduce((sum, value) => sum + value, 0) : undefined,
  }

  return { session, models }
}
