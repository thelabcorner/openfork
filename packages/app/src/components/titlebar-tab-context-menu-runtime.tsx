import { base64Encode } from "@opencode-ai/core/util/encode"
import { useNavigate } from "@solidjs/router"
import type { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { SessionContextMenu } from "./session-menu/session-context-menu"

export function TitlebarTabContextMenuRuntime(props: {
  id: string
  session?: () => Session | undefined
  server?: ServerConnection.Key
  isGroup?: boolean
  groupId?: string
  groupName?: string
  cursor: { x: number; y: number }
  onOpenChange?: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const platform = usePlatform()
  const language = useLanguage()
  const dialog = useDialog()
  const projectDirectory = () => props.session?.()?.directory

  return (
    <SessionContextMenu
      cursor={props.cursor}
      where={props.isGroup ? "group-tab" : "tab"}
      tabId={props.id}
      session={props.session?.()}
      server={props.server}
      onOpenChange={props.onOpenChange}
      isGroup={props.isGroup}
      groupId={props.groupId}
      onNewSessionInProject={() => {
        const directory = projectDirectory()
        if (directory) navigate(`/${base64Encode(directory)}/session`)
      }}
      onOpenProjectInExplorer={() => {
        const directory = projectDirectory()
        if (directory && platform.revealPath) void platform.revealPath(directory)
      }}
      onCopyProjectPath={() => {
        const directory = projectDirectory()
        if (directory)
          void navigator.clipboard
            .writeText(directory)
            .then(() => showToast({ title: language.t("projectExplorer.contextMenu.pathCopied") }))
      }}
      onForkConversation={() => {
        const sessionID = props.session?.()?.id
        if (!sessionID) return
        void import("@/components/dialog-fork").then(({ DialogFork }) =>
          dialog.show(() => <DialogFork sessionID={sessionID} />),
        )
      }}
    />
  )
}
