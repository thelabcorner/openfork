/**
 * A virtualized tree can contain thousands of logical items despite mounting
 * only one viewport. Preserve the entire previous array when the BLOCK
 * STRUCTURE is unchanged so the virtualizer sees no spurious item invalidation.
 *
 * During normal telemetry, title and status updates the key sequence is
 * unchanged. Reconcile positionally without allocating an O(N) Map; only build
 * that map when inserting/removing/reordering actual tree blocks.
 */
export function reuseChatSidebarVirtualBlocks<T extends { key: string }>(
  previous: readonly T[],
  next: T[],
  same: (a: T, b: T) => boolean,
): T[] {
  if (!previous.length) return next
  if (previous.length === next.length) {
    let identical = true
    let aligned = true
    for (let i = 0; i < next.length; i++) {
      const before = previous[i]!
      const after = next[i]!
      if (before.key !== after.key) {
        aligned = false
        identical = false
        continue
      }
      if (same(before, after)) next[i] = before
      else identical = false
    }
    if (identical) return previous as T[]
    if (aligned) return next
  }
  const prior = new Map(previous.map((block) => [block.key, block] as const))
  for (let i = 0; i < next.length; i++) {
    const block = next[i]!
    const existing = prior.get(block.key)
    if (existing && same(existing, block)) next[i] = existing
  }
  return next
}