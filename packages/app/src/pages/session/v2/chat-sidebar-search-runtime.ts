import { createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useGlobal } from "@/context/global"
import { useLayout } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { createHomeSessionSearchController } from "@/pages/home/home-session-search-controller"
import type { HomeSessionRecord, OpenSessionOptions } from "@/pages/home/home-session-types"

/**
 * Demand-only Chat sidebar search integration.
 *
 * The visible search field lives in chat-sidebar-pane.tsx, but none of the Home
 * search/global-server/tab machinery is needed merely to paint that field. This
 * runtime is imported on first focus and created back under the pane's Solid
 * owner, so the initial sidebar graph stays independent of search.
 */
export function createChatSidebarSearchRuntime(input: { prefetchSession: (session: Session) => void }) {
  const globalCtx = useGlobal()
  const tabs = useTabs()
  const layout = useLayout()
  const serverSDK = useServerSDK()
  const navigate = useNavigate()

  const serverKey = createMemo(() => {
    try {
      const conn = serverSDK().server
      return conn ? ServerConnection.key(conn) : ("" as ServerConnection.Key)
    } catch {
      return "" as ServerConnection.Key
    }
  })

  const search = createHomeSessionSearchController(
    {
      project: {
        list: () => layout.projects.list(),
        selected: () => undefined,
      },
      server: {
        list: globalCtx.servers.list,
        focused: () => serverSDK().server,
        focusedContext: () => {
          try {
            const conn = serverSDK().server
            return conn ? globalCtx.ensureServerCtx(conn) : undefined
          } catch {
            return undefined
          }
        },
      },
    },
    {
      session: {
        open: (session: Session, options?: OpenSessionOptions) => {
          input.prefetchSession(session)
          if (!session.id || !session.directory) return
          if (options?.background) {
            const server = serverKey()
            if (!server) return
            tabs.addSessionTab({ server, sessionId: session.id })
            return
          }
          navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
        },
      },
    },
    // mod+f belongs to session.find on this surface.
    { registerFocusCommand: false },
  )

  return {
    search,
    serverKey,
    isOpenTab: (record: HomeSessionRecord) => sessionHasOpenTab(tabs.store, serverKey(), record.session),
  }
}

export type ChatSidebarSearchRuntime = ReturnType<typeof createChatSidebarSearchRuntime>
