import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import { EventV2 } from "../event"
import { SwarmClaims } from "./claims"
import { SwarmKnowledge } from "./knowledge"
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
  SwarmMemberTable,
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

export interface BlackboardKnowledgeInput {
  readonly swarmID: Swarm.ID
  /** Task whose assignment receives the knowledge. */
  readonly taskID?: Swarm.TaskID
  /**
   * Additional tasks whose filed knowledge is relevant to this handoff, for
   * example DAG predecessors. Knowledge filed under a task that is neither the
   * receiving task nor declared here is deliberately excluded.
   *
   * Deduplicated and capped at `SwarmKnowledge.MAX_RELATED_TASKS`; the digest
   * reports how many were dropped so a caller cannot mistake a bounded read for
   * the knowledge set it asked for.
   */
  readonly relatedTaskIDs?: ReadonlyArray<Swarm.TaskID>
  /** Clamped into `SwarmKnowledge.MAX_LIMITS`; a caller cannot uncap the read. */
  readonly limits?: Partial<SwarmKnowledge.KnowledgeLimits>
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

/**
 * Read-only conflict probe for mutation-tool boundaries.
 *
 * This is the primitive `edit`/`write`/`patch` consult to decide whether a
 * target path is already claimed by another member. It is a pure read: it takes
 * no lock, performs no write, and cannot block or deadlock. The caller owns the
 * warn-vs-deny policy and any user override.
 */
export interface ClaimConflictInput {
  readonly swarmID: Swarm.ID
  /** Durable or typed scope string; opaque scopes always report no conflicts. */
  readonly scope: string
  /** Exclude this member's own claims from the result. */
  readonly ownerMemberID?: Swarm.MemberID
  readonly now?: number
}

export interface ClaimConflict {
  readonly claim: Swarm.Claim
  readonly memberLifecycle?: Swarm.MemberLifecycle
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

function conflictError(requested: string, held: string, holderMemberID: string) {
  return new SwarmSchema.ConflictError({
    code: "swarm.claim_conflict",
    reason: `Claim ${requested} overlaps live claim ${held} held by member ${holderMemberID}.`,
  })
}

export function makeSharedStateOperations(input: {
  readonly db: Db
  readonly readDb: Db
  readonly events: EventV2.Interface
}) {
  const { db, readDb, events } = input

  /**
   * Live typed-claim conflicts for a requested scope, resolved against member
   * lifecycle. Bounded by the Swarm's claim count and one read snapshot; no
   * locks, no writes, no waiting.
   */
  const conflictingClaims = Effect.fnUntraced(function* (request: {
    readonly swarmID: Swarm.ID
    readonly scope: SwarmClaims.ClaimScope
    readonly ownerMemberID?: Swarm.MemberID
    readonly now: number
    /** Writer handle when the probe must observe the caller's own open transaction. */
    readonly txDb?: Db
  }) {
    const source = request.txDb ?? readDb
    const rows = yield* source
      .select()
      .from(SwarmClaimTable)
      .where(eq(SwarmClaimTable.swarm_id, request.swarmID))
      .all()
      .pipe(Effect.orDie)
    const ownerIDs = [...new Set(rows.map((row) => row.member_id))]
    const lifecycles = new Map<string, Swarm.MemberLifecycle>()
    if (ownerIDs.length > 0) {
      const members = yield* source
        .select({ id: SwarmMemberTable.id, lifecycle: SwarmMemberTable.lifecycle })
        .from(SwarmMemberTable)
        .where(and(eq(SwarmMemberTable.swarm_id, request.swarmID), inArray(SwarmMemberTable.id, ownerIDs)))
        .all()
        .pipe(Effect.orDie)
      for (const member of members) lifecycles.set(member.id, member.lifecycle)
    }
    const conflicts = SwarmClaims.findConflicts(
      request.scope,
      rows.map((row) => ({
        scope: row.scope,
        memberID: row.member_id,
        lifecycle: lifecycles.get(row.member_id),
        releasedAt: row.released_at,
        expiresAt: row.expires_at,
      })),
      { now: request.now, ownerMemberID: request.ownerMemberID },
    )
    const byMemberScope = new Map(rows.map((row) => [`${row.member_id}\u0000${row.scope}`, row]))
    return conflicts.map((conflict) => {
      const row = byMemberScope.get(`${conflict.memberID}\u0000${conflict.scope}`)!
      return {
        claim: hydrateClaim(row),
        memberLifecycle: conflict.lifecycle as Swarm.MemberLifecycle | undefined,
      } satisfies ClaimConflict
    })
  })

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

  /**
   * Bounded, task-relevant shared-knowledge projection.
   *
   * This is the durable owner of "what shared working knowledge does this task
   * need to start with". It reads only swarm-wide entries, entries filed under
   * the receiving task, and entries filed under caller-declared related tasks,
   * then applies a deterministic entry/byte budget. Cost is bounded in rows read
   * and bytes returned, independent of total Swarm knowledge volume.
   *
   * Provenance (`authorMemberID`, `taskID`, `version`, `updatedAt`, `scope`) is
   * carried per entry so a consumer can attribute knowledge without re-reading
   * storage. Content is peer-authored collaboration data: the projection adds
   * no host directive, and a renderer must fence it like a peer message body.
   */
  const blackboardKnowledge = Effect.fn("Swarm.blackboardKnowledge")(function* (
    request: BlackboardKnowledgeInput,
  ) {
    // A caller-supplied related-task list becomes an IN (...) predicate, so it is
    // deduplicated and bounded here rather than trusted to be small.
    const related = SwarmKnowledge.selectRelatedTasks(request.taskID, request.relatedTaskIDs)
    const scopes = [isNull(SwarmBlackboardTable.task_id)]
    if (request.taskID !== undefined) scopes.push(eq(SwarmBlackboardTable.task_id, request.taskID))
    if (related.tasks.length > 0) scopes.push(inArray(SwarmBlackboardTable.task_id, related.tasks))
    // One statement, one Swarm predicate, one hard SQL LIMIT.
    //
    // `swarm_blackboard_task_idx (swarm_id, task_id)` serves the task predicates
    // and treats `task_id IS NULL` as an equality seek, so no Session history and
    // no other Swarm's Blackboard is touched. The row cap is applied in SQL so
    // SQLite never materializes more than MAX_CANDIDATES entries for hydration.
    const rows = yield* readDb
      .select()
      .from(SwarmBlackboardTable)
      .where(and(eq(SwarmBlackboardTable.swarm_id, request.swarmID), or(...scopes)))
      .orderBy(desc(SwarmBlackboardTable.time_updated), asc(SwarmBlackboardTable.key))
      .limit(SwarmKnowledge.MAX_CANDIDATES)
      .all()
      .pipe(Effect.orDie)
    const scopeOf = (taskID: Swarm.TaskID | null): SwarmKnowledge.KnowledgeScope => {
      if (taskID === null) return "swarm"
      return taskID === request.taskID ? "task" : "related"
    }
    return SwarmKnowledge.digest({
      candidates: rows.map((row) => ({
        scope: scopeOf(row.task_id ?? null),
        updatedAt: row.time_updated,
        entry: hydrateBlackboard(row),
      })),
      limits: request.limits,
      // Conservative in the safe direction: a completely full window may be an
      // exactly complete match set, but claiming completeness we cannot prove is
      // how shared knowledge goes silently missing from a handoff.
      storageTruncated: rows.length >= SwarmKnowledge.MAX_CANDIDATES,
      droppedRelatedTasks: related.dropped,
    })
  })

  const acquireClaim = Effect.fn("Swarm.acquireClaim")(function* (request: AcquireClaimInput) {
    const scope = SwarmClaims.canonicalizeScope(request.scope)
    if (!scope) return yield* new SwarmSchema.ValidationError({ reason: "Claim scope is required." })
    const now = request.now ?? Date.now()
    if (!validExpiry(request.expiresAt, now))
      return yield* new SwarmSchema.ValidationError({ reason: "Claim expiry must be in the future." })
    const member = yield* requireMemberRow(readDb, request.swarmID, request.memberID)
    if (member.lifecycle === "stopping" || member.lifecycle === "stopped")
      return yield* new SwarmSchema.ValidationError({
        reason: `Member ${request.memberID} cannot acquire claims while ${member.lifecycle}.`,
      })
    const parsed = SwarmClaims.parseScope(scope)
    // A scope that cannot be parsed degrades to the documented opaque/advisory
    // form instead of failing the write.
    //
    // `swarm_claim.scope` is an agent-facing free-text column that predates typed
    // claims, and callers legitimately store labels that merely begin with
    // "path:" (`path-ish`, `path:src/a.ts`). Hard-rejecting those would break a
    // stable advisory surface for a purely additive feature, and it would reject
    // the durable row the caller asked for over a coordination nicety.
    //
    // Degradation is fail-safe rather than silent: an unparseable scope also
    // reports zero conflicts in `findConflicts`, so the claim protects nothing,
    // and the raw value stays visible verbatim through `claims`/`claimPage` for
    // an operator or a host that derives scopes to notice and correct it. Callers
    // that construct scopes programmatically should validate with
    // `SwarmClaims.parseScope` before calling, and fail there where the mistake
    // is actually theirs.
    const typedScope = parsed.ok && parsed.scope.kind !== "opaque" ? parsed.scope : undefined
    if (typedScope) {
      // Fast-path advisory check on a read snapshot so an obvious conflict
      // fails cheaply. This is NOT the enforcement point: the authoritative
      // re-check runs inside the writer transaction below.
      const conflicts = yield* conflictingClaims({
        swarmID: request.swarmID,
        scope: typedScope,
        ownerMemberID: request.memberID,
        now,
      })
      const first = conflicts[0]
      if (first) return yield* conflictError(scope, first.claim.scope, first.claim.memberID)
    }
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
          // Authoritative typed overlap re-check, inside the writer transaction.
          //
          // The pre-flight check above runs on a read snapshot and would
          // otherwise leave a TOCTOU window where two members both observe an
          // empty scope and both commit. This re-reads claim rows through the
          // SAME `db` writer transaction that performs the insert/update, so
          // SQLite writer serialization makes the two attempts mutually
          // exclusive: the loser's transaction observes the winner's committed
          // row and fails closed.
          //
          // This is deliberately NOT an application-level lock. Mutual exclusion
          // comes from the existing single-writer SQLite boundary, so there is
          // no hidden global mutex, no lock ordering to violate, and no
          // deadlock surface.
          if (typedScope) {
            const live = yield* conflictingClaims({
              swarmID: request.swarmID,
              scope: typedScope,
              ownerMemberID: request.memberID,
              now,
              txDb: db,
            })
            const blocking = live[0]
            if (blocking) return yield* commitFail(conflictError(scope, blocking.claim.scope, blocking.claim.memberID))
          }
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

  const claims = Effect.fn("Swarm.claims")(function* (swarmID: Swarm.ID) {    const rows = yield* readDb
      .select()
      .from(SwarmClaimTable)
      .where(eq(SwarmClaimTable.swarm_id, swarmID))
      .orderBy(asc(SwarmClaimTable.member_id), asc(SwarmClaimTable.scope))
      .all()
      .pipe(Effect.orDie)
    return rows.map(hydrateClaim)
  })

  /**
   * Read-only conflict probe for mutation-tool boundaries.
   *
   * Ownership note: this is deliberately a *pure read* against the claim
   * projection. It holds no lock, writes nothing, and cannot block, so it can
   * never deadlock a mutation path. It is also advisory-by-construction: it
   * reports the current live holders, it does not reserve the scope. A caller
   * that wants warn-vs-deny policy and user override authority must decide
   * those itself; Core deliberately does not pick warn or deny for the model.
   *
   * Note the residual race: this probe and a subsequent `acquireClaim` are two
   * separate read snapshots, so two members can still both acquire an
   * overlapping typed claim if they interleave. The claim table's
   * `(swarm_id, member_id, scope)` primary key intentionally does not serialize
   * arbitrary path prefixes, because adding a hidden global lock over path
   * ranges is exactly the failure mode this lane must avoid.
   */
  const claimConflictsFor = Effect.fn("Swarm.claimConflictsFor")(function* (request: ClaimConflictInput) {
    const now = request.now ?? Date.now()
    const parsed = SwarmClaims.parseScope(request.scope)
    if (!parsed.ok || parsed.scope.kind === "opaque") return []
    return yield* conflictingClaims({
      swarmID: request.swarmID,
      scope: parsed.scope,
      ownerMemberID: request.ownerMemberID,
      now,
    })
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
    blackboardKnowledge,
    acquireClaim,
    renewClaim,
    releaseClaim,
    claims,
    claimConflictsFor,
    claimPage,
    publishDeliverable,
    verdictDeliverable,
    deliverables,
    deliverableHistory,
  }
}
