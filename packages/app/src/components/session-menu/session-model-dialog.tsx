import { createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ModelTooltip, formatCostPerMillion } from "@/components/model-tooltip"
import { useLanguage } from "@/context/language"
import { ModelsProvider, useModels } from "@/context/models"
import { useGlobal } from "@/context/global"
import { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { createPromptSession } from "@/context/prompt-state"
import { showToast } from "@/utils/toast"
import { popularProviders } from "@/hooks/use-providers"
import { isUnlimitedModel, stripUnlimitedSuffix } from "@/utils/model-badges"
import { getOpenRouterEndpoints, type OpenRouterEndpoint } from "@/utils/openrouter-endpoints"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"

const favoritesRailKey = "favorites"

export function DialogSessionModelPicker(props: { session: Session; server?: ServerConnection.Key }) {
  // Wrap inner content with a directory-scoped ModelsProvider so that
  // useModels().list() returns models for *this* session's directory,
  // not the current global directory (which is empty at the titlebar).
  // This matches the v2 prompt input's model selector which is always
  // directory-scoped, and fixes the "No model results / 0 models" empty
  // state seen in image-1.png.
  return (
    <ModelsProvider directory={() => props.session.directory}>
      <DialogSessionModelPickerInner session={props.session} server={props.server} />
    </ModelsProvider>
  )
}

function DialogSessionModelPickerInner(props: { session: Session; server?: ServerConnection.Key }) {
  const language = useLanguage()
  const models = useModels()
  const global = useGlobal()
  const dialog = useDialog()
  const [filter, setFilter] = createSignal("")
  const [rail, setRail] = createSignal<string>("")
  const [active, setActive] = createSignal<string>("")

  const allModels = createMemo(() => models.list())
  const filtered = createMemo(() => {
    const q = filter().toLowerCase().trim()
    const list = allModels().filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
    const searched = q ? list.filter((m) => `${m.provider.name} ${m.name} ${m.id}`.toLowerCase().includes(q)) : list
    return searched
  })

  const railProviders = createMemo(() => {
    const seen = new Map<string, string>()
    for (const item of filtered()) {
      if (!seen.has(item.provider.id)) seen.set(item.provider.id, item.provider.name)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  })

  const railModels = createMemo(() => {
    if (rail() === "" || rail() === favoritesRailKey) return filtered()
    return filtered().filter((item) => item.provider.id === rail())
  })

  const favorites = createMemo(() =>
    filtered().filter((item) => models.favorite.isFavorite({ providerID: item.provider.id, modelID: item.id })),
  )
  const showFavorites = () => favorites().length > 0 && (rail() === "" || rail() === favoritesRailKey)

  // Group by provider for display, similar to ModelSelectorPopoverV2View
  const groups = createMemo(() => {
    const byProvider = new Map<string, typeof filtered extends () => infer T ? T : never>()
    for (const item of railModels()) {
      const g = byProvider.get(item.provider.id)
      if (g) (g as any).push(item)
      else byProvider.set(item.provider.id, [item] as any)
    }
    return Array.from(byProvider, ([category, items]) => ({ category, items: items as any })).sort((a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      if (aIndex >= 0 && bIndex < 0) return -1
      if (aIndex < 0 && bIndex >= 0) return 1
      if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex
      return a.items[0].provider.name.localeCompare(b.items[0].provider.name)
    })
  })

  const select = (item: ReturnType<typeof models.list>[number]) => {
    const conn = props.server ? global.servers.list().find((c) => ServerConnection.key(c) === props.server) : undefined
    const scope = conn ? global.ensureServerCtx(conn).sdk.scope : undefined
    if (!scope) {
      showToast({ title: language.t("common.requestFailed"), variant: "error" })
      return
    }
    try {
      const ps = createPromptSession(scope, { dir: base64Encode(props.session.directory), id: props.session.id })
      ps.model.set({ providerID: item.provider.id, modelID: item.id } as any)
      // also push to recent via models
      models.recent.push({ providerID: item.provider.id, modelID: item.id })
      showToast({ title: language.t("command.model.choose"), variant: "success" })
      dialog.close()
    } catch (err) {
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
        variant: "error",
      })
    }
  }

  const isFavorite = (item: ReturnType<typeof models.list>[number]) =>
    models.favorite.isFavorite({ providerID: item.provider.id, modelID: item.id })
  const toggleFavorite = (item: ReturnType<typeof models.list>[number]) =>
    models.favorite.toggle({ providerID: item.provider.id, modelID: item.id })

  // OpenRouter handling (same as dialog-select-model.tsx) — uses global server SDK, not directory-scoped useSDK (which is unavailable at titlebar)
  const [openRouterStore, setOpenRouterStore] = createSignal<
    Record<string, { loading: boolean; endpoints?: OpenRouterEndpoint[] }>
  >({})
  const ensureOpenRouter = (modelId: string) => {
    const store = openRouterStore()
    if (store[modelId]?.loading || store[modelId]?.endpoints !== undefined) return
    const conn = props.server
      ? (global.servers.list().find((c) => ServerConnection.key(c) === props.server) ?? global.servers.list()[0])
      : global.servers.list()[0]
    const sdk = conn ? global.ensureServerCtx(conn).sdk : undefined
    if (!sdk) return
    setOpenRouterStore((prev) => ({ ...prev, [modelId]: { loading: true, endpoints: undefined } }))
    void getOpenRouterEndpoints(modelId, async (m) => {
      const res = await (sdk as any).client.experimental.openrouterEndpoints.get(
        { model: m } as any,
        { throwOnError: true } as any,
      )
      return (res.data as any[]).map((e: any) => ({
        providerName: e.providerName,
        tag: e.tag,
        provider: e.provider,
        pricing: {
          prompt: Number(e.pricing.prompt) * 1_000_000,
          completion: Number(e.pricing.completion) * 1_000_000,
          cacheRead: Number(e.pricing.cacheRead) * 1_000_000,
        },
        uptime: e.uptime !== undefined ? Number(e.uptime) : undefined,
      }))
    }).then((result) => {
      setOpenRouterStore((prev) => ({ ...prev, [modelId]: { loading: false, endpoints: result ?? undefined } }))
    })
  }

  // For tooltip positioning, we use simple hover with Tooltip component
  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="w-full max-w-[720px] h-[520px] flex flex-col p-0 overflow-hidden"
    >
      <div class="flex h-full min-h-0">
        {/* Left rail - provider filter + favorites */}
        <ScrollView class="w-[140px] shrink-0 border-r border-v2-border-border-muted bg-v2-background-bg-layer-01">
          <div class="p-2 flex flex-col gap-1">
            <button
              type="button"
              class={`w-full rounded-md px-2 py-1 text-left text-[12px] ${rail() === "" ? "bg-v2-background-bg-layer-03 text-v2-text-text-base" : "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"}`}
              onClick={() => setRail("")}
            >
              All
            </button>
            <Show when={favorites().length > 0}>
              <button
                type="button"
                class={`w-full rounded-md px-2 py-1 text-left text-[12px] flex items-center gap-1 ${rail() === favoritesRailKey ? "bg-v2-background-bg-layer-03 text-v2-text-text-base" : "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"}`}
                onClick={() => setRail(favoritesRailKey)}
              >
                <Icon name="star" size="small" class="size-3" /> {language.t("dialog.model.favorites")}
              </button>
            </Show>
            <div class="my-1 h-px bg-v2-border-border-muted" />
            <For each={railProviders()}>
              {(p) => (
                <button
                  type="button"
                  class={`w-full rounded-md px-2 py-1 text-left text-[12px] truncate ${rail() === p.id ? "bg-v2-background-bg-layer-03 text-v2-text-text-base" : "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"}`}
                  onClick={() => setRail(p.id)}
                  title={p.name}
                >
                  {p.name}
                </button>
              )}
            </For>
          </div>
        </ScrollView>

        {/* Main content */}
        <div class="flex flex-1 flex-col min-w-0">
          <div class="p-3 border-b border-v2-border-border-muted flex items-center gap-2">
            <div class="relative flex-1">
              <Icon
                name="magnifying-glass"
                size="small"
                class="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-v2-icon-icon-muted"
              />
              <input
                class="w-full rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 pl-7 pr-3 py-1.5 text-[13px] outline-none focus:border-v2-border-border-focus"
                placeholder={language.t("dialog.model.search.placeholder")}
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                autofocus
              />
            </div>
          </div>

          <ScrollView class="flex-1 min-h-0">
            <div class="p-2 flex flex-col gap-1">
              <Show when={rail() === favoritesRailKey}>
                <div class="px-2 py-1 text-[11px] font-[600] uppercase tracking-wide text-v2-text-text-faint">
                  {language.t("dialog.model.favorites")}
                </div>
                <For
                  each={favorites()}
                  fallback={
                    <div class="px-3 py-4 text-center text-sm text-v2-text-text-muted">
                      {language.t("dialog.model.empty")}
                    </div>
                  }
                >
                  {(item) => (
                    <ModelRow
                      item={item}
                      isFavorite={isFavorite(item)}
                      onToggleFavorite={() => toggleFavorite(item)}
                      onSelect={() => select(item)}
                      onHover={() => setActive(`${item.provider.id}:${item.id}`)}
                      isActive={active() === `${item.provider.id}:${item.id}`}
                      ensureOpenRouter={ensureOpenRouter}
                      openRouterEndpoints={openRouterStore()[item.id]?.endpoints}
                    />
                  )}
                </For>
              </Show>

              <Show when={rail() !== favoritesRailKey}>
                <For
                  each={groups()}
                  fallback={
                    <div class="px-3 py-8 text-center text-sm text-v2-text-text-muted">
                      {language.t("dialog.model.empty")}
                    </div>
                  }
                >
                  {(group) => (
                    <>
                      <div class="px-2 py-1 text-[11px] font-[600] uppercase tracking-wide text-v2-text-text-faint">
                        {group.items[0].provider.name}
                      </div>
                      <For each={group.items}>
                        {(item) => (
                          <ModelRow
                            item={item}
                            isFavorite={isFavorite(item)}
                            onToggleFavorite={() => toggleFavorite(item)}
                            onSelect={() => select(item)}
                            onHover={() => setActive(`${item.provider.id}:${item.id}`)}
                            isActive={active() === `${item.provider.id}:${item.id}`}
                            ensureOpenRouter={ensureOpenRouter}
                            openRouterEndpoints={openRouterStore()[item.id]?.endpoints}
                          />
                        )}
                      </For>
                    </>
                  )}
                </For>
              </Show>
            </div>
          </ScrollView>

          <div class="border-t border-v2-border-border-muted p-2 flex justify-between items-center">
            <button
              type="button"
              class="text-[12px] text-v2-text-text-muted hover:text-v2-text-text-base"
              onClick={() => {
                void import("@/components/dialog-manage-models").then((m) => {
                  void dialog.show(() => <m.DialogManageModelsV2 />)
                })
              }}
            >
              {language.t("dialog.model.manage")}
            </button>
            <span class="text-[11px] text-v2-text-text-faint">{filtered().length} models</span>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function ModelRow(props: {
  item: ReturnType<ReturnType<typeof import("@/context/models").useModels>["list"]>[number]
  isFavorite: boolean
  onToggleFavorite: () => void
  onSelect: () => void
  onHover: () => void
  isActive: boolean
  ensureOpenRouter?: (id: string) => void
  openRouterEndpoints?: OpenRouterEndpoint[]
}) {
  const isFree = props.item.provider.id === "opencode" && (!props.item.cost || props.item.cost.input === 0)
  const price = `${formatCostPerMillion(props.item.cost.input)}/M`
  const isOpenRouter = props.item.provider.id === "openrouter"

  return (
    <Tooltip
      placement="right-start"
      gutter={12}
      openDelay={400}
      value={
        <ModelTooltip
          model={props.item as any}
          latest={(props.item as any).latest}
          free={isFree}
          unlimited={isUnlimitedModel(props.item as any)}
          v2
        />
      }
    >
      <div
        class={`group/row flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-v2-overlay-simple-overlay-hover ${props.isActive ? "bg-v2-overlay-simple-overlay-hover" : ""}`}
        onMouseEnter={() => {
          props.onHover()
          if (isOpenRouter) props.ensureOpenRouter?.(props.item.id)
        }}
      >
        <ProviderIcon id={props.item.provider.id} class="size-3.5 shrink-0 opacity-60" />
        <span class="min-w-0 flex-1 truncate text-[13px] leading-5">{stripUnlimitedSuffix(props.item.name)}</span>
        <Show when={(props.item as any).latest}>
          <Tag class="shrink-0 text-[10px]">{props.item.provider.id === "opencode" ? "Latest" : ""}</Tag>
        </Show>
        <span class="shrink-0 text-[11px] tabular-nums text-v2-text-text-faint">{price}</span>
        <button
          type="button"
          class={`flex size-5 shrink-0 items-center justify-center rounded-sm ${props.isFavorite ? "text-v2-state-fg-warning" : "text-v2-icon-icon-muted hover:text-v2-icon-icon-base"}`}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleFavorite()
          }}
          aria-label={props.isFavorite ? "Remove favorite" : "Add favorite"}
        >
          <Icon name={props.isFavorite ? "star-filled" : "star"} size="small" />
        </button>
        <button
          type="button"
          class="flex-1 absolute inset-0"
          onClick={props.onSelect}
          aria-label={`Select ${props.item.name}`}
        />
      </div>
    </Tooltip>
  )
}
