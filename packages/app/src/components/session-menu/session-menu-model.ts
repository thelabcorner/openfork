import type { useLanguage } from "@/context/language"
import type { TabSessionState } from "../titlebar-tab-state"
import type { MenuSectionDef } from "./menu-model"

export type SessionMenuWhere = "tab" | "home" | "chats" | "group-tab"

export type SessionMenuActions = {
  open?: () => void
  openInBackground?: () => void
  stop?: () => void
  pause?: () => void
  resume?: () => void
  regenerateTitle?: () => void
  renameGroup?: () => void
  addSessions?: () => void
  addToGroup?: (groupId: string) => void
  createGroup?: (name: string) => void
  removeFromGroup?: () => void
  archive?: () => void
  close?: () => void
  closeLeft?: () => void
  closeRight?: () => void
  closeOthers?: () => void
  closeAll?: () => void
  openGroupTab?: () => void
  deleteGroup?: () => void
}

export type SessionMenuModelInput = {
  where: SessionMenuWhere
  language: ReturnType<typeof useLanguage>
  state: TabSessionState
  pendingRegenerate: boolean
  sessionID?: string
  isGroup?: boolean
  // Tab-specific geometry for close enablement
  tabIndex: number
  tabCount: number
  // Group context for home/chats rows
  userGroups: Array<{ id: string; name: string }>
  isInGroup: boolean
  // Capabilities are derived from state/context but caller may override;
  // factory still respects them for disabled. If not provided, disabled is derived.
  actions: SessionMenuActions
  // Dialog helper for "New group" item — caller passes a function that shows DialogSessionGroupName
  onCreateGroupDialog?: () => void
}

export function createSessionMenuModel(input: SessionMenuModelInput): MenuSectionDef[] {
  const t = input.language.t.bind(input.language)
  const working = input.state === "working"
  const paused = input.state === "paused"
  const hasSession = !!input.sessionID
  const tabIndex = input.tabIndex
  const tabCount = input.tabCount

  const sections: MenuSectionDef[] = []

  // ── Section 1: session execution state (stop/pause/resume) — only when session exists
  if (hasSession && (input.where === "tab" || input.where === "home" || input.where === "chats")) {
    sections.push({
      id: "state",
      items: [
        {
          kind: "item",
          id: "stop",
          label: t("command.session.stop"),
          disabled: !working || !input.actions.stop,
          onSelect: () => input.actions.stop?.(),
        },
        {
          kind: "item",
          id: "pause",
          label: t("command.session.pause"),
          disabled: !working || !input.actions.pause,
          onSelect: () => input.actions.pause?.(),
        },
        {
          kind: "item",
          id: "resume",
          label: t("command.session.resume"),
          disabled: !paused || !input.actions.resume,
          onSelect: () => input.actions.resume?.(),
        },
      ],
    })
  }

  // ── Section 2: retitle — only when session exists
  if (hasSession) {
    sections.push({
      id: "retitle",
      items: [
        {
          kind: "item",
          id: "regenerateTitle",
          label: input.pendingRegenerate ? t("command.session.regenerateTitle.pending") : t("command.session.regenerateTitle"),
          disabled: input.pendingRegenerate || !input.actions.regenerateTitle,
          onSelect: () => input.actions.regenerateTitle?.(),
        },
      ],
    })
  }

  // ── Section 3: navigation (Open / Open in background) — home/chats only
  if (input.where === "home" || input.where === "chats") {
    if (hasSession && (input.actions.open || input.actions.openInBackground)) {
      sections.push({
        id: "navigation",
        items: [
          {
            kind: "item",
            id: "open",
            label: t("common.open"),
            disabled: !input.actions.open,
            onSelect: () => input.actions.open?.(),
          },
          {
            kind: "item",
            id: "openInBackground",
            label: t("home.sessions.contextMenu.openInBackground"),
            disabled: !input.actions.openInBackground,
            onSelect: () => input.actions.openInBackground?.(),
          },
        ],
      })
    }
  }

  // ── Section 4: group actions
  // For group tabs: Rename group / Add sessions
  // For session rows (home/chats): Add to group submenu + Remove from group
  if (input.isGroup) {
    sections.push({
      id: "group-tab",
      items: [
        {
          kind: "item",
          id: "renameGroup",
          label: t("sessionGroup.rename"),
          disabled: !input.actions.renameGroup,
          onSelect: () => input.actions.renameGroup?.(),
        },
        {
          kind: "item",
          id: "addSessions",
          label: t("sessionGroup.addSessions"),
          disabled: !input.actions.addSessions,
          onSelect: () => input.actions.addSessions?.(),
        },
      ],
    })
  } else if (input.where === "home" || input.where === "chats") {
    // Session row group section — submenu + remove
    const submenuItems: MenuSectionDef["items"] = [
      ...input.userGroups.map((group) => ({
        kind: "item" as const,
        id: `addToGroup:${group.id}`,
        label: group.name,
        onSelect: () => input.actions.addToGroup?.(group.id),
      })),
    ]

    // Always include New group at bottom of submenu with a separator handled by renderer
    const addToGroupSubmenu: MenuSectionDef["items"][number] = {
      kind: "submenu",
      id: "addToGroup",
      label: t("home.sessions.contextMenu.addToGroup"),
      items: [
        ...submenuItems,
        // Sentinel for separator — renderer will split; we encode as disabled separator? Instead, push a real item for New group
        // and let renderer insert separator before it if groups exist.
        ...(input.userGroups.length > 0
          ? [
              {
                kind: "item" as const,
                id: "__separator",
                label: "__separator",
                disabled: true,
                onSelect: () => {},
              },
            ]
          : []),
        {
          kind: "item",
          id: "newGroup",
          label: t("home.sessions.contextMenu.newGroup"),
          onSelect: () => input.onCreateGroupDialog?.(),
        },
      ],
    }

    const groupItems: MenuSectionDef["items"] = [addToGroupSubmenu]
    if (input.isInGroup) {
      groupItems.push({
        kind: "item",
        id: "removeFromGroup",
        label: t("home.sessions.contextMenu.removeFromGroup"),
        disabled: !input.actions.removeFromGroup,
        onSelect: () => input.actions.removeFromGroup?.(),
      })
    }

    sections.push({
      id: "group",
      items: groupItems,
    })
  } else if (input.where === "group-tab") {
    // Fallback — already handled via isGroup above, but keep for type safety
  }

  // ── Section 5: close / archive
  // Tabs use Close variants; home/chats use Archive (and close variants only for tabs)
  if (input.where === "tab" || input.where === "group-tab") {
    const isTab = input.tabIndex >= 0
    sections.push({
      id: "close",
      items: [
        {
          kind: "item",
          id: "close",
          label: t("command.tab.close"),
          disabled: !isTab || !input.actions.close,
          onSelect: () => input.actions.close?.(),
        },
        {
          kind: "item",
          id: "closeLeft",
          label: t("command.tab.closeLeft"),
          disabled: tabIndex <= 0 || !input.actions.closeLeft,
          onSelect: () => input.actions.closeLeft?.(),
        },
        {
          kind: "item",
          id: "closeRight",
          label: t("command.tab.closeRight"),
          disabled: tabIndex < 0 || tabIndex >= tabCount - 1 || !input.actions.closeRight,
          onSelect: () => input.actions.closeRight?.(),
        },
        {
          kind: "item",
          id: "closeOthers",
          label: t("command.tab.closeOthers"),
          disabled: tabCount <= 1 || !input.actions.closeOthers,
          onSelect: () => input.actions.closeOthers?.(),
        },
        {
          kind: "item",
          id: "closeAll",
          label: t("command.tab.closeAll"),
          disabled: !input.actions.closeAll,
          onSelect: () => input.actions.closeAll?.(),
        },
      ],
    })
  } else if (input.where === "home" || input.where === "chats") {
    if (hasSession && input.actions.archive) {
      sections.push({
        id: "archive",
        items: [
          {
            kind: "item",
            id: "archive",
            label: t("common.archive"),
            onSelect: () => input.actions.archive?.(),
          },
        ],
      })
    }
  }

  return sections
}
