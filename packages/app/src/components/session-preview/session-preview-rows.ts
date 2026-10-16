import type {
  SessionPreviewRelationships,
  SessionPreviewSectionKind,
  SessionPreviewTreeRow,
} from "./session-preview-model"

export interface PreviewListItem {
  first: boolean
  sectionKey: string
  sectionName: string
  sectionKind: SessionPreviewSectionKind | "special"
  sectionCount: number
  row: SessionPreviewTreeRow
  parentTitle?: string
}

export function previewRelationshipCount(rel: SessionPreviewRelationships | undefined) {
  if (!rel) return 0
  let count = rel.specialAgents.length
  for (const section of rel.sections) count += section.rows.length
  return count
}

/** No intermediate array allocation for member-ID scans (status summary,
 * open-all, and counts). Retains section order including special agents. */
export function forEachPreviewSession(
  rel: SessionPreviewRelationships | undefined,
  visit: (sessionID: string) => void,
) {
  if (!rel) return
  for (const section of rel.sections)
    for (const item of section.rows) visit(item.row.id)
  for (const item of rel.specialAgents) visit(item.row.id)
}

/**
 * Precompute row multiplicities on relationship changes, not on every tab
 * open/close or status change. A session may appear in several memberships:
 * counts must retain that historical multiplicity, not deduplicate the UI.
 */
export function previewSessionWeights(rel: SessionPreviewRelationships | undefined): ReadonlyMap<string, number> {
  const weights = new Map<string, number>()
  forEachPreviewSession(rel, (id) => weights.set(id, (weights.get(id) ?? 0) + 1))
  return weights
}

/** O(number of open tabs), after a one-time O(relationship rows) index. */
export function previewUnopenedCount(weights: ReadonlyMap<string, number>, openIDs: Iterable<string>, total: number) {
  let remaining = total
  for (const id of openIDs) remaining -= weights.get(id) ?? 0
  return remaining
}

/** Only materialize the first visible page as rich presentation entries.
 * A group with 10,000 members should not allocate 10,000 list wrappers to
 * display a virtualized window of at most 80. Structural relationships and
 * bulk actions remain complete through the unmodified producer projection.
 */
export function previewVisibleRows(
  rel: SessionPreviewRelationships | undefined,
  limit: number,
  specialAgentsName: string,
): PreviewListItem[] {
  if (!rel || limit <= 0) return []
  const items: PreviewListItem[] = []
  for (let sectionIndex = 0; sectionIndex < rel.sections.length; sectionIndex++) {
    const section = rel.sections[sectionIndex]!
    for (let i = 0; i < section.rows.length && items.length < limit; i++) {
      items.push({
        first: i === 0,
        sectionKey: `section-${sectionIndex}`,
        sectionName: section.name,
        sectionKind: section.kind,
        sectionCount: section.rows.length,
        row: section.rows[i]!,
      })
    }
    if (items.length >= limit) return items
  }
  for (let i = 0; i < rel.specialAgents.length && items.length < limit; i++) {
    const entry = rel.specialAgents[i]!
    items.push({
      first: i === 0,
      sectionKey: "special-agents",
      sectionName: specialAgentsName,
      sectionKind: "special",
      sectionCount: rel.specialAgents.length,
      row: { row: entry.row, depth: 0, last: true },
      parentTitle: entry.parentTitle,
    })
  }
  return items
}