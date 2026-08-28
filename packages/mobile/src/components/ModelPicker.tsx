import type { Provider } from "@opencode-ai/sdk/v2/client"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { IconBrain, IconCheck, IconGrid, IconImage, IconSearch, IconStar, IconX } from "../icons"
import { applyProviderRailOrder, readProviderRailOrder } from "../modelPreferences"
import { ProviderBadge } from "./ProviderBadge"
import { Sheet } from "./Sheet"

const FAVORITES_KEY = "opencode.mobile.favoriteModels"

function readFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function writeFavorites(set: Set<string>) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...set]))
  } catch {}
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return `${n}`
}

// cost is $ per million tokens already — grow decimal precision only when 2
// decimals would round a real nonzero rate down to "$0.00".
function formatCostPerMillion(value: number): string {
  if (value === 0) return "$0.00"
  let decimals = 2
  while (decimals < 8 && Number(value.toFixed(decimals)) === 0) decimals++
  return `$${value.toFixed(decimals)}`
}

// A handful of providers most people actually use — surfaced first in the
// rail and in provider group ordering, same idea as the desktop selector's
// `popularProviders`, just a short local list since mobile has no shared hook.
const POPULAR_PROVIDERS = ["anthropic", "claude", "claude-api", "openai", "opencode", "google", "openrouter"]

const NEW_WINDOW_MS = 45 * 24 * 60 * 60 * 1000
function isNewModel(model: ModelEntry): boolean {
  const t = Date.parse(model.release_date ?? "")
  return !Number.isNaN(t) && Date.now() - t < NEW_WINDOW_MS
}

type ModelEntry = Provider["models"][string]
type Entry = { provider: Provider; model: ModelEntry }

const ALL_KEY = "__all__"
const FAV_KEY = "__favorites__"

type RailOption = { key: string; name: string; provider?: Provider }

type Row =
  | { kind: "header"; key: string; title: string; count: number }
  | { kind: "item"; key: string; entry: Entry }

export function ModelPicker(props: {
  open: boolean
  onClose: () => void
  providers: Provider[]
  current?: { providerID: string; modelID: string }
  onSelect: (providerID: string, modelID: string) => void | Promise<void>
}) {
  const [search, setSearch] = createSignal("")
  const [favorites, setFavorites] = createSignal<Set<string>>(readFavorites())
  const [rail, setRail] = createSignal(ALL_KEY)
  const [providerOrder, setProviderOrder] = createSignal(readProviderRailOrder())
  let searchRef: HTMLInputElement | undefined

  createEffect(() => {
    if (!props.open) return
    setSearch("")
    setRail(ALL_KEY)
    setProviderOrder(readProviderRailOrder())
    queueMicrotask(() => searchRef?.focus({ preventScroll: true }))
  })

  const favKey = (providerID: string, modelID: string) => `${providerID}:${modelID}`
  const toggleFavorite = (providerID: string, modelID: string) => {
    const key = favKey(providerID, modelID)
    const next = new Set(favorites())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setFavorites(next)
    writeFavorites(next)
  }

  const allEntries = createMemo<Entry[]>(() =>
    props.providers.flatMap((provider) => Object.values(provider.models ?? {}).map((model) => ({ provider, model }))),
  )

  const searched = createMemo(() => {
    const q = search().trim().toLowerCase()
    if (!q) return allEntries()
    return allEntries().filter(
      ({ provider, model }) =>
        (model.name ?? model.id).toLowerCase().includes(q) ||
        provider.name.toLowerCase().includes(q) ||
        provider.id.toLowerCase().includes(q),
    )
  })

  const favoriteEntries = createMemo(() => searched().filter((e) => favorites().has(favKey(e.provider.id, e.model.id))))

  const railProviders = createMemo(() => {
    const seen = new Map<string, Provider>()
    for (const { provider } of searched()) if (!seen.has(provider.id)) seen.set(provider.id, provider)
    const providers = [...seen.values()].sort((a, b) => {
      const ai = POPULAR_PROVIDERS.indexOf(a.id)
      const bi = POPULAR_PROVIDERS.indexOf(b.id)
      if (ai >= 0 && bi < 0) return -1
      if (ai < 0 && bi >= 0) return 1
      if (ai >= 0 && bi >= 0) return ai - bi
      return a.name.localeCompare(b.name)
    })
    return applyProviderRailOrder(providers, providerOrder())
  })

  const railOptions = createMemo<RailOption[]>(() => {
    const opts: RailOption[] = [{ key: ALL_KEY, name: "All models" }]
    if (favoriteEntries().length > 0) opts.push({ key: FAV_KEY, name: "Favorites" })
    for (const provider of railProviders()) opts.push({ key: provider.id, name: provider.name, provider })
    return opts
  })

  // If the active rail provider drops out of the (search-filtered) list, fall
  // back to "All" instead of showing a stuck-empty pane.
  const activeRail = createMemo(() => {
    const key = rail()
    return railOptions().some((o) => o.key === key) ? key : ALL_KEY
  })

  const railFiltered = createMemo(() => {
    const key = activeRail()
    if (key === FAV_KEY) return favoriteEntries()
    if (key === ALL_KEY) return searched()
    return searched().filter((e) => e.provider.id === key)
  })

  const groupedByProvider = createMemo(() => {
    const map = new Map<string, Entry[]>()
    for (const entry of railFiltered()) {
      const group = map.get(entry.provider.id)
      if (group) group.push(entry)
      else map.set(entry.provider.id, [entry])
    }
    return [...map.values()].map((entries) => ({ provider: entries[0]!.provider, entries }))
  })

  const rows = createMemo<Row[]>(() => {
    const out: Row[] = []
    const key = activeRail()
    if (key === FAV_KEY) {
      for (const entry of favoriteEntries()) out.push({ kind: "item", key: favKey(entry.provider.id, entry.model.id) + ":fav", entry })
      return out
    }
    if (key === ALL_KEY && !search().trim() && favoriteEntries().length > 0) {
      out.push({ kind: "header", key: "h:favorites", title: "Favorites", count: favoriteEntries().length })
      for (const entry of favoriteEntries()) out.push({ kind: "item", key: favKey(entry.provider.id, entry.model.id) + ":fav", entry })
    }
    for (const group of groupedByProvider()) {
      out.push({ kind: "header", key: `h:${group.provider.id}`, title: group.provider.name, count: group.entries.length })
      for (const entry of group.entries) out.push({ kind: "item", key: favKey(entry.provider.id, entry.model.id), entry })
    }
    return out
  })

  const row = (entry: Entry) => {
    const { provider, model } = entry
    const selected = () => props.current?.providerID === provider.id && props.current?.modelID === model.id
    const isFav = () => favorites().has(favKey(provider.id, model.id))
    const free = model.cost.input === 0 && model.cost.output === 0
    return (
      <div
        class="model-row"
        classList={{ selected: selected() }}
        role="button"
        tabindex="0"
        onClick={() => void props.onSelect(provider.id, model.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            void props.onSelect(provider.id, model.id)
          }
        }}
      >
        <div class="model-row-main">
          <div class="model-row-name">
            <span class="name">{model.name}</span>
            <Show when={model.capabilities?.reasoning}><IconBrain size={10} class="cap-icon reasoning" /></Show>
            <Show when={model.capabilities?.input?.image}><IconImage size={10} class="cap-icon image" /></Show>
            <Show when={free}><span class="model-tag free">Free</span></Show>
            <Show when={isNewModel(model)}><span class="model-tag new">New</span></Show>
            <Show when={model.status !== "active"}><span class="model-tag status">{model.status}</span></Show>
          </div>
          <div class="model-row-meta">
            <span>{formatContext(model.limit?.context ?? 0)} ctx</span>
            <span>·</span>
            <span class={free ? "free" : ""}>
              {free ? "free" : `${formatCostPerMillion(model.cost.input)} / ${formatCostPerMillion(model.cost.output)} per M`}
            </span>
          </div>
        </div>
        <button
          class="model-fav-btn"
          classList={{ active: isFav() }}
          aria-label={isFav() ? "Remove favorite" : "Add favorite"}
          onClick={(e) => {
            e.stopPropagation()
            toggleFavorite(provider.id, model.id)
          }}
        >
          <IconStar size={13} />
        </button>
        <Show when={selected()}>
          <IconCheck size={13} class="model-row-check" />
        </Show>
      </div>
    )
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Model" height="full">
      <div class="model-picker">
        <div class="model-search">
          <div class="model-search-field">
            <IconSearch size={12} />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search models"
              placeholder="Search models…"
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
                classList={{ favorites: o.key === FAV_KEY, all: o.key === ALL_KEY }}
                title={o.name}
              >
                <Show when={o.key === ALL_KEY}><IconGrid size={15} /></Show>
                <Show when={o.key === FAV_KEY}><IconStar size={14} /></Show>
                <Show when={o.provider}>{(provider) => <ProviderBadge providerID={provider().id} size="sm" />}</Show>
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
                  row(item.entry)
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
  )
}
