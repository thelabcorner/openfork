import { expect, test } from "bun:test"
import { parseFragment, serialize, type DefaultTreeAdapterTypes as Tree } from "parse5"
import { fragmentLargeMarkdownHtml } from "./markdown-large-fragments"
import { LARGE_MARKDOWN_NODE_ATTR } from "./markdown-large-protocol"
import { createMarkdownParser } from "@opencode-ai/ui/context/marked-parser"

function reassemble(html: string) {
  const result = parseFragment("")
  let ancestors = new Map<string, Tree.Element>()
  let count = 0
  let maxChars = 0
  for (const page of fragmentLargeMarkdownHtml(html)) {
    count++
    maxChars = Math.max(maxChars, page.html.length)
    const openIDs = new Set(page.openIDs)
    const continued = new Map<string, Tree.Element>()
    const append = (node: Tree.ChildNode, parent: Tree.ParentNode) => {
      if (!("tagName" in node)) { parent.childNodes.push(node); return }
      const id = node.attrs.find((attr) => attr.name === LARGE_MARKDOWN_NODE_ATTR)?.value
      let target = id ? ancestors.get(id) : undefined
      if (!target || !parent.childNodes.includes(target)) {
        target = { ...node, attrs: node.attrs.filter((attr) => attr.name !== LARGE_MARKDOWN_NODE_ATTR), childNodes: [] }
        parent.childNodes.push(target)
      }
      if (id && openIDs.has(id)) continued.set(id, target)
      for (const child of node.childNodes) append(child, target)
    }
    for (const node of parseFragment(page.html).childNodes) append(node, result)
    ancestors = continued
  }
  return { html: serialize(result), count, maxChars }
}

test("bounded rich fragments preserve one oversized nested paragraph and every Unicode character", () => {
  const html = `<h1>Heading</h1><p><strong>${"a &amp; b 😀 &lt;c&gt; ".repeat(30_000)}</strong> end</p>`
  const result = reassemble(html)
  expect(result.html).toBe(serialize(parseFragment(html)))
  expect(result.count).toBeGreaterThan(10)
  expect(result.maxChars).toBeLessThan(64 * 1024)
})

test("fragment seams preserve lists, tables, links and code without duplicating their ancestors", () => {
  const html = `<ul>${Array.from({length: 600}, (_, index) => `<li><a href="https://example.com/${index}">item ${index}</a><ul><li><code>nested</code></li></ul></li>`).join("")}</ul><table><tbody>${"<tr><td>one</td><td><em>two</em></td></tr>".repeat(600)}</tbody></table>`
  const result = reassemble(html)
  expect(result.html).toBe(serialize(parseFragment(html)))
  expect(result.count).toBeGreaterThan(10)
})

test("raw content cannot forge continuation identities", () => {
  const html = `<p ${LARGE_MARKDOWN_NODE_ATTR}="forged">first</p><p>second</p>`
  expect(reassemble(html).html).toBe("<p>first</p><p>second</p>")
})

test("oversized source keeps its rich inline semantics through the production parser", async () => {
  const parser = createMarkdownParser((code) => code)
  const body = "bounded rich content 😀 ".repeat(30_000) + "tail"
  const html = await parser.parse(`# Rich oversized heading\n\n**${body}**\n\n- rich-large-end-marker`)
  expect(html).toContain("<strong>")
  expect(reassemble(html).html).toBe(serialize(parseFragment(html)))
})
