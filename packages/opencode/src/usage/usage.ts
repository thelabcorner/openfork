export * as Usage from "./usage"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Semaphore, Types } from "effect"
import { Database, withBackfillDb } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

/**
 * Global usage aggregation across every session in the database.
 *
 * The message table is the canonical V1 assistant-message projection; each
 * assistant message is a physical row with its own id, so "work performed"
 * semantics hold by construction (forked sessions inherit rows, never duplicate
 * them). Time attribution uses `time.completed`, not session update time.
 */

type Mutable<T> = Types.DeepMutable<T>

const TokenTotals = Schema.Struct({
  input: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
})
export type TokenTotals = Schema.Schema.Type<typeof TokenTotals>
type MutableTokens = Mutable<TokenTotals>

const zeroTokens = (): MutableTokens => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
})

const addTokens = (target: MutableTokens, input: TokenTotals) => {
  target.input += input.input
  target.cacheRead += input.cacheRead
  target.cacheWrite += input.cacheWrite
  target.output += input.output
  target.reasoning += input.reasoning
  return target
}

const totalTokens = (tokens: TokenTotals) =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning

const safeDiv = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : 0)

export const UsageTotals = Schema.Struct({
  sessions: Schema.Finite,
  messages: Schema.Finite,
  /** Sum of provider-recorded message cost. */
  cost: Schema.Finite,
  /** Catalog-rate estimate for messages that recorded no cost. */
  estimatedCost: Schema.Finite,
  pricedRecords: Schema.Finite,
  unpricedRecords: Schema.Finite,
  tokens: TokenTotals,
  /** Sum of (completed - created) wall time across messages with both timestamps. */
  durationMs: Schema.Finite,
  durationRecords: Schema.Finite,
  /** Sum of (firstToken - requestSent) time to first token across messages with both timestamps. */
  ttftMs: Schema.Finite,
  ttftRecords: Schema.Finite,
})
export type UsageTotals = Schema.Schema.Type<typeof UsageTotals>

export const UsageRates = Schema.Struct({
  tokensPerSecond: Schema.Finite,
  avgTokensPerTurn: Schema.Finite,
  avgCostPerTurn: Schema.Finite,
  /** cacheRead / (input + cacheRead); 0 when there is no input. */
  cacheHitRate: Schema.Finite,
  /** Estimated USD saved by cache reads vs charging them as fresh input. */
  cacheSavings: Schema.Finite,
  /** Fraction of messages (0..1) whose model rates were known for the savings estimate. */
  cacheSavingsCoverage: Schema.Finite,
})
export type UsageRates = Schema.Schema.Type<typeof UsageRates>

const ModelRef = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.NullOr(Schema.String),
})

export const MostUsedModel = Schema.Struct({
  ...ModelRef.fields,
  messages: Schema.Finite,
  cost: Schema.Finite,
  share: Schema.Finite,
})
export type MostUsedModel = Schema.Schema.Type<typeof MostUsedModel>

export const ProviderBucket = Schema.Struct({
  providerID: Schema.String,
  messages: Schema.Finite,
  sessions: Schema.Finite,
  cost: Schema.Finite,
  estimatedCost: Schema.Finite,
  unpricedRecords: Schema.Finite,
  tokens: TokenTotals,
  share: Schema.Finite,
})
export type ProviderBucket = Schema.Schema.Type<typeof ProviderBucket>

export const ModelBucket = Schema.Struct({
  ...ModelRef.fields,
  messages: Schema.Finite,
  cost: Schema.Finite,
  estimatedCost: Schema.Finite,
  unpricedRecords: Schema.Finite,
  tokens: TokenTotals,
  share: Schema.Finite,
  cacheSavings: Schema.Finite,
})
export type ModelBucket = Schema.Schema.Type<typeof ModelBucket>

export const VariantBucket = Schema.Struct({
  variant: Schema.NullOr(Schema.String),
  messages: Schema.Finite,
  cost: Schema.Finite,
  share: Schema.Finite,
})
export type VariantBucket = Schema.Schema.Type<typeof VariantBucket>

export const ProjectBucket = Schema.Struct({
  projectID: Schema.String,
  name: Schema.String,
  sessions: Schema.Finite,
  messages: Schema.Finite,
  cost: Schema.Finite,
  tokens: Schema.Finite,
})
export type ProjectBucket = Schema.Schema.Type<typeof ProjectBucket>

export const PeriodBucket = Schema.Struct({
  start: Schema.Finite,
  cost: Schema.Finite,
  tokens: Schema.Finite,
  messages: Schema.Finite,
})
export type PeriodBucket = Schema.Schema.Type<typeof PeriodBucket>

export const DayBucket = Schema.Struct({
  start: Schema.Finite,
  cost: Schema.Finite,
  tokens: Schema.Finite,
  messages: Schema.Finite,
})
export type DayBucket = Schema.Schema.Type<typeof DayBucket>

const CountBucket = Schema.Struct({
  cost: Schema.Finite,
  tokens: Schema.Finite,
  messages: Schema.Finite,
})
export type CountBucket = Schema.Schema.Type<typeof CountBucket>

export const PricingMode = Schema.Literals(["recorded", "estimated", "mixed", "unpriced"])
export type PricingMode = typeof PricingMode.Type

export const Pricing = Schema.Struct({
  coverage: Schema.Finite,
  mode: PricingMode,
})
export type Pricing = Schema.Schema.Type<typeof Pricing>

export const UsageSummary = Schema.Struct({
  since: Schema.Finite,
  until: Schema.Finite,
  resolution: Schema.Literals(["hour", "day"]),
  projectID: Schema.NullOr(Schema.String),
  totals: UsageTotals,
  rates: UsageRates,
  mostUsedModel: Schema.NullOr(MostUsedModel),
  providers: Schema.Array(ProviderBucket),
  models: Schema.Array(ModelBucket),
  variants: Schema.Array(VariantBucket),
  projects: Schema.Array(ProjectBucket),
  periods: Schema.Array(PeriodBucket),
  days: Schema.Array(DayBucket),
  /** Day of week, JS order: 0 = Sunday … 6 = Saturday. */
  dow: Schema.Tuple([
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
  ]),
  /** Hour of day 0..23 in local time. */
  hours: Schema.Tuple([
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
    CountBucket,
  ]),
  pricing: Pricing,
})
export type UsageSummary = Schema.Schema.Type<typeof UsageSummary>

export const UsageSummaryRequest = Schema.Struct({
  since: Schema.Finite,
  until: Schema.Finite,
  resolution: Schema.Literals(["hour", "day"]),
  projectID: Schema.optional(Schema.NullOr(Schema.String)),
})
export type UsageSummaryRequest = Schema.Schema.Type<typeof UsageSummaryRequest>

export interface Interface {
  readonly summary: (request: UsageSummaryRequest) => Effect.Effect<UsageSummary>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Usage") {}

type UsageRow = {
  id: string
  session_id: string
  provider_id: string | null
  model_id: string | null
  variant: string | null
  created_ms: number | null
  completed_ms: number | null
  request_sent_ms: number | null
  first_token_ms: number | null
  cost_usd: number | null
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  project_id: string
  directory: string
  project_name: string | null
}

type ModelRates = { input: number; output: number; cacheRead: number; cacheWrite: number }

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// Bound the wire payload / render cost for very long windows (all-time day
// buckets can reach thousands). Charts only need a representative sample.
const MAX_PERIODS = 400
const MAX_DAYS = 500

// Summary results are aggregated and small; cache them briefly so repeated
// panel opens and rapid range switching do not re-scan the message table. The
// message-table max rowid is part of the key, so a newly-inserted message
// invalidates the cache naturally and live usage never lags.
const SUMMARY_CACHE_TTL_MS = 3_000
const summaryCache = new Map<string, { at: number; value: UsageSummary }>()

function downsample<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list
  const step = Math.ceil(list.length / max)
  const out: T[] = []
  for (let i = 0; i < list.length; i += step) out.push(list[i])
  const last = list[list.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

const localDayStart = (ms: number) => {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const utcDayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS

const utcHourStart = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS

function emptyBucket(): Mutable<CountBucket> {
  return { cost: 0, tokens: 0, messages: 0 }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, filename } = yield* Database.Service
    const modelsDev = yield* ModelsDev.Service
    // Client aborts stop response delivery, but SQLite work already handed to
    // a separate connection may continue. Serialize analytics scans so rapid
    // range/project changes cannot create a concurrent scan storm.
    const queryPermit = yield* Semaphore.make(1)

    yield* db
      .run(
        sql`CREATE INDEX IF NOT EXISTS idx_message_completed
            ON message (json_extract(data, '$.time.completed'))`,
      )
      .pipe(Effect.orDie)

    const summary = Effect.fn("Usage.summary")(function* (request: UsageSummaryRequest) {
      const projectID = request.projectID ?? null

      // Key by semantic range, not the exact millisecond timestamps generated
      // by the renderer. Exact timestamps made the old cache miss on every
      // request. A short TTL bounds staleness while avoiding any shared-DB
      // watermark query on the hot path.
      const range = request.since === 0 ? "all" : String(request.until - request.since)
      const key = `${range}:${request.resolution}:${projectID ?? ""}`
      const hit = summaryCache.get(key)
      if (hit && Date.now() - hit.at < SUMMARY_CACHE_TTL_MS) return hit.value

      const catalog = yield* modelsDev.get()
      const rates = buildRates(catalog)

      // Run the scan on a dedicated connection so a large aggregation can
      // never block the app's shared connection, which serializes live
      // session/message queries (that starvation is what made the app stutter
      // while this pane refreshed).
      const result = yield* queryPermit.withPermits(1)(
        withBackfillDb(filename, (conn) =>
          Effect.gen(function* () {
            const rows = yield* conn
              .all<UsageRow>(
              sql`
                SELECT
                  m.id,
                  m.session_id,
                  json_extract(m.data, '$.providerID') AS provider_id,
                  json_extract(m.data, '$.modelID') AS model_id,
                  json_extract(m.data, '$.variant') AS variant,
                  json_extract(m.data, '$.time.created') AS created_ms,
                  json_extract(m.data, '$.time.completed') AS completed_ms,
                  json_extract(m.data, '$.time.requestSentAt') AS request_sent_ms,
                  json_extract(m.data, '$.time.firstTokenAt') AS first_token_ms,
                  json_extract(m.data, '$.cost') AS cost_usd,
                  COALESCE(json_extract(m.data, '$.tokens.input'), 0) AS input_tokens,
                  COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS cache_read_tokens,
                  COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) AS cache_write_tokens,
                  COALESCE(json_extract(m.data, '$.tokens.output'), 0) AS output_tokens,
                  COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) AS reasoning_tokens,
                  s.project_id,
                  s.directory,
                  p.name AS project_name
                FROM message m
                JOIN session s ON s.id = m.session_id
                LEFT JOIN project p ON p.id = s.project_id
                WHERE json_extract(m.data, '$.role') = 'assistant'
                  AND json_extract(m.data, '$.time.completed') >= ${request.since}
                  AND json_extract(m.data, '$.time.completed') < ${request.until}
                  AND (${projectID} IS NULL OR s.project_id = ${projectID})
                ORDER BY completed_ms ASC
              `,
              )
              .pipe(Effect.orDie)
            return aggregate(rows, rates, request)
          }),
        ).pipe(Effect.orDie),
      )

      if (summaryCache.size > 100) summaryCache.clear()
      summaryCache.set(key, { at: Date.now(), value: result })
      return result
    })

    return Service.of({ summary })
  }),
)

function buildRates(catalog: Record<string, ModelsDev.Provider>) {
  const rates = new Map<string, ModelRates>()
  for (const provider of Object.values(catalog)) {
    for (const [modelID, model] of Object.entries(provider.models)) {
      const cost = model.cost
      if (!cost) continue
      const cacheRead = cost.cache_read ?? cost.input
      const cacheWrite = cost.cache_write ?? cost.input
      rates.set(`${provider.id}/${modelID}`, {
        input: cost.input,
        output: cost.output,
        cacheRead,
        cacheWrite,
      })
    }
  }
  return rates
}

function aggregate(rows: UsageRow[], rates: Map<string, ModelRates>, request: UsageSummaryRequest): UsageSummary {
  const totals: Mutable<UsageTotals> = {
    sessions: 0,
    messages: 0,
    cost: 0,
    estimatedCost: 0,
    pricedRecords: 0,
    unpricedRecords: 0,
    tokens: zeroTokens(),
    durationMs: 0,
    durationRecords: 0,
    ttftMs: 0,
    ttftRecords: 0,
  }
  const providers = new Map<string, Mutable<ProviderBucket>>()
  const models = new Map<string, Mutable<ModelBucket>>()
  const variants = new Map<string | null, Mutable<VariantBucket>>()
  const projects = new Map<string, Mutable<ProjectBucket>>()
  const periods = new Map<number, Mutable<PeriodBucket>>()
  const days = new Map<number, Mutable<DayBucket>>()
  const dow = Array.from({ length: 7 }, emptyBucket)
  const hours = Array.from({ length: 24 }, emptyBucket)
  const sessions = new Set<string>()
  const providerSessions = new Map<string, Set<string>>()
  const projectSessions = new Map<string, Set<string>>()
  let cacheSavings = 0
  let cacheSavingsRecords = 0
  let estimatedRecords = 0

  const bucketPeriod = (ms: number) => (request.resolution === "hour" ? utcHourStart(ms) : utcDayStart(ms))

  for (const row of rows) {
    const tokens: TokenTotals = {
      input: row.input_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
    }
    const completed = row.completed_ms
    if (completed === null) continue

    totals.messages += 1

    const providerID = row.provider_id ?? "unknown"
    const modelID = row.model_id ?? "unknown"
    const rate = rates.get(`${providerID}/${modelID}`)

    sessions.add(row.session_id)
    let providerSessionSet = providerSessions.get(providerID)
    if (!providerSessionSet) {
      providerSessionSet = new Set()
      providerSessions.set(providerID, providerSessionSet)
    }
    providerSessionSet.add(row.session_id)
    let projectSessionSet = projectSessions.get(row.project_id)
    if (!projectSessionSet) {
      projectSessionSet = new Set()
      projectSessions.set(row.project_id, projectSessionSet)
    }
    projectSessionSet.add(row.session_id)

    let source: "recorded" | "estimated" | "unpriced"
    let cost = 0
    if (row.cost_usd !== null && Number.isFinite(row.cost_usd)) {
      cost = row.cost_usd
      source = "recorded"
      totals.cost += cost
      totals.pricedRecords += 1
    } else if (rate) {
      cost = estimateCost(tokens, rate)
      source = "estimated"
      totals.estimatedCost += cost
      totals.pricedRecords += 1
      estimatedRecords += 1
    } else {
      source = "unpriced"
      totals.unpricedRecords += 1
    }

    addTokens(totals.tokens, tokens)

    if (row.created_ms !== null && completed >= row.created_ms) {
      totals.durationMs += completed - row.created_ms
      totals.durationRecords += 1
    }
    if (row.request_sent_ms !== null && row.first_token_ms !== null && row.first_token_ms >= row.request_sent_ms) {
      totals.ttftMs += row.first_token_ms - row.request_sent_ms
      totals.ttftRecords += 1
    }

    const saved = cacheSavingsFor(row, tokens, rate)
    cacheSavings += saved
    if (rate) cacheSavingsRecords += 1

    const provider = providers.get(providerID) ?? {
      providerID,
      messages: 0,
      sessions: 0,
      cost: 0,
      estimatedCost: 0,
      unpricedRecords: 0,
      tokens: zeroTokens(),
      share: 0,
    }
    provider.messages += 1
    if (source === "recorded") provider.cost += cost
    if (source === "estimated") provider.estimatedCost += cost
    if (source === "unpriced") provider.unpricedRecords += 1
    addTokens(provider.tokens, tokens)
    providers.set(providerID, provider)

    const modelKey = `${providerID}/${modelID}\u0000${row.variant ?? ""}`
    const model = models.get(modelKey) ?? {
      providerID,
      modelID,
      variant: row.variant ?? null,
      messages: 0,
      cost: 0,
      estimatedCost: 0,
      unpricedRecords: 0,
      tokens: zeroTokens(),
      share: 0,
      cacheSavings: 0,
    }
    model.messages += 1
    if (source === "recorded") model.cost += cost
    if (source === "estimated") model.estimatedCost += cost
    if (source === "unpriced") model.unpricedRecords += 1
    addTokens(model.tokens, tokens)
    model.cacheSavings += saved
    models.set(modelKey, model)

    const variant = row.variant ?? null
    const variantBucket = variants.get(variant) ?? { variant, messages: 0, cost: 0, share: 0 }
    variantBucket.messages += 1
    variantBucket.cost += cost
    variants.set(variant, variantBucket)

    const project = projects.get(row.project_id) ?? {
      projectID: row.project_id,
      name: row.project_name ?? basename(row.directory),
      sessions: 0,
      messages: 0,
      cost: 0,
      tokens: 0,
    }
    project.messages += 1
    project.cost += cost
    project.tokens += totalTokens(tokens)
    projects.set(row.project_id, project)

    const periodStart = bucketPeriod(completed)
    const period = periods.get(periodStart) ?? { start: periodStart, cost: 0, tokens: 0, messages: 0 }
    period.cost += cost
    period.tokens += totalTokens(tokens)
    period.messages += 1
    periods.set(periodStart, period)

    const dayStart = localDayStart(completed)
    const day = days.get(dayStart) ?? { start: dayStart, cost: 0, tokens: 0, messages: 0 }
    day.cost += cost
    day.tokens += totalTokens(tokens)
    day.messages += 1
    days.set(dayStart, day)

    const local = new Date(completed)
    const dowIndex = local.getDay()
    dow[dowIndex].cost += cost
    dow[dowIndex].tokens += totalTokens(tokens)
    dow[dowIndex].messages += 1
    const hourIndex = local.getHours()
    hours[hourIndex].cost += cost
    hours[hourIndex].tokens += totalTokens(tokens)
    hours[hourIndex].messages += 1
  }

  totals.sessions = sessions.size

  for (const provider of providers.values()) {
    provider.sessions = providerSessions.get(provider.providerID)?.size ?? 0
    provider.share = safeDiv(provider.messages, totals.messages)
  }
  for (const model of models.values()) {
    model.share = safeDiv(model.messages, totals.messages)
  }
  for (const variant of variants.values()) {
    variant.share = safeDiv(variant.messages, totals.messages)
  }
  for (const project of projects.values()) {
    project.sessions = projectSessions.get(project.projectID)?.size ?? 0
  }

  const processedTokens = totals.tokens.output + totals.tokens.reasoning
  const ratesResult: UsageRates = {
    tokensPerSecond: safeDiv(processedTokens, totals.durationMs) * 1000,
    avgTokensPerTurn: safeDiv(totalTokens(totals.tokens), totals.messages),
    avgCostPerTurn: safeDiv(totals.cost + totals.estimatedCost, totals.messages),
    cacheHitRate: safeDiv(totals.tokens.cacheRead, totals.tokens.input + totals.tokens.cacheRead),
    cacheSavings,
    cacheSavingsCoverage: safeDiv(cacheSavingsRecords, totals.messages),
  }

  const priced = totals.pricedRecords + totals.unpricedRecords
  const mode: PricingMode =
    totals.messages === 0
      ? "unpriced"
      : totals.unpricedRecords === totals.messages
        ? "unpriced"
        : estimatedRecords === 0
          ? "recorded"
          : totals.pricedRecords === estimatedRecords
            ? "estimated"
            : "mixed"

  const mostUsedModel = findMostUsedModel(models.values(), totals.messages)

  return {
    since: request.since,
    until: request.until,
    resolution: request.resolution,
    projectID: request.projectID ?? null,
    totals,
    rates: ratesResult,
    mostUsedModel,
    providers: [...providers.values()].sort((a, b) => b.cost + b.estimatedCost - (a.cost + a.estimatedCost)),
    models: [...models.values()].sort((a, b) => b.cost + b.estimatedCost - (a.cost + a.estimatedCost)),
    variants: [...variants.values()].sort((a, b) => b.messages - a.messages),
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost),
    periods: downsample([...periods.values()].sort((a, b) => a.start - b.start), MAX_PERIODS),
    days: downsample([...days.values()].sort((a, b) => a.start - b.start), MAX_DAYS),
    dow: dow as unknown as UsageSummary["dow"],
    hours: hours as unknown as UsageSummary["hours"],
    pricing: {
      coverage: safeDiv(totals.pricedRecords, totals.messages),
      mode,
    },
  }
}

function estimateCost(tokens: TokenTotals, rate: ModelRates) {
  return (
    (tokens.input / 1_000_000) * rate.input +
    (tokens.cacheRead / 1_000_000) * rate.cacheRead +
    (tokens.cacheWrite / 1_000_000) * rate.cacheWrite +
    ((tokens.output + tokens.reasoning) / 1_000_000) * rate.output
  )
}

function cacheSavingsFor(row: UsageRow, tokens: TokenTotals, rate: ModelRates | undefined) {
  if (!rate || tokens.cacheRead <= 0) return 0
  return (tokens.cacheRead / 1_000_000) * (rate.input - rate.cacheRead)
}

type ModelAggregate = { messages: number; cost: number; modelID: string; providerID: string; variant: string | null }

function findMostUsedModel(models: Iterable<ModelBucket>, totalMessages: number): MostUsedModel | null {
  const byKey = new Map<string, ModelAggregate>()
  for (const model of models) {
    const key = `${model.providerID}/${model.modelID}`
    const current = byKey.get(key)
    if (current) {
      current.messages += model.messages
      current.cost += model.cost
      continue
    }
    byKey.set(key, {
      messages: model.messages,
      cost: model.cost,
      modelID: model.modelID,
      providerID: model.providerID,
      variant: model.variant,
    })
  }
  let best: ModelAggregate | undefined
  for (const value of byKey.values()) {
    if (!best || value.messages > best.messages || (value.messages === best.messages && value.cost > best.cost)) {
      best = value
    }
  }
  if (!best) return null
  return {
    providerID: best.providerID,
    modelID: best.modelID,
    variant: best.variant,
    messages: best.messages,
    cost: best.cost,
    share: safeDiv(best.messages, totalMessages),
  }
}

function basename(directory: string) {
  const normalized = directory.replace(/[\\/]+$/, "")
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"))
  return separator === -1 ? normalized : normalized.slice(separator + 1)
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, ModelsDev.node] })
