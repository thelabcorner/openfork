/** A proven literal paragraph may extend its *existing Text node* directly.
 * HTML has already been sanitized by the worker. Recheck its exact serialized
 * structure before bypassing morphdom; Markdown, links, entities and punctuation
 * that change structure must still take the normal reconciliation path. */
type PlainBlock = {
  key: string
  mode: string
  raw: string
  src?: string
  html?: string
}

function isLiteralParagraph(block: PlainBlock) {
  const html = block.html
  const source = block.src
  if (source === undefined || html === undefined) return false
  // Marked serializes a plain paragraph as <p>text</p>\n. This check rejects
  // even syntactically subtle changes (inline links, entities, emphasis).
  return html.length === source.length + 8 &&
    html.startsWith("<p>") &&
    html.endsWith("</p>\n") &&
    html.slice(3, -5) === source
}

export function provenPlainParagraphSuffix(previous: PlainBlock | undefined, next: PlainBlock): string | undefined {
  if (!previous || previous.mode !== "live" || next.mode !== "live" || previous.key !== next.key) return
  if (previous.raw !== previous.src || next.raw !== next.src) return
  if (!isLiteralParagraph(previous) || !isLiteralParagraph(next)) return
  if (next.src!.length <= previous.src!.length) return
  // String#slice plus equality is the repository's validated append-prefix
  // check, avoiding a repeated startsWith walk of an ever-growing transcript.
  if (next.src!.slice(0, previous.src!.length) !== previous.src) return
  const suffix = next.src!.slice(previous.src!.length)
  if (suffix.includes("\r") || suffix.includes("\n")) return
  return suffix
}
