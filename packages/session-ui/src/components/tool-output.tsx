import { Show, createMemo, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { checksum } from "@opencode-ai/core/util/encode"
import { Markdown } from "./markdown"

export function CodeView(props: { contents: string; filename: string }) {
  const fileComponent = useFileComponent()
  return (
    <div data-component="tool-output-json">
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: props.filename,
          contents: props.contents,
          cacheKey: checksum(props.contents),
        }}
        overflow="scroll"
      />
    </div>
  )
}

export function ToolSection(props: { label: string; children: JSX.Element }) {
  return (
    <div data-component="tool-section">
      <div data-slot="tool-section-label">{props.label}</div>
      {props.children}
    </div>
  )
}

function tryPrettyJson(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== "object" || parsed === null) return undefined
    return JSON.stringify(parsed, null, 2)
  } catch {
    return undefined
  }
}

/**
 * Renders tool output with content-aware treatment: JSON gets a
 * syntax-highlighted code viewer (same one used for file diffs), anything
 * else falls back to prose/markdown rendering.
 */
export function SmartToolOutput(props: { output?: string; filename?: string }) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const pretty = createMemo(() => (props.output ? tryPrettyJson(props.output) : undefined))

  return (
    <Show when={props.output}>
      <Show
        when={pretty()}
        fallback={
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        }
      >
        {(json) => (
          <div data-component="tool-output-json">
            <Dynamic
              component={fileComponent}
              mode="text"
              file={{
                name: props.filename ?? "output.json",
                contents: json(),
                cacheKey: checksum(json()),
              }}
              overflow="scroll"
            />
          </div>
        )}
      </Show>
    </Show>
  )
}
