import type { ParentProps } from "solid-js"
import { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2"
import { SessionContextMenu } from "./session-menu/session-context-menu"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useNavigate } from "@solidjs/router"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"

// Thin adapter: titlebar tabs now delegate to the unified SessionContextMenu.
// Preserves the same props contract so titlebar-tab-strip.tsx needs no change.
export function TitlebarTabContextMenu(
  props: ParentProps<{
    id: string
    session?: () => Session | undefined
    server?: ServerConnection.Key
    isGroup?: boolean
    groupId?: string
    groupName?: string
  }>,
) {
  const navigate = useNavigate()
  const platform = usePlatform()
  const language = useLanguage()
  const dialog = useDialog()
  const projectDirectory = () => props.session?.()?.directory
  return (
    <SessionContextMenu
      where={props.isGroup ? "group-tab" : "tab"}
      tabId={props.id}
      session={props.session?.()}
      server={props.server}
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
        if (directory) void navigator.clipboard.writeText(directory).then(() => showToast({ title: language.t("projectExplorer.contextMenu.pathCopied") }))
      }}
      onForkConversation={() => {
        const sessionID = props.session?.()?.id
        if (!sessionID) return
        void import("@/components/dialog-fork").then(({ DialogFork }) => dialog.show(() => <DialogFork sessionID={sessionID} />))
      }}
    >
      {props.children}
    </SessionContextMenu>
  )
}
