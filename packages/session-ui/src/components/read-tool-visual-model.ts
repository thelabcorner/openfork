import type { VisualToolPresentation } from "./tool-visual-media-model"

const imageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

/**
 * Read's image is stored on the *tool part's attachments*, not metadata or
 * output. Keep the original data URL: copying/decoding base64 for each render
 * is costly (particularly for a run of extracted video frames).
 *
 * SVG reads remain text reads for the agent and the source-code viewer. Only
 * project a visual from a complete document, never from a paginated fragment.
 */
export function readToolVisualPresentation(
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  attachments: unknown,
): VisualToolPresentation | undefined {
  const display = record(metadata.display)
  const rawPath = text(input.filePath) ?? text(input.file_path) ?? text(display?.path)
  const name = rawPath?.split(/[\\/]/).pop()

  if (Array.isArray(attachments)) {
    for (const value of attachments) {
      const attachment = record(value)
      if (attachment?.type !== "file") continue
      const mime = text(attachment.mime)
      const url = text(attachment.url)
      if (!mime || !url || !imageMimes.has(mime)) continue
      const prefix = `data:${mime};base64,`
      if (!url.startsWith(prefix) || url.length === prefix.length) continue
      return {
        kind: "read",
        origin: "file",
        name,
        sources: [{ key: "read", kind: "read", inline: { mime, url } }],
        initialSource: "read",
      }
    }
  }

  const path = text(display?.path)
  const svg = text(display?.text)
  if (
    metadata.action !== "read" ||
    display?.type !== "file" ||
    !path?.toLowerCase().endsWith(".svg") ||
    display.truncated !== false ||
    display.lineStart !== 1 ||
    display.lineEnd !== display.totalLines ||
    !svg ||
    !/<svg(?:\s|\/|>)/i.test(svg)
  )
    return

  return {
    kind: "read",
    origin: "file",
    name: path.split(/[\\/]/).pop(),
    sources: [
      {
        key: "read",
        kind: "read",
        inline: { mime: "image/svg+xml", url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` },
      },
    ],
    initialSource: "read",
  }
}
