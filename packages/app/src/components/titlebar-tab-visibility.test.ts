import { expect, test } from "bun:test"
import { trackTabStripVisibility } from "./titlebar-tab-visibility"

test("one observer pauses offscreen slots, tracks replacements and restores on teardown", () => {
  const scroll = document.createElement("div")
  const list = document.createElement("div")
  scroll.append(list)
  document.body.append(scroll)
  const slot = document.createElement("div")
  slot.setAttribute("data-titlebar-tab-slot", "")
  list.append(slot)

  let onIntersection!: IntersectionObserverCallback
  let onMutation!: MutationCallback
  let disconnected = 0
  const observed = new Set<Element>()
  const Intersection = class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      onIntersection = callback
      expect(options?.root).toBe(scroll)
    }
    observe(element: Element) { observed.add(element) }
    unobserve(element: Element) { observed.delete(element) }
    disconnect() { disconnected++; observed.clear() }
  } as unknown as typeof IntersectionObserver
  const Mutation = class {
    constructor(callback: MutationCallback) { onMutation = callback }
    observe(target: Node, options?: MutationObserverInit) {
      expect(target).toBe(list)
      expect(options).toEqual({ childList: true })
    }
    disconnect() { disconnected++ }
  } as unknown as typeof MutationObserver

  const stop = trackTabStripVisibility(scroll, list, Intersection, Mutation)
  const emit = (target: Element, isIntersecting: boolean) =>
    onIntersection([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)
  try {
    expect(observed.has(slot)).toBe(true)
    emit(slot, false)
    expect(slot.hasAttribute("data-tab-offscreen")).toBe(true)
    emit(slot, true)
    expect(slot.hasAttribute("data-tab-offscreen")).toBe(false)
    emit(slot, false)
    const replacement = document.createElement("div")
    replacement.setAttribute("data-titlebar-tab-slot", "")
    slot.remove()
    list.append(replacement)
    onMutation([], {} as MutationObserver)
    expect(observed.has(slot)).toBe(false)
    expect(slot.hasAttribute("data-tab-offscreen")).toBe(false)
    expect(observed.has(replacement)).toBe(true)
    emit(replacement, false)
    expect(replacement.hasAttribute("data-tab-offscreen")).toBe(true)
    stop()
    expect(replacement.hasAttribute("data-tab-offscreen")).toBe(false)
    expect(disconnected).toBe(2)
  } finally {
    scroll.remove()
  }
})

test("mutation reconciliation is proportional to changed children and preserves moved nodes", () => {
  const scroll = document.createElement("div")
  const list = document.createElement("div")
  scroll.append(list)
  document.body.append(scroll)
  const slots = Array.from({ length: 256 }, () => {
    const slot = document.createElement("div")
    slot.setAttribute("data-titlebar-tab-slot", "")
    list.append(slot)
    return slot
  })

  let onIntersection!: IntersectionObserverCallback
  let onMutation!: MutationCallback
  let observedCount = 0
  let unobservedCount = 0
  const observed = new Set<Element>()
  const Intersection = class {
    constructor(callback: IntersectionObserverCallback) { onIntersection = callback }
    observe(element: Element) { observedCount++; observed.add(element) }
    unobserve(element: Element) { unobservedCount++; observed.delete(element) }
    disconnect() { observed.clear() }
  } as unknown as typeof IntersectionObserver
  const Mutation = class {
    constructor(callback: MutationCallback) { onMutation = callback }
    observe() {}
    disconnect() {}
  } as unknown as typeof MutationObserver
  const record = (added: Node[], removed: Node[]): MutationRecord => ({
    target: list,
    addedNodes: added,
    removedNodes: removed,
  }) as unknown as MutationRecord

  const stop = trackTabStripVisibility(scroll, list, Intersection, Mutation)
  const originalMatches = Element.prototype.matches
  let matches = 0
  try {
    expect(observedCount).toBe(256)
    const moved = slots[7]!
    onIntersection([{ target: moved, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(moved.hasAttribute("data-tab-offscreen")).toBe(true)

    list.append(moved)
    const added = document.createElement("div")
    added.setAttribute("data-titlebar-tab-slot", "")
    list.append(added)
    const removed = slots[19]!
    removed.remove()
    const irrelevant = document.createElement("span")
    list.append(irrelevant)

    Element.prototype.matches = function (selector: string) {
      matches++
      return originalMatches.call(this, selector)
    }
    onMutation([
      record([moved], [moved]),
      record([added, irrelevant], []),
      record([], [removed]),
    ], {} as MutationObserver)
    expect(matches).toBeLessThanOrEqual(3)
    expect(observedCount).toBe(257)
    expect(unobservedCount).toBe(1)
    expect(observed.has(moved)).toBe(true)
    expect(moved.hasAttribute("data-tab-offscreen")).toBe(true)
    expect(observed.has(added)).toBe(true)
    expect(observed.has(removed)).toBe(false)
    expect(observed.has(irrelevant)).toBe(false)

    // One-record deliveries take the allocation-free fast path.
    const extra = document.createElement("div")
    extra.setAttribute("data-titlebar-tab-slot", "")
    list.append(extra)
    onMutation([record([extra], [])], {} as MutationObserver)
    expect(observed.has(extra)).toBe(true)
    expect(observedCount).toBe(258)
    onIntersection([{ target: extra, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    extra.remove()
    onMutation([record([], [extra])], {} as MutationObserver)
    expect(observed.has(extra)).toBe(false)
    expect(extra.hasAttribute("data-tab-offscreen")).toBe(false)
    expect(unobservedCount).toBe(2)
    list.prepend(moved)
    onMutation([record([moved], [moved])], {} as MutationObserver)
    expect(observed.has(moved)).toBe(true)
    expect(moved.hasAttribute("data-tab-offscreen")).toBe(true)

    stop()
    onMutation([record([added], [])], {} as MutationObserver)
    expect(observedCount).toBe(258)
    expect(moved.hasAttribute("data-tab-offscreen")).toBe(false)
  } finally {
    Element.prototype.matches = originalMatches
    stop()
    scroll.remove()
  }
})