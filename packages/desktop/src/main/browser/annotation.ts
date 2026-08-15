// Human-in-the-loop annotation session controller. Owns the main-process half
// of the guest-preload annotation protocol (annotation-overlay.ts): starts a
// pick session, validates the returned payload (trust boundary — the guest
// never supplies its own screenshot), captures the requested crop, and
// resolves with a structured result the renderer can turn into composer
// context. One active session per tab; a new pick cancels a stale one.

import type { WebContents } from "electron"
import {
  ANNOTATION_CANCEL_CHANNEL,
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_PICKED_CHANNEL,
  ANNOTATION_START_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  isBrowserAnnotationPayload,
  type BrowserAnnotationPayload,
  type BrowserAnnotationResult,
} from "./contracts"

interface Session {
  wc: WebContents
  onPicked: (event: unknown, raw: unknown) => void
  onDestroyed: () => void
  onNavigate: () => void
  settle: (result: BrowserAnnotationResult | null) => void
}

export class AnnotationController {
  private readonly sessions = new Map<string, Session>()

  /** Begin a pick session on `tabId`'s webContents; resolves with the
   * structured result on submit, or `null` on cancel/navigation/destruction.
   * Never rejects — cancellation is a normal outcome, not an error. */
  start(tabId: string, wc: WebContents, colorScheme: "light" | "dark"): Promise<BrowserAnnotationResult | null> {
    this.cancel(tabId)

    return new Promise((resolve) => {
      let settled = false
      const settle = (result: BrowserAnnotationResult | null) => {
        if (settled) return
        settled = true
        this.teardown(tabId)
        resolve(result)
      }

      const onPicked = (_event: unknown, raw: unknown) => {
        void this.handlePicked(tabId, wc, raw, settle)
      }
      const onDestroyed = () => settle(null)
      const onNavigate = () => settle(null)

      wc.ipc.on(ANNOTATION_PICKED_CHANNEL, onPicked)
      wc.once("destroyed", onDestroyed)
      wc.on("did-start-navigation", onNavigate)

      this.sessions.set(tabId, { wc, onPicked, onDestroyed, onNavigate, settle })

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
    // The webContents may already be destroyed by the time we get here
    // (that's exactly what onDestroyed reports) — listener removal on a
    // destroyed EventEmitter is safe and a no-op, so no try/catch needed.
    session.wc.ipc.removeListener(ANNOTATION_PICKED_CHANNEL, session.onPicked)
    session.wc.removeListener("destroyed", session.onDestroyed)
    session.wc.removeListener("did-start-navigation", session.onNavigate)
  }

  private async handlePicked(
    tabId: string,
    wc: WebContents,
    raw: unknown,
    settle: (result: BrowserAnnotationResult | null) => void,
  ): Promise<void> {
    if (!isBrowserAnnotationPayload(raw)) {
      // Malformed/spoofed payload — do not ack, do not resolve a partial
      // result; treat as a cancelled session so no stale styles are left
      // uncertain about their restore state.
      this.sendCancel(wc)
      settle(null)
      return
    }
    const payload: BrowserAnnotationPayload = raw

    const base = {
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

    if (!payload.cropRect) {
      this.ackCapture(wc)
      settle({ ...base, screenshot: null })
      return
    }

    try {
      const rect = {
        x: Math.max(0, Math.round(payload.cropRect.x)),
        y: Math.max(0, Math.round(payload.cropRect.y)),
        width: Math.max(1, Math.round(payload.cropRect.width)),
        height: Math.max(1, Math.round(payload.cropRect.height)),
      }
      const image = await wc.capturePage(rect)
      const size = image.getSize()
      this.ackCapture(wc)
      settle({
        ...base,
        screenshot: { mime: "image/png", dataUrl: image.toDataURL(), width: size.width, height: size.height },
      })
    } catch {
      // A failed screenshot must never discard useful structured annotation
      // data — resolve with screenshot: null instead of failing outright.
      this.ackCapture(wc)
      settle({ ...base, screenshot: null })
    }
  }

  /** Ack unconditionally once capture has settled (success or failure) so
   * the guest can safely restore its temporary styles and tear down. */
  private ackCapture(wc: WebContents): void {
    if (wc.isDestroyed()) return
    wc.send(ANNOTATION_CAPTURED_CHANNEL)
  }

  private sendCancel(wc: WebContents): void {
    if (wc.isDestroyed()) return
    wc.send(ANNOTATION_CANCEL_CHANNEL)
  }
}
