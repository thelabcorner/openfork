// HostedBrowserWebview: one hosted browser tab — address chrome + the
// <webview> canvas with the device toolbar, resize handles, agent cursor,
// element badges, snapshot summary, crash recovery, and the action timeline.
//
// The <webview> tag only exists in the Electron shell (webviewTag:true,
// partition enforced at attach). In the plain web app the host is absent and
// the tab renders the unavailable state.
//
// Layout model (browserViewportLayout.ts): the guest page always renders at
// its LOGICAL CSS viewport; the webview DOM element is sized logical*zoom and
// scaled by the fit factor — scaling never changes the page's CSS breakpoint.
// The cursor/badges map guest CSS px through the presented content rect
// (cursorMath.ts), pushed here on scroll/resize/rAF.

import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
  type Ref,
} from "solid-js"
import { useLanguage } from "@/context/language"
import { browserHostClient } from "./browserHostClient"
import { browserSurfaceStore } from "./browserSurfaceStore"
import { resolveFittedSourceContent, resolveViewportLayout, resolveWebviewElementSize, applyViewportResize, aspectRatioOf } from "./browserViewportLayout"
import { VIEWPORT_MIN_SIZE, type PanelRect, type PresentedContent, type ViewportSetting } from "./types"
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar"
import { BrowserViewportResizeHandles, type ResizeDirection } from "./BrowserViewportResizeHandles"
import { AgentBrowserCursor } from "./AgentBrowserCursor"
import { ElementBadgeOverlay } from "./ElementBadgeOverlay"
import { SnapshotSummary } from "./SnapshotSummary"
import { AgentActionTimeline } from "./AgentActionTimeline"
import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  planWebviewCrashRecovery,
  type WebviewCrashRecoveryState,
} from "./webviewCrashRecovery"

// Mirror of the engine's BROWSER_PARTITION (main/browser/contracts.ts) — the
// guest partition is enforced at attach; the renderer tag must request it.
const BROWSER_PARTITION = "persist:opencode-browser-v1"

interface WebviewElement extends HTMLElement {
  getWebContentsId: () => number
  loadURL: (url: string) => Promise<void>
  goBack: () => void
  goForward: () => void
  reload: () => void
  stop: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  getURL: () => string
  getTitle: () => string
  isCrashed: () => boolean
}

function webviewSupported(): boolean {
  if (typeof document === "undefined") return false
  try {
    const probe = document.createElement("webview") as unknown as { getWebContentsId?: unknown }
    return typeof probe.getWebContentsId === "function"
  } catch {
    return false
  }
}

export function HostedBrowserWebview(props: {
  /** Runtime tab id (engine-allocated; keys all per-tab stores). */
  tabId: string
  active: boolean
  onClose: () => void
  onNewTab: () => void
}) {
  const language = useLanguage()
  const [webviewEl, setWebviewEl] = createSignal<WebviewElement>()
  const [preloadPath, setPreloadPath] = createSignal("")
  const [crashed, setCrashed] = createSignal(false)
  const [crashState, setCrashState] = createSignal<WebviewCrashRecoveryState>(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE)
  const [remountKey, setRemountKey] = createSignal(0)
  const [canGoBack, setCanGoBack] = createSignal(false)
  const [canGoForward, setCanGoForward] = createSignal(false)
  const [draftUrl, setDraftUrl] = createSignal("")
  const [activeDirection, setActiveDirection] = createSignal<ResizeDirection | null>(null)
  const [dragStart, setDragStart] = createSignal<{ width: number; height: number; x: number; y: number }>()
  const [aspectLocked, setAspectLocked] = createSignal(false)
  const [badgesVisible, setBadgesVisible] = createSignal(true)

  let wrapperRef: HTMLDivElement | undefined
  let stageRef: HTMLDivElement | undefined
  let raf = 0

  const guest = createMemo(() => browserHostClient.guest(props.tabId))
  const hostState = browserHostClient.state
  const surface = createMemo(() => browserSurfaceStore.get(props.tabId))
  const viewport = createMemo(() => surface()?.viewport ?? DEFAULT_VIEWPORT)
  const zoomFactor = createMemo(() => {
    const zoom = browserHostClient.zoomFactor(props.tabId)
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  })

  const panelRect = createMemo<PanelRect>(() => {
    const rect = surface()?.rect
    if (rect) return rect
    return { x: 0, y: 0, width: 0, height: 0 }
  })

  const layout = createMemo(() => resolveViewportLayout(panelRect(), viewport(), zoomFactor()))
  const elementSize = createMemo(() => resolveWebviewElementSize(layout()))
  const fillSize = createMemo(() => resolveFittedSourceContent(panelRect(), zoomFactor()))

  // ── webview lifecycle ─────────────────────────────────────────────────────

  onMount(() => {
    if (!webviewSupported()) return
    void browserHostClient.getGuestPreloadPath().then((path) => {
      if (path) setPreloadPath(path)
    })
  })

  const attach = (el: WebviewElement | undefined) => {
    if (!el) return
    setWebviewEl(el)
    el.addEventListener("did-start-loading", () => {
      setCrashed(false)
    })
    el.addEventListener("did-stop-loading", () => {
      setCanGoBack(el.canGoBack())
      setCanGoForward(el.canGoForward())
      setDraftUrl(el.getURL())
    })
    el.addEventListener("did-navigate", () => {
      setCanGoBack(el.canGoBack())
      setCanGoForward(el.canGoForward())
      setDraftUrl(el.getURL())
      void register()
    })
    el.addEventListener("did-navigate-in-page", () => {
      setCanGoBack(el.canGoBack())
      setCanGoForward(el.canGoForward())
      setDraftUrl(el.getURL())
    })
    el.addEventListener("dom-ready", () => {
      void register()
    })
    el.addEventListener("render-process-gone", () => {
      setCrashed(true)
      const now = Date.now()
      const plan = planWebviewCrashRecovery(crashState(), now)
      setCrashState(plan.state)
      if (plan.remount) {
        const key = remountKey() + 1
        window.setTimeout(() => setRemountKey(key), plan.delayMs)
      }
    })
  }

  async function register() {
    const el = webviewEl()
    if (!el) return
    try {
      await browserHostClient.registerWebview(props.tabId, el.getWebContentsId())
    } catch {
      // The engine logs; the panel keeps rendering the empty webview.
    }
  }

  createEffect(() => {
    browserSurfaceStore.setVisible(props.tabId, props.active)
  })

  createEffect(() => {
    const el = webviewEl()
    if (!el) return
    const clean = () => {
      void browserHostClient.unregisterWebview(props.tabId)
      browserSurfaceStore.clear(props.tabId)
    }
    onCleanup(clean)
  })

  onCleanup(() => {
    if (raf) cancelAnimationFrame(raf)
  })

  // ── presentation (panel rect + content push) ──────────────────────────────

  function measureAndPresent() {
    const el = webviewEl()
    const wrapper = wrapperRef
    if (!props.active) return
    if (!el || !wrapper) return
    const wrapperRect = wrapper.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const scale = layout().viewportScale
    const content: PresentedContent = {
      x: elRect.left - wrapperRect.left + wrapper.scrollLeft,
      y: elRect.top - wrapperRect.top + wrapper.scrollTop,
      width: elRect.width,
      height: elRect.height,
      scale,
      scrollLeft: wrapper.scrollLeft,
      scrollTop: wrapper.scrollTop,
    }
    browserSurfaceStore.presentContent(props.tabId, content)
  }

  function presentPanelRect() {
    const wrapper = wrapperRef
    if (!props.active) return
    if (!wrapper) return
    browserSurfaceStore.presentRect(props.tabId, {
      x: 0,
      y: 0,
      width: wrapper.clientWidth,
      height: wrapper.clientHeight,
    })
  }

  createEffect(() => {
    layout()
    elementSize()
    presentPanelRect()
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      measureAndPresent()
    })
  })

  // ── resize drags ───────────────────────────────────────────────────────────

  const onResizePointerDown = (direction: ResizeDirection, event: PointerEvent) => {
    const current = viewport()
    if (current.width == null || current.height == null) return
    event.preventDefault()
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
    setActiveDirection(direction)
    setDragStart({ width: current.width, height: current.height, x: event.clientX, y: event.clientY })

    const onMove = (move: PointerEvent) => {
      const start = dragStart()
      if (!start) return
      const dx = move.clientX - start.x
      const dy = move.clientY - start.y
      const aspect = aspectLocked() ? aspectRatioOf(start.width, start.height) : null
      const next = applyViewportResize(start, { direction, dx, dy }, { minSize: VIEWPORT_MIN_SIZE, aspectRatio: aspect })
      browserSurfaceStore.setViewport(props.tabId, { ...current, width: next.width, height: next.height })
      browserSurfaceStore.setDragging(props.tabId, true)
    }
    const onUp = () => {
      setActiveDirection(null)
      setDragStart(undefined)
      browserSurfaceStore.setDragging(props.tabId, false)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }

  const onResizeKeyDown = (direction: ResizeDirection, event: KeyboardEvent) => {
    const current = viewport()
    if (current.width == null || current.height == null) return
    const step = event.shiftKey ? 64 : 16
    let dx = 0
    let dy = 0
    if (event.key === "ArrowLeft") dx = -step
    else if (event.key === "ArrowRight") dx = step
    else if (event.key === "ArrowUp") dy = -step
    else if (event.key === "ArrowDown") dy = step
    else return
    event.preventDefault()
    const aspect = aspectLocked() ? aspectRatioOf(current.width, current.height) : null
    const next = applyViewportResize(
      { width: current.width, height: current.height },
      { direction, dx, dy },
      { minSize: VIEWPORT_MIN_SIZE, aspectRatio: aspect },
    )
    browserSurfaceStore.setViewport(props.tabId, { ...current, width: next.width, height: next.height })
  }

  // ── chrome actions ─────────────────────────────────────────────────────────

  const submitAddress = (event: SubmitEvent) => {
    event.preventDefault()
    const raw = draftUrl().trim()
    if (!raw) return
    const el = webviewEl()
    if (!el) return
    const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`
    void el.loadURL(url)
  }

  const reloadPage = () => {
    webviewEl()?.reload()
  }

  const stopLoading = () => {
    webviewEl()?.stop()
  }

  const goBackPage = () => {
    webviewEl()?.goBack()
  }

  const goForwardPage = () => {
    webviewEl()?.goForward()
  }

  const loading = () => guest().loading
  const controller = () => guest().controller
  const url = () => guest().url
  const title = () => guest().title

  const webviewUrl = createMemo(() => {
    const current = url()
    if (current) return current
    return draftUrl() || "about:blank"
  })

  const supported = () => webviewSupported()

  return (
    <div
      class="absolute inset-0 flex h-full min-h-0 flex-col"
      classList={{ hidden: !props.active }}
      data-browser-tab
      data-tab-id={props.tabId}
    >
      {/* ── address chrome ── */}
      <div
        class="flex h-8 shrink-0 items-center gap-1 border-b border-v2-border-border-base bg-v2-background-bg-base px-1.5"
        data-browser-address-bar
      >
        <IconButton
          label={language.t("browser.nav.back")}
          disabled={!canGoBack()}
          onClick={goBackPage}
          title={language.t("browser.nav.back")}
          data-testid="browser-back"
        >
          <NavIcon d="M10.5 4.5L6 9L10.5 13.5" />
        </IconButton>
        <IconButton
          label={language.t("browser.nav.forward")}
          disabled={!canGoForward()}
          onClick={goForwardPage}
          title={language.t("browser.nav.forward")}
          data-testid="browser-forward"
        >
          <NavIcon d="M5.5 4.5L10 9L5.5 13.5" />
        </IconButton>
        <IconButton
          label={loading() ? language.t("browser.nav.stop") : language.t("browser.nav.reload")}
          onClick={loading() ? stopLoading : reloadPage}
          title={loading() ? language.t("browser.nav.stop") : language.t("browser.nav.reload")}
          data-testid="browser-reload"
        >
          <Show when={loading()} fallback={<NavIcon d="M13 8a5 5 0 1 1-1.5-3.5M13 8V4M13 8H9" />}>
            <NavIcon d="M5 5L11 11M11 5L5 11" />
          </Show>
        </IconButton>

        <form class="min-w-0 flex-1" onSubmit={submitAddress}>
          <input
            class="h-6 w-full min-w-0 rounded-[4px] border border-transparent bg-v2-background-bg-layer-01 px-2 text-[11px] leading-none text-v2-text-text-base outline-none transition-colors duration-100 placeholder:text-v2-text-text-muted focus:border-v2-border-border-strong"
            value={draftUrl()}
            onInput={(event) => setDraftUrl(event.currentTarget.value)}
            placeholder={language.t("browser.address.placeholder")}
            spellcheck={false}
            aria-label={language.t("browser.address.placeholder")}
            data-testid="browser-address"
          />
        </form>

        <IconButton
          label={language.t("browser.nav.newTab")}
          onClick={props.onNewTab}
          title={language.t("browser.nav.newTab")}
          data-testid="browser-new-tab"
        >
          <NavIcon d="M8 3.5V12.5M3.5 8H12.5" />
        </IconButton>
        <IconButton
          label={language.t("common.close")}
          onClick={props.onClose}
          title={language.t("common.close")}
          data-testid="browser-close-tab"
        >
          <NavIcon d="M5 5L11 11M11 5L5 11" />
        </IconButton>
      </div>

      {/* ── canvas ── */}
      <div class="relative min-h-0 flex-1 overflow-hidden" data-browser-canvas>
        <Show when={supported() && hostState().connected} fallback={<UnavailableState />}>
          <Show
            when={!crashed()}
            fallback={
              <div class="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-v2-background-bg-base" data-browser-crash>
                <div class="text-[12px] text-v2-text-text-base">{language.t("browser.crash.title")}</div>
                <button
                  type="button"
                  class="h-6 rounded-[4px] bg-v2-background-bg-layer-03 px-2 text-[11px] leading-none text-v2-text-text-base transition-colors duration-100 hover:bg-v2-background-bg-layer-02"
                  onClick={() => {
                    setCrashState(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE)
                    setCrashed(false)
                    setRemountKey((key) => key + 1)
                  }}
                >
                  {language.t("browser.crash.reload")}
                </button>
              </div>
            }
          >
            <div
              ref={wrapperRef}
              class="absolute inset-0 overflow-auto"
              data-browser-canvas-scroll
              onScroll={() => measureAndPresent()}
            >
              <div
                ref={stageRef}
                class="relative"
                style={{
                  width: `${layout().canvasWidth}px`,
                  height: `${layout().canvasHeight}px`,
                }}
                data-browser-stage
              >
                {/* Keyed by the crash-recovery remount counter: a new key
                    disposes the old <webview> and mounts a fresh one. */}
                <Show when={remountKey() + 1} keyed>
                  <webview
                    ref={attach as unknown as Ref<HTMLElement>}
                    src={webviewUrl()}
                    partition={BROWSER_PARTITION}
                    preload={preloadPath() || undefined}
                    class="absolute left-0 top-0"
                    style={{
                      width: `${elementSize().width}px`,
                      height: `${elementSize().height}px`,
                      transform: layout().viewportScale === 1 ? undefined : `scale(${layout().viewportScale})`,
                      "transform-origin": "top left",
                    }}
                    data-browser-webview
                    data-css-width={Math.round(viewport().width ?? panelRect().width)}
                    data-css-height={Math.round(viewport().height ?? panelRect().height)}
                    data-css-zoom={zoomFactor()}
                  />
                </Show>

                <BrowserViewportResizeHandles
                  layout={layout()}
                  activeDirection={activeDirection()}
                  onPointerDown={onResizePointerDown}
                  onKeyDown={onResizeKeyDown}
                />
              </div>
            </div>

            <Show when={loading()}>
              <div class="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden">
                <div class="browser-loading-indeterminate h-full w-1/2 bg-v2-text-text-accent" />
              </div>
            </Show>

            <BrowserDeviceToolbar
              setting={viewport()}
              fillSize={fillSize()}
              aspectRatioLocked={aspectLocked()}
              badgesVisible={badgesVisible()}
              onChange={(setting) => browserSurfaceStore.setViewport(props.tabId, setting)}
              onAspectRatioChange={setAspectLocked}
              onBadgesToggle={() => setBadgesVisible(!badgesVisible())}
            />

            <AgentBrowserCursor
              tabId={props.tabId}
              runtimeTabId={props.tabId}
              zoomFactor={zoomFactor()}
              controller={controller()}
            />
            <ElementBadgeOverlay tabId={props.tabId} zoomFactor={zoomFactor()} visible={badgesVisible()} />
            <SnapshotSummary tabId={props.tabId} />
            <AgentActionTimeline tabId={props.tabId} />
          </Show>
        </Show>
      </div>
    </div>
  )
}

function UnavailableState() {
  const language = useLanguage()
  return (
    <div class="absolute inset-0 z-10 flex items-center justify-center bg-v2-background-bg-base">
      <div class="max-w-[240px] text-center text-[12px] leading-relaxed text-v2-text-text-muted">
        {language.t("browser.panel.unavailable")}
      </div>
    </div>
  )
}

function NavIcon(props: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={props.d} stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

function IconButton(props: {
  label: string
  title: string
  disabled?: boolean
  onClick: () => void
  children: JSX.Element
  "data-testid"?: string
}) {
  return (
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-v2-text-text-muted transition-colors duration-100 hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
      aria-label={props.label}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid={props["data-testid"]}
    >
      {props.children}
    </button>
  )
}

const DEFAULT_VIEWPORT: ViewportSetting = {
  mode: "fill",
  width: null,
  height: null,
  presetId: null,
  orientation: "portrait",
}
