import { createEffect, lazy, onCleanup, Show, Suspense, type ParentProps } from "solid-js"
import { RoutePlaceholder } from "@/components/route-loading-fallback"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useLayout } from "@/context/layout"
import { SDKProvider } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { createBrowserPanelV2State } from "@/pages/session/v2/browser-panel-v2-state"
import { createChatSidebarPaneState } from "@/pages/session/v2/chat-sidebar-pane-state"
import { LimitsPanel } from "@/pages/session/limits-panel"
import { createLimitsPanelState } from "@/pages/session/limits-panel-state"

const BrowserPanelV2 = lazy(() =>
  import("@/pages/session/v2/browser-panel-v2").then((m) => ({ default: m.BrowserPanelV2 })),
)

const ChatSidebarPane = lazy(() =>
  import("@/pages/session/v2/chat-sidebar-pane").then((m) => ({ default: m.ChatSidebarPane })),
)

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const layout = useLayout()
  const [state, setState] = createStore({ debugTools: true })

  createEffect(() => setV2Toast(true))

  // The hosted browser pane is app-shell scoped, not session-page scoped: it
  // stays mounted (and its webviews alive) across every route — home, new
  // session, and chat sessions alike. The engine's tab-request broadcast is
  // the signal to auto-open it.
  const isDesktop = createMediaQuery("(min-width: 768px)")
  const chatSidebarState = createChatSidebarPaneState()
  const chatOpen = () => layout.chats.opened()
  const chatVisible = () => isDesktop() && chatOpen()
  const browserV2State = createBrowserPanelV2State()
  const browserOpen = () => layout.browser.opened()
  const browserVisible = () => isDesktop() && browserOpen()
  const limitsPanelState = createLimitsPanelState()
  const limitsOpen = () => layout.limits.opened()
  const limitsVisible = () => isDesktop() && limitsOpen()
  const limitsDirectory = () => layout.projects.list()[0]?.worktree ?? ""

  // Project explorer panel (packages/app/src/pages/session/v2/project-explorer-panel.tsx)
  // is NOT mounted here despite mirroring the browser panel's visual treatment:
  // unlike the browser (server-scoped only), it needs a resolved *directory*
  // via useFile()/useSDK(), which only exists inside a session/draft route's
  // own SDKProvider+FileProvider subtree (see session.tsx's SessionProviders).
  // Mounting it at this shell level throws "File context must be used within
  // a context provider" at runtime. It's mounted inside session.tsx's Page()
  // instead; layout.projectExplorer's open/close state (below) still lives
  // here in the shared context so the titlebar toggle works regardless.

  // The browser host client module is loaded lazily (it drags the whole
  // browser pane graph with it); the subscription is torn down via a
  // synchronous onCleanup because the async body runs outside any owner.
  createEffect(() => {
    let disposeHostClient = () => {}
    onCleanup(() => disposeHostClient())
    void import("@/pages/session/v2/browser/browserHostClient").then(({ browserHostClient }) => {
      void browserHostClient.init()
      const unsubscribeRequest = browserHostClient.onTabRequest(() => {
        if (layout.browser.opened()) return
        layout.browser.open()
      })
      const unsubscribeClose = browserHostClient.onTabClose(() => {})
      disposeHostClient = () => {
        unsubscribeRequest()
        unsubscribeClose()
      }
    })
  })

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <div class="flex h-full min-h-0 min-w-0 flex-1 flex-row items-stretch">
        <Show when={chatVisible()}>
          <Suspense fallback={<RoutePlaceholder />}>
            <ChatSidebarPane
              state={chatSidebarState}
              opened={chatOpen()}
              onClose={() => layout.chats.close()}
            />
          </Suspense>
        </Show>
        <main class="min-h-0 min-w-0 flex-1 overflow-x-hidden flex flex-col items-start contain-strict">
          <Suspense fallback={<RoutePlaceholder />}>
            {props.children}
          </Suspense>
        </main>
        <div class="my-2 me-2 min-h-0 shrink-0 self-stretch" classList={{ hidden: !limitsVisible() }}>
          <SDKProvider directory={limitsDirectory}>
            <LimitsPanel state={limitsPanelState} opened={limitsVisible()} onClose={() => layout.limits.close()} />
          </SDKProvider>
        </div>
        <Show when={browserVisible()}>
          <Suspense fallback={<RoutePlaceholder />}>
            <BrowserPanelV2
              state={browserV2State}
              opened={browserOpen()}
              onClose={() => layout.browser.close()}
            />
          </Suspense>
        </Show>
      </div>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
