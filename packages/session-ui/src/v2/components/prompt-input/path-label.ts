export type PromptInputV2LabelSegment = { text: string; matched: boolean }

/**
 * Split a path label into the primary basename and its parent path for dense
 * picker rendering. Display separators are normalized to `/`, but offsets stay
 * 1:1 with the source label so server-provided highlight positions remain valid.
 *
 * Directory results deserve special handling: a trailing slash is structural,
 * not part of the basename. Treating `agent-skills\\` as an ordinary filename
 * makes the basename start at index 1 when a filename helper trims that slash,
 * which is what produced rows such as `gent-skills\\  a` on Windows.
 */
export function splitPromptInputV2PathSegments(
  label: string,
  positions: number[] | undefined,
  query: string | undefined,
): { dirSegments: PromptInputV2LabelSegment[]; nameSegments: PromptInputV2LabelSegment[] } | undefined {
  if (!label) return undefined

  const normalized = label.replaceAll("\\", "/")
  const isDirectory = /\/$/.test(normalized)
  const display = isDirectory ? normalized.replace(/\/+$/, "") : normalized
  if (!display) return undefined

  const slash = display.lastIndexOf("/")
  // Root-level files need no two-column path treatment. Root-level directories
  // still come through here so their trailing separator is omitted visually.
  if (slash < 0 && !isDirectory) return undefined

  const nameStart = slash + 1
  const usablePositions = positions?.filter((position) => position >= 0 && position < display.length)
  const segments = highlightPromptInputV2Label(display, usablePositions, query?.replaceAll("\\", "/"))
  const dirSegments: PromptInputV2LabelSegment[] = []
  const nameSegments: PromptInputV2LabelSegment[] = []
  let offset = 0

  for (const segment of segments) {
    const start = offset
    const end = offset + segment.text.length
    offset = end
    if (end <= nameStart) {
      dirSegments.push(segment)
      continue
    }
    if (start >= nameStart) {
      nameSegments.push(segment)
      continue
    }
    dirSegments.push({ text: segment.text.slice(0, nameStart - start), matched: segment.matched })
    nameSegments.push({ text: segment.text.slice(nameStart - start), matched: segment.matched })
  }

  return { dirSegments, nameSegments }
}

export function highlightPromptInputV2Label(
  label: string,
  positions: number[] | undefined,
  query: string | undefined,
): PromptInputV2LabelSegment[] {
  if (positions && positions.length > 0) {
    const matched = new Set(positions)
    const segments: PromptInputV2LabelSegment[] = []
    let buffer = ""
    let bufferMatched = false
    for (let index = 0; index < label.length; index++) {
      const isMatched = matched.has(index)
      if (buffer && isMatched !== bufferMatched) {
        segments.push({ text: buffer, matched: bufferMatched })
        buffer = ""
      }
      buffer += label[index]
      bufferMatched = isMatched
    }
    if (buffer) segments.push({ text: buffer, matched: bufferMatched })
    return segments
  }

  const needle = query?.trim()
  if (!needle) return [{ text: label, matched: false }]
  const index = label.toLowerCase().indexOf(needle.toLowerCase())
  if (index === -1) return [{ text: label, matched: false }]
  const segments: PromptInputV2LabelSegment[] = []
  if (index > 0) segments.push({ text: label.slice(0, index), matched: false })
  segments.push({ text: label.slice(index, index + needle.length), matched: true })
  if (index + needle.length < label.length) segments.push({ text: label.slice(index + needle.length), matched: false })
  return segments
}
