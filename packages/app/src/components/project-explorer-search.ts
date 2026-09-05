export type ProjectExplorerSearchTree = {
  isExpanded: (path: string) => boolean
  expand: (path: string, options?: { generation?: number; priority?: "interactive" | "background" }) => void
  collapse: (path: string) => void
  beginGeneration?: () => number
}

/**
 * Owns the directory expansions made to reveal search results.
 *
 * Search must not permanently change the user's tree layout. The controller
 * only records directories it expands itself, so clearing a search can restore
 * the prior layout without touching directories the user had already opened.
 */
export function createProjectExplorerSearchExpansion(tree: ProjectExplorerSearchTree) {
  const owned = new Set<string>()

  const releasePath = (path: string) => {
    if (tree.isExpanded(path)) tree.collapse(path)
    owned.delete(path)
  }

  const release = () => {
    for (const path of owned) releasePath(path)
  }

  let suppressedQuery: string | undefined
  let lastQuery: string | undefined

  const sync = (ancestors: ReadonlySet<string> | undefined, query = "") => {
    if (!ancestors) {
      // Clearing a query invalidates queued search expansions. Avoid bumping
      // the generation for every reactive refresh while the tree is already
      // clear; unrelated watcher/index updates must not cancel valid work.
      if (lastQuery !== undefined || owned.size > 0) tree.beginGeneration?.()
      release()
      suppressedQuery = undefined
      lastQuery = undefined
      return
    }

    // A manual expand/collapse-all action owns the current query's layout.
    // Keep that decision through async directory listing updates; a new query
    // starts a fresh search-expansion lifecycle.
    if (suppressedQuery === query) return
    const generation = lastQuery === query ? undefined : tree.beginGeneration?.()
    suppressedQuery = undefined
    lastQuery = query

    // Query changes can make previously revealed branches irrelevant. Release
    // only those branches; unrelated user-controlled expansion is untouched.
    for (const path of owned) {
      if (!ancestors.has(path)) releasePath(path)
    }

    // The search renderer needs every matching ancestor visible. Record only
    // transitions from collapsed to expanded so cleanup stays lossless.
    for (const path of ancestors) {
      // A new query cancelled the preceding generation, including requests
      // for ancestors that remain expanded. Re-enqueue those listings too;
      // the store deduplicates loaded directories without another HTTP call.
      if (generation !== undefined && (owned.has(path) || tree.isExpanded(path))) {
        tree.expand(path, { generation, priority: "interactive" })
        continue
      }
      if (owned.has(path) || tree.isExpanded(path)) continue
      owned.add(path)
      tree.expand(path, generation === undefined ? undefined : { generation, priority: "interactive" })
    }
  }

  return {
    sync,
    /** Mark a directory as user-controlled after a direct tree interaction. */
    userToggled: (path: string) => owned.delete(path),
    /** Manual expand/collapse-all actions supersede search ownership. */
    releaseAll: (query = "") => {
      tree.beginGeneration?.()
      owned.clear()
      suppressedQuery = query
    },
    dispose: () => {
      release()
      suppressedQuery = undefined
    },
  }
}
