export * as SessionSearch from "./search"

import { eq, sql, type SQL } from "drizzle-orm"
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
} from "./sql"
import { partSearchText, searchText, snippet } from "./search-text"

export const DefaultSearchLimit = 50
export const MaxSearchLimit = 100
const MaxQueryTerms = 8
const MinTermLength = 2
const BackfillChunk = 1000
const AutomaticBackfillEnv = "OPENCODE_SEARCH_BACKFILL"

export interface SearchInput {
  readonly query: string
  readonly directory?: string
  readonly workspaceID?: string
  readonly project?: string
  readonly limit?: number
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

export interface SearchResult {
  readonly titleMatches: SessionSchema.Info[]
  readonly messageMatches: SearchMessageMatch[]
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
    const limit = Math.min(input.limit ?? DefaultSearchLimit, MaxSearchLimit)
    const scope: SQL[] = []
    if (input.directory) scope.push(sql`s.directory = ${normalizeDirectory(input.directory)}`)
    if (input.workspaceID) scope.push(sql`s.workspace_id = ${input.workspaceID}`)
    if (input.project) scope.push(sql`s.project_id = ${input.project}`)
    const scopeClause = scope.length > 0 ? sql` AND ${sql.join(scope, sql` AND `)}` : sql``

    const titleRows = yield* db
      .all<typeof SessionTable.$inferSelect>(sql`
        SELECT s.*
        FROM session s
        WHERE s.title LIKE ${`%${input.query}%`}${scopeClause}
        ORDER BY s.time_created DESC, s.id DESC
        LIMIT ${limit}
      `)
      .pipe(
        Effect.mapError(
          () => new SearchError({ message: "Search query could not be executed" }),
        ),
      )

    const terms = matchTerms(input.query)
    const match = matchQuery(input.query)
    // Rank in the FTS layer first (narrow rowid+score rows), then join only
    // the top-N. Scope filters are applied BEFORE ranking by intersecting the
    // FTS matches with the scoped session_message rowids, so the bm25 sort
    // stays bounded by the scoped set. Without scope the rank sort runs over
    // all matches but never touches the wide message rows.
    const ranked = scope.length > 0
      ? sql`
          SELECT session_message_fts.rowid, bm25(session_message_fts) AS score
          FROM session_message_fts
          JOIN (
            SELECT m.rowid
            FROM session s
            JOIN session_message m ON m.session_id = s.id
            WHERE ${sql.join(scope, sql` AND `)}
          ) scoped ON scoped.rowid = session_message_fts.rowid
          WHERE session_message_fts MATCH ${match}
          ORDER BY bm25(session_message_fts)
          LIMIT ${limit}`
      : sql`
          SELECT rowid, bm25(session_message_fts) AS score
          FROM session_message_fts
          WHERE session_message_fts MATCH ${match}
          ORDER BY bm25(session_message_fts)
          LIMIT ${limit}`
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
            ORDER BY f.score
          `)
          .pipe(
            Effect.mapError(
              () => new SearchError({ message: "Search query could not be executed" }),
            ),
          )
      : []

    // V1 conversation content lives in the part table (message.data holds only
    // role and metadata). The same tokenized prefix MATCH runs over part_fts;
    // matches are projected to their parent message and session, exactly like
    // the V2 path, so the response shape is identical across stores.
    const rankedParts = scope.length > 0
      ? sql`
          SELECT part_fts.rowid, bm25(part_fts) AS score
          FROM part_fts
          JOIN (
            SELECT p.rowid
            FROM session s
            JOIN part p ON p.session_id = s.id
            WHERE ${sql.join(scope, sql` AND `)}
          ) scoped ON scoped.rowid = part_fts.rowid
          WHERE part_fts MATCH ${match}
          ORDER BY bm25(part_fts)
          LIMIT ${limit}`
      : sql`
          SELECT rowid, bm25(part_fts) AS score
          FROM part_fts
          WHERE part_fts MATCH ${match}
          ORDER BY bm25(part_fts)
          LIMIT ${limit}`
    const partRows = match
      ? yield* db
          .all<PartRow>(sql`
            SELECT
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
            ORDER BY f.score
          `)
          .pipe(
            Effect.mapError(
              () => new SearchError({ message: "Search query could not be executed" }),
            ),
          )
      : []

    return {
      titleMatches: titleRows.map(decodeTitleRow),
      messageMatches: mergeMatches(
        [
          ...messageRows.map((row) => ({
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
          ...partRows.map((row) => ({
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
        ],
        limit,
      ),
    }
  })
}

// One session may surface matches from both the V2 session_message and the V1
// part stores (e.g. a session that predates the V2 projection). Collapse to
// one match per message ID, keeping the first (highest BM25-ranked) hit, and
// cap the merged list at the requested limit.
function mergeMatches(matches: SearchMessageMatch[], limit: number): SearchMessageMatch[] {
  const seen = new Set<string>()
  const merged: SearchMessageMatch[] = []
  for (const match of matches) {
    if (seen.has(match.messageID)) continue
    seen.add(match.messageID)
    merged.push(match)
    if (merged.length >= limit) break
  }
  return merged
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
    model: parseJson<{ id: string; providerID: string; variant?: string }>(row.model as string | null),
    revert: parseJson(row.revert as string | null),
  })
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
      watermark = rows.at(-1)!.rowid
      yield* retryOnLock(
        db.transaction((tx) =>
          Effect.gen(function* () {
            for (const row of rows) {
              const data = yield* resolveProjectionRef(db, row.session_id, "session_message.data", row.data)
              const message = decodeMessage({ ...data, id: row.id, type: row.type })
              if (Option.isSome(message)) {
                yield* tx
                  .update(SessionMessageTable)
                  .set({ search_text: searchText(message.value) })
                  .where(eq(SessionMessageTable.id, row.id))
                  .run()
              }
            }
            yield* tx
              .update(SearchBackfillTable)
              .set({ watermark_rowid: watermark })
              .where(eq(SearchBackfillTable.id, 1))
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
      watermark = rows.at(-1)!.rowid
      yield* retryOnLock(
        db.transaction((tx) =>
          Effect.gen(function* () {
            for (const row of rows) {
              const data = yield* resolveProjectionRef(db, row.session_id, "part.data", row.data)
              const part = decodePart({ ...data, id: row.id, sessionID: row.session_id, messageID: row.message_id })
              if (Option.isSome(part)) {
                yield* tx
                  .update(PartTable)
                  .set({ search_text: partSearchText(part.value) })
                  .where(eq(PartTable.id, row.id))
                  .run()
              }
            }
            yield* tx
              .update(PartSearchBackfillTable)
              .set({ watermark_rowid: watermark })
              .where(eq(PartSearchBackfillTable.id, 1))
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

// Run the resumable FTS backfill on a dedicated SQLite connection so it does
// not take the shared in-process client semaphore. This still writes to the
// same database file, so automatic startup callers must gate it explicitly.
export function backfillOnOwnConnection(filename: string): Effect.Effect<void> {
  return Database.withBackfillDb(filename, (db) => backfill(db)).pipe(
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

const readBackfillState = (db: Database) =>
  Effect.gen(function* () {
    const row = yield* db
      .select({ watermark: SearchBackfillTable.watermark_rowid, done: SearchBackfillTable.done })
      .from(SearchBackfillTable)
      .where(eq(SearchBackfillTable.id, 1))
      .get()
    if (row) return { watermark: row.watermark, done: row.done === 1 }
    yield* db.insert(SearchBackfillTable).values({ id: 1, watermark_rowid: -1, done: 0 }).run()
    return { watermark: -1, done: false }
  })

const setBackfillDone = (db: Database) =>
  db
    .update(SearchBackfillTable)
    .set({ done: 1 })
    .where(eq(SearchBackfillTable.id, 1))
    .run()
    .pipe(Effect.asVoid)

const readPartBackfillState = (db: Database) =>
  Effect.gen(function* () {
    const row = yield* db
      .select({ watermark: PartSearchBackfillTable.watermark_rowid, done: PartSearchBackfillTable.done })
      .from(PartSearchBackfillTable)
      .where(eq(PartSearchBackfillTable.id, 1))
      .get()
    if (row) return { watermark: row.watermark, done: row.done === 1 }
    yield* db
      .insert(PartSearchBackfillTable)
      .values({ id: 1, watermark_rowid: -1, done: 0 })
      .run()
    return { watermark: -1, done: false }
  })

const setPartBackfillDone = (db: Database) =>
  db
    .update(PartSearchBackfillTable)
    .set({ done: 1 })
    .where(eq(PartSearchBackfillTable.id, 1))
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
