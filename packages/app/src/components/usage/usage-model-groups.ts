import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"

export type UsageModelRow = UsageSummaryResponse["models"][number]

export type TokenBreakdown = {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}

export type ModelProviderBreakdown = {
  providerID: string
  /** The provider's own model id — may differ from the group's canonical `modelID` once cross-provider identity matching is in play. */
  modelID: string
  variant: string | null
  messages: number
  cost: number
  tokens: number
  tokenBreakdown: TokenBreakdown
  share: number
  cacheSavings: number
  /** Sum of (completed - created) wall time and the record count backing it — lets callers derive tok/s as (tokenBreakdown.output+reasoning)/durationMs*1000, guarding durationRecords > 0. */
  durationMs: number
  durationRecords: number
}

export type ModelGroup = {
  /** Canonical display identity for the group — a catalog model name when resolved, otherwise the raw provider modelID. */
  modelID: string
  messages: number
  cost: number
  tokens: number
  tokenBreakdown: TokenBreakdown
  share: number
  cacheSavings: number
  durationMs: number
  durationRecords: number
  /** One entry per distinct provider+variant that served this model, sorted by cost desc. */
  providers: ModelProviderBreakdown[]
  providerCount: number
}

/** Resolves a usage row to the group it belongs to (`key`) and the label the group displays (`label`). */
export type IdentifyModel = (row: UsageModelRow) => { key: string; label: string }

/** Default identity: exact modelID match — unaware of the model catalog, so two providers reporting the same canonical model under different id strings stay split. Callers with catalog access should pass a smarter `identify` (see usage-model-identity.ts). */
const identifyByModelID: IdentifyModel = (row) => ({ key: row.modelID, label: row.modelID })

const emptyBreakdown = (): TokenBreakdown => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 })

const addBreakdown = (a: TokenBreakdown, b: UsageModelRow["tokens"]): TokenBreakdown => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
})

const rowTokens = (row: UsageModelRow) =>
  row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite + row.tokens.output + row.tokens.reasoning

const rowCost = (row: UsageModelRow) => row.cost + row.estimatedCost

/**
 * The server reports usage per (provider, model, variant) combination — the
 * same model routed through two providers (e.g. a direct API key and a
 * proxy), or run with two different reasoning variants, shows up as two
 * separate rows. That fragments a model's real total and can push a
 * heavily-used model's individual rows low enough to look unused when a
 * caller truncates the list.
 *
 * Grouping key comes from `identify`, which defaults to an exact modelID
 * match — safe, but blind to two providers reporting the *same* model under
 * different id strings (e.g. a direct API vs. an OpenRouter-style
 * `vendor/model-id`). Passing a catalog-aware `identify` (see
 * `createCatalogIdentify` in usage-model-identity.ts) resolves those to one
 * group instead. Either way, the per-provider/variant split stays available
 * via `providers` for drill-down, so merging never hides where the spend
 * actually came from.
 */
export function groupModelsByName(models: UsageModelRow[], identify: IdentifyModel = identifyByModelID): ModelGroup[] {
  const groups = new Map<string, ModelGroup>()

  for (const row of models) {
    const cost = rowCost(row)
    const tokens = rowTokens(row)
    const variant = row.variant || null
    const { key, label } = identify(row)

    let group = groups.get(key)
    if (!group) {
      group = {
        modelID: label,
        messages: 0,
        cost: 0,
        tokens: 0,
        tokenBreakdown: emptyBreakdown(),
        share: 0,
        cacheSavings: 0,
        durationMs: 0,
        durationRecords: 0,
        providers: [],
        providerCount: 0,
      }
      groups.set(key, group)
    }

    group.messages += row.messages
    group.cost += cost
    group.tokens += tokens
    group.tokenBreakdown = addBreakdown(group.tokenBreakdown, row.tokens)
    group.share += row.share
    group.cacheSavings += row.cacheSavings
    group.durationMs += row.durationMs
    group.durationRecords += row.durationRecords
    group.providers.push({
      providerID: row.providerID,
      modelID: row.modelID,
      variant,
      messages: row.messages,
      cost,
      tokens,
      tokenBreakdown: { ...row.tokens },
      share: row.share,
      cacheSavings: row.cacheSavings,
      durationMs: row.durationMs,
      durationRecords: row.durationRecords,
    })
  }

  const result = [...groups.values()]
  for (const group of result) {
    group.providers.sort((a, b) => b.cost - a.cost)
    group.providerCount = new Set(group.providers.map((entry) => entry.providerID)).size
  }
  return result.sort((a, b) => b.cost - a.cost)
}

/** A single provider's own models, unmerged (already scoped to one providerID, so no name collisions to resolve). */
export function modelsForProvider(models: UsageModelRow[], providerID: string) {
  return models
    .filter((row) => row.providerID === providerID)
    .map((row) => ({
      providerID: row.providerID,
      modelID: row.modelID,
      variant: row.variant || null,
      messages: row.messages,
      cost: rowCost(row),
      tokens: rowTokens(row),
      tokenBreakdown: { ...row.tokens },
      share: row.share,
      cacheSavings: row.cacheSavings,
      durationMs: row.durationMs,
      durationRecords: row.durationRecords,
    }))
    .sort((a, b) => b.cost - a.cost)
}
