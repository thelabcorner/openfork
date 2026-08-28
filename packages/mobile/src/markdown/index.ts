import { createMarkdownParser } from "./parser"
import { highlightCode } from "./highlight"

const parser = createMarkdownParser(highlightCode)

export async function parseMarkdown(src: string): Promise<string> {
  return (await parser.parse(src)) as string
}

export { project, completedProjection, type Block, type Projection } from "./stream"
export { sanitizeMarkdown } from "./sanitize"
