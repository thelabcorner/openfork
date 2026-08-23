import { SessionGroup } from "@/session/group"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { CreatePayload, RenamePayload, ReorderPayload, AddSessionPayload } from "../groups/session-group"
import * as SessionError from "./session-errors"

export const sessionGroupHandlers = HttpApiBuilder.group(InstanceHttpApi, "session-group", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* SessionGroup.Service

    const list = Effect.fn("SessionGroupHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const listDetails = Effect.fn("SessionGroupHttpApi.listDetails")(function* () {
      return yield* svc.listWithSessions()
    })

    const create = Effect.fn("SessionGroupHttpApi.create")(function* (ctx: {
      payload: typeof CreatePayload.Type
    }) {
      return yield* svc.create(ctx.payload)
    })

    const get = Effect.fn("SessionGroupHttpApi.get")(function* (ctx: {
      params: { groupID: SessionGroup.ID }
    }) {
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
    }) {
      yield* SessionError.mapStorageNotFound(svc.remove(ctx.params.groupID))
      return HttpApiSchema.NoContent.make()
    })

    const reorder = Effect.fn("SessionGroupHttpApi.reorder")(function* (ctx: {
      params: { groupID: SessionGroup.ID }
      payload: typeof ReorderPayload.Type
    }) {
      yield* SessionError.mapStorageNotFound(
        svc.reorder({ id: ctx.params.groupID, position: ctx.payload.position }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const addSession = Effect.fn("SessionGroupHttpApi.addSession")(function* (ctx: {
      params: { groupID: SessionGroup.ID }
      payload: typeof AddSessionPayload.Type
    }) {
      yield* SessionError.mapStorageNotFound(
        svc.addSession({ groupId: ctx.params.groupID, sessionId: ctx.payload.sessionId }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const removeSession = Effect.fn("SessionGroupHttpApi.removeSession")(function* (ctx: {
      params: { groupID: SessionGroup.ID; sessionID: string }
    }) {
      yield* SessionError.mapStorageNotFound(
        svc.removeSession({ groupId: ctx.params.groupID, sessionId: ctx.params.sessionID }),
      )
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
  }),
)
