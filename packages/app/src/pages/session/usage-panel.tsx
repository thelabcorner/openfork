import { createSignal, ErrorBoundary, onMount, Show } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import { UsagePanelContent } from "@/components/usage/usage-panel-content"
import {
  USAGE_PANEL_WIDTH_MIN,
  USAGE_PANEL_WIDTH_MAX,
  type UsagePanelState,
} from "@/pages/session/usage-panel-state"

/**
 * UsagePanel — the global usage analytics right pane. Compact header (title,
 * collapse) above the UsagePanelContent. The panel width is driven by the
 * persisted usage-panel state via the edge resize handle.
 * Structurally mirrors ContextPanel.
 */
export function UsagePanel(props: {
  state: UsagePanelState
  opened: boolean
  onClose: () => void
}) {
  const language = useLanguage()
  const [contentReady, setContentReady] = createSignal(false)

  onMount(() => {
    requestAnimationFrame(() => setContentReady(true))
  })

  return (
    <div
      id="usage-panel"
      class="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
      style={{ width: `${props.state.sidebarWidth()}px` }}
      data-usage-panel
    >
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-v2-border-border-base bg-v2-background-bg-base px-1.5">
        <span class="min-w-0 flex-1 truncate px-1 text-[11px] leading-none text-v2-text-text-muted">
          {language.t("usage.panel.title")}
        </span>
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
        <ErrorBoundary
          fallback={(error) => {
            console.error("[usage-panel] mount failure", error)
            return (
              <div class="flex h-full flex-col items-center justify-center gap-1 px-3 text-center">
                <span class="text-[10px] font-[600] uppercase leading-3 text-v2-state-fg-danger">{language.t("usage.error")}</span>
                <span class="max-w-full truncate text-[10px] leading-3 text-v2-text-text-faint">
                  {error instanceof Error ? error.message : String(error)}
                </span>
              </div>
            )
          }}
        >
          <Show when={props.state.visible()}>
            <Show
              when={contentReady()}
              fallback={
                <div class="flex h-full items-center justify-center">
                  <Spinner class="size-4 text-v2-icon-icon-muted" />
                </div>
              }
            >
              <UsagePanelContent />
            </Show>
          </Show>
        </ErrorBoundary>
      </div>

      <ResizeHandle
        direction="horizontal"
        edge="start"
        size={props.state.sidebarWidth()}
        min={USAGE_PANEL_WIDTH_MIN}
        max={USAGE_PANEL_WIDTH_MAX}
        onResize={props.state.resizeSidebar}
      />
    </div>
  )
}
