export * as SessionRecovery from "./recovery"

import { and, eq, inArray, isNull } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionMessageProjection } from "./message-projection"
import { SessionSchema } from "./schema"
import { SessionMessageTable, SessionMessageToolOverlayTable } from "./sql"

type DatabaseReader = Pick<Database.Interface["db"], "select">

export interface InterruptedToolRepairResult {
  readonly candidates: number
  readonly settled: number
}

export const failInterruptedEntries = Effect.fn("SessionRecovery.failInterruptedEntries")(function* (
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  entries: readonly { readonly message: SessionMessage.Message }[],
  eligible?: ReadonlyMap<SessionMessage.ID, ReadonlySet<string>>,
) {
  let settled = 0
  for (const { message } of entries) {
    if (message.type !== "assistant") continue
    const calls = eligible?.get(message.id)
    if (eligible && !calls) continue
    for (const tool of message.content) {
      if (tool.type !== "tool") continue
      if (calls && !calls.has(tool.id)) continue
      if (tool.state.status !== "pending" && tool.state.status !== "running") continue
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: message.id,
        callID: tool.id,
        error: { type: "unknown", message: "Tool execution interrupted" },
        provider: {
          executed: tool.provider?.executed === true,
          ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
        },
      })
      settled++
    }
  }
  return settled
})

/**
 * Seal only unresolved durable tool calls for one Session after an executor is
 * proven dead. This is transcript repair, not authority transfer: callers must
 * separately own the Session recovery fence before invoking it.
 *
 * Candidate discovery uses normalized projection state and decodes only owning
 * assistant messages. Re-running is idempotent because Tool.Failed fills the
 * overlay settlement pointer in the same EventV2 transaction.
 */
export const failInterruptedTools = Effect.fn("SessionRecovery.failInterruptedTools")(function* (
  db: DatabaseReader,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const candidates = yield* db
    .select({
      messageID: SessionMessageToolOverlayTable.message_id,
      callID: SessionMessageToolOverlayTable.call_id,
    })
    .from(SessionMessageTable)
    .innerJoin(
      SessionMessageToolOverlayTable,
      eq(SessionMessageToolOverlayTable.message_id, SessionMessageTable.id),
    )
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        isNull(SessionMessageToolOverlayTable.settlement_event_id),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  if (candidates.length === 0) return { candidates: 0, settled: 0 } satisfies InterruptedToolRepairResult

  const byMessage = new Map<SessionMessage.ID, Set<string>>()
  for (const candidate of candidates) {
    const calls = byMessage.get(candidate.messageID) ?? new Set<string>()
    calls.add(candidate.callID)
    byMessage.set(candidate.messageID, calls)
  }
  const messageIDs = [...byMessage.keys()]
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(inArray(SessionMessageTable.id, messageIDs))
    .all()
    .pipe(Effect.orDie)
  const messages = yield* SessionMessageProjection.decodeRows(db, rows).pipe(Effect.orDie)
  const settled = yield* failInterruptedEntries(
    events,
    sessionID,
    messages.map((message) => ({ message })),
    byMessage,
  )
  return { candidates: candidates.length, settled } satisfies InterruptedToolRepairResult
})
