import { For, Show, createMemo, createSignal } from "solid-js"
import { IconAlertTriangle } from "../../icons"
import { CopyChip } from "./shared"
import { parseToolError, type ErrorBlock } from "./parse"

/**
 * Body of a failed tool call.
 *
 * Previously this was the raw error string in a `<pre>`, which made a one-line
 * "file not found" look identical to a 40-frame stack trace. Errors are prose,
 * except when they are not: `patch` and `edit` quote the source they could not
 * match, and reflowing that as a paragraph destroys the alignment that makes it
 * readable at all on a narrow screen.
 *
 * So: a tinted head strip naming the error type, prose paragraphs and verbatim
 * excerpts in the order the tool wrote them, remediation on a rail, and any
 * real stack trace behind a tap.
 */

function ErrorCode(props: { block: Extract<ErrorBlock, { kind: "code" }> }) {
  return (
    <div class="terr-code">
      <For each={props.block.lines}>
        {(line) => (
          <div class={`terr-code-line ${line.marker ? "marker" : ""}`}>
            <Show when={line.number}>
              <span class="terr-code-gutter tnum">{line.number}</span>
            </Show>
            <span class="terr-code-text">{line.text || " "}</span>
          </div>
        )}
      </For>
    </div>
  )
}

export function ToolErrorPanel(props: { error: string }) {
  const parsed = createMemo(() => parseToolError(props.error))
  const [showStack, setShowStack] = createSignal(false)

  return (
    <div class="terr">
      <div class="terr-head">
        <IconAlertTriangle size={9} />
        <span class="terr-type">{parsed().type ?? "Failed"}</span>
        <CopyChip text={() => parsed().raw} />
      </div>

      <div class="terr-body">
        <For each={parsed().blocks}>
          {(block) => (
            <Show
              when={block.kind === "code"}
              fallback={<div class="terr-msg">{(block as Extract<ErrorBlock, { kind: "text" }>).text}</div>}
            >
              <ErrorCode block={block as Extract<ErrorBlock, { kind: "code" }>} />
            </Show>
          )}
        </For>
      </div>

      <Show when={parsed().hints.length > 0}>
        <div class="terr-hints">
          <For each={parsed().hints}>{(hint) => <div class="terr-hint">{hint}</div>}</For>
        </div>
      </Show>

      <Show when={parsed().stack.length > 0}>
        <Show
          when={showStack()}
          fallback={
            <button
              class="tmore"
              onClick={(event) => {
                event.stopPropagation()
                setShowStack(true)
              }}
            >
              Show stack ({parsed().stack.length} lines)
            </button>
          }
        >
          <pre class="terr-stack">{parsed().stack.join("\n")}</pre>
        </Show>
      </Show>
    </div>
  )
}
