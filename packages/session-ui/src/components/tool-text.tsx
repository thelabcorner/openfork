import { For, Show, createMemo, createSignal } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ToolBadge, ToolFields, ToolRow, ToolRows } from "./tool-parts"

/**
 * The last-resort renderer for tool output.
 *
 * The previous fallback pushed raw tool output through the *markdown* renderer,
 * which is actively destructive: tool output is text, and markdown eats the
 * things that carry its meaning. `<job id="…">` wrappers vanish, `*` turns into
 * emphasis, leading whitespace collapses so aligned columns and quoted source
 * lose their alignment, and consecutive lines get reflowed into one paragraph.
 * That is why several tools looked like a garbled wall of prose.
 *
 * So this renders text as text — but it is not a `<pre>` dump either. Most
 * opencode tools emit the same three shapes, and recognising them costs little:
 *
 *   `<tag attr="…">…</tag>`   a wrapper whose attributes are the summary
 *   `Key: value` runs          → a field grid
 *   `- item` runs              → rows
 *
 * Anything unrecognised stays verbatim, monospace, with its indentation.
 */

const FIELD = /^([A-Za-z][A-Za-z0-9 _/-]{0,23}):[ \t]+(\S.*)$/
const BULLET = /^[ \t]*[-*•][ \t]+(\S.*)$/
const WRAPPER = /^<([a-z_][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>\n([\s\S]*)\n<\/\1>$/

export type ToolTextBlock =
  | { kind: "fields"; items: { key: string; value: string }[] }
  | { kind: "list"; items: string[] }
  | { kind: "text"; text: string }

/**
 * Strong markdown signals only. A stray `*` or a single `#` is far more likely
 * to be shell output than a document, and guessing wrong destroys the content.
 */
export function looksLikeMarkdown(text: string) {
  if (/^```/m.test(text)) return true
  if ((text.match(/^#{1,6} \S/gm)?.length ?? 0) >= 2) return true
  if (/^\|.*\|[ \t]*$/m.test(text) && /^\|[\s:|-]+\|[ \t]*$/m.test(text)) return true
  const inline = (text.match(/\*\*[^*\n]+\*\*/g)?.length ?? 0) + (text.match(/\[[^\]\n]+\]\([^)\n]+\)/g)?.length ?? 0)
  return inline >= 3
}

export function parseToolText(output: string) {
  let body = output.trim()
  const attrs: { key: string; value: string }[] = []

  const wrapper = WRAPPER.exec(body)
  if (wrapper) {
    for (const attr of (wrapper[2] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs.push({ key: attr[1]!, value: attr[2]! })
    }
    body = wrapper[3]!
  }

  const blocks: ToolTextBlock[] = []
  let text: string[] = []
  let fields: { key: string; value: string }[] = []
  let list: string[] = []

  const flushText = () => {
    const joined = text.join("\n").replace(/^\n+|\n+$/g, "")
    if (joined.trim()) blocks.push({ kind: "text", text: joined })
    text = []
  }
  // A lone `Key: value` line is a sentence far more often than it is a table,
  // so a run has to be worth the grid before it becomes one.
  const flushFields = () => {
    if (fields.length >= 2) {
      flushText()
      blocks.push({ kind: "fields", items: fields })
    } else {
      for (const field of fields) text.push(`${field.key}: ${field.value}`)
    }
    fields = []
  }
  const flushList = () => {
    if (list.length >= 2) {
      flushText()
      blocks.push({ kind: "list", items: list })
    } else {
      for (const item of list) text.push(`- ${item}`)
    }
    list = []
  }

  for (const line of body.split("\n")) {
    const field = FIELD.exec(line)
    if (field) {
      flushList()
      fields.push({ key: field[1]!, value: field[2]! })
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      flushFields()
      list.push(bullet[1]!)
      continue
    }
    flushFields()
    flushList()
    text.push(line)
  }
  flushFields()
  flushList()
  flushText()

  return { tag: wrapper?.[1], attrs, blocks }
}

/**
 * Height-bounds long output. A 2,000-line log should not push the rest of the
 * conversation off-screen before you have decided you care about it.
 */
function Bounded(props: { children: any; lines: number }) {
  const i18n = useI18n()
  const [full, setFull] = createSignal(false)
  const clamped = () => props.lines > 40 && !full()
  return (
    <>
      <div data-slot="tool-text-scroll" data-clamped={clamped() ? "true" : undefined}>
        {props.children}
      </div>
      <Show when={clamped()}>
        <button type="button" data-component="tool-more" onClick={() => setFull(true)}>
          {i18n.t("ui.toolParts.showAllLines", { count: props.lines })}
        </button>
      </Show>
    </>
  )
}

export function ToolText(props: { output: string }) {
  const parsed = createMemo(() => parseToolText(props.output))
  const lines = createMemo(() => props.output.split("\n").length)

  return (
    <div data-component="tool-text">
      <Show when={parsed().attrs.length > 0}>
        <div data-slot="tool-text-attrs">
          <For each={parsed().attrs}>
            {(attr) => (
              <ToolBadge mono>
                <span data-slot="tool-text-attr-key">{attr.key}</span>
                {attr.value}
              </ToolBadge>
            )}
          </For>
        </div>
      </Show>
      <Bounded lines={lines()}>
        <For each={parsed().blocks}>
          {(block) => (
            <>
              <Show when={block.kind === "fields" && block}>
                {(entry) => <ToolFields items={(entry() as any).items.map((item: any) => ({ ...item, mono: true }))} />}
              </Show>
              <Show when={block.kind === "list" && block}>
                {(entry) => (
                  <ToolRows>
                    <For each={(entry() as any).items as string[]}>
                      {(item) => <ToolRow primary={item} mono={false} />}
                    </For>
                  </ToolRows>
                )}
              </Show>
              <Show when={block.kind === "text" && block}>
                {(entry) => <pre data-slot="tool-text-pre">{(entry() as any).text}</pre>}
              </Show>
            </>
          )}
        </For>
      </Bounded>
    </div>
  )
}
