import * as path from "path"
import { Effect } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { UpdateFileChunk } from "../patch"

// Failure-context helpers for file-mutating tools (edit/write/patch/apply_patch).
//
// When an edit fails (oldString not found, ambiguous match, hunk mismatch), the
// tool already holds the file's current content in memory. These helpers turn
// that content into a bounded, line-numbered excerpt of the region the caller
// was trying to touch, so the model can self-correct without a redundant read.

const MIN_FUZZY_NEEDLE_CHARS = 8
// 0.5 keeps the common stale-edit case (2-line block, one drifted line) visible;
// below that a "nearest region" is more likely coincidental than helpful.
const MIN_REGION_SCORE = 0.5
const MAX_SNIPPET_LINES = 14
const SNIPPET_CONTEXT_LINES = 2
const MAX_SNIPPET_LINE_CHARS = 160
const MAX_OCCURRENCES_LISTED = 10

export type Region = { start: number; end: number; score: number }

const normalizeLine = (line: string) => line.trim().replace(/\s+/g, " ")

const displayLine = (line: string) => {
  const stripped = line.endsWith("\r") ? line.slice(0, -1) : line
  return stripped.length > MAX_SNIPPET_LINE_CHARS ? `${stripped.slice(0, MAX_SNIPPET_LINE_CHARS)}…` : stripped
}

// Locate the file region most similar to the needle (whitespace-insensitive,
// line-aligned sliding window). Returns undefined below MIN_REGION_SCORE.
export function bestRegion(content: string, needleLines: readonly string[]): Region | undefined {
  const lines = content.split("\n")
  const pattern = needleLines.map(normalizeLine)
  const size = pattern.length
  if (size === 0 || size > lines.length || pattern.every((l) => l === "")) return undefined

  let best: Region | undefined
  for (let i = 0; i <= lines.length - size; i++) {
    let matches = 0
    for (let j = 0; j < size; j++) {
      if (normalizeLine(lines[i + j]!) === pattern[j]) matches++
    }
    const score = matches / size
    if (!best || score > best.score) best = { start: i, end: i + size - 1, score }
    if (score === 1) break
  }
  if (!best || best.score < MIN_REGION_SCORE) return undefined
  return best
}

function lineOfIndex(content: string, index: number): number {
  let line = 0
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") line++
  }
  return line
}

// 1-based line numbers of every exact occurrence of needle (capped scan).
export function occurrenceLineNumbers(content: string, needle: string): number[] {
  const out: number[] = []
  let from = 0
  while (out.length <= MAX_OCCURRENCES_LISTED) {
    const index = content.indexOf(needle, from)
    if (index === -1) break
    out.push(lineOfIndex(content, index) + 1)
    from = index + Math.max(needle.length, 1)
  }
  return out
}

// Numbered excerpt covering region ± context, hard-capped at MAX_SNIPPET_LINES.
export function renderRegion(content: string, region: { start: number; end: number }): string {
  const lines = content.split("\n")
  const first = Math.max(0, region.start - SNIPPET_CONTEXT_LINES)
  const last = Math.min(lines.length - 1, first + MAX_SNIPPET_LINES - 1)
  const width = String(last + 1).length
  const rendered: string[] = []
  for (let i = first; i <= last; i++) {
    const marker = i === region.start ? ">" : " "
    rendered.push(`${marker}${String(i + 1).padStart(width)} | ${displayLine(lines[i]!)}`)
  }
  if (last < region.end) rendered.push(`${" ".repeat(width + 3)}… (${region.end - last} more matched lines)`)
  return rendered.join("\n")
}

const isSignificantNeedle = (needleLines: readonly string[]) =>
  needleLines.reduce((sum, l) => sum + normalizeLine(l).length, 0) >= MIN_FUZZY_NEEDLE_CHARS

const fuzzyExcerpt = (content: string, needleLines: readonly string[]): string | undefined => {
  if (!isSignificantNeedle(needleLines)) return undefined
  const region = bestRegion(content, needleLines)
  if (!region) return undefined
  return renderRegion(content, region)
}

// Hint for edit-tool conflicts: exact multi-match → occurrence lines + first
// site; otherwise the closest fuzzy region. undefined = nothing worth showing.
export function replaceConflictHint(input: { content: string; needle: string }): string | undefined {
  const occurrences = occurrenceLineNumbers(input.content, input.needle)
  if (occurrences.length > 1) {
    const listed = occurrences.slice(0, MAX_OCCURRENCES_LISTED)
    const suffix = occurrences.length > listed.length ? `, … (+${occurrences.length - listed.length} more)` : ""
    const first = { start: listed[0]! - 1, end: listed[0]! - 1 }
    return [
      `The target text currently appears at line(s): ${listed.join(", ")}${suffix}. Include more surrounding lines to disambiguate.`,
      "",
      renderRegion(input.content, first),
    ].join("\n")
  }
  const excerpt = fuzzyExcerpt(input.content, input.needle.split("\n"))
  if (!excerpt) return undefined
  return ["Current file content closest to your target:", "", excerpt].join("\n")
}

// Hint for the disproportionate-match guard: show the span the fuzzy match
// expanded to, so the caller can resend it verbatim instead of re-reading.
export function spanConflictHint(input: { content: string; span: string }): string {
  const start = lineOfIndex(input.content, input.content.indexOf(input.span))
  return renderRegion(input.content, { start, end: start + input.span.split("\n").length - 1 })
}

// Recover the expected lines from a deriveNewContentsFromChunks failure and
// attach the current-file region nearest them. Falls back to the first chunk
// with old lines when the message shape is unrecognized.
export function patchConflictDetail(input: { content: string; chunks: readonly UpdateFileChunk[]; error: unknown }): string {
  const base = input.error instanceof Error ? input.error.message : String(input.error)
  const excerpt = fuzzyExcerpt(input.content, expectedLinesFrom(base, input.chunks))
  return excerpt ? `${base}\n\nCurrent file content closest to the expected lines:\n\n${excerpt}` : base
}

function expectedLinesFrom(message: string, chunks: readonly UpdateFileChunk[]): string[] {
  const block = message.match(/Failed to find expected lines in [^:]*:\n([\s\S]*)/)
  if (block?.[1]) return block[1].split("\n")
  const context = message.match(/Failed to find context '([\s\S]*?)' in /)
  if (context?.[1]) return [context[1]]
  return chunks.find((c) => c.old_lines.length > 0)?.old_lines ?? []
}

// Sibling listing for "file not found" failures — catches wrong-path mistakes
// (e.g. src/foo.ts vs src/foo/index.ts) without a separate ls/glob roundtrip.
export const missingFileHint = Effect.fn("Conflict.missingFileHint")(function* (afs: FSUtil.Interface, filePath: string) {
  const entries = yield* afs.readDirectoryEntries(path.dirname(filePath)).pipe(Effect.catch(() => Effect.succeed([])))
  if (entries.length === 0) return undefined
  const names = entries.slice(0, 24).map((e) => (e.type === "directory" ? `${e.name}/` : e.name))
  const suffix = entries.length > names.length ? ` … (+${entries.length - names.length} more)` : ""
  return `existing entries in ${path.dirname(filePath)}: ${names.join(", ")}${suffix}`
})

export * as Conflict from "./conflict"
