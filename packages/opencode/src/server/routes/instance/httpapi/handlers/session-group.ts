import { SessionGroup } from "@/session/group"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CreatePayload,
  RenamePayload,
  ReorderPayload,
  AddSessionPayload,
  ResolvePayload,
  ReorderMembersPayload,
  PolicyPayload,
  RemoveQuery,
  RemoveSessionQuery,
} from "../groups/session-group"
import * as SessionError from "./session-errors"
import * as ApiError from "../errors"

export const sessionGroupHandlers = HttpApiBuilder.group(InstanceHttpApi, "session-group", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* SessionGroup.Service

    const list = Effect.fn("SessionGroupHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const listDetails = Effect.fn("SessionGroupHttpApi.listDetails")(function* () {
      return yield* svc.listWithSessions()
    })

    const create = Effect.fn("SessionGroupHttpApi.create")(function* (ctx: { payload: typeof CreatePayload.Type }) {
      return yield* svc.create({
        name: ctx.payload.name,
        kind: ctx.payload.kind,
        anchorSessionId: ctx.payload.anchorSessionID,
        ownerPlugin: ctx.payload.ownerPlugin,
        policy: ctx.payload.policy,
      })
    })

    const get = Effect.fn("SessionGroupHttpApi.get")(function* (ctx: { params: { groupID: SessionGroup.ID } }) {
      return yield* SessionError.mapStorageNotFound(svc.getWithSessions(ctx.params.groupID))
    })

    const rename = Effect.fn("SessionGroupHttpApi.rename")(function* (ctx: {
      params: { groupID: SessionGroup.ID }
      payload: typeof RenamePayload.Type
    }) {
      yield* SessionError.mapStorageNotFound(svc.rename({ id: ctx.params.groupID, name: ctx.payload.name }))
      return HttpApiSchema.NoContent.make()
    })

    const remove = Effect.fn("SessionGroupHttpApi.remove")(function* (ctx: {
      params: { groupID: SessionGroup.ID }
      query: typeof RemoveQuery.Type
    }) {
      yield* svc.remove(ctx.params.groupID, ctx.query).pipe(
        Effect.catchTag("NotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
        Effect.catchTags({
          SessionGroupHasLockedMembersError: (error) =>
            Effect.fail(new ApiError.ConflictError({ message: error.message, code: error.code })),
          SessionGroupOwnerMismatchError: (error) =>
            Effect.fail(new ApiError.ConflictError({ message: error.message, code: error.code })),
        }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const reorder = Effect.fn("SessionGroupHttpApi.reorder")(function* (ctx: {
      params: { groupID: SessionGroup.ID }
      payload: typeof ReorderPayload.Type
    }) {
      yield* SessionError.mapStorageNotFound(svc.reorder({ id: ctx.params.groupID, position: ctx.payload.position }))
      return HttpApiSchema.NoContent.make()
    })

    const addSession = Effect.fn("SessionGroupHttpApi.addSession")(function* (ctx: {
      params: { groupID: SessionGroup.ID }
      payload: typeof AddSessionPayload.Type
    }) {
      yield* SessionError.mapStorageNotFound(
        svc.addSession({
          groupId: ctx.params.groupID,
          sessionId: ctx.payload.sessionId,
          locked: ctx.payload.locked,
          origin: ctx.payload.origin,
          originPlugin: ctx.payload.originPlugin,
          originRef: ctx.payload.originRef,
        }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const removeSession = Effect.fn("SessionGroupHttpApi.removeSession")(function* (ctx: {
      params: { groupID: SessionGroup.ID; sessionID: string }
      query: typeof RemoveSessionQuery.Type
    }) {
      yield* svc
        .removeSession({
          groupId: ctx.params.groupID,
          sessionId: ctx.params.sessionID,
          ownerPlugin: ctx.query.ownerPlugin,
        })
        .pipe(
          Effect.catchTag("NotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
          Effect.catchTags({
            SessionGroupMemberLockedError: (error) =>
              Effect.fail(new ApiError.ConflictError({ message: error.message, code: error.code })),
            SessionGroupOwnerMismatchError: (error) =>
              Effect.fail(new ApiError.ConflictError({ message: error.message, code: error.code })),
          }),
        )
      return HttpApiSchema.NoContent.make()
    })

    const capabilities = Effect.fn("SessionGroupHttpApi.capabilities")(function* () {
      return yield* svc.capabilities()
    })

    const forSession = Effect.fn("SessionGroupHttpApi.forSession")(function* (ctx: { params: { sessionID: string } }) {
      return yield* svc.membershipsFor(ctx.params.sessionID)
    })

    const resolve = Effect.fn("SessionGroupHttpApi.resolve")(function* (ctx: { payload: typeof ResolvePayload.Type }) {
      return yield* svc.resolveOrCreate({
        name: ctx.payload.name,
        kind: ctx.payload.kind,
        anchorSessionId: ctx.payload.anchorSessionID,
        ownerPlugin: ctx.payload.ownerPlugin,
        policy: ctx.payload.policy,
      })
    })

    const reorderMembers = Effect.fn("SessionGroupHttpApi.reorderMembers")(function* (ctx: {
      params: { groupID: SessionGroup.ID }
      payload: typeof ReorderMembersPayload.Type
    }) {
      yield* SessionError.mapStorageNotFound(
        svc.reorderMembers({ id: ctx.params.groupID, sessionIds: [...ctx.payload.sessionIds] }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const setPolicy = Effect.fn("SessionGroupHttpApi.setPolicy")(function* (ctx: {
      params: { groupID: SessionGroup.ID }
      payload: typeof PolicyPayload.Type
    }) {
      yield* SessionError.mapStorageNotFound(svc.setPolicy({ id: ctx.params.groupID, policy: ctx.payload }))
      return HttpApiSchema.NoContent.make()
    })

    return handlers
      .handle("list", list)
      .handle("listDetails", listDetails)
      .handle("create", create)
      .handle("get", get)
      .handle("rename", rename)
      .handle("remove", remove)
      .handle("reorder", reorder)
      .handle("addSession", addSession)
      .handle("removeSession", removeSession)
      .handle("capabilities", capabilities)
      .handle("forSession", forSession)
      .handle("resolve", resolve)
      .handle("reorderMembers", reorderMembers)
      .handle("setPolicy", setPolicy)
  }),
)
