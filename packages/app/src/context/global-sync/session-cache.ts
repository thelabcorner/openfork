import type { Message, Part, PermissionRequest, QuestionRequest, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"

export const SESSION_CACHE_LIMIT = 40
// Approximate retained JS heap for background session caches. Strings are
// counted as UTF-16 (2 bytes/code unit), which intentionally treats base64
// media as expensive. Active/protected sessions are never evicted just to meet
// this budget, but their known bytes still count so idle caches are shed first.
export const SESSION_CACHE_BYTE_LIMIT = 128 * 1024 * 1024

type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  session_diff: Record<string, FileDiffInfo[] | undefined>
  todo: Record<string, Todo[] | undefined>
  message: Record<string, Message[] | undefined>
  session_message: Record<string, SessionMessageInfo[] | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
  part_text_accum_delta: Record<string, string | undefined>
}

function roughValueBytes(value: unknown, seen: Set<object>): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "string") return 16 + value.length * 2
  if (typeof value === "number" || typeof value === "bigint") return 8
  if (typeof value === "boolean") return 4
  if (typeof value !== "object") return 0
  if (seen.has(value)) return 0
  seen.add(value)

  if (Array.isArray(value)) {
    let bytes = 24 + value.length * 8
    for (const item of value) bytes += roughValueBytes(item, seen)
    return bytes
  }

  let bytes = 32
  for (const [key, item] of Object.entries(value)) {
    bytes += 16 + key.length * 2 + roughValueBytes(item, seen)
  }
  return bytes
}

/**
 * Approximate one session's retained renderer cache without serializing it.
 * Called at background/cache lifecycle boundaries, never for each stream delta.
 */
export function estimateSessionCacheBytes(store: SessionCache, sessionID: string) {
  const seen = new Set<object>()
  let bytes = 0
  bytes += roughValueBytes(store.session_status[sessionID], seen)
  bytes += roughValueBytes(store.session_diff[sessionID], seen)
  bytes += roughValueBytes(store.todo[sessionID], seen)
  bytes += roughValueBytes(store.message[sessionID], seen)
  bytes += roughValueBytes(store.session_message[sessionID], seen)
  bytes += roughValueBytes(store.permission[sessionID], seen)
  bytes += roughValueBytes(store.question[sessionID], seen)

  const messageIDs = new Set<string>()
  for (const message of store.message[sessionID] ?? []) messageIDs.add(message.id)
  for (const message of store.session_message[sessionID] ?? []) messageIDs.add(message.id)
  for (const [messageID, parts] of Object.entries(store.part)) {
    if (messageIDs.has(messageID) || parts?.some((part) => part.sessionID === sessionID)) {
      bytes += roughValueBytes(parts, seen)
      for (const part of parts ?? []) bytes += roughValueBytes(store.part_text_accum_delta[part.id], seen)
    }
  }
  return bytes
}

export function dropSessionCaches(store: SessionCache, sessionIDs: Iterable<string>) {
  const stale = new Set(Array.from(sessionIDs).filter(Boolean))
  if (stale.size === 0) return

  // Fast path: evict only the parts owned by the sessions being dropped, keyed
  // via each session's own message list. Scanning every key in store.part here
  // would be O(all cached messages across every session visited this run),
  // which turned an occasional cache trim into a full-store sweep on every tab
  // sync once SESSION_CACHE_LIMIT was exceeded.
  //
  // Orphan path: a session whose message list is already gone cannot be walked,
  // so its parts and text accumulators would stay in the store for the life of
  // the process. Those sessions are collected here and resolved by a single
  // pass over store.part, which runs only when such a session is present — so
  // the common trim keeps its cheap message-walk.
  const orphan = new Set<string>()
  for (const sessionID of stale) {
    const messages = store.message[sessionID]
    if (!messages || messages.length === 0) {
      orphan.add(sessionID)
      continue
    }
    for (const message of messages) {
      const parts = store.part[message.id]
      if (!parts) continue
      for (const part of parts) {
        delete store.part_text_accum_delta[part.id]
      }
      delete store.part[message.id]
    }
  }

  if (orphan.size > 0) {
    // Object.entries snapshots the key list, so deleting during the loop is safe.
    for (const [messageID, parts] of Object.entries(store.part)) {
      if (!parts || parts.length === 0) continue
      // Parts carry their own sessionID, so ownership does not depend on the
      // message list still being present.
      const owner = parts.find((part) => !!part?.sessionID)?.sessionID
      if (!owner || !orphan.has(owner)) continue
      for (const part of parts) {
        delete store.part_text_accum_delta[part.id]
      }
      delete store.part[messageID]
    }
  }

  for (const sessionID of stale) {
    delete store.message[sessionID]
    delete store.todo[sessionID]
    delete store.session_message[sessionID]
    delete store.session_diff[sessionID]
    delete store.session_status[sessionID]
    delete store.permission[sessionID]
    delete store.question[sessionID]
  }
}

export function pickSessionCacheEvictions(input: {
  seen: Set<string>
  keep: string
  limit: number
  preserve?: Iterable<string>
  weights?: ReadonlyMap<string, number>
  maxBytes?: number
}) {
  const stale: string[] = []
  const keep = new Set([input.keep, ...Array.from(input.preserve ?? [])])
  if (input.seen.has(input.keep)) input.seen.delete(input.keep)
  input.seen.add(input.keep)
  let retainedBytes = 0
  if (input.weights && input.maxBytes !== undefined) {
    for (const id of input.seen) retainedBytes += input.weights.get(id) ?? 0
  }
  for (const id of input.seen) {
    const overCount = input.seen.size - stale.length > input.limit
    const overBytes = input.maxBytes !== undefined && retainedBytes > input.maxBytes
    if (!overCount && !overBytes) break
    if (keep.has(id)) continue
    stale.push(id)
    retainedBytes -= input.weights?.get(id) ?? 0
  }
  for (const id of stale) {
    input.seen.delete(id)
  }
  return stale
}
