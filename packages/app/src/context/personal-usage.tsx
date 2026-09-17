import { createSimpleContext } from "@opencode-ai/ui/context"
import { createMemo, createSignal } from "solid-js"
import type { UsageModelProfileResponse } from "@opencode-ai/sdk/v2/client"
import { useServerSDK } from "@/context/server-sdk"

const PROFILE_TTL_MS = 2_000

type CostEntry = { cost: number; count: number }

/**
 * Server-scoped personal model economics.
 *
 * The old implementation duplicated assistant-message history into a second
 * persisted client database and rescanned the renderer's message cache to keep
 * it current. Usage now owns compact settled-generation records, so the client
 * needs only one lazy aggregate snapshot per server.
 */
export const { use: usePersonalUsage, provider: PersonalUsageProvider } = createSimpleContext({
  name: "PersonalUsage",
  gate: false,
  init: () => {
    const serverSDK = useServerSDK()
    const [models, setModels] = createSignal<UsageModelProfileResponse["models"]>([])
    const [loadedAt, setLoadedAt] = createSignal(0)
    let pending: Promise<void> | undefined

    const ensure = (force = false) => {
      if (!force && loadedAt() > 0 && Date.now() - loadedAt() < PROFILE_TTL_MS) return Promise.resolve()
      if (pending) return pending
      pending = serverSDK()
        .client.usage.modelProfile({ throwOnError: true })
        .then((response) => {
          setModels(response.data?.models ?? [])
          setLoadedAt(Date.now())
        })
        .catch(() => {
          // Compatibility with an older connected server: ranking simply uses
          // the generic corpus until this endpoint becomes available.
          setModels([])
          setLoadedAt(Date.now())
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    }

    const personalCosts = createMemo(() => {
      const map = new Map<string, CostEntry>()
      for (const model of models()) {
        if (model.costSamples <= 0 || model.averageCost <= 0) continue
        map.set(`${model.providerID}:${model.modelID}`, { cost: model.averageCost, count: model.costSamples })
      }
      return map
    })

    const hitRates = createMemo(() => {
      const map = new Map<string, number>()
      for (const model of models()) {
        if (model.cacheSamples < 3) continue
        map.set(`${model.providerID}:${model.modelID}`, model.cacheHitRate)
      }
      return map
    })

    const clear = () => {
      setModels([])
      setLoadedAt(0)
    }

    return {
      ensure,
      ready: () => loadedAt() > 0,
      personalCosts,
      hitRates,
      clear,
      getCost: (providerID: string, modelID: string) => personalCosts().get(`${providerID}:${modelID}`),
      getHitRate: (providerID: string, modelID: string) => hitRates().get(`${providerID}:${modelID}`),
    }
  },
})
