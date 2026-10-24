import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Usage } from "@/usage/usage"
import { UsageInspectionContract } from "@/usage/inspection-contract"
import { OxpAttribution } from "@opencode-ai/core/oxp-attribution/attribution"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { ContextOccupancy } from "@opencode-ai/core/session/context-occupancy"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"
import { OxpSupervision } from "./supervision"

/**
 * OXP projection of native Usage domain actions. Global analytics have their
 * own default-off authority; context remains bound to a supervised Session.
 *
 * Usage's durable service and native tool execution stay authoritative. OXP
 * does not invent a native Tool.Context or silently inherit filesystem/session
 * authority for global analytics.
 */
export const Parameters = Schema.Struct({
  action: Schema.Literals(["context", "totals", "breakdown", "timeline", "maintenance", "profile", "workload", "summary", "oxpContext"]).annotate({
    description: "context requires an explicitly supervised sessionID. Aggregate actions require the separate globalUsageAnalytics grant; workload is capped at 90 days.",
  }),
  sessionID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  rootID: Schema.optional(OxpSchema.RootID),
  window: Schema.optional(Schema.Literals(["1h", "12h", "1d", "7d", "14d", "30d", "90d", "all"]).annotate({
    description: "Range preset. Use since+until instead for explicit epoch milliseconds; the workload and OXP context projections require at most 90 days.",
  })),
  since: Schema.optional(Schema.Finite), until: Schema.optional(Schema.Finite),
  projectID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  dimension: Schema.optional(Schema.Literals(["provider", "model", "variant", "project", "agent"])),
  sort: Schema.optional(Schema.Literals(["cost", "tokens", "messages"])),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  resolution: Schema.optional(Schema.Literals(["hour", "day"])),
  metric: Schema.optional(Schema.Literals(["cost", "tokens", "messages"])),
  maxPoints: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 120 }))),
  providerID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  modelID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  sections: Schema.optional(Schema.Array(Schema.Literals(["activity", "models", "economics", "series"])).check(Schema.isMinLength(1), Schema.isMaxLength(4))),
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
    const oxpAttribution = yield* OxpAttribution.Service

    const execute: Interface["execute"] = Effect.fn("OxpUsage.execute")(function* (input, signal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "Usage inspection cancelled" })
      if (input.action !== "context") {
        if (input.rootID) return yield* new OxpError.InvalidArgument({ detail: "Global usage actions do not accept filesystem root selectors" })
        const admission = yield* authority.authorize({ plane: "augmentation", operation: "usage.global", phase: "read" })
        if (input.action === "workload" || input.action === "summary" || input.action === "oxpContext") {
          const range = yield* Effect.try({
            try: () => rangeOf(input),
            catch: (error) => error instanceof OxpError.InvalidArgument
              ? error
              : new OxpError.InvalidArgument({ detail: "Invalid usage range" }),
          })
          let structured: unknown
          let title: string
          if (input.action === "workload") {
            if (range.since < 0 || range.until <= range.since || range.until - range.since > 90 * 24 * 60 * 60 * 1000 ||
              !Number.isSafeInteger(range.since) || !Number.isSafeInteger(range.until) || range.until > Date.now() + 86_400_000) {
              return yield* new OxpError.InvalidArgument({ detail: "workload requires a valid time range no longer than 90 days" })
            }
            if (input.modelID && !input.providerID) return yield* new OxpError.InvalidArgument({ detail: "workload modelID requires providerID" })
            if ((input.limit ?? 20) > 20) return yield* new OxpError.InvalidArgument({ detail: "OXP workload limit cannot exceed 20" })
            if (input.sessionID || input.rootID) return yield* new OxpError.InvalidArgument({ detail: "workload does not accept Session or root selectors" })
            if (input.sections || input.dimension || input.sort || input.resolution || input.metric || input.maxPoints) {
              return yield* new OxpError.InvalidArgument({ detail: "workload accepts only range, selectors, and limit" })
            }
            structured = yield* usage.workload({
              ...range,
              ...(input.providerID ? { providerID: input.providerID } : {}),
              ...(input.modelID ? { modelID: input.modelID } : {}),
              ...(input.projectID ? { projectID: input.projectID } : {}),
              limit: input.limit ?? 20,
            })
            title = "Usage workload"
          } else if (input.action === "oxpContext") {
            if (range.until - range.since > 90 * DAY_MS || !Number.isSafeInteger(range.since) || !Number.isSafeInteger(range.until)) {
              return yield* new OxpError.InvalidArgument({ detail: "oxpContext requires a safe-integer range no longer than 90 days" })
            }
            if (input.projectID || input.providerID || input.modelID || input.sections || input.dimension || input.sort || input.resolution || input.metric || input.maxPoints || input.limit || input.sessionID || input.rootID) {
              return yield* new OxpError.InvalidArgument({ detail: "oxpContext accepts a range and optional project-independent activity scope only" })
            }
            // This is the same producer as the Desktop OXP Context tab. Its
            // estimates and calibration/coverage records are passed through.
            structured = yield* oxpAttribution.snapshot({ since: range.since, until: range.until, includeWorkload: true })
            title = "OXP usage context"
          } else {
            if (input.providerID || input.modelID || input.sections === undefined || input.dimension || input.sort || input.metric || input.maxPoints || input.sessionID || input.rootID) {
              return yield* new OxpError.InvalidArgument({ detail: "summary requires selected sections and accepts range, projectID, resolution, and limit" })
            }
            const summary = yield* usage.summary({
              ...range,
              resolution: input.resolution ?? (range.until - range.since <= 7 * 24 * 60 * 60 * 1000 ? "hour" : "day"),
              ...(input.projectID ? { projectID: input.projectID } : {}),
            })
            const cap = input.limit ?? 20
            const view: Record<string, unknown> = {
              kind: "summary",
              since: summary.since,
              until: summary.until,
              resolution: summary.resolution,
              projectID: summary.projectID,
              totals: summary.totals,
              provenance: "durable-usage-records",
              sections: [...new Set(input.sections)],
            }
            if (input.sections.includes("economics")) view.economics = { rates: summary.rates, pricing: summary.pricing }
            if (input.sections.includes("models")) view.models = {
              providers: summary.providers.slice(0, cap), totalProviders: summary.providers.length,
              models: summary.models.slice(0, cap), totalModels: summary.models.length,
              mostUsedModel: summary.mostUsedModel,
              truncated: summary.providers.length > cap || summary.models.length > cap,
            }
            if (input.sections.includes("activity")) view.activity = {
              activity: summary.activity, days: summary.days.slice(-Math.min(cap, 30)),
              dow: summary.dow, hours: summary.hours, punchcard: summary.punchcard,
              sessions: summary.sessions.slice(0, Math.min(cap, 20)), totalSessions: summary.sessions.length,
            }
            if (input.sections.includes("series")) view.series = {
              periods: summary.periods.slice(-Math.min(cap, 120)),
              providers: summary.providerSeries.slice(0, cap), models: summary.modelSeries.slice(0, cap),
              totalProviders: summary.providerSeries.length, totalModels: summary.modelSeries.length,
            }
            structured = view
            title = "Usage summary"
          }
          if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "Usage inspection cancelled" })
          yield* authority.revalidate(admission, "egress")
          return { title, output: JSON.stringify(structured), structured, metadata: {
            action: input.action, source: input.action === "oxpContext" ? "oxp-attribution" : "durable-usage",
            provenance: input.action === "workload" ? "producer-settlement; historical tool calls may be missing" :
              input.action === "oxpContext" ? "empirical OXP invocation attribution; estimates and source coverage are explicit" : "durable-usage-records",
            precision: input.action === "workload" ? "exact counts/sums; percentiles follow native quantile gates; tool wall time overlaps and is not elapsed human time" : "producer-projected; estimated prices identified in summary",
          } } satisfies OxpResult.CapabilityResult
        }
        const params = { ...input } as Schema.Schema.Type<typeof UsageInspectionContract.Parameters>
        const result = yield* UsageInspectionContract.runUsage(params, usage).pipe(
          Effect.mapError((error) =>
            error instanceof UsageInspectionContract.UsageArgumentsError
              ? new OxpError.InvalidArgument({ detail: error.detail })
              : error,
          ),
        )
        if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "Usage inspection cancelled" })
        yield* authority.revalidate(admission, "egress")
        return { title: result.title, output: result.output, structured: result.data, metadata: { action: input.action, source: "durable-usage-global", provenance: "settled-usage-records" } } satisfies OxpResult.CapabilityResult
      }
      // Resolve and authorize before touching analytics: a sessionID is not
      // an independent database read capability.
      if (!input.sessionID) return yield* new OxpError.InvalidArgument({ detail: "Usage context requires an explicit sessionID" })
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
  deps: [Usage.node, SessionTelemetry.node, OxpAttribution.node, OxpSupervision.node, OxpAuthority.node],
})

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOWS = { "1h": 60 * 60 * 1000, "12h": 12 * 60 * 60 * 1000, "1d": DAY_MS, "7d": 7 * DAY_MS, "14d": 14 * DAY_MS, "30d": 30 * DAY_MS, "90d": 90 * DAY_MS } as const
function rangeOf(input: Input) {
  if (input.window && (input.since !== undefined || input.until !== undefined)) throw new OxpError.InvalidArgument({ detail: "Supply either window or since+until" })
  if ((input.since === undefined) !== (input.until === undefined)) throw new OxpError.InvalidArgument({ detail: "Absolute range requires since and until" })
  const until = input.until ?? Date.now()
  const since = input.since ?? (input.window === "all" ? 0 : until - WINDOWS[input.window ?? "30d"])
  if (!Number.isFinite(since) || !Number.isFinite(until) || since < 0 || until <= since) throw new OxpError.InvalidArgument({ detail: "Usage range must be finite, non-negative and increasing" })
  return { since, until }
}

export * as OxpUsage from "./usage"
