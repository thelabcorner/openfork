export * as ProjectInventory from "./project-inventory"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Duration, Effect, Layer, Option, Queue, Scope, SynchronizedRef } from "effect"
import { EventV2 } from "./event"
import { Git } from "./git"
import { Location } from "./location"
import { Ripgrep } from "./ripgrep"
import { AbsolutePath, RelativePath } from "./schema"
import { Watcher } from "./filesystem/watcher"
import { Ignore } from "./filesystem/ignore"

/**
 * Project-owned filesystem inventory.
 *
 * ## Ownership
 *
 * A canonical location owns one inventory. Sessions consume it, so session
 * count never multiplies project-wide filesystem discovery. The authoritative
 * producer is Git (`ls-files --cached` for the tracked set, `ls-files --others
 * --exclude-standard` for the untracked set), because that is the exact domain
 * Snapshot stages: dotfiles, tracked files under generated folders a UI watcher
 * ignores, and Git-ignore semantics are all preserved.
 *
 * ## Revision and invalidation domain
 *
 * `revision` changes only when the observed file set changes. Watcher deltas
 * apply incrementally; a `.git`-control event (branch switch, HEAD move)
 * invalidates the cached rebuild because tracked status may have changed.
 * Explicit `invalidate()` is available to mutation brokers.
 *
 * ## Known coverage boundary
 *
 * The native watcher intentionally ignores generated folders (`build`, `dist`,
 * `out`, `desktop`, caches, ...). If the inventory observes a file *under* one
 * of those folders (`gaps` is true), watcher-only incremental maintenance could
 * miss a sibling change, so `complete` is reported false. Consumers that need
 * exact freshness (Snapshot retention, untracked substitution) must check
 * `complete` and otherwise re-read the authoritative producer. A newly created,
 * never-observed ignored folder remains a documented residual until the watcher
 * or the inventory owns that folder explicitly.
 */
export type Coverage = "git" | "search" | "none"

export interface Diagnostics {
  readonly revision: number
  readonly rebuilds: number
  readonly deltas: number
  readonly tracked: number
  readonly untracked: number
  readonly coverage: Coverage
  readonly complete: boolean
  readonly gaps: boolean
  readonly watcherOwnedRoot: boolean
}

export interface Interface {
  /** All project files (tracked ∪ untracked, non-ignored), location-relative. */
  readonly files: (input?: { readonly path?: string }) => Effect.Effect<readonly string[]>
  /** Untracked, non-gitignored files only, location-relative. */
  readonly untracked: (input?: { readonly path?: string }) => Effect.Effect<readonly string[]>
  /** Force an authoritative Git rebuild before the next read. */
  readonly refresh: () => Effect.Effect<void>
  /** Mark the cached inventory stale; the next read rebuilds. */
  readonly invalidate: (reason?: string) => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Diagnostics>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectInventory") {}

const DEBOUNCE_MS = 150

type State = {
  readonly tracked: ReadonlySet<string>
  readonly untracked: ReadonlySet<string>
  readonly revision: number
  readonly rebuilds: number
  readonly deltas: number
  readonly coverage: Coverage
  readonly gaps: boolean
  readonly seeded: boolean
}

const emptyState: State = {
  tracked: new Set(),
  untracked: new Set(),
  revision: 0,
  rebuilds: 0,
  deltas: 0,
  coverage: "none",
  gaps: false,
  seeded: false,
}

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) => {
  if (left.size !== right.size) return false
  for (const item of left) if (!right.has(item)) return false
  return true
}

const toRelative = (root: string, file: string) => path.relative(root, file).replaceAll("\\", "/")

const under = (files: ReadonlySet<string>, scope: string | undefined) => {
  const prefix = scope ? scope.replaceAll("\\", "/").replace(/\/+$/, "") : ""
  if (!prefix || prefix === ".") return Array.from(files)
  return Array.from(files).filter((file) => file === prefix || file.startsWith(`${prefix}/`))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const git = yield* Git.Service
    const ripgrep = yield* Ripgrep.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope

    const directory = location.directory
    const state = yield* SynchronizedRef.make<State>(emptyState)

    const repo = yield* Effect.cached(
      location.vcs?.type === "git"
        ? git.repo.discover(AbsolutePath.make(directory)).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : Effect.succeed(undefined),
    )

    const gitScope = Effect.fnUntraced(function* () {
      const found = yield* repo
      if (!found) return undefined
      const relative = path.relative(found.worktree, directory).replaceAll("\\", "/")
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "."
      return relative
    })

    const rebuildFromSearch = Effect.fnUntraced(function* () {
      const found = new Set<string>()
      yield* ripgrep
        .find({
          cwd: directory,
          pattern: "*",
          limit: location.vcs ? Number.MAX_SAFE_INTEGER : 100_000,
          onEntry: (entry) => Effect.sync(() => found.add(String(entry.path))),
        })
        .pipe(Effect.catch(() => Effect.succeed([])))
      yield* SynchronizedRef.update(state, (current) => ({
        ...current,
        tracked: new Set<string>(),
        untracked: found,
        revision: current.seeded ? current.revision + 1 : current.revision,
        rebuilds: current.rebuilds + 1,
        coverage: "search" as const,
        gaps: true,
        seeded: true,
      }))
    })

    const rebuildFromGit = Effect.fnUntraced(function* () {
      const found = yield* repo
      if (!found) return yield* rebuildFromSearch()
      const relative = yield* gitScope()
      if (relative === undefined) return yield* rebuildFromSearch()
      const listed = yield* git.index
        .list({ repository: found, scope: RelativePath.make(relative) })
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!listed) return
      const tracked = new Set(listed.tracked.map((item) => String(item)))
      const untracked = new Set(listed.untracked.map((item) => String(item)))
      // Coverage proof against the watcher's actual domain: a path is covered
      // when neither the tracked-aware native rules nor the callback guard hide
      // it. Computed with the identical `Ignore.coverage` the watcher uses, so
      // the proof cannot drift from the observer.
      const watchCoverage = Ignore.coverage(tracked)
      const gaps = [...tracked, ...untracked].some(
        (file) =>
          Ignore.nativeIgnored(file, watchCoverage.native) ||
          Ignore.match(file, { whitelist: watchCoverage.whitelist }),
      )
      yield* SynchronizedRef.update(state, (current) => {
        const changed =
          current.coverage !== "git" || !sameSet(current.tracked, tracked) || !sameSet(current.untracked, untracked)
        return {
          ...current,
          tracked,
          untracked,
          revision: changed ? current.revision + 1 : current.revision,
          rebuilds: current.rebuilds + 1,
          coverage: "git" as const,
          gaps,
          seeded: true,
        }
      })
    })

    // Repository-preferred single-flight: one authoritative rebuild is shared by
    // every concurrent reader; `invalidate` forks a fresh generation.
    const [ensureFresh, invalidateFresh] = yield* Effect.cachedInvalidateWithTTL(
      rebuildFromGit().pipe(Effect.orDie),
      Duration.infinity,
    )

    const invalidate = Effect.fnUntraced(function* (reason?: string) {
      if (reason) yield* Effect.logDebug("project inventory invalidated", { directory, reason })
      yield* invalidateFresh
    })

    const refresh = Effect.fnUntraced(function* () {
      yield* invalidate("refresh")
      yield* ensureFresh
    })

    // Incremental watcher maintenance. A path event updates the untracked set
    // directly. `.git`-control events invalidate instead: tracked status may
    // have changed and only Git can answer that authoritatively.
    const queue = yield* Queue.dropping<{ readonly file: string; readonly event: "add" | "change" | "unlink" }>(4096)
    const unsubscribe = yield* events.listenLocation(
      Watcher.Event.Updated,
      { directory, workspaceID: location.workspaceID },
      (event) =>
        Effect.gen(function* () {
          const data = event.data as { file: string; event: "add" | "change" | "unlink" }
          yield* Queue.offer(queue, data).pipe(Effect.ignore)
        }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    const applyBatch = (batch: ReadonlyMap<string, "add" | "change" | "unlink">) =>
      Effect.gen(function* () {
        const control = Array.from(batch.keys()).some((file) => {
          const relative = toRelative(directory, file)
          return relative === ".git" || relative.startsWith(".git/")
        })
        if (control) return yield* invalidate("git.control")

        yield* SynchronizedRef.update(state, (current) => {
          if (!current.seeded) return current
          const deltas = new Map<string, boolean>()
          for (const [file, event] of batch) {
            const relative = toRelative(directory, file)
            if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue
            deltas.set(relative, event === "unlink")
          }
          if (deltas.size === 0) return current
          const untracked = new Set(current.untracked)
          let changed = false
          for (const [file, removed] of deltas) {
            if (removed) changed = untracked.delete(file) || changed
            else if (!untracked.has(file) && !current.tracked.has(file)) {
              untracked.add(file)
              changed = true
            }
          }
          if (!changed) return current
          return {
            ...current,
            untracked,
            revision: current.revision + 1,
            deltas: current.deltas + 1,
            // Deltas only arrive for paths the watcher observed, which are by
            // construction inside its coverage; gaps can only change when Git
            // re-enumerates at a rebuild.
          }
        })
      })

    yield* Effect.gen(function* () {
      while (true) {
        const first = yield* Queue.take(queue)
        const batch = new Map<string, "add" | "change" | "unlink">([[first.file, first.event]])
        yield* Effect.sleep(DEBOUNCE_MS)
        while (true) {
          const next = yield* Queue.poll(queue)
          if (Option.isNone(next)) break
          batch.set(next.value.file, next.value.event)
        }
        yield* applyBatch(batch)
      }
    }).pipe(Effect.forkIn(scope))

    const snapshot = () => SynchronizedRef.get(state)

    const complete = (current: State) =>
      current.coverage === "git" && !current.gaps && Watcher.hasActiveRoot(directory)

    const files = Effect.fn("ProjectInventory.files")(function* (input?: { readonly path?: string }) {
      yield* ensureFresh
      const current = yield* snapshot()
      return under(new Set([...current.tracked, ...current.untracked]), input?.path)
    })

    const untracked = Effect.fn("ProjectInventory.untracked")(function* (input?: { readonly path?: string }) {
      yield* ensureFresh
      const current = yield* snapshot()
      return under(current.untracked, input?.path)
    })

    const diagnostics = Effect.fn("ProjectInventory.diagnostics")(function* () {
      // Diagnostics must describe a seeded inventory, not the pre-read empty
      // state; readers and diagnostics therefore share the same single-flight.
      yield* ensureFresh
      const current = yield* snapshot()
      return {
        revision: current.revision,
        rebuilds: current.rebuilds,
        deltas: current.deltas,
        tracked: current.tracked.size,
        untracked: current.untracked.size,
        coverage: current.coverage,
        complete: complete(current),
        gaps: current.gaps,
        watcherOwnedRoot: Watcher.hasActiveRoot(directory),
      } satisfies Diagnostics
    })

    return Service.of({ files, untracked, refresh, invalidate, diagnostics })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node, EventV2.node, Git.node, Ripgrep.node],
})
