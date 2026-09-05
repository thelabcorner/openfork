import { For, Show, createMemo, createSignal } from "solid-js"
import { Chip, Fields, Row, Rows } from "./primitives"
import { parseToolText, type ToolTextBlock } from "./parse"
import { parseShellOutput } from "./ansi"

/**
 * The last-resort renderer for tool output.
 *
 * The generic body used to be `JSON.stringify(input)` above the raw output in
 * two `<pre>` blocks. That is honest but unreadable: the JSON is the *request*,
 * which the collapsed row already summarises, and the output loses whatever
 * structure it had.
 *
 * Most opencode tools emit one of three shapes, and recognising them is nearly
 * free:
 *
 *   `<tag attr="…">…</tag>`  a wrapper whose attributes are the summary
 *   `Key: value` runs         → a field grid
 *   `- item` runs             → rows
 *
 * Anything unrecognised stays verbatim, with its indentation, because the
 * alignment is often the only structure it has.
 */

const CLAMP_LINES = 40

export function ToolText(props: { output: string }) {
  // One implementation of "resolve line rewrites, drop the escapes".
  const clean = createMemo(() => parseShellOutput(props.output).text)
  const parsed = createMemo(() => parseToolText(clean()))
  const lines = createMemo(() => clean().split("\n").length)
  const [full, setFull] = createSignal(false)
  const clamped = () => lines() > CLAMP_LINES && !full()

  return (
    <div class="ttext">
      <Show when={parsed().attrs.length > 0}>
        <div class="ttext-attrs">
          <For each={parsed().attrs}>
            {(attr) => (
              <Chip soft>
                <span class="ttext-attr-key">{attr.key}</span>
                {attr.value}
              </Chip>
            )}
          </For>
        </div>
      </Show>

      <div class={`ttext-scroll ${clamped() ? "clamped" : ""}`}>
        <For each={parsed().blocks}>
          {(block: ToolTextBlock) => (
            <>
              <Show when={block.kind === "fields" && block}>
                {(entry) => (
                  <Fields
                    items={(entry() as Extract<ToolTextBlock, { kind: "fields" }>).items.map((item) => ({
                      key: item.key,
                      value: item.value,
                    }))}
                  />
                )}
              </Show>
              <Show when={block.kind === "list" && block}>
                {(entry) => (
                  <Rows>
                    <For each={(entry() as Extract<ToolTextBlock, { kind: "list" }>).items}>
                      {(item) => <Row primary={item} />}
                    </For>
                  </Rows>
                )}
              </Show>
              <Show when={block.kind === "text" && block}>
                {(entry) => <pre class="ttext-pre">{(entry() as Extract<ToolTextBlock, { kind: "text" }>).text}</pre>}
              </Show>
            </>
          )}
        </For>
      </div>

      <Show when={clamped()}>
        <button
          class="tmore"
          onClick={(event) => {
            event.stopPropagation()
            setFull(true)
          }}
        >
          Show all {lines()} lines
        </button>
      </Show>
    </div>
  )
}
