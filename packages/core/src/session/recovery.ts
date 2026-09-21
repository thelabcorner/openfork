export * as SessionRecovery from "./recovery"

import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import type { RuntimeOwner } from "../runtime-owner"
import { SessionEvent } from "./event"
import { SessionExecutionOwner } from "./execution-owner"
import { SessionMessage } from "./message"
import { SessionMessageProjection } from "./message-projection"
import { SessionSchema } from "./schema"
import { PartTable, SessionMessageTable, SessionMessageToolOverlayTable } from "./sql"

type DatabaseReader = Pick<Database.Interface["db"], "select">

export interface ExecutionHazards {
  readonly currentTool: boolean
  readonly legacyTool: boolean
}

export type DeadOwnerRecoveryResult =
  | { readonly state: "idle"; readonly snapshot: SessionExecutionOwner.Snapshot }
  | { readonly state: "recovered"; readonly token: SessionExecutionOwner.RecoveryToken }
  | {
      readonly state: "effect-unknown"
      readonly token: SessionExecutionOwner.RecoveryToken
      readonly hazards: ExecutionHazards
    }
  | {
      readonly state: "blocked"
      readonly snapshot: SessionExecutionOwner.Snapshot
      readonly proof?: Exclude<RuntimeOwner.LocalDeathProof, "dead">
    }
  | { readonly state: "raced"; readonly snapshot: SessionExecutionOwner.Snapshot }

/**
 * Negative containment proof for automatic dead-owner recovery.
 *
 * A hard-dead runtime may have left an OS child alive. OpenFork therefore only
 * auto-completes recovery when there is no durable in-flight tool boundary in
 * either the current or V1 projection. Any pending/running tool is preserved as
 * effect-unknown evidence and keeps the generation fenced; do not "repair" it
 * away before containment or explicit operator acknowledgement exists.
 */
export const executionHazards = Effect.fn("SessionRecovery.executionHazards")(function* (
  db: DatabaseReader,
  sessionID: SessionSchema.ID,
) {
  const currentTool =
    (yield* db
      .select({ callID: SessionMessageToolOverlayTable.call_id })
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
      .limit(1)
      .get()
      .pipe(Effect.orDie)) !== undefined

  const legacyTool =
    (yield* db
      .select({ id: PartTable.id })
      .from(PartTable)
      .where(
        and(
          eq(PartTable.session_id, sessionID),
          sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
          sql`json_extract(${PartTable.data}, '$.state.status') IN ('pending', 'running')`,
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)) !== undefined

  return { currentTool, legacyTool } satisfies ExecutionHazards
})

export const recoverDeadOwnerIfQuiescent = Effect.fn("SessionRecovery.recoverDeadOwnerIfQuiescent")(function* (
  db: DatabaseReader,
  ownership: SessionExecutionOwner.Interface,
  sessionID: SessionSchema.ID,
) {
  const claim = yield* ownership.tryClaimRecovery(sessionID)
  if (claim.state === "idle") return { state: "idle" as const, snapshot: claim.snapshot }
  if (claim.state === "blocked")
    return { state: "blocked" as const, snapshot: claim.snapshot, proof: claim.proof }
  if (claim.state === "busy") return { state: "blocked" as const, snapshot: claim.snapshot }

  const hazards = yield* executionHazards(db, sessionID)
  if (hazards.currentTool || hazards.legacyTool) {
    return { state: "effect-unknown" as const, token: claim.token, hazards }
  }

  const completed = yield* ownership.completeRecovery(claim.token)
  if (completed === "released") return { state: "recovered" as const, token: claim.token }
  return { state: "raced" as const, snapshot: yield* ownership.snapshot(sessionID) }
})

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
