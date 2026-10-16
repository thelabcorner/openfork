/** Editor-neutral CSS Custom Highlight painter. Never wraps/replaces text nodes,
 * preserving IME, undo, UTF-16 selection, and noneditable @mentions. */
export type WritingIssue = {
  id: string
  start: number
  end: number
  category: "spelling" | "grammar"
}
let instance = 0

function textRange(editor: HTMLElement, start: number, end: number): Range | undefined {
  if (end <= start || start < 0) return undefined
  const tree = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let offset = 0
  let node = tree.nextNode()
  let from: { node: Node; offset: number } | undefined
  while (node) {
    const length = node.textContent?.length ?? 0
    if (!from && start >= offset && start < offset + length) from = { node, offset: start - offset }
    if (from && end <= offset + length) {
      const range = document.createRange()
      range.setStart(from.node, from.offset)
      range.setEnd(node, end - offset)
      return range
    }
    offset += length
    node = tree.nextNode()
  }
  return undefined
}

export function createPromptWritingHighlights() {
  const id = ++instance
  const spelling = `openfork-writing-spelling-${id}`
  const grammar = `openfork-writing-grammar-${id}`
  const corrected = `openfork-writing-corrected-${id}`
  let pairs: { issue: WritingIssue; range: Range }[] = []
  let correctedPairs: { issue: WritingIssue; range: Range }[] = []
  let style: HTMLStyleElement | undefined

  const registry = () => typeof CSS !== "undefined" ? CSS.highlights : undefined
  const clear = () => {
    registry()?.delete(spelling)
    registry()?.delete(grammar)
    registry()?.delete(corrected)
    pairs = []
    correctedPairs = []
  }
  const paint = (editor: HTMLElement, fullText: string, issues: readonly WritingIssue[],
    automatic: readonly Pick<WritingIssue, "id" | "start" | "end">[] = []) => {
    clear()
    if ((!issues.length && !automatic.length) || typeof Highlight === "undefined" || !registry()) return
    // Browser editor may hold <br>/nested paragraphs during an in-progress
    // composition. Never paint potentially wrong offsets.
    if (editor.textContent !== fullText) return
    if (!style) {
      style = document.createElement("style")
      style.textContent = `
        ::highlight(${spelling}) { text-decoration: underline wavy #e05252; text-decoration-thickness: 1px; text-underline-offset: 3px; }
        ::highlight(${grammar}) { text-decoration: underline wavy #438dd7; text-decoration-thickness: 1px; text-underline-offset: 3px; }
        ::highlight(${corrected}) { background-color: rgb(113 113 122 / 0.13); text-decoration: underline dotted #a1a1aa; text-decoration-thickness: 1px; text-underline-offset: 3px; }
      `
      document.head.appendChild(style)
    }
    const spell: Range[] = []
    const gram: Range[] = []
    for (const issue of issues.slice(0, 32)) {
      const range = textRange(editor, issue.start, issue.end)
      if (!range) continue
      // Last defense against stale async highlights spanning edited words.
      pairs.push({ issue, range })
      if (issue.category === "spelling") spell.push(range)
      else gram.push(range)
    }
    if (spell.length) registry()?.set(spelling, new Highlight(...spell))
    if (gram.length) registry()?.set(grammar, new Highlight(...gram))
    const fixed: Range[] = []
    for (const item of automatic.slice(0, 32)) {
      const range = textRange(editor, item.start, item.end)
      if (!range) continue
      correctedPairs.push({ issue: { ...item, category: "spelling" }, range })
      fixed.push(range)
    }
    if (fixed.length) registry()?.set(corrected, new Highlight(...fixed))
  }
  const atPoint = (x: number, y: number): WritingIssue | undefined => {
    // Rect measurements happen on deliberate user click only, never typing.
    for (const { issue, range } of pairs) {
      for (const rect of range.getClientRects()) {
        if (x >= rect.left - 2 && x <= rect.right + 2 &&
          y >= rect.top - 3 && y <= rect.bottom + 3) return issue
      }
    }
    return undefined
  }
  const atCorrectionPoint = (x: number, y: number): string | undefined => {
    for (const { issue, range } of correctedPairs) {
      for (const rect of range.getClientRects()) {
        if (x >= rect.left - 2 && x <= rect.right + 2 &&
          y >= rect.top - 3 && y <= rect.bottom + 3) return issue.id
      }
    }
    return undefined
  }
  const hoverAtPoint = (x: number, y: number): {
    kind: "corrected" | "suggestion"
    id: string
    rect: { left: number; top: number; right: number; bottom: number }
  } | undefined => {
    for (const { kind, items } of [
      { kind: "corrected" as const, items: correctedPairs },
      { kind: "suggestion" as const, items: pairs },
    ]) {
      for (const { issue, range } of items) {
        for (const rect of range.getClientRects()) {
          if (x < rect.left - 1 || x > rect.right + 1 ||
            y < rect.top - 2 || y > rect.bottom + 2) continue
          return {
            kind, id: issue.id,
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          }
        }
      }
    }
    return undefined
  }
  const destroy = () => {
    clear()
    style?.remove()
    style = undefined
  }
  return { paint, clear, atPoint, atCorrectionPoint, hoverAtPoint, destroy }
}
