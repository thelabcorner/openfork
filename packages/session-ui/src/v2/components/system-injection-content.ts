/**
 * Structural parser for system/automation injection payloads.
 *
 * Injections are not prose. The producers emit a small, stable, XML-ish
 * envelope around otherwise-markdown bodies:
 *
 *   <task id="ses_1" state="completed">
 *   <summary>Background task completed: …</summary>
 *   <task_result>
 *   **Root cause:** …
 *   </task_result>
 *   </task>
 *
 * Rendering that verbatim shows the user the wire format. Rendering it as
 * markdown swallows the envelope (marked treats the tags as raw HTML) and the
 * structure is lost either way. So we parse the envelope here -- and ONLY the
 * envelope -- into nodes the card can draw as real UI, leaving every leaf body
 * untouched so the markdown renderer still sees exactly what the model saw.
 *
 * Deliberately conservative. A tag is only promoted to an element when it is
 * unambiguously block-shaped: the open tag owns its whole line and a matching
 * close tag owns a later line, or the element opens and closes within one line.
 * Generic prose (`Vec<T>`, `a < b`, an inline `<br>`) can never satisfy that, so
 * ordinary markdown injections such as plan reminders pass through as one text
 * node and render exactly as they always did.
 *
 * Pure and dependency-free: the timeline, the card and the tests all share it.
 */

export type InjectionAttribute = {
  readonly name: string
  readonly value: string
}

export type InjectionNode =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "element"
      readonly tag: string
      readonly attributes: readonly InjectionAttribute[]
      readonly children: readonly InjectionNode[]
      /** Verbatim inner source, for copy and the raw view. */
      readonly text: string
    }

const OPEN_LINE = /^[ \t]*<([A-Za-z][A-Za-z0-9._-]*)((?:\s[^<>]*?)?)\/?>[ \t]*$/
const CLOSE_LINE = /^[ \t]*<\/([A-Za-z][A-Za-z0-9._-]*)>[ \t]*$/
const INLINE_ELEMENT = /^[ \t]*<([A-Za-z][A-Za-z0-9._-]*)((?:\s[^<>]*?)?)>([\s\S]*)<\/\1>[ \t]*$/
const SELF_CLOSING = /\/>[ \t]*$/
const FENCE = /^[ \t]*(?:```|~~~)/
const ATTRIBUTE = /([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g

/**
 * Producers XML-escape values they place on a single line (attributes,
 * `<summary>`, `<error>`); multi-line bodies are passed through raw, so those
 * are never decoded -- an `&amp;` in tool output is literal tool output.
 */
function decodeEntities(value: string) {
  if (!value.includes("&")) return value
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function parseAttributes(source: string): InjectionAttribute[] {
  const trimmed = source.trim().replace(/\/$/, "")
  if (!trimmed) return []
  const result: InjectionAttribute[] = []
  ATTRIBUTE.lastIndex = 0
  for (let match = ATTRIBUTE.exec(trimmed); match; match = ATTRIBUTE.exec(trimmed)) {
    const name = match[1]
    if (!name) continue
    const raw = match[2] ?? match[3] ?? match[4] ?? ""
    result.push({ name, value: decodeEntities(raw) })
  }
  return result
}

/** Index of the line closing `tag`, honouring same-tag nesting and code fences. */
function closingLine(lines: readonly string[], tag: string, from: number, to: number) {
  let depth = 0
  let fenced = false
  for (let index = from; index < to; index++) {
    const line = lines[index] ?? ""
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const close = CLOSE_LINE.exec(line)
    if (close && close[1] === tag) {
      if (depth === 0) return index
      depth--
      continue
    }
    const open = OPEN_LINE.exec(line)
    if (open && open[1] === tag && !SELF_CLOSING.test(line)) depth++
  }
  return -1
}

function textNode(lines: readonly string[], from: number, to: number, into: InjectionNode[]) {
  if (to <= from) return
  const text = lines.slice(from, to).join("\n")
  if (!/\S/.test(text)) return
  into.push({ kind: "text", text: trimBlankEdges(text) })
}

function trimBlankEdges(text: string) {
  return text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "")
}

function parseRange(lines: readonly string[], from: number, to: number, depth: number): InjectionNode[] {
  const nodes: InjectionNode[] = []
  let pending = from
  let fenced = false

  for (let index = from; index < to; index++) {
    const line = lines[index] ?? ""

    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue

    // `<tag …>body</tag>` complete on one line: the body is single-line and
    // therefore producer-escaped, so it is decoded back to its real text.
    const inline = INLINE_ELEMENT.exec(line)
    if (inline?.[1]) {
      const inner = decodeEntities(inline[3] ?? "")
      textNode(lines, pending, index, nodes)
      nodes.push({
        kind: "element",
        tag: inline[1].toLowerCase(),
        attributes: parseAttributes(inline[2] ?? ""),
        children: /\S/.test(inner) ? [{ kind: "text", text: inner.trim() }] : [],
        text: inner.trim(),
      })
      pending = index + 1
      continue
    }

    const open = OPEN_LINE.exec(line)
    if (!open?.[1]) continue

    const tag = open[1].toLowerCase()
    if (SELF_CLOSING.test(line)) {
      textNode(lines, pending, index, nodes)
      nodes.push({ kind: "element", tag, attributes: parseAttributes(open[2] ?? ""), children: [], text: "" })
      pending = index + 1
      continue
    }

    const close = closingLine(lines, tag, index + 1, to)
    // No matching close line: not an envelope, just text that happens to look
    // like a tag. Leave it in the text run.
    if (close < 0) continue

    textNode(lines, pending, index, nodes)
    const inner = trimBlankEdges(lines.slice(index + 1, close).join("\n"))
    nodes.push({
      kind: "element",
      tag,
      attributes: parseAttributes(open[2] ?? ""),
      // Depth guard: pathological nesting from tool output must not recurse
      // without bound. Past the limit the body stays a single text leaf.
      children: depth >= 6 ? (/\S/.test(inner) ? [{ kind: "text", text: inner }] : []) : parseRange(lines, index + 1, close, depth + 1),
      text: inner,
    })
    pending = close + 1
    index = close
  }

  textNode(lines, pending, to, nodes)
  return nodes
}

/** Parse one injection segment into its envelope structure. */
export function parseInjectionContent(text: string): InjectionNode[] {
  if (!text) return []
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const nodes = parseRange(lines, 0, lines.length, 0)
  if (nodes.length === 0 && /\S/.test(text)) return [{ kind: "text", text: trimBlankEdges(text) }]
  return nodes
}

/** True when parsing found real structure worth drawing as UI. */
export function hasInjectionStructure(nodes: readonly InjectionNode[]) {
  return nodes.some((node) => node.kind === "element")
}

const SUMMARY_TAGS = new Set(["summary", "title", "description", "note", "message"])

/**
 * Human-readable one-line preview.
 *
 * The collapsed row previously showed the first non-blank line, which for every
 * enveloped injection is the machine open tag (`<task id="ses_…" state="…">`).
 * Prefer a declared summary, then the first real prose anywhere in the tree.
 */
export function injectionContentPreview(nodes: readonly InjectionNode[]): string {
  const summary = findSummary(nodes)
  if (summary) return summary
  return findProse(nodes) ?? ""
}

function findSummary(nodes: readonly InjectionNode[]): string | undefined {
  for (const node of nodes) {
    if (node.kind !== "element") continue
    if (SUMMARY_TAGS.has(node.tag)) {
      const line = firstLine(node.text)
      if (line) return line
    }
    const nested = findSummary(node.children)
    if (nested) return nested
  }
  return undefined
}

function findProse(nodes: readonly InjectionNode[]): string | undefined {
  for (const node of nodes) {
    if (node.kind === "text") {
      const line = firstLine(node.text)
      if (line) return line
      continue
    }
    const nested = findProse(node.children)
    if (nested) return nested
  }
  return undefined
}

function firstLine(text: string) {
  for (const line of text.split("\n")) {
    const value = stripMarkdownNoise(line.trim())
    if (value) return value
  }
  return ""
}

/** Preview text is a single unstyled line; markdown syntax there is noise. */
function stripMarkdownNoise(line: string) {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim()
}

export type InjectionTone = "neutral" | "info" | "success" | "warning" | "danger"

/**
 * Semantic family of an injection, from its producer rather than its payload.
 * Drives the card's glyph only; lives here so non-JSX modules (provenance
 * presentation, tests) can name it without importing the component.
 */
export type SystemInjectionKind =
  | "system"
  | "skill"
  | "task"
  | "shell"
  | "goal"
  | "plan"
  | "schedule"
  | "recovery"
  | "compaction"
  | "swarm"
  | "oxp"
  | "audit"
  | "title"
  | "automation"

export type InjectionTagPresentation = {
  readonly label: string
  /**
   * `frame` wraps children in a titled panel, `lead` is the eyebrow sentence
   * shown above the body, `section` is a labelled body block, and `field` is a
   * short scalar rendered inline as a key/value chip.
   */
  readonly role: "frame" | "lead" | "section" | "field"
  readonly tone?: InjectionTone
  readonly body?: "markdown" | "pre"
}

const TAG_PRESENTATION: Record<string, InjectionTagPresentation> = {
  task: { label: "Task", role: "frame" },
  task_result: { label: "Result", role: "section", body: "markdown" },
  task_error: { label: "Error", role: "section", tone: "danger", body: "pre" },
  background_shell: { label: "Background shell", role: "frame" },
  shell_metadata: { label: "Shell", role: "frame" },
  "system-reminder": { label: "System reminder", role: "frame", tone: "info" },
  system_reminder: { label: "System reminder", role: "frame", tone: "info" },
  summary: { label: "Summary", role: "lead" },
  title: { label: "Title", role: "lead" },
  description: { label: "Description", role: "lead" },
  message: { label: "Message", role: "section", body: "markdown" },
  command: { label: "Command", role: "section", body: "pre" },
  preview: { label: "Output", role: "section", body: "pre" },
  output: { label: "Output", role: "section", body: "pre" },
  content: { label: "Content", role: "section", body: "markdown" },
  entries: { label: "Entries", role: "section", body: "pre" },
  entry: { label: "Entry", role: "section", body: "pre" },
  error: { label: "Error", role: "section", tone: "danger", body: "pre" },
  warning: { label: "Warning", role: "section", tone: "warning", body: "markdown" },
  note: { label: "Note", role: "section", tone: "info", body: "markdown" },
  hint: { label: "Hint", role: "section", tone: "info", body: "markdown" },
  suggestion: { label: "Suggestion", role: "section", tone: "info", body: "markdown" },
  next: { label: "Next", role: "section", body: "markdown" },
  triage: { label: "Triage", role: "section", body: "markdown" },
  event_data: { label: "Event data", role: "section", body: "pre" },
  skill_files: { label: "Skill files", role: "section", body: "pre" },
  path: { label: "Path", role: "field" },
  file: { label: "File", role: "field" },
  status: { label: "Status", role: "field" },
  state: { label: "State", role: "field" },
  source: { label: "Source", role: "field" },
  name: { label: "Name", role: "field" },
  id: { label: "ID", role: "field" },
  type: { label: "Type", role: "field" },
}

/** Presentation for an envelope tag; unknown tags degrade to a labelled section. */
export function injectionTagPresentation(tag: string): InjectionTagPresentation {
  return TAG_PRESENTATION[tag] ?? { label: humanizeTag(tag), role: "section", body: "markdown" }
}

export function humanizeTag(tag: string) {
  const words = tag.replace(/[_.-]+/g, " ").trim()
  if (!words) return tag
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const STATE_TONES: Record<string, InjectionTone> = {
  completed: "success",
  complete: "success",
  success: "success",
  succeeded: "success",
  ok: "success",
  passed: "success",
  done: "success",
  running: "info",
  pending: "info",
  queued: "info",
  active: "info",
  started: "info",
  cancelled: "warning",
  canceled: "warning",
  skipped: "warning",
  timeout: "warning",
  partial: "warning",
  error: "danger",
  failed: "danger",
  failure: "danger",
  denied: "danger",
}

const STATE_ATTRIBUTES = new Set(["state", "status", "result", "outcome"])

/** Status-shaped attributes become tone-carrying pills instead of key/value chips. */
export function injectionAttributeTone(attribute: InjectionAttribute): InjectionTone | undefined {
  if (!STATE_ATTRIBUTES.has(attribute.name.toLowerCase())) return undefined
  return STATE_TONES[attribute.value.trim().toLowerCase()] ?? "neutral"
}

/** Tone for the whole segment, so the card edge can carry the outcome. */
export function injectionContentTone(nodes: readonly InjectionNode[]): InjectionTone | undefined {
  let tone: InjectionTone | undefined
  const rank: Record<InjectionTone, number> = { neutral: 0, info: 1, success: 2, warning: 3, danger: 4 }
  const visit = (list: readonly InjectionNode[]) => {
    for (const node of list) {
      if (node.kind !== "element") continue
      const candidates: (InjectionTone | undefined)[] = [
        injectionTagPresentation(node.tag).tone,
        ...node.attributes.map(injectionAttributeTone),
      ]
      for (const candidate of candidates) {
        if (!candidate || candidate === "neutral") continue
        if (!tone || rank[candidate] > rank[tone]) tone = candidate
      }
      visit(node.children)
    }
  }
  visit(nodes)
  return tone
}
