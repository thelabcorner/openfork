import { useLocation, useNavigate } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"

export const settingsTabs = ["general", "shortcuts", "servers", "providers", "models", "devices"] as const
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

export function useSettingsNavigation() {
  const location = useLocation<{ settings?: boolean }>()
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSync = useServerSync()
  const tabs = useTabs()

  const currentPath = () => `${location.pathname}${location.search}${location.hash}`

  return {
    open(tab: SettingsTab = "general") {
      const route = layout.route()
      const query = new URLSearchParams(route.type === "settings" ? location.search : "")
      query.set("tab", tab)

      if (route.type !== "settings") {
        query.set("from", currentPath())

        const draft = route.type === "draft"
          ? tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
          : undefined
        const serverKey = "server" in route && route.server ? route.server : draft?.server ?? server.key
        query.set("server", serverKey)

        const directory = (() => {
          if (route.type === "dir-new-sesssion") return route.dir
          if (route.type === "draft") return draft?.type === "draft" ? draft.directory : undefined
          if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
          if (route.type === "home") return layout.home.selection().directory
          return undefined
        })()
        if (directory) query.set("directory", directory)
        if (route.type === "session") query.set("session", route.sessionId)
      }

      navigate(`/settings?${query}`, {
        replace: route.type === "settings",
        state: route.type === "settings" ? location.state : { settings: true },
      })
    },
    close() {
      if (layout.route().type !== "settings") return
      if (location.state?.settings) {
        navigate(-1)
        return
      }
      const query = new URLSearchParams(location.search)
      navigate(safeSettingsReturn(query.get("from")), { replace: true })
    },
  }
}
