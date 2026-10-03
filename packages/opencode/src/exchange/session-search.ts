export * as ExchangeSessionSearch from "./session-search"

import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRecall } from "@opencode-ai/core/session/recall"
import { SessionSearch } from "@opencode-ai/core/session/search"
import { ExchangeError } from "./error"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export interface Input extends SessionRecall.RecallInput {
  /** Presentation-only label such as current/project/global or an OFXP root ref. */
  readonly scopeLabel?: string
  /** Explicitly repair one bounded historical-index chunk before searching. */
  readonly repairIndex?: boolean
}

export interface Hooks<E = never> {
  /** Revalidate caller authority after the read and before egress. */
  readonly revalidate?: () => Effect.Effect<unknown, E>
  /** Optional bounded historical-index repair owned by the caller/runtime. */
  readonly repairIndex?: () => Effect.Effect<SessionSearch.RepairProgress, E>
  /** Project a native durable directory into the caller's safe namespace. */
  readonly projectDirectory?: (directory: string) => string
}

export interface Metadata {
  readonly count: number
  readonly titleHits: number
  readonly contentHits: number
  readonly partHits: number
  readonly toolHits: number
  readonly truncated: boolean
  readonly complete: boolean
  readonly repairTimedOut?: boolean
  readonly repairedRows?: number
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly structured: Readonly<Record<string, unknown>>
  readonly metadata: Metadata
  readonly mutation: { readonly attempted: false; readonly committed: false }
}

type DatabaseService = Database.Interface["db"]

function normalizedLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

export function execute<E>(
  db: DatabaseService,
  input: Input,
  hooks: Hooks<E> = {},
): Effect.Effect<Result, ExchangeError.Error | E> {
  return Effect.gen(function* () {
    const query = input.query?.trim()
    const tool = input.tool?.trim()
    if (!query && !tool) {
      return yield* new ExchangeError.InvalidArgument({ detail: "Session search requires query or tool" })
    }
    if (tool && tool.length > 128) {
      return yield* new ExchangeError.InvalidArgument({ detail: "Session search tool name must be at most 128 characters" })
    }

    let repair: SessionSearch.RepairProgress | undefined
    if (input.repairIndex === true) {
      if (!hooks.repairIndex) {
        return yield* new ExchangeError.DependencyUnavailable({
          detail: "Session search index repair is unavailable on this surface",
        })
      }
      repair = yield* hooks.repairIndex()
    }

    const result = yield* SessionRecall.recall(db, {
      ...input,
      ...(query ? { query } : { query: undefined }),
      ...(tool ? { tool } : { tool: undefined }),
    }).pipe(
      Effect.mapError((error) => new ExchangeError.DependencyUnavailable({ detail: error.message })),
    )

    if (hooks.revalidate) yield* hooks.revalidate().pipe(Effect.asVoid)

    const projectDirectory = (directory: string) =>
      Effect.try({
        try: () => hooks.projectDirectory?.(directory) ?? directory,
        catch: () => new ExchangeError.PathEscape({ detail: "Session search result escaped the authorized directory projection" }),
      })

    const titles = yield* Effect.forEach(result.titleMatches, (session) =>
      projectDirectory(String(session.location.directory)).pipe(
        Effect.map((directory) => ({
          sessionId: String(session.id),
          title: session.title,
          projectID: String(session.projectID),
          directory,
          ...(session.location.workspaceID ? { workspaceID: String(session.location.workspaceID) } : {}),
          ...(session.parentID ? { parentId: String(session.parentID) } : {}),
          createdAt: DateTime.toEpochMillis(session.time.created),
          updatedAt: DateTime.toEpochMillis(session.time.updated),
          archived: session.time.archived !== undefined,
        })),
      ),
    )

    const content = yield* Effect.forEach(result.messageMatches, (match) =>
      projectDirectory(match.directory).pipe(
        Effect.map((directory) => ({
          sessionId: String(match.sessionID),
          messageId: String(match.messageID),
          title: match.sessionTitle,
          projectID: String(match.projectID),
          directory,
          type: match.type,
          createdAt: match.time.created,
          snippet: match.snippet,
          matchedTerms: match.matchedTerms,
        })),
      ),
    )

    const parts = yield* Effect.forEach(result.partMatches, (match) =>
      projectDirectory(match.directory).pipe(
        Effect.map((directory) => ({
          sessionId: String(match.sessionID),
          messageId: String(match.messageID),
          partId: match.partID,
          partType: match.partType,
          title: match.sessionTitle,
          projectID: String(match.projectID),
          directory,
          role: match.role,
          createdAt: match.time.created,
          snippet: match.snippet,
          matchedTerms: match.matchedTerms,
        })),
      ),
    )

    const tools = yield* Effect.forEach(result.toolMatches, (match) =>
      projectDirectory(match.directory).pipe(
        Effect.map((directory) => ({
          sessionId: String(match.sessionID),
          messageId: String(match.messageID),
          ...(match.partID ? { partId: match.partID } : {}),
          title: match.sessionTitle,
          projectID: String(match.projectID),
          directory,
          tool: match.tool,
          source: match.source,
          createdAt: match.time.created,
          snippet: match.snippet,
          matchedTerms: match.matchedTerms,
        })),
      ),
    )

    const bySession = new Map<string, {
      sessionId: string
      title: string
      projectID: string
      directory: string
      matchedBy: Set<"title" | "content" | "part" | "tool">
      snippets: string[]
      latestAt: number
    }>()
    const add = (hit: {
      sessionId: string
      title: string
      projectID: string
      directory: string
      kind: "title" | "content" | "part" | "tool"
      snippet?: string
      at: number
    }) => {
      const existing = bySession.get(hit.sessionId)
      const row = existing ?? {
        sessionId: hit.sessionId,
        title: hit.title,
        projectID: hit.projectID,
        directory: hit.directory,
        matchedBy: new Set<"title" | "content" | "part" | "tool">(),
        snippets: [],
        latestAt: hit.at,
      }
      row.latestAt = Math.max(row.latestAt, hit.at)
      row.matchedBy.add(hit.kind)
      if (hit.snippet && row.snippets.length < 3 && !row.snippets.includes(hit.snippet)) row.snippets.push(hit.snippet)
      bySession.set(hit.sessionId, row)
    }
    for (const hit of titles) add({ ...hit, kind: "title", at: hit.updatedAt })
    for (const hit of content) add({ ...hit, kind: "content", snippet: hit.snippet, at: hit.createdAt })
    for (const hit of parts) add({ ...hit, kind: "part", snippet: hit.snippet, at: hit.createdAt })
    for (const hit of tools) add({ ...hit, kind: "tool", snippet: hit.snippet, at: hit.createdAt })

    const limit = normalizedLimit(input.limit)
    const sessions = [...bySession.values()]
      .sort((a, b) => {
        // Exact structural tool evidence is the strongest routing signal when
        // the caller explicitly requested a tool. Otherwise corroboration
        // across independent channels wins, followed by granular evidence and
        // recency. This is in-memory over O(limit * channels), never a DB pass.
        if (tool) {
          const toolDelta = Number(b.matchedBy.has("tool")) - Number(a.matchedBy.has("tool"))
          if (toolDelta !== 0) return toolDelta
        }
        const channelDelta = b.matchedBy.size - a.matchedBy.size
        if (channelDelta !== 0) return channelDelta
        const partDelta = Number(b.matchedBy.has("part")) - Number(a.matchedBy.has("part"))
        if (partDelta !== 0) return partDelta
        const titleDelta = Number(b.matchedBy.has("title")) - Number(a.matchedBy.has("title"))
        if (titleDelta !== 0) return titleDelta
        if (b.latestAt !== a.latestAt) return b.latestAt - a.latestAt
        return a.sessionId.localeCompare(b.sessionId)
      })
      .slice(0, limit)
      .map((row) => ({
      sessionId: row.sessionId,
      title: row.title,
      projectID: row.projectID,
      directory: row.directory,
      matchedBy: [...row.matchedBy],
      snippets: row.snippets,
    }))

    const truncated =
      titles.length >= limit ||
      content.length >= limit ||
      parts.length >= limit ||
      tools.length >= limit ||
      result.coverage.v1ToolCandidatesTruncated ||
      result.coverage.v2ToolCandidatesTruncated

    const structured = {
      ...(input.scopeLabel ? { scope: input.scopeLabel } : {}),
      ...(query ? { query } : {}),
      ...(tool ? { tool } : {}),
      coverage: result.coverage,
      ...(repair ? { repair } : {}),
      sessions,
      hits: { titles, content, parts, tools },
    }
    const metadata: Metadata = {
      count: sessions.length,
      titleHits: titles.length,
      contentHits: content.length,
      partHits: parts.length,
      toolHits: tools.length,
      truncated,
      complete: result.coverage.complete,
      ...(repair ? { repairTimedOut: repair.timedOut } : {}),
      ...(repair
        ? {
            repairedRows: repair.sessionMessages.processed + repair.parts.processed,
          }
        : {}),
    }
    return {
      title: "Search sessions",
      output: JSON.stringify(structured),
      structured,
      metadata,
      mutation: { attempted: false, committed: false },
    }
  })
}
