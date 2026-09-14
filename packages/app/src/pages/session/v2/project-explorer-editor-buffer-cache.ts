export const PROJECT_EXPLORER_CLEAN_BUFFER_MAX_CHARS = 8 * 1024 * 1024

export type CacheableEditorBuffer = {
  path: string
  savedContent: string
  dirty: boolean
  binary?: string
  cold?: boolean
}

const retainedChars = (buffer: CacheableEditorBuffer) => buffer.savedContent.length + (buffer.binary?.length ?? 0)

/**
 * Bound duplicate content retained solely by inactive clean editor tabs.
 * Dirty and active buffers are correctness-critical and never evicted.
 * Oldest tab order is the eviction order, matching the pane's stable buffer
 * list without maintaining another reactive LRU structure.
 */
export function trimProjectExplorerEditorBuffers<T extends CacheableEditorBuffer>(
  buffers: readonly T[],
  activePath: string | undefined,
  maxChars = PROJECT_EXPLORER_CLEAN_BUFFER_MAX_CHARS,
): T[] {
  let total = 0
  for (const buffer of buffers) {
    if (buffer.cold) continue
    total += retainedChars(buffer)
  }
  if (total <= maxChars) return buffers as T[]

  let changed = false
  const next = [...buffers]
  for (let index = 0; index < next.length && total > maxChars; index++) {
    const buffer = next[index]!
    if (buffer.path === activePath || buffer.dirty || buffer.cold) continue
    const released = retainedChars(buffer)
    if (released === 0) continue
    total -= released
    changed = true
    next[index] = { ...buffer, savedContent: "", binary: undefined, cold: true }
  }
  return changed ? next : (buffers as T[])
}
