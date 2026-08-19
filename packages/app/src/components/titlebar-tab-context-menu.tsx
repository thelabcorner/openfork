import { createMemo, Show, type ParentProps } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { tabKey, useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { useGlobal, type ServerCtx } from "@/context/global"
import { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2"
import { showToast } from "@/utils/toast"
import { tabSessionState } from "./titlebar-tab-state"
import {
  beginTitleRegeneration,
  endTitleRegeneration,
  isTitleRegenerationPending,
  sessionApiOf,
} from "./titlebar-tab-actions"

// Right-click menu for a titlebar tab. Binding 4-group layout contract
// (docs/swarm-cross-doc-review.md §4, adopted by docs/swarm-session-retitle.md §5.1):
//
//   [Stop session / Pause session / Resume session]   <- session-state group
//   ────────── separator ──────────
//   [Regenerate title]                                <- retitle group
//   ────────── separator ──────────
//   [Rename group / Add sessions]                     <- group actions (group tabs only)
//   ────────── separator ──────────
//   [project actions]                                 <- pathfinder group (future)
//   ────────── separator ──────────
//   [Close tab … Close all tabs]                      <- existing Close group, last
//
// Icon-free and no keybinds in v1. The anchor is the tab's store key (`id`); the
// store index is derived at open and at select time so "left"/"right" follow full
// store order, not the visible/overflow-filtered order the strip renders.
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
  const tabs = useTabs()
  const language = useLanguage()
  const global = useGlobal()
  const index = () => tabs.store.findIndex((item) => tabKey(item) === props.id)
  const count = () => tabs.store.length
  const sessionID = createMemo(() => props.session?.()?.id)
  const serverCtx = createMemo<ServerCtx | undefined>(() => {
    if (!props.server) return
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (conn) return global.ensureServerCtx(conn)
  })
  const state = createMemo(() => tabSessionState(serverCtx(), sessionID()))
  const working = createMemo(() => state() === "working")
  const paused = createMemo(() => state() === "paused")
  const pendingRegenerate = createMemo(() => isTitleRegenerationPending(sessionID()))

  const stop = () => {
    const id = sessionID()
    const api = sessionApiOf(serverCtx())
    if (!id || !api) return
    void api.interrupt({ sessionID: id })
  }

  const pause = () => {
    const id = sessionID()
    const api = sessionApiOf(serverCtx())
    if (!id || !api) return
    void api.pause({ sessionID: id })
  }

  const resume = () => {
    const id = sessionID()
    const api = sessionApiOf(serverCtx())
    if (!id || !api) return
    void api.resume({ sessionID: id })
  }

  const regenerateTitle = () => {
    const id = sessionID()
    const api = sessionApiOf(serverCtx())
    if (!id || !api || pendingRegenerate()) return
    beginTitleRegeneration(id)
    void api
      .regenerateTitle({ sessionID: id })
      .then(() =>
        showToast({ title: language.t("toast.title.regenerated"), variant: "success" }),
      )
      .catch((err) =>
        showToast({
          title: language.t("toast.title.failed"),
          description: err instanceof Error ? err.message : undefined,
          variant: "error",
        }),
      )
      .finally(() => endTitleRegeneration(id))
  }

  const renameGroup = () => {
    showToast({ title: language.t("sessionGroup.rename") })
  }

  const addSessions = () => {
    showToast({ title: language.t("sessionGroup.addSessions") })
  }

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger class="block h-full w-full min-w-0" as="div">
        {props.children}
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content>
          <Show when={sessionID()}>
            {/* Group 1 — session execution state (stop/pause feature). */}
            <MenuV2.Item disabled={!working()} onSelect={stop}>
              {language.t("command.session.stop")}
            </MenuV2.Item>
            <MenuV2.Item disabled={!working()} onSelect={pause}>
              {language.t("command.session.pause")}
            </MenuV2.Item>
            <MenuV2.Item disabled={!paused()} onSelect={resume}>
              {language.t("command.session.resume")}
            </MenuV2.Item>
            <MenuV2.Separator />
            {/* Group 2 — regenerate session title (retitle feature). Enabled while
                paused (retitle §5.2 / cross-doc Q6); disabled while a regeneration
                is pending, with the label swapped to the pending copy. */}
            <MenuV2.Item disabled={pendingRegenerate()} onSelect={regenerateTitle}>
              {pendingRegenerate()
                ? language.t("command.session.regenerateTitle.pending")
                : language.t("command.session.regenerateTitle")}
            </MenuV2.Item>
            {/* Group 3 — project actions (pathfinder's tab-project-actions feature).
                TODO(tab-project-actions): insert the P1/P2/P3 project-action group
                here with a separator, per the binding menu layout contract in
                docs/swarm-cross-doc-review.md §4. Nothing renders until that lands. */}
            <MenuV2.Separator />
          </Show>
          <Show when={props.isGroup}>
            <MenuV2.Item onSelect={renameGroup}>
              {language.t("sessionGroup.rename")}
            </MenuV2.Item>
            <MenuV2.Item onSelect={addSessions}>
              {language.t("sessionGroup.addSessions")}
            </MenuV2.Item>
            <MenuV2.Separator />
          </Show>
          {/* Group 4 — existing Close group, unchanged, last. */}
          <MenuV2.Item disabled={index() < 0} onSelect={() => tabs.closeTab(index())}>
            {language.t("command.tab.close")}
          </MenuV2.Item>
          <MenuV2.Item disabled={index() <= 0} onSelect={() => tabs.closeTabsLeftOf(index())}>
            {language.t("command.tab.closeLeft")}
          </MenuV2.Item>
          <MenuV2.Item disabled={index() >= count() - 1} onSelect={() => tabs.closeTabsRightOf(index())}>
            {language.t("command.tab.closeRight")}
          </MenuV2.Item>
          <MenuV2.Item disabled={count() <= 1} onSelect={() => tabs.closeOtherTabs(index())}>
            {language.t("command.tab.closeOthers")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => tabs.closeAllTabs()}>
            {language.t("command.tab.closeAll")}
          </MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}
