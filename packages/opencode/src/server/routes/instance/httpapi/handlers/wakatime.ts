import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { RootHttpApi } from "../api"
import { ApiWakaTimeSettingsError, WakaTimeUpdatePayload } from "../groups/wakatime"

/**
 * Tier-0 WakaTime control surface.
 *
 * The process-global exporter lives in Core, so this handler is a thin
 * transport adapter: it yields `WakaTime.Service` once at layer construction
 * (never per request, never through InstanceStore) and exposes only the two
 * facts a settings surface needs. Enablement mutation authority stays in Core;
 * nothing here stores, accepts, or echoes credential material.
 */
export const wakatimeHandlers = HttpApiBuilder.group(RootHttpApi, "wakatime", (handlers) =>
  Effect.gen(function* () {
    const wakatime = yield* WakaTime.Service

    const update = Effect.fn("WakaTimeHttpApi.update")(function* (ctx: {
      payload: typeof WakaTimeUpdatePayload.Type
    }) {
      return yield* wakatime.setEnabled(ctx.payload.enabled).pipe(
        Effect.mapError((error) => new ApiWakaTimeSettingsError({ message: error.message })),
      )
    })

    return handlers.handle("status", () => wakatime.status()).handle("update", update)
  }),
)
