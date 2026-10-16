/**
 * A pointer context-menu event carries viewport coordinates. Keyboard-originated
 * contextmenu events (Menu key / Shift+F10) may instead report (0, 0).
 * Anchor those to the invoking row, not the top-left corner of the desktop.
 *
 * The host's floating-positioning layer remains responsible for viewport
 * collision/flip handling. Layout is read only on an actual context-menu event.
 */
export function contextMenuPosition(
  event: Pick<MouseEvent, "button" | "clientX" | "clientY">,
  anchor: { getBoundingClientRect: () => Pick<DOMRect, "left" | "top" | "width" | "height"> },
): { x: number; y: number } {
  if (event.button === 2 || event.clientX !== 0 || event.clientY !== 0) {
    return { x: event.clientX, y: event.clientY }
  }
  const rect = anchor.getBoundingClientRect()
  return {
    x: rect.left + Math.min(24, Math.max(0, rect.width / 2)),
    y: rect.top + Math.min(24, Math.max(0, rect.height / 2)),
  }
}
