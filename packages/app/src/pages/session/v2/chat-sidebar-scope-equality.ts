/** Stable membership identity for selectors driven by frequently re-minted
 * Session rows. A title/updated-time change is NOT a scope change, so it
 * must not replay the entire SessionGroup roster or footer subscriptions.
 */
export function sameChatSidebarIDSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/** Footer attention auto-response policy is directory-dependent. Preserve the
 * exact per-session directory set, not only its session IDs, across updates.
 */
export function sameChatSidebarDirectoryScope(
  a: { directories: ReadonlyMap<string, ReadonlySet<string>> },
  b: { directories: ReadonlyMap<string, ReadonlySet<string>> },
): boolean {
  if (a === b) return true
  if (a.directories.size !== b.directories.size) return false
  for (const [id, dirs] of a.directories) {
    const other = b.directories.get(id)
    if (!other || !sameChatSidebarIDSet(dirs, other)) return false
  }
  return true
}

/** Only owning-directory changes should invalidate Status permission policy,
 * not every title, timestamp or other metadata update in the root index. */
export function sameChatSidebarSessionDirectories(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, directory] of a) if (b.get(id) !== directory) return false
  return true
}