import { createMemo, type Accessor } from "solid-js"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { ProviderSettingsListResponse, ProviderSettingsModelsResponse } from "@opencode-ai/sdk/v2/client"
import { useServerSDK } from "@/context/server-sdk"
import { safeQueryData } from "@/utils/safe-query-data"

export type ProviderSettingsItem = ProviderSettingsListResponse["providers"][number]

const EMPTY: ProviderSettingsListResponse = { providers: [] }
const EMPTY_MODELS: ProviderSettingsModelsResponse = { models: [] }
const STALE_MS = 5 * 60_000

/**
 * Process-global provider settings projection.
 *
 * This is intentionally separate from `useProviders`: the latter is a
 * workspace catalog and must never invent a directory when one is absent.
 * The query key is server-scoped, so settings dialogs opened from multiple
 * routes share one request/cache without leaking data across servers.
 */
export function useProviderSettings(options: { enabled?: Accessor<boolean> } = {}) {
  const serverSDK = useServerSDK()
  const queryClient = useQueryClient()
  const enabled = () => options.enabled?.() ?? true
  const key = () => [serverSDK().scope, "provider-settings"] as const
  const query = useQuery(() => ({
    queryKey: key(),
    enabled: enabled(),
    staleTime: STALE_MS,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const client = serverSDK().client.providerSettings
      if (!client?.list) throw new Error("providerSettings.list endpoint unavailable")
      const response = await serverSDK().requests.schedule(
        "interactive",
        () => client.list({ throwOnError: true }),
        { key: "provider-settings", kind: "provider-settings" },
      )
      return response.data ?? EMPTY
    },
  }))

  const data = () => safeQueryData(query, EMPTY)
  const all = createMemo(() => new Map(data().providers.map((provider) => [provider.id, provider])))
  const connected = createMemo(() => data().providers.filter((provider) => provider.connected))

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: key() })
    if (enabled()) await query.refetch()
  }

  const afterMutation = async <T>(run: () => Promise<T>) => {
    const value = await run()
    await refresh()
    return value
  }

  return {
    query,
    data,
    all,
    connected,
    get: (providerID: string) => all().get(providerID),
    refresh,
    connectKey: (input: { providerID: string; key: string; label?: string }) =>
      afterMutation(() =>
        serverSDK().client.providerSettings.connectKey(input, { throwOnError: true }),
      ),
    credential: {
      select: (credentialID: string) =>
        afterMutation(() =>
          serverSDK().client.providerSettings.credential.select({ credentialID }, { throwOnError: true }),
        ),
      update: (credentialID: string, label: string) =>
        afterMutation(() =>
          serverSDK().client.providerSettings.credential.update({ credentialID, label }, { throwOnError: true }),
        ),
      remove: (credentialID: string) =>
        afterMutation(() =>
          serverSDK().client.providerSettings.credential.remove({ credentialID }, { throwOnError: true }),
        ),
    },
  }
}

export function useProviderSettingsModels() {
  const serverSDK = useServerSDK()
  const query = useQuery(() => ({
    queryKey: [serverSDK().scope, "provider-settings-models"],
    staleTime: STALE_MS,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const client = serverSDK().client.providerSettings
      if (!client?.models) throw new Error("providerSettings.models endpoint unavailable")
      const response = await serverSDK().requests.schedule(
        "interactive",
        () => client.models({ throwOnError: true }),
        { key: "provider-settings-models", kind: "provider-settings-models" },
      )
      return response.data ?? EMPTY_MODELS
    },
  }))
  return {
    query,
    data: () => safeQueryData(query, EMPTY_MODELS),
  }
}
