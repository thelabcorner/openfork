// Compiles a structured BrowserAnnotationResult into a provider-neutral text
// block - the composer sends this as plain text, so no provider needs
// OpenFork-specific binary annotation awareness to benefit from a human's pick.
// Internal state stays structured and rich; this boundary emits portable text.

import type {
  BrowserAnnotationElementContext,
  BrowserAnnotationResult,
  BrowserAnnotationSourceFrame,
  BrowserAnnotationStyleChange,
} from "./browserHostClient"

export const MAX_ANNOTATION_BLOCK_BYTES = 6000

// Regexes are built from ASCII escapes so no literal Unicode whitespace can
// slip into source and break parsing.
// Flatten line/paragraph separators, CR/LF, tabs, form-feed, vertical tab.
const NEWLINE_CLASS = new RegExp("[\\u000D\\u000A\\u2028\\u2029\\u0009\\u000C\\u000B]+", "g")
// Strip C0 controls, DEL, and the Unicode line/paragraph separators.
const CONTROL_CLASS = new RegExp("[\\u0000-\\u001F\\u007F\\u2028\\u2029]", "g")
// Block delimiters that page-controlled text must never be allowed to forge.
const BLOCK_CLOSING_TAG = /<\/(browser_annotation|element_context)\s*>/gi

const encoder = new TextEncoder()
function byteLen(s: string): number {
  return encoder.encode(s).length
}

// Page-derived strings are attacker/user controlled. Collapse newlines/tabs so
// an injected value cannot forge a new directive line, strip control chars, and
// defang any closing-tag sequence.
function fence(value: string): string {
  const flattened = value.replace(NEWLINE_CLASS, " ")
  const defanged = flattened.replace(CONTROL_CLASS, "").replace(BLOCK_CLOSING_TAG, "&lt;/$1&gt;")
  return defanged.trim()
}

function plural(n: number): string {
  return n === 1 ? "" : "s"
}

// Human-facing chip label: React component name when known, tag-name fallback.
function elementLabel(element: BrowserAnnotationElementContext): string {
  const name = fence(element.componentName ?? element.tagName)
  if (element.source) {
    const at = element.source.line != null ? `${element.source.file}:${element.source.line}` : element.source.file
    return `<${name}> (${fence(at)})`
  }
  return `<${name}>`
}

function sourceLocation(source: BrowserAnnotationSourceFrame, withColumn = false): string {
  if (source.line == null) return fence(source.file)
  const base = `${source.file}:${source.line}`
  if (withColumn && source.column != null) return `${base}:${source.column}`
  return base
}

function styleChangeLine(change: BrowserAnnotationStyleChange): string {
  const prev = change.previousValue == null ? "(default)" : fence(change.previousValue)
  return `- ${fence(change.property)}: ${prev} -> ${fence(change.value)}`
}

// Natural-language target census that DISTINGUISHES KINDS. Region records carry
// no DOM identity ({ id, rect }), so calling one an "element" would make the
// model hallucinate a component it cannot locate. Regions are "marked region",
// freehand ink is "drawing".
function targetsSummary(annotation: BrowserAnnotationResult): string {
  const parts: string[] = []
  if (annotation.elements.length > 0) {
    parts.push(`${annotation.elements.length} selected element${plural(annotation.elements.length)}`)
  }
  if (annotation.regions.length > 0) {
    parts.push(`${annotation.regions.length} marked region${plural(annotation.regions.length)}`)
  }
  if (annotation.strokes.length > 0) {
    parts.push(`${annotation.strokes.length} drawing${plural(annotation.strokes.length)}`)
  }
  return parts.length > 0 ? parts.join(", ") + "." : "no targets selected."
}

// Per-element content ordered by descending value. Source location (folded into
// the label) is the single highest-value token in the whole payload; styles are
// the cheapest. Truncation walks this tier order breadth-first: every element's
// label before any selector, every selector before any html, every html before
// any styles block.
type Tier = { tier: number; text: string }

function elementTiers(element: BrowserAnnotationElementContext): Tier[] {
  const out: Tier[] = []
  out.push({ tier: 0, text: `- ${elementLabel(element)}:` })
  if (element.source) {
    out.push({ tier: 1, text: `  source: ${sourceLocation(element.source, true)}` })
  }
  if (element.selector) {
    out.push({ tier: 2, text: `  selector: ${fence(element.selector)}` })
  }
  if (element.htmlPreview) {
    out.push({ tier: 3, text: `  html:\n    ${fence(element.htmlPreview)}` })
  }
  const styles = element.styles?.trim()
  if (styles) {
    out.push({ tier: 4, text: `  styles:\n    ${fence(styles)}` })
  }
  return out
}

const TRUNCATION_NOTE =
  "Note: element context truncated to fit the prompt budget (depth reduced before breadth)."

function buildElementContext(
  elements: BrowserAnnotationElementContext[],
  budgetBytes: number,
): { text: string; truncated: boolean } {
  const perElement = elements.map((el) => elementTiers(el))

  // Tier-major, element-order sequence - the exact priority order truncation follows.
  const seq: Array<{ el: number; tier: number; text: string; bytes: number }> = []
  for (let tier = 0; tier <= 4; tier++) {
    for (let i = 0; i < perElement.length; i++) {
      const found = perElement[i].find((t) => t.tier === tier)
      if (found) seq.push({ el: i, tier, text: found.text, bytes: byteLen(found.text + "\n") })
    }
  }

  let used = 0
  const accepted = new Set<string>()
  for (const item of seq) {
    if (used + item.bytes > budgetBytes) break
    used += item.bytes
    accepted.add(`${item.el}:${item.tier}`)
  }

  const blocks: string[] = []
  for (let i = 0; i < perElement.length; i++) {
    const kept = perElement[i].filter((t) => accepted.has(`${i}:${t.tier}`))
    if (kept.length === 0) continue
    blocks.push(kept.map((t) => t.text).join("\n"))
  }

  if (blocks.length === 0) return { text: "", truncated: seq.length > 0 }
  return {
    text: `<element_context>\n${blocks.join("\n")}\n</element_context>`,
    truncated: accepted.size < seq.length,
  }
}

interface BuildOptions {
  maxBytes?: number
}

/** Builds the `<browser_annotation>` text block. Pure - no DOM, no I/O. */
export function buildBrowserAnnotationPrompt(
  annotation: BrowserAnnotationResult,
  opts: BuildOptions = {},
): string {
  const maxBytes = opts.maxBytes ?? MAX_ANNOTATION_BLOCK_BYTES

  const headLines: string[] = ["<browser_annotation>", "Browser annotation:"]
  headLines.push(`Id: ${fence(annotation.id)}`)
  headLines.push(
    `Page: ${fence(annotation.pageUrl)}${annotation.pageTitle ? ` (${fence(annotation.pageTitle)})` : ""}`,
  )
  if (annotation.comment) headLines.push(`Comment: ${fence(annotation.comment)}`)
  headLines.push(`Targets: ${targetsSummary(annotation)}`)

  // Omit the section entirely rather than emit empty scaffolding.
  if (annotation.styleChanges.length > 0) {
    headLines.push("Requested visual changes:")
    for (const change of annotation.styleChanges) headLines.push(styleChangeLine(change))
  }

  if (annotation.screenshot) headLines.push("The attached screenshot is the annotated preview crop.")

  const headText = headLines.join("\n") + "\n"
  const closingTag = "</browser_annotation>"
  const headBytes = byteLen(headText) + byteLen(closingTag + "\n")
  const wrapperBytes = byteLen("<element_context>\n</element_context>\n")

  // Reserve room for the truncation note up front so it can always be appended
  // when the context is actually trimmed; the note itself is never dropped.
  const noteBytes = byteLen(TRUNCATION_NOTE) + 1
  const elementBudget = Math.max(0, maxBytes - headBytes - wrapperBytes - noteBytes)

  let elementText = ""
  let truncated = false
  if (annotation.elements.length > 0) {
    const built = buildElementContext(annotation.elements, elementBudget)
    elementText = built.text ? built.text + "\n" : ""
    truncated = built.truncated
  }

  let result = headText + elementText + closingTag
  if (truncated) result += "\n" + TRUNCATION_NOTE
  return result
}
