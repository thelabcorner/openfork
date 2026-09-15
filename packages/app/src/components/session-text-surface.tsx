import { Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { SelectionToolbar } from "./selection-toolbar"
import { ContextMenuCursorTrigger } from "./context-menu-cursor-trigger"
import {
  captureContextMenuSelection,
  contextMenuHasSelection,
  contextMenuSelectionText,
  type ContextMenuSelectionSnapshot,
} from "./context-menu-selection"
import {
  copyContextMenuSelection,
  cutContextMenuSelection,
  pasteContextMenuClipboard,
  selectAllContextMenuTarget,
} from "./context-menu-actions"

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return document.execCommand("copy")
  }
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

  // Context-menu state — controlled DropdownMenu at cursor position.
  // Using a hidden trigger avoids Kobalte's ContextMenu `display: contents`
  // large-area trigger bug where `excludedElements: [triggerRef]` prevents
  // DismissableLayer from closing on left-click outside Content but still inside
  // the trigger area (the whole session viewport). Portal the 1px trigger to the
  // document so viewport client coordinates cannot be rebased by contained panes.
  const [menu, setMenu] = createStore<{
    open: boolean
    request?: { x: number; y: number; selection: ContextMenuSelectionSnapshot }
  }>({ open: false })

  const handleContextMenu = (e: MouseEvent) => {
    const targetEl = e.target as Element | null
    if (targetEl?.closest('[data-component="menu-v2-content"]')) return
    const selection = captureContextMenuSelection(targetEl)
    e.preventDefault()
    e.stopPropagation()
    setMenu({ open: true, request: { x: e.clientX, y: e.clientY, selection } })
  }

  const addToChat = (textOverride?: string) => {
    const text = (textOverride ?? "").trim()
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
    const text = (textOverride ?? "").trim()
    if (!text) return
    const dir = sdk().directory
    // tabs.newDraft navigates itself; prompt is seeded as initial draft prompt
    void tabs.newDraft({ server: server.key, directory: dir }, text)
    showToast({ title: language.t("command.session.new"), variant: "success" })
  }

  const addToNotes = (textOverride?: string) => {
    const text = (textOverride ?? "").trim()
    if (!text) return
    // Premium stub: notes file not yet backed — copy with toast so action is never dead.
    // When the notes backend lands, replace with file-ops create + real persistence.
    void writeClipboard(text).then(() => {
      showToast({ title: language.t("selection.toolbar.addedToNotes"), variant: "success" })
    })
  }

  const copySelection = (textOverride?: string) => {
    const text = textOverride ?? ""
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
        onContextMenu={handleContextMenu}
        style={{ display: "contents" }}
      >
        {props.children}
        <Show when={menu.open && menu.request} keyed>
          {(request) => {
            const text = contextMenuSelectionText(request.selection)
            const selectable = contextMenuHasSelection(request.selection) && text.trim().length > 0
            const editable = !!request.selection.editable
            return (
              <MenuV2
                open={menu.open}
                onOpenChange={(open) => setMenu("open", open)}
                placement="right-start"
                gutter={2}
                shift={2}
                flip
                overflowPadding={8}
              >
                <ContextMenuCursorTrigger x={request.x} y={request.y} />
                <MenuV2.Portal>
                  <MenuV2.Content>
                    <MenuV2.Item disabled={!selectable} onSelect={() => addToChat(text)}>
                      <span class="flex items-center gap-2 w-full">
                        <span data-slot="menu-v2-item-icon"><Icon name="chats" size="small" /></span>
                        {language.t("projectExplorer.contextMenu.addToChat")}
                      </span>
                    </MenuV2.Item>
                    <MenuV2.Item disabled={!selectable} onSelect={() => newSessionWithSelection(text)}>
                      <span class="flex items-center gap-2 w-full">
                        <span data-slot="menu-v2-item-icon"><Icon name="plus" size="small" /></span>
                        {language.t("command.session.new")}
                      </span>
                    </MenuV2.Item>
                    <MenuV2.Item disabled={!selectable} onSelect={() => addToNotes(text)}>
                      <span class="flex items-center gap-2 w-full">
                        <span data-slot="menu-v2-item-icon"><Icon name="edit" size="small" /></span>
                        {language.t("selection.toolbar.addToNotes")}
                      </span>
                    </MenuV2.Item>
                    <MenuV2.Separator />
                    <MenuV2.Item
                      disabled={!selectable}
                      onSelect={() => {
                        void copyContextMenuSelection(request.selection).then((copied) => {
                          if (copied) showToast({ title: language.t("common.copy"), variant: "success" })
                        })
                      }}
                    >
                      <span class="flex items-center gap-2 w-full">
                        <span data-slot="menu-v2-item-icon"><Icon name="outline-copy" size="small" /></span>
                        {language.t("common.copy")}
                      </span>
                    </MenuV2.Item>
                    <MenuV2.Item
                      disabled={!editable || !selectable}
                      onSelect={() => void cutContextMenuSelection(request.selection)}
                    >
                      <span class="flex items-center gap-2 w-full">
                        <span data-slot="menu-v2-item-icon"><Icon name="edit" size="small" /></span>
                        {language.t("common.cut")}
                      </span>
                    </MenuV2.Item>
                    <MenuV2.Item disabled={!editable} onSelect={() => void pasteContextMenuClipboard(request.selection)}>
                      <span class="flex items-center gap-2 w-full">
                        <span data-slot="menu-v2-item-icon"><Icon name="outline-copy" size="small" /></span>
                        {language.t("common.paste")}
                      </span>
                    </MenuV2.Item>
                    <MenuV2.Separator />
                    <MenuV2.Item onSelect={() => selectAllContextMenuTarget(request.selection)}>
                      <span class="flex items-center gap-2 w-full">
                        <span data-slot="menu-v2-item-icon"><Icon name="expand" size="small" /></span>
                        {language.t("common.selectAll")}
                      </span>
                    </MenuV2.Item>
                  </MenuV2.Content>
                </MenuV2.Portal>
              </MenuV2>
            )
          }}
        </Show>
      </div>
    </>
  )
}
