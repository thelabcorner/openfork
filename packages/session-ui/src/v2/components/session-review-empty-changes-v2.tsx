import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Icon } from "@opencode-ai/ui/v2/icon"
import "./session-changes-v2.css"

export function SessionReviewEmptyChangesV2() {
  const i18n = useI18n()

  return (
    <div data-slot="session-changes-v2-empty-changes">
      <Icon name="review" size="large" />
      <div data-slot="session-changes-v2-empty-changes-title">{i18n.t("ui.SessionChangesV2.empty.changes.title")}</div>
      <div data-slot="session-changes-v2-empty-changes-description">
        {i18n.t("ui.SessionChangesV2.empty.changes.description")}
      </div>
    </div>
  )
}
