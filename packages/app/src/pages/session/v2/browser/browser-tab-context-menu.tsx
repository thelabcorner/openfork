import { For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { browserHostClient } from "./browserHostClient"
import type { BrowserGuestState } from "./types"

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
  const muted = () => props.guest().muted
  const sessionList = () => props.sessions()

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger as="div" class="contents">
        {props.children}
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content>
          <MenuV2.Item onSelect={() => void browserHostClient.refreshTab(props.tabId)}>
            {language.t("browser.tab.refresh")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => void browserHostClient.duplicateTab(props.tabId)}>
            {language.t("browser.tab.duplicate")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => void browserHostClient.setTabMuted(props.tabId, !muted())}>
            {muted() ? language.t("browser.tab.unmute") : language.t("browser.tab.mute")}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Sub gutter={0} overlap overflowPadding={8}>
            <MenuV2.SubTrigger>{language.t("browser.tab.assign")}</MenuV2.SubTrigger>
            <MenuV2.Portal>
              <MenuV2.SubContent>
                <Show
                  when={sessionList().length > 0}
                  fallback={
                    <MenuV2.Item disabled>{language.t("browser.tab.assignNoSessions")}</MenuV2.Item>
                  }
                >
                  <For each={sessionList()}>
                    {(session) => (
                      <MenuV2.Item
                        onSelect={() => void browserHostClient.assignTab(props.tabId, { kind: "agent", sessionId: session.id })}
                      >
                        {session.title || session.id}
                      </MenuV2.Item>
                    )}
                  </For>
                </Show>
              </MenuV2.SubContent>
            </MenuV2.Portal>
          </MenuV2.Sub>
          <MenuV2.Item onSelect={() => void browserHostClient.assignTab(props.tabId, { kind: "user" })}>
            {language.t("browser.tab.returnToMe")}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item onSelect={() => void browserHostClient.closeRange(props.tabId, "left")}>
            {language.t("browser.tab.closeLeft")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => void browserHostClient.closeRange(props.tabId, "right")}>
            {language.t("browser.tab.closeRight")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => void browserHostClient.closeRange(props.tabId, "others")}>
            {language.t("browser.tab.closeOthers")}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item onSelect={props.onClose}>{language.t("browser.tab.close")}</MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}
