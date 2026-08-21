import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  Component,
  ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Tag as TagV2 } from "@opencode-ai/ui/v2/badge-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ModelTooltip, formatCostPerMillion } from "./model-tooltip"
import { getOpenRouterEndpoints, type OpenRouterEndpoint } from "@/utils/openrouter-endpoints"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { handleDocumentSearchKeydown } from "@/utils/search-keydown"
import { createMenuDismissController } from "@/utils/menu-dismiss-controller"
import { createEventListener } from "@solid-primitives/event-listener"
import { createPolled } from "@solid-primitives/timer"
import { matchesModelSearch } from "./dialog-select-model-search"
import { useForkUsage } from "@/context/fork-usage"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import type { ForkWindowUsage } from "@/utils/fork-client"
import { percent as usagePercent, colorFor } from "./usage-gauge-v2"
import { estimateRequestsRemaining, estimateRequestsRemainingFromCost, isUsageTrackedProvider } from "@/utils/model-usage-estimate"
import { getUsageTables, matchUsagePricing, matchUsageProfile } from "@/utils/model-usage-profile"
import { averageCostPerRequest, buildModelCostIndex } from "@/utils/model-usage-history"
import { deepSeekRatePeriod, isDeepSeekPeakPricedModel } from "@/utils/model-peak-pricing"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]

const modelKey = (model: ModelItem) => `${model.provider.id}:${model.id}`
const manageKey = "action:manage"

// Sentinel for "let OpenRouter pick the upstream provider" — the first,
// default-selected entry of the sub-provider picker. Storing it is never
// persisted; choosing it clears the pinned preference so nothing reaches the
// request (`request.ts` additionally guards against it defensively).
const OPENROUTER_AUTO = "auto"
const favoritesRailKey = "favorites"

// Row streaming: render enough rows to fill the ~320px viewport several times
// over on the first paint, then append the remainder during idle frames. A
// 1000-model catalog otherwise mounts synchronously at open (~70ms block).
const INITIAL_RENDER_ROWS = 48
const RENDER_CHUNK = 96
// The highlighted row must always exist in the DOM; keep this much company
// rendered past it so arrowing into unrendered territory never misses.
const ACTIVE_RENDER_BUFFER = 24

// Representative $/token price (input + output) — cheapest first within a
// provider group and within favorites, name as tiebreaker for equal-cost models.
const modelCost = (item: ModelItem) => item.cost.input + item.cost.output
const byCost = (a: ModelItem, b: ModelItem) => modelCost(a) - modelCost(b) || a.name.localeCompare(b.name)

const sortModelGroups = (a: { category: string; items: ModelItem[] }, b: { category: string; items: ModelItem[] }) => {
  const aIndex = popularProviders.indexOf(a.category)
  const bIndex = popularProviders.indexOf(b.category)
  const aPopular = aIndex >= 0
  const bPopular = bIndex >= 0

  if (aPopular && !bPopular) return -1
  if (!aPopular && bPopular) return 1
  if (aPopular && bPopular) return aIndex - bIndex
  return a.items[0].provider.name.localeCompare(b.items[0].provider.name)
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()

  const models = createMemo(() =>
    model
      .list()
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          openDelay={0}
          value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular">
          <span class="truncate">{i.name}</span>
          <DeepSeekRateBadge model={i} />
          <Show when={isFree(i.provider.id, i.cost)}>
            <Tag>{language.t("model.tag.free")}</Tag>
          </Show>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

// Tiers on the *absolute* number of requests you could still make with this
// model, not on % of budget spent (that figure is identical for every model
// sharing a credential and says nothing about a specific model's affordability).
const stretchTone = (requests: number) => {
  if (requests <= 8) return "danger"
  if (requests <= 40) return "warning"
  return "success"
}

// A relative "how much stretch do I get from this model" bar: length is the
// estimated remaining-request count for this model on a log scale, normalized
// against the most generous model currently visible. Cheap/high-throughput
// models (thousands of estimated requests) read as long bars; expensive ones
// (dozens of requests) read as short bars — a plain linear scale would crush
// everything but the priciest model to zero given how wide that range is.
function ModelStretchBar(props: { requests: number; maxRequests: number }) {
  const fraction = () => {
    if (props.maxRequests <= 0) return 0
    const value = Math.log1p(Math.max(0, props.requests)) / Math.log1p(props.maxRequests)
    return Math.max(0, Math.min(1, value))
  }
  const color = () => colorFor(stretchTone(props.requests))

  return (
    <span class="flex h-3 w-7 shrink-0 items-center overflow-hidden rounded-full bg-v2-background-bg-layer-03">
      <span
        class="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${fraction() * 100}%`, "background-color": color() }}
      />
    </span>
  )
}

function ModelRowMeta(props: {
  item: ModelItem
  usage?: { estimatedRequests?: number }
  maxRequests: number
  price: JSX.Element
}) {
  return (
    <Show
      when={props.usage?.estimatedRequests !== undefined}
      fallback={<span class="shrink-0 tabular-nums text-v2-text-text-faint">{props.price}</span>}
    >
      <ModelStretchBar requests={props.usage!.estimatedRequests!} maxRequests={props.maxRequests} />
    </Show>
  )
}

// Tiers on *uptime* — the closest honest "which upstream should I trust"
// signal OpenRouter's public API actually populates (its throughput/latency
// fields are null for every provider). Same color language as the usage bar.
const uptimeTone = (uptime: number) => {
  if (uptime >= 99) return "success"
  if (uptime >= 95) return "warning"
  return "danger"
}

const formatPricePerM = (cost: number) => `${formatCostPerMillion(cost)}/M`

const providerIconId = (provider: string, providerName: string) => {
  const value = `${provider} ${providerName}`.toLowerCase()
  if (value.includes("amazon-bedrock")) return "amazon-bedrock"
  if (value.includes("google-vertex-anthropic")) return "google-vertex-anthropic"
  if (value.includes("anthropic")) return "anthropic"
  if (value.includes("azure")) return "azure"
  if (value.includes("openai")) return "openai"
  if (value.includes("google") || value.includes("vertex")) return "google-vertex"
  if (value.includes("deepseek")) return "deepseek"
  if (value.includes("meta") || value.includes("llama")) return "llama"
  if (value.includes("mistral")) return "mistral"
  if (value.includes("qwen") || value.includes("alibaba")) return "alibaba"
  if (value.includes("moonshot")) return "moonshotai"
  if (value.includes("nvidia")) return "nvidia"
  if (value.includes("perplexity")) return "perplexity"
  if (value.includes("huggingface")) return "huggingface"
  if (value.includes("siliconflow")) return "siliconflow"
  if (value.includes("scaleway")) return "scaleway"
  if (value.includes("nebius")) return "nebius"
  if (value.includes("vultr")) return "vultr"
  if (value.includes("novita")) return "novita-ai"
  if (value.includes("together")) return "togetherai"
  if (value.includes("fireworks")) return "fireworks-ai"
  if (value.includes("digitalocean")) return "digitalocean"
  if (value.includes("groq")) return "groq"
  if (value.includes("cerebras")) return "cerebras"
  if (value.includes("cohere")) return "cohere"
  if (value.includes("deepinfra")) return "deepinfra"
  if (value.includes("xai")) return "xai"
  return "synthetic"
}

// An OpenRouter model row is a `Menu.Sub` trigger: hovering opens a submenu
// whose header shows the model's full `ModelTooltip` (so the tooltip is part
// of the submenu, not a separate floating element competing with its hover-
// open) followed by the upstream-provider picker. The Sub is rendered outside
// the RadioGroup — see `rowList`. Best-effort endpoints fetch; failure
// degrades to Auto-only with no entry list.
function OpenRouterRow(props: {
  item: ModelItem
  navKey: string
  active: boolean
  current: boolean
  favorited: boolean
  pinned: string | undefined
  usage?: { percent: number; estimatedRequests?: number; personalized?: boolean }
  maxRequests: number
  onActivate: () => void
  onToggleFavorite: () => void
  onPickProvider: (tag: string | undefined) => void
  submenuOpen: boolean
  onSubmenuChange: (open: boolean) => void
}) {
  const language = useLanguage()
  const sdk = useSDK()
  // Fetch the upstream-provider table lazily, only once the user actually
  // approaches this row (hover) to open the picker — never on mount. Opening
  // the selector with a connected OpenRouter account lists dozens of models,
  // and firing one endpoints fetch (+ sync localStorage parse) per row up
  // front causes a janky/paint-blocking burst right at popover open.
  const [endpoints, setEndpoints] = createSignal<OpenRouterEndpoint[] | undefined>()
  const [loading, setLoading] = createSignal(false)
  let requested: string | undefined
  const fetchEndpoints = async (model: string) => {
    const response = await sdk().client.experimental.openrouterEndpoints.get({ model }, { throwOnError: true })
    // The server proxy normalizes OpenRouter's per-token prices to USD/1M (its
    // canonical boundary). No real per-million rate is below $0.0001, so any
    // smaller magnitude is a per-token price leaked by a stale proxy or cached
    // response — rescale it here rather than ever rendering a "$0.0000004/M".
    const perMillion = (value: number) =>
      Math.abs(value) > 0 && Math.abs(value) < 1e-4 ? value * 1_000_000 : value
    return response.data.map((entry) => ({
      providerName: entry.providerName,
      tag: entry.tag,
      provider: entry.provider,
      pricing: {
        prompt: perMillion(Number(entry.pricing.prompt)),
        completion: perMillion(Number(entry.pricing.completion)),
        cacheRead: perMillion(Number(entry.pricing.cacheRead)),
      },
      uptime: entry.uptime === undefined ? undefined : Number(entry.uptime),
    }))
  }
  const loadEndpoints = () => {
    const model = props.item.id
    if (requested === model) return
    requested = model
    setLoading(true)
    void getOpenRouterEndpoints(model, fetchEndpoints).then((result) => {
      setEndpoints(result)
      setLoading(false)
    })
  }
  // Stable catalog price (USD/1M), identical to the other rows. Deriving it from
  // the lazily-fetched upstream table made the number jump the moment endpoints
  // loaded on hover; the submenu carries the per-provider rates instead.
  const price = () => formatPricePerM(modelCost(props.item))
  const pinnedName = () => {
    const tag = props.pinned
    if (!tag) return undefined
    return endpoints()?.find((entry) => entry.provider === tag)?.providerName
  }

  return (
    <MenuV2.Sub
      gutter={6}
      overlap
      overflowPadding={8}
      open={props.submenuOpen}
      onOpenChange={(open) => {
        props.onSubmenuChange(open)
        if (open) {
          loadEndpoints()
          return
        }
        // Reset so reopening after a failed load re-fetches instead of
        // short-circuiting on `requested`; successful loads are served from the
        // module cache so a reopen here is cheap.
        requested = undefined
      }}
    >
      <MenuV2.SubTrigger
        data-option-key={props.navKey}
        data-selected-model={props.current ? true : undefined}
        title={pinnedName()}
        class="scroll-my-6 w-full"
        classList={{ "!bg-v2-overlay-simple-overlay-hover": props.active || props.current }}
        onPointerMove={() => {
          props.onActivate()
        }}
      >
        <ProviderIcon id={props.item.provider.id} class="size-3.5 shrink-0 opacity-60" />
        <span class="min-w-0 flex-1 truncate leading-5">{props.item.name}</span>
        <Show when={props.item.latest}>
          <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
        </Show>
        <ModelRowMeta
          item={props.item}
          usage={props.usage}
          maxRequests={props.maxRequests}
          price={<span class="text-[10px] font-[520] leading-5">{price()}</span>}
        />
        <ModelFavoriteToggle favorited={props.favorited} onToggle={props.onToggleFavorite} />
      </MenuV2.SubTrigger>
      <MenuV2.Portal>
        <MenuV2.SubContent class="w-64 rounded-md border-0 bg-v2-background-bg-layer-01 p-1 shadow-[var(--v2-elevation-floating)] focus:outline-none">
          <div
            class="mb-1 border-b border-v2-border-border-muted px-3 pb-1.5"
            style={{ "font-size": "11px", "line-height": "12px", "font-weight": 530 }}
          >
            <ModelTooltip
              model={props.item}
              latest={props.item.latest}
              free={isFree(props.item.provider.id, props.item.cost)}
              usage={props.usage}
              v2
            />
          </div>
          <MenuV2.Item
            data-selected={!props.pinned ? true : undefined}
            onSelect={() => props.onPickProvider(undefined)}
          >
            <span class="min-w-0 flex-1 truncate">{language.t("dialog.model.subprovider.auto")}</span>
            <Show when={!props.pinned}>
              <Icon name="check" size="small" class="shrink-0 text-v2-text-text-accent" />
            </Show>
          </MenuV2.Item>
          <MenuV2.Separator class="my-0.5" />
          <Show
            when={loading()}
            fallback={
              <Show
                when={endpoints() && endpoints()!.length > 0}
                fallback={
                  <MenuV2.Item disabled>
                    <span class="min-w-0 flex-1 truncate">
                      {endpoints() === undefined
                        ? language.t("dialog.model.subprovider.error")
                        : language.t("dialog.model.subprovider.empty")}
                    </span>
                  </MenuV2.Item>
                }
              >
                <For each={endpoints()}>
                  {(entry) => (
                    <TooltipV2
                      class="w-full"
                      placement="right-start"
                      gutter={6}
                      openDelay={0}
                      value={
                        <OpenRouterProviderTooltip
                          model={props.item}
                          endpoint={entry}
                          pinned={props.pinned === entry.provider}
                        />
                      }
                    >
                      <MenuV2.Item
                        class="w-full"
                        data-selected={props.pinned === entry.provider ? true : undefined}
                        onSelect={() => props.onPickProvider(entry.provider)}
                      >
                        <ProviderIcon
                          id={providerIconId(entry.provider, entry.providerName)}
                          class="size-3.5 shrink-0 opacity-70"
                        />
                        <span class="min-w-0 flex-1 truncate">{entry.providerName}</span>
                        <span class="shrink-0 text-[10px] font-[520] tabular-nums text-v2-text-text-faint">
                          {formatPricePerM(entry.pricing.prompt + entry.pricing.completion)}
                        </span>
                        <Show when={entry.uptime !== undefined}>
                          <span
                            class="shrink-0 rounded-sm px-1 text-[9px] font-[600] uppercase leading-4"
                            title={language.t("dialog.model.subprovider.uptime")}
                            style={{ color: colorFor(uptimeTone(entry.uptime!)) }}
                          >
                            {entry.uptime!.toFixed(1)}%
                          </span>
                        </Show>
                      </MenuV2.Item>
                    </TooltipV2>
                  )}
                </For>
              </Show>
            }
          >
            <MenuV2.Item disabled>
              <span class="min-w-0 flex-1 truncate">{language.t("common.loading")}</span>
            </MenuV2.Item>
          </Show>
        </MenuV2.SubContent>
      </MenuV2.Portal>
    </MenuV2.Sub>
  )
}

// Specialized tooltip for an OpenRouter upstream-provider entry in the picker:
// who serves the model, at what price, with what uptime, and whether it's the
// currently pinned routing target.
function OpenRouterProviderTooltip(props: {
  model: ModelItem
  endpoint: OpenRouterEndpoint
  pinned: boolean
}) {
  const language = useLanguage()
  const row = (name: string, value: JSX.Element) => (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{value}</span>
    </div>
  )
  return (
    <div class="flex w-[224px] flex-col gap-2">
      {row(
        language.t("model.tooltip.provider"),
        <span class="font-[520]">{props.endpoint.providerName}</span>,
      )}
      {row(language.t("model.tooltip.model"), props.model.name)}
      {row(
        language.t("model.tooltip.cost.input"),
        <span class="tabular-nums">{formatPricePerM(props.endpoint.pricing.prompt)}</span>,
      )}
      {row(
        language.t("model.tooltip.cost.output"),
        <span class="tabular-nums">{formatPricePerM(props.endpoint.pricing.completion)}</span>,
      )}
      <Show when={props.endpoint.pricing.cacheRead > 0}>
        {row(
          language.t("model.tooltip.cost.cached"),
          <span class="tabular-nums">{formatPricePerM(props.endpoint.pricing.cacheRead)}</span>,
        )}
      </Show>
      <Show when={props.endpoint.uptime !== undefined}>
        {row(
          language.t("dialog.model.subprovider.uptime"),
          <span class="tabular-nums" style={{ color: colorFor(uptimeTone(props.endpoint.uptime!)) }}>
            {props.endpoint.uptime!.toFixed(1)}%
          </span>,
        )}
      </Show>
      <Show when={props.pinned}>
        <div class="h-px bg-v2-border-border-muted" />
        <span class="text-[10px] font-[520] text-v2-text-text-accent">
          {language.t("dialog.model.subprovider.pinned")}
        </span>
      </Show>
    </div>
  )
}

function ModelFavoriteToggle(props: { favorited: boolean; onToggle: () => void }) {
  const language = useLanguage()
  return (
    <button
      type="button"
      class="flex size-5 shrink-0 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
      classList={{ "!text-v2-state-fg-warning": props.favorited }}
      aria-label={props.favorited ? language.t("model.favorite.remove") : language.t("model.favorite.add")}
      aria-pressed={props.favorited}
      onPointerDown={(event) => {
        // Kobalte's selectable items select on pointerdown (mousedown), not
        // click — preventDefault alone doesn't stop it from bubbling to the
        // RadioItem's own pointerdown handler and selecting the model.
        event.preventDefault()
        event.stopPropagation()
      }}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        props.onToggle()
      }}
    >
      <Icon name={props.favorited ? "star-filled" : "star"} size="small" />
    </button>
  )
}

// DeepSeek V4 Flash / Pro (OpenCode Zen) are priced by time-of-day rate
// period. Show whether it is peak or off-peak right now, refreshed on a
// minute boundary so the badge tracks the current UTC hour without a build.
function DeepSeekRateBadge(props: { model: ModelItem; v2?: boolean }) {
  const language = useLanguage()
  const now = createPolled(() => new Date(), 60_000)
  const label = () =>
    deepSeekRatePeriod(now()) === "peak" ? language.t("model.tag.peak") : language.t("model.tag.offpeak")
  const badge = () =>
    props.v2 ? (
      <TagV2 class="shrink-0" title={language.t("model.peak.hours")}>
        {label()}
      </TagV2>
    ) : (
      <Tag class="shrink-0" title={language.t("model.peak.hours")}>
        {label()}
      </Tag>
    )
  return <Show when={isDeepSeekPeakPricedModel(props.model)}>{badge()}</Show>
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => JSX.Element
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"
export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  trigger: ModelSelectorTrigger
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const local = useLocal()
  const directory = () => decode64(local.slug())

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-connect-provider").then((x) => {
      void dialog.show(() => <x.DialogConnectProvider directory={directory} />)
    })
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.trigger} />
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => close("select")}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export function ModelSelectorPopoverV2(props: {
  provider?: string
  model?: ModelState
  trigger: ModelSelectorTrigger
  onClose?: () => void
}) {
  const dialog = useDialog()
  const layout = useLayout()
  const local = useLocal()
  const directory = () => decode64(local.slug())
  const controller = createModelSelectorController({
    model: props.model,
    provider: () => props.provider,
    onSelect: () => props.onClose?.(),
  })

  const handleCompare = () => {
    layout.models.toggle()
  }

  return (
    <ModelSelectorPopoverV2View
      trigger={props.trigger}
      models={controller.models}
      groups={controller.groups}
      favorites={controller.favorites}
      isFavorite={controller.isFavorite}
      onToggleFavorite={controller.toggleFavorite}
      current={controller.current}
      select={controller.select}
      subProviderGet={controller.subProviderGet}
      subProviderSet={controller.subProviderSet}
      onCompare={handleCompare}
      onManage={() => {
        void import("./dialog-manage-models").then((module) => {
          void dialog.show(() => <module.DialogManageModelsV2 />)
        })
      }}
      onManageCredentials={() => {
        void import("./dialog-credential-switcher").then((module) => {
          void dialog.show(() => <module.DialogCredentialSwitcherV2 directory={directory} />)
        })
      }}
      onClose={() => props.onClose?.()}
    />
  )
}

function createModelSelectorController(input: {
  provider: () => string | undefined
  model?: ModelState
  onSelect: () => void
}) {
  const model = input.model ?? useLocal().model
  const allModels = createMemo(() =>
    model
      .list()
      .filter((item) => model.visible({ modelID: item.id, providerID: item.provider.id }))
      .filter((item) => (input.provider() ? item.provider.id === input.provider() : true)),
  )

  const key = (item: ModelItem) => ({ modelID: item.id, providerID: item.provider.id })

  return {
    models: (search: string) => {
      const query = search.trim()
      const filtered = query
        ? allModels().filter((item) => matchesModelSearch(query, [item.name, item.id, item.provider.name]))
        : allModels()
      return [...filtered].sort(byCost)
    },
    groups: (models: ModelItem[]) => {
      const byProvider = new Map<string, ModelItem[]>()
      for (const item of models) {
        byProvider.set(item.provider.id, [...(byProvider.get(item.provider.id) ?? []), item])
      }
      return Array.from(byProvider, ([category, items]) => ({ category, items: [...items].sort(byCost) })).sort(
        sortModelGroups,
      )
    },
    favorites: (models: ModelItem[]) =>
      models.filter((item) => model.favorite.isFavorite(key(item))).sort(byCost),
    isFavorite: (item: ModelItem) => model.favorite.isFavorite(key(item)),
    toggleFavorite: (item: ModelItem) => model.favorite.toggle(key(item)),
    current: () => {
      const value = model.current()
      return value ? modelKey(value) : undefined
    },
    select: (item: ModelItem) => {
      model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
      input.onSelect()
    },
    subProviderGet: (item: ModelItem) =>
      model.subProvider.get({ providerID: item.provider.id, modelID: item.id }),
    subProviderSet: (item: ModelItem, value: string | undefined) =>
      model.subProvider.set({ providerID: item.provider.id, modelID: item.id }, value),
  }
}

type NavRow = { navKey: string; item?: ModelItem }

function ModelSelectorPopoverV2View(props: {
  trigger: ModelSelectorTrigger
  models: (search: string) => ModelItem[]
  groups: (models: ModelItem[]) => { category: string; items: ModelItem[] }[]
  favorites: (models: ModelItem[]) => ModelItem[]
  isFavorite: (item: ModelItem) => boolean
  onToggleFavorite: (item: ModelItem) => void
  current: () => string | undefined
  select: (item: ModelItem) => void
  subProviderGet: (item: ModelItem) => string | undefined
  subProviderSet: (item: ModelItem, value: string | undefined) => void
  onCompare: () => void
  onManage: () => void
  onManageCredentials: () => void
  onClose: () => void
}) {
  const language = useLanguage()
  const forkUsage = useForkUsage()
  const sync = useSync()
  const [tables] = createResource(() => getUsageTables())
  const profileTable = () => tables()?.profile ?? []
  const pricingTable = () => tables()?.pricing ?? []
  const [store, setStore] = createStore({ open: false, search: "", active: "", rail: "", submenu: "" })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  const dismiss = createMenuDismissController(() => contentRef)

  const models = createMemo(() => props.models(store.search))
  // The provider rail is derived from the full (search-filtered) model list so
  // it never collapses when one provider is selected — filtering happens below.
  const railProviders = createMemo(() => {
    const seen = new Map<string, string>()
    for (const item of models()) {
      if (!seen.has(item.provider.id)) seen.set(item.provider.id, item.provider.name)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  })
  const railModels = createMemo(() => {
    if (store.rail === "" || store.rail === favoritesRailKey) return models()
    return models().filter((item) => item.provider.id === store.rail)
  })
  const groups = createMemo(() => props.groups(railModels()))
  const favorites = createMemo(() => props.favorites(models()))
  const showFavorites = () =>
    favorites().length > 0 && (store.rail === "" || store.rail === favoritesRailKey)
  const showProviderGroups = () => store.rail !== favoritesRailKey
  const hasContent = () => (store.rail === favoritesRailKey ? favorites().length > 0 : railModels().length > 0)
  const favoriteKey = (item: ModelItem) => `fav:${modelKey(item)}`

  // Deliberately does NOT fall back to `usage.latest.aggregate`: that figure
  // spans every credential the account has ever used (including long-since
  // reset/exhausted ones), which is why an earlier version of this pinned at
  // 100%. Without a resolved active credential's own window we simply don't
  // know, so no bar is shown rather than a misleading one.
  const activeWindow = createMemo<ForkWindowUsage | undefined>(() => {
    const credentialID = forkUsage.activeCredentialID()
    if (!credentialID) return undefined
    const windows = forkUsage.usage.latest?.byCredential.find((entry) => entry.credentialID === credentialID)?.windows
    return windows?.find((entry) => entry.label === "5h")
  })
  // One O(messages) pass, memoized, instead of rescanning the whole message
  // store per model per row (previously O(models * messages) on every render).
  const costIndex = createMemo(() => buildModelCostIndex(sync().data.message))
  const usageFor = (item: ModelItem) => {
    if (!isUsageTrackedProvider(item.provider.id)) return undefined
    const window = activeWindow()
    if (!window) return undefined
    const key = { id: item.id, providerID: item.provider.id }
    const personalCost = averageCostPerRequest(costIndex(), key)
    const estimatedRequests =
      personalCost !== undefined
        ? estimateRequestsRemainingFromCost(window, personalCost)
        : estimateRequestsRemaining(
            window,
            matchUsagePricing(pricingTable() ?? [], { name: item.name, family: item.family, id: item.id }) ?? item.cost,
            matchUsageProfile(profileTable() ?? [], { name: item.name, family: item.family, id: item.id }),
          )
    return {
      percent: usagePercent(window),
      estimatedRequests,
      personalized: personalCost !== undefined,
    }
  }
  // Compute usage once per model and reuse it for the max-requests scaling and
  // every rendered row, instead of running the profile/pricing match loops
  // twice per model (once here, once per row) on every open.
  // Deferred until after first paint so opening the selector paints the model
  // list immediately; the usage bars (and the cost-index scan they can trigger)
  // fill in on the next idle frame instead of blocking the open.
  const [usageReady, setUsageReady] = createSignal(false)
  onMount(() => {
    const schedule = (cb: () => void) =>
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(cb, { timeout: 200 })
        : setTimeout(cb, 0)
    schedule(() => setUsageReady(true))
  })
  const usageMap = createMemo(() => {
    const map = new Map<string, ReturnType<typeof usageFor>>()
    if (!usageReady()) return map
    for (const item of models()) {
      map.set(modelKey(item), usageFor(item))
    }
    return map
  })
  const maxRequests = createMemo(() => {
    let max = 0
    for (const item of models()) {
      const requests = usageMap().get(modelKey(item))?.estimatedRequests
      if (requests !== undefined && requests > max) max = requests
    }
    return max
  })

  const rows = createMemo<NavRow[]>(() => [
    ...favorites().map((item) => ({ navKey: favoriteKey(item), item })),
    ...groups().flatMap((group) => group.items.map((item) => ({ navKey: modelKey(item), item }))),
    { navKey: manageKey },
  ])
  // Streamed rendering slices. Selection, search-first-key, and keyboard nav
  // all operate on the full logical list (rows()/navKeys()); only the DOM is
  // deferred. Slices keep item identity so <For> appends without remounting.
  const [renderLimit, setRenderLimit] = createSignal(INITIAL_RENDER_ROWS)
  const favoriteSlice = createMemo(() => (showFavorites() ? favorites().slice(0, renderLimit()) : []))
  // Per-group visible counts start where favorites left off; groups themselves
  // stay keyed by category so the outer <For> keeps stable identities while
  // slices grow.
  const groupVisibleCounts = createMemo(() => {
    let budget = Math.max(0, renderLimit() - favorites().length)
    const counts = new Map<string, number>()
    for (const group of groups()) {
      const count = Math.min(group.items.length, budget)
      counts.set(group.category, count)
      budget -= count
    }
    return counts
  })
  const renderedCount = createMemo(
    () =>
      (showFavorites() ? favorites().length : 0) +
      (showProviderGroups() ? groups().reduce((total, group) => total + group.items.length, 0) : 0),
  )
  createEffect(() => {
    const total = renderedCount()
    if (renderLimit() >= total) return
    const grow = () => setRenderLimit((limit) => Math.min(total, limit + RENDER_CHUNK))
    const handle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(grow, { timeout: 120 })
        : setTimeout(grow, 0)
    onCleanup(() => {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle as number)
      else clearTimeout(handle as number)
    })
  })
  createEffect(() => {
    const active = store.active
    if (!active || active === manageKey) return
    const index = rows().findIndex((row) => row.navKey === active)
    if (index < 0) return
    if (index + ACTIVE_RENDER_BUFFER > renderLimit()) {
      setRenderLimit(Math.min(renderedCount(), index + ACTIVE_RENDER_BUFFER))
    }
  })
  const navKeys = () => rows().map((row) => row.navKey)
  const initialActive = () => {
    const selected = props.current()
    const options = navKeys()
    if (selected && options.includes(selected)) return selected
    return options[0] ?? ""
  }
  const activeItem = () =>
    store.active ? contentRef?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(store.active)}"]`) : undefined
  const setOpen = (open: boolean) => {
    if (open) {
      dismiss.allowTriggerRestore()
      setRenderLimit(INITIAL_RENDER_ROWS)
      setStore({ open: true, active: initialActive(), submenu: "" })
      setTimeout(() =>
        requestAnimationFrame(() => {
          searchRef?.focus()
          activeItem()?.scrollIntoView({ block: "nearest" })
        }),
      )
      return
    }
    setStore({ open: false, search: "", active: "", submenu: "" })
  }
  const selectModel = (item: ModelItem) => {
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(() => props.select(item))
  }
  const manage = () => {
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(props.onManage)
  }
  const compare = () => {
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(props.onCompare)
  }
  const selectActive = () => {
    const row = rows().find((row) => row.navKey === store.active)
    if (!row) return
    if (row.item) {
      selectModel(row.item)
      return
    }
    manage()
  }
  const moveActive = (delta: number) => {
    const options = navKeys()
    if (options.length === 0) return
    const index = options.indexOf(store.active)
    const start = index === -1 ? 0 : index
    setStore("active", options[(start + delta + options.length) % options.length])
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  const setSearch = (value: string) => {
    const filtered = props.models(value)
    const fav = props.favorites(filtered)
    const firstKey = fav[0] ? favoriteKey(fav[0]) : filtered[0] ? modelKey(filtered[0]) : manageKey
    setStore({ search: value, active: firstKey })
  }

  createEffect(() => {
    if (!store.open) return
    createEventListener(
      document,
      "keydown",
      (event: KeyboardEvent) => handleDocumentSearchKeydown(searchRef, event, store.search, setSearch),
      true,
    )
  })

  const renderRow = (item: ModelItem, navKey: string) => {
    // Read the per-model usage computed once in usageMap rather than
    // re-running the profile/pricing match loops for every rendered row.
    const usage = createMemo(() => usageMap().get(modelKey(item)))
    if (item.provider.id === "openrouter") {
      return (
        <OpenRouterRow
          item={item}
          navKey={navKey}
          active={store.active === navKey}
          current={props.current() === modelKey(item)}
          favorited={props.isFavorite(item)}
          pinned={props.subProviderGet(item)}
          usage={usage()}
          maxRequests={maxRequests()}
          onActivate={() => setStore("active", navKey)}
          onToggleFavorite={() => props.onToggleFavorite(item)}
          submenuOpen={store.submenu === navKey}
          onSubmenuChange={(open) => {
            if (open) {
              setStore("submenu", navKey)
              return
            }
            if (store.submenu === navKey) setStore("submenu", "")
          }}
          onPickProvider={(tag) => {
            props.subProviderSet(item, tag)
            selectModel(item)
          }}
        />
      )
    }
    return (
      <TooltipV2
        class="w-full"
        placement="right-start"
        gutter={6}
        openDelay={0}
        value={
          <ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} usage={usage()} v2 />
        }
      >
        <MenuV2.RadioItem
          value={modelKey(item)}
          data-option-key={navKey}
          data-selected-model={props.current() === modelKey(item) ? true : undefined}
          class="scroll-my-6 w-full"
          classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === navKey }}
          onMouseEnter={() => {
            setStore("active", navKey)
            setTimeout(() => searchRef?.focus())
          }}
          onSelect={() => selectModel(item)}
        >
          <ProviderIcon id={item.provider.id} class="size-3.5 shrink-0 opacity-60" />
          <span class="min-w-0 flex-1 truncate leading-5">{item.name}</span>
          <DeepSeekRateBadge model={item} v2 />
          <Show when={isFree(item.provider.id, item.cost)}>
            <TagV2 class="shrink-0">{language.t("model.tag.free")}</TagV2>
          </Show>
          <Show when={item.latest}>
            <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
          </Show>
          <ModelRowMeta
            item={item}
            usage={usage()}
            maxRequests={maxRequests()}
            price={<span class="text-[10px] font-[520] leading-5">{formatPricePerM(modelCost(item))}</span>}
          />
          <ModelFavoriteToggle favorited={props.isFavorite(item)} onToggle={() => props.onToggleFavorite(item)} />
        </MenuV2.RadioItem>
      </TooltipV2>
    )
  }

  // Renders a group's model rows. Standard models are RadioItems and need a
  // RadioGroup to track the active selection; OpenRouter rows are nested
  // `Menu.Sub`s, which Kobalte registers in the parent menu's selection
  // manager — mixing them into the same RadioGroup corrupts selection and
  // dismissal (models stop selecting, the menu stops closing). So standard
  // rows stay in a RadioGroup and OpenRouter Subs are rendered beside it.
  const rowList = (items: ModelItem[], keyFor: (item: ModelItem) => string) => {
    const standard = items.filter((item) => item.provider.id !== "openrouter")
    const openrouter = items.filter((item) => item.provider.id === "openrouter")
    return (
      <>
        <Show when={standard.length > 0}>
          <MenuV2.RadioGroup value={props.current()}>
            <For each={standard}>{(item) => renderRow(item, keyFor(item))}</For>
          </MenuV2.RadioGroup>
        </Show>
        <For each={openrouter}>{(item) => renderRow(item, keyFor(item))}</For>
      </>
    )
  }

  return (
    <MenuV2 open={store.open} modal={false} placement="top-start" gutter={6} onOpenChange={setOpen}>
      <MenuV2.Trigger as={props.trigger} />
      <MenuV2.Portal>
        <MenuV2.Content
          ref={(element: HTMLDivElement) => (contentRef = element)}
          class="w-[316px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          onPointerDownOutside={dismiss.preventTriggerRestore}
          onFocusOutside={dismiss.preventTriggerRestore}
          onCloseAutoFocus={dismiss.onCloseAutoFocus}
        >
          <div class="flex flex-col p-0.5">
            <div class="flex h-7 items-center gap-2 rounded-sm pl-3 pr-2.5 text-v2-icon-icon-muted">
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={(el) => (searchRef = el)}
                value={store.search}
                placeholder={language.t("dialog.model.search.placeholder")}
                class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab") return
                  event.stopPropagation()
                  if (event.key === "Escape") {
                    event.preventDefault()
                    dismiss.preventTriggerRestore()
                    setOpen(false)
                    dismiss.afterClose(props.onClose)
                    return
                  }
                  if (event.altKey || event.metaKey) return
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    moveActive(1)
                    return
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    moveActive(-1)
                    return
                  }
                  if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault()
                    selectActive()
                  }
                }}
              />
              <Show when={store.search.trim()}>
                <button
                  type="button"
                  class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setSearch("")}
                  aria-label={language.t("common.clear")}
                >
                  <Icon name="close" size="small" />
                </button>
              </Show>
              <button
                type="button"
                class="flex size-5 shrink-0 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  compare()
                }}
                aria-label={language.t("dialog.model.compare")}
                title={language.t("dialog.model.compare")}
              >
                <Icon name="compare" size="small" />
              </button>
            </div>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex min-h-0 max-h-[320px]">
            <div class="flex w-8 shrink-0 flex-col items-stretch gap-0.5 border-r border-v2-border-border-muted p-0.5 py-1">
              <TooltipV2
                placement="right-start"
                gutter={6}
                openDelay={0}
                value={<span class="text-[12px] font-[500]">{language.t("dialog.model.favorites")}</span>}
              >
                <button
                  type="button"
                  class="relative flex size-7 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                  classList={{ "!text-v2-state-fg-warning": store.rail === favoritesRailKey }}
                  aria-label={language.t("dialog.model.favorites")}
                  title={language.t("dialog.model.favorites")}
                  onClick={() => setStore("rail", store.rail === favoritesRailKey ? "" : favoritesRailKey)}
                >
                  <Show when={store.rail === favoritesRailKey}>
                    <span class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-v2-state-fg-warning" />
                  </Show>
                  <Icon name="star-filled" size="small" class="shrink-0" />
                </button>
              </TooltipV2>
              <For each={railProviders()}>
                {(provider) => (
                  <TooltipV2
                    placement="right-start"
                    gutter={6}
                    openDelay={0}
                    value={<span class="text-[12px] font-[500]">{provider.name}</span>}
                  >
                    <button
                      type="button"
                      class="relative flex size-7 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                      classList={{ "!text-v2-text-text-accent": store.rail === provider.id }}
                      aria-label={provider.name}
                      title={provider.name}
                      onClick={() => setStore("rail", store.rail === provider.id ? "" : provider.id)}
                    >
                      <Show when={store.rail === provider.id}>
                        <span class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-v2-text-text-accent" />
                      </Show>
                      <ProviderIcon id={provider.id} class="size-4 shrink-0 opacity-70" />
                    </button>
                  </TooltipV2>
                )}
              </For>
            </div>
            <ScrollView data-slot="model-selector-scroll" class="min-h-0 flex-1">
              <div class="flex flex-col p-0.5 pt-0">
                <Show
                  when={hasContent()}
                  fallback={
                    <div class="flex h-12 items-center px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint">
                      {language.t("dialog.model.empty")}
                    </div>
                  }
                >
                  <Show when={showFavorites()}>
                  <MenuV2.Group>
                    <MenuV2.GroupLabel class="gap-2 px-3">
                      <Icon name="star-filled" size="small" class="shrink-0 text-v2-state-fg-warning" />
                      <span class="min-w-0 flex-1 truncate">{language.t("dialog.model.favorites")}</span>
                    </MenuV2.GroupLabel>
                    {rowList(favoriteSlice(), favoriteKey)}
                  </MenuV2.Group>
                  <MenuV2.Separator class="my-0.5" />
                </Show>
                <Show when={showProviderGroups()}>
                  <For each={groups()}>
                    {(group) => (
                      <Show when={(groupVisibleCounts().get(group.category) ?? 0) > 0}>
                        <MenuV2.Group>
                        <MenuV2.GroupLabel class="gap-2 px-3">
                          <ProviderIcon id={group.category} class="size-3.5 shrink-0 opacity-70" />
                          <span class="min-w-0 flex-1 truncate">{group.items[0].provider.name}</span>
                          <Show when={group.category === "opencode"}>
                            <button
                              type="button"
                              class="flex size-5 shrink-0 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                              aria-label={language.t("dialog.credential.manageKeys")}
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={(event) => {
                                event.stopPropagation()
                                props.onManageCredentials()
                              }}
                            >
                              <Icon name="outline-sliders" size="small" />
                            </button>
                          </Show>
                        </MenuV2.GroupLabel>
                        {rowList(group.items.slice(0, groupVisibleCounts().get(group.category) ?? 0), modelKey)}
                        </MenuV2.Group>
                      </Show>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </ScrollView>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col p-0.5">
            <MenuV2.Item
              data-option-key={manageKey}
              classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === manageKey }}
              onMouseEnter={() => {
                setStore("active", manageKey)
                setTimeout(() => searchRef?.focus())
              }}
              onSelect={manage}
            >
              <Icon name="outline-sliders" size="small" />
              <span class="min-w-0 flex-1 truncate leading-5">{language.t("dialog.model.manage")}</span>
            </MenuV2.Item>
          </div>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const directory = () => decode64(local.slug())

  const provider = () => {
    void import("./dialog-connect-provider").then((x) => {
      void dialog.show(() => <x.DialogConnectProvider directory={directory} />)
    })
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
