import type { Provider } from "@opencode-ai/sdk/v2/client"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import {
  collapseAccountVariants,
  expandForQuery,
  indexModelGroups,
  variantForPolicy,
  type AccountVariant,
  type ModelGroup,
} from "@opencode-ai/schema/model-select/accounts"
import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"
import { isMultiAccountProvider, MULTI_ACCOUNT_PROVIDERS } from "@opencode-ai/schema/model-select/multi-account-providers"
import { hasPublishedPricing, isUnlimitedModel, stripUnlimitedSuffix } from "@opencode-ai/schema/model-select/badges"
import { isFreeModel } from "@opencode-ai/schema/model-select/cost"
import { applySectionOrder } from "@opencode-ai/schema/model-select/order"
import { FAVORITES_SECTION } from "@opencode-ai/schema/model-select/rail-order"
import type { UsageTables } from "@opencode-ai/schema/model-select/usage-profile"
import { loadUsageTables, rankModels, readPersonalCostIndex, type PersonalIndex } from "../model-ranking"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import type { AccountUsage } from "../model-accounts"
import { collectAccountLabels, synthesizeAccounts, usageForAccount } from "../model-accounts"
import { subProviderKeyFor, type ModelPreferencesStore } from "../modelPreferences"
import type { EndpointsFetcher, OpenRouterEndpoint } from "../openrouter-endpoints"
import type { LimitsProviderData } from "../views/LimitsView"
import { IconBrain, IconCheck, IconChevronRight, IconGrid, IconImage, IconSearch, IconStar, IconX, IconZap } from "../icons"
import { AccountPickerSheet } from "./AccountPickerSheet"
import { EndpointPickerSheet } from "./EndpointPickerSheet"
import { ProviderBadge } from "./ProviderBadge"
import { Sheet } from "./Sheet"

type ModelEntry = Provider["models"][string]

/** The selector's own item shape: a model plus the provider it came from. */
type Item = {
  id: string
  name: string
  provider: { id: string; name: string }
  model: ModelEntry
}

const ALL_KEY = "__all__"
const FAV_KEY = "__favorites__"
const RECENT_KEY = "__recent__"

const NEW_WINDOW_MS = 45 * 24 * 60 * 60 * 1000

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return `${n}`
}

// Cost is $ per million tokens already - grow decimal precision only when 2
// decimals would round a real nonzero rate down to "$0.00".
function formatCostPerMillion(value: number): string {
  if (value === 0) return "$0.00"
  if (!Number.isFinite(value)) return "—"
  let decimals = 2
  while (decimals < 8 && Number(value.toFixed(decimals)) === 0) decimals++
  return `$${value.toFixed(decimals)}`
}

function isNewModel(model: ModelEntry): boolean {
  const t = Date.parse((model as { release_date?: string }).release_date ?? "")
  return !Number.isNaN(t) && Date.now() - t < NEW_WINDOW_MS
}

/** Marketing suffixes that render as badges instead of sitting in the name. */
const displayName = (name: string) => stripUnlimitedSuffix(name.replace("(latest)", "").trim())

const modelKey = (item: Item) => `${item.provider.id}:${item.id}`
const baseKey = (item: Item) => {
  const split = splitModelIDForProvider(item.id, item.provider.id)
  return `${item.provider.id}:${split.baseModelID}`
}

/** The rail only needs an id and a display name, not a whole provider record. */
type RailOption = { key: string; name: string; providerID?: string }

type Row =
  | { kind: "header"; key: string; title: string; count: number }
  | { kind: "item"; key: string; item: Item; group?: ModelGroup<Item> }

/**
 * Everything the picker needs that ChatView itself does not own. Grouped into
 * one prop so the app can supply them without threading five optional props
 * through every intermediate view.
 */
export type ModelPickerExtras = {
  client?: () => OpencodeClient | undefined
  preferences?: ModelPreferencesStore
  /** Quota data, already loaded by the app for the limits page. */
  quota?: () => readonly LimitsProviderData[]
  fetchEndpoints?: EndpointsFetcher
}

export function ModelPicker(props: {
  open: boolean
  onClose: () => void
  providers: Provider[]
  current?: { providerID: string; modelID: string }
  extras?: ModelPickerExtras
  onSelect: (selection: {
    providerID: string
    modelID: string
    subProvider?: string
  }) => void | Promise<void>
}) {
  const [search, setSearch] = createSignal("")
  const [rail, setRail] = createSignal(ALL_KEY)
  const [accountTarget, setAccountTarget] = createSignal<Item | undefined>()
  const [endpointTarget, setEndpointTarget] = createSignal<Item | undefined>()

  // Endpoint fetch state, keyed by model id. `undefined` = in flight or never
  // requested, `null` = failed, array = loaded.
  const [endpoints, setEndpoints] = createSignal<Record<string, OpenRouterEndpoint[] | null | undefined>>({})

  let searchRef: HTMLInputElement | undefined

  const prefs = () => props.extras?.preferences
  const [prefVersion, setPrefVersion] = createSignal(0)
  createEffect(() => {
    const store = prefs()
    if (!store) return
    return store.subscribe(() => setPrefVersion((v) => v + 1))
  })

  // Ranking inputs. The public usage/pricing tables are fetched once per
  // session (and cached in localStorage for a day by `getUsageTables`); until
  // they land the list is name-sorted, which is what the desktop shows in the
  // same window rather than a second, different priced order.
  const [tables, setTables] = createSignal<UsageTables | undefined>()
  const [personal, setPersonal] = createSignal<PersonalIndex>({})

  createEffect(() => {
    if (!props.open) return
    setSearch("")
    setRail(ALL_KEY)
    setAccountTarget(undefined)
    setEndpointTarget(undefined)
    void prefs()?.load()
    setPersonal(readPersonalCostIndex())
    if (!tables()) void loadUsageTables().then((loaded) => loaded && setTables(loaded))
    queueMicrotask(() => searchRef?.focus({ preventScroll: true }))
  })

  const quotaData = () => props.extras?.quota?.() ?? []

  const accountLabels = createMemo(() => collectAccountLabels(quotaData()))

  const allItems = createMemo<Item[]>(() =>
    props.providers.flatMap((provider) =>
      Object.values(provider.models ?? {}).map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        provider: { id: provider.id, name: provider.name },
        model,
      })),
    ),
  )

  /**
   * One canonical row per model, with account-qualified ids collapsed into the
   * group's variant list - the desktop's behaviour, so a provider enrolling
   * three accounts does not triple the list length.
   */
  const groups = createMemo(() => collapseAccountVariants(allItems(), MULTI_ACCOUNT_PROVIDERS, accountLabels()))

  const groupIndex = createMemo(() => indexModelGroups(groups()))

  const queried = createMemo(() => {
    const q = search().trim().toLowerCase()
    if (!q) return groups()
    // Keep only groups that match, but let an account label or id bring back
    // its own variant row - typing "dana" should find that account's model.
    const matched = expandForQuery(groups(), q).map(baseKey)
    const keep = new Set(matched)
    if (keep.size > 0) return groups().filter((group) => keep.has(group.key))
    return groups().filter(
      (group) =>
        (group.canonical.provider.name ?? "").toLowerCase().includes(q) ||
        group.canonical.provider.id.toLowerCase().includes(q),
    )
  })

  /**
   * Canonical rows for the current query, ranked cheapest-first by the same
   * usage-yield engine the desktop selector uses (see `model-ranking.ts`).
   *
   * Declared here, above every memo that reads it: `createMemo` evaluates its
   * body immediately, so a memo defined earlier that calls `flatItems()` hits
   * the temporal dead zone and throws `ReferenceError`. That throw escapes
   * Solid's update queue and leaves it wedged, which stops the *entire app*
   * re-rendering — the UI keeps its last painted frame and every click looks
   * like it did nothing.
   */
  const flatItems = createMemo<Item[]>(() =>
    rankModels(
      queried().map((group) => group.canonical),
      // Fallbacks are built from the whole catalog, not the filtered view, so a
      // model hidden behind a rail filter can still donate a sibling price.
      { tables: tables(), catalog: allItems(), personal: personal() },
    ),
  )

  const favorites = createMemo(() => {
    prefVersion()
    const store = prefs()
    return store ? new Set(store.favorites()) : fallbackFavorites()
  })

  const recentKeys = createMemo(() => {
    prefVersion()
    const entries = prefs()?.recents() ?? []
    return entries.map((entry) => `${entry.providerID}:${entry.modelID}`)
  })

  const recentItems = createMemo(() => {
    const keys = recentKeys()
    if (keys.length === 0) return []
    // Resolve through the groups, not the raw catalog: a recent entry holding
    // an account-qualified id must light up the collapsed canonical row
    // (showing its account chip) rather than vanishing once the catalog stops
    // listing that variant explicitly.
    const canonical = new Map<string, Item>()
    for (const group of groups()) {
      canonical.set(modelKey(group.canonical), group.canonical)
      for (const variant of group.variants) canonical.set(modelKey(variant.item), group.canonical)
    }
    // Present in the current (search-filtered) list, and not already surfaced
    // under Favorites - the desktop drops a favorited model from Recent rather
    // than listing the same row twice.
    const visible = new Set(flatItems().map(modelKey))
    const favored = favorites()
    const out: Item[] = []
    for (const key of keys) {
      const item = canonical.get(key)
      if (!item || out.includes(item)) continue
      const itemKey = modelKey(item)
      if (!visible.has(itemKey) || favored.has(itemKey)) continue
      out.push(item)
    }
    return out
  })

  const [localVersion, setLocalVersion] = createSignal(0)
  const forceUpdate = () => setLocalVersion((v) => v + 1)

  const toggleFavorite = (item: Item) => {
    const key = modelKey(item)
    const next = new Set(favorites())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    const store = prefs()
    if (store) store.setFavorites([...next])
    else writeFavorites(next)
    forceUpdate()
  }

  // --- Recents -------------------------------------------------------------

  const rememberRecent = (item: Item) => {
    const store = prefs()
    if (!store) return
    const key = modelKey(item)
    const next = [{ providerID: item.provider.id, modelID: item.id }, ...store.recents().filter((entry) => `${entry.providerID}:${entry.modelID}` !== key)].slice(0, 10)
    store.setRecents(next)
  }

  // --- Selection -----------------------------------------------------------

  const currentAccountID = createMemo(() => {
    const value = props.current
    if (!value) return undefined
    return splitModelIDForProvider(value.modelID, value.providerID).accountID
  })

  const subProviderKey = subProviderKeyFor

  const subProviderFor = (item: Item): string | undefined => {
    prefVersion()
    if (item.provider.id !== "openrouter") return undefined
    return prefs()?.subProviderFor(subProviderKey(item.provider.id, item.id))
  }

  const selectItem = async (item: Item) => {
    rememberRecent(item)
    const subProvider = subProviderFor(item)
    await props.onSelect({ providerID: item.provider.id, modelID: item.id, ...(subProvider ? { subProvider } : {}) })
  }

  const setPin = (item: Item, value: string | undefined) => {
    prefs()?.setSubProvider(subProviderKey(item.provider.id, item.id), value)
  }

  // --- OpenRouter endpoints ------------------------------------------------

  // Self-heal a pin whose upstream no longer serves the model: without this the
  // request would carry `provider: { only: [...] }` for a provider that cannot
  // serve it and fail on every send.
  const healStalePins = (modelID: string, list: OpenRouterEndpoint[]) => {
    const store = prefs()
    if (!store) return
    // Read with the same key `subProviderKey` writes.
    const key = subProviderKey("openrouter", modelID)
    const pinned = store.subProviderFor(key)
    if (pinned && !list.some((entry) => entry.provider === pinned)) {
      store.setSubProvider(key, undefined)
    }
  }

  const ensureEndpoints = (modelID: string) => {
    const fetcher = props.extras?.fetchEndpoints
    if (!fetcher) return
    if (modelID in endpoints()) return
    setEndpoints((prev) => ({ ...prev, [modelID]: undefined }))
    void fetcher(modelID).then((result) => {
      // `undefined` from the fetcher means the request failed (an empty array
      // is a real "no upstreams to pin"), so it is stored as null to keep the
      // two distinguishable in the UI.
      const list = result ?? null
      if (list) healStalePins(modelID, list)
      setEndpoints((prev) => ({ ...prev, [modelID]: list }))
    })
  }

  const endpointsFor = (modelID: string): OpenRouterEndpoint[] | null | undefined => endpoints()[modelID]

  // --- Rail ----------------------------------------------------------------

  const railProviders = createMemo<{ id: string; name: string }[]>(() => {
    prefVersion()
    const seen = new Map<string, string>()
    for (const item of flatItems()) if (!seen.has(item.provider.id)) seen.set(item.provider.id, item.provider.name)
    const list = Array.from(seen, ([id, name]) => ({ id, name }))
    // Server-shared rail order first; providers the snapshot has never seen
    // keep their computed position rather than being shuffled to the end.
    const store = prefs()
    return store ? store.applyRail(list) : list
  })


  const railOptions = createMemo<RailOption[]>(() => {
    const opts: RailOption[] = [{ key: ALL_KEY, name: "All models" }]
    if (favorites().size > 0) opts.push({ key: FAV_KEY, name: "Favorites" })
    if (recentItems().length > 0) opts.push({ key: RECENT_KEY, name: "Recent" })
    for (const provider of railProviders()) opts.push({ key: provider.id, name: provider.name, providerID: provider.id })
    return opts
  })

  // Fall back to "All" if the active rail drops out of the filtered list,
  // rather than showing a stuck-empty pane.
  const activeRail = createMemo(() => {
    const key = rail()
    return railOptions().some((o) => o.key === key) ? key : ALL_KEY
  })

  const railFiltered = createMemo<Item[]>(() => {
    const key = activeRail()
    if (key === FAV_KEY) return flatItems().filter((item) => favorites().has(modelKey(item)))
    if (key === RECENT_KEY) return recentItems()
    if (key === ALL_KEY) return flatItems()
    return flatItems().filter((item) => item.provider.id === key)
  })

  // --- Rows ----------------------------------------------------------------

  /**
   * Applies the user's manual order for one section on top of the ranking,
   * exactly as the desktop does: models the stored snapshot names come first in
   * that order, everything else keeps its ranked position. The snapshot is the
   * shared server document, so a group reordered on the desktop reads the same
   * here.
   */
  const ordered = (section: string, items: Item[]) => {
    prefVersion()
    const snapshot = prefs()?.orderFor(section)
    return applySectionOrder(items, snapshot ? [...snapshot] : undefined, modelKey)
  }

  const grouped = createMemo(() => {
    const map = new Map<string, Item[]>()
    for (const item of railFiltered()) {
      const list = map.get(item.provider.id)
      if (list) list.push(item)
      else map.set(item.provider.id, [item])
    }
    return [...map.values()].map((items) => ({
      provider: items[0]!.provider,
      items: ordered(items[0]!.provider.id, items),
    }))
  })

  const rows = createMemo<Row[]>(() => {
    localVersion()
    prefVersion()
    const out: Row[] = []
    const key = activeRail()
    const showFavorites = key === FAV_KEY || (key === ALL_KEY && favorites().size > 0)
    const showRecents = key === RECENT_KEY || (key === ALL_KEY && recentItems().length > 0 && !search().trim())

    if (showFavorites) {
      const items = ordered(
        FAVORITES_SECTION,
        railFiltered().filter((item) => favorites().has(modelKey(item))),
      )
      out.push({ kind: "header", key: "h:favorites", title: "Favorites", count: items.length })
      for (const item of items) out.push({ kind: "item", key: `fav:${modelKey(item)}`, item, group: groupIndex().get(modelKey(item)) })
      if (key === FAV_KEY) return out
    }

    if (showRecents) {
      const items = recentItems()
      out.push({ kind: "header", key: "h:recent", title: "Recent", count: items.length })
      for (const item of items) out.push({ kind: "item", key: `rec:${modelKey(item)}`, item, group: groupIndex().get(modelKey(item)) })
      if (key === RECENT_KEY) return out
    }

    // On "All", a model already listed under Favorites or Recent must not be
    // repeated under its provider group - the same row twice reads as a bug.
    const alreadyShown = new Set(
      out.filter((entry) => entry.kind === "item").map((entry) => modelKey((entry as { item: Item }).item)),
    )

    for (const group of grouped()) {
      const items = group.items.filter((item) => !alreadyShown.has(modelKey(item)))
      if (items.length === 0) continue
      out.push({ kind: "header", key: `h:${group.provider.id}`, title: group.provider.name, count: items.length })
      for (const item of items)
        out.push({ kind: "item", key: modelKey(item), item, group: groupIndex().get(modelKey(item)) })
    }
    return out
  })

  // --- Variants (account + upstream display state) -------------------------

  /** Accounts offered for a row, merged with any quota-only roster. */
  const variantsFor = (item: Item, group: ModelGroup<Item> | undefined): AccountVariant<Item>[] => {
    if (!group) return []
    if (group.variants.length > 1) return group.variants
    // The catalog has one or zero variants but the live account roster may
    // have more; synthesize selectable rows so a new key is reachable.
    const roster = synthesizeAccounts(item.provider.id, quotaData())
    if (roster.length <= 1) return group.variants
    // Build from the base model, not the row's id: the row may already carry
    // an account suffix, and `base@a@b` is not a resolvable model id.
    const base = splitModelIDForProvider(item.id, item.provider.id).baseModelID
    return roster.map((entry) => ({
      accountID: entry.accountId,
      item: { ...item, id: `${base}@${entry.accountId}`, name: entry.label ? `${item.name} (${entry.label})` : item.name },
    }))
  }

  // Cached per provider *and* model: WorkBuddy/Verdent quotas are per model, so
  // a resolver keyed by provider alone would report another model's headroom.
  const usageForAccountResolver = createMemo(() => {
    const cache = new Map<string, (accountID: string) => AccountUsage | undefined>()
    return (item: Item) => {
      const base = splitModelIDForProvider(item.id, item.provider.id).baseModelID
      const key = `${item.provider.id}:${base}`
      const existing = cache.get(key)
      if (existing) return existing
      const resolver = usageForAccount(item.provider.id, quotaData(), accountLabels(), base)
      cache.set(key, resolver)
      return resolver
    }
  })

  const pinnedName = (item: Item) => {
    const pinned = subProviderFor(item)
    if (!pinned) return undefined
    const list = endpointsFor(item.id)
    return list?.find((entry) => entry.provider === pinned)?.providerName
  }

  // --- Row renderer --------------------------------------------------------

  const row = (item: Item, group: ModelGroup<Item> | undefined) => {
    const current = () => props.current
    /**
     * A collapsed row represents a whole account group, so an exact id match is
     * not enough: selecting `model@wb-a` must light up the `model` row (and
     * show which account is pinned) instead of leaving the list looking like
     * nothing is selected.
     */
    const selected = () => {
      const value = current()
      if (!value) return false
      if (value.providerID !== item.provider.id) return false
      if (value.modelID === item.id) return true
      const base = splitModelIDForProvider(value.modelID, value.providerID).baseModelID
      return base === splitModelIDForProvider(item.id, item.provider.id).baseModelID
    }
    const isFav = () => favorites().has(modelKey(item))
    const model = item.model
    // "Free" is the provider's tier, not merely a $0 price: an image model
    // publishes zeros too, and labelling it free would be wrong. Same predicate
    // the desktop rows and the ranking taxonomy use.
    const free = isFreeModel({ id: item.id, name: item.name, provider: item.provider, cost: model.cost })
    const unlimited = isUnlimitedModel({ id: item.id, name: item.name, cost: model.cost })
    // The catalog marks a provider's current pick by appending "(latest)".
    const latest = item.name.includes("(latest)")
    const priced = hasPublishedPricing(model.cost)

    const variants = () => variantsFor(item, group)
    const showAccounts = () => isMultiAccountProvider(item.provider.id) && variants().length > 1
    const isOpenRouter = () => item.provider.id === "openrouter"

    const selectedVariantID = createMemo(() => {
      if (!selected()) return undefined
      const value = current()
      if (!value) return undefined
      const byItem = group?.variants.find((variant) => variant.item.id === value.modelID)
      // Fall back to parsing the id so a synthesized row (or a group the index
      // never indexed) still shows which account is pinned.
      return byItem?.accountID ?? splitModelIDForProvider(value.modelID, value.providerID).accountID
    })

    const accountChip = () => {
      if (!selectedVariantID()) return undefined
      const variant = variants().find((v) => v.accountID === selectedVariantID())
      return accountLabels().get(selectedVariantID()!) ?? variant?.accountID
    }

    const openAccounts = () => {
      setAccountTarget(item)
    }

    const openEndpoints = () => {
      ensureEndpoints(item.id)
      setEndpointTarget(item)
    }

    return (
      <div class="model-row" classList={{ selected: selected() }}>
        <button
          type="button"
          class="model-row-hit"
          onClick={() => void selectItem(item)}
        >
          <div class="model-row-main">
            <div class="model-row-name">
              <span class="name">{displayName(group?.label ?? item.name)}</span>
              <Show when={model.capabilities?.reasoning}><IconBrain size={10} class="cap-icon reasoning" /></Show>
              <Show when={model.capabilities?.input?.image}><IconImage size={10} class="cap-icon image" /></Show>
              <Show when={free && !unlimited}><span class="model-tag free">Free</span></Show>
              <Show when={unlimited}><span class="model-tag free">Unlimited</span></Show>
              <Show when={latest}><span class="model-tag latest">Latest</span></Show>
              <Show when={isNewModel(model)}><span class="model-tag new">New</span></Show>
              <Show when={model.status !== "active"}><span class="model-tag status">{model.status}</span></Show>
            </div>
            <div class="model-row-meta">
              <span>{formatContext(model.limit?.context ?? 0)} ctx</span>
              <span>·</span>
              <span class={free ? "free" : ""}>
                {free
                  ? "free"
                  : priced
                    ? `${formatCostPerMillion(model.cost.input)} / ${formatCostPerMillion(model.cost.output)} per M`
                    : // No published rate anywhere. Rendering "$0.00" here reads
                      // as free when it only means unpriced.
                      "—"}
              </span>
            </div>
          </div>
        </button>

        <Show when={accountChip()}>
          {(chip) => <span class="model-account-chip" title={chip()}>{chip()}</span>}
        </Show>

        <Show when={isOpenRouter() && pinnedName(item)}>
          {(name) => <span class="model-upstream-chip">{name()}</span>}
        </Show>

        <Show when={showAccounts()}>
          <button
            type="button"
            class="model-variant-btn"
            aria-label="Choose account"
            onClick={openAccounts}
          >
            <span class="count">{variants().length}</span>
            <IconChevronRight size={12} />
          </button>
        </Show>

        <Show when={isOpenRouter()}>
          <button
            type="button"
            class="model-variant-btn"
            aria-label="Choose upstream provider"
            onClick={openEndpoints}
          >
            <IconZap size={11} />
          </button>
        </Show>

        <button
          class="model-fav-btn"
          classList={{ active: isFav() }}
          aria-label={isFav() ? "Remove favorite" : "Add favorite"}
          onClick={() => toggleFavorite(item)}
        >
          <IconStar size={13} />
        </button>

        <Show when={selected()}>
          <IconCheck size={13} class="model-row-check" />
        </Show>
      </div>
    )
  }

  // --- Sub-sheets ----------------------------------------------------------

  const accountTargetItem = () => accountTarget()
  const accountTargetGroup = () => {
    const item = accountTarget()
    if (!item) return undefined
    return groupIndex().get(modelKey(item)) ?? groupIndex().get(baseKey(item))
  }

  const endpointTargetItem = () => endpointTarget()

  const onSelectAccount = async (accountID: string) => {
    const item = accountTargetItem()
    const group = accountTargetGroup()
    setAccountTarget(undefined)
    if (!item) return

    const chosen = group ? variantForPolicy(group, accountID) : undefined
    if (chosen) {
      await selectItem(chosen)
      return
    }
    // The account is enrolled but has no catalog row of its own (a key added
    // after the catalog cache was built). Compose the id the server expects.
    const base = splitModelIDForProvider(item.id, item.provider.id).baseModelID
    await selectItem({ ...item, id: `${base}@${accountID}` })
  }

  const onSelectAuto = async () => {
    const group = accountTargetGroup()
    const item = accountTargetItem()
    setAccountTarget(undefined)
    if (!item) return
    // Auto is the provider's own routing: select the bare, unqualified model.
    const bare = group?.auto ?? group?.canonical
    await selectItem(bare ? { ...bare, id: splitModelIDForProvider(bare.id, bare.provider.id).baseModelID } : item)
  }

  return (
    <>
      <Sheet open={props.open} onClose={props.onClose} title="Model" height="full">
        <div class="model-picker">
          <div class="model-search">
            <div class="model-search-field">
              <IconSearch size={12} />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search models"
                placeholder="Search models."
                value={search()}
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                onInput={(event) => {
                  setSearch(event.currentTarget.value)
                  setRail(ALL_KEY)
                }}
              />
              <Show when={search()}>
                <button
                  type="button"
                  class="model-search-clear"
                  aria-label="Clear model search"
                  onClick={() => {
                    setSearch("")
                    setRail(ALL_KEY)
                    searchRef?.focus({ preventScroll: true })
                  }}
                >
                  <IconX size={12} />
                </button>
              </Show>
            </div>
          </div>

          <div class="model-picker-body">
            <RadioGroup
              class="model-rail"
              orientation="vertical"
              size="small"
              options={railOptions()}
              current={railOptions().find((o) => o.key === activeRail())}
              value={(o) => o.key}
              onSelect={(o) => setRail(o?.key ?? ALL_KEY)}
              label={(o) => (
                <span
                  class="model-rail-btn"
                  classList={{ favorites: o.key === FAV_KEY, all: o.key === ALL_KEY, recent: o.key === RECENT_KEY }}
                  title={o.name}
                >
                  <Show when={o.key === ALL_KEY}><IconGrid size={15} /></Show>
                  <Show when={o.key === FAV_KEY}><IconStar size={14} /></Show>
                  <Show when={o.key === RECENT_KEY}><IconClockGlyph /></Show>
                  <Show when={o.providerID}>{(id) => <ProviderBadge providerID={id()} size="sm" />}</Show>
                </span>
              )}
            />

            <div class="model-list-pane">
              <For each={rows()}>
                {(item) =>
                  item.kind === "header" ? (
                    <div class="model-group-head">
                      <span class="name">{item.title}</span>
                      <span class="count">{item.count}</span>
                    </div>
                  ) : (
                    row(item.item, item.group)
                  )
                }
              </For>
              <Show when={rows().length === 0}>
                <div class="empty-list">
                  <p>No models matching "{search()}"</p>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Sheet>

      <AccountPickerSheet
        open={accountTargetItem() !== undefined}
        onClose={() => setAccountTarget(undefined)}
        title={displayName(accountTargetGroup()?.label ?? accountTargetItem()?.name ?? "")}
        group={accountTargetGroup()}
        variants={accountTargetItem() ? variantsFor(accountTargetItem()!, accountTargetGroup()) : []}
        // Selecting the bare model is always the provider's own routing, so
        // Auto is offered for every row that has accounts to choose between.
        hasAuto={accountTargetItem() !== undefined}
        selectedAccountID={accountTargetItem() && props.current?.providerID === accountTargetItem()!.provider.id ? currentAccountID() : undefined}
        selectedAuto={(() => {
          const item = accountTargetItem()
          const value = props.current
          if (!item || !value || value.providerID !== item.provider.id) return false
          // Auto means no account suffix at all. Comparing against the base id
          // alone would also match `model@wb-a`, whose base is `model`.
          if (splitModelIDForProvider(value.modelID, value.providerID).accountID) return false
          return value.modelID === splitModelIDForProvider(item.id, item.provider.id).baseModelID
        })()}
        usageForAccount={
          accountTargetItem() ? usageForAccountResolver()(accountTargetItem()!) : undefined
        }
        accountLabels={accountLabels()}
        onSelectAuto={() => void onSelectAuto()}
        onSelectAccount={(id) => void onSelectAccount(id)}
      />

      <EndpointPickerSheet
        open={endpointTargetItem() !== undefined}
        onClose={() => setEndpointTarget(undefined)}
        title={displayName(endpointTargetItem()?.name ?? "")}
        endpoints={
          endpointTargetItem() ? endpointsFor(endpointTargetItem()!.id) ?? undefined : undefined
        }
        pinned={endpointTargetItem() ? subProviderFor(endpointTargetItem()!) : undefined}
        onPick={(provider) => {
          const item = endpointTargetItem()
          setEndpointTarget(undefined)
          if (!item) return
          setPin(item, provider)
          void selectItem(item)
        }}
      />
    </>
  )
}

// --- Fallbacks when no preferences store is wired ---------------------------

const FAVORITES_KEY = "opencode.mobile.favoriteModels"

function fallbackFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function writeFavorites(set: Set<string>) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...set]))
  } catch {
    // Storage is an optimization.
  }
}

function IconClockGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  )
}
