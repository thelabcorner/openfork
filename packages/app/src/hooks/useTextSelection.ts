import { createSignal, onCleanup } from "solid-js"

export type TextSelectionState = {
  text: string
  rect: DOMRect | null
  range: Range | null
  isCollapsed: boolean
  anchorNode: Node | null
}

export function createTextSelection(input: {
  container: () => HTMLElement | undefined | null
  enabled?: () => boolean
  minLength?: number
  debounceMs?: number
}) {
  const [state, setState] = createSignal<TextSelectionState>({
    text: "",
    rect: null,
    range: null,
    isCollapsed: true,
    anchorNode: null,
  })
  const [visible, setVisible] = createSignal(false)

  let raf = 0
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const minLength = () => input.minLength ?? 2
  const isEnabled = () => input.enabled?.() ?? true

  const isInsideContainer = (node: Node | null) => {
    const el = input.container()
    if (!el || !node) return false
    // Text nodes → check parent element
    const target = node.nodeType === Node.TEXT_NODE ? (node.parentElement as Element | null) : (node as Element)
    if (!target) return false
    return el.contains(target)
  }

  const compute = () => {
    if (!isEnabled()) {
      setVisible(false)
      return
    }
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setVisible(false)
      setState({ text: "", rect: null, range: null, isCollapsed: true, anchorNode: sel?.anchorNode ?? null })
      return
    }
    const text = sel.toString()
    if (text.trim().length < minLength()) {
      setVisible(false)
      return
    }
    const range = sel.getRangeAt(0).cloneRange()
    const anchorNode = sel.anchorNode
    // Must be inside container
    if (!isInsideContainer(anchorNode) && !isInsideContainer(sel.focusNode)) {
      setVisible(false)
      return
    }
    // Ignore selections that include editable inputs (composer) — toolbar only for reading surface
    const active = document.activeElement
    if (active instanceof HTMLElement && (active.isContentEditable || active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
      // If selection is inside the active editable, suppress toolbar (use its own caret)
      if (active.contains(anchorNode as Node | null) || active.contains(sel.focusNode as Node | null)) {
        setVisible(false)
        return
      }
    }
    let rect: DOMRect | null = null
    try {
      rect = range.getBoundingClientRect()
      // Zero rect can happen on line-wrapped or hidden ranges — use selection's client rects fallback
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        const rects = range.getClientRects()
        if (rects.length > 0) {
          // Use union of first/last line to get width; anchor near first rect for collapsed-ish
          rect = rects[0] ?? null
        }
      }
    } catch {}
    if (!rect || rect.width < 4) {
      setVisible(false)
      return
    }
    setState({ text, rect, range, isCollapsed: false, anchorNode })
    setVisible(true)
  }

  const schedule = () => {
    const ms = input.debounceMs ?? 40
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(compute)
    }, ms)
  }

  const onSelectionChange = () => schedule()
  const onMouseUp = () => schedule()
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Shift" || e.key.startsWith("Arrow")) schedule()
  }

  document.addEventListener("selectionchange", onSelectionChange)
  document.addEventListener("mouseup", onMouseUp)
  document.addEventListener("keyup", onKeyUp)
  window.addEventListener("resize", schedule)
  window.addEventListener("scroll", schedule, true)

  onCleanup(() => {
    document.removeEventListener("selectionchange", onSelectionChange)
    document.removeEventListener("mouseup", onMouseUp)
    document.removeEventListener("keyup", onKeyUp)
    window.removeEventListener("resize", schedule)
    window.removeEventListener("scroll", schedule, true)
    if (debounceTimer) clearTimeout(debounceTimer)
    cancelAnimationFrame(raf)
  })

  const clear = () => {
    setVisible(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
  }

  return { state, visible, clear, recompute: compute }
}
