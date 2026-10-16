import type { ModelsDev } from "@opencode-ai/core/models-dev"
import { buildRates, type ModelRates } from "./valuation"

/**
 * Memoize rate projection by the authoritative immutable catalog snapshot.
 * ModelsDev.get() returns the same snapshot until refresh invalidates it,
 * then publishes a different object. Never memoize across different objects
 * and never suppress the source's refresh / network lifecycle.
 */
export function makeUsageRatesCache() {
  let catalog: Record<string, ModelsDev.Provider> | undefined
  let rates: Map<string, ModelRates> | undefined
  return (next: Record<string, ModelsDev.Provider>): Map<string, ModelRates> => {
    if (next !== catalog || !rates) {
      catalog = next
      rates = buildRates(next)
    }
    return rates
  }
}
