import { FUZZ, type Match, type Span } from "./span"
import { applySpans } from "./span"
import { buildLineIndex, lineNumberAt, type Line } from "./line-index"
import {
  describeDifference,
  hasUnicodeLookalikes,
  levenshtein,
  lineSimilarity,
  normalizeUnicode,
  unescapeAggressive,
} from "./text"
import { replaceConflictHint } from "../conflict"

export type Matcher = (content: string, find: string, lines: readonly Line[]) => Generator<Match, void, unknown>

const BLOCK_ANCHOR_SIMILARITY_THRESHOLD = 0.65
/** Cap on competitor line numbers named in an ambiguity refusal (D41). */
const MAX_CANDIDATES_LISTED = 10

// ── Matchers (offset-yielding) ───────────────────────────────────────────────

export const ExactMatcher: Matcher = function* (content, find) {
  if (find === "") return
  let from = 0
  for (;;) {
    const idx = content.indexOf(find, from)
    if (idx === -1) return
    yield { start: idx, end: idx + find.length, fuzz: FUZZ.EXACT, via: "exact" }
    from = idx + Math.max(1, find.length)
  }
}

/**
 * Unicode-equivalent match. Sound because normalizeUnicode is strictly
 * 1-char -> 1-char, so offsets in normalized space are offsets in original
 * space and the recovered slice is exact original bytes.
 */
export const UnicodeMatcher: Matcher = function* (content, find) {
  if (find === "") return
  if (!hasUnicodeLookalikes(content) && !hasUnicodeLookalikes(find)) return
  const nContent = normalizeUnicode(content)
  const nFind = normalizeUnicode(find)
  if (nFind === find && nContent === content) return
  let from = 0
  for (;;) {
    const idx = nContent.indexOf(nFind, from)
    if (idx === -1) return
    yield { start: idx, end: idx + nFind.length, fuzz: FUZZ.UNICODE, via: "unicode-equivalent" }
    from = idx + Math.max(1, nFind.length)
  }
}

type LineCompare = (fileLine: string, findLine: string) => boolean

function* lineBlockMatches(
  lines: readonly Line[],
  find: string,
  fuzz: number,
  via: string,
  eq: LineCompare,
): Generator<Match, void, unknown> {
  const findLines = find.split("\n")
  if (findLines.length > 1 && findLines[findLines.length - 1] === "") findLines.pop()
  if (findLines.length === 0) return

  for (let i = 0; i + findLines.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < findLines.length; j++) {
      if (!eq(lines[i + j]!.text, findLines[j]!)) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const first = lines[i]!
    const last = lines[i + findLines.length - 1]!
    // End at textEnd, not end: the terminator belongs to the file, not to the
    // match. This is the offset-space statement of the terminator rule.
    yield { start: first.start, end: last.textEnd, fuzz, via }
  }
}

export const TrailingWhitespaceMatcher: Matcher = function* (_content, find, lines) {
  yield* lineBlockMatches(lines, find, FUZZ.TRAILING_WS, "trailing-whitespace", (a, b) => a.trimEnd() === b.trimEnd())
}

export const LineTrimmedMatcher: Matcher = function* (_content, find, lines) {
  yield* lineBlockMatches(lines, find, FUZZ.LINE_TRIMMED, "line-trimmed", (a, b) => a.trim() === b.trim())
}

export const WhitespaceCollapsedMatcher: Matcher = function* (_content, find, lines) {
  const collapse = (t: string) => t.replace(/\s+/g, " ").trim()
  yield* lineBlockMatches(lines, find, FUZZ.WHITESPACE_COLLAPSED, "whitespace-collapsed", (a, b) => collapse(a) === collapse(b))
}

export const IndentFlexibleMatcher: Matcher = function* (_content, find, lines) {
  const findLines = find.split("\n")
  if (findLines.length > 1 && findLines[findLines.length - 1] === "") findLines.pop()
  if (findLines.length === 0) return

  const dedent = (block: string[]) => {
    const nonEmpty = block.filter((l) => l.trim().length > 0)
    if (nonEmpty.length === 0) return block
    const min = Math.min(...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0))
    return block.map((l) => (l.trim().length === 0 ? l : l.slice(min)))
  }
  const target = dedent(findLines).join("\n")

  for (let i = 0; i + findLines.length <= lines.length; i++) {
    const block = lines.slice(i, i + findLines.length).map((l) => l.text)
    if (dedent(block).join("\n") !== target) continue
    yield {
      start: lines[i]!.start,
      end: lines[i + findLines.length - 1]!.textEnd,
      fuzz: FUZZ.INDENT_FLEXIBLE,
      via: "indent-flexible",
    }
  }
}

/**
 * Escape-normalized match, UNIQUENESS-GATED (D44): a match is only offered when
 * the unescaped needle occurs exactly once. Unescaping source that legitimately
 * contains "\\n" can make a wrong block compare equal, and this tier is where
 * that happens.
 */
export const EscapeNormalizedMatcher: Matcher = function* (content, find) {
  const unescaped = unescapeAggressive(find)
  if (unescaped === find || unescaped === "") return
  const first = content.indexOf(unescaped)
  if (first === -1) return
  if (content.indexOf(unescaped, first + 1) !== -1) return // ambiguous: withhold
  yield { start: first, end: first + unescaped.length, fuzz: FUZZ.ESCAPE_NORMALIZED, via: "escape-normalized" }
}

/**
 * Block anchor: first/last line as anchors plus middle-line similarity.
 *
 * Two fixes vs the previous implementation:
 *  - D15: the size check no longer masks the correct block — a nearby
 *    wrong-size candidate is skipped and scanning continues.
 *  - D16: blank middle lines score 1.0 (via lineSimilarity) instead of being
 *    skipped while still counting in the divisor, which made blocks with blank
 *    middles unmatchable.
 *
 * It also no longer picks a winner among multiple candidates (D17). It yields
 * ALL viable candidates and lets arbitration refuse — the tool never guesses
 * a location.
 */
export const BlockAnchorMatcher: Matcher = function* (_content, find, lines) {
  const findLines = find.split("\n")
  if (findLines.length > 1 && findLines[findLines.length - 1] === "") findLines.pop()
  if (findLines.length < 3) return

  const firstAnchor = findLines[0]!.trim()
  const lastAnchor = findLines[findLines.length - 1]!.trim()
  const wanted = findLines.length
  const maxDelta = Math.max(1, Math.floor(wanted * 0.25))

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.text.trim() !== firstAnchor) continue
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j]!.text.trim() !== lastAnchor) continue
      const size = j - i + 1
      if (Math.abs(size - wanted) > maxDelta) continue // D15: keep scanning

      const middle = Math.min(wanted - 2, size - 2)
      let similarity = 1
      if (middle > 0) {
        let total = 0
        for (let k = 1; k <= middle; k++) {
          total += lineSimilarity(lines[i + k]!.text.trim(), findLines[k]!.trim())
        }
        similarity = total / middle
      }
      if (similarity >= BLOCK_ANCHOR_SIMILARITY_THRESHOLD) {
        yield { start: lines[i]!.start, end: lines[j]!.textEnd, fuzz: FUZZ.BLOCK_ANCHOR, via: "block-anchor" }
      }
      break // this (i, j) pair is settled; move to the next opening anchor
    }
  }
}

export const MATCHERS: readonly Matcher[] = [
  ExactMatcher,
  TrailingWhitespaceMatcher,
  UnicodeMatcher,
  LineTrimmedMatcher,
  WhitespaceCollapsedMatcher,
  IndentFlexibleMatcher,
  EscapeNormalizedMatcher,
  BlockAnchorMatcher,
]

// ── Arbitration ──────────────────────────────────────────────────────────────

export type ResolveOptions = {
  /** Restrict matching to [from, content.length). Used by the chunk cursor. */
  from?: number
  /** Reject any match above this fuzz tier. */
  maxFuzz?: number
  /** Human label for error text ("oldString", "hunk 2 of 5", ...). */
  label?: string
}

export type Resolution = {
  match: Match
  /** All matches in the winning tier (length 1 on success). */
  tier: Match[]
  /** Every distinct match found, for diagnostics. */
  all: Match[]
  warnings: string[]
}

export class MatchError extends Error {
  readonly kind: "not-found" | "ambiguous" | "disproportionate"
  readonly candidates: number[]
  constructor(kind: MatchError["kind"], message: string, candidates: number[] = []) {
    super(message)
    this.name = "MatchError"
    this.kind = kind
    this.candidates = candidates
  }
}

function collect(content: string, find: string, lines: readonly Line[], opts: ResolveOptions): Match[] {
  const from = opts.from ?? 0
  const maxFuzz = opts.maxFuzz ?? Number.POSITIVE_INFINITY
  const seen = new Map<string, Match>()
  for (const matcher of MATCHERS) {
    for (const m of matcher(content, find, lines)) {
      if (m.start < from) continue
      if (m.fuzz > maxFuzz) continue
      const key = `${m.start}:${m.end}`
      const prior = seen.get(key)
      // Same span found by several tiers: keep the safest attribution.
      if (!prior || m.fuzz < prior.fuzz) seen.set(key, m)
    }
  }
  return [...seen.values()].sort((a, b) => a.fuzz - b.fuzz || a.start - b.start)
}

/**
 * Disproportionate-match guard, tightened (D42). The old form let a 1-line
 * oldString silently consume a multi-line span; now any fuzzy tier must stay
 * within a line-count delta of the needle, and the 1-line escape hatch is gone.
 */
function assertProportionate(content: string, find: string, m: Match, label: string) {
  const span = content.slice(m.start, m.end)
  const findLines = find.split("\n").length
  const spanLines = span.split("\n").length
  const allowed = m.fuzz === FUZZ.EXACT ? Number.POSITIVE_INFINITY : Math.max(1, Math.ceil(findLines * 0.25))
  if (spanLines > findLines + allowed) {
    throw new MatchError(
      "disproportionate",
      `Refusing ${label}: the matched span is ${spanLines} lines but ${label} is ${findLines} lines ` +
        `(matcher: ${m.via}). Resend the exact current-file text you intend to replace.`,
    )
  }
  if (m.fuzz !== FUZZ.EXACT && span.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4)) {
    throw new MatchError(
      "disproportionate",
      `Refusing ${label}: the matched span is far larger than ${label} (matcher: ${m.via}). ` +
        `Resend the exact current-file text you intend to replace.`,
    )
  }
}

/**
 * THE uniqueness rule. Single arbitration point for BOTH `replace()` and the
 * patch chunk resolver — D49's fix and its drift-prevention are the same code.
 *
 * Rule: consider only the lowest non-empty fuzz tier. Exactly one match there
 * succeeds; more than one is an ambiguity and is REFUSED with the line numbers
 * of every competitor (D41).
 */
export function resolveMatch(content: string, find: string, opts: ResolveOptions = {}): Resolution {
  const label = opts.label ?? "oldString"
  if (find === "") {
    throw new MatchError("not-found", `${label} cannot be empty. Provide the exact text to replace.`)
  }
  const lines = buildLineIndex(content)
  const all = collect(content, find, lines, opts)

  if (all.length === 0) {
    throw new MatchError("not-found", notFoundMessage(content, find, lines, label, opts))
  }

  const bestFuzz = all[0]!.fuzz
  const tier = all.filter((m) => m.fuzz === bestFuzz)

  if (tier.length > 1) {
    const numbers = tier.map((m) => lineNumberAt(lines, m.start))
    const listed = numbers.slice(0, MAX_CANDIDATES_LISTED).join(", ")
    const suffix = numbers.length > MAX_CANDIDATES_LISTED ? `, … (+${numbers.length - MAX_CANDIDATES_LISTED} more)` : ""
    const parts = [
      `Found multiple matches for ${label} at lines ${listed}${suffix} ` +
        `(matcher: ${bestFuzz === FUZZ.EXACT ? "exact" : tier[0]!.via}). ` +
        `Provide more surrounding context so exactly one location matches` +
        (bestFuzz === FUZZ.EXACT ? `, or set replaceAll:true to change all of them.` : `.`),
    ]
    const hint = replaceConflictHint({ content, needle: find })
    if (hint) parts.push("", hint)
    throw new MatchError("ambiguous", parts.join("\n"), numbers)
  }

  const match = tier[0]!
  assertProportionate(content, find, match, label)

  const warnings: string[] = []
  if (match.fuzz !== FUZZ.EXACT) {
    warnings.push(
      `${label} did not match exactly; resolved via ${match.via} at line ${lineNumberAt(lines, match.start)}. ` +
        `Send exact current-file text next time to avoid relying on fuzzy matching.`,
    )
  }
  return { match, tier, all, warnings }
}

/**
 * Not-found payload. Confirmed model-visible, so it is written as a repair
 * instruction, not a status report: nearest line by edit distance, a
 * first-difference window against it (D40), the closest current-file region,
 * and the tool call that recovers.
 */
function notFoundMessage(content: string, find: string, lines: readonly Line[], label: string, opts: ResolveOptions): string {
  const findFirst = find.split("\n")[0]!.trim()
  let bestLine: Line | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (opts.from !== undefined && line.start < opts.from) continue
    const score = levenshtein(line.text.trim(), findFirst)
    if (score < bestScore) {
      bestScore = score
      bestLine = line
    }
  }
  const parts = [
    `Could not find ${label} in the file. It must match the current file contents exactly, ` +
      `including whitespace, indentation, and line endings.`,
  ]
  if (opts.from !== undefined) {
    parts.push(`(Search was restricted to line ${lineNumberAt(lines, opts.from)} onward.)`)
  }
  if (bestLine && bestScore < Math.max(8, findFirst.length)) {
    parts.push("", `Closest line is ${bestLine.index + 1}:`, describeDifference(bestLine.text, findFirst))
  }
  const hint = replaceConflictHint({ content, needle: find })
  if (hint) parts.push("", hint)
  parts.push(
    "",
    `HINT: read({action:"around", symbol:"<name>"}) shows the exact current text around a symbol; ` +
      `grep({pattern:"<text>"}) locates it. Copy the result verbatim into ${label}.`,
  )
  return parts.join("\n")
}

// ── Public entry points ──────────────────────────────────────────────────────

/**
 * Resolve an exact-path edit to spans. `replaceAll` is permitted only at
 * fuzz 0 (D8): previously a fuzzy matcher could yield a normalized
 * approximation of oldString and replaceAll would then rewrite every
 * occurrence of that approximation.
 */
export function resolveReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { spans: Span[]; warnings: string[]; via: string; applied: number } {
  if (oldString === newString) {
    throw new MatchError("not-found", "No changes to apply: oldString and newString are identical.")
  }

  if (replaceAll) {
    // Uniqueness arbitration is skipped deliberately: renaming every
    // occurrence is the documented intent. Exact-only by policy (D8) — a
    // fuzzy tier must never decide the rewrite set.
    const lines = buildLineIndex(content)
    const spans: Span[] = []
    for (const m of ExactMatcher(content, oldString, lines)) {
      spans.push({ start: m.start, end: m.end, replacement: newString })
    }
    if (spans.length === 0) {
      throw new MatchError("not-found", "replaceAll requires an exact match; oldString was not found verbatim.")
    }
    return { spans, warnings: [], via: "exact", applied: spans.length }
  }

  const resolution = resolveMatch(content, oldString, { label: "oldString" })
  const { start, end } = resolution.match
  return {
    spans: [{ start, end, replacement: newString }],
    warnings: resolution.warnings,
    via: resolution.match.via,
    applied: 1,
  }
}

/** Back-compat wrapper. Same signature as the old replace(). */
export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  const { spans } = resolveReplacement(content, oldString, newString, replaceAll)
  // applySpans, not String.replace: `$1`/`$&`/`$$` are literal (D1).
  return applySpans(content, spans)
}

export * as EditMatch from "./match"
