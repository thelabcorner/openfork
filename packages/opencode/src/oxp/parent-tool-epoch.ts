import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"

export const HANDOFF_AFTER_MS = 20 * 60 * 1000
export const EPOCH_MAX_MS = 25 * 60 * 1000

const MAX_TRACKED_PARENTS = 256
const RETAIN_IDLE_MS = 2 * 60 * 60 * 1000
const MAX_CORRELATION_BYTES = 1024

export interface ParentCorrelation {
  readonly scheme: "openai/session"
  readonly value: string
  readonly scope: "conversation"
}

type Entry = {
  epoch: number
  epochObservedAt: number
  lastCallAt: number
  callCount: number
  handoffReminderDelivered: boolean
  durableContinuationEstablished: boolean
}

export type Observation =
  | { readonly state: "unattributed"; readonly shouldRemind: false }
  | {
      readonly state: "active" | "handoff-recommended"
      readonly epoch: number
      readonly observedAgeMs: number
      readonly shouldRemind: boolean
      readonly durableContinuationEstablished: boolean
    }

export interface Stats {
  readonly parentEpochs: number
  readonly parentEpochReminders: number
  readonly conversationCorrelatedCalls: number
  readonly unattributedParentCalls: number
  readonly trackedParents: number
}

function boundedCorrelation(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CORRELATION_BYTES
    ? value
    : undefined
}

function keyOf(correlation: ParentCorrelation | undefined) {
  if (!correlation) return
  return createHash("sha256")
    .update(correlation.scheme, "utf8")
    .update("\0")
    .update(correlation.value, "utf8")
    .digest("base64url")
}

export function parentCorrelation(meta: unknown): ParentCorrelation | undefined {
  const source =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : undefined
  const chatGPTSession = boundedCorrelation(source?.["openai/session"])
  if (chatGPTSession) {
    return {
      scheme: "openai/session",
      value: chatGPTSession,
      scope: "conversation",
    }
  }
  // openai/subject is deliberately not a correlation fallback: OpenAI
  // documents it as anonymized user identity, not conversation identity.
  return undefined
}

export function makeTracker(options: { readonly now?: () => number } = {}) {
  const now = options.now ?? (() => performance.now())
  const entries = new Map<string, Entry>()
  let parentEpochs = 0
  let parentEpochReminders = 0
  let conversationCorrelatedCalls = 0
  let unattributedParentCalls = 0

  const prune = (at: number) => {
    for (const [key, entry] of entries) {
      if (at - entry.lastCallAt >= RETAIN_IDLE_MS) entries.delete(key)
    }
    while (entries.size >= MAX_TRACKED_PARENTS) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of entries) {
        if (entry.lastCallAt < oldestAt) {
          oldestAt = entry.lastCallAt
          oldestKey = key
        }
      }
      if (!oldestKey) break
      entries.delete(oldestKey)
    }
  }

  const begin = (key: string, at: number, prior?: Entry) => {
    const entry: Entry = {
      epoch: (prior?.epoch ?? 0) + 1,
      epochObservedAt: at,
      lastCallAt: at,
      callCount: 1,
      handoffReminderDelivered: false,
      durableContinuationEstablished: false,
    }
    entries.set(key, entry)
    parentEpochs += 1
    return entry
  }

  const observe = (correlation: ParentCorrelation | undefined): Observation => {
    const key = keyOf(correlation)
    if (!key) {
      unattributedParentCalls += 1
      return { state: "unattributed", shouldRemind: false }
    }
    conversationCorrelatedCalls += 1
    const at = now()
    prune(at)
    let entry = entries.get(key)
    if (!entry) {
      entry = begin(key, at)
    } else if (at - entry.epochObservedAt >= EPOCH_MAX_MS) {
      entry = begin(key, at, entry)
    } else {
      entry.lastCallAt = Math.max(entry.lastCallAt, at)
      entry.callCount += 1
    }

    const observedAgeMs = Math.max(0, at - entry.epochObservedAt)
    const shouldRemind = observedAgeMs >= HANDOFF_AFTER_MS && !entry.handoffReminderDelivered
    if (shouldRemind) {
      entry.handoffReminderDelivered = true
      parentEpochReminders += 1
    }
    return {
      state: observedAgeMs >= HANDOFF_AFTER_MS ? "handoff-recommended" : "active",
      epoch: entry.epoch,
      observedAgeMs: Math.floor(observedAgeMs),
      shouldRemind,
      durableContinuationEstablished: entry.durableContinuationEstablished,
    }
  }

  const markDurableContinuation = (correlation: ParentCorrelation | undefined) => {
    const key = keyOf(correlation)
    if (!key) return false
    const entry = entries.get(key)
    if (!entry) return false
    entry.durableContinuationEstablished = true
    return true
  }

  const hasDurableContinuation = (correlation: ParentCorrelation | undefined) => {
    const key = keyOf(correlation)
    return key ? entries.get(key)?.durableContinuationEstablished === true : false
  }

  const stats = (): Stats => ({
    parentEpochs,
    parentEpochReminders,
    conversationCorrelatedCalls,
    unattributedParentCalls,
    trackedParents: entries.size,
  })

  return { observe, markDurableContinuation, hasDurableContinuation, stats }
}

export type Tracker = ReturnType<typeof makeTracker>

export * as OxpParentToolEpoch from "./parent-tool-epoch"
