/**
 * Shared XML-shape readers for tool output text.
 *
 * Our own tools record their results as small tagged blocks (`<job>`, `<monitor>`,
 * `<test-run>`, ...). These helpers read that recorded text and nothing else. They
 * live in a plain `.ts` module so the parsers built on them stay unit-testable
 * without pulling in Solid or the stylesheet side effects of a `.tsx` renderer.
 */

export function unescapeXml(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

export function tagText(source: string, name: string) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(source)
  return match ? unescapeXml(match[1]!.trim()) : undefined
}

export function tagBlocks(source: string, name: string) {
  const out: { attrs: Record<string, string>; inner: string }[] = []
  for (const match of source.matchAll(new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`, "g"))) {
    const attrs: Record<string, string> = {}
    for (const attr of (match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = unescapeXml(attr[2]!)
    out.push({ attrs, inner: match[2]! })
  }
  return out
}

export function selfClosing(source: string, name: string) {
  const match = new RegExp(`<${name}([^>]*)\\/>`).exec(source)
  if (!match) return undefined
  const attrs: Record<string, string> = {}
  for (const attr of (match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = unescapeXml(attr[2]!)
  return attrs
}