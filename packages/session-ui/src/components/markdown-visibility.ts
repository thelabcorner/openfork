type Subscriber = { onChange: (visible: boolean) => void; intersects: boolean }
const subscribers = new Map<Element, Subscriber>()
let observer: IntersectionObserver | undefined
let mutations: MutationObserver | undefined
const observedAncestors = new Map<Element, Set<Element>>()
let mutationGeneration = 0
let mutationRebuildToken = 0
let mutationRebuildScheduled = false

function painted(element: Element, cache = new Map<Element, boolean>()) {
  if (typeof document === "undefined" || document.hidden || !element.isConnected) return false
  for (let node: Element | null = element; node; node = node.parentElement) {
    let visible = cache.get(node)
    if (visible === undefined) {
      const style = getComputedStyle(node)
      visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.contentVisibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        node.getAttribute("aria-hidden") !== "true"
      cache.set(node, visible)
    }
    if (!visible) return false
    if (node === document.documentElement) break
  }
  return true
}

function publish(element: Element, styleCache?: Map<Element, boolean>) {
  const subscriber = subscribers.get(element)
  if (!subscriber) return
  subscriber.onChange(subscriber.intersects && painted(element, styleCache))
}

function onDocumentVisibility() {
  const styleCache = new Map<Element, boolean>()
  for (const element of subscribers.keys()) publish(element, styleCache)
}

function onAncestorMutation(records: MutationRecord[]) {
  const affected = new Set<Element>()
  const styleCache = new Map<Element, boolean>()
  for (const record of records) {
    for (const element of observedAncestors.get(record.target as Element) ?? []) affected.add(element)
  }
  for (const element of affected) publish(element, styleCache)
}

function makeMutationObserver() {
  const generation = ++mutationGeneration
  let current: MutationObserver
  current = new MutationObserver((records) => {
    // A callback already queued by a disconnected observer must not publish
    // stale records into a later subscriber generation.
    if (generation !== mutationGeneration || current !== mutations) return
    onAncestorMutation(records)
  })
  return current
}

function scheduleMutationObserverRebuild() {
  if (mutationRebuildScheduled || !mutations) return
  mutationRebuildScheduled = true
  const current = mutations
  const generation = mutationGeneration
  const token = ++mutationRebuildToken
  queueMicrotask(() => {
    if (token !== mutationRebuildToken) return
    if (generation !== mutationGeneration || current !== mutations || subscribers.size === 0) {
      mutationRebuildScheduled = false
      return
    }
    rebuildMutationObserver()
    if (token === mutationRebuildToken) mutationRebuildScheduled = false
  })
}

/** One observer owns viewport visibility for every Markdown instance. */
export function observeMarkdownVisibility(element: Element, onChange: (visible: boolean) => void) {
  if (typeof IntersectionObserver !== "undefined") {
    observer ??= new IntersectionObserver((entries) => {
      const styleCache = new Map<Element, boolean>()
      for (const entry of entries) {
        const subscriber = subscribers.get(entry.target)
        if (!subscriber) continue
        subscriber.intersects = entry.isIntersecting
        publish(entry.target, styleCache)
      }
    })
  }
  subscribers.set(element, { onChange, intersects: !observer })
  observer?.observe(element)
  if (subscribers.size === 1) {
    mutations = makeMutationObserver()
    document.addEventListener("visibilitychange", onDocumentVisibility)
  }
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    let targets = observedAncestors.get(ancestor)
    if (!targets) {
      targets = new Set()
      observedAncestors.set(ancestor, targets)
      mutations?.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] })
    }
    targets.add(element)
    if (ancestor === document.documentElement) break
  }
  return () => {
    subscribers.delete(element)
    observer?.unobserve(element)
    let rebuild = false
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const targets = observedAncestors.get(ancestor)
      targets?.delete(element)
      if (targets?.size === 0) {
        observedAncestors.delete(ancestor)
        rebuild = true
      }
      if (ancestor === document.documentElement) break
    }
    // MutationObserver has no per-target unobserve. Rebuild only when an
    // observed ancestor loses its final subscriber.
    if (rebuild) scheduleMutationObserverRebuild()
    if (subscribers.size !== 0) return
    observer?.disconnect()
    observer = undefined
    mutationGeneration++
    mutationRebuildToken++
    mutationRebuildScheduled = false
    mutations?.disconnect()
    mutations = undefined
    observedAncestors.clear()
    document.removeEventListener("visibilitychange", onDocumentVisibility)
  }
}

function rebuildMutationObserver() {
  const current = mutations
  const generation = mutationGeneration
  if (!current) return
  const records = current.takeRecords()
  // A style mutation can land after a subscriber cleanup queues this rebuild.
  // Apply those records against the current subscriber map before disconnecting
  // the observer, or a remaining hidden consumer may never be updated.
  if (records.length > 0 && current === mutations && generation === mutationGeneration) onAncestorMutation(records)
  if (current !== mutations || generation !== mutationGeneration || subscribers.size === 0) return
  current.disconnect()
  for (const ancestor of observedAncestors.keys())
    current.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] })
}
