import type { ParentProps } from "solid-js"
import { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2"
import { SessionContextMenu } from "./session-menu/session-context-menu"

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
  return (
    <SessionContextMenu
      where={props.isGroup ? "group-tab" : "tab"}
      tabId={props.id}
      session={props.session?.()}
      server={props.server}
      isGroup={props.isGroup}
      groupId={props.groupId}
    >
      {props.children}
    </SessionContextMenu>
  )
}
