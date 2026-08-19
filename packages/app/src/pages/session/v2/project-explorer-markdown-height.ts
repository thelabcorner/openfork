import { estimateTextHeight, textLayoutMode, type TextLayoutMode, type TextTypography } from "@/lib/text-layout"
export type { TextLayoutMode } from "@/lib/text-layout"

/**
 * Advisory markdown height prediction for two surfaces:
 *   1. the project explorer markdown viewer (loading-state placeholder height)
 *   2. the session timeline markdown rows (pre-mount virtualizer height prior)
 *
 * Architectural invariant — PRETEXT PREDICTS, THE DOM DECIDES: every value this
 * module returns is a hint. The DOM measures real rendered height and wins.
 *
 * Cost discipline: prediction must never cost more than the correction it
 * saves. The DOM measures a mounted row within one frame; the only real win of
 * a prior is avoiding visible pre-mount geometry shifts (scroll anchoring,
 * bottom-anchored streaming, restored-session scroll position). So:
 *   - the flag defaults to "off" (zero cost, zero behavior change);
 *   - classification is a single cheap line scan capped at MAX_CLASSIFY_CHARS;
 *   - the pretext path is only taken for simple content, and relies on the
 *     shared lib's bounded LRU prepared cache to make repeated estimates
 *     (e.g. every streaming projection recompute) near-free;
 *   - everything else falls back to a conservative single-pass prior.
 */

export type MarkdownComplexity = "simple" | "complex"

export const MARKDOWN_TYPOGRAPHY: TextTypography = {
  // Mirrors packages/session-ui/src/components/markdown.css:
  // font-family var(--font-family-sans), font-size 14px, line-height 160%.
  family: '"Segoe UI", system-ui, sans-serif',
  fontSizePx: 14,
  lineHeightPx: 22.4,
  fontWeight: 400,
  fontStyle: "normal",
  letterSpacingPx: 0,
}

// Beyond this size the classifier scan is skipped and everything is treated as
// complex, so only the (still linear) conservative prior runs.
const MAX_CLASSIFY_CHARS = 64_000

/**
 * Conservative eligibility classifier: is this markdown safe to hand to the
 * pretext text measurer, or does it contain constructs whose rendered height
 * no pure-text layout pass can predict?
 *
 * Eligible ("simple"): prose, ATX/setext headings, single-level lists,
 * blockquotes, horizontal rules, inline formatting (code, bold, links,
 * emphasis). Note `$...$` inline math is NOT katex in this renderer — only
 * `$$...$$` blocks and `\(...\)` are (packages/ui/src/context/marked-parser.tsx)
 * — so dollar amounts stay eligible.
 *
 * Ineligible ("complex"): fenced/indented code blocks, katex math, GFM
 * tables, HTML blocks, images, nested lists, and any input over the scan cap.
 */
export function classifyMarkdown(text: string): MarkdownComplexity {
  if (text.length > MAX_CLASSIFY_CHARS) return "complex"
  if (/\$\$|\\\(/.test(text)) return "complex"
  if (/!\[[^\]]*\]\(/.test(text)) return "complex"
  let listIndent: number | undefined
  for (const line of text.split(/\r\n?|\n/)) {
    // Right-trim only: leading indentation is significant (nested lists,
    // indented code) and must survive for the marker/indent checks below.
    const trimmed = line.replace(/\s+$/, "")
    if (!trimmed) {
      listIndent = undefined
      continue
    }
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) return "complex"
    if (/^\s{4,}\S/.test(line)) return "complex"
    if (/^\s{0,3}</.test(trimmed)) return "complex"
    if (/^\s{0,3}\|/.test(line)) return "complex"
    if (/^\s{0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\s*$/.test(line)) return "complex"
    const marker = trimmed.replace(/^(?:\s*>)+[ \t]?/, "").match(/^([ \t]*)(?:[-*+]|\d{1,9}[.)])([ \t])/)
    if (!marker) continue
    const indent = marker[1]!.replace(/\t/g, "  ").length
    if (listIndent !== undefined && indent > listIndent) return "complex"
    listIndent = indent
  }
  return "simple"
}

/**
 * Conservative single-pass prior: rough rendered height from a per-line
 * visual-line model calibrated to packages/session-ui/src/components/markdown.css
 * (14px base, 160% line height, block margins). Deliberately crude — it only
 * needs to be in the right ballpark and cost a linear scan.
 */
export function priorMarkdownHeight(text: string, widthPx: number, typography: TextTypography = MARKDOWN_TYPOGRAPHY): number {
  const { fontSizePx, lineHeightPx } = typography
  const avgCharWidth = Math.max(4, fontSizePx * 0.5)
  const charsPerLine = Math.max(8, Math.floor(widthPx / avgCharWidth))
  let height = 0
  let paragraphLines = 0
  let listIndent: number | undefined
  const flushParagraph = () => {
    if (paragraphLines === 0) return
    // p margin-bottom 12px approximates to roughly half a base line.
    height += paragraphLines * lineHeightPx + 12
    paragraphLines = 0
  }
  for (const rawLine of text.split(/\r\n?|\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      flushParagraph()
      listIndent = undefined
      continue
    }
    const quoted = trimmed.startsWith(">")
    const body = quoted ? trimmed.replace(/^\s*>[ \t]?/, "").trimStart() : trimmed
    const headingMatch = body.match(/^(#{1,6})[ \t]/)
    const heading = headingMatch ? headingMatch[1]!.length : 0
    if (heading > 0) {
      flushParagraph()
      // h1: 17px + 40px margins, h2: 15px + 34px, h3+: 13px + 28px, all at
      // large line-height — expressed as base-line multiples.
      height += (heading === 1 ? 2.8 : heading === 2 ? 2.5 : 2.1) * lineHeightPx
      continue
    }
    if (/^(?:[-*_])(?:\s*\1){2,}$/.test(body)) {
      flushParagraph()
      height += 1.5 * lineHeightPx
      continue
    }
    const marker = body.match(/^([ \t]*)(?:[-*+]|\d{1,9}[.)])([ \t])/)
    if (marker) {
      flushParagraph()
      const indent = marker[1]!.replace(/\t/g, "  ").length
      if (listIndent !== undefined && indent > listIndent) height += 0.25 * lineHeightPx
      listIndent = indent
      const itemLines = Math.max(1, Math.ceil(body.slice(marker[0]!.length).length / charsPerLine))
      // List item line + amortized ul/ol margins (8px top + 12px bottom).
      height += itemLines * lineHeightPx + 10
      continue
    }
    paragraphLines += Math.max(1, Math.ceil(body.length / charsPerLine)) + (quoted ? 0.25 : 0)
  }
  flushParagraph()
  return Math.max(lineHeightPx, Math.ceil(height))
}

export type MarkdownHeightOptions = {
  /** Flag override (tests). Defaults to the OPENCODE_TEXT_LAYOUT env flag. */
  mode?: TextLayoutMode
  typography?: TextTypography
}

/**
 * Advisory rendered-height estimate for a markdown source at a given width.
 * Returns undefined when the flag is "off" or the source is blank — callers
 * must treat undefined as "no hint available" and keep DOM measurement
 * authoritative.
 */
export function estimateMarkdownHeight(text: string, widthPx: number, options?: MarkdownHeightOptions): number | undefined {
  if (!text.trim()) return undefined
  const mode = options?.mode ?? textLayoutMode()
  if (mode === "off") return undefined
  const typography = options?.typography ?? MARKDOWN_TYPOGRAPHY
  const width = Number.isFinite(widthPx) ? Math.max(64, widthPx) : MARKDOWN_WIDTH_FALLBACK
  if (text.length > MAX_CLASSIFY_CHARS) return priorMarkdownHeight(text, width, typography)
  if (mode === "prior" || classifyMarkdown(text) === "complex") return priorMarkdownHeight(text, width, typography)
  try {
    const height = estimateTextHeight(text, typography, width)
    if (typeof height === "number" && Number.isFinite(height) && height > 0) return Math.ceil(height)
  } catch {
    // Shared lib unavailable/throws on pathological input — fall back to the prior.
  }
  return priorMarkdownHeight(text, width, typography)
}

// Representative fallback width for surfaces that don't know their real
// content width pre-mount (the session timeline). Advisory only.
export const MARKDOWN_WIDTH_FALLBACK = 720
