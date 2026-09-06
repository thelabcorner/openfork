/**
 * Incremental cursor over the directories a watcher queue overflow declared
 * lost.
 *
 * Kept free of Solid primitives and of the FileProvider barrel so it can be
 * imported and tested directly -- importing `../file` pulls in
 * `createSimpleContext` -> `solid-js/web`, whose server build (what `bun test`
 * resolves without the browser condition) has no `use` export.
 *
 * The recovery path must never be able to re-arm the overflow it is servicing.
 * The old code enqueued the entire loaded-directory snapshot in one pass, so a
 * tree with more than WATCHER_DIR_QUEUE_MAX loaded directories hit the overflow
 * branch on the 513th enqueue, re-armed `staleAll`, and re-entered recovery --
 * a permanent listing loop that also kept the whole tree permanently stale and
 * the scheduler permits saturated.
 */
export const WATCHER_DIR_QUEUE_MAX = 512

// How many recovered directories the stale-drain moves into the live queue per
// pump. Deliberately far below WATCHER_DIR_QUEUE_MAX: the recovery path must
// never be able to push the queue to the overflow threshold, because overflow
// is what arms recovery in the first place.
export const WATCHER_STALE_DRAIN_BATCH = 32

export type StaleDrainDeps = {
  visible: () => boolean
  disposed: () => boolean
  staleAll: () => boolean
  setStaleAll: (value: boolean) => void
  /** Scanned ONCE per recovery, not once per store mutation. */
  loadedDirectories: () => string[]
  isLoaded: (dir: string) => boolean
  markTreeStale: () => void
  enqueue: (dir: string) => void
  queueSize: () => number
  drain: () => void
  /** Invalidations collected while the pane was hidden. */
  stale: Set<string>
  batch?: number
}

export function createStaleDrain(deps: StaleDrainDeps) {
  const batch = deps.batch ?? WATCHER_STALE_DRAIN_BATCH
  let cursor: { dirs: string[]; index: number } | undefined

  const settle = () => {
    if (cursor && cursor.index >= cursor.dirs.length) cursor = undefined
  }

  const pumpCursor = () => {
    settle()
    if (!cursor) return false
    const end = Math.min(cursor.index + batch, cursor.dirs.length)
    for (; cursor.index < end; cursor.index++) {
      const dir = cursor.dirs[cursor.index]
      // A directory can be dropped (scope switch, live-tree trim) between the
      // snapshot and its turn in the drain.
      if (dir !== undefined && deps.isLoaded(dir)) deps.enqueue(dir)
    }
    settle()
    return true
  }

  const pumpStaleSet = () => {
    if (deps.stale.size === 0) return false
    let moved = 0
    for (const dir of deps.stale) {
      deps.stale.delete(dir)
      // Only refresh dirs still loaded in the tree. Events that landed while the
      // tree was hidden may reference dirs that were reset on a project switch;
      // refreshing those would be wasted work and a burst of listDir calls.
      if (deps.isLoaded(dir)) deps.enqueue(dir)
      if (++moved >= batch) break
    }
    return true
  }

  return {
    /**
     * Snapshot the loaded index once and start walking it. Returns false when
     * there is nothing to recover or a walk is already in flight -- restarting
     * mid-drain would re-bump the stale epoch and re-invalidate the effect.
     */
    beginRecovery() {
      if (!deps.staleAll() || cursor) return false
      const loaded = deps.loadedDirectories()
      deps.markTreeStale()
      cursor = { dirs: loaded, index: 0 }
      deps.setStaleAll(false)
      return true
    },

    /**
     * Move a bounded slice into the live queue. Batches whose directories all
     * disappeared enqueue nothing, so the loop keeps slicing instead of parking
     * the cursor: the drain is the only caller of `continuePump`, and it never
     * starts on an empty queue.
     */
    pump() {
      let moved = false
      while (cursor && deps.queueSize() < batch) {
        if (!pumpCursor()) break
        moved = true
      }
      if (pumpStaleSet()) moved = true
      return moved
    },

    /** Top the queue back up when a drain batch completes. */
    continuePump() {
      if (deps.disposed() || !deps.visible()) return false
      if (deps.queueSize() >= batch) return false
      if (!pumpCursor()) return false
      deps.drain()
      return true
    },

    pending: () => cursor !== undefined,

    reset() {
      cursor = undefined
      deps.setStaleAll(false)
    },
  }
}
