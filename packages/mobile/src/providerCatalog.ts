import type { Provider, ProviderListResponse } from "@opencode-ai/sdk/v2/client"

export function normalizeLegacyProviders(input: Provider[] | ProviderListResponse | undefined): Provider[] {
  if (Array.isArray(input)) return input
  if (!input) return []

  const connected = new Set(input.connected)
  return input.all.filter((provider) => connected.has(provider.id))
}
