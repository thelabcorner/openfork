/**
 * Bounded Context ledger traversal over the authoritative durable V1 message/
 * part and overlay projections. Ordinary (uncompacted) sessions perform one
 * indexed message keyset page and at most 50 addressed part hydrations; they
 * never materialize their entire history in JavaScript.
 *
 * Completed or potentially completed compaction may reorder the retained tail.
 * Those sessions conservatively fall back to the canonical compiler-aligned
 * snapshot, then page its results. Never paginate raw physical rows across a
 * compaction boundary and call them effective context.
 *
 * This is a stepping stone to a fully producer-materialized ledger, NOT that
 * final architecture: compaction and OPCL ambiguity are guarded by partial
 * SQLite indexes, but selected pages still hydrate complete V1 message/part
 * JSON (including any large tool outputs).
 */
import { Effect } from "effect"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { MessageTable, PartTable, SessionContextStateTable } from "@opencode-ai/core/session/sql"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { SessionLedger } from "./ledger"
import { ContextInspection } from "./inspection"

export const PAGE_MAX = 50
type Cursor = {
  v: 1
  sessionID: string
  revision: number
} & ({ mode: "chronological"; inner: string } | { mode: "compacted"; before: string })
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url")
const revisionFrom = (sessionID: string, reader: Pick<Database.DatabaseShape, "select">) =>
  reader.select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, sessionID))
    .get().pipe(Effect.map((row) => row?.seq ?? -1), Effect.orDie)
function decode(value: string | undefined): Cursor | undefined {
  if (!value) return undefined
  try {
    if (value.length > 4096) throw Error("cursor too long")
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (!cursor || cursor.v !== 1 ||
      typeof cursor.sessionID !== "string" || !Number.isSafeInteger(cursor.revision) ||
      (cursor.mode !== "chronological" && cursor.mode !== "compacted") ||
      (cursor.mode === "chronological" ? typeof cursor.inner !== "string" : typeof cursor.before !== "string"))
      throw Error("Invalid Context ledger page cursor")
    return cursor
  } catch {
    throw Error("Invalid Context ledger page cursor")
  }
}

export const readPage = Effect.fn("ContextLedgerPage.readPage")(function* (input: {
  sessionID: string
  limit?: number
  cursor?: string
}) {
  const limit = input.limit ?? PAGE_MAX
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX)
    return yield* Effect.die(new Error("Invalid Context page size"))
  const after = decode(input.cursor)
  const { readDb } = yield* Database.Service
  if (after && after.sessionID !== input.sessionID)
    return yield* Effect.die(new Error("Context page cursor belongs to another session"))
  // Durable event sequence fences every producer-owned projection update.
  // A keyset page cannot be silently combined with an older version after a
  // user edits/excludes a message, compaction finishes, or another worker
  // commits a message/part update.
  const initialRevision = yield* revisionFrom(input.sessionID, readDb)
  if (after && after.revision !== initialRevision)
    return yield* Effect.die(new Error("Context ledger changed during pagination"))

  // OPCL references conceal the original V1 metadata from the raw SQL
  // compaction classifier and from the legacy V1 page hydrator. Do not
  // silently treat an opaque message as unsigned/uncompacted or fabricate a
  // partial ledger. The matching partial index makes this O(log n).
  const opaque = yield* readDb
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, input.sessionID as any),
       sql`${MessageTable.context_opaque} = 1`))
    .limit(1).get().pipe(Effect.orDie)
  if (opaque) return yield* Effect.die(new Error(
    "Opaque V1 message metadata requires canonical OPCL rehydration before ledger pagination",
  ))
   // OPCL may externalize the physical part JSON *after* the authoritative
   // PartUpdated projector wrote complete v1 scalar facts. That exact case is
   // safe to inspect without decoding the large payload. Only opaque parts
   // lacking producer-verified v1 facts require ref-aware reconciliation.
   const opaquePart = yield* readDb
    .select({ id: PartTable.id })
    .from(PartTable)
    .where(and(eq(PartTable.session_id, input.sessionID as any),
       sql`${PartTable.context_opaque} = 1 AND ${PartTable.context_projection_version} <> 1`))
    .limit(1).get().pipe(Effect.orDie)
  if (opaquePart) return yield* Effect.die(new Error(
     "Opaque V1 part metadata without verified v1 facts requires canonical OPCL rehydration before ledger pagination",
  ))

  // A completed assistant summary with a matching compaction part is necessary
  // for V1 effective-history rewriting. Match both conditions, not merely
  // `summary:true`: general summary turns without a compaction marker are
  // common, and making every such Session hydrate its entire ledger defeats
  // bounded pagination. False positives still safely take the slow path.
  const potentiallyCompacted = yield* readDb
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, input.sessionID as any),
       sql`${MessageTable.context_summary} = 1`,
       sql`EXISTS (
         SELECT 1 FROM part
         WHERE part.message_id = json_extract(${MessageTable.data}, '$.parentID')
           AND part.session_id = ${input.sessionID}
           AND part.context_compaction = 1
       )`))
    .limit(1).get().pipe(Effect.orDie)
  const mode = potentiallyCompacted ? "compacted" : "chronological"
  if (after && after.mode !== mode) return yield* Effect.die(new Error("Context history changed during pagination"))

  if (mode === "compacted") {
    const snapshot = yield* ContextInspection.read(input.sessionID)
    if ((yield* revisionFrom(input.sessionID, readDb)) !== initialRevision)
      return yield* Effect.die(new Error("Context ledger changed during pagination"))
    const all = ContextInspection.ledger(input.sessionID, snapshot)
    let end = all.entries.length
    if (after?.mode === "compacted") {
      const at = all.entries.findIndex((entry) => entry.messageID === after.before)
      if (at < 0) return yield* Effect.die(new Error("Context page cursor no longer exists"))
      end = at
    }
    const start = Math.max(0, end - limit)
    return {
      sessionID: SessionID.make(input.sessionID),
      entries: all.entries.slice(start, end),
      authoritativeTotals: !after ? all.totals : undefined,
      revision: initialRevision,
      hasMore: start > 0,
      nextCursor: start > 0 ? encode({ v: 1, sessionID: input.sessionID, revision: initialRevision, mode, before: all.entries[start]!.messageID }) : undefined,
      mode: "compacted" as const,
    }
  }

  return yield* readDb.transaction((tx) =>
    Effect.gen(function* () {
      const revision = yield* revisionFrom(input.sessionID, tx)
      if (revision !== initialRevision)
        return yield* Effect.die(new Error("Context ledger changed during pagination"))
       // New V1 producers persist versioned part scalars at event-write time.
       // Prefer those for bounded Context inspection: even huge tool outputs
       // are never materialized into JS merely for token/preview/signature
       // badges. Historical v0/opaque parts automatically use canonical
       // hydration; never return unverified estimates from missing facts.
       const inputPage = {
         sessionID: input.sessionID as any, limit,
         before: after?.mode === "chronological" ? after.inner : undefined,
       }
       const compact = yield* MessageV2.pageContextFactsOn(inputPage, tx)
       const page = compact ?? (yield* MessageV2.pageOn(inputPage, tx))
      const ids = page.items.map((item) => item.info.id as any)
      const overlays = ids.length ? yield* tx.select({
        message_id: SessionContextStateTable.message_id,
        excluded: SessionContextStateTable.excluded,
        pinned: SessionContextStateTable.pinned,
        override_data: SessionContextStateTable.override_data,
      }).from(SessionContextStateTable)
        .where(and(eq(SessionContextStateTable.session_id, input.sessionID as any),
          inArray(SessionContextStateTable.message_id, ids)))
        .all().pipe(Effect.orDie) : []
       const ledger = SessionLedger.buildWithRows(
          { sessionID: input.sessionID, messages: page.items },
          overlays,
          compact?.facts,
        )
       return {
         sessionID: SessionID.make(input.sessionID),
         entries: ledger.entries,
         revision,
        hasMore: page.more,
        nextCursor: page.more && page.cursor
          ? encode({ v: 1, sessionID: input.sessionID, revision, mode, inner: page.cursor }) : undefined,
        mode: "chronological" as const,
      }
    }), { behavior: "deferred" },
  )
})
