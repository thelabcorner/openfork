/**
 * Pure Settings navigation identity and safe return-path normalization.
 * Keep these helpers isolated from router, layout and runtime providers so
 * deep-link regression tests never initialize the Solid application.
 */
export const settingsTabs = [
  "general",
  "shortcuts",
  "oxp",
  "servers",
  "providers",
  "models",
  "special-agents",
  "wakatime",
  "telegram",
  "devices",
] as const

export type SettingsTab = (typeof settingsTabs)[number]

const settingsTabSet = new Set<string>(settingsTabs)

export function normalizeSettingsTab(value: string | undefined): SettingsTab {
  return value && settingsTabSet.has(value) ? (value as SettingsTab) : "general"
}

export function safeSettingsReturn(value: string | null | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/"
  if (value === "/settings" || value.startsWith("/settings?")) return "/"
  return value
}
