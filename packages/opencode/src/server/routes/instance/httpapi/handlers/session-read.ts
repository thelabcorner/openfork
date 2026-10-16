import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import * as CurrentParts from "@opencode-ai/core/session/current-parts"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { MessageV2 } from "@/session/message-v2"
import * as SessionToolOutput from "@opencode-ai/core/session/tool-output"
import * as ApiError from "../errors"
import { overlayCurrentPartSnapshots } from "@/session/current-part-overlay"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionReadApi } from "../groups/session-read"
import { SessionReadMessagesQuery } from "../groups/session-read"
import * as SessionError from "./session-errors"

export const sessionReadHandlers = HttpApiBuilder.group(SessionReadApi, "sessionRead", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const todo = yield* Todo.Service
    const currentParts = yield* CurrentParts.Service
    const database = yield* Database.Service
    const readDatabase = Database.Service.of({ ...database, db: database.readDb, readDb: database.readDb })

    const requireSession = Effect.fn("SessionReadHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const specialAgentExecution = (current: Session.Info): MessageV2.CurrentV1Execution => ({
      agent: SessionMetadataOwnership.specialAgentKind(current.metadata) ?? current.agent,
      ...(current.model
        ? {
            model: {
              providerID: current.model.providerID,
              modelID: current.model.id,
              ...(current.model.variant ? { variant: current.model.variant } : {}),
            },
          }
        : {}),
    })

    const overlayCurrentParts = (items: readonly WithParts[]): WithParts[] => {
      if (items.length === 0) return []
      const snapshots = currentParts.snapshot(
        items[0]!.info.sessionID,
        items.map((item) => item.info.id),
      )
      return overlayCurrentPartSnapshots(items, snapshots)
    }

    const get = Effect.fn("SessionReadHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionReadHttpApi.children")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const getTodo = Effect.fn("SessionReadHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todo.get(ctx.params.sessionID)
    })

    const messages = Effect.fn("SessionReadHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof SessionReadMessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(ctx.query.before!),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      const current = yield* requireSession(ctx.params.sessionID)
      const specialAgent = SessionMetadataOwnership.isSpecialAgent(current.metadata)
      const execution = specialAgent ? specialAgentExecution(current) : undefined
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        const items = yield* SessionError.mapStorageNotFound(
          specialAgent
            ? MessageV2.currentAll({ sessionID: ctx.params.sessionID, execution }).pipe(
                Effect.provideService(Database.Service, readDatabase),
              )
            : session.messages({ sessionID: ctx.params.sessionID }),
        )
        return overlayCurrentParts(items)
      }

      const pageLimit = Math.min(ctx.query.limit, MessageV2.TIMELINE_MESSAGE_PAGE_LIMIT)
      const page = yield* SessionError.mapStorageNotFound(
        specialAgent
          ? MessageV2.currentPage({
            sessionID: ctx.params.sessionID,
            limit: pageLimit,
            before: ctx.query.before,
            execution,
          }).pipe(Effect.provideService(Database.Service, readDatabase))
          : MessageV2.timelinePage({
            sessionID: ctx.params.sessionID,
            limit: pageLimit,
            before: ctx.query.before,
          }).pipe(Effect.provideService(Database.Service, readDatabase)),
      )
      const items = overlayCurrentParts(page.items)
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      const headers: Record<string, string> = {
        "Access-Control-Expose-Headers": "Link, X-Next-Cursor, X-Windowed-Messages",
      }
      if (page.cursor) {
        url.searchParams.set("limit", pageLimit.toString())
        url.searchParams.set("before", page.cursor)
        headers.Link = `<${url.toString()}>; rel="next"`
        headers["X-Next-Cursor"] = page.cursor
      }
      if (page.windowed.length > 0) headers["X-Windowed-Messages"] = JSON.stringify(page.windowed)
      return HttpServerResponse.jsonUnsafe(items, { headers })
    })

    const message = Effect.fn("SessionReadHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      const item = yield* SessionError.mapStorageNotFound(
        (SessionMetadataOwnership.isSpecialAgent(current.metadata)
          ? MessageV2.currentGet({
              sessionID: ctx.params.sessionID,
              messageID: ctx.params.messageID,
              execution: specialAgentExecution(current),
            })
          : MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID })
        ).pipe(Effect.provideService(Database.Service, readDatabase)),
      )
      return overlayCurrentParts([item])[0] ?? item
    })

    const messageParts = Effect.fn("SessionReadHttpApi.messageParts")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
      query: { cursor?: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const cursor = ctx.query.cursor
        ? yield* Effect.try({
            try: () => MessageV2.decodeInspectionPartCursor(ctx.query.cursor!),
            catch: () => new HttpApiError.BadRequest({}),
          })
        : undefined
      return yield* SessionError.mapStorageNotFound(
        MessageV2.inspectionPartsPage({
          sessionID: ctx.params.sessionID,
          messageID: ctx.params.messageID,
          cursor,
        }).pipe(Effect.provideService(Database.Service, readDatabase)),
      )
    })

    const timelineParts = Effect.fn("SessionReadHttpApi.timelineParts")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
      query: { cursor?: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.timelinePartsPage({
          sessionID: ctx.params.sessionID,
          messageID: ctx.params.messageID,
          cursor: ctx.query.cursor,
        }).pipe(Effect.provideService(Database.Service, readDatabase)),
      )
      const active = new Map(currentParts.snapshot(ctx.params.sessionID, [ctx.params.messageID]).map((part) => [part.id, part]))
      return {
        ...page,
        data: page.data.map((part) => active.get(part.id) ?? part),
      }
    })

    const timelinePartsBatch = Effect.fn("SessionReadHttpApi.timelinePartsBatch")(function* (ctx: {
      params: { sessionID: SessionID }
      query: { messageIDs: readonly MessageID[]; cursor?: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.messageIDs.length > MessageV2.TIMELINE_RECOVERY_MESSAGE_LIMIT)
        return yield* new HttpApiError.BadRequest({})
      const messageIDs = [...new Set(ctx.query.messageIDs)].sort()
      const cursor = ctx.query.cursor
        ? yield* Effect.try({
            try: () => MessageV2.decodeTimelineRecoveryBatchCursor(ctx.query.cursor!, messageIDs),
            catch: () => new HttpApiError.BadRequest({}),
          })
        : undefined
      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.timelinePartsBatchPage({ sessionID: ctx.params.sessionID, messageIDs, cursor }).pipe(
          Effect.provideService(Database.Service, readDatabase),
        ),
      )
      const active = new Map(
        currentParts.snapshot(ctx.params.sessionID, messageIDs).map((part) => [part.id, part]),
      )
      return {
        ...page,
        data: page.data.map((entry) => ({
          ...entry,
          part: active.get(entry.part.id) ?? entry.part,
        })),
      }
    })

    const toolOutput = Effect.fn("SessionReadHttpApi.toolOutput")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: import("@/session/schema").PartID }
      query: { offset?: number }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const item = yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }).pipe(
          Effect.provideService(Database.Service, readDatabase),
        ),
      )
      const part = item.parts.find((value) => value.id === ctx.params.partID)
      if (
        !part ||
        part.type !== "tool" ||
        !part.callID ||
        part.state.status === "pending" ||
        part.state.metadata?.timelineOutput !== true
      ) {
        return yield* ApiError.notFound("Durable tool output is unavailable for this tool part")
      }
      const page = yield* SessionToolOutput.page({
        sessionID: ctx.params.sessionID,
        messageID: ctx.params.messageID,
        toolCallID: part.callID,
        offset: ctx.query.offset ?? 0,
      }).pipe(Effect.provideService(Database.Service, readDatabase))
      if (!page) return yield* ApiError.notFound("Durable tool output is unavailable for this tool part")
      return page
    })

    return handlers
      .handle("get", get)
      .handle("children", children)
      .handle("todo", getTodo)
      .handle("messages", messages)
      .handle("message", message)
      .handle("messageParts", messageParts)
      .handle("timelineParts", timelineParts)
      .handle("timelinePartsBatch", timelinePartsBatch)
      .handle("toolOutput", toolOutput)
  }),
)
