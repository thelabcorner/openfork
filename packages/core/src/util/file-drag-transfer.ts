export const FILE_DRAG_TRANSFER_MAX_ITEMS = 512
export const FILE_DRAG_TRANSFER_MAX_CHARS = 128 * 1024

export type FileDragTransfer = {
  plainText: string
  uriList: string
  included: number
  total: number
  truncated: boolean
}

/**
 * Build a bounded native DataTransfer payload.
 *
 * Internal tree moves keep their authoritative selection in application state,
 * so a native drag payload must never synchronously stringify an arbitrary
 * 10k/50k selection merely for interoperability with external drop targets.
 */
export function buildFileDragTransfer(
  paths: Iterable<string>,
  toFileUrl: (path: string) => string,
  options: { total?: number; maxItems?: number; maxChars?: number } = {},
): FileDragTransfer {
  const maxItems = Math.max(1, options.maxItems ?? FILE_DRAG_TRANSFER_MAX_ITEMS)
  const maxChars = Math.max(256, options.maxChars ?? FILE_DRAG_TRANSFER_MAX_CHARS)
  const plain: string[] = []
  const uris: string[] = []
  let chars = 0
  let seen = 0

  for (const path of paths) {
    seen++
    if (plain.length >= maxItems) break
    const plainLine = `file:${path}`
    const uriLine = toFileUrl(path)
    const added = plainLine.length + uriLine.length + 4
    if (plain.length > 0 && chars + added > maxChars) break
    plain.push(plainLine)
    uris.push(uriLine)
    chars += added
  }

  const total = Math.max(options.total ?? seen, seen)
  return {
    plainText: plain.join("\n"),
    uriList: uris.join("\r\n"),
    included: plain.length,
    total,
    truncated: plain.length < total,
  }
}

/** Parse the `file:<path>` newline protocol emitted by OpenCode file drags. */
export function parseFileDragText(value: string | undefined): string[] {
  if (!value) return []
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || lines.some((line) => !line.startsWith("file:"))) return []
  return lines.map((line) => line.slice("file:".length)).filter(Boolean)
}
