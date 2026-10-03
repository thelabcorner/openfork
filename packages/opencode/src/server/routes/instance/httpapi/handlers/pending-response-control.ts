import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PendingResponseRegistry } from "@/server/pending-response-registry"
import { PermissionNotFoundError, QuestionNotFoundError } from "../errors"
import { PermissionControlApi } from "../groups/permission"
import { QuestionControlApi } from "../groups/question"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

function location(directory: string) {
  return FSUtil.resolve(directory)
}

const notFoundPermission = (requestID: string) =>
  new PermissionNotFoundError({ requestID, message: `Permission request not found: ${requestID}` })
const notFoundQuestion = (requestID: string) =>
  new QuestionNotFoundError({ requestID, message: `Question request not found: ${requestID}` })

export const permissionControlHandlers = HttpApiBuilder.group(PermissionControlApi, "permissionControl", (handlers) =>
  Effect.gen(function* () {
    const responses = yield* PendingResponseRegistry.Service
    return handlers
      .handle("reply", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          yield* responses
            .settle({
              kind: "permission",
              requestID: ctx.params.requestID,
              directory: location(route.directory),
              payload: { requestID: ctx.params.requestID, reply: ctx.payload.reply, message: ctx.payload.message },
            })
            .pipe(Effect.catchTag("PendingResponse.NotFoundError", () => Effect.fail(notFoundPermission(ctx.params.requestID))))
          return true
        }),
      )
      .handle("sessionReply", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          yield* responses
            .settle({
              kind: "permission",
              requestID: ctx.params.permissionID,
              sessionID: ctx.params.sessionID,
              directory: location(route.directory),
              payload: { requestID: ctx.params.permissionID, reply: ctx.payload.response },
            })
            .pipe(Effect.catchTag("PendingResponse.NotFoundError", () => Effect.fail(notFoundPermission(ctx.params.permissionID))))
          return true
        }),
      )
  }),
)

export const questionControlHandlers = HttpApiBuilder.group(QuestionControlApi, "questionControl", (handlers) =>
  Effect.gen(function* () {
    const responses = yield* PendingResponseRegistry.Service

    return handlers
      .handle("reply", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          yield* responses
            .settle({
              kind: "question",
              requestID: ctx.params.requestID,
              directory: location(route.directory),
              payload: {
                type: "reply",
                input: {
                  requestID: ctx.params.requestID,
                  answers: ctx.payload.answers,
                  details: ctx.payload.details,
                },
              },
            })
            .pipe(Effect.catchTag("PendingResponse.NotFoundError", () => Effect.fail(notFoundQuestion(ctx.params.requestID))))
          return true
        }),
      )
      .handle("reject", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          yield* responses
            .settle({
              kind: "question",
              requestID: ctx.params.requestID,
              directory: location(route.directory),
              payload: { type: "reject" },
            })
            .pipe(Effect.catchTag("PendingResponse.NotFoundError", () => Effect.fail(notFoundQuestion(ctx.params.requestID))))
          return true
        }),
      )
  }),
)
