import { Show } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { ModelsPanelContent } from "@/components/models/models-panel-content"
import {
  MODELS_PANEL_WIDTH_MIN,
  MODELS_PANEL_WIDTH_MAX,
  type ModelsPanelState,
} from "@/pages/session/models-panel-state"

/**
 * ModelsPanel — the model comparison right pane. Compact header (title,
 * collapse) above the ModelsPanelContent. The panel width is driven by the
 * persisted models-panel state via the edge resize handle.
 * Structurally mirrors ContextPanel / UsagePanel.
 */
export function ModelsPanel(props: {
  state: ModelsPanelState
  opened: boolean
  onClose: () => void
}) {
  const language = useLanguage()

  return (
    <div
      id="models-panel"
      class="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
      style={{ width: `${props.state.sidebarWidth()}px` }}
      data-models-panel
    >
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-v2-border-border-base bg-v2-background-bg-base px-1.5">
        <span class="min-w-0 flex-1 truncate px-1 text-[11px] leading-none text-v2-text-text-muted">
          {language.t("models.panel.title")}
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
        <Show when={props.state.visible()}>
          <ModelsPanelContent />
        </Show>
      </div>

      <ResizeHandle
        direction="horizontal"
        edge="start"
        size={props.state.sidebarWidth()}
        min={MODELS_PANEL_WIDTH_MIN}
        max={MODELS_PANEL_WIDTH_MAX}
        onResize={props.state.resizeSidebar}
      />
    </div>
  )
}
