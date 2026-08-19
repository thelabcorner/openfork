/**
 * Eligibility for pretext row-height prediction (PRETEXT PREDICTS, THE DOM
 * DECIDES). Conservative on purpose: only text whose rendered height a pure
 * text-layout pass can actually predict is eligible. Everything else falls
 * through to priors/fallback.
 *
 * Excluded:
 *   - streaming rows (text changes every delta; re-preparing is wasted work)
 *   - text containing tabs (the app uses tab-size 4, pretext models tab-size 8)
 *   - complex markdown: tables, fenced code, math, images, blockquotes,
 *     nested lists, HTML — these render with block margins/other fonts that a
 *     single-font wrap pass cannot predict
 *   - unknown/empty content
 */

import type { TimelineRow } from "../timeline-row"

export type RowTextKind =
  | { kind: "user-text"; text: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "error-text"; text: string }
  | { kind: "thinking-text"; text: string }
  | { kind: "none" }

export const MAX_ESTIMATE_CHARS = 32_000

export function rowTextKind(row: TimelineRow.TimelineRow): RowTextKind {
  switch (row._tag) {
    case "UserMessage":
      // User text is plain prose; the message text is derived by the caller
      // (parts) and passed through rowInput.text. This row type alone is not
      // enough to classify, so mark it eligible-by-shape and let the text
      // classifier decide.
      return { kind: "user-text", text: "" }
    case "AssistantPart":
      return { kind: "assistant-text", text: "" }
    case "Error":
      return { kind: "error-text", text: row.text }
    case "Thinking":
      return { kind: "thinking-text", text: row.reasoningHeading ?? "" }
    default:
      return { kind: "none" }
  }
}

export function isEligibleText(text: string): boolean {
  if (!text) return false
  if (text.length > MAX_ESTIMATE_CHARS) return false
  if (text.includes("\t")) return false
  if (/\$\$|\\\(|\\\[/.test(text)) return false
  if (/!\[[^\]]*\]\(/.test(text)) return false
  let listIndent: number | undefined
  for (const line of text.split(/\r\n?|\n/)) {
    const trimmed = line.replace(/\s+$/, "")
    if (!trimmed) {
      listIndent = undefined
      continue
    }
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) return false
    if (/^\s{4,}\S/.test(line)) return false
    if (/^\s{0,3}</.test(trimmed)) return false
    if (/^\s{0,3}\|/.test(line)) return false
    if (/^\s{0,3}#{1,6}[ \t]/.test(line)) return false
    if (/^\s{0,3}>/.test(trimmed)) return false
    const marker = trimmed.match(/^([ \t]*)(?:[-*+]|\d{1,9}[.)])([ \t])/)
    if (!marker) continue
    const indent = marker[1]!.replace(/\t/g, "  ").length
    if (listIndent !== undefined && indent > listIndent) return false
    listIndent = indent
  }
  return true
}
