import type { useLanguage } from "@/context/language"
import type { BrowserGuestState } from "@/pages/session/v2/browser/types"
import type { MenuSectionDef } from "./menu-model"

export type BrowserMenuModelInput = {
  language: ReturnType<typeof useLanguage>
  tabId: string
  guest: BrowserGuestState
  sessions: Array<{ id: string; title: string }>
  actions: {
    refresh: () => void
    duplicate: () => void
    setMuted: (muted: boolean) => void
    assign: (sessionId: string) => void
    returnToMe: () => void
    closeRange: (mode: "left" | "right" | "others") => void
    close: () => void
  }
}

export function createBrowserMenuModel(input: BrowserMenuModelInput): MenuSectionDef[] {
  const t = input.language.t.bind(input.language)
  const muted = input.guest.muted

  return [
    {
      id: "controls",
      items: [
        { kind: "item", id: "refresh", label: t("browser.tab.refresh"), onSelect: input.actions.refresh },
        { kind: "item", id: "duplicate", label: t("browser.tab.duplicate"), onSelect: input.actions.duplicate },
        {
          kind: "item",
          id: "mute",
          label: muted ? t("browser.tab.unmute") : t("browser.tab.mute"),
          onSelect: () => input.actions.setMuted(!muted),
        },
      ],
    },
    {
      id: "assign",
      items: [
        {
          kind: "submenu",
          id: "assign",
          label: t("browser.tab.assign"),
          items:
            input.sessions.length > 0
              ? input.sessions.map((s) => ({
                  kind: "item" as const,
                  id: `assign:${s.id}`,
                  label: s.title || s.id,
                  onSelect: () => input.actions.assign(s.id),
                }))
              : [{ kind: "item" as const, id: "no-sessions", label: t("browser.tab.assignNoSessions"), disabled: true, onSelect: () => {} }],
        },
        { kind: "item", id: "returnToMe", label: t("browser.tab.returnToMe"), onSelect: input.actions.returnToMe },
      ],
    },
    {
      id: "close-ranges",
      items: [
        { kind: "item", id: "closeLeft", label: t("browser.tab.closeLeft"), onSelect: () => input.actions.closeRange("left") },
        { kind: "item", id: "closeRight", label: t("browser.tab.closeRight"), onSelect: () => input.actions.closeRange("right") },
        { kind: "item", id: "closeOthers", label: t("browser.tab.closeOthers"), onSelect: () => input.actions.closeRange("others") },
      ],
    },
    {
      id: "close",
      items: [{ kind: "item", id: "close", label: t("browser.tab.close"), onSelect: input.actions.close }],
    },
  ]
}
