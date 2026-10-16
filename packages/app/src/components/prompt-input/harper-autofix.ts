import type { Prompt } from "@/context/prompt-state"
import { correctPromptParts } from "./correction"
import { applyHarperSuggestion, type PromptGrammarIssue } from "./harper-projection"

export type AutoHarperChange = {
  id: string
  original: string
  replacement: string
  start: number
  end: number
}

/**
 * Opt-in automatic edits are deliberately narrower than Harper's suggestions.
 * Spelling must match both Harper's span and the curated, syntax-aware typo
 * dictionary. Basic grammar is restricted to Harper's exact indefinite-article
 * rule ("a" ↔ "an"), with a sole suggestion and intact word boundaries.
 *
 * Harper's first spelling suggestion is NOT a confidence estimate:
 * for "contienu", it may rank "content" before "continue".
 * Never silently accept a general top-ranked rewrite or agreement/style edit.
 */
export function proposeHarperAutofix(
  parts: Prompt,
  issues: readonly PromptGrammarIssue[],
  cursor: number | undefined,
  rejected: ReadonlySet<string>,
): { change: AutoHarperChange; parts: Prompt; cursor: number } | undefined {
  if (cursor === undefined || !Number.isInteger(cursor)) return undefined
  const vetted = correctPromptParts(parts)
  const text = parts.map((part) => part.type === "image" ? "" : part.content).join("")
  for (const issue of issues) {
    const original = issue.original.toLowerCase()
    if (rejected.has(original)) continue
    // Wait for the user to leave the entire token: never fight the caret, IME,
    // or a word still being typed.
    if (cursor >= issue.start && cursor <= issue.end) continue
    const previous = text[issue.start - 1] ?? ""
    const following = text[issue.end] ?? ""
    const sentencePunctuation = /[.!?,;:]/.test(following) &&
      (issue.end + 1 === text.length || /\s/.test(text[issue.end + 1]))
    if (/[A-Za-z0-9_\\u00C0-\\uFFFF]/.test(previous) ||
      /[A-Za-z0-9_\\u00C0-\\uFFFF]/.test(following) ||
      "/\\\\@#$%<>=:+_{}[]`!|~.-".includes(previous) ||
      ("/\\\\@#$%<>=:+_{}[]`!|~.-(".includes(following) && !sentencePunctuation)) continue

    const patch = issue.category === "spelling" && vetted.status === "corrected"
      ? vetted.patches.find((p) => p.start === issue.start && p.end === issue.end &&
        p.original === issue.original && issue.suggestions.includes(p.replacement))
      : undefined
    let replacement = patch?.replacement
    if (!replacement && issue.category === "grammar" &&
      issue.message === "Incorrect indefinite article." && issue.suggestions.length === 1) {
      const candidate = issue.suggestions[0]
      const pair = original === "a" && candidate?.toLowerCase() === "an" ||
        original === "an" && candidate?.toLowerCase() === "a"
      if (pair && candidate && issue.original === issue.original.toLowerCase() &&
        candidate === candidate.toLowerCase()) replacement = candidate
    }
    if (!replacement) continue
    const committed = applyHarperSuggestion(parts, issue, replacement)
    if (!committed) continue
    const caret = cursor > issue.end ? cursor + replacement.length - issue.original.length : cursor
    return {
      change: {
        id: `${issue.start}:${issue.original}:${replacement}`,
        original: issue.original,
        replacement,
        start: issue.start,
        end: issue.start + replacement.length,
      },
      parts: committed.parts,
      cursor: caret,
    }
  }
  return undefined
}

/**
 * Rejection is a local, exact inverse operation—not an inference, fuzzy search,
 * or a historical whole-prompt restore that could erase other corrections.
 */
export function rejectHarperAutofix(
  parts: Prompt,
  change: AutoHarperChange,
  cursor: number | undefined,
): { parts: Prompt; cursor: number } | undefined {
  const inverse: PromptGrammarIssue = {
    id: change.id,
    start: change.start,
    end: change.end,
    original: change.replacement,
    message: "Restore original spelling",
    category: "spelling",
    suggestions: [change.original],
  }
  const applied = applyHarperSuggestion(parts, inverse, change.original)
  if (!applied) return undefined
  const delta = change.original.length - change.replacement.length
  return {
    parts: applied.parts,
    cursor: cursor === undefined ? change.start + change.original.length :
      cursor > change.end ? cursor + delta : cursor >= change.start
        ? change.start + change.original.length : cursor,
  }
}


/**
 * Preserve rejected-word affordances across unrelated typing without risking
 * a fuzzy restoration. Rebase only when the structural topology and opaque
 * mention/attachment metadata remain stable; edits touching any corrected
 * token revoke that token's rejection affordance.
 */
export function rebaseHarperChanges(
  oldParts: Prompt,
  nextParts: Prompt,
  changes: readonly AutoHarperChange[],
): AutoHarperChange[] | undefined {
  if (oldParts.length !== nextParts.length) return undefined
  for (let i = 0; i < oldParts.length; i++) {
    const before = oldParts[i]
    const after = nextParts[i]
    if (!before || !after || before.type !== after.type) return undefined
    if (before.type === "text" || after.type === "text") continue
    const omitMutableOffsets = (part: Prompt[number]) => {
      if (part.type === "image") return part
      const { start: _start, end: _end, ...stable } = part
      if (stable.type !== "file" || !stable.source) return stable
      const { text: _text, ...source } = stable.source
      return { ...stable, source }
    }
    try {
      if (JSON.stringify(omitMutableOffsets(before)) !== JSON.stringify(omitMutableOffsets(after)))
        return undefined
    } catch {
      return undefined
    }
    if (before.type !== "image" && after.type !== "image" && before.content !== after.content)
      return undefined
  }
  const visible = (parts: Prompt) => parts.map((part) => part.type === "image" ? "" : part.content).join("")
  const oldText = visible(oldParts)
  const nextText = visible(nextParts)
  let prefix = 0
  while (prefix < oldText.length && prefix < nextText.length &&
    oldText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) prefix++
  let oldEnd = oldText.length
  let nextEnd = nextText.length
  while (oldEnd > prefix && nextEnd > prefix &&
    oldText.charCodeAt(oldEnd - 1) === nextText.charCodeAt(nextEnd - 1)) {
    oldEnd--
    nextEnd--
  }
  const delta = (nextEnd - prefix) - (oldEnd - prefix)
  return shiftHarperChanges(changes, prefix, oldEnd, delta)
    .filter((item) => {
      if (nextText.slice(item.start, item.end) !== item.replacement) return false
      const before = nextText[item.start - 1] ?? ""
      const after = nextText[item.end] ?? ""
      // Even a boundary insertion can turn a previously corrected word into
      // an identifier; its old inverse must then cease to be available.
      const identifierChar = /[A-Za-z0-9_\u00C0-\uFFFF]/
      return !identifierChar.test(before) && !identifierChar.test(after)
    })
}

/** Shift existing visible change locations after a separate disjoint edit. */
export function shiftHarperChanges(
  existing: readonly AutoHarperChange[],
  editStart: number,
  editEnd: number,
  delta: number,
): AutoHarperChange[] {
  return existing.flatMap((item) => {
    if (item.end <= editStart) return [item]
    if (item.start >= editEnd) return [{ ...item, start: item.start + delta, end: item.end + delta }]
    return [] // Overlap means the old correction is no longer safely reversible.
  })
}
