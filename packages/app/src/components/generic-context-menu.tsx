import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
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
  const [open, setOpen] = createSignal(false)
  const [anchor, setAnchor] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 })
  let triggerRef: HTMLButtonElement | undefined

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

  const handleContextMenu = (e: MouseEvent) => {
    if (e.defaultPrevented) return
    const targetEl = e.target as Element | null
    if (targetEl?.closest('[data-component="menu-v2-content"]')) return
    setTarget(targetEl)
    setAnchor({ x: e.clientX, y: e.clientY })
    e.preventDefault()
    setOpen(true)
  }

  return (
    <div onContextMenu={handleContextMenu} onPointerDown={(e: PointerEvent) => setTarget(e.target as Element)} style={{ display: "contents" }}>
      {props.children}
      <MenuV2 open={open()} onOpenChange={setOpen} placement="right-start" gutter={2} shift={2} flip overflowPadding={8}>
        <MenuV2.Trigger
          ref={(el: HTMLButtonElement) => {
            triggerRef = el
          }}
          style={
            {
              position: "fixed",
              left: `${anchor().x}px`,
              top: `${anchor().y}px`,
              width: "1px",
              height: "1px",
              opacity: "0",
              "pointer-events": "none",
              padding: "0",
              border: "0",
            } as any
          }
          aria-hidden="true"
          tabIndex={-1}
        />
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Item disabled={!selectable()} onSelect={copy}>
              <span class="flex items-center gap-2 w-full">
                <span data-slot="menu-v2-item-icon">
                  <Icon name="outline-copy" size="small" />
                </span>
                {language.t("common.copy")}
              </span>
            </MenuV2.Item>
            <MenuV2.Item disabled={!editable() || !selectable()} onSelect={cut}>
              <span class="flex items-center gap-2 w-full">
                <span data-slot="menu-v2-item-icon">
                  <Icon name="edit" size="small" />
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
                  <Icon name="expand" size="small" />
                </span>
                {language.t("common.selectAll")}
              </span>
            </MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )
}
