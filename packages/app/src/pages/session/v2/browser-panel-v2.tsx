import { For, Show, createMemo } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { browserHostClient } from "./browser/browserHostClient"
import { HostedBrowserWebview } from "./browser/HostedBrowserWebview"
import { BrowserTabContextMenu } from "./browser/browser-tab-context-menu"
import { BrowserPanelV2SidebarToggle } from "./browser-panel-v2-sidebar-toggle"
import {
  BROWSER_PANEL_V2_WIDTH_MAX,
  BROWSER_PANEL_V2_WIDTH_MIN,
  type BrowserPanelV2State,
} from "./browser-panel-v2-state"

/**
 * BrowserPanelV2 — the hosted-browser right pane. Compact header (tab title,
 * new-tab, collapse) above the full HostedBrowserWebview tab. The panel width is
 * driven by the persisted `browser-panel-v2` state via the edge resize handle.
 */
export function BrowserPanelV2(props: {
  state: BrowserPanelV2State
  opened: boolean
  onClose: () => void
}) {
  const language = useLanguage()
  const hostState = browserHostClient.state
  const serverSync = useServerSync()

  // Open/visited chat sessions for the "Assign to session…" submenu (D7 user
  // authority). Sourced from the in-memory session store the page maintains;
  // the exact list hook is an implementation detail (flagged in the design).
  const assignSessions = createMemo(() =>
    Object.values(serverSync().session.data.info)
      .filter((info): info is NonNullable<typeof info> => info !== undefined)
      .map((session) => ({ id: session.id, title: session.title ?? session.id })),
  )

  const activeTabId = createMemo(() => {
    const state = hostState()
    if (state.activeTabId && state.guests.some((guest) => guest.tabId === state.activeTabId)) {
      return state.activeTabId
    }
    return state.guests[0]?.tabId ?? null
  })

  const activeTabTitle = createMemo(() => {
    const id = activeTabId()
    if (!id) return null
    return browserHostClient.guest(id).title ?? browserHostClient.guest(id).url
  })
  // Primitive tabId array, not the full guest objects: Solid's <For> reconciles
  // by item identity, and guest objects get a new reference on every real
  // field change (title while loading, url on navigation). Keying the mount
  // loop off guest objects tore down and recreated HostedBrowserWebview (a
  // fresh <webview>, i.e. a visible reload) on ordinary navigation — strings
  // compare by value, so tabIds() stays stable across those pushes.
  const tabIds = createMemo(() => hostState().guests.map((guest) => guest.tabId))

  const newTab = () => {
    void browserHostClient.open({ url: "about:blank", newTab: true, activate: true })
  }

  const closeActiveTab = () => {
    const id = activeTabId()
    if (id) void browserHostClient.close(id)
  }

  const activateTab = (tabId: string) => {
    void browserHostClient.activate(tabId)
  }

  return (
    <div
      id="browser-panel"
      class="my-2 me-2 flex min-h-0 shrink-0 self-stretch flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
      style={{ width: `${props.state.sidebarWidth()}px` }}
      data-browser-panel
    >
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-v2-border-border-base bg-v2-background-bg-base px-1.5">
        <div class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" data-browser-tabs>
          <Show
            when={tabIds().length > 0}
            fallback={
              <div class="min-w-0 flex-1 truncate px-1 text-[11px] leading-none text-v2-text-text-muted" data-browser-panel-title>
                {language.t("browser.panel.empty")}
              </div>
            }
          >
            <For each={tabIds()}>
              {(tabId) => (
                <BrowserTabPill
                  tabId={tabId}
                  active={activeTabId() === tabId}
                  fallbackTitle={activeTabTitle()}
                  sessions={assignSessions}
                  onActivate={() => activateTab(tabId)}
                  onClose={() => void browserHostClient.close(tabId)}
                />
              )}
            </For>
          </Show>
        </div>
        <TooltipV2 value={language.t("browser.nav.newTab")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            onClick={newTab}
            aria-label={language.t("browser.nav.newTab")}
            icon={<IconV2 name="plus" />}
          />
        </TooltipV2>
        <BrowserPanelV2SidebarToggle opened={props.opened} onToggle={props.onClose} />
      </div>

      <div class="relative min-h-0 flex-1">
        <Show when={tabIds().length > 0} fallback={<BrowserPanelV2Empty onNewTab={newTab} />}>
          <For each={tabIds()}>
            {(tabId) => (
              <HostedBrowserWebview
                tabId={tabId}
                active={activeTabId() === tabId}
                onClose={closeActiveTab}
                onNewTab={newTab}
              />
            )}
          </For>
        </Show>
      </div>

      <ResizeHandle
        direction="horizontal"
        edge="start"
        size={props.state.sidebarWidth()}
        min={BROWSER_PANEL_V2_WIDTH_MIN}
        max={BROWSER_PANEL_V2_WIDTH_MAX}
        onResize={props.state.resizeSidebar}
      />
    </div>
  )
}

/** One tab-strip pill. Reads its own guest state so a title/loading update
 * on one tab only re-renders that pill, not the whole strip. Right-click opens
 * the tab context menu (D8). */
function BrowserTabPill(props: {
  tabId: string
  active: boolean
  fallbackTitle: string | null
  sessions: () => Array<{ id: string; title: string }>
  onActivate: () => void
  onClose: () => void
}) {
  const language = useLanguage()
  const guest = createMemo(() => browserHostClient.guest(props.tabId))
  const label = () => guest().title || guest().url || props.fallbackTitle || language.t("browser.panel.empty")
  const ownerLabel = () =>
    guest().owner.kind === "user" ? language.t("browser.tab.owner.user") : language.t("browser.tab.owner.agent")

  const pill = (
    <div
      data-active={props.active || undefined}
      class="group/tab flex h-6 min-w-0 max-w-[170px] flex-1 items-center rounded-[5px] text-v2-text-text-muted transition-colors duration-100 hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base data-[active=true]:bg-v2-background-bg-layer-03 data-[active=true]:text-v2-text-text-base"
    >
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-1 rounded-l-[5px] px-2 text-left text-[11px] leading-none"
        title={`${label()} · ${ownerLabel()}${guest().muted ? ` · ${language.t("browser.tab.owner.muted")}` : ""}`}
        aria-label={label()}
        onClick={props.onActivate}
      >
        <span
          class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-muted data-[loading=true]:bg-v2-text-text-accent"
          data-loading={guest().loading || undefined}
        />
        <span class="min-w-0 flex-1 truncate">{label()}</span>
        <span class="shrink-0 text-[9px] leading-none uppercase text-v2-text-text-muted">
          {guest().muted ? language.t("browser.tab.owner.muted") : ownerLabel()}
        </span>
      </button>
      <button
        type="button"
        class="flex size-5 shrink-0 items-center justify-center rounded-[4px] opacity-0 transition-opacity duration-100 hover:bg-v2-background-bg-layer-01 group-hover/tab:opacity-100 data-[active=true]:opacity-100"
        data-active={props.active || undefined}
        aria-label={language.t("common.close")}
        onClick={(event) => {
          event.stopPropagation()
          props.onClose()
        }}
      >
        <CloseIcon />
      </button>
    </div>
  )

  return (
    <BrowserTabContextMenu tabId={props.tabId} guest={guest} sessions={props.sessions} onClose={props.onClose}>
      {pill}
    </BrowserTabContextMenu>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 5L11 11M11 5L5 11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  )
}

function BrowserPanelV2Empty(props: { onNewTab: () => void }) {
  const language = useLanguage()
  return (
    <div class="absolute inset-0 z-10 flex items-center justify-center bg-v2-background-bg-base">
      <div class="flex max-w-[240px] flex-col items-center gap-3 text-center">
        <div class="text-[12px] leading-relaxed text-v2-text-text-muted">{language.t("browser.panel.empty")}</div>
        <button
          type="button"
          class="h-6 rounded-[4px] bg-v2-background-bg-layer-03 px-2 text-[11px] leading-none text-v2-text-text-base transition-colors duration-100 hover:bg-v2-background-bg-layer-02"
          onClick={props.onNewTab}
        >
          {language.t("browser.nav.newTab")}
        </button>
      </div>
    </div>
  )
}
