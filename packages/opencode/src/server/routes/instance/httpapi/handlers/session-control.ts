import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import * as BackgroundJobOwner from "@opencode-ai/core/background-job"
import { SessionID } from "@/session/schema"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { SessionControlApi } from "../groups/session-control"

export const sessionControlHandlers = HttpApiBuilder.group(SessionControlApi, "sessionControl", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const owner = yield* SessionExecutionOwner.Service
    const automation = yield* GoalAutomation.Service

    const abort = Effect.fn("SessionControlHttpApi.abort")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      const sessionID = ctx.params.sessionID
      const current = yield* session.get(sessionID).pipe(Effect.option)
      if (Option.isSome(current)) {
        if (SessionMetadataOwnership.isProducerOwned(current.value.metadata ?? undefined)) {
          return yield* new HttpApiError.BadRequest({})
        }

        const route = yield* WorkspaceRouteContext
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const requestedDirectory = url.searchParams.get("directory") ?? request.headers["x-opencode-directory"]
        const requestedWorkspace = url.searchParams.get("workspace")
        const sameDirectory = (left: string, right: string) =>
          Effect.try({
            try: () => FSUtil.resolve(left) === FSUtil.resolve(right),
            catch: () => new HttpApiError.BadRequest({}),
          })

        // Session.Info is the durable location authority. Reject mismatching
        // caller hints explicitly; the workspace middleware otherwise prefers
        // the session-derived location and can conceal a stale caller location.
        if (!(yield* sameDirectory(route.directory, current.value.directory))) {
          return yield* new HttpApiError.BadRequest({})
        }
        if (requestedDirectory && !(yield* sameDirectory(requestedDirectory, current.value.directory))) {
          return yield* new HttpApiError.BadRequest({})
        }
        if (requestedWorkspace && requestedWorkspace !== current.value.workspaceID) {
          return yield* new HttpApiError.BadRequest({})
        }
      }

      // The generation-CAS interrupt is the cancellation fence: it must win
      // before touching session-owned jobs so a delayed abort cannot cancel
      // work admitted by a newer run. Job cancellation then uses the live-job
      // owner index and local Runner cancellation follows only for that exact
      // generation. All three operations avoid Instance bootstrap.
      const observed = yield* owner.snapshot(sessionID)
      const interrupt = observed.ownerID
        ? yield* owner.requestInterrupt(sessionID, "operator", observed.generation)
        : { state: "idle" as const }
      if (interrupt.state === "requested") {
        const local = yield* SessionRunState.cancelActiveHandle(sessionID, interrupt.token.generation)
        if (local !== "cancelled") yield* BackgroundJobOwner.cancelOwnedBySession(sessionID)
      } else if (interrupt.state === "idle") {
        yield* BackgroundJobOwner.cancelOwnedBySession(sessionID)
      }
      if (interrupt.state === "stale") return false
      yield* automation.cancel(sessionID)
      return true
    })

    return handlers.handle("abort", abort)
  }),
)
