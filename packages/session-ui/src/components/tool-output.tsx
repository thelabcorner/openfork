import { Match, Show, Switch, createMemo, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { checksum } from "@opencode-ai/core/util/encode"
import { Markdown } from "./markdown"
import { ToolText, looksLikeMarkdown } from "./tool-text"

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
 * Renders tool output with content-aware treatment.
 *
 * Three paths, in order of how much is known about the payload:
 *
 *   JSON        → the syntax-highlighted code viewer used for file previews
 *   markdown    → the markdown renderer, but only on strong evidence
 *   everything else → verbatim text (see tool-text.tsx)
 *
 * The middle case used to be the *only* case, which meant every tool that had
 * not been given a renderer had its output silently mangled: XML wrappers
 * stripped, indentation collapsed, `*` eaten. Plain text through the markdown
 * renderer loses information; markdown through the text renderer merely looks
 * plainer, so the ambiguous case now falls the safe way.
 */
export function SmartToolOutput(props: { output?: string; filename?: string }) {
  const fileComponent = useFileComponent()
  const pretty = createMemo(() => (props.output ? tryPrettyJson(props.output) : undefined))
  const markdown = createMemo(() => !!props.output && !pretty() && looksLikeMarkdown(props.output))

  return (
    <Show when={props.output}>
      <Switch fallback={<ToolText output={props.output!} />}>
        <Match when={pretty()}>
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
        </Match>
        <Match when={markdown()}>
          <div data-component="tool-output" data-scrollable tabIndex={0} role="region">
            <Markdown text={props.output!} />
          </div>
        </Match>
      </Switch>
    </Show>
  )
}
