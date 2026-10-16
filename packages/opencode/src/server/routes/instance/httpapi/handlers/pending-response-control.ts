import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PendingResponseRegistry } from "@/server/pending-response-registry"
import { PermissionNotFoundError, QuestionNotFoundError } from "../errors"
import { PermissionControlApi } from "../groups/permission"
import { QuestionControlApi } from "../groups/question"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import * as AutoAcceptPolicy from "@/permission/auto-accept-policy"
import { HttpApiError } from "effect/unstable/httpapi"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Session } from "@/session/session"
import { HttpServerRequest } from "effect/unstable/http"

function location(directory: string) {
  return FSUtil.resolve(directory)
}

// A raw directory containing %2F and an SDK-encoded header are ambiguous.
// Match either spelling against the active request owner, never use it to
// initialize a workspace or override an explicit query/workspace location.
const responseLocation = Effect.gen(function* () {
  const route = yield* WorkspaceRouteContext
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, "http://localhost")
  const directory = location(route.directory)
  const header = request.headers["x-opencode-directory"]
  if (!header || url.searchParams.has("directory") || url.searchParams.has("workspace") || route.workspaceID)
    return { directory }
  try {
    if (location(decodeURIComponent(header)) !== directory) return { directory }
    return { directory, directoryCandidates: [location(header)] }
  } catch {
    return { directory }
  }
})

const notFoundPermission = (requestID: string) =>
  new PermissionNotFoundError({ requestID, message: `Permission request not found: ${requestID}` })
const notFoundQuestion = (requestID: string) =>
  new QuestionNotFoundError({ requestID, message: `Question request not found: ${requestID}` })

export const permissionControlHandlers = HttpApiBuilder.group(PermissionControlApi, "permissionControl", (handlers) =>
  Effect.gen(function* () {
    const responses = yield* PendingResponseRegistry.Service
    const sessions = yield* Session.Service
    return handlers
      .handle("autoAcceptPolicy", (ctx) =>
        Effect.gen(function* () {
          const route = yield* WorkspaceRouteContext
          if (!ctx.query.directory) return yield* new HttpApiError.BadRequest({})
          const policy = yield* Effect.promise(() =>
            AutoAcceptPolicy.update(route.directory, ctx.payload.autoAccept, ctx.payload.mode),
          ).pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
          const pending = yield* responses.list({ kind: "permission", directory: location(route.directory) })
          for (const request of pending as ReadonlyArray<PermissionV1.Request>) {
            const lineage: string[] = []
            const seen = new Set<string>()
            let current: PermissionV1.Request["sessionID"] | undefined = request.sessionID
            while (current && !seen.has(current)) {
              seen.add(current)
              const info: Option.Option<Session.Info> = yield* sessions.get(current).pipe(Effect.option)
              if (Option.isNone(info)) break
              lineage.push(current)
              current = info.value.parentID
            }
            if (!AutoAcceptPolicy.acceptsLineage({ current: policy }, lineage, "*")) continue
            yield* responses
              .settle({
                kind: "permission",
                requestID: request.id,
                sessionID: request.sessionID,
                directory: location(route.directory),
                payload: { requestID: request.id, reply: "once" },
              })
              .pipe(Effect.ignore)
          }
          return true
        }),
      )
      .handle("reply", (ctx) =>
        Effect.gen(function* () {
          const scope = yield* responseLocation
          yield* responses
            .settle({
              kind: "permission",
              requestID: ctx.params.requestID,
              ...scope,
              payload: { requestID: ctx.params.requestID, reply: ctx.payload.reply, message: ctx.payload.message },
            })
            .pipe(
              Effect.catchTag("PendingResponse.NotFoundError", () =>
                Effect.fail(notFoundPermission(ctx.params.requestID)),
              ),
            )
          return true
        }),
      )
      .handle("sessionReply", (ctx) =>
        Effect.gen(function* () {
          const scope = yield* responseLocation
          yield* responses
            .settle({
              kind: "permission",
              requestID: ctx.params.permissionID,
              sessionID: ctx.params.sessionID,
              ...scope,
              payload: { requestID: ctx.params.permissionID, reply: ctx.payload.response },
            })
            .pipe(
              Effect.catchTag("PendingResponse.NotFoundError", () =>
                Effect.fail(notFoundPermission(ctx.params.permissionID)),
              ),
            )
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
          const scope = yield* responseLocation
          yield* responses
            .settle({
              kind: "question",
              requestID: ctx.params.requestID,
              ...scope,
              payload: {
                type: "reply",
                input: {
                  requestID: ctx.params.requestID,
                  answers: ctx.payload.answers,
                  details: ctx.payload.details,
                },
              },
            })
            .pipe(
              Effect.catchTag("PendingResponse.NotFoundError", () =>
                Effect.fail(notFoundQuestion(ctx.params.requestID)),
              ),
            )
          return true
        }),
      )
      .handle("reject", (ctx) =>
        Effect.gen(function* () {
          const scope = yield* responseLocation
          yield* responses
            .settle({
              kind: "question",
              requestID: ctx.params.requestID,
              ...scope,
              payload: { type: "reject" },
            })
            .pipe(
              Effect.catchTag("PendingResponse.NotFoundError", () =>
                Effect.fail(notFoundQuestion(ctx.params.requestID)),
              ),
            )
          return true
        }),
      )
  }),
)
