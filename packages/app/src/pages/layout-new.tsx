import { createEffect, createSignal, lazy, onCleanup, onMount, Show, Suspense, type ParentProps } from "solid-js"
import { RoutePlaceholder } from "@/components/route-placeholder"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useLayout } from "@/context/layout"
import { SDKProvider } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { createBrowserPanelV2State } from "@/pages/session/v2/browser-panel-v2-state"
import { createChatSidebarPaneState } from "@/pages/session/v2/chat-sidebar-pane-state"
import { loadChatSidebarPane } from "@/pages/session/v2/chat-sidebar-preload"
import { createLimitsPanelState } from "@/pages/session/limits-panel-state"

const BrowserPanelV2 = lazy(() =>
  import("@/pages/session/v2/browser-panel-v2").then((m) => ({ default: m.BrowserPanelV2 })),
)

const ChatSidebarPane = lazy(() => loadChatSidebarPane().then((m) => ({ default: m.ChatSidebarPane })))

const LimitsPanel = lazy(() =>
  import("@/pages/session/limits-panel").then((m) => ({ default: m.LimitsPanel })),
)

const DebugBar = lazy(() => import("@/components/debug-bar").then((m) => ({ default: m.DebugBar })))
const TabsInfoPopup = lazy(() => import("@/components/help-button").then((m) => ({ default: m.TabsInfoPopup })))

/**
 * Primary desktop application shell.
 *
 * ## Raised route-pane geometry contract — DO NOT DRIFT
 *
 * Direct route children rendered inside this layout's `<main>` participate in
 * a parent-owned flex column. A normal raised page surface must therefore use
 * the established outer geometry:
 *
 * `m-2 min-h-0 min-w-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict`
 *
 * Add `flex` / `flex-col` as the page needs internally, but do **not**
 * hand-roll the outer sizing contract:
 *
 * - Do not replace `m-2` with `m-1` or another bespoke gutter. The margin is
 *   part of the pane's effective height as well as its visual spacing; changing
 *   it makes the route pane visibly taller/shorter than neighboring surfaces.
 * - Do not add `h-full` or `w-full` to a direct route pane. This `<main>`
 *   owns the available dimensions; a child that independently claims 100%
 *   width/height double-counts the gutter and causes overflow/clipping.
 * - Do not substitute bespoke outer borders/radii/elevation for the canonical
 *   raised-pane shell. Put feature-specific framing *inside* the pane instead.
 *
 * Canonical examples include Agent Studio, Scheduled Tasks, Usage, and Home.
 * If a new route genuinely needs different outer geometry, document why rather
 * than silently copying a near-match. This has been a recurring source of UI
 * drift, so future agents should treat the shell geometry as an invariant.
 */
export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const layout = useLayout()
  const [state, setState] = createStore({ debugTools: true })
  const [secondaryChromeReady, setSecondaryChromeReady] = createSignal(false)

  // Help/promotional chrome and dev instrumentation are not prerequisites for
  // navigation or session interaction. Loading them in the initial shell made
  // their drawers, media, tooltips and observers compete with first paint.
  // Keep behavior intact, but let the primary shell win the startup race.
  onMount(() => {
    const idle = window.requestIdleCallback?.(() => setSecondaryChromeReady(true), { timeout: 1000 })
    if (idle !== undefined) {
      onCleanup(() => window.cancelIdleCallback?.(idle))
      return
    }
    const timer = window.setTimeout(() => setSecondaryChromeReady(true), 0)
    onCleanup(() => window.clearTimeout(timer))
  })

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
  // own SDKProvider+FileProvider subtree (session.tsx SessionProviders, and
  // app.tsx ResolvedDraftRoute + DraftProviders for /new-session). Mounting it
  // at this shell level throws "File context must be used within a context
  // provider" at runtime. Session and new-session pages mount it locally;
  // layout.projectExplorer open/close still lives here so the titlebar toggle
  // works on both routes. The new-session tree follows the project selector
  // because SDKProvider.directory is the draft's selected worktree.

  // The browser host client module is loaded lazily (it drags the whole
  // browser pane graph with it); the subscription is torn down via a
  // synchronous onCleanup because the async body runs outside any owner.
  createEffect(() => {
    let disposed = false
    let disposeHostClient = () => {}
    onCleanup(() => {
      disposed = true
      disposeHostClient()
    })
    void import("@/pages/session/v2/browser/browserHostClient").then(({ browserHostClient }) => {
      // Dynamic imports cannot be cancelled. If the layout unmounts while the
      // chunk is loading, do not initialize the browser host or attach global
      // listeners after its owner has already gone away.
      if (disposed) return
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
        <Show when={limitsVisible()}>
          <div class="my-2 me-2 min-h-0 shrink-0 self-stretch">
            <Suspense fallback={<RoutePlaceholder />}>
              <SDKProvider directory={limitsDirectory}>
                <LimitsPanel state={limitsPanelState} opened onClose={() => layout.limits.close()} />
              </SDKProvider>
            </Suspense>
          </div>
        </Show>
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
      <Show when={secondaryChromeReady()}>
        <Suspense>
          {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
          <TabsInfoPopup />
        </Suspense>
      </Show>
      <ToastRegion v2 />
    </div>
  )
}
