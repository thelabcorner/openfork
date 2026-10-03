export * as SessionRecall from "./recall"

import { Effect, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../database/database"
import { ProjectV2 } from "../project"
import { resolveProjectionRef } from "../event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { PartTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionSearch } from "./search"
import { assistantPartSearchText, partSearchText, snippet } from "./search-text"
import { SessionV1 } from "../v1/session"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_TOOL_CANDIDATES = 1_000
const TOOL_CANDIDATE_MULTIPLIER = 12

export interface RecallInput extends SessionSearch.SearchScopeInput {
  readonly query?: string
  readonly tool?: string
  readonly limit?: number
}

export interface ToolMatch {
  readonly source: "v1_part" | "v2_message"
  readonly sessionID: SessionSchema.ID
  readonly messageID: string
  readonly partID?: string
  readonly sessionTitle: string
  readonly directory: string
  readonly projectID: ProjectV2.ID
  readonly time: { readonly created: number }
  readonly tool: string
  readonly snippet: string
  readonly matchedTerms: readonly string[]
}

export interface Coverage {
  readonly v1PartIndexReady: boolean
  readonly v2MessageIndexReady: boolean
  /** Historical V2 rows have been reprojected with the current tool-name marker extractor. */
  readonly v2ToolIndexReady: boolean
  readonly v1ToolCandidatesTruncated: boolean
  readonly v2ToolCandidatesTruncated: boolean
  readonly complete: boolean
}

export interface RecallResult {
  readonly titleMatches: SessionSchema.Info[]
  readonly messageMatches: SessionSearch.SearchMessageMatch[]
  readonly partMatches: SessionSearch.SearchPartMatch[]
  readonly toolMatches: ToolMatch[]
  readonly coverage: Coverage
}

type DatabaseService = Database.Interface["db"]

type V1ToolRow = {
  readonly part_id: string
  readonly message_id: string
  readonly session_id: string
  readonly time_created: number
  readonly search_text: string
  readonly data: unknown
  readonly session_title: string
  readonly directory: string
  readonly project_id: string
}

type V2CandidateRow = {
  readonly id: string
  readonly session_id: string
  readonly time_created: number
  readonly search_text: string
  readonly data: unknown
  readonly session_title: string
  readonly directory: string
  readonly project_id: string
}

function normalizeLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

function parseRawJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function prefixTermsMatch(text: string, terms: readonly string[]) {
  if (terms.length === 0) return true
  const words = text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
  return terms.every((term) => {
    const needle = term.toLocaleLowerCase()
    return words.some((word) => word.startsWith(needle))
  })
}

const decodeMessage = Schema.decodeUnknownOption(SessionMessage.Message)
const decodePart = Schema.decodeUnknownOption(SessionV1.Part)

function toolMarkerMatch(tool: string, query?: string) {
  const markerTerms = SessionSearch.matchTerms(`tool ${tool}`)
  if (markerTerms.length === 0) return SessionSearch.matchQuery(query ?? tool)
  const marker = `"${markerTerms.join(" ")}"`
  const content = query?.trim() ? SessionSearch.matchQuery(query.trim()) : undefined
  return content ? `${marker} ${content}` : marker
}

function searchV1Tools(
  db: DatabaseService,
  input: RecallInput & { readonly tool: string },
  limit: number,
): Effect.Effect<{ readonly matches: ToolMatch[]; readonly truncated: boolean }, SessionSearch.SearchError> {
  return Effect.gen(function* () {
    const match = toolMarkerMatch(input.tool, input.query)
    if (!match) return { matches: [], truncated: false }
    const terms = SessionSearch.matchTerms(input.query?.trim() ?? "")
    const conditions = SessionSearch.scopeConditions(input)
    const candidateLimit = Math.min(
      MAX_TOOL_CANDIDATES,
      Math.max(64, limit * TOOL_CANDIDATE_MULTIPLIER),
    )
    const scopeClause = conditions.length > 0 ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``
    const rows = yield* db
      .all<V1ToolRow>(sql`
        SELECT
          p.id AS part_id,
          p.message_id,
          p.session_id,
          m.time_created,
          p.search_text,
          p.data,
          s.title AS session_title,
          s.directory,
          s.project_id
        FROM part_fts
        JOIN part p ON p.rowid = part_fts.rowid
        JOIN message m ON m.id = p.message_id
        JOIN session s ON s.id = p.session_id
        WHERE part_fts MATCH ${match}
          ${scopeClause}
        ORDER BY rank
        LIMIT ${candidateLimit + 1}
      `)
      .pipe(
        Effect.mapError(() => new SessionSearch.SearchError({ message: "Session tool-call search could not be executed" })),
      )

    const truncated = rows.length > candidateLimit
    const matches: ToolMatch[] = []
    for (const row of rows.slice(0, candidateLimit)) {
      const data = yield* resolveProjectionRef(db, row.session_id, "part.data", parseRawJson(row.data)).pipe(
        Effect.mapError(() => new SessionSearch.SearchError({ message: "Session tool-call search could not decode a part" })),
      )
      const decoded = decodePart({
        ...(typeof data === "object" && data !== null ? data : {}),
        id: row.part_id,
        messageID: row.message_id,
        sessionID: row.session_id,
      })
      if (Option.isNone(decoded) || decoded.value.type !== "tool" || decoded.value.tool !== input.tool) continue
      const searchable = partSearchText(decoded.value)
      if (!prefixTermsMatch(searchable, terms)) continue
      matches.push({
        source: "v1_part",
        sessionID: SessionSchema.ID.make(row.session_id),
        messageID: row.message_id,
        partID: row.part_id,
        sessionTitle: row.session_title,
        directory: row.directory,
        projectID: ProjectV2.ID.make(row.project_id),
        time: { created: row.time_created },
        tool: decoded.value.tool,
        snippet: snippet(searchable, terms),
        matchedTerms: terms,
      })
      if (matches.length >= limit) return { matches, truncated }
    }
    return { matches, truncated }
  })
}

function searchV2Tools(
  db: DatabaseService,
  input: RecallInput & { readonly tool: string },
  limit: number,
  projectionReady: boolean,
): Effect.Effect<
  { readonly matches: ToolMatch[]; readonly truncated: boolean; readonly exhaustive: boolean },
  SessionSearch.SearchError
> {
  return Effect.gen(function* () {
    const query = input.query?.trim()
    const terms = SessionSearch.matchTerms(query ?? "")
    const conditions = SessionSearch.scopeConditions(input)
    conditions.push(sql`m.type = 'assistant'`)
    const candidateLimit = Math.min(
      MAX_TOOL_CANDIDATES,
      Math.max(64, limit * TOOL_CANDIDATE_MULTIPLIER),
    )

    const decodeRows = (rows: readonly V2CandidateRow[], seen = new Set<string>()) =>
      Effect.gen(function* () {
        const matches: ToolMatch[] = []
        for (const row of rows) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          const data = yield* resolveProjectionRef(db, row.session_id, "session_message.data", parseRawJson(row.data)).pipe(
            Effect.mapError(() => new SessionSearch.SearchError({ message: "Session tool-call search could not decode a message" })),
          )
          const decoded = decodeMessage({ ...data, id: row.id, type: "assistant" })
          if (Option.isNone(decoded) || decoded.value.type !== "assistant") continue
          for (const part of decoded.value.content) {
            if (part.type !== "tool" || part.name !== input.tool) continue
            const searchable = assistantPartSearchText(part)
            if (!prefixTermsMatch(searchable, terms)) continue
            matches.push({
              source: "v2_message",
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: row.id,
              partID: part.id,
              sessionTitle: row.session_title,
              directory: row.directory,
              projectID: ProjectV2.ID.make(row.project_id),
              time: { created: row.time_created },
              tool: part.name,
              snippet: snippet(searchable, terms),
              matchedTerms: terms,
            })
            if (matches.length >= limit) return matches
          }
        }
        return matches
      })

    // Combined query+tool search uses the historical content projection as the
    // narrowing key, then verifies the exact tool structurally. This remains
    // complete for pre-marker V2 rows when the ordinary message index is ready.
    if (query) {
      const match = SessionSearch.matchQuery(query)
      if (!match) return { matches: [], truncated: false, exhaustive: true }
      const rows = yield* db
        .all<V2CandidateRow>(sql`
          SELECT
            m.id,
            m.session_id,
            m.time_created,
            m.search_text,
            m.data,
            s.title AS session_title,
            s.directory,
            s.project_id
          FROM session_message_fts
          JOIN session_message m ON m.rowid = session_message_fts.rowid
          JOIN session s ON s.id = m.session_id
          WHERE session_message_fts MATCH ${match}
            AND ${sql.join(conditions, sql` AND `)}
          ORDER BY rank
          LIMIT ${candidateLimit + 1}
        `)
        .pipe(
          Effect.mapError(() => new SessionSearch.SearchError({ message: "Session tool-call search could not be executed" })),
        )
      const truncated = rows.length > candidateLimit
      return {
        matches: yield* decodeRows(rows.slice(0, candidateLimit)),
        truncated,
        exhaustive: !truncated,
      }
    }

    // Tool-only search first uses the new bounded tool-name marker. That keeps
    // the common path on FTS and avoids decoding broad assistant history.
    const marker = toolMarkerMatch(input.tool)
    const fastRows = marker
      ? yield* db
          .all<V2CandidateRow>(sql`
            SELECT
              m.id,
              m.session_id,
              m.time_created,
              m.search_text,
              m.data,
              s.title AS session_title,
              s.directory,
              s.project_id
            FROM session_message_fts
            JOIN session_message m ON m.rowid = session_message_fts.rowid
            JOIN session s ON s.id = m.session_id
            WHERE session_message_fts MATCH ${marker}
              AND ${sql.join(conditions, sql` AND `)}
            ORDER BY rank
            LIMIT ${candidateLimit + 1}
          `)
          .pipe(
            Effect.mapError(() => new SessionSearch.SearchError({ message: "Session tool-call search could not be executed" })),
          )
      : []
    const seen = new Set<string>()
    const fastMatches = yield* decodeRows(fastRows.slice(0, candidateLimit), seen)
    const fastTruncated = fastRows.length > candidateLimit

    if (projectionReady) {
      // Once the current extractor-version cursor is complete, the marker FTS
      // is authoritative for historical V2 rows and the compatibility scan is
      // permanently removed from this hot path.
      return {
        matches: fastMatches.slice(0, limit),
        truncated: fastTruncated,
        exhaustive: !fastTruncated,
      }
    }

    if (fastMatches.length >= limit) {
      // Older V2 rows may predate the tool-name marker projection. We can return
      // the requested bounded result without a history scan, but cannot prove an
      // exhaustive negative/order across that historical tail yet.
      return { matches: fastMatches.slice(0, limit), truncated: true, exhaustive: false }
    }

    // Compatibility fallback for historical pre-marker rows. It is deliberately
    // bounded; saturation is surfaced as incomplete coverage rather than causing
    // an unbounded transcript/message scan on a Tier 0/1 recall request.
    const fallbackRows = yield* db
      .all<V2CandidateRow>(sql`
        SELECT
          m.id,
          m.session_id,
          m.time_created,
          m.search_text,
          m.data,
          s.title AS session_title,
          s.directory,
          s.project_id
        FROM session_message m
        JOIN session s ON s.id = m.session_id
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY m.time_created DESC, m.id DESC
        LIMIT ${candidateLimit + 1}
      `)
      .pipe(
        Effect.mapError(() => new SessionSearch.SearchError({ message: "Session tool-call search could not be executed" })),
      )
    const fallbackMatches = yield* decodeRows(fallbackRows.slice(0, candidateLimit), seen)
    const matches = [...fastMatches, ...fallbackMatches]
      .sort((a, b) => b.time.created - a.time.created)
      .slice(0, limit)
    const fallbackTruncated = fallbackRows.length > candidateLimit
    return {
      matches,
      truncated: fastTruncated || fallbackTruncated,
      exhaustive: !fallbackTruncated,
    }
  })
}

export function recall(
  db: DatabaseService,
  input: RecallInput,
): Effect.Effect<RecallResult, SessionSearch.SearchError> {
  return Effect.gen(function* () {
    const query = input.query?.trim()
    const tool = input.tool?.trim()
    if (!query && !tool) {
      return yield* new SessionSearch.SearchError({ message: "Session recall requires query or tool" })
    }
    if (tool && tool.length > 128) {
      return yield* new SessionSearch.SearchError({ message: "Tool name is too long" })
    }

    const limit = normalizeLimit(input.limit)
    const shared = {
      directory: input.directory,
      directoryPrefixes: input.directoryPrefixes,
      workspaceID: input.workspaceID,
      project: input.project,
      parentID: input.parentID,
      roots: input.roots,
      includeArchived: input.includeArchived,
      limit,
    }
    const broad = query
      ? yield* SessionSearch.search(db, { ...shared, query })
      : { titleMatches: [], messageMatches: [], partMatches: [] }

    const indexCoverage = yield* SessionSearch.indexCoverage(db)
    const v1Tool = tool
      ? yield* searchV1Tools(db, { ...input, tool }, limit)
      : { matches: [] as ToolMatch[], truncated: false }
    const v2Tool = tool
      ? yield* searchV2Tools(db, { ...input, tool }, limit, indexCoverage.v2ToolIndexReady)
      : { matches: [] as ToolMatch[], truncated: false, exhaustive: true }

    const seen = new Set<string>()
    const toolMatches = [...v1Tool.matches, ...v2Tool.matches]
      .filter((match) => {
        const key = `${match.messageID}\u0000${match.partID ?? ""}\u0000${match.tool}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => b.time.created - a.time.created)
      .slice(0, limit)

    const complete =
      (!query || (indexCoverage.v1PartIndexReady && indexCoverage.v2MessageIndexReady)) &&
      (!tool || (indexCoverage.v1PartIndexReady && !v1Tool.truncated && v2Tool.exhaustive))

    return {
      titleMatches: broad.titleMatches,
      messageMatches: broad.messageMatches,
      partMatches: broad.partMatches,
      toolMatches,
      coverage: {
        ...indexCoverage,
        v1ToolCandidatesTruncated: v1Tool.truncated,
        v2ToolCandidatesTruncated: v2Tool.truncated,
        complete,
      },
    }
  })
}
