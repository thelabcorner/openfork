import { type Accessor, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { getUsageTables } from "@/utils/model-usage-profile"
import { isRecentModelRelease, withinRecentWindow } from "@/utils/model-recency"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility?: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
  subProvider?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> } = {}) => {
    const providers = useProviders(() => props.directory?.())

    const warmUsage = () => {
      void getUsageTables()
    }
    if (typeof requestIdleCallback === "function") requestIdleCallback(warmUsage, { timeout: 400 })
    else requestAnimationFrame(warmUsage)

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
        subProvider: {},
      }),
    )

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromISO(model.release_date)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter((x) =>
          withinRecentWindow(
            release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"),
          ),
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) if (item.visibility) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const favorite = createMemo(() => {
      const set = new Set<string>()
      for (const item of store.user) if (item.favorite) set.add(modelKey(item))
      return set
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function updateUser(model: ModelKey, patch: Partial<Pick<User, "visibility" | "favorite">>) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, ...patch }))
        return
      }
      setStore("user", store.user.length, { ...model, ...patch })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      // Newly-added models default ON (no matter what); only releases that
      // aged out of the recent window default to off.
      return isRecentModelRelease(release().get(key))
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      updateUser(model, { visibility: state ? "show" : "hide" })
    }

    const isFavorite = (model: ModelKey) => favorite().has(modelKey(model))

    const toggleFavorite = (model: ModelKey) => {
      updateUser(model, { favorite: !isFavorite(model) })
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    // OpenRouter upstream-provider routing preference: the tag of the
    // upstream infra provider a given model should be pinned to (or undefined
    // for OpenRouter's own Auto routing). Persisted per model, exposed as a
    // generic options bag alongside `variant` — deliberately separate from it,
    // since variant is a closed set of per-model reasoning-effort presets.
    const subProviderKey = (model: ModelKey) => `${model.providerID}:${model.modelID}`
    const getSubProvider = (model: ModelKey) => store.subProvider?.[subProviderKey(model)]

    const setSubProvider = (model: ModelKey, value: string | undefined) => {
      const key = subProviderKey(model)
      if (!store.subProvider) {
        setStore("subProvider", { [key]: value })
        return
      }
      setStore("subProvider", key, value)
    }

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      favorite: {
        isFavorite,
        toggle: toggleFavorite,
      },
      recent: {
        list: () => recentModels.latest ?? [],
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
      subProvider: {
        get: getSubProvider,
        set: setSubProvider,
      },
    }
  },
})
