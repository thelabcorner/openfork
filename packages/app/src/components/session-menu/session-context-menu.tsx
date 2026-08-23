import { createMemo, type ParentProps } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { useTabs, tabKey } from "@/context/tabs"
import { useGlobal } from "@/context/global"
import { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2"
import { useSessionGroups } from "@/context/session-groups"
import { DialogSessionGroupName } from "../dialog-session-group"
import { showToast } from "@/utils/toast"
import { tabSessionState } from "../titlebar-tab-state"
import { isTitleRegenerationPending, sessionApiOf, beginTitleRegeneration, endTitleRegeneration } from "../titlebar-tab-actions"
import { createSessionMenuModel, type SessionMenuWhere } from "./session-menu-model"
import type { MenuSectionDef } from "./menu-model"
import { MenuSectionsRenderer } from "./menu-renderer"

export type SessionContextMenuProps = ParentProps<{
  where: SessionMenuWhere
  session?: Session | undefined
  server?: ServerConnection.Key
  // Tab-specific
  tabId?: string
  isGroup?: boolean
  groupId?: string
  // Home/chats row-specific
  inGroupId?: string
  onOpen?: (opts?: { background?: boolean }) => void
  onArchive?: () => Promise<void> | void
  // Group overrides — if not provided, generic sessionGroups mutations are used
  onAddToGroup?: (groupId: string) => void
  onRemoveFromGroup?: () => void
  onCreateGroup?: (name: string, sessionIds?: string[]) => Promise<string> | void
}>

/**
 * Unified session right-click menu — one shared architecture for tabs, home, and chats.
 * Perf: per-row wrapper (today) but all rendering is memoized; model factory is pure and
 * cheap. A single-container variant for large lists can swap in without changing the model.
 * One `MenuV2.Context` per instance, same `MenuSectionDef` type for session + file menus.
 */
export function SessionContextMenu(props: SessionContextMenuProps) {
  const language = useLanguage()
  const tabs = useTabs()
  const global = useGlobal()
  const dialog = useDialog()
  const sessionGroups = useSessionGroups()

  const sessionID = createMemo(() => props.session?.id)
  const serverCtx = createMemo(() => {
    if (!props.server) return undefined
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })

  const state = createMemo(() => tabSessionState(serverCtx(), sessionID()))
  const pendingRegenerate = createMemo(() => isTitleRegenerationPending(sessionID()))

  const tabIndex = createMemo(() => {
    if (!props.tabId) return -1
    return tabs.store.findIndex((item) => tabKey(item) === props.tabId)
  })
  const tabCount = createMemo(() => tabs.store.length)

  const userGroups = () => sessionGroups.groups().map((g) => ({ id: g.id, name: g.name }))
  const isInGroup = createMemo(() => !!props.inGroupId)

  // Default control actions (stop/pause/resume/regenerate) — hosts may override via props actions
  const api = createMemo(() => sessionApiOf(serverCtx()))

  const stop = () => {
    const id = sessionID()
    const a = api()
    if (!id || !a) return
    void (a as unknown as { interrupt: (p: { sessionID: string }) => Promise<unknown> }).interrupt({ sessionID: id })
  }
  const pause = () => {
    const id = sessionID()
    const a = api()
    if (!id || !a) return
    void a.pause({ sessionID: id })
  }
  const resume = () => {
    const id = sessionID()
    const a = api()
    if (!id || !a) return
    void a.resume({ sessionID: id })
  }
  const regenerateTitle = () => {
    const id = sessionID()
    const a = api()
    if (!id || !a || pendingRegenerate()) return
    beginTitleRegeneration(id)
    void a
      .regenerateTitle({ sessionID: id })
      .then(() => showToast({ title: language.t("toast.title.regenerated"), variant: "success" }))
      .catch((err) =>
        showToast({
          title: language.t("toast.title.failed"),
          description: err instanceof Error ? err.message : undefined,
          variant: "error",
        }),
      )
      .finally(() => endTitleRegeneration(id))
  }

  const close = () => {
    const i = tabIndex()
    if (i >= 0) tabs.closeTab(i)
  }
  const closeLeft = () => {
    const i = tabIndex()
    if (i > 0) tabs.closeTabsLeftOf(i)
  }
  const closeRight = () => {
    const i = tabIndex()
    if (i >= 0 && i < tabCount() - 1) tabs.closeTabsRightOf(i)
  }
  const closeOthers = () => {
    const i = tabIndex()
    if (i >= 0) tabs.closeOtherTabs(i)
  }
  const closeAll = () => tabs.closeAllTabs()

  const renameGroup = () => {
    showToast({ title: language.t("sessionGroup.rename") })
  }
  const addSessions = () => {
    showToast({ title: language.t("sessionGroup.addSessions") })
  }

  const onCreateGroupDialog = () => {
    const sid = sessionID()
    if (!sid) return
    // If host provided onCreateGroup, use it via dialog that forwards name + sid
    if (props.onCreateGroup) {
      void dialog.show(() => <DialogSessionGroupName onSubmit={(name) => void props.onCreateGroup?.(name, [sid])} />)
      return
    }
    void dialog.show(() => (
      <DialogSessionGroupName onSubmit={(name) => void sessionGroups.createGroup(name).then((g) => sessionGroups.addSessionToGroup({ groupId: g.id, sessionId: sid }))} />
    ))
  }

  const sections = createMemo<MenuSectionDef[]>(() =>
    createSessionMenuModel({
      where: props.where,
      language,
      state: state(),
      pendingRegenerate: pendingRegenerate(),
      sessionID: sessionID(),
      isGroup: props.isGroup,
      tabIndex: tabIndex(),
      tabCount: tabCount(),
      userGroups: userGroups(),
      isInGroup: isInGroup(),
      onCreateGroupDialog,
      actions: {
        open: props.onOpen ? () => props.onOpen?.({ background: false }) : undefined,
        openInBackground: props.onOpen ? () => props.onOpen?.({ background: true }) : undefined,
        stop,
        pause,
        resume,
        regenerateTitle,
        renameGroup: props.isGroup ? renameGroup : undefined,
        addSessions: props.isGroup ? addSessions : undefined,
        addToGroup: (groupId) => {
          if (props.onAddToGroup) {
            props.onAddToGroup(groupId)
            return
          }
          const sid = sessionID()
          if (!sid) return
          void sessionGroups.addSessionToGroup({ groupId, sessionId: sid })
        },
        removeFromGroup: () => {
          if (props.onRemoveFromGroup) {
            props.onRemoveFromGroup()
            return
          }
          const sid = sessionID()
          const gid = props.inGroupId
          if (!sid || !gid) return
          void sessionGroups.removeSessionFromGroup({ groupId: gid, sessionId: sid })
        },
        archive: props.onArchive ? () => void props.onArchive?.() : undefined,
        close: props.tabId ? close : undefined,
        closeLeft: props.tabId ? closeLeft : undefined,
        closeRight: props.tabId ? closeRight : undefined,
        closeOthers: props.tabId ? closeOthers : undefined,
        closeAll: props.tabId ? closeAll : undefined,
      },
    }),
  )

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger class="block h-full w-full min-w-0" as="div">
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
