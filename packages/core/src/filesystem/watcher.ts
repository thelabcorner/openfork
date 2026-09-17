export * as Watcher from "./watcher"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { makeLocationNode } from "../effect/app-node"
import { Cause, Context, Effect, Layer } from "effect"
import { FileSystemWatcher } from "@opencode-ai/schema/filesystem-watcher"
import path from "path"
import { Config } from "../config"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { lazy } from "../util/lazy"
import { Ignore } from "./ignore"
import { Protected } from "./protected"

declare const OPENCODE_LIBC: string | undefined

const SUBSCRIBE_TIMEOUT_MS = 10_000
const MAX_PENDING_UPDATES = 4096
const DRAIN_CHUNK_SIZE = 64

// Process-local ownership registry for successfully established project-root
// subscriptions. Consumers that want to reuse a completed project materialization
// must not infer watcher liveness from feature flags or native binding presence:
// neither proves that this directory is actually being observed. Refcounts keep
// this correct if more than one location graph temporarily refers to the same
// canonical root during a migration or reload.
const activeRoots = new Map<string, number>()

function rootKey(directory: string) {
  const resolved = path.resolve(directory).replaceAll("\\", "/")
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function retainRoot(directory: string) {
  const key = rootKey(directory)
  activeRoots.set(key, (activeRoots.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (activeRoots.get(key) ?? 1) - 1
    if (next <= 0) activeRoots.delete(key)
    else activeRoots.set(key, next)
  }
}

export const Event = FileSystemWatcher.Event

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const relative = path.relative(dir, item)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

export const hasNativeBinding = () => !!watcher()

/** Number of live native project-root subscriptions for this canonical path. */
export const activeRootCount = (directory: string) => activeRoots.get(rootKey(directory)) ?? 0

/**
 * Whether the owning Core watcher has successfully subscribed this project
 * root. This is runtime ownership state, not a feature/configuration guess.
 */
export const hasActiveRoot = (directory: string) => activeRootCount(directory) > 0

/**
 * Collapse exact-duplicate notifications (same path AND same type) within one
 * native batch. Editors and atomic saves routinely emit several identical
 * notifications for a single change; each duplicate would otherwise cost a
 * full event publish + SSE fan-out. Different types for the same path are all
 * kept — collapsing e.g. create+change would lose the "add" transition.
 */
export function dedupeUpdates<T extends { path: string; type: string }>(updates: readonly T[]): T[] {
  const seen = new Map<string, string>()
  return updates.filter((update) => {
    if (seen.get(update.path) === update.type) return false
    seen.set(update.path, update.type)
    return true
  })
}

export function isGitControlPath(relative: string) {
  const normalized = relative.replaceAll("\\", "/")
  return normalized === "HEAD" || normalized === "packed-refs" || normalized.startsWith("refs/")
}

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileWatcher") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return Service.of({})

    const backend = getBackend()
    const location = yield* Location.Service
    if (!backend) {
      yield* Effect.logError("watcher backend not supported", {
        directory: location.directory,
        platform: process.platform,
      })
      return Service.of({})
    }

    const w = watcher()
    if (!w) return Service.of({})

    yield* Effect.logInfo("watcher backend", { directory: location.directory, platform: process.platform, backend })
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const subscriptions: ParcelWatcher.AsyncSubscription[] = []
    const releaseRoots: Array<() => void> = []
    const pending = new Map<string, { path: string; type: string }>()
    let draining = false
    let stopped = false
    // Keep the same project-specific ignore rules at the callback boundary.
    // Native backends receive these rules too, but a second check is required
    // because branch switches can surface descendants after the backend has
    // already applied its ignore list.
    let callbackIgnore: string[] = []

    const drain = () => {
      if (stopped || draining || pending.size === 0) return
      draining = true
      runFork(
        Effect.gen(function* () {
          while (pending.size > 0) {
            const batch: Array<{ path: string; type: string }> = []
            for (const [key, update] of pending) {
              pending.delete(key)
              batch.push(update)
              if (batch.length >= DRAIN_CHUNK_SIZE) break
            }
            yield* Effect.forEach(
              batch,
              (update) =>
                events.publish(Event.Updated, {
                  file: update.path,
                  event:
                    update.type === "create" ? "add" : update.type === "update" ? "change" : "unlink",
                }),
              { discard: true },
            )
            // Bound each synchronous publication slice. A 4K path storm must
            // not occupy one event-loop turn while another session is trying to
            // dispatch a provider request, flush SSE, or commit a token.
            yield* Effect.yieldNow
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              draining = false
              if (!stopped && pending.size > 0) drain()
            }),
          ),
        ),
      )
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopped = true
        pending.clear()
      }),
    )
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()))),
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const release of releaseRoots.splice(0)) release()
      }),
    )

    // Some default ignore rules match directories/files a project genuinely
    // tracks (`.opencode/`, `packages/desktop/`, a root `bin/`, a tracked
    // `*.log`). A watcher that hides tracked files is a freshness bug, not an
    // optimization, so the ignore set is derived from the tracked set:
    // patterns that would hide tracked files are dropped from the native list,
    // and the exact directories/files are whitelisted for the callback guard.
    // Refreshed when the git control subscription reports a ref change. Volume
    // stays bounded: generated `node_modules`/`dist` tracks nothing and remains
    // ignored.
    let trackedWhitelist: string[] = []
    let nativeIgnore: readonly string[] = Ignore.PATTERNS
    let refreshingWhitelist = false
    const refreshTrackedWhitelist = Effect.fnUntraced(function* () {
      if (location.vcs?.type !== "git") {
        trackedWhitelist = []
        nativeIgnore = Ignore.PATTERNS
        return
      }
      const repository = yield* git.repo.discover(location.directory)
      if (!repository) {
        trackedWhitelist = []
        nativeIgnore = Ignore.PATTERNS
        return
      }
      const tracked = yield* git.index
        .tracked({ repository })
        .pipe(Effect.catch(() => Effect.succeed([] as readonly string[])))
      const watchCoverage = Ignore.coverage(tracked)
      nativeIgnore = watchCoverage.native
      trackedWhitelist = watchCoverage.whitelist.flatMap((pattern) => [
        pattern,
        path.join(location.directory, pattern).replaceAll("\\", "/"),
      ])
    })
    yield* refreshTrackedWhitelist().pipe(Effect.catchCause(() => Effect.void))

    const refreshWhitelistSoon = () => {
      if (refreshingWhitelist) return
      refreshingWhitelist = true
      runFork(
        refreshTrackedWhitelist().pipe(
          Effect.ensuring(Effect.sync(() => (refreshingWhitelist = false))),
          Effect.catchCause(() => Effect.void),
        ),
      )
    }

    const callback = (gitDirectory?: string): ParcelWatcher.SubscribeCallback => (_error, updates) => {
      if (stopped) return
      if (updates.length === 0) return
      if (gitDirectory) refreshWhitelistSoon()
      // Parcel's ignore option is evaluated by the native backend, but some
      // backends still report descendants of ignored folders during a burst
      // (notably branch switches on Windows). Filter those hints at the
      // publication boundary as a second, backend-independent guard. Keep git
      // control files because the separate git subscription uses HEAD/ref
      // changes to refresh project state.
      const filtered = updates.filter((update) => {
        if (gitDirectory) return isGitControlPath(path.relative(gitDirectory, update.path))
        return (
          !Ignore.match(path.relative(location.directory, update.path), {
            extra: callbackIgnore,
            whitelist: trackedWhitelist,
          }) &&
          !Ignore.match(update.path, { extra: callbackIgnore, whitelist: trackedWhitelist })
        )
      })
      if (filtered.length === 0) return
      // Parcel already batches native notifications. Publish the batch from a
      // single fiber instead of scheduling one fiber per changed path.
      const deduped = dedupeUpdates(filtered)
      if (deduped.length === 0) return
      for (const update of deduped) {
        // Notifications invalidate state; retain the terminal hint per path.
        const key = update.path
        if (!pending.has(key) && pending.size >= MAX_PENDING_UPDATES) {
          // File notifications are hints; retaining only the newest bounded
          // window is preferable to allowing a burst of generated files to
          // grow the process indefinitely. Consumers re-list on each update.
          const oldest = pending.keys().next().value
          if (oldest !== undefined) pending.delete(oldest)
        }
        pending.set(key, update)
      }
      drain()
    }

    const subscribe = (directory: string, ignore: string[], gitDirectory?: string, projectRoot = false) => {
      const pending = w.subscribe(directory, callback(gitDirectory), { ignore, backend })
      return Effect.promise(() => pending).pipe(
        Effect.tap((subscription) =>
          Effect.sync(() => {
            subscriptions.push(subscription)
            if (projectRoot) releaseRoots.push(retainRoot(directory))
          }),
        ),
        Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
        Effect.catchCause((cause) => {
          pending.then((subscription) => subscription.unsubscribe()).catch(() => {})
          return Effect.logError("failed to subscribe", { directory, cause: Cause.pretty(cause) })
        }),
      )
    }

    const config = (yield* (yield* Config.Service).entries())
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((item) => item.info.watcher?.ignore ?? [])
    const configIgnore = new Set(config)
    callbackIgnore = [...new Set([...configIgnore, ...protecteds(location.directory)])]
    // Watch any project root, git or not (operator decision: the old `location.vcs &&` guard
    // from f95f877e5f deliberately skipped non-git roots; do not re-add it). Ignore patterns
    // (tracked-aware subset of Ignore.PATTERNS + config `watcher.ignore` + protected paths)
    // bound event volume while keeping every tracked directory observable.
    if (yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER) {
      yield* Effect.forkScoped(
        subscribe(
          location.directory,
          [...new Set([...nativeIgnore, ...configIgnore, ...protecteds(location.directory)])],
          undefined,
          true,
        ),
      )
    }

    if (location.vcs?.type === "git") {
      const resolved = (yield* git.repo.discover(location.directory))?.gitDirectory
      const vcs = resolved ? yield* fs.realPath(resolved).pipe(Effect.catch(() => Effect.succeed(resolved))) : undefined
      if (vcs && !configIgnore.has(".git") && !configIgnore.has(vcs) && (!resolved || !configIgnore.has(resolved))) {
        // Evaluate the allowlist on every event, including entries created
        // after subscription. Native exclusions avoid traversing object data.
        yield* Effect.forkScoped(subscribe(vcs, [path.join(vcs, "objects"), path.join(vcs, "logs")], vcs))
      }
    }

    return Service.of({})
  }).pipe(
    Effect.catchCause((cause) => {
      return Effect.logError("failed to init watcher service", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(Service.of({})),
      )
    }),
  ),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Config.node, Git.node, EventV2.node],
})
