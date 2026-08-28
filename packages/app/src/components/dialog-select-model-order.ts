// Pure ordering helpers for the model selector's drag-to-reorder. Stored
// orders live in the persisted `model.order` record (see context/models.tsx);
// each entry holds a full snapshot of `providerID:modelID` keys in the user's
// chosen order for one section ("favorites" or a provider group). Keys
// missing from the snapshot (models added after the last reorder) keep their
// cost-sorted position by appending after every pinned model, so a stale
// snapshot never shuffles new releases into the middle of a group.

// Sorts `items` so models present in `order` come first in that order; the
// rest keep their incoming (cost-sorted) order. Returns the input reference
// when the order would not visibly change anything.
export function applySectionOrder<T>(items: T[], order: string[] | undefined, keyOf: (item: T) => string): T[] {
  if (!order || order.length < 2 || items.length < 2) return items
  const rank = new Map(order.map((key, index) => [key, index]))
  let pinned = 0
  for (const item of items) if (rank.has(keyOf(item))) pinned++
  if (pinned < 2) return items
  return [...items].sort(
    (a, b) => (rank.get(keyOf(a)) ?? Number.POSITIVE_INFINITY) - (rank.get(keyOf(b)) ?? Number.POSITIVE_INFINITY) || 0,
  )
}

// While a drag is in progress the underlying list stays untouched; rows
// between the dragged item's origin (`from`) and its current drop index
// (`to`) are preview-shifted by one row height instead. Returns the pixel
// offset for a row at `index` within the section.
export function dragPreviewOffset(from: number, to: number, index: number, height: number) {
  if (from === to || index === from) return 0
  if (from < to && index > from && index <= to) return -height
  if (to < from && index >= to && index < from) return height
  return 0
}
