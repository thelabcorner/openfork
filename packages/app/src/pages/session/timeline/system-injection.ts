import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import type { Part } from "@opencode-ai/sdk/v2"

/**
 * "System injections" are the text parts the SERVER appends to a user turn so
 * that the model sees them: plan/build-switch reminders, MCP resource bodies,
 * shell-tool preambles, compaction hand-offs, task-output continuations.
 *
 * The authoritative marker is already produced and persisted upstream --
 * `synthetic: true` means assistant-audience-only (`ignored: true` is the
 * mirror image: user-audience-only). That is why the user bubble has never
 * drawn them: `UserMessageDisplay` renders the FIRST NON-SYNTHETIC text part
 * and nothing else. Surfacing them is therefore pure presentation over a fact
 * the client store already holds -- no new transport, projection, or route.
 *
 * Everything here is pure and is called exactly once per turn from row
 * construction, over the `userParts` array that pass already reads.
 */
export type SystemInjectionSegment = {
  id: string
  text: string
}

type TextPart = Extract<Part, { type: "text" }>

function isInjection(part: Part): part is TextPart {
  if (part.type !== "text") return false
  if (!part.synthetic) return false
  // Not sent to the model, so not an injection into its context.
  if (part.ignored) return false
  // Same cheap emptiness test the renderable() predicate uses: `\S` stops at
  // the first real character instead of trimming the whole accumulated string.
  if (!/\S/.test(part.text ?? "")) return false
  // Inline file comments are synthetic too, but the timeline already draws them
  // as comment cards; showing them twice would be a regression, not a reveal.
  return !(readCommentMetadata(part.metadata) ?? parseCommentNote(part.text))
}

export function systemInjectionSegments(parts: readonly Part[]): SystemInjectionSegment[] {
  const result: SystemInjectionSegment[] = []
  for (const part of parts) {
    if (!isInjection(part)) continue
    result.push({ id: part.id, text: part.text })
  }
  return result
}

/**
 * Row-identity digest for the turn's injections.
 *
 * Deliberately SCALAR. Timeline rows compare with `Equal.equals`, which falls
 * back to reference equality for plain arrays, so carrying the segment array in
 * the row descriptor would make the row unequal on every reconstruction and
 * churn the virtualizer. Synthetic parts are written once (never streamed
 * token-by-token) and part IDs are immutable and ascending, so the joined IDs
 * change if and only if the set of injections actually changed.
 */
export function systemInjectionSignature(parts: readonly Part[]) {
  let signature = ""
  let count = 0
  for (const part of parts) {
    if (!isInjection(part)) continue
    signature = count === 0 ? part.id : `${signature},${part.id}`
    count += 1
  }
  return { signature, count }
}

/** Collapsed one-line preview. Kept out of the row descriptor: it is derived
 * from text, and text-derived fields in a row break row equality. */
export function systemInjectionPreview(segments: readonly SystemInjectionSegment[]) {
  const first = segments[0]
  if (!first) return ""
  for (const line of first.text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ""
}
