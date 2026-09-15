import type { VisualArtifactPreview } from "./browserHostClient"

export interface VisualObjectUrlAdapter {
  create(blob: Blob): string
  revoke(url: string): void
}

const defaultAdapter: VisualObjectUrlAdapter = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
}

export const isInlineVisualMime = (mime: string): boolean =>
  mime === "image/png" || mime === "image/gif" || mime === "image/svg+xml" || mime === "image/jpeg"

/**
 * Owns renderer blob URLs for SnapEye previews. Every replacement revokes the
 * previous URL immediately and clearAll() is intended for Solid onCleanup.
 * This keeps repeated visual-history browsing from retaining megabytes of
 * immutable PNG/filmstrip data in the renderer process.
 */
export class VisualPreviewCache {
  private readonly urls = new Map<string, string>()

  constructor(private readonly adapter: VisualObjectUrlAdapter = defaultAdapter) {}

  replace(key: string, preview: VisualArtifactPreview | null): string | null {
    this.clear(key)
    if (!preview || !isInlineVisualMime(preview.descriptor.mime)) return null
    // Copy into a standalone ArrayBuffer so the Blob never retains a larger
    // structured-clone backing store that happened to contain this view.
    const bytes = new Uint8Array(preview.bytes)
    const url = this.adapter.create(new Blob([bytes.buffer], { type: preview.descriptor.mime }))
    this.urls.set(key, url)
    return url
  }

  clear(key: string): void {
    const current = this.urls.get(key)
    if (!current) return
    this.urls.delete(key)
    this.adapter.revoke(current)
  }

  clearAll(): void {
    for (const url of this.urls.values()) this.adapter.revoke(url)
    this.urls.clear()
  }

  get size(): number {
    return this.urls.size
  }
}

export function decodeVisualJson(preview: VisualArtifactPreview | null): unknown {
  if (!preview || preview.descriptor.mime !== "application/json") return null
  try {
    return JSON.parse(new TextDecoder().decode(preview.bytes))
  } catch {
    return null
  }
}
