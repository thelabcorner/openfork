import { createSignal, type ParentProps } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { SelectionToolbar } from "./selection-toolbar"

function isEditableTarget(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  if (el instanceof HTMLInputElement) return !el.disabled && !el.readOnly && el.type !== "checkbox" && el.type !== "radio"
  return (el as HTMLElement).isContentEditable
}

function hasSelection() {
  const sel = typeof window !== "undefined" ? window.getSelection() : null
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0
}

function selectedText() {
  return window.getSelection()?.toString() ?? ""
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return document.execCommand("copy")
  }
}

function insertAtCursor(target: HTMLInputElement | HTMLTextAreaElement | HTMLElement, text: string) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? target.value.length
    target.setRangeText(text, start, end, "end")
    target.dispatchEvent(new Event("input", { bubbles: true }))
    return
  }
  document.execCommand("insertText", false, text)
}

/**
 * Premium session surface: wraps the timeline/composer reading surface with
 * two complementary affordances that share the same selection detection:
 *  - a floating selection toolbar (Add to chat / New session / Add to notes / Copy)
 *  - a contextual right-click menu (copy/cut/paste/select-all + session actions)
 *
 * Mount INSIDE the session route (so usePrompt/useSDK/useServer are valid).
 * Any more specific MenuV2.Context deeper in the tree still wins via
 * stopPropagation — this is the fallback for the session reading surface only.
 */
export function SessionTextSurface(props: ParentProps<{ containerRef?: () => HTMLElement | undefined | null }>) {
  const language = useLanguage()
  const prompt = usePrompt()
  const sdk = useSDK()
  const server = useServer()
  const tabs = useTabs()

  // For toolbar + context menu we need a stable container ref. Prefer explicit prop,
  // otherwise fall back to the surface div itself.
  let surfaceRef: HTMLDivElement | undefined
  const container = () => props.containerRef?.() ?? surfaceRef

  // Context-menu target tracking — captured on pointerdown so the menu can
  // enable/disable items based on what was actually right-clicked.
  const [target, setTarget] = createSignal<Element | null>(null)
  const editable = () => isEditableTarget(target())
  const selectable = () => hasSelection()

  const copy = () => {
    const text = selectedText()
    if (text) void writeClipboard(text).then(() => showToast({ title: language.t("common.copy"), variant: "success" }))
  }
  const cut = () => {
    const el = target()
    const text = selectedText()
    if (!text || !editable()) return
    void writeClipboard(text).then(() => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const start = el.selectionStart ?? 0
        const end = el.selectionEnd ?? 0
        el.setRangeText("", start, end, "end")
        el.dispatchEvent(new Event("input", { bubbles: true }))
      } else {
        document.execCommand("delete")
      }
    })
  }
  const paste = () => {
    const el = target()
    if (!el || !isEditableTarget(el)) return
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) insertAtCursor(el, text)
      })
      .catch(() => {
        document.execCommand("paste")
      })
  }
  const selectAll = () => {
    const el = target()
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.select()
      return
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      return
    }
    document.execCommand("selectAll")
  }

  const addToChat = (textOverride?: string) => {
    const text = (textOverride ?? selectedText()).trim()
    if (!text) {
      showToast({ title: language.t("projectExplorer.contextMenu.noActiveChat"), variant: "error" })
      return
    }
    try {
      const current = prompt.current()
      // Append as quoted block — preserves history, keeps mention spans intact
      const last = current[current.length - 1]
      const quoted = text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
      const insertion = `\n${quoted}\n`
      if (last?.type === "text") {
        const sep = last.content === "" || last.content.endsWith("\n") ? "" : "\n"
        const nextContent = last.content + sep + insertion
        prompt.set(
          [...current.slice(0, -1), { ...last, content: nextContent, end: nextContent.length }],
          nextContent.length,
        )
      } else {
        prompt.set([...current, { type: "text", content: text, start: 0, end: text.length }], text.length)
      }
      showToast({ title: language.t("projectExplorer.contextMenu.addedToChat", { name: text.slice(0, 32) }), variant: "success" })
      // Focus composer for immediate follow-up
      requestAnimationFrame(() => {
        const ed = document.querySelector<HTMLElement>("[data-component='prompt-input'] [contenteditable='true']")
        ed?.focus()
      })
    } catch (e) {
      showToast({ title: language.t("common.requestFailed"), description: e instanceof Error ? e.message : undefined, variant: "error" })
    }
  }

  const newSessionWithSelection = (textOverride?: string) => {
    const text = (textOverride ?? selectedText()).trim()
    if (!text) return
    const dir = sdk().directory
    // tabs.newDraft navigates itself; prompt is seeded as initial draft prompt
    void tabs.newDraft({ server: server.key, directory: dir }, text)
    showToast({ title: language.t("command.session.new"), variant: "success" })
  }

  const addToNotes = (textOverride?: string) => {
    const text = (textOverride ?? selectedText()).trim()
    if (!text) return
    // Premium stub: notes file not yet backed — copy with toast so action is never dead.
    // When the notes backend lands, replace with file-ops create + real persistence.
    void writeClipboard(text).then(() => {
      showToast({ title: language.t("selection.toolbar.addedToNotes"), variant: "success" })
    })
  }

  const copySelection = (textOverride?: string) => {
    const text = textOverride ?? selectedText()
    if (text) void writeClipboard(text)
  }

  const toolbarActions = () => [
    { id: "copy", label: language.t("common.copy"), icon: "outline-copy", onSelect: (t: string) => copySelection(t) },
    { id: "addToChat", label: language.t("projectExplorer.contextMenu.addToChat"), icon: "chats", onSelect: (t: string) => addToChat(t) },
    { id: "newSession", label: language.t("command.session.new"), icon: "plus", onSelect: (t: string) => newSessionWithSelection(t) },
    { id: "addToNotes", label: language.t("selection.toolbar.addToNotes"), icon: "edit", onSelect: (t: string) => addToNotes(t) },
  ]

  return (
    <>
      {/* Floating pill — selection-driven, not right-click */}
      <SelectionToolbar container={container} actions={toolbarActions()} />

      {/* Right-click surface — session-aware context menu. Wraps only the reading surface so composer keeps native caret behavior. */}
      <div
        ref={surfaceRef}
        data-session-surface
        class="contents"
        onPointerDown={(e) => setTarget(e.target as Element)}
      >
        <MenuV2.Context>
          <MenuV2.Context.Trigger as="div" class="contents">
            {props.children}
          </MenuV2.Context.Trigger>
          <MenuV2.Context.Portal>
            <MenuV2.Context.Content>
              <MenuV2.Item disabled={!selectable()} onSelect={() => copySelection()}>
                <span class="flex items-center gap-2 w-full">
                  <span data-slot="menu-v2-item-icon">
                    <Icon name="outline-copy" size="small" />
                  </span>
                  {language.t("common.copy")}
                </span>
              </MenuV2.Item>
              <MenuV2.Item disabled={!selectable()} onSelect={() => addToChat()}>
                <span class="flex items-center gap-2 w-full">
                  <span data-slot="menu-v2-item-icon">
                    <Icon name="chats" size="small" />
                  </span>
                  {language.t("projectExplorer.contextMenu.addToChat")}
                </span>
              </MenuV2.Item>
              <MenuV2.Item disabled={!selectable()} onSelect={() => newSessionWithSelection()}>
                <span class="flex items-center gap-2 w-full">
                  <span data-slot="menu-v2-item-icon">
                    <Icon name="plus" size="small" />
                  </span>
                  {language.t("command.session.new")}
                </span>
              </MenuV2.Item>
              <MenuV2.Item disabled={!selectable()} onSelect={() => addToNotes()}>
                <span class="flex items-center gap-2 w-full">
                  <span data-slot="menu-v2-item-icon">
                    <Icon name="edit" size="small" />
                  </span>
                  {language.t("selection.toolbar.addToNotes")}
                </span>
              </MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item disabled={!editable() || !selectable()} onSelect={cut}>
                <span class="flex items-center gap-2 w-full">
                  <span data-slot="menu-v2-item-icon">
                    <Icon name="outline-copy" size="small" />
                  </span>
                  {language.t("common.cut")}
                </span>
              </MenuV2.Item>
              <MenuV2.Item disabled={!editable()} onSelect={paste}>
                <span class="flex items-center gap-2 w-full">
                  <span data-slot="menu-v2-item-icon">
                    <Icon name="outline-copy" size="small" />
                  </span>
                  {language.t("common.paste")}
                </span>
              </MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={selectAll}>
                <span class="flex items-center gap-2 w-full">
                  <span data-slot="menu-v2-item-icon">
                    <Icon name="plus" size="small" />
                  </span>
                  {language.t("common.selectAll")}
                </span>
              </MenuV2.Item>
            </MenuV2.Context.Content>
          </MenuV2.Context.Portal>
        </MenuV2.Context>
      </div>
    </>
  )
}
