import type { ThemedToken } from "shiki"
import type { MarkdownToken } from "./markdown-worker-protocol"

/** Convert a complete Shiki line result without intermediate flatten/map arrays.
 * Preserve newline tokens exactly: even a blank intermediate line owns "\n". */
export function flattenHighlightLines(
  lines: readonly (readonly ThemedToken[])[],
  convert: (value: ThemedToken) => MarkdownToken,
  source?: string,
): MarkdownToken[] {
  const result: MarkdownToken[] = []
  let offset = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    for (let i = 0; i < line.length; i++) {
      const token = line[i]!
      result.push(convert(token))
      offset += token.content.length
    }
    if (index + 1 < lines.length) {
      // Shiki splits lines at LF and drops the preceding CR in CRLF files.
      // Restore the exact original separator; copies/selections must never
      // silently rewrite source bytes when syntax highlighting finishes.
      const separator = source?.charCodeAt(offset) === 13 && source.charCodeAt(offset + 1) === 10 ? "\r\n" : "\n"
      result.push([separator, ""])
      offset += separator.length
    }
  }
  return result
}

/** O(n) streaming conversion with one output allocation and no filtered copy. */
export function convertHighlightTokens(
  tokens: readonly ThemedToken[],
  convert: (value: ThemedToken) => MarkdownToken,
): MarkdownToken[] {
  const result: MarkdownToken[] = []
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i]!
    if (value.content.length) result.push(convert(value))
  }
  return result
}
