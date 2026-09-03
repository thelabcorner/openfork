import { createMemo, createSignal } from "solid-js"
import { useLayout } from "@/context/layout"
import { createResizableSize } from "@/utils/resizable-size"

export const LIMITS_PANEL_WIDTH_DEFAULT = 480
export const LIMITS_PANEL_WIDTH_MIN = 320
export const LIMITS_PANEL_WIDTH_MAX = 960

export function createLimitsPanelState() {
  const layout = useLayout()
  const width = createResizableSize("limits-panel", "sidebarWidth", {
    min: LIMITS_PANEL_WIDTH_MIN,
    max: LIMITS_PANEL_WIDTH_MAX,
    default: LIMITS_PANEL_WIDTH_DEFAULT,
  })
  const opened = layout.limits.opened
  const visible = createMemo(() => opened())
  return {
    opened,
    visible,
    sidebarWidth: width.size,
    sidebarTransition: width.ready,
    resizeSidebar: width.resize,
    open() {
      layout.limits.open()
    },
    close() {
      layout.limits.close()
    },
    toggle() {
      layout.limits.toggle()
    },
  }
}

export type LimitsPanelState = ReturnType<typeof createLimitsPanelState>

/**
 * Cross-surface "show me THIS provider" channel.
 *
 * The composer's limit arc opens the pane, but opening it at the top of a list
 * of eight providers is not an answer — the user clicked a specific ring. A
 * module-level signal (no owner needed; signals are ownerless) lets the arc
 * name a provider and the pane scroll to and flash that card, without either
 * side importing the other's component tree. `at` is part of the payload so
 * clicking the same provider twice re-triggers the effect.
 */
const [focusRequest, setFocusRequest] = createSignal<{ providerId: string; at: number } | undefined>()

export function focusLimitsProvider(providerId: string) {
  setFocusRequest({ providerId, at: Date.now() })
}

export function limitsFocusRequest() {
  return focusRequest()
}
