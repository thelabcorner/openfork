import type { Prompt } from "@/context/prompt-state"
import { snapshotPrompt } from "@/context/prompt-snapshot"
import { promptCorrectionProtectedRanges } from "./correction"

export type HarperProjection = {
  /** Sanitized input: structured identifiers and code never reach the linter. */
  text: string
  /** Scalar (Harper) indices mapped to visible-prompt UTF-16 offsets. */
  scalarToUtf16: readonly number[]
  /** Prefix count of protected scalar values, including preceding ones. */
  blockedPrefix: readonly number[]
  original: string
}

const MAX_LINT_CHARS = 8_000

/** Admission-level identity, not just the visible string. Structured reference
 * metadata and image identities must not be rebased by a stale diagnostic.
 * Returned only on demand; never persisted or sent to Harper.
 */
export function promptGrammarDraftIdentity(parts: Prompt): string | undefined {
  if (parts.length > 512) return undefined
  try {
    return JSON.stringify(snapshotPrompt(parts))
  } catch {
    return undefined
  }
}

/**
 * Do not send source code or structured references to Harper at all.
 * Maintain one Unicode scalar for every scalar in the original text, so its
 * Rust source spans can be mapped back into the UTF-16 contenteditable editor.
 * An all-space mask preserves newlines for grammar paragraph boundaries.
 */
export function projectPromptForHarper(parts: Prompt): HarperProjection | undefined {
  const blocked = promptCorrectionProtectedRanges(parts)
  if (!blocked) return undefined
  let original = ""
  for (const part of parts) {
    if (part.type === "image") continue
    original += part.content
    if (original.length > MAX_LINT_CHARS) return undefined
  }
  if (!original.trim()) return undefined

  const scalarToUtf16 = [0]
  const blockedPrefix = [0]
  const masked: string[] = []
  let utf16 = 0
  let range = 0
  for (const value of original) {
    while (range < blocked.length && blocked[range].end <= utf16) range++
    const reserved = range < blocked.length && blocked[range].start < utf16 + value.length &&
      blocked[range].end > utf16
    const hide = reserved || value === "\r"
    masked.push(hide && value !== "\n" ? " " : value)
    utf16 += value.length
    scalarToUtf16.push(utf16)
    blockedPrefix.push(blockedPrefix[blockedPrefix.length - 1] + (hide ? 1 : 0))
  }

  const text = masked.join("")
  if (!/[A-Za-z]{2}/.test(text)) return undefined
  return { text, scalarToUtf16, blockedPrefix, original }
}

export function harperSpanToUtf16(
  input: HarperProjection,
  start: number,
  end: number,
): { start: number; end: number; original: string } | undefined {
  if (!Number.isInteger(start) || !Number.isInteger(end) ||
    start < 0 || end <= start || end >= input.scalarToUtf16.length) return undefined
  if (input.blockedPrefix[end] !== input.blockedPrefix[start]) return undefined
  const from = input.scalarToUtf16[start]
  const to = input.scalarToUtf16[end]
  if (from === undefined || to === undefined || from >= to) return undefined
  return { start: from, end: to, original: input.original.slice(from, to) }
}

export type PromptGrammarIssue = {
  id: string
  start: number
  end: number
  original: string
  message: string
  category: "spelling" | "grammar"
  suggestions: readonly string[]
}

/** Applying a suggestion requires the *same* draft content and a text-only span. */
export function applyHarperSuggestion(parts: Prompt, issue: PromptGrammarIssue, replacement: string): {
  parts: Prompt
  cursor: number
} | undefined {
  if (!Number.isInteger(issue.start) || !Number.isInteger(issue.end) || issue.start < 0 ||
    issue.end <= issue.start || replacement.length > 500 || !issue.suggestions.includes(replacement)) return undefined
  const blocked = promptCorrectionProtectedRanges(parts)
  if (!blocked || blocked.some((span) => issue.start < span.end && issue.end > span.start)) return undefined
  let sourceOffset = 0
  let outputOffset = 0
  let matched = false
  const next: Prompt = []
  for (const part of parts) {
    if (part.type === "image") {
      next.push(part)
      continue
    }
    if (part.start !== sourceOffset || part.end !== sourceOffset + part.content.length) return undefined
    sourceOffset = part.end
    let content = part.content
    if (issue.start >= part.start && issue.end <= part.end && part.type === "text") {
      if (content.slice(issue.start - part.start, issue.end - part.start) !== issue.original || matched) return undefined
      content = content.slice(0, issue.start - part.start) + replacement +
        content.slice(issue.end - part.start)
      matched = true
    } else if (issue.start < part.end && issue.end > part.start) return undefined
    const updated = { ...part, content, start: outputOffset, end: outputOffset + content.length }
    // A word replacement shifts following mention locations, not their identity.
    if (updated.type === "file" && updated.source) {
      updated.source = { ...updated.source, text: {
        ...updated.source.text, value: updated.content,
        start: updated.start, end: updated.end,
      } }
    }
    next.push(updated)
    outputOffset = updated.end
  }
  if (!matched) return undefined
  return { parts: next, cursor: issue.start + replacement.length }
}
