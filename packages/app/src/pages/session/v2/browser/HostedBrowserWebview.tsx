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
  untrack,
  type JSX,
  type Ref,
} from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import type { ImageAttachmentPart, TextPart } from "@/context/prompt"
import { sendFollowupDraft, type FollowupDraft } from "@/components/prompt-input/submit"
import { createBlobReference } from "@/utils/draft-store"
import { uuid } from "@/utils/uuid"
import { showToast } from "@/utils/toast"
import { browserHostClient, type BrowserAnnotationResult } from "./browserHostClient"
import { buildBrowserAnnotationPrompt } from "./browserAnnotationPrompt"
import { BrowserChromeMenu } from "./BrowserChromeMenu"
import { browserSurfaceStore } from "./browserSurfaceStore"
import {
  resolveBrowserDeviceViewportArea,
  resolveResponsiveBrowserViewportSize,
  resolveViewportLayout,
  resolveWebviewElementSize,
  resizeBrowserViewportFromRail,
  resizeFreeformViewport,
  aspectRatioOf,
  type ViewportLayout,
} from "./browserViewportLayout"
import { browserViewportSettingKey, type PanelRect, type PresentedContent, type ViewportSetting } from "./types"
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
  const platform = usePlatform()
  const serverSync = useServerSync()
  const canAnnotate = () => !!browserHostClient.annotationTarget()
  const [webviewEl, setWebviewEl] = createSignal<WebviewElement>()
  const [annotating, setAnnotating] = createSignal(false)
  const [preloadPath, setPreloadPath] = createSignal("")
  const [crashed, setCrashed] = createSignal(false)
  const [crashState, setCrashState] = createSignal<WebviewCrashRecoveryState>(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE)
  const [remountKey, setRemountKey] = createSignal(0)
  const [mountGeneration, setMountGeneration] = createSignal(0)
  const [canGoBack, setCanGoBack] = createSignal(false)
  const [canGoForward, setCanGoForward] = createSignal(false)
  const [draftUrl, setDraftUrl] = createSignal("")
  const [activeDirection, setActiveDirection] = createSignal<ResizeDirection | null>(null)
  const [aspectLocked, setAspectLocked] = createSignal(false)
  const [badgesVisible, setBadgesVisible] = createSignal(true)

  let wrapperRef: HTMLDivElement | undefined
  let stageRef: HTMLDivElement | undefined
  let raf = 0
  let registeredWebview: { webContentsId: number; generation: number } | undefined
  let loadingStuckTimer = 0

  const guest = createMemo(() => browserHostClient.guest(props.tabId))
  const [loadingOverride, setLoadingOverride] = createSignal(false)
  const hostState = browserHostClient.state
  const surface = createMemo(() => browserSurfaceStore.get(props.tabId))
  /** Authoritative viewport — persisted, read by every consumer except the
   * live layout during an active resize gesture (see effectiveViewport). */
  const viewport = createMemo(() => surface()?.viewport ?? DEFAULT_VIEWPORT)
  // Derive from guest() (already memoized) rather than a second independent
  // browserHostClient.zoomFactor(tabId) call, which re-does the same
  // hostState().guests.find() lookup guest() already did this tick.
  const zoomFactor = createMemo(() => {
    const zoom = guest().zoomFactor
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  })

  const panelRect = createMemo<PanelRect>(() => {
    const rect = surface()?.rect
    if (rect) return rect
    return { x: 0, y: 0, width: 0, height: 0 }
  })

  // Speculative size during an active pointer drag or keyboard-debounce
  // window — NOT written to browserSurfaceStore until the gesture commits.
  // Persisting on every pointermove/keydown would flood the store (and any
  // future sync/automation layer reading it) with intermediate states nobody
  // needs; T3Code calls this pattern out explicitly (see porting handoff
  // "Mistake 4: persisting every pointer move").
  const [dragViewport, setDragViewport] = createSignal<{ width: number; height: number } | null>(null)
  const effectiveViewport = createMemo<ViewportSetting>(() => {
    const drag = dragViewport()
    const authoritative = viewport()
    if (!drag || authoritative.mode === "fill") return authoritative
    return { ...authoritative, width: drag.width, height: drag.height }
  })

  const layout = createMemo(() => resolveViewportLayout(panelRect(), effectiveViewport(), zoomFactor()))
  const elementSize = createMemo(() => resolveWebviewElementSize(layout()))
  const fillSize = createMemo(() => resolveResponsiveBrowserViewportSize(panelRect(), zoomFactor()))

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
      setLoadingOverride(false)
      clearTimeout(loadingStuckTimer)
      loadingStuckTimer = window.setTimeout(() => {
        setLoadingOverride(true)
      }, 5_000)
    })
    el.addEventListener("did-stop-loading", () => {
      clearTimeout(loadingStuckTimer)
      setLoadingOverride(false)
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
      const webContentsId = el.getWebContentsId()
      const generation = mountGeneration()
      const previous = registeredWebview
      await browserHostClient.registerWebview(props.tabId, webContentsId, generation)
      registeredWebview = { webContentsId, generation }
      if (previous && (previous.webContentsId !== webContentsId || previous.generation !== generation)) {
        void browserHostClient.unregisterWebview(props.tabId, previous.webContentsId, previous.generation)
      }
    } catch {
      // Electron exposes getWebContentsId only after dom-ready; later events retry.
    }
  }

  createEffect(() => {
    browserSurfaceStore.setVisible(props.tabId, props.active)
  })

  onCleanup(() => {
    clearTimeout(loadingStuckTimer)
    if (raf) cancelAnimationFrame(raf)
    if (registeredWebview) {
      void browserHostClient.unregisterWebview(
        props.tabId,
        registeredWebview.webContentsId,
        registeredWebview.generation,
      )
    }
    browserSurfaceStore.clear(props.tabId)
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

  // Coalesces bursts into one measurement per frame — native "scroll" fires
  // far faster than the display refresh rate during momentum/trackpad
  // scrolling, and each measurement forces two synchronous getBoundingClientRect
  // layout reads.
  function scheduleMeasure() {
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => measureAndPresent())
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

  // Panel-rect measurement must NOT live in a createEffect that also reads
  // layout()/panelRect() (both derive from the very store this writes to) —
  // that self-triggers (fixed via browserSurfaceStore's write-dedupe below),
  // but a dedup'd effect only ever measures once: whatever wrapper.clientWidth
  // /clientHeight happens to be on its first run. If that first run lands
  // before the parent flex layout has settled (routinely 0×0 on initial
  // mount), that zero size gets "locked in" forever — the <webview> renders
  // at 0×0 (invisible) for every tab, independent of which URL loaded. A
  // ResizeObserver is the actual source of truth for "the wrapper's size
  // changed" and re-fires on every real layout change (including the
  // display:none → visible transition when a tab becomes active), so use it
  // instead of relying on the render-reactive graph for this.
  let panelResizeObserver: ResizeObserver | undefined
  onMount(() => {
    if (!wrapperRef) return
    panelResizeObserver = new ResizeObserver(() => presentPanelRect())
    panelResizeObserver.observe(wrapperRef)
    presentPanelRect()
  })
  onCleanup(() => panelResizeObserver?.disconnect())

  createEffect(() => {
    layout()
    elementSize()
    scheduleMeasure()
  })

  // ── resize drags ───────────────────────────────────────────────────────────
  //
  // Both gestures share one invalidation rule: capture browserViewportSettingKey
  // at the start, and refuse to touch the authoritative store if it no longer
  // matches when the gesture would commit. Nothing external mutates viewport
  // mid-gesture in this build (no agent resize tool yet), but this is cheap,
  // matches the T3 handoff's explicit invariant, and protects the one real
  // local race today: pointer-drag and keyboard-debounce cancelling each other.

  let keyboardTimer: number | undefined
  let keyboardSourceKey: string | undefined
  let keyboardPending: { width: number; height: number } | undefined

  function cancelKeyboardPending() {
    if (keyboardTimer) window.clearTimeout(keyboardTimer)
    keyboardTimer = undefined
    keyboardSourceKey = undefined
    keyboardPending = undefined
  }

  onCleanup(cancelKeyboardPending)

  const onResizePointerDown = (direction: ResizeDirection, event: PointerEvent) => {
    const authoritative = viewport()
    if (authoritative.mode === "fill" || authoritative.width == null || authoritative.height == null) return
    event.preventDefault()
    cancelKeyboardPending()
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)

    const pointerId = event.pointerId
    const sourceKey = browserViewportSettingKey(authoritative)
    const startPointer = { x: event.clientX, y: event.clientY }
    const startSize = { width: authoritative.width, height: authoritative.height }
    const available = resolveBrowserDeviceViewportArea(panelRect())
    // Captured once at grab time, not recomputed per move — recomputing mid-
    // gesture would change the pointer-to-logical mapping itself and make the
    // handle accelerate/drift (see browserViewportLayout.ts's rail-solver doc).
    const dragZoomFactor = zoomFactor() * layout().viewportScale
    let latest = startSize

    setActiveDirection(direction)
    setDragViewport(startSize)
    browserSurfaceStore.setDragging(props.tabId, true)

    const sourceStillCurrent = () => browserViewportSettingKey(viewport()) === sourceKey

    function cleanup() {
      setActiveDirection(null)
      setDragViewport(null)
      browserSurfaceStore.setDragging(props.tabId, false)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
    }

    function onMove(move: PointerEvent) {
      if (move.pointerId !== pointerId) return
      if (!sourceStillCurrent()) {
        cleanup()
        return
      }
      const delta = { x: move.clientX - startPointer.x, y: move.clientY - startPointer.y }
      const aspect = aspectLocked() ? aspectRatioOf(startSize.width, startSize.height) : null
      latest = resizeBrowserViewportFromRail(startSize, delta, available, dragZoomFactor, direction, aspect)
      setDragViewport(latest)
    }

    function onUp(up: PointerEvent) {
      if (up.pointerId !== pointerId) return
      cleanup()
      if (!sourceStillCurrent()) return
      if (latest.width === startSize.width && latest.height === startSize.height) return
      // A manual rail drag always commits as freeform, even starting from a
      // preset — matches T3's "dragging a preset converts it to freeform."
      browserSurfaceStore.setViewport(props.tabId, {
        ...authoritative,
        mode: "freeform",
        presetId: null,
        width: latest.width,
        height: latest.height,
      })
    }

    function onCancel(cancel: PointerEvent) {
      if (cancel.pointerId !== pointerId) return
      cleanup()
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
  }

  const onResizeKeyDown = (direction: ResizeDirection, event: KeyboardEvent) => {
    const authoritative = viewport()
    if (authoritative.mode === "fill" || authoritative.width == null || authoritative.height == null) return
    // Semantic logical-CSS-pixel steps, not a physical mouse-distance mapping
    // — no rail/fit-scale conversion here, only zoom normalization.
    const step = event.shiftKey ? 50 : 10
    let dx = 0
    let dy = 0
    if (event.key === "ArrowLeft") dx = -step
    else if (event.key === "ArrowRight") dx = step
    else if (event.key === "ArrowUp") dy = -step
    else if (event.key === "ArrowDown") dy = step
    else return
    event.preventDefault()

    const sourceKey = browserViewportSettingKey(authoritative)
    const base =
      keyboardSourceKey === sourceKey && keyboardPending
        ? keyboardPending
        : { width: authoritative.width, height: authoritative.height }
    const aspect = aspectLocked() ? aspectRatioOf(base.width, base.height) : null
    const next = resizeFreeformViewport(base, { x: dx, y: dy }, zoomFactor(), direction, aspect)

    keyboardSourceKey = sourceKey
    keyboardPending = next
    setDragViewport(next)
    setActiveDirection(direction)

    if (keyboardTimer) window.clearTimeout(keyboardTimer)
    keyboardTimer = window.setTimeout(() => {
      keyboardTimer = undefined
      const pendingKey = keyboardSourceKey
      const pendingSize = keyboardPending
      keyboardSourceKey = undefined
      keyboardPending = undefined
      setDragViewport(null)
      setActiveDirection(null)
      if (!pendingSize || pendingKey !== browserViewportSettingKey(viewport())) return
      browserSurfaceStore.setViewport(props.tabId, {
        ...authoritative,
        mode: "freeform",
        presetId: null,
        width: pendingSize.width,
        height: pendingSize.height,
      })
    }, 150)
  }

  // ── chrome actions ─────────────────────────────────────────────────────────

  onCleanup(() => {
    if (annotating()) void browserHostClient.cancelAnnotation(props.tabId)
  })

  /** Converts a resolved annotation into composer content parts: the
   * structured prompt block as a trailing text part, plus the screenshot
   * crop (if capture succeeded) as an image attachment — same shape a
   * pasted/dropped image takes (see prompt-input/attachments.ts). Screenshot
   * failure never blocks the text context from landing. */
  async function buildAnnotationParts(annotation: BrowserAnnotationResult): Promise<Array<TextPart | ImageAttachmentPart>> {
    const parts: Array<TextPart | ImageAttachmentPart> = [
      { type: "text", content: buildBrowserAnnotationPrompt(annotation), start: 0, end: 0 },
    ]
    if (!annotation.screenshot) return parts
    try {
      const response = await fetch(annotation.screenshot.dataUrl)
      const blob = await response.blob()
      const file = new File([blob], `browser-annotation-${annotation.id}.png`, { type: annotation.screenshot.mime })
      parts.push({
        type: "image",
        id: uuid(),
        filename: file.name,
        mime: annotation.screenshot.mime,
        blob: platform.draftStore ? await platform.draftStore.putBlob(file) : await createBlobReference(file),
      })
    } catch {
      // Attachment conversion failure must not discard the structured
      // annotation text already queued above.
    }
    return parts
  }

  function attachAnnotation(parts: Array<TextPart | ImageAttachmentPart>) {
    const target = browserHostClient.annotationTarget()
    if (!target) return
    const capture = target.capture()
    capture.set([...capture.current(), ...parts], capture.cursor())
  }

  /** True send (not just attach-to-draft): builds a minimal FollowupDraft and
   * calls the same lower-level send path the composer itself uses
   * (sendFollowupDraft — see prompt-input/submit.ts). Deliberately does NOT
   * reconstruct the composer's full handleSubmit orchestration (new-session
   * creation, worktree selection, input history, popover state) — none of
   * that applies here: the browser panel only exists inside an ALREADY-open
   * session, so sessionID is always live and there is no "create a session
   * first" branch to handle. Falls back to attaching if there's no live
   * session or no model/agent selected, rather than silently dropping the
   * annotation. */
  async function sendAnnotation(parts: Array<TextPart | ImageAttachmentPart>) {
    const target = browserHostClient.annotationTarget()
    if (!target) return
    if (!target.agent || !target.model.providerID) {
      attachAnnotation(parts)
      showToast({ title: language.t("browser.annotate.toast.attached.title") })
      return
    }
    const draft: FollowupDraft = {
      sessionID: target.sessionID,
      sessionDirectory: target.directory,
      prompt: parts,
      context: [],
      agent: target.agent,
      model: { providerID: target.model.providerID, modelID: target.model.modelID },
      variant: target.model.variant ?? undefined,
    }
    try {
      await sendFollowupDraft({ api: target.api, serverSync: serverSync(), sync: target.sync, draft })
    } catch {
      // sendFollowupDraft already toasts its own failure; nothing further to
      // do here — the structured content was never silently discarded since
      // it was only ever held in `parts`, not committed to the draft.
    }
  }

  const toggleAnnotate = async () => {
    if (annotating()) {
      setAnnotating(false)
      void browserHostClient.cancelAnnotation(props.tabId)
      return
    }
    if (!canAnnotate()) {
      showToast({ title: language.t("browser.annotate.toast.unavailable") })
      return
    }
    setAnnotating(true)
    const result = await browserHostClient.startAnnotation(props.tabId)
    setAnnotating(false)
    if (!result) return
    const parts = await buildAnnotationParts(result)
    if (result.submission === "send") {
      await sendAnnotation(parts)
      return
    }
    attachAnnotation(parts)
    showToast({ title: language.t("browser.annotate.toast.attached.title") })
  }

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
    // Host-level reload (D8a): the engine owns the webview reload so the broker
    // stays authoritative; falls back to the DOM call when the host is gone.
    void browserHostClient.refreshTab(guest().tabId)
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

  const loading = () => guest().loading && !loadingOverride()
  const controller = () => guest().controller
  const url = () => guest().url
  const title = () => guest().title

  // `src` seeds a <webview>'s FIRST navigation only — Electron treats any
  // later `src` reassignment as a brand-new document load. Once the element
  // exists, all further navigation (redirects, SPA history changes, link
  // clicks, agent-driven CDP ops, the address bar's el.loadURL() call) must
  // happen without touching `src` again, or every redirect/URL update
  // becomes a visible reload (this is what broke google.com: it rewrites its
  // own URL via history APIs on nearly every interaction). So `mountUrl` is
  // captured once at setup — synchronously, not inside an effect, so it is
  // never subscribed to url()/draftUrl() — and is only ever re-seeded when a
  // NEW <webview> element is about to be created (the crash-recovery
  // remount below), using the most recently known live URL.
  const [mountUrl, setMountUrl] = createSignal(url() || draftUrl() || "about:blank")
  let seededGeneration = remountKey()

  createEffect(() => {
    const key = remountKey()
    setMountGeneration(key)
    if (key === seededGeneration) return
    seededGeneration = key
    setMountUrl(untrack(() => draftUrl() || url() || "about:blank"))
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

        <Show when={canAnnotate()}>
          <IconButton
            label={annotating() ? language.t("browser.nav.cancelAnnotate") : language.t("browser.nav.annotate")}
            onClick={() => void toggleAnnotate()}
            title={annotating() ? language.t("browser.nav.cancelAnnotate") : language.t("browser.nav.annotate")}
            active={annotating()}
            data-testid="browser-annotate"
          >
            <AnnotateIcon />
          </IconButton>
        </Show>
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
        <BrowserChromeMenu tabId={props.tabId} />
      </div>

      {/* ── device/viewport toolbar: part of the chrome flow (not an overlay),
          so the canvas below shrinks to make room for it and the webview's
          measured panel rect respects it. ── */}
      <Show when={supported() && hostState().connected && !crashed()}>
        <BrowserDeviceToolbar
          setting={viewport()}
          fillSize={fillSize()}
          aspectRatioLocked={aspectLocked()}
          badgesVisible={badgesVisible()}
          onChange={(setting) => browserSurfaceStore.setViewport(props.tabId, setting)}
          onAspectRatioChange={setAspectLocked}
          onBadgesToggle={() => setBadgesVisible(!badgesVisible())}
        />
      </Show>

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
              onScroll={scheduleMeasure}
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
                    src={mountUrl()}
                    partition={BROWSER_PARTITION}
                    preload={preloadPath() || undefined}
                    class="absolute"
                    style={{
                      // Position at the SOLVED viewport origin, then scale
                      // with transform-origin pinned to that same top-left
                      // corner — the scaled box's top-left never moves, and
                      // its rendered size becomes exactly viewportWidth ×
                      // viewportHeight, matching the frame/handles below.
                      // Was hardcoded to left:0/top:0 (Tailwind `left-0
                      // top-0`), so a centered/rail-offset viewport always
                      // rendered flush with the stage's corner instead of
                      // inside its own frame.
                      left: `${layout().viewportX}px`,
                      top: `${layout().viewportY}px`,
                      width: `${elementSize().width}px`,
                      height: `${elementSize().height}px`,
                      transform: layout().viewportScale === 1 ? undefined : `scale(${layout().viewportScale})`,
                      "transform-origin": "top left",
                    }}
                    data-browser-webview
                    data-css-width={Math.round(effectiveViewport().width ?? panelRect().width)}
                    data-css-height={Math.round(effectiveViewport().height ?? panelRect().height)}
                    data-css-zoom={zoomFactor()}
                  />
                </Show>

                {/* Device frame: a visible outline + soft shadow around the
                    fixed viewport so it reads as a deliberate device
                    boundary rather than content floating in empty space.
                    ring-inset keeps it flush with the exact solved geometry
                    (unlike border, which would grow the box). Brightens to
                    the accent color while a resize is in progress. */}
                <Show when={!layout().fillsPanel}>
                  <div
                    class="pointer-events-none absolute z-20 rounded-[3px] shadow-md ring-1 ring-inset ring-v2-border-border-base transition-[box-shadow] duration-150"
                    classList={{ "ring-v2-text-text-accent": !!activeDirection() }}
                    style={{
                      left: `${layout().viewportX}px`,
                      top: `${layout().viewportY}px`,
                      width: `${layout().viewportWidth}px`,
                      height: `${layout().viewportHeight}px`,
                    }}
                    data-browser-device-frame
                  />
                </Show>

                <BrowserViewportResizeHandles
                  layout={layout()}
                  activeDirection={activeDirection()}
                  onPointerDown={onResizePointerDown}
                  onKeyDown={onResizeKeyDown}
                />

                <Show when={activeDirection() && effectiveViewport().width != null && effectiveViewport().height != null}>
                  <ViewportDimensionBadge layout={layout()} width={effectiveViewport().width!} height={effectiveViewport().height!} />
                </Show>
              </div>
            </div>

            <Show when={loading()}>
              <div class="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden">
                <div class="browser-loading-indeterminate h-full w-1/2 bg-v2-text-text-accent" />
              </div>
            </Show>

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

/** Live "W × H" readout during an active rail/keyboard resize — positioned
 * against the solved current layout (not the gesture's starting rect), so it
 * tracks the viewport as it's resized. Inset from the top edge rather than
 * floating above it so it never goes off-canvas for a viewport centered near
 * the top of the panel. */
function ViewportDimensionBadge(props: { layout: ViewportLayout; width: number; height: number }) {
  return (
    <div
      class="pointer-events-none absolute z-30 flex h-5 items-center rounded-[4px] border border-v2-border-border-base bg-v2-background-bg-base/95 px-1.5 text-[10px] font-medium leading-none tabular-nums text-v2-text-text-base shadow-sm backdrop-blur-sm"
      style={{
        left: `${props.layout.viewportX + props.layout.viewportWidth / 2}px`,
        top: `${props.layout.viewportY + 6}px`,
        transform: "translate(-50%, 0)",
      }}
      data-browser-viewport-dimension-badge
    >
      {props.width} × {props.height}
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
  active?: boolean
  onClick: () => void
  children: JSX.Element
  "data-testid"?: string
}) {
  return (
    <button
      type="button"
      data-active={props.active || undefined}
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-v2-text-text-muted transition-colors duration-100 hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent data-[active=true]:bg-v2-text-text-accent data-[active=true]:text-v2-background-bg-base data-[active=true]:hover:bg-v2-text-text-accent"
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid={props["data-testid"]}
    >
      {props.children}
    </button>
  )
}

function AnnotateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11 2.5l2.5 2.5-7.5 7.5H3.5v-2.5L11 2.5z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

const DEFAULT_VIEWPORT: ViewportSetting = {
  mode: "fill",
  width: null,
  height: null,
  presetId: null,
  orientation: "portrait",
}
