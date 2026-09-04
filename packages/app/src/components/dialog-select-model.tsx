import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  batch,
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
import { useVerdentUsage } from "@/hooks/use-verdent-usage"
import { useGensparkUsage, formatCreditsPerMillion, type GensparkModelUsage } from "@/hooks/use-genspark-usage"
import { WorkBuddyFreeBadge, workBuddyFreeLabel } from "./workbuddy-free-badge"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { usePersonalUsage } from "@/context/personal-usage"
import { useLimits } from "@/hooks/use-limits"
import { useNow } from "@/hooks/use-now"
import type { ForkWindowUsage } from "@/utils/fork-client"
import { useOpenRouterFreeUsage } from "@/hooks/use-openrouter-free-usage"
import type { FreeUsageReport } from "@/utils/openrouter-free-usage"
import { percent as usagePercent, colorFor } from "./usage-gauge-v2"
import { toneForRemaining } from "@/utils/limits-format"
import {
  collapseAccountVariants,
  expandForQuery,
  groupForModelID,
  indexModelGroups,
  type ModelGroup,
  variantForPolicy,
} from "./dialog-select-model-accounts"
import { MULTI_ACCOUNT_PROVIDERS, type AutoPolicy } from "@/utils/multi-account-providers"
import { splitModelIDForProvider } from "@/utils/model-account-identity"
import { AccountOptionList, accountLabelForVariant, type AccountOptionUsage } from "./model-account-submenu"
import { ModelStretchBar, stretchTone } from "./model-stretch-bar"
import {
  estimateRequestsRemaining,
  estimateRequestsRemainingFromCost,
  isUsageTrackedProvider,
} from "@/utils/model-usage-estimate"
import {
  getUsageTables,
  matchUsagePricing,
  matchUsageProfile,
  collectThresholdPricingFromIndex,
  prepareThresholdIndex,
} from "@/utils/model-usage-profile"
import { buildHitRateIndex, buildModelCostIndex } from "@/utils/model-usage-history"
import { deepSeekRatePeriod, isDeepSeekPeakPricedModel } from "@/utils/model-peak-pricing"
import { isUnlimitedModel, stripUnlimitedSuffix, hasPublishedPricing } from "@/utils/model-badges"
import {
  buildFuzzyPricingFallbackMap,
  buildPersonalFallbackMap,
  buildPricingFallbackMap,
  mergePricingFallbacks,
  resolveEffectiveCost,
  sortByCheapness,
  isFreeModel,
} from "@/utils/model-cost"
import { buildStandardWorkloadCorpus, FALLBACK_WORKLOAD_CORPUS, type CorpusBands, type Workload } from "@/utils/model-usage-yield"

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
  genspark?: GensparkModelUsage
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

// Sentinel for "let OpenRouter pick the upstream provider" ΓÇö the first,
// default-selected entry of the sub-provider picker. Storing it is never
// persisted; choosing it clears the pinned preference so nothing reaches the
// request (`request.ts` additionally guards against it defensively).
const favoritesRailKey = "favorites"
const recentRailKey = "recent"

// ---------------------------------------------------------------------------
//  Cheapness V2: Usage Yield ranking (┬º5-6, ┬º19, ┬º31 of
//  cheapness-v2-usage-yield-proposal). See utils/model-usage-yield.ts for the
//  full derivation. Summary:
//  - Every PAID model is priced against the SAME standardized workload corpus
//    (16 deduped Go tuples, not its own idiosyncratic profile), via
//    priceWorkload = (I┬╖P_I + K┬╖P_K + O┬╖P_O)/1M (┬º5.2).
//  - Primary cost is the median corpus cost (┬º6); Light/Typical/Heavy bands
//    (┬º7) are derived from context quartiles for diagnostics.
//  - Context-threshold tiers (┬º8: Qwen Γëñ/ >256K, Grok Γëñ/ >200K, GPT Luna Γëñ/ >272K)
//    select the tier the workload actually activates ΓÇö not just the cheapest row.
//  - Time regimes (┬º9: DeepSeek Peak/Off-Peak) blend to expected yield with the
//    documented 20.83% peak fraction (35/168 weekly hours).
//  - Free taxonomy (┬º10, ┬º19): quota-exempt (Unlimited) ΓåÆ free-limited-known ΓåÆ
//    free-limited-unknown ΓåÆ paid-by-yield. Free models never divide by zero;
//    their rank is tier-ordered (┬º19) and capacity is shown separately.
//  - Personal measured yield (┬º31): your own $/request (averageCostPerRequest
//    from buildModelCostIndex, ΓëÑ3 samples) is blended heavily ΓÇö 70% personal
//    vs 30% corpus, extrapolated across *all* providers (┬º32-33). Your history
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
//  - Unpriced models with no sibling pricing (┬º25) sort last; ┬º28 deterministic tiebreakers: yield ΓåÆ name ΓåÆ id.
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
  // One view-level quota projection. Row renderers stay presentational: the
  // WorkBuddy quota resource must never be created once per model row.
  const workbuddy = useWorkBuddyUsage()
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
          <Show when={i.provider.id === "workbuddy"}>
            {(() => {
              const value = workbuddy.forModel(i.id)
              return (
                <>
                  <WorkBuddyFreeBadge label={workBuddyFreeLabel(workbuddy.rateFor(i.id))} />
                  <Show when={value}>
                    {(usage) => (
                      <>
                        <ModelStretchBar
                          requests={usage().estimatedRequests}
                          remainingPercent={usage().remainingPercent}
                          tone={
                            usage().remainingPercent !== undefined
                              ? (toneForRemaining(usage().remainingPercent) as UsageTone)
                              : (stretchTone(usage().estimatedRequests) as UsageTone)
                          }
                        />
                        <span
                          class="shrink-0 text-[10px] font-[520] tabular-nums"
                          classList={{
                            "text-v2-state-fg-danger": usage().creditsExhausted,
                            "text-v2-text-text-faint": !usage().creditsExhausted,
                          }}
                          title={
                            usage().creditsExhausted
                              ? `${usage().account} ┬╖ ${language.t("model.tooltip.workbuddy.noCredits")}`
                              : `${usage().account} ┬╖ ${usage().free ? `~${usage().estimatedRequests} promo requests left (24h) ┬╖ ${usage().remainingPercent?.toFixed(1) ?? "ΓÇö"}%` : `x${usage().rate} credits/request`}`
                          }
                        >
                          {usage().creditsExhausted
                            ? language.t("model.tag.noCredits")
                            : usage().free &&
                                Number.isFinite(usage().estimatedRequests) &&
                                usage().estimatedRequests !== Number.POSITIVE_INFINITY
                              ? `~${Math.round(usage().estimatedRequests).toLocaleString()}`
                              : usage().free
                                ? "Free"
                                : `~${Number.isFinite(usage().estimatedRequests) ? Math.round(usage().estimatedRequests).toLocaleString() : "Γê₧"}`}
                        </span>
                      </>
                    )}
                  </Show>
                </>
              )
            })()}
          </Show>
          <DeepSeekRateBadge model={i} />
          <Show when={isUnlimitedModel(i)}>
            <Tag>{language.t("model.tag.unlimited")}</Tag>
          </Show>
          <Show when={i.provider.id !== "workbuddy" && i.provider.id !== "genspark" && isFreeModel(i as never)}>
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

function ModelRowMeta(props: { item: ModelItem; usage?: ModelUsage; price: JSX.Element }) {
  const language = useLanguage()
  return (
    <Show
      when={props.usage?.estimatedRequests !== undefined || props.usage?.remainingPercent !== undefined}
      fallback={<span class="shrink-0 tabular-nums text-v2-text-text-faint">{props.price}</span>}
    >
      <ModelStretchBar
        requests={props.usage?.estimatedRequests ?? 0}
        remainingPercent={props.usage?.remainingPercent}
        tone={props.usage?.tone}
      />
      <Show when={props.usage?.workbuddy}>
        {(workbuddy) => (
          <span
            class="max-w-[92px] shrink-0 truncate text-[9px] font-[520] tabular-nums leading-5"
            classList={{
              "text-v2-state-fg-danger": workbuddy().creditsExhausted,
              "text-v2-text-text-faint": !workbuddy().creditsExhausted,
            }}
            title={
              workbuddy().creditsExhausted
                ? `${workbuddy().account} ┬╖ ${language.t("model.tooltip.workbuddy.noCredits")}`
                : `${workbuddy().account} ┬╖ ${workbuddy().rate > 0 ? `x${workbuddy().rate} credits/request` : "Free now"}`
            }
          >
            {workbuddy().creditsExhausted
              ? language.t("model.tag.noCredits")
              : workbuddy().free
                ? "Free"
                : `~${Number.isFinite(workbuddy().estimatedRequests) ? Math.round(workbuddy().estimatedRequests).toLocaleString() : "Γê₧"}`}
          </span>
        )}
      </Show>
    </Show>
  )
}

// Tiers on *uptime* ΓÇö the closest honest "which upstream should I trust"
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
    <ScrollView class="max-h-[336px] w-full [&_.scroll-view__viewport]:overscroll-contain" viewportRef={setScrollRoot}>
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
              <div class="absolute inset-x-0 top-0" style={{ transform: `translateY(${virtualRow.start}px)` }}>
                <MenuV2.Item
                  data-endpoint-index={virtualRow.index}
                  class="w-full !h-auto !min-h-[42px] !items-stretch !gap-0 !p-0 [&_[data-slot=menu-v2-item-content]]:!flex [&_[data-slot=menu-v2-item-content]]:!flex-col [&_[data-slot=menu-v2-item-content]]:!items-stretch [&_[data-slot=menu-v2-item-content]]:!gap-0 [&_[data-slot=menu-v2-item-content]]:!p-0 [&_[data-slot=menu-v2-item-content]]:!flex-1"
                  data-selected={isSelected ? true : undefined}
                  tabIndex={
                    focusedIndex() === virtualRow.index || (focusedIndex() < 0 && virtualRow.index === 0) ? 0 : -1
                  }
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
                      <span class="min-w-0 flex-1 truncate text-[12px] font-[450] leading-none tracking-[-0.02px] text-v2-text-text-base">
                        {entry.providerName}
                      </span>
                      <Show when={isCheapest}>
                        <span class="shrink-0 rounded-[3px] bg-v2-state-bg-success/10 px-1 py-0 text-[9px] font-[600] leading-3 tracking-[0.04px] text-v2-state-fg-success">
                          {language.t("dialog.model.subprovider.best")}
                        </span>
                      </Show>
                      <span class="shrink-0 text-[11px] font-[500] tabular-nums leading-none text-v2-text-text-muted">
                        {price}
                      </span>
                      <Show when={isSelected}>
                        <Icon name="check" size="small" class="size-3 shrink-0 text-v2-text-text-accent" />
                      </Show>
                    </div>
                    <div class="flex min-w-0 items-center gap-1 pl-5 text-[10px] font-[450] leading-none text-v2-text-text-faint">
                      <span class="min-w-0 truncate tabular-nums">{entry.tag}</span>
                      <Show when={uptime !== undefined}>
                        <span
                          class="inline-flex shrink-0 items-center gap-1 tabular-nums"
                          title={language.t("dialog.model.subprovider.uptime")}
                        >
                          <span
                            class="size-1 shrink-0 rounded-full"
                            style={{ "background-color": colorFor(uptimeTone(uptime!)) }}
                          />
                          <span style={{ color: colorFor(uptimeTone(uptime!)) }}>{uptime!.toFixed(1)}%</span>
                        </span>
                      </Show>
                      <Show when={throughput !== undefined}>
                        <span class="shrink-0 tabular-nums" title="Throughput (tokens/s)">
                          ┬╖ {throughput} tok/s
                        </span>
                      </Show>
                      <Show when={cacheHit !== undefined}>
                        <span class="shrink-0 tabular-nums" title="Cache hit rate">
                          ┬╖ ~{cacheHit}%
                        </span>
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
// the RadioGroup ΓÇö see `rowList`. Best-effort endpoints fetch; failure
// degrades to Auto-only with no entry list.
function OpenRouterRow(props: {
  item: ModelItem
  navKey: string
  current: boolean
  favorited: boolean
  pinned: string | undefined
  usage?: ModelUsage
  priceLabel: string
  /** WorkBuddy promotion badge label, resolved by the parent to keep rows pure. */
  freeLabel?: string
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
          <WorkBuddyFreeBadge label={props.freeLabel} />
        </Show>
        <Show
          when={
            props.item.provider.id !== "workbuddy" &&
            props.item.provider.id !== "genspark" &&
            isFreeModel(props.item as never)
          }
        >
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

function MultiAccountRow(props: {
  item: ModelItem
  displayName: string
  variants: { accountID: string; item: ModelItem }[]
  navKey: string
  current: boolean
  selectedAccountID?: string
  auto?: ModelItem
  selectedAuto?: boolean
  favorited: boolean
  usage?: ModelUsage
  priceLabel: string
  freeLabel?: string
  accountLabels?: Readonly<Record<string, string>> | ReadonlyMap<string, string>
  rowRef: (element: HTMLElement | undefined) => void
  onActivate: () => void
  onDeactivate: () => void
  onToggleFavorite: () => void
  usageForAccount?: (accountID: string) => AccountOptionUsage | undefined
  submenuOpen: boolean
  onSubmenuChange: (open: boolean) => void
  onSelectAuto: () => void
  onSelectAccount: (accountID: string) => void
}) {
  const language = useLanguage()
  return (
    <MenuV2.Sub gutter={6} overlap overflowPadding={8} open={props.submenuOpen} onOpenChange={props.onSubmenuChange}>
      <MenuV2.SubTrigger
        ref={props.rowRef}
        data-option-key={props.navKey}
        data-selected-model={props.current ? true : undefined}
        aria-label={language.t("dialog.model.account.aria", { name: props.displayName, count: props.variants.length })}
        title={props.variants.map((variant) => accountLabelForVariant(variant, props.accountLabels)).join(", ")}
        class="scroll-my-6 w-full"
        classList={{ "!bg-v2-overlay-simple-overlay-hover": props.current }}
        onMouseEnter={props.onActivate}
        onMouseLeave={props.onDeactivate}
      >
        <ProviderIcon id={props.item.provider.id} class="size-3.5 shrink-0 opacity-60" />
        <span class="min-w-0 flex-1 truncate leading-5">{stripUnlimitedSuffix(props.displayName)}</span>
        <Show when={props.item.provider.id === "workbuddy"}>
          <WorkBuddyFreeBadge label={props.freeLabel} />
        </Show>
        <Show
          when={
            props.item.provider.id !== "workbuddy" &&
            props.item.provider.id !== "genspark" &&
            isFreeModel(props.item as never)
          }
        >
          <TagV2 class="shrink-0">{language.t("model.tag.free")}</TagV2>
        </Show>
        <Show when={props.item.latest}>
          <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
        </Show>
        <Show when={isUnlimitedModel(props.item)}>
          <TagV2 class="shrink-0">{language.t("model.tag.unlimited")}</TagV2>
        </Show>
        <Show when={props.selectedAccountID}>
          {(selected) => {
            const variant = props.variants.find((entry) => entry.accountID === selected())
            return (
              <span
                class="max-w-[72px] shrink-0 truncate rounded-[3px] bg-v2-overlay-simple-overlay-hover px-1 text-[9px] font-[600] text-v2-text-text-faint"
                title={selected()}
              >
                {variant ? accountLabelForVariant(variant, props.accountLabels) : selected()}
              </span>
            )
          }}
        </Show>
        <ModelRowMeta
          item={props.item}
          usage={props.usage}
          price={<span class="text-[10px] font-[520] leading-5">{props.priceLabel}</span>}
        />
        <Show when={props.current}>
          <Icon name="check" size="small" class="shrink-0 text-v2-text-text-accent" />
        </Show>
        <ModelFavoriteToggle favorited={props.favorited} onToggle={props.onToggleFavorite} />
      </MenuV2.SubTrigger>
      <Show when={props.submenuOpen}>
        <MenuV2.Portal>
          <MenuV2.SubContent
            data-model-selector-submenu
            class="overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 p-1 shadow-[var(--v2-elevation-floating)] focus:outline-none"
            style={{ width: "300px", "min-width": "300px", "max-width": "calc(100vw - 24px)" }}
          >
            <div
              class="mb-1 min-w-0 w-full overflow-hidden border-b border-v2-border-border-muted px-2.5 pb-1 [&>div]:!w-full [&>div]:!max-w-full"
              style={{ "font-size": "11px", "line-height": "12px", "font-weight": 530 }}
            >
              <ModelTooltip
                model={props.item}
                latest={props.item.latest}
                free={isFreeModel(props.item as never)}
                unlimited={isUnlimitedModel(props.item)}
                usage={props.usage}
                v2
              />
            </div>
            <AccountOptionList
              variants={props.variants}
              auto={props.auto}
              selectedAuto={props.selectedAuto}
              selectedAccountID={props.selectedAccountID}
              usageForAccount={props.usageForAccount}
              accountLabels={props.accountLabels}
              onSelectAuto={props.onSelectAuto}
              onSelect={props.onSelectAccount}
            />
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
        // click ΓÇö preventDefault alone doesn't stop it from bubbling to the
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
  // and this row is actually a DeepSeek peak-priced model ΓÇö avoids N timers for
  // N rows (previously every row created a 60s interval unconditionally).
  let fallbackNow: (() => Date) | undefined
  if (props.period === undefined && isDeepSeekPeakPricedModel(props.model)) {
    const now = createPolled(() => new Date(), 60_000)
    fallbackNow = now
  }
  const period = () =>
    props.period ?? (fallbackNow ? deepSeekRatePeriod(fallbackNow()) : deepSeekRatePeriod(new Date()))
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
  defaultOpen?: boolean
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
  // are gated while the popover is closed ΓÇö otherwise every `message.updated`
  // token during streaming re-sorts the full catalog idle.
  const [isOpen, setIsOpen] = createSignal(props.defaultOpen ?? false)
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
      currentVariant={controller.currentVariant}
      currentAccountID={controller.currentAccountID}
      groupOf={controller.groupOf}
      variants={controller.variants}
      selectVariant={controller.selectVariant}
      select={controller.select}
      subProviderGet={controller.subProviderGet}
      subProviderSet={controller.subProviderSet}
      pricingFallback={controller.mergedPricingFallback}
      tables={controller.tables}
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
      defaultOpen={props.defaultOpen}
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
  // (┬º31). Build the per-model personal index once per sync-change and blend
  // it heavily (70%) with the standardized corpus when ranking.
  let sync: ReturnType<typeof useSync> | undefined
  try {
    sync = useSync()
  } catch {
    sync = undefined
  }
  let personal: ReturnType<typeof usePersonalUsage> | undefined
  try {
    personal = usePersonalUsage()
  } catch {
    personal = undefined
  }
  const isOpen = () => input.open?.() ?? true
  const [rankReady, setRankReady] = createSignal(false)
  createEffect(() => {
    if (!isOpen()) {
      setRankReady(false)
      return
    }
    // Defer the ~50ms ranking (fuzzy + sort) one frame so open->flush is cheap
    // (~5ms alphabetical) and ranking lands after paint. openOrder pins the
    // first ranked order so rows don't jump on subsequent recomputes.
    const handle =
      typeof requestIdleCallback !== "undefined"
        ? requestIdleCallback(() => setRankReady(true), { timeout: 80 })
        : setTimeout(() => setRankReady(true), 16)
    onCleanup(() => {
      if (typeof cancelIdleCallback !== "undefined" && typeof (handle as unknown as number) === "number") cancelIdleCallback(handle as unknown as number)
      else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    })
  })
  // Durable learner: ingest live assistant messages into the global persisted
  // store so "your usage" survives LRU eviction (SESSION_CACHE_LIMIT=40) and
  // cold restarts. The store is deduped by message id, capped at 200/model,
  // and debounced globally via PersonalUsageIngest; this local ingest ensures
  // the open selector's sort reflects very recent messages within <1s.
  createEffect(() => {
    if (!isOpen()) return
    if (!sync || !personal || !personal.ready()) return
    const msgMap = sync().data.message
    const total = Object.values(msgMap).reduce((sum, arr) => sum + (arr?.length ?? 0), 0)
    void total
    queueMicrotask(() => personal!.ingest(msgMap))
  })
  const personalCosts = createMemo(() => {
    if (!isOpen() || !rankReady()) return undefined
    const durable = personal?.personalCosts()
    if (durable && durable.size > 0) return durable
    // Fallback: ephemeral scan before durable has been populated (first
    // run after upgrade, or provider not mounted in tests/storybook).
    if (!sync) return undefined
    const idx = buildModelCostIndex(sync().data.message)
    if (idx.size === 0) return undefined
    const map = new Map<string, { cost: number; count: number }>()
    for (const [k, entry] of idx.entries()) map.set(k, { cost: entry.sum / entry.count, count: entry.count })
    return map.size > 0 ? map : undefined
  })
  // ┬º21.4, ┬º28: the ranking corpus upgrades from the pinned fallback to the
  // live Go workload when the tables fetch succeeds ΓÇö deterministic either way.
  // Gated on open: avoid fetching+parsing while the picker is closed and idle.
  const [tables] = createResource(
    () => (isOpen() ? true : undefined),
    () => getUsageTables(),
  )
  // Cross-open in-memory cache (IndexedDB explicitly rejected: async +
  // structured-clone overhead, stale-rank risk). The fuzzy build
  // (O(unpriced × paid)) + threshold scan + corpus build are the ~50ms open
  // cost; keep them across closes keyed on catalog fingerprint so a reopen
  // with an unchanged catalog reuses them instead of rebuilding.
  let cachedMergedPricing: Map<string, import("@/utils/model-cost").ModelCost> | undefined
  let cachedMergedCatalogFp = ""
  let cachedThreshold: Map<
    string,
    Array<{
      thresholdTokens: number
      operator: "<=" | ">"
      cost: { input: number; output: number; cache: { read: number; write: number } }
    }>
  > | undefined
  let cachedThresholdFp = ""
  let cachedBands: CorpusBands | undefined
  let cachedBandsTablesFp = ""
  let openOrderCfp: string | undefined
  let openOrderTfp: string | undefined
  let openOrderUsageRev: string | undefined
  // Set while closed; consumed once on the next open edge so usage-accrued
  // between opens invalidates the pin exactly once per open. Mid-open
  // recomputes never re-check (stability-within-open).
  let openEdgeUsageCheck = false
  // Lightweight usage revision over the personal/hit-rate inputs that feed
  // the sort. The retained pin must not override freshly accrued usage:
  // personalCosts/hitRates refresh per open but are not part of the catalog
  // fingerprint, so without this a new usage sample would be sorted and then
  // re-pinned back to the stale order. Fallback maps derive deterministically
  // from the primaries, so hashing the primaries suffices. Costs use
  // toPrecision(10) — stable for identical doubles, sensitive to real change.
  function usageRevOf(
    pCosts: Map<string, { cost: number; count: number }> | undefined,
    hr: Map<string, number> | undefined,
  ): string {
    let h = 0x811c9dc5
    const mix = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
      h ^= 0x9e3779b9
      h = Math.imul(h, 0x01000193)
    }
    if (pCosts) {
      mix(`p${pCosts.size}`)
      for (const k of [...pCosts.keys()].sort()) {
        const e = pCosts.get(k)!
        mix(`${k}=${e.cost.toPrecision(10)}:${e.count}`)
      }
    } else mix("p-")
    if (hr) {
      mix(`h${hr.size}`)
      for (const k of [...hr.keys()].sort()) {
        mix(`${k}=${(hr.get(k)!).toPrecision(10)}`)
      }
    } else mix("h-")
    return (h >>> 0).toString(16).padStart(8, "0")
  }
  // Catalog fingerprint: model.list length + FNV-1a ids hash. Empty list
  // yields "" so the empty-local-list fallback path (view's props.models(""))
  // is preserved and never poisons the cache.
  function catalogIdsFp(): string {
    let raw: Array<{ id: string; provider: { id: string } }> = []
    try {
      raw = model.list() as unknown as Array<{ id: string; provider: { id: string } }>
    } catch {
      return ""
    }
    if (raw.length === 0) return ""
    let h = 0x811c9dc5
    for (const item of raw) {
      const s = `${item.provider.id}:${item.id}`
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
      h ^= 0x9e3779b9
      h = Math.imul(h, 0x01000193)
    }
    return `${raw.length}:${(h >>> 0).toString(16).padStart(8, "0")}`
  }
  // Tables fingerprint: profile/pricing lengths + FNV over pricing row names
  // (threshold-relevant) and profile tuple stream. Cheap, deterministic.
  function tablesFp(): string {
    const t = tables.latest as import("@/utils/model-usage-profile").UsageTables | undefined
    const profile = t?.profile
    const pricing = t?.pricing
    if (!profile || !pricing || (profile.length === 0 && pricing.length === 0)) return ""
    let h = 0x811c9dc5
    const mix = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
      h ^= 0x9e3779b9
      h = Math.imul(h, 0x01000193)
    }
    for (const e of profile) {
      for (const n of e.names) mix(n)
      mix(`${e.profile.input}|${e.profile.cached}|${e.profile.output}`)
    }
    for (const e of pricing) {
      for (const n of e.names) mix(n)
      mix(`${e.pricing.input}|${e.pricing.output}|${e.pricing.cache.read}|${e.pricing.cache.write}`)
    }
    return `p${profile.length}:r${pricing.length}:${(h >>> 0).toString(16).padStart(8, "0")}`
  }
  const bands = createMemo(() => {
    // Cache-first: identical tables fingerprint reuses bands without rebuild,
    // even across closes (memos below are idle-gated while closed).
    const tfp = tablesFp()
    if (tfp && cachedBands && cachedBandsTablesFp === tfp) return cachedBands
    if (!isOpen() || !rankReady()) return undefined
    const p = tables.latest?.profile
    if (!p || p.length === 0) return undefined
    const built = buildStandardWorkloadCorpus(p.map((e) => e.profile))
    if (tfp) {
      cachedBands = built
      cachedBandsTablesFp = tfp
    }
    return built
  })
  const thresholdMap = createMemo(() => {
    // Cache-first keyed on catalog + tables fingerprint; exact same output as
    // a fresh build (same builders), reused across closes.
    const cfp = catalogIdsFp()
    const tfp = tablesFp()
    const fp = cfp && tfp ? `${cfp}|${tfp}` : ""
    if (fp && cachedThreshold && cachedThresholdFp === fp) return cachedThreshold
    if (!isOpen() || !rankReady()) return undefined
    const pricing = tables.latest?.pricing
    if (!pricing || pricing.length === 0) return undefined
    // Build threshold-tier map for Qwen/Grok/GPT-Luna style dual rows (┬º8).
    // Use the full model list (not just visible/filtered) so that a model
    // hidden via visibility still contributes its threshold tiers for fallback.
    const map = new Map<
      string,
      Array<{
        thresholdTokens: number
        operator: "<=" | ">"
        cost: { input: number; output: number; cache: { read: number; write: number } }
      }>
    >()
    const raw = model.list()
    // Y3 hoisted: the pricing table is invariant across this loop, so prepare
    // the threshold index (filter + name normalize) once instead of per model.
    const prepared = prepareThresholdIndex(pricing)
    for (const item of raw) {
      const tp = collectThresholdPricingFromIndex(prepared, {
        name: item.name,
        family: (item as unknown as { family?: string }).family,
        id: item.id,
      })
      if (tp) map.set(modelKey(item as ModelItem), tp as never)
    }
    const out = map.size > 0 ? map : undefined
    if (fp && out) {
      cachedThreshold = out
      cachedThresholdFp = fp
    }
    return out
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
  const collapsedGroups = createMemo(() => collapseAccountVariants(unsorted(), MULTI_ACCOUNT_PROVIDERS))
  const groupIndex = createMemo(() => indexModelGroups(collapsedGroups()))
  // Pricing fallback: same model id across providers is ~same price (except
  // openrouter). If a model is unpriced on one provider, borrow a sibling's
  // published price instead of sorting it as unpriced/last. Build from the
  // full catalog (not just visible/filtered) so that a hidden sibling can
  // still donate its pricing.
  const pricingFallback = createMemo(() => {
    if (!isOpen() || !rankReady()) return undefined
    const list = model.list()
    if (list.length === 0) return undefined
    const map = buildPricingFallbackMap(list as never)
    return map.size > 0 ? map : undefined
  })
  // Fuzzy sibling of the exact-id fallback above: catches free-tier variants
  // that ship under a different id than their paid counterpart (any provider,
  // ΓëÑ75% name-similarity confidence ΓÇö see string-similarity.ts). Merged with,
  // never replacing, the exact map (exact always wins on a shared id).
  const fuzzyPricingFallback = createMemo(() => {
    if (!isOpen() || !rankReady()) return undefined
    const list = model.list()
    if (list.length === 0) return undefined
    const map = buildFuzzyPricingFallbackMap(list as never)
    return map.size > 0 ? map : undefined
  })
  const mergedPricingFallback = createMemo(() => {
    // Cache-first: unchanged catalog fingerprint reuses the merged map
    // (exact-wins-over-fuzzy preserved via mergePricingFallbacks) without
    // rebuilding the O(unpriced × paid) fuzzy scan. Never caches the
    // empty-catalog case so the view's props.models("") fallback stays intact.
    const cfp = catalogIdsFp()
    if (cfp && cachedMergedPricing && cachedMergedCatalogFp === cfp) return cachedMergedPricing
    if (!isOpen() || !rankReady()) return undefined
    const merged = mergePricingFallbacks(pricingFallback(), fuzzyPricingFallback())
    if (cfp && merged) {
      cachedMergedPricing = merged
      cachedMergedCatalogFp = cfp
    }
    return merged
  })
  // Pre-warm fuzzy + threshold + bands during idle after mount, not on click.
  // Kicks the usage-tables fetch and builds the expensive maps from whatever
  // catalog/tables are already available, so the first open hits warm caches.
  // Identical builders → identical scores; no ranking behavior change.
  onMount(() => {
    const warm = () => {
      try {
        const cfp = catalogIdsFp()
        if (cfp && cfp !== cachedMergedCatalogFp) {
          try {
            const list = model.list() as never
            if ((list as unknown as Array<unknown>).length > 0) {
              const exact = buildPricingFallbackMap(list)
              const fuzzy = buildFuzzyPricingFallbackMap(list)
              const merged = mergePricingFallbacks(exact.size > 0 ? exact : undefined, fuzzy.size > 0 ? fuzzy : undefined)
              if (merged) {
                cachedMergedPricing = merged
                cachedMergedCatalogFp = cfp
              }
            }
          } catch {}
        }
        void getUsageTables()
          .then((t) => {
            try {
              if (!t) return
              const live = t as import("@/utils/model-usage-profile").UsageTables
              // Bands warm from the fetched profiles.
              try {
                if (live.profile.length > 0) {
                  const built = buildStandardWorkloadCorpus(live.profile.map((e) => e.profile))
                  void built
                  // Cache under the resource fingerprint when available so the
                  // open path hits; otherwise leave bands caching to open.
                  const tfpNow = tablesFp()
                  if (tfpNow) {
                    cachedBands = built
                    cachedBandsTablesFp = tfpNow
                  }
                }
              } catch {}
              // Threshold warm from fetched pricing + current catalog.
              try {
                const cfpNow = catalogIdsFp()
                const tfpNow = tablesFp()
                const fpNow = cfpNow && tfpNow ? `${cfpNow}|${tfpNow}` : ""
                if (fpNow && cachedThresholdFp !== fpNow && live.pricing.length > 0) {
                  const raw = model.list()
                  if (raw.length > 0) {
                    const prepared = prepareThresholdIndex(live.pricing)
                    const map = new Map<
                      string,
                      Array<{
                        thresholdTokens: number
                        operator: "<=" | ">"
                        cost: { input: number; output: number; cache: { read: number; write: number } }
                      }>
                    >()
                    for (const item of raw) {
                      const tp = collectThresholdPricingFromIndex(prepared, {
                        name: (item as { name: string }).name,
                        family: (item as unknown as { family?: string }).family,
                        id: (item as { id: string }).id,
                      })
                      if (tp) map.set(modelKey(item as ModelItem), tp as never)
                    }
                    if (map.size > 0) {
                      cachedThreshold = map
                      cachedThresholdFp = fpNow
                    }
                  }
                }
              } catch {}
            } catch {}
          })
          .catch(() => {})
      } catch {}
    }
    if (typeof requestIdleCallback !== "undefined") requestIdleCallback(() => warm(), { timeout: 2000 })
    else setTimeout(warm, 100)
  })
  // Personal fallback: same model across providers shares your workload shape.
  // If you used claude-sonnet via anthropic (personal data exists) but not via
  // openrouter, borrow that personal $/request to value the openrouter variant
  // instead of falling back to the generic corpus.
  const personalFallback = createMemo(() => {
    if (!isOpen() || !rankReady()) return undefined
    const p = personalCosts()
    if (!p) return undefined
    const map = buildPersonalFallbackMap(p)
    return map.size > 0 ? map : undefined
  })
  // Hit rate: personal cache hit rate per provider:model, with cross-provider
  // fallback by model id. When available (ΓëÑ3 samples), the workload's prompt
  // is re-split as K'=T*h, I'=T*(1-h) so a provider/model that actually hits
  // cache 80% of the time is correctly seen as cheaper than one that hits 20%.
  const hitRates = createMemo(() => {
    if (!isOpen() || !rankReady()) return undefined
    const durable = personal?.hitRates()
    if (durable && durable.size > 0) return durable
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
    if (!isOpen() || !rankReady()) return undefined
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
    const list = collapsedGroups().map((group) => group.canonical)
    if (!isOpen() || !rankReady()) {
      if (!isOpen()) {
        // Keep openOrder across closes; invalidate only when the catalog
        // fingerprint (model.list length + ids hash + tables fingerprint)
        // changed. Empty fingerprints are treated as unknown, never as a
        // change: the tables fetch typically resolves mid-first-open, and
        // "" -> loaded must adopt the new tables fingerprint, not discard
        // the pinned order. Empty catalog never invalidates (fallback path
        // preserved).
        const cfpNow = catalogIdsFp()
        const tfpNow = tablesFp()
        if (openOrder !== undefined && cfpNow) {
          if (openOrderCfp !== undefined && cfpNow !== openOrderCfp) openOrder = undefined
          else if (tfpNow && openOrderTfp && tfpNow !== openOrderTfp) openOrder = undefined
        }
        if (openOrder === undefined) {
          openOrderCfp = undefined
          openOrderTfp = undefined
          openOrderUsageRev = undefined
        } else if (tfpNow && !openOrderTfp) {
          openOrderTfp = tfpNow
        }
        // Arm the one-shot usage check for the next open edge.
        openEdgeUsageCheck = true
      }
      return list.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    }
    const b = bands()
    const tmap = thresholdMap()
    const pCosts = personalCosts()
    const pFallback = personalFallback()
    const priceFallback = mergedPricingFallback()
    const hr = hitRates()
    const hrFallback = hitRateFallback()
    const corpus = b?.corpus
    const sorted = sortByCheapness(
      list as never,
      corpus,
      tmap as never,
      pCosts as never,
      priceFallback as never,
      pFallback as never,
      hr as never,
      hrFallback as never,
    ) as unknown as typeof list
    let result: typeof list
    if (!openOrder) {
      openOrder = sorted.map(modelKey)
      openOrderCfp = catalogIdsFp() || undefined
      openOrderTfp = tablesFp() || undefined
      openOrderUsageRev = usageRevOf(pCosts, hr)
      openEdgeUsageCheck = false
      result = sorted
    } else if (openEdgeUsageCheck) {
      // One-shot per open: usage accrued between opens (new personal samples
      // or hit-rate shifts) adopts the fresh order instead of being overridden
      // by the stale pin. Mid-open recomputes skip this (pin stays stable).
      openEdgeUsageCheck = false
      const rev = usageRevOf(pCosts, hr)
      if (rev !== openOrderUsageRev) {
        openOrder = sorted.map(modelKey)
        openOrderCfp = catalogIdsFp() || undefined
        openOrderTfp = tablesFp() || undefined
        openOrderUsageRev = rev
        result = sorted
      } else {
        const rank = new Map(openOrder.map((key, index) => [key, index]))
        result = sorted.sort(
          (a, b) =>
            (rank.get(modelKey(a)) ?? Number.POSITIVE_INFINITY) - (rank.get(modelKey(b)) ?? Number.POSITIVE_INFINITY),
        )
      }
    } else {
      const rank = new Map(openOrder.map((key, index) => [key, index]))
      result = sorted.sort(
        (a, b) =>
          (rank.get(modelKey(a)) ?? Number.POSITIVE_INFINITY) - (rank.get(modelKey(b)) ?? Number.POSITIVE_INFINITY),
      )
    }
    return result
  })
  const searchableFields = createMemo(() => {
    if (!isOpen()) return new Map<ModelItem, ReturnType<typeof prepareModelSearchFields>>()
    const fields = new Map<ModelItem, ReturnType<typeof prepareModelSearchFields>>()
    for (const group of collapsedGroups()) {
      fields.set(
        group.canonical,
        prepareModelSearchFields([
          group.label,
          group.canonical.name,
          group.canonical.id,
          group.canonical.provider.name,
          ...group.variants.flatMap((variant) => [variant.accountID, variant.item.name, variant.item.id]),
        ]),
      )
    }
    return fields
  })

  const key = (item: ModelItem) => ({ modelID: item.id, providerID: item.provider.id })
  // `model.current()` values are `{ id, providerID, ... }` — they carry NO
  // `modelID` and NO `provider` object at runtime (see models.tsx:150,
  // local.tsx:258), so `modelKey(value as ModelItem)` builds
  // `"undefined:<id>"` and every groupIndex lookup misses. Build the index
  // key from the flat fields instead: `${providerID}:${id}` matches the
  // `modelKey(item)` keys the index is built with.
  const currentKey = (value: { providerID: string; id: string }) => `${value.providerID}:${value.id}`
  const currentGroup = (value: { providerID: string; modelID: string }) =>
    groupIndex().get(`${value.providerID}:${value.modelID}`) ??
    groupForModelID(collapsedGroups(), value.providerID, value.modelID)
  const toCurrentRef = (value: { providerID: string; id: string }) => ({
    providerID: value.providerID,
    modelID: value.id,
  })
  const current = createMemo(() => {
    const value = model.current()
    if (!value) return undefined
    return currentGroup(toCurrentRef(value))?.key ?? currentKey(value)
  })
  const currentVariant = createMemo(() => {
    const value = model.current()
    return value
      ? groupIndex()
          .get(currentKey(value))
          ?.variants.find((variant) => variant.item.id === value.id)
      : undefined
  })
  // Account pinned on the current model, including ids the group index never
  // saw (synthesized submenu rows). Falls back to parsing the transport
  // suffix (`model@vd-…`, `model@zen-…`) so the checkmark survives.
  const currentAccountID = createMemo(() => {
    const value = model.current()
    if (!value) return undefined
    const group = currentGroup(toCurrentRef(value))
    const byItem = group?.variants.find((variant) => variant.item.id === value.id)
    if (byItem) return byItem.accountID
    return splitModelIDForProvider(value.id, value.providerID).accountID
  })

  return {
    models: (search: string) => {
      const query = search.trim()
      if (!query) return allModels()
      const matches = createModelSearchMatcher(query)
      const fields = searchableFields()
      const matchedGroups = collapsedGroups().filter((group) => {
        const prepared = fields.get(group.canonical)
        return prepared ? matches(prepared) : false
      })
      const expanded = expandForQuery(matchedGroups, query)
      // `expandForQuery` uses a substring check for account labels; retain the
      // existing fuzzy matcher for regular model/provider queries.
      return expanded.filter((item) => {
        const group = groupIndex().get(modelKey(item))
        const prepared = group ? fields.get(group.canonical) : undefined
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
    favorites: (_models: ModelItem[]) => {
      const out: ModelItem[] = []
      for (const group of collapsedGroups()) {
        const favorited =
          model.favorite.isFavorite(key(group.canonical)) ||
          group.variants.some((variant) => model.favorite.isFavorite(key(variant.item)))
        if (favorited) out.push(group.canonical)
      }
      return out
    },
    recents: (models: ModelItem[]) => {
      const byKey = groupIndex()
      const ordered: ModelItem[] = []
      const seen = new Set<string>()
      const recentItems = model.recent() ?? []
      for (const entry of recentItems) {
        if (!entry) continue
        const k = modelKey(entry)
        const group = byKey.get(k)
        if (!group || seen.has(group.key)) continue
        if (
          model.favorite.isFavorite(key(group.canonical)) ||
          group.variants.some((variant) => model.favorite.isFavorite(key(variant.item)))
        )
          continue
        if (!models.some((item) => modelKey(item) === modelKey(group.canonical))) continue
        seen.add(group.key)
        ordered.push(group.canonical)
      }
      return ordered
    },
    isFavorite: (item: ModelItem) => {
      const group = groupIndex().get(modelKey(item))
      return group
        ? model.favorite.isFavorite(key(group.canonical)) ||
            group.variants.some((variant) => model.favorite.isFavorite(key(variant.item)))
        : model.favorite.isFavorite(key(item))
    },
    toggleFavorite: (item: ModelItem) => model.favorite.toggle(key(item)),
    current,
    currentVariant,
    currentAccountID,
    groupOf: (item: ModelItem): ModelGroup<ModelItem> | undefined => groupIndex().get(modelKey(item)),
    variants: (item: ModelItem) => groupIndex().get(modelKey(item))?.variants ?? [],
    selectVariant: (item: ModelItem, selection: string | AutoPolicy) => {
      const group = groupIndex().get(modelKey(item))
      const selected = group ? variantForPolicy(group, selection) : undefined
      if (selected) {
        model.set({ modelID: selected.id, providerID: selected.provider.id }, { recent: true })
        input.onSelect()
      }
    },
    select: (item: ModelItem) => {
      model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
      input.onSelect()
    },
    subProviderGet: (item: ModelItem) => model.subProvider.get({ providerID: item.provider.id, modelID: item.id }),
    subProviderSet: (item: ModelItem, value: string | undefined) =>
      model.subProvider.set({ providerID: item.provider.id, modelID: item.id }, value),
    mergedPricingFallback: () => mergedPricingFallback(),
    tables: () => tables.latest as import("@/utils/model-usage-profile").UsageTables | undefined,
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
  currentVariant: () => { accountID: string; item: ModelItem } | undefined
  /** Account id parsed from the current model's transport suffix (`@zen-…`,
   * `@vd-…`) when the pinned variant is not in the group index (e.g. a
   * synthesized submenu for go keys the catalog cache hasn't refreshed). */
  currentAccountID?: () => string | undefined
  groupOf: (item: ModelItem) => ModelGroup<ModelItem> | undefined
  variants: (item: ModelItem) => { accountID: string; item: ModelItem }[]
  selectVariant: (item: ModelItem, selection: string | AutoPolicy) => void
  select: (item: ModelItem) => void
  subProviderGet: (item: ModelItem) => string | undefined
  subProviderSet: (item: ModelItem, value: string | undefined) => void
  onCompare: () => void
  onManage: () => void
  onManageCredentials: () => void
  onClose: () => void
  model?: ModelState
  onExternalOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  pricingFallback?: () => Map<string, import("@/utils/model-cost").ModelCost> | undefined
  tables?: () => import("@/utils/model-usage-profile").UsageTables | undefined
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
  // Provider catalog refresh (see selectAccount step 2b): the Verdent/Zen
  // models hooks emit per-account ids at provider-load time, but the app
  // caches that catalog while quota reads the vault live — accounts enrolled
  // after load (vault edit) appear in the submenu but not the catalog until
  // the `providers` queries are refetched. Same degrade-on-missing pattern.
  let serverSync: ReturnType<typeof useServerSync> | undefined
  try {
    serverSync = useServerSync()
  } catch {
    serverSync = undefined
  }
  let personal: ReturnType<typeof usePersonalUsage> | undefined
  try {
    personal = usePersonalUsage()
  } catch {
    personal = undefined
  }
  // Ingest live messages into durable store while open - ensures very recent
  // samples (post-debounce window) still affect the tooltip/stretch bars.
  createEffect(() => {
    if (!store.open) return
    if (!personal || !personal.ready()) return
    const msgMap = sync().data.message
    const total = Object.values(msgMap).reduce((sum, arr) => sum + (arr?.length ?? 0), 0)
    void total
    queueMicrotask(() => personal!.ingest(msgMap))
  })
  // WorkBuddy bills credits-per-request across several independent accounts, so
  // its stretch estimate cannot ride the OpenCode-Go USD-window path. This is a
  // pure projection of the quota result `useLimits` already polls ΓÇö no extra
  // network traffic.
  const workbuddy = useWorkBuddyUsage()
  const verdent = useVerdentUsage()
  const genspark = useGensparkUsage()
  const [store, setStore] = createStore({
    open: props.defaultOpen ?? false,
    search: persistedModelSearch,
    active: "",
    tooltip: "",
    rail: "",
    submenu: "",
  })
  // Account labels for the model picker ΓÇö the server's model names are cached
  // in Provider.list() and still carry the old numeric label until the cache is
  // invalidated after a vault edit. Quota's `verdentAccounts`/`workbuddyAccounts`
  // are live (read directly from the vault on every poll), so prefer those.
  const limitsNow = useNow(() => store.open)
  const limits = useLimits({ now: limitsNow } as any)
  const accountLabels = createMemo(() => {
    const map = new Map<string, string>()
    for (const p of limits.providers() ?? []) {
      const usage = (p as any).result?.usage
      for (const acct of usage?.verdentAccounts ?? [])
        if (acct.accountId && acct.label) map.set(acct.accountId, acct.label)
      for (const acct of usage?.workbuddyAccounts ?? [])
        if (acct.accountId && acct.label) map.set(acct.accountId, acct.label)
      for (const acct of usage?.zenAccounts ?? []) if (acct.keyId && acct.label) map.set(acct.keyId, acct.label)
    }
    // opencode and opencode-go accounts (env + vault) are all reported by the
    // pool through the `opencode` quota adapter's `zenAccounts`, so their
    // labels resolve here for both providers. Vault UUIDs are kept for legacy
    // synthesized rows (old servers); their pool ids (`zen-<hash>`) come from
    // the zenAccounts rows above.
    for (const cred of forkUsage.credentials.latest ?? [])
      if (cred.id && cred.label) map.set(cred.id, cred.label)
    return map.size > 0 ? map : undefined
  })
  // Verdent accounts as reported live by the quota adapter (`verdentAccounts`),
  // used to synthesize the account submenu when the catalog exposes no
  // per-account model variants.
  const verdentAccounts = createMemo<{ accountId: string; label: string }[]>(() => {
    const out: { accountId: string; label: string }[] = []
    const seen = new Set<string>()
    for (const p of limits.providers() ?? []) {
      const usage = (p as any).result?.usage
      for (const acct of usage?.verdentAccounts ?? []) {
        if (!acct?.accountId || seen.has(acct.accountId)) continue
        seen.add(acct.accountId)
        out.push({ accountId: acct.accountId, label: acct.label ?? acct.accountId })
      }
    }
    return out
  })
  const zenKeyLimits = createMemo(() => {
    const map = new Map<
      string,
      {
        label: string
        exhausted: boolean
        usedObserved: number | null
        limitEstimate: number | null
        remainingPercent: number | null
      }
    >()
    for (const p of limits.providers() ?? []) {
      const usage = (p as any).result?.usage
      for (const acct of usage?.zenAccounts ?? []) if (acct.keyId) map.set(acct.keyId, acct)
    }
    return map
  })
  // Backend variants exist only for providers whose plugin emits them
  // (workbuddy, verdent, and Zen's `opencode`). opencode-go keys live in the
  // fork credential store, so they never arrive as catalog variants. When a
  // provider has >1 key/credential but no collapsed group, synthesize a
  // display-only group so the row renders the account submenu (which embeds
  // the model tooltip) instead of a plain row plus the floating tooltip.
  // Shared by tooltip suppression and row rendering so the two can't drift.
  // Per-row group cache: building the synthesized variant arrays
  // (Array.from + map + labeled clones) on every call costs one allocation
  // burst per mounted virtual row per render. Cache by model key and reuse
  // while the inputs are unchanged (source group identity + live account
  // source sizes). O(1) hit path; recompute only when quota/credential data
  // actually changes.
  const buildAccountGroup = (
    item: ModelItem,
    group: ModelGroup<ModelItem> | undefined,
  ): ModelGroup<ModelItem> | undefined => {
    if (group && group.variants.length > 1) return group
    // Embed the label in parens on the synthesized variant name so the
    // `accountLabelForVariant` fallback parser (used when the labels map
    // hasn't been populated yet — e.g. quota still loading) can still show
    // a human name instead of the raw accountID. accountLabels() is also
    // populated for every key here as a belt-and-suspenders fallback.
    const labeledClone = (accountID: string, label: string) =>
      ({ ...item, id: `${item.id}@${accountID}`, name: label ? `${item.name} (${label})` : item.name }) as ModelItem
    const plainClone = (accountID: string) => ({ ...item, id: `${item.id}@${accountID}` }) as ModelItem
    const build = (variants: { accountID: string; item: ModelItem }[]) =>
      ({
        key: `${item.provider.id}:${item.id}`,
        canonical: item,
        label: item.name,
        auto: item,
        variants,
      }) as ModelGroup<ModelItem>

    // opencode and opencode-go share the Zen account pool (env + vault keys),
    // so both synthesize from `zenKeyLimits()` — the pool's live accounts as
    // reported by the `opencode` quota adapter. Ids are `zen-<hash>` in both
    // cases, matching the catalog variants and the usage roster.
    if ((item.provider.id === "opencode" || item.provider.id === "opencode-go") && zenKeyLimits().size > 1)
      return build(
        Array.from(zenKeyLimits().entries()).map(([keyId, info]) => ({
          accountID: keyId,
          item: labeledClone(keyId, info.label),
        })),
      )
    // Verdent: fall back to the quota-reported account list when the catalog
    // exposes no per-account variants.
    if (item.provider.id === "verdent" && verdentAccounts().length > 1)
      return build(
        verdentAccounts().map((acct) => ({
          accountID: acct.accountId,
          item: labeledClone(acct.accountId, acct.label),
        })),
      )
    // Suppress "unused param" for plainClone — kept for any future source
    // that needs the un-labeled shape.
    void plainClone
    return group
  }
  const accountGroupCache = new Map<
    string,
    {
      sourceGroup: ModelGroup<ModelItem> | undefined
      zenSize: number
      verdentLen: number
      result: ModelGroup<ModelItem> | undefined
    }
  >()
  onCleanup(() => accountGroupCache.clear())
  const accountGroupFor = (item: ModelItem): ModelGroup<ModelItem> | undefined => {
    const key = modelKey(item)
    const sourceGroup = props.groupOf(item)
    const zenSize = zenKeyLimits().size
    const verdentLen = verdentAccounts().length
    const cached = accountGroupCache.get(key)
    if (
      cached &&
      cached.sourceGroup === sourceGroup &&
      cached.zenSize === zenSize &&
      cached.verdentLen === verdentLen
    )
      return cached.result
    const result = buildAccountGroup(item, sourceGroup)
    accountGroupCache.set(key, { sourceGroup, zenSize, verdentLen, result })
    return result
  }

  const [localTables] = createResource(
    () => (store.open && !props.tables ? true : undefined),
    () => getUsageTables(),
  )
  const tablesLatest = () => props.tables?.() ?? localTables.latest
  const profileTable = () => tablesLatest()?.profile ?? []
  const pricingTable = () => tablesLatest()?.pricing ?? []
  const sdk = useSDK()
  const freeUsage = useOpenRouterFreeUsage()
  // Pricing fallback for display: same model id across providers is ~same cost
  // (except openrouter). Build from the full catalog so that an unpriced
  // variant can show a borrowed sibling price instead of "ΓÇö".
  // Y2 dedup: reuse controller's mergedPricingFallback when available to avoid
  // building the same two maps twice per open. The controller's maps are built
  // from model.list() (full catalog); the view's fallback to props.models("")
  // is preserved only for the empty-local-list edge case where the controller
  // has no data.
  const pricingFallbackForDisplay = createMemo(() => {
    if (props.pricingFallback?.()) return undefined
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
  // Fuzzy sibling of the exact-id display fallback above ΓÇö see the matching
  // comment on the controller-scoped `fuzzyPricingFallback` memo above.
  const fuzzyPricingFallbackForDisplay = createMemo(() => {
    if (props.pricingFallback?.()) return undefined
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
    const map = buildFuzzyPricingFallbackMap(list as never)
    return map.size > 0 ? map : undefined
  })
  const mergedPricingFallbackForDisplay = createMemo(() => {
    const fromController = props.pricingFallback?.()
    if (fromController) return fromController
    return mergePricingFallbacks(pricingFallbackForDisplay(), fuzzyPricingFallbackForDisplay())
  })
  // Hit rate maps: durable personal aggregate (survives LRU) + openrouter telemetry.
  // Personal is now the global persisted learner (deduped by message id, 200/model).
  // Openrouter is built from openRouterStore endpoints.
  // Both are per provider:model and also aggregated by model id for cross-provider fallback.
  // Gated on store.open: map derivation is cheap but still gated.
  const personalHitRates = createMemo(() => {
    if (!store.open) return undefined
    const durable = personal?.hitRates()
    if (durable && durable.size > 0) return durable
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
    for (const [modelId, entry] of Object.entries(
      openRouterStore as Record<string, { endpoints?: OpenRouterEndpoint[] }>,
    )) {
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
  // V2 Usage Yield helpers for endpoint sorting (┬º5-6, corpus ┬º5.1, median ┬º6).
  // Same standardized workload used for model ranking so endpoint order is
  // yield-consistent with the model selector (┬º32). Corpus upgrades to live
  // when Go profiles have been fetched; otherwise the pinned 16-tuple fallback.
  const getEndpointCorpus = (): Workload[] => {
    const live = tablesLatest()?.profile ?? []
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
  // ┬º5.2 tokenCost with cache-hit blending. When telemetry provides hit rate,
  // the missed portion of cachedReadTokens is priced at prompt (cache miss ΓåÆ fresh input).
  // effectiveCache = hit*cacheRead + (1-hit)*prompt. Undefined hit ΓåÆ assume 1 (no penalty for unknown).
  const endpointMedianCost = (endpoint: OpenRouterEndpoint, corpus: Workload[]): number => {
    const hit = endpoint.telemetry?.cacheHitPercent !== undefined ? endpoint.telemetry.cacheHitPercent / 100 : 1
    const effectiveCacheRead = Number.isFinite(hit)
      ? endpoint.pricing.cacheRead * hit + endpoint.pricing.prompt * (1 - hit)
      : endpoint.pricing.cacheRead
    const costs = corpus.map(
      (workload) =>
        (workload.freshInputTokens * endpoint.pricing.prompt +
          workload.cachedReadTokens * effectiveCacheRead +
          workload.outputTokens * endpoint.pricing.completion) /
        1_000_000,
    )
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
    // Cheapest ΓåÆ most expensive via V2 Usage Yield (┬º5-6): median cost across
    // the same standardized workload corpus used for model ranking. Every
    // paid upstream is priced against the SAME 16 workloads (deduped Go profiles,
    // ┬º5.1), median of per-workload costs is the comparison (┬º6). This replaces
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
      const response = await sdk().client.experimental.openrouterTelemetry.get(
        { model, timeRange: "1w" },
        { throwOnError: true },
      )
      const telemetry = response.data ?? []
      if (telemetry.length === 0) return endpoints
      const enriched = endpoints.map((entry) => {
        const value = telemetry.find(
          (item) => item.providerName === entry.providerName || item.providerSlug === entry.provider,
        )
        const cacheHitPercent =
          value && Number.isFinite(Number(value.cacheHitPercent)) ? Number(value.cacheHitPercent) : undefined
        const throughputTps =
          value && Number.isFinite(Number(value.throughputTps)) ? Number(value.throughputTps) : undefined
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
      // Re-sort with cache-hit blended yield (┬º5.2 + cache-miss as prompt). A
      // low hit rate materially raises effective cost (missed cache ΓåÆ prompt),
      // so a superficially cheap cacheRead with 60% hit can sort behind a
      // slightly pricier but 95% hit provider ΓÇö exactly the correction V2 wants
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
      // Silent best-effort ΓÇö log for diagnostics, do not toast (would spam for ~ models).
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
  const setSubmenu = (navKey: string, open: boolean, modelID: string, prefetchOpenRouter = true) => {
    if (!open) {
      if (store.submenu === navKey) setStore("submenu", "")
      return
    }
    setStore("submenu", navKey)
    if (prefetchOpenRouter) ensureOpenRouter(modelID)
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
  // it never collapses when one provider is selected ΓÇö filtering happens below.
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
  const showFavorites = () => favorites().length > 0 && (store.rail === "" || store.rail === favoritesRailKey)
  const showRecents = () => recents().length > 0 && (store.rail === "" || store.rail === recentRailKey)
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
    }
    return map
  })
  // Deliberately does NOT fall back to `usage.latest.aggregate`: that figure
  // spans every credential the account has ever used (including long-since
  // reset/exhausted ones), which is why an earlier version of this pinned at
  // 100%. Without a resolved active credential's own window we simply don't
  // know, so no bar is shown rather than a misleading one.
  const activeWindow = createMemo<ForkWindowUsage | undefined>(() => {
    const windows = forkUsage.usageWindowsFor(forkUsage.activeCredentialID())
    return windows.find((entry) => entry.label === "5h")
  })
  // Durable learner: personal $/request from the global persisted store
  // (deduped, 200/model, survives LRU). Falls back to an ephemeral scan
  // while the store is hydrating or on first run after upgrade.
  const durableCosts = createMemo(() => {
    if (!store.open) return undefined
    const durable = personal?.personalCosts()
    if (durable && durable.size > 0) return durable
    const idx = buildModelCostIndex(sync().data.message)
    if (idx.size === 0) return undefined
    const map = new Map<string, { cost: number; count: number }>()
    for (const [k, entry] of idx.entries()) map.set(k, { cost: entry.sum / entry.count, count: entry.count })
    return map.size > 0 ? map : undefined
  })
  const usageFor = (item: ModelItem) => {
    // WorkBuddy: credits-per-request funded by one account's remaining balance.
    // Checked first because these models carry no USD cost at all, so the
    // token-priced path below would render "ΓÇö" and no bar.
    if (item.provider.id === "workbuddy") {
      // Pass the full (possibly account-qualified) id: `hy4-preview@wb-<id>`
      // must be funded by that account, not by the best account overall.
      const estimate = workbuddy.forModel(item.id)
      if (!estimate) return undefined
      const account = workbuddy
        .accounts()
        .find((entry) => entry.id === estimate.account || entry.account === estimate.account)
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
    if (item.provider.id === "verdent") {
      const estimate = verdent.forModel(item.id)
      if (!estimate) return undefined
      return {
        percent: 100 - estimate.remainingPercent,
        estimatedRequests: estimate.estimatedRequests,
        remainingPercent: estimate.remainingPercent,
        tone: stretchTone(estimate.estimatedRequests) as UsageTone,
        workbuddy: estimate as unknown as WorkBuddyModelUsage,
      }
    }
    if (item.provider.id === "genspark") {
      const cost = resolveEffectiveCost(item, mergedPricingFallbackForDisplay()).cost
      const dollarPerM = (cost.input ?? 0) + (cost.output ?? 0)
      if (!(dollarPerM > 0)) return undefined
      const estimate = genspark.forModel(dollarPerM)
      if (!estimate) return undefined
      return {
        percent: 100,
        estimatedRequests: estimate.estimatedRequests,
        remainingPercent: undefined,
        tone: stretchTone(estimate.estimatedRequests) as UsageTone,
        genspark: estimate,
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
    const durableKey = `${item.provider.id}:${item.id}`
    const personalEntry = durableCosts()?.get(durableKey)
    const personalCost = personalEntry?.cost
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
    const plain = active.startsWith("fav:") ? active.slice(4) : active.startsWith("recent:") ? active.slice(7) : active
    const candidate = modelByKey().get(plain)
    if (!candidate || candidate.provider.id === "openrouter" || (accountGroupFor(candidate)?.variants.length ?? 0) > 1)
      return undefined
    if (
      store.rail !== "" &&
      store.rail !== favoritesRailKey &&
      store.rail !== recentRailKey &&
      candidate.provider.id !== store.rail
    )
      return undefined
    if (store.rail === favoritesRailKey && !props.isFavorite(candidate)) return undefined
    if (store.rail === recentRailKey && !recents().some((item) => modelKey(item) === modelKey(candidate)))
      return undefined
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
      result.push(
        ...favorites().map((item) => ({
          kind: "item" as const,
          key: favoriteKey(item),
          navKey: favoriteKey(item),
          item,
        })),
      )
      result.push({ kind: "separator", key: "separator:favorites" })
    }
    if (showRecents()) {
      result.push({ kind: "header", key: "header:recent", title: language.t("dialog.model.recent") })
      result.push(
        ...recents().map((item) => ({ kind: "item" as const, key: recentKey(item), navKey: recentKey(item), item })),
      )
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
      return (index: number) =>
        snapshot[index]?.kind === "header" ? 24 : snapshot[index]?.kind === "separator" ? 5 : 25
    },
    overscan: 8,
    get getItemKey() {
      const snapshot = renderRows()
      return (index: number) => snapshot[index]?.key ?? index
    },
    get rangeExtractor() {
      const snapshot = renderRows()
      const indexByNavKey = new Map<string, number>()
      for (let i = 0; i < snapshot.length; i++) {
        const row = snapshot[i]
        if (row.kind === "item") indexByNavKey.set(row.navKey, i)
      }
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indexes = defaultRangeExtractor(range)
        const active = store.active
        const activeIndex = indexByNavKey.get(active) ?? -1
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
      // One flush for BOTH gates. `store.open` (view) and the controller's
      // `isOpen` signal (L993, flipped via onExternalOpenChange) are separate
      // reactive layers; unbatched, opening invalidates ~19 gated memos across
      // both and re-renders between them. batch() collapses that to one pass.
      batch(() => {
        setStore({ open: true, active: initialActive(), tooltip: "", submenu: "" })
        props.onExternalOpenChange?.(true)
      })
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
    // Mirrors the open branch: both gates flip in one flush.
    batch(() => {
      setStore({ open: false, active: "", tooltip: "", submenu: "" })
      setUsageReady(false)
      props.onExternalOpenChange?.(false)
    })
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => setUsageReady(true), { timeout: 200 })
    } else {
      setTimeout(() => setUsageReady(true), 0)
    }
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
  let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (searchDebounceTimer !== undefined) clearTimeout(searchDebounceTimer)
  })
  const setSearch = (value: string) => {
    cancelHoverIntent()
    setStore({ tooltip: "", submenu: "" })
    persistedModelSearch = value
    if (searchDebounceTimer !== undefined) clearTimeout(searchDebounceTimer)
    if (value === "") {
      setStore("search", value)
      return
    }
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = undefined
      setStore("search", value)
    }, 100)
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
        if (store.submenu && event.target instanceof Element && event.target.closest("[data-model-selector-submenu]")) {
          return
        }
        handleDocumentSearchKeydown(searchRef, event, store.search, setSearch)
      },
      true,
    )
  })

  // Account selection must always land on something the app can actually
  // use. `local.model.set` writes any id, but `current()` resolves through
  // `validModel`, which requires the id to exist in the provider catalog —
  // writing an unknown id silently snaps back to the previous model. A
  // synthesized submenu can offer an account the catalog doesn't expose
  // yet (stale cache after a vault edit — quota reads the vault live,
  // Provider.list is cached at load; or a different id domain like fork
  // credentials), so resolve in order: real variant → catalog-known
  // candidate → catalog refresh + retry → provider mechanism → honest
  // automatic-routing fallback.
  // View-level (defined once, not once per row): `renderRow` runs for every
  // mounted virtual row, so a per-row `async` closure here would allocate the
  // whole resolve chain per row per render. Rows pass a tiny wrapper instead.
  const selectAccountFor = async (
    item: ModelItem,
    group: ModelGroup<ModelItem> | undefined,
    accountID: string,
  ) => {
    try {
      // 1. Real catalog variant — always routable.
      if (group?.variants.some((variant) => variant.accountID === accountID)) {
        props.selectVariant(item, accountID)
        return
      }
      // Strip any existing account suffix first so re-pinning from a
      // variant row (e.g. search results) can't stack `@a@b`. Context
      // suffixes (`@300k`) survive — same account, other window.
      const base = splitModelIDForProvider(item.id, item.provider.id).baseModelID
      const candidate = `${base}@${accountID}`
      const catalogHas = () => {
        try {
          const catalog = (local?.model.list() ?? []) as ModelItem[]
          return catalog.some((entry) => entry.provider.id === item.provider.id && entry.id === candidate)
        } catch {
          return false
        }
      }
      // 2. Hidden-but-real: the id exists in the full (unfiltered) catalog.
      if (catalogHas()) {
        props.select({ ...item, id: candidate } as ModelItem)
        return
      }
      // 2b. Stale catalog: the provider's models hook emits per-account
      // ids at load time, but accounts enrolled afterwards (vault edit)
      // only appear in live quota — never in the cached catalog. Refresh
      // the `providers` queries once and re-check; the memos rebuild
      // reactively, so a hit here also fixes the next open. If the proxy
      // itself is down this changes nothing and we fall through.
      // `useServerSync` returns an accessor (mirrors `useServerSDK`), so it
      // must be invoked before reaching `refreshProviders`.
      try {
        await serverSync?.()?.refreshProviders()
        if (catalogHas()) {
          props.select({ ...item, id: candidate } as ModelItem)
          return
        }
      } catch {
        // Fall through to the provider mechanism below.
      }
      // 3. opencode-go (and Zen) account ids are real catalog variants with a
      // `@zen-<id>` Pool suffix; no per-request activation is needed anymore —
      // the request router resolves the pinned account from that suffix
      // directly. A bare id routes to the pool default key.
      // 4. Degraded: the account can't be pinned because the provider
      // backend isn't exposing per-account models. Fall back to automatic
      // routing with an explanation instead of a silent no-op.
      props.select(item)
      showToast({
        title: language.t("dialog.model.account.routingAutomatic"),
        description: language.t("dialog.model.account.routingAutomaticDescription"),
      })
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "error",
      })
    }
  }
  // Per-provider account-usage resolvers, defined once per view. The
  // `usageForAccount` prop previously built a fresh 4-branch closure tree on
  // every MultiAccountRow render; each branch closes over view memos and is
  // only invoked when the submenu opens, so stable shared functions + a
  // per-item cached picker cut per-render allocation to an O(1) map hit.
  const usageForWorkbuddyAccount = (item: ModelItem) => (accountID: string) =>
    workbuddy.forModel(`${item.id}@${accountID}`)
  const usageForVerdentAccount = (item: ModelItem) => (accountID: string) =>
    verdent.forModel(`${item.id}@${accountID}`)
  const usageForZenAccount = (_item: ModelItem) => (accountID: string) => {
    const key = zenKeyLimits().get(accountID)
    if (!key) return undefined
    const estimatedRequests =
      key.limitEstimate !== null && key.usedObserved !== null
        ? key.limitEstimate - key.usedObserved
        : Number.POSITIVE_INFINITY
    return {
      estimatedRequests,
      ...(key.remainingPercent !== null ? { remainingPercent: key.remainingPercent } : {}),
      account: key.label,
      creditsExhausted: key.exhausted,
    }
  }
  const usageForGoAccount = (item: ModelItem) => (accountID: string) => {
    // Go windows are USD budgets (spentUSD/limitUSD), not
    // request counts — reuse the same estimator the Go row
    // path uses instead of inventing parallel math.
    const window = forkUsage.usageWindowsFor(accountID).find((entry) => entry.label === "5h")
    if (!window) return undefined
    const remainingUSD = Math.max(0, window.limitUSD - window.spentUSD)
    const remainingPercent =
      window.estimatedPercent ?? (window.limitUSD > 0 ? (remainingUSD / window.limitUSD) * 100 : undefined)
    // `estimateRequestsRemaining` returns `undefined` when the model has no
    // usable cost (unpriced and no fallback) — surface "no data" rather than
    // a mistyped `undefined` where `AccountOptionUsage` requires a number.
    const estimatedRequests = estimateRequestsRemaining(window, item.cost, undefined)
    if (estimatedRequests === undefined) return undefined
    return {
      estimatedRequests,
      ...(remainingPercent !== undefined ? { remainingPercent } : {}),
      account: accountLabels()?.get(accountID) ?? accountID,
      creditsExhausted: remainingUSD <= 0,
    }
  }
  const usageForAccountCache = new Map<string, { item: ModelItem; fn: ((accountID: string) => AccountOptionUsage | undefined) | undefined }>()
  onCleanup(() => usageForAccountCache.clear())
  const usageForAccountFor = (item: ModelItem) => {
    const key = modelKey(item)
    const cached = usageForAccountCache.get(key)
    if (cached && cached.item === item) return cached.fn
    const fn =
      item.provider.id === "workbuddy"
        ? usageForWorkbuddyAccount(item)
        : item.provider.id === "verdent"
          ? usageForVerdentAccount(item)
          : item.provider.id === "opencode"
            ? usageForZenAccount(item)
            : item.provider.id === "opencode-go"
              ? usageForGoAccount(item)
              : undefined
    usageForAccountCache.set(key, { item, fn })
    return fn
  }

  const renderRow = (item: ModelItem, navKey: string) => {
    const itemKey = modelKey(item)
    const current = () => props.current() === itemKey
    const usage = () => usageMap().get(itemKey)
    // Cross-provider + fuzzy-name pricing fallback for display: if this
    // provider's variant is unpriced but a sibling provider offers the same
    // (or a name-matched free/paid variant) model with pricing, show the
    // borrowed price (with "~" to hint it's inferred) instead of "ΓÇö" so the
    // user sees why it's sorted where it is. Sorting already uses the same
    // fallback (see mergedPricingFallback in the controller).
    const effective = () => resolveEffectiveCost(item, mergedPricingFallbackForDisplay())
    const effectiveCost = () => effective().cost
    const isBorrowed = () => effective().borrowed
    const effectiveItem = () => (isBorrowed() ? ({ ...item, cost: effectiveCost() } as ModelItem) : item)
    const group = props.groupOf(item)
    const displayGroup = accountGroupFor(item)
    // Thin per-row wrapper over the view-level `selectAccountFor` (defined
    // once above): the full resolve chain must not be reallocated per mounted
    // virtual row. See the comment on `selectAccountFor` for the guarantees.
    const selectAccount = (accountID: string) => void selectAccountFor(item, group, accountID)
    const price = () => {
      // WorkBuddy publishes no token price ΓÇö it charges credits per request.
      // Showing "ΓÇö" would waste the slot and hide the single most useful
      // number, so show the actual consumption rate instead.
      if (item.provider.id === "workbuddy") {
        const rate = workbuddy.rateFor(item.id)
        if (!rate) return "ΓÇö"
        if (rate.free) return rate.promotion ?? language.t("model.tag.free")
        return rate.rate > 0 ? `x${rate.rate}` : "ΓÇö"
      }
      if (item.provider.id === "genspark") {
        const cost = effectiveCost()
        const dollarPerM = hasPublishedPricing(cost) ? cost.input + cost.output : undefined
        const rate = genspark.rateFor(dollarPerM)
        if (!rate) return "ΓÇö"
        return `${isBorrowed() ? "~" : ""}${formatCreditsPerMillion(rate.creditsPerM)}`
      }
      return hasPublishedPricing(effectiveCost())
        ? `${isBorrowed() ? "~" : ""}${formatPricePerM(effectiveCost().input + effectiveCost().output)}`
        : "ΓÇö"
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
          priceLabel={price()}
          freeLabel={workBuddyFreeLabel(workbuddy.rateFor(item.id))}
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
    if (displayGroup && displayGroup.variants.length > 1) {
      return (
        <MultiAccountRow
          item={effectiveItem()}
          displayName={displayGroup.label}
          variants={displayGroup.variants}
          navKey={navKey}
          current={current()}
          selectedAccountID={
            current()
              ? (props.currentVariant()?.accountID ?? props.currentAccountID?.())
              : undefined
          }
          auto={displayGroup.auto}
          selectedAuto={current() && !props.currentVariant() && !props.currentAccountID?.()}
          favorited={props.isFavorite(item)}
          usage={usage()}
          priceLabel={price()}
          freeLabel={workBuddyFreeLabel(workbuddy.rateFor(item.id))}
          accountLabels={accountLabels()}
          // View-level cached picker (`usageForAccountFor`, defined once
          // above): the 4-branch closure tree used to be rebuilt per row per
          // render. O(1) map hit; resolvers read live memos when invoked.
          usageForAccount={usageForAccountFor(item)}
          rowRef={setRowRef(navKey)}
          onActivate={() => activate(navKey)}
          onDeactivate={() => deactivate(navKey)}
          onToggleFavorite={() => props.onToggleFavorite(item)}
          submenuOpen={store.submenu === navKey}
          onSubmenuChange={(open) => setSubmenu(navKey, open, item.id, false)}
          onSelectAuto={() => {
            dismiss.preventTriggerRestore()
            // Single closeWith: selectModel wraps in another closeWith, which
            // bails on `!store.open` after unmount — nesting it here silently
            // dropped every Auto selection. Call props.select directly.
            closeWith(() => props.select(item))
          }}
          onSelectAccount={(accountID) => {
            dismiss.preventTriggerRestore()
            closeWith(() => void selectAccount(accountID))
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
        <span class="min-w-0 flex-1 truncate leading-5">{stripUnlimitedSuffix(group?.label ?? item.name)}</span>
        {/* Guard the badge mount: `DeepSeekRateBadge` is a no-render `Show`
            for every non-DeepSeek row, but mounting the component still costs
            a context read + effect per virtual row. Skip it entirely unless
            this row can actually show it. */}
        <Show when={isDeepSeekPeakPricedModel(item)}>
          <DeepSeekRateBadge model={item} v2 period={deepSeekPeriod()} />
        </Show>
        <Show when={item.provider.id === "workbuddy"}>
          <WorkBuddyFreeBadge label={workBuddyFreeLabel(workbuddy.rateFor(item.id))} />
        </Show>
        <Show when={isUnlimitedModel(item)}>
          <TagV2 class="shrink-0">{language.t("model.tag.unlimited")}</TagV2>
        </Show>
        <Show when={item.provider.id !== "workbuddy" && item.provider.id !== "genspark" && isFreeModel(item as never)}>
          <TagV2 class="shrink-0">{language.t("model.tag.free")}</TagV2>
        </Show>
        <Show when={item.latest}>
          <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
        </Show>
        <ModelRowMeta
          item={item}
          usage={usage()}
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
    <MenuV2
      open={store.open}
      modal={false}
      placement={props.placement ?? "top-start"}
      gutter={6}
      onOpenChange={onOpenChange}
    >
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
                modifiers={[
                  RestrictToVerticalAxis,
                  RestrictToElement.configure({ element: () => railListRef ?? null }),
                ]}
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
                        get id() {
                          return provider.id
                        },
                        get index() {
                          return index()
                        },
                      })
                      return (
                        <TooltipV2
                          placement="right-start"
                          gutter={6}
                          openDelay={0}
                          value={<span class="text-[12px] font-[500]">{provider.name}</span>}
                        >
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
            <ScrollView data-slot="model-selector-scroll" class="min-h-0 flex-1" viewportRef={setScrollRoot}>
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
                                  fallback={
                                    <Icon name="star-filled" size="small" class="shrink-0 text-v2-state-fg-warning" />
                                  }
                                >
                                  <Icon name="clock" size="small" class="shrink-0 text-v2-text-text-faint" />
                                </Show>
                              }
                            >
                              <ProviderIcon id={row.provider!} class="size-3.5 shrink-0 opacity-70" />
                            </Show>
                            <span class="min-w-0 flex-1 truncate">{row.title}</span>
                            <Show when={row.provider === "opencode" || row.provider === "opencode-go"}>
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
                  style={
                    {
                      position: "fixed",
                      left: `${position().x}px`,
                      top: `${position().y}px`,
                      "pointer-events": "none",
                      "z-index": 1000,
                      "max-width": "calc(100vw - 30px)",
                      "max-height": "calc(100vh - 30px)",
                    } as never
                  }
                >
                  <ModelTooltip
                    model={(() => {
                      const m = item()
                      const effective = resolveEffectiveCost(m, mergedPricingFallbackForDisplay())
                      return effective.borrowed ? ({ ...m, cost: effective.cost } as never) : m
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
