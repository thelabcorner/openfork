import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { createSignal, type ParentProps } from "solid-js"
import { useLanguage } from "@/context/language"

/**
 * App-wide fallback right-click menu (t-context-menu-arch).
 *
 * Mount ONCE at the app root (AppBaseProviders), wrapping the whole tree in a
 * single MenuV2.Context. Kobalte's ContextMenu.Trigger calls
 * stopPropagation() when it opens, so any more specific MenuV2.Context
 * nested deeper in the tree (tabs, project explorer, session rows, custom
 * feature menus) still wins on its own DOM subtree — this root trigger only
 * fires for right-clicks that no inner trigger already claimed. That's the
 * whole architecture: specific menus opt in by wrapping their own region in
 * MenuV2.Context; everywhere else automatically gets this generic
 * copy/cut/paste/select-all menu instead of the native Chrome one.
 *
 * To add a NEW app-wide default action (not specific to one feature), add it
 * here. To add a feature-specific menu, wrap that feature's markup in its
 * own <MenuV2.Context> — no changes needed here.
 */
function isEditableTarget(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  if (el instanceof HTMLInputElement) return !el.disabled && !el.readOnly && el.type !== "checkbox" && el.type !== "radio"
  return (el as HTMLElement).isContentEditable
}

function hasSelection() {
  const sel = typeof window !== "undefined" ? window.getSelection() : null
  return !!sel && !sel.isCollapsed && sel.toString().length > 0
}

async function writeClipboard(text: string): Promise<boolean> {
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

export function GenericContextMenuProvider(props: ParentProps) {
  const language = useLanguage()
  const [target, setTarget] = createSignal<Element | null>(null)

  const editable = () => isEditableTarget(target())
  const selectable = () => hasSelection()

  const copy = () => {
    const text = window.getSelection()?.toString()
    if (text) void writeClipboard(text)
  }
  const cut = () => {
    const el = target()
    const text = window.getSelection()?.toString()
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
        // Clipboard read denied (permissions) — execCommand paste is the
        // best-effort fallback; Chrome blocks it outside a user gesture in
        // some contexts, Electron generally allows it.
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

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger
        as="div"
        class="contents"
        onPointerDown={(event: PointerEvent) => setTarget(event.target as Element)}
      >
        {props.children}
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content>
          <MenuV2.Item disabled={!selectable()} onSelect={copy}>
            {language.t("common.copy")}
          </MenuV2.Item>
          <MenuV2.Item disabled={!editable() || !selectable()} onSelect={cut}>
            {language.t("common.cut")}
          </MenuV2.Item>
          <MenuV2.Item disabled={!editable()} onSelect={paste}>
            {language.t("common.paste")}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item onSelect={selectAll}>{language.t("common.selectAll")}</MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}
