/**
 * Turns the literal text of an inline-code span that `inlineCodeKind` already
 * classified into something the OS can act on.
 *
 * The rendered text is written for humans, so it carries sentence punctuation
 * and editor-style `file:line:column` suffixes that `shell.openPath` and
 * `shell.showItemInFolder` would choke on. Copy keeps the text verbatim; only
 * the actionable value is cleaned.
 */
export type MarkdownTargetKind = "path" | "url"

export type MarkdownTarget = {
  kind: MarkdownTargetKind
  /** Exactly what the message rendered — what "Copy" puts on the clipboard. */
  raw: string
  /** Cleaned filesystem path or URL, safe to hand to the OS. */
  value: string
  line?: number
  column?: number
}

/** Sentence punctuation that can trail a path or URL inside prose. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"`]+$/
const SURROUNDING_QUOTES = /^(['"`])(.*)\1$/s
/** `file.ts:12` / `file.ts:12:34`. Anchored to digits, so `C:\dir` never matches. */
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/
/** GitHub/editor-style `file.ts#L12` / `file.ts#L12C34`. */
const HASH_LINE_SUFFIX = /#L(\d+)(?:C(\d+))?$/i

export function parseMarkdownTarget(kind: MarkdownTargetKind, text: string): MarkdownTarget | undefined {
  const raw = text.trim()
  if (!raw) return undefined

  let value = raw.replace(SURROUNDING_QUOTES, "$2").trim()
  if (!value) return undefined

  if (kind === "url") {
    value = value.replace(TRAILING_PUNCTUATION, "")
    if (!value) return undefined
    return { kind, raw, value }
  }

  // A drive designator is meaningful even without a separator (`C:` is
  // drive-relative on Windows), and `:` is otherwise sentence punctuation.
  if (/^[A-Za-z]:$/.test(value)) return { kind, raw, value }

  // A trailing separator is meaningful on a directory, so keep it and strip
  // punctuation only from the segment before it.
  const separator = /[/\\]$/.exec(value)?.[0] ?? ""
  const body = separator ? value.slice(0, -separator.length) : value
  if (separator && !body) return { kind, raw, value: separator }
  let cleaned = body.replace(TRAILING_PUNCTUATION, "")
  if (separator && /^[A-Za-z]:$/.test(body)) cleaned = body
  if (!cleaned) return undefined

  let line: number | undefined
  let column: number | undefined
  if (!separator) {
    const match = LINE_SUFFIX.exec(cleaned) ?? HASH_LINE_SUFFIX.exec(cleaned)
    const head = match ? cleaned.slice(0, match.index) : ""
    // Only treat it as a location when something path-like precedes it;
    // otherwise a bare `12:30` would lose its text.
    if (match && head) {
      cleaned = head
      line = Number(match[1])
      column = match[2] === undefined ? undefined : Number(match[2])
    }
  }

  return { kind, raw, value: cleaned + separator, line, column }
}
