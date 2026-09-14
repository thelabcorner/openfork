import { and, asc, desc, eq, gt, gte, ne, or } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionMessage } from "./message"
import { SessionMessageProjection } from "./message-projection"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]
type DatabaseReader = Pick<DatabaseService, "select">
export type RunnerEntry = { readonly seq: number; readonly message: SessionMessage.Message }
export type RunnerSnapshot = { readonly frontier: number; readonly entries: RunnerEntry[] }

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseReader, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseReader,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction
          ? or(
              gte(SessionMessageTable.seq, compaction.seq),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseReader, sessionID: SessionSchema.ID) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  return yield* SessionMessageProjection.decodeRows(
    db,
    yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq),
  )
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseReader,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseReader,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
  const messages = yield* SessionMessageProjection.decodeRows(db, rows)
  return rows.map((row, index) => ({ seq: row.seq, message: messages[index]! }))
})

/**
 * Read a runner projection and its durable frontier from one SQLite snapshot.
 *
 * The paired frontier is what lets the active runner subscribe before this
 * read, then replay only buffered events newer than the snapshot without
 * guessing whether an event raced the history query.
 */
export const snapshotForRunner = Effect.fn("SessionHistory.snapshotForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        // This first read establishes the transaction's WAL snapshot. Every row,
        // lifecycle overlay, and optional ChunkDB ref decoded below belongs to
        // the same committed frontier.
        const frontier = yield* EventV2.latestSequence(tx, sessionID)
        const compaction = yield* latestCompaction(tx, sessionID)
        const rows = yield* messageRows(tx, sessionID, compaction, baselineSeq)
        const messages = yield* SessionMessageProjection.decodeRows(tx, rows)
        return {
          frontier,
          entries: rows.map((row, index) => ({ seq: row.seq, message: messages[index]! })),
        } satisfies RunnerSnapshot
      }),
    )
    .pipe(Effect.orDie)
})

export * as SessionHistory from "./history"
