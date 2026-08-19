import { FileIcon } from "@opencode-ai/ui/file-icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import "./session-changes-v2.css"

export type SessionReviewEmptyNoGitV2Props = {
  pending: boolean
  onInitGit: () => void
}

export function SessionReviewEmptyNoGitV2(props: SessionReviewEmptyNoGitV2Props) {
  const i18n = useI18n()

  return (
    <div data-slot="session-changes-v2-empty-no-git">
      <FileIcon node={{ path: ".gitignore", type: "file" }} mono />
      <div data-slot="session-changes-v2-empty-no-git-title">{i18n.t("ui.SessionChangesV2.empty.noGit.title")}</div>
      <div data-slot="session-changes-v2-empty-no-git-description">
        {i18n.t("ui.SessionChangesV2.empty.noGit.description")}
      </div>
      <ButtonV2 variant="neutral" size="normal" disabled={props.pending} onClick={props.onInitGit}>
        {props.pending
          ? i18n.t("ui.SessionChangesV2.empty.noGit.actionLoading")
          : i18n.t("ui.SessionChangesV2.empty.noGit.action")}
      </ButtonV2>
    </div>
  )
}
