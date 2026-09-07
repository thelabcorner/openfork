// Character-level normalization + bounded edit distance.

/**
 * Unicode equivalence map. Every entry is STRICTLY one character to one
 * character — that invariant is what lets a matcher search normalized text and
 * then recover the exact original slice by offset. Do NOT reach for
 * String.prototype.normalize("NFKC") here: it is not length-preserving, so the
 * offsets would be wrong and the recovered slice would be garbage.
 */
const UNICODE_EQUIVALENT: Record<string, string> = {
  // Hyphen/dash variants -> ASCII hyphen-minus.
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
  // Curly single quotes -> straight apostrophe.
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  // Curly double quotes -> straight double quote.
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  // Whitespace variants -> plain space.
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  "　": " ",
}

const UNICODE_EQUIVALENT_RE = new RegExp(`[${Object.keys(UNICODE_EQUIVALENT).join("")}]`, "g")

/** Length-preserving. Offsets into the result map 1:1 onto the input. */
export function normalizeUnicode(text: string): string {
  if (!UNICODE_EQUIVALENT_RE.test(text)) {
    UNICODE_EQUIVALENT_RE.lastIndex = 0
    return text
  }
  UNICODE_EQUIVALENT_RE.lastIndex = 0
  return text.replace(UNICODE_EQUIVALENT_RE, (ch) => UNICODE_EQUIVALENT[ch] ?? ch)
}

export function hasUnicodeLookalikes(text: string): boolean {
  UNICODE_EQUIVALENT_RE.lastIndex = 0
  const hit = UNICODE_EQUIVALENT_RE.test(text)
  UNICODE_EQUIVALENT_RE.lastIndex = 0
  return hit
}

/**
 * CRLF *and* lone CR (D43). A normalizer that only handled \r\n produced wrong
 * line counts — and therefore wrong 1-based line numbers — for
 * classic-Mac-ending files.
 */
export function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
}

/**
 * Escape normalization, `\\+` (one or more backslashes). Kept deliberately
 * narrow and, at the call site, gated on UNIQUENESS: unescaping source that
 * legitimately contains "\\n" can make a wrong block compare equal, so this
 * tier withholds ambiguous matches rather than guessing (D44).
 */
export function unescapeAggressive(text: string): string {
  return text.replace(/\\+(n|t|r|'|"|`|\\|\n|\$)/g, (match, ch: string) => {
    switch (ch) {
      case "n":
        return "\n"
      case "t":
        return "\t"
      case "r":
        return "\r"
      case "'":
        return "'"
      case '"':
        return '"'
      case "`":
        return "`"
      case "\\":
        return "\\"
      case "\n":
        return "\n"
      case "$":
        return "$"
      default:
        return match
    }
  })
}

const LEVENSHTEIN_MAX_LEN = 512

/**
 * Bounded Levenshtein with a two-row rolling buffer (D19).
 * Above the cap we return max distance rather than allocating an O(n*m)
 * matrix — one minified line previously hung or OOM'd the tool.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a === "" || b === "") return Math.max(a.length, b.length)
  if (a.length > LEVENSHTEIN_MAX_LEN || b.length > LEVENSHTEIN_MAX_LEN) {
    return Math.max(a.length, b.length)
  }

  let prev = new Array<number>(b.length + 1)
  let cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    const ca = a[i - 1]
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    const swap = prev
    prev = cur
    cur = swap
  }
  return prev[b.length]!
}

/** Similarity in [0,1]. Blank-vs-blank is 1, not "skip" (see D16). */
export function lineSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

/**
 * First-difference window (D40). Blind `.slice(0, 80)` hid mismatches past
 * column 80 — the exact case where a model cannot self-heal because it can't
 * see what differs. Error text is confirmed model-visible, so payload quality
 * is a live recovery mechanism.
 */
export function describeDifference(actual: string, expected: string, window = 60): string {
  let i = 0
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++
  const from = Math.max(0, i - Math.floor(window / 2))
  const slice = (s: string) => {
    const head = from > 0 ? "…" : ""
    const body = s.slice(from, from + window)
    const tail = from + window < s.length ? "…" : ""
    return head + body + tail
  }
  const caret = " ".repeat((from > 0 ? 1 : 0) + (i - from)) + "^"
  return [`first difference at column ${i + 1}:`, `  expected: ${slice(expected)}`, `  actual:   ${slice(actual)}`, `            ${caret}`].join(
    "\n",
  )
}

export * as EditText from "./text"
