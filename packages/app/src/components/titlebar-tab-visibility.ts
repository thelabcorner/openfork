const SLOT_SELECTOR = "[data-titlebar-tab-slot]"
const OFFSCREEN_ATTRIBUTE = "data-tab-offscreen"

/**
 * One intersection observer for the entire horizontally scrolling tab strip.
 * Pauses only offscreen tab animations; no per-tab observers, timers or Solid
 * signals. Initial discovery is O(tab count), but subsequent DOM mutation
 * batches reconcile only touched direct children. Reordering an existing node
 * keeps its observer registration and state until the next intersection.
 */
export function trackTabStripVisibility(
  scroll: HTMLElement,
  list: HTMLElement,
  Intersection: typeof IntersectionObserver | undefined = globalThis.IntersectionObserver,
  Mutation: typeof MutationObserver | undefined = globalThis.MutationObserver,
) {
  if (!Intersection || !Mutation) return () => {}

  const tracked = new Set<HTMLElement>()
  let disposed = false
  const intersections = new Intersection((entries) => {
    for (const entry of entries) {
      const element = entry.target
      if (!(element instanceof HTMLElement) || !tracked.has(element)) continue
      if (entry.isIntersecting) element.removeAttribute(OFFSCREEN_ATTRIBUTE)
      else element.setAttribute(OFFSCREEN_ATTRIBUTE, "")
    }
  }, { root: scroll, threshold: 0 })

  const track = (element: HTMLElement) => {
    if (tracked.has(element)) return
    tracked.add(element)
    intersections.observe(element)
  }
  const untrack = (element: HTMLElement) => {
    if (!tracked.delete(element)) return
    intersections.unobserve(element)
    element.removeAttribute(OFFSCREEN_ATTRIBUTE)
  }
  const reconcile = (node: Node) => {
    if (!(node instanceof HTMLElement)) return
    if (node.parentElement === list && node.matches(SLOT_SELECTOR)) track(node)
    else untrack(node)
  }
  const synchronize = () => {
    if (disposed) return
    const present = new Set<HTMLElement>()
    for (const child of list.children) {
      if (!(child instanceof HTMLElement) || !child.matches(SLOT_SELECTOR)) continue
      present.add(child)
      track(child)
    }
    for (const element of tracked) {
      if (present.has(element)) continue
      untrack(element)
    }
  }

  const mutations = new Mutation((records) => {
    if (disposed) return
    // Empty records are possible in test adapters; a full reconciliation is
    // the safe fallback rather than leaving a stale observer registration.
    if (records.length === 0) {
      synchronize()
      return
    }
    // The overwhelmingly common delivery changes one direct child. Avoid
    // allocating a Set for it, including the same-node remove+add generated
    // by tab reordering. Reconcile against final DOM parentage, not record
    // order, so a moved element never loses its observer.
    if (records.length === 1) {
      const record = records[0]!
      if (record.target !== list) return
      if (record.addedNodes.length <= 1 && record.removedNodes.length <= 1) {
        const added = record.addedNodes[0]
        const removed = record.removedNodes[0]
        if (added) reconcile(added)
        if (removed && removed !== added) reconcile(removed)
        return
      }
    }
    const changed = new Set<HTMLElement>()
    for (const record of records) {
      if (record.target !== list) continue
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) changed.add(node)
      }
      for (const node of record.removedNodes) {
        if (node instanceof HTMLElement) changed.add(node)
      }
    }
    for (const element of changed) {
      reconcile(element)
    }
  })
  mutations.observe(list, { childList: true })
  synchronize()

  return () => {
    disposed = true
    mutations.disconnect()
    intersections.disconnect()
    for (const element of tracked) element.removeAttribute(OFFSCREEN_ATTRIBUTE)
    tracked.clear()
  }
}