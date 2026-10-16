import { useGlobal, type ServerCtx } from "@/context/global"
import { useTabs, tabKey } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { tabSessionState } from "../titlebar-tab-state"
import { isTitleRegenerationPending, sessionApiOf } from "../titlebar-tab-actions"
import { createSessionTitleRegeneration } from "../session-title-regeneration"
import { stopSession } from "@/utils/session-stop"
import { showToast } from "@/utils/toast"

/**
 * Centralized hook for session control actions (stop/pause/resume/regenerate).
 * Perf: memoizes ServerCtx lookup and reuses one `sessionApiOf` per session/server pair.
 * Pure helper — hosts may still override any action via props.
 */
export function createSessionControlActions(input: {
  sessionID?: string
  server?: ServerConnection.Key
}) {
  const global = useGlobal()

  const serverCtx = () => {
    if (!input.server) return undefined as ServerCtx | undefined
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === input.server)
    if (!conn) return undefined as ServerCtx | undefined
    return global.ensureServerCtx(conn)
  }

  const state = () => tabSessionState(serverCtx(), input.sessionID)
  const pendingRegenerate = () => isTitleRegenerationPending(input.sessionID)

  const api = () => sessionApiOf(serverCtx())

  const stop = () => {
    const id = input.sessionID
    const a = api()
    if (!id || !a) return
    void stopSession(a, id).catch((error) => showToast({
      variant: "error",
      title: "Unable to stop session",
      description: error instanceof Error ? error.message : String(error),
    }))
  }

  const pause = () => {
    const id = input.sessionID
    const a = api()
    if (!id || !a) return
    void a.pause({ sessionID: id })
  }

  const resume = () => {
    const id = input.sessionID
    const a = api()
    if (!id || !a) return
    void a.resume({ sessionID: id })
  }

  const titleRegeneration = createSessionTitleRegeneration({
    sessionID: () => input.sessionID,
    session: () => (input.sessionID ? serverCtx()?.sync.session.peek(input.sessionID) : undefined),
    api,
    server: () => input.server,
  })
  const regenerateTitle = () => titleRegeneration.run()

  return { serverCtx, state, pendingRegenerate, stop, pause, resume, regenerateTitle }
}

export function createTabCloseActions(input: { tabId: string }) {
  const tabs = useTabs()
  const index = () => tabs.store.findIndex((item) => tabKey(item) === input.tabId)
  const count = () => tabs.store.length

  return {
    index,
    count,
    close: () => {
      const i = index()
      if (i >= 0) tabs.closeTab(i)
    },
    closeLeft: () => {
      const i = index()
      if (i > 0) tabs.closeTabsLeftOf(i)
    },
    closeRight: () => {
      const i = index()
      if (i >= 0 && i < count() - 1) tabs.closeTabsRightOf(i)
    },
    closeOthers: () => {
      const i = index()
      if (i >= 0) tabs.closeOtherTabs(i)
    },
    closeAll: () => tabs.closeAllTabs(),
  }
}
