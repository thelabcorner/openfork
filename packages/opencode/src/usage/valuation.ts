import type { ModelsDev } from "@opencode-ai/core/models-dev"

export type ModelRates = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type ValuationTokens = {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
}

export function buildRates(catalog: Record<string, ModelsDev.Provider>) {
  const rates = new Map<string, ModelRates>()
  for (const provider of Object.values(catalog)) {
    for (const [modelID, model] of Object.entries(provider.models)) {
      const cost = model.cost
      if (!cost) continue
      rates.set(`${provider.id}/${modelID}`, {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cache_read ?? cost.input,
        cacheWrite: cost.cache_write ?? cost.input,
      })
    }
  }
  return rates
}

export function estimateCost(tokens: ValuationTokens, rate: ModelRates) {
  return (
    (tokens.input / 1_000_000) * rate.input +
    (tokens.cacheRead / 1_000_000) * rate.cacheRead +
    (tokens.cacheWrite / 1_000_000) * rate.cacheWrite +
    ((tokens.output + tokens.reasoning) / 1_000_000) * rate.output
  )
}

export function cacheSavings(tokens: ValuationTokens, rate: ModelRates | undefined) {
  if (!rate || tokens.cacheRead <= 0) return 0
  return (tokens.cacheRead / 1_000_000) * (rate.input - rate.cacheRead)
}
