/**
 * Suspend asynchronous Markdown DOM commits without removing any pixels that
 * have already been painted. IntersectionObserver can briefly report false
 * while the virtualized timeline remeasures a streaming row; destroying its
 * in-flight DOM here creates a visible empty-message flash.
 *
 * A pending wrapper is invalidated for the next visible reconciliation. The
 * source model remains authoritative; this only retains the last painted DOM.
 */
export function suspendMarkdownDomWork(
  container: HTMLElement,
  activeKeys: Set<string>,
  cancel: (key: string) => void,
) {
  if (activeKeys.size === 0) return false
  for (const key of activeKeys) cancel(key)
  for (const child of container.children) {
    if (!(child instanceof HTMLElement)) continue
    const key = child.dataset.markdownKey
    if (!key || !activeKeys.has(key)) continue
    // A cancelled incremental commit has not produced this block's final hash.
    // Force a fresh render when visibility returns, without blanking the
    // partially or fully painted subtree in the meantime.
    child.removeAttribute("data-markdown-hash")
    child.removeAttribute("data-markdown-pending")
  }
  activeKeys.clear()
  return true
}
