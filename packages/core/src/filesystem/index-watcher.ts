export * as FileIndexWatcher from "./index-watcher"

import path from "path"
import { Context, Effect, Layer, Queue } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { FileIndex } from "./index"
import { deriveDir } from "./index-watcher-dir"
import { Watcher } from "./watcher"

// The visible explorer waits 120ms before it re-lists a watcher-touched
// directory. Refresh the server-side metadata cache ahead of that request so
// the UI normally observes the patched metadata in the same round trip. This is
// still long enough to coalesce native save/create bursts.
const DEBOUNCE_MS = 50
const MAX_PENDING_PATHS = 4096
const MAX_PENDING_DIRS = 1024
const REFRESH_CONCURRENCY = 2

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileIndex/Watcher") {}

// Routes raw filesystem watcher events into incremental directory refreshes.
// Do not invalidate a whole subtree: the explorer also force-lists watcher
// changes, and the old 150ms invalidation raced its 120ms refresh, throwing away
// a freshly rebuilt cache and guaranteeing another scan. The FileIndex refresh
// preserves untouched file metadata and re-stats only watcher-touched paths.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const index = yield* FileIndex.Service

    type PendingDir = { paths: Set<string>; forceMetadata: boolean }
    const pending = new Map<string, PendingDir>()
    let pendingPathCount = 0
    const wake = yield* Queue.dropping<void>(1)
    const unsubscribe = yield* events.listenLocation(
      Watcher.Event.Updated,
      { directory: location.directory, workspaceID: location.workspaceID },
      (event) =>
      Effect.gen(function* () {
        const data = event.data as { file: string; event: "add" | "change" | "unlink" }
        const dir = deriveDir(location.directory, data.file)
        if (dir === undefined) return
        const relative = path.relative(location.directory, data.file).replaceAll("\\", "/")
        let item = pending.get(dir)
        if (!item) {
          if (pending.size >= MAX_PENDING_DIRS) {
            // Pathological fan-out (e.g. package-manager churn across thousands
            // of directories) must not make this debounce map unbounded. Drop
            // only the cached subtree for overflow dirs. The next visible list
            // rebuilds it from disk, preserving correctness without queuing more
            // proactive I/O while the storm is still arriving.
            yield* index.invalidate(dir).pipe(Effect.ignore)
            return
          }
          item = { paths: new Set(), forceMetadata: false }
          pending.set(dir, item)
        }
        if (!item.forceMetadata && !item.paths.has(relative)) {
          if (pendingPathCount >= MAX_PENDING_PATHS) {
            // Collapse overflow per directory instead of dropping freshness
            // hints. The fallback does one stat-only metadata pass for that
            // directory, bounded by the same structural listing we need anyway.
            pendingPathCount -= item.paths.size
            item.paths.clear()
            item.forceMetadata = true
          } else {
            item.paths.add(relative)
            pendingPathCount++
          }
        }
        yield* Queue.offer(wake, undefined).pipe(Effect.ignore)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(wake)
        yield* Effect.sleep(DEBOUNCE_MS)
        const batch = [...pending.entries()]
        pending.clear()
        pendingPathCount = 0
        yield* Effect.forEach(
          batch,
          ([dir, item]) =>
            index
              .refresh(dir, {
                changedPaths: item.forceMetadata ? undefined : [...item.paths],
                forceMetadata: item.forceMetadata,
              })
              .pipe(Effect.ignore),
          { concurrency: REFRESH_CONCURRENCY, discard: true },
        )
      }
    }).pipe(Effect.forkScoped)

    return Service.of({})
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FileIndex.node, Location.node, EventV2.node],
})
