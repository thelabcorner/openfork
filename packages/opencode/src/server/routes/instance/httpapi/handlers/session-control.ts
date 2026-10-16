import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { Database } from "@opencode-ai/core/database/database"
import { SessionLimitRecovery } from "@opencode-ai/core/session/limit-recovery"
import { SessionLimitRecovery as RecoveryEvent } from "@opencode-ai/schema/session-limit-recovery"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionOperatorRecovery } from "@/session/operator-stop"
import { SessionStatus } from "@/session/status"
import * as BackgroundJobOwner from "@opencode-ai/core/background-job"
import { SessionID } from "@/session/schema"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { SessionControlApi } from "../groups/session-control"

// SDK directory headers are URI-encoded (packages/sdk/js/src/client.ts encodes
// with `encodeURIComponent`), while query parameters are already decoded by
// URLSearchParams. Decoding mirrors middleware/workspace-routing.ts so the
// bootstrap-free control path and the routed path agree on the same contract.
function decodeDirectoryHint(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const sessionControlHandlers = HttpApiBuilder.group(SessionControlApi, "sessionControl", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const owner = yield* SessionExecutionOwner.Service
    const automation = yield* GoalAutomation.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const status = yield* SessionStatus.Service
    const operatorRecovery = yield* SessionOperatorRecovery.Service

    const abort = Effect.fn("SessionControlHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      const sessionID = ctx.params.sessionID
      const current = yield* session.get(sessionID).pipe(Effect.option)
      if (Option.isSome(current)) {
        if (
          SessionMetadataOwnership.isProducerOwned(current.value.metadata ?? undefined) &&
          !SessionMetadataOwnership.isHumanControllableWorker(current.value.metadata ?? undefined)
        ) {
          return yield* new HttpApiError.BadRequest({})
        }

        const route = yield* WorkspaceRouteContext
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        // A directory hint has more than one legitimate spelling. Query parameters
        // arrive already decoded by URLSearchParams and stay a single candidate.
        // The SDK URI-encodes `x-opencode-directory`, but a directory whose own
        // name contains a valid percent escape ("foo%20bar") is indistinguishable
        // from an encoded one, so the header is compared as two candidates: the
        // raw value and its safe decode. A malformed escape falls back to the raw
        // value so a bad header cannot turn into an unhandled failure. Neither
        // spelling is ever used to route or bootstrap; Session.Info stays the
        // authority for where this session actually lives.
        const queryDirectory = url.searchParams.get("directory")
        const headerDirectory = request.headers["x-opencode-directory"]
        const directoryHints = queryDirectory
          ? [queryDirectory]
          : headerDirectory
            ? [headerDirectory, decodeDirectoryHint(headerDirectory)]
            : []
        const requestedWorkspace = url.searchParams.get("workspace")
        const sameDirectory = (left: string, right: string) =>
          Effect.try({
            try: () => FSUtil.resolve(left) === FSUtil.resolve(right),
            catch: () => new HttpApiError.BadRequest({}),
          })
        // Hint matching must never fail the request by itself: an unresolvable
        // spelling is simply a non-match, and the fence below rejects the hint.
        const hintMatches = (hint: string, directory: string) => {
          try {
            return FSUtil.resolve(hint) === FSUtil.resolve(directory)
          } catch {
            return false
          }
        }

        // Session.Info is the durable location authority. Reject mismatching
        // caller hints explicitly; the workspace middleware otherwise prefers
        // the session-derived location and can conceal a stale caller location.
        if (!(yield* sameDirectory(route.directory, current.value.directory))) {
          return yield* new HttpApiError.BadRequest({})
        }
        if (directoryHints.length > 0 && !directoryHints.some((hint) => hintMatches(hint, current.value.directory))) {
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
       // Take a process-local admission cutoff before any awaited DB/control
       // operation. Once we know the exact observed generation, this Stop may
       // cancel only jobs admitted before this point. A newer Session turn
       // arriving while Stop is waiting for SQLite cannot be collateral damage.
       const jobCutoff = BackgroundJobOwner.captureSessionJobCancellationCutoff()
       const recovery = yield* SessionLimitRecovery.get(db, sessionID)
      const observed = yield* owner.snapshot(sessionID)
      const interrupt = observed.ownerID
        ? yield* owner.requestInterrupt(sessionID, "operator", observed.generation)
        : { state: "idle" as const }
      if (interrupt.state === "requested") {
        const local = yield* SessionRunState.cancelActiveHandle(sessionID, interrupt.token.generation)
        if (local !== "cancelled") {
          yield* BackgroundJobOwner.cancelOwnedBySession(sessionID, Effect.void, jobCutoff)
          const recovered = yield* operatorRecovery.recover(sessionID, interrupt.token.generation)
          if (recovered === "uncontained" || recovered === "stale" || recovered === "live") return false
        }
      } else if (interrupt.state === "idle") {
           yield* BackgroundJobOwner.cancelOwnedBySession(sessionID, Effect.void, jobCutoff)
        const hazards = yield* SessionRecovery.executionHazards(db, sessionID)
        if (hazards.currentTool || hazards.legacyTool) {
          const recovered = yield* operatorRecovery.recover(sessionID, observed.generation)
          if (recovered === "uncontained" || recovered === "stale") return false
        }
      }
      if (interrupt.state === "stale") return false
      // A durable interrupt request is not proof the live Runner stopped.
      // Do not return a false successful Stop while the observed generation
      // still owns execution (including the live-owner/no-local-handle case).
      const after = yield* owner.snapshot(sessionID)
      if (
        observed.ownerID &&
        after.ownerID === observed.ownerID &&
        after.generation === observed.generation
      ) {
        yield* Effect.logWarning("Session Stop left the observed execution generation owned", {
          sessionID,
          generation: observed.generation,
        })
        return false
      }
      yield* automation.cancel(sessionID)
      // Revoke only the recovery generation observed by this Stop. A newer
      // failure/admission must not be erased by a delayed operator request.
      if (recovery && (yield* SessionLimitRecovery.cancel(db, { sessionID, generation: recovery.generation }))) {
        yield* events.publish(RecoveryEvent.Cleared, { sessionID, generation: recovery.generation })
      }
      return true
    })

    return handlers.handle("abort", abort)
  }),
)
