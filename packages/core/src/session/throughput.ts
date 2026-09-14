/**
 * Fork-owned turn throughput: request throughput with an honest denominator.
 *
 * One model step decomposes into four instants:
 *   t0 = requestSentAt (HTTP dispatch, stamped pre-stream)
 *   t1 = firstTokenAt  (first visible text/reasoning token)
 *   t2 = streamedAt    (response-body end, before tool settlement)
 *   t3 = completed     (after local tool settlement)
 *
 * The primary metric is request throughput, Σ visible output / Σ(t2 − t0),
 * matching upstream PR #45265 as corrected by PR #47125. Provider queueing
 * and prefill live in t0 → t1, so a decode-only rate would discard exactly
 * the signal used to compare providers. Tool execution (t2 → t3) is always
 * excluded: dividing by `completed` absorbs every shell call and permission
 * prompt into the denominator.
 *
 * Numerator and denominator always cover the same token population:
 * request windows contain reasoning time, so the request rate uses visible
 * output alone; the decode window anchored at first-token arrival uses
 * output + reasoning.
 *
 * Performance: single forward pass from the turn start, O(turn length),
 * no intermediate arrays, no allocation beyond the result. Called per
 * assistant-footer render, so it must stay cheaper than the markdown it
 * sits under.
 */

export interface ThroughputMessage {
  readonly id: string
  readonly role: string
  readonly modelKey?: string
  readonly output?: number
  readonly reasoning?: number
  readonly requestSentAt?: number
  readonly firstTokenAt?: number
  readonly streamedAt?: number
  readonly failed?: boolean
}

export interface TurnThroughput {
  /** Visible output tokens per second over Σ(streamedAt − requestSentAt). */
  readonly requestRate: number
  /** (output + reasoning) per second over Σ(streamedAt − firstTokenAt). */
  readonly decodeRate?: number
  /** Σ(firstTokenAt − requestSentAt) in milliseconds. */
  readonly ttftMs?: number
  readonly steps: number
}

type TurnAccumulator = {
  id: string
  steps: number
  output: number
  outputAndReasoning: number
  requestMs: number
  decodeMs: number
  ttftMs: number
  decodeMeasurable: boolean
  modelKey?: string
  invalid: boolean
}

const freshTurn = (id: string): TurnAccumulator => ({
  id,
  steps: 0,
  output: 0,
  outputAndReasoning: 0,
  requestMs: 0,
  decodeMs: 0,
  ttftMs: 0,
  decodeMeasurable: true,
  invalid: false,
})

const finishTurn = (turn: TurnAccumulator | undefined): TurnThroughput | undefined => {
  if (!turn || turn.invalid || turn.steps === 0 || turn.output <= 0 || turn.requestMs <= 0) return undefined
  const result: TurnThroughput = {
    requestRate: turn.output / (turn.requestMs / 1000),
    steps: turn.steps,
  }
  if (turn.decodeMeasurable && turn.decodeMs > 0 && turn.outputAndReasoning > 0) {
    return {
      ...result,
      decodeRate: turn.outputAndReasoning / (turn.decodeMs / 1000),
      ttftMs: turn.ttftMs,
    }
  }
  return result
}

const accumulateAssistant = (turn: TurnAccumulator, message: ThroughputMessage) => {
  if (turn.invalid) return
  if (message.failed) {
    turn.invalid = true
    return
  }
  const sent = message.requestSentAt
  const streamed = message.streamedAt
  if (sent === undefined || streamed === undefined || !(streamed > sent)) {
    turn.invalid = true
    return
  }
  if (turn.modelKey === undefined) turn.modelKey = message.modelKey
  else if (message.modelKey !== undefined && message.modelKey !== turn.modelKey) {
    turn.invalid = true
    return
  }
  turn.steps += 1
  turn.output += message.output ?? 0
  turn.outputAndReasoning += (message.output ?? 0) + (message.reasoning ?? 0)
  turn.requestMs += streamed - sent
  const first = message.firstTokenAt
  if (first === undefined || !(first > sent) || !(streamed > first)) turn.decodeMeasurable = false
  else {
    turn.decodeMs += streamed - first
    turn.ttftMs += first - sent
  }
}

/**
 * Compute every user turn's throughput in one forward pass.
 *
 * `turnThroughput(messages, id)` intentionally remains a convenient single-turn
 * API, but calling it once for every turn searches the same history repeatedly
 * and is O(turns * messages). Timeline/session-summary consumers that need all
 * turns must use this bulk form instead: every message belongs to at most one
 * active user turn, so the complete map is O(messages) time and O(turns) space.
 */
export function turnThroughputByTurn(messages: readonly ThroughputMessage[]): Map<string, TurnThroughput> {
  const result = new Map<string, TurnThroughput>()
  let turn: TurnAccumulator | undefined
  const finish = () => {
    const value = finishTurn(turn)
    if (turn && value) result.set(turn.id, value)
    turn = undefined
  }

  for (const message of messages) {
    if (message.role === "user") {
      finish()
      turn = freshTurn(message.id)
      continue
    }
    if (message.role === "model-switched") {
      if (turn) turn.invalid = true
      continue
    }
    if (message.role === "agent-switched") continue
    if (isBoundary(message.role)) {
      finish()
      continue
    }
    if (message.role === "assistant" && turn) accumulateAssistant(turn, message)
  }
  finish()
  return result
}

const isBoundary = (role: string) =>
  role === "user" || role === "synthetic" || role === "compaction" || role === "shell" || role === "system"

export function turnThroughput(
  messages: readonly ThroughputMessage[],
  turnID: string,
): TurnThroughput | undefined {
  let index = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.id === turnID) {
      index = i
      break
    }
  }
  if (index < 0) return undefined

  let steps = 0
  let output = 0
  let outputAndReasoning = 0
  let requestMs = 0
  let decodeMs = 0
  let ttftMs = 0
  let decodeMeasurable = true
  let modelKey: string | undefined

  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === "model-switched") return undefined
    if (message.role === "agent-switched") continue
    if (isBoundary(message.role)) break
    if (message.role !== "assistant") continue
    if (message.failed) return undefined
    const sent = message.requestSentAt
    const streamed = message.streamedAt
    // All-or-nothing: a step without a measured window disqualifies the
    // turn rather than mixing measured and unmeasured denominators.
    // Inverted or zero-length windows are clock anomalies, not fast
    // generations: clamping them to zero would keep the tokens while
    // dropping the time and inflate the rate.
    if (sent === undefined || streamed === undefined || !(streamed > sent)) return undefined
    if (modelKey === undefined) modelKey = message.modelKey
    else if (message.modelKey !== undefined && message.modelKey !== modelKey) return undefined
    steps += 1
    output += message.output ?? 0
    outputAndReasoning += (message.output ?? 0) + (message.reasoning ?? 0)
    requestMs += streamed - sent
    const first = message.firstTokenAt
    if (first === undefined || !(first > sent) || !(streamed > first)) decodeMeasurable = false
    else {
      decodeMs += streamed - first
      ttftMs += first - sent
    }
  }

  if (steps === 0 || output <= 0 || requestMs <= 0) return undefined
  const result: TurnThroughput = {
    requestRate: output / (requestMs / 1000),
    steps,
  }
  if (decodeMeasurable && decodeMs > 0 && outputAndReasoning > 0) {
    return { ...result, decodeRate: outputAndReasoning / (decodeMs / 1000), ttftMs }
  }
  return result
}

export * as SessionThroughput from "./throughput"
