import { For, Show, createMemo, createSignal } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { parseToolError, type ErrorBlock } from "./tool-error-parse"

/**
 * Body of a failed tool call.
 *
 * Errors are prose, not code — rendering the whole thing as a monospace blob
 * made a one-line "file not found" look like a stack trace. But they are not
 * *only* prose either: `patch` and `edit` quote the source they could not
 * match, and reflowing that as a paragraph destroys the alignment that makes it
 * readable. So the body is split into prose paragraphs and verbatim excerpts,
 * with remediation and any real stack trace after them.
 */

function ErrorCode(props: { block: Extract<ErrorBlock, { kind: "code" }> }) {
  return (
    <div data-slot="tool-error-code">
      <For each={props.block.lines}>
        {(line) => (
          <div data-slot="tool-error-code-line" data-marker={line.marker ? "true" : undefined}>
            <Show when={line.number}>
              <span data-slot="tool-error-code-gutter">{line.number}</span>
            </Show>
            <span data-slot="tool-error-code-text">{line.text || " "}</span>
          </div>
        )}
      </For>
    </div>
  )
}

export function ToolErrorPanel(props: { error: string }) {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)
  const [showStack, setShowStack] = createSignal(false)

  const parsed = createMemo(() => parseToolError(props.error))

  const copy = async () => {
    if (!parsed().raw) return
    await navigator.clipboard.writeText(parsed().raw)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const copyLabel = () => (copied() ? i18n.t("ui.message.copied") : i18n.t("ui.toolErrorCard.copyError"))

  return (
    <div data-component="tool-error-panel">
      <div data-slot="tool-error-head">
        <Icon name="warning" size="small" />
        <span data-slot="tool-error-type">{parsed().type ?? i18n.t("ui.toolErrorCard.failed")}</span>
        <Tooltip value={copyLabel()} placement="top" gutter={4}>
          <IconButton
            icon={copied() ? "check" : "copy"}
            size="small"
            variant="ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation()
              void copy()
            }}
            aria-label={copyLabel()}
          />
        </Tooltip>
      </div>

      <div data-slot="tool-error-body">
        <For each={parsed().blocks}>
          {(block) => (
            <Show when={block.kind === "code"} fallback={<div data-slot="tool-error-message">{(block as any).text}</div>}>
              <ErrorCode block={block as Extract<ErrorBlock, { kind: "code" }>} />
            </Show>
          )}
        </For>
      </div>

      <Show when={parsed().hints.length > 0}>
        <div data-slot="tool-error-hints">
          <For each={parsed().hints}>{(hint) => <div data-slot="tool-error-hint">{hint}</div>}</For>
        </div>
      </Show>

      <Show when={parsed().stack.length > 0}>
        <Show
          when={showStack()}
          fallback={
            <button type="button" data-component="tool-more" onClick={() => setShowStack(true)}>
              {i18n.t("ui.toolErrorCard.showStack", { count: parsed().stack.length })}
            </button>
          }
        >
          <pre data-slot="tool-error-stack">
            <code>{parsed().stack.join("\n")}</code>
          </pre>
        </Show>
      </Show>
    </div>
  )
}
