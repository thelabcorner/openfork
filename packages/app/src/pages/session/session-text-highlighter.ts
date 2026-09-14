let globalOverlayFrame: number | undefined
let globalOverlayContainer: HTMLDivElement | undefined

function clearHighlights() {
  const api = (globalThis as { CSS?: { highlights?: { delete: (name: string) => void } } }).CSS?.highlights
  if (!api) return
  api.delete("opencode-session-find")
  api.delete("opencode-session-find-current")
}

function clearOverlay() {
  if (globalOverlayFrame !== undefined) {
    cancelAnimationFrame(globalOverlayFrame)
    globalOverlayFrame = undefined
  }
  if (globalOverlayContainer) {
    globalOverlayContainer.innerHTML = ""
  }
}

/**
 * Walk ALL text nodes reachable from `root`, including inside shadow roots.
 * TreeWalker only traverses the light DOM — this function recurses into
 * shadow roots so highlights work inside Pierre diffs, web components, etc.
 */
function walkAllTextNodes(root: Node, cb: (node: Text) => void) {
  if (root instanceof Text) {
    cb(root)
    return
  }
  if (root instanceof Element) {
    if (root.shadowRoot) walkAllTextNodes(root.shadowRoot, cb)
    for (const child of root.childNodes) walkAllTextNodes(child, cb)
  }
}

function scanTurnNodes(container: HTMLElement, needle: string): Range[] {
  const ranges: Range[] = []

  const nodes: Text[] = []
  const ends: number[] = []
  let pos = 0
  walkAllTextNodes(container, (textNode) => {
    pos += textNode.data.length
    nodes.push(textNode)
    ends.push(pos)
  })
  if (nodes.length === 0) return ranges

  const fullText = nodes.map((n) => n.data).join("").toLowerCase()
  if (!fullText.includes(needle)) return ranges

  const locate = (offset: number) => {
    let lo = 0
    let hi = ends.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ends[mid] >= offset) hi = mid
      else lo = mid + 1
    }
    const prev = lo === 0 ? 0 : ends[lo - 1]
    return { node: nodes[lo], offset: offset - prev }
  }

  let at = fullText.indexOf(needle)
  while (at !== -1) {
    const start = locate(at)
    const end = locate(at + needle.length)
    try {
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      ranges.push(range)
    } catch {
      // Range creation can fail if nodes were removed between scan and create
    }
    at = fullText.indexOf(needle, at + needle.length)
  }

  return ranges
}

function applyHighlights(ranges: Range[], activeIndex: number) {
  const api = (globalThis as unknown as { CSS?: { highlights?: any }; Highlight?: any }).CSS?.highlights
  const Highlight = (globalThis as unknown as { Highlight?: any }).Highlight
  if (!api || typeof Highlight !== "function") return false

  api.delete("opencode-session-find")
  api.delete("opencode-session-find-current")

  const active = ranges[activeIndex]
  if (active) api.set("opencode-session-find-current", new Highlight(active))

  const rest = ranges.filter((_, i) => i !== activeIndex)
  if (rest.length > 0) api.set("opencode-session-find", new Highlight(...rest))
  return true
}

function renderOverlay(ranges: Range[], activeIndex: number, scrollRoot: HTMLElement) {
  clearOverlay()
  if (!globalOverlayContainer || ranges.length === 0) return

  const base = scrollRoot.getBoundingClientRect()
  const frag = document.createDocumentFragment()

  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]
    const active = i === activeIndex
    for (const rect of Array.from(range.getClientRects())) {
      if (!rect.width || !rect.height) continue

      const mark = document.createElement("div")
      mark.className = "session-find-overlay-mark"
      mark.style.position = "absolute"
      mark.style.left = `${Math.round(rect.left - base.left + scrollRoot.scrollLeft)}px`
      mark.style.top = `${Math.round(rect.top - base.top + scrollRoot.scrollTop)}px`
      mark.style.width = `${Math.round(rect.width)}px`
      mark.style.height = `${Math.round(rect.height)}px`
      mark.style.borderRadius = "2px"
      mark.style.pointerEvents = "none"
      if (active) {
        mark.style.backgroundColor = "var(--surface-warning-strong)"
        mark.style.opacity = "0.5"
      } else {
        mark.style.backgroundColor = "var(--surface-warning-base)"
        mark.style.opacity = "0.4"
      }
      frag.appendChild(mark)
    }
  }

  globalOverlayContainer.appendChild(frag)
}

export type SessionTextHighlighter = {
  scan: (scrollRoot: HTMLElement) => void
  /** Mark one mutated subtree dirty and schedule a bounded rescan. */
  invalidate: (node?: Node) => void
  /** Scrolling does not change DOM ranges; only the legacy overlay needs geometry work. */
  onScroll: () => void
  clear: () => void
  dispose: () => void
  setOverlayContainer: (el: HTMLDivElement | undefined) => void
  setQuery: (query: string) => void
  setActiveIndex: (index: number) => void
  getActiveMessageID: () => string | undefined
  /** Get the container element of the active match (for precise row scrolling) */
  getActiveContainer: () => HTMLElement | undefined
}

export function createSessionTextHighlighter(): SessionTextHighlighter {
  let query = ""
  let activeIndex = 0
  let scrollRoot: HTMLElement | undefined
  let useOverlay = false
  let activeMessageID: string | undefined
  let scanFrame: number | undefined
  let scanTimer: ReturnType<typeof setTimeout> | undefined
  let lastScanAt = 0
  const MUTATION_SCAN_INTERVAL_MS = 50

  // Per-container cache: text content + ranges. Avoids re-walking shadow
  // roots and text nodes for containers whose content hasn't changed.
  let containerCache = new Map<HTMLElement, { ranges: Range[] }>()

  // Cached container list — avoids querySelectorAll on every frame during
  // streaming. Invalidated when containers are added/removed (detected by
  // checking if cached elements are still connected).
  let cachedContainers: HTMLElement[] | null = null
  let containerGeneration = 0
  const CONTAINER_STALE_THRESHOLD = 30 // re-query after this many scans

  // Track last-applied state to skip redundant CSS.highlights updates.
  // During streaming the MutationObserver fires constantly but match positions
  // rarely change — this avoids the delete/set flicker.
  let lastAppliedFingerprint = ""
  let activeContainer: HTMLElement | undefined
  let rangeGeneration = 0
  let currentRanges: Range[] = []

  const getContainers = (root: HTMLElement): HTMLElement[] => {
    // Fast path: reuse cached list if all elements are still in the DOM
    if (cachedContainers && containerGeneration < CONTAINER_STALE_THRESHOLD) {
      const allConnected = cachedContainers.every((el) => el.isConnected)
      if (allConnected) {
        containerGeneration++
        return cachedContainers
      }
      // Some containers disconnected — invalidate and re-query
      cachedContainers = null
      containerGeneration = 0
    }
    cachedContainers = Array.from(root.querySelectorAll<HTMLElement>("[data-component='session-turn']"))
    containerGeneration = 0
    return cachedContainers
  }

  const doScan = () => {
    if (!scrollRoot || !query) {
      clearAll()
      return
    }

    const needle = query.toLowerCase()
    const turnContainers = getContainers(scrollRoot)

    // Drop cache entries for containers no longer in the list
    const currentSet = new Set(turnContainers)
    for (const cached of containerCache.keys()) {
      if (!currentSet.has(cached)) containerCache.delete(cached)
    }

    // Rebuild ranges from per-container caches
    const allRanges: Range[] = []
    const allContainers: HTMLElement[] = []

    let rebuiltRanges = false
    for (const container of turnContainers) {
      const cached = containerCache.get(container)

      if (cached) {
        // Mutation invalidation is authoritative. Do not read/lowercase the
        // entire subtree merely to prove an unchanged virtual row is unchanged.
        for (const range of cached.ranges) {
          allRanges.push(range)
          allContainers.push(container)
        }
        continue
      }

      // Container changed or new — walk its text nodes
      const found = scanTurnNodes(container, needle)
      containerCache.set(container, { ranges: found })
      rebuiltRanges = true
      for (const range of found) {
        allRanges.push(range)
        allContainers.push(container)
      }
    }
    if (rebuiltRanges) rangeGeneration++
    currentRanges = allRanges

    // Determine which turn contains the active match
    activeMessageID = undefined
    activeContainer = undefined
    if (allRanges.length > 0 && activeIndex < allRanges.length) {
      const container = allContainers[activeIndex]
      if (container) {
        activeContainer = container
        const ancestor = container.closest("[data-message-id]")
        if (ancestor instanceof HTMLElement) {
          activeMessageID = ancestor.getAttribute("data-message-id") ?? undefined
        }
      }
    }

    // Build a fingerprint of the current state. If it matches what's already
    // painted, skip the expensive CSS.highlights delete/set entirely.
    const fingerprint = `${rangeGeneration}:${allRanges.length}:${activeIndex}`
    if (fingerprint === lastAppliedFingerprint) return
    lastAppliedFingerprint = fingerprint

    if (useOverlay) {
      renderOverlay(allRanges, activeIndex, scrollRoot)
    } else {
      if (!applyHighlights(allRanges, activeIndex)) {
        useOverlay = true
        renderOverlay(allRanges, activeIndex, scrollRoot)
      }
    }
  }

  const cancelScheduledScan = () => {
    if (scanTimer !== undefined) {
      clearTimeout(scanTimer)
      scanTimer = undefined
    }
    if (scanFrame !== undefined) {
      cancelAnimationFrame(scanFrame)
      scanFrame = undefined
    }
  }

  const scheduleRescan = (throttle = false) => {
    if (scanFrame !== undefined) return
    if (!throttle && scanTimer !== undefined) {
      // User navigation/query changes outrank the mutation throttle. Promote a
      // pending delayed scan to the next frame instead of making find-next wait.
      clearTimeout(scanTimer)
      scanTimer = undefined
    } else if (scanTimer !== undefined) return
    const enqueueFrame = () => {
      scanTimer = undefined
      if (scanFrame !== undefined) return
      scanFrame = requestAnimationFrame(() => {
        scanFrame = undefined
        lastScanAt = performance.now()
        doScan()
      })
    }
    if (!throttle) {
      enqueueFrame()
      return
    }
    const wait = Math.max(0, MUTATION_SCAN_INTERVAL_MS - (performance.now() - lastScanAt))
    if (wait === 0) enqueueFrame()
    else scanTimer = setTimeout(enqueueFrame, wait)
  }

  const clearAll = () => {
    cancelScheduledScan()
    containerCache.clear()
    cachedContainers = null
    containerGeneration = 0
    activeMessageID = undefined
    activeContainer = undefined
    currentRanges = []
    rangeGeneration++
    lastAppliedFingerprint = ""
    clearHighlights()
    clearOverlay()
  }

  return {
    scan(root: HTMLElement) {
      scrollRoot = root
      if (!query) return
      scheduleRescan()
    },

    invalidate(node?: Node) {
      // An open find bar with no query is intentionally cold. Streaming
      // markdown can generate many mutations per second; there is nothing to
      // invalidate or schedule until a real needle exists.
      if (!query) return
      if (!node) {
        containerCache.clear()
        cachedContainers = null
        containerGeneration = 0
      } else {
        const element = node instanceof Element ? node : node.parentElement
        const turn = element?.closest("[data-component='session-turn']")
        if (turn instanceof HTMLElement) {
          containerCache.delete(turn)
        } else {
          // A mutation outside a turn is usually the virtualizer adding/removing
          // row containers. Re-query membership on the next scan.
          cachedContainers = null
          containerGeneration = 0
        }
      }
      lastAppliedFingerprint = ""
      scheduleRescan(true)
    },

    onScroll() {
      // CSS Custom Highlight ranges are anchored to text nodes and move with
      // normal layout/scrolling. Rewalking the transcript on every scroll event
      // is pure waste. Only the fallback absolute-position overlay needs its
      // rectangles recomputed.
      if (!useOverlay || !scrollRoot || currentRanges.length === 0) return
      if (globalOverlayFrame !== undefined) return
      globalOverlayFrame = requestAnimationFrame(() => {
        globalOverlayFrame = undefined
        if (!scrollRoot || !useOverlay) return
        renderOverlay(currentRanges, activeIndex, scrollRoot)
      })
    },

    clear() {
      clearAll()
    },

    dispose() {
      clearAll()
      scrollRoot = undefined
    },

    setOverlayContainer(el: HTMLDivElement | undefined) {
      globalOverlayContainer = el
    },

    setQuery(value: string) {
      if (query === value) return
      query = value
      if (!query.trim()) {
        query = ""
        clearAll()
        return
      }
      // Query changed — all cached ranges are invalid (different needle)
      containerCache.clear()
      rangeGeneration++
      lastAppliedFingerprint = ""
      if (scrollRoot) scheduleRescan()
    },

    setActiveIndex(index: number) {
      if (activeIndex === index) return
      activeIndex = index
      lastAppliedFingerprint = "" // Force re-apply
      if (scrollRoot && query) scheduleRescan()
    },

    getActiveMessageID() {
      return activeMessageID
    },

    getActiveContainer() {
      return activeContainer
    },
  }
}
