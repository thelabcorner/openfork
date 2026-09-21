import { and, asc, desc, eq, gt, isNull, lt, or } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import { EventV2 } from "../event"
import {
  hydrateBlackboard,
  hydrateClaim,
  hydrateDeliverable,
} from "./projection"
import {
  type Db,
  requireDeliverableRow,
  requireMemberRow,
  requireTaskRunRow,
} from "./repository"
import { SwarmSchema } from "./schema"
import {
  SwarmBlackboardTable,
  SwarmClaimTable,
  SwarmDeliverableTable,
  SwarmTaskRunTable,
  SwarmTaskTable,
} from "./sql"
import { commitFail, publishWithCommit } from "./transaction"

export interface PutBlackboardInput {
  readonly swarmID: Swarm.ID
  readonly key: string
  readonly value: Swarm.BlackboardEntry["value"]
  readonly contentType: string
  readonly authorMemberID: Swarm.MemberID
  readonly taskID?: Swarm.TaskID
  /**
   * Required for overwrite. Use 0 (or omit) only for create-if-absent.
   */
  readonly expectedVersion?: number
  readonly now?: number
}

export interface ClaimToken {
  readonly swarmID: Swarm.ID
  readonly memberID: Swarm.MemberID
  readonly scope: string
  readonly generation: number
}

export interface AcquireClaimInput {
  readonly swarmID: Swarm.ID
  readonly memberID: Swarm.MemberID
  readonly scope: string
  readonly expiresAt?: number
  readonly now?: number
}

export interface RenewClaimInput {
  readonly token: ClaimToken
  readonly expiresAt?: number
  readonly now?: number
}

export interface PublishDeliverableInput {
  readonly swarmID: Swarm.ID
  readonly memberID: Swarm.MemberID
  readonly taskRunID?: Swarm.TaskRunID
  readonly summary: string
  readonly refs?: readonly string[]
  readonly files?: readonly string[]
  readonly now?: number
}

export interface VerdictDeliverableInput {
  readonly deliverableID: Swarm.DeliverableID
  readonly reviewerMemberID: Swarm.MemberID
  readonly verdict: Swarm.DeliverableVerdict
  readonly now?: number
}

export interface DeliverableHistoryCursor {
  readonly createdAt: number
  readonly id: Swarm.DeliverableID
}

function claimStale(token: ClaimToken, actual: number) {
  return new SwarmSchema.StaleFenceError({
    fence: "claim",
    id: token.memberID + ":" + token.scope,
    expectedGeneration: token.generation,
    actualGeneration: actual,
  })
}

function validExpiry(expiresAt: number | undefined, now: number) {
  return expiresAt === undefined || (Number.isFinite(expiresAt) && expiresAt > now)
}

export function makeSharedStateOperations(input: {
  readonly db: Db
  readonly readDb: Db
  readonly events: EventV2.Interface
}) {
  const { db, readDb, events } = input

  const putBlackboard = Effect.fn("Swarm.putBlackboard")(function* (request: PutBlackboardInput) {
    const key = request.key.trim()
    if (!key) return yield* new SwarmSchema.ValidationError({ reason: "Blackboard key is required." })
    const contentType = request.contentType.trim()
    if (!contentType)
      return yield* new SwarmSchema.ValidationError({ reason: "Blackboard contentType is required." })
    const author = yield* requireMemberRow(readDb, request.swarmID, request.authorMemberID)
    if (author.lifecycle === "stopping" || author.lifecycle === "stopped")
      return yield* new SwarmSchema.ValidationError({
        reason: `Member ${request.authorMemberID} cannot write shared state while ${author.lifecycle}.`,
      })
    if (request.taskID) {
      const task = yield* readDb
        .select({ id: SwarmTaskTable.id })
        .from(SwarmTaskTable)
        .where(and(eq(SwarmTaskTable.id, request.taskID), eq(SwarmTaskTable.swarm_id, request.swarmID)))
        .get()
        .pipe(Effect.orDie)
      if (!task)
        return yield* new SwarmSchema.NotFoundError({ entity: "task", id: request.taskID })
    }
    const current = yield* readDb
      .select()
      .from(SwarmBlackboardTable)
      .where(and(eq(SwarmBlackboardTable.swarm_id, request.swarmID), eq(SwarmBlackboardTable.key, key)))
      .get()
      .pipe(Effect.orDie)
    if (current && request.expectedVersion === undefined)
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.blackboard_expected_version_required",
        reason: `Blackboard key ${key} already exists; expectedVersion is required to overwrite it.`,
      })
    if (
      (!current && request.expectedVersion !== undefined && request.expectedVersion !== 0) ||
      (current && request.expectedVersion !== current.version)
    )
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.blackboard_version_conflict",
        reason: `Blackboard key ${key} version conflict.`,
      })
    const now = request.now ?? Date.now()
    const version = (current?.version ?? 0) + 1
    const entry = Swarm.BlackboardEntry.make({
      swarmID: request.swarmID,
      key,
      value: request.value,
      contentType,
      version,
      authorMemberID: request.authorMemberID,
      ...(request.taskID === undefined ? {} : { taskID: request.taskID }),
      time: {
        created: DateTime.makeUnsafe(current?.time_created ?? now),
        updated: DateTime.makeUnsafe(now),
      },
    })
    yield* publishWithCommit(
      events,
      Swarm.Event.BlackboardUpdated,
      { swarmID: request.swarmID, entry },
      () =>
        Effect.gen(function* () {
          const liveAuthor = yield* requireMemberRow(db, request.swarmID, request.authorMemberID).pipe(
            Effect.catch((error) => commitFail(error)),
          )
          if (liveAuthor.lifecycle === "stopping" || liveAuthor.lifecycle === "stopped")
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.blackboard_author_changed",
                reason: "Blackboard author stopped before the write committed.",
              }),
            )
          if (request.taskID) {
            const task = yield* db
              .select({ id: SwarmTaskTable.id })
              .from(SwarmTaskTable)
              .where(
                and(eq(SwarmTaskTable.id, request.taskID), eq(SwarmTaskTable.swarm_id, request.swarmID)),
              )
              .get()
              .pipe(Effect.orDie)
            if (!task)
              return yield* commitFail(new SwarmSchema.NotFoundError({ entity: "task", id: request.taskID }))
          }
          const live = yield* db
            .select()
            .from(SwarmBlackboardTable)
            .where(and(eq(SwarmBlackboardTable.swarm_id, request.swarmID), eq(SwarmBlackboardTable.key, key)))
            .get()
            .pipe(Effect.orDie)
          if (!current) {
            if (live)
              return yield* commitFail(
                new SwarmSchema.ConflictError({
                  code: "swarm.blackboard_version_conflict",
                  reason: `Blackboard key ${key} was created concurrently.`,
                }),
              )
            yield* db
              .insert(SwarmBlackboardTable)
              .values({
                swarm_id: request.swarmID,
                key,
                value: request.value,
                content_type: contentType,
                version: 1,
                author_member_id: request.authorMemberID,
                task_id: request.taskID,
                time_created: now,
                time_updated: now,
              })
              .run()
              .pipe(Effect.orDie)
            return
          }
          if (!live || live.version !== request.expectedVersion)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.blackboard_version_conflict",
                reason: `Blackboard key ${key} changed concurrently.`,
              }),
            )
          const updated = yield* db
            .update(SwarmBlackboardTable)
            .set({
              value: request.value,
              content_type: contentType,
              version,
              author_member_id: request.authorMemberID,
              task_id: request.taskID ?? null,
              time_updated: now,
            })
            .where(
              and(
                eq(SwarmBlackboardTable.swarm_id, request.swarmID),
                eq(SwarmBlackboardTable.key, key),
                eq(SwarmBlackboardTable.version, request.expectedVersion!),
              ),
            )
            .returning({ version: SwarmBlackboardTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.blackboard_version_conflict",
                reason: `Blackboard key ${key} changed concurrently.`,
              }),
            )
        }),
    )
    return entry
  })

  const blackboard = Effect.fn("Swarm.blackboard")(function* (request: {
    readonly swarmID: Swarm.ID
    readonly key?: string
  }) {
    const rows = yield* readDb
      .select()
      .from(SwarmBlackboardTable)
      .where(
        request.key === undefined
          ? eq(SwarmBlackboardTable.swarm_id, request.swarmID)
          : and(eq(SwarmBlackboardTable.swarm_id, request.swarmID), eq(SwarmBlackboardTable.key, request.key)),
      )
      .orderBy(asc(SwarmBlackboardTable.key))
      .all()
      .pipe(Effect.orDie)
    return rows.map(hydrateBlackboard)
  })

  const blackboardPage = Effect.fn("Swarm.blackboardPage")(function* (request: {
    readonly swarmID: Swarm.ID
    readonly limit?: number
    readonly afterKey?: string
  }) {
    const limit = Math.min(200, Math.max(1, Math.trunc(request.limit ?? 100)))
    const rows = yield* readDb
      .select()
      .from(SwarmBlackboardTable)
      .where(
        request.afterKey === undefined
          ? eq(SwarmBlackboardTable.swarm_id, request.swarmID)
          : and(eq(SwarmBlackboardTable.swarm_id, request.swarmID), gt(SwarmBlackboardTable.key, request.afterKey)),
      )
      .orderBy(asc(SwarmBlackboardTable.key))
      .limit(limit + 1)
      .all()
      .pipe(Effect.orDie)
    const more = rows.length > limit
    const selected = rows.slice(0, limit)
    return {
      items: selected.map(hydrateBlackboard),
      more,
      ...(more && selected.length > 0 ? { nextKey: selected[selected.length - 1]!.key } : {}),
    }
  })

  const acquireClaim = Effect.fn("Swarm.acquireClaim")(function* (request: AcquireClaimInput) {
    const scope = request.scope.trim()
    if (!scope) return yield* new SwarmSchema.ValidationError({ reason: "Claim scope is required." })
    const now = request.now ?? Date.now()
    if (!validExpiry(request.expiresAt, now))
      return yield* new SwarmSchema.ValidationError({ reason: "Claim expiry must be in the future." })
    const member = yield* requireMemberRow(readDb, request.swarmID, request.memberID)
    if (member.lifecycle === "stopping" || member.lifecycle === "stopped")
      return yield* new SwarmSchema.ValidationError({
        reason: `Member ${request.memberID} cannot acquire claims while ${member.lifecycle}.`,
      })
    const current = yield* readDb
      .select()
      .from(SwarmClaimTable)
      .where(
        and(
          eq(SwarmClaimTable.swarm_id, request.swarmID),
          eq(SwarmClaimTable.member_id, request.memberID),
          eq(SwarmClaimTable.scope, scope),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    const live =
      current &&
      current.released_at === null &&
      (current.expires_at === null || current.expires_at > now)
    if (live)
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.claim_active",
        reason: `Claim ${scope} is already active for member ${request.memberID}.`,
      })
    const generation = (current?.generation ?? 0) + 1
    const claim = Swarm.Claim.make({
      swarmID: request.swarmID,
      memberID: request.memberID,
      scope,
      generation,
      ...(request.expiresAt === undefined ? {} : { expiresAt: DateTime.makeUnsafe(request.expiresAt) }),
      time: {
        created: DateTime.makeUnsafe(current?.time_created ?? now),
        updated: DateTime.makeUnsafe(now),
      },
    })
    yield* publishWithCommit(
      events,
      Swarm.Event.ClaimUpdated,
      { swarmID: request.swarmID, claim },
      () =>
        Effect.gen(function* () {
          const liveMember = yield* requireMemberRow(db, request.swarmID, request.memberID).pipe(
            Effect.catch((error) => commitFail(error)),
          )
          if (liveMember.lifecycle === "stopping" || liveMember.lifecycle === "stopped")
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.claim_member_stopped",
                reason: "Claim owner stopped before claim acquisition committed.",
              }),
            )
          const actual = yield* db
            .select()
            .from(SwarmClaimTable)
            .where(
              and(
                eq(SwarmClaimTable.swarm_id, request.swarmID),
                eq(SwarmClaimTable.member_id, request.memberID),
                eq(SwarmClaimTable.scope, scope),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (
            (current === undefined && actual !== undefined) ||
            (current !== undefined &&
              (actual === undefined ||
                actual.generation !== current.generation ||
                actual.released_at !== current.released_at ||
                actual.expires_at !== current.expires_at))
          )
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.claim_changed",
                reason: `Claim ${scope} changed concurrently.`,
              }),
            )
          if (!actual) {
            yield* db
              .insert(SwarmClaimTable)
              .values({
                swarm_id: request.swarmID,
                member_id: request.memberID,
                scope,
                generation,
                expires_at: request.expiresAt,
                released_at: null,
                time_created: now,
                time_updated: now,
              })
              .run()
              .pipe(Effect.orDie)
          } else {
            yield* db
              .update(SwarmClaimTable)
              .set({
                generation,
                expires_at: request.expiresAt ?? null,
                released_at: null,
                time_updated: now,
              })
              .where(
                and(
                  eq(SwarmClaimTable.swarm_id, request.swarmID),
                  eq(SwarmClaimTable.member_id, request.memberID),
                  eq(SwarmClaimTable.scope, scope),
                  eq(SwarmClaimTable.generation, current!.generation),
                ),
              )
              .run()
              .pipe(Effect.orDie)
          }
        }),
    )
    return { claim, token: { swarmID: request.swarmID, memberID: request.memberID, scope, generation } satisfies ClaimToken }
  })

  const renewClaim = Effect.fn("Swarm.renewClaim")(function* (request: RenewClaimInput) {
    const now = request.now ?? Date.now()
    if (!validExpiry(request.expiresAt, now))
      return yield* new SwarmSchema.ValidationError({ reason: "Claim expiry must be in the future." })
    const current = yield* readDb
      .select()
      .from(SwarmClaimTable)
      .where(
        and(
          eq(SwarmClaimTable.swarm_id, request.token.swarmID),
          eq(SwarmClaimTable.member_id, request.token.memberID),
          eq(SwarmClaimTable.scope, request.token.scope),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!current)
      return yield* new SwarmSchema.NotFoundError({
        entity: "claim",
        id: request.token.memberID + ":" + request.token.scope,
      })
    if (current.generation !== request.token.generation)
      return yield* claimStale(request.token, current.generation)
    if (current.released_at !== null)
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.claim_released",
        reason: "Released claims cannot be renewed; reacquire to obtain a new generation.",
      })
    const claim = hydrateClaim({
      ...current,
      expires_at: request.expiresAt ?? null,
      time_updated: now,
    })
    yield* publishWithCommit(
      events,
      Swarm.Event.ClaimUpdated,
      { swarmID: request.token.swarmID, claim },
      () =>
        Effect.gen(function* () {
          const updated = yield* db
            .update(SwarmClaimTable)
            .set({ expires_at: request.expiresAt ?? null, time_updated: now })
            .where(
              and(
                eq(SwarmClaimTable.swarm_id, request.token.swarmID),
                eq(SwarmClaimTable.member_id, request.token.memberID),
                eq(SwarmClaimTable.scope, request.token.scope),
                eq(SwarmClaimTable.generation, request.token.generation),
                isNull(SwarmClaimTable.released_at),
              ),
            )
            .returning({ generation: SwarmClaimTable.generation })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* commitFail(claimStale(request.token, current.generation + 1))
        }),
    )
    return claim
  })

  const releaseClaim = Effect.fn("Swarm.releaseClaim")(function* (request: {
    readonly token: ClaimToken
    readonly now?: number
  }) {
    const current = yield* readDb
      .select()
      .from(SwarmClaimTable)
      .where(
        and(
          eq(SwarmClaimTable.swarm_id, request.token.swarmID),
          eq(SwarmClaimTable.member_id, request.token.memberID),
          eq(SwarmClaimTable.scope, request.token.scope),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!current)
      return yield* new SwarmSchema.NotFoundError({
        entity: "claim",
        id: request.token.memberID + ":" + request.token.scope,
      })
    if (current.generation !== request.token.generation)
      return yield* claimStale(request.token, current.generation)
    if (current.released_at !== null) return hydrateClaim(current)
    const now = request.now ?? Date.now()
    const claim = hydrateClaim({ ...current, released_at: now, time_updated: now })
    yield* publishWithCommit(
      events,
      Swarm.Event.ClaimUpdated,
      { swarmID: request.token.swarmID, claim },
      () =>
        Effect.gen(function* () {
          const updated = yield* db
            .update(SwarmClaimTable)
            .set({ released_at: now, time_updated: now })
            .where(
              and(
                eq(SwarmClaimTable.swarm_id, request.token.swarmID),
                eq(SwarmClaimTable.member_id, request.token.memberID),
                eq(SwarmClaimTable.scope, request.token.scope),
                eq(SwarmClaimTable.generation, request.token.generation),
              ),
            )
            .returning({ releasedAt: SwarmClaimTable.released_at })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* commitFail(claimStale(request.token, current.generation + 1))
        }),
    )
    return claim
  })

  const claims = Effect.fn("Swarm.claims")(function* (swarmID: Swarm.ID) {
    const rows = yield* readDb
      .select()
      .from(SwarmClaimTable)
      .where(eq(SwarmClaimTable.swarm_id, swarmID))
      .orderBy(asc(SwarmClaimTable.member_id), asc(SwarmClaimTable.scope))
      .all()
      .pipe(Effect.orDie)
    return rows.map(hydrateClaim)
  })

  const claimPage = Effect.fn("Swarm.claimPage")(function* (request: {
    readonly swarmID: Swarm.ID
    readonly limit?: number
    readonly after?: { readonly memberID: Swarm.MemberID; readonly scope: string }
  }) {
    const limit = Math.min(200, Math.max(1, Math.trunc(request.limit ?? 100)))
    const rows = yield* readDb
      .select()
      .from(SwarmClaimTable)
      .where(
        request.after === undefined
          ? eq(SwarmClaimTable.swarm_id, request.swarmID)
          : and(
              eq(SwarmClaimTable.swarm_id, request.swarmID),
              or(
                gt(SwarmClaimTable.member_id, request.after.memberID),
                and(
                  eq(SwarmClaimTable.member_id, request.after.memberID),
                  gt(SwarmClaimTable.scope, request.after.scope),
                ),
              ),
            ),
      )
      .orderBy(asc(SwarmClaimTable.member_id), asc(SwarmClaimTable.scope))
      .limit(limit + 1)
      .all()
      .pipe(Effect.orDie)
    const more = rows.length > limit
    const selected = rows.slice(0, limit)
    const last = more ? selected.at(-1) : undefined
    return {
      items: selected.map(hydrateClaim),
      more,
      ...(last === undefined ? {} : { next: { memberID: last.member_id, scope: last.scope } }),
    }
  })

  const publishDeliverable = Effect.fn("Swarm.publishDeliverable")(function* (
    request: PublishDeliverableInput,
  ) {
    const summary = request.summary.trim()
    if (!summary)
      return yield* new SwarmSchema.ValidationError({ reason: "Deliverable summary is required." })
    const member = yield* requireMemberRow(readDb, request.swarmID, request.memberID)
    if (member.lifecycle === "stopping" || member.lifecycle === "stopped")
      return yield* new SwarmSchema.ValidationError({
        reason: `Member ${request.memberID} cannot publish deliverables while ${member.lifecycle}.`,
      })
    if (request.taskRunID) {
      const run = yield* requireTaskRunRow(readDb, request.taskRunID)
      const task = yield* readDb
        .select({ swarmID: SwarmTaskTable.swarm_id })
        .from(SwarmTaskTable)
        .where(eq(SwarmTaskTable.id, run.task_id))
        .get()
        .pipe(Effect.orDie)
      if (!task || task.swarmID !== request.swarmID)
        return yield* new SwarmSchema.ValidationError({
          reason: `Task run ${request.taskRunID} does not belong to Swarm ${request.swarmID}.`,
        })
    }
    const now = request.now ?? Date.now()
    const deliverable = Swarm.Deliverable.make({
      id: Swarm.DeliverableID.create(),
      swarmID: request.swarmID,
      memberID: request.memberID,
      ...(request.taskRunID === undefined ? {} : { taskRunID: request.taskRunID }),
      summary,
      refs: [...(request.refs ?? [])],
      files: [...(request.files ?? [])],
      createdAt: DateTime.makeUnsafe(now),
    })
    yield* publishWithCommit(
      events,
      Swarm.Event.DeliverableUpdated,
      { swarmID: request.swarmID, deliverable },
      () =>
        Effect.gen(function* () {
          const liveMember = yield* requireMemberRow(db, request.swarmID, request.memberID).pipe(
            Effect.catch((error) => commitFail(error)),
          )
          if (liveMember.lifecycle === "stopping" || liveMember.lifecycle === "stopped")
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.deliverable_member_stopped",
                reason: "Member stopped before deliverable publication committed.",
              }),
            )
          if (request.taskRunID) {
            const run = yield* requireTaskRunRow(db, request.taskRunID).pipe(
              Effect.catch((error) => commitFail(error)),
            )
            const task = yield* db
              .select({ swarmID: SwarmTaskTable.swarm_id })
              .from(SwarmTaskTable)
              .where(eq(SwarmTaskTable.id, run.task_id))
              .get()
              .pipe(Effect.orDie)
            if (!task || task.swarmID !== request.swarmID)
              return yield* commitFail(
                new SwarmSchema.ValidationError({
                  reason: `Task run ${request.taskRunID} no longer belongs to the destination Swarm.`,
                }),
              )
          }
          yield* db
            .insert(SwarmDeliverableTable)
            .values({
              id: deliverable.id,
              swarm_id: request.swarmID,
              member_id: request.memberID,
              task_run_id: request.taskRunID,
              summary,
              refs: [...(request.refs ?? [])],
              files: [...(request.files ?? [])],
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
        }),
    )
    return deliverable
  })

  const verdictDeliverable = Effect.fn("Swarm.verdictDeliverable")(function* (
    request: VerdictDeliverableInput,
  ) {
    const current = yield* requireDeliverableRow(readDb, request.deliverableID)
    if (current.verdict !== null)
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.deliverable_already_verdict",
        reason: `Deliverable ${request.deliverableID} already has verdict ${current.verdict}.`,
      })
    yield* requireMemberRow(readDb, current.swarm_id, request.reviewerMemberID)
    const now = request.now ?? Date.now()
    const deliverable = hydrateDeliverable({
      ...current,
      verdict: request.verdict,
      verdict_by_member_id: request.reviewerMemberID,
      verdict_at: now,
    })
    yield* publishWithCommit(
      events,
      Swarm.Event.DeliverableUpdated,
      { swarmID: current.swarm_id, deliverable },
      () =>
        Effect.gen(function* () {
          yield* requireMemberRow(db, current.swarm_id, request.reviewerMemberID).pipe(
            Effect.catch((error) => commitFail(error)),
          )
          const updated = yield* db
            .update(SwarmDeliverableTable)
            .set({
              verdict: request.verdict,
              verdict_by_member_id: request.reviewerMemberID,
              verdict_at: now,
            })
            .where(
              and(
                eq(SwarmDeliverableTable.id, request.deliverableID),
                isNull(SwarmDeliverableTable.verdict),
              ),
            )
            .returning({ id: SwarmDeliverableTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.deliverable_already_verdict",
                reason: `Deliverable ${request.deliverableID} received a verdict concurrently.`,
              }),
            )
        }),
    )
    return deliverable
  })

  const deliverables = Effect.fn("Swarm.deliverables")(function* (request: {
    readonly swarmID: Swarm.ID
    readonly memberID?: Swarm.MemberID
  }) {
    const rows = yield* readDb
      .select()
      .from(SwarmDeliverableTable)
      .where(
        request.memberID === undefined
          ? eq(SwarmDeliverableTable.swarm_id, request.swarmID)
          : and(
              eq(SwarmDeliverableTable.swarm_id, request.swarmID),
              eq(SwarmDeliverableTable.member_id, request.memberID),
            ),
      )
      .orderBy(asc(SwarmDeliverableTable.time_created), asc(SwarmDeliverableTable.id))
      .all()
      .pipe(Effect.orDie)
    return rows.map(hydrateDeliverable)
  })

  const deliverableHistory = Effect.fn("Swarm.deliverableHistory")(function* (request: {
    readonly swarmID: Swarm.ID
    readonly memberID?: Swarm.MemberID
    readonly limit?: number
    readonly before?: DeliverableHistoryCursor
  }) {
    const limit = Math.min(200, Math.max(1, Math.trunc(request.limit ?? 50)))
    const predicates = [eq(SwarmDeliverableTable.swarm_id, request.swarmID)]
    if (request.memberID !== undefined) predicates.push(eq(SwarmDeliverableTable.member_id, request.memberID))
    if (request.before !== undefined) {
      predicates.push(
        or(
          lt(SwarmDeliverableTable.time_created, request.before.createdAt),
          and(
            eq(SwarmDeliverableTable.time_created, request.before.createdAt),
            lt(SwarmDeliverableTable.id, request.before.id),
          ),
        )!,
      )
    }
    const rows = yield* readDb
      .select()
      .from(SwarmDeliverableTable)
      .where(and(...predicates))
      .orderBy(desc(SwarmDeliverableTable.time_created), desc(SwarmDeliverableTable.id))
      .limit(limit + 1)
      .all()
      .pipe(Effect.orDie)
    const more = rows.length > limit
    const selected = rows.slice(0, limit)
    const last = more ? selected.at(-1) : undefined
    return {
      items: selected.map(hydrateDeliverable),
      more,
      ...(last === undefined ? {} : { next: { createdAt: last.time_created, id: last.id } }),
    }
  })

  return {
    putBlackboard,
    blackboard,
    blackboardPage,
    acquireClaim,
    renewClaim,
    releaseClaim,
    claims,
    claimPage,
    publishDeliverable,
    verdictDeliverable,
    deliverables,
    deliverableHistory,
  }
}
