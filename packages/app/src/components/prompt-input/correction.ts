import type { Prompt } from "@/context/prompt"
import { normalizePromptCorrectionRules } from "@/utils/prompt-correction-policy"

/** Deterministic, local-first spelling patches for explicitly opted-in human prose. */
const TYPO: Readonly<Record<string, string>> = Object.freeze({
  contienu: "continue", contineu: "continue", conitnue: "continue", continute: "continue",
  reasearch: "research", resaerch: "research", reserach: "research", reasearching: "researching",
  comprehensivley: "comprehensively", comprehensuvely: "comprehensively",
  comprehensuiveky: "comprehensively", comprehenisvely: "comprehensively",
  exhasutively: "exhaustively", exhuastively: "exhaustively", exhastively: "exhaustively",
  architecure: "architecture", architechture: "architecture", architechtural: "architectural",
  implementaiton: "implementation", implemenation: "implementation", implemetation: "implementation",
  optimzation: "optimization", optimzations: "optimizations", optmization: "optimization",
  perfomance: "performance", performace: "performance",
  dependecy: "dependency", depedency: "dependency",
  succcessfully: "successfully", succesfully: "successfully", sucessfully: "successfully",
  definately: "definitely", becuase: "because", recieve: "receive", recieved: "received",
  seperate: "separate", seperately: "separately", occured: "occurred",
  teh: "the", hte: "the",
})

/** Cheap candidate filter. No boundary constraint: false positives are safe,
 * but missing a correctable token would incorrectly skip the full scan. */
const KNOWN_TYPO_CANDIDATE = new RegExp(Object.keys(TYPO).join("|"), "i")

export const PROMPT_CORRECTION_DICTIONARY_VERSION = "known-typos-1"
export type PromptCorrectionPatch = {
  /** Original visible-prompt UTF-16 half-open range. */
  start: number
  end: number
  original: string
  replacement: string
  rule: string
}
export type PromptCorrectionAdmission = {
  /** Only a trusted first-party composer supplies enabled=true. */
  enabled: boolean
  mode: "normal" | "shell"
  skip?: boolean
  humanInterjection?: boolean
}

/** A source gate independent of lexical correction: no runtime-wide mutation. */
export function shouldCorrectPromptSubmission(input: PromptCorrectionAdmission): boolean {
  return input.enabled && input.mode === "normal" && !input.skip && !input.humanInterjection
}

export type PromptCorrectionOptions = {
  /** Opt-out list has veto precedence over the built-in known-error dictionary. */
  excludedWords?: readonly string[]
  /** User-approved exact word pairs. Still subject to protected-span and polarity vetoes. */
  userReplacements?: Readonly<Record<string, string>>
  /** English dictionary; abstain on other explicitly chosen UI locales. */
  locale?: string
  /** Optional reviewed subset of original UTF-16 patch starts. No preview state
   * is persisted; absent means apply every eligible deterministic correction. */
  selectedPatchStarts?: ReadonlySet<number>
}
export type PromptCorrectionResult = {
  original: Prompt
  effective: Prompt
  patches: readonly PromptCorrectionPatch[]
  status: "unchanged" | "corrected" | "bypassed"
}
type Span = { start: number; end: number }
const MAX_CHARS = 20_000
const MAX_PARTS = 4_096
const MAX_PATCHES = 128

/** Merge the protected-byte intervals once instead of scanning all of them per token. */
function mergeSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Span[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (!last || span.start > last.end) {
      merged.push({ start: span.start, end: span.end })
      continue
    }
    last.end = Math.max(last.end, span.end)
  }
  return merged
}

/**
 * Linear-time markdown link mask. Repeated unclosed '[' must not make a
 * backtracking regexp retry an increasingly long suffix on the send path.
 *
 * Strictly protect valid [label](destination) syntax and conservatively guard
 * the rest of an unterminated destination rather than edit its contents.
 */
function protectMarkdownLinks(text: string, add: (start: number, end: number) => void) {
  let open = -1
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 91) {
      // Preserve the earliest unmatched opener, including nested labels.
      // Protecting too much is safer than editing inside an ambiguous link.
      if (open < 0) open = i
      continue
    }
    if (code === 10) {
      open = -1
      continue
    }
    if (code !== 93) continue
    if (open < 0 || open === i - 1 || text.charCodeAt(i + 1) !== 40) {
      open = -1
      continue
    }
    const destination = i + 2
    const close = text.indexOf(")", destination)
    if (close < 0) {
      add(open, text.length)
      return
    }
    add(open, close + 1)
    i = close
    open = -1
  }
}

function protectedSyntax(text: string): Span[] {
  const ranges: Span[] = []
  const add = (start: number, end: number) => { if (end > start) ranges.push({ start, end }) }

  // Stateful, including unclosed Markdown fences; malformed markup is protected.
  let fence: { char: string; width: number; start: number } | undefined
  let pos = 0
  while (pos < text.length) {
    const next = text.indexOf("\n", pos)
    const end = next < 0 ? text.length : next + 1
    const line = text.slice(pos, end)
    const delimiter = /^[ \t]{0,3}(\x60{3,}|~{3,})/.exec(line)
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.char && delimiter[1].length >= fence.width &&
          line.slice(delimiter[0].length).trim().length === 0) {
        add(fence.start, end)
        fence = undefined
      }
    } else if (delimiter) fence = { char: delimiter[1][0], width: delimiter[1].length, start: pos }
    else if (/^(?: {4,}|\t|\s*(?:\$ |>>> |\/\/|\/\*|\*\/|> |(?:const|let|var|import|export|function|class|return)\s|(?:npm|pnpm|bun|git|node|cargo|python|powershell|curl)\s|(?:diff --git|@@ |--- a\/|\+\+\+ b\/)|(?:ERROR|WARN|DEBUG|TRACE)\b|\{[\s"]|<\/?[\w-]+))/i.test(line)) add(pos, end)
    pos = end
  }
  if (fence) add(fence.start, text.length)

  const ticks = /\x60+/g
  let opening: { start: number; width: number } | undefined
  for (const match of text.matchAll(ticks)) {
    if (!opening) opening = { start: match.index, width: match[0].length }
    else if (opening.width === match[0].length) {
      add(opening.start, match.index + match[0].length)
      opening = undefined
    }
  }
  if (opening) add(opening.start, text.length)

  const literals = [
    /(?:https?:\/\/|file:\/\/|mailto:)\S+/gi,
    /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,
    /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g,
    /(?:^|[\s(])(?:\.{1,2}\/|~\/|\/(?:home|usr|var|tmp|mnt|etc)\/)[^\s"'<>]+/gm,
    /(?:^|[\s(])--?[A-Za-z][\w-]*/gm,
    /\$\{[^}]*\}|\{\{[^}]*\}\}/g,
    /\b(?:ses|msg|swm|proc)_[A-Za-z0-9_-]+\b/g,
    /\b(?:[a-f\d]{32,}|sha256:[a-f\d]+)\b/gi,
    /<\/?[A-Za-z][^>]*>/g,
    /"(?:\\.|[^"\\\n])*(?:"|$)/gm,
    /(?<![\p{L}\p{N}])'(?:\\.|[^'\\\n])*(?:'|$)/gmu,
    /“[^”\n]*(?:”|$)|‘[^’\n]*(?:’|$)|«[^»\n]*(?:»|$)/gm,
    /^[ \t]*(?:[A-Za-z_$][\w$.-]*|"[^"]+"|'[^']+')\s*[:=]\s*[^\n]*$/gm,
    /^[ \t]*(?:\[|{)[^\n]*$/gm,
    /^[ \t]*\|[^\n]*\|[ \t]*$/gm,
    /^[ \t]*(?:\d{4}-\d\d-\d\d[T ]\d\d:\d\d|(?:Traceback|at\s+\S+|Error:|Exception:))[^\n]*$/gm,
  ]
  for (const pattern of literals)
    for (const match of text.matchAll(pattern)) add(match.index, match.index + match[0].length)
  protectMarkdownLinks(text, add)
  return ranges
}

/**
 * Shared syntax isolation for inline grammar engines.
 * Exposes ranges, never repairs prose or changes submission behavior.
 * undefined means abstain: unsupported/ambiguous prompt topology.
 */
export function promptCorrectionProtectedRanges(parts: Prompt): ReadonlyArray<Span> | undefined {
  if (parts.length > MAX_PARTS) return undefined
  let text = ""
  let expected = 0
  const structural: Span[] = []
  for (const part of parts) {
    if (part.type === "image") continue
    if (part.start !== expected || part.end !== expected + part.content.length) return undefined
    if (part.type !== "text") structural.push({ start: part.start, end: part.end })
    text += part.content
    expected = part.end
    if (text.length > MAX_CHARS) return undefined
  }
  if (!text || text.trimStart().startsWith("/") ||
    /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/u.test(text) ||
    /\r(?!\n)/.test(text)) return undefined
  const spans = structural.concat(protectedSyntax(text))
  if (/^---[ \t]*\r?\n/.test(text)) {
    const closing = /^---[ \t]*\r?$/gm
    closing.lastIndex = text.indexOf("\n") + 1
    const matched = closing.exec(text)
    spans.push({ start: 0, end: matched ? matched.index + matched[0].length : text.length })
  }
  return mergeSpans(spans)
}

function replacement(word: string, custom: ReadonlyMap<string, string>): string | undefined {
  if (word !== word.toLowerCase() && word !== word[0].toUpperCase() + word.slice(1).toLowerCase()) return undefined
  const key = word.toLowerCase()
  // A plain frozen object still inherits keys such as constructor/toString.
  const correct = custom.get(key) ?? (Object.hasOwn(TYPO, key) ? TYPO[key] : undefined)
  if (!correct) return undefined
  return word[0] === word[0].toUpperCase() ? correct[0].toUpperCase() + correct.slice(1) : correct
}

function identifierBoundary(text: string, start: number, end: number) {
  const before = text[start - 1] ?? ""
  const after = text[end] ?? ""
  // ASCII regex tokens must never split a surrounding Unicode identifier.
  if (/[\p{L}\p{M}\p{N}]/u.test(before) || /[\p{L}\p{M}\p{N}]/u.test(after)) return true
  if (before && "/\\@#$%<>=:+_{}[]`!|~.-".includes(before)) return true
  const sentenceExclamation = after === "!" && (!text[end + 1] || /\s/.test(text[end + 1]))
  if (after && "/\\@#$%<>=:+_{}[]`!|~-(".includes(after) && !sentenceExclamation) return true
  if (after === "." && /[A-Za-z0-9]/.test(text[end + 1] ?? "")) return true
  return /\d/.test(before) || /\d/.test(after)
}
/** No side effects: unchanged original on *any* invalid offsets or unsafe patches. */
export function correctPromptParts(
  parts: Prompt,
  enabled = true,
  options: PromptCorrectionOptions = {},
): PromptCorrectionResult {
  const unchanged = (status: "unchanged" | "bypassed"): PromptCorrectionResult => ({
    original: parts, effective: parts, patches: [], status,
  })
  if (!enabled || (options.locale && !/^en(?:$|[-_])/i.test(options.locale))) return unchanged("bypassed")
  if (parts.length > MAX_PARTS) return unchanged("bypassed")
  try {
    // Reject oversized inputs before concatenating a potentially enormous
    // draft. This also bounds all subsequent regex and remapping allocations.
    let length = 0
    for (const part of parts) {
      if (!part || typeof part !== "object") return unchanged("bypassed")
      if (part.type === "image") continue
      if (typeof part.content !== "string") return unchanged("bypassed")
      length += part.content.length
      if (length > MAX_CHARS) return unchanged("bypassed")
    }
    const text = parts.map((part) => ("content" in part ? part.content : "")).join("")
    if (!text || text.trimStart().startsWith("/")) return unchanged("bypassed")
    // Directional/zero-width formatting can make displayed and indexed text
    // disagree; refuse to change any characters in such a draft.
    if (/[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/u.test(text)) return unchanged("bypassed")
    // Rare standalone carriage returns invalidate the line grammar used by
    // Markdown fences and quote guards. Refuse to normalize rather than parse
    // code or prose under an ambiguous notion of a line boundary.
    if (/\r(?!\n)/.test(text)) return unchanged("bypassed")
    let position = 0
    const textSpans: Span[] = []
    const structural: Span[] = []
    for (const part of parts) {
      if (part.type === "image") continue
      if (part.start !== position || part.end !== position + part.content.length) return unchanged("bypassed")
      const span = { start: part.start, end: part.end }
      if (part.type === "text") textSpans.push(span)
      else structural.push(span)
      position = part.end
    }
    if (position !== text.length) return unchanged("bypassed")

    // Most authored prompts contain no known typo. Avoid expensive syntax
    // parsing, protection sorting, and remapping entirely on that hot path.
    // Candidate filtering is deliberately permissive; structural and contextual
    // guards still make the final decision when a candidate is present.
    const validUserReplacements = normalizePromptCorrectionRules(options.userReplacements)
    const customKeys = Object.keys(validUserReplacements)
    const candidate = parts.some((part) => {
      if (part.type !== "text") return false
      if (KNOWN_TYPO_CANDIDATE.test(part.content)) return true
      if (!customKeys.length) return false
      const lower = part.content.toLowerCase()
      return customKeys.some((key) => lower.includes(key))
    })
    if (!candidate) return unchanged("unchanged")
    const protectedSpans = structural.concat(protectedSyntax(text))
    // YAML frontmatter is declarative data, not prose, even if a known typo
    // happens to occur inside a value. An unclosed block protects to EOF.
    if (/^---[ \t]*\r?\n/.test(text)) {
      const close = /^---[ \t]*\r?$/gm
      close.lastIndex = text.indexOf("\n") + 1
      const end = close.exec(text)
      protectedSpans.push({ start: 0, end: end ? end.index + end[0].length : text.length })
    }
    const blocked = mergeSpans(protectedSpans)
    const custom = new Map(Object.entries(validUserReplacements))
    const exclusions = new Set((options.excludedWords ?? []).slice(0, 128)
      .filter((word): word is string => typeof word === "string" && word.length <= 40)
      .map((word) => word.toLowerCase()))
    const patches: PromptCorrectionPatch[] = []
    let textSpanIndex = 0
    let blockedIndex = 0
    let lineStart = 0
    let nextNewline = text.indexOf("\n")
    for (const match of text.matchAll(/[A-Za-z]+/g)) {
      const start = match.index
      const end = start + match[0].length
      while (nextNewline >= 0 && nextNewline < start) {
        lineStart = nextNewline + 1
        nextNewline = text.indexOf("\n", lineStart)
      }
      // Capitalized proper names are particularly risky. Only correct title
      // case at the start of a prompt or line; never mid-sentence names.
      if (match[0][0] !== match[0][0].toLowerCase() && start > 0 &&
          text.slice(lineStart, start).trim().length > 0) continue
      if (exclusions.has(match[0].toLowerCase())) continue
      const correct = replacement(match[0], custom)
      if (!correct || correct === match[0] || identifierBoundary(text, start, end)) continue
      while (textSpanIndex < textSpans.length && textSpans[textSpanIndex].end <= start) textSpanIndex++
      const textSpan = textSpans[textSpanIndex]
      if (!textSpan || start < textSpan.start || end > textSpan.end) continue
      while (blockedIndex < blocked.length && blocked[blockedIndex].end <= start) blockedIndex++
      const protectedSpan = blocked[blockedIndex]
      if (protectedSpan && start < protectedSpan.end && end > protectedSpan.start) continue
      if (options.selectedPatchStarts && !options.selectedPatchStarts.has(start)) continue
      patches.push({ start, end, original: match[0], replacement: correct, rule: custom.has(match[0].toLowerCase())
        ? "user:" + match[0].toLowerCase() : match[0].toLowerCase() })
      if (patches.length > MAX_PATCHES) return unchanged("bypassed")
    }
    if (!patches.length) return unchanged("unchanged")

    let offset = 0
    let patchIndex = 0
    const effective = parts.map((part) => {
      if (part.type === "image") return part
      let content = part.content
      if (part.type === "text") {
        const edits: PromptCorrectionPatch[] = []
        while (patchIndex < patches.length && patches[patchIndex].start < part.end) {
          const patch = patches[patchIndex++]
          if (patch.start >= part.start && patch.end <= part.end) edits.push(patch)
        }
        if (edits.length) {
          // Apply sorted non-overlapping edits in one pass. Repeated splice-like
          // replacements needlessly recopy the whole string per patch.
          const fragments: string[] = []
          let cursor = 0
          for (const patch of edits) {
            const begin = patch.start - part.start
            const end = patch.end - part.start
            if (begin < cursor || content.slice(begin, end) !== patch.original)
              throw new Error("Stale or overlapping correction span")
            fragments.push(content.slice(cursor, begin), patch.replacement)
            cursor = end
          }
          fragments.push(content.slice(cursor))
          content = fragments.join("")
        }
      }
      const result = { ...part, content, start: offset, end: offset + content.length }
      if (result.type === "file" && result.source) {
        // Keep the *internal* saved reference metadata consistent as well as
        // the offsets reconstructed by buildRequestParts at transport time.
        // Do not rewrite the source object owned by the original draft.
        result.source = {
          ...result.source,
          text: {
            ...result.source.text,
            value: result.content,
            start: result.start,
            end: result.end,
          },
        }
      }
      offset = result.end
      return result
    }) as Prompt
    if (effective.length !== parts.length ||
      effective.some((part, i) => {
        const before = parts[i]
        if (part.type !== before.type) return true
        if (part.type === "image" || before.type === "image") return part !== before
        return before.type !== "text" && part.content !== before.content
      })) return unchanged("bypassed")
    return { original: parts, effective, patches, status: "corrected" }
  } catch {
    return unchanged("bypassed")
  }
}
