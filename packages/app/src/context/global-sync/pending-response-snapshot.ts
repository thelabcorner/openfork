export function reconcilePendingBySession<T extends { readonly sessionID: string }>(
  previous: Readonly<Record<string, ReadonlyArray<T>>>,
  snapshot: ReadonlyArray<T>,
): Record<string, T[]> {
  const next: Record<string, T[]> = Object.fromEntries(Object.keys(previous).map((sessionID) => [sessionID, []]))
  for (const item of snapshot) (next[item.sessionID] ??= []).push(item)
  return next
}
