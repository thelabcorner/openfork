import { describe, expect, test } from "bun:test"
import {
  captureContextMenuSelection,
  contextMenuHasSelection,
  contextMenuSelectionText,
} from "./context-menu-selection"
import {
  copyContextMenuSelection,
  cutContextMenuSelection,
  pasteContextMenuClipboard,
  pasteContextMenuText,
  selectAllContextMenuTarget,
} from "./context-menu-actions"

function withClipboard(clipboard: Pick<Clipboard, "readText" | "writeText">) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard })
  return () => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor)
    else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
  }
}

describe("context menu selection snapshots", () => {
  test("preserves a text-control selection after focus moves to the menu", () => {
    const input = document.createElement("textarea")
    input.value = "alpha beta gamma"
    document.body.append(input)
    input.setSelectionRange(6, 10)

    const snapshot = captureContextMenuSelection(input)
    input.setSelectionRange(0, 0)

    expect(contextMenuHasSelection(snapshot)).toBe(true)
    expect(contextMenuSelectionText(snapshot)).toBe("beta")
    input.remove()
  })

  test("copies the captured selection after the live selection has collapsed", async () => {
    const editor = document.createElement("div")
    editor.setAttribute("contenteditable", "true")
    editor.textContent = "hello world"
    document.body.append(editor)

    const text = editor.firstChild!
    const range = document.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    const live = window.getSelection()!
    live.removeAllRanges()
    live.addRange(range)
    const snapshot = captureContextMenuSelection(editor)
    live.removeAllRanges()

    let copied = ""
    const restoreClipboard = withClipboard({
      readText: async () => "",
      writeText: async (value) => {
        copied = value
      },
    })
    try {
      expect(await copyContextMenuSelection(snapshot)).toBe(true)
      expect(copied).toBe("world")
    } finally {
      restoreClipboard()
      editor.remove()
    }
  })

  test("cuts the originally captured text-control selection", async () => {
    const input = document.createElement("textarea")
    input.value = "alpha beta gamma"
    document.body.append(input)
    input.setSelectionRange(6, 10)
    const snapshot = captureContextMenuSelection(input)
    input.setSelectionRange(0, 0)

    let copied = ""
    let inputs = 0
    input.addEventListener("input", () => inputs++)
    const restoreClipboard = withClipboard({
      readText: async () => "",
      writeText: async (value) => {
        copied = value
      },
    })
    try {
      expect(await cutContextMenuSelection(snapshot)).toBe(true)
      expect(copied).toBe("beta")
      expect(input.value).toBe("alpha  gamma")
      expect(inputs).toBe(1)
    } finally {
      restoreClipboard()
      input.remove()
    }
  })

  test("resolves nested non-editable mention nodes back to the prompt editor", () => {
    const editor = document.createElement("div")
    editor.setAttribute("contenteditable", "true")
    const mention = document.createElement("span")
    mention.setAttribute("contenteditable", "false")
    mention.textContent = "@file"
    editor.append("before ", mention, " after")
    document.body.append(editor)

    const range = document.createRange()
    range.selectNode(mention)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const snapshot = captureContextMenuSelection(mention)
    expect(snapshot.editable).toBe(editor)
    expect(contextMenuSelectionText(snapshot)).toBe("@file")
    editor.remove()
  })

  test("restores contenteditable selection before routing a synthetic paste", () => {
    const editor = document.createElement("div")
    editor.setAttribute("contenteditable", "true")
    editor.textContent = "hello world"
    document.body.append(editor)

    const text = editor.firstChild!
    const range = document.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const snapshot = captureContextMenuSelection(editor)
    selection.removeAllRanges()

    let pasted = ""
    editor.addEventListener("paste", (event) => {
      pasted = event.clipboardData?.getData("text/plain") ?? ""
      event.preventDefault()
    })

    expect(pasteContextMenuText(snapshot, "replacement")).toBe(true)
    expect(pasted).toBe("replacement")
    expect(window.getSelection()?.toString()).toBe("world")
    editor.remove()
  })

  test("reads clipboard text once and routes it through the editor paste handler", async () => {
    const editor = document.createElement("div")
    editor.setAttribute("contenteditable", "true")
    editor.textContent = "hello world"
    document.body.append(editor)

    const text = editor.firstChild!
    const range = document.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    const live = window.getSelection()!
    live.removeAllRanges()
    live.addRange(range)
    const snapshot = captureContextMenuSelection(editor)
    live.removeAllRanges()

    let reads = 0
    let pasted = ""
    const restoreClipboard = withClipboard({
      readText: async () => {
        reads++
        return "replacement"
      },
      writeText: async () => {},
    })
    editor.addEventListener("paste", (event) => {
      pasted = event.clipboardData?.getData("text/plain") ?? ""
      event.preventDefault()
    })
    try {
      expect(await pasteContextMenuClipboard(snapshot)).toBe(true)
      expect(reads).toBe(1)
      expect(pasted).toBe("replacement")
    } finally {
      restoreClipboard()
      editor.remove()
    }
  })

  test("falls back to setRangeText for plain text controls", () => {
    const input = document.createElement("textarea")
    input.value = "alpha beta gamma"
    document.body.append(input)
    input.setSelectionRange(6, 10)
    const snapshot = captureContextMenuSelection(input)
    input.setSelectionRange(0, 0)

    let inputs = 0
    input.addEventListener("input", () => inputs++)
    expect(pasteContextMenuText(snapshot, "delta")).toBe(true)
    expect(input.value).toBe("alpha delta gamma")
    expect(inputs).toBe(1)
    input.remove()
  })

  test("select all targets the captured editable root rather than the full document", () => {
    const editor = document.createElement("div")
    editor.setAttribute("contenteditable", "true")
    editor.textContent = "composer only"
    const sibling = document.createElement("div")
    sibling.textContent = "outside"
    document.body.append(editor, sibling)

    const snapshot = captureContextMenuSelection(editor)
    selectAllContextMenuTarget(snapshot)

    expect(window.getSelection()?.toString()).toBe("composer only")
    editor.remove()
    sibling.remove()
  })
})
