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
  // New quick actions
  changeModel?: () => void
  selectVariant?: (variant: string | undefined) => void
  toggleAutoAccept?: () => void
  poke?: () => void
  compact?: () => void
  exportJson?: () => void
  copySessionId?: () => void
  renameSession?: () => void
  togglePin?: () => void
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
  // Session-specific quick-action state
  isAutoAccepting?: boolean
  isPinned?: boolean
  currentVariant?: string | undefined
  currentModelLabel?: string | undefined
  availableVariants?: string[]
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
          icon: "stop",
          onSelect: () => input.actions.stop?.(),
        },
        {
          kind: "item",
          id: "pause",
          label: t("command.session.pause"),
          disabled: !working || !input.actions.pause,
          icon: "pause",
          onSelect: () => input.actions.pause?.(),
        },
        {
          kind: "item",
          id: "resume",
          label: t("command.session.resume"),
          disabled: !paused || !input.actions.resume,
          icon: "play",
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
          icon: "outline-reset",
          onSelect: () => input.actions.regenerateTitle?.(),
        },
      ],
    })
  }

  // ── Section 2b: session utilities (rename, pin, copy id, export) — only when session exists
  if (hasSession && !input.isGroup) {
    const utilItems: MenuSectionDef["items"] = []
    if (input.actions.renameSession) {
      utilItems.push({
        kind: "item",
        id: "renameSession",
        label: t("command.session.rename"),
        icon: "edit",
        onSelect: () => input.actions.renameSession?.(),
      })
    }
    if (input.actions.togglePin) {
      utilItems.push({
        kind: "checkbox",
        id: "togglePin",
        label: input.isPinned ? t("command.session.unpin") : t("command.session.pin"),
        checked: !!input.isPinned,
        icon: input.isPinned ? "pin-filled" : "pin",
        onSelect: () => input.actions.togglePin?.(),
      })
    }
    if (input.actions.copySessionId) {
      utilItems.push({
        kind: "item",
        id: "copySessionId",
        label: t("command.session.copyId"),
        icon: "outline-copy",
        onSelect: () => input.actions.copySessionId?.(),
      })
    }
    if (input.actions.exportJson) {
      utilItems.push({
        kind: "item",
        id: "exportJson",
        label: t("command.session.exportJson"),
        icon: "download",
        onSelect: () => input.actions.exportJson?.(),
      })
    }
    if (utilItems.length > 0) {
      sections.push({ id: "sessionUtils", items: utilItems })
    }
  }

  // ── Section 3: model & variant — inspired by prompt-input-v2's ModelSelectorPopoverV2View
  // Quick model switch + reasoning effort, same openrouter submenu/tooltip UX is
  // surfaced via the "Change model..." dialog (which reuses DialogSelectModel's
  // openrouter provider picker, favorites, search, etc). Variant submenu is inline.
  if (hasSession && !input.isGroup && (input.actions.changeModel || input.actions.selectVariant)) {
    const modelItems: MenuSectionDef["items"] = []
    if (input.actions.changeModel) {
      const label = input.currentModelLabel ? `${t("command.model.choose")} — ${input.currentModelLabel}` : t("command.model.choose")
      modelItems.push({
        kind: "item",
        id: "changeModel",
        label,
        icon: "outline-sliders",
        onSelect: () => input.actions.changeModel?.(),
      })
    }
    if (input.actions.selectVariant) {
      const variants = input.availableVariants ?? ["default", "low", "medium", "high", "xhigh"]
      const current = input.currentVariant ?? "default"
      modelItems.push({
        kind: "submenu",
        id: "variant",
        label: t("command.model.variant.cycle"),
        icon: "outline-sliders",
        items: variants.map((variant) => {
          const isDefault = variant === "default"
          const variantId = isDefault ? undefined : variant
          const checked = current === variant
          return {
            kind: "radio" as const,
            id: `variant:${variant}`,
            label: isDefault ? t("common.default") : variant,
            checked,
            onSelect: () => input.actions.selectVariant?.(variantId),
          }
        }),
      })
    }
    if (modelItems.length > 0) {
      sections.push({ id: "model", items: modelItems })
    }
  }

  // ── Section 4: permissions — auto-accept toggle (checkbox, mirrors prompt-input's toggle)
  if (hasSession && !input.isGroup && input.actions.toggleAutoAccept !== undefined) {
    sections.push({
      id: "permissions",
      items: [
        {
          kind: "checkbox",
          id: "autoAccept",
          label: t("command.permissions.autoaccept.enable"),
          checked: !!input.isAutoAccepting,
          icon: "shield-check",
          onSelect: () => input.actions.toggleAutoAccept?.(),
        },
      ],
    })
  }

  // ── Section 5: poke — send "continue" when agent died / stalled
  if (hasSession && !input.isGroup && input.actions.poke) {
    sections.push({
      id: "poke",
      items: [
        {
          kind: "item",
          id: "poke",
          label: t("command.session.poke"),
          disabled: working,
          icon: "play",
          onSelect: () => input.actions.poke?.(),
        },
      ],
    })
  }

  // ── Section 6: compact — summarize session to reduce context (triggers compaction)
  if (hasSession && !input.isGroup && input.actions.compact) {
    sections.push({
      id: "compact",
      items: [
        {
          kind: "item",
          id: "compact",
          label: t("command.session.compact"),
          disabled: working,
          icon: "hourglass",
          onSelect: () => input.actions.compact?.(),
        },
      ],
    })
  }

  // ── Section 7: navigation (Open / Open in background) — home/chats only
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
            icon: "outline-square-arrow",
            onSelect: () => input.actions.open?.(),
          },
          {
            kind: "item",
            id: "openInBackground",
            label: t("home.sessions.contextMenu.openInBackground"),
            disabled: !input.actions.openInBackground,
            icon: "outline-square-arrow",
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
          icon: "edit",
          onSelect: () => input.actions.renameGroup?.(),
        },
        {
          kind: "item",
          id: "addSessions",
          label: t("sessionGroup.addSessions"),
          disabled: !input.actions.addSessions,
          icon: "outline-dots",
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
      icon: "chats",
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
          icon: "plus",
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
        icon: "close",
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
          icon: "close",
          onSelect: () => input.actions.close?.(),
        },
        {
          kind: "item",
          id: "closeLeft",
          label: t("command.tab.closeLeft"),
          disabled: tabIndex <= 0 || !input.actions.closeLeft,
          icon: "close",
          onSelect: () => input.actions.closeLeft?.(),
        },
        {
          kind: "item",
          id: "closeRight",
          label: t("command.tab.closeRight"),
          disabled: tabIndex < 0 || tabIndex >= tabCount - 1 || !input.actions.closeRight,
          icon: "close",
          onSelect: () => input.actions.closeRight?.(),
        },
        {
          kind: "item",
          id: "closeOthers",
          label: t("command.tab.closeOthers"),
          disabled: tabCount <= 1 || !input.actions.closeOthers,
          icon: "close",
          onSelect: () => input.actions.closeOthers?.(),
        },
        {
          kind: "item",
          id: "closeAll",
          label: t("command.tab.closeAll"),
          disabled: !input.actions.closeAll,
          icon: "close",
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
            icon: "archive",
            onSelect: () => input.actions.archive?.(),
          },
        ],
      })
    }
  }

  return sections
}
