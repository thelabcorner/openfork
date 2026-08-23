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
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { createStore } from "solid-js/store"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
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
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { handleDocumentSearchKeydown } from "@/utils/search-keydown"
import { createMenuDismissController } from "@/utils/menu-dismiss-controller"
import { createEventListener } from "@solid-primitives/event-listener"
import { createPolled } from "@solid-primitives/timer"
import { createModelSearchMatcher, prepareModelSearchFields } from "./dialog-select-model-search"
import { useForkUsage } from "@/context/fork-usage"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import type { ForkWindowUsage } from "@/utils/fork-client"
import { percent as usagePercent, colorFor } from "./usage-gauge-v2"
import { useOpenRouterFreeUsage } from "@/hooks/use-openrouter-free-usage"
import { FreeUsageBar } from "./openrouter-free-usage-bar"
import { estimateRequestsRemaining, estimateRequestsRemainingFromCost, isUsageTrackedProvider } from "@/utils/model-usage-estimate"
import { getUsageTables, matchUsagePricing, matchUsageProfile } from "@/utils/model-usage-profile"
import { averageCostPerRequest, buildModelCostIndex } from "@/utils/model-usage-history"
import { deepSeekRatePeriod, isDeepSeekPeakPricedModel } from "@/utils/model-peak-pricing"
import { isUnlimitedModel, stripUnlimitedSuffix, hasPublishedPricing } from "@/utils/model-badges"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]

const modelKey = (model: ModelItem) => `${model.provider.id}:${model.id}`
const manageKey = "action:manage"
let persistedModelSearch = ""

// Sentinel for "let OpenRouter pick the upstream provider" — the first,
// default-selected entry of the sub-provider picker. Storing it is never
// persisted; choosing it clears the pinned preference so nothing reaches the
// request (`request.ts` additionally guards against it defensively).
const favoritesRailKey = "favorites"

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
      filter={persistedModelSearch}
      onFilter={(value) => {
        persistedModelSearch = value
      }}
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
          value={
            <ModelTooltip
              model={item}
              latest={item.latest}
              free={isFree(item.provider.id, item.cost)}
              unlimited={isUnlimitedModel(item)}
            />
          }
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
          <span class="truncate">{stripUnlimitedSuffix(i.name)}</span>
          <DeepSeekRateBadge model={i} />
          <Show when={isUnlimitedModel(i)}>
            <Tag>{language.t("model.tag.unlimited")}</Tag>
          </Show>
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

function OpenRouterEndpointList(props: {
  endpoints: OpenRouterEndpoint[]
  pinned: string | undefined
  onPickProvider: (tag: string | undefined) => void
}) {
  const language = useLanguage()
  const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement>()
  const [focusedIndex, setFocusedIndex] = createSignal(-1)
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.endpoints.length
    },
    getScrollElement: () => scrollRoot() ?? null,
    initialRect: { width: 256, height: 336 },
    estimateSize: () => 28,
    overscan: 4,
    getItemKey: (index) => props.endpoints[index]?.tag ?? index,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      const focused = focusedIndex()
      if (focused < 0 || indexes.includes(focused)) return indexes
      return [...indexes, focused].sort((a, b) => a - b)
    },
  })
  const focusIndex = (index: number) => {
    if (index < 0 || index >= props.endpoints.length) return
    setFocusedIndex(index)
    virtualizer.scrollToIndex(index, { align: "auto" })
    requestAnimationFrame(() => {
      scrollRoot()?.querySelector<HTMLElement>(`[data-endpoint-index="${index}"]`)?.focus()
    })
  }

  return (
    <ScrollView
      class="max-h-[336px] w-full [&_.scroll-view__viewport]:overscroll-contain"
      viewportRef={setScrollRoot}
    >
      <div class="relative" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        <For each={virtualizer.getVirtualItems()}>
          {(virtualRow) => {
            const entry = props.endpoints[virtualRow.index]
            if (!entry) return null
            const price = formatPricePerM(entry.pricing.prompt + entry.pricing.completion)
            return (
              <div
                class="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <MenuV2.Item
                  data-endpoint-index={virtualRow.index}
                  class="w-full"
                  data-selected={props.pinned === entry.provider ? true : undefined}
                  tabIndex={focusedIndex() === virtualRow.index || (focusedIndex() < 0 && virtualRow.index === 0) ? 0 : -1}
                  onFocus={() => setFocusedIndex(virtualRow.index)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
                    event.preventDefault()
                    event.stopPropagation()
                    focusIndex(virtualRow.index + (event.key === "ArrowDown" ? 1 : -1))
                  }}
                  onSelect={() => props.onPickProvider(entry.provider)}
                >
                  <ProviderIcon
                    id={providerIconId(entry.provider, entry.providerName)}
                    class="size-3.5 shrink-0 opacity-70"
                  />
                  <span class="min-w-0 flex-1 truncate">{entry.providerName}</span>
                  <span class="shrink-0 text-[10px] font-[520] tabular-nums text-v2-text-text-faint">
                    {price}
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
                  <Show when={entry.telemetry?.cacheHitPercent !== undefined}>
                    <span
                      class="shrink-0 rounded-sm px-1 text-[9px] font-[520] tabular-nums text-v2-text-text-faint"
                      title="Cache hit rate"
                    >
                      ~{entry.telemetry!.cacheHitPercent}%
                    </span>
                  </Show>
                  <Show when={entry.telemetry?.throughputTps !== undefined}>
                    <span
                      class="shrink-0 rounded-sm px-1 text-[9px] font-[520] tabular-nums text-v2-text-text-faint"
                      title="Throughput (tokens/s)"
                    >
                      {entry.telemetry!.throughputTps} tok/s
                    </span>
                  </Show>
                </MenuV2.Item>
              </div>
            )
          }}
        </For>
      </div>
    </ScrollView>
  )
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
  current: boolean
  favorited: boolean
  pinned: string | undefined
  usage?: { percent: number; estimatedRequests?: number; personalized?: boolean }
  maxRequests: number
  priceLabel: string
  rowRef: (element: HTMLElement | undefined) => void
  endpoints: OpenRouterEndpoint[] | undefined
  loading: boolean
  period?: ReturnType<typeof deepSeekRatePeriod>
  onActivate: () => void
  onToggleFavorite: () => void
  onPickProvider: (tag: string | undefined) => void
  submenuOpen: boolean
  onSubmenuChange: (open: boolean) => void
}) {
  const language = useLanguage()
  const pinnedName = () => {
    const tag = props.pinned
    if (!tag) return undefined
    return props.endpoints?.find((entry) => entry.provider === tag)?.providerName
  }

  return (
    <MenuV2.Sub
      gutter={6}
      overlap
      overflowPadding={8}
      open={props.submenuOpen}
      onOpenChange={(open) => {
        props.onSubmenuChange(open)
      }}
    >
      <MenuV2.SubTrigger
        ref={props.rowRef}
        data-option-key={props.navKey}
        data-selected-model={props.current ? true : undefined}
        title={pinnedName()}
        class="scroll-my-6 w-full"
        classList={{ "!bg-v2-overlay-simple-overlay-hover": props.current }}
        onMouseEnter={() => {
          props.onActivate()
          props.onSubmenuChange(true)
        }}
      >
        <ProviderIcon id={props.item.provider.id} class="size-3.5 shrink-0 opacity-60" />
        <span class="min-w-0 flex-1 truncate leading-5">{stripUnlimitedSuffix(props.item.name)}</span>
        <Show when={props.item.id.endsWith(":free") || props.item.id === "openrouter/free"}>
          <TagV2 class="shrink-0">{language.t("model.tag.free")}</TagV2>
        </Show>
        <Show when={props.item.latest}>
          <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
        </Show>
        <Show when={isUnlimitedModel(props.item)}>
          <TagV2 class="shrink-0">{language.t("model.tag.unlimited")}</TagV2>
        </Show>
        <ModelRowMeta
          item={props.item}
          usage={props.usage}
          maxRequests={props.maxRequests}
          price={<span class="text-[10px] font-[520] leading-5">{props.priceLabel}</span>}
        />
        <ModelFavoriteToggle favorited={props.favorited} onToggle={props.onToggleFavorite} />
      </MenuV2.SubTrigger>
      <Show when={props.submenuOpen}>
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
              unlimited={isUnlimitedModel(props.item)}
              usage={props.usage}
              period={props.period}
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
            when={props.loading}
            fallback={
              <Show
                when={props.endpoints && props.endpoints.length > 0}
                fallback={
                  <MenuV2.Item disabled>
                    <span class="min-w-0 flex-1 truncate">
                      {props.endpoints === undefined
                        ? language.t("dialog.model.subprovider.error")
                        : language.t("dialog.model.subprovider.empty")}
                    </span>
                  </MenuV2.Item>
                }
              >
                <OpenRouterEndpointList
                  endpoints={props.endpoints!}
                  pinned={props.pinned}
                  onPickProvider={props.onPickProvider}
                />
              </Show>
            }
          >
            <MenuV2.Item disabled>
              <span class="min-w-0 flex-1 truncate">{language.t("common.loading")}</span>
            </MenuV2.Item>
          </Show>
          </MenuV2.SubContent>
        </MenuV2.Portal>
      </Show>
    </MenuV2.Sub>
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
// The timer is owned once by ModelSelectorPopoverV2View (not per-row) to avoid
// N intervals for N rows; this component receives the shared period via props
// and degrades to a live read when used outside that view (legacy dialog).
function DeepSeekRateBadge(props: { model: ModelItem; v2?: boolean; period?: ReturnType<typeof deepSeekRatePeriod> }) {
  const language = useLanguage()
  // Only create a fallback timer when the caller didn't provide a shared period
  // and this row is actually a DeepSeek peak-priced model — avoids N timers for
  // N rows (previously every row created a 60s interval unconditionally).
  let fallbackNow: (() => Date) | undefined
  if (props.period === undefined && isDeepSeekPeakPricedModel(props.model)) {
    const now = createPolled(() => new Date(), 60_000)
    fallbackNow = now
  }
  const period = () => props.period ?? (fallbackNow ? deepSeekRatePeriod(fallbackNow()) : deepSeekRatePeriod(new Date()))
  const label = () => (period() === "peak" ? language.t("model.tag.peak") : language.t("model.tag.offpeak"))
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
      .filter((item) => (input.provider() ? item.provider.id === input.provider() : true))
      .sort(byCost),
  )
  const searchableFields = createMemo(
    () =>
      new Map(
        allModels().map((item) => [
          item,
          prepareModelSearchFields([item.name, item.id, item.provider.name]),
        ] as const),
      ),
  )

  const key = (item: ModelItem) => ({ modelID: item.id, providerID: item.provider.id })
  const current = createMemo(() => {
    const value = model.current()
    return value ? modelKey(value) : undefined
  })

  return {
    models: (search: string) => {
      const query = search.trim()
      if (!query) return allModels()
      const matches = createModelSearchMatcher(query)
      const fields = searchableFields()
      return allModels().filter((item) => matches(fields.get(item)!))
    },
    groups: (models: ModelItem[]) => {
      const byProvider = new Map<string, ModelItem[]>()
      for (const item of models) {
        const group = byProvider.get(item.provider.id)
        if (group) group.push(item)
        else byProvider.set(item.provider.id, [item])
      }
      return Array.from(byProvider, ([category, items]) => ({ category, items })).sort(sortModelGroups)
    },
    favorites: (models: ModelItem[]) => models.filter((item) => model.favorite.isFavorite(key(item))),
    isFavorite: (item: ModelItem) => model.favorite.isFavorite(key(item)),
    toggleFavorite: (item: ModelItem) => model.favorite.toggle(key(item)),
    current,
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
type SelectorRenderRow =
  | { kind: "header"; key: string; provider?: string; title: string }
  | { kind: "separator"; key: string }
  | { kind: "item"; key: string; navKey: string; item: ModelItem }

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
  const profileTable = () => tables.latest?.profile ?? []
  const pricingTable = () => tables.latest?.pricing ?? []
  const sdk = useSDK()
  const freeUsage = useOpenRouterFreeUsage({ includeValue: false })
  const freeModelRequests = createMemo(() => {
    const report = freeUsage.data()
    if (!report) return new Map<string, number>()
    const map = new Map<string, number>()
    for (const m of report.free.models) {
      map.set(m.model, m.requests)
      map.set(`openrouter:${m.model}`, m.requests)
    }
    return map
  })
  const [store, setStore] = createStore({ open: false, search: persistedModelSearch, active: "", rail: "", submenu: "" })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  const dismiss = createMenuDismissController(() => contentRef)
  let submenuTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSubmenu: string | undefined

  // Centralized DeepSeek period: one timer for the whole selector, not one per row.
  const deepSeekNow = createPolled(() => new Date(), 60_000)
  const deepSeekPeriod = createMemo(() => deepSeekRatePeriod(deepSeekNow()))

  // Centralized OpenRouter endpoint cache: one store + ring prefetcher instead of
  // per-row signals + per-hover fetches that each hit localStorage + network.
  const [openRouterStore, setOpenRouterStore] = createStore<
    Record<string, { loading: boolean; endpoints: OpenRouterEndpoint[] | undefined }>
  >({})
  const openRouterPrefetched = new Set<string>()
  const fetchOpenRouterEndpoints = async (model: string): Promise<OpenRouterEndpoint[]> => {
    const endpointsResponse = await sdk().client.experimental.openrouterEndpoints.get({ model }, { throwOnError: true })
    const perMillion = (value: number) => (Math.abs(value) > 0 && Math.abs(value) < 1e-4 ? value * 1_000_000 : value)
    const endpoints = endpointsResponse.data.map((entry) => {
      return {
        providerName: entry.providerName,
        tag: entry.tag,
        provider: entry.provider,
        pricing: {
          prompt: perMillion(Number(entry.pricing.prompt)),
          completion: perMillion(Number(entry.pricing.completion)),
          cacheRead: perMillion(Number(entry.pricing.cacheRead)),
        },
        uptime: entry.uptime === undefined ? undefined : Number(entry.uptime),
      }
    })
    return endpoints
  }
  const addOpenRouterTelemetry = async (model: string, endpoints: OpenRouterEndpoint[]) => {
    // Best-effort: telemetry augments uptime/price but must never break the submenu.
    // The server now never 500s (returns [] on no telemetry), so this is silent.
    try {
      const response = await sdk().client.experimental.openrouterTelemetry.get({ model, timeRange: "1w" }, { throwOnError: true })
      const telemetry = response.data ?? []
      if (telemetry.length === 0) return endpoints
      return endpoints.map((entry) => {
        const value = telemetry.find((item) => item.providerName === entry.providerName || item.providerSlug === entry.provider)
        const cacheHitPercent = value && Number.isFinite(Number(value.cacheHitPercent)) ? Number(value.cacheHitPercent) : undefined
        const throughputTps = value && Number.isFinite(Number(value.throughputTps)) ? Number(value.throughputTps) : undefined
        return value && cacheHitPercent !== undefined
          ? {
              ...entry,
              telemetry: {
                cacheHitPercent,
                ...(throughputTps === undefined ? {} : { throughputTps }),
              },
            }
          : entry
      })
    } catch (error) {
      // Silent best-effort — log for diagnostics, do not toast (would spam for ~ models).
      console.warn("[openrouter-telemetry] best-effort fetch failed", { model, error: String(error) })
      return endpoints
    }
  }
  const ensureOpenRouter = (modelID: string) => {
    const existing = openRouterStore[modelID]
    if (existing?.loading || existing?.endpoints !== undefined) return
    openRouterPrefetched.add(modelID)
    setOpenRouterStore(modelID, { loading: true, endpoints: undefined })
    void getOpenRouterEndpoints(modelID, fetchOpenRouterEndpoints).then(async (result) => {
      setOpenRouterStore(modelID, { loading: false, endpoints: result ? await addOpenRouterTelemetry(modelID, result) : result })
    })
  }

  // Hover is intentionally treated as an intent, not an immediate state change.
  // Scanning across rows should stay entirely CSS-only; only a row that remains
  // hovered long enough gets a tooltip/submenu and the associated reactive work.
  const TOOLTIP_INTENT_DELAY = 64
  const SUBMENU_INTENT_DELAY = 80
  let hoverRaf = 0
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  let pendingActive: string | null = null
  const flushPendingActive = () => {
    hoverRaf = 0
    const next = pendingActive
    pendingActive = null
    if (next !== null && store.active !== next) setStore("active", next)
  }
  const cancelHoverIntent = () => {
    pendingActive = null
    if (hoverRaf) {
      cancelAnimationFrame(hoverRaf)
      hoverRaf = 0
    }
    if (hoverTimer !== undefined) {
      clearTimeout(hoverTimer)
      hoverTimer = undefined
    }
  }
  const setSubmenu = (navKey: string, open: boolean, modelID: string) => {
    if (!open) {
      if (pendingSubmenu === navKey) {
        pendingSubmenu = undefined
        if (submenuTimer !== undefined) clearTimeout(submenuTimer)
        submenuTimer = undefined
      }
      if (store.submenu === navKey) setStore("submenu", "")
      return
    }
    if (pendingSubmenu === navKey || store.submenu === navKey) return
    if (submenuTimer !== undefined) clearTimeout(submenuTimer)
    pendingSubmenu = navKey
    submenuTimer = setTimeout(() => {
      submenuTimer = undefined
      pendingSubmenu = undefined
      setStore("submenu", navKey)
      ensureOpenRouter(modelID)
    }, SUBMENU_INTENT_DELAY)
  }
  const activate = (navKey: string) => {
    if (store.submenu && store.submenu !== navKey) setStore("submenu", "")
    if (pendingSubmenu && pendingSubmenu !== navKey) {
      pendingSubmenu = undefined
      if (submenuTimer !== undefined) clearTimeout(submenuTimer)
      submenuTimer = undefined
    }
    if (store.active === navKey) {
      cancelHoverIntent()
      return
    }
    pendingActive = navKey
    if (hoverTimer !== undefined) clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined
      if (hoverRaf) cancelAnimationFrame(hoverRaf)
      hoverRaf = requestAnimationFrame(flushPendingActive)
    }, TOOLTIP_INTENT_DELAY)
  }
  onCleanup(() => {
    cancelHoverIntent()
    if (submenuTimer !== undefined) clearTimeout(submenuTimer)
    pendingSubmenu = undefined
  })

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

  // O(1) lookups for hover: avoid linear `models().find` per hover and
  // `querySelector` DOM scans (forced layout). Refs are populated as rows mount.
  const rowRefs = new Map<string, HTMLElement>()
  const setRowRef = (key: string) => (element: HTMLElement | undefined) => {
    if (element) rowRefs.set(key, element)
    else rowRefs.delete(key)
  }
  const modelByKey = createMemo(() => {
    const map = new Map<string, ModelItem>()
    for (const item of models()) {
      map.set(modelKey(item), item)
      map.set(`fav:${modelKey(item)}`, item)
    }
    return map
  })
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
  // Ring prefetcher for OpenRouter: after open, warm endpoint data on idle, 3 at
  // a time. This effect deliberately never reads openRouterStore: reading a
  // reactive cache while writing it would restart the ring after every result.
  createEffect(() => {
    if (!store.open) return
    // Capture the current filtered model list; re-runs when search/rail changes.
    const ids = [...new Set(models().filter((item) => item.provider.id === "openrouter").map((item) => item.id))]
    if (ids.length === 0) return
    let cancelled = false
    const MAX_CONCURRENT = 3
    let inFlight = 0
    let index = 0
    const pump = () => {
      if (cancelled) return
      while (inFlight < MAX_CONCURRENT && index < ids.length) {
        const id = ids[index++]
        if (openRouterPrefetched.has(id)) continue
        openRouterPrefetched.add(id)
        inFlight++
        setOpenRouterStore(id, { loading: true, endpoints: undefined })
        void getOpenRouterEndpoints(id, fetchOpenRouterEndpoints)
          .then(async (result) => {
            if (!cancelled) setOpenRouterStore(id, { loading: false, endpoints: result ? await addOpenRouterTelemetry(id, result) : result })
          })
          .finally(() => {
            inFlight--
            if (index < ids.length) {
              const schedule =
                typeof requestIdleCallback === "function"
                  ? () => requestIdleCallback(pump, { timeout: 400 })
                  : () => setTimeout(pump, 32)
              schedule()
            }
          })
      }
    }
    let idleHandle: number | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (typeof requestIdleCallback === "function") idleHandle = requestIdleCallback(pump, { timeout: 600 })
    else timeoutHandle = setTimeout(pump, 64)
    onCleanup(() => {
      cancelled = true
      if (idleHandle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idleHandle)
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    })
  })

  // Shared tooltip: single floating card driven by active row, instead of N
  // Kobalte Tooltip instances each with MutationObserver + floating-ui overhead
  // and openDelay=0 mount on every hover. This cuts ~50 Tooltip managers to 1.
  const [tooltipPos, setTooltipPos] = createSignal<{ x: number; y: number } | null>(null)
  let tooltipPositionFrame = 0
  let tooltipSuppressedFor: string | undefined
  onCleanup(() => {
    if (tooltipPositionFrame) cancelAnimationFrame(tooltipPositionFrame)
  })
  const setTooltipPosition = (position: { x: number; y: number } | null) => {
    const current = tooltipPos()
    if (!position) {
      if (current) setTooltipPos(null)
      return
    }
    if (current?.x === position.x && current.y === position.y) return
    setTooltipPos(position)
  }
  const tooltipModel = createMemo<ModelItem | undefined>(() => {
    const active = store.active
    if (!active || active === manageKey) return undefined
    const candidate = modelByKey().get(active) ?? modelByKey().get(active.startsWith("fav:") ? active.slice(4) : active)
    if (!candidate || candidate.provider.id === "openrouter") return undefined
    if (store.rail !== "" && store.rail !== favoritesRailKey && candidate.provider.id !== store.rail) return undefined
    if (store.rail === favoritesRailKey && !props.isFavorite(candidate)) return undefined
    if (!store.open) return undefined
    return candidate
  })
  const tooltipUsage = createMemo(() => {
    const item = tooltipModel()
    return item ? usageMap().get(modelKey(item)) : undefined
  })
  const updateTooltipPosition = () => {
    const active = store.active
    if (tooltipSuppressedFor === active) {
      setTooltipPosition(null)
      return
    }
    const item = tooltipModel()
    if (!item) {
      setTooltipPosition(null)
      return
    }
    const element = rowRefs.get(store.active)
    const viewport = scrollRoot()
    if (!viewport) {
      setTooltipPosition(null)
      return
    }
    if (!element || !element.isConnected || !contentRef?.contains(element)) {
      tooltipSuppressedFor = active
      setTooltipPosition(null)
      return
    }
    const rect = element.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom || rect.height === 0) {
      tooltipSuppressedFor = active
      setTooltipPosition(null)
      return
    }
    const width = 236
    const height = 280
    let x = rect.right + 6
    let y = rect.top
    if (x + width > window.innerWidth) x = rect.left - width - 6
    if (x < 8) x = 8
    if (y + height > window.innerHeight) y = Math.max(8, window.innerHeight - height - 8)
    if (y < 8) y = 8
    setTooltipPosition({ x, y })
  }
  createEffect(() => {
    void tooltipModel()
    void store.open
    void scrollRoot()
    if (tooltipSuppressedFor !== store.active) tooltipSuppressedFor = undefined
    if (!store.open) {
      setTooltipPos(null)
      return
    }
    if (tooltipPositionFrame) cancelAnimationFrame(tooltipPositionFrame)
    tooltipPositionFrame = requestAnimationFrame(() => {
      tooltipPositionFrame = 0
      updateTooltipPosition()
    })
  })
  createEffect(() => {
    if (!store.open || !tooltipModel()) return
    const viewport = scrollRoot()
    if (!viewport) return
    const onScroll = () => {
      if (tooltipSuppressedFor === store.active) return
      if (tooltipPositionFrame) return
      tooltipPositionFrame = requestAnimationFrame(() => {
        tooltipPositionFrame = 0
        updateTooltipPosition()
      })
    }
    viewport.addEventListener("scroll", onScroll)
    window.addEventListener("resize", onScroll)
    onCleanup(() => {
      viewport.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    })
  })

  const rows = createMemo<NavRow[]>(() => [
    ...favorites().map((item) => ({ navKey: favoriteKey(item), item })),
    ...groups().flatMap((group) => group.items.map((item) => ({ navKey: modelKey(item), item }))),
    { navKey: manageKey },
  ])
  const renderRows = createMemo<SelectorRenderRow[]>(() => {
    const result: SelectorRenderRow[] = []
    if (showFavorites()) {
      result.push({ kind: "header", key: "header:favorites", title: language.t("dialog.model.favorites") })
      result.push(...favorites().map((item) => ({ kind: "item" as const, key: favoriteKey(item), navKey: favoriteKey(item), item })))
      result.push({ kind: "separator", key: "separator:favorites" })
    }
    if (showProviderGroups()) {
      for (const group of groups()) {
        result.push({
          kind: "header",
          key: `header:${group.category}`,
          provider: group.category,
          title: group.items[0].provider.name,
        })
        result.push(
          ...group.items.map((item) => ({ kind: "item" as const, key: modelKey(item), navKey: modelKey(item), item })),
        )
      }
    }
    return result
  })
  const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement>()
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return renderRows().length
    },
    getScrollElement: () => scrollRoot() ?? null,
    initialRect: { width: 316, height: 320 },
    estimateSize: (index) => (renderRows()[index]?.kind === "header" ? 28 : renderRows()[index]?.kind === "separator" ? 5 : 28),
    overscan: 8,
    getItemKey: (index) => renderRows()[index]?.key ?? index,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      const active = store.active
      const activeIndex = renderRows().findIndex((row) => row.kind === "item" && row.navKey === active)
      if (activeIndex < 0 || indexes.includes(activeIndex)) return indexes
      return [...indexes, activeIndex].sort((a, b) => a - b)
    },
  })
  createEffect(
    on(
      () => store.rail,
      () => setTooltipPos(null),
      { defer: true },
    ),
  )
  // TanStack may reuse VirtualItem objects when indexes stay stable. Solid's
  // <For> keys by object identity, so snapshot the row alongside each virtual
  // item to force an intentional replacement when search changes the model at
  // the same index.
  const virtualRows = createMemo(() =>
    virtualizer.getVirtualItems().map((virtualRow) => ({
      virtualRow,
      row: renderRows()[virtualRow.index],
    })),
  )
  createEffect(() => {
    if (!store.open || !store.active) return
    const active = store.active
    const index = renderRows().findIndex((row) => row.kind === "item" && row.navKey === active)
    if (index < 0 || !scrollRoot()) return
    const range = virtualizer.range
    if (range && index >= range.startIndex && index <= range.endIndex) return
    queueMicrotask(() => {
      const next = renderRows().findIndex((row) => row.kind === "item" && row.navKey === active)
      if (next >= 0) virtualizer.scrollToIndex(next, { align: "auto" })
    })
  })
  // Usage bars are presentation metadata, not navigation data. Calculate them
  // only for mounted virtual rows; the full catalog must never be scanned just
  // because the selector opened.
  const [usageReady, setUsageReady] = createSignal(false)
  onMount(() => {
    const schedule = (cb: () => void) =>
      typeof requestIdleCallback === "function" ? requestIdleCallback(cb, { timeout: 200 }) : setTimeout(cb, 0)
    schedule(() => setUsageReady(true))
  })
  const visibleUsageItems = createMemo(() =>
    virtualizer
      .getVirtualItems()
      .map((virtualRow) => renderRows()[virtualRow.index])
      .filter((row): row is Extract<SelectorRenderRow, { kind: "item" }> => row?.kind === "item")
      .map((row) => row.item),
  )
  const usageMap = createMemo(() => {
    const map = new Map<string, ReturnType<typeof usageFor>>()
    if (!usageReady() || !store.open) return map
    for (const item of visibleUsageItems()) map.set(modelKey(item), usageFor(item))
    return map
  })
  const maxRequests = createMemo(() => {
    let max = 0
    for (const item of visibleUsageItems()) {
      const requests = usageMap().get(modelKey(item))?.estimatedRequests
      if (requests !== undefined && requests > max) max = requests
    }
    return max
  })
  const navKeys = () => rows().map((row) => row.navKey)
  const initialActive = () => {
    const selected = props.current()
    const options = navKeys()
    if (selected && options.includes(selected)) return selected
    return options[0] ?? ""
  }
  const setOpen = (open: boolean) => {
    if (open) {
      if (submenuTimer !== undefined) clearTimeout(submenuTimer)
      submenuTimer = undefined
      pendingSubmenu = undefined
      cancelHoverIntent()
      dismiss.allowTriggerRestore()
      setStore({ open: true, active: initialActive(), submenu: "" })
      setTimeout(() =>
        requestAnimationFrame(() => {
          searchRef?.focus()
        }),
      )
      return
    }
    cancelHoverIntent()
    if (submenuTimer !== undefined) clearTimeout(submenuTimer)
    submenuTimer = undefined
    pendingSubmenu = undefined
    // Keep the query for the next open; the explicit clear control remains the
    // user's way to reset it. This makes repeated model switching much faster.
    setStore({ open: false, active: "", submenu: "" })
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
    const next = options[(start + delta + options.length) % options.length]
    setStore("active", next)
    queueMicrotask(() => {
      const index = renderRows().findIndex((row) => row.kind === "item" && row.navKey === next)
      const range = virtualizer.range
      if (index >= 0 && (!range || index < range.startIndex || index > range.endIndex)) {
        virtualizer.scrollToIndex(index, { align: "auto" })
      }
    })
  }
  const setSearch = (value: string) => {
    persistedModelSearch = value
    setStore("search", value)
  }

  // Wait for the search memo to settle before choosing the first result. Reading
  // models() immediately after setStore("search", ...) observes the old list
  // during Solid's event batch and leaves the UI stale until the next reopen.
  createEffect(
    on(
      () => store.search,
      () => {
        const filtered = models()
        const fav = favorites()
        const firstKey = fav[0] ? favoriteKey(fav[0]) : filtered[0] ? modelKey(filtered[0]) : manageKey
        if (store.active !== firstKey) setStore("active", firstKey)
        if (scrollRoot()) {
          virtualizer.measure()
          virtualizer.scrollToOffset(0)
        }
      },
      { defer: true },
    ),
  )

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
    const itemKey = modelKey(item)
    const current = props.current() === itemKey
    const usage = usageMap().get(itemKey)
    const price = hasPublishedPricing(item.cost) ? formatPricePerM(modelCost(item)) : "—"
    if (item.provider.id === "openrouter") {
      const cached = openRouterStore[item.id]
      return (
        <OpenRouterRow
          item={item}
          navKey={navKey}
          current={current}
          favorited={props.isFavorite(item)}
          pinned={props.subProviderGet(item)}
          usage={usage}
          maxRequests={maxRequests()}
          priceLabel={price}
          rowRef={setRowRef(navKey)}
          endpoints={cached?.endpoints}
          loading={cached?.loading ?? false}
          period={deepSeekPeriod()}
          onActivate={() => {
            activate(navKey)
          }}
          onToggleFavorite={() => props.onToggleFavorite(item)}
          submenuOpen={store.submenu === navKey}
          onSubmenuChange={(open) => setSubmenu(navKey, open, item.id)}
          onPickProvider={(tag) => {
            props.subProviderSet(item, tag)
            selectModel(item)
          }}
        />
      )
    }
    return (
      <MenuV2.Item
        ref={setRowRef(navKey)}
        data-option-key={navKey}
        data-selected-model={current ? true : undefined}
        classList={{ "!bg-v2-overlay-simple-overlay-hover": current }}
        class="scroll-my-6 w-full hover:bg-v2-overlay-simple-overlay-hover"
        onMouseEnter={() => activate(navKey)}
        onSelect={() => selectModel(item)}
      >
        <ProviderIcon id={item.provider.id} class="size-3.5 shrink-0 opacity-60" />
        <span class="min-w-0 flex-1 truncate leading-5">{stripUnlimitedSuffix(item.name)}</span>
        <DeepSeekRateBadge model={item} v2 period={deepSeekPeriod()} />
        <Show when={isUnlimitedModel(item)}>
          <TagV2 class="shrink-0">{language.t("model.tag.unlimited")}</TagV2>
        </Show>
        <Show when={isFree(item.provider.id, item.cost) || item.id.endsWith(":free") || item.id === "openrouter/free"}>
          <TagV2 class="shrink-0">{language.t("model.tag.free")}</TagV2>
        </Show>
        <Show when={freeModelRequests().get(item.id) !== undefined || freeModelRequests().get(modelKey(item)) !== undefined}>
          <span class="shrink-0 rounded-sm bg-v2-background-bg-layer-03 px-1 text-[10px] font-[520] tabular-nums text-v2-text-text-faint">
            {freeModelRequests().get(item.id) ?? freeModelRequests().get(modelKey(item))} req
          </span>
        </Show>
        <Show when={item.latest}>
          <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
        </Show>
        <ModelRowMeta
          item={item}
          usage={usage}
          maxRequests={maxRequests()}
          price={<span class="text-[10px] font-[520] leading-5">{price}</span>}
        />
        <Show when={current}>
          <Icon name="check" size="small" class="shrink-0 text-v2-text-text-accent" />
        </Show>
        <ModelFavoriteToggle favorited={props.isFavorite(item)} onToggle={() => props.onToggleFavorite(item)} />
      </MenuV2.Item>
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
          <Show when={freeUsage.data()}>
            {(report) => (
              <div class="border-b border-v2-border-border-muted p-1.5">
                <FreeUsageBar report={report()} compact />
              </div>
            )}
          </Show>
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
                  onClick={() => {
                    tooltipSuppressedFor = store.active
                    setTooltipPos(null)
                    setStore("rail", store.rail === favoritesRailKey ? "" : favoritesRailKey)
                  }}
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
                      onClick={() => {
                        tooltipSuppressedFor = store.active
                        setTooltipPos(null)
                        setStore("rail", store.rail === provider.id ? "" : provider.id)
                      }}
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
            <ScrollView
              data-slot="model-selector-scroll"
              class="min-h-0 flex-1"
              viewportRef={setScrollRoot}
            >
              <Show
                when={hasContent()}
                fallback={
                  <div class="flex h-12 items-center px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint">
                    {language.t("dialog.model.empty")}
                  </div>
                }
              >
                <div class="relative p-0.5 pt-0" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                  <For each={virtualRows()}>
                    {(entry) => {
                      const virtualRow = entry.virtualRow
                      const row = entry.row
                      if (!row) return null
                      if (row.kind === "separator") {
                        return (
                          <div
                            class="absolute inset-x-0 top-0 h-px bg-v2-border-border-muted"
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                          />
                        )
                      }
                      if (row.kind === "header") {
                        return (
                          <div
                            data-slot="menu-v2-group-label"
                            class="absolute inset-x-0 top-0 box-border flex h-7 items-center gap-2 px-3 text-[11px] font-[530] leading-none tracking-[0.05px] text-v2-text-text-faint"
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                          >
                            <Show
                              when={row.provider}
                              fallback={<Icon name="star-filled" size="small" class="shrink-0 text-v2-state-fg-warning" />}
                            >
                              <ProviderIcon id={row.provider!} class="size-3.5 shrink-0 opacity-70" />
                            </Show>
                            <span class="min-w-0 flex-1 truncate">{row.title}</span>
                            <Show when={row.provider === "opencode"}>
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
                          </div>
                        )
                      }
                      return (
                        <div
                          class="absolute inset-x-0 top-0"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          {renderRow(row.item, row.navKey)}
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </ScrollView>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col p-0.5">
            <MenuV2.Item
              data-option-key={manageKey}
              class="hover:bg-v2-overlay-simple-overlay-hover"
              onMouseEnter={() => activate(manageKey)}
              onSelect={manage}
            >
              <Icon name="outline-sliders" size="small" />
              <span class="min-w-0 flex-1 truncate leading-5">{language.t("dialog.model.manage")}</span>
            </MenuV2.Item>
          </div>
        </MenuV2.Content>
        <Show when={tooltipModel()}>
          {(item) => (
            <Show when={tooltipPos()}>
              {(position) => (
                <div
                  data-component="tooltip-v2"
                  style={{
                    position: "fixed",
                    left: `${position().x}px`,
                    top: `${position().y}px`,
                    "pointer-events": "none",
                    "z-index": 1000,
                  }}
                >
                  <ModelTooltip
                    model={item()}
                    latest={item().latest}
                    free={isFree(item().provider.id, item().cost)}
                    unlimited={isUnlimitedModel(item())}
                    usage={tooltipUsage()}
                    period={deepSeekPeriod()}
                    v2
                  />
                </div>
              )}
            </Show>
          )}
        </Show>
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
