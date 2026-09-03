import { For, Show, createMemo, createSignal } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"

/**
 * Body of a failed tool call.
 *
 * Errors are prose, not code — the old panel rendered the whole thing as a
 * monospace blob, which made a one-line "file not found" look like a stack
 * trace. This splits the three things an error actually contains:
 *
 *   1. a type (`SchemaError`, `ENOENT`) → badge
 *   2. the message → readable sans
 *   3. remediation the tool appended ("Please rewrite the input…") → footer
 *
 * Stack-like tails stay monospace and collapse, so a deep trace doesn't push
 * the conversation off-screen.
 */

/** Lines tools append to tell the *model* what to do next. */
const REMEDIATION = /^(please |try |use |re-save |hint:|suggestion:|did you mean)/i

/** `SchemaError(...)`, `ENOENT:`, `TypeError:` — a leading machine-readable type. */
const ERROR_TYPE = /^([A-Z][A-Za-z0-9_]*(?:Error|Exception)|E[A-Z]{3,})\b[:(]?/

const STACK_LINE = /^\s*(at\s+\S|\s{4,}\S)/

export function ToolErrorPanel(props: { error: string }) {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)
  const [showStack, setShowStack] = createSignal(false)

  const parsed = createMemo(() => {
    const raw = props.error.replace(/^Error:\s*/, "").trim()
    const lines = raw.split("\n")

    const stackAt = lines.findIndex((line) => STACK_LINE.test(line))
    const body = stackAt >= 0 ? lines.slice(0, stackAt) : lines
    const stack = stackAt >= 0 ? lines.slice(stackAt) : []

    const hints: string[] = []
    while (body.length > 1 && REMEDIATION.test(body[body.length - 1]!.trim())) {
      hints.unshift(body.pop()!.trim())
    }

    const message = body.join("\n").trim()
    const type = ERROR_TYPE.exec(message)?.[1]

    return { raw, type, message, hints, stack }
  })

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

      <Show when={parsed().message}>
        <div data-slot="tool-error-message">{parsed().message}</div>
      </Show>

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
