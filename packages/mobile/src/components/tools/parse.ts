/**
 * Pure parsers for built-in tool output.
 *
 * The desktop client (packages/session-ui) has equivalents; mobile keeps its
 * own copies for the same reason it already duplicates `parseGrepOutput` — the
 * two clients ship independently and mobile must not pull the desktop bundle's
 * dependency graph (i18n context, the file/diff viewer, the markdown worker).
 *
 * Everything here is string-in / data-out so it can be tested without a DOM.
 */

/* ── XML-ish helpers ──────────────────────────────────────────────────────
   Most built-in tools wrap their output in a light XML envelope aimed at the
   model. It is not real XML — no namespaces, no CDATA — so a regex reader is
   both sufficient and much cheaper than DOMParser on a phone. */

export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

function readAttrs(source: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const attr of (source ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = unescapeXml(attr[2]!)
  return attrs
}

export type TagBlock = { attrs: Record<string, string>; inner: string }

export function tagBlock(source: string, name: string): TagBlock | undefined {
  const match = new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`).exec(source)
  return match ? { attrs: readAttrs(match[1]), inner: match[2]! } : undefined
}

export function tagBlocks(source: string, name: string): TagBlock[] {
  const out: TagBlock[] = []
  for (const match of source.matchAll(new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`, "g"))) {
    out.push({ attrs: readAttrs(match[1]), inner: match[2]! })
  }
  return out
}

export function tagText(source: string, name: string): string | undefined {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(source)
  return match ? unescapeXml(match[1]!.trim()) : undefined
}

export function tagTexts(source: string, name: string): string[] {
  return [...source.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "g"))].map((m) => unescapeXml(m[1]!))
}

/** `<name a="1" />` — the first one. */
export function selfClosing(source: string, name: string): Record<string, string> | undefined {
  const match = new RegExp(`<${name}([^>]*)\\/>`).exec(source)
  return match ? readAttrs(match[1]) : undefined
}

/** `<name a="1" />` — all of them. */
export function selfClosingAll(source: string, name: string): Record<string, string>[] {
  return [...source.matchAll(new RegExp(`<${name}\\s([^>]*?)\\/>`, "g"))].map((m) => readAttrs(m[1]))
}

export function bytes(value: number): string {
  if (!Number.isFinite(value)) return ""
  const units = ["B", "KB", "MB", "GB"]
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/** Drops the trailing agent-facing hint paragraphs from a tool's output. */
export function withoutHints(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^(Use |Re-save |Try:|Stored\.|Superseded )/.test(line.trim()))
    .join("\n")
    .trim()
}

/* Carriage-return / erase-line handling lives in ./ansi (parseShellOutput),
   which resolves the rewrite *and* keeps the SGR state. Callers that only want
   the text use `parseShellOutput(x).text`; there is deliberately not a second
   implementation here to drift out of sync with it. */

/* ── Failed tool calls ─────────────────────────────────────────────────────
   Errors are not one blob. They are prose, sometimes interleaved with verbatim
   source (patch/edit quote the lines they could not find, with a `NNNN |`
   gutter), sometimes followed by remediation aimed at the model, and only
   occasionally by a real stack trace.

   Getting the split wrong is worse than not splitting: a heuristic that treats
   any four-space indent as a stack frame collapses a patch failure's entire
   body — the part that says which lines did not match.
   ───────────────────────────────────────────────────────────────────────── */

const STACK_FRAME = /^\s*at\s+\S/
const STACK_LOCATION = /^\s+\(?(?:[A-Za-z]:)?[^\s:()]+:\d+(?::\d+)?\)?$/
const STACK_MODULE = /^\s+(?:node:|file:\/\/|webpack:|\.\/|\/)\S*:\d+/

const isStackLine = (line: string) => STACK_FRAME.test(line) || STACK_LOCATION.test(line) || STACK_MODULE.test(line)

const REMEDIATION = /^(please |try |use |re-save |hint:|suggestion:|did you mean)/i
const ERROR_TYPE = /^([A-Z][A-Za-z0-9_]*(?:Error|Exception)|E[A-Z]{3,})\b[:(]?/
const GUTTER = /^(\s*)(>?)\s*(\d+)\s*[|│]\s?(.*)$/
const INDENTED_CODE = /^ {4,}\S/

export type ErrorCodeLine = { marker: boolean; number?: string; text: string }
export type ErrorBlock = { kind: "text"; text: string } | { kind: "code"; lines: ErrorCodeLine[] }

export type ParsedToolError = {
  raw: string
  type?: string
  blocks: ErrorBlock[]
  hints: string[]
  stack: string[]
}

/**
 * Only treat a tail as a stack when it really is one: walk backwards while the
 * lines look like frames, and require enough of them that collapsing is a
 * favour rather than a hiding place.
 */
function splitStack(lines: string[]): { body: string[]; stack: string[] } {
  let index = lines.length
  let frames = 0
  while (index > 0) {
    const line = lines[index - 1]!
    if (line.trim() === "") {
      index--
      continue
    }
    if (!isStackLine(line)) break
    frames++
    index--
  }
  if (frames < 3) return { body: lines, stack: [] }
  while (index < lines.length && lines[index]!.trim() === "") index++
  return { body: lines.slice(0, index), stack: lines.slice(index) }
}

function errorBlocks(lines: string[]): ErrorBlock[] {
  const blocks: ErrorBlock[] = []
  let text: string[] = []
  let code: ErrorCodeLine[] = []

  const flushText = () => {
    const joined = text.join("\n").replace(/^\n+|\n+$/g, "")
    if (joined.trim()) blocks.push({ kind: "text", text: joined })
    text = []
  }
  const flushCode = () => {
    while (code.length && !code[code.length - 1]!.text.trim() && !code[code.length - 1]!.number) code.pop()
    if (code.length) blocks.push({ kind: "code", lines: code })
    code = []
  }

  for (const line of lines) {
    const gutter = GUTTER.exec(line)
    if (gutter) {
      flushText()
      code.push({ marker: gutter[2] === ">", number: gutter[3], text: gutter[4] ?? "" })
      continue
    }
    if (INDENTED_CODE.test(line)) {
      flushText()
      code.push({ marker: false, text: line.replace(/^ {2}/, "") })
      continue
    }
    // A blank line inside a quoted excerpt belongs to the excerpt.
    if (code.length && line.trim() === "") {
      code.push({ marker: false, text: "" })
      continue
    }
    flushCode()
    text.push(line)
  }

  flushText()
  flushCode()
  return blocks
}

export function parseToolError(error: string): ParsedToolError {
  const raw = error.replace(/^Error:\s*/, "").trimEnd()
  const { body, stack } = splitStack(raw.split("\n"))

  const hints: string[] = []
  while (body.length > 1 && REMEDIATION.test(body[body.length - 1]!.trim())) {
    hints.unshift(body.pop()!.trim())
  }

  const blocks = errorBlocks(body)
  const first = blocks.find((block) => block.kind === "text")
  const type = first?.kind === "text" ? ERROR_TYPE.exec(first.text)?.[1] : undefined

  return { raw, type, blocks, hints, stack }
}

/* ── Unrecognised output ───────────────────────────────────────────────────
   The last-resort renderer. Tool output is text: it must not be reflowed as
   prose or fed to a markdown renderer, which eats indentation and `<tag>`
   envelopes. But most tools emit one of three recognisable shapes, and
   spotting them is nearly free.
   ───────────────────────────────────────────────────────────────────────── */

const FIELD = /^([A-Za-z][A-Za-z0-9 _/-]{0,23}):[ \t]+(\S.*)$/
const BULLET = /^[ \t]*[-*•][ \t]+(\S.*)$/
const WRAPPER = /^<([a-z_][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>\n([\s\S]*)\n<\/\1>$/

export type ToolTextBlock =
  | { kind: "fields"; items: { key: string; value: string }[] }
  | { kind: "list"; items: string[] }
  | { kind: "text"; text: string }

/**
 * Strong markdown signals only. A stray `*` or a single `#` is far more likely
 * to be shell output than a document, and guessing wrong destroys the content.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (/^```/m.test(text)) return true
  if ((text.match(/^#{1,6} \S/gm)?.length ?? 0) >= 2) return true
  if (/^\|.*\|[ \t]*$/m.test(text) && /^\|[\s:|-]+\|[ \t]*$/m.test(text)) return true
  const inline = (text.match(/\*\*[^*\n]+\*\*/g)?.length ?? 0) + (text.match(/\[[^\]\n]+\]\([^)\n]+\)/g)?.length ?? 0)
  return inline >= 3
}

export function parseToolText(output: string): {
  tag?: string
  attrs: { key: string; value: string }[]
  blocks: ToolTextBlock[]
} {
  let body = output.trim()
  const attrs: { key: string; value: string }[] = []

  const wrapper = WRAPPER.exec(body)
  if (wrapper) {
    for (const [key, value] of Object.entries(readAttrs(wrapper[2]))) attrs.push({ key, value })
    body = wrapper[3]!
  }

  const blocks: ToolTextBlock[] = []
  let text: string[] = []
  let fields: { key: string; value: string }[] = []
  let list: string[] = []

  const flushText = () => {
    const joined = text.join("\n").replace(/^\n+|\n+$/g, "")
    if (joined.trim()) blocks.push({ kind: "text", text: joined })
    text = []
  }
  // A lone `Key: value` line is a sentence far more often than it is a table,
  // so a run has to be worth the grid before it becomes one.
  const flushFields = () => {
    if (fields.length >= 2) {
      flushText()
      blocks.push({ kind: "fields", items: fields })
    } else {
      for (const field of fields) text.push(`${field.key}: ${field.value}`)
    }
    fields = []
  }
  const flushList = () => {
    if (list.length >= 2) {
      flushText()
      blocks.push({ kind: "list", items: list })
    } else {
      for (const item of list) text.push(`- ${item}`)
    }
    list = []
  }

  for (const line of body.split("\n")) {
    const field = FIELD.exec(line)
    if (field) {
      flushList()
      fields.push({ key: field[1]!, value: field[2]! })
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      flushFields()
      list.push(bullet[1]!)
      continue
    }
    flushFields()
    flushList()
    text.push(line)
  }
  flushFields()
  flushList()
  flushText()

  return { tag: wrapper?.[1], attrs, blocks }
}

/* ── Skill ─────────────────────────────────────────────────────────────────
   Three shapes: loaded `<skill_content>` blocks, a `<skills>` roster, and the
   prose misses ("not found", "no name provided") that used to fall through to
   an unstyled dump of instructions written for the model.
   ───────────────────────────────────────────────────────────────────────── */

export type SkillListItem = { name: string; description: string; score?: string }

export type ParsedSkillContent = { name: string; body: string; baseDir?: string; files: string[] }

function relativeToBase(file: string, base?: string) {
  if (!base) return file
  const normalized = file.replace(/\\/g, "/")
  const normalizedBase = base.replace(/\\/g, "/").replace(/\/$/, "")
  return normalized.startsWith(normalizedBase + "/") ? normalized.slice(normalizedBase.length + 1) : normalized
}

export function skillFileLabel(file: string, base?: string): string {
  return relativeToBase(file, base)
}

export function parseSkillContents(output: string): ParsedSkillContent[] {
  return tagBlocks(output, "skill_content").map((raw) => {
    const filesBlock = tagBlock(raw.inner, "skill_files")
    const files = filesBlock ? tagTexts(filesBlock.inner, "file").map((f) => f.trim()) : []
    const baseDir = /Base directory for this skill:\s*(.+)/.exec(raw.inner)?.[1]?.trim()
    const cut = raw.inner.search(/\n+Base directory for this skill:/)
    const body = (cut >= 0 ? raw.inner.slice(0, cut) : raw.inner).replace(/^#\s*Skill:\s*.+\n+/, "").trim()
    return { name: raw.attrs.name ?? "skill", body, baseDir, files }
  })
}

export function parseSkillList(output: string):
  | { mode?: string; count?: string; items: SkillListItem[] }
  | undefined {
  const tag = tagBlock(output, "skills")
  if (tag) {
    const items: SkillListItem[] = []
    for (const line of tag.inner.split("\n")) {
      const match = /^\s*-\s*([^:]+):\s*(.*)$/.exec(line)
      if (!match) continue
      items.push({ name: match[1]!.trim(), description: match[2]!.trim() })
    }
    return { mode: tag.attrs.mode, count: tag.attrs.count, items }
  }

  const scored: SkillListItem[] = []
  for (const line of output.split("\n")) {
    const match = /^\s*\d+\.\s*\*\*(.+?)\*\*\s*(?:\(score:\s*([\d.]+)\))?\s*(?:[—-]\s*(.*))?$/.exec(line)
    if (!match) continue
    scored.push({
      name: match[1]!.trim(),
      score: match[2],
      description: (match[3] ?? "").trim().replace(/^\((.*)\)$/, "$1"),
    })
  }
  return scored.length ? { mode: "search", count: String(scored.length), items: scored } : undefined
}

const SKILL_HINT = /^(Use |Tip: |Pass |Relative paths )/
const SKILL_ROSTER = /^Available(\s+skills)?\b[^:]*:\s*$/i
const SKILL_ROSTER_INLINE = /^Available(\s+skills)?\b[^:]*:\s*(\S.*)$/i

export function parseSkillNotice(
  output: string,
): { message: string; items: SkillListItem[]; hints: string[] } | undefined {
  const message: string[] = []
  const hints: string[] = []
  const items: SkillListItem[] = []
  let inRoster = false

  for (const raw of output.split("\n")) {
    const line = raw.trim()
    if (SKILL_ROSTER.test(line)) {
      inRoster = true
      continue
    }
    const inline = SKILL_ROSTER_INLINE.exec(line)
    if (inline) {
      for (const name of inline[2]!.split(",")) {
        const trimmed = name.trim()
        if (trimmed && trimmed !== "(none)") items.push({ name: trimmed, description: "" })
      }
      continue
    }
    if (SKILL_HINT.test(line)) {
      hints.push(line)
      inRoster = false
      continue
    }
    const entry = /^-\s*([^:]+):\s*(.*)$/.exec(line)
    if (entry) {
      items.push({ name: entry[1]!.trim(), description: entry[2]!.trim() })
      continue
    }
    if (!line) {
      inRoster = false
      continue
    }
    if (line === "(none)") continue
    if (inRoster) continue
    message.push(line)
  }

  if (!message.length && !items.length) return undefined

  // The roster can arrive twice — inline in the error message and again under
  // the heading. Keep the described copy.
  const unique = new Map<string, SkillListItem>()
  for (const item of items) {
    const existing = unique.get(item.name)
    if (!existing || (!existing.description && item.description)) unique.set(item.name, item)
  }

  return { message: message.join(" "), items: [...unique.values()], hints }
}

/* ── Typecheck ───────────────────────────────────────────────────────────── */

export type Diagnostic = {
  file: string
  line: string
  column: string
  code: string
  severity: string
  message: string
  suggestion: string
}

export type ParsedTypecheck = {
  status: string
  diagnostics: Diagnostic[]
  groups: { file: string; items: Diagnostic[] }[]
  tiers: { tier: string; count: number }[]
}

function tierCount(source: string | undefined, name: string) {
  if (!source) return 0
  const match = new RegExp(`<${name}>(\\d+)<\\/${name}>`).exec(source)
  return match ? Number(match[1]) : 0
}

export function parseTypecheck(output: string): ParsedTypecheck | undefined {
  const root = tagBlock(output, "typecheck")
  if (!root) return undefined

  const diagnostics: Diagnostic[] = []
  const body = tagBlock(root.inner, "diagnostics")?.inner ?? ""
  for (const match of body.matchAll(/<diagnostic([^>]*)>([\s\S]*?)<\/diagnostic>/g)) {
    const attrs = readAttrs(match[1])
    diagnostics.push({
      file: attrs.file ?? "",
      line: attrs.line ?? "",
      column: attrs.column ?? "",
      code: attrs.code ?? "",
      severity: attrs.severity ?? "",
      message: tagText(match[2]!, "message") ?? "",
      suggestion: tagText(match[2]!, "suggestion") ?? "",
    })
  }

  const byFile = new Map<string, Diagnostic[]>()
  for (const d of diagnostics) {
    const list = byFile.get(d.file) ?? []
    list.push(d)
    byFile.set(d.file, list)
  }

  const triage = tagBlock(root.inner, "triage")?.inner
  const tiers = (["P0", "P1", "P2", "P3"] as const)
    .map((tier) => ({ tier, count: tierCount(triage, tier.toLowerCase()) }))
    .filter((entry) => entry.count > 0)

  return {
    status: root.attrs.status ?? "passed",
    diagnostics,
    groups: [...byFile.entries()].map(([file, items]) => ({ file, items })),
    tiers,
  }
}

/* ── Test ────────────────────────────────────────────────────────────────── */

export type TestFailure = { file?: string; line?: string; name?: string; detail?: string }

export type ParsedTest = {
  kind: "run" | "list"
  failures: TestFailure[]
  tail?: string
  files: string[]
}

export function parseTest(output: string): ParsedTest | undefined {
  const run = tagBlock(output, "test-run")
  const list = tagBlock(output, "test-list")
  if (!run && !list) return undefined
  return {
    kind: run ? "run" : "list",
    failures: selfClosingAll(run?.inner ?? "", "failure") as TestFailure[],
    tail: tagText(run?.inner ?? "", "tail"),
    files: selfClosingAll(list?.inner ?? "", "file")
      .map((attrs) => attrs.path ?? "")
      .filter(Boolean),
  }
}

/* ── Memory ──────────────────────────────────────────────────────────────── */

export type MemoryEntry = {
  id?: string
  status?: string
  topic?: string
  kind?: string
  origin?: string
  scope?: string
  title?: string
  summary?: string
  score?: string
  evidence?: string
}

function memoryEntry(attrs: Record<string, string>, inner: string): MemoryEntry {
  return {
    id: attrs.id,
    status: attrs.status,
    score: attrs.score,
    topic: tagText(inner, "topic"),
    kind: tagText(inner, "kind"),
    origin: tagText(inner, "origin"),
    scope: tagText(inner, "scope"),
    title: tagText(inner, "title"),
    summary: tagText(inner, "summary"),
    evidence: selfClosing(inner, "evidence")?.count,
  }
}

export type ParsedMemory = {
  stored?: MemoryEntry
  search?: { query?: string; hits: MemoryEntry[] }
  forgotten?: string
  note?: string
}

export function parseMemory(output: string): ParsedMemory | undefined {
  const storedBlock = tagBlocks(output, "memory")[0]
  const searchBlock = tagBlocks(output, "memory-search")[0]
  const forgotten = selfClosing(output, "memory-forgotten")
  const emptySearch = selfClosing(output, "memory-search")
  const emptyMap = selfClosing(output, "memory-map")

  if (!storedBlock && !searchBlock && !forgotten && !emptySearch && !emptyMap) return undefined

  const note = withoutHints(output.replace(/<[^>]+>[\s\S]*?<\/[^>]+>|<[^>]+\/>/g, ""))

  return {
    stored: storedBlock ? memoryEntry(storedBlock.attrs, storedBlock.inner) : undefined,
    search: searchBlock
      ? {
          query: searchBlock.attrs.query,
          hits: tagBlocks(searchBlock.inner, "hit").map((hit) => memoryEntry(hit.attrs, hit.inner)),
        }
      : undefined,
    forgotten: forgotten?.id,
    note: (emptySearch || emptyMap) && note ? note : undefined,
  }
}

/* ── Project ─────────────────────────────────────────────────────────────── */

export type TreeNode = { depth: number; label: string; meta?: string }

const TREE_LINE = /^(\s*)(.+?)\s*(?:\((\d[\d,]*\s+files?,\s*[\d.]+\s*\wB)\))?\s*$/

export function parseProjectTree(output: string): { preamble?: string; nodes: TreeNode[] } {
  const nodes: TreeNode[] = []
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    const match = TREE_LINE.exec(line)
    if (!match) continue
    const label = match[2]!.trim()
    // Prose lines (the "no manifest detected" preamble) aren't tree nodes.
    if (!label.endsWith("/") && !match[3] && !/^[\w.\-@]+$/.test(label)) continue
    nodes.push({ depth: Math.floor(match[1]!.length / 2), label, meta: match[3] })
  }
  const first = output.split("\n").find((line) => line.trim())?.trim()
  const preamble = first && !nodes.some((node) => node.label === first) ? first : undefined
  return { preamble, nodes }
}

/* ── Symbols ─────────────────────────────────────────────────────────────── */

export type SymbolHit = { name: string; kind?: string; file?: string; line?: string }

export function parseSymbols(output: string): SymbolHit[] {
  const out: SymbolHit[] = []
  for (const line of output.split("\n")) {
    // `name  [kind]  path:line`
    const match = /^\s*(\S+)\s+(?:\[(\w+)\]\s+)?(.+?):(\d+)\s*$/.exec(line)
    if (!match) continue
    out.push({ name: match[1]!, kind: match[2], file: match[3], line: match[4] })
  }
  return out
}

/* ── Checkpoint / Monitor / Archive / JSON ───────────────────────────────── */

export type Checkpoint = {
  ordinal?: string
  id?: string
  status?: string
  kind?: string
  files?: string
  add?: string
  del?: string
  mine?: string
}

export function parseCheckpoints(output: string): { list: Checkpoint[]; empty?: string } | undefined {
  const list = selfClosingAll(output, "cp") as Checkpoint[]
  const block = tagBlocks(output, "checkpoints")[0]
  const empty = block && block.attrs.count === "0" ? block.inner.trim() : undefined
  if (!list.length && !empty) return undefined
  return { list, empty }
}

export function parseMonitor(
  output: string,
): { state?: string; job?: string; description?: string; command?: string } | undefined {
  const block = tagBlocks(output, "monitor")[0]
  if (!block) return undefined
  return {
    state: block.attrs.state,
    job: block.attrs.job,
    description: tagText(block.inner, "description"),
    command: tagText(block.inner, "command"),
  }
}

export type ArchiveEntry = { name: string; size?: string; dir: boolean; unsafe: boolean }

export function parseArchive(
  output: string,
): { archive?: string; format?: string; entries?: string; uncompressed?: string; items: ArchiveEntry[] } | undefined {
  const archive = tagText(output, "archive")
  const items: ArchiveEntry[] = []
  for (const line of output.split("\n")) {
    const match = /^\s{2}(\[!\]|\[D\]|\s{3})\s(.+)$/.exec(line)
    if (!match) continue
    const marker = match[1]!.trim()
    const rest = match[2]!
    const split = rest.lastIndexOf(" — ")
    const unsafe = marker === "[!]"
    items.push({
      name: split > 0 ? rest.slice(0, split) : rest,
      size: unsafe || split < 0 ? undefined : rest.slice(split + 3),
      dir: marker === "[D]",
      unsafe,
    })
  }
  if (!archive && !items.length) return undefined
  return {
    archive,
    format: tagText(output, "format"),
    entries: tagText(output, "entries"),
    uncompressed: tagText(output, "uncompressed"),
    items,
  }
}

export type JsonValidation = {
  ok: boolean
  bytes?: string
  parseMs?: string
  error?: { line?: string; column?: string; message: string }
  excerpt?: string
}

export function parseJsonValidate(output: string): JsonValidation | undefined {
  const selfClose = selfClosing(output, "json-validate")
  if (selfClose) return { ok: selfClose.ok === "true", bytes: selfClose.bytes, parseMs: selfClose.parseMs }

  const block = tagBlocks(output, "json-validate")[0]
  if (!block) return undefined

  const match = /<error\s([^>]*)>([\s\S]*?)<\/error>/.exec(block.inner)
  const attrs = readAttrs(match?.[1])
  return {
    ok: block.attrs.ok === "true",
    bytes: block.attrs.bytes,
    parseMs: block.attrs.parseMs,
    error: match ? { line: attrs.line, column: attrs.column, message: unescapeXml(match[2]!.trim()) } : undefined,
    excerpt: tagText(block.inner, "excerpt"),
  }
}

/* ── Background ──────────────────────────────────────────────────────────── */

export type BackgroundJobRow = {
  id: string
  status: string
  kind?: string
  description?: string
  command: string
  exit?: number | null
}

export function backgroundRows(metadata: Record<string, unknown> | undefined): BackgroundJobRow[] {
  const rows = metadata?.jobs
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (row): row is BackgroundJobRow => !!row && typeof row === "object" && typeof (row as any).id === "string",
  )
}

/** `<job id="…" status="…">` … `</job>` — the `status` and `wait` actions. */
export function parseJobBlock(
  output: string,
): { attrs: Record<string, string>; command?: string; fields: { key: string; value: string }[]; tail: string } | undefined {
  const block = tagBlocks(output, "job")[0]
  if (!block) return undefined

  const fields: { key: string; value: string }[] = []
  const tail: string[] = []
  let inTail = false

  for (const raw of block.inner.split("\n")) {
    const line = raw.trim()
    if (/^Output tail:$/.test(line)) {
      inTail = true
      continue
    }
    if (inTail) {
      tail.push(raw)
      continue
    }
    if (line.startsWith("<command>")) continue
    const field = /^([A-Z][A-Za-z ]{0,20}):\s+(\S.*)$/.exec(line)
    if (field) fields.push({ key: field[1]!, value: unescapeXml(field[2]!) })
  }

  while (tail.length && !tail[0]!.trim()) tail.shift()
  while (tail.length && !tail[tail.length - 1]!.trim()) tail.pop()

  return { attrs: block.attrs, command: tagText(block.inner, "command"), fields, tail: tail.join("\n") }
}

/* ── Git ─────────────────────────────────────────────────────────────────── */

export type StatusEntry = { code: string; path: string }
export type StatusTone = "add" | "modify" | "delete" | "untracked" | "conflict" | "neutral"

export function statusTone(code: string): StatusTone {
  if (code.includes("U") || code === "AA" || code === "DD") return "conflict"
  if (code === "??") return "untracked"
  if (code.includes("A")) return "add"
  if (code.includes("D")) return "delete"
  if (code.includes("M") || code.includes("R") || code.includes("C")) return "modify"
  return "neutral"
}

function statusEntries(inner: string): StatusEntry[] {
  return tagTexts(inner, "entry")
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
    .filter((entry) => entry.path.length > 0)
}

function statusBlock(source: string) {
  if (/<status\s+clean="true"\s*\/>/.test(source)) return { attrs: { clean: "true" }, inner: "" }
  return tagBlock(source, "status")
}

export type ParsedGit =
  | { mode: "status"; entries: StatusEntry[] }
  | { mode: "summary"; branch?: string; entries: StatusEntry[]; commits: string[] }
  | { mode: "log"; commits: string[] }
  | { mode: "diff"; diff: string }
  | { mode: "commit"; applied: boolean; hash?: string; entries: StatusEntry[]; raw?: string }
  | { mode: "raw"; text: string }

export function parseGit(mode: string, output: string): ParsedGit | undefined {
  switch (mode) {
    case "status":
      return { mode: "status", entries: statusEntries(statusBlock(output)?.inner ?? "") }
    case "stage":
    case "unstage":
    case "restore": {
      const wrapper = mode === "stage" ? "staged" : mode === "unstage" ? "unstaged" : "restored"
      const inner = tagBlock(output, wrapper)?.inner ?? ""
      return { mode: "status", entries: statusEntries(statusBlock(inner)?.inner ?? "") }
    }
    case "summary": {
      const summary = tagBlock(output, "summary")
      if (!summary) return undefined
      return {
        mode: "summary",
        branch: summary.attrs.branch,
        entries: statusEntries(summary.inner),
        commits: tagTexts(tagBlock(output, "recent")?.inner ?? "", "commit"),
      }
    }
    case "log": {
      const log = tagBlock(output, "log")
      if (!log) return undefined
      return { mode: "log", commits: unescapeXml(log.inner).trim().split("\n").filter(Boolean) }
    }
    case "diff": {
      const diff = tagBlock(output, "diff")
      if (!diff) return undefined
      return { mode: "diff", diff: unescapeXml(diff.inner).trim() }
    }
    case "commit": {
      const commit = tagBlock(output, "commit")
      if (!commit) return undefined
      const applied = commit.attrs.applied === "true"
      return {
        mode: "commit",
        applied,
        hash: tagText(commit.inner, "commit"),
        entries: statusEntries(statusBlock(commit.inner)?.inner ?? ""),
        raw: applied ? undefined : unescapeXml(commit.inner).trim(),
      }
    }
    case "show":
    case "shell": {
      const raw = tagBlock(output, mode === "show" ? "show" : "git-shell")
      if (!raw) return undefined
      return { mode: "raw", text: unescapeXml(raw.inner).trim() }
    }
    default:
      return undefined
  }
}

/* ── LSP ─────────────────────────────────────────────────────────────────── */

const SYMBOL_KIND = [
  "file", "module", "namespace", "package", "class", "method", "property", "field",
  "constructor", "enum", "interface", "function", "variable", "constant", "string",
  "number", "boolean", "array", "object", "key", "null", "enum member", "struct",
  "event", "operator", "type parameter",
]

export type LspPlace = { name?: string; kind?: string; path: string; line?: number; character?: number; detail?: string }

const fileFromUri = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\/\/?/, ""))

export function parseLspPlaces(result: unknown): LspPlace[] {
  if (!Array.isArray(result)) return []
  return result.flatMap((raw: any): LspPlace[] => {
    // Call hierarchy wraps the item it is telling you about.
    const node = raw?.from ?? raw?.to ?? raw
    const uri = node?.uri ?? node?.location?.uri
    if (typeof uri !== "string") return []
    const start = node?.range?.start ?? node?.selectionRange?.start ?? node?.location?.range?.start
    return [
      {
        name: typeof node.name === "string" ? node.name : undefined,
        kind: typeof node.kind === "number" ? SYMBOL_KIND[node.kind - 1] : undefined,
        detail: typeof node.detail === "string" ? node.detail : undefined,
        path: fileFromUri(uri),
        // LSP is zero-based; editors are not.
        line: start ? (start.line ?? 0) + 1 : undefined,
        character: start ? (start.character ?? 0) + 1 : undefined,
      },
    ]
  })
}

export function parseLspHover(result: unknown): string | undefined {
  if (!Array.isArray(result)) return undefined
  const contents = (result[0] as any)?.contents
  if (typeof contents === "string") return contents
  if (typeof contents?.value === "string") return contents.value
  if (Array.isArray(contents)) {
    return contents.map((part: any) => (typeof part === "string" ? part : (part?.value ?? ""))).join("\n\n")
  }
  return undefined
}

/* ── Refactor ────────────────────────────────────────────────────────────── */

export type ParsedRefactor =
  | { kind: "refactor"; status?: string; mode?: string; summary?: string; changed: Record<string, string>[]; diff?: string }
  | { kind: "references"; total?: string; files: Record<string, string>[] }
  | { kind: "symbol"; file?: string; line?: string; column?: string; name?: string; symbolKind?: string; rename?: string }

export function parseRefactor(output: string): ParsedRefactor | undefined {
  const block = tagBlocks(output, "refactor")[0]
  if (block) {
    const stripped = block.inner
      .replace(/<summary>[\s\S]*?<\/summary>/g, "")
      .replace(/<changed[^>]*\/>/g, "")
      .trim()
    const diff = /^(diff |--- |\+\+\+ |@@)/m.test(stripped) ? unescapeXml(stripped) : undefined
    return {
      kind: "refactor",
      status: block.attrs.status,
      mode: block.attrs.mode,
      summary: tagText(block.inner, "summary") ?? (diff ? undefined : stripped || undefined),
      changed: selfClosingAll(block.inner, "changed"),
      diff,
    }
  }

  const references = tagBlocks(output, "references")[0]
  if (references) {
    return { kind: "references", total: references.attrs.total, files: selfClosingAll(references.inner, "file") }
  }

  const symbol = tagBlocks(output, "symbol")[0]
  if (symbol) {
    return {
      kind: "symbol",
      file: symbol.attrs.file,
      line: symbol.attrs.line,
      column: symbol.attrs.column,
      name: tagText(symbol.inner, "name"),
      symbolKind: tagText(symbol.inner, "kind"),
      rename: tagText(symbol.inner, "canRename") === "true" ? tagText(symbol.inner, "renameDisplay") : undefined,
    }
  }

  return undefined
}
