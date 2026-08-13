// Pure cursor math — the T3 coordinate formula and the opacity/linger state
// machine, extracted so they can be unit-tested without a DOM.

import type { BrowserController, BrowserPointerEvent, PresentedContent } from "./types"

/** Active linger window: each pointer event keeps the cursor at full opacity. */
export const CURSOR_ACTIVE_MS = 700

/**
 * Map a guest CSS-viewport pointer coordinate to the panel DOM space.
 *
 * EXACT T3 formula (AgentBrowserCursor.tsx):
 *   translate3d(event.x * zoomFactor * content.scale + content.x - content.scrollLeft px,
 *               event.y * zoomFactor * content.scale + content.y - content.scrollTop px)
 *
 * `event.x/y` are guest CSS pixels; `zoomFactor` is the guest webContents zoom;
 * `content` is the webview's presentation rect (browserSurfaceStore). Host app
 * zoom is intentionally absent — the webview is a DOM element, so app zoom
 * scales webview and cursor together and the terms cancel.
 */
export function cursorPosition(
  event: Pick<BrowserPointerEvent, "x" | "y">,
  zoomFactor: number,
  content: PresentedContent | null,
): { x: number; y: number } {
  const scale = content?.scale ?? 1
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return {
    x: event.x * zoom * scale + (content?.x ?? 0) - (content?.scrollLeft ?? 0),
    y: event.y * zoom * scale + (content?.y ?? 0) - (content?.scrollTop ?? 0),
  }
}

export function cursorTranslate3d(
  event: Pick<BrowserPointerEvent, "x" | "y">,
  zoomFactor: number,
  content: PresentedContent | null,
): string {
  const { x, y } = cursorPosition(event, zoomFactor, content)
  return `translate3d(${x}px, ${y}px, 0)`
}

/**
 * Cursor opacity: full while active; when idle, dim the human cursor more than
 * the agent cursor so the human eye tracks the agent's intent.
 */
export function agentBrowserCursorOpacity(active: boolean, controller: BrowserController): number {
  if (active) return 1
  return controller === "human" ? 0.18 : 0.35
}

/** Map an element rect (guest CSS viewport coords) into panel DOM space. */
export function elementRectInPanel(
  rect: { x: number; y: number; width: number; height: number },
  zoomFactor: number,
  content: PresentedContent | null,
): { x: number; y: number; width: number; height: number } {
  const { x, y } = cursorPosition({ x: rect.x, y: rect.y }, zoomFactor, content)
  const scale = content?.scale ?? 1
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return { x, y, width: rect.width * zoom * scale, height: rect.height * zoom * scale }
}
