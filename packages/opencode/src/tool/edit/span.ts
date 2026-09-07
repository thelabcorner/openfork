// Offset-addressed edit primitives. Every matcher, strategy, and chunk
// resolver in the edit/patch subsystem speaks in Spans over the ORIGINAL
// file content, so:
//   - untouched bytes are untouched by construction (D2 cannot recur),
//   - `$` in replacement text is never interpreted (D1 cannot recur),
//   - errors can always name a line number (D40/D41),
//   - the plan/apply invariant is a one-line identity (see invariant.ts).

export type Span = {
  /** Inclusive start offset in the original content. */
  start: number
  /** Exclusive end offset in the original content. */
  end: number
  /** Literal replacement text. NEVER passed through String.replace. */
  replacement: string
}

export type Match = {
  start: number
  end: number
  /** Lower is better. See FUZZ. */
  fuzz: number
  /** Matcher name, for diagnostics and telemetry. */
  via: string
}

/**
 * Fuzz ladder, ascending in risk. Arbitration only ever considers the LOWEST
 * non-empty tier, so a risky matcher can never outrank a safe one, and two
 * candidates inside one tier are an ambiguity (refuse) rather than a race
 * (guess).
 */
export const FUZZ = {
  EXACT: 0,
  TRAILING_WS: 1,
  UNICODE: 10,
  LINE_TRIMMED: 100,
  WHITESPACE_COLLAPSED: 200,
  INDENT_FLEXIBLE: 300,
  ESCAPE_NORMALIZED: 400,
  BLOCK_ANCHOR: 500,
} as const

/** Highest fuzz still eligible for replaceAll. Exact only, by policy (D8). */
export const REPLACE_ALL_MAX_FUZZ = FUZZ.EXACT

export function spansOverlap(a: Span, b: Span): boolean {
  // Zero-width spans (pure insertions) collide only with a span that strictly
  // contains the insertion point, and with another insertion at the same point.
  if (a.start === a.end && b.start === b.end) return a.start === b.start
  return a.start < b.end && b.start < a.end
}

/** Sort ascending, then reject overlaps. Shared by batch and patch. */
export function orderSpans(spans: readonly Span[], context: string): Span[] {
  const sorted = [...spans].sort((x, y) => x.start - y.start || x.end - y.end)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    if (spansOverlap(prev, cur)) {
      throw new Error(
        `${context}: overlapping edits at [${prev.start},${prev.end}) and [${cur.start},${cur.end}). ` +
          `Each location may be edited at most once per call — split the conflicting edits into separate calls.`,
      )
    }
  }
  return sorted
}

/**
 * Apply spans to content. Descending order so earlier offsets stay valid.
 * The fix for the batch-drift class (D4): every span addresses the ORIGINAL
 * content, so earlier edits never shift later targets.
 */
export function applySpans(content: string, spans: readonly Span[]): string {
  const ordered = [...spans].sort((x, y) => y.start - x.start || y.end - x.end)
  let out = content
  for (const span of ordered) {
    out = out.slice(0, span.start) + span.replacement + out.slice(span.end)
  }
  return out
}

/** Literal splice. The whole reason D1 is structurally dead. */
export function spliceLiteral(content: string, start: number, end: number, replacement: string): string {
  return content.slice(0, start) + replacement + content.slice(end)
}

export * as EditSpan from "./span"
