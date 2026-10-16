import {
  buildLineIndex,
  dominantTerminator,
  hasMixedTerminators,
  lineNumberAt,
  reterminate,
  type Line,
} from "./line-index"
import { orderSpans, type Span } from "./span"
import { describeDifference, normalizeNewlines } from "./text"
import { MatchError, resolveMatch, resolveReplacement } from "./match"

export type StrategyResult = {
  spans: Span[]
  applied: number
  strategy: string
  warnings: string[]
  oldPreview?: string
}

const PREVIEW_MAX = 200
const preview = (text: string) => (text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text)

function requireLine(lines: readonly Line[], line: number, what: string): Line {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    throw new Error(
      `${what} ${line} is out of range: the file has ${lines.length} line${lines.length === 1 ? "" : "s"}. ` +
        `Note a file ending in a newline has no trailing empty line — use appendFile to add at the end.`,
    )
  }
  return lines[line - 1]!
}

/**
 * Verification for line-targeted strategies is now MANDATORY.
 *
 * Line numbers are the weakest handle a model has; these strategies previously
 * carried the weakest verification in the file, which inverted the risk
 * profile. Now every line target must be confirmed by content.
 */
function verifyLine(line: Line, oldText: string, what: string): void {
  const expected = normalizeNewlines(oldText)
  const oneLine = expected.endsWith("\n") ? expected.slice(0, -1) : expected
  if (oneLine === "") throw new Error(`${what} verification must contain non-empty text from the target line.`)
  if (oneLine.includes("\n")) {
    throw new Error(`${what} verification must describe one line; use startLine/endLine or oldString for multi-line text.`)
  }
  if (line.text.includes(oneLine)) return
  throw new Error(
    `${what} ${line.index + 1} does not contain the expected text.\n${describeDifference(line.text, oneLine)}\n` +
      `Re-read the file if the content has moved.`,
  )
}

// Single line replace. oldText is REQUIRED: text currently on the line,
// confirming the target has not moved.
export function replaceLine(content: string, line: number, newText: string, oldText?: string): StrategyResult {
  const lines = buildLineIndex(content)
  const target = requireLine(lines, line, "line")
  if (oldText === undefined || oldText === "") {
    throw new Error(
      `line strategy requires oldText: the text currently on line ${line}, used to confirm the target has not ` +
        `moved. Bare line numbers are the least reliable way to address an edit.`,
    )
  }
  verifyLine(target, normalizeNewlines(oldText), "line")

  const ending = target.terminator || dominantTerminator(lines)
  const replacement = reterminate(newText, ending)
  if (replacement === target.text) {
    return { spans: [], applied: 0, strategy: "line", warnings: [], oldPreview: preview(target.text) }
  }
  return {
    spans: [{ start: target.start, end: target.textEnd, replacement }],
    applied: 1,
    strategy: "line",
    warnings: [],
    oldPreview: preview(target.text),
  }
}

// Range replace, with STRUCTURAL verification (D14).
export function replaceLines(
  content: string,
  startLine: number,
  endLine: number,
  newText: string,
  oldText?: string,
): StrategyResult {
  const lines = buildLineIndex(content)
  const first = requireLine(lines, startLine, "startLine")
  const last = requireLine(lines, endLine, "endLine")
  if (endLine < startLine) throw new Error(`Invalid range ${startLine}..${endLine}: endLine precedes startLine.`)

  const span = endLine - startLine + 1
  if (span > 5) {
    if (oldText === undefined || oldText === "") {
      throw new Error(
        `Range ${startLine}..${endLine} spans ${span} lines (>5) and requires oldText verification. ` +
          `oldText must begin with the range's first line and end with its last line.`,
      )
    }
    // Substring containment was near-vacuous: oldText:"return" satisfied a
    // 200-line range. Require the range's endpoints (D14).
    const wanted = normalizeNewlines(oldText).split("\n")
    const wantedFirst = wanted[0]!.trim()
    const wantedLast = wanted[wanted.length - 1]!.trim()
    if (first.text.trim() !== wantedFirst) {
      throw new Error(
        `Range ${startLine}..${endLine} verification failed at its first line.\n` +
          describeDifference(first.text.trim(), wantedFirst),
      )
    }
    if (last.text.trim() !== wantedLast) {
      throw new Error(
        `Range ${startLine}..${endLine} verification failed at its last line.\n` +
          describeDifference(last.text.trim(), wantedLast),
      )
    }
  } else if (oldText !== undefined && oldText !== "") {
    const joined = lines
      .slice(startLine - 1, endLine)
      .map((l) => l.text)
      .join("\n")
    if (!joined.includes(normalizeNewlines(oldText))) {
      throw new Error(
        `Range ${startLine}..${endLine} does not contain the expected text.\n` +
          describeDifference(joined, normalizeNewlines(oldText)),
      )
    }
  }

  const joined = lines
    .slice(startLine - 1, endLine)
    .map((l) => l.text)
    .join("\n")
  // Terminator of the LAST replaced line, not the first.
  const ending = last.terminator || dominantTerminator(lines)
  const replacement = reterminate(newText, ending)
  if (replacement === joined) {
    return { spans: [], applied: 0, strategy: "startLine/endLine", warnings: [], oldPreview: preview(joined) }
  }
  return {
    spans: [{ start: first.start, end: last.textEnd, replacement }],
    applied: 1,
    strategy: "startLine/endLine",
    warnings: [],
    oldPreview: preview(joined),
  }
}

/**
 * D11 — line deletion, which was previously IMPOSSIBLE: replaceLines(3,5,"")
 * produced [...before, "", ...after], collapsing the range to one blank line
 * rather than removing it.
 */
export function deleteLines(content: string, startLine: number, endLine: number, oldText?: string): StrategyResult {
  const lines = buildLineIndex(content)
  const first = requireLine(lines, startLine, "startLine")
  const last = requireLine(lines, endLine, "endLine")
  if (endLine < startLine) throw new Error(`Invalid range ${startLine}..${endLine}: endLine precedes startLine.`)

  const joined = lines
    .slice(startLine - 1, endLine)
    .map((l) => l.text)
    .join("\n")
  if (oldText === undefined || oldText === "") {
    throw new Error(
      `delete requires oldText confirming what is being removed (the first line of the range is enough for a ` +
        `single line; endpoints are required for ranges over 5 lines).`,
    )
  }
  const wanted = normalizeNewlines(oldText)
  if (!joined.includes(wanted) && first.text.trim() !== wanted.split("\n")[0]!.trim()) {
    throw new Error(
      `Delete range ${startLine}..${endLine} does not contain the expected text.\n` +
        describeDifference(joined, wanted),
    )
  }

  // Consume the range's own terminators. When deleting through the final line
  // of a file that has no trailing newline, also consume the PRECEDING
  // terminator so the file doesn't gain a trailing blank line.
  let start = first.start
  const end = last.end
  if (last.terminator === "" && startLine > 1) start = lines[startLine - 2]!.textEnd

  return {
    spans: [{ start, end, replacement: "" }],
    applied: 1,
    strategy: "delete",
    warnings: [],
    oldPreview: preview(joined),
  }
}

/**
 * D12 — insertion with prepend support. `line: 0` inserts before line 1.
 * The old insertAfter rejected 0, so prepend was not even expressible.
 *
 * D13 — an anchor is required for any non-boundary insertion.
 */
export function insertAt(content: string, line: number, newText: string, oldText?: string): StrategyResult {
  const lines = buildLineIndex(content)
  if (!Number.isInteger(line) || line < 0 || line > lines.length) {
    throw new Error(
      `insertAt line ${line} is out of range (0 = prepend, ${lines.length} = append; file has ${lines.length} lines).`,
    )
  }
  const ending = dominantTerminator(lines)

  if (line === 0) {
    const replacement = reterminate(newText, ending) + ending
    return { spans: [{ start: 0, end: 0, replacement }], applied: 1, strategy: "insertAt", warnings: [] }
  }

  const anchor = lines[line - 1]!
  if (oldText === undefined || oldText === "") {
    throw new Error(
      `insertAt requires oldText: the text currently on line ${line}, confirming the insertion point. ` +
        `A bare line number is the most drift-prone way to place an insertion.`,
    )
  }
  verifyLine(anchor, normalizeNewlines(oldText), "insertAt anchor line")

  // Anchor is the final line with no terminator: supply one before inserting.
  if (anchor.terminator === "") {
    const replacement = ending + reterminate(newText, ending)
    return {
      spans: [{ start: anchor.end, end: anchor.end, replacement }],
      applied: 1,
      strategy: "insertAt",
      warnings: [],
      oldPreview: preview(anchor.text),
    }
  }
  const replacement = reterminate(newText, anchor.terminator) + anchor.terminator
  return {
    spans: [{ start: anchor.end, end: anchor.end, replacement }],
    applied: 1,
    strategy: "insertAt",
    warnings: [],
    oldPreview: preview(anchor.text),
  }
}

export function appendToFile(content: string, newText: string): StrategyResult {
  const lines = buildLineIndex(content)
  const ending = dominantTerminator(lines)
  const lastLine = lines[lines.length - 1]!
  const body = reterminate(newText, ending)
  if (body === "") return { spans: [], applied: 0, strategy: "appendFile", warnings: [] }
  const needsTerminator = content.length > 0 && lastLine.terminator === ""
  const replacement = (needsTerminator ? ending : "") + body
  return {
    spans: [{ start: content.length, end: content.length, replacement }],
    applied: 1,
    strategy: "appendFile",
    warnings: [],
  }
}

/**
 * Anchored near-text replace. An optional occurrence index keeps a
 * legitimately repeated anchor usable; a refusal (not a split/join) answers
 * an oldText that appears twice on the target line.
 */
export function replaceNear(
  content: string,
  nearText: string,
  oldText: string,
  newText: string,
  occurrence?: number,
): StrategyResult {
  const lines = buildLineIndex(content)
  const needle = normalizeNewlines(nearText)
  if (needle === "") throw new Error("nearText anchor cannot be empty; provide a unique, non-empty anchor from the file.")
  if (needle.includes("\n")) throw new Error("nearText must be a single line; use oldString/newString for multi-line edits.")
  const anchors = lines.filter((l) => l.text.includes(needle))

  if (anchors.length === 0) {
    throw new Error(
      `nearText anchor not found: "${preview(needle)}" does not appear in the file. ` +
        `Provide exact anchor text from the current file content.`,
    )
  }
  let anchor: Line
  if (anchors.length === 1) {
    anchor = anchors[0]!
  } else if (occurrence !== undefined) {
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > anchors.length) {
      throw new Error(
        `nearText occurrence ${occurrence} is out of range: the anchor appears ${anchors.length} times ` +
          `(lines ${anchors.map((l) => l.index + 1).join(", ")}).`,
      )
    }
    anchor = anchors[occurrence - 1]!
  } else {
    throw new Error(
      `nearText matches ${anchors.length} lines (${anchors.map((l) => l.index + 1).join(", ")}). ` +
        `Provide a more specific anchor, or set occurrence to select one (1-based).`,
    )
  }

  const from = Math.max(0, anchor.index - 5)
  const to = Math.min(lines.length - 1, anchor.index + 5)
  const target = normalizeNewlines(oldText)
  if (target.includes("\n")) throw new Error("nearText oldText must be a single line; use oldString/newString for multi-line edits.")
  const candidates = lines.slice(from, to + 1).filter((l) => l.text.includes(target))

  if (candidates.length === 0) {
    throw new Error(
      `oldText not found within ±5 lines of the anchor (line ${anchor.index + 1}). ` +
        `Provide the exact text to replace, or widen the anchor.`,
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `oldText appears on multiple lines near the anchor (lines ${candidates.map((l) => l.index + 1).join(", ")}). ` +
        `Provide a more specific nearText or use the exact oldString/newString path.`,
    )
  }
  const line = candidates[0]!
  const idx = line.text.indexOf(target)
  if (line.text.indexOf(target, idx + target.length) !== -1) {
    throw new Error(
      `oldText appears more than once on line ${line.index + 1}. Include surrounding characters so the ` +
        `intended occurrence is unambiguous.`,
    )
  }
  const start = line.start + idx
  const replacement = reterminate(newText, line.terminator || dominantTerminator(lines))
  if (replacement === target) {
    return { spans: [], applied: 0, strategy: "nearText", warnings: [], oldPreview: preview(line.text) }
  }
  return {
    spans: [{ start, end: start + target.length, replacement }],
    applied: 1,
    strategy: "nearText",
    warnings: [],
    oldPreview: preview(line.text),
  }
}

// ── Batch (D4, D5, D25) ──────────────────────────────────────────────────────

export type BatchOpType =
  | { line: number; newText: string; oldText?: string }
  | { startLine: number; endLine: number; newText?: string; oldText?: string; delete?: boolean }
  | { oldString: string; newString?: string; newText?: string }
  | { insertAt: number; newText: string; oldText?: string; insertAfter?: number }
  | { insertAfter: number; newText: string; oldText?: string; insertAt?: number }
  | { appendFile: true; newText: string }
  | { nearText: string; oldText: string; newText: string; occurrence?: number }

/**
 * All ops are resolved against the ORIGINAL content, overlap-checked, then
 * applied in descending offset order.
 *
 * The old implementation threaded each op through a mutating `current`, so any
 * op that changed the line count shifted every later line target. Resolving
 * against original coordinates with reverse-order application removes the
 * whole drift class.
 */
export function applyBatch(content: string, edits: readonly BatchOpType[]): StrategyResult {
  if (edits.length === 0) throw new Error("edits must contain at least one operation.")
  const spans: Span[] = []
  const warnings: string[] = []
  let oldPreview: string | undefined
  let applied = 0

  edits.forEach((edit, i) => {
    const label = `edits[${i}]`
    let result: StrategyResult
    if ("oldString" in edit) {
      if (edit.newString !== undefined && edit.newText !== undefined && edit.newString !== edit.newText) {
        throw new Error(`${label}: conflicting newString and newText replacements.`)
      }
      const replacement = edit.newString ?? edit.newText
      if (typeof replacement !== "string")
        throw new Error(`${label}: an exact op requires newString (or its newText alias).`)
      // D28: reject key mixing rather than silently dropping the extra keys.
      for (const key of Object.keys(edit)) {
        if (!["oldString", "newString", "newText"].includes(key))
          throw new Error(`${label}: cannot combine oldString/newString with ${key}.`)
      }
      const resolved = resolveReplacement(content, edit.oldString, replacement)
      result = {
        spans: resolved.spans,
        applied: resolved.applied,
        strategy: "exact",
        warnings: resolved.warnings,
      }
    } else {
      const targets = ["line", "startLine", "endLine", "insertAt", "insertAfter", "appendFile", "nearText"]
      const present = targets.filter((key) => key in edit)
      const group = present[0]
      const allowed =
        group === "line"
          ? ["line", "oldText", "newText"]
          : group === "startLine" || group === "endLine"
            ? ["startLine", "endLine", "oldText", "newText", "delete"]
            : group === "insertAt" || group === "insertAfter"
              ? ["insertAt", "insertAfter", "oldText", "newText"]
              : group === "appendFile"
                ? ["appendFile", "newText"]
                : group === "nearText"
                  ? ["nearText", "oldText", "newText", "occurrence"]
                  : []
      for (const key of Object.keys(edit)) {
        if (!allowed.includes(key))
          throw new Error(`${label}: cannot combine ${group ?? "unknown strategy"} with ${key}.`)
      }
      if ("delete" in edit && edit.delete && edit.newText !== undefined)
        throw new Error(`${label}: cannot combine delete:true with newText.`)
      try {
        result = applyEditStrategy(content, edit)
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    spans.push(...result.spans)
    applied += result.applied
    warnings.push(...result.warnings.map((w) => `${label}: ${w}`))
    oldPreview = oldPreview ?? result.oldPreview
  })

  // D5 — overlap detection. Two ops touching one span is refused, never merged.
  const ordered = orderSpans(spans, "edits")
  return { spans: ordered, applied, strategy: "edits", warnings, oldPreview }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export type StrategyParams = {
  edits?: readonly BatchOpType[]
  line?: number
  startLine?: number
  endLine?: number
  insertAt?: number
  /** Deprecated alias for insertAt. */
  insertAfter?: number
  appendFile?: boolean
  nearText?: string
  occurrence?: number
  oldText?: string
  newText?: string
  delete?: boolean
}

export function validateStrategyShape(params: StrategyParams): string {
  const groups: string[] = []
  if (params.edits !== undefined) groups.push("edits")
  if (params.line !== undefined) groups.push("line")
  if (params.startLine !== undefined || params.endLine !== undefined) groups.push("startLine/endLine")
  if (params.insertAt !== undefined || params.insertAfter !== undefined) groups.push("insertAt")
  if (params.appendFile !== undefined) groups.push("appendFile")
  if (params.nearText !== undefined) groups.push("nearText")

  if (groups.length === 0) {
    throw new Error(
      "No edit strategy detected. Provide oldString/newString (exact path), or one of: edits, line, " +
        "startLine+endLine (with delete:true to remove lines), insertAt (0 = prepend), appendFile, nearText.",
    )
  }
  if (groups.length > 1) {
    throw new Error(`Ambiguous edit: multiple strategies present (${groups.join(", ")}). Provide exactly one.`)
  }

  const strategy = groups[0]!
  const allowed = {
    edits: ["edits"],
    line: ["line", "oldText", "newText"],
    "startLine/endLine": ["startLine", "endLine", "oldText", "newText", "delete"],
    insertAt: ["insertAt", "insertAfter", "oldText", "newText"],
    appendFile: ["appendFile", "newText"],
    nearText: ["nearText", "occurrence", "oldText", "newText"],
  }[strategy]!
  const mixed = Object.entries(params)
    .filter(([key, value]) => value !== undefined && !allowed.includes(key))
    .map(([key]) => key)
  if (mixed.length > 0) {
    throw new Error(`${strategy} strategy cannot be combined with ${mixed.join(", ")}. Provide one complete strategy.`)
  }
  if (strategy === "line") {
    if (params.newText === undefined) throw new Error("line strategy requires newText.")
    if (params.oldText === undefined || params.oldText === "") {
      throw new Error("line strategy requires oldText (non-empty expected text from the target line).")
    }
  }
  if (strategy === "startLine/endLine") {
    if (params.startLine === undefined || params.endLine === undefined) {
      throw new Error("startLine/endLine strategy requires both startLine and endLine.")
    }
    if (params.delete && params.newText !== undefined) {
      throw new Error("delete:true cannot be combined with newText; omit newText to remove the range.")
    }
    if (params.delete && (params.oldText === undefined || params.oldText === "")) {
      throw new Error("delete:true requires oldText confirming the range being removed.")
    }
    if (!params.delete && params.newText === undefined) {
      throw new Error("startLine/endLine strategy requires newText, or delete:true to remove the range.")
    }
  }
  if (strategy === "insertAt" && params.newText === undefined) throw new Error("insertAt strategy requires newText.")
  if (strategy === "insertAt" && params.insertAt !== undefined && params.insertAfter !== undefined && params.insertAt !== params.insertAfter) {
    throw new Error(`Conflicting insert targets: insertAt (${params.insertAt}) differs from insertAfter (${params.insertAfter}).`)
  }
  if (strategy === "insertAt") {
    const at = params.insertAt ?? params.insertAfter!
    if (at > 0 && (params.oldText === undefined || params.oldText === "")) {
      throw new Error(`insertAt ${at} requires oldText confirming the anchor line.`)
    }
    if (at === 0 && params.oldText !== undefined) {
      throw new Error("insertAt:0 prepends before the file and has no anchor; omit oldText.")
    }
  }
  if (strategy === "appendFile") {
    if (params.appendFile !== true) throw new Error("appendFile strategy requires appendFile:true.")
    if (params.newText === undefined) throw new Error("appendFile strategy requires newText.")
  }
  if (strategy === "nearText") {
    if (params.nearText === "") throw new Error("nearText anchor cannot be empty; provide a unique, non-empty anchor from the file.")
    if (params.newText === undefined) throw new Error("nearText strategy requires newText.")
    if (params.oldText === undefined || params.oldText === "") throw new Error("nearText strategy requires oldText.")
  }
  if (strategy === "edits" && params.edits?.length === 0) throw new Error("edits must contain at least one operation.")
  return strategy
}

export function applyEditStrategy(content: string, params: StrategyParams): StrategyResult {
  const strategy = validateStrategyShape(params)
  const newText = params.newText === undefined ? undefined : normalizeNewlines(params.newText)
  const oldText = params.oldText === undefined ? undefined : normalizeNewlines(params.oldText)

  switch (strategy) {
    case "edits":
      return applyBatch(content, params.edits!)
    case "line":
      return replaceLine(content, params.line!, newText!, oldText)
    case "startLine/endLine": {
      if (params.delete) {
        return deleteLines(content, params.startLine!, params.endLine!, oldText)
      }
      return replaceLines(content, params.startLine!, params.endLine!, newText!, oldText)
    }
    case "insertAt": {
      // insertAfter is retained as a deprecated alias with identical semantics.
      const at = params.insertAt ?? params.insertAfter!
      return insertAt(content, at, newText!, oldText)
    }
    case "appendFile":
      return appendToFile(content, newText!)
    case "nearText": {
      return replaceNear(content, params.nearText!, oldText!, newText!, params.occurrence)
    }
    default:
      throw new Error(`Unsupported strategy: ${strategy}`)
  }
}

export { MatchError, resolveMatch, hasMixedTerminators, lineNumberAt }
export * as EditStrategy from "./strategy"
