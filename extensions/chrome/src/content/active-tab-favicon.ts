export const ACTIVE_TAB_ICON_ATTRIBUTE = "data-opencode-active-tab-icon"

/**
 * Apply/remove opencode's active-tab favicon without mutating the site's own
 * favicon declarations. Appending the marker last lets normal favicon
 * selection prefer it; removal naturally restores the page icon.
 */
export function setActiveTabFavicon(document: Document, active: boolean, iconUrl?: string): void {
  const selector = `link[${ACTIVE_TAB_ICON_ATTRIBUTE}]`
  const existing = document.querySelector<HTMLLinkElement>(selector)
  if (!active) {
    existing?.remove()
    return
  }
  if (existing) {
    // An activation can arrive at document_start before <head> exists. Once
    // navigation completes, move the existing marker into <head> so it is a
    // standards-valid favicon declaration rather than creating a duplicate.
    if (document.head && existing.parentElement !== document.head) document.head.appendChild(existing)
    return
  }
  if (!iconUrl) return

  const icon = document.createElement("link")
  icon.rel = "icon"
  icon.type = "image/png"
  icon.href = iconUrl
  icon.setAttribute(ACTIVE_TAB_ICON_ATTRIBUTE, "")
  ;(document.head ?? document.documentElement).appendChild(icon)
}
