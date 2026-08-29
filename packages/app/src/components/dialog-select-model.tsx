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
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { createModelSearchMatcher, prepareModelSearchFields } from "./dialog-select-model-search"
import { applySectionOrder } from "./dialog-select-model-order"
import { useForkUsage } from "@/context/fork-usage"
import { useWorkBuddyUsage, type WorkBuddyModelUsage } from "@/hooks/use-workbuddy-usage"
import { WorkBuddyFreeBadge } from "./workbuddy-free-badge"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import type { ForkWindowUsage } from "@/utils/fork-client"
import { useOpenRouterFreeUsage } from "@/hooks/use-openrouter-free-usage"
import type { FreeUsageReport } from "@/utils/openrouter-free-usage"
import { percent as usagePercent, colorFor } from "./usage-gauge-v2"
import { estimateRequestsRemaining, estimateRequestsRemainingFromCost, isUsageTrackedProvider } from "@/utils/model-usage-estimate"
import { getUsageTables, matchUsagePricing, matchUsageProfile, collectThresholdPricing } from "@/utils/model-usage-profile"
import { averageCostPerRequest, buildHitRateIndex, buildModelCostIndex } from "@/utils/model-usage-history"
import { deepSeekRatePeriod, isDeepSeekPeakPricedModel } from "@/utils/model-peak-pricing"
import { isUnlimitedModel, stripUnlimitedSuffix, hasPublishedPricing } from "@/utils/model-badges"
import { buildPersonalFallbackMap, buildPricingFallbackMap, sortByCheapness, isFreeModel } from "@/utils/model-cost"
import { buildStandardWorkloadCorpus, FALLBACK_WORKLOAD_CORPUS, type Workload } from "@/utils/model-usage-yield"

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]
type UsageTone = "danger" | "warning" | "success"
type ModelUsage = {
  percent: number
  estimatedRequests?: number
  personalized?: boolean
  remainingPercent?: number
  tone?: UsageTone
  /**
   * WorkBuddy-only: credits-per-request and the funding account behind the
   * estimate. Present only when the model is served by WorkBuddy, so the
   * tooltip can explain an estimate that is measured in *requests bought by
   * remaining credits* rather than dollars remaining in a time window.
   */
  workbuddy?: WorkBuddyModelUsage
}

const modelKey = (model: ModelItem) => `${model.provider.id}:${model.id}`
const manageKey = "action:manage"
let persistedModelSearch = ""

const isOpenRouterFreeModel = (item: ModelItem) =>
  item.provider.id === "openrouter" && (item.id === "openrouter/free" || item.id.endsWith(":free"))

const openRouterFreeUsageTone = (status: FreeUsageReport["free"]["status"]): UsageTone => {
  if (status === "depleted" || status === "terminal" || status === "critical") return "danger"
  if (status === "low" || status === "draining") return "warning"
  return "success"
}

// Sentinel for "let OpenRouter pick the upstream provider" — the first,
// default-selected entry of the sub-provider picker. Storing it is never
// persisted; choosing it clears the pinned preference so nothing reaches the
// request (`request.ts` additionally guards against it defensively).
const favoritesRailKey = "favorites"
const recentRailKey = "recent"

// ---------------------------------------------------------------------------
//  Cheapness V2: Usage Yield ranking (§5-6, §19, §31 of
//  cheapness-v2-usage-yield-proposal). See utils/model-usage-yield.ts for the
//  full derivation. Summary:
//  - Every PAID model is priced against the SAME standardized workload corpus
//    (16 deduped Go tuples, not its own idiosyncratic profile), via
//    priceWorkload = (I·P_I + K·P_K + O·P_O)/1M (§5.2).
//  - Primary cost is the median corpus cost (§6); Light/Typical/Heavy bands
//    (§7) are derived from context quartiles for diagnostics.
//  - Context-threshold tiers (§8: Qwen ≤/ >256K, Grok ≤/ >200K, GPT Luna ≤/ >272K)
//    select the tier the workload actually activates — not just the cheapest row.
//  - Time regimes (§9: DeepSeek Peak/Off-Peak) blend to expected yield with the
//    documented 20.83% peak fraction (35/168 weekly hours).
//  - Free taxonomy (§10, §19): quota-exempt (Unlimited) → free-limited-known →
//    free-limited-unknown → paid-by-yield. Free models never divide by zero;
//    their rank is tier-ordered (§19) and capacity is shown separately.
//  - Personal measured yield (§31): your own $/request (averageCostPerRequest
//    from buildModelCostIndex, ≥3 samples) is blended heavily — 70% personal
//    vs 30% corpus, extrapolated across *all* providers (§32-33). Your history
//    is more relevant than the generic workload, but the corpus remains a 30%
//    prior to avoid overfitting early samples.
//  - Cross-provider pricing fallback: same model id across providers is ~same
//    price (except openrouter). If a model is unpriced on one provider but
//    priced on another, borrow the sibling's published price instead of
//    sorting as unpriced/last.
//  - Cross-provider personal fallback: same model id shares your workload
//    shape. If you used claude-sonnet via anthropic but not via openrouter,
//    borrow that personal $/request (70% weight) to value the openrouter
//    variant instead of falling back to the generic corpus.
//  - Unpriced models with no sibling pricing (§25) sort last; §28 deterministic tiebreakers: yield → name → id.
// ---------------------------------------------------------------------------
const providerDisplayName = (id: string, fallback: string) => {
  if (id === "claude") return "Claude Subscription"
  if (id === "claude-api") return "Claude API Key"
  return fallback
}

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
      .filter((m) => (props.provider ? m.provider.id === props.provider : true))
      .map((m) => ({
        ...m,
        provider: { ...m.provider, name: providerDisplayName(m.provider.id, m.provider.name) },
      })),
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
              free={isFreeModel(item as never)}
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
          <Show when={isFreeModel(i as never)}>
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
function ModelStretchBar(props: { requests: number; maxRequests: number; remainingPercent?: number; tone?: UsageTone }) {
  const fraction = () => {
    if (props.remainingPercent !== undefined) return Math.max(0, Math.min(1, props.remainingPercent / 100))
    if (props.maxRequests <= 0) return 0
    const value = Math.log1p(Math.max(0, props.requests)) / Math.log1p(props.maxRequests)
    return Math.max(0, Math.min(1, value))
  }
  const color = () => colorFor(props.tone ?? stretchTone(props.requests))

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
  usage?: ModelUsage
  maxRequests: number
  price: JSX.Element
}) {
  return (
    <Show
      when={props.usage?.estimatedRequests !== undefined || props.usage?.remainingPercent !== undefined}
      fallback={<span class="shrink-0 tabular-nums text-v2-text-text-faint">{props.price}</span>}
    >
      <ModelStretchBar
        requests={props.usage?.estimatedRequests ?? 0}
        maxRequests={props.maxRequests}
        remainingPercent={props.usage?.remainingPercent}
        tone={props.usage?.tone}
      />
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
  if (provider === "claude" || provider === "claude-api") return "anthropic"
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
    estimateSize: () => 42,
    overscan: 4,
    get getItemKey() {
      const endpoints = props.endpoints
      return (index: number) => endpoints[index]?.tag ?? index
    },
    get rangeExtractor() {
      const focused = focusedIndex()
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indexes = defaultRangeExtractor(range)
        if (focused < 0 || focused >= range.count || indexes.includes(focused)) return indexes
        return [...indexes, focused].sort((a, b) => a - b)
      }
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
            const isSelected = props.pinned === entry.provider
            const isCheapest = virtualRow.index === 0
            const uptime = entry.uptime
            const cacheHit = entry.telemetry?.cacheHitPercent
            const throughput = entry.telemetry?.throughputTps
            return (
              <div
                class="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <MenuV2.Item
                  data-endpoint-index={virtualRow.index}
                  class="w-full !h-auto !min-h-[42px] !items-stretch !gap-0 !p-0 [&_[data-slot=menu-v2-item-content]]:!flex [&_[data-slot=menu-v2-item-content]]:!flex-col [&_[data-slot=menu-v2-item-content]]:!items-stretch [&_[data-slot=menu-v2-item-content]]:!gap-0 [&_[data-slot=menu-v2-item-content]]:!p-0 [&_[data-slot=menu-v2-item-content]]:!flex-1"
                  data-selected={isSelected ? true : undefined}
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
                  <div class="flex w-full flex-col justify-center gap-[2px] px-2 py-1.5">
                    <div class="flex w-full items-center gap-1.5">
                      <ProviderIcon
                        id={providerIconId(entry.provider, entry.providerName)}
                        class="size-3.5 shrink-0 opacity-70"
                      />
                      <span class="min-w-0 flex-1 truncate text-[12px] font-[450] leading-none tracking-[-0.02px] text-v2-text-text-base">{entry.providerName}</span>
                      <Show when={isCheapest}>
                        <span class="shrink-0 rounded-[3px] bg-v2-state-bg-success/10 px-1 py-0 text-[9px] font-[600] leading-3 tracking-[0.04px] text-v2-state-fg-success">{language.t("dialog.model.subprovider.best")}</span>
                      </Show>
                      <span class="shrink-0 text-[11px] font-[500] tabular-nums leading-none text-v2-text-text-muted">{price}</span>
                      <Show when={isSelected}>
                        <Icon name="check" size="small" class="size-3 shrink-0 text-v2-text-text-accent" />
                      </Show>
                    </div>
                    <div class="flex min-w-0 items-center gap-1 pl-5 text-[10px] font-[450] leading-none text-v2-text-text-faint">
                      <span class="min-w-0 truncate tabular-nums">{entry.tag}</span>
                      <Show when={uptime !== undefined}>
                        <span class="inline-flex shrink-0 items-center gap-1 tabular-nums" title={language.t("dialog.model.subprovider.uptime")}>
                          <span class="size-1 shrink-0 rounded-full" style={{ "background-color": colorFor(uptimeTone(uptime!)) }} />
                          <span style={{ color: colorFor(uptimeTone(uptime!)) }}>{uptime!.toFixed(1)}%</span>
                        </span>
                      </Show>
                      <Show when={throughput !== undefined}>
                        <span class="shrink-0 tabular-nums" title="Throughput (tokens/s)">· {throughput} tok/s</span>
                      </Show>
                      <Show when={cacheHit !== undefined}>
                        <span class="shrink-0 tabular-nums" title="Cache hit rate">· ~{cacheHit}%</span>
                      </Show>
                    </div>
                  </div>
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
  usage?: ModelUsage
  maxRequests: number
  priceLabel: string
  rowRef: (element: HTMLElement | undefined) => void
  endpoints: OpenRouterEndpoint[] | undefined
  loading: boolean
  period?: ReturnType<typeof deepSeekRatePeriod>
  hitRate?: number
  onActivate: () => void
  onDeactivate: () => void
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
        }}
        onMouseLeave={props.onDeactivate}
      >
        <ProviderIcon id={props.item.provider.id} class="size-3.5 shrink-0 opacity-60" />
        <span class="min-w-0 flex-1 truncate leading-5">{stripUnlimitedSuffix(props.item.name)}</span>
        <Show when={props.item.provider.id === "workbuddy"}>
          <WorkBuddyFreeBadge modelID={props.item.id} />
        </Show>
        <Show when={props.item.provider.id !== "workbuddy" && isFreeModel(props.item as never)}>
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
          <MenuV2.SubContent
            data-model-selector-submenu
            class="w-64 rounded-md border-0 bg-v2-background-bg-layer-01 p-1 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          >
          <div
            class="mb-1 border-b border-v2-border-border-muted px-3 pb-1.5"
            style={{ "font-size": "11px", "line-height": "12px", "font-weight": 530 }}
          >
              <ModelTooltip
                model={props.item}
                latest={props.item.latest}
                free={isFreeModel(props.item as never)}
                unlimited={isUnlimitedModel(props.item)}
                usage={props.usage}
                period={props.period}
                hitRate={props.hitRate}
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
  placement?: ComponentProps<typeof MenuV2>["placement"]
  onClose?: () => void
}) {
  const dialog = useDialog()
  const layout = useLayout()
  let local: ReturnType<typeof useLocal> | undefined
  try {
    local = useLocal()
  } catch {
    local = undefined
  }
  const directory = () => (local ? decode64(local.slug()) : undefined)
  // Lift open state so the controller's heavy memos (message scans, yield sorts)
  // are gated while the popover is closed — otherwise every `message.updated`
  // token during streaming re-sorts the full catalog idle.
  const [isOpen, setIsOpen] = createSignal(false)
  const controller = createModelSelectorController({
    model: props.model,
    provider: () => props.provider,
    onSelect: () => props.onClose?.(),
    open: isOpen,
  })

  const handleCompare = () => {
    layout.models.toggle()
  }

  return (
    <ModelSelectorPopoverV2View
      trigger={props.trigger}
      placement={props.placement}
      models={controller.models}
      groups={controller.groups}
      favorites={controller.favorites}
      recents={controller.recents}
      isFavorite={controller.isFavorite}
      onToggleFavorite={controller.toggleFavorite}
      current={controller.current}
      select={controller.select}
      subProviderGet={controller.subProviderGet}
      subProviderSet={controller.subProviderSet}
      onExternalOpenChange={setIsOpen}
      onCompare={handleCompare}
      onManage={() => {
        void import("./dialog-manage-models").then((module) => {
          void dialog.show(() => <module.DialogManageModelsV2 />)
        })
      }}
      onManageCredentials={() => {
        const dir = directory()
        if (!dir) return
        void import("./dialog-credential-switcher").then((module) => {
          void dialog.show(() => <module.DialogCredentialSwitcherV2 directory={() => dir} />)
        })
      }}
      onClose={() => props.onClose?.()}
      model={props.model}
    />
  )
}

function createModelSelectorController(input: {
  provider: () => string | undefined
  model?: ModelState
  onSelect: () => void
  open?: () => boolean
}) {
  const model = input.model ?? useLocal().model
  // Personal measured $/request is more relevant than the generic corpus
  // (§31). Build the per-model personal index once per sync-change and blend
  // it heavily (70%) with the standardized corpus when ranking.
  let sync: ReturnType<typeof useSync> | undefined
  try {
    sync = useSync()
  } catch {
    sync = undefined
  }
  const isOpen = () => input.open?.() ?? true
  const personalCosts = createMemo(() => {
    if (!isOpen()) return undefined
    if (!sync) return undefined
    const idx = buildModelCostIndex(sync().data.message)
    if (idx.size === 0) return undefined
    const map = new Map<string, { cost: number; count: number }>()
    for (const [k, entry] of idx.entries()) {
      map.set(k, { cost: entry.sum / entry.count, count: entry.count })
    }
    return map.size > 0 ? map : undefined
  })
  // §21.4, §28: the ranking corpus upgrades from the pinned fallback to the
  // live Go workload when the tables fetch succeeds — deterministic either way.
  // Gated on open: avoid fetching+parsing while the picker is closed and idle.
  const [tables] = createResource(
    () => (isOpen() ? true : undefined),
    () => getUsageTables(),
  )
  const bands = createMemo(() => {
    if (!isOpen()) return undefined
    const p = tables.latest?.profile
    if (!p || p.length === 0) return undefined
    return buildStandardWorkloadCorpus(p.map((e) => e.profile))
  })
  const thresholdMap = createMemo(() => {
    if (!isOpen()) return undefined
    const pricing = tables.latest?.pricing
    if (!pricing || pricing.length === 0) return undefined
    // Build threshold-tier map for Qwen/Grok/GPT-Luna style dual rows (§8).
    // Use the full model list (not just visible/filtered) so that a model
    // hidden via visibility still contributes its threshold tiers for fallback.
    const map = new Map<string, Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: { input: number; output: number; cache: { read: number; write: number } } }>>()
    const raw = model.list()
    for (const item of raw) {
      const tp = collectThresholdPricing(pricing, { name: item.name, family: (item as unknown as { family?: string }).family, id: item.id })
      if (tp) map.set(modelKey(item as ModelItem), tp as never)
    }
    return map.size > 0 ? map : undefined
  })

  const unsorted = createMemo(() =>
    model
      .list()
      .filter((item) => model.visible({ modelID: item.id, providerID: item.provider.id }))
      .filter((item) => (input.provider() ? item.provider.id === input.provider() : true))
      .map((item) => ({
        ...item,
        provider: { ...item.provider, name: providerDisplayName(item.provider.id, item.provider.name) },
      })),
  )
  // Pricing fallback: same model id across providers is ~same price (except
  // openrouter). If a model is unpriced on one provider, borrow a sibling's
  // published price instead of sorting it as unpriced/last. Build from the
  // full catalog (not just visible/filtered) so that a hidden sibling can
  // still donate its pricing.
  const pricingFallback = createMemo(() => {
    if (!isOpen()) return undefined
    const list = model.list()
    if (list.length === 0) return undefined
    const map = buildPricingFallbackMap(list as never)
    return map.size > 0 ? map : undefined
  })
  // Personal fallback: same model across providers shares your workload shape.
  // If you used claude-sonnet via anthropic (personal data exists) but not via
  // openrouter, borrow that personal $/request to value the openrouter variant
  // instead of falling back to the generic corpus.
  const personalFallback = createMemo(() => {
    if (!isOpen()) return undefined
    const p = personalCosts()
    if (!p) return undefined
    const map = buildPersonalFallbackMap(p)
    return map.size > 0 ? map : undefined
  })
  // Hit rate: personal cache hit rate per provider:model, with cross-provider
  // fallback by model id. When available (≥3 samples), the workload's prompt
  // is re-split as K'=T*h, I'=T*(1-h) so a provider/model that actually hits
  // cache 80% of the time is correctly seen as cheaper than one that hits 20%.
  const hitRates = createMemo(() => {
    if (!isOpen()) return undefined
    if (!sync) return undefined
    const idx = buildHitRateIndex(sync().data.message)
    if (idx.size === 0) return undefined
    const map = new Map<string, number>()
    for (const [k, entry] of idx.entries()) {
      const denom = entry.input + entry.cacheRead
      if (denom <= 0) continue
      if (entry.count < 3) continue
      map.set(k, entry.cacheRead / denom)
    }
    return map.size > 0 ? map : undefined
  })
  const hitRateFallback = createMemo(() => {
    if (!isOpen()) return undefined
    const h = hitRates()
    if (!h) return undefined
    const byModel = new Map<string, { sum: number; count: number }>()
    for (const [key, hr] of h.entries()) {
      const sep = key.indexOf(":")
      const modelId = sep >= 0 ? key.slice(sep + 1) : key
      const agg = byModel.get(modelId)
      if (!agg) byModel.set(modelId, { sum: hr, count: 1 })
      else {
        agg.sum += hr
        agg.count++
      }
    }
    const out = new Map<string, number>()
    for (const [modelId, agg] of byModel.entries()) out.set(modelId, agg.sum / agg.count)
    return out.size > 0 ? out : undefined
  })
  let openOrder: string[] | undefined
  const allModels = createMemo(() => {
    const list = [...unsorted()]
    if (!isOpen()) {
      openOrder = undefined
      // Closed picker: avoid Usage Yield ranking entirely. The trigger only
      // needs the current model name, not a globally sorted catalog. Returning
      // a cheap alphabetical order isolates the composer from message-store
      // churn (every `message.updated` token) and from the O(n log n) yield
      // comparator. Full ranking is computed once on open.
      return list.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    }
    const b = bands()
    const tmap = thresholdMap()
    const pCosts = personalCosts()
    const pFallback = personalFallback()
    const priceFallback = pricingFallback()
    const hr = hitRates()
    const hrFallback = hitRateFallback()
    const corpus = b?.corpus
    // Delegates to Usage Yield V2 (§5-6) blended heavily with personal
    // measured $/request (§31): personal 70% vs corpus 30% when available,
    // plus cross-provider pricing/usage/hit-rate fallbacks so that a model
    // missing data on one provider borrows from a sibling provider offering
    // the same model. Hit rate re-splits the prompt (K'=T*h) when available.
    // Falls back to workload-normalized fallback corpus (§5.1 pinned 16-tuple)
    // so sorting stays synchronous and deterministic even before fetch (§28).
    // Use bulk O(n) scoring: one median per model, not one per compare.
    const sorted = sortByCheapness(list as never, corpus, tmap as never, pCosts as never, priceFallback as never, pFallback as never, hr as never, hrFallback as never) as unknown as typeof list
    if (!openOrder) {
      openOrder = sorted.map(modelKey)
      return sorted
    }
    const rank = new Map(openOrder.map((key, index) => [key, index]))
    return sorted.sort(
      (a, b) => (rank.get(modelKey(a)) ?? Number.POSITIVE_INFINITY) - (rank.get(modelKey(b)) ?? Number.POSITIVE_INFINITY),
    )
  })
  const searchableFields = createMemo(() => {
    return new Map(
      allModels().map((item) => [item, prepareModelSearchFields([item.name, item.id, item.provider.name])] as const),
    )
  })

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
      return allModels().filter((item) => {
        const prepared = fields.get(item)
        return prepared ? matches(prepared) : false
      })
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
    recents: (models: ModelItem[]) => {
      const byKey = new Map(models.map((item) => [modelKey(item), item] as const))
      const ordered: ModelItem[] = []
      const recentItems = model.recent() ?? []
      for (const entry of recentItems) {
        if (!entry) continue
        const k = modelKey(entry)
        const item = byKey.get(k)
        if (!item) continue
        if (model.favorite.isFavorite(key(item))) continue
        ordered.push(item)
      }
      return ordered
    },
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
  placement?: ComponentProps<typeof MenuV2>["placement"]
  models: (search: string) => ModelItem[]
  groups: (models: ModelItem[]) => { category: string; items: ModelItem[] }[]
  favorites: (models: ModelItem[]) => ModelItem[]
  recents: (models: ModelItem[]) => ModelItem[]
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
  model?: ModelState
  onExternalOpenChange?: (open: boolean) => void
}) {
  const language = useLanguage()
  let local: ReturnType<typeof useLocal> | undefined
  try {
    local = useLocal()
  } catch {
    local = undefined
  }
  const modelState = () => props.model ?? local?.model
  const railOrder = () => modelState()?.order?.get("rail") ?? []
  const applyRailOrder = (items: { id: string; name: string }[]): { id: string; name: string }[] => {
    return applySectionOrder(items, railOrder(), (item) => item.id)
  }
  const persistRailOrder = (ids: string[]) => {
    modelState()?.order?.set("rail", ids)
  }
  const forkUsage = useForkUsage()
  const sync = useSync()
  // WorkBuddy bills credits-per-request across several independent accounts, so
  // its stretch estimate cannot ride the OpenCode-Go USD-window path. This is a
  // pure projection of the quota result `useLimits` already polls — no extra
  // network traffic.
  const workbuddy = useWorkBuddyUsage()
  const [store, setStore] = createStore({ open: false, search: persistedModelSearch, active: "", tooltip: "", rail: "", submenu: "" })
  const [tables] = createResource(
    () => (store.open ? true : undefined),
    () => getUsageTables(),
  )
  const profileTable = () => tables.latest?.profile ?? []
  const pricingTable = () => tables.latest?.pricing ?? []
  const sdk = useSDK()
  const freeUsage = useOpenRouterFreeUsage()
  // Pricing fallback for display: same model id across providers is ~same cost
  // (except openrouter). Build from the full catalog so that an unpriced
  // variant can show a borrowed sibling price instead of "—".
  const pricingFallbackForDisplay = createMemo(() => {
    if (!store.open) return undefined
    let list: ModelItem[] = []
    try {
      const maybe = local?.model.list() ?? []
      if (maybe.length > 0) list = maybe as ModelItem[]
    } catch {}
    if (list.length === 0) {
      try {
        list = props.models("") as ModelItem[]
      } catch {}
    }
    if (list.length === 0) return undefined
    const map = buildPricingFallbackMap(list as never)
    return map.size > 0 ? map : undefined
  })
  // Hit rate maps: personal (own aggregate) heavily weighted, plus openrouter telemetry.
  // Personal is built from sync messages; openrouter is built from openRouterStore endpoints.
  // Both are per provider:model and also aggregated by model id for cross-provider fallback.
  // Gated on store.open: scanning 20k messages for hit rates is wasted while closed.
  const personalHitRates = createMemo(() => {
    if (!store.open) return undefined
    const idx = buildHitRateIndex(sync().data.message)
    if (idx.size === 0) return undefined
    const map = new Map<string, number>()
    for (const [k, entry] of idx.entries()) {
      const denom = entry.input + entry.cacheRead
      if (denom <= 0) continue
      if (entry.count < 3) continue
      map.set(k, entry.cacheRead / denom)
    }
    return map.size > 0 ? map : undefined
  })
  const personalHitRateFallback = createMemo(() => {
    if (!store.open) return undefined
    const m = personalHitRates()
    if (!m) return undefined
    const byModel = new Map<string, { sum: number; count: number }>()
    for (const [key, hr] of m.entries()) {
      const modelId = key.slice(key.indexOf(":") + 1)
      const agg = byModel.get(modelId)
      if (!agg) byModel.set(modelId, { sum: hr, count: 1 })
      else {
        agg.sum += hr
        agg.count++
      }
    }
    const out = new Map<string, number>()
    for (const [modelId, agg] of byModel.entries()) out.set(modelId, agg.sum / agg.count)
    return out.size > 0 ? out : undefined
  })
  const [openRouterStore, setOpenRouterStore] = createStore<
    Record<string, { loading: boolean; endpoints: OpenRouterEndpoint[] | undefined }>
  >({})
  const openRouterHitRates = createMemo(() => {
    if (!store.open) return undefined
    const map = new Map<string, number>()
    for (const [modelId, entry] of Object.entries(openRouterStore as Record<string, { endpoints?: OpenRouterEndpoint[] }>)) {
      const eps = (entry as { endpoints?: OpenRouterEndpoint[] })?.endpoints
      if (!eps || eps.length === 0) continue
      let sum = 0
      let cnt = 0
      for (const ep of eps) {
        const h = ep.telemetry?.cacheHitPercent
        if (h === undefined || !Number.isFinite(h)) continue
        sum += h > 1 ? h / 100 : h
        cnt++
      }
      if (cnt > 0) map.set(`openrouter:${modelId}`, sum / cnt)
    }
    return map.size > 0 ? map : undefined
  })
  const openRouterHitRateFallback = createMemo(() => {
    if (!store.open) return undefined
    const m = openRouterHitRates()
    if (!m) return undefined
    const out = new Map<string, number>()
    for (const [key, hr] of m.entries()) {
      const modelId = key.slice(key.indexOf(":") + 1)
      out.set(modelId, hr)
    }
    return out.size > 0 ? out : undefined
  })
  const combinedHitRates = createMemo(() => {
    if (!store.open) return undefined
    const personal = personalHitRates()
    const openRouter = openRouterHitRates()
    if (!personal && !openRouter) return undefined
    const combined = new Map<string, number>()
    if (personal) for (const [k, v] of personal.entries()) combined.set(k, v)
    if (openRouter) for (const [k, v] of openRouter.entries()) if (!combined.has(k)) combined.set(k, v)
    return combined
  })
  const combinedHitRateFallback = createMemo(() => {
    if (!store.open) return undefined
    const personalFb = personalHitRateFallback()
    const openRouterFb = openRouterHitRateFallback()
    if (!personalFb && !openRouterFb) return undefined
    const combined = new Map<string, number>()
    if (personalFb) for (const [k, v] of personalFb.entries()) combined.set(k, v)
    if (openRouterFb) for (const [k, v] of openRouterFb.entries()) if (!combined.has(k)) combined.set(k, v)
    return combined
  })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  let railListRef: HTMLDivElement | undefined
  const dismiss = createMenuDismissController(() => contentRef)
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let focusFrame = 0
  let disposed = false

  // Centralized DeepSeek period: one timer for the whole selector, not one per row.
  const deepSeekNow = createPolled(() => new Date(), 60_000)
  const deepSeekPeriod = createMemo(() => deepSeekRatePeriod(deepSeekNow()))

  // Centralized OpenRouter endpoint cache: one store + ring prefetcher instead of
  // per-row signals + per-hover fetches that each hit localStorage + network.
  // V2 Usage Yield helpers for endpoint sorting (§5-6, corpus §5.1, median §6).
  // Same standardized workload used for model ranking so endpoint order is
  // yield-consistent with the model selector (§32). Corpus upgrades to live
  // when Go profiles have been fetched; otherwise the pinned 16-tuple fallback.
  const getEndpointCorpus = (): Workload[] => {
    const live = tables.latest?.profile ?? []
    if (live.length > 0) {
      try {
        const bands = buildStandardWorkloadCorpus(live.map((entry) => entry.profile))
        if (bands.corpus.length > 0) return bands.corpus
      } catch {}
    }
    return [...FALLBACK_WORKLOAD_CORPUS] as Workload[]
  }
  const medianCost = (values: number[]): number => {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }
  // §5.2 tokenCost with cache-hit blending. When telemetry provides hit rate,
  // the missed portion of cachedReadTokens is priced at prompt (cache miss → fresh input).
  // effectiveCache = hit*cacheRead + (1-hit)*prompt. Undefined hit → assume 1 (no penalty for unknown).
  const endpointMedianCost = (endpoint: OpenRouterEndpoint, corpus: Workload[]): number => {
    const hit = endpoint.telemetry?.cacheHitPercent !== undefined ? endpoint.telemetry.cacheHitPercent / 100 : 1
    const effectiveCacheRead = Number.isFinite(hit) ? endpoint.pricing.cacheRead * hit + endpoint.pricing.prompt * (1 - hit) : endpoint.pricing.cacheRead
    const costs = corpus.map((workload) => (workload.freshInputTokens * endpoint.pricing.prompt + workload.cachedReadTokens * effectiveCacheRead + workload.outputTokens * endpoint.pricing.completion) / 1_000_000)
    return medianCost(costs)
  }
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
    // Cheapest → most expensive via V2 Usage Yield (§5-6): median cost across
    // the same standardized workload corpus used for model ranking. Every
    // paid upstream is priced against the SAME 16 workloads (deduped Go profiles,
    // §5.1), median of per-workload costs is the comparison (§6). This replaces
    // ad-hoc 800/65k/220 weighting with corpus-true economics.
    const corpus = getEndpointCorpus()
    endpoints.sort((a, b) => {
      const costA = endpointMedianCost(a as OpenRouterEndpoint, corpus)
      const costB = endpointMedianCost(b as OpenRouterEndpoint, corpus)
      if (costA !== costB) return costA - costB
      const uA = a.uptime ?? 0
      const uB = b.uptime ?? 0
      if (uA !== uB) return uB - uA
      return a.providerName.localeCompare(b.providerName)
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
      const enriched = endpoints.map((entry) => {
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
      // Re-sort with cache-hit blended yield (§5.2 + cache-miss as prompt). A
      // low hit rate materially raises effective cost (missed cache → prompt),
      // so a superficially cheap cacheRead with 60% hit can sort behind a
      // slightly pricier but 95% hit provider — exactly the correction V2 wants
      // when hit data is available. Falls back to hit=1 for unknowns (no penalty).
      const corpus = getEndpointCorpus()
      enriched.sort((a, b) => {
        const costA = endpointMedianCost(a, corpus)
        const costB = endpointMedianCost(b, corpus)
        if (costA !== costB) return costA - costB
        const uA = a.uptime ?? 0
        const uB = b.uptime ?? 0
        if (uA !== uB) return uB - uA
        return a.providerName.localeCompare(b.providerName)
      })
      return enriched
    } catch (error) {
      // Silent best-effort — log for diagnostics, do not toast (would spam for ~ models).
      console.warn("[openrouter-telemetry] best-effort fetch failed", { model, error: String(error) })
      return endpoints
    }
  }
  const ensureOpenRouter = (modelID: string) => {
    const existing = openRouterStore[modelID]
    if (existing?.loading || existing?.endpoints !== undefined) return
    setOpenRouterStore(modelID, { loading: true, endpoints: undefined })
    void getOpenRouterEndpoints(modelID, fetchOpenRouterEndpoints).then(async (result) => {
      const endpoints = result ? await addOpenRouterTelemetry(modelID, result) : result
      if (!disposed) setOpenRouterStore(modelID, { loading: false, endpoints })
      // Prune a stale pinned upstream provider that would brick the model.
      // OpenRouter returns 404 "No allowed providers are available" when
      // `provider.only` contains a provider that no longer serves the model
      // (e.g. tencent for xiaomi/mimo-v2.5-20260422). The pin is persisted per
      // model, so we clear it automatically when we discover it's invalid.
      if (endpoints && local?.model) {
        const key = { providerID: "openrouter", modelID }
        const pinned = local.model.subProvider.get(key)
        if (pinned && !endpoints.some((entry) => entry.provider === pinned)) {
          local.model.subProvider.set(key, undefined)
        }
      }
    })
  }

  // Hover is intentionally treated as an intent, not an immediate state change.
  // Scanning across rows should stay entirely CSS-only; only a row that remains
  // hovered long enough gets a tooltip/submenu and the associated reactive work.
  const TOOLTIP_INTENT_DELAY = 64
  let hoverRaf = 0
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  let pendingActive: string | null = null
  const flushPendingActive = () => {
    hoverRaf = 0
    const next = pendingActive
    pendingActive = null
    if (next !== null) {
      if (store.active !== next) setStore("active", next)
      setStore("tooltip", next)
    }
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
      if (store.submenu === navKey) setStore("submenu", "")
      return
    }
    setStore("submenu", navKey)
    ensureOpenRouter(modelID)
  }
  const activate = (navKey: string) => {
    if (store.submenu && store.submenu !== navKey) setStore("submenu", "")
    if (store.tooltip === navKey) {
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
  const deactivate = (navKey: string) => {
    if (pendingActive === navKey) cancelHoverIntent()
    if (store.tooltip === navKey) setStore("tooltip", "")
  }
  onCleanup(() => {
    disposed = true
    cancelHoverIntent()
    if (focusTimer !== undefined) clearTimeout(focusTimer)
    if (focusFrame) cancelAnimationFrame(focusFrame)
  })

  // The controller owns catalog ranking. OpenRouter telemetry arrives one
  // prefetched model at a time; using that live cache here reordered the list
  // after every response and moved virtual rows underneath the pointer.
  const models = createMemo(() => props.models(store.search))
  // The provider rail is derived from the full (search-filtered) model list so
  // it never collapses when one provider is selected — filtering happens below.
  const railProviders = createMemo(() => {
    const seen = new Map<string, string>()
    for (const item of models()) {
      if (!seen.has(item.provider.id)) seen.set(item.provider.id, item.provider.name)
    }
    const base = Array.from(seen, ([id, name]) => ({ id, name }))
    return applyRailOrder(base)
  })
  const railModels = createMemo(() => {
    if (store.rail === "" || store.rail === favoritesRailKey || store.rail === recentRailKey) return models()
    return models().filter((item) => item.provider.id === store.rail)
  })
  const groups = createMemo(() => props.groups(railModels()))
  const favorites = createMemo(() => props.favorites(models()))
  const recents = createMemo(() => props.recents(models()))
  const showFavorites = () =>
    favorites().length > 0 && (store.rail === "" || store.rail === favoritesRailKey)
  const showRecents = () =>
    recents().length > 0 && (store.rail === "" || store.rail === recentRailKey)
  const showProviderGroups = () => store.rail !== favoritesRailKey && store.rail !== recentRailKey
  const hasContent = () => {
    if (store.rail === favoritesRailKey) return favorites().length > 0
    if (store.rail === recentRailKey) return recents().length > 0
    return railModels().length > 0
  }
  const favoriteKey = (item: ModelItem) => `fav:${modelKey(item)}`
  const recentKey = (item: ModelItem) => `recent:${modelKey(item)}`

  // O(1) lookups for hover: avoid linear `models().find` per hover and
  // `querySelector` DOM scans (forced layout). Refs are populated as rows mount.
  const rowRefs = new Map<string, HTMLElement>()
  const rowRefCallbacks = new Map<string, (element: HTMLElement | undefined) => void>()
  const setRowRef = (key: string) => {
    const existing = rowRefCallbacks.get(key)
    if (existing) return existing
    let current: HTMLElement | undefined
    const callback = (next: HTMLElement | undefined) => {
      if (next) {
        current = next
        rowRefs.set(key, next)
        return
      }
      if (current && rowRefs.get(key) === current) rowRefs.delete(key)
      current = undefined
    }
    rowRefCallbacks.set(key, callback)
    return callback
  }
  onCleanup(() => {
    rowRefs.clear()
    rowRefCallbacks.clear()
  })
  const modelByKey = createMemo(() => {
    const map = new Map<string, ModelItem>()
    for (const item of models()) {
      map.set(modelKey(item), item)
      map.set(`fav:${modelKey(item)}`, item)
      map.set(`recent:${modelKey(item)}`, item)
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
  // Gated on open: the usage bars are only visible while the picker is open.
  const costIndex = createMemo(() => {
    if (!store.open) return new Map() as ReturnType<typeof buildModelCostIndex>
    return buildModelCostIndex(sync().data.message)
  })
  const usageFor = (item: ModelItem) => {
    // WorkBuddy: credits-per-request funded by one account's remaining balance.
    // Checked first because these models carry no USD cost at all, so the
    // token-priced path below would render "—" and no bar.
    if (item.provider.id === "workbuddy") {
      // Pass the full (possibly account-qualified) id: `hy4-preview@wb-<id>`
      // must be funded by that account, not by the best account overall.
      const estimate = workbuddy.forModel(item.id)
      if (!estimate) return undefined
      const account = workbuddy.accounts().find((entry) => entry.id === estimate.account || entry.account === estimate.account)
      return {
        percent: 100 - estimate.remainingPercent,
        estimatedRequests: estimate.estimatedRequests,
        remainingPercent: estimate.remainingPercent,
        tone: stretchTone(estimate.estimatedRequests) as UsageTone,
        workbuddy: {
          ...estimate,
          ...(account ? { totalCredits: account.totalCredits } : {}),
        } as WorkBuddyModelUsage,
      }
    }
    if (isOpenRouterFreeModel(item)) {
      const report = freeUsage.data()
      if (!report) return undefined
      return {
        percent: report.free.usedPercent,
        remainingPercent: report.free.remainingPercent,
        tone: openRouterFreeUsageTone(report.free.status),
      }
    }
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
  // Shared tooltip: single floating card driven by active row, instead of N
  // Kobalte Tooltip instances each with MutationObserver + floating-ui overhead
  // and openDelay=0 mount on every hover. This cuts ~50 Tooltip managers to 1.
  const [tooltipPos, setTooltipPos] = createSignal<{ x: number; y: number } | null>(null)
  let tooltipPositionFrame = 0
  let tooltipEl: HTMLDivElement | undefined
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
    const active = store.tooltip
    if (!active || active === manageKey) return undefined
    const candidate =
      modelByKey().get(active) ??
      modelByKey().get(
        active.startsWith("fav:")
          ? active.slice(4)
          : active.startsWith("recent:")
            ? active.slice(7)
            : active,
      )
    if (!candidate || candidate.provider.id === "openrouter") return undefined
    if (store.rail !== "" && store.rail !== favoritesRailKey && store.rail !== recentRailKey && candidate.provider.id !== store.rail)
      return undefined
    if (store.rail === favoritesRailKey && !props.isFavorite(candidate)) return undefined
    if (store.rail === recentRailKey && !recents().some((item) => modelKey(item) === modelKey(candidate))) return undefined
    if (!store.open) return undefined
    return candidate
  })
  const tooltipUsage = createMemo(() => {
    const item = tooltipModel()
    return item ? usageMap().get(modelKey(item)) : undefined
  })
  const tooltipHitRate = createMemo(() => {
    const item = tooltipModel()
    if (!item) return undefined
    const key = modelKey(item)
    const direct = combinedHitRates()?.get(key)
    if (direct !== undefined) return direct
    const fb = combinedHitRateFallback()?.get(item.id)
    return fb
  })
  const updateTooltipPosition = () => {
    const active = store.tooltip
    if (tooltipSuppressedFor === active) {
      setTooltipPosition(null)
      return
    }
    const item = tooltipModel()
    if (!item) {
      setTooltipPosition(null)
      return
    }
    const element = rowRefs.get(active)
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
    const MARGIN = 15
    // Measure the tooltip container if it exists; fall back to estimates.
    let measuredWidth = 236
    let measuredHeight = 280
    if (tooltipEl) {
      const tooltipRect = tooltipEl.getBoundingClientRect()
      measuredWidth = Math.round(tooltipRect.width) || 236
      measuredHeight = Math.round(tooltipRect.height) || 280
    }
    const width = measuredWidth
    const height = measuredHeight
    let x = rect.right + 6
    let y = rect.top
    // Clamp horizontally: flip to left if it would overflow right, then enforce margin
    if (x + width > window.innerWidth - MARGIN) x = rect.left - width - 6
    if (x < MARGIN) x = MARGIN
    // Clamp vertically: push up if it would overflow bottom, then enforce margin
    if (y + height > window.innerHeight - MARGIN) y = Math.max(MARGIN, window.innerHeight - height - MARGIN)
    if (y < MARGIN) y = MARGIN
    setTooltipPosition({ x, y })
  }
  createEffect(() => {
    void tooltipModel()
    void store.open
    void scrollRoot()
    if (tooltipSuppressedFor !== store.tooltip) tooltipSuppressedFor = undefined
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
      if (tooltipSuppressedFor === store.tooltip) return
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

  const renderRows = createMemo<SelectorRenderRow[]>(() => {
    const result: SelectorRenderRow[] = []
    if (showFavorites()) {
      result.push({ kind: "header", key: "header:favorites", title: language.t("dialog.model.favorites") })
      result.push(...favorites().map((item) => ({ kind: "item" as const, key: favoriteKey(item), navKey: favoriteKey(item), item })))
      result.push({ kind: "separator", key: "separator:favorites" })
    }
    if (showRecents()) {
      result.push({ kind: "header", key: "header:recent", title: language.t("dialog.model.recent") })
      result.push(...recents().map((item) => ({ kind: "item" as const, key: recentKey(item), navKey: recentKey(item), item })))
      result.push({ kind: "separator", key: "separator:recent" })
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
  const rows = createMemo<NavRow[]>(() => [
    ...renderRows().flatMap((row) => (row.kind === "item" ? [{ navKey: row.navKey, item: row.item }] : [])),
    { navKey: manageKey },
  ])
  const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement>()
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return renderRows().length
    },
    getScrollElement: () => scrollRoot() ?? null,
    initialRect: { width: 316, height: 320 },
    get estimateSize() {
      const snapshot = renderRows()
      return (index: number) => (snapshot[index]?.kind === "header" ? 28 : snapshot[index]?.kind === "separator" ? 5 : 28)
    },
    overscan: 8,
    get getItemKey() {
      const snapshot = renderRows()
      return (index: number) => snapshot[index]?.key ?? index
    },
    get rangeExtractor() {
      const snapshot = renderRows()
      const active = store.active
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indexes = defaultRangeExtractor(range)
        const activeIndex = snapshot.findIndex((row) => row.kind === "item" && row.navKey === active)
        if (activeIndex < 0 || indexes.includes(activeIndex)) return indexes
        return [...indexes, activeIndex].sort((a, b) => a - b)
      }
    },
  })
  // Solid's <For> keys by object identity. Preserve snapshots for unchanged
  // rows so an active-row hover does not remount the visible virtual window;
  // replace only rows whose identity or measured position actually changed.
  const virtualRows = createMemo<
    { virtualRow: ReturnType<typeof virtualizer.getVirtualItems>[number]; row: SelectorRenderRow | undefined }[]
  >((previous = []) => {
    const prior = new Map(previous.flatMap((entry) => (entry.row ? [[entry.row.key, entry] as const] : [])))
    return virtualizer.getVirtualItems().map((virtualRow) => {
      const row = renderRows()[virtualRow.index]
      const existing = prior.get(row?.key)
      if (
        existing &&
        existing.row === row &&
        existing.virtualRow.index === virtualRow.index &&
        existing.virtualRow.start === virtualRow.start &&
        existing.virtualRow.size === virtualRow.size
      ) {
        return existing
      }
      return { virtualRow, row }
    })
  })
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
    let idleHandle: number | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (typeof requestIdleCallback === "function") {
      idleHandle = requestIdleCallback(() => setUsageReady(true), { timeout: 200 })
    } else {
      timeoutHandle = setTimeout(() => setUsageReady(true), 0)
    }
    onCleanup(() => {
      if (idleHandle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idleHandle)
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    })
  })
  const visibleUsageItems = createMemo(() =>
    virtualizer
      .getVirtualItems()
      .filter((virtualRow) => {
        const range = virtualizer.range
        return !range || (virtualRow.index >= range.startIndex && virtualRow.index <= range.endIndex)
      })
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
  createEffect(
    on(
      () => store.rail,
      () => {
        cancelHoverIntent()
        setStore({ active: navKeys()[0] ?? manageKey, tooltip: "", submenu: "" })
        setTooltipPos(null)
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
    const options = navKeys()
    if (options.includes(store.active)) return
    setStore({ active: options[0] ?? manageKey, tooltip: "", submenu: "" })
  })
  const initialActive = () => {
    const selected = props.current()
    const options = navKeys()
    if (selected && options.includes(selected)) return selected
    return options[0] ?? ""
  }
  const setOpen = (open: boolean) => {
    if (open === store.open) return
    if (open) {
      cancelHoverIntent()
      dismiss.allowTriggerRestore()
      setStore({ open: true, active: initialActive(), tooltip: "", submenu: "" })
      props.onExternalOpenChange?.(true)
      focusTimer = setTimeout(() => {
        focusTimer = undefined
        focusFrame = requestAnimationFrame(() => {
          focusFrame = 0
          if (store.open && searchRef?.isConnected) searchRef.focus()
        })
      })
      return
    }
    cancelHoverIntent()
    if (focusTimer !== undefined) clearTimeout(focusTimer)
    focusTimer = undefined
    if (focusFrame) cancelAnimationFrame(focusFrame)
    focusFrame = 0
    // Keep the query for the next open; the explicit clear control remains the
    // user's way to reset it. This makes repeated model switching much faster.
    setStore({ open: false, active: "", tooltip: "", submenu: "" })
    props.onExternalOpenChange?.(false)
  }
  let closeAction: (() => void) | undefined
  let closeGeneration = 0
  onCleanup(() => {
    closeGeneration++
    closeAction = undefined
  })
  const closeWith = (action: () => void) => {
    if (!store.open) return
    const generation = ++closeGeneration
    closeAction = action
    setOpen(false)
    const valid = () => generation === closeGeneration && !store.open
    dismiss.afterClose(() => {
      const callback = closeAction
      closeAction = undefined
      callback?.()
    }, valid)
  }
  const onOpenChange = (open: boolean) => {
    if (open) {
      closeGeneration++
      closeAction = undefined
      setOpen(true)
      return
    }
    if (!store.open) return
    closeWith(props.onClose)
  }
  const selectModel = (item: ModelItem) => {
    dismiss.preventTriggerRestore()
    closeWith(() => props.select(item))
  }
  const manage = () => {
    dismiss.preventTriggerRestore()
    closeWith(() => {
      props.onClose()
      props.onManage()
    })
  }
  const compare = () => {
    dismiss.preventTriggerRestore()
    closeWith(() => {
      props.onClose()
      props.onCompare()
    })
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
    cancelHoverIntent()
    setStore({ tooltip: "", submenu: "" })
    const options = navKeys()
    if (options.length === 0) return
    const index = options.indexOf(store.active)
    const next =
      index === -1
        ? options[delta > 0 ? 0 : options.length - 1]
        : options[(index + delta + options.length) % options.length]
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
    cancelHoverIntent()
    setStore({ tooltip: "", submenu: "" })
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
        const firstKey = navKeys()[0] ?? manageKey
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
      (event: KeyboardEvent) => {
        if (
          store.submenu &&
          event.target instanceof Element &&
          event.target.closest("[data-model-selector-submenu]")
        ) {
          return
        }
        handleDocumentSearchKeydown(searchRef, event, store.search, setSearch)
      },
      true,
    )
  })

  const renderRow = (item: ModelItem, navKey: string) => {
    const itemKey = modelKey(item)
    const current = () => props.current() === itemKey
    const usage = () => usageMap().get(itemKey)
    // Cross-provider pricing fallback for display: if this provider's variant
    // is unpriced but a sibling provider offers the same model id with pricing,
    // show the borrowed price (with "~" to hint it's sibling-derived) instead
    // of "—" so the user sees why it's sorted where it is. Sorting already
    // uses the same fallback via buildPricingFallbackMap in the controller.
    const fallbackCost = () => pricingFallbackForDisplay()?.get(item.id)
    const effectiveCost = () => (hasPublishedPricing(item.cost) ? item.cost : fallbackCost() ?? item.cost)
    const isBorrowed = () => !hasPublishedPricing(item.cost) && !!fallbackCost()
    const effectiveItem = () => (isBorrowed() ? ({ ...item, cost: effectiveCost() } as ModelItem) : item)
    const price = () => {
      // WorkBuddy publishes no token price — it charges credits per request.
      // Showing "—" would waste the slot and hide the single most useful
      // number, so show the actual consumption rate instead.
      if (item.provider.id === "workbuddy") {
        const rate = workbuddy.rateFor(item.id)
        if (!rate) return "—"
        if (rate.free) return rate.promotion ?? language.t("model.tag.free")
        return rate.rate > 0 ? `x${rate.rate}` : "—"
      }
      return hasPublishedPricing(effectiveCost())
        ? `${isBorrowed() ? "~" : ""}${formatPricePerM(effectiveCost().input + effectiveCost().output)}`
        : "—"
    }
    if (item.provider.id === "openrouter") {
      const cached = () => openRouterStore[item.id]
      return (
        <OpenRouterRow
          item={effectiveItem()}
          navKey={navKey}
          current={current()}
          favorited={props.isFavorite(item)}
          pinned={props.subProviderGet(item)}
          usage={usage()}
          maxRequests={maxRequests()}
          priceLabel={price()}
          rowRef={setRowRef(navKey)}
          endpoints={cached()?.endpoints}
          loading={cached()?.loading ?? false}
          period={deepSeekPeriod()}
          onActivate={() => {
            activate(navKey)
          }}
          onDeactivate={() => deactivate(navKey)}
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
        data-selected-model={current() ? true : undefined}
        classList={{ "!bg-v2-overlay-simple-overlay-hover": current() }}
        class="scroll-my-6 w-full hover:bg-v2-overlay-simple-overlay-hover"
        onMouseEnter={() => activate(navKey)}
        onMouseLeave={() => deactivate(navKey)}
        onSelect={() => selectModel(item)}
      >
        <ProviderIcon id={item.provider.id} class="size-3.5 shrink-0 opacity-60" />
        <span class="min-w-0 flex-1 truncate leading-5">{stripUnlimitedSuffix(item.name)}</span>
        <DeepSeekRateBadge model={item} v2 period={deepSeekPeriod()} />
        <Show when={item.provider.id === "workbuddy"}>
          <WorkBuddyFreeBadge modelID={item.id} />
        </Show>
        <Show when={isUnlimitedModel(item)}>
          <TagV2 class="shrink-0">{language.t("model.tag.unlimited")}</TagV2>
        </Show>
        <Show when={item.provider.id !== "workbuddy" && isFreeModel(item as never)}>
          <TagV2 class="shrink-0">{language.t("model.tag.free")}</TagV2>
        </Show>
        <Show when={item.latest}>
          <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
        </Show>
        <ModelRowMeta
          item={item}
          usage={usage()}
          maxRequests={maxRequests()}
          price={<span class="text-[10px] font-[520] leading-5">{price()}</span>}
        />
        <Show when={current()}>
          <Icon name="check" size="small" class="shrink-0 text-v2-text-text-accent" />
        </Show>
        <ModelFavoriteToggle favorited={props.isFavorite(item)} onToggle={() => props.onToggleFavorite(item)} />
      </MenuV2.Item>
    )
  }

  return (
    <MenuV2 open={store.open} modal={false} placement={props.placement ?? "top-start"} gutter={6} onOpenChange={onOpenChange}>
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
                    closeWith(props.onClose)
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
            <div class="flex min-h-0 max-h-full w-8 shrink-0 flex-col items-stretch gap-0.5 overflow-y-auto border-r border-v2-border-border-muted p-0.5 py-1 no-scrollbar">
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
                  onClick={() => {
                    tooltipSuppressedFor = store.tooltip
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
              <TooltipV2
                placement="right-start"
                gutter={6}
                openDelay={0}
                value={<span class="text-[12px] font-[500]">{language.t("dialog.model.recent")}</span>}
              >
                <button
                  type="button"
                  class="relative flex size-7 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                   classList={{ "!text-v2-text-text-accent": store.rail === recentRailKey }}
                   aria-label={language.t("dialog.model.recent")}
                  onClick={() => {
                    tooltipSuppressedFor = store.tooltip
                    setTooltipPos(null)
                    setStore("rail", store.rail === recentRailKey ? "" : recentRailKey)
                  }}
                >
                  <Show when={store.rail === recentRailKey}>
                    <span class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-v2-text-text-accent" />
                  </Show>
                  <Icon name="clock" size="small" class="shrink-0" />
                </button>
              </TooltipV2>
              <DragDropProvider
                sensors={(defaults) => [
                  ...defaults.filter((sensor) => sensor !== PointerSensor),
                  PointerSensor.configure({
                    activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                    preventActivation: (event) =>
                      !!store.search.trim() ||
                      (event.target instanceof Element && !!event.target.closest("[data-action]")),
                  }),
                ]}
                modifiers={[RestrictToVerticalAxis, RestrictToElement.configure({ element: () => railListRef ?? null })]}
                 plugins={(defaults) => [
                   ...defaults,
                   AutoScroller.configure({ acceleration: 8, threshold: { x: 0, y: 0.05 } }),
                  Feedback.configure({ dropAnimation: null }),
                ]}
                onDragEnd={(event) => {
                  if (store.search.trim()) return
                  const source = event.operation.source
                  if (event.canceled || !isSortable(source)) return
                  const currentIds = railProviders().map((p) => p.id)
                  const initialIndex = source.initialIndex ?? 0
                  const index = source.index ?? initialIndex
                  if (initialIndex !== index && initialIndex >= 0 && index >= 0) {
                    const reordered = arrayMove(currentIds, initialIndex, index)
                    persistRailOrder(reordered)
                  }
                }}
              >
                <div ref={railListRef} class="flex flex-col gap-0.5">
                  <For each={railProviders()}>
                  {(provider, index) => {
                    const sortable = useSortable({
                      get id() { return provider.id },
                      get index() { return index() },
                    })
                    return (
                      <TooltipV2 placement="right-start" gutter={6} openDelay={0} value={<span class="text-[12px] font-[500]">{provider.name}</span>}>
                        <button
                          ref={sortable.ref}
                          data-sortable-id={provider.id}
                          type="button"
                          class="relative flex size-7 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                           classList={{ "!text-v2-text-text-accent": store.rail === provider.id }}
                           aria-label={provider.name}
                          onClick={() => {
                            tooltipSuppressedFor = store.tooltip
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
                    )
                  }}
                </For>
                </div>
              </DragDropProvider>
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
                              fallback={
                                <Show
                                  when={row.key === "header:recent"}
                                  fallback={<Icon name="star-filled" size="small" class="shrink-0 text-v2-state-fg-warning" />}
                                >
                                  <Icon name="clock" size="small" class="shrink-0 text-v2-text-text-faint" />
                                </Show>
                              }
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
                  ref={(el: HTMLDivElement) => {
                    tooltipEl = el
                    if (tooltipPositionFrame) cancelAnimationFrame(tooltipPositionFrame)
                    tooltipPositionFrame = requestAnimationFrame(() => {
                      tooltipPositionFrame = 0
                      updateTooltipPosition()
                    })
                  }}
                  data-component="tooltip-v2"
                  style={{
                    position: "fixed",
                    left: `${position().x}px`,
                    top: `${position().y}px`,
                    "pointer-events": "none",
                    "z-index": 1000,
                    "max-width": "calc(100vw - 30px)",
                    "max-height": "calc(100vh - 30px)",
                  } as never}
                >
                  <ModelTooltip
                    model={(() => {
                      const m = item()
                      const fallback = pricingFallbackForDisplay()?.get(m.id)
                      return fallback && !hasPublishedPricing(m.cost) ? ({ ...m, cost: fallback } as never) : m
                    })()}
                    latest={item().latest}
                    free={isFreeModel(item() as never)}
                    unlimited={isUnlimitedModel(item())}
                    usage={tooltipUsage()}
                    period={deepSeekPeriod()}
                    hitRate={tooltipHitRate()}
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
