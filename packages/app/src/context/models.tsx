import { type Accessor, createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { createModelPreferencesSync } from "./model-preferences-sync"
import { useServerSDK } from "./server-sdk"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { getUsageTables } from "@/utils/model-usage-profile"
import { isRecentModelRelease, withinRecentWindow } from "@/utils/model-recency"
import { normalizeOpenRouterEndpoints, warmOpenRouterEndpoints, type OpenRouterEndpoint } from "@/utils/openrouter-endpoints"
import { rankOpenRouterEndpoints } from "@/utils/openrouter-endpoint-ranking"
import { Model as ModelContract } from "@opencode-ai/schema/model"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility?: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
  subProvider?: Record<string, string | undefined>
  order?: Record<string, string[]>
}

const RECENT_LIMIT = 10
const ALWAYS_VISIBLE_PROVIDERS = new Set(["claude"])

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

// The persisted records hold `undefined` for cleared entries; the wire schema
// does not. Drop them rather than serializing nulls the server would reject.
function definedEntries(record: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record ?? {})) if (value !== undefined) out[key] = value
  return out
}

// Manual model order is persisted per selector section. Provider ids are
// user-defined slugs, so both kinds get a prefix to stay collision-free.
const FAVORITES_SECTION = "favorites"
const sectionKeyFor = (section: string) =>
  section === FAVORITES_SECTION ? "section:favorites" : `section:provider:${section}`

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (
    props: {
      directory?: Accessor<string | undefined>
      catalog?: Accessor<NormalizedProviderListResponse | undefined>
      warmUsage?: boolean
    } = {},
  ) => {
    // Global/server-owned surfaces may supply an explicitly fetched Tier-2
    // catalog instead of manufacturing a directory-scoped Local/Sync tree.
    const providers = props.catalog ? undefined : useProviders(() => props.directory?.())

    const warmUsage = () => {
      void getUsageTables()
    }
    if (props.warmUsage !== false) {
      if (typeof requestIdleCallback === "function") requestIdleCallback(warmUsage, { timeout: 400 })
      else requestAnimationFrame(warmUsage)
    }

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
        subProvider: {},
        order: {},
      }),
    )

    // One-time migration: clear stale OpenRouter provider pin that bricks
    // xiaomi/mimo-v2.5-20260422 (tencent no longer serves it, but persisted
    // preference still sends `provider: { only: ["tencent"] }` and triggers
    // "No allowed providers are available" on every request). Generic stale
    // handling also runs when endpoints are fetched (dialog-select-model.tsx).
    void ready.promise?.then(() => {
      const stale = store.subProvider
      if (!stale) return
      // Specific known-bad pin from the bug report.
      const staleKey = "openrouter:xiaomi/mimo-v2.5-20260422"
      if (stale[staleKey] === "tencent") {
        setStore("subProvider", staleKey, undefined)
      }
      // Also prune any other "tencent" pin for the dated 20260422 variant
      // family where tencent is not a known provider - best-effort, avoids
      // leaving a bricked model if the id shifts slightly (e.g. suffix).
      for (const [key, value] of Object.entries(stale)) {
        if (value !== "tencent") continue
        if (key.includes("mimo-v2.5-20260422") && key.startsWith("openrouter:")) {
          setStore("subProvider", key, undefined)
        }
      }
    })

    const connectedProviders = () => {
      const catalog = props.catalog?.()
      if (catalog) {
        const connected = new Set(catalog.connected)
        return [...catalog.all.values()].filter((provider) => connected.has(provider.id))
      }
      return providers?.connected() ?? []
    }

    const available = createMemo(() =>
      connectedProviders().flatMap((p) =>
        Object.values(p.models)
          .filter((m) => ModelContract.isLanguageModel(p.id, m))
          .map((m) => ({
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
      if (ALWAYS_VISIBLE_PROVIDERS.has(model.providerID)) return true
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

    // Manual display order inside a model-selector section ("favorites" or a
    // provider group). Each entry stores the full snapshot of
    // `providerID:modelID` keys in the user's chosen order; snapshots are
    // written by drag-to-reorder / Alt+Arrow in the selector and applied on
    // top of the default cost sort.
    const getOrder = (section: string) => store.order?.[sectionKeyFor(section)]
    const setOrder = (section: string, keys: string[]) => {
      const key = sectionKeyFor(section)
      if (!store.order) {
        setStore("order", { [key]: keys })
        return
      }
      setStore("order", key, keys)
    }
    const clearOrder = (section: string) => {
      const key = sectionKeyFor(section)
      if (store.order) (setStore as unknown as (a: string, b: string, c: string[] | undefined) => void)("order", key, undefined)
    }

    // Publish this client's selector preferences so a paired PWA renders the
    // same rail order, favorites, recents and routing pins. Read-only from the
    // server's point of view: nothing here writes back into `store`.
    // `useServerSDK` is not available in every tree that mounts this provider
    // (storybook, isolated dialogs), so its absence degrades to no sync.
    let serverSDK: ReturnType<typeof useServerSDK> | undefined
    try {
      serverSDK = useServerSDK()
    } catch {
      serverSDK = undefined
    }
    // Resolved per attempt, and defensively: the accessor throws while no
    // server is connected, and this provider mounts before one exists.
    const preferencesClient = () => {
      try {
        return serverSDK?.()?.client.global.preferences
      } catch {
        return undefined
      }
    }
    const openRouterEndpointsClient = () => {
      try {
        return serverSDK?.()?.client.experimental.openrouterEndpoints
      } catch {
        return undefined
      }
    }
    const fetchOpenRouterEndpoints = async (modelID: string): Promise<OpenRouterEndpoint[]> => {
      const client = openRouterEndpointsClient()
      if (!client) throw new Error("OpenRouter endpoint client unavailable")
      const response = await client.get({ model: modelID }, { throwOnError: true })
      return rankOpenRouterEndpoints(normalizeOpenRouterEndpoints(response.data)).map((entry) => entry.endpoint)
    }

    // The selector itself is mounted only after the user opens it, which is too
    // late to hide OpenRouter endpoint latency. Warm high-probability models as
    // soon as persisted model preferences + the Tier-0 client are available;
    // this does NOT require a workspace provider catalog.
    //
    // Once a catalog is already available, append the remaining visible
    // OpenRouter language models. This deliberately does not force lazy
    // settings/scheduled-task scopes to fetch Tier-2 catalog state merely for a
    // speculative warmup. The cache utility owns the 24h admission TTL,
    // module-wide dedup, idle slicing and bounded concurrency, so several
    // ModelsProvider mounts still collapse into one background producer.
    createEffect(() => {
      if (!ready() || !openRouterEndpointsClient()) return

      const prioritized: string[] = []
      const seen = new Set<string>()
      const push = (modelID: string | undefined) => {
        if (!modelID || seen.has(modelID)) return
        seen.add(modelID)
        prioritized.push(modelID)
      }

      // Recents are the strongest predictor of the next submenu the user will
      // inspect and are capped at RECENT_LIMIT.
      for (const item of store.recent) {
        if (item.providerID === "openrouter") push(item.modelID)
      }

      // Explicit favorites/visibility survive app restarts and should be warm
      // before a lazy settings catalog has even been admitted.
      for (const item of store.user) {
        if (item.providerID !== "openrouter") continue
        if (item.favorite || item.visibility === "show") push(item.modelID)
      }

      // A persisted provider pin is both high-intent and correctness-sensitive:
      // warming it early lets the selector validate a provider that disappeared
      // upstream without waiting for the submenu interaction.
      for (const [key, value] of Object.entries(store.subProvider ?? {})) {
        if (!value || !key.startsWith("openrouter:")) continue
        push(key.slice("openrouter:".length))
      }

      const provider = connectedProviders().find((item) => item.id === "openrouter")
      if (provider) {
        const languageModels = Object.values(provider.models).filter((model) =>
          ModelContract.isLanguageModel(provider.id, model),
        )
        for (const model of languageModels) {
          if (visible({ providerID: "openrouter", modelID: model.id })) push(model.id)
        }
      }

      if (prioritized.length === 0) return
      warmOpenRouterEndpoints(prioritized, fetchOpenRouterEndpoints)
    })
    createModelPreferencesSync({
      client: preferencesClient,
      ready: () => ready(),
      snapshot: () => ({
        order: { ...(store.order ?? {}) },
        favorite: store.user.filter((item) => item.favorite).map((item) => modelKey(item)),
        recent: store.recent.map((item) => ({ providerID: item.providerID, modelID: item.modelID })),
        // Keyed `providerID:modelID`, matching `subProviderKey` above.
        subProvider: definedEntries(store.subProvider),
        // Keyed `providerID/modelID` — `variantKey` uses a slash, not a colon.
        // Preserved verbatim so the PWA can look pins up with the same key.
        variant: definedEntries(store.variant),
      }),
    })

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        if (ready.promise) await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      catalogStatus: () => props.catalog?.()?.catalog?.status ?? providers?.catalogStatus(),
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
      order: {
        get: getOrder,
        set: setOrder,
        clear: clearOrder,
      },
    }
  },
})
