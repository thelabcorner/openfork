import type { ServerConnection } from "./server"
import type { Tab } from "./tabs"
import { isAppTabPage, normalizeAppTabHref } from "./app-tabs"

export function migrateTabs(value: unknown, fallback: ServerConnection.Key): Tab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap<Tab>((tab) => {
    if (!tab || typeof tab !== "object") return []
    if ("type" in tab && tab.type === "app") {
      if (!("page" in tab) || typeof tab.page !== "string" || !isAppTabPage(tab.page)) return []
      const href = "href" in tab && typeof tab.href === "string" ? tab.href : undefined
      return [{ type: "app", page: tab.page, href: normalizeAppTabHref(tab.page, href) }]
    }
    if ("server" in tab && typeof tab.server !== "string") return []
    const server = ("server" in tab ? tab.server : fallback) as ServerConnection.Key
    if (tab.type === "session" && typeof tab.sessionId === "string") {
      return [{ type: tab.type, server, sessionId: tab.sessionId }]
    }
    if (
      tab.type === "draft" &&
      typeof tab.draftID === "string" &&
      typeof tab.directory === "string" &&
      (tab.worktree === undefined || typeof tab.worktree === "string")
    ) {
      return [{ type: tab.type, server, draftID: tab.draftID, directory: tab.directory, worktree: tab.worktree }]
    }
    return []
  })
}
