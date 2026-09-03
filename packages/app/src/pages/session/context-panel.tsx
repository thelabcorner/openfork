import { createEffect, ErrorBoundary, lazy, Show, startTransition, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { ResizeHandle, type ResizeHandlePairSide } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import { SegmentedTabs } from "@/components/session/insights-primitives"
import { LimitsPanelContent } from "@/pages/session/limits-panel"
import {
  CONTEXT_PANEL_WIDTH_MIN,
  CONTEXT_PANEL_WIDTH_MAX,
  type ContextTab,
  type ContextPanelState,
} from "@/pages/session/context-panel-state"

const loadContextTab = () => import("@/components/session/session-context-tab")

const SessionContextTab = lazy(() => loadContextTab().then((module) => ({ default: module.SessionContextTab })))

/**
 * ContextPanel — unified right pane for Context / Limits.
 * Tab bodies load on intent, mount on first visit, then remain mounted to
 * preserve scroll and local state. Limits retains its global data across
 * session changes; Context detaches from session streams while hidden, and
 * the Limits display clock pauses while it is not visible. Usage moved out
 * to the standalone /usage page.
 */
export function ContextPanel(props: {
  state: ContextPanelState
  opened: boolean
  onClose: () => void
  pair?: { left: ResizeHandlePairSide | ResizeHandlePairSide[]; right: ResizeHandlePairSide }
}) {
  const language = useLanguage()
  const initial = props.state.tab()
  const [visited, setVisited] = createStore<Record<ContextTab, boolean>>({
    context: initial === "context",
    limits: initial === "limits",
  })

  createEffect(() => {
    const tab = props.state.tab()
    if (!visited[tab]) setVisited(tab, true)
  })

  const handleTabChange = (value: string) => {
    startTransition(() => props.state.setTab(value as ContextTab))
  }

  const handleTabIntent = (value: string) => {
    if (value === "context") void loadContextTab()
  }

  const contextActive = () => props.state.visible() && props.state.tab() === "context"
  const limitsActive = () => props.state.visible() && props.state.tab() === "limits"

  const TabFallback = () => (
    <div class="flex h-full items-center justify-center">
      <Spinner class="size-4 text-v2-icon-icon-muted" />
    </div>
  )

  return (
    <div
      id="context-panel"
      class="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
      style={{ width: `${props.state.sidebarWidth()}px` }}
      data-context-panel
    >
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-v2-border-border-base bg-v2-background-bg-base px-1.5">
        <SegmentedTabs
          value={props.state.tab()}
          onChange={handleTabChange}
          onIntent={handleTabIntent}
          options={[
            { value: "context", label: language.t("session.tab.context") },
            { value: "limits", label: language.t("limits.panel.title") },
          ]}
        />
        <TooltipV2 value={language.t("common.collapse")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            onClick={props.onClose}
            aria-label={language.t("common.collapse")}
            icon={<Icon name="close" />}
          />
        </TooltipV2>
      </div>

      <div class="relative min-h-0 flex-1 overflow-hidden">
        <Show when={props.state.visible()}>
          <div
            class="absolute inset-0 flex flex-col"
            hidden={props.state.tab() !== "context"}
            aria-hidden={props.state.tab() !== "context"}
          >
            <Show when={visited.context} fallback={<TabFallback />}>
              <ErrorBoundary
                fallback={(error) => (
                  <div class="flex h-full flex-col items-center justify-center gap-1 px-3 text-center">
                    <span class="text-[10px] font-[600] uppercase leading-3 text-v2-state-fg-danger">{String(error)}</span>
                  </div>
                )}
              >
                <Suspense fallback={<TabFallback />}>
                  <SessionContextTab active={contextActive} />
                </Suspense>
              </ErrorBoundary>
            </Show>
          </div>
          <div
            class="absolute inset-0 flex flex-col"
            hidden={props.state.tab() !== "limits"}
            aria-hidden={props.state.tab() !== "limits"}
          >
            <Show when={visited.limits} fallback={<TabFallback />}>
              <ErrorBoundary
                fallback={(error) => (
                  <div class="flex h-full flex-col items-center justify-center gap-1 px-3 text-center">
                    <span class="text-[10px] font-[600] uppercase leading-3 text-v2-state-fg-danger">{String(error)}</span>
                  </div>
                )}
              >
                <Suspense fallback={<TabFallback />}>
                  <LimitsPanelContent active={limitsActive} />
                </Suspense>
              </ErrorBoundary>
            </Show>
          </div>
        </Show>
      </div>

      <ResizeHandle
        direction="horizontal"
        edge="start"
        size={props.state.sidebarWidth()}
        min={CONTEXT_PANEL_WIDTH_MIN}
        max={CONTEXT_PANEL_WIDTH_MAX}
        onResize={props.state.resizeSidebar}
        pair={props.pair}
      />
    </div>
  )
}
