import type { Provider } from "@opencode-ai/sdk/v2/client"

const MODEL_PREFERENCE_KEYS = ["opencode.global.dat:model", "model.v1"]
const PROVIDER_RAIL_ORDER_KEY = "section:provider:rail"

export function readProviderRailOrder(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string[] {
  if (!storage) return []
  for (const key of MODEL_PREFERENCE_KEYS) {
    try {
      const raw = storage.getItem(key)
      if (!raw) continue
      const value = JSON.parse(raw) as { order?: Record<string, unknown> }
      const order = value.order?.[PROVIDER_RAIL_ORDER_KEY]
      if (Array.isArray(order) && order.every((item) => typeof item === "string")) return order
    } catch {}
  }
  return []
}

export function applyProviderRailOrder(providers: Provider[], order: string[]): Provider[] {
  if (order.length < 2) return providers
  const rank = new Map(order.map((id, index) => [id, index]))
  if (providers.filter((provider) => rank.has(provider.id)).length < 2) return providers
  return [...providers].sort(
    (a, b) => (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY),
  )
}
