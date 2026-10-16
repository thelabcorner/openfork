import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Usage } from "@/usage/usage"
import { UsageInspectionContract } from "@/usage/inspection-contract"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { ContextOccupancy } from "@opencode-ai/core/session/context-occupancy"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"
import { OxpSupervision } from "./supervision"

/**
 * Session-scoped OXP projection of the same native @usage action.
 *
 * Usage's durable service and native tool execution stay authoritative. OXP
 * does not invent a native Tool.Context, access arbitrary session IDs, or
 * silently turn root-scoped filesystem read into permission for global
 * cross-project financial/usage analytics.
 */
export const Parameters = Schema.Struct({
  action: Schema.Literal("context"),
  sessionID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  rootID: Schema.optional(OxpSchema.RootID),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/OxpUsage") {}
export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const usage = yield* Usage.Service
    const supervision = yield* OxpSupervision.Service
    const authority = yield* OxpAuthority.Service
    const telemetry = yield* SessionTelemetry.Service

    const execute: Interface["execute"] = Effect.fn("OxpUsage.execute")(function* (input, signal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "Usage inspection cancelled" })
      // Resolve and authorize before touching analytics: a sessionID is not
      // an independent database read capability.
      const target = yield* supervision.resolve(input.sessionID, "session.get", input.rootID)
      const history = yield* usage.sessionContext(target.row.id)
      const result = UsageInspectionContract.projectSessionContext(target.row.id, history)
      // Use the same bootstrap-free, bounded producer projection as the native
      // Context pane. Read once, only after Session-specific admission.
      const snapshot = history ? (yield* telemetry.snapshot([target.row.id]))[target.row.id] : undefined
      const footprint = history
        ? ContextOccupancy.project({ history: { latest: history.latest }, telemetry: snapshot })
        : undefined
      const source = footprint
        ? snapshot?.context
          ? "latest-settled-telemetry"
          : "latest-settled-history"
        : "not-available"
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "Usage inspection cancelled" })
      yield* authority.revalidate(target.admission, "egress")

      // Latest settled provider footprint is observable, but an in-flight
      // request's eventual context occupancy is not.
      const view = {
        ...result.data,
        source: "durable-usage" as const,
        settledContext: footprint ?? null,
        contextWindowUtilization: footprint?.usage ?? null,
        contextWindowUtilizationSource: source,
        liveContextWindowUtilization: null,
        liveContextWindowUtilizationSource: "not-available" as const,
      }
      const footprintText = footprint
        ? `Latest settled provider context: ${footprint.total}/${footprint.limit ?? "unknown"} tokens${footprint.usage === null ? "" : ` (${footprint.usage}%)`} · ${source}.`
        : "Latest settled provider context: unavailable."
      return {
        title: result.title,
        output: [result.output, footprintText, "Live in-flight context-window occupancy: unavailable."].join("\n"),
        structured: view,
        metadata: {
          action: "context",
          source: "durable-usage",
          sessionID: target.row.id,
          contextWindowUtilizationSource: source,
          liveContextWindowUtilizationSource: "not-available",
        },
      } satisfies OxpResult.CapabilityResult
    })
    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Usage.node, SessionTelemetry.node, OxpSupervision.node, OxpAuthority.node],
})

export * as OxpUsage from "./usage"
