import { SessionLimitRecovery } from "@opencode-ai/schema/session-limit-recovery"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"
import { ApiNotFoundError, ConflictError } from "../errors"

const root = "/session/:sessionID/limit-recovery"

export const SessionLimitRecoveryPaths = {
  get: root,
  autoResume: `${root}/auto-resume`,
  resume: `${root}/resume`,
  snooze: `${root}/snooze-until-reset`,
  wake: `${root}/wake`,
  cancel: root,
} as const

const Generation = Schema.Struct({ generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
const AutoResumePayload = Schema.Struct({ ...Generation.fields, enabled: Schema.Boolean })

export const SessionLimitRecoveryApi = HttpApi.make("session-limit-recovery").add(
  HttpApiGroup.make("sessionLimitRecovery")
    .add(
      HttpApiEndpoint.get("get", SessionLimitRecoveryPaths.get, {
        params: { sessionID: SessionID },
        success: described(Schema.NullOr(SessionLimitRecovery.Info), "Current session limit recovery"),
        error: ApiNotFoundError,
      }),
      HttpApiEndpoint.patch("autoResume", SessionLimitRecoveryPaths.autoResume, {
        params: { sessionID: SessionID },
        payload: AutoResumePayload,
        success: described(SessionLimitRecovery.Info, "Updated recovery settings"),
        error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
      }),
      HttpApiEndpoint.post("resume", SessionLimitRecoveryPaths.resume, {
        params: { sessionID: SessionID },
        payload: Generation,
        success: described(SessionLimitRecovery.Info, "Requested immediate manual recovery"),
        error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
      }),
      HttpApiEndpoint.post("snooze", SessionLimitRecoveryPaths.snooze, {
        params: { sessionID: SessionID },
        payload: Generation,
        success: described(SessionLimitRecovery.Info, "Snoozed session until its reset"),
        error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
      }),
      HttpApiEndpoint.post("wake", SessionLimitRecoveryPaths.wake, {
        params: { sessionID: SessionID },
        payload: Generation,
        success: described(SessionLimitRecovery.Info, "Cleared recovery snooze"),
        error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
      }),
      HttpApiEndpoint.delete("cancel", SessionLimitRecoveryPaths.cancel, {
        params: { sessionID: SessionID },
        payload: Generation,
        success: described(HttpApiSchema.NoContent, "Cancelled session recovery"),
        error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
      }),
    )
    .annotateMerge(OpenApi.annotations({ title: "sessionLimitRecovery", description: "Bootstrap-free session limit recovery controls." }))
    .middleware(Authorization),
)
