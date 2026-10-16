/**
 * Shared, pure and bounded model-catalog query/projection.
 * No provider credentials, model options, headers, API endpoints, or account labels
 * are admitted to this projection. Native and OXP supply their own authorized sources.
 */
import { Schema } from "effect"

const MAX_RESULTS = 100
const DEFAULT_RESULTS = 25
const MAX_OFFSET = 100_000

export const Parameters = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["configured", "catalog"])).annotate({
    description: "Native: configured active provider catalog (default), or public models.dev catalog. OXP: public catalog only.",
  }),
  action: Schema.optional(Schema.Literals(["list", "get", "providers"])).annotate({
    description: "list (default), get one exact provider/model, or count models per provider.",
  }),
  q: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).annotate({
    description: "Case-insensitive AND-term search across provider, model ID, name and family. Exact/prefix matches rank first.",
  }),
  providerID: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  modelID: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).annotate({
    description: "Required with action=get. Use the exact ID returned by the chosen provider; preserve account-specific qualifiers when present.",
  }),
  sort: Schema.optional(Schema.Literals(["relevance", "name", "model", "provider", "context", "output", "inputCost", "outputCost", "release", "usage"])),
  order: Schema.optional(Schema.Literals(["asc", "desc"])),
  offset: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_OFFSET }))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RESULTS }))),
  reasoning: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Boolean),
  vision: Schema.optional(Schema.Boolean),
  zeroCost: Schema.optional(Schema.Boolean).annotate({
    description: "Published input AND output prices are zero. Does NOT imply free account access or remaining quota.",
  }),
  minContext: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxInputCost: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  maxOutputCost: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  includeUsage: Schema.optional(Schema.Boolean).annotate({
    description: "Join bounded historical model-use counts (native only, or authorized OXP Session). No history hydration.",
  }),
  includeQuota: Schema.optional(Schema.Boolean).annotate({
    description: "Fetch advisory account quota for exactly one providerID (native only). No provider fanout.",
  }),
})
export type Input = Schema.Schema.Type<typeof Parameters>

type ModelLike = {
  readonly id?: string
  readonly name?: string
  readonly family?: string
  readonly primitive?: string
  readonly type?: string
  readonly status?: string
  readonly release_date?: string
  readonly reasoning?: boolean
  readonly tool_call?: boolean
  readonly attachment?: boolean
  readonly capabilities?: {
    readonly reasoning?: boolean
    readonly toolcall?: boolean
    readonly attachment?: boolean
    readonly input?: { readonly image?: boolean | undefined }
  }
  readonly modalities?: { readonly input?: readonly string[] }
  readonly limit?: { readonly context?: number; readonly output?: number; readonly input?: number }
  readonly cost?: { readonly input?: number; readonly output?: number; readonly cache_read?: number; readonly cache_write?: number }
}
type ProviderLike = { readonly name: string; readonly models: Readonly<Record<string, ModelLike>> }

export type ModelRow = {
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly family: string | null
  readonly primitive: string
  readonly status: string | null
  readonly release: string | null
  readonly context: number | null
  readonly output: number | null
  readonly inputCost: number | null
  readonly outputCost: number | null
  readonly reasoning: boolean
  readonly tools: boolean
  readonly vision: boolean
  readonly publishedZeroCost: boolean
  readonly usageMessages?: number
  readonly quota?: { readonly advisory: true; readonly state: "exhausted-window" | "remaining" | "unknown"; readonly remainingPercent: number | null; readonly observedAt: number }
}
export type UsageIndex = ReadonlyMap<string, number>
export const identity = (providerID: string, modelID: string) => JSON.stringify([providerID, modelID])

/** Enumerate once; only whitelisted scalar metadata survives egress. */
export function rowsFromProviders(providers: Readonly<Record<string, ProviderLike>>): ModelRow[] {
  const result: ModelRow[] = []
  for (const [providerID, provider] of Object.entries(providers)) {
    for (const [key, model] of Object.entries(provider.models)) {
      const inputCost = typeof model.cost?.input === "number" && Number.isFinite(model.cost.input) ? model.cost.input : null
      const outputCost = typeof model.cost?.output === "number" && Number.isFinite(model.cost.output) ? model.cost.output : null
      result.push({
        providerID,
        modelID: model.id ?? key,
        name: model.name ?? key,
        family: model.family ?? null,
        primitive: model.primitive ?? (model.type === "decision" ? "system-one" : "language"),
        status: model.status ?? null,
        release: model.release_date ?? null,
        context: Number.isFinite(model.limit?.context) ? model.limit!.context! : null,
        output: Number.isFinite(model.limit?.output) ? model.limit!.output! : null,
        inputCost,
        outputCost,
        reasoning: model.capabilities?.reasoning ?? model.reasoning ?? false,
        tools: model.capabilities?.toolcall ?? model.tool_call ?? false,
        vision: model.capabilities?.input?.image ?? model.modalities?.input?.includes("image") ?? false,
        publishedZeroCost: inputCost === 0 && outputCost === 0,
      })
    }
  }
  return result
}
const normalized = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
function score(row: ModelRow, terms: readonly string[]) {
  if (!terms.length) return 0
  const provider = normalized(row.providerID)
  const id = normalized(row.modelID)
  const name = normalized(row.name)
  const family = normalized(row.family ?? "")
  let score = 0
  for (const term of terms) {
    if (id === term || `${provider}/${id}` === term) score += 100
    else if (id.startsWith(term)) score += 60
    else if (name.startsWith(term)) score += 45
    else if (id.includes(term)) score += 30
    else if (name.includes(term)) score += 20
    else if (provider.includes(term) || family.includes(term)) score += 10
    else return -1
  }
  return score
}
function numeric(value: number | null | undefined, other: number | null | undefined, order: 1 | -1) {
  // Missing metrics always last, regardless of sort direction.
  if (value == null) return other == null ? 0 : 1
  if (other == null) return -1
  return (value - other) * order
}
const asc = (a: string, b: string) => a.localeCompare(b, "en")

export type ModelListResult = {
  readonly action: "list" | "get"
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly returned: number
  readonly omitted: number
  readonly hasMore: boolean
  readonly models: ModelRow[]
}
export type ProviderListResult = {
  readonly action: "providers"
  readonly total: number
  readonly totalProviders: number
  readonly offset: number
  readonly limit: number
  readonly returned: number
  readonly omitted: number
  readonly hasMore: boolean
  readonly providers: { providerID: string; models: number }[]
}
export type Result = ModelListResult | ProviderListResult

export function queryModels(rows: readonly ModelRow[], params: Input, usage?: UsageIndex): Result {
  const action = params.action ?? "list"
  const offset = params.offset ?? 0
  const limit = params.limit ?? DEFAULT_RESULTS
  const sort = params.sort ?? "relevance"
  if (action === "get" && (!params.providerID || !params.modelID))
    throw new Error("get requires exact providerID and modelID")
  if (action !== "get" && params.modelID) throw new Error("modelID requires action=get")
  if (action === "get" && (params.q || offset || params.sort || params.order))
    throw new Error("get does not accept search, sorting or pagination")
  if (sort === "usage" && !usage) throw new Error("sort=usage requires includeUsage and authorized usage data")
  const order: 1 | -1 = params.order === "asc" ? 1 : params.order === "desc" ? -1 :
    ["context", "output", "release", "usage", "relevance"].includes(sort) ? -1 : 1
  const terms = normalized(params.q ?? "").split(/\s+/).filter(Boolean)
  // A release date is shared by many catalog rows. Parse each distinct value
  // at most once rather than running Date.parse() for every sort comparison.
  const releaseCache = new Map<string, number | null>()
  const releaseTime = (release: string | null) => {
    if (!release) return null
    if (releaseCache.has(release)) return releaseCache.get(release) ?? null
    const parsed = Date.parse(release)
    const timestamp = Number.isFinite(parsed) ? parsed : null
    releaseCache.set(release, timestamp)
    return timestamp
  }
  const matches: Array<{ row: ModelRow; relevance: number }> = []
  for (const original of rows) {
    if (params.providerID && original.providerID !== params.providerID) continue
    if (params.modelID && original.modelID !== params.modelID) continue
    if (params.reasoning !== undefined && original.reasoning !== params.reasoning) continue
    if (params.tools !== undefined && original.tools !== params.tools) continue
    if (params.vision !== undefined && original.vision !== params.vision) continue
    if (params.zeroCost !== undefined && original.publishedZeroCost !== params.zeroCost) continue
    if (params.minContext !== undefined && (original.context === null || original.context < params.minContext)) continue
    if (params.maxInputCost !== undefined && (original.inputCost === null || original.inputCost > params.maxInputCost)) continue
    if (params.maxOutputCost !== undefined && (original.outputCost === null || original.outputCost > params.maxOutputCost)) continue
    const relevance = score(original, terms)
    if (relevance < 0) continue
    matches.push({ row: original, relevance })
  }
  matches.sort((a, b) => {
    const left = a.row, right = b.row
    const comparison =
      sort === "relevance" ? (a.relevance - b.relevance) * order :
      sort === "name" ? asc(left.name, right.name) * order :
      sort === "model" ? asc(left.modelID, right.modelID) * order :
      sort === "provider" ? asc(left.providerID, right.providerID) * order :
      sort === "context" ? numeric(left.context, right.context, order) :
      sort === "output" ? numeric(left.output, right.output, order) :
      sort === "inputCost" ? numeric(left.inputCost, right.inputCost, order) :
      sort === "outputCost" ? numeric(left.outputCost, right.outputCost, order) :
      sort === "usage" ? numeric(usage?.get(identity(left.providerID, left.modelID)), usage?.get(identity(right.providerID, right.modelID)), order) :
      // String dates are ISO YYYY-MM-DD in both catalogs; unknown dates last.
      numeric(releaseTime(left.release), releaseTime(right.release), order)
    return comparison || asc(left.providerID, right.providerID) || asc(left.modelID, right.modelID)
  })
  const total = matches.length
  if (action === "providers") {
    const count = new Map<string, number>()
    for (const match of matches) count.set(match.row.providerID, (count.get(match.row.providerID) ?? 0) + 1)
    const providers = [...count].sort(([a], [b]) => asc(a, b)).map(([providerID, models]) => ({ providerID, models }))
    const selected = providers.slice(offset, offset + limit)
    return { action, total, totalProviders: providers.length, providers: selected, offset, limit, returned: selected.length, omitted: Math.max(0, providers.length - selected.length), hasMore: offset + selected.length < providers.length }
  }
  const selected = action === "get" ? matches.slice(0, 1) : matches.slice(offset, offset + limit)
  return {
    action, total, offset: action === "get" ? 0 : offset, limit: action === "get" ? 1 : limit,
    returned: selected.length, omitted: total - selected.length,
    hasMore: action !== "get" && offset + selected.length < total,
    models: selected.map(({ row }) => {
      const messages = usage?.get(identity(row.providerID, row.modelID))
      return messages === undefined ? row : { ...row, usageMessages: messages }
    }),
  }
}
export * as ModelsQuery from "./query"
