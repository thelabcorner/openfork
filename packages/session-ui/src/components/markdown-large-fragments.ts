import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes as Tree } from "parse5"

import { LARGE_MARKDOWN_FRAGMENT_CHARS, LARGE_MARKDOWN_FRAGMENT_NODES, LARGE_MARKDOWN_NODE_ATTR, type LargeMarkdownFragment } from "./markdown-large-protocol"

function escapedText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Run only in the isolated large-body worker. Pages contain balanced HTML;
 * continued elements carry stable IDs so the renderer appends into their
 * existing nodes instead of manufacturing new paragraphs/lists at page seams. */
export function* fragmentLargeMarkdownHtml(html: string): Generator<LargeMarkdownFragment> {
  const document = parseFragment(html)
  type Open = { id: string; open: string; close: string }
  type Task = { node: Tree.ChildNode } | { close: Open }
  const tasks: Task[] = document.childNodes.toReversed().map((node) => ({ node }))
  const opened: Open[] = []
  let body = ""
  let changed = false
  let nodes = 0
  let nextID = 0
  const flush = () => {
    const value = { html: body + opened.toReversed().map((item) => item.close).join(""), openIDs: opened.map((item) => item.id) }
    body = opened.map((item) => item.open).join("")
    changed = false
    nodes = 0
    return value
  }
  while (tasks.length) {
    const task = tasks.pop()!
    if ("close" in task) {
      body += task.close.close
      opened.pop()
      changed = true
    } else if ("tagName" in task.node) {
      const node = task.node
      const id = String(++nextID)
      const shell = serializeOuter({ ...node, childNodes: [], attrs: [
        ...node.attrs.filter((attr) => attr.name !== LARGE_MARKDOWN_NODE_ATTR),
        { name: LARGE_MARKDOWN_NODE_ATTR, value: id },
      ] })
      const closeAt = shell.lastIndexOf("</")
      const item = { id, open: closeAt < 0 ? shell : shell.slice(0, closeAt), close: closeAt < 0 ? "" : shell.slice(closeAt) }
      body += item.open
      changed = true
      nodes++
      if (item.close) {
        opened.push(item)
        tasks.push({ close: item })
        for (let index = node.childNodes.length - 1; index >= 0; index--) tasks.push({ node: node.childNodes[index]! })
      }
    } else if (task.node.nodeName === "#text") {
      const text = (task.node as Tree.TextNode).value
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + 4096)
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
        body += escapedText(text.slice(offset, end))
        offset = end
        changed = true
        nodes++
        if (body.length >= LARGE_MARKDOWN_FRAGMENT_CHARS || nodes >= LARGE_MARKDOWN_FRAGMENT_NODES) yield flush()
      }
    }
    if (changed && (body.length >= LARGE_MARKDOWN_FRAGMENT_CHARS || nodes >= LARGE_MARKDOWN_FRAGMENT_NODES)) yield flush()
  }
  if (changed) yield flush()
}
