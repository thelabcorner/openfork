import type { FileOutline, OutlineSymbol } from "../symbols/outline"

export const AROUND_BEFORE = 2
export const AROUND_MAX = 80
export const GREP_MAX = 50

export const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export function renderHeal(requested: string, opened: string, reason: string): string {
  return [
    `<heal>`,
    `Requested: ${escapeXml(requested)}`,
    `Opened:    ${escapeXml(opened)}`,
    `Why: ${escapeXml(reason)}`,
    `This path was missing. Opened a unique same-name file instead — it may be the wrong one.`,
    `If this is not the file you wanted, ignore the content below and glob the basename. Do not keep using the opened path as if you requested it.`,
    `</heal>`,
    ``,
  ].join("\n")
}

export function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern)
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  }
}

export function renderOutline(filepath: string, totalLines: number | undefined, outline: FileOutline, max = 200): string {
  const order = ["function", "class", "interface", "type", "enum", "variable", "const", "import", "module"] as const
  const classNames = new Set(outline.symbols.filter((s) => s.kind === "class").map((s) => s.name))
  const membersByClass = new Map<string, OutlineSymbol[]>()
  for (const symbol of outline.symbols) {
    if (symbol.memberOf && classNames.has(symbol.memberOf)) {
      const list = membersByClass.get(symbol.memberOf) ?? []
      list.push(symbol)
      membersByClass.set(symbol.memberOf, list)
    }
  }
  const topLevel = outline.symbols.filter((s) => !s.memberOf || !classNames.has(s.memberOf))
  const lines: string[] = [
    `<outline path="${escapeXml(filepath)}"${totalLines != null ? ` lines="${totalLines}"` : ""} symbols="${outline.symbols.length}" lang="${outline.lang}"${outline.fallback ? ` fallback="regex"` : ""}>`,
  ]
  let shown = 0
  for (const kind of order) {
    const inGroup = topLevel.filter((s) => s.kind === kind)
    if (inGroup.length === 0) continue
    for (const symbol of inGroup) {
      if (shown >= max) break
      shown++
      lines.push(`  ${symbol.kind} ${symbol.name} L${symbol.line}`)
      if (kind === "class") {
        for (const member of membersByClass.get(symbol.name) ?? []) {
          if (shown >= max) break
          shown++
          lines.push(`    ${member.kind} ${member.name} L${member.line}`)
        }
      }
    }
  }
  if (shown >= max && outline.symbols.length > shown) {
    lines.push(`  … ${outline.symbols.length - shown} more — pattern="name" or symbol="name"`)
  }
  lines.push(`</outline>`)
  lines.push(`Use symbol="<name>" to read a definition, or offset=<line> for a window.`)
  return lines.join("\n")
}

export function aroundWindow(
  outline: FileOutline,
  symbol: string,
): { symbol: OutlineSymbol; offset: number; limit: number } | undefined {
  const exact = outline.symbols.filter((s) => s.name === symbol)
  const needle = symbol.toLowerCase()
  const hits = exact.length > 0 ? exact : outline.symbols.filter((s) => s.name.toLowerCase().includes(needle))
  const hit = hits[0]
  if (!hit) return
  const next = outline.symbols
    .filter((s) => s.line > hit.line && s.memberOf !== hit.name)
    .sort((a, b) => a.line - b.line)[0]
  const offset = Math.max(1, hit.line - AROUND_BEFORE)
  const end = next ? Math.min(next.line - 1, hit.line + AROUND_MAX) : hit.line + AROUND_MAX
  return { symbol: hit, offset, limit: Math.max(1, end - offset + 1) }
}

export function renderGrep(
  filepath: string,
  pattern: string,
  hits: Array<{ line: number; text: string }>,
  truncated: boolean,
): string {
  const lines = [
    `<matches path="${escapeXml(filepath)}" pattern="${escapeXml(pattern)}" count="${hits.length}"${truncated ? ` truncated="true"` : ""}>`,
  ]
  for (const hit of hits) {
    lines.push(`  ${hit.line}: ${hit.text}`)
  }
  if (hits.length === 0) {
    lines.push(`  (no matches — try action="outline" or a looser pattern)`)
  } else if (truncated) {
    lines.push(`  (first ${GREP_MAX} matches. Narrow the pattern or Read offset=<line>.)`)
  }
  lines.push(`</matches>`)
  return lines.join("\n")
}
