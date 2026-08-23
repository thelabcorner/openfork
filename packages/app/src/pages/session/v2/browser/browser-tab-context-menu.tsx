import { createMemo, type JSX } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { browserHostClient } from "./browserHostClient"
import type { BrowserGuestState } from "./types"
import { createBrowserMenuModel } from "@/components/session-menu/browser-menu-model"
import { MenuSectionsRenderer } from "@/components/session-menu/menu-renderer"

/**
 * Right-click tab context menu (D8): Refresh · Duplicate · Mute/Unmute ·
 * Close · close-ranges · Assign to session… · Return to me. All actions are
 * host-level (browserHostClient); assigning to a session is the user-authority
 * channel (D7) — never available to an agent tool.
 */
export function BrowserTabContextMenu(props: {
  tabId: string
  guest: () => BrowserGuestState
  sessions: () => Array<{ id: string; title: string }>
  onClose: () => void
  children: JSX.Element
}) {
  const language = useLanguage()
  const sections = createMemo(() =>
    createBrowserMenuModel({
      language,
      tabId: props.tabId,
      guest: props.guest(),
      sessions: props.sessions(),
      actions: {
        refresh: () => void browserHostClient.refreshTab(props.tabId),
        duplicate: () => void browserHostClient.duplicateTab(props.tabId),
        setMuted: (muted) => void browserHostClient.setTabMuted(props.tabId, muted),
        assign: (sessionId) => void browserHostClient.assignTab(props.tabId, { kind: "agent", sessionId }),
        returnToMe: () => void browserHostClient.assignTab(props.tabId, { kind: "user" }),
        closeRange: (mode) => void browserHostClient.closeRange(props.tabId, mode),
        close: () => props.onClose(),
      },
    }),
  )

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger as="div" class="contents">
        {props.children}
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content>
          <MenuSectionsRenderer sections={sections()} />
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}
