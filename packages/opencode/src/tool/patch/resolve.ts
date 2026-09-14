import { MatchError, resolveMatch } from "../edit/match"
import type { Match } from "../edit/span"
import { buildLineIndex } from "../edit/line-index"
import { adaptReplacementTerminators } from "@opencode-ai/core/line-ending"
import { FUZZ } from "../edit/span"
import { orderSpans, type Span } from "../edit/span"
import type { UpdateFileChunk } from "../../patch"

export type ResolvedChunk = {
  chunk: UpdateFileChunk
  index: number
  span: Span
  fuzz: number
  via: string
}

const chunkNeedle = (chunk: UpdateFileChunk) => chunk.old_lines.join("\n")
const chunkReplacement = (chunk: UpdateFileChunk) => chunk.new_lines.join("\n")

/**
 * EOF-anchored match, tried BEFORE file-wide resolution for chunks carrying
 * `is_end_of_file` (the `*** End of File` marker). Mirrors the old cursor
 * resolver's "try EOF first, then forward search" discipline: when the tail of
 * the file matches, that match wins deterministically even if an earlier
 * identical block exists.
 */
function matchAtEof(content: string, needle: string): Match | undefined {
  const findLines = needle.split("\n")
  if (findLines.length > 1 && findLines[findLines.length - 1] === "") findLines.pop()
  if (findLines.length === 0) return undefined
  const lines = buildLineIndex(content)
  if (findLines.length > lines.length) return undefined
  const start = lines.length - findLines.length
  const block = lines.slice(start)

  const tiers: Array<{ fuzz: number; via: string; eq: (a: string, b: string) => boolean }> = [
    { fuzz: FUZZ.EXACT, via: "exact", eq: (a, b) => a === b },
    { fuzz: FUZZ.TRAILING_WS, via: "trailing-whitespace", eq: (a, b) => a.trimEnd() === b.trimEnd() },
    { fuzz: FUZZ.LINE_TRIMMED, via: "line-trimmed", eq: (a, b) => a.trim() === b.trim() },
  ]
  for (const tier of tiers) {
    let ok = true
    for (let j = 0; j < findLines.length; j++) {
      if (!tier.eq(block[j]!.text, findLines[j]!)) {
        ok = false
        break
      }
    }
    if (ok) {
      return { start: block[0]!.start, end: block[block.length - 1]!.textEnd, fuzz: tier.fuzz, via: `${tier.via}-at-eof` }
    }
  }
  return undefined
}

/**
 * Advance the lower bound past a `change_context` line (the `@@ context`
 * form). Same message shape as the old cursor resolver so conflict detail
 * keeps recovering expected lines from it.
 */
function applyContext(content: string, context: string, from: number, filePath: string): number {
  const lines = buildLineIndex(content)
  let lowerLine = 0
  while (lowerLine < lines.length && lines[lowerLine]!.start < from) lowerLine++
  const eqs: Array<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ]
  for (const eq of eqs) {
    for (let i = lowerLine; i < lines.length; i++) {
      if (eq(lines[i]!.text, context)) return lines[i]!.end
    }
  }
  throw new Error(`Failed to find context '${context}' in ${filePath}`)
}

/**
 * Resolve every chunk of one file to a Span over the ORIGINAL content, then
 * order and overlap-check.
 *
 * D49: a lone or first hunk has no upstream cursor constraint, so a
 * cursor-only design still lands it on the FIRST of N identical candidates.
 * Uniqueness-at-cursor — not the cursor alone — is what fixes that, and it is
 * the same rule replace() uses (edit/match.ts resolveMatch), so the two
 * matching subsystems can no longer drift apart.
 *
 * D3 composition: the same-path merge can hand us chunks in non-file order, so
 * resolution never assumes input order. Pass 1 resolves every chunk that is
 * unambiguous file-wide. Pass 2 retries the ambiguous ones inside the window
 * bounded by their resolved neighbours, which is what makes a duplicate
 * candidate locatable at all. Only then do we sort and overlap-check.
 */
function resolveOne(
  content: string,
  chunk: UpdateFileChunk,
  index: number,
  from: number,
  upper: number,
  filePath: string,
): Match {
  const needle = chunkNeedle(chunk)
  let lower = from
  if (chunk.change_context) {
    lower = Math.max(lower, applyContext(content, chunk.change_context, lower, filePath))
  }
  if (chunk.is_end_of_file) {
    const eof = matchAtEof(content, needle)
    if (eof && eof.start >= lower && (upper >= content.length || eof.end <= upper)) return eof
  }
  const scope = upper < content.length ? content.slice(0, upper) : content
  return resolveMatch(scope, needle, { from: lower, label: `hunk ${index + 1}` }).match
}

export function resolveChunks(content: string, chunks: readonly UpdateFileChunk[], filePath: string): ResolvedChunk[] {
  const resolved = new Array<ResolvedChunk | undefined>(chunks.length)
  const deferred: Array<{ index: number; error: MatchError }> = []

  // Pass 1 — file-wide unique resolution.
  chunks.forEach((chunk, index) => {
    const needle = chunkNeedle(chunk)
    if (needle === "") {
      // Pure addition. Native semantics would append at EOF; we refuse rather
      // than guess a location, matching the translateGitDiff safety gate.
      throw new Error(
        `${filePath}: hunk ${index + 1} has no context or removed lines, so its position is undetermined. ` +
          `Include at least one unchanged context line, or use the single-edit insertAt/appendFile strategy.`,
      )
    }
    try {
      const match = resolveOne(content, chunk, index, 0, content.length, filePath)
      resolved[index] = {
        chunk,
        index,
        span: { start: match.start, end: match.end, replacement: chunkReplacement(chunk) },
        fuzz: match.fuzz,
        via: match.via,
      }
    } catch (error) {
      if (error instanceof MatchError && error.kind === "ambiguous") {
        deferred.push({ index, error })
        return
      }
      throw error
    }
  })

  // Pass 2 — disambiguate using resolved spans as windows. Probe every gap
  // between consecutive resolved spans (in file order), plus head and tail: a
  // deferred chunk resolves iff exactly one gap yields exactly one match.
  // Iterate to fixpoint so resolving one chunk narrows the gaps for the next.
  // Gap probing (not patch-order neighbours) is what makes reversed authoring
  // resolve identically — the D3-composition case.
  let pending = deferred.map((d) => d.index)
  const errors = new Map(deferred.map((d) => [d.index, d.error] as const))
  while (pending.length > 0) {
    let progressed = false
    const still: number[] = []
    for (const index of pending) {
      const found = probeGaps(content, chunks[index]!, index, resolved, filePath)
      if (found) {
        resolved[index] = found
        progressed = true
      } else {
        still.push(index)
      }
    }
    if (!progressed) break
    pending = still
  }
  if (pending.length > 0) {
    const index = pending[0]!
    const error = errors.get(index)!
    const at = error.candidates.join(", ")
    throw new Error(
      `${filePath}: hunk ${index + 1} matches ${error.candidates.length} locations (lines ${at}) and ` +
        `neighbouring hunks do not narrow it to one. Add surrounding context lines that are unique to the ` +
        `location you mean — the tool will not guess between identical candidates.`,
    )
  }

  const out = resolved.filter((r): r is ResolvedChunk => r !== undefined)
  // Sort + overlap-reject in offset space (shared with applyBatch). The error
  // keeps the historical "overlapping chunks" phrasing the plan tests assert.
  try {
    orderSpans(
      out.map((r) => r.span),
      `${filePath}: patch`,
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`overlapping chunks in ${filePath}: ${detail}`)
  }
  return out.sort((a, b) => a.span.start - b.span.start)
}

function probeGaps(
  content: string,
  chunk: UpdateFileChunk,
  index: number,
  resolved: ReadonlyArray<ResolvedChunk | undefined>,
  filePath: string,
): ResolvedChunk | undefined {
  const spans = resolved
    .filter((r): r is ResolvedChunk => r !== undefined)
    .map((r) => r.span)
    .sort((a, b) => a.start - b.start)
  const gaps: Array<[number, number]> = []
  let lo = 0
  for (const s of spans) {
    if (s.start > lo) gaps.push([lo, s.start])
    lo = Math.max(lo, s.end)
  }
  gaps.push([lo, content.length])

  let hit: Match | undefined
  let hits = 0
  for (const [glo, ghi] of gaps) {
    if (ghi <= glo) continue
    try {
      hit = resolveOne(content, chunk, index, glo, ghi, filePath)
      hits++
      if (hits > 1) return undefined
    } catch {
      // This gap cannot host the chunk (ambiguous, absent, or context bound
      // outside it). Gaps are tried independently; the final refusal names
      // the file-wide candidates.
      continue
    }
  }
  if (hits !== 1 || !hit) return undefined
  const match = hit
  return {
    chunk,
    index,
    span: { start: match.start, end: match.end, replacement: chunkReplacement(chunk) },
    fuzz: match.fuzz,
    via: match.via,
  }
}

/** Replacement for deriveNewContentsFromChunks' matching half. */
export function deriveContent(
  content: string,
  chunks: readonly UpdateFileChunk[],
  filePath: string,
): { content: string; spans: Span[]; warnings: string[] } {
  const resolvedChunks = resolveChunks(content, chunks, filePath)
  const spans = resolvedChunks.map((r) => ({
    ...r.span,
    replacement: adaptReplacementTerminators(content, r.span.start, r.span.end, r.span.replacement),
  }))
  const warnings = resolvedChunks
    .filter((r) => r.fuzz !== 0)
    .map(
      (r) =>
        `hunk ${r.index + 1} matched via ${r.via} rather than exactly; verify the result and send exact ` +
        `current-file context next time.`,
    )
  const next = spans
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((acc, s) => acc.slice(0, s.start) + s.replacement + acc.slice(s.end), content)
  return { content: next, spans, warnings }
}

export * as PatchResolve from "./resolve"
