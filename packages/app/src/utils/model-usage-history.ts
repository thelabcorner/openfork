import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"

// Real personal usage, derived from the assistant messages this client has
// already synced (session history in this app instance) rather than a
// generic published profile — this reflects the user's own actual prompt/
// response sizes for a given model, which is a far better predictor of their
// future spend than an industry-average estimate.
//
// Built as a single O(messages) pass producing a per-model index, rather than
// filtering the full message store once per model (O(models * messages)):
// with N models in the selector and a session history that only grows over
// time, that product gets expensive fast, and it was being repeated on every
// render (twice per row, plus once more per model for the relative-bar max)
// with no memoization at all. Callers should build this once via createMemo
// keyed on the message store and reuse it — see dialog-select-model.tsx.
const MAX_SAMPLES_PER_MODEL = 200
// Hard ceiling on total messages inspected per rebuild. Sync doesn't expose a
// global chronological order across sessions, so this can't guarantee "most
// recent" — it's a backstop against unbounded cost as history accumulates,
// not the primary relevance mechanism (MAX_SAMPLES_PER_MODEL is).
const MAX_MESSAGES_SCANNED = 20_000

export type ModelCostIndex = Map<string, { sum: number; count: number }>

const indexKey = (providerID: string, modelID: string) => `${providerID}:${modelID}`

export function buildModelCostIndex(messagesBySession: Record<string, Message[] | undefined>): ModelCostIndex {
  const index: ModelCostIndex = new Map()
  let scanned = 0
  outer: for (const messages of Object.values(messagesBySession)) {
    if (!messages) continue
    for (const message of messages) {
      if (scanned >= MAX_MESSAGES_SCANNED) break outer
      scanned++
      if (message.role !== "assistant") continue
      const assistant = message as AssistantMessage
      if (!(assistant.cost > 0)) continue
      const key = indexKey(assistant.providerID, assistant.modelID)
      const entry = index.get(key)
      if (!entry) {
        index.set(key, { sum: assistant.cost, count: 1 })
        continue
      }
      if (entry.count >= MAX_SAMPLES_PER_MODEL) continue
      entry.sum += assistant.cost
      entry.count++
    }
  }
  return index
}

export function averageCostPerRequest(index: ModelCostIndex, model: { id: string; providerID: string }): number | undefined {
  const entry = index.get(indexKey(model.providerID, model.id))
  if (!entry) return undefined
  return entry.sum / entry.count
}

export type HitRateIndex = Map<string, { input: number; cacheRead: number; count: number }>

export function buildHitRateIndex(messagesBySession: Record<string, Message[] | undefined>): HitRateIndex {
  const index: HitRateIndex = new Map()
  let scanned = 0
  outer: for (const messages of Object.values(messagesBySession)) {
    if (!messages) continue
    for (const message of messages) {
      if (scanned >= MAX_MESSAGES_SCANNED) break outer
      scanned++
      if (message.role !== "assistant") continue
      const assistant = message as AssistantMessage
      // Need both input and cacheRead to compute hit rate; if neither, skip
      const input = (assistant.tokens as unknown as { input?: number })?.input ?? 0
      const cacheRead = (assistant.tokens as unknown as { cache?: { read?: number } })?.cache?.read ?? (assistant.tokens as unknown as { cacheRead?: number })?.cacheRead ?? 0
      // Also try the flat tokens shape used in some SDK versions
      const tokensAny = assistant.tokens as unknown as Record<string, unknown>
      const actualInput = typeof tokensAny["input"] === "number" ? (tokensAny["input"] as number) : input
      const actualCacheRead =
        typeof (tokensAny["cache"] as Record<string, unknown> | undefined)?.["read"] === "number"
          ? ((tokensAny["cache"] as Record<string, unknown>)["read"] as number)
          : typeof tokensAny["cacheRead"] === "number"
            ? (tokensAny["cacheRead"] as number)
            : cacheRead
      if (!(actualInput > 0 || actualCacheRead > 0)) continue
      const key = indexKey(assistant.providerID, assistant.modelID)
      const entry = index.get(key)
      if (!entry) {
        index.set(key, { input: actualInput, cacheRead: actualCacheRead, count: 1 })
        continue
      }
      if (entry.count >= MAX_SAMPLES_PER_MODEL) continue
      entry.input += actualInput
      entry.cacheRead += actualCacheRead
      entry.count++
    }
  }
  return index
}

export function hitRateForModel(index: HitRateIndex, model: { id: string; providerID: string }): number | undefined {
  const entry = index.get(indexKey(model.providerID, model.id))
  if (!entry) return undefined
  const denom = entry.input + entry.cacheRead
  if (denom <= 0) return undefined
  return entry.cacheRead / denom
}

export function hitRateFromTotals(input: number, cacheRead: number): number | undefined {
  const denom = input + cacheRead
  if (denom <= 0) return undefined
  return cacheRead / denom
}
