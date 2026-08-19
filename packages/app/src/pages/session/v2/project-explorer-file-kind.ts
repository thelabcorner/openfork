/** File-kind classification + binary URL helpers for the project explorer
 * editor pane. Owned here so the filetype dispatch (editor pane) and the
 * viewers share one source of truth. */

export type ProjectExplorerFileKind = "text" | "markdown" | "image" | "svg" | "pdf"

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mdown": "text/markdown",
  ".mkd": "text/markdown",
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"])

export function projectExplorerFileKind(path: string): ProjectExplorerFileKind {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase()
  if (ext === ".svg") return "svg"
  if (ext === ".pdf") return "pdf"
  if (ext === ".md" || ext === ".markdown" || ext === ".mdown" || ext === ".mkd") return "markdown"
  if (IMAGE_EXT.has(ext)) return "image"
  return "text"
}

export function projectExplorerMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase()
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

/** Binary files load as base64 content; viewers render via a data URL. */
export function binaryDataUrl(content: string, mime: string): string {
  return `data:${mime};base64,${content}`
}
