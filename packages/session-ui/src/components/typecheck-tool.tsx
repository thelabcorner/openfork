import { createMemo, For, Show } from "solid-js"
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

function extractInt(text: string | undefined, name: string) {
  if (!text) return 0
  const match = new RegExp(`<${name}>(\\d+)<\\/${name}>`).exec(text)
  return match ? Number(match[1]) : 0
}

type Diagnostic = {
  file: string
  line: string
  column: string
  code: string
  severity: string
  category: string
  message: string
  suggestion: string
}

function extractDiagnostics(text: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const re = /<diagnostic([^>]*)>([\s\S]*?)<\/diagnostic>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const attrs: Record<string, string> = {}
    for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = attr[2]!
    const message = extractTag(match[2]!, "message")?.inner ?? ""
    const suggestion = extractTag(match[2]!, "suggestion")?.inner ?? ""
    out.push({
      file: unescapeXml(attrs.file ?? ""),
      line: attrs.line ?? "",
      column: attrs.column ?? "",
      code: attrs.code ?? "",
      severity: attrs.severity ?? "",
      category: attrs.category ?? "",
      message: unescapeXml(message),
      suggestion: unescapeXml(suggestion),
    })
  }
  return out
}

function groupByFile(diagnostics: Diagnostic[]) {
  const groups = new Map<string, Diagnostic[]>()
  for (const d of diagnostics) {
    const list = groups.get(d.file) ?? []
    list.push(d)
    groups.set(d.file, list)
  }
  return [...groups.entries()].map(([file, items]) => ({ file, items }))
}

function TriageStrip(props: { counts: Record<"P0" | "P1" | "P2" | "P3", number> }) {
  return (
    <div data-component="typecheck-triage">
      <For each={["P0", "P1", "P2", "P3"] as const}>
        {(tier) => (
          <Show when={props.counts[tier] > 0}>
            <span data-slot="typecheck-triage-badge" data-tier={tier}>
              {tier} · {props.counts[tier]}
            </span>
          </Show>
        )}
      </For>
    </div>
  )
}

function DiagnosticRow(props: { diagnostic: Diagnostic }) {
  return (
    <div data-slot="typecheck-diagnostic" data-severity={props.diagnostic.severity}>
      <div data-slot="typecheck-diagnostic-head">
        <span data-slot="typecheck-diagnostic-severity">{props.diagnostic.severity}</span>
        <span data-slot="typecheck-diagnostic-loc">
          {props.diagnostic.line}:{props.diagnostic.column}
        </span>
        <span data-slot="typecheck-diagnostic-code">{props.diagnostic.code}</span>
      </div>
      <div data-slot="typecheck-diagnostic-message">{props.diagnostic.message}</div>
      <Show when={props.diagnostic.suggestion}>
        <div data-slot="typecheck-diagnostic-suggestion">{props.diagnostic.suggestion}</div>
      </Show>
    </div>
  )
}

function FileGroup(props: { file: string; items: Diagnostic[] }) {
  return (
    <div data-slot="typecheck-file-group">
      <div data-slot="typecheck-file-header">
        <span data-slot="typecheck-file-path">{props.file}</span>
        <span data-slot="typecheck-file-count">{props.items.length}</span>
      </div>
      <For each={props.items}>{(d) => <DiagnosticRow diagnostic={d} />}</For>
    </div>
  )
}

export function TypecheckOutput(props: { output: string }) {
  const i18n = useI18n()
  const root = createMemo(() => extractTag(props.output, "typecheck"))
  const status = createMemo(() => root()?.attrs.status ?? "passed")
  const triageBlock = createMemo(() => extractTag(root()?.inner ?? "", "triage")?.inner)
  const counts = createMemo(() => ({
    P0: extractInt(triageBlock(), "p0"),
    P1: extractInt(triageBlock(), "p1"),
    P2: extractInt(triageBlock(), "p2"),
    P3: extractInt(triageBlock(), "p3"),
  }))
  const diagnosticsBlock = createMemo(() => extractTag(root()?.inner ?? "", "diagnostics")?.inner)
  const groups = createMemo(() => groupByFile(extractDiagnostics(diagnosticsBlock() ?? "")))

  return (
    <Show when={root()} fallback={<SmartToolOutput output={props.output} />}>
      <div data-component="typecheck-output">
        <div data-slot="typecheck-status-banner" data-status={status()}>
          <span data-slot="typecheck-status-label">
            {status() === "passed" ? i18n.t("ui.tool.typecheck.passed") : i18n.t("ui.tool.typecheck.failed")}
          </span>
          <Show when={groups().length}>
            <TriageStrip counts={counts()} />
          </Show>
        </div>
        <Show when={groups().length}>
          <div data-slot="typecheck-groups">
            <For each={groups()}>{(group) => <FileGroup file={group.file} items={group.items} />}</For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
