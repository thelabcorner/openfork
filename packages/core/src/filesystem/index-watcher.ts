export * as FileIndexWatcher from "./index-watcher"

import { Context, Effect, Layer, Option, Queue, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { FileIndex } from "./index"
import { deriveDir } from "./index-watcher-dir"
import { Watcher } from "./watcher"

const DEBOUNCE_MS = 150

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileIndex/Watcher") {}

// Routes raw filesystem watcher events into incremental index invalidation so a
// large project patches the changed subtree instead of rescanning. Mirrors the
// proven debounced-batch consumer in filesystem/search.ts: location-filtered,
// latest event per changed dir wins, then FileIndex.invalidate(dirPath) marks
// just that subtree stale for a targeted re-scan on next list.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const index = yield* FileIndex.Service

    const queue = yield* Queue.dropping<string>(1024)
    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (event.type !== Watcher.Event.Updated.type) return
        const data = event.data as { file: string; event: "add" | "change" | "unlink" }
        if (event.location && event.location.directory !== location.directory) return
        const dir = deriveDir(location.directory, data.file)
        if (dir === undefined) return
        yield* Queue.offer(queue, dir).pipe(Effect.ignore)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    yield* Effect.gen(function* () {
      while (true) {
        const first = yield* Queue.take(queue)
        const batch = new Set<string>([first])
        yield* Effect.sleep(DEBOUNCE_MS)
        while (true) {
          const next = yield* Queue.poll(queue)
          if (Option.isNone(next)) break
          batch.add(next.value)
        }
        for (const dir of batch) {
          yield* index.invalidate(dir).pipe(Effect.ignore)
        }
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
