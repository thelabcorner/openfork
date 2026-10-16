import type { SettingsTab } from "./navigation-model"

/**
 * Presentation-only Settings navigation. IDs are stable deep-link contracts;
 * neither the sidebar nor the page is allowed to define a competing registry.
 * An absent section resolves to the first section for that tab.
 */
export const settingsSectionRegistry = {
  general: [
    { id: "basics", label: "Basics" },
    { id: "appearance", labelKey: "settings.general.section.appearance" },
    { id: "notifications", labelKey: "settings.general.section.notifications" },
    { id: "sounds", labelKey: "settings.general.section.sounds" },
    { id: "updates", labelKey: "settings.general.section.updates" },
    { id: "display", labelKey: "settings.general.section.display" },
    { id: "advanced", labelKey: "settings.general.section.advanced" },
    { id: "danger-zone", labelKey: "settings.general.section.dangerZone" },
  ],
  oxp: [
    { id: "connection", labelKey: "settings.oxp.connection.title" },
    { id: "folders", labelKey: "settings.oxp.folders.title" },
    { id: "permissions", label: "Capabilities" },
    { id: "agents", labelKey: "settings.oxp.agentSupport.title" },
    { id: "background", labelKey: "settings.oxp.lifecycle.title" },
    { id: "activity", label: "Activity & diagnostics" },
    { id: "migration", label: "Migration" },
  ],
  telegram: [
    { id: "connection", label: "Bot & pairing" },
    { id: "delivery", label: "Delivery" },
    { id: "quota", label: "Quota resets" },
    { id: "management", label: "Management" },
  ],
} as const

export type SettingsSection =
  (typeof settingsSectionRegistry)[keyof typeof settingsSectionRegistry][number]["id"]
export type SettingsSectionEntry = { readonly id: SettingsSection; readonly label?: string; readonly labelKey?: string }

export function sectionsForTab(tab: SettingsTab): readonly SettingsSectionEntry[] {
  if (tab === "general") return settingsSectionRegistry.general
  if (tab === "oxp") return settingsSectionRegistry.oxp
  if (tab === "telegram") return settingsSectionRegistry.telegram
  return []
}

export function normalizeSettingsSection(tab: SettingsTab, value: string | null | undefined): SettingsSection | undefined {
  const sections = sectionsForTab(tab)
  return sections.find((section) => section.id === value)?.id ?? sections[0]?.id
}

/** Preserve return context (server, directory, session, from) across child navigation. */
export function settingsSectionQuery(search: string, tab: SettingsTab, section?: string) {
  const query = new URLSearchParams(search)
  query.set("tab", tab)
  if (section && normalizeSettingsSection(tab, section) === section) query.set("section", section)
  else query.delete("section")
  return query
}
