import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import * as CurrentParts from "@opencode-ai/core/session/current-parts"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { MessageV2 } from "@/session/message-v2"
import { overlayCurrentPartSnapshots } from "@/session/current-part-overlay"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID, SessionID } from "@/session/schema"
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

      const page = yield* SessionError.mapStorageNotFound(
        specialAgent
          ? MessageV2.currentPage({
              sessionID: ctx.params.sessionID,
              limit: ctx.query.limit,
              before: ctx.query.before,
              execution,
            }).pipe(Effect.provideService(Database.Service, readDatabase))
          : MessageV2.page({
              sessionID: ctx.params.sessionID,
              limit: ctx.query.limit,
              before: ctx.query.before,
            }).pipe(Effect.provideService(Database.Service, readDatabase)),
      )
      const items = overlayCurrentParts(page.items)
      if (!page.cursor) return items

      const request = yield* HttpServerRequest.HttpServerRequest
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
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

    return handlers
      .handle("get", get)
      .handle("children", children)
      .handle("todo", getTodo)
      .handle("messages", messages)
      .handle("message", message)
  }),
)
