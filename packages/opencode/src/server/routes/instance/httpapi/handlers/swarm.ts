import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmCommand } from "@/swarm/command"
import { SwarmMemberSessionWake } from "@/swarm/member-session-wake"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import { RootHttpApi } from "../api"
import * as ApiError from "../errors"
import {
  SwarmBlackboardQuery,
  SwarmClaimQuery,
  SwarmDelegatePayload,
  SwarmDeliverableQuery,
  SwarmListQuery,
  SwarmMemberAddPayload,
  SwarmMemberConfigurePayload,
  SwarmMemberLifecyclePayload,
  SwarmMessageQuery,
  SwarmRunQuery,
  SwarmTaskCreatePayload,
  SwarmTaskDependenciesPayload,
  SwarmUpdatePayload,
} from "../groups/swarm"

type SwarmApiError = ApiError.InvalidRequestError | ApiError.ApiNotFoundError | ApiError.ConflictError

const mapError = <A, R>(effect: Effect.Effect<A, SwarmV2.SwarmSchema.Error, R>): Effect.Effect<A, SwarmApiError, R> =>
  effect.pipe(
    Effect.catchTag("Swarm.NotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
    Effect.catchTag("Swarm.ValidationError", (error) =>
      Effect.fail(new ApiError.InvalidRequestError({ message: error.message, kind: "swarm_validation" })),
    ),
    Effect.catchTags({
      "Swarm.ConflictError": (error) =>
        Effect.fail(new ApiError.ConflictError({ message: error.message, code: error.code })),
      "Swarm.StaleRevisionError": (error) =>
        Effect.fail(
          new ApiError.ConflictError({
            message: error.message,
            resource: error.swarmID,
            code: "swarm_stale_revision",
          }),
        ),
      "Swarm.StaleFenceError": (error) =>
        Effect.fail(
          new ApiError.ConflictError({
            message: error.message,
            resource: error.id,
            code: "swarm_stale_fence",
          }),
        ),
      "Swarm.InvalidTransitionError": (error) =>
        Effect.fail(
          new ApiError.ConflictError({
            message: error.message,
            resource: error.id,
            code: "swarm_invalid_transition",
          }),
        ),
    }),
  )

type TimedCursor = { readonly createdAt: number; readonly id: string }
type ClaimCursor = { readonly memberID: string; readonly scope: string }
type BlackboardCursor = { readonly key: string }
type CursorValue = TimedCursor | ClaimCursor | BlackboardCursor

function invalidCursor() {
  return new ApiError.InvalidCursorError({ message: "Invalid or stale Swarm cursor; restart from the first page." })
}

function encodeCursor(kind: string, value: CursorValue) {
  return Buffer.from(JSON.stringify({ v: 1, kind, ...value }), "utf8").toString("base64url")
}

function decodeCursor(
  value: string | undefined,
  kind: string,
): Effect.Effect<Record<string, unknown> | undefined, ApiError.InvalidCursorError> {
  return Effect.suspend(() => {
    if (value === undefined) return Effect.succeed(undefined)
    return Effect.try({
      try: () => {
        if (value.length > 2048) throw new Error("cursor too large")
        const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>
        if (parsed.v !== 1 || parsed.kind !== kind) throw new Error("cursor kind mismatch")
        return parsed
      },
      catch: invalidCursor,
    })
  })
}

function decodeTimedCursor<ID extends string>(
  value: string | undefined,
  kind: "message" | "run" | "deliverable",
  makeID: (value: string) => ID,
): Effect.Effect<{ readonly createdAt: number; readonly id: ID } | undefined, ApiError.InvalidCursorError> {
  return decodeCursor(value, kind).pipe(
    Effect.flatMap((parsed) => {
      if (parsed === undefined) return Effect.succeed(undefined)
      if (!Number.isSafeInteger(parsed.createdAt) || typeof parsed.id !== "string")
        return Effect.fail(invalidCursor())
      return Effect.try({
        try: () => ({ createdAt: parsed.createdAt as number, id: makeID(parsed.id as string) }),
        catch: invalidCursor,
      })
    }),
  )
}

function decodeClaimCursor(
  value: string | undefined,
): Effect.Effect<ClaimCursor & { readonly memberID: Swarm.MemberID } | undefined, ApiError.InvalidCursorError> {
  return decodeCursor(value, "claim").pipe(
    Effect.flatMap((parsed) => {
      if (parsed === undefined) return Effect.succeed(undefined)
      if (typeof parsed.memberID !== "string" || typeof parsed.scope !== "string" || parsed.scope.length === 0)
        return Effect.fail(invalidCursor())
      return Effect.try({
        try: () => ({ memberID: Swarm.MemberID.make(parsed.memberID as string), scope: parsed.scope as string }),
        catch: invalidCursor,
      })
    }),
  )
}

function decodeBlackboardCursor(
  value: string | undefined,
): Effect.Effect<string | undefined, ApiError.InvalidCursorError> {
  return decodeCursor(value, "blackboard").pipe(
    Effect.flatMap((parsed) => {
      if (parsed === undefined) return Effect.succeed(undefined)
      if (typeof parsed.key !== "string" || parsed.key.length === 0) return Effect.fail(invalidCursor())
      return Effect.succeed(parsed.key)
    }),
  )
}

export const swarmHandlers = HttpApiBuilder.group(RootHttpApi, "swarm", (handlers) =>
  Effect.gen(function* () {
    const swarms = yield* SwarmV2.Service
    const memberWake = yield* SwarmMemberSessionWake.Service
    const profilePreflight = yield* SwarmProfilePreflight.Service

    const ensure = (swarmID: Swarm.ID) => mapError(swarms.info(swarmID))

    /**
     * Admission gate for every durable managed-worker execution profile.
     *
     * The Swarm row owns the authoritative workspace directory, so an incoming
     * profile is proven against *that* catalog rather than the caller's payload
     * or a cwd fallback. This gate is strictly read-only: it never mutates
     * Swarm state, so an unrunnable profile can neither become a durable member
     * row nor replace a previously good profile.
     *
     * Core remains the sole authority on member lifecycle/binding fences. In
     * particular this does not weaken the stopped/unbound precondition of
     * memberConfigure, and it deliberately does not inspect a member's *stored*
     * profile, so reconfiguring a member quarantined by a legacy
     * unprovable requirement stays a working operator escape hatch.
     */
    const preflightMemberProfile = Effect.fn("SwarmHttpApi.preflightMemberProfile")(function* (
      info: Swarm.Info,
      profile: Swarm.MemberExecutionProfile,
    ) {
      return yield* mapError(profilePreflight.check({ directory: info.directory, profile }))
    })

    const list = Effect.fn("SwarmHttpApi.list")((ctx: { query: typeof SwarmListQuery.Type }) =>
      swarms.summaries({
        ...(ctx.query.projectID === undefined ? {} : { projectID: ctx.query.projectID }),
        ...(ctx.query.workspaceID === undefined ? {} : { workspaceID: ctx.query.workspaceID }),
        ...(ctx.query.status === undefined ? {} : { status: ctx.query.status }),
        ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit }),
      }),
    )

    const detail = Effect.fn("SwarmHttpApi.detail")(function* (ctx: { params: { swarmID: Swarm.ID } }) {
      const [detail, dependencies] = yield* Effect.all([
        mapError(swarms.get(ctx.params.swarmID)),
        swarms.dependenciesForSwarm(ctx.params.swarmID),
      ])
      return { ...detail, dependencies }
    })

    const summary = Effect.fn("SwarmHttpApi.summary")((ctx: { params: { swarmID: Swarm.ID } }) =>
      mapError(swarms.summary(ctx.params.swarmID)),
    )

    const messages = Effect.fn("SwarmHttpApi.messages")(function* (ctx: {
      params: { swarmID: Swarm.ID }
      query: typeof SwarmMessageQuery.Type
    }) {
      yield* ensure(ctx.params.swarmID)
      const before = yield* decodeTimedCursor(ctx.query.cursor, "message", Swarm.MessageID.make)
      const page = yield* swarms.messageHistory({
        swarmID: ctx.params.swarmID,
        ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit }),
        ...(before === undefined ? {} : { before }),
      })
      return {
        items: page.items,
        more: page.more,
        ...(page.next === undefined ? {} : { nextCursor: encodeCursor("message", page.next) }),
      }
    })

    const runs = Effect.fn("SwarmHttpApi.runs")(function* (ctx: {
      params: { swarmID: Swarm.ID }
      query: typeof SwarmRunQuery.Type
    }) {
      yield* ensure(ctx.params.swarmID)
      const before = yield* decodeTimedCursor(ctx.query.cursor, "run", Swarm.TaskRunID.make)
      const page = yield* swarms.taskRunHistory({
        swarmID: ctx.params.swarmID,
        ...(ctx.query.taskID === undefined ? {} : { taskID: ctx.query.taskID }),
        ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit }),
        ...(before === undefined ? {} : { before }),
      })
      return {
        items: page.items,
        more: page.more,
        ...(page.next === undefined ? {} : { nextCursor: encodeCursor("run", page.next) }),
      }
    })

    const blackboard = Effect.fn("SwarmHttpApi.blackboard")(function* (ctx: {
      params: { swarmID: Swarm.ID }
      query: typeof SwarmBlackboardQuery.Type
    }) {
      yield* ensure(ctx.params.swarmID)
      const afterKey = yield* decodeBlackboardCursor(ctx.query.cursor)
      const page = yield* swarms.blackboardPage({
        swarmID: ctx.params.swarmID,
        ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit }),
        ...(afterKey === undefined ? {} : { afterKey }),
      })
      return {
        items: page.items,
        more: page.more,
        ...(page.nextKey === undefined ? {} : { nextCursor: encodeCursor("blackboard", { key: page.nextKey }) }),
      }
    })

    const claims = Effect.fn("SwarmHttpApi.claims")(function* (ctx: {
      params: { swarmID: Swarm.ID }
      query: typeof SwarmClaimQuery.Type
    }) {
      yield* ensure(ctx.params.swarmID)
      const after = yield* decodeClaimCursor(ctx.query.cursor)
      const page = yield* swarms.claimPage({
        swarmID: ctx.params.swarmID,
        ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit }),
        ...(after === undefined ? {} : { after }),
      })
      return {
        items: page.items,
        more: page.more,
        ...(page.next === undefined ? {} : { nextCursor: encodeCursor("claim", page.next) }),
      }
    })

    const deliverables = Effect.fn("SwarmHttpApi.deliverables")(function* (ctx: {
      params: { swarmID: Swarm.ID }
      query: typeof SwarmDeliverableQuery.Type
    }) {
      yield* ensure(ctx.params.swarmID)
      const before = yield* decodeTimedCursor(ctx.query.cursor, "deliverable", Swarm.DeliverableID.make)
      const page = yield* swarms.deliverableHistory({
        swarmID: ctx.params.swarmID,
        ...(ctx.query.memberID === undefined ? {} : { memberID: ctx.query.memberID }),
        ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit }),
        ...(before === undefined ? {} : { before }),
      })
      return {
        items: page.items,
        more: page.more,
        ...(page.next === undefined ? {} : { nextCursor: encodeCursor("deliverable", page.next) }),
      }
    })

    const delegate = Effect.fn("SwarmHttpApi.delegate")(function* (ctx: {
      payload: typeof SwarmDelegatePayload.Type
    }) {
      return yield* mapError(
        SwarmCommand.delegate(swarms, profilePreflight, {
          projectID: ctx.payload.projectID,
          ...(ctx.payload.workspaceID === undefined ? {} : { workspaceID: ctx.payload.workspaceID }),
          directory: ctx.payload.directory,
          coordinatorSessionID: ctx.payload.coordinatorSessionID,
          name: ctx.payload.name,
          ...(ctx.payload.coordinatorName === undefined ? {} : { coordinatorName: ctx.payload.coordinatorName }),
          ...(ctx.payload.coordinatorRole === undefined ? {} : { coordinatorRole: ctx.payload.coordinatorRole }),
          members: ctx.payload.members ?? [],
          tasks: ctx.payload.tasks ?? [],
        }),
      )
    })

    const update = Effect.fn("SwarmHttpApi.update")(function* (ctx: {
      params: { swarmID: Swarm.ID }
      payload: typeof SwarmUpdatePayload.Type
    }) {
      return yield* mapError(
        swarms.update({
          id: ctx.params.swarmID,
          expectedRevision: ctx.payload.expectedRevision,
          ...(ctx.payload.name === undefined ? {} : { name: ctx.payload.name }),
          ...(ctx.payload.status === undefined ? {} : { status: ctx.payload.status }),
          ...(ctx.payload.policy === undefined ? {} : { policy: ctx.payload.policy }),
        }),
      )
    })

    const memberAdd = Effect.fn("SwarmHttpApi.memberAdd")(function* (ctx: {
      params: { swarmID: Swarm.ID }
      payload: typeof SwarmMemberAddPayload.Type
    }) {
      const info = yield* ensure(ctx.params.swarmID)
      yield* preflightMemberProfile(info, ctx.payload.desiredProfile)
      return yield* mapError(
        swarms.addMember({
          swarmID: ctx.params.swarmID,
          name: ctx.payload.name,
          kind: "managed_worker",
          role: ctx.payload.role,
          desiredProfile: ctx.payload.desiredProfile,
          workspacePolicy: ctx.payload.workspacePolicy,
          ...(ctx.payload.capabilities === undefined ? {} : { capabilities: ctx.payload.capabilities }),
        }),
      )
    })

    const memberLifecycle = Effect.fn("SwarmHttpApi.memberLifecycle")(function* (ctx: {
      params: { swarmID: Swarm.ID; memberID: Swarm.MemberID }
      payload: typeof SwarmMemberLifecyclePayload.Type
    }) {
      const target = yield* mapError(swarms.memberSessionTarget(ctx.params.swarmID, ctx.params.memberID))
      if (target.member.kind === "coordinator")
        return yield* new ApiError.InvalidRequestError({
          message: "Coordinator lifecycle is controlled through Swarm state, not member lifecycle.",
          kind: "swarm_coordinator_lifecycle",
        })
      return yield* mapError(
        swarms.setMemberLifecycle({
          swarmID: ctx.params.swarmID,
          memberID: ctx.params.memberID,
          expectedLifecycle: ctx.payload.expectedLifecycle,
          lifecycle: ctx.payload.lifecycle,
        }),
      )
    })

    const memberConfigure = Effect.fn("SwarmHttpApi.memberConfigure")(function* (ctx: {
      params: { swarmID: Swarm.ID; memberID: Swarm.MemberID }
      payload: typeof SwarmMemberConfigurePayload.Type
    }) {
      const info = yield* ensure(ctx.params.swarmID)
      // Admission runs before the durable write; Core's exact stopped/unbound
      // fence then re-checks and owns that transition as before.
      yield* preflightMemberProfile(info, ctx.payload.desiredProfile)
      return yield* mapError(
        swarms.configureMember({
          swarmID: ctx.params.swarmID,
          memberID: ctx.params.memberID,
          expectedBindingGeneration: ctx.payload.expectedBindingGeneration,
          desiredProfile: ctx.payload.desiredProfile,
          workspacePolicy: ctx.payload.workspacePolicy,
          ...(ctx.payload.capabilities === undefined ? {} : { capabilities: ctx.payload.capabilities }),
        }),
      )
    })

    const taskCreate = Effect.fn("SwarmHttpApi.taskCreate")(function* (ctx: {
      params: { swarmID: Swarm.ID }
      payload: typeof SwarmTaskCreatePayload.Type
    }) {
      yield* ensure(ctx.params.swarmID)
      return yield* mapError(
        swarms.createTask({
          swarmID: ctx.params.swarmID,
          title: ctx.payload.title,
          ...(ctx.payload.description === undefined ? {} : { description: ctx.payload.description }),
          ...(ctx.payload.priority === undefined ? {} : { priority: ctx.payload.priority }),
          ...(ctx.payload.reservedMemberID === undefined ? {} : { reservedMemberID: ctx.payload.reservedMemberID }),
          ...(ctx.payload.acceptance === undefined ? {} : { acceptance: ctx.payload.acceptance }),
          ...(ctx.payload.metadata === undefined ? {} : { metadata: ctx.payload.metadata }),
          dependencies: ctx.payload.dependencies ?? [],
        }),
      )
    })

    const taskDependencies = Effect.fn("SwarmHttpApi.taskDependencies")(function* (ctx: {
      params: { swarmID: Swarm.ID; taskID: Swarm.TaskID }
      payload: typeof SwarmTaskDependenciesPayload.Type
    }) {
      return yield* mapError(
        swarms.setTaskDependencies({
          swarmID: ctx.params.swarmID,
          taskID: ctx.params.taskID,
          dependencies: ctx.payload.dependencies,
        }),
      )
    })

    const recover = Effect.fn("SwarmHttpApi.recover")(function* (ctx: {
      params: { swarmID: Swarm.ID }
    }) {
      yield* ensure(ctx.params.swarmID)
      const unresolved = (yield* swarms.unboundManagedMemberTargets({ swarmID: ctx.params.swarmID })).filter(
        (target) => target.swarm.status === "active" && target.member.lifecycle === "active",
      )
      const requested = yield* memberWake.request(ctx.params.swarmID)
      return {
        requested,
        unresolved: unresolved.map((target) => ({
          memberID: target.member.id,
          name: target.member.name,
          bindingGeneration: target.member.bindingGeneration,
        })),
      }
    })

    return handlers
      .handle("list", list)
      .handle("detail", detail)
      .handle("summary", summary)
      .handle("messages", messages)
      .handle("runs", runs)
      .handle("blackboard", blackboard)
      .handle("claims", claims)
      .handle("deliverables", deliverables)
      .handle("delegate", delegate)
      .handle("update", update)
      .handle("memberAdd", memberAdd)
      .handle("memberLifecycle", memberLifecycle)
      .handle("memberConfigure", memberConfigure)
      .handle("taskCreate", taskCreate)
      .handle("taskDependencies", taskDependencies)
      .handle("recover", recover)
  }),
)
