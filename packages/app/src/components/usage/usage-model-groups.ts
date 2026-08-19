import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"

export type UsageModelRow = UsageSummaryResponse["models"][number]

export type ModelProviderBreakdown = {
  providerID: string
  variant: string | null
  messages: number
  cost: number
  tokens: number
  share: number
  cacheSavings: number
}

export type ModelGroup = {
  modelID: string
  messages: number
  cost: number
  tokens: number
  share: number
  cacheSavings: number
  /** One entry per distinct provider+variant that served this model, sorted by cost desc. */
  providers: ModelProviderBreakdown[]
  providerCount: number
}

const rowTokens = (row: UsageModelRow) =>
  row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite + row.tokens.output + row.tokens.reasoning

const rowCost = (row: UsageModelRow) => row.cost + row.estimatedCost

/**
 * The server reports usage per (provider, model, variant) combination — the
 * same model routed through two providers (e.g. a direct API key and a
 * proxy), or run with two different reasoning variants, shows up as two
 * separate rows. That fragments a model's real total and can push a
 * heavily-used model's individual rows low enough to look unused when a
 * caller truncates the list. This merges by `modelID` alone so "how much did
 * I use claude-sonnet-4-5" has one honest answer, while keeping the
 * per-provider/variant split available via `providers` for drill-down.
 */
export function groupModelsByName(models: UsageModelRow[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>()

  for (const row of models) {
    const cost = rowCost(row)
    const tokens = rowTokens(row)
    const variant = row.variant || null

    let group = groups.get(row.modelID)
    if (!group) {
      group = { modelID: row.modelID, messages: 0, cost: 0, tokens: 0, share: 0, cacheSavings: 0, providers: [], providerCount: 0 }
      groups.set(row.modelID, group)
    }

    group.messages += row.messages
    group.cost += cost
    group.tokens += tokens
    group.share += row.share
    group.cacheSavings += row.cacheSavings
    group.providers.push({
      providerID: row.providerID,
      variant,
      messages: row.messages,
      cost,
      tokens,
      share: row.share,
      cacheSavings: row.cacheSavings,
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
      share: row.share,
      cacheSavings: row.cacheSavings,
    }))
    .sort((a, b) => b.cost - a.cost)
}
