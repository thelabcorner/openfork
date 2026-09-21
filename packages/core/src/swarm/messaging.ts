import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { EventV2 } from "../event"
import { canSuppressReply, expandRecipients, type MessageTarget, validMessageBody } from "./message"
import { hydrateDelivery, hydrateMessage } from "./projection"
import {
  type Db,
  requireDeliveryRow,
  requireMemberRow,
  requireMessageRow,
  requireTaskRow,
} from "./repository"
import { SwarmSchema } from "./schema"
import {
  SwarmMemberTable,
  SwarmMessageDeliveryTable,
  SwarmMessageTable,
} from "./sql"
import { commitFail, publishWithCommit } from "./transaction"

export interface EnqueueMessageInput {
  readonly swarmID: Swarm.ID
  readonly senderMemberID: Swarm.MemberID
  readonly target: MessageTarget
  readonly kind: Swarm.MessageKind
  readonly body: string
  readonly priority?: Swarm.MessagePriority
  readonly replyExpected?: boolean
  readonly taskID?: Swarm.TaskID
  readonly correlationID?: string
  readonly responseTo?: Swarm.MessageID
  readonly expiresAt?: number
  readonly now?: number
}

export interface DeliveryClaimToken {
  readonly deliveryID: Swarm.DeliveryID
  readonly generation: number
  readonly owner: string
  readonly recipientMemberID: Swarm.MemberID
  readonly recipientSessionID: Swarm.Member["sessionID"] & string
  readonly recipientBindingGeneration: number
}

export interface ClaimDeliveryInput {
  readonly deliveryID: Swarm.DeliveryID
  readonly owner: string
  readonly leaseMs: number
  readonly now?: number
}

export type DeliveryRelease =
  | {
      readonly type: "retry"
      readonly nextAttemptAt: number
      readonly error?: string
      /** False for pure deferral/fencing races where no delivery attempt occurred. */
      readonly countAsAttempt?: boolean
    }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "expired"; readonly error?: string }

export interface ReleaseDeliveryInput {
  readonly token: DeliveryClaimToken
  readonly outcome: DeliveryRelease
  readonly now?: number
}

export interface CommitDeliveryAdmissionInput {
  readonly token: DeliveryClaimToken
  readonly admittedSessionID: DeliveryClaimToken["recipientSessionID"]
  readonly admittedSeq: number
  readonly admittedAt: number
}

export interface ExpireDeliveryInput {
  readonly deliveryID: Swarm.DeliveryID
  readonly now?: number
}

export interface MessageHistoryCursor {
  readonly createdAt: number
  readonly id: Swarm.MessageID
}

export interface MessageHistoryEntry {
  readonly message: Swarm.Message
  readonly deliveries: ReadonlyArray<Swarm.Delivery>
}

export interface MessageHistoryPage {
  readonly items: ReadonlyArray<MessageHistoryEntry>
  readonly more: boolean
  readonly next?: MessageHistoryCursor
}

function positiveDuration(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

function deliveryStale(id: Swarm.DeliveryID, expected: number, actual: number) {
  return new SwarmSchema.StaleFenceError({
    fence: "delivery_claim",
    id,
    expectedGeneration: expected,
    actualGeneration: actual,
  })
}

function claimMatches(row: typeof SwarmMessageDeliveryTable.$inferSelect, token: DeliveryClaimToken) {
  return (
    row.id === token.deliveryID &&
    row.state === "claimed" &&
    row.claim_generation === token.generation &&
    row.claim_owner === token.owner &&
    row.recipient_member_id === token.recipientMemberID
  )
}

/**
 * Phase-2 seam: invoke this from the recipient Session EventV2 commit hook.
 * Session input insertion and delivery admission then commit or roll back as one
 * SQLite transaction without publishing a second aggregate event.
 */
export const commitDeliveryAdmission = Effect.fn("Swarm.commitDeliveryAdmission")(function* (
  database: Db,
  input: CommitDeliveryAdmissionInput,
) {
  if (!Number.isSafeInteger(input.admittedSeq) || input.admittedSeq < 0)
    return yield* new SwarmSchema.ValidationError({ reason: "admittedSeq must be a non-negative safe integer." })
  const delivery = yield* requireDeliveryRow(database, input.token.deliveryID)
  if (input.admittedSessionID !== input.token.recipientSessionID)
    return yield* new SwarmSchema.ConflictError({
      code: "swarm.delivery_session_mismatch",
      reason: "Delivery admission Session does not match the claimed recipient binding.",
    })
  const message = yield* database
    .select({ expiresAt: SwarmMessageTable.expires_at })
    .from(SwarmMessageTable)
    .where(eq(SwarmMessageTable.id, delivery.message_id))
    .get()
    .pipe(Effect.orDie)
  if (!message)
    return yield* new SwarmSchema.NotFoundError({ entity: "message", id: delivery.message_id })
  if (message.expiresAt !== null && message.expiresAt <= input.admittedAt)
    return yield* new SwarmSchema.ConflictError({
      code: "swarm.message_expired",
      reason: `Message ${delivery.message_id} expired before Session admission committed.`,
    })
  const member = yield* database
    .select({
      sessionID: SwarmMemberTable.session_id,
      generation: SwarmMemberTable.binding_generation,
      lifecycle: SwarmMemberTable.lifecycle,
    })
    .from(SwarmMemberTable)
    .where(eq(SwarmMemberTable.id, input.token.recipientMemberID))
    .get()
    .pipe(Effect.orDie)
  if (
    !member ||
    member.lifecycle !== "active" ||
    member.sessionID !== input.token.recipientSessionID ||
    member.generation !== input.token.recipientBindingGeneration
  )
    return yield* new SwarmSchema.StaleFenceError({
      fence: "member_binding",
      id: input.token.recipientMemberID,
      expectedGeneration: input.token.recipientBindingGeneration,
      actualGeneration: member?.generation ?? input.token.recipientBindingGeneration + 1,
    })
  // A Session-event projector may already have materialized the exact receipt
  // earlier in this same writer transaction. Keep that path idempotent only
  // AFTER revalidating the producer's captured TTL + member-binding fence.
  if (
    delivery.state === "admitted" &&
    delivery.claim_generation === input.token.generation &&
    delivery.recipient_member_id === input.token.recipientMemberID &&
    delivery.admitted_session_id === input.admittedSessionID &&
    delivery.admitted_seq === input.admittedSeq
  )
    return hydrateDelivery(delivery)
  if (!claimMatches(delivery, input.token))
    return yield* deliveryStale(
      input.token.deliveryID,
      input.token.generation,
      delivery.claim_generation,
    )
  const updated = yield* database
    .update(SwarmMessageDeliveryTable)
    .set({
      state: "admitted",
      admitted_session_id: input.admittedSessionID,
      admitted_seq: input.admittedSeq,
      admitted_at: input.admittedAt,
      claim_owner: null,
      claim_expires_at: null,
      next_attempt_at: null,
      error: null,
    })
    .where(
      and(
        eq(SwarmMessageDeliveryTable.id, input.token.deliveryID),
        eq(SwarmMessageDeliveryTable.state, "claimed"),
        eq(SwarmMessageDeliveryTable.claim_generation, input.token.generation),
        eq(SwarmMessageDeliveryTable.claim_owner, input.token.owner),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!updated)
    return yield* new SwarmSchema.ConflictError({
      code: "swarm.delivery_changed",
      reason: `Delivery ${input.token.deliveryID} changed before Session admission committed.`,
    })
  return hydrateDelivery(updated)
})

export function makeMessagingOperations(input: {
  readonly db: Db
  readonly readDb: Db
  readonly events: EventV2.Interface
}) {
  const { db, readDb, events } = input

  const expireDelivery = Effect.fn("Swarm.expireDelivery")(function* (request: ExpireDeliveryInput) {
    const now = request.now ?? Date.now()
    const row = yield* requireDeliveryRow(readDb, request.deliveryID)
    const message = yield* readDb
      .select()
      .from(SwarmMessageTable)
      .where(eq(SwarmMessageTable.id, row.message_id))
      .get()
      .pipe(Effect.orDie)
    if (!message)
      return yield* new SwarmSchema.NotFoundError({ entity: "message", id: row.message_id })
    if (message.expires_at === null || message.expires_at > now)
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.message_not_expired",
        reason: `Message ${message.id} has not expired.`,
      })
    if (row.state !== "pending" && row.state !== "claimed") {
      if (row.state === "expired") return hydrateDelivery(row)
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.delivery_not_expirable",
        reason: `Delivery ${row.id} cannot expire from state ${row.state}.`,
      })
    }
    const next = hydrateDelivery({
      ...row,
      state: "expired",
      claim_owner: null,
      claim_expires_at: null,
      next_attempt_at: null,
      // Expiry is a semantic deadline, not a failed delivery attempt.
      attempt_count: row.attempt_count,
      error: "message expired before admission",
    })
    yield* publishWithCommit(
      events,
      Swarm.Event.DeliveryUpdated,
      { swarmID: message.swarm_id, delivery: next },
      () =>
        Effect.gen(function* () {
          const updated = yield* db
            .update(SwarmMessageDeliveryTable)
            .set({
              state: "expired",
              claim_owner: null,
              claim_expires_at: null,
              next_attempt_at: null,
              error: "message expired before admission",
            })
            .where(
              and(
                eq(SwarmMessageDeliveryTable.id, row.id),
                eq(SwarmMessageDeliveryTable.state, row.state),
                eq(SwarmMessageDeliveryTable.claim_generation, row.claim_generation),
              ),
            )
            .returning({ id: SwarmMessageDeliveryTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.delivery_changed",
                reason: `Delivery ${row.id} changed before expiry committed.`,
              }),
            )
        }),
    )
    return next
  })

  const expireDueDeliveries = Effect.fn("Swarm.expireDueDeliveries")(function* (request?: {
    readonly now?: number
    readonly limit?: number
  }) {
    const now = request?.now ?? Date.now()
    const limit = Math.min(64, Math.max(1, Math.trunc(request?.limit ?? 32)))
    const rows = yield* readDb.all<{ id: Swarm.DeliveryID }>(sql`
      SELECT delivery.id AS id
      FROM swarm_message AS message INDEXED BY swarm_message_expiry_idx
      INNER JOIN swarm_message_delivery AS delivery ON delivery.message_id = message.id
      WHERE message.expires_at IS NOT NULL
        AND message.expires_at <= ${now}
        AND delivery.state IN ('pending', 'claimed')
      ORDER BY message.expires_at, delivery.id
      LIMIT ${limit}
    `).pipe(Effect.orDie)
    const expired: Swarm.Delivery[] = []
    for (const row of rows) {
      const result = yield* expireDelivery({ deliveryID: row.id, now }).pipe(Effect.exit)
      if (result._tag === "Success") expired.push(result.value)
    }
    return expired
  })

  const claimableDeliveryIDs = Effect.fn("Swarm.claimableDeliveryIDs")(function* (request?: {
    readonly now?: number
    readonly limit?: number
  }) {
    const now = request?.now ?? Date.now()
    const limit = Math.min(64, Math.max(1, Math.trunc(request?.limit ?? 32)))
    const pending = yield* readDb.all<{ id: Swarm.DeliveryID; due: number }>(sql`
      SELECT delivery.id AS id, COALESCE(delivery.next_attempt_at, delivery.time_created) AS due
      FROM swarm_message_delivery AS delivery INDEXED BY swarm_message_delivery_due_idx
      INNER JOIN swarm_message AS message ON message.id = delivery.message_id
      INNER JOIN swarm_member AS member ON member.id = delivery.recipient_member_id
      WHERE delivery.state = 'pending'
        AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= ${now})
        AND (message.expires_at IS NULL OR message.expires_at > ${now})
        AND member.lifecycle = 'active'
        AND member.session_id IS NOT NULL
      ORDER BY delivery.next_attempt_at, delivery.id
      LIMIT ${limit}
    `).pipe(Effect.orDie)
    const remaining = Math.max(0, limit - pending.length)
    const reclaimed =
      remaining === 0
        ? []
        : yield* readDb.all<{ id: Swarm.DeliveryID; due: number }>(sql`
            SELECT delivery.id AS id, delivery.claim_expires_at AS due
            FROM swarm_message_delivery AS delivery INDEXED BY swarm_message_delivery_claim_expiry_idx
            INNER JOIN swarm_message AS message ON message.id = delivery.message_id
            INNER JOIN swarm_member AS member ON member.id = delivery.recipient_member_id
            WHERE delivery.state = 'claimed'
              AND delivery.claim_expires_at <= ${now}
              AND (message.expires_at IS NULL OR message.expires_at > ${now})
              AND member.lifecycle = 'active'
              AND member.session_id IS NOT NULL
            ORDER BY delivery.claim_expires_at, delivery.id
            LIMIT ${remaining}
          `).pipe(Effect.orDie)
    return [...pending, ...reclaimed]
      .sort((a, b) => a.due - b.due || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((row) => row.id)
  })

  const enqueueMessage = Effect.fn("Swarm.enqueueMessage")(function* (request: EnqueueMessageInput) {
    if (!validMessageBody(request.body))
      return yield* new SwarmSchema.ValidationError({ reason: "Message body cannot be empty." })
    const now = request.now ?? Date.now()
    if (request.expiresAt !== undefined && request.expiresAt <= now)
      return yield* new SwarmSchema.ValidationError({ reason: "Message expiry must be in the future." })
    const members = yield* readDb
      .select()
      .from(SwarmMemberTable)
      .where(eq(SwarmMemberTable.swarm_id, request.swarmID))
      .orderBy(asc(SwarmMemberTable.id))
      .all()
      .pipe(Effect.orDie)
    const sender = members.find((member) => member.id === request.senderMemberID)
    if (!sender)
      return yield* new SwarmSchema.NotFoundError({ entity: "member", id: request.senderMemberID })
    if (sender.lifecycle === "stopping" || sender.lifecycle === "stopped")
      return yield* new SwarmSchema.ValidationError({
        reason: `Member ${request.senderMemberID} is not allowed to send while ${sender.lifecycle}.`,
      })
    if (!sender.session_id)
      return yield* new SwarmSchema.ValidationError({
        reason: `Member ${request.senderMemberID} must be Session-bound before sending peer messages.`,
      })

    let responseTo: typeof SwarmMessageTable.$inferSelect | undefined
    if (request.responseTo) responseTo = yield* requireMessageRow(readDb, request.swarmID, request.responseTo)
    if (request.kind === "response" && !responseTo)
      return yield* new SwarmSchema.ValidationError({ reason: "Response messages require responseTo." })
    if (responseTo && request.target.type !== "member")
      return yield* new SwarmSchema.ValidationError({ reason: "Replies must address one member directly." })
    if (
      responseTo &&
      request.target.type === "member" &&
      request.target.memberID !== responseTo.sender_member_id
    )
      return yield* new SwarmSchema.ValidationError({
        reason: "A reply must target the author of the referenced message.",
      })

    const expanded = expandRecipients(
      members.map((member) => ({ id: member.id, lifecycle: member.lifecycle })),
      request.senderMemberID,
      request.target,
    )
    if (!expanded.ok)
      return yield* new SwarmSchema.ValidationError({ reason: `Invalid message target: ${expanded.reason}.` })
    const messageID = Swarm.MessageID.create()
    const replyExpected =
      request.replyExpected ??
      (request.target.type === "broadcast" && canSuppressReply(request.kind) ? false : true)
    if (!replyExpected && !canSuppressReply(request.kind))
      return yield* new SwarmSchema.ValidationError({
        reason: `${request.kind} messages require a reply-capable contract.`,
      })
    if (request.taskID) yield* requireTaskRow(readDb, request.swarmID, request.taskID)
    const correlationID =
      request.correlationID ??
      responseTo?.correlation_id ??
      (responseTo ? responseTo.id : request.kind === "request" ? messageID : undefined)
    const message = Swarm.Message.make({
      id: messageID,
      swarmID: request.swarmID,
      senderMemberID: request.senderMemberID,
      senderSessionID: sender.session_id,
      senderBindingGeneration: sender.binding_generation,
      kind: request.kind,
      body: request.body.trim(),
      ...(request.taskID === undefined ? {} : { taskID: request.taskID }),
      ...(correlationID === undefined ? {} : { correlationID }),
      ...(request.responseTo === undefined ? {} : { responseTo: request.responseTo }),
      priority: request.priority ?? "normal",
      replyExpected,
      createdAt: DateTime.makeUnsafe(now),
      ...(request.expiresAt === undefined ? {} : { expiresAt: DateTime.makeUnsafe(request.expiresAt) }),
    })
    const deliveries = expanded.recipients.map((recipientMemberID) =>
      Swarm.Delivery.make({
        id: Swarm.DeliveryID.create(),
        messageID,
        recipientMemberID,
        state: "pending",
        sessionInputID: SessionMessage.ID.create(),
        claimGeneration: 0,
        nextAttemptAt: DateTime.makeUnsafe(now),
        attemptCount: 0,
      }),
    )

    yield* publishWithCommit(
      events,
      Swarm.Event.MessageCreated,
      { swarmID: request.swarmID, message, deliveries },
      () =>
        Effect.gen(function* () {
          const liveMembers = yield* db
            .select()
            .from(SwarmMemberTable)
            .where(eq(SwarmMemberTable.swarm_id, request.swarmID))
            .orderBy(asc(SwarmMemberTable.id))
            .all()
            .pipe(Effect.orDie)
          const liveSender = liveMembers.find((member) => member.id === request.senderMemberID)
          if (
            !liveSender ||
            liveSender.lifecycle === "stopping" ||
            liveSender.lifecycle === "stopped" ||
            liveSender.session_id !== message.senderSessionID ||
            liveSender.binding_generation !== message.senderBindingGeneration
          )
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.sender_changed",
                reason: "Sender membership/binding changed before message enqueue committed.",
              }),
            )
          const liveExpansion = expandRecipients(
            liveMembers.map((member) => ({ id: member.id, lifecycle: member.lifecycle })),
            request.senderMemberID,
            request.target,
          )
          if (
            !liveExpansion.ok ||
            liveExpansion.recipients.join("\0") !== expanded.recipients.join("\0")
          )
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.recipient_set_changed",
                reason: "Message recipient set changed concurrently; retry enqueue.",
              }),
            )
          if (request.taskID)
            yield* requireTaskRow(db, request.swarmID, request.taskID).pipe(
              Effect.catch((error) => commitFail(error)),
            )
          if (responseTo) {
            const original = yield* requireMessageRow(db, request.swarmID, responseTo.id).pipe(
              Effect.catch((error) => commitFail(error)),
            )
            if (
              original.sender_member_id !== responseTo.sender_member_id ||
              original.correlation_id !== responseTo.correlation_id
            )
              return yield* commitFail(
                new SwarmSchema.ConflictError({
                  code: "swarm.reply_target_changed",
                  reason: "Referenced message changed unexpectedly.",
                }),
              )
          }
          yield* db
            .insert(SwarmMessageTable)
            .values({
              id: message.id,
              swarm_id: message.swarmID,
              sender_member_id: message.senderMemberID,
              sender_session_id: message.senderSessionID,
              sender_binding_generation: message.senderBindingGeneration,
              kind: message.kind,
              body: message.body,
              task_id: message.taskID,
              correlation_id: message.correlationID,
              response_to: message.responseTo,
              priority: message.priority,
              reply_expected: message.replyExpected,
              time_created: now,
              expires_at: request.expiresAt,
            })
            .run()
            .pipe(Effect.orDie)
          if (deliveries.length > 0)
            yield* db
              .insert(SwarmMessageDeliveryTable)
              .values(
                deliveries.map((delivery) => ({
                  id: delivery.id,
                  message_id: message.id,
                  recipient_member_id: delivery.recipientMemberID,
                  state: "pending" as const,
                  session_input_id: delivery.sessionInputID,
                  claim_generation: 0,
                  next_attempt_at: now,
                  attempt_count: 0,
                  time_created: now,
                })),
              )
              .run()
              .pipe(Effect.orDie)
        }),
    )
    return { message, deliveries }
  })

  const claimDelivery = Effect.fn("Swarm.claimDelivery")(function* (request: ClaimDeliveryInput) {
    const leaseMs = positiveDuration(request.leaseMs)
    if (!leaseMs)
      return yield* new SwarmSchema.ValidationError({
        reason: "Delivery claim leaseMs must be a positive finite duration.",
      })
    const owner = request.owner.trim()
    if (!owner) return yield* new SwarmSchema.ValidationError({ reason: "Delivery claim owner is required." })
    const now = request.now ?? Date.now()
    const delivery = yield* requireDeliveryRow(readDb, request.deliveryID)
    const message = yield* readDb
      .select()
      .from(SwarmMessageTable)
      .where(eq(SwarmMessageTable.id, delivery.message_id))
      .get()
      .pipe(Effect.orDie)
    if (!message)
      return yield* new SwarmSchema.NotFoundError({ entity: "message", id: delivery.message_id })
    if (message.expires_at !== null && message.expires_at <= now)
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.message_expired",
        reason: `Message ${message.id} expired before delivery claim.`,
      })
    const recipient = yield* requireMemberRow(readDb, message.swarm_id, delivery.recipient_member_id)
    if (recipient.lifecycle !== "active" || !recipient.session_id)
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.recipient_unavailable",
        reason: `Recipient ${recipient.id} is not currently active and Session-bound.`,
      })
    const reclaim =
      delivery.state === "claimed" &&
      delivery.claim_expires_at !== null &&
      delivery.claim_expires_at <= now
    const due =
      delivery.state === "pending" &&
      (delivery.next_attempt_at === null || delivery.next_attempt_at <= now)
    if (!reclaim && !due)
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.delivery_not_claimable",
        reason: `Delivery ${request.deliveryID} is not currently claimable from state ${delivery.state}.`,
      })
    const generation = delivery.claim_generation + 1
    const result = hydrateDelivery({
      ...delivery,
      state: "claimed",
      claim_generation: generation,
      claim_owner: owner,
      claim_expires_at: now + leaseMs,
      error: null,
    })
    yield* publishWithCommit(
      events,
      Swarm.Event.DeliveryUpdated,
      { swarmID: message.swarm_id, delivery: result },
      () =>
        Effect.gen(function* () {
          const liveMember = yield* db
            .select({
              lifecycle: SwarmMemberTable.lifecycle,
              sessionID: SwarmMemberTable.session_id,
              generation: SwarmMemberTable.binding_generation,
            })
            .from(SwarmMemberTable)
            .where(
              and(
                eq(SwarmMemberTable.id, recipient.id),
                eq(SwarmMemberTable.swarm_id, message.swarm_id),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (
            !liveMember ||
            liveMember.lifecycle !== "active" ||
            !liveMember.sessionID ||
            liveMember.sessionID !== recipient.session_id ||
            liveMember.generation !== recipient.binding_generation
          )
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.recipient_changed",
                reason: `Recipient ${recipient.id} changed while delivery ${request.deliveryID} was being claimed.`,
              }),
            )
          const statePredicate = due
            ? and(
                eq(SwarmMessageDeliveryTable.state, "pending"),
                or(
                  isNull(SwarmMessageDeliveryTable.next_attempt_at),
                  lte(SwarmMessageDeliveryTable.next_attempt_at, now),
                ),
              )
            : and(
                eq(SwarmMessageDeliveryTable.state, "claimed"),
                lte(SwarmMessageDeliveryTable.claim_expires_at, now),
              )
          const changed = yield* db
            .update(SwarmMessageDeliveryTable)
            .set({
              state: "claimed",
              claim_generation: generation,
              claim_owner: owner,
              claim_expires_at: now + leaseMs,
              error: null,
            })
            .where(
              and(
                eq(SwarmMessageDeliveryTable.id, request.deliveryID),
                eq(SwarmMessageDeliveryTable.claim_generation, delivery.claim_generation),
                statePredicate,
              ),
            )
            .returning({ id: SwarmMessageDeliveryTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!changed)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.delivery_claim_raced",
                reason: `Delivery ${request.deliveryID} changed while being claimed.`,
              }),
            )
        }),
    )
    const token: DeliveryClaimToken = {
      deliveryID: result.id,
      generation,
      owner,
      recipientMemberID: recipient.id,
      recipientSessionID: recipient.session_id,
      recipientBindingGeneration: recipient.binding_generation,
    }
    return { delivery: result, message: hydrateMessage(message), token }
  })

  const releaseDelivery = Effect.fn("Swarm.releaseDelivery")(function* (request: ReleaseDeliveryInput) {
    const row = yield* requireDeliveryRow(readDb, request.token.deliveryID)
    if (!claimMatches(row, request.token))
      return yield* deliveryStale(request.token.deliveryID, request.token.generation, row.claim_generation)
    const message = yield* readDb
      .select()
      .from(SwarmMessageTable)
      .where(eq(SwarmMessageTable.id, row.message_id))
      .get()
      .pipe(Effect.orDie)
    if (!message)
      return yield* new SwarmSchema.NotFoundError({ entity: "message", id: row.message_id })
    const now = request.now ?? Date.now()
    const nextState: Swarm.DeliveryState =
      request.outcome.type === "retry" ? "pending" : request.outcome.type
    const attemptCount =
      row.attempt_count +
      (request.outcome.type === "expired" ||
      (request.outcome.type === "retry" && request.outcome.countAsAttempt === false)
        ? 0
        : 1)
    const next = hydrateDelivery({
      ...row,
      state: nextState,
      claim_owner: null,
      claim_expires_at: null,
      next_attempt_at: request.outcome.type === "retry" ? request.outcome.nextAttemptAt : null,
      attempt_count: attemptCount,
      error: request.outcome.error ?? null,
    })

    const apply = () =>
      Effect.gen(function* () {
        const updated = yield* db
          .update(SwarmMessageDeliveryTable)
          .set({
            state: nextState,
            claim_owner: null,
            claim_expires_at: null,
            next_attempt_at: request.outcome.type === "retry" ? request.outcome.nextAttemptAt : null,
            attempt_count: attemptCount,
            error: request.outcome.error ?? null,
          })
          .where(
            and(
              eq(SwarmMessageDeliveryTable.id, request.token.deliveryID),
              eq(SwarmMessageDeliveryTable.state, "claimed"),
              eq(SwarmMessageDeliveryTable.claim_generation, request.token.generation),
              eq(SwarmMessageDeliveryTable.claim_owner, request.token.owner),
            ),
          )
          .returning({ id: SwarmMessageDeliveryTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated)
          return yield* commitFail(
            new SwarmSchema.ConflictError({
              code: "swarm.delivery_changed",
              reason: `Delivery ${request.token.deliveryID} changed before release.`,
            }),
          )
      })

    yield* publishWithCommit(
      events,
      Swarm.Event.DeliveryUpdated,
      { swarmID: message.swarm_id, delivery: next },
      apply,
    )
    return next
  })

  const messages = Effect.fn("Swarm.messages")(function* (request: {
    readonly swarmID: Swarm.ID
    readonly limit?: number
  }) {
    const limit = Math.min(200, Math.max(1, Math.trunc(request.limit ?? 50)))
    const rows = yield* readDb
      .select()
      .from(SwarmMessageTable)
      .where(eq(SwarmMessageTable.swarm_id, request.swarmID))
      .orderBy(desc(SwarmMessageTable.time_created), desc(SwarmMessageTable.id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    return rows.map(hydrateMessage)
  })

  const messageHistory = Effect.fn("Swarm.messageHistory")(function* (request: {
    readonly swarmID: Swarm.ID
    readonly limit?: number
    readonly before?: MessageHistoryCursor
  }) {
    const limit = Math.min(200, Math.max(1, Math.trunc(request.limit ?? 50)))
    const cursor = request.before
    const rows = yield* readDb
      .select()
      .from(SwarmMessageTable)
      .where(
        cursor === undefined
          ? eq(SwarmMessageTable.swarm_id, request.swarmID)
          : and(
              eq(SwarmMessageTable.swarm_id, request.swarmID),
              or(
                lt(SwarmMessageTable.time_created, cursor.createdAt),
                and(eq(SwarmMessageTable.time_created, cursor.createdAt), lt(SwarmMessageTable.id, cursor.id)),
              ),
            ),
      )
      .orderBy(desc(SwarmMessageTable.time_created), desc(SwarmMessageTable.id))
      .limit(limit + 1)
      .all()
      .pipe(Effect.orDie)
    const more = rows.length > limit
    const selected = rows.slice(0, limit)
    const deliveries =
      selected.length === 0
        ? []
        : yield* readDb
            .select()
            .from(SwarmMessageDeliveryTable)
            .where(inArray(SwarmMessageDeliveryTable.message_id, selected.map((row) => row.id)))
            .orderBy(
              asc(SwarmMessageDeliveryTable.message_id),
              asc(SwarmMessageDeliveryTable.recipient_member_id),
              asc(SwarmMessageDeliveryTable.id),
            )
            .all()
            .pipe(Effect.orDie)
    const byMessage = Map.groupBy(deliveries, (delivery) => delivery.message_id)
    const last = more ? selected.at(-1) : undefined
    return {
      items: selected.map((row) => ({
        message: hydrateMessage(row),
        deliveries: (byMessage.get(row.id) ?? []).map(hydrateDelivery),
      })),
      more,
      ...(last === undefined ? {} : { next: { createdAt: last.time_created, id: last.id } }),
    } satisfies MessageHistoryPage
  })

  const deliveriesForMessage = Effect.fn("Swarm.deliveriesForMessage")(function* (messageID: Swarm.MessageID) {
    const rows = yield* readDb
      .select()
      .from(SwarmMessageDeliveryTable)
      .where(eq(SwarmMessageDeliveryTable.message_id, messageID))
      .orderBy(asc(SwarmMessageDeliveryTable.recipient_member_id))
      .all()
      .pipe(Effect.orDie)
    return rows.map(hydrateDelivery)
  })

  return {
    enqueueMessage,
    claimDelivery,
    releaseDelivery,
    expireDelivery,
    expireDueDeliveries,
    claimableDeliveryIDs,
    messages,
    messageHistory,
    deliveriesForMessage,
  }
}
