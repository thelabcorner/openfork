/// <reference lib="webworker" />
import { createMarkdownParser } from "@opencode-ai/ui/context/marked-parser"
import { fragmentLargeMarkdownHtml } from "./markdown-large-fragments"

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const parser = createMarkdownParser((code, language) =>
  `<pre class="shiki OpenCode"><code class="language-${escape(language)}">${escape(code)}</code></pre>`,
)
let parts: string[] = []
let pages: ReturnType<typeof fragmentLargeMarkdownHtml> | undefined
self.onmessage = async (event: MessageEvent<{ id: number; type: "start" | "append" | "finish" | "next"; text?: string }>) => {
  const request = event.data
  try {
    if (request.type === "start") {
      parts = []
      pages = undefined
    } else if (request.type === "append") parts.push(request.text ?? "")
    else if (request.type === "finish") {
      const source = parts.join("")
      parts = []
      const html = await parser.parse(source)
      pages = fragmentLargeMarkdownHtml(html)
    } else {
      const page = pages?.next()
      if (!page || page.done) pages = undefined
      self.postMessage({ id: request.id, page: page?.value, done: !page || page.done })
      return
    }
    self.postMessage({ id: request.id })
  } catch (error) {
    parts = []
    pages = undefined
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
}
