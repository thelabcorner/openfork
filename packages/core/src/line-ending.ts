/** Line-ending helpers shared by the V2 edit/patch/write tools. */

export type Terminator = "\n" | "\r\n" | "\r"
export type Line = { readonly text: string; terminator: Terminator | "" }
export type TextMatch = { readonly start: number; readonly end: number }

export const normalizeNewlines = (text: string) =>
  text.includes("\r") ? text.replaceAll("\r\n", "\n").replaceAll("\r", "\n") : text

function terminatorAt(content: string, offset: number): Terminator | undefined {
  const code = content.charCodeAt(offset)
  if (code === 10) return "\n"
  if (code !== 13) return undefined
  return content.charCodeAt(offset + 1) === 10 ? "\r\n" : "\r"
}

function nextTerminator(content: string, from: number): Terminator | undefined {
  const lf = content.indexOf("\n", from)
  const cr = content.indexOf("\r", from)
  if (lf === -1 && cr === -1) return undefined
  const at = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr)
  return terminatorAt(content, at)
}

function previousTerminator(content: string, before: number): Terminator | undefined {
  if (before <= 0) return undefined
  const lf = content.lastIndexOf("\n", before - 1)
  const cr = content.lastIndexOf("\r", before - 1)
  const at = Math.max(lf, cr)
  if (at < 0) return undefined
  if (content.charCodeAt(at) === 10 && at > 0 && content.charCodeAt(at - 1) === 13) return "\r\n"
  return terminatorAt(content, at)
}

export function adaptReplacementTerminators(content: string, start: number, end: number, replacement: string): string {
  if (!replacement.includes("\n") && !replacement.includes("\r")) return replacement
  const logical = normalizeNewlines(replacement)
  if (!logical.includes("\n")) return logical

  const sourceTerminators: Terminator[] = []
  for (let i = start; i < end; i++) {
    const code = content.charCodeAt(i)
    if (code === 10) {
      sourceTerminators.push("\n")
      continue
    }
    if (code !== 13) continue
    if (content.charCodeAt(i + 1) === 10 && i + 1 < end) {
      sourceTerminators.push("\r\n")
      i++
    } else sourceTerminators.push("\r")
  }

  const spanEndsWithTerminator =
    end > start && (content.charCodeAt(end - 1) === 10 || content.charCodeAt(end - 1) === 13)
  const fallback =
    (spanEndsWithTerminator ? sourceTerminators[sourceTerminators.length - 1] : terminatorAt(content, end)) ??
    sourceTerminators[sourceTerminators.length - 1] ??
    nextTerminator(content, end) ??
    previousTerminator(content, start) ??
    "\n"

  let out = ""
  let cursor = 0
  let term = 0
  for (;;) {
    const at = logical.indexOf("\n", cursor)
    if (at === -1) return out + logical.slice(cursor)
    out += logical.slice(cursor, at) + (sourceTerminators[term++] ?? fallback)
    cursor = at + 1
  }
}

/**
 * Auto-heal a whole-file model write against an existing text file.
 *
 * New/empty/single-line files have no physical EOL policy to infer, so the
 * supplied bytes are preserved. Existing files with terminators reuse their
 * per-line terminators positionally; inserted extra lines fall back to the
 * nearest existing style. This preserves mixed-ending files instead of
 * flattening them to a whole-file dominant style.
 */
export function adaptWriteTerminators(existing: string, supplied: string): string {
  if (!supplied.includes("\n") && !supplied.includes("\r")) return supplied
  if (!existing.includes("\n") && !existing.includes("\r")) return supplied
  return adaptReplacementTerminators(existing, 0, existing.length, supplied)
}

function rawMatches(content: string, needle: string): TextMatch[] {
  const matches: TextMatch[] = []
  let offset = 0
  for (;;) {
    const start = content.indexOf(needle, offset)
    if (start === -1) return matches
    const end = start + needle.length
    matches.push({ start, end })
    offset = end
  }
}

function logicalMatchEnd(content: string, start: number, needle: string): number | undefined {
  let source = start
  let wanted = 0
  while (wanted < needle.length) {
    const expected = needle.charCodeAt(wanted)
    if (expected !== 10) {
      if (source >= content.length || content.charCodeAt(source) !== expected) return undefined
      source++
      wanted++
      continue
    }
    const actual = content.charCodeAt(source)
    if (actual === 10) source++
    else if (actual === 13) {
      source++
      if (content.charCodeAt(source) === 10) source++
    } else return undefined
    wanted++
  }
  return source
}

export function findLogicalMatches(content: string, suppliedNeedle: string): TextMatch[] {
  const needle = normalizeNewlines(suppliedNeedle)
  if (needle === "") return []
  if (!needle.includes("\n")) return rawMatches(content, needle)
  if (!content.includes("\r")) return rawMatches(content, needle)

  const anchor = needle.slice(0, needle.indexOf("\n"))
  const matches: TextMatch[] = []
  if (anchor !== "") {
    let offset = 0
    for (;;) {
      const start = content.indexOf(anchor, offset)
      if (start === -1) return matches
      const end = logicalMatchEnd(content, start, needle)
      if (end !== undefined) {
        matches.push({ start, end })
        offset = end
      } else offset = start + 1
    }
  }

  for (let start = 0; start < content.length; start++) {
    const code = content.charCodeAt(start)
    if (code !== 10 && code !== 13) continue
    if (code === 10 && start > 0 && content.charCodeAt(start - 1) === 13) continue
    const end = logicalMatchEnd(content, start, needle)
    if (end === undefined) continue
    matches.push({ start, end })
    start = end - 1
  }
  return matches
}

export function splitLinesPreservingTerminators(content: string): Line[] {
  if (content === "") return []
  const lines: Line[] = []
  let start = 0
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i)
    if (code !== 10 && code !== 13) continue
    const crlf = code === 13 && content.charCodeAt(i + 1) === 10
    lines.push({ text: content.slice(start, i), terminator: crlf ? "\r\n" : code === 13 ? "\r" : "\n" })
    if (crlf) i++
    start = i + 1
  }
  if (start < content.length) lines.push({ text: content.slice(start), terminator: "" })
  return lines
}

function nearbyTerminator(lines: ReadonlyArray<Line>, index: number): Terminator {
  for (let i = Math.min(index, lines.length - 1); i >= 0; i--) {
    const term = lines[i]?.terminator
    if (term) return term
  }
  for (let i = index + 1; i < lines.length; i++) {
    const term = lines[i]?.terminator
    if (term) return term
  }
  return "\n"
}

export function applyLineReplacements(
  source: ReadonlyArray<Line>,
  replacements: ReadonlyArray<readonly [start: number, remove: number, insert: ReadonlyArray<string>]>,
): string {
  const lines = source.map((line) => ({ ...line }))
  for (let r = replacements.length - 1; r >= 0; r--) {
    const [start, remove, insert] = replacements[r]!
    const removed = lines.slice(start, start + remove)
    if (remove === 0 && start === lines.length && lines.length > 0 && lines[lines.length - 1]!.terminator === "") {
      lines[lines.length - 1]!.terminator = nearbyTerminator(lines, lines.length - 1)
    }
    const fallback =
      removed.findLast((line) => line.terminator !== "")?.terminator || nearbyTerminator(lines, Math.max(0, start - 1))
    const tail = remove > 0 ? removed[removed.length - 1]?.terminator : fallback
    const added = insert.map((text, index) => {
      if (remove === 0) return { text, terminator: fallback }
      if (index === insert.length - 1) return { text, terminator: tail ?? fallback }
      return { text, terminator: removed[index]?.terminator || fallback }
    })
    lines.splice(start, remove, ...added)
  }
  return lines.map((line) => line.text + line.terminator).join("")
}
