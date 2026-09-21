export * as ToolOutputProjection from "./tool-output-projection"

export type Strategy = "balanced" | "head" | "tail"

export interface Limits {
  readonly maxLines: number
  readonly maxBytes: number
}

export interface Analysis {
  readonly originalLines: number
  readonly originalBytes: number
  readonly overLines: boolean
  readonly overBytes: boolean
  readonly truncated: boolean
}

export interface PreviewSegment {
  startByte: number
  endByte: number
}

export interface Projection extends Analysis {
  readonly content: string
  readonly strategy: Strategy
  /** Bytes copied from the original source into the preview, excluding marker/separators. */
  readonly retainedBytes: number
  readonly omittedBytes: number
  /** Exact source byte ranges retained in the model-facing preview. */
  readonly segments: ReadonlyArray<PreviewSegment>
}

export interface ProjectOptions extends Limits {
  readonly marker: string
  readonly strategy?: Strategy
}

const normalize = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)

function utf8Forward(input: string, index: number) {
  const code = input.charCodeAt(index)
  if (code < 0x80) return { bytes: 1, units: 1 }
  if (code < 0x800) return { bytes: 2, units: 1 }
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
    const low = input.charCodeAt(index + 1)
    if (low >= 0xdc00 && low <= 0xdfff) return { bytes: 4, units: 2 }
  }
  return { bytes: 3, units: 1 }
}

function utf8Backward(input: string, end: number) {
  const code = input.charCodeAt(end - 1)
  if (code >= 0xdc00 && code <= 0xdfff && end >= 2) {
    const high = input.charCodeAt(end - 2)
    if (high >= 0xd800 && high <= 0xdbff) return { bytes: 4, units: 2 }
  }
  if (code < 0x80) return { bytes: 1, units: 1 }
  if (code < 0x800) return { bytes: 2, units: 1 }
  return { bytes: 3, units: 1 }
}

export function takePrefixBytes(input: string, maximumBytes: number) {
  const limit = normalize(maximumBytes)
  let bytes = 0
  let index = 0
  while (index < input.length) {
    const width = utf8Forward(input, index)
    if (bytes + width.bytes > limit) break
    bytes += width.bytes
    index += width.units
  }
  return input.slice(0, index)
}

export function takeSuffixBytes(input: string, maximumBytes: number) {
  const limit = normalize(maximumBytes)
  let bytes = 0
  let index = input.length
  while (index > 0) {
    const width = utf8Backward(input, index)
    if (bytes + width.bytes > limit) break
    bytes += width.bytes
    index -= width.units
  }
  return input.slice(index)
}

export function lineCount(input: string) {
  if (input.length === 0) return 1
  let lines = 1
  let from = 0
  while (true) {
    const at = input.indexOf("\n", from)
    if (at === -1) return lines
    lines++
    from = at + 1
  }
}

export function takeHeadLines(input: string, count: number) {
  const limit = normalize(count)
  if (limit <= 0) return ""
  let at = -1
  for (let line = 0; line < limit; line++) {
    at = input.indexOf("\n", at + 1)
    if (at === -1) return input
  }
  return input.slice(0, at)
}

export function takeTailLines(input: string, count: number) {
  const limit = normalize(count)
  if (limit <= 0) return ""
  let at = input.length
  for (let line = 0; line < limit; line++) {
    const previous = input.lastIndexOf("\n", at - 1)
    if (previous === -1) return input
    at = previous
  }
  return input.slice(at + 1)
}

function clipHead(input: string, maxLines: number, maxBytes: number) {
  return takePrefixBytes(takeHeadLines(input, maxLines), maxBytes)
}

function clipTail(input: string, maxLines: number, maxBytes: number) {
  return takeSuffixBytes(takeTailLines(input, maxLines), maxBytes)
}

export function analyze(text: string, limits: Limits): Analysis {
  const maxLines = normalize(limits.maxLines)
  const maxBytes = normalize(limits.maxBytes)
  const originalLines = lineCount(text)
  const originalBytes = Buffer.byteLength(text, "utf-8")
  const overLines = originalLines > maxLines
  const overBytes = originalBytes > maxBytes
  return {
    originalLines,
    originalBytes,
    overLines,
    overBytes,
    truncated: overLines || overBytes,
  }
}

/**
 * Build a model-facing projection whose complete representation (source sample,
 * separators, and marker) fits both configured limits.
 *
 * The marker is treated as control/recovery information and retained before
 * source bytes when the budget is extremely small. No tokenizer is used here:
 * byte/line limits are deterministic transport bounds; model-specific token
 * budgeting belongs at the provider serialization boundary.
 */
export function project(text: string, options: ProjectOptions, known?: Analysis): Projection {
  const maxLines = normalize(options.maxLines)
  const maxBytes = normalize(options.maxBytes)
  const strategy = options.strategy ?? "balanced"
  const analysis = known ?? analyze(text, { maxLines, maxBytes })
  if (!analysis.truncated) {
    return {
      ...analysis,
      content: text,
      strategy,
      retainedBytes: analysis.originalBytes,
      omittedBytes: 0,
      segments: analysis.originalBytes > 0 ? [{ startByte: 0, endByte: analysis.originalBytes }] : [],
    }
  }

  const marker = clipHead(options.marker, maxLines, maxBytes)
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  const markerLines = marker.length > 0 ? lineCount(marker) : 0
  const sourceLineBudget = Math.max(0, maxLines - markerLines)

  if (sourceLineBudget === 0 || markerBytes >= maxBytes) {
    return {
      ...analysis,
      content: marker,
      strategy,
      retainedBytes: 0,
      omittedBytes: analysis.originalBytes,
      segments: [],
    }
  }

  let headLineBudget = 0
  let tailLineBudget = 0
  if (strategy === "head") headLineBudget = sourceLineBudget
  else if (strategy === "tail") tailLineBudget = sourceLineBudget
  else {
    headLineBudget = Math.ceil(sourceLineBudget / 2)
    tailLineBudget = Math.floor(sourceLineBudget / 2)
  }

  const headCandidate =
    headLineBudget > 0 ? (analysis.overLines ? takeHeadLines(text, headLineBudget) : text) : ""
  const tailCandidate =
    tailLineBudget > 0 ? (analysis.overLines ? takeTailLines(text, tailLineBudget) : text) : ""

  // Each non-empty source segment is separated from the marker by one newline.
  // Reserve those bytes before splitting the remaining source budget.
  const segmentCount = Number(headCandidate.length > 0) + Number(tailCandidate.length > 0)
  const separatorBytes = marker.length > 0 ? segmentCount : Math.max(0, segmentCount - 1)
  const sourceByteBudget = Math.max(0, maxBytes - markerBytes - separatorBytes)
  let head = ""
  let tail = ""

  if (strategy === "head") {
    head = takePrefixBytes(headCandidate, sourceByteBudget)
  } else if (strategy === "tail") {
    tail = takeSuffixBytes(tailCandidate, sourceByteBudget)
  } else {
    const headFull = Buffer.byteLength(headCandidate, "utf-8")
    const tailFull = Buffer.byteLength(tailCandidate, "utf-8")
    let headBudget = Math.min(headFull, Math.ceil(sourceByteBudget / 2))
    let tailBudget = Math.min(tailFull, sourceByteBudget - headBudget)
    let spare = sourceByteBudget - headBudget - tailBudget
    if (spare > 0) {
      const addHead = Math.min(spare, headFull - headBudget)
      headBudget += addHead
      spare -= addHead
    }
    if (spare > 0) tailBudget += Math.min(spare, tailFull - tailBudget)
    head = takePrefixBytes(headCandidate, headBudget)
    tail = takeSuffixBytes(tailCandidate, tailBudget)
  }

  // Do not reclaim separator bytes after clipping. A segment that was empty
  // under the original budget can become non-empty when given the reclaimed
  // byte, which reintroduces the separator and violates the hard byte bound by
  // exactly one byte. Leaving at most two bytes unused is the correct tradeoff
  // for a mechanically strict provider envelope.

  const pieces = strategy === "tail" ? [marker, tail] : [head, marker, tail]
  const content = pieces.filter((piece) => piece.length > 0).join("\n")
  const retainedBytes = Buffer.byteLength(head, "utf-8") + Buffer.byteLength(tail, "utf-8")
  const segments: PreviewSegment[] = []
  if (head.length > 0) {
    segments.push({ startByte: 0, endByte: Buffer.byteLength(head, "utf-8") })
  }
  if (tail.length > 0) {
    const tailBytes = Buffer.byteLength(tail, "utf-8")
    const startByte = analysis.originalBytes - tailBytes
    const endByte = analysis.originalBytes
    const previous = segments.at(-1)
    if (previous && startByte <= previous.endByte) previous.endByte = Math.max(previous.endByte, endByte)
    else segments.push({ startByte, endByte })
  }

  return {
    ...analysis,
    content,
    strategy,
    retainedBytes,
    omittedBytes: Math.max(0, analysis.originalBytes - retainedBytes),
    segments,
  }
}
