import type { Part } from "@opencode-ai/schema/session-v1"

/** Overlay only process-owned live parts onto already hydrated detail rows. */
export function overlayCurrentPartSnapshots<T extends { readonly info: { readonly id: string }; readonly parts: Part[] }>(
  items: readonly T[],
  snapshots: readonly Part[],
): Array<Omit<T, "parts"> & { parts: Part[] }> {
  if (items.length === 0 || snapshots.length === 0) return [...items]
  const byMessage = new Map<string, Map<string, Part>>()
  for (const part of snapshots) {
    let parts = byMessage.get(part.messageID)
    if (!parts) {
      parts = new Map()
      byMessage.set(part.messageID, parts)
    }
    parts.set(part.id, part)
  }
  return items.map((item) => {
    const active = byMessage.get(item.info.id)
    if (!active) return item
    const parts = new Map(item.parts.map((part) => [part.id, part]))
    for (const [id, part] of active) parts.set(id as Part["id"], part)
    return { ...item, parts: [...parts.values()].sort((a, b) => a.id.localeCompare(b.id)) }
  })
}
