import { useLanguage } from "@/context/language"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useTabs, tabKey } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { tabSessionState } from "../titlebar-tab-state"
import { beginTitleRegeneration, endTitleRegeneration, isTitleRegenerationPending, sessionApiOf } from "../titlebar-tab-actions"
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
  const language = useLanguage()
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
    void (a as unknown as { interrupt: (p: { sessionID: string }) => Promise<unknown> }).interrupt({ sessionID: id })
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

  const regenerateTitle = () => {
    const id = input.sessionID
    const a = api()
    if (!id || !a || pendingRegenerate()) return
    beginTitleRegeneration(id)
    void a
      .regenerateTitle({ sessionID: id })
      .then(() => showToast({ title: language.t("toast.title.regenerated"), variant: "success" }))
      .catch((err) =>
        showToast({
          title: language.t("toast.title.failed"),
          description: err instanceof Error ? err.message : undefined,
          variant: "error",
        }),
      )
      .finally(() => endTitleRegeneration(id))
  }

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
