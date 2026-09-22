import { createVirtualizer } from "@tanstack/solid-virtual"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { popularProviders } from "@/hooks/use-providers"
import { useProviderSettingsModels } from "@/hooks/use-provider-settings"
import { useModelVisibilitySettings } from "@/hooks/use-model-visibility-settings"
import { stripUnlimitedSuffix } from "@/utils/model-badges"
import { Persist, persisted } from "@/utils/persist"
import {
  filterSettingsModelGroups,
  flattenSettingsModelGroups,
  groupSettingsModels,
  type SettingsModelItem,
  type SettingsModelRow,
} from "./models-view"
import "./settings-v2.css"

const PROVIDER_ICON_SIZE = 16
const GROUP_ROW_HEIGHT = 28
const MODEL_ROW_HEIGHT = 34
const SEARCH_DEBOUNCE_MS = 80

type GroupRow = Extract<SettingsModelRow, { kind: "group" }>
type ModelRow = Extract<SettingsModelRow, { kind: "model" }>

function asGroupRow(row: SettingsModelRow): GroupRow | undefined {
  if (row.kind !== "group") return undefined
  return row
}

function asModelRow(row: SettingsModelRow): ModelRow | undefined {
  if (row.kind !== "model") return undefined
  return row
}

export const SettingsModelsV2: Component = () => <SettingsModelsV2Content />

const SettingsModelsV2Content: Component = () => {
  const language = useLanguage()
  const catalog = useProviderSettingsModels()
  const visibility = useModelVisibilitySettings()
  const serverSdk = useServerSDK()
  const [store, setStore] = persisted(
    Persist.serverGlobal(serverSdk().scope, "settings-v2.models.providers"),
    createStore({ collapsed: {} as Record<string, boolean> }),
  )

  const models = createMemo<SettingsModelItem[]>(() =>
    catalog.data().models.map((model) => {
      const displayName = stripUnlimitedSuffix(model.name)
      return {
        key: `${model.providerID}:${model.modelID}`,
        id: model.modelID,
        name: model.name,
        displayName,
        releaseDate: model.releaseDate,
        provider: { id: model.providerID, name: model.providerName },
        searchText: `${model.providerName} ${model.name} ${model.modelID}`.toLowerCase(),
      }
    }),
  )
  const groups = createMemo(() => groupSettingsModels(models(), popularProviders))

  const [searchInput, setSearchInput] = createSignal("")
  const [query, setQuery] = createSignal("")
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  const updateSearch = (value: string) => {
    setSearchInput(value)
    if (searchTimer !== undefined) clearTimeout(searchTimer)
    if (!value) {
      searchTimer = undefined
      setQuery("")
      return
    }
    searchTimer = setTimeout(() => {
      searchTimer = undefined
      setQuery(value)
    }, SEARCH_DEBOUNCE_MS)
  }

  onCleanup(() => {
    if (searchTimer !== undefined) clearTimeout(searchTimer)
  })

  const filteredGroups = createMemo(() => filterSettingsModelGroups(groups(), query()))
  const searching = createMemo(() => query().trim().length > 0)
  const modelCount = createMemo(() => filteredGroups().reduce((count, group) => count + group.items.length, 0))
  const rows = createMemo(() => flattenSettingsModelGroups(filteredGroups(), store.collapsed, searching()))

  const [body, setBody] = createSignal<HTMLDivElement>()
  const scrollMargin = () => body()?.offsetTop ?? 0
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rows().length
    },
    getScrollElement: () => {
      const parent = body()?.parentElement
      return parent instanceof HTMLDivElement ? parent : null
    },
    initialRect: { width: 720, height: 600 },
    get estimateSize() {
      const snapshot = rows()
      return (index: number) => (snapshot[index]?.kind === "group" ? GROUP_ROW_HEIGHT : MODEL_ROW_HEIGHT)
    },
    get getItemKey() {
      const snapshot = rows()
      return (index: number) => snapshot[index]?.key ?? index
    },
    get scrollMargin() {
      return scrollMargin()
    },
    overscan: 10,
  })
  // Solid's <For> keys objects by identity, while the virtualizer may emit
  // fresh VirtualItem objects on scroll. Drive the DOM by stable row keys so
  // rows that stay in the window stay mounted instead of remounting every frame.
  const rowByKey = createMemo(() => new Map(rows().map((row) => [row.key, row] as const)))
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [String(item.key), item] as const)),
  )
  const virtualRowKeys = createMemo(() => virtualizer.getVirtualItems().map((item) => String(item.key)))

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={searchInput()}
            onInput={(event) => updateSearch(event.currentTarget.value)}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("dialog.model.search.placeholder")}
          />
          <Show when={searchInput()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => updateSearch("")}
            />
          </Show>
        </div>
      </div>

      <div ref={setBody} class="settings-v2-tab-body settings-v2-models settings-v2-models-virtual">
        <Show
          when={!catalog.query.isPending}
          fallback={
            <div class="settings-v2-models-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={modelCount() > 0}
            fallback={
              <div class="settings-v2-models-status">
                <span>{language.t("dialog.model.empty")}</span>
                <Show when={searchInput()}>
                  <span class="settings-v2-models-status-filter">&quot;{searchInput()}&quot;</span>
                </Show>
              </div>
            }
          >
            <div
              class="settings-v2-models-virtual-spacer"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
              data-model-count={modelCount()}
            >
              <For each={virtualRowKeys()}>
                {(key) => (
                  <Show when={virtualItemByKey().get(key)}>
                    {(virtualRow) => (
                      <Show when={rowByKey().get(key)}>
                        {(row) => (
                          <div
                            class="settings-v2-models-virtual-item"
                            style={{
                              height: `${virtualRow().size}px`,
                              transform: `translateY(${virtualRow().start - scrollMargin()}px)`,
                            }}
                          >
                            <Show when={asGroupRow(row())}>
                              {(groupRow) => (
                                <div class="settings-v2-models-group-row">
                                  <button
                                    type="button"
                                    class="settings-v2-models-group-trigger"
                                    aria-expanded={groupRow().expanded}
                                    disabled={groupRow().searching}
                                    onClick={() => setStore("collapsed", groupRow().category, groupRow().expanded)}
                                  >
                                    <span class="settings-v2-models-group-chevron">
                                      <Show
                                        when={groupRow().expanded}
                                        fallback={
                                          <svg width="5" height="6" viewBox="0 0 5 6" fill="none" aria-hidden="true">
                                            <path
                                              d="M0.75194 5.31663C0.41861 5.51103 0 5.27063 0 4.88473V0.500754C0 0.114854 0.41861 -0.125577 0.75194 0.0688635L4.5096 2.26084C4.8404 2.45378 4.8404 2.93168 4.5096 3.12462L0.75194 5.31663Z"
                                              fill="currentColor"
                                            />
                                          </svg>
                                        }
                                      >
                                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                          <path
                                            d="M5.37624 6.75194C5.18184 6.41861 5.42224 6 5.80814 6H10.1921C10.578 6 10.8184 6.41861 10.624 6.75194L8.43203 10.5096C8.23909 10.8404 7.76119 10.8404 7.56825 10.5096L5.37624 6.75194Z"
                                            fill="currentColor"
                                          />
                                        </svg>
                                      </Show>
                                    </span>
                                    <span class="settings-v2-models-group-label">
                                      <ProviderIcon
                                        id={groupRow().category}
                                        width={PROVIDER_ICON_SIZE}
                                        height={PROVIDER_ICON_SIZE}
                                        class="settings-v2-models-provider-icon shrink-0"
                                      />
                                      <span class="settings-v2-section-title">{groupRow().name}</span>
                                    </span>
                                  </button>
                                </div>
                              )}
                            </Show>

                            <Show when={asModelRow(row())}>
                              {(modelRow) => (
                                <div
                                  class="settings-v2-models-model-row"
                                  data-first={modelRow().first ? "" : undefined}
                                  data-last={modelRow().last ? "" : undefined}
                                >
                                  <span class="settings-v2-models-model-name" title={modelRow().item.name}>
                                    {modelRow().item.displayName}
                                  </span>
                                  <Switch
                                    checked={visibility.visible({
                                      providerID: modelRow().item.provider.id,
                                      modelID: modelRow().item.id,
                                      releaseDate: modelRow().item.releaseDate,
                                    })}
                                    onChange={(checked) =>
                                      visibility.setVisibility(
                                        {
                                          providerID: modelRow().item.provider.id,
                                          modelID: modelRow().item.id,
                                        },
                                        checked,
                                      )
                                    }
                                    hideLabel
                                  >
                                    {modelRow().item.displayName}
                                  </Switch>
                                </div>
                              )}
                            </Show>
                          </div>
                        )}
                      </Show>
                    )}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </>
  )
}
