export * as SessionSearch from "./search"

import { eq, inArray, sql, type SQL } from "drizzle-orm"
import { Cause, Effect, Option, Schedule, Schema } from "effect"
import { ProjectV2 } from "../project"
import { Database } from "../database/database"
import { resolveProjectionRef } from "../event"
import { fromRow } from "./info"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionV1 } from "../v1/session"
import {
  PartSearchBackfillTable,
  PartTable,
  SearchBackfillTable,
  SessionMessageTable,
  SessionTable,
  SessionToolRecallBackfillTable,
} from "./sql"
import { partSearchText, searchText, snippet } from "./search-text"
import { SessionToolRecall } from "./tool-recall"
import { SessionLegacyToolIndex } from "./legacy-tool-index"
import { legacyPartKind, legacyPartOpaque } from "./legacy-part-query"

export const DefaultSearchLimit = 50
export const MaxSearchLimit = 100
export type SearchRanking = "recent" | "relevance"
const MaxQueryTerms = 8
const MinTermLength = 2
const BackfillChunk = 1000
const AutomaticBackfillEnv = "OPENCODE_SEARCH_BACKFILL"
const BaseSearchBackfillID = 1
/** Bump only when the persisted V2 search_text extractor semantics change. */
export const CurrentSearchProjectionVersion = 2
// Bump whenever the persisted V1 part search projection changes. Version 2
// removes raw Code source/runtime input from part_fts and replaces it with a
// bounded identity/lineage projection.
const PartSearchBackfillID = 2

export interface SearchScopeInput {
  readonly directory?: string
  /** Root/prefix scopes are applied before FTS ranking. Primarily used by supervised Exchange adapters. */
  readonly directoryPrefixes?: readonly string[]
  readonly workspaceID?: string
  readonly project?: string
  readonly parentID?: SessionSchema.ID
  readonly roots?: boolean
  /** Existing API callers leave this undefined to preserve historical behavior. */
  readonly includeArchived?: boolean
}

export interface SearchInput extends SearchScopeInput {
  readonly query: string
  readonly limit?: number
  /** relevance preserves BM25 ordering; recent orders matching durable evidence newest-first. */
  readonly ranking?: SearchRanking
}

export interface SearchMessageMatch {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly sessionTitle: string
  readonly directory: string
  readonly projectID: ProjectV2.ID
  readonly time: { readonly created: number }
  readonly type: SessionMessage.Type
  readonly snippet: string
  readonly matchedTerms: string[]
}

export interface SearchPartMatch {
  readonly sessionID: SessionSchema.ID
  readonly messageID: string
  readonly partID: string
  readonly partType: string
  readonly sessionTitle: string
  readonly directory: string
  readonly projectID: ProjectV2.ID
  readonly time: { readonly created: number }
  readonly role: string
  readonly snippet: string
  readonly matchedTerms: string[]
}

export interface SearchResult {
  readonly titleMatches: SessionSchema.Info[]
  readonly messageMatches: SearchMessageMatch[]
  /** Ranked V1 part-level hits from the same FTS query; no additional scan. */
  readonly partMatches: SearchPartMatch[]
}

// Raised when the FTS query fails to execute. User-supplied query text must
// never surface as an unhandled defect: the handler maps this to a 400.
export class SearchError extends Schema.TaggedErrorClass<SearchError>()("Session.SearchError", {
  message: Schema.String,
}) {}

export function automaticBackfillEnabled() {
  return ["1", "true"].includes(process.env[AutomaticBackfillEnv]?.toLowerCase() ?? "")
}

type Database = Database.Interface["db"]
type MessageRow = {
  readonly id: string
  readonly session_id: string
  readonly type: string
  readonly time_created: number
  readonly search_text: string
  readonly session_title: string
  readonly directory: string
  readonly project_id: string
}
type PartRow = {
  readonly part_id: string
  readonly part_type: string | null
  readonly message_id: string
  readonly session_id: string
  readonly role: string | null
  readonly time_created: number
  readonly search_text: string
  readonly session_title: string
  readonly directory: string
  readonly project_id: string
}

const normalizeDirectory = (directory: string) =>
  process.platform === "win32" ? directory.replaceAll("\\", "/") : directory

function normalizePrefix(directory: string) {
  const normalized = normalizeDirectory(directory)
  if (normalized === "/") return normalized
  return normalized.replace(/\/+$/, "")
}

export function scopeConditions(input: SearchScopeInput): SQL[] {
  const scope: SQL[] = []
  if (input.directory) scope.push(sql`s.directory = ${normalizeDirectory(input.directory)}`)
  if (input.directoryPrefixes !== undefined) {
    const prefixes = [...new Set(input.directoryPrefixes.map(normalizePrefix))]
    if (prefixes.length === 0) {
      scope.push(sql`0`)
    } else {
      const roots = prefixes.map((prefix) => {
        if (prefix === "/") return sql`substr(s.directory, 1, 1) = '/'`
        const childPrefix = `${prefix}/`
        return process.platform === "win32"
          ? sql`(lower(s.directory) = lower(${prefix}) OR lower(substr(s.directory, 1, ${childPrefix.length})) = lower(${childPrefix}))`
          : sql`(s.directory = ${prefix} OR substr(s.directory, 1, ${childPrefix.length}) = ${childPrefix})`
      })
      scope.push(sql`(${sql.join(roots, sql` OR `)})`)
    }
  }
  if (input.workspaceID) scope.push(sql`s.workspace_id = ${input.workspaceID}`)
  if (input.project) scope.push(sql`s.project_id = ${input.project}`)
  if (input.parentID) scope.push(sql`s.parent_id = ${input.parentID}`)
  if (input.roots) scope.push(sql`s.parent_id IS NULL`)
  if (input.includeArchived === false) scope.push(sql`s.time_archived IS NULL`)
  return scope
}

// Tokenize user input into FTS-safe terms. Everything outside unicode
// letters/digits/underscore is a separator, so no FTS5 query syntax (quotes,
// % ; * ^ : ( ) { } ~ - AND/OR/NOT) can ever survive into the MATCH
// expression; terms shorter than MinTermLength are dropped.
const tokenizeTerms = (query: string): string[] => {
  const terms = new Set<string>()
  for (const raw of query.split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length >= MinTermLength) terms.add(raw)
    if (terms.size >= MaxQueryTerms) break
  }
  return [...terms]
}

// FTS5 operator keywords would be parsed as operators if emitted bare.
const operatorKeyword = (term: string) => /^(and|or|not|near)$/i.test(term)

// Distinct query terms used for both prefix matching and client-side
// highlighting (mirrors matchQuery tokenization).
export function matchTerms(query: string): string[] {
  return tokenizeTerms(query)
}

// Build an FTS5 MATCH expression: one bare prefix term (`tok*`) per query
// term, joined with an implicit AND. Operator keywords are quoted so they
// cannot be parsed as operators. Returns undefined when no term qualifies
// (e.g. an all-symbol query), which disables content matching.
export function matchQuery(query: string): string | undefined {
  const terms = tokenizeTerms(query)
  if (terms.length === 0) return undefined
  return terms.map((term) => (operatorKeyword(term) ? `"${term}"` : `${term}*`)).join(" ")
}

export function search(db: Database, input: SearchInput): Effect.Effect<SearchResult, SearchError> {
  return Effect.gen(function* () {
    const startedAt = Date.now()
    // SQLite interprets LIMIT -1 as *unbounded*. Reject that accidental
    // escape hatch before constructing the FTS and title queries; the public
    // bounded Session recall invariant must hold for every caller.
    const rawLimit = input.limit ?? DefaultSearchLimit
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(MaxSearchLimit, Math.trunc(rawLimit)))
      : DefaultSearchLimit
    const ranking = input.ranking ?? "relevance"
    const scope = scopeConditions(input)
    const scopeClause = scope.length > 0 ? sql` AND ${sql.join(scope, sql` AND `)}` : sql``
    // A user searches for literal title text. Unescaped LIKE '%' and '_'
    // previously matched arbitrary titles, inflating recall with false hits.
    // ESCAPE '!' preserves SQLite's case-insensitive LIKE semantics while
    // treating %, _, and ! in the input as literal characters.
    const titlePattern = `%${input.query.replace(/[!%_]/g, "!$&")}%`

    const titleStartedAt = Date.now()
    const titleRows = yield* db
      .all<typeof SessionTable.$inferSelect>(sql`
        SELECT s.*
        FROM session s
        WHERE s.title LIKE ${titlePattern} ESCAPE '!'${scopeClause}
        ORDER BY s.time_created DESC, s.id DESC
        LIMIT ${limit}
      `)
      .pipe(
        Effect.mapError(
          () => new SearchError({ message: "Search query could not be executed" }),
        ),
      )
    const titleMs = Date.now() - titleStartedAt

    const terms = matchTerms(input.query)
    const match = matchQuery(input.query)
    // Rank in the FTS layer first (narrow rowid+score rows), then join only
    // the top-N. Scope filters are applied BEFORE ranking by intersecting the
    // FTS matches with the scoped session_message rowids, so the rank sort
    // stays bounded by the scoped set. Without scope the rank sort runs over
    // all matches but never touches the wide message rows.
    const ranked = ranking === "recent"
      ? scope.length > 0
        ? sql`
            SELECT session_message_fts.rowid, 0 AS score
            FROM session_message_fts
            JOIN session_message m ON m.rowid = session_message_fts.rowid
            JOIN session s ON s.id = m.session_id
            WHERE session_message_fts MATCH ${match}
              AND ${sql.join(scope, sql` AND `)}
            ORDER BY m.time_created DESC, m.id DESC
            LIMIT ${limit}`
        : sql`
            SELECT session_message_fts.rowid, 0 AS score
            FROM session_message_fts
            JOIN session_message m ON m.rowid = session_message_fts.rowid
            WHERE session_message_fts MATCH ${match}
            ORDER BY m.time_created DESC, m.id DESC
            LIMIT ${limit}`
      : scope.length > 0
        ? sql`
            SELECT session_message_fts.rowid, rank AS score
            FROM session_message_fts
            JOIN (
              SELECT m.rowid
              FROM session s
              JOIN session_message m ON m.session_id = s.id
              WHERE ${sql.join(scope, sql` AND `)}
            ) scoped ON scoped.rowid = session_message_fts.rowid
            WHERE session_message_fts MATCH ${match}
            ORDER BY rank
            LIMIT ${limit}`
        : sql`
            SELECT rowid, rank AS score
            FROM session_message_fts
            WHERE session_message_fts MATCH ${match}
            ORDER BY rank
            LIMIT ${limit}`
    const messageOrder = ranking === "recent"
      ? sql`m.time_created DESC, m.id DESC`
      : sql`f.score`
    const messageStartedAt = Date.now()
    const messageRows = match
      ? yield* db
          .all<MessageRow>(sql`
            SELECT
              m.id,
              m.session_id,
              m.type,
              m.time_created,
              m.search_text,
              s.title AS session_title,
              s.directory,
              s.project_id
            FROM (${ranked}) f
            JOIN session_message m ON m.rowid = f.rowid
            JOIN session s ON s.id = m.session_id
            ORDER BY ${messageOrder}
          `)
          .pipe(
            Effect.mapError(
              () => new SearchError({ message: "Search query could not be executed" }),
            ),
          )
      : []
    const messageMs = Date.now() - messageStartedAt

    // V1 conversation content lives in the part table (message.data holds only
    // role and metadata). The same tokenized prefix MATCH runs over part_fts;
    // matches are projected to their parent message and session, exactly like
    // the V2 path, so the response shape is identical across stores.
    // On large V1 stores, an ordinary JOIN lets SQLite start with the global
    // FTS index and apply the session scope only after enumerating matches.
    // For selective scopes, drive from the scoped part rowids and probe FTS by
    // rowid. Prefix scopes can contain several roots; only use this plan for a
    // small root set so broad authorization scopes keep the global FTS plan.
    const selectivePartScope = Boolean(
      input.directory || input.workspaceID || input.project || input.parentID,
    ) || (input.directoryPrefixes !== undefined && input.directoryPrefixes.length > 0 && input.directoryPrefixes.length <= 8)
    const rankedParts = ranking === "recent"
      ? sql`
          SELECT part_fts.rowid, 0 AS score
          FROM part_fts
          JOIN part p ON p.rowid = part_fts.rowid
          JOIN message m ON m.id = p.message_id
          JOIN session s ON s.id = p.session_id
          WHERE part_fts MATCH ${match}
            ${scope.length > 0 ? sql`AND ${sql.join(scope, sql` AND `)}` : sql``}
          ORDER BY m.time_created DESC, p.id DESC
          LIMIT ${limit}`
      : selectivePartScope
        ? sql`
            SELECT part_fts.rowid, rank AS score
            FROM part_fts
            CROSS JOIN part p ON p.rowid = part_fts.rowid
            JOIN session s ON s.id = p.session_id
            WHERE part_fts MATCH ${match}
              AND ${sql.join(scope, sql` AND `)}
            ORDER BY rank
            LIMIT ${limit}`
        : scope.length > 0
        ? sql`
            SELECT part_fts.rowid, rank AS score
            FROM part_fts
            JOIN (
              SELECT p.rowid
              FROM session s
              JOIN part p ON p.session_id = s.id
              WHERE ${sql.join(scope, sql` AND `)}
            ) scoped ON scoped.rowid = part_fts.rowid
            WHERE part_fts MATCH ${match}
            ORDER BY rank
            LIMIT ${limit}`
        : sql`
            SELECT rowid, rank AS score
            FROM part_fts
            WHERE part_fts MATCH ${match}
            ORDER BY rank
            LIMIT ${limit}`
    const partOrder = ranking === "recent"
      ? sql`m.time_created DESC, p.id DESC`
      : sql`f.score`
    const partStartedAt = Date.now()
    const partRows = match
      ? yield* db
          .all<PartRow>(sql`
            SELECT
              p.id AS part_id,
              json_extract(p.data, '$.type') AS part_type,
              p.message_id,
              p.session_id,
              m.time_created,
              p.search_text,
              s.title AS session_title,
              s.directory,
              s.project_id,
              json_extract(m.data, '$.role') AS role
            FROM (${rankedParts}) f
            JOIN part p ON p.rowid = f.rowid
            JOIN message m ON m.id = p.message_id
            JOIN session s ON s.id = p.session_id
            ORDER BY ${partOrder}
          `)
          .pipe(
            Effect.mapError(
              () => new SearchError({ message: "Search query could not be executed" }),
            ),
          )
      : []
    const partMs = Date.now() - partStartedAt

    const result = {
      titleMatches: titleRows.map(decodeTitleRow),
      partMatches: partRows.map((row) => ({
        sessionID: SessionSchema.ID.make(row.session_id),
        messageID: row.message_id,
        partID: row.part_id,
        partType: row.part_type ?? "unknown",
        sessionTitle: row.session_title,
        directory: row.directory,
        projectID: ProjectV2.ID.make(row.project_id),
        time: { created: row.time_created },
        role: row.role ?? "unknown",
        snippet: snippet(row.search_text, terms),
        matchedTerms: terms,
      })),
      messageMatches: mergeMatches(
        messageRows.map((row) => ({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
          sessionTitle: row.session_title,
          directory: row.directory,
          projectID: ProjectV2.ID.make(row.project_id),
          time: { created: row.time_created },
          type: row.type as SessionMessage.Type,
          snippet: snippet(row.search_text, terms),
          matchedTerms: terms,
        })),
        partRows.map((row) => ({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.message_id),
          sessionTitle: row.session_title,
          directory: row.directory,
          projectID: ProjectV2.ID.make(row.project_id),
          time: { created: row.time_created },
          type: (row.role === "assistant" ? "assistant" : "user") as SessionMessage.Type,
          snippet: snippet(row.search_text, terms),
          matchedTerms: terms,
        })),
        limit,
        ranking,
      ),
    }
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= 1_000) {
      const backfill = yield* readBackfillState(db).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const partBackfill = yield* readPartBackfillState(db).pipe(Effect.catch(() => Effect.succeed(undefined)))
      yield* Effect.logInfo("session search core completed slowly", {
        elapsedMs,
        ranking,
        titleMs,
        messageMs,
        partMs,
        queryLength: input.query.length,
        limit,
        scoped: scope.length > 0,
        matchTerms: terms.length,
        titleRows: titleRows.length,
        messageRows: messageRows.length,
        partRows: partRows.length,
        mergedMessages: result.messageMatches.length,
        backfill,
        partBackfill,
      })
    }
    return result
  })
}

// FTS5 ranks each of the two indexes independently; a raw BM25 score is not
// calibrated across their different corpora. Previously the relevance merge
// simply concatenated every V2 result before every V1 result, silently
// burying legacy content. Reciprocal rank fusion balances the two ordered
// lists without requiring cross-index score normalization or extra queries.
// Duplicate message IDs gain agreement credit, not duplicate result slots.
export function mergeMatches(
  v2: SearchMessageMatch[],
  v1: SearchMessageMatch[],
  limit: number,
  ranking: SearchRanking,
): SearchMessageMatch[] {
  if (ranking === "recent") {
    const seen = new Set<string>()
    const result: SearchMessageMatch[] = []
    const ordered = [...v2, ...v1].sort((a, b) =>
      b.time.created - a.time.created || String(b.messageID).localeCompare(String(a.messageID)))
    for (const hit of ordered) {
      if (seen.has(hit.messageID)) continue
      seen.add(hit.messageID)
      result.push(hit)
      if (result.length >= limit) break
    }
    return result
  }
  const fused = new Map<string, {
    match: SearchMessageMatch
    score: number
    firstRank: number
  }>()
  for (const list of [v2, v1]) {
    // V1 can have multiple matching parts inside the *same* message. Those
    // are one source's repeated evidence, not independent confirmations.
    const seenInIndex = new Set<string>()
    let uniqueRank = 0
    for (let i = 0; i < list.length; i++) {
      const match = list[i]!
      const key = String(match.messageID)
      if (seenInIndex.has(key)) continue
      seenInIndex.add(key)
      const existing = fused.get(key)
      const score = 1 / (60 + ++uniqueRank)
      if (existing) {
        existing.score += score
        existing.firstRank = Math.min(existing.firstRank, uniqueRank)
      } else {
        fused.set(key, { match, score, firstRank: uniqueRank })
      }
    }
  }
  return [...fused.values()]
    .sort((a, b) =>
      b.score - a.score ||
      a.firstRank - b.firstRank ||
      b.match.time.created - a.match.time.created ||
      String(a.match.messageID).localeCompare(String(b.match.messageID)))
    .slice(0, limit)
    .map((item) => item.match)
}

// The title query runs through raw SQL (db.all), so JSON-typed columns arrive
// as strings, not parsed objects. fromRow expects the drizzle-decoded shape
// (model/revert as objects), so parse them back before mapping.
const decodeTitleRow = (row: typeof SessionTable.$inferSelect) => {
  const parseJson = <A>(value: string | null): A | null => {
    if (!value) return null
    try {
      return JSON.parse(value) as A
    } catch {
      return null
    }
  }
  return fromRow({
    ...row,
        model: parseJson<{ id: string; providerID: string; accountID?: string; variant?: string }>(
          row.model as string | null,
        ),
    revert: parseJson(row.revert as string | null),
  })
}

export interface IndexCoverage {
  readonly v1PartIndexReady: boolean
  readonly v2MessageIndexReady: boolean
  /** Current V2 extractor version (including structural tool-name markers) has been projected over history. */
  readonly v2ToolIndexReady: boolean
  /** Exact producer-owned tool-call sidecar covers all historical V1 parts. */
  readonly v1ToolRecallReady: boolean
  /** Exact producer-owned tool-call sidecar covers all historical V2 messages. */
  readonly v2ToolRecallReady: boolean
}

export function indexCoverage(db: Database): Effect.Effect<IndexCoverage, SearchError> {
  return Effect.all({
    v1: db
      .select({ done: PartSearchBackfillTable.done })
      .from(PartSearchBackfillTable)
      .where(eq(PartSearchBackfillTable.id, PartSearchBackfillID))
      .get(),
    v2: db
      .select({ done: SearchBackfillTable.done })
      .from(SearchBackfillTable)
      .where(eq(SearchBackfillTable.id, BaseSearchBackfillID))
      .get(),
    v2Current: db
      .select({ done: SearchBackfillTable.done })
      .from(SearchBackfillTable)
      .where(eq(SearchBackfillTable.id, CurrentSearchProjectionVersion))
      .get(),
    toolV1: db
      .select({ done: SessionToolRecallBackfillTable.done })
      .from(SessionToolRecallBackfillTable)
      .where(eq(SessionToolRecallBackfillTable.source, "v1_part"))
      .get(),
    toolV2: db
      .select({ done: SessionToolRecallBackfillTable.done })
      .from(SessionToolRecallBackfillTable)
      .where(eq(SessionToolRecallBackfillTable.source, "v2_message"))
      .get(),
  }).pipe(
    Effect.map(({ v1, v2, v2Current, toolV1, toolV2 }) => ({
      v1PartIndexReady: v1?.done === 1,
      v2MessageIndexReady: v2?.done === 1,
      v2ToolIndexReady: v2Current?.done === 1,
      v1ToolRecallReady: toolV1?.done === 1,
      v2ToolRecallReady: toolV2?.done === 1,
    })),
    Effect.mapError(() => new SearchError({ message: "Session search coverage could not be read" })),
  )
}

export interface RepairProgress {
  /** Rows reprojected with the current V2 search-text extractor version. */
  readonly sessionMessages: { readonly processed: number; readonly done: boolean }
  readonly parts: { readonly processed: number; readonly done: boolean }
  readonly toolRecallV1: { readonly processed: number; readonly projected: number; readonly done: boolean }
  readonly toolRecallV2: { readonly processed: number; readonly projected: number; readonly done: boolean }
  readonly timedOut: boolean
}

function normalizeRepairRows(input: number | undefined) {
  if (input === undefined || !Number.isFinite(input)) return 128
  return Math.max(1, Math.min(512, Math.floor(input)))
}

function repairMessageChunk(db: Database, maxRows: number) {
  return Effect.gen(function* () {
    // This cursor is versioned independently from the original content
    // backfill. A previously-complete v1 cursor cannot prove that rows were
    // reprojected after the extractor learned structural tool-name markers.
    const state = yield* retryOnLock(readCurrentProjectionState(db))
    if (state.done) return { processed: 0, done: true } as const
    const rows = yield* retryOnLock(
      db
        .select({
          id: SessionMessageTable.id,
          session_id: SessionMessageTable.session_id,
          type: SessionMessageTable.type,
          data: SessionMessageTable.data,
          rowid: sql<number>`rowid`,
        })
        .from(SessionMessageTable)
        .where(sql`rowid > ${state.watermark}`)
        .orderBy(sql`rowid`)
        .limit(maxRows)
        .all(),
    )
    if (rows.length === 0) {
      yield* retryOnLock(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(SearchBackfillTable)
              .set({ done: 1 })
              .where(eq(SearchBackfillTable.id, CurrentSearchProjectionVersion))
              .run()
            // A full pass under the current extractor is a strict superset of
            // the original V2 content backfill, so it also proves that cursor
            // complete without a second write-amplifying history pass.
            yield* tx
              .insert(SearchBackfillTable)
              .values({ id: BaseSearchBackfillID, watermark_rowid: state.watermark, done: 1 })
              .onConflictDoUpdate({
                target: SearchBackfillTable.id,
                set: { watermark_rowid: state.watermark, done: 1 },
              })
              .run()
          }),
        ),
      )
      return { processed: 0, done: true } as const
    }

    const decodeMessage = Schema.decodeUnknownOption(SessionMessage.Message)
    // Projection refs may require event_value reads/decompression. Resolve and
    // decode them before entering the write transaction so the transaction is
    // a short write-only batch and never recursively starts DB work.
    const updates: Array<{ readonly id: SessionMessage.ID; readonly searchText: string }> = []
    for (const row of rows) {
      const data = yield* resolveProjectionRef(db, row.session_id, "session_message.data", row.data)
      const message = decodeMessage({ ...data, id: row.id, type: row.type })
      if (Option.isSome(message)) {
        updates.push({ id: row.id, searchText: searchText(message.value) })
      }
    }
    const watermark = rows.at(-1)!.rowid
    const done = rows.length < maxRows
    yield* retryOnLock(
      db.transaction((tx) =>
        Effect.gen(function* () {
          for (const update of updates) {
            yield* tx
              .update(SessionMessageTable)
              .set({ search_text: update.searchText })
              .where(eq(SessionMessageTable.id, update.id))
              .run()
          }
          yield* tx
            .update(SearchBackfillTable)
            .set({ watermark_rowid: watermark, ...(done ? { done: 1 } : {}) })
            .where(eq(SearchBackfillTable.id, CurrentSearchProjectionVersion))
            .run()
          if (done) {
            yield* tx
              .insert(SearchBackfillTable)
              .values({ id: BaseSearchBackfillID, watermark_rowid: watermark, done: 1 })
              .onConflictDoUpdate({
                target: SearchBackfillTable.id,
                set: { watermark_rowid: watermark, done: 1 },
              })
              .run()
          }
        }),
      ),
    )
    return { processed: rows.length, done } as const
  })
}

function repairPartChunk(db: Database, maxRows: number) {
  return Effect.gen(function* () {
    const state = yield* retryOnLock(readPartBackfillState(db))
    if (state.done) return { processed: 0, done: true } as const
    const rows = yield* retryOnLock(
      db
        .select({
          id: PartTable.id,
          message_id: PartTable.message_id,
          session_id: PartTable.session_id,
          data: PartTable.data,
          rowid: sql<number>`rowid`,
        })
        .from(PartTable)
        .where(sql`rowid > ${state.watermark}`)
        .orderBy(sql`rowid`)
        .limit(maxRows)
        .all(),
    )
    if (rows.length === 0) {
      yield* retryOnLock(setPartBackfillDone(db))
      return { processed: 0, done: true } as const
    }

    const decodePart = Schema.decodeUnknownOption(SessionV1.Part)
    const updates: Array<{ readonly id: SessionV1.PartID; readonly searchText: string }> = []
    for (const row of rows) {
      const data = yield* resolveProjectionRef(db, row.session_id, "part.data", row.data)
      const part = decodePart({ ...data, id: row.id, sessionID: row.session_id, messageID: row.message_id })
      if (Option.isSome(part)) {
        updates.push({ id: row.id, searchText: partSearchText(part.value) })
      }
    }
    const watermark = rows.at(-1)!.rowid
    const done = rows.length < maxRows
    yield* retryOnLock(
      db.transaction((tx) =>
        Effect.gen(function* () {
          for (const update of updates) {
            yield* tx
              .update(PartTable)
              .set({ search_text: update.searchText })
              .where(eq(PartTable.id, update.id))
              .run()
          }
          yield* tx
            .update(PartSearchBackfillTable)
            .set({ watermark_rowid: watermark, ...(done ? { done: 1 } : {}) })
            .where(eq(PartSearchBackfillTable.id, PartSearchBackfillID))
            .run()
        }),
      ),
    )
    return { processed: rows.length, done } as const
  })
}

function repairToolRecallV1Chunk(db: Database, maxRows: number) {
  return Effect.gen(function* () {
    const source = "v1_part" as const
    const state = yield* retryOnLock(readToolRecallBackfillState(db, source))
    if (state.done) return { processed: 0, projected: 0, done: true } as const
    const rows = yield* retryOnLock(
      db
        .select({
          id: PartTable.id,
          message_id: PartTable.message_id,
          session_id: PartTable.session_id,
          time_created: PartTable.time_created,
          rowid: sql<number>`rowid`,
          part_type: legacyPartKind,
          cdb_ref: legacyPartOpaque,
        })
        .from(PartTable)
        // The cursor advances across physical rows, not only matching rows.
        // This keeps one explicit repair call O(maxRows) even when tools are
        // extremely sparse in a large historical part table.
        .where(sql`rowid > ${state.watermark}`)
        .orderBy(sql`rowid`)
        .limit(maxRows)
        .all(),
    )
    if (rows.length === 0) {
      yield* retryOnLock(setToolRecallBackfillDone(db, source))
      return { processed: 0, projected: 0, done: true } as const
    }

    const decodePart = Schema.decodeUnknownOption(SessionV1.Part)
    const projected: SessionToolRecall.Row[] = []
    const candidates = rows.filter((row) => row.part_type === "tool" || row.cdb_ref === 1)
    const payloads = candidates.length === 0
      ? []
      : yield* db
          .select({ id: PartTable.id, data: PartTable.data })
          .from(PartTable)
          .where(inArray(PartTable.id, candidates.map((row) => row.id)))
          .all()
          .pipe(Effect.orDie)
    const payloadByID = new Map(payloads.map((row) => [row.id, row.data] as const))
    for (const row of candidates) {
      const raw = payloadByID.get(row.id)
      if (raw === undefined) continue
      const data = yield* resolveProjectionRef(db, row.session_id, "part.data", raw)
      const part = decodePart({ ...data, id: row.id, sessionID: row.session_id, messageID: row.message_id })
      if (Option.isNone(part)) continue
      const next = SessionToolRecall.fromV1Part(part.value, row.time_created)
      if (next) projected.push(next)
    }

    const watermark = rows.at(-1)!.rowid
    const done = rows.length < maxRows
    yield* retryOnLock(
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* SessionToolRecall.insertHistoricalRowsIfAbsent(tx, projected)
          yield* tx
            .update(SessionToolRecallBackfillTable)
            .set({ watermark_rowid: watermark, ...(done ? { done: 1 } : {}) })
            .where(eq(SessionToolRecallBackfillTable.source, source))
            .run()
        }),
      ),
    )
    return { processed: rows.length, projected: projected.length, done } as const
  })
}

function repairToolRecallV2Chunk(db: Database, maxRows: number) {
  return Effect.gen(function* () {
    const source = "v2_message" as const
    const state = yield* retryOnLock(readToolRecallBackfillState(db, source))
    if (state.done) return { processed: 0, projected: 0, done: true } as const
    const rows = yield* retryOnLock(
      db
        .select({
          id: SessionMessageTable.id,
          session_id: SessionMessageTable.session_id,
          type: SessionMessageTable.type,
          rowid: sql<number>`rowid`,
        })
        .from(SessionMessageTable)
        // As with V1, bound progress by physical rows first. Filtering assistant
        // rows before LIMIT could turn a 128-row repair request into a scan of
        // an arbitrarily large user/system-heavy historical tail.
        .where(sql`rowid > ${state.watermark}`)
        .orderBy(sql`rowid`)
        .limit(maxRows)
        .all(),
    )
    if (rows.length === 0) {
      yield* retryOnLock(setToolRecallBackfillDone(db, source))
      return { processed: 0, projected: 0, done: true } as const
    }

    const decodeMessage = Schema.decodeUnknownOption(SessionMessage.Message)
    const projected: SessionToolRecall.Row[] = []
    const candidates = rows.filter((row) => row.type === "assistant")
    const payloads = candidates.length === 0
      ? []
      : yield* db
          .select({ id: SessionMessageTable.id, data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(inArray(SessionMessageTable.id, candidates.map((row) => row.id)))
          .all()
          .pipe(Effect.orDie)
    const payloadByID = new Map(payloads.map((row) => [row.id, row.data] as const))
    for (const row of candidates) {
      const raw = payloadByID.get(row.id)
      if (raw === undefined) continue
      const data = yield* resolveProjectionRef(db, row.session_id, "session_message.data", raw)
      const message = decodeMessage({ ...data, id: row.id, type: row.type })
      if (Option.isNone(message)) continue
      projected.push(...SessionToolRecall.fromV2Message(row.session_id, message.value))
    }

    const watermark = rows.at(-1)!.rowid
    const done = rows.length < maxRows
    yield* retryOnLock(
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* SessionToolRecall.insertHistoricalRowsIfAbsent(tx, projected)
          yield* tx
            .update(SessionToolRecallBackfillTable)
            .set({ watermark_rowid: watermark, ...(done ? { done: 1 } : {}) })
            .where(eq(SessionToolRecallBackfillTable.source, source))
            .run()
        }),
      ),
    )
    return { processed: rows.length, projected: projected.length, done } as const
  })
}

/**
 * Explicit bounded repair for interactive recall. This is intentionally not
 * automatic startup work: one call processes at most maxRows from each store.
 */
export function repairChunk(
  db: Database,
  input: { readonly maxRows?: number } = {},
): Effect.Effect<Omit<RepairProgress, "timedOut">, SearchError> {
  const maxRows = normalizeRepairRows(input.maxRows)
  return Effect.gen(function* () {
    const sessionMessages = yield* repairMessageChunk(db, maxRows)
    const parts = yield* repairPartChunk(db, maxRows)
    const toolRecallV1 = yield* repairToolRecallV1Chunk(db, maxRows)
    const toolRecallV2 = yield* repairToolRecallV2Chunk(db, maxRows)
    return { sessionMessages, parts, toolRecallV1, toolRecallV2 }
  }).pipe(
    Effect.mapError(() => new SearchError({ message: "Session search repair could not be completed" })),
  )
}

export function repairOnOwnConnection(
  filename: string,
  input: { readonly maxRows?: number; readonly timeoutMs?: number } = {},
): Effect.Effect<RepairProgress, unknown> {
  const timeoutMs = Math.max(100, Math.min(5_000, Math.floor(input.timeoutMs ?? 2_000)))
  return Database.withBackfillDb(
    filename,
    (db) => repairChunk(db, { maxRows: input.maxRows }),
    { busyTimeoutMs: 50 },
  ).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map((result) =>
      Option.isSome(result)
        ? { ...result.value, timedOut: false }
        : {
            sessionMessages: { processed: 0, done: false },
            parts: { processed: 0, done: false },
            toolRecallV1: { processed: 0, projected: 0, done: false },
            toolRecallV2: { processed: 0, projected: 0, done: false },
            timedOut: true,
          },
    ),
    Effect.mapError(() => new Error("Session search index repair is temporarily unavailable")),
  )
}

// --- resumable backfill -----------------------------------------------------

// Chunked, resumable maintenance backfill of search_text + FTS index for rows
// written before the search migration. Each chunk commits in its own
// transaction, advances a rowid high-watermark, and yields between chunks.
// The session_message FTS triggers index each updated row atomically.
// Re-running is a no-op once done. This is intentionally opt-in for app
// startup: even with a dedicated connection, writes still contend on the same
// SQLite file and consume process time.
export function backfill(db: Database): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* retryOnLock(readBackfillState(db))
    if (state.done) return
    const decodeMessage = Schema.decodeUnknownOption(SessionMessage.Message)
    let watermark = state.watermark
    for (;;) {
      const rows = yield* retryOnLock(
        db
          .select({
            id: SessionMessageTable.id,
            session_id: SessionMessageTable.session_id,
            type: SessionMessageTable.type,
            data: SessionMessageTable.data,
            rowid: sql<number>`rowid`,
          })
          .from(SessionMessageTable)
          .where(sql`rowid > ${watermark}`)
          .orderBy(sql`rowid`)
          .limit(BackfillChunk)
          .all(),
      )
      if (rows.length === 0) {
        yield* retryOnLock(setBackfillDone(db))
        return
      }
      const updates: Array<{ readonly id: SessionMessage.ID; readonly searchText: string }> = []
      for (const row of rows) {
        const data = yield* resolveProjectionRef(db, row.session_id, "session_message.data", row.data)
        const message = decodeMessage({ ...data, id: row.id, type: row.type })
        if (Option.isSome(message)) {
          updates.push({ id: row.id, searchText: searchText(message.value) })
        }
      }
      watermark = rows.at(-1)!.rowid
      yield* retryOnLock(
        db.transaction((tx) =>
          Effect.gen(function* () {
            for (const update of updates) {
              yield* tx
                .update(SessionMessageTable)
                .set({ search_text: update.searchText })
                .where(eq(SessionMessageTable.id, update.id))
                .run()
            }
            yield* tx
              .update(SearchBackfillTable)
              .set({ watermark_rowid: watermark })
              .where(eq(SearchBackfillTable.id, BaseSearchBackfillID))
              .run()
          }),
        ),
      )
      yield* Effect.yieldNow
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("Session search backfill stopped; watermark preserved, resumes on next start", { error }),
    ),
  )
}

// Same chunked, resumable pass over the V1 `part` table (desktop-app
// conversations). Part data is stored JSON that omits identity; reconstruct it
// before computing search text so the same partSearchText extractor that
// serves the live write path is used. Re-running is a no-op once done.
export function backfillParts(db: Database): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* retryOnLock(readPartBackfillState(db))
    if (state.done) return
    const decodePart = Schema.decodeUnknownOption(SessionV1.Part)
    let watermark = state.watermark
    for (;;) {
      const rows = yield* retryOnLock(
        db
          .select({
            id: PartTable.id,
            message_id: PartTable.message_id,
            session_id: PartTable.session_id,
            data: PartTable.data,
            rowid: sql<number>`rowid`,
          })
          .from(PartTable)
          .where(sql`rowid > ${watermark}`)
          .orderBy(sql`rowid`)
          .limit(BackfillChunk)
          .all(),
      )
      if (rows.length === 0) {
        yield* retryOnLock(setPartBackfillDone(db))
        return
      }
      const updates: Array<{ readonly id: SessionV1.PartID; readonly searchText: string }> = []
      for (const row of rows) {
        const data = yield* resolveProjectionRef(db, row.session_id, "part.data", row.data)
        const part = decodePart({ ...data, id: row.id, sessionID: row.session_id, messageID: row.message_id })
        if (Option.isSome(part)) {
          updates.push({ id: row.id, searchText: partSearchText(part.value) })
        }
      }
      watermark = rows.at(-1)!.rowid
      yield* retryOnLock(
        db.transaction((tx) =>
          Effect.gen(function* () {
            for (const update of updates) {
              yield* tx
                .update(PartTable)
                .set({ search_text: update.searchText })
                .where(eq(PartTable.id, update.id))
                .run()
            }
            yield* tx
              .update(PartSearchBackfillTable)
              .set({ watermark_rowid: watermark })
              .where(eq(PartSearchBackfillTable.id, PartSearchBackfillID))
              .run()
          }),
        ),
      )
      yield* Effect.yieldNow
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("Part search backfill stopped; watermark preserved, resumes on next start", { error }),
    ),
  )
}

function backfillCurrentProjection(db: Database): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (;;) {
      const message = yield* repairMessageChunk(db, BackfillChunk)
      const toolV1 = yield* repairToolRecallV1Chunk(db, BackfillChunk)
      const toolV2 = yield* repairToolRecallV2Chunk(db, BackfillChunk)
      const identity = yield* SessionLegacyToolIndex.repairChunk(db)
      if (message.done && toolV1.done && toolV2.done && identity.done) return
      yield* Effect.yieldNow
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("Session search projection backfill stopped; watermark preserved, resumes on next start", { error }),
    ),
  )
}

// Run the current extractor-version projection on a dedicated SQLite
// connection so it does not take the shared in-process client semaphore. This
// supersedes the original content-only cursor once complete, avoiding a second
// full historical write pass. It is still explicitly opt-in because SQLite
// writers share the same file-level contention domain.
export function backfillOnOwnConnection(filename: string): Effect.Effect<void> {
  return Database.withBackfillDb(filename, (db) => backfillCurrentProjection(db)).pipe(
    Effect.catch((error) =>
      Effect.logError("Session search backfill could not start; watermark preserved, resumes on next start", { error }),
    ),
  )
}

export function backfillPartsOnOwnConnection(filename: string): Effect.Effect<void> {
  return Database.withBackfillDb(filename, (db) => backfillParts(db)).pipe(
    Effect.catch((error) =>
      Effect.logError("Part search backfill could not start; watermark preserved, resumes on next start", { error }),
    ),
  )
}

type BackfillState = { readonly watermark: number; readonly done: boolean }

const readSearchBackfillState = (db: Database, id: number) =>
  Effect.gen(function* () {
    const row = yield* db
      .select({ watermark: SearchBackfillTable.watermark_rowid, done: SearchBackfillTable.done })
      .from(SearchBackfillTable)
      .where(eq(SearchBackfillTable.id, id))
      .get()
    if (row) return { watermark: row.watermark, done: row.done === 1 }
    yield* db.insert(SearchBackfillTable).values({ id, watermark_rowid: -1, done: 0 }).run()
    return { watermark: -1, done: false }
  })

const readBackfillState = (db: Database) => readSearchBackfillState(db, BaseSearchBackfillID)
const readCurrentProjectionState = (db: Database) =>
  readSearchBackfillState(db, CurrentSearchProjectionVersion)

const setBackfillDone = (db: Database) =>
  db
    .update(SearchBackfillTable)
    .set({ done: 1 })
    .where(eq(SearchBackfillTable.id, BaseSearchBackfillID))
    .run()
    .pipe(Effect.asVoid)

const readPartBackfillState = (db: Database) =>
  Effect.gen(function* () {
    const row = yield* db
      .select({ watermark: PartSearchBackfillTable.watermark_rowid, done: PartSearchBackfillTable.done })
      .from(PartSearchBackfillTable)
      .where(eq(PartSearchBackfillTable.id, PartSearchBackfillID))
      .get()
    if (row) return { watermark: row.watermark, done: row.done === 1 }
    yield* db
      .insert(PartSearchBackfillTable)
      .values({ id: PartSearchBackfillID, watermark_rowid: -1, done: 0 })
      .run()
    return { watermark: -1, done: false }
  })

const setPartBackfillDone = (db: Database) =>
  db
    .update(PartSearchBackfillTable)
    .set({ done: 1 })
    .where(eq(PartSearchBackfillTable.id, PartSearchBackfillID))
    .run()
    .pipe(Effect.asVoid)

const readToolRecallBackfillState = (
  db: Database,
  source: SessionToolRecall.Source,
) =>
  Effect.gen(function* () {
    const row = yield* db
      .select({
        watermark: SessionToolRecallBackfillTable.watermark_rowid,
        done: SessionToolRecallBackfillTable.done,
      })
      .from(SessionToolRecallBackfillTable)
      .where(eq(SessionToolRecallBackfillTable.source, source))
      .get()
    if (row) return { watermark: row.watermark, done: row.done === 1 }
    yield* db
      .insert(SessionToolRecallBackfillTable)
      .values({ source, watermark_rowid: -1, done: 0 })
      .run()
    return { watermark: -1, done: false }
  })

const setToolRecallBackfillDone = (
  db: Database,
  source: SessionToolRecall.Source,
) =>
  db
    .update(SessionToolRecallBackfillTable)
    .set({ done: 1 })
    .where(eq(SessionToolRecallBackfillTable.source, source))
    .run()
    .pipe(Effect.asVoid)

// SQLite reports lock contention (SQLITE_BUSY / SQLITE_LOCKED) as a SqlError
// whose reason is a LockTimeoutError. The drizzle query layer wraps that
// SqlError in an EffectDrizzleQueryError (cause held as a Cause), so the check
// unwraps one level before classifying.
const isLockTimeoutError = (error: unknown): boolean => {
  if (!isRecord(error)) return false
  if (error._tag === "SqlError") return isRecord(error.reason) && error.reason._tag === "LockTimeoutError"
  if (error._tag === "EffectDrizzleQueryError") {
    const cause = error.cause
    if (!Cause.isCause(cause)) return false
    const failure = Cause.findErrorOption(cause)
    return Option.isSome(failure) && isLockTimeoutError(failure.value)
  }
  return false
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

// Lock contention is transient: back off and retry the whole chunk instead of
// dying (the old Effect.orDie made the forked backfill vanish permanently on
// the first busy). The delay grows exponentially and is capped + jittered so
// competing writers on the same DB file get a chance to make progress. The
// rowid watermark is only advanced inside the chunk transaction, so an aborted
// chunk is simply re-run.
const lockRetrySchedule = Schedule.exponential("250 millis", 2).pipe(
  Schedule.either(Schedule.spaced("30 seconds")),
  Schedule.jittered,
)

const retryOnLock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      while: (error) => isLockTimeoutError(error),
      schedule: lockRetrySchedule,
    }),
  )
