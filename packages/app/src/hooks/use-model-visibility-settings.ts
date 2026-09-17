import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { Persist, persisted } from "@/utils/persist"
import { isRecentModelRelease } from "@/utils/model-recency"

type Visibility = "show" | "hide"
type ModelKey = { providerID: string; modelID: string }
type User = ModelKey & { visibility?: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
  subProvider?: Record<string, string | undefined>
  order?: Record<string, string[]>
}

const ALWAYS_VISIBLE_PROVIDERS = new Set(["claude"])

/**
 * Visibility-only view over the canonical persisted model preference record.
 * Settings does not need a provider runtime merely to edit this client-side
 * preference, but it must preserve the exact storage shape used by ModelsProvider.
 */
export function useModelVisibilitySettings() {
  const [store, setStore, , ready] = persisted(
    Persist.global("model", ["model.v1"]),
    createStore<Store>({ user: [], recent: [], variant: {}, subProvider: {}, order: {} }),
  )
  const visibility = createMemo(() => {
    const map = new Map<string, Visibility>()
    for (const item of store.user) if (item.visibility) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
    return map
  })

  const visible = (model: ModelKey & { releaseDate?: string }) => {
    const state = visibility().get(`${model.providerID}:${model.modelID}`)
    if (state === "hide") return false
    if (state === "show") return true
    if (ALWAYS_VISIBLE_PROVIDERS.has(model.providerID)) return true
    const release = model.releaseDate ? DateTime.fromISO(model.releaseDate) : undefined
    return isRecentModelRelease(release)
  }

  const setVisibility = (model: ModelKey, state: boolean) => {
    const index = store.user.findIndex((item) => item.providerID === model.providerID && item.modelID === model.modelID)
    const patch = { visibility: (state ? "show" : "hide") as Visibility }
    if (index >= 0) {
      setStore("user", index, (current) => ({ ...current, ...patch }))
      return
    }
    setStore("user", store.user.length, { ...model, ...patch })
  }

  return { ready, visible, setVisibility }
}
