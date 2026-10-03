import type { ServerConnection } from "./server"
import { requireServerKey } from "@/utils/session-route"
import { decode64 } from "@/utils/base64"
import { appTabPageFromPathname, type AppTabPage } from "./app-tabs"

export type LayoutRoute =
  | { type: "home" }
  | { type: AppTabPage }
  | { type: "draft"; draftID: string; server?: ServerConnection.Key }
  | { type: "dir-new-sesssion"; dir: string; dirBase64: string; server?: ServerConnection.Key }
  | { type: "session"; sessionId: string; server?: ServerConnection.Key }
  | { type: "group"; groupId: string; server?: ServerConnection.Key }

export const currentRoute = (pathname: string, search: string): LayoutRoute => {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 0) return { type: "home" }
  // Not every app tab is a single-segment path: OXP selects an activity in the
  // URL (`/oxp/activity/:id`). Share the tab store's own path parser so a deep
  // app-tab route still resolves to its tab here — otherwise the extra segments
  // fall through to the directory branch, `decode64("oxp")` fails, the route
  // reports "home", and the tab strip highlights Home while an app tab is open.
  const appPage = appTabPageFromPathname(pathname)
  if (appPage) return { type: appPage }

  if (parts[0] === "new-session") {
    const draftID = new URLSearchParams(search).get("draftId")
    if (!draftID) return { type: "home" }
    return { type: "draft", draftID }
  }

  if (parts[0] === "server" && parts[2] === "session" && parts[3]) {
    return {
      type: "session",
      sessionId: parts[3],
      server: requireServerKey(parts[1]),
    }
  }

  if (parts[0] === "server" && parts[2] === "group" && parts[3]) {
    return {
      type: "group",
      groupId: parts[3],
      server: requireServerKey(parts[1]),
    }
  }

  const dirBase64 = parts[0]
  const dir = decode64(dirBase64)
  if (!dir) return { type: "home" }

  if (parts[1] !== "session") return { type: "home" }

  const id = parts[2]
  if (id) return { type: "session", sessionId: id }
  return { type: "dir-new-sesssion", dir, dirBase64 }
}
