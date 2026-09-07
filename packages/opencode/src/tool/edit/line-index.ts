// Terminator-preserving line index. Replaces the split("\n") model everywhere
// in the strategy layer.
//
// WHY: split("\n") destroys per-line terminators, which forces a whole-file
// re-encode on write (the D2 mixed-ending corruption) and makes terminator
// math a recurring bug source (the "gained trailing newline" regression).
// Here each line carries its own terminator, a replacement adopts the
// terminator of the LAST line it replaces, and untouched lines are never
// rewritten.
//
// SEMANTIC CHANGE vs the pre-span strategies (intentional): a file "a\n" is
// ONE line here, not two. split("\n") yields ["a", ""] and exposed a phantom
// final empty line that `line`/`insertAfter` could target. Line counts in
// errors and bounds checks shift by one for files ending in a newline.
// Appending is `appendFile` or `insertAt(lineCount)`, never "the phantom line".

export type Line = {
  /** 0-based. */
  index: number
  /** Offset of the first character of the line's text. */
  start: number
  /** Offset just past the text, i.e. at the terminator. */
  textEnd: number
  /** Offset just past the terminator. */
  end: number
  /** Line text WITHOUT its terminator. */
  text: string
  /** "\n" | "\r\n" | "\r" | "" (empty only for a final line with no newline). */
  terminator: string
}

export function buildLineIndex(content: string): Line[] {
  const lines: Line[] = []
  let start = 0
  let i = 0
  let index = 0

  while (i < content.length) {
    const ch = content[i]!
    if (ch === "\n") {
      lines.push({ index: index++, start, textEnd: i, end: i + 1, text: content.slice(start, i), terminator: "\n" })
      i += 1
      start = i
      continue
    }
    if (ch === "\r") {
      const crlf = content[i + 1] === "\n"
      const end = crlf ? i + 2 : i + 1
      lines.push({
        index: index++,
        start,
        textEnd: i,
        end,
        text: content.slice(start, i),
        terminator: crlf ? "\r\n" : "\r",
      })
      i = end
      start = i
      continue
    }
    i += 1
  }

  // Trailing partial line, or the single empty line of an empty file.
  if (start < content.length || lines.length === 0) {
    lines.push({
      index: index++,
      start,
      textEnd: content.length,
      end: content.length,
      text: content.slice(start),
      terminator: "",
    })
  }
  return lines
}

/** Most common terminator in the file. Used only for text the model supplies. */
export function dominantTerminator(lines: readonly Line[]): string {
  const counts = new Map<string, number>()
  for (const line of lines) {
    if (line.terminator === "") continue
    counts.set(line.terminator, (counts.get(line.terminator) ?? 0) + 1)
  }
  let best = "\n"
  let bestCount = 0
  for (const [term, count] of counts) {
    if (count > bestCount) {
      best = term
      bestCount = count
    }
  }
  return best
}

export function hasMixedTerminators(lines: readonly Line[]): boolean {
  const seen = new Set<string>()
  for (const line of lines) {
    if (line.terminator !== "") seen.add(line.terminator)
  }
  return seen.size > 1
}

/** 1-based line number containing `offset`. Binary search. */
export function lineNumberAt(lines: readonly Line[], offset: number): number {
  let lo = 0
  let hi = lines.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const line = lines[mid]!
    if (offset < line.start) hi = mid - 1
    else if (offset >= line.end && mid !== lines.length - 1) lo = mid + 1
    else return mid + 1
  }
  return lines.length
}

/**
 * Re-terminate model-supplied text for insertion at a given site.
 * Internal breaks adopt `ending`; the caller owns the trailing terminator.
 */
export function reterminate(newText: string, ending: string): string {
  const lf = newText.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  return ending === "\n" ? lf : lf.replaceAll("\n", ending)
}

export * as EditLineIndex from "./line-index"
