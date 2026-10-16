export * as SessionRecall from "./recall"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../database/database"
import { ProjectV2 } from "../project"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionSearch } from "./search"
import { snippet } from "./search-text"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export interface RecallInput extends SessionSearch.SearchScopeInput {
  readonly query?: string
  readonly tool?: string
  readonly limit?: number
  /** recent is used by conversational recall surfaces; relevance preserves historical BM25 behavior. */
  readonly ranking?: SessionSearch.SearchRanking
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
  readonly v1ToolRecallReady: boolean
  readonly v2ToolRecallReady: boolean
  /** More exact sidecar rows matched than the requested presentation limit. */
  readonly toolResultsTruncated: boolean
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

type ToolProjectionRow = {
  readonly source: "v1_part" | "v2_message"
  readonly message_id: string
  readonly part_id: string
  readonly session_id: string
  readonly time_created: number
  readonly search_text: string
  readonly tool: string
  readonly session_title: string
  readonly directory: string
  readonly project_id: string
}

function normalizeLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

function searchToolProjection(
  db: DatabaseService,
  input: RecallInput & { readonly tool: string },
  limit: number,
): Effect.Effect<{ readonly matches: ToolMatch[]; readonly truncated: boolean }, SessionSearch.SearchError> {
  return Effect.gen(function* () {
    const query = input.query?.trim()
    const terms = SessionSearch.matchTerms(query ?? "")
    const scope = SessionSearch.scopeConditions(input)
    const scopeClause = scope.length > 0 ? sql`AND ${sql.join(scope, sql` AND `)}` : sql``

    let rows: ToolProjectionRow[]
    if (query) {
      // Exact identity is relational (`t.tool = ?`). FTS owns only bounded
      // input/lineage text so tool-name tokens cannot create false matches or
      // distort relevance.
      const match = SessionSearch.matchQuery(query)
      if (!match) return { matches: [], truncated: false }
      const order = input.ranking === "recent"
        ? sql`t.time_created DESC, t.id DESC`
        : sql`rank`
      rows = yield* db
        .all<ToolProjectionRow>(sql`
          SELECT
            t.source,
            t.message_id,
            t.part_id,
            t.session_id,
            t.time_created,
            t.search_text,
            t.tool,
            s.title AS session_title,
            s.directory,
            s.project_id
          -- Query+tool must be text-selectivity-first. Without CROSS JOIN,
          -- SQLite may drive from (tool,time_created,id) to satisfy the recent
          -- ORDER BY and probe FTS once per tool call, which is pathological
          -- for rare terms. FTS narrows rowids first; the base-table rowid
          -- lookup then proves exact tool identity before the small result set
          -- is ranked by time or BM25.
          FROM session_tool_recall_fts
          CROSS JOIN session_tool_recall t NOT INDEXED
            ON t.id = session_tool_recall_fts.rowid
          JOIN ${SessionTable} s ON s.id = t.session_id
          WHERE session_tool_recall_fts MATCH ${match}
            AND t.tool = ${input.tool}
            ${scopeClause}
          ORDER BY ${order}
          LIMIT ${limit + 1}
        `)
        .pipe(
          Effect.mapError(
            () => new SessionSearch.SearchError({ message: "Exact tool-call projection search could not be executed" }),
          ),
        )
    } else {
      // Exact tool-only recall has two materially different access patterns.
      // Directory/workspace/parent scopes have selective Session indexes, so
      // drive from Session and probe the compact sidecar by Session + tool.
      // Project-only/global/prefix scopes can be broad; there the tool-time
      // index can stop immediately after the requested newest rows.
      const sessionFirst = Boolean(input.directory || input.workspaceID || input.parentID)
      const statement = sessionFirst
        ? sql`
            SELECT
              t.source,
              t.message_id,
              t.part_id,
              t.session_id,
              t.time_created,
              t.search_text,
              t.tool,
              s.title AS session_title,
              s.directory,
              s.project_id
            FROM ${SessionTable} s
            CROSS JOIN session_tool_recall t INDEXED BY session_tool_recall_session_tool_time_idx
            WHERE t.session_id = s.id
              AND t.tool = ${input.tool}
              ${scopeClause}
            ORDER BY t.time_created DESC, t.id DESC
            LIMIT ${limit + 1}
          `
        : sql`
            SELECT
              t.source,
              t.message_id,
              t.part_id,
              t.session_id,
              t.time_created,
              t.search_text,
              t.tool,
              s.title AS session_title,
              s.directory,
              s.project_id
            FROM session_tool_recall t INDEXED BY session_tool_recall_tool_time_idx
            JOIN ${SessionTable} s ON s.id = t.session_id
            WHERE t.tool = ${input.tool}
              ${scopeClause}
            ORDER BY t.time_created DESC, t.id DESC
            LIMIT ${limit + 1}
          `
      rows = yield* db.all<ToolProjectionRow>(statement).pipe(
        Effect.mapError(
          () => new SessionSearch.SearchError({ message: "Exact tool-call projection search could not be executed" }),
        ),
      )
    }

    return {
      matches: rows.slice(0, limit).map((row) => ({
        source: row.source,
        sessionID: SessionSchema.ID.make(row.session_id),
        messageID: row.message_id,
        partID: row.part_id,
        sessionTitle: row.session_title,
        directory: row.directory,
        projectID: ProjectV2.ID.make(row.project_id),
        time: { created: row.time_created },
        tool: row.tool,
        snippet: snippet(row.search_text, terms),
        matchedTerms: terms,
      })),
      truncated: rows.length > limit,
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
      ranking: input.ranking,
    }
    const broad = query
      ? yield* SessionSearch.search(db, { ...shared, query })
      : { titleMatches: [], messageMatches: [], partMatches: [] }

    const indexCoverage = yield* SessionSearch.indexCoverage(db)
    // Ordinary recall is projection-only. Historical message/part decoding is
    // owned by explicit bounded repair/backfill, never by this Tier 0/1 read.
    // While a backfill cursor is incomplete, return the producer-projected and
    // already-repaired subset and surface incomplete coverage instead of
    // silently hydrating history on the caller's latency path.
    const toolResult = tool
      ? yield* searchToolProjection(db, { ...input, tool }, limit)
      : { matches: [] as ToolMatch[], truncated: false }

    // The original V2 content backfill cursor does not certify the CURRENT
    // extractor. Version 2 added searchable structural tool-name markers;
    // returning complete=true while that replay is outstanding is false
    // confidence for ordinary text searches over historical tool work.
    const complete =
      (!query || (indexCoverage.v1PartIndexReady &&
        indexCoverage.v2MessageIndexReady && indexCoverage.v2ToolIndexReady)) &&
      (!tool || (indexCoverage.v1ToolRecallReady && indexCoverage.v2ToolRecallReady))

    return {
      titleMatches: broad.titleMatches,
      messageMatches: broad.messageMatches,
      partMatches: broad.partMatches,
      toolMatches: toolResult.matches,
      coverage: {
        ...indexCoverage,
        toolResultsTruncated: toolResult.truncated,
        complete,
      },
    }
  })
}
