// Human-in-the-loop annotation session controller. Owns the main-process half
// of the guest-preload annotation protocol (annotation-overlay.ts): starts a
// pick session, validates the returned payload (trust boundary — the guest
// never supplies its own screenshot), captures the requested crop, and
// resolves with a structured result the renderer can turn into composer
// context. One active session per tab; a new pick cancels a stale one.
//
// State machine (the renderer is a PURE reflection of this — it must never
// keep a second optimistic copy of these states):
//
//   idle ──start()──▶ arming ──pick received──▶ active ──validated──▶ submitting
//                                                        │                       │
//                          (destroy / main-frame         │ (gen mismatch /       │ (destroy / main-frame
//                           navigation while armed)      │  navigation / timeout)│  navigation before submit)
//                                                        ▼                       ▼
//                                                     cancelled               capturing ──▶ settled
//
// Terminal states: `settled` (carries the structured result, screenshot may be
// null) and `cancelled` (resolves null). Cancellation is a NORMAL outcome and
// never throws.

import type { NativeImage, WebContents } from "electron"
import {
  ANNOTATION_CANCEL_CHANNEL,
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_PICKED_CHANNEL,
  ANNOTATION_START_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  isBrowserAnnotationPayload,
  type BrowserAnnotationPayload,
  type BrowserAnnotationResult,
  type Rect,
} from "./contracts"

/** Hard ceiling on the composite submitting+capturing phase. An ipcMain.handle
 * promise that never resolves would leave the Annotate button permanently
 * stuck, so we settle the structured annotation (without a screenshot) instead. */
const ANNOTATION_SUBMIT_TIMEOUT_MS = 5_000

/** Long-edge cap for the encoded PNG so a 4K guest page can't yield a
 * multi-megabyte data URL into the composer draft. */
const ANNOTATION_MAX_SCREENSHOT_LONG_EDGE = 1_600

type AnnotationState =
  | "idle"
  | "arming"
  | "active"
  | "submitting"
  | "capturing"
  | "settled"
  | "cancelled"

interface AnnotationSessionIdentity {
  /** Monotonic registry generation for the tab at pick time. Re-asserted before
   * every capture so a stale completion cannot photograph a replacement guest. */
  generation: number
  webContentsId: number
  /** Live read of the registry's current generation for `tabId`. */
  getCurrentGeneration: (tabId: string) => number | undefined
  /** Live read of the guest's current viewport (for host-side crop clamping). */
  getCurrentViewport: (tabId: string) => Size | undefined
}

interface Size {
  width: number
  height: number
}

type AnnotationBase = Omit<BrowserAnnotationResult, "screenshot">

interface Session {
  tabId: string
  wc: WebContents
  identity: AnnotationSessionIdentity
  colorScheme: "light" | "dark"
  state: AnnotationState
  /** True once settle() has run. A cancelled/navigated/timed-out session must
   * never be acked or settled again, even if an in-flight capture later
   * resolves (generation does NOT change on navigation, so the generation
   * guard alone would not catch it). */
  settled: boolean
  onPicked: (event: unknown, raw: unknown) => void
  onDestroyed: () => void
  onNavigate: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
  settle: (result: BrowserAnnotationResult | null) => void
  /** Composite-phase timeout handle (set once we begin submitting). */
  timeout: ReturnType<typeof setTimeout> | null
  /** Structured payload captured so far, so a timeout can degrade to it. */
  pendingBase: AnnotationBase | null
}

export class AnnotationController {
  private readonly sessions = new Map<string, Session>()

  /** Begin a pick session on `tabId`'s webContents; resolves with the
   * structured result on submit, or `null` on cancel/navigation/destruction.
   * Never rejects — cancellation is a normal outcome, not an error.
   * `identity` carries the session's generation so every async completion can
   * re-assert it still owns the tab before photographing. */
  start(
    tabId: string,
    wc: WebContents,
    colorScheme: "light" | "dark",
    identity: AnnotationSessionIdentity,
  ): Promise<BrowserAnnotationResult | null> {
    this.cancel(tabId)

    return new Promise((resolve) => {
      let settled = false
      const session: Session = {
        tabId,
        wc,
        identity,
        colorScheme,
        state: "arming",
        settled: false,
        onPicked: (_event, raw) => {
          void this.handlePicked(tabId, session, raw)
        },
        onDestroyed: () => this.cancel(tabId),
        onNavigate: (_event, _url, _isInPlace, isMainFrame) => {
          // Only a main-frame navigation abandons the pick; subframe SPA pushes
          // must not cancel an in-flight annotation.
          if (isMainFrame) this.cancel(tabId)
        },
        settle: (result) => {
          if (settled) return
          settled = true
          session.settled = true
          this.clearTimeout(session)
          session.state = result === null ? "cancelled" : "settled"
          this.teardown(tabId)
          resolve(result)
        },
        timeout: null,
        pendingBase: null,
      }

      this.sessions.set(tabId, session)

      wc.ipc.on(ANNOTATION_PICKED_CHANNEL, session.onPicked)
      wc.once("destroyed", session.onDestroyed)
      wc.on("did-start-navigation", session.onNavigate)

      wc.send(ANNOTATION_THEME_CHANNEL, colorScheme)
      wc.send(ANNOTATION_START_CHANNEL)
    })
  }

  /** Explicit cancel — toggling Annotate off again, tab close, etc. */
  cancel(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (!session) return
    session.settle(null)
  }

  private teardown(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.sessions.delete(tabId)
    this.clearTimeout(session)
    // The webContents may already be destroyed by the time we get here (that's
    // exactly what onDestroyed reports) — listener removal on a destroyed
    // EventEmitter is safe and a no-op, so no try/catch needed.
    session.wc.ipc.removeListener(ANNOTATION_PICKED_CHANNEL, session.onPicked)
    session.wc.removeListener("destroyed", session.onDestroyed)
    session.wc.removeListener("did-start-navigation", session.onNavigate)
  }

  private clearTimeout(session: Session): void {
    if (session.timeout !== null) {
      clearTimeout(session.timeout)
      session.timeout = null
    }
  }

  /** True only if this is still the live, un-settled session that may be acted
   * upon. Checks: (a) the session has not already settled/cancelled, (b) the
   * guest webContents is still around, and (c) the registry still reports the
   * same generation the session claimed. Generation does NOT change on plain
   * navigation, so (a) is what actually catches a navigation that fired
   * cancel() — without it, a late capture could wrongly ack the new guest. */
  private isActionable(session: Session): boolean {
    if (session.settled) return false
    if (session.wc.isDestroyed()) return false
    return session.identity.getCurrentGeneration(session.tabId) === session.identity.generation
  }

  private async handlePicked(tabId: string, session: Session, raw: unknown): Promise<void> {
    // Re-entrancy guard: a session only ever consumes one pick.
    if (session.state !== "arming") return

    if (!isBrowserAnnotationPayload(raw)) {
      // Malformed/spoofed payload — do not ack, do not resolve a partial
      // result; treat as a cancelled session so no stale styles are left
      // uncertain about their restore state.
      this.sendCancel(session.wc)
      session.settle(null)
      return
    }
    const payload = raw as BrowserAnnotationPayload

    session.state = "active"

    const base: AnnotationBase = {
      id: payload.id,
      pageUrl: payload.pageUrl,
      pageTitle: payload.pageTitle,
      comment: payload.comment,
      elements: payload.elements,
      regions: payload.regions,
      strokes: payload.strokes,
      styleChanges: payload.styleChanges,
      submission: payload.submission,
      createdAt: payload.createdAt,
    }

    // active -> submitting: we now own the structured payload and are about to
    // capture. Begin the composite-phase timeout so a guest that never reaches
    // capture-complete cannot hang the Annotate button.
    session.state = "submitting"
    session.pendingBase = base
    this.armTimeout(session)

    // Capture-ordering contract (guest preload <-> main). The host MUST follow
    // this exact sequence; do not let a refactor reorder it:
    //   1. guest hides EDITOR CHROME ONLY (toolbar, comment box, hover outline)
    //      while LEAVING selection outlines, region boxes, ink VISIBLE and
    //      LEAVING temporary CSS APPLIED;
    //   2. guest sends payload + crop (ANNOTATION_PICKED_CHANNEL);
    //   3. host validates and independently re-clamps the crop against the
    //      guest's ACTUAL current viewport;
    //   4. host captures (capturePage);
    //   5. host sends capture-complete (ANNOTATION_CAPTURED_CHANNEL) — the ONLY
    //      signal that lets the guest restore baselines / tear down;
    //   6. guest restores baselines and tears down.
    // Restoring CSS or removing marks BEFORE step 5 produces a screenshot that
    // does not show what the user asked for.

    // GENERATION GUARD: re-assert the tab's current generation before we
    // photograph. A mismatch means the guest was replaced/navigated and this
    // stale completion must NOT capture a stranger's page. We also must not ack
    // the new guest, so no capture-complete is sent here.
    if (!this.isActionable(session)) {
      session.settle(null)
      return
    }

    // No crop requested -> nothing to photograph; ack immediately so the guest
    // can tear down, and settle the structured annotation (screenshot: null).
    if (!payload.cropRect) {
      this.ackCapture(session)
      session.settle({ ...base, screenshot: null })
      return
    }

    session.state = "capturing"

    // Host-side independent re-clamp against the guest's ACTUAL current
    // viewport (the guest's own clamp is not trusted as the sole authority).
    // Skip the clamp when no viewport is known yet rather than trusting a
    // fabricated size.
    const requestedRect: Rect = {
      x: Math.max(0, Math.round(payload.cropRect.x)),
      y: Math.max(0, Math.round(payload.cropRect.y)),
      width: Math.max(1, Math.round(payload.cropRect.width)),
      height: Math.max(1, Math.round(payload.cropRect.height)),
    }
    const viewport = session.identity.getCurrentViewport(session.tabId)
    const rect = viewport ? clampCropToViewport(requestedRect, viewport) : requestedRect

    const image = await this.captureCrop(session.wc, rect)

    // Re-check liveness/generation AFTER the async capture: if the guest was
    // replaced mid-capture we must not ack the NEW guest (that would wrongly
    // tear it down) nor present a stale page as a result.
    if (!this.isActionable(session)) {
      session.settle(null)
      return
    }

    if (!image) {
      // Capture failed (e.g. UnknownVizError) — the structured annotation is the
      // most valuable part and must survive independently of pixels. Ack the
      // (still-live, same) guest so its temporary CSS is restored, then settle
      // without a screenshot.
      this.ackCapture(session)
      session.settle({ ...base, screenshot: null })
      return
    }

    this.ackCapture(session)
    session.settle({ ...base, screenshot: this.encodeScreenshot(image) })
  }

  private armTimeout(session: Session): void {
    session.timeout = setTimeout(() => {
      if (session.state === "settled" || session.state === "cancelled") return
      // Hard cap reached: settle the structured annotation WITHOUT a screenshot
      // rather than hanging. Only act on the same live guest — a replaced guest
      // must not be acked (its temporary CSS is moot after navigation).
      if (this.isActionable(session) && session.pendingBase) {
        this.ackCapture(session)
        session.settle({ ...session.pendingBase, screenshot: null })
      } else {
        session.settle(null)
      }
    }, ANNOTATION_SUBMIT_TIMEOUT_MS)
    session.timeout.unref?.()
  }

  /** Electron capturePage can throw UnknownVizError when a guest is hidden or
   * not yet composited. Retry once after a frame before degrading to null. */
  private async captureCrop(wc: WebContents, rect: Rect): Promise<NativeImage | null> {
    try {
      return await wc.capturePage(rect)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
      try {
        return await wc.capturePage(rect)
      } catch {
        return null
      }
    }
  }

  /** Resize the captured PNG so its long edge stays <= the cap, then encode.
   * Records the final (possibly downscaled) width/height on the screenshot. */
  private encodeScreenshot(image: NativeImage): BrowserAnnotationResult["screenshot"] {
    let img = image
    const size = img.getSize()
    const longEdge = Math.max(size.width, size.height)
    if (longEdge > ANNOTATION_MAX_SCREENSHOT_LONG_EDGE) {
      const scale = ANNOTATION_MAX_SCREENSHOT_LONG_EDGE / longEdge
      img = img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
    }
    const final = img.getSize()
    return { mime: "image/png", dataUrl: img.toDataURL(), width: final.width, height: final.height }
  }

  /** Ack unconditionally once capture has settled (success or failure), but
   * ONLY for the same live guest — a replaced/destroyed guest must not receive
   * capture-complete (that would wrongly tear down a stranger's page). The
   * guest sits in `capturing` with the user's page still wearing temporary CSS
   * until it gets this signal, so the liveness guard is the safety, not a
   * reason to skip the ack. */
  private ackCapture(session: Session): void {
    if (!this.isActionable(session)) return
    session.wc.send(ANNOTATION_CAPTURED_CHANNEL)
  }

  private sendCancel(wc: WebContents): void {
    if (wc.isDestroyed()) return
    wc.send(ANNOTATION_CANCEL_CHANNEL)
  }
}

/** Independent host-side clamp of a crop rect into the guest's actual viewport.
 * Pure: no Electron dependency, safe to unit-test. Keeps x/y in-bounds and
 * width/height >= 1 and within the remaining viewport. */
export function clampCropToViewport(rect: Rect, viewport: Size): Rect {
  const vw = Math.max(0, viewport.width)
  const vh = Math.max(0, viewport.height)
  const x = Math.min(Math.max(0, rect.x), Math.max(0, vw - 1))
  const y = Math.min(Math.max(0, rect.y), Math.max(0, vh - 1))
  const width = Math.min(Math.max(1, rect.width), Math.max(1, vw - x))
  const height = Math.min(Math.max(1, rect.height), Math.max(1, vh - y))
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}
