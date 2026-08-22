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

export const ProviderUsage = Schema.Struct({
  windows: Schema.Record(Schema.String, UsageWindow),
  models: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ windows: Schema.Record(Schema.String, UsageWindow) }),
    ),
  ),
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
