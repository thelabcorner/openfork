import { Schema } from "effect"

/**
 * Wire contract for provider-account quota reads, ported from OpenChamber's
 * quota tracker (MIT). Quota is advisory display state about a remote
 * provider account: a stale or failed read must never block inference, and
 * nothing here is persisted — clients re-fetch on demand.
 *
 * A quota is not required to be a percentage: credit balances report a
 * `valueLabel` with null percents, and every numeric field is nullable so
 * partial provider payloads stay representable.
 */

export const UsageWindow = Schema.Struct({
  usedPercent: Schema.NullOr(Schema.Finite),
  remainingPercent: Schema.NullOr(Schema.Finite),
  windowSeconds: Schema.NullOr(Schema.Finite),
  resetAt: Schema.NullOr(Schema.Finite),
  resetAfterSeconds: Schema.NullOr(Schema.Finite),
  valueLabel: Schema.NullOr(Schema.String),
})
export type UsageWindow = Schema.Schema.Type<typeof UsageWindow>

/**
 * Per-model metadata for providers that price per model rather than per token.
 *
 * `rate` is the provider's own consumption rate per request, in the provider's
 * billing unit (WorkBuddy: credits). `0`/absent means "not published" — it is
 * NOT "free"; `rateFree` distinguishes a genuine zero-cost promotion, and
 * `promotionLabel` carries the badge text the provider is currently showing
 * (e.g. "Free now"). A client turns `rate` into an estimate by dividing the
 * account's remaining balance by it, so a missing rate must degrade to "no
 * estimate" rather than to "infinite requests".
 */
export const ProviderModelUsage = Schema.Struct({
  windows: Schema.Record(Schema.String, UsageWindow),
  rate: Schema.optional(Schema.Finite),
  rateFree: Schema.optional(Schema.Boolean),
  rateLabel: Schema.optional(Schema.NullOr(Schema.String)),
  promotionLabel: Schema.optional(Schema.NullOr(Schema.String)),
})
export type ProviderModelUsage = Schema.Schema.Type<typeof ProviderModelUsage>

export const WorkBuddyModelLimit = Schema.Struct({
  model: Schema.String,
  canonical: Schema.NullOr(Schema.String),
  unit: Schema.String,
  usedObserved: Schema.Finite,
  limitEstimate: Schema.NullOr(Schema.Finite),
  remainingEstimate: Schema.NullOr(Schema.Finite),
  remainingPercent: Schema.NullOr(Schema.Finite),
  status: Schema.Literal("healthy", "draining", "low", "critical", "terminal", "depleted", "unknown"),
  confidence: Schema.Literal("low", "medium", "high"),
  accuracy: Schema.Literal("observed", "estimate", "server-confirmed"),
  exhaustedObserved: Schema.Boolean,
  serverCode: Schema.NullOr(Schema.Finite),
  resetAt: Schema.NullOr(Schema.Finite),
  resetSource: Schema.Literal("server-6004", "inferred", "unknown"),
  windowType: Schema.Literal("server-defined", "inferred-rolling-24h", "unknown"),
  windowStartedAt: Schema.NullOr(Schema.Finite),
  lastObservationAt: Schema.NullOr(Schema.Finite),
  burnPerHour: Schema.NullOr(Schema.Finite),
  estimatedExhaustionAt: Schema.NullOr(Schema.Finite),
  willLikelyExhaustBeforeReset: Schema.NullOr(Schema.Boolean),
  coverage: Schema.Literal("opencode-only"),
})
export type WorkBuddyModelLimit = Schema.Schema.Type<typeof WorkBuddyModelLimit>

export const WorkBuddyAccountLimits = Schema.Struct({
  accountId: Schema.String,
  label: Schema.String,
  models: Schema.Array(WorkBuddyModelLimit),
})
export type WorkBuddyAccountLimits = Schema.Schema.Type<typeof WorkBuddyAccountLimits>

export const ProviderUsage = Schema.Struct({
  windows: Schema.Record(Schema.String, UsageWindow),
  models: Schema.optional(Schema.Record(Schema.String, ProviderModelUsage)),
  /**
   * Maps the provider's stable account key onto the (possibly disambiguated)
   * label used in the `windows` keys.
   *
   * The two are NOT string-derivable: WorkBuddy's stable id comes from the
   * Tencent UID (`wb-215789ee-…`) while its display label comes from the
   * nickname (`arcfit.dev@gmail.com`), and a second account with the same
   * nickname gets a disambiguating suffix. The frontend needs both — the
   * account-qualified model id carries the stable key, the quota window carries
   * the label — so the pairing is published rather than guessed. Without it a
   * per-account lookup can only fall back to aggregate behavior.
   */
  accountLabels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** WorkBuddy promotional frequency windows, separate from package-credit windows. */
  workbuddyAccounts: Schema.optional(Schema.Array(WorkBuddyAccountLimits)),
})
export type ProviderUsage = Schema.Schema.Type<typeof ProviderUsage>

export const ProviderResult = Schema.Struct({
  providerId: Schema.String,
  providerName: Schema.String,
  ok: Schema.Boolean,
  configured: Schema.Boolean,
  error: Schema.optional(Schema.String),
  planLabel: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.NullOr(ProviderUsage),
  fetchedAt: Schema.Finite,
  /**
   * Epoch ms before which a re-read is guaranteed to be served from this
   * adapter's own cache, so a client refresh would repaint identical numbers.
   * Uncached adapters omit it (refresh always does real work); an adapter
   * backing off from a 429 sets it to the end of its cooldown. The UI takes
   * the MAX across providers: refreshing is only useful once the slowest
   * cached provider can actually return something new.
   *
   * Absent means "unknown / not cached" — clients must treat a missing value
   * as "refresh now", never as "never refresh", otherwise a server that
   * predates this field would disable refresh forever.
   */
  nextRefreshAt: Schema.optional(Schema.Finite),
})
export type ProviderResult = Schema.Schema.Type<typeof ProviderResult>

export const ProviderSummary = Schema.Struct({
  providerId: Schema.String,
  providerName: Schema.String,
  configured: Schema.Boolean,
})
export type ProviderSummary = Schema.Schema.Type<typeof ProviderSummary>

export const ProvidersResult = Schema.Struct({
  providers: Schema.Array(ProviderSummary),
})
export type ProvidersResult = Schema.Schema.Type<typeof ProvidersResult>
