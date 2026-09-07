import { applySpans, spansOverlap, type Span } from "./span"

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(`edit invariant violated: ${message}`)
    this.name = "InvariantViolation"
  }
}

/**
 * THE invariant: the bytes outside the reported spans are byte-identical to the
 * original, and the spans fully explain the new content.
 *
 * Because Span carries its replacement, this reduces to an identity —
 * applySpans(before, spans) === after — which subsumes essentially the whole
 * line-ending section of the test matrix (mixed endings, BOM, lone \r, no
 * trailing newline) in one assertion and holds through the delete/prepend work
 * where terminator math is hardest.
 *
 * Cheap enough to run in production behind a flag; run unconditionally in tests.
 */
export function assertSpansExplain(before: string, after: string, spans: readonly Span[]): void {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  for (const span of sorted) {
    if (span.start < 0 || span.end > before.length || span.end < span.start) {
      throw new InvariantViolation(`span [${span.start},${span.end}) is out of bounds for ${before.length} bytes`)
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    if (spansOverlap(sorted[i - 1]!, sorted[i]!)) {
      throw new InvariantViolation(
        `spans [${sorted[i - 1]!.start},${sorted[i - 1]!.end}) and [${sorted[i]!.start},${sorted[i]!.end}) overlap`,
      )
    }
  }
  const rebuilt = applySpans(before, sorted)
  if (rebuilt !== after) {
    throw new InvariantViolation(
      `applying ${sorted.length} span(s) to the original does not reproduce the new content ` +
        `(rebuilt ${rebuilt.length} bytes, actual ${after.length} bytes)`,
    )
  }
}

/** Untouched-region check, stated directly for test readability. */
export function untouchedRegions(before: string, spans: readonly Span[]): string[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const out: string[] = []
  let cursor = 0
  for (const span of sorted) {
    out.push(before.slice(cursor, span.start))
    cursor = span.end
  }
  out.push(before.slice(cursor))
  return out
}

export * as EditInvariant from "./invariant"
