import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { BasicTool } from "./basic-tool"
import { ToolErrorPanel } from "./tool-error-panel"
import type { ToolInfo } from "./message-part"

export interface ToolErrorCardProps {
  /** Identity for the row, computed by the caller — passing it rather than
   *  importing `getToolInfo` here keeps this module free of a cycle back into
   *  `message-part`. */
  info: ToolInfo
  error: string
  title?: string
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  subtitle?: string
  href?: string
  onSubtitleClick?: (event: MouseEvent) => void
}

/**
 * A failed call is still a tool call, so it renders as the same row: same badge
 * icon, same title, same target. Only the tone changes, plus `failed` in the
 * result slot and the error in the expanded card.
 *
 * The previous design was a separate red-tinted card that dropped the tool's
 * icon and repurposed the subtitle to hold an error headline — which meant a
 * failed `read` never told you which file it was reading.
 */
export function ToolErrorCard(props: ToolErrorCardProps) {
  const i18n = useI18n()
  const [state, setState] = createStore({ copied: false })

  const info = () => props.info
  const cleaned = createMemo(() => props.error.replace(/^Error:\s*/, "").trim())

  const copy = async () => {
    const text = cleaned()
    if (!text) return
    await navigator.clipboard.writeText(text)
    setState("copied", true)
    setTimeout(() => setState("copied", false), 2000)
  }

  const copyLabel = () => (state.copied ? i18n.t("ui.message.copied") : i18n.t("ui.toolErrorCard.copyError"))

  return (
    <BasicTool
      icon={info().icon}
      status="error"
      defaultOpen={props.defaultOpen}
      open={props.open}
      onOpenChange={props.onOpenChange}
      allowOpenWhilePending
      trigger={{
        title: props.title ?? info().title,
        // An explicit subtitle (the subagent link) wins; otherwise show the same
        // target a successful row would have.
        subtitle: props.subtitle ?? info().subtitle,
        subtitleTruncate: props.subtitle ? undefined : info().subtitleTruncate,
        subtitleMono: props.subtitle ? undefined : info().subtitleMono,
        subtitleClass: props.href ? "clickable subagent-link" : undefined,
        result: i18n.t("ui.toolErrorCard.failed"),
        resultTone: "danger",
      }}
      onSubtitleClick={
        props.href
          ? () => {
              const event = new MouseEvent("click", { button: 0 })
              props.onSubtitleClick?.(event)
            }
          : undefined
      }
    >
      <ToolErrorPanel error={props.error} />
    </BasicTool>
  )
}
