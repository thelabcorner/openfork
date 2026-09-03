import { createMemo, createSignal, For, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { SmartToolOutput } from "./tool-output"
import { ToolBadge, ToolBlock, ToolBoundedList, ToolEmpty, ToolPath, ToolRow, ToolStats } from "./tool-parts"

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

/**
 * Typecheck output.
 *
 * The previous rendering printed every diagnostic's full message *and* its
 * suggestion as stacked blocks, so an 80-error run buried the conversation. The
 * suggestion is near-identical boilerplate across diagnostics, so it is only
 * shown when a row is opened.
 *
 * Shape: stats → files (collapsed, bounded) → diagnostics (one line each,
 * click to expand).
 */

const TIERS = ["P0", "P1", "P2", "P3"] as const

function tierTone(tier: (typeof TIERS)[number]) {
  if (tier === "P0") return "danger" as const
  if (tier === "P1") return "warning" as const
  return "neutral" as const
}

function DiagnosticRow(props: { diagnostic: Diagnostic }) {
  const [open, setOpen] = createSignal(false)
  const d = () => props.diagnostic
  return (
    <div data-component="typecheck-diagnostic" data-open={open() ? "true" : undefined}>
      <ToolRow
        onClick={() => setOpen(!open())}
        lead={<span data-slot="typecheck-loc">{`${d().line}:${d().column}`}</span>}
        primary={d().message}
        mono={false}
        trailing={<span data-slot="typecheck-code">{d().code}</span>}
      />
      <Show when={open()}>
        <div data-slot="typecheck-detail">
          <div data-slot="typecheck-detail-message">{d().message}</div>
          <Show when={d().suggestion}>
            <div data-slot="typecheck-detail-suggestion">{d().suggestion}</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function FileGroup(props: { file: string; items: Diagnostic[]; defaultOpen?: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  return (
    <div data-component="typecheck-file" data-open={open() ? "true" : undefined}>
      <ToolRow
        onClick={() => setOpen(!open())}
        lead={<span data-slot="typecheck-file-caret">{open() ? "▾" : "▸"}</span>}
        primary={<ToolPath path={props.file} />}
        truncate="start"
        trailing={String(props.items.length)}
      />
      <Show when={open()}>
        <div data-slot="typecheck-file-body">
          <ToolBoundedList items={props.items} limit={10} scroll>
            {(item) => <DiagnosticRow diagnostic={item} />}
          </ToolBoundedList>
        </div>
      </Show>
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
  const diagnostics = createMemo(() => extractDiagnostics(diagnosticsBlock() ?? ""))
  const groups = createMemo(() => groupByFile(diagnostics()))

  const stats = createMemo(() => {
    const items: { label: string; value: string; tone?: "danger" | "success" | "neutral" }[] = [
      {
        label: i18n.t("ui.tool.typecheck.stat.errors"),
        value: String(diagnostics().length),
        tone: diagnostics().length ? "danger" : "success",
      },
    ]
    if (groups().length) items.push({ label: i18n.t("ui.tool.typecheck.stat.files"), value: String(groups().length) })
    for (const tier of TIERS) {
      if (counts()[tier] > 0) items.push({ label: tier, value: String(counts()[tier]) })
    }
    return items
  })

  return (
    <Show when={root()} fallback={<SmartToolOutput output={props.output} />}>
      <Show
        when={diagnostics().length > 0}
        fallback={
          <ToolEmpty>
            <ToolBadge tone="success">{i18n.t("ui.tool.typecheck.passed")}</ToolBadge>
          </ToolEmpty>
        }
      >
        <ToolStats items={stats()} />
        <ToolBlock>
          <ToolBoundedList items={groups()} limit={6}>
            {(group, index) => (
              <FileGroup file={group.file} items={group.items} defaultOpen={index === 0 && groups().length === 1} />
            )}
          </ToolBoundedList>
        </ToolBlock>
      </Show>
    </Show>
  )
}
