import { createSignal, onCleanup } from "solid-js"
import type { ServerCtx } from "@/context/global"
import type { GroupTab, SessionTab } from "@/context/tabs"
import { markTabPreviewClosed, tabPreviewOpenDelay } from "./titlebar-tab-preview-timing"

/** One inspector per tab strip. Tabs do not own hover-card instances, timers or portals. */
export type TabPreviewIntent = {
  anchor: HTMLElement
  tab: SessionTab | GroupTab
  serverCtx: () => ServerCtx | undefined
  serverLabel: () => string | undefined
}

/**
 * Shared pointer intent state machine. Only the hovered tab's lightweight
 * identity is retained; the expensive session/group projection belongs to one
 * downstream preview owner. Crossing adjacent tabs repopulates that owner
 * synchronously, never leaving a second portal behind.
 */
export function createTabPreviewController(options: {
  delay?: () => number
  closeDelay?: number
} = {}) {
  const [current, setCurrent] = createSignal<TabPreviewIntent>()
  let pending: TabPreviewIntent | undefined
  let dwell: ReturnType<typeof setTimeout> | undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  let menuOpen = false
  let cardHovered = false
  let disposed = false
  let closeFrame = 0

  const clearDwell = () => {
    pending = undefined
    if (dwell !== undefined) clearTimeout(dwell)
    dwell = undefined
  }
  const clearGrace = () => {
    if (grace !== undefined) clearTimeout(grace)
    grace = undefined
  }
  const close = (force = false) => {
    clearDwell()
    clearGrace()
    if (!force && (menuOpen || cardHovered)) return
    // A forced dismissal disposes the portalled card before its pointer-leave
    // or context-menu-close callbacks can run. Do not carry those locks over to
    // the next tab hover; that would make the new preview impossible to open
    // (or impossible to dismiss).
    if (force) {
      menuOpen = false
      cardHovered = false
      if (closeFrame) cancelAnimationFrame(closeFrame)
      closeFrame = 0
    }
    if (!current()) return
    setCurrent(undefined)
    markTabPreviewClosed()
  }
  const hover = (intent: TabPreviewIntent) => {
    if (disposed || menuOpen || !intent.anchor.isConnected) return
    clearGrace()
    if (current()?.anchor === intent.anchor) return
    if (pending?.anchor === intent.anchor) return
    clearDwell()
    // Reuse the same mounted card without a second dwell when crossing tabs.
    if (current()) {
      setCurrent(intent)
      return
    }
    pending = intent
    dwell = setTimeout(() => {
      dwell = undefined
      if (disposed || menuOpen || pending !== intent) return
      pending = undefined
      if (!intent.anchor.isConnected || !intent.anchor.matches(":hover")) return
      setCurrent(intent)
    }, (options.delay ?? tabPreviewOpenDelay)())
  }
  const leave = (anchor: HTMLElement) => {
    if (pending?.anchor === anchor) clearDwell()
    if (current()?.anchor !== anchor || menuOpen || cardHovered) return
    clearGrace()
    grace = setTimeout(() => {
      grace = undefined
      if (current()?.anchor !== anchor || anchor.matches(":hover")) return
      close()
    }, options.closeDelay ?? 140)
  }
  const contentEnter = () => {
    cardHovered = true
    clearGrace()
  }
  const contentLeave = () => {
    cardHovered = false
    if (menuOpen || current()?.anchor.matches(":hover")) return
    const anchor = current()?.anchor
    if (anchor) leave(anchor)
  }
  const contextMenuOpenChange = (open: boolean) => {
    menuOpen = open
    if (open) {
      clearGrace()
      return
    }
    if (closeFrame) cancelAnimationFrame(closeFrame)
    closeFrame = requestAnimationFrame(() => {
      closeFrame = 0
      if (disposed || menuOpen || cardHovered || current()?.anchor.matches(":hover")) return
      close()
    })
  }
  onCleanup(() => {
    disposed = true
    clearDwell()
    clearGrace()
    if (closeFrame) cancelAnimationFrame(closeFrame)
    setCurrent(undefined)
  })
  return { current, hover, leave, close, contentEnter, contentLeave, contextMenuOpenChange }
}
