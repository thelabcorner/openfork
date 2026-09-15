import {
  contextMenuSelectionText,
  type ContextMenuEditableTarget,
  type ContextMenuSelectionSnapshot,
} from "./context-menu-selection"

function restoreSelection(snapshot: ContextMenuSelectionSnapshot, editableOnly: boolean) {
  const selection = snapshot.selection
  if (!selection) return false

  if (selection.kind === "control") {
    if (editableOnly && snapshot.editable !== selection.target) return false
    try {
      selection.target.focus({ preventScroll: true })
      selection.target.setSelectionRange(selection.start, selection.end)
      return true
    } catch {
      return false
    }
  }

  if (editableOnly && (!snapshot.editable || !selection.inEditable)) return false
  if (!selection.range.startContainer.isConnected || !selection.range.endContainer.isConnected) return false
  try {
    if (editableOnly && snapshot.editable instanceof HTMLElement) snapshot.editable.focus({ preventScroll: true })
    const live = window.getSelection()
    if (!live) return false
    live.removeAllRanges()
    live.addRange(selection.range.cloneRange())
    return true
  } catch {
    return false
  }
}

function dispatchInput(target: Element, inputType: string, data: string | null) {
  try {
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }))
  } catch {
    target.dispatchEvent(new Event("input", { bubbles: true }))
  }
}

async function writeClipboard(text: string, snapshot: ContextMenuSelectionSnapshot) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    if (!restoreSelection(snapshot, false)) return false
    return typeof document.execCommand === "function" && document.execCommand("copy")
  }
}

export async function copyContextMenuSelection(snapshot: ContextMenuSelectionSnapshot) {
  const text = contextMenuSelectionText(snapshot)
  if (!text) return false
  return writeClipboard(text, snapshot)
}

export async function cutContextMenuSelection(snapshot: ContextMenuSelectionSnapshot) {
  const selection = snapshot.selection
  const editable = snapshot.editable
  const text = contextMenuSelectionText(snapshot)
  if (!selection || !editable || !text) return false
  if (selection.kind === "range" && !selection.inEditable) return false
  if (!(await writeClipboard(text, snapshot))) return false

  if (selection.kind === "control") {
    selection.target.setRangeText("", selection.start, selection.end, "end")
    dispatchInput(selection.target, "deleteByCut", null)
    return true
  }

  if (!restoreSelection(snapshot, true)) return false
  if (typeof document.execCommand === "function" && document.execCommand("delete")) return true
  selection.range.deleteContents()
  dispatchInput(editable, "deleteByCut", null)
  return true
}

function dispatchPaste(target: ContextMenuEditableTarget, text: string) {
  try {
    const clipboardData = new DataTransfer()
    clipboardData.setData("text/plain", text)
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData })
    const uncancelled = target.dispatchEvent(event)
    return !uncancelled || event.defaultPrevented
  } catch {
    return false
  }
}

export function pasteContextMenuText(snapshot: ContextMenuSelectionSnapshot, text: string) {
  const editable = snapshot.editable
  const selection = snapshot.selection
  if (!editable || !selection || !restoreSelection(snapshot, true)) return false
  if (dispatchPaste(editable, text)) return true

  if (selection.kind === "control") {
    selection.target.setRangeText(text, selection.start, selection.end, "end")
    dispatchInput(selection.target, "insertFromPaste", text)
    return true
  }

  if (typeof document.execCommand === "function" && document.execCommand("insertText", false, text)) return true
  const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : selection.range.cloneRange()
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  const live = window.getSelection()
  live?.removeAllRanges()
  live?.addRange(range)
  dispatchInput(editable, "insertFromPaste", text)
  return true
}

export async function pasteContextMenuClipboard(snapshot: ContextMenuSelectionSnapshot) {
  if (!snapshot.editable) return false
  try {
    const text = await navigator.clipboard.readText()
    if (!text) return true
    return pasteContextMenuText(snapshot, text)
  } catch {
    if (!restoreSelection(snapshot, true)) return false
    return typeof document.execCommand === "function" && document.execCommand("paste")
  }
}

export function selectAllContextMenuTarget(snapshot: ContextMenuSelectionSnapshot) {
  const editable = snapshot.editable
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    editable.focus({ preventScroll: true })
    editable.select()
    return
  }
  if (editable instanceof HTMLElement) {
    editable.focus({ preventScroll: true })
    const range = document.createRange()
    range.selectNodeContents(editable)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    return
  }
  document.execCommand("selectAll")
}
