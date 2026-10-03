/** Preserve keyed list identity when a projection is recomputed without data changes. */
export function reuseStableEntries<T>(previous: T[], next: T[], equal: (left: T, right: T) => boolean): T[] {
  if (previous.length !== next.length) return next
  for (let index = 0; index < previous.length; index++) {
    if (!equal(previous[index]!, next[index]!)) return next
  }
  return previous
}
