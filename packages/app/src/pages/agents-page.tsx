
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"


import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createQuery } from "@tanstack/solid-query"
import { SettingsModelPickerV2 } from "@/components/settings-v2/parts/model-picker"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { pathKey } from "@/utils/path-key"
import "./agents-page.css"
import {
  EDITABLE_NATIVE_AGENT_DEFINITIONS,
  RESERVED_NATIVE_AGENT_IDS,
  agentConfigValue,
  agentExposure,
  customAgentIDs,
  draftFingerprint,
  draftFromAgentConfig,
  draftValidation,
  isEditableNativeAgent,
  nativeAgentMode,
  type AgentStudioConfig,
  type AgentStudioDraft,
  type AgentStudioMode,
} from "./agents/agent-studio-model"

type StudioState = {
  selected: string
  creating: boolean
  search: string
  filter: AgentFilter
  draft: AgentStudioDraft
  baseline: string
  promptEditing: boolean
  saving: boolean
}

type AgentFilter = "all" | "builtin" | "custom"

const emptyDraft = draftFromAgentConfig({ id: "build", nativeMode: "primary" })

const modeKeys = {
  primary: {
    label: "agents.editor.mode.primary",
    description: "agents.editor.mode.primary.description",
  },
  subagent: {
    label: "agents.editor.mode.subagent",
    description: "agents.editor.mode.subagent.description",
  },
  all: {
    label: "agents.editor.mode.all",
    description: "agents.editor.mode.all.description",
  },
} as const

/**
 * One description per built-in, keyed by the same ids the shared agent contract
 * declares. A key that is missing would silently fall back to a neighbour's
 * copy, so unknown ids resolve to the generic subtitle instead.
 */
const NATIVE_DESCRIPTION_KEYS: Record<string, string> = {
  build: "agents.builtin.build.description",
  plan: "agents.builtin.plan.description",
  yolo: "agents.builtin.yolo.description",
  general: "agents.builtin.general.description",
  explore: "agents.builtin.explore.description",
  compaction: "agents.builtin.compaction.description",
  title: "agents.builtin.title.description",
  "prompt-revisor": "agents.builtin.prompt-revisor.description",
  summary: "agents.builtin.summary.description",
}

function nativeDescriptionKey(id: string) {
  return NATIVE_DESCRIPTION_KEYS[id] as "agents.builtin.build.description" | undefined
}

function ConfirmAgentAction(props: {
  title: string
  description: string
  action: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({ busy: false })

  const confirm = async () => {
    if (state.busy) return
    setState("busy", true)
    try {
      await props.onConfirm()
      dialog.close()
    } finally {
      setState("busy", false)
    }
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose={state.busy}>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="max-w-[440px] px-4 py-3">
        <p class="text-[12px] leading-5 text-v2-text-text-muted">{props.description}</p>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="neutral" disabled={state.busy} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          type="button"
          variant={props.danger ? "danger" : "contrast"}
          disabled={state.busy}
          onClick={() => void confirm()}
        >
          {props.action}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

function SectionHeader(props: { title: string; description?: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-0.5">
      <h2 class="text-[11px] font-[620] leading-4 tracking-[-0.01em] text-v2-text-text-strong">{props.title}</h2>
      <Show when={props.description}>
        <p class="max-w-[720px] text-[10px] leading-3.5 text-v2-text-text-faint">{props.description}</p>
      </Show>
    </div>
  )
}

function FieldLabel(props: { children: unknown; hint?: string }) {
  return (
    <div class="mb-1 flex items-center justify-between gap-2">
      <span class="text-[10px] font-[560] leading-none text-v2-text-text-muted">{props.children as any}</span>
      <Show when={props.hint}>
        <span class="text-[9px] leading-none text-v2-text-text-faint">{props.hint}</span>
      </Show>
    </div>
  )
}

function AgentRow(props: {
  id: string
  title: string
  subtitle: string
  badge?: "override"
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      class="group relative flex min-w-0 items-center gap-1.5 rounded-[4px] px-1.5 py-1 text-left outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:ring-1 focus-visible:ring-v2-border-border-focus"
      classList={{ "bg-v2-overlay-simple-overlay-hover text-v2-text-text-strong": props.active }}
      aria-current={props.active ? "true" : undefined}
      onClick={props.onSelect}
    >
      <Show when={props.active}>
        <span class="absolute inset-y-1 left-0 w-px rounded-full bg-v2-border-border-focus" />
      </Show>
      <span class="flex size-5 shrink-0 items-center justify-center rounded-[4px]">
        <Icon name="brain" size="small" class={props.active ? "text-v2-icon-icon-base" : "text-v2-icon-icon-muted"} />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1">
          <span class="truncate text-[10px] font-[570] leading-3.5 text-v2-text-text-base">{props.title}</span>
          <Show when={props.badge === "override"}>
            <span class="size-1 shrink-0 rounded-full bg-v2-icon-icon-info" />
          </Show>
        </span>
        <span class="block truncate text-[9px] leading-3 text-v2-text-text-faint">{props.subtitle}</span>
      </span>
    </button>
  )
}

export function AgentsPage() {
  const language = useLanguage()
  const serverSync = useServerSync()
  const dialog = useDialog()
  const [searchParams, setSearchParams] = useSearchParams<{ selected?: string; directory?: string }>()

  const configAgents = createMemo(
    () => (serverSync().data.config.agent ?? {}) as Record<string, AgentStudioConfig | undefined>,
  )

  const initialSelected = () => {
    const requested = searchParams.selected?.trim()
    if (requested && (isEditableNativeAgent(requested) || customAgentIDs(configAgents()).includes(requested))) {
      return requested
    }
    return "build"
  }

  const [state, setState] = createStore<StudioState>({
    selected: initialSelected(),
    creating: false,
    search: "",
    filter: "all",
    draft: emptyDraft,
    baseline: "",
    promptEditing: false,
    saving: false,
  })

  // Global config owns overrides, but shipped built-in prompts are owned by the
  // resolved Agent catalog. Read one concrete workspace catalog so Studio can
  // display those inherited values without copying prompt text into the UI.
  const sourceDirectory = createMemo(
    () =>
      searchParams.directory?.trim() ||
      serverSync().data.project.find((project) => project.id !== "global" && project.worktree !== "/")?.worktree,
  )
  const runtimeAgents = createQuery(() => {
    const directory = sourceDirectory() ?? ""
    const options = serverSync().queryOptions.agents(pathKey(directory))
    return {
      ...options,
      // Agent Studio requires the resolved prompt-bearing catalog. Keep this
      // cache lane distinct from any already-hydrated composer/bootstrap agent
      // query so a stale legacy result cannot leave the editor blank after a
      // hybrid server upgrades to the current agent endpoint.
      queryKey: [...options.queryKey, "studio-resolved-v2"] as typeof options.queryKey,
      enabled: !!directory,
      staleTime: 0,
      refetchOnMount: "always",
      placeholderData: [],
    }
  })

  const selectedNative = createMemo(() => !state.creating && isEditableNativeAgent(state.selected))
  const selectedConfig = createMemo(() => (state.creating ? undefined : configAgents()[state.selected]))
  const runtimeAgent = createMemo(() => runtimeAgents.data?.find((item) => item.name === state.selected))
  const inheritedPrompt = createMemo(() => {
    if (state.creating) return ""
    if (typeof selectedConfig()?.prompt === "string") return ""
    return runtimeAgent()?.prompt ?? ""
  })
  const promptValue = createMemo(() => (state.promptEditing ? state.draft.prompt : inheritedPrompt()))
  const validation = createMemo(() => draftValidation(state.draft))
  const dirty = createMemo(() => state.creating || draftFingerprint(state.draft) !== state.baseline)
  const hasNativeOverride = createMemo(
    () => selectedNative() && !!selectedConfig() && Object.keys(selectedConfig() ?? {}).length > 0,
  )

  const idCollision = createMemo(() => {
    if (!state.creating) return false
    const id = state.draft.id.trim()
    if (!id) return false
    return RESERVED_NATIVE_AGENT_IDS.has(id) || configAgents()[id] !== undefined
  })
  const numbersValid = createMemo(() => validation().temperature && validation().topP && validation().steps)
  const canSave = createMemo(
    () => dirty() && validation().id && !idCollision() && numbersValid() && !state.saving,
  )

  const loadAgent = (id: string) => {
    const nativeMode = nativeAgentMode(id)
    const config = configAgents()[id]
    const draft = draftFromAgentConfig({ id, config, nativeMode })
    setState({
      selected: id,
      creating: false,
      draft,
      baseline: draftFingerprint(draft),
      promptEditing: typeof config?.prompt === "string",
    })
    setSearchParams({ selected: id, directory: searchParams.directory }, { replace: true })
  }

  const discardThen = (next: () => void) => {
    if (!dirty()) {
      next()
      return
    }
    dialog.show(() => (
      <ConfirmAgentAction
        title={language.t("agents.dialog.discard.title")}
        description={language.t("agents.dialog.discard.description")}
        action={language.t("agents.dialog.discard.action")}
        danger
        onConfirm={next}
      />
    ))
  }

  const selectAgent = (id: string) => {
    if (!state.creating && state.selected === id) return
    discardThen(() => loadAgent(id))
  }

  const newAgent = () => {
    discardThen(() => {
      const draft = draftFromAgentConfig({ id: "" })
      setState({
        selected: "",
        creating: true,
        draft,
        baseline: draftFingerprint(draft),
        promptEditing: true,
      })
      setSearchParams({ selected: undefined, directory: searchParams.directory }, { replace: true })
    })
  }

  // Explicit save only. Autosaving every keystroke would push a global config
  // write — and therefore an instance dispose plus a workspace catalog reload —
  // per character typed into a system prompt.
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() !== "s") return
      if (!canSave()) return
      event.preventDefault()
      void save()
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  createEffect(() => {
    const agents = configAgents()
    if (state.creating || dirty()) return
    const id = state.selected || initialSelected()
    const nativeMode = nativeAgentMode(id)
    const next = draftFromAgentConfig({ id, config: agents[id], nativeMode })
    const fingerprint = draftFingerprint(next)
    if (fingerprint === state.baseline) return
    setState({
      draft: next,
      baseline: fingerprint,
      promptEditing: typeof agents[id]?.prompt === "string",
    })
  })

  // A routed Manage-agents action can target an already-mounted Studio tab.
  // Follow that query selection only while the current draft is clean: routing
  // must never become an implicit discard mechanism for unsaved agent edits.
  createEffect(() => {
    const requested = searchParams.selected?.trim()
    if (!requested || state.creating || dirty()) return
    if (requested === state.selected) return
    if (!isEditableNativeAgent(requested) && !customAgentIDs(configAgents()).includes(requested)) return
    loadAgent(requested)
  })

  createEffect(() => {
    if (state.baseline) return
    loadAgent(initialSelected())
  })

  const save = async () => {
    if (!canSave()) return
    const id = state.draft.id.trim()
    const native = selectedNative()
    setState("saving", true)
    try {
      await serverSync().updateAgentConfig({
        id,
        value: agentConfigValue(configAgents()[id], state.draft, { native }),
      })
      const next = { ...state.draft, id }
      setState({
        selected: id,
        creating: false,
        draft: next,
        baseline: draftFingerprint(next),
        promptEditing: !!next.prompt.trim(),
      })
      setSearchParams({ selected: id, directory: searchParams.directory }, { replace: true })
      showToast({
        title: language.t("agents.editor.saveSuccess"),
        description: language.t("agents.editor.saveSuccess.description", { agent: id }),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("agents.editor.saveFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setState("saving", false)
    }
  }

  const removeConfigEntry = async (id: string) => {
    await serverSync().updateAgentConfig({ id, value: null })
  }

  const resetNative = async () => {
    if (!selectedNative()) return
    const id = state.selected
    await removeConfigEntry(id)
    const next = draftFromAgentConfig({ id, nativeMode: nativeAgentMode(id) })
    setState({ draft: next, baseline: draftFingerprint(next), promptEditing: false })
    showToast({ title: language.t("agents.editor.resetSuccess") })
  }

  const deleteCustom = () => {
    if (state.creating) {
      loadAgent("build")
      return
    }
    const id = state.selected
    dialog.show(() => (
      <ConfirmAgentAction
        title={language.t("agents.dialog.delete.title", { agent: id })}
        description={language.t("agents.dialog.delete.description")}
        action={language.t("agents.dialog.delete.action")}
        danger
        onConfirm={async () => {
          await removeConfigEntry(id)
          loadAgent("build")
          showToast({
            title: language.t("agents.editor.deleteSuccess"),
            description: language.t("agents.editor.deleteSuccess.description", { agent: id }),
          })
        }}
      />
    ))
  }

  const query = createMemo(() => state.search.trim().toLowerCase())
  const matchesQuery = (id: string, description?: string) => {
    const q = query()
    if (!q) return true
    return (
      id.toLowerCase().includes(q) ||
      (typeof description === "string" && description.toLowerCase().includes(q)) ||
      language.t((nativeDescriptionKey(id) ?? "agents.subtitle") as "agents.subtitle").toLowerCase().includes(q)
    )
  }

  const builtinEntries = createMemo(() =>
    EDITABLE_NATIVE_AGENT_DEFINITIONS.filter((item) => {
      if (state.filter === "custom") return false
      return matchesQuery(item.id)
    }),
  )
  const customEntries = createMemo(() =>
    customAgentIDs(configAgents()).filter((id) => {
      if (state.filter === "builtin") return false
      return matchesQuery(id, configAgents()[id]?.description)
    }),
  )
  const listEmpty = createMemo(() => builtinEntries().length === 0 && customEntries().length === 0)

  const modeOption = (mode: AgentStudioMode) => modeKeys[mode]
  const exposure = createMemo(() => agentExposure({ mode: state.draft.mode, hidden: state.draft.hidden }))
  const showMentionsToggle = createMemo(() => !selectedNative() && state.draft.mode !== "primary")

  return (
    <div
      data-component="agents-page"
      class="m-2 flex min-h-0 min-w-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
    >
      <aside class="flex w-[232px] min-w-[216px] shrink-0 flex-col border-r border-v2-border-border-muted/70 bg-v2-background-bg-layer-01">
        <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-v2-border-border-muted/70 px-2">
          <Icon name="brain" size="small" class="text-v2-icon-icon-muted" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-[620] leading-4 text-v2-text-text-strong">
              {language.t("agents.title")}
            </div>
          </div>
          <span class="shrink-0 text-[9px] leading-3 text-v2-text-text-faint">{language.t("agents.scope.global")}</span>
          <IconButtonV2
            type="button"
            size="small"
            variant="ghost-muted"
            icon={<Icon name="plus" />}
            aria-label={language.t("agents.new")}
            onClick={newAgent}
          />
        </div>

        <div class="shrink-0 border-b border-v2-border-border-muted/70 p-1.5">
          <div class="agent-studio-search">
            <Icon name="search" size="small" class="agent-studio-search-icon" />
            <input
              class="agent-studio-search-input"
              type="search"
              value={state.search}
              placeholder={language.t("agents.search")}
              aria-label={language.t("agents.search")}
              spellcheck={false}
              autocomplete="off"
              onInput={(event) => setState("search", event.currentTarget.value)}
            />
          </div>
          <div class="mt-1 flex h-6 items-end gap-3 border-b border-v2-border-border-muted/50 px-1">
            <For each={["all", "builtin", "custom"] as AgentFilter[]}>
              {(value) => (
                <button
                  type="button"
                  class="relative h-6 px-0.5 text-[9px] font-[560] leading-3 text-v2-text-text-muted transition-colors hover:text-v2-text-text-base"
                  classList={{
                    "text-v2-text-text-strong after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-v2-border-border-focus":
                      state.filter === value,
                  }}
                  aria-pressed={state.filter === value}
                  onClick={() => setState("filter", value)}
                >
                  {language.t(`agents.filter.${value}` as "agents.filter.all")}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="relative min-h-0 flex-1">
          <ScrollView class="h-full [&_.scroll-view__viewport]:overscroll-contain">
            <div class="flex flex-col gap-2 p-1.5">
              <Show when={builtinEntries().length > 0}>
                <div>
                  <div class="flex h-5 items-center px-1.5 text-[8px] font-[650] uppercase tracking-[0.12em] text-v2-text-text-faint">
                    {language.t("agents.group.builtin")}
                  </div>
                  <div class="flex flex-col gap-px">
                    <For each={builtinEntries()}>
                      {(item) => (
                        <AgentRow
                          id={item.id}
                          title={item.id}
                          subtitle={language.t(modeOption(item.mode).label)}
                          badge={
                            configAgents()[item.id] && Object.keys(configAgents()[item.id] ?? {}).length > 0
                              ? "override"
                              : undefined
                          }
                          active={!state.creating && state.selected === item.id}
                          onSelect={() => selectAgent(item.id)}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <div>
                <div class="flex h-5 items-center justify-between px-1.5">
                  <span class="text-[8px] font-[650] uppercase tracking-[0.12em] text-v2-text-text-faint">
                    {language.t("agents.group.custom")}
                  </span>
                  <span class="text-[8px] tabular-nums text-v2-text-text-faint">{customEntries().length}</span>
                </div>
                <div class="flex flex-col gap-px">
                  <Show when={state.creating}>
                    <button
                      type="button"
                      class="flex min-w-0 items-center gap-1.5 rounded-[4px] bg-v2-overlay-simple-overlay-hover px-1.5 py-1 text-left"
                    >
                      <span class="flex size-5 shrink-0 items-center justify-center rounded-[4px] border border-dashed border-v2-border-border-focus">
                        <Icon name="plus" size="small" class="text-v2-icon-icon-info" />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[10px] font-[570] leading-3.5 text-v2-text-text-base">
                          {state.draft.id || language.t("agents.new")}
                        </span>
                        <span class="block text-[9px] leading-3 text-v2-text-text-faint">
                          {language.t("agents.badge.unsaved")}
                        </span>
                      </span>
                    </button>
                  </Show>
                  <For each={customEntries()}>
                    {(id) => (
                      <AgentRow
                        id={id}
                        title={id}
                        subtitle={configAgents()[id]?.description || language.t(modeOption(configAgents()[id]?.mode ?? "all").label)}
                        active={!state.creating && state.selected === id}
                        onSelect={() => selectAgent(id)}
                      />
                    )}
                  </For>
                  <Show when={!state.creating && customEntries().length === 0}>
                    <div class="mx-1 rounded-[4px] border border-dashed border-v2-border-border-muted px-2 py-2">
                      <div class="text-[10px] font-[560] text-v2-text-text-muted">{language.t("agents.empty")}</div>
                      <div class="mt-1 text-[9px] leading-3.5 text-v2-text-text-faint">
                        {language.t("agents.empty.description")}
                      </div>
                    </div>
                  </Show>
                </div>
              </div>

              <Show when={listEmpty()}>
                <div class="mx-1 rounded-[4px] border border-dashed border-v2-border-border-muted px-2 py-2 text-[10px] text-v2-text-text-muted">
                  {language.t("agents.empty.filtered")}
                </div>
              </Show>
            </div>
          </ScrollView>
        </div>

        <div class="shrink-0 border-t border-v2-border-border-muted/70 px-2 py-1.5 text-[8px] leading-3 text-v2-text-text-faint">
          {language.t("agents.scope.description")}
        </div>
      </aside>

      <section class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-9 shrink-0 items-center gap-2 border-b border-v2-border-border-muted/70 px-2.5">
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <Icon name="brain" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            <div class="min-w-0">
              <div class="flex min-w-0 items-center gap-2">
                <h1 class="truncate text-[11px] font-[630] leading-4 text-v2-text-text-strong">
                  {state.creating ? language.t("agents.new") : state.selected}
                </h1>
                <span class="rounded-[3px] border border-v2-border-border-muted px-1 py-0.5 text-[8px] font-[560] leading-none text-v2-text-text-muted">
                  {selectedNative() ? language.t("agents.badge.builtin") : language.t("agents.badge.custom")}
                </span>
                <Show when={hasNativeOverride()}>
                  <span class="rounded-[3px] bg-v2-state-bg-info px-1 py-0.5 text-[8px] font-[560] leading-none text-v2-state-fg-info">
                    {language.t("agents.badge.override")}
                  </span>
                </Show>
              </div>
              <p class="truncate text-[9px] leading-3 text-v2-text-text-faint">
                {selectedNative()
                  ? language.t((nativeDescriptionKey(state.selected) ?? "agents.subtitle") as "agents.subtitle")
                  : state.draft.description || language.t("agents.subtitle")}
              </p>
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-1">
            <Show when={dirty()}>
              <span class="me-0.5 flex items-center gap-1 text-[8px] font-[540] text-v2-text-text-muted">
                <span class="size-1 rounded-full bg-v2-icon-icon-warning" />
                {language.t("agents.badge.unsaved")}
              </span>
            </Show>
            <Show when={selectedNative() && hasNativeOverride()}>
              <ButtonV2 type="button" size="small" variant="ghost-muted" icon="reset" onClick={() => void resetNative()}>
                {language.t("agents.editor.reset")}
              </ButtonV2>
            </Show>
            <Show when={!selectedNative()}>
              <ButtonV2 type="button" size="small" variant="ghost-muted" icon="trash" onClick={deleteCustom}>
                {language.t("agents.editor.delete")}
              </ButtonV2>
            </Show>
            <TooltipV2
              placement="bottom"
              gutter={4}
              value={`${language.t("agents.editor.save")} — ${navigatorPlatformKey()}`}
            >
              <ButtonV2
                type="button"
                size="small"
                variant={state.saving ? "loading" : "contrast"}
                disabled={!canSave()}
                onClick={() => void save()}
              >
                {language.t(state.saving ? "agents.editor.saving" : "agents.editor.save")}
              </ButtonV2>
            </TooltipV2>
          </div>
        </header>

        <div class="relative min-h-0 flex-1 bg-v2-background-bg-base">
          <ScrollView class="h-full [&_.scroll-view__viewport]:overscroll-contain">
            <div class="grid min-h-full w-full grid-cols-1 xl:grid-cols-[minmax(0,1fr)_304px]">
              <main class="flex min-h-full min-w-0 flex-col px-3.5 py-3 xl:px-4">
                <section class="shrink-0 border-b border-v2-border-border-muted/70 pb-3">
                  <SectionHeader
                    title={language.t("agents.editor.identity")}
                    description={language.t("agents.editor.identity.description")}
                  />
                  <div class="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[200px_minmax(320px,1fr)]">
                    <div>
                      <FieldLabel hint={state.creating ? language.t("agents.editor.id.hint") : undefined}>
                        {language.t("agents.editor.id")}
                      </FieldLabel>
                      <input
                        class="agent-studio-field"
                        value={state.draft.id}
                        disabled={!state.creating}
                        data-invalid={state.creating && (!validation().id || idCollision()) ? "" : undefined}
                        aria-invalid={state.creating && (!validation().id || idCollision()) ? true : undefined}
                        placeholder={language.t("agents.editor.id.placeholder")}
                        spellcheck={false}
                        autocorrect="off"
                        autocapitalize="off"
                        onInput={(event) => setState("draft", "id", event.currentTarget.value.toLowerCase())}
                      />
                      <Show when={state.creating && (!validation().id || idCollision())}>
                        <p class="mt-1 text-[9px] leading-3 text-v2-state-fg-danger">
                          {language.t("agents.editor.invalidId")}
                        </p>
                      </Show>
                    </div>
                    <div>
                      <FieldLabel>{language.t("agents.editor.description")}</FieldLabel>
                      <input
                        class="agent-studio-field"
                        value={state.draft.description}
                        placeholder={
                          selectedNative()
                            ? language.t(
                                (nativeDescriptionKey(state.selected) ?? "agents.editor.description.placeholder") as "agents.editor.description.placeholder",
                              )
                            : language.t("agents.editor.description.placeholder")
                        }
                        onInput={(event) => setState("draft", "description", event.currentTarget.value)}
                      />
                    </div>
                  </div>
                </section>

                <section class="flex min-h-[430px] flex-1 flex-col pt-3">
                  <div class="flex items-start justify-between gap-3">
                    <SectionHeader
                      title={language.t("agents.editor.systemPrompt")}
                      description={language.t("agents.editor.systemPrompt.description")}
                    />
                    <span class="shrink-0 font-mono text-[8px] tabular-nums leading-4 text-v2-text-text-faint">
                      {state.draft.prompt.length.toLocaleString()}
                    </span>
                  </div>
                  <div class="agent-studio-prompt mt-2 min-h-[420px] w-full flex-1">
                    <textarea
                      class="agent-studio-prompt-input"
                      value={promptValue()}
                      placeholder={language.t("agents.editor.systemPrompt.placeholder")}
                      spellcheck={false}
                      onInput={(event) => {
                        setState("promptEditing", true)
                        setState("draft", "prompt", event.currentTarget.value)
                      }}
                    />
                  </div>
                  <Show when={!state.promptEditing && inheritedPrompt().trim()}>
                    <div class="mt-1.5 flex items-center gap-1 text-[8px] text-v2-text-text-faint">
                      <Icon name="info" size="small" class="opacity-60" />
                      {language.t("agents.editor.runtimeDefault")}
                    </div>
                  </Show>
                  <Show when={!state.promptEditing && !inheritedPrompt().trim()}>
                    <div class="mt-1.5 flex items-center gap-1 text-[8px] text-v2-text-text-faint">
                      <Icon name="info" size="small" class="opacity-60" />
                      {language.t("agents.editor.providerDefault")}
                    </div>
                  </Show>
                </section>
              </main>

              <aside class="min-w-0 border-t border-v2-border-border-muted/70 bg-v2-background-bg-layer-01/35 xl:border-l xl:border-t-0">
                <section class="border-b border-v2-border-border-muted/70 p-2.5">
                  <SectionHeader
                    title={language.t("agents.editor.runtime")}
                    description={language.t("agents.editor.runtime.description")}
                  />
                  <Show
                    when={!selectedNative()}
                    fallback={
                       <div class="mt-2">
                         <div class="flex h-7 items-center justify-between border-y border-v2-border-border-muted/60">
                           <span class="text-[9px] font-[540] text-v2-text-text-muted">
                             {language.t("agents.editor.runtime")}
                           </span>
                           <span class="rounded-[3px] bg-v2-overlay-simple-overlay-hover px-1.5 py-0.5 text-[8px] font-[600] text-v2-text-text-base">
                             {language.t(modeOption(state.draft.mode).label)}
                           </span>
                         </div>
                         <p class="mt-1.5 text-[8px] leading-3.5 text-v2-text-text-faint">
                           {language.t("agents.editor.nativeMode")}
                         </p>
                       </div>
                    }
                  >
                    <div class="mt-2 flex h-7 items-center rounded-[4px] border border-v2-border-border-muted/70 bg-v2-background-bg-base p-0.5">
                      <For each={["primary", "subagent", "all"] as AgentStudioMode[]}>
                        {(mode) => (
                          <button
                            type="button"
                            class="h-6 min-w-0 flex-1 rounded-[3px] px-1 text-[9px] font-[560] leading-3 text-v2-text-text-muted transition-colors hover:text-v2-text-text-base"
                            classList={{
                              "bg-v2-overlay-simple-overlay-hover text-v2-text-text-strong shadow-[inset_0_0_0_1px_var(--v2-border-border-muted)]":
                                state.draft.mode === mode,
                            }}
                            aria-pressed={state.draft.mode === mode}
                            onClick={() => {
                              setState("draft", "mode", mode)
                              if (mode === "primary") setState("draft", "hidden", false)
                            }}
                          >
                            {language.t(modeOption(mode).label)}
                          </button>
                        )}
                      </For>
                    </div>
                    <p class="mt-1.5 text-[8px] leading-3.5 text-v2-text-text-faint">
                      {language.t(modeOption(state.draft.mode).description)}
                    </p>
                  </Show>

                  <Show when={showMentionsToggle()}>
                    <div class="mt-2 flex items-center justify-between gap-2 border-t border-v2-border-border-muted/70 pt-2">
                      <div class="min-w-0">
                        <div class="text-[9px] font-[560] leading-3.5 text-v2-text-text-base">
                          {language.t("agents.editor.mentions")}
                        </div>
                        <div class="text-[8px] leading-3 text-v2-text-text-faint">
                          {language.t("agents.editor.mentions.description")}
                        </div>
                      </div>
                      <Switch checked={!state.draft.hidden} onChange={(value) => setState("draft", "hidden", !value)} />
                    </div>
                  </Show>
                </section>

                <section class="border-b border-v2-border-border-muted/70 p-2.5">
                  <SectionHeader
                    title={language.t("agents.editor.model")}
                    description={language.t("agents.editor.model.description")}
                  />
                  <div class="mt-2 flex min-w-0 items-center justify-between gap-2">
                    <span class="text-[9px] font-[540] text-v2-text-text-muted">{language.t("agents.editor.model")}</span>
                    <SettingsModelPickerV2
                      compact
                      value={state.draft.model}
                      defaultLabel={language.t("agents.editor.model.default")}
                      action="agents-model"
                      onChange={(model) => setState("draft", "model", model)}
                    />
                  </div>
                  <div class="mt-2">
                    <FieldLabel>{language.t("agents.editor.variant")}</FieldLabel>
                    <input
                      class="agent-studio-field"
                      value={state.draft.variant}
                      placeholder={language.t("agents.editor.variant.placeholder")}
                      spellcheck={false}
                      onInput={(event) => setState("draft", "variant", event.currentTarget.value)}
                    />
                  </div>
                </section>

                <section class="border-b border-v2-border-border-muted/70 p-2.5">
                  <SectionHeader
                    title={language.t("agents.editor.tuning")}
                    description={language.t("agents.editor.tuning.description")}
                  />
                  <div class="mt-2 grid grid-cols-3 gap-1.5">
                    <div>
                      <FieldLabel>{language.t("agents.editor.temperature")}</FieldLabel>
                      <input
                        class="agent-studio-field agent-studio-field-numeric"
                        type="number"
                        value={state.draft.temperature}
                        data-invalid={!validation().temperature ? "" : undefined}
                        aria-invalid={!validation().temperature ? true : undefined}
                        onInput={(event) => setState("draft", "temperature", event.currentTarget.value)}
                      />
                    </div>
                    <div>
                      <FieldLabel>{language.t("agents.editor.topP")}</FieldLabel>
                      <input
                        class="agent-studio-field agent-studio-field-numeric"
                        type="number"
                        value={state.draft.topP}
                        data-invalid={!validation().topP ? "" : undefined}
                        aria-invalid={!validation().topP ? true : undefined}
                        onInput={(event) => setState("draft", "topP", event.currentTarget.value)}
                      />
                    </div>
                    <div>
                      <FieldLabel>{language.t("agents.editor.steps")}</FieldLabel>
                      <input
                        class="agent-studio-field agent-studio-field-numeric"
                        type="number"
                        value={state.draft.steps}
                        data-invalid={!validation().steps ? "" : undefined}
                        aria-invalid={!validation().steps ? true : undefined}
                        onInput={(event) => setState("draft", "steps", event.currentTarget.value)}
                      />
                    </div>
                  </div>
                  <Show when={!numbersValid()}>
                    <p class="mt-1.5 text-[8px] leading-3 text-v2-state-fg-danger">
                      {language.t("agents.editor.invalidNumber")}
                    </p>
                  </Show>
                </section>

                <ExposurePanel exposure={exposure()} language={language} />
              </aside>
            </div>
          </ScrollView>
        </div>
      </section>
    </div>
  )
}

function navigatorPlatformKey() {
  if (typeof navigator === "undefined") return "Ctrl+S"
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent) ? "⌘S" : "Ctrl+S"
}

function ExposurePanel(props: {
  exposure: ReturnType<typeof agentExposure>
  language: ReturnType<typeof useLanguage>
}) {
  const language = props.language
  const rows = () => [
    { label: language.t("agents.editor.composer"), enabled: props.exposure.composer },
    { label: language.t("agents.editor.mentionsShort"), enabled: props.exposure.mention },
    { label: language.t("agents.editor.delegation"), enabled: props.exposure.delegation },
  ]
  return (
    <section class="p-2.5">
      <SectionHeader title={language.t("agents.editor.availability")} />
      <div class="mt-2 flex flex-col">
        <For each={rows()}>
          {(item) => (
            <div class="flex h-7 items-center justify-between gap-2 border-b border-v2-border-border-muted/50 last:border-b-0">
              <span class="text-[9px] text-v2-text-text-muted">{item.label}</span>
              <span
                class="flex items-center gap-1 text-[8px] font-[560]"
                classList={{
                  "text-v2-state-fg-success": item.enabled,
                  "text-v2-text-text-faint": !item.enabled,
                }}
              >
                <span
                  class="size-1 rounded-full"
                  classList={{
                    "bg-v2-state-fg-success": item.enabled,
                    "bg-v2-border-border-strong": !item.enabled,
                  }}
                />
                {language.t(item.enabled ? "agents.editor.enabled" : "agents.editor.disabled")}
              </span>
            </div>
          )}
        </For>
      </div>
      <p class="mt-1.5 text-[8px] leading-3 text-v2-text-text-faint">
        {language.t("agents.editor.delegation.description")}
      </p>
    </section>
  )
}
