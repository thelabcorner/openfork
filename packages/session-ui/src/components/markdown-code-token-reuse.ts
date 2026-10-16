import type { MarkdownToken } from "./markdown-worker-protocol"

/** The completed Shiki pass can change tokens near the terminal line.
 * Keep the exact shared prefix of the previous streamed spans and the
 * completed authoritative result; no style/text mismatch is permitted.
 * Inputs are two token segments to avoid allocating/flattening large arrays. */
export function commonCodeTokenPrefix(
  previousStable: readonly MarkdownToken[],
  previousUnstable: readonly MarkdownToken[],
  nextStable: readonly MarkdownToken[],
  nextUnstable: readonly MarkdownToken[],
): number {
  const beforeStable = previousStable.length
  const afterStable = nextStable.length
  const count = Math.min(beforeStable + previousUnstable.length, afterStable + nextUnstable.length)
  for (let index = 0; index < count; index++) {
    const left = index < beforeStable ? previousStable[index]! : previousUnstable[index - beforeStable]!
    const right = index < afterStable ? nextStable[index]! : nextUnstable[index - afterStable]!
    if (left[0] !== right[0] || left[1] !== right[1]) return index
  }
  return count
}
