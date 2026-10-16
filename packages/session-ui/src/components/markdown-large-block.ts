import { MARKDOWN_RICH_BLOCK_MAX_BYTES, type Projection } from "./markdown-stream"
import { MARKDOWN_WORKER_MAX_JOB_BYTES } from "./markdown-worker-admission"

const fenceLine = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/

/** Conservative proof that Markdown parsing yields one literal paragraph.
 * Unlike an unparsed-source fallback this has final Markdown semantics, so it
 * can be committed incrementally without ever changing presentation later. */
export function isLiteralMarkdownParagraph(text: string) {
  if (!text || /^(?: {4}|\t)/.test(text)) return false
  if (/[\\`*_\[\]<>!&#~$\r\n]/.test(text)) return false
  if (/^[ ]{0,3}-{3,}[ ]*$/.test(text)) return false
  if (/^[ \t]{0,3}(?:[-+]\s|\d{1,9}[.)]\s)/.test(text)) return false
  if (/(?:https?:\/\/|www\.|@)/i.test(text)) return false
  return true
}

/**
 * Avoid lexing a single oversized source block as one worker job. A complete
 * fenced block keeps its code body and language so the renderer can provide
 * its normal code shell and copy control while committing the source in frames.
 * Other single blocks retain their exact source for the isolated rich-body
 * worker. Syntax-free prose has a proven final paragraph projection.
 */
export function oversizedMarkdownProjection(text: string): Projection | undefined {
  const bytes = text.length * 2
  if (bytes <= MARKDOWN_RICH_BLOCK_MAX_BYTES) return undefined

  if (isLiteralMarkdownParagraph(text))
    return { text, blocks: [{ raw: text, src: text, mode: "full", plainParagraph: true }] }

  const firstNewline = text.indexOf("\n")
  if (firstNewline > 0 && firstNewline <= 256) {
    const opening = fenceLine.exec(text.slice(0, firstNewline).replace(/\r$/, ""))
    if (opening) {
      const marker = opening[1]!
      // Inspect only the bounded suffix. A full lastIndexOf over every
      // streaming token makes huge code fences repeatedly scan their entire
      // accumulated body on the renderer thread.
      const suffixStart = Math.max(0, text.length - 258)
      const suffix = text.slice(suffixStart)
      const suffixNewline = suffix.lastIndexOf("\n")
      const closeStart = suffixNewline < 0 ? -1 : suffixStart + suffixNewline + 1
      const closingLength = closeStart < 0 ? Infinity : text.length - closeStart
      const closing = closingLength <= 256 ? text.slice(closeStart).replace(/\r?\n?$/, "").trimEnd() : ""
      const closingFence = new RegExp(`^[\\t ]{0,3}${marker[0]}{${marker.length},}[\\t ]*$`)
      if (closingFence.test(closing)) {
        const language = opening[2]!.trim().split(/\s+/, 1)[0]?.toLowerCase() || undefined
        return {
          text,
          blocks: [{
            raw: text,
            src: text.slice(firstNewline + 1, closeStart),
            mode: "code",
            language,
            complete: true,
          }],
        }
      }
    }
  }

  // Once the source exceeds worker admission, paragraph structure no longer
  // changes the safe outcome. Avoid scanning the entire jumbo string just to
  // decide whether to return the same lossless rich-body projection.
  if (bytes > MARKDOWN_WORKER_MAX_JOB_BYTES)
    return { text, blocks: [{ raw: text, src: text, mode: "full" }] }

  const hasParagraphBoundary = /\r?\n[ \t]*\r?\n/.test(text)
  if (!hasParagraphBoundary)
    return { text, blocks: [{ raw: text, src: text, mode: "full" }] }
  return undefined
}
