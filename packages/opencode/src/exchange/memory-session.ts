export * as ExchangeMemorySession from "./memory-session"

import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRecall } from "@opencode-ai/core/session/recall"
import { SessionSearch } from "@opencode-ai/core/session/search"

/** This is a routing projection of historical evidence, not a Memory.Entry. */
export interface Hit {
  readonly source: "conversation" | "title"
  readonly sessionId: string
  readonly messageId?: string
  readonly title: string
  readonly snippet: string
  readonly occurredAt: number
  readonly occurredAtIso: string
  readonly timeBasis: "message_created" | "session_record_updated"
}

export interface Result {
  readonly hits: readonly Hit[]
  readonly complete: boolean
  readonly truncated: boolean
  readonly ranking: "recent" | "relevance"
  /** Explicit projection-completeness evidence, not a request to repair on read. */
  readonly indexCoverage?: {
    readonly v1PartIndexReady: boolean
    readonly v2MessageIndexReady: boolean
    readonly v2ToolIndexReady: boolean
    readonly v1ToolRecallReady: boolean
    readonly v2ToolRecallReady: boolean
  }
}

type DatabaseService = Database.Interface["db"]

/**
 * Bounded diversity: return independent Session sources before additional
 * messages from the same transcript, then restore original ranking order.
 * This is source diversity, not semantic reranking or invented provenance.
 */
export function selectDiverse(hits: readonly Hit[], limit: number): Hit[] {
  const messageSessions = new Set(hits.filter((hit) => hit.source === "conversation").map((hit) => hit.sessionId))
  const candidates = hits.filter((hit) => hit.source !== "title" || !messageSessions.has(hit.sessionId))
  const chosen = new Set<number>()
  const sessions = new Set<string>()
  for (let i = 0; i < candidates.length && chosen.size < limit; i++) {
    const hit = candidates[i]!
    if (sessions.has(hit.sessionId)) continue
    sessions.add(hit.sessionId)
    chosen.add(i)
  }
  for (let i = 0; i < candidates.length && chosen.size < limit; i++) chosen.add(i)
  return [...chosen].sort((a, b) => a - b).map((i) => candidates[i]!)
}

/** No unscoped default: callers MUST establish the authorized location first. */
export type Scope =
  | { readonly project: string; readonly directoryPrefixes?: never }
  | { readonly directoryPrefixes: readonly string[]; readonly project?: never }

export function search(
  db: DatabaseService,
  input: Scope & { readonly query: string; readonly limit: number; readonly ranking?: "recent" | "relevance" },
): Effect.Effect<Result, SessionSearch.SearchError> {
  return Effect.gen(function* () {
    const limit = Math.max(1, Math.min(10, Math.floor(input.limit)))
    // Allow alternative Sessions into the candidate set without an unbounded
    // history scan. This is a deliberate bounded throughput/fidelity tradeoff.
    const candidateLimit = Math.min(20, Math.max(limit, limit * 3))
    const ranking = input.ranking ?? "recent"
    const result = yield* SessionRecall.recall(db, {
      query: input.query,
      ranking,
      limit: candidateLimit,
      includeArchived: false,
      ...(input.project !== undefined ? { project: input.project } : { directoryPrefixes: input.directoryPrefixes }),
    })
    const seen = new Set<string>()
    const hits: Hit[] = []
    for (const match of result.messageMatches) {
      const messageId = String(match.messageID)
      if (seen.has(messageId)) continue
      seen.add(messageId)
      hits.push({
        source: "conversation",
        sessionId: String(match.sessionID),
        messageId,
        title: match.sessionTitle.slice(0, 180),
        snippet: match.snippet.slice(0, 160),
        occurredAt: match.time.created,
        occurredAtIso: new Date(match.time.created).toISOString(),
        timeBasis: "message_created",
      })
    }
    for (const match of result.titleMatches) {
      hits.push({
        source: "title",
        sessionId: String(match.id),
        title: match.title.slice(0, 180),
        snippet: match.title.slice(0, 160),
        occurredAt: DateTime.toEpochMillis(match.time.updated),
        occurredAtIso: new Date(DateTime.toEpochMillis(match.time.updated)).toISOString(),
        timeBasis: "session_record_updated",
      })
    }
    if (ranking === "recent") hits.sort((a, b) => {
      if (a.source !== b.source) return a.source === "conversation" ? -1 : 1
      return b.occurredAt - a.occurredAt || a.sessionId.localeCompare(b.sessionId)
    })
    const selected = selectDiverse(hits, limit)
    return {
      hits: selected,
      ranking,
      complete: result.coverage.complete,
      indexCoverage: {
        v1PartIndexReady: result.coverage.v1PartIndexReady,
        v2MessageIndexReady: result.coverage.v2MessageIndexReady,
        v2ToolIndexReady: result.coverage.v2ToolIndexReady,
        v1ToolRecallReady: result.coverage.v1ToolRecallReady,
        v2ToolRecallReady: result.coverage.v2ToolRecallReady,
      },
      truncated: hits.length > selected.length ||
        result.messageMatches.length >= candidateLimit ||
        result.titleMatches.length >= candidateLimit ||
        result.partMatches.length >= candidateLimit,
    }
  })
}