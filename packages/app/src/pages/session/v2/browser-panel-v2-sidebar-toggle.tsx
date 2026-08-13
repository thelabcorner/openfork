import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"

/**
 * Browser panel sidebar toggle — mirrors SessionReviewV2SidebarToggle's
 * signature ({opened, disabled?, onToggle}) so the browser pane can be
 * collapsed/expanded from the session header next to the review toggle.
 */
export function BrowserPanelV2SidebarToggle(props: {
  opened: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  const language = useLanguage()
  return (
    <TooltipV2 value={language.t("command.browser.toggle")}>
      <IconButtonV2
        type="button"
        variant="ghost-muted"
        size="large"
        class="!w-9 shrink-0"
        state={props.opened ? "pressed" : undefined}
        disabled={props.disabled}
        onClick={props.onToggle}
        aria-label={language.t("command.browser.toggle")}
        aria-expanded={props.opened}
        aria-controls="browser-panel"
        icon={<IconV2 name="globe" />}
      />
    </TooltipV2>
  )
}
