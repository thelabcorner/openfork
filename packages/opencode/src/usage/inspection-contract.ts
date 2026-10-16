import { Effect, Schema } from "effect"
import { Usage } from "@/usage/usage"
import type {
  UsageInspectionRequest,
  UsageInspectionResult,
  InspectionTotalsResult,
  InspectionBreakdownResult,
  InspectionTimelineResult,
  InspectionMaintenanceResult,
} from "@/usage/inspection"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const DEFAULT_POINTS = 48
const MAX_POINTS = 120
const DEFAULT_PROFILE_LIMIT = 20
const MAX_CONTEXT_MODELS = 30

const WINDOWS = {
  "1h": HOUR_MS,
  "12h": 12 * HOUR_MS,
  "1d": DAY_MS,
  "7d": 7 * DAY_MS,
  "14d": 14 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
} as const

export const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Literals(["totals", "breakdown", "timeline", "maintenance", "profile", "context"]),
  ).annotate({
    description:
      "Operation (default totals). Use a narrow action instead of requesting every usage projection at once.",
  }),
  window: Schema.optional(Schema.Literals(["1h", "12h", "1d", "7d", "14d", "30d", "90d", "all"])).annotate({
    description:
      "Range preset for totals/breakdown/timeline/maintenance (default 30d). Mutually exclusive with since/until.",
  }),
  since: Schema.optional(Schema.Finite).annotate({
    description: "Absolute range start epoch milliseconds. Supply together with until; mutually exclusive with window.",
  }),
  until: Schema.optional(Schema.Finite).annotate({
    description: "Absolute range end epoch milliseconds. Supply together with since; mutually exclusive with window.",
  }),
  projectID: Schema.optional(Schema.String).annotate({
    description: "Optional durable project id filter for range analytics.",
  }),
  dimension: Schema.optional(Schema.Literals(["provider", "model", "variant", "project", "agent"])).annotate({
    description: "breakdown: provider/model/variant/project (default model). maintenance: agent/model (default agent).",
  }),
  sort: Schema.optional(Schema.Literals(["cost", "tokens", "messages"])).annotate({
    description: "breakdown ordering (default cost).",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT }))).annotate({
    description: "breakdown/maintenance/profile row cap (default 10; profile 20; max 100).",
  }),
  resolution: Schema.optional(Schema.Literals(["hour", "day"])).annotate({
    description: "timeline bucket resolution. Defaults to hour for <=7d, otherwise day.",
  }),
  metric: Schema.optional(Schema.Literals(["cost", "tokens", "messages"])).annotate({
    description:
      "timeline primary metric (default cost). All three bounded values remain available in the structured view.",
  }),
  maxPoints: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: MAX_POINTS }))).annotate({
    description: "timeline point cap (default 48, max 120).",
  }),
  sessionID: Schema.optional(Schema.String).annotate({
    description: "context: exact session id.",
  }),
})

type ProfileView = {
  kind: "profile"
  models: Array<{
    providerID: string
    modelID: string
    costSamples: number
    averageCost: number
    cacheSamples: number
    cacheHitRate: number
  }>
  totalModels: number
  omittedModels: number
}

type ContextView = {
  kind: "context"
  sessionID: string
  createdAt: number
  updatedAt: number
  counts: { all: number; user: number; assistant: number }
  totals: {
    messages: number
    toolCalls: number
    cost: number
    freeMessages: number
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
    generatedMs: number
    toolMs: number
    ttftMs: number
    ttftRecords: number
    upstreamTTFTMs: number
    upstreamTTFTRecords: number
  }
  models: unknown[]
  totalModels: number
  omittedModels: number
  breakdown: {
    system: number
    user: number
    synthetic: number
    shell: number
    compaction: number
    assistant: number
    tool: number
    other: number
  }
}

type RangeView =
  | (InspectionTotalsResult & { kind: "totals" })
  | (InspectionBreakdownResult & { kind: "breakdown" })
  | (InspectionTimelineResult & { kind: "timeline" })
  | (InspectionMaintenanceResult & { kind: "maintenance" })

export type Metadata = {
  action: "totals" | "breakdown" | "timeline" | "maintenance" | "profile" | "context"
  view: RangeView | ProfileView | ContextView | { kind: "context"; sessionID: string; missing: true }
}

export class UsageArgumentsError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = "UsageArgumentsError"
  }
}

function invalid(detail: string) {
  return new UsageArgumentsError(detail)
}

function hasAny(params: Record<string, unknown>, keys: readonly string[]) {
  return keys.some((key) => params[key] !== undefined)
}

function normalizeRange(params: Schema.Schema.Type<typeof Parameters>) {
  if (params.window && (params.since !== undefined || params.until !== undefined)) {
    return Effect.fail(invalid("range accepts either window or since+until, not both"))
  }
  const hasAbsolute = params.since !== undefined || params.until !== undefined
  if (hasAbsolute && (params.since === undefined || params.until === undefined)) {
    return Effect.fail(invalid("absolute range requires both since and until"))
  }
  const until = hasAbsolute ? params.until! : Date.now()
  const selected = params.window ?? "30d"
  const since = hasAbsolute ? params.since! : selected === "all" ? 0 : until - WINDOWS[selected]
  if (!Number.isFinite(since) || !Number.isFinite(until) || since < 0 || until <= since) {
    return Effect.fail(invalid("usage range must be finite, non-negative, and increasing"))
  }
  return Effect.succeed({ since, until, ...(params.projectID ? { projectID: params.projectID } : {}) })
}

function totalTokens(tokens: {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}) {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning
}

function money(value: number) {
  if (!Number.isFinite(value)) return "$0"
  return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function compactNumber(value: number) {
  if (!Number.isFinite(value)) return "0"
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 1 : 2)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 1 : 2)}K`
  return Math.round(value).toLocaleString("en-US")
}

function outputFor(result: UsageInspectionResult) {
  if (result.action === "totals") {
    const spend = result.totals.cost + result.totals.estimatedCost
    return [
      `Usage ${new Date(result.since).toISOString()} → ${new Date(result.until).toISOString()}`,
      `Spend: ${money(spend)} (${money(result.totals.cost)} recorded + ${money(result.totals.estimatedCost)} estimated)`,
      `Tokens: ${compactNumber(totalTokens(result.totals.tokens))} · turns: ${result.totals.messages} · sessions: ${result.totals.sessions}`,
      `Cache hit: ${(result.rates.cacheHitRate * 100).toFixed(1)}% · estimated savings: ${money(result.rates.cacheSavings)}`,
      `Pricing: ${result.pricing.mode} · ${(result.pricing.coverage * 100).toFixed(1)}% coverage`,
      result.mostUsedModel
        ? `Most used: ${result.mostUsedModel.providerID}/${result.mostUsedModel.modelID} · ${result.mostUsedModel.messages} turns · ${(result.mostUsedModel.share * 100).toFixed(1)}%`
        : undefined,
    ]
      .filter((line): line is string => !!line)
      .join("\n")
  }

  if (result.action === "breakdown") {
    return [
      `Usage by ${result.dimension} · ${result.rows.length}/${result.totalRows} rows`,
      ...result.rows.map(
        (row) =>
          `${row.label}: ${money(row.cost + row.estimatedCost)} · ${compactNumber(row.tokens)} tokens · ${row.messages} turns · ${row.sessions} sessions`,
      ),
      ...(result.truncated
        ? [`… ${result.totalRows - result.rows.length} rows omitted; raise limit if they matter.`]
        : []),
    ].join("\n")
  }

  if (result.action === "timeline") {
    return [
      `Usage timeline · ${result.resolution} · ${result.points.length}/${result.sourcePoints} points`,
      ...result.points.map(
        (point) =>
          `${new Date(point.start).toISOString()}: ${money(point.cost + point.estimatedCost)} · ${compactNumber(point.tokens)} tokens · ${point.messages} turns`,
      ),
      ...(result.truncated ? ["Timeline downsampled to the requested maxPoints."] : []),
    ].join("\n")
  }

  return [
    `Maintenance usage · ${result.dimension} · ${result.rows.length}/${result.totalRows} rows`,
    `Spend: ${money(result.totals.cost + result.totals.estimatedCost)} · tokens: ${compactNumber(result.totals.totalTokens)} · requests: ${result.totals.requests} · sessions: ${result.totals.sessions}`,
    ...result.rows.map(
      (row) =>
        `${row.label}: ${money(row.cost + row.estimatedCost)} · ${compactNumber(row.tokens)} tokens · ${row.requests} requests`,
    ),
    ...(result.truncated ? [`… ${result.totalRows - result.rows.length} rows omitted.`] : []),
  ].join("\n")
}

/**
 * Common bounded native/OXP Session context projection.
 *
 * Accept the single authoritative durable read performed by the caller;
 * never carry systemPrompt, full messages, or unsliced model records across
 * the external boundary.
 */
export function projectSessionContext(sessionID: string, history: Usage.SessionContextHistory | undefined) {
  if (!history) {
    const view = { kind: "context" as const, sessionID, missing: true as const }
    return {
      title: "Usage context",
      metadata: { action: "context" as const, view },
      output: `No durable usage context found for ${sessionID}.`,
      data: view,
    }
  }
  const models = history.models.slice(0, MAX_CONTEXT_MODELS)
  const view: ContextView = {
    kind: "context",
    sessionID: history.sessionID,
    createdAt: history.createdAt,
    updatedAt: history.updatedAt,
    counts: history.counts,
    totals: history.totals,
    models,
    totalModels: history.models.length,
    omittedModels: Math.max(0, history.models.length - models.length),
    breakdown: history.breakdown,
  }
  return {
    title: "Usage context",
    metadata: { action: "context" as const, view },
    output: [
      `Session ${view.sessionID}`,
      `Usage messages: ${view.totals.messages} · tool calls: ${view.totals.toolCalls} · cost: ${money(view.totals.cost)}`,
      `Tokens: ${compactNumber(totalTokens(view.totals.tokens))} · models: ${view.totalModels}`,
      `Context parts: system ${view.breakdown.system}, user ${view.breakdown.user}, assistant ${view.breakdown.assistant}, tool ${view.breakdown.tool}, other ${view.breakdown.other}`,
    ].join("\n"),
    data: view,
  }
}

/** Single authoritative usage execution shared by the native lazy tool and external adapters. */
export function runUsage(params: Schema.Schema.Type<typeof Parameters>, usage: Usage.Interface) {
  return Effect.gen(function* () {
    const action = params.action ?? "totals"

    if (action === "profile") {
      if (
        hasAny(params as Record<string, unknown>, [
          "window",
          "since",
          "until",
          "projectID",
          "dimension",
          "sort",
          "resolution",
          "metric",
          "maxPoints",
          "sessionID",
        ])
      ) {
        return yield* Effect.fail(invalid("profile accepts optional limit only"))
      }
      const result = yield* usage.modelProfile()
      const limit = params.limit ?? DEFAULT_PROFILE_LIMIT
      const models = [...result.models]
        .sort((left, right) => right.costSamples - left.costSamples || right.cacheSamples - left.cacheSamples)
        .slice(0, limit)
      const view: ProfileView = {
        kind: "profile",
        models,
        totalModels: result.models.length,
        omittedModels: Math.max(0, result.models.length - models.length),
      }
      return {
        title: "Usage profile",
        metadata: { action, view },
        output: [
          `Model profile · ${models.length}/${result.models.length} models`,
          ...models.map(
            (model) =>
              `${model.providerID}/${model.modelID}: avg ${money(model.averageCost)} · cache ${(model.cacheHitRate * 100).toFixed(1)}% · ${model.costSamples} cost samples`,
          ),
          ...(view.omittedModels ? [`… ${view.omittedModels} models omitted.`] : []),
        ].join("\n"),
        data: view,
      }
    }

    if (action === "context") {
      if (!params.sessionID) return yield* Effect.fail(invalid("context requires sessionID"))
      if (
        hasAny(params as Record<string, unknown>, [
          "window",
          "since",
          "until",
          "projectID",
          "dimension",
          "sort",
          "limit",
          "resolution",
          "metric",
          "maxPoints",
        ])
      ) {
        return yield* Effect.fail(invalid("context accepts sessionID only"))
      }
      const result = yield* usage.sessionContext(params.sessionID)
      return projectSessionContext(params.sessionID, result)
    }

    const range = yield* normalizeRange(params)
    let request: UsageInspectionRequest
    if (action === "totals") {
      if (
        hasAny(params as Record<string, unknown>, [
          "dimension",
          "sort",
          "limit",
          "resolution",
          "metric",
          "maxPoints",
          "sessionID",
        ])
      ) {
        return yield* Effect.fail(invalid("totals accepts range and optional projectID only"))
      }
      request = { action, ...range }
    } else if (action === "breakdown") {
      if (hasAny(params as Record<string, unknown>, ["resolution", "metric", "maxPoints", "sessionID"])) {
        return yield* Effect.fail(invalid("breakdown does not accept timeline/session arguments"))
      }
      const dimension = params.dimension ?? "model"
      if (dimension === "agent")
        return yield* Effect.fail(invalid("breakdown dimension must be provider, model, variant, or project"))
      request = {
        action,
        ...range,
        dimension,
        limit: params.limit ?? DEFAULT_LIMIT,
        sort: params.sort ?? "cost",
      }
    } else if (action === "timeline") {
      if (hasAny(params as Record<string, unknown>, ["dimension", "sort", "limit", "sessionID"])) {
        return yield* Effect.fail(invalid("timeline does not accept breakdown/session arguments"))
      }
      const rangeMs = range.until - range.since
      request = {
        action,
        ...range,
        resolution: params.resolution ?? (rangeMs <= 7 * DAY_MS ? "hour" : "day"),
        metric: params.metric ?? "cost",
        maxPoints: params.maxPoints ?? DEFAULT_POINTS,
      }
    } else {
      if (hasAny(params as Record<string, unknown>, ["sort", "resolution", "metric", "maxPoints", "sessionID"])) {
        return yield* Effect.fail(invalid("maintenance accepts range, projectID, dimension, and limit only"))
      }
      const dimension = params.dimension ?? "agent"
      if (dimension !== "agent" && dimension !== "model") {
        return yield* Effect.fail(invalid("maintenance dimension must be agent or model"))
      }
      request = {
        action: "maintenance",
        ...range,
        dimension,
        limit: params.limit ?? DEFAULT_LIMIT,
      }
    }

    const result = yield* usage.inspect(request)
    const view = { ...result, kind: result.action } as RangeView
    return {
      title: `Usage · ${result.action}`,
      metadata: { action, view },
      output: outputFor(result),
      data: result,
    }
  })
}

export * as UsageInspectionContract from "./inspection-contract"
