import type { Ref } from "solid-js"

const TAB_ACTION_SLOTS = ['[data-slot="tab-close"]', '[data-slot="tab-state"]'] as const

// Any control in the tab's action group (close / stop / resume) is excluded from
// drag-start, rename, and middle-click-navigate gestures.
export function isTabActionTarget(target: EventTarget | null) {
  return target instanceof Element && TAB_ACTION_SLOTS.some((slot) => !!target.closest(slot))
}

export function canStartTabDrag(pointerType: string) {
  return pointerType !== "touch"
}

export function forwardTabRef(ref: Ref<HTMLDivElement> | undefined, element: HTMLDivElement) {
  if (typeof ref === "function") ref(element)
}

export function canOpenTabRename(dragging: boolean | undefined, editing: boolean, pending: boolean) {
  return !dragging && !editing && !pending
}
