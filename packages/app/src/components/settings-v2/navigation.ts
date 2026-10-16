import { useLocation, useNavigate } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { settingsSectionQuery, type SettingsSection } from "./sections"
import { safeSettingsReturn, type SettingsTab } from "./navigation-model"
export { normalizeSettingsTab, safeSettingsReturn, settingsTabs } from "./navigation-model"
export type { SettingsTab } from "./navigation-model"

export function useSettingsNavigation() {
  const location = useLocation<{ settings?: boolean }>()
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSync = useServerSync()
  const tabs = useTabs()

  const currentPath = () => `${location.pathname}${location.search}${location.hash}`

  return {
    open(tab: SettingsTab = "general", section?: SettingsSection) {
      const route = layout.route()
      const query = settingsSectionQuery(route.type === "settings" ? location.search : "", tab, section)

      if (route.type !== "settings") {
        query.set("from", currentPath())

        const draft = route.type === "draft"
          ? tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
          : undefined
        const serverKey =
          "server" in route && route.server
            ? route.server
            : draft?.type === "draft"
              ? draft.server
              : server.key
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

      const href = `/settings?${query}`
      if (route.type === "settings") {
        navigate(href, { replace: true, state: location.state })
        return
      }
      tabs.openAppTab("settings", href)
    },
    close() {
      if (layout.route().type !== "settings") return
      const index = tabs.store.findIndex((item) => item.type === "app" && item.page === "settings")
      if (index !== -1) {
        tabs.closeTab(index)
        return
      }
      if (location.state?.settings) {
        navigate(-1)
        return
      }
      const query = new URLSearchParams(location.search)
      navigate(safeSettingsReturn(query.get("from")), { replace: true })
    },
  }
}
