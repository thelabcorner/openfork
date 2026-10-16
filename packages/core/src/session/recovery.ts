export * as SessionRecovery from "./recovery"

import { and, eq, inArray, isNull } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import type { RuntimeOwner } from "../runtime-owner"
import { SessionV1 } from "../v1/session"
import { SessionEvent } from "./event"
import { SessionExecutionOwner } from "./execution-owner"
import { SessionMessage } from "./message"
import { SessionMessageProjection } from "./message-projection"
import { SessionSchema } from "./schema"
import { SessionLegacyToolIndex } from "./legacy-tool-index"
import { SessionRecoveryTurn } from "./recovery-turn"
import { KeyedMutex } from "../effect/keyed-mutex"
import { MessageTable, SessionMessageTable, SessionMessageToolOverlayTable } from "./sql"

type DatabaseReader = Pick<Database.Interface["db"], "select">

// A process may load several OpenFork runtime module graphs (desktop/server,
// refreshed OXP, supervisors). Same-runtime tryClaimRecovery intentionally
// returns an existing claim, so two callers can otherwise publish duplicate
// Step.Failed/MessageUpdated events and race the same CAS release. Serialize
// whole claim→hazard proof→transcript settlement→release, not just claim().
const RECOVERY_LOCKS = Symbol.for("openfork.session-recovery.locks.v1")
const recoveryLocks = (() => {
  const processState = globalThis as typeof globalThis & { [key: symbol]: unknown }
  const existing = processState[RECOVERY_LOCKS] as KeyedMutex.KeyedMutex<SessionSchema.ID> | undefined
  if (existing) return existing
  const created = KeyedMutex.makeUnsafe<SessionSchema.ID>()
  processState[RECOVERY_LOCKS] = created
  return created
})()
export const withSessionRecoveryLock = <A, E, R>(
  sessionID: SessionSchema.ID,
  work: Effect.Effect<A, E, R>,
) => recoveryLocks.withLock(sessionID)(work)

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
  | { readonly state: "transcript-unverifiable"; readonly token: SessionExecutionOwner.RecoveryToken; readonly reason: string }
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

  const legacyTool = yield* SessionLegacyToolIndex.hasUnsettled(db, sessionID)

  return { currentTool, legacyTool } satisfies ExecutionHazards
})

export const recoverDeadOwnerIfQuiescent = Effect.fn("SessionRecovery.recoverDeadOwnerIfQuiescent")(function* (
  db: DatabaseReader,
  ownership: SessionExecutionOwner.Interface,
  sessionID: SessionSchema.ID,
  events: EventV2.Interface,
) {
  return yield* withSessionRecoveryLock(sessionID, Effect.gen(function* () {
  const claim = yield* ownership.tryClaimRecovery(sessionID)
  if (claim.state === "idle") return { state: "idle" as const, snapshot: claim.snapshot }
  if (claim.state === "blocked")
    return { state: "blocked" as const, snapshot: claim.snapshot, proof: claim.proof }
  if (claim.state === "busy") return { state: "blocked" as const, snapshot: claim.snapshot }

  const hazards = yield* executionHazards(db, sessionID)
  if (hazards.currentTool || hazards.legacyTool) {
    return { state: "effect-unknown" as const, token: claim.token, hazards }
  }

  // Tools are quiescent, but an assistant may still be half-written when a
  // provider/worker crashes before completing any tool. Closing execution
  // ownership first strands that message in a false generating state.
  // Use the exact recovery claim and its acquiredAt boundary before release.
  const transcript = yield* SessionRecoveryTurn.sealInterruptedGeneration(
    db, events, sessionID, claim.snapshot.acquiredAt,
  )
  if (transcript.state !== "sealed") {
    yield* Effect.logWarning("Dead Session transcript cannot be proven sealed; execution remains fenced", {
      sessionID, generation: claim.token.generation, reason: transcript.reason,
    })
    return { state: "transcript-unverifiable" as const, token: claim.token, reason: transcript.reason }
  }

  const completed = yield* ownership.completeRecovery(claim.token)
  if (completed === "released") return { state: "recovered" as const, token: claim.token }
  return { state: "raced" as const, snapshot: yield* ownership.snapshot(sessionID) }
  }))
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
 * Candidate discovery covers both authoritative projections:
 * - current/V2 unresolved overlays are sealed with Tool.Failed;
 * - retained V1 ToolParts are rewritten through the canonical PartUpdated event.
 *
 * Re-running is idempotent: current settlement fills the overlay pointer and the
 * V1 repair changes pending/running to error, so neither row is selected again.
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

  const byMessage = new Map<SessionMessage.ID, Set<string>>()
  for (const candidate of candidates) {
    const calls = byMessage.get(candidate.messageID) ?? new Set<string>()
    calls.add(candidate.callID)
    byMessage.set(candidate.messageID, calls)
  }

  let settled = 0
  if (byMessage.size > 0) {
    const messageIDs = [...byMessage.keys()]
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(inArray(SessionMessageTable.id, messageIDs))
      .all()
      .pipe(Effect.orDie)
    const messages = yield* SessionMessageProjection.decodeRows(db, rows).pipe(Effect.orDie)
    settled += yield* failInterruptedEntries(
      events,
      sessionID,
      messages.map((message) => ({ message })),
      byMessage,
    )
  }

  const legacy = yield* SessionLegacyToolIndex.unsettledParts(db, sessionID)

  if (legacy.length > 0) {
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    const decodeTool = Schema.decodeUnknownOption(SessionV1.ToolPart)
    for (const row of legacy) {
      const decoded = decodeTool({
        ...row.data,
        id: row.id,
        messageID: row.messageID,
        sessionID: row.sessionID,
      })
      if (Option.isNone(decoded)) continue
      // Schema decoding deliberately returns a readonly view. Clone only after
      // validation so the legacy wire value can be rewritten as the mutable V1
      // protocol type without sharing nested metadata objects with the row.
      const data = structuredClone(decoded.value) as SessionV1.ToolPart
      if (data.state.status !== "pending" && data.state.status !== "running") continue
      const metadata =
        data.state.status === "running" && data.state.metadata && typeof data.state.metadata === "object"
          ? { ...data.state.metadata, interrupted: true }
          : { interrupted: true }
      const part: SessionV1.ToolPart = {
        ...data,
        state: {
          status: "error",
          input: data.state.input,
          error: "Tool execution interrupted (external effect unknown)",
          metadata,
          time: {
            start: data.state.status === "running" ? data.state.time.start : now,
            end: now,
          },
        },
      }
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: row.sessionID,
        part,
        time: now,
      })
      settled++
    }
    // A crashed executor leaves the assistant unfinished as well as its calls.
    // Repair that producer-owned boundary through its canonical event so Resume
    // cannot mistake the abandoned turn for a still-streaming assistant.
    const messages = yield* db.select().from(MessageTable)
      .where(inArray(MessageTable.id, [...new Set(legacy.map((row) => row.messageID))]))
      .all().pipe(Effect.orDie)
    const decodeAssistant = Schema.decodeUnknownOption(SessionV1.Assistant)
    for (const row of messages) {
      const decoded = decodeAssistant({ ...row.data, id: row.id, sessionID: row.session_id })
      if (Option.isNone(decoded) || decoded.value.time.completed !== undefined) continue
      const info = structuredClone(decoded.value) as SessionV1.Assistant
      info.time.completed = now
      info.error ??= { name: "MessageAbortedError", data: { message: "Execution interrupted (external effects unknown)" } }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info })
    }
  }

  return { candidates: candidates.length + legacy.length, settled } satisfies InterruptedToolRepairResult
})
