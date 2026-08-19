import { createMemo, createResource, createSignal, onMount, Show, type JSX } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from "shiki"
import { checksum } from "@opencode-ai/core/util/encode"
import { createMarkdownParser } from "@opencode-ai/ui/context/marked-parser"
import { OpenCodeTheme } from "@opencode-ai/ui/context/marked-theme"
import {
  getCachedMarkdown,
  sanitizeMarkdown,
  touchCachedMarkdown,
  type MarkdownCacheEntry,
} from "@opencode-ai/session-ui/markdown-cache"
import { estimateMarkdownHeight, MARKDOWN_WIDTH_FALLBACK } from "./project-explorer-markdown-height"
import { ProjectExplorerScrollbar } from "./project-explorer-scrollbar"
import "./project-explorer-scrollbar.css"
import "./project-explorer-markdown-viewer.css"

/**
 * Rich rendered-markdown view for the project explorer editor pane.
 * The filetype dispatch in the editor pane imports this exact signature.
 */

let highlighter: Promise<Highlighter> | undefined

function getHighlighter() {
  return (highlighter ??= createHighlighter({ themes: [OpenCodeTheme], langs: [] }))
}

// Module-level singleton parser: the Marked instance (with KaTeX + Shiki) is
// created once and shared across every viewer instance, matching the session
// timeline's highlight machinery (createHighlighter + OpenCode theme).
const parser = createMarkdownParser(async (code, language) => {
  const instance = await getHighlighter()
  const name = language in bundledLanguages ? language : "text"
  if (!instance.getLoadedLanguages().includes(name))
    await instance.loadLanguage(bundledLanguages[name as BundledLanguage])
  return instance.codeToHtml(code, { lang: name as BundledLanguage, theme: "OpenCode", tabindex: false })
})

function cachedEntry(key: string, content: string): string | undefined {
  const cached = getCachedMarkdown(key)
  if (!cached || cached.raw !== content) return undefined
  touchCachedMarkdown(key, cached)
  return cached.html
}

function cacheEntry(key: string, content: string, html: string) {
  const entry: MarkdownCacheEntry = { raw: content, hash: checksum(content) ?? "", html }
  touchCachedMarkdown(key, entry)
}

async function renderMarkdown(path: string, content: string) {
  const key = `${path}\u0000${content}`
  const cached = cachedEntry(key, content)
  if (cached !== undefined) return cached
  const html = sanitizeMarkdown(await parser.parse(content))
  cacheEntry(key, content, html)
  return html
}

export function ProjectExplorerMarkdownViewer(props: { path: string; content: string }): JSX.Element {
  const language = useLanguage()
  const [html] = createResource(
    () => [props.path, props.content],
    async (source) => renderMarkdown(source[0], source[1]),
  )
  const [width, setWidth] = createSignal(MARKDOWN_WIDTH_FALLBACK)
  const [selectionText, setSelectionText] = createSignal("")
  let host: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined

  onMount(() => {
    const update = () => {
      if (!host || host.clientWidth <= 0) return
      setWidth(host.clientWidth)
    }
    update()
    createResizeObserver(() => host, update)
  })

  // Capture the in-viewer selection when the context menu opens; right-click
  // keeps the selection, so this reflects what Copy should copy.
  const captureSelection = (open: boolean) => {
    if (!open) {
      setSelectionText("")
      return
    }
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const focus = selection?.focusNode
    if (!selection || !anchor || !focus || !host?.contains(anchor) || !host?.contains(focus)) {
      setSelectionText("")
      return
    }
    setSelectionText(selection.toString())
  }

  const copySelection = async () => {
    const text = selectionText()
    if (!text) return
    await navigator.clipboard.writeText(text)
  }

  const selectAll = () => {
    if (!host) return
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(host)
    selection.removeAllRanges()
    selection.addRange(range)
    setSelectionText(selection.toString())
  }

  const copyMarkdown = () => navigator.clipboard.writeText(props.content)

  const copyHtml = () => navigator.clipboard.writeText(html() ?? "")

  const copyPath = async () => {
    await navigator.clipboard.writeText(props.path)
    showToast({ title: language.t("projectExplorer.contextMenu.pathCopied") })
  }

  // Advisory placeholder height while the async parse is pending; undefined
  // unless the OPENCODE_TEXT_LAYOUT flag enables prediction (DOM is authoritative).
  const placeholderHeight = createMemo(() => {
    if (html.error || html()) return undefined
    return estimateMarkdownHeight(props.content, width())
  })

  return (
    <div
      ref={(el) => {
        host = el
      }}
      data-component="project-explorer-markdown-viewer"
      dir="auto"
    >
      <div
        ref={(el) => {
          scroller = el
        }}
        data-slot="project-explorer-markdown-viewer-scroller"
      >
        <MenuV2.Context onOpenChange={captureSelection}>
          <MenuV2.Context.Trigger as="div" class="contents">
            <Show when={html.error}>
              <pre data-slot="project-explorer-markdown-viewer-fallback">{props.content}</pre>
            </Show>
            <Show when={!html.error && html()}>
              <div data-slot="project-explorer-markdown-viewer-body" innerHTML={html()} />
            </Show>
            <Show when={placeholderHeight()}>
              <div data-slot="project-explorer-markdown-viewer-placeholder" style={{ height: `${placeholderHeight()}px` }} />
            </Show>
          </MenuV2.Context.Trigger>
          <MenuV2.Context.Portal>
            <MenuV2.Context.Content>
              <MenuV2.Item disabled={!selectionText()} onSelect={() => void copySelection()}>
                {language.t("ui.message.copy")}
              </MenuV2.Item>
              <MenuV2.Item onSelect={selectAll}>{language.t("projectExplorer.markdown.selectAll")}</MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => void copyMarkdown()}>
                {language.t("projectExplorer.markdown.copyAsMarkdown")}
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => void copyHtml()}>{language.t("projectExplorer.markdown.copyAsHtml")}</MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => void copyPath()}>{language.t("projectExplorer.markdown.copyPath")}</MenuV2.Item>
            </MenuV2.Context.Content>
          </MenuV2.Context.Portal>
        </MenuV2.Context>
      </div>
      <ProjectExplorerScrollbar viewport={() => scroller} />
    </div>
  )
}
