// Keep hover streak timing in the lightweight tab graph. The preview component
// is lazy-loaded, so its module cannot be responsible for deciding whether a
// neighbouring tab should open immediately.
export const TAB_PREVIEW_OPEN_DELAY = 450
export const TAB_PREVIEW_SKIP_WINDOW = 500

let lastClosedAt: number | undefined

export function tabPreviewIsWarm(now = Date.now()) {
  return lastClosedAt !== undefined && now >= lastClosedAt && now - lastClosedAt < TAB_PREVIEW_SKIP_WINDOW
}

export function tabPreviewOpenDelay(now = Date.now()) {
  return tabPreviewIsWarm(now) ? 0 : TAB_PREVIEW_OPEN_DELAY
}

export function markTabPreviewClosed(now = Date.now()) {
  lastClosedAt = now
}