export * as Usage from "./usage"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Semaphore, Types } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { UsageClassification } from "@opencode-ai/core/usage/classification"
import { UsageRecord } from "@opencode-ai/core/usage/record"
import { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { SessionTelemetry as SessionTelemetrySchema } from "@opencode-ai/schema/session-telemetry"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"

/**
 * Global usage aggregation across every session in the database.
 *
 * `usage_record` is the compact, Usage-owned settlement projection for
 * user-facing generations. V1/V2 producers write it once at settlement and the
 * migration imports historical assistant rows once, so steady-state analytics
 * never decodes conversation payloads. Forked sessions inherit records rather
 * than duplicating work. Time attribution uses completion time, not session
 * update time.
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

export const MaintenanceTotals = Schema.Struct({
  requests: Schema.Finite,
  sessions: Schema.Finite,
  cost: Schema.Finite,
  estimatedCost: Schema.Finite,
  pricedRecords: Schema.Finite,
  estimatedRecords: Schema.Finite,
  unpricedRecords: Schema.Finite,
  /** Detailed token classes when the provider supplied them. */
  tokens: TokenTotals,
  /** Authoritative all-token count; may exceed the detailed sum when a
   * terminally-cancelled provider omitted its final usage breakdown. */
  totalTokens: Schema.Finite,
  durationMs: Schema.Finite,
  durationRecords: Schema.Finite,
})
export type MaintenanceTotals = Schema.Schema.Type<typeof MaintenanceTotals>

export const MaintenanceAgentBucket = Schema.Struct({
  agent: Schema.String,
  requests: Schema.Finite,
  sessions: Schema.Finite,
  models: Schema.Finite,
  cost: Schema.Finite,
  estimatedCost: Schema.Finite,
  totalTokens: Schema.Finite,
  tokenShare: Schema.Finite,
  costShare: Schema.Finite,
})
export type MaintenanceAgentBucket = Schema.Schema.Type<typeof MaintenanceAgentBucket>

export const MaintenanceModelBucket = Schema.Struct({
  agent: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.NullOr(Schema.String),
  requests: Schema.Finite,
  cost: Schema.Finite,
  estimatedCost: Schema.Finite,
  totalTokens: Schema.Finite,
})
export type MaintenanceModelBucket = Schema.Schema.Type<typeof MaintenanceModelBucket>

export const MaintenancePeriodBucket = Schema.Struct({
  start: Schema.Finite,
  requests: Schema.Finite,
  cost: Schema.Finite,
  tokens: Schema.Finite,
})
export type MaintenancePeriodBucket = Schema.Schema.Type<typeof MaintenancePeriodBucket>

export const MaintenanceSummary = Schema.Struct({
  totals: MaintenanceTotals,
  agents: Schema.Array(MaintenanceAgentBucket),
  models: Schema.Array(MaintenanceModelBucket),
  periods: Schema.Array(MaintenancePeriodBucket),
})
export type MaintenanceSummary = Schema.Schema.Type<typeof MaintenanceSummary>

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
  /** Sum of (completed - created) wall time, scoped to this provider — mirrors UsageTotals.durationMs. */
  durationMs: Schema.Finite,
  durationRecords: Schema.Finite,
  /** Provider response generation window (first token -> stream end). */
  generationMs: Schema.Finite,
  generationRecords: Schema.Finite,
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
  /** Sum of (completed - created) wall time, scoped to this model — mirrors UsageTotals.durationMs. */
  durationMs: Schema.Finite,
  durationRecords: Schema.Finite,
  /** Provider response generation window (first token -> stream end). */
  generationMs: Schema.Finite,
  generationRecords: Schema.Finite,
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
  /** Distinct sessions touched on this local day — lets the client show
   * "how many separate pieces of work", not just raw turn count. */
  sessions: Schema.Finite,
})
export type DayBucket = Schema.Schema.Type<typeof DayBucket>

const CountBucket = Schema.Struct({
  cost: Schema.Finite,
  tokens: Schema.Finite,
  messages: Schema.Finite,
})
export type CountBucket = Schema.Schema.Type<typeof CountBucket>

export const EntitySeries = Schema.Struct({
  /** `providerID` for a provider series, `providerID/modelID` for a model one
   * (variants merged, matching how the client groups them). */
  key: Schema.String,
  /** Parallel arrays aligned index-for-index with `periods`. Kept as bare
   * number arrays rather than an array of bucket objects: a per-entity series
   * repeats the same timestamps for every entity, and re-sending `start` on
   * each one would roughly triple the payload for no information. */
  cost: Schema.Array(Schema.Finite),
  tokens: Schema.Array(Schema.Finite),
  messages: Schema.Array(Schema.Finite),
})
export type EntitySeries = Schema.Schema.Type<typeof EntitySeries>

export const SessionBucket = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.String,
  projectID: Schema.String,
  projectName: Schema.String,
  messages: Schema.Finite,
  cost: Schema.Finite,
  tokens: Schema.Finite,
  /** Distinct provider/model pairs used in this session. */
  models: Schema.Finite,
  /** First and last assistant-message completion in the window, so the client
   * can show both when the session ran and how long it stayed active. */
  start: Schema.Finite,
  end: Schema.Finite,
})
export type SessionBucket = Schema.Schema.Type<typeof SessionBucket>

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
  /** Per-provider usage over time, aligned with `periods`. Provider cardinality
   * is naturally small, so every provider gets a series. */
  providerSeries: Schema.Array(EntitySeries),
  /** Per-model usage over time, aligned with `periods`. Emitted richest-first
   * under a fixed number budget (see MAX_SERIES_VALUES) so a long window with
   * hundreds of models cannot balloon the response; models past the budget
   * simply have no series and the client omits their trend rather than drawing
   * a partial one. */
  modelSeries: Schema.Array(EntitySeries),
  /** Day-of-week x hour-of-day activity grid, 168 entries in local time,
   * indexed `dow * 24 + hour`. `dow`/`hours` are its two marginals and stay
   * for callers that only need one axis — the cross product is what makes a
   * punchcard ("Tuesdays at 9pm") possible, and it cannot be reconstructed
   * from the marginals. */
  punchcard: Schema.Array(CountBucket),
  /** Heaviest sessions in the window, ranked by total tokens (not cost, so a
   * session run entirely on free models still ranks by the work it did),
   * capped at MAX_SESSIONS. */
  sessions: Schema.Array(SessionBucket),
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
  /** Host-owned support-agent usage. Deliberately excluded from all ordinary
   * work totals/series above so maintenance overhead cannot distort activity,
   * model portfolio, or per-turn economics. */
  maintenance: MaintenanceSummary,
})
export type UsageSummary = Schema.Schema.Type<typeof UsageSummary>

export const UsageSummaryRequest = Schema.Struct({
  since: Schema.Finite,
  until: Schema.Finite,
  resolution: Schema.Literals(["hour", "day"]),
  projectID: Schema.optional(Schema.NullOr(Schema.String)),
})
export type UsageSummaryRequest = Schema.Schema.Type<typeof UsageSummaryRequest>

export const ModelProfileEntry = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  costSamples: Schema.Finite,
  averageCost: Schema.Finite,
  cacheSamples: Schema.Finite,
  cacheHitRate: Schema.Finite,
})
export type ModelProfileEntry = Schema.Schema.Type<typeof ModelProfileEntry>

export const ModelProfile = Schema.Struct({
  models: Schema.Array(ModelProfileEntry),
})
export type ModelProfile = Schema.Schema.Type<typeof ModelProfile>

export const PricingCatalogModel = Schema.Struct({
  providerID: Schema.String,
  providerName: Schema.String,
  modelID: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  cost: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
})
export type PricingCatalogModel = Schema.Schema.Type<typeof PricingCatalogModel>

export const PricingCatalog = Schema.Struct({
  models: Schema.Array(PricingCatalogModel),
})
export type PricingCatalog = Schema.Schema.Type<typeof PricingCatalog>

const SessionContextRate = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

export const SessionContextModel = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.NullOr(Schema.String),
  providerName: Schema.String,
  modelName: Schema.String,
  messages: Schema.Finite,
  toolCalls: Schema.Finite,
  cost: Schema.Finite,
  freeMessages: Schema.Finite,
  tokens: TokenTotals,
  freeTokens: TokenTotals,
  generatedMs: Schema.Finite,
  toolMs: Schema.Finite,
  ttftMs: Schema.Finite,
  ttftRecords: Schema.Finite,
  upstreamTTFTMs: Schema.Finite,
  upstreamTTFTRecords: Schema.Finite,
  firstMessageTime: Schema.Finite,
  lastMessageTime: Schema.Finite,
  costRate: Schema.optional(SessionContextRate),
})
export type SessionContextModel = Schema.Schema.Type<typeof SessionContextModel>

export const SessionContextBreakdown = Schema.Struct({
  system: Schema.Finite,
  user: Schema.Finite,
  synthetic: Schema.Finite,
  shell: Schema.Finite,
  compaction: Schema.Finite,
  assistant: Schema.Finite,
  tool: Schema.Finite,
  other: Schema.Finite,
})
export type SessionContextBreakdown = Schema.Schema.Type<typeof SessionContextBreakdown>

export const SessionContextLatest = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
  providerName: Schema.String,
  modelName: Schema.String,
  contextLimit: Schema.optional(Schema.Finite),
  completedAt: Schema.Finite,
  tokens: TokenTotals,
})
export type SessionContextLatest = Schema.Schema.Type<typeof SessionContextLatest>

export const SessionContextHistory = Schema.Struct({
  sessionID: Schema.String,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  counts: Schema.Struct({
    all: Schema.Finite,
    user: Schema.Finite,
    assistant: Schema.Finite,
  }),
  systemPrompt: Schema.NullOr(Schema.String),
  totals: Schema.Struct({
    messages: Schema.Finite,
    toolCalls: Schema.Finite,
    cost: Schema.Finite,
    freeMessages: Schema.Finite,
    tokens: TokenTotals,
    freeTokens: TokenTotals,
    generatedMs: Schema.Finite,
    toolMs: Schema.Finite,
    ttftMs: Schema.Finite,
    ttftRecords: Schema.Finite,
    upstreamTTFTMs: Schema.Finite,
    upstreamTTFTRecords: Schema.Finite,
  }),
  models: Schema.Array(SessionContextModel),
  latest: Schema.optional(SessionContextLatest),
  breakdown: SessionContextBreakdown,
})
export type SessionContextHistory = Schema.Schema.Type<typeof SessionContextHistory>

/**
 * Bootstrap-free context-pane projection. Historical analytics come from
 * durable scalar/session projections; live occupancy and phase come from the
 * bounded SessionTelemetry overlay. No message/part payloads cross this API.
 */
export const SessionContextSnapshot = Schema.Struct({
  history: SessionContextHistory,
  telemetry: Schema.NullOr(SessionTelemetrySchema.Info),
})
export type SessionContextSnapshot = Schema.Schema.Type<typeof SessionContextSnapshot>

export interface Interface {
  readonly summary: (request: UsageSummaryRequest) => Effect.Effect<UsageSummary>
  readonly modelProfile: () => Effect.Effect<ModelProfile>
  readonly pricingCatalog: () => Effect.Effect<PricingCatalog>
  readonly sessionContext: (sessionID: string) => Effect.Effect<SessionContextHistory | undefined>
  readonly recordMaintenance: (input: MaintenanceRecordInput) => Effect.Effect<void>
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
  streamed_ms: number | null
  cost_usd: number | null
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  project_id: string
  directory: string
  project_name: string | null
  session_title: string | null
  agent: string | null
  mode: string | null
}

type MaintenanceUsageRow = {
  agent: string
  provider_id: string
  model_id: string
  variant: string | null
  session_id: string | null
  project_id: string | null
  requests: number
  cost_usd: number | null
  cost_estimated: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  total_tokens: number
  started_ms: number
  completed_ms: number
}

type ModelProfileRow = {
  provider_id: string
  model_id: string
  cost_samples: number
  cost_sum: number
  cache_samples: number
  input_tokens: number
  cache_read_tokens: number
}

type SessionContextModelRow = {
  provider_id: string
  model_id: string
  variant: string | null
  variant_count: number
  messages: number
  tool_calls: number
  cost_usd: number
  free_messages: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  free_input_tokens: number
  free_cache_read_tokens: number
  free_cache_write_tokens: number
  free_output_tokens: number
  free_reasoning_tokens: number
  generated_ms: number
  tool_ms: number
  ttft_ms: number
  ttft_records: number
  upstream_ttft_ms: number
  upstream_ttft_records: number
  first_message_ms: number
  last_message_ms: number
}

type SessionContextSessionRow = {
  session_id: string
  special_agent: number
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
  cost_usd: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  created_ms: number
  updated_ms: number
  event_seq: number
  latest_usage_completed_at: number | null
  latest_usage_message_id: string | null
}

type SessionContextRawProjection = {
  modelRows: SessionContextModelRow[]
  latestRows: SessionContextLatestRow[]
  messageGroups: SessionContextMessageGroupRow[]
  promptRows: SessionContextPromptRow[]
  partGroups: SessionContextPartGroupRow[]
}

type SessionContextLatestRow = {
  provider_id: string
  model_id: string
  variant: string | null
  completed_at: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
}

type SessionContextSemanticRow = {
  message_type: string | null
  role: string | null
  provenance_owner: string | null
  provenance_source: string | null
  provenance_lifetime: string | null
}

type SessionContextMessageGroupRow = SessionContextSemanticRow & {
  messages: number
}

type SessionContextPromptRow = SessionContextSemanticRow & {
  id: string
  system_prompt: string
  created_ms: number
}

type SessionContextPartGroupRow = SessionContextSemanticRow & {
  content_chars: number
  tool_chars: number
}

export type MaintenanceRecordInput = {
  agent: string
  providerID: string
  modelID: string
  /** Committed route authority for this maintenance generation. */
  route?: UsageRouteAttribution.Committed
  variant?: string | null
  sessionID?: string | null
  projectID?: string | null
  requests?: number
  cost?: number | null
  /** True when provider usage was unavailable and the caller priced a local token estimate. */
  costEstimated?: boolean
  tokens: TokenTotals
  totalTokens?: number
  startedAt?: number
  completedAt?: number
}

type ModelRates = { input: number; output: number; cacheRead: number; cacheWrite: number }

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// Bound the wire payload / render cost for very long windows (all-time day
// buckets can reach thousands). Charts only need a representative sample.
const MAX_PERIODS = 400
const MAX_DAYS = 500
const MAX_SESSIONS = 50
// Budget in emitted numbers per series kind (each entity costs 3 x period
// count). Scales the number of charted models to the window: a 30-bucket month
// covers every model, a 400-bucket all-time view covers the top ~50.
const MAX_SERIES_VALUES = 60_000

// Summary results are aggregated and small; cache them briefly so repeated
// panel opens and rapid range switching do not re-scan usage_record. Cache
// entries carry UsageRecord's monotonic in-process revision, so a new settled
// generation invalidates them without adding a database watermark query to the
// hot path.
const SUMMARY_CACHE_TTL_MS = 3_000
const summaryCache = new Map<string, { at: number; revision: number; value: UsageSummary }>()
const MODEL_PROFILE_CACHE_TTL_MS = 10_000
let modelProfileCache: { at: number; database: string; revision: number; value: ModelProfile } | undefined

// Context-pane history can be expensive to derive from large legacy transcripts,
// but its inputs already expose tiny durable invalidation watermarks:
//
// - event_sequence.seq changes for Session message/part mutations;
// - latest usage identity changes when a settled UsageRecord lands after the final
//   message event.
//
// Cache only the fixed-size SQL projection, never raw transcript content. This
// keeps repeat opens/refetches O(1) while preserving a cold path that can rebuild
// from durable truth after restart or out-of-band maintenance.
const SESSION_CONTEXT_CACHE_TTL_MS = 60_000
const MAX_SESSION_CONTEXT_CACHE = 128
const sessionContextProjectionCache = new Map<
  string,
  {
    at: number
    eventSeq: number
    updatedAt: number
    latestUsageCompletedAt: number | null
    latestUsageMessageID: string | null
    value: SessionContextRawProjection
  }
>()

/** Invalidate process-local analytics after an out-of-band history mutation. */
export const resetUsageSummaryCache = () => {
  summaryCache.clear()
  sessionContextProjectionCache.clear()
  // modelProfile is derived from the same durable usage_record history as the
  // range summaries. A reset/history rewrite must therefore invalidate both
  // projections atomically; otherwise Settings/Usage can display a stale
  // personal-model ranking for MODEL_PROFILE_CACHE_TTL_MS after the underlying
  // records have already been removed or rewritten.
  modelProfileCache = undefined
}

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
    const { db, readDb, scanDb, filename } = yield* Database.Service
    const modelsDev = yield* ModelsDev.Service
    // Client aborts stop response delivery, but SQLite work already handed to
    // a separate connection may continue. Serialize analytics scans so rapid
    // range/project changes cannot create a concurrent scan storm.
    const queryPermit = yield* Semaphore.make(1)
    // Session Context is an interactive, session-local read. Keep it off the
    // global Usage scan permit and reuse Database's persistent query-only lane
    // instead of opening/configuring a fresh SQLite handle on every panel fetch.
    const contextQueryPermit = yield* Semaphore.make(1)

    const summary = Effect.fn("Usage.summary")(function* (request: UsageSummaryRequest) {
      const projectID = request.projectID ?? null

      // Key by semantic range, not the exact millisecond timestamps generated
      // by the renderer. Exact timestamps made the old cache miss on every
      // request. A short TTL bounds staleness while avoiding any shared-DB
      // watermark query on the hot path.
      const range = request.since === 0 ? "all" : String(request.until - request.since)
      const key = `${filename}:${range}:${request.resolution}:${projectID ?? ""}`
      const revision = UsageRecord.revision()
      const hit = summaryCache.get(key)
      if (hit && hit.revision === revision && Date.now() - hit.at < SUMMARY_CACHE_TTL_MS) return hit.value

      const catalog = yield* modelsDev.get()
      const rates = buildRates(catalog)

      // Run the scan on a dedicated connection so a large aggregation can
      // never block the app's shared connection, which serializes live
      // session/message queries (that starvation is what made the app stutter
      // while this pane refreshed). The scan lane is lazy and persistent, so
      // Node pays worker/open/configure cost once per Database lifetime.
      const result = yield* queryPermit.withPermits(1)(
        Effect.gen(function* () {
          const conn = yield* scanDb()
          const rows = yield* conn
            .all<UsageRow>(
              sql`
                SELECT
                  r.message_id AS id,
                  r.session_id,
                  r.provider_id,
                  r.model_id,
                  r.variant,
                  r.created_at AS created_ms,
                  r.completed_at AS completed_ms,
                  r.request_sent_at AS request_sent_ms,
                  r.first_token_at AS first_token_ms,
                  r.streamed_at AS streamed_ms,
                  r.cost_usd,
                  r.input_tokens,
                  r.cache_read_tokens,
                  r.cache_write_tokens,
                  r.output_tokens,
                  r.reasoning_tokens,
                  COALESCE(s.project_id, us.project_id, '__historical__') AS project_id,
                  COALESCE(s.directory, us.directory, 'Historical usage') AS directory,
                  COALESCE(s.title, us.title, 'Deleted session') AS session_title,
                  COALESCE(p.name, us.project_name) AS project_name,
                  r.agent,
                  r.mode
                FROM usage_record r
                LEFT JOIN session s ON s.id = r.session_id
                LEFT JOIN project p ON p.id = s.project_id
                LEFT JOIN usage_session us ON us.session_id = r.session_id
                WHERE r.completed_at >= ${request.since}
                  AND r.completed_at < ${request.until}
                  AND (${projectID} IS NULL OR COALESCE(s.project_id, us.project_id, '__historical__') = ${projectID})
                ORDER BY completed_ms ASC

              `,
            )
            .pipe(Effect.orDie)
          const maintenanceRows = yield* conn
            .all<MaintenanceUsageRow>(
              sql`
                SELECT
                  agent,
                  provider_id,
                  model_id,
                  variant,
                  session_id,
                  project_id,
                  requests,
                  cost_usd,
                  cost_estimated,
                  input_tokens,
                  cache_read_tokens,
                  cache_write_tokens,
                  output_tokens,
                  reasoning_tokens,
                  total_tokens,
                  time_started AS started_ms,
                  time_completed AS completed_ms
                FROM maintenance_usage
                WHERE time_completed >= ${request.since}
                  AND time_completed < ${request.until}
                  AND (${projectID} IS NULL OR project_id = ${projectID})
                ORDER BY time_completed ASC
              `,
            )
            .pipe(Effect.orDie)
          return aggregate(rows, maintenanceRows, rates, request)
        }),
      )

      if (summaryCache.size > 100) summaryCache.clear()
      summaryCache.set(key, { at: Date.now(), revision, value: result })
      return result
    })

    const modelProfile = Effect.fn("Usage.modelProfile")(function* () {
      const revision = UsageRecord.revision()
      const hit = modelProfileCache
      if (
        hit &&
        hit.database === filename &&
        hit.revision === revision &&
        Date.now() - hit.at < MODEL_PROFILE_CACHE_TTL_MS
      )
        return hit.value
      const rows = yield* queryPermit.withPermits(1)(
        Effect.gen(function* () {
          const conn = yield* scanDb()
          return yield* conn
            .all<ModelProfileRow>(sql`
              WITH recent AS (
                SELECT
                  provider_id,
                  model_id,
                  cost_usd,
                  input_tokens,
                  cache_read_tokens,
                  ROW_NUMBER() OVER (
                    PARTITION BY provider_id, model_id
                    ORDER BY completed_at DESC, message_id DESC
                  ) AS sample_rank
                FROM usage_record
                WHERE COALESCE(mode, '') <> ${UsageClassification.MAINTENANCE_MODE}
              )
              SELECT
                provider_id,
                model_id,
                SUM(CASE WHEN cost_usd > 0 THEN 1 ELSE 0 END) AS cost_samples,
                SUM(CASE WHEN cost_usd > 0 THEN cost_usd ELSE 0 END) AS cost_sum,
                SUM(CASE WHEN input_tokens > 0 OR cache_read_tokens > 0 THEN 1 ELSE 0 END) AS cache_samples,
                SUM(input_tokens) AS input_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens
              FROM recent
              WHERE sample_rank <= 200
              GROUP BY provider_id, model_id
            `)
            .pipe(Effect.orDie)
        }),
      )
      const value: ModelProfile = {
        models: rows.map((row) => ({
          providerID: row.provider_id,
          modelID: row.model_id,
          costSamples: row.cost_samples,
          averageCost: row.cost_samples > 0 ? row.cost_sum / row.cost_samples : 0,
          cacheSamples: row.cache_samples,
          cacheHitRate:
            row.input_tokens + row.cache_read_tokens > 0
              ? row.cache_read_tokens / (row.input_tokens + row.cache_read_tokens)
              : 0,
        })),
      }
      modelProfileCache = { at: Date.now(), database: filename, revision, value }
      return value
    })

    const pricingCatalog = Effect.fn("Usage.pricingCatalog")(function* () {
      const catalog = yield* modelsDev.get()
      return {
        models: Object.values(catalog).flatMap((provider) =>
          Object.entries(provider.models).map(([modelID, model]) => ({
            providerID: provider.id,
            providerName: provider.name,
            modelID,
            name: model.name,
            ...(model.family === undefined ? {} : { family: model.family }),
            cost: {
              input: model.cost?.input ?? 0,
              output: model.cost?.output ?? 0,
              cache: {
                read: model.cost?.cache_read ?? model.cost?.input ?? 0,
                write: model.cost?.cache_write ?? model.cost?.input ?? 0,
              },
            },
          })),
        ),
      }
    })

    const sessionContext = Effect.fn("Usage.sessionContext")(function* (sessionID: string) {
      const catalog = yield* modelsDev.get()
      const raw = yield* contextQueryPermit.withPermits(1)(
        Effect.gen(function* () {
            const conn = readDb
            const sessionRows = yield* conn
              .all<SessionContextSessionRow>(sql`
                SELECT
                  id AS session_id,
                  CASE WHEN json_type(metadata, '$.specialAgent') = 'text' THEN 1 ELSE 0 END AS special_agent,
                  CAST(json_extract(model, '$.providerID') AS TEXT) AS model_provider_id,
                  CAST(json_extract(model, '$.id') AS TEXT) AS model_id,
                  CAST(json_extract(model, '$.variant') AS TEXT) AS model_variant,
                  cost AS cost_usd,
                  tokens_input AS input_tokens,
                  tokens_output AS output_tokens,
                  tokens_reasoning AS reasoning_tokens,
                  tokens_cache_read AS cache_read_tokens,
                  tokens_cache_write AS cache_write_tokens,
                  time_created AS created_ms,
                  time_updated AS updated_ms,
                  COALESCE((
                    SELECT seq
                    FROM event_sequence
                    WHERE aggregate_id = session.id
                    LIMIT 1
                  ), 0) AS event_seq,
                  (
                    SELECT completed_at
                    FROM usage_record
                    WHERE session_id = session.id
                    ORDER BY completed_at DESC, message_id DESC
                    LIMIT 1
                  ) AS latest_usage_completed_at,
                  (
                    SELECT message_id
                    FROM usage_record
                    WHERE session_id = session.id
                    ORDER BY completed_at DESC, message_id DESC
                    LIMIT 1
                  ) AS latest_usage_message_id
                FROM session
                WHERE id = ${sessionID}
                LIMIT 1
                  `)
                  .pipe(Effect.orDie)
            const sessionRow = sessionRows[0]
            if (!sessionRow) return undefined

            const cacheKey = `${filename}:${sessionID}`
            const cached = sessionContextProjectionCache.get(cacheKey)
            if (
              cached &&
              Date.now() - cached.at < SESSION_CONTEXT_CACHE_TTL_MS &&
              cached.eventSeq === sessionRow.event_seq &&
              cached.updatedAt === sessionRow.updated_ms &&
              cached.latestUsageCompletedAt === sessionRow.latest_usage_completed_at &&
              cached.latestUsageMessageID === sessionRow.latest_usage_message_id
            ) {
              return { sessionRow, ...cached.value }
            }

            // Collapse the entire settled history inside SQLite. The wire/process
            // result is O(models), not O(turns), and the indexed session_id scan
            // touches only scalar usage rows.
            const modelRows = sessionRow.special_agent
              ? yield* conn
                  .all<SessionContextModelRow>(sql`
                    WITH tool_counts AS (
                      SELECT
                        o.message_id,
                        COUNT(*) AS tool_calls
                      FROM session_message_tool_overlay o
                      JOIN session_message m ON m.id = o.message_id
                      WHERE m.session_id = ${sessionID}
                      GROUP BY o.message_id
                    ),
                    tool_times AS (
                      SELECT
                        m.id AS message_id,
                        COALESCE(SUM(
                          CASE
                            WHEN json_extract(content.value, '$.type') = 'tool'
                              AND json_extract(content.value, '$.time.completed') IS NOT NULL
                            THEN MAX(
                              0,
                              CAST(json_extract(content.value, '$.time.completed') AS INTEGER) -
                              COALESCE(
                                CAST(json_extract(content.value, '$.time.ran') AS INTEGER),
                                CAST(json_extract(content.value, '$.time.created') AS INTEGER)
                              )
                            )
                            ELSE 0
                          END
                        ), 0) AS tool_ms
                      FROM session_message m
                      LEFT JOIN json_each(m.data, '$.content') content
                        ON m.type = 'assistant'
                      WHERE m.session_id = ${sessionID}
                        AND m.type = 'assistant'
                      GROUP BY m.id
                    ),
                    turns AS (
                      SELECT
                        m.id AS message_id,
                        COALESCE(
                          CAST(json_extract(m.data, '$.model.providerID') AS TEXT),
                          ${sessionRow.model_provider_id}
                        ) AS provider_id,
                        COALESCE(
                          CAST(json_extract(m.data, '$.model.id') AS TEXT),
                          ${sessionRow.model_id}
                        ) AS model_id,
                        COALESCE(
                          CAST(json_extract(m.data, '$.model.variant') AS TEXT),
                          ${sessionRow.model_variant}
                        ) AS variant,
                        COALESCE(
                          CAST(json_extract(m.data, '$.time.created') AS INTEGER),
                          m.time_created
                        ) AS created_at,
                        CAST(json_extract(m.data, '$.time.requestSentAt') AS INTEGER) AS request_sent_at,
                        CAST(json_extract(m.data, '$.time.firstTokenAt') AS INTEGER) AS first_token_at,
                        COALESCE(
                          l.streamed_at,
                          CAST(json_extract(m.data, '$.time.streamedAt') AS INTEGER)
                        ) AS streamed_at,
                        CAST(json_extract(l.settlement, '$.completed') AS INTEGER) AS completed_at,
                        COALESCE(CAST(json_extract(l.settlement, '$.cost') AS REAL), 0) AS cost_usd,
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.input') AS INTEGER), 0) AS input_tokens,
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.cache.read') AS INTEGER), 0) AS cache_read_tokens,
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.cache.write') AS INTEGER), 0) AS cache_write_tokens,
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.output') AS INTEGER), 0) AS output_tokens,
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.reasoning') AS INTEGER), 0) AS reasoning_tokens,
                        COALESCE(tc.tool_calls, 0) AS tool_calls,
                        COALESCE(tt.tool_ms, 0) AS tool_ms
                      FROM session_message m
                      JOIN session_message_lifecycle l ON l.message_id = m.id
                      LEFT JOIN tool_counts tc ON tc.message_id = m.id
                      LEFT JOIN tool_times tt ON tt.message_id = m.id
                      WHERE m.session_id = ${sessionID}
                        AND m.type = 'assistant'
                        AND json_extract(l.settlement, '$.type') = 'ended'
                        AND COALESCE(
                          CAST(json_extract(m.data, '$.model.providerID') AS TEXT),
                          ${sessionRow.model_provider_id}
                        ) IS NOT NULL
                        AND COALESCE(
                          CAST(json_extract(m.data, '$.model.id') AS TEXT),
                          ${sessionRow.model_id}
                        ) IS NOT NULL
                    )
                    SELECT
                      provider_id,
                      model_id,
                      MIN(variant) AS variant,
                      COUNT(DISTINCT COALESCE(variant, '__null__')) AS variant_count,
                      COUNT(*) AS messages,
                      COALESCE(SUM(tool_calls), 0) AS tool_calls,
                      COALESCE(SUM(cost_usd), 0) AS cost_usd,
                      SUM(CASE WHEN cost_usd <= 0.000000001 THEN 1 ELSE 0 END) AS free_messages,
                      SUM(input_tokens) AS input_tokens,
                      SUM(cache_read_tokens) AS cache_read_tokens,
                      SUM(cache_write_tokens) AS cache_write_tokens,
                      SUM(output_tokens) AS output_tokens,
                      SUM(reasoning_tokens) AS reasoning_tokens,
                      SUM(CASE WHEN cost_usd <= 0.000000001 THEN input_tokens ELSE 0 END) AS free_input_tokens,
                      SUM(CASE WHEN cost_usd <= 0.000000001 THEN cache_read_tokens ELSE 0 END) AS free_cache_read_tokens,
                      SUM(CASE WHEN cost_usd <= 0.000000001 THEN cache_write_tokens ELSE 0 END) AS free_cache_write_tokens,
                      SUM(CASE WHEN cost_usd <= 0.000000001 THEN output_tokens ELSE 0 END) AS free_output_tokens,
                      SUM(CASE WHEN cost_usd <= 0.000000001 THEN reasoning_tokens ELSE 0 END) AS free_reasoning_tokens,
                      SUM(
                        CASE
                          WHEN first_token_at IS NOT NULL AND streamed_at IS NOT NULL AND streamed_at >= first_token_at
                          THEN streamed_at - first_token_at
                          ELSE 0
                        END
                      ) AS generated_ms,
                      COALESCE(SUM(tool_ms), 0) AS tool_ms,
                      SUM(
                        CASE
                          WHEN first_token_at IS NOT NULL AND created_at IS NOT NULL AND first_token_at >= created_at
                          THEN first_token_at - created_at
                          ELSE 0
                        END
                      ) AS ttft_ms,
                      SUM(
                        CASE
                          WHEN first_token_at IS NOT NULL AND created_at IS NOT NULL AND first_token_at >= created_at
                          THEN 1
                          ELSE 0
                        END
                      ) AS ttft_records,
                      SUM(
                        CASE
                          WHEN first_token_at IS NOT NULL AND request_sent_at IS NOT NULL AND first_token_at >= request_sent_at
                          THEN first_token_at - request_sent_at
                          ELSE 0
                        END
                      ) AS upstream_ttft_ms,
                      SUM(
                        CASE
                          WHEN first_token_at IS NOT NULL AND request_sent_at IS NOT NULL AND first_token_at >= request_sent_at
                          THEN 1
                          ELSE 0
                        END
                      ) AS upstream_ttft_records,
                      MIN(COALESCE(created_at, completed_at)) AS first_message_ms,
                      MAX(completed_at) AS last_message_ms
                    FROM turns
                    GROUP BY provider_id, model_id
                  `)
                  .pipe(Effect.orDie)
              : yield* conn
                  .all<SessionContextModelRow>(sql`
                WITH tool_stats AS (
                  SELECT
                    message_id,
                    COUNT(*) AS tool_calls,
                    COALESCE(SUM(
                      CASE
                        WHEN json_extract(data, '$.state.time.start') IS NOT NULL
                          AND json_extract(data, '$.state.time.end') IS NOT NULL
                        THEN MAX(
                          0,
                          CAST(json_extract(data, '$.state.time.end') AS INTEGER) -
                          CAST(json_extract(data, '$.state.time.start') AS INTEGER)
                        )
                        ELSE 0
                      END
                    ), 0) AS tool_ms
                  FROM part
                  WHERE session_id = ${sessionID}
                    AND json_extract(data, '$.type') = 'tool'
                  GROUP BY message_id
                )
                SELECT
                  u.provider_id,
                  u.model_id,
                  MIN(u.variant) AS variant,
                  COUNT(DISTINCT COALESCE(u.variant, '__null__')) AS variant_count,
                  COUNT(*) AS messages,
                  COALESCE(SUM(t.tool_calls), 0) AS tool_calls,
                  COALESCE(SUM(u.cost_usd), 0) AS cost_usd,
                  SUM(CASE WHEN u.cost_usd IS NOT NULL AND u.cost_usd <= 0.000000001 THEN 1 ELSE 0 END) AS free_messages,
                  SUM(u.input_tokens) AS input_tokens,
                  SUM(u.cache_read_tokens) AS cache_read_tokens,
                  SUM(u.cache_write_tokens) AS cache_write_tokens,
                  SUM(u.output_tokens) AS output_tokens,
                  SUM(u.reasoning_tokens) AS reasoning_tokens,
                  SUM(CASE WHEN u.cost_usd IS NOT NULL AND u.cost_usd <= 0.000000001 THEN u.input_tokens ELSE 0 END) AS free_input_tokens,
                  SUM(CASE WHEN u.cost_usd IS NOT NULL AND u.cost_usd <= 0.000000001 THEN u.cache_read_tokens ELSE 0 END) AS free_cache_read_tokens,
                  SUM(CASE WHEN u.cost_usd IS NOT NULL AND u.cost_usd <= 0.000000001 THEN u.cache_write_tokens ELSE 0 END) AS free_cache_write_tokens,
                  SUM(CASE WHEN u.cost_usd IS NOT NULL AND u.cost_usd <= 0.000000001 THEN u.output_tokens ELSE 0 END) AS free_output_tokens,
                  SUM(CASE WHEN u.cost_usd IS NOT NULL AND u.cost_usd <= 0.000000001 THEN u.reasoning_tokens ELSE 0 END) AS free_reasoning_tokens,
                  SUM(
                    CASE
                      WHEN u.first_token_at IS NOT NULL AND u.streamed_at IS NOT NULL AND u.streamed_at >= u.first_token_at
                      THEN u.streamed_at - u.first_token_at
                      ELSE 0
                    END
                  ) AS generated_ms,
                  COALESCE(SUM(t.tool_ms), 0) AS tool_ms,
                  SUM(
                    CASE
                      WHEN u.first_token_at IS NOT NULL AND u.created_at IS NOT NULL AND u.first_token_at >= u.created_at
                      THEN u.first_token_at - u.created_at
                      ELSE 0
                    END
                  ) AS ttft_ms,
                  SUM(
                    CASE
                      WHEN u.first_token_at IS NOT NULL AND u.created_at IS NOT NULL AND u.first_token_at >= u.created_at
                      THEN 1
                      ELSE 0
                    END
                  ) AS ttft_records,
                  SUM(
                    CASE
                      WHEN u.first_token_at IS NOT NULL AND u.request_sent_at IS NOT NULL AND u.first_token_at >= u.request_sent_at
                      THEN u.first_token_at - u.request_sent_at
                      ELSE 0
                    END
                  ) AS upstream_ttft_ms,
                  SUM(
                    CASE
                      WHEN u.first_token_at IS NOT NULL AND u.request_sent_at IS NOT NULL AND u.first_token_at >= u.request_sent_at
                      THEN 1
                      ELSE 0
                    END
                  ) AS upstream_ttft_records,
                  MIN(COALESCE(u.created_at, u.completed_at)) AS first_message_ms,
                  MAX(u.completed_at) AS last_message_ms
                FROM usage_record u
                LEFT JOIN tool_stats t ON t.message_id = u.message_id
                WHERE u.session_id = ${sessionID}
                GROUP BY u.provider_id, u.model_id
                  `)
                  .pipe(Effect.orDie)

            // Some pre-usage-ledger special-agent transcripts settled provider
            // accounting only into maintenance_usage. Prefer the canonical
            // per-message settlement projection above; use maintenance rows only
            // when that historical transcript has no settled assistant rows at
            // all. This preserves old auditors without double-counting modern
            // special-agent turns, which write both usage_record and
            // maintenance_usage.
            const resolvedModelRows =
              sessionRow.special_agent && modelRows.length === 0
                ? yield* conn
                    .all<SessionContextModelRow>(sql`
                      SELECT
                        provider_id,
                        model_id,
                        MIN(variant) AS variant,
                        COUNT(DISTINCT COALESCE(variant, '__null__')) AS variant_count,
                        COALESCE(SUM(requests), 0) AS messages,
                        0 AS tool_calls,
                        COALESCE(SUM(cost_usd), 0) AS cost_usd,
                        COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_usd <= 0.000000001 THEN requests ELSE 0 END), 0) AS free_messages,
                        COALESCE(SUM(input_tokens), 0) AS input_tokens,
                        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                        COALESCE(SUM(output_tokens), 0) AS output_tokens,
                        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                        COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_usd <= 0.000000001 THEN input_tokens ELSE 0 END), 0) AS free_input_tokens,
                        COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_usd <= 0.000000001 THEN cache_read_tokens ELSE 0 END), 0) AS free_cache_read_tokens,
                        COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_usd <= 0.000000001 THEN cache_write_tokens ELSE 0 END), 0) AS free_cache_write_tokens,
                        COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_usd <= 0.000000001 THEN output_tokens ELSE 0 END), 0) AS free_output_tokens,
                        COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_usd <= 0.000000001 THEN reasoning_tokens ELSE 0 END), 0) AS free_reasoning_tokens,
                        0 AS generated_ms,
                        0 AS tool_ms,
                        0 AS ttft_ms,
                        0 AS ttft_records,
                        0 AS upstream_ttft_ms,
                        0 AS upstream_ttft_records,
                        MIN(time_started) AS first_message_ms,
                        MAX(time_completed) AS last_message_ms
                      FROM maintenance_usage
                      WHERE session_id = ${sessionID}
                      GROUP BY provider_id, model_id
                    `)
                    .pipe(Effect.orDie)
                : modelRows

            // Historical sessions can predate SessionTelemetry. Keep the cold
            // fallback scalar-only and index-backed: the existing
            // (session_id, completed_at) index serves this newest-settlement
            // lookup without decoding any assistant message JSON.
            const latestRows = sessionRow.special_agent
              ? yield* conn
                  .all<SessionContextLatestRow>(sql`
                    SELECT
                      COALESCE(
                        CAST(json_extract(m.data, '$.model.providerID') AS TEXT),
                        ${sessionRow.model_provider_id}
                      ) AS provider_id,
                      COALESCE(
                        CAST(json_extract(m.data, '$.model.id') AS TEXT),
                        ${sessionRow.model_id}
                      ) AS model_id,
                      COALESCE(
                        CAST(json_extract(m.data, '$.model.variant') AS TEXT),
                        ${sessionRow.model_variant}
                      ) AS variant,
                      CAST(json_extract(l.settlement, '$.completed') AS INTEGER) AS completed_at,
                      COALESCE(CAST(json_extract(l.settlement, '$.tokens.input') AS INTEGER), 0) AS input_tokens,
                      COALESCE(CAST(json_extract(l.settlement, '$.tokens.cache.read') AS INTEGER), 0) AS cache_read_tokens,
                      COALESCE(CAST(json_extract(l.settlement, '$.tokens.cache.write') AS INTEGER), 0) AS cache_write_tokens,
                      COALESCE(CAST(json_extract(l.settlement, '$.tokens.output') AS INTEGER), 0) AS output_tokens,
                      COALESCE(CAST(json_extract(l.settlement, '$.tokens.reasoning') AS INTEGER), 0) AS reasoning_tokens
                    FROM session_message m
                    JOIN session_message_lifecycle l ON l.message_id = m.id
                    WHERE m.session_id = ${sessionID}
                      AND m.type = 'assistant'
                      AND json_extract(l.settlement, '$.type') = 'ended'
                      AND (
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.input') AS INTEGER), 0) +
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.cache.read') AS INTEGER), 0) +
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.cache.write') AS INTEGER), 0) +
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.output') AS INTEGER), 0) +
                        COALESCE(CAST(json_extract(l.settlement, '$.tokens.reasoning') AS INTEGER), 0)
                      ) > 0
                    ORDER BY CAST(json_extract(l.settlement, '$.completed') AS INTEGER) DESC, m.seq DESC
                    LIMIT 1
                  `)
                  .pipe(Effect.orDie)
              : yield* conn
                  .all<SessionContextLatestRow>(sql`
                SELECT
                  provider_id,
                  model_id,
                  variant,
                  completed_at,
                  input_tokens,
                  cache_read_tokens,
                  cache_write_tokens,
                  output_tokens,
                  reasoning_tokens
                FROM usage_record
                WHERE session_id = ${sessionID}
                  AND (
                    input_tokens +
                    cache_read_tokens +
                    cache_write_tokens +
                    output_tokens +
                    reasoning_tokens
                  ) > 0
                ORDER BY completed_at DESC, message_id DESC
                LIMIT 1
                  `)
                  .pipe(Effect.orDie)

            const resolvedLatestRows =
              sessionRow.special_agent && latestRows.length === 0
                ? yield* conn
                    .all<SessionContextLatestRow>(sql`
                      SELECT
                        provider_id,
                        model_id,
                        variant,
                        time_completed AS completed_at,
                        input_tokens,
                        cache_read_tokens,
                        cache_write_tokens,
                        output_tokens,
                        reasoning_tokens
                      FROM maintenance_usage
                      WHERE session_id = ${sessionID}
                        AND (
                          input_tokens +
                          cache_read_tokens +
                          cache_write_tokens +
                          output_tokens +
                          reasoning_tokens
                        ) > 0
                      ORDER BY time_completed DESC, rowid DESC
                      LIMIT 1
                    `)
                    .pipe(Effect.orDie)
                : latestRows

            // Keep semantic classification in the centralized provenance owner,
            // but collapse repeated message metadata in SQLite first. Result
            // cardinality is O(distinct semantic sources), never O(messages).
            const messageGroups = sessionRow.special_agent
              ? yield* conn
                  .all<SessionContextMessageGroupRow>(sql`
                    SELECT
                      type AS message_type,
                      CASE
                        WHEN type = 'assistant' THEN 'assistant'
                        WHEN type IN ('user', 'synthetic') THEN 'user'
                        ELSE NULL
                      END AS role,
                      json_extract(data, '$.provenance.owner') AS provenance_owner,
                      json_extract(data, '$.provenance.source') AS provenance_source,
                      json_extract(data, '$.provenance.lifetime') AS provenance_lifetime,
                      COUNT(*) AS messages
                    FROM session_message
                    WHERE session_id = ${sessionID}
                      AND type IN ('user', 'synthetic', 'system', 'shell', 'compaction', 'assistant')
                    GROUP BY 1, 2, 3, 4, 5
                  `)
                  .pipe(Effect.orDie)
              : yield* conn
                  .all<SessionContextMessageGroupRow>(sql`
                    SELECT
                      NULL AS message_type,
                      json_extract(data, '$.role') AS role,
                      json_extract(data, '$.provenance.owner') AS provenance_owner,
                      json_extract(data, '$.provenance.source') AS provenance_source,
                      json_extract(data, '$.provenance.lifetime') AS provenance_lifetime,
                      COUNT(*) AS messages
                    FROM message
                    WHERE session_id = ${sessionID}
                    GROUP BY 1, 2, 3, 4, 5
                  `)
                  .pipe(Effect.orDie)

            // A Session can accumulate many user-role host continuations that
            // repeat the same system prompt. Keep only the newest non-empty
            // candidate per semantic provenance tuple, then let the shared
            // provenance classifier choose the newest genuine user prompt.
            const promptRows = sessionRow.special_agent
              ? ([] satisfies SessionContextPromptRow[])
              : yield* conn
                  .all<SessionContextPromptRow>(sql`
                WITH ranked AS (
                  SELECT
                    id,
                    json_extract(data, '$.role') AS role,
                    json_extract(data, '$.provenance.owner') AS provenance_owner,
                    json_extract(data, '$.provenance.source') AS provenance_source,
                    json_extract(data, '$.provenance.lifetime') AS provenance_lifetime,
                    CAST(json_extract(data, '$.system') AS TEXT) AS system_prompt,
                    time_created AS created_ms,
                    ROW_NUMBER() OVER (
                      PARTITION BY
                        COALESCE(json_extract(data, '$.role'), ''),
                        COALESCE(json_extract(data, '$.provenance.owner'), ''),
                        COALESCE(json_extract(data, '$.provenance.source'), ''),
                        COALESCE(json_extract(data, '$.provenance.lifetime'), '')
                      ORDER BY time_created DESC, id DESC
                    ) AS row_rank
                  FROM message
                  WHERE session_id = ${sessionID}
                    AND TRIM(COALESCE(CAST(json_extract(data, '$.system') AS TEXT), '')) <> ''
                )
                SELECT
                  id,
                  NULL AS message_type,
                  role,
                  provenance_owner,
                  provenance_source,
                  provenance_lifetime,
                  system_prompt,
                  created_ms
                FROM ranked
                WHERE row_rank = 1
              `)
              .pipe(Effect.orDie)

            // Aggregate context-shape characters in SQLite. Legacy V1 data is
            // measured directly from message/part JSON. Current special-agent
            // rows do the same while inline, with search_text only as a bounded
            // fallback for OPCL-externalized canonical payloads. The fallback is
            // deliberately approximate (tool results are not fully indexed),
            // but it prevents an externalized transcript from collapsing to a
            // fictitious zero-context shape without hydrating event_value blobs.
            // Only fixed-size sums cross into JavaScript.
            const partGroups = sessionRow.special_agent
              ? yield* conn
                  .all<SessionContextPartGroupRow>(sql`
                    WITH projected AS (
                      SELECT
                        m.type AS message_type,
                        CASE
                          WHEN m.type = 'assistant' THEN 'assistant'
                          WHEN m.type IN ('user', 'synthetic') THEN 'user'
                          ELSE NULL
                        END AS role,
                        json_extract(m.data, '$.provenance.owner') AS provenance_owner,
                        json_extract(m.data, '$.provenance.source') AS provenance_source,
                        json_extract(m.data, '$.provenance.lifetime') AS provenance_lifetime,
                        CASE m.type
                          WHEN 'user' THEN length(COALESCE(CAST(json_extract(m.data, '$.text') AS TEXT), NULLIF(m.search_text, ''), ''))
                          WHEN 'synthetic' THEN length(COALESCE(CAST(json_extract(m.data, '$.text') AS TEXT), NULLIF(m.search_text, ''), ''))
                          WHEN 'system' THEN length(COALESCE(CAST(json_extract(m.data, '$.text') AS TEXT), NULLIF(m.search_text, ''), ''))
                          WHEN 'shell' THEN
                            CASE
                              WHEN json_extract(m.data, '$.command') IS NULL
                                AND json_extract(m.data, '$.output') IS NULL
                              THEN length(COALESCE(m.search_text, ''))
                              ELSE
                                length(COALESCE(CAST(json_extract(m.data, '$.command') AS TEXT), '')) +
                                length(COALESCE(CAST(json_extract(m.data, '$.output') AS TEXT), ''))
                            END
                          WHEN 'compaction' THEN
                            CASE
                              WHEN json_extract(m.data, '$.summary') IS NULL
                                AND json_extract(m.data, '$.recent') IS NULL
                              THEN length(COALESCE(m.search_text, ''))
                              ELSE
                                length(COALESCE(CAST(json_extract(m.data, '$.summary') AS TEXT), '')) +
                                length(COALESCE(CAST(json_extract(m.data, '$.recent') AS TEXT), ''))
                            END
                          ELSE 0
                        END AS content_chars,
                        0 AS tool_chars
                      FROM session_message m
                      WHERE m.session_id = ${sessionID}
                        AND m.type <> 'assistant'

                      UNION ALL

                      SELECT
                        'assistant' AS message_type,
                        'assistant' AS role,
                        NULL AS provenance_owner,
                        NULL AS provenance_source,
                        NULL AS provenance_lifetime,
                        COALESCE(SUM(
                          CASE json_extract(content.value, '$.type')
                            WHEN 'text' THEN length(COALESCE(CAST(json_extract(content.value, '$.text') AS TEXT), ''))
                            WHEN 'reasoning' THEN length(COALESCE(CAST(json_extract(content.value, '$.text') AS TEXT), ''))
                            ELSE 0
                          END
                        ), 0) +
                        CASE
                          WHEN json_type(m.data, '$.content') IS NULL
                          THEN length(COALESCE(m.search_text, ''))
                          ELSE 0
                        END AS content_chars,
                        COALESCE(SUM(
                          CASE
                            WHEN json_extract(content.value, '$.type') <> 'tool' THEN 0
                            ELSE
                              length(COALESCE(CAST(json_extract(content.value, '$.state.input') AS TEXT), '')) +
                              CASE json_extract(content.value, '$.state.status')
                                WHEN 'pending' THEN 0
                                WHEN 'completed' THEN COALESCE((
                                  SELECT SUM(length(COALESCE(CAST(json_extract(tool_content.value, '$.text') AS TEXT), '')))
                                  FROM json_each(content.value, '$.state.content') tool_content
                                  WHERE json_extract(tool_content.value, '$.type') = 'text'
                                ), 0)
                                WHEN 'error' THEN length(COALESCE(CAST(json_extract(content.value, '$.state.error.message') AS TEXT), ''))
                                ELSE 0
                              END
                          END
                        ), 0) AS tool_chars
                      FROM session_message m
                      LEFT JOIN json_each(m.data, '$.content') content
                        ON m.type = 'assistant'
                      WHERE m.session_id = ${sessionID}
                        AND m.type = 'assistant'
                      GROUP BY m.id
                    )
                    SELECT
                      message_type,
                      role,
                      provenance_owner,
                      provenance_source,
                      provenance_lifetime,
                      COALESCE(SUM(content_chars), 0) AS content_chars,
                      COALESCE(SUM(tool_chars), 0) AS tool_chars
                    FROM projected
                    GROUP BY 1, 2, 3, 4, 5
                  `)
                  .pipe(Effect.orDie)
              : yield* conn
                  .all<SessionContextPartGroupRow>(sql`
                SELECT
                  NULL AS message_type,
                  json_extract(m.data, '$.role') AS role,
                  json_extract(m.data, '$.provenance.owner') AS provenance_owner,
                  json_extract(m.data, '$.provenance.source') AS provenance_source,
                  json_extract(m.data, '$.provenance.lifetime') AS provenance_lifetime,
                  COALESCE(SUM(
                    CASE json_extract(p.data, '$.type')
                      WHEN 'text' THEN length(COALESCE(CAST(json_extract(p.data, '$.text') AS TEXT), ''))
                      WHEN 'reasoning' THEN length(COALESCE(CAST(json_extract(p.data, '$.text') AS TEXT), ''))
                      WHEN 'file' THEN length(COALESCE(CAST(json_extract(p.data, '$.source.text.value') AS TEXT), ''))
                      WHEN 'agent' THEN length(COALESCE(CAST(json_extract(p.data, '$.source.value') AS TEXT), ''))
                      ELSE 0
                    END
                  ), 0) AS content_chars,
                  COALESCE(SUM(
                    CASE
                      WHEN json_extract(p.data, '$.type') <> 'tool' THEN 0
                      ELSE
                        length(COALESCE(CAST(json_extract(p.data, '$.state.input') AS TEXT), '')) +
                        CASE json_extract(p.data, '$.state.status')
                          WHEN 'pending' THEN length(COALESCE(CAST(json_extract(p.data, '$.state.raw') AS TEXT), ''))
                          WHEN 'completed' THEN length(COALESCE(CAST(json_extract(p.data, '$.state.output') AS TEXT), ''))
                          WHEN 'error' THEN length(COALESCE(CAST(json_extract(p.data, '$.state.error') AS TEXT), ''))
                          ELSE 0
                        END
                    END
                  ), 0) AS tool_chars
                FROM part p
                JOIN message m
                  ON m.id = p.message_id
                 AND m.session_id = p.session_id
                WHERE p.session_id = ${sessionID}
                GROUP BY 1, 2, 3, 4, 5
                  `)
                  .pipe(Effect.orDie)

            const value: SessionContextRawProjection = {
              modelRows: resolvedModelRows,
              latestRows: resolvedLatestRows,
              messageGroups,
              promptRows,
              partGroups,
            }
            if (!sessionContextProjectionCache.has(cacheKey) && sessionContextProjectionCache.size >= MAX_SESSION_CONTEXT_CACHE) {
              const oldest = sessionContextProjectionCache.keys().next().value
              if (oldest !== undefined) sessionContextProjectionCache.delete(oldest)
            }
            sessionContextProjectionCache.delete(cacheKey)
            sessionContextProjectionCache.set(cacheKey, {
              at: Date.now(),
              eventSeq: sessionRow.event_seq,
              updatedAt: sessionRow.updated_ms,
              latestUsageCompletedAt: sessionRow.latest_usage_completed_at,
              latestUsageMessageID: sessionRow.latest_usage_message_id,
              value,
            })
            return { sessionRow, ...value }
          }),
      )
      if (!raw) return undefined

      const { sessionRow, modelRows, latestRows, messageGroups, promptRows, partGroups } = raw
      let userMessages = 0
      let assistantMessages = 0
      let systemPrompt: string | null = null
      let messageCount = 0

      const semanticKind = (row: SessionContextSemanticRow) => {
        if (row.message_type === "assistant") return "assistant" as const
        // Current special-agent System events are durable transcript markers
        // (audit-cycle notices, read-only notices, etc.), not proof of the
        // privileged provider system prompt. Keep them in the catch-all
        // transcript bucket rather than labeling them provider-visible system
        // context.
        if (row.message_type === "system") return undefined
        if (row.message_type === "synthetic") return "synthetic" as const
        if (row.message_type === "shell") return "shell" as const
        if (row.message_type === "compaction") return "compaction" as const
        const role = row.role ?? "unknown"
        if (role !== "user") return role === "assistant" ? ("assistant" as const) : undefined
        const owner =
          row.provenance_owner === "user" || row.provenance_owner === "host"
            ? row.provenance_owner
            : undefined
        const provenance =
          owner && row.provenance_source
            ? owner === "user"
              ? {
                  owner: "user" as const,
                  source: row.provenance_source,
                  ...(row.provenance_lifetime === "historical" ? { lifetime: "historical" as const } : {}),
                }
              : {
                  owner: "host" as const,
                  source: row.provenance_source,
                  ...(row.provenance_lifetime === "historical" ? { lifetime: "historical" as const } : {}),
                }
            : undefined
        return SessionTurnProvenance.semanticKindInfo({ role, provenance })
      }

      for (const row of messageGroups) {
        messageCount += row.messages
        const kind = semanticKind(row)
        if (kind === "user") userMessages += row.messages
        if (kind === "assistant") assistantMessages += row.messages
      }

      for (const row of promptRows.sort(
        (left, right) => right.created_ms - left.created_ms || right.id.localeCompare(left.id),
      )) {
        if (semanticKind(row) !== "user") continue
        const prompt = row.system_prompt.trim()
        if (!prompt) continue
        systemPrompt = prompt
        break
      }

      const breakdown: Mutable<SessionContextBreakdown> = {
        system: systemPrompt ? Math.ceil(systemPrompt.length / 4) : 0,
        user: 0,
        synthetic: 0,
        shell: 0,
        compaction: 0,
        assistant: 0,
        tool: 0,
        other: 0,
      }
      const toolCalls = modelRows.reduce((sum, row) => sum + row.tool_calls, 0)
      const toolMs = modelRows.reduce((sum, row) => sum + row.tool_ms, 0)

      for (const row of partGroups) {
        const contentTokens = Math.max(0, Math.ceil(row.content_chars / 4))
        const toolTokens = Math.max(0, Math.ceil(row.tool_chars / 4))
        const kind = semanticKind(row)
        if (kind === "assistant") {
          breakdown.assistant += contentTokens
          breakdown.tool += toolTokens
          continue
        }
        if (kind === "user") breakdown.user += contentTokens
        else if (kind === "shell") breakdown.shell += contentTokens
        else if (kind === "compaction") breakdown.compaction += contentTokens
        else if (kind === "synthetic") breakdown.synthetic += contentTokens
        else breakdown.other += contentTokens + toolTokens
      }

      const freeTokens = zeroTokens()
      let freeMessages = 0
      let generatedMs = 0
      let ttftMs = 0
      let ttftRecords = 0
      let upstreamTTFTMs = 0
      let upstreamTTFTRecords = 0
      let settledMessages = 0
      let settledCost = 0
      const settledTokens = zeroTokens()

      for (const row of modelRows) {
        settledMessages += row.messages
        settledCost += row.cost_usd
        settledTokens.input += row.input_tokens
        settledTokens.cacheRead += row.cache_read_tokens
        settledTokens.cacheWrite += row.cache_write_tokens
        settledTokens.output += row.output_tokens
        settledTokens.reasoning += row.reasoning_tokens
        freeMessages += row.free_messages
        freeTokens.input += row.free_input_tokens
        freeTokens.cacheRead += row.free_cache_read_tokens
        freeTokens.cacheWrite += row.free_cache_write_tokens
        freeTokens.output += row.free_output_tokens
        freeTokens.reasoning += row.free_reasoning_tokens
        generatedMs += row.generated_ms
        ttftMs += row.ttft_ms
        ttftRecords += row.ttft_records
        upstreamTTFTMs += row.upstream_ttft_ms
        upstreamTTFTRecords += row.upstream_ttft_records
      }

      const providerCatalog = new Map(Object.values(catalog).map((provider) => [provider.id, provider] as const))
      const catalogModel = (provider: (typeof catalog)[string] | undefined, modelID: string) =>
        provider?.models[modelID] ?? provider?.models[splitAccountModelID(modelID).baseModelID]
      const latestRow = latestRows[0]
      const latest: SessionContextLatest | undefined = latestRow
        ? (() => {
            const provider = providerCatalog.get(latestRow.provider_id)
            const model = catalogModel(provider, latestRow.model_id)
            return {
              providerID: latestRow.provider_id,
              modelID: latestRow.model_id,
              ...(latestRow.variant ? { variant: latestRow.variant } : {}),
              providerName: provider?.name ?? latestRow.provider_id,
              modelName: model?.name ?? latestRow.model_id,
              ...(model ? { contextLimit: model.limit.context } : {}),
              completedAt: latestRow.completed_at,
              tokens: {
                input: latestRow.input_tokens,
                cacheRead: latestRow.cache_read_tokens,
                cacheWrite: latestRow.cache_write_tokens,
                output: latestRow.output_tokens,
                reasoning: latestRow.reasoning_tokens,
              },
            }
          })()
        : undefined
      const projectedModels: SessionContextModel[] = modelRows
        .map((row) => {
          const provider = providerCatalog.get(row.provider_id)
          const model = catalogModel(provider, row.model_id)
          const cost = model?.cost
          return {
            providerID: row.provider_id,
            modelID: row.model_id,
            variant: row.variant_count === 1 ? row.variant : null,
            providerName: provider?.name ?? row.provider_id,
            modelName: model?.name ?? row.model_id,
            messages: row.messages,
            toolCalls: row.tool_calls,
            cost: row.cost_usd,
            freeMessages: row.free_messages,
            tokens: {
              input: row.input_tokens,
              cacheRead: row.cache_read_tokens,
              cacheWrite: row.cache_write_tokens,
              output: row.output_tokens,
              reasoning: row.reasoning_tokens,
            },
            freeTokens: {
              input: row.free_input_tokens,
              cacheRead: row.free_cache_read_tokens,
              cacheWrite: row.free_cache_write_tokens,
              output: row.free_output_tokens,
              reasoning: row.free_reasoning_tokens,
            },
            generatedMs: row.generated_ms,
            toolMs: row.tool_ms,
            ttftMs: row.ttft_ms,
            ttftRecords: row.ttft_records,
            upstreamTTFTMs: row.upstream_ttft_ms,
            upstreamTTFTRecords: row.upstream_ttft_records,
            firstMessageTime: row.first_message_ms,
            lastMessageTime: row.last_message_ms,
            ...(cost
              ? {
                  costRate: {
                    input: cost.input,
                    output: cost.output,
                    cache: {
                      read: cost.cache_read ?? cost.input,
                      write: cost.cache_write ?? cost.input,
                    },
                  },
                }
              : {}),
          }
        })
        .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens))

      return {
        sessionID,
        createdAt: sessionRow.created_ms,
        updatedAt: sessionRow.updated_ms,
        counts: {
          all: messageCount,
          user: userMessages,
          assistant: assistantMessages,
        },
        systemPrompt,
        totals: {
          messages: settledMessages,
          toolCalls,
          cost: sessionRow.special_agent ? settledCost : sessionRow.cost_usd,
          freeMessages,
          tokens: sessionRow.special_agent
            ? settledTokens
            : {
                input: sessionRow.input_tokens,
                cacheRead: sessionRow.cache_read_tokens,
                cacheWrite: sessionRow.cache_write_tokens,
                output: sessionRow.output_tokens,
                reasoning: sessionRow.reasoning_tokens,
              },
          freeTokens,
          generatedMs,
          toolMs,
          ttftMs,
          ttftRecords,
          upstreamTTFTMs,
          upstreamTTFTRecords,
        },
        models: projectedModels,
        latest,
        breakdown,
      } satisfies SessionContextHistory
    })

    /**
     * Persist one completed support-agent generation (or an already-aggregated
     * operation with requests > 1). Usage accounting must never become a new
     * failure mode for the feature being measured, so storage failures are
     * intentionally best-effort and leave the caller unaffected.
     */
    const recordMaintenance: Interface["recordMaintenance"] = (input) =>
      Effect.gen(function* () {
        const completedAt = input.completedAt ?? Date.now()
        const startedAt = Math.min(input.startedAt ?? completedAt, completedAt)
        const requests = Math.max(1, Math.floor(input.requests ?? 1))
        const detailTotal = totalTokens(input.tokens)
        const allTokens = Math.max(detailTotal, Math.floor(input.totalTokens ?? detailTotal))
        const sessionID = input.sessionID ?? null
        const projectID = input.projectID ?? null
        const variant = input.variant ?? null
        const settled = UsageRouteAttribution.settle({ route: input.route })
        const routeKind = input.route === undefined ? "unknown" : settled.attribution.kind
        const accountID = settled.accountID ?? null
        const cost = input.cost !== undefined && input.cost !== null && Number.isFinite(input.cost) ? input.cost : null
        yield* db.run(sql`
          INSERT INTO maintenance_usage (
            agent, provider_id, model_id, route_kind, account_id, variant, session_id, project_id,
            requests, cost_usd, cost_estimated, input_tokens, cache_read_tokens,
            cache_write_tokens, output_tokens, reasoning_tokens, total_tokens,
            time_started, time_completed
          ) VALUES (
            ${input.agent}, ${input.providerID}, ${input.modelID}, ${routeKind}, ${accountID}, ${variant}, ${sessionID},
            COALESCE(${projectID}, (SELECT project_id FROM session WHERE id = ${sessionID} LIMIT 1)),
            ${requests}, ${cost}, ${input.costEstimated === true ? 1 : 0}, ${input.tokens.input}, ${input.tokens.cacheRead},
            ${input.tokens.cacheWrite}, ${input.tokens.output}, ${input.tokens.reasoning}, ${allTokens},
            ${startedAt}, ${completedAt}
          )
        `)
        // Maintenance calls are infrequent; clearing is cheaper and safer than
        // trying to mutate every cached range that may contain this timestamp.
        summaryCache.clear()
      }).pipe(Effect.catch(() => Effect.void))

    return Service.of({ summary, modelProfile, pricingCatalog, sessionContext, recordMaintenance })
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

function aggregate(
  rows: UsageRow[],
  maintenanceRows: MaintenanceUsageRow[],
  rates: Map<string, ModelRates>,
  request: UsageSummaryRequest,
): UsageSummary {
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
  const providerSeriesData = new Map<string, Map<number, { cost: number; tokens: number; messages: number }>>()
  const modelSeriesData = new Map<string, Map<number, { cost: number; tokens: number; messages: number }>>()
  const days = new Map<number, Mutable<DayBucket>>()
  const dow = Array.from({ length: 7 }, emptyBucket)
  const hours = Array.from({ length: 24 }, emptyBucket)
  const punchcard = Array.from({ length: 7 * 24 }, emptyBucket)
  const sessionBuckets = new Map<string, Mutable<SessionBucket>>()
  const sessionModels = new Map<string, Set<string>>()
  const daySessions = new Map<number, Set<string>>()
  const sessions = new Set<string>()
  const providerSessions = new Map<string, Set<string>>()
  const projectSessions = new Map<string, Set<string>>()
  let cacheSavings = 0
  let cacheSavingsRecords = 0
  let estimatedRecords = 0
  let throughputMs = 0

  const generationWindow = (row: UsageRow, completed: number) => {
    if (row.first_token_ms !== null && row.streamed_ms !== null && row.streamed_ms >= row.first_token_ms)
      return row.streamed_ms - row.first_token_ms
    if (row.created_ms !== null && completed >= row.created_ms) return completed - row.created_ms
    return undefined
  }

  const maintenanceTotals: Mutable<MaintenanceTotals> = {
    requests: 0,
    sessions: 0,
    cost: 0,
    estimatedCost: 0,
    pricedRecords: 0,
    estimatedRecords: 0,
    unpricedRecords: 0,
    tokens: zeroTokens(),
    totalTokens: 0,
    durationMs: 0,
    durationRecords: 0,
  }
  const maintenanceAgents = new Map<string, Mutable<MaintenanceAgentBucket>>()
  const maintenanceModels = new Map<string, Mutable<MaintenanceModelBucket>>()
  const maintenancePeriods = new Map<number, Mutable<MaintenancePeriodBucket>>()
  const maintenanceSessions = new Set<string>()
  const maintenanceAgentSessions = new Map<string, Set<string>>()
  const maintenanceAgentModels = new Map<string, Set<string>>()

  const addMaintenance = (record: {
    agent: string
    providerID: string
    modelID: string
    variant: string | null
    sessionID: string | null
    requests: number
    cost: number | null
    costEstimated?: boolean
    tokens: TokenTotals
    allTokens: number
    started: number | null
    completed: number
  }) => {
    const requests = Math.max(1, record.requests)
    const rate = rates.get(`${record.providerID}/${record.modelID}`)
    const detailed = totalTokens(record.tokens)
    const allTokens = Math.max(detailed, record.allTokens)
    let effectiveCost = 0
    let recordedCost = 0
    let estimatedCost = 0
    if (record.cost !== null && Number.isFinite(record.cost)) {
      effectiveCost = record.cost
      if (record.costEstimated) {
        estimatedCost = record.cost
        maintenanceTotals.estimatedCost += record.cost
        maintenanceTotals.estimatedRecords += requests
      } else {
        recordedCost = record.cost
        maintenanceTotals.cost += record.cost
      }
      maintenanceTotals.pricedRecords += requests
    } else if (rate && detailed > 0) {
      estimatedCost = estimateCost(record.tokens, rate)
      effectiveCost = estimatedCost
      maintenanceTotals.estimatedCost += estimatedCost
      maintenanceTotals.pricedRecords += requests
    } else {
      maintenanceTotals.unpricedRecords += requests
    }
    maintenanceTotals.requests += requests
    addTokens(maintenanceTotals.tokens, record.tokens)
    maintenanceTotals.totalTokens += allTokens
    if (record.sessionID) maintenanceSessions.add(record.sessionID)
    if (record.started !== null && record.completed >= record.started) {
      maintenanceTotals.durationMs += record.completed - record.started
      maintenanceTotals.durationRecords += 1
    }

    const agent = maintenanceAgents.get(record.agent) ?? {
      agent: record.agent,
      requests: 0,
      sessions: 0,
      models: 0,
      cost: 0,
      estimatedCost: 0,
      totalTokens: 0,
      tokenShare: 0,
      costShare: 0,
    }
    agent.requests += requests
    agent.cost += recordedCost
    agent.estimatedCost += estimatedCost
    agent.totalTokens += allTokens
    maintenanceAgents.set(record.agent, agent)

    if (record.sessionID) {
      const set = maintenanceAgentSessions.get(record.agent) ?? new Set<string>()
      set.add(record.sessionID)
      maintenanceAgentSessions.set(record.agent, set)
    }
    const modelIdentity = `${record.providerID}/${record.modelID}`
    const agentModelSet = maintenanceAgentModels.get(record.agent) ?? new Set<string>()
    agentModelSet.add(modelIdentity)
    maintenanceAgentModels.set(record.agent, agentModelSet)

    const modelKey = `${record.agent}\u0000${record.providerID}/${record.modelID}\u0000${record.variant ?? ""}`
    const model = maintenanceModels.get(modelKey) ?? {
      agent: record.agent,
      providerID: record.providerID,
      modelID: record.modelID,
      variant: record.variant,
      requests: 0,
      cost: 0,
      estimatedCost: 0,
      totalTokens: 0,
    }
    model.requests += requests
    model.cost += recordedCost
    model.estimatedCost += estimatedCost
    model.totalTokens += allTokens
    maintenanceModels.set(modelKey, model)

    const periodStart = bucketPeriod(record.completed)
    const period = maintenancePeriods.get(periodStart) ?? { start: periodStart, requests: 0, cost: 0, tokens: 0 }
    period.requests += requests
    period.cost += effectiveCost
    period.tokens += allTokens
    maintenancePeriods.set(periodStart, period)
  }

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

    // Compaction/summary generations are durable assistant rows for replay, but
    // they are host maintenance rather than user-facing turns. Keep them out of
    // every ordinary usage bucket while still accounting for their real model
    // work alongside non-persisted special agents.
    const maintenanceAgent = UsageClassification.maintenanceAgent(row)
    if (maintenanceAgent) {
      if (!UsageClassification.isMirroredMaintenanceSettlement(row)) {
        addMaintenance({
          agent: maintenanceAgent,
          providerID: row.provider_id ?? "unknown",
          modelID: row.model_id ?? "unknown",
          variant: row.variant ?? null,
          sessionID: row.session_id,
          requests: 1,
          cost: row.cost_usd,
          costEstimated: false,
          tokens,
          allTokens: totalTokens(tokens),
          started: row.created_ms,
          completed,
        })
      }
      continue
    }

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
    const generationMs = generationWindow(row, completed)
    if (generationMs !== undefined) throughputMs += generationMs

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
      durationMs: 0,
      durationRecords: 0,
      generationMs: 0,
      generationRecords: 0,
    }
    provider.messages += 1
    if (source === "recorded") provider.cost += cost
    if (source === "estimated") provider.estimatedCost += cost
    if (source === "unpriced") provider.unpricedRecords += 1
    addTokens(provider.tokens, tokens)
    if (row.created_ms !== null && completed >= row.created_ms) {
      provider.durationMs += completed - row.created_ms
      provider.durationRecords += 1
    }
    if (generationMs !== undefined) {
      provider.generationMs += generationMs
      provider.generationRecords += 1
    }
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
      durationMs: 0,
      durationRecords: 0,
      generationMs: 0,
      generationRecords: 0,
    }
    model.messages += 1
    if (source === "recorded") model.cost += cost
    if (source === "estimated") model.estimatedCost += cost
    if (source === "unpriced") model.unpricedRecords += 1
    addTokens(model.tokens, tokens)
    model.cacheSavings += saved
    if (row.created_ms !== null && completed >= row.created_ms) {
      model.durationMs += completed - row.created_ms
      model.durationRecords += 1
    }
    if (generationMs !== undefined) {
      model.generationMs += generationMs
      model.generationRecords += 1
    }
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

    let providerPeriod = providerSeriesData.get(providerID)
    if (!providerPeriod) {
      providerPeriod = new Map()
      providerSeriesData.set(providerID, providerPeriod)
    }
    let providerSlot = providerPeriod.get(periodStart) ?? { cost: 0, tokens: 0, messages: 0 }
    providerSlot.cost += cost
    providerSlot.tokens += totalTokens(tokens)
    providerSlot.messages += 1
    providerPeriod.set(periodStart, providerSlot)

    // Variants merged into one model series, matching how the client groups them.
    const seriesModelKey = `${providerID}/${modelID}`
    let modelPeriod = modelSeriesData.get(seriesModelKey)
    if (!modelPeriod) {
      modelPeriod = new Map()
      modelSeriesData.set(seriesModelKey, modelPeriod)
    }
    let modelSlot = modelPeriod.get(periodStart) ?? { cost: 0, tokens: 0, messages: 0 }
    modelSlot.cost += cost
    modelSlot.tokens += totalTokens(tokens)
    modelSlot.messages += 1
    modelPeriod.set(periodStart, modelSlot)

    const dayStart = localDayStart(completed)
    const day = days.get(dayStart) ?? { start: dayStart, cost: 0, tokens: 0, messages: 0, sessions: 0 }
    day.cost += cost
    day.tokens += totalTokens(tokens)
    day.messages += 1
    days.set(dayStart, day)
    let daySessionSet = daySessions.get(dayStart)
    if (!daySessionSet) {
      daySessionSet = new Set()
      daySessions.set(dayStart, daySessionSet)
    }
    daySessionSet.add(row.session_id)

    const local = new Date(completed)
    const dowIndex = local.getDay()
    dow[dowIndex].cost += cost
    dow[dowIndex].tokens += totalTokens(tokens)
    dow[dowIndex].messages += 1
    const hourIndex = local.getHours()
    hours[hourIndex].cost += cost
    hours[hourIndex].tokens += totalTokens(tokens)
    hours[hourIndex].messages += 1
    const punchIndex = dowIndex * 24 + hourIndex
    punchcard[punchIndex].cost += cost
    punchcard[punchIndex].tokens += totalTokens(tokens)
    punchcard[punchIndex].messages += 1

    // Rows arrive ordered by completion ascending, so `start` is set once on
    // first sight and `end` simply tracks the latest row for the session.
    const sessionBucket = sessionBuckets.get(row.session_id) ?? {
      sessionID: row.session_id,
      title: row.session_title ?? "",
      projectID: row.project_id,
      projectName: row.project_name ?? basename(row.directory),
      messages: 0,
      cost: 0,
      tokens: 0,
      models: 0,
      start: completed,
      end: completed,
    }
    sessionBucket.messages += 1
    sessionBucket.cost += cost
    sessionBucket.tokens += totalTokens(tokens)
    sessionBucket.end = completed
    sessionBuckets.set(row.session_id, sessionBucket)
    let sessionModelSet = sessionModels.get(row.session_id)
    if (!sessionModelSet) {
      sessionModelSet = new Set()
      sessionModels.set(row.session_id, sessionModelSet)
    }
    sessionModelSet.add(`${providerID}/${modelID}`)
  }

  for (const row of maintenanceRows) {
    const tokens: TokenTotals = {
      input: row.input_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
    }
    addMaintenance({
      agent: row.agent,
      providerID: row.provider_id,
      modelID: row.model_id,
      variant: row.variant,
      sessionID: row.session_id,
      requests: row.requests,
      cost: row.cost_usd,
      costEstimated: row.cost_estimated === 1,
      tokens,
      allTokens: row.total_tokens,
      started: row.started_ms,
      completed: row.completed_ms,
    })
  }

  totals.sessions = sessions.size
  maintenanceTotals.sessions = maintenanceSessions.size

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
  for (const day of days.values()) {
    day.sessions = daySessions.get(day.start)?.size ?? 0
  }
  for (const session of sessionBuckets.values()) {
    session.models = sessionModels.get(session.sessionID)?.size ?? 0
  }
  const maintenanceSpend = maintenanceTotals.cost + maintenanceTotals.estimatedCost
  for (const agent of maintenanceAgents.values()) {
    agent.sessions = maintenanceAgentSessions.get(agent.agent)?.size ?? 0
    agent.models = maintenanceAgentModels.get(agent.agent)?.size ?? 0
    agent.tokenShare = safeDiv(agent.totalTokens, maintenanceTotals.totalTokens)
    agent.costShare = safeDiv(agent.cost + agent.estimatedCost, maintenanceSpend)
  }

  const processedTokens = totals.tokens.output + totals.tokens.reasoning
  const ratesResult: UsageRates = {
    tokensPerSecond: safeDiv(processedTokens, throughputMs) * 1000,
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

    const finalPeriods = downsample([...periods.values()].sort((a, b) => a.start - b.start), MAX_PERIODS)
    const alignSeries = (data: Iterable<[string, Map<number, { cost: number; tokens: number; messages: number }>]>): EntitySeries[] => {
      const out: EntitySeries[] = []
      for (const [key, perStart] of data) {
        const cost = new Array<number>(finalPeriods.length).fill(0)
        const tokens = new Array<number>(finalPeriods.length).fill(0)
        const messages = new Array<number>(finalPeriods.length).fill(0)
        for (const [start, bucket] of perStart) {
          let fi = finalPeriods.length - 1
          while (fi > 0 && finalPeriods[fi]!.start > start) fi--
          if (finalPeriods.length > 0 && finalPeriods[fi]!.start <= start) {
            cost[fi]! += bucket.cost
            tokens[fi]! += bucket.tokens
            messages[fi]! += bucket.messages
          }
        }
        out.push({ key, cost, tokens, messages })
      }
      return out
    }
    const modelBudget = Math.max(1, Math.floor(MAX_SERIES_VALUES / Math.max(1, finalPeriods.length)))
    const modelSeries = alignSeries(
      [...modelSeriesData.entries()]
        .sort((a, b) => {
          let am = 0
          let bm = 0
          for (const [, bucket] of a[1]) am += bucket.messages
          for (const [, bucket] of b[1]) bm += bucket.messages
          return bm - am
        })
        .slice(0, modelBudget),
    )

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
    periods: finalPeriods,
    days: downsample([...days.values()].sort((a, b) => a.start - b.start), MAX_DAYS),
    dow: dow as unknown as UsageSummary["dow"],
    hours: hours as unknown as UsageSummary["hours"],
    punchcard,
    providerSeries: alignSeries(providerSeriesData),
    modelSeries,
    // Ranked by tokens rather than cost so a session run entirely on free or
    // unpriced models is not silently absent from "your heaviest work".
    sessions: [...sessionBuckets.values()].sort((a, b) => b.tokens - a.tokens).slice(0, MAX_SESSIONS),
    pricing: {
      coverage: safeDiv(totals.pricedRecords, totals.messages),
      mode,
    },
    maintenance: {
      totals: maintenanceTotals,
      agents: [...maintenanceAgents.values()].sort((a, b) => b.totalTokens - a.totalTokens),
      models: [...maintenanceModels.values()].sort(
        (a, b) => b.cost + b.estimatedCost - (a.cost + a.estimatedCost) || b.totalTokens - a.totalTokens,
      ),
      periods: downsample([...maintenancePeriods.values()].sort((a, b) => a.start - b.start), MAX_PERIODS),
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
