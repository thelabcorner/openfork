import type { MarkdownToken } from "./markdown-worker-protocol"

export function highlightTokenBytes(tokens: readonly MarkdownToken[]) {
  let size = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    size += (token[0].length + token[1].length) * 2
  }
  return size
}

/**
 * Track a streaming response by its *changed* token suffix. Rewalking every
 * stable token on each character made memory accounting O(n²) over a session,
 * even after code tokenization itself became incremental.
 */
export function nextHighlightStateBytes(
  previous: { unstable: readonly MarkdownToken[] } | undefined,
  previousBytes: number | undefined,
  response: { reset: boolean; stable: readonly MarkdownToken[]; unstable: readonly MarkdownToken[] },
) {
  const appended = highlightTokenBytes(response.stable) + highlightTokenBytes(response.unstable)
  if (!previous || previousBytes === undefined || response.reset) return appended
  return previousBytes - highlightTokenBytes(previous.unstable) + appended
}
