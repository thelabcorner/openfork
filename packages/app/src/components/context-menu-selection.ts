export type ContextMenuEditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement

type ControlSelection = {
  kind: "control"
  target: HTMLInputElement | HTMLTextAreaElement
  start: number
  end: number
}

type RangeSelection = {
  kind: "range"
  range: Range
  inEditable: boolean
}

type ContextMenuSelection = ControlSelection | RangeSelection

export type ContextMenuSelectionSnapshot = {
  target: Element | null
  editable: ContextMenuEditableTarget | null
  selection?: ContextMenuSelection
}

function editableControl(element: Element) {
  if (element instanceof HTMLTextAreaElement) {
    if (element.disabled || element.readOnly) return null
    return element
  }
  if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) return null
  try {
    if (element.selectionStart === null || element.selectionEnd === null) return null
  } catch {
    return null
  }
  return element
}

function editableRoot(target: Element | null): ContextMenuEditableTarget | null {
  let contentEditable: HTMLElement | null = null
  for (let current = target; current; current = current.parentElement) {
    const control = editableControl(current)
    if (control) return control
    if (!(current instanceof HTMLElement)) continue
    const explicit = current.getAttribute("contenteditable")
    if (current.isContentEditable || explicit === "true" || explicit === "plaintext-only") {
      contentEditable = current
      continue
    }
    if (contentEditable) break
  }
  return contentEditable
}

function rangeInside(target: HTMLElement, range: Range) {
  return target.contains(range.startContainer) && target.contains(range.endContainer)
}

export function captureContextMenuSelection(target: Element | null): ContextMenuSelectionSnapshot {
  const editable = editableRoot(target)
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const start = editable.selectionStart ?? editable.value.length
    const end = editable.selectionEnd ?? start
    return { target, editable, selection: { kind: "control", target: editable, start, end } }
  }

  const selection = window.getSelection()
  if (!selection?.rangeCount) return { target, editable }
  const range = selection.getRangeAt(0).cloneRange()
  return {
    target,
    editable,
    selection: {
      kind: "range",
      range,
      inEditable: editable instanceof HTMLElement && rangeInside(editable, range),
    },
  }
}

export function contextMenuSelectionText(snapshot: ContextMenuSelectionSnapshot) {
  const selection = snapshot.selection
  if (!selection) return ""
  if (selection.kind === "control") return selection.target.value.slice(selection.start, selection.end)
  return selection.range.toString()
}

export function contextMenuHasSelection(snapshot: ContextMenuSelectionSnapshot) {
  const selection = snapshot.selection
  if (!selection) return false
  if (selection.kind === "control") return selection.start !== selection.end
  return !selection.range.collapsed
}
