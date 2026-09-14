import type { Part } from "@opencode-ai/sdk/v2"

/**
 * Project a live assistant part into only the fields that can change timeline
 * row topology while a turn is working. Text/reasoning growth is represented by
 * a binary empty/non-empty marker; ordinary tool input/output growth disappears
 * entirely; `question` retains only hidden-vs-visible status.
 *
 * Mounted row components still read the authoritative Part store directly, so
 * this projection never alters rendered content. Its sole purpose is to keep
 * row construction asleep for token/content deltas that cannot affect row
 * membership or grouping.
 */
export function projectWorkingAssistantParts(parts: readonly Part[]): Part[] {
  return parts.map((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return {
        id: part.id,
        type: part.type,
        text: part.text.trim() ? "x" : "",
      } as Part
    }
    if (part.type === "tool") {
      const hiddenQuestion =
        part.tool === "question" && (part.state.status === "pending" || part.state.status === "running")
      return {
        id: part.id,
        type: "tool",
        tool: part.tool,
        state: { status: hiddenQuestion ? "pending" : "completed" },
      } as unknown as Part
    }
    return { id: part.id, type: part.type } as Part
  })
}

export function workingAssistantPartsEqual(left: readonly Part[], right: readonly Part[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!
    const b = right[index]!
    if (a.id !== b.id || a.type !== b.type) return false
    if ((a.type === "text" || a.type === "reasoning") && b.type === a.type) {
      if (a.text !== b.text) return false
      continue
    }
    if (a.type === "tool" && b.type === "tool") {
      if (a.tool !== b.tool || a.state.status !== b.state.status) return false
    }
  }
  return true
}
