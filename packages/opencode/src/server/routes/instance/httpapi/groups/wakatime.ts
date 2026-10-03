import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { Authorization } from "../middleware/authorization"

export const WakaTimePaths = {
  status: "/global/wakatime",
} as const

/**
 * Browser-safe projection of the process-global Core WakaTime exporter status.
 *
 * This mirrors `WakaTime.Status` exactly: an opt-in flag, whether
 * authentication material resolves, and the already-resolved CLI plus how it
 * was found. It deliberately carries no secret, no queue depth, and no
 * last-send/error telemetry, because Core does not expose those facts and a
 * settings surface must not invent them.
 */
export const WakaTimeStatus = Schema.Struct({
  enabled: Schema.Boolean,
  configured: Schema.Boolean,
  cli: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["override", "system", "managed"])),
})
  .annotate({ identifier: "WakaTimeStatus" })
  .annotate({ description: "Process-global WakaTime exporter status without secret material." })

export const WakaTimeUpdatePayload = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({ identifier: "WakaTimeUpdatePayload" })

/**
 * Core owns the opt-in mutation. Enabling can fail while Core transactionally
 * prepares a usable CLI or while it persists the opt-in, so either failure is a
 * 500: the request was well-formed and the requested enablement was not applied.
 * The message is Core's own and never carries settings content.
 */
export class ApiWakaTimeSettingsError extends Schema.ErrorClass<ApiWakaTimeSettingsError>("WakaTimeSettingsError")(
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export const WakaTimeApi = HttpApi.make("wakatime").add(
  HttpApiGroup.make("wakatime")
    .add(
      HttpApiEndpoint.get("status", WakaTimePaths.status, {
        success: described(WakaTimeStatus, "Current WakaTime opt-in and configuration status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wakatime.status",
          summary: "Get WakaTime status",
          description:
            "Read the process-global WakaTime exporter status: the effective opt-in, whether authentication material resolves, and the already-resolved CLI plus its source. Never resolves a download, never returns secret material, and never materializes a workspace instance.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.patch("update", WakaTimePaths.status, {
        payload: WakaTimeUpdatePayload,
        success: described(WakaTimeStatus, "Updated WakaTime opt-in status"),
        error: [ApiWakaTimeSettingsError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wakatime.update",
          summary: "Update WakaTime opt-in",
          description:
            "Update the WakaTime opt-in through the Core exporter that owns it. Unless an operator override forces WakaTime off, enabling first prepares or reuses a usable CLI and persists the opt-in only after that succeeds; disabling requires no CLI preparation. Returns the resulting effective status. Tier-0 global operation; never requires a workspace instance.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({
        title: "wakatime",
        description: "Tier-0 process-global WakaTime opt-in exporter control.",
      }),
    ),
)
