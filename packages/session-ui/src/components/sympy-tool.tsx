import { createMemo, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { SmartToolOutput } from "./tool-output"

function unescapeXml(text: string) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

function extractTag(text: string, name: string) {
  const match = new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`).exec(text)
  if (!match) return undefined
  const attrs: Record<string, string> = {}
  for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = attr[2]!
  return { attrs, inner: match[2]! }
}

export function SympyOutput(props: { output: string }) {
  const i18n = useI18n()
  const root = createMemo(() => extractTag(props.output, "sympy"))
  const status = createMemo(() => root()?.attrs.status)
  const call = createMemo(() => extractTag(root()?.inner ?? "", "call")?.inner)
  const result = createMemo(() => extractTag(root()?.inner ?? "", "result")?.inner)
  const error = createMemo(() => extractTag(root()?.inner ?? "", "error")?.inner)
  const suggestion = createMemo(() => extractTag(root()?.inner ?? "", "suggestion")?.inner)
  const message = createMemo(() => extractTag(root()?.inner ?? "", "message")?.inner)
  const diagnostics = createMemo(() => extractTag(root()?.inner ?? "", "diagnostics")?.inner)

  return (
    <Show when={root()} fallback={<SmartToolOutput output={props.output} />}>
      <div data-component="sympy-output" data-status={status()}>
        <Show when={call()}>
          <div data-slot="sympy-call">{unescapeXml(call()!)}</div>
        </Show>
        <Show when={status() === "ok" && result()}>
          <div data-slot="sympy-result">{unescapeXml(result()!)}</div>
        </Show>
        <Show when={status() === "error" && error()}>
          <div data-slot="sympy-error">{unescapeXml(error()!)}</div>
        </Show>
        <Show when={suggestion()}>
          <div data-slot="sympy-suggestion">{unescapeXml(suggestion()!)}</div>
        </Show>
        <Show when={message() && status() !== "ok" && status() !== "error"}>
          <div data-slot="sympy-message">{unescapeXml(message()!)}</div>
        </Show>
        <Show when={status() === "timed-out"}>
          <div data-slot="sympy-message">{i18n.t("ui.tool.sympy.timedOut")}</div>
        </Show>
        <Show when={diagnostics()}>
          <pre data-slot="sympy-diagnostics">{unescapeXml(diagnostics()!)}</pre>
        </Show>
      </div>
    </Show>
  )
}
