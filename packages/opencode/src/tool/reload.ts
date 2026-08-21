// Tool hot-reload: detects changes to file-based custom tools ({tool,tools}/*.{js,ts}) and
// plugin files ({plugin,plugins}/*.{ts,js}), re-imports them fresh (bypassing Bun's
// pathname-keyed module cache via loadToolModule), validates the new custom slice BEFORE
// swapping it into the registry, and notifies clients over EventV2 (ToolEvent.Reloaded).
//
// Detection (docs/architecture/tool-hot-reload.md §3.2):
//   a) watcher — subscribe to the core FileWatcher "file.watcher.updated" stream and filter
//      by path + instance location (primary; active wherever OPENCODE_EXPERIMENTAL_FILEWATCHER
//      is on, e.g. desktop).
//   b) poll — fingerprint (size + content hash) every watched file across ALL config dirs
//      every ~2s. Covers the global config dir, which the core watcher does not watch, and
//      CLI where the watcher flag is off.
//   c) manual — reload(reason: "manual") from the V1 POST /tool/reload endpoint.
//
// Safety invariants:
//   - Validate before swap: duplicate ids within the reload set is a hard no-swap error;
//     on ANY failure the old state is kept and the event carries the error.
//   - One-at-a-time gate (Ref) so concurrent triggers coalesce; a short backoff skips new
//     reloads for ~500ms after a failure.
//   - The swap is atomic (registry.refreshCustom) and only affects the NEXT prompt-step
//     resolve; in-flight tool executions keep their captured def (tool-hot-reload §2).
//   - Plugin-file reload never re-applies hooks (subscriptions): the fresh module's tool
//     defs are extracted and swapped, and a "plugin hooks require restart" warning is
//     attached (P1 scope, tool-hot-reload §3.3).
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ignore } from "@opencode-ai/core/filesystem/ignore"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2 } from "@opencode-ai/core/event"
import { ToolEvent } from "@opencode-ai/schema/tool-event"
import { Glob } from "@opencode-ai/core/util/glob"
import type { ToolDefinition } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import path from "path"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Plugin } from "../plugin"
import type { PluginLoader } from "../plugin/loader"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { fromPlugin, isPluginTool, type CustomToolDeps } from "./custom"
import { loadToolModule } from "./import"
import { Agent } from "@/agent/agent"
import { Truncate } from "./truncate"
import { Clock, Context, Effect, Layer, Option, Queue, Ref, Scope } from "effect"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"

declare const OPENCODE_LIBC: string | undefined

const DEBOUNCE_MS = 250
const POLL_INTERVAL_MS = 2_000
const BACKOFF_MS = 500

export type ReloadReason = "watcher" | "poll" | "manual"

export interface ReloadResult {
  readonly ok: boolean
  readonly added: string[]
  readonly updated: string[]
  readonly removed: string[]
  readonly warnings: string[]
  readonly error?: string
}

export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly reload: (reason: ReloadReason) => Effect.Effect<ReloadResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolReload") {}

type Fingerprint = { readonly size: number; readonly hash: string }

type ReloadState = {
  readonly run: (reason: ReloadReason) => Effect.Effect<ReloadResult>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const plugin = yield* Plugin.Service
    const agent = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<ReloadState>(
      Effect.fn("ToolReload.state")(function* (ctx) {
        const deps: CustomToolDeps = { agent, truncate, directory: ctx.directory, worktree: ctx.worktree }
        const gate = yield* Ref.make(false)
        const pending = yield* Ref.make(false)
        const backoffUntil = yield* Ref.make(0)
        const dirty = yield* Ref.make(new Set<string>())
        const fingerprints = yield* Ref.make(new Map<string, Fingerprint>())
        const triggers = yield* Queue.dropping<"watcher" | "poll">(32)
        const dirs = yield* config.directories()

        const run = Effect.fn("ToolReload.run")(function* (reason: ReloadReason) {
          // One-at-a-time gate: a trigger arriving mid-run coalesces via the pending flag,
          // which makes the current pass re-run once after it finishes.
          if (yield* Ref.getAndSet(gate, true)) {
            yield* Ref.set(pending, true)
            return {
              ok: true,
              added: [],
              updated: [],
              removed: [],
              warnings: ["tool reload already in progress; coalesced into the current run"],
            }
          }
          const result = yield* Effect.gen(function* () {
            // Simple backoff: skip new watcher/poll reloads shortly after a failure. Manual
            // reloads are never backoff-blocked — they are the explicit escape hatch.
            if (reason !== "manual" && (yield* Clock.currentTimeMillis) < (yield* Ref.get(backoffUntil))) {
              return {
                ok: true,
                added: [],
                updated: [],
                removed: [],
                warnings: ["tool reload skipped: backing off after a recent failure"],
              }
            }
            let passes = 0
            let last: ReloadResult
            do {
              yield* Ref.set(pending, false)
              last = yield* reloadOnce(reason)
              if (!last.ok) yield* Ref.set(backoffUntil, (yield* Clock.currentTimeMillis) + BACKOFF_MS)
            } while ((yield* Ref.get(pending)) && ++passes < 3)
            return last
          }).pipe(Effect.onExit(() => Ref.set(gate, false)))
          return result
        })

        const reloadOnce = Effect.fn("ToolReload.reloadOnce")(function* (reason: ReloadReason) {
          // The Electron desktop sidecar is Node-based. Bun's module
          // transpiler is required for safe file-tool hot reload, so a Node
          // reload must preserve the currently registered custom slice. A
          // partial rebuild here could change the model-visible tool set
          // mid-session and destabilize provider prefix/context caching.
          if (typeof Bun === "undefined") {
            return {
              ok: true,
              added: [],
              updated: [],
              removed: [],
              warnings: ["tool hot-reload unavailable in Node; existing tool registry preserved"],
            }
          }
          const changed = yield* Ref.getAndSet(dirty, new Set<string>())
          const warnings: string[] = []
          if ([...changed].some((file) => isPluginFile(dirs, file))) {
            warnings.push("plugin hooks require restart")
          }

          const attempt = Effect.gen(function* () {
            const custom = yield* buildCustomSlice(warnings)
            const diff = yield* registry.refreshCustom(custom)
            return { added: diff.added, updated: diff.updated, removed: diff.removed, warnings }
          })

          const result: ReloadResult = yield* attempt.pipe(
            Effect.map((r) => ({ ok: true, ...r })),
            Effect.catch((error) =>
              Effect.succeed({
                ok: false,
                added: [],
                updated: [],
                removed: [],
                warnings,
                error: `tool reload failed: ${error}`,
              }),
            ),
            Effect.catchDefect((defect) =>
              Effect.succeed({
                ok: false,
                added: [],
                updated: [],
                removed: [],
                warnings,
                error: `tool reload failed: ${String(defect)}`,
              }),
            ),
          )

          // Always notify — success payload or the error (old state is kept on failure).
          yield* events.publish(ToolEvent.Reloaded, eventData(result)).pipe(Effect.ignore)
          if (!result.ok) yield* Effect.logWarning("tool reload failed", { reason, error: result.error })
          return result
        })

        // Build the full new custom slice (file tools + plugin tools, registry build order)
        // and validate it. Any load/conversion failure fails the whole reload (no swap).
        const buildCustomSlice = Effect.fn("ToolReload.buildCustomSlice")(function* (warnings: string[]) {
          const fileTools = yield* loadFileTools(scanToolFiles(dirs))
          const pluginFileTools = yield* loadPluginFileTools(scanPluginFiles(dirs), warnings)
          const installed = yield* loadInstalledPluginTools()
          const sourced = [
            ...fileTools.map((def) => ({ def, source: "file" as const })),
            ...pluginFileTools.map((def) => ({ def, source: "plugin" as const })),
            ...installed.map((def) => ({ def, source: "plugin" as const })),
          ]
          // Self-conflict: a duplicate id within the same source is a hard no-swap error.
          // Cross-conflict (file vs plugin): keep the existing precedence (plugin defs are
          // pushed after file defs, so they win on duplicates, exactly like the registry
          // build) and attach a warning instead of failing.
          const counts = new Map<string, { file: number; plugin: number }>()
          const warned = new Set<string>()
          for (const { def, source } of sourced) {
            const entry = counts.get(def.id) ?? { file: 0, plugin: 0 }
            entry[source] += 1
            counts.set(def.id, entry)
            if (entry[source] > 1) {
              return yield* Effect.fail(
                `duplicate tool id "${def.id}" within ${source} tools; reload aborted`,
              )
            }
            if (entry.file > 0 && entry.plugin > 0 && !warned.has(def.id)) {
              warned.add(def.id)
              warnings.push(
                `tool "${def.id}" is defined by both a file and a plugin; keeping existing precedence`,
              )
            }
          }
          return sourced.map((item) => item.def)
        })

        const loadFileTools = Effect.fn("ToolReload.loadFileTools")(function* (files: string[]) {
          const defs: Tool.Def[] = []
          if (typeof Bun === "undefined") {
            // The desktop sidecar is Node/Electron. Do not let the optional
            // Bun hot-reload path fail the user's prompt.
            return defs
          }
          for (const file of files) {
            // loadToolModule re-reads + bundles + re-imports, bypassing Bun's module cache.
            const mod = yield* Effect.promise(() => loadToolModule(file)).pipe(
              Effect.mapError((error) => `failed to load tool file ${file}: ${errorMessage(error)}`),
            )
            // Same id naming as the registry scan: default export -> basename, named export
            // `foo` -> `${basename}_foo`.
            const namespace = path.basename(file, path.extname(file))
            for (const [id, def] of Object.entries(mod)) {
              if (!isPluginTool(def)) continue
              defs.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def, deps))
            }
          }
          return defs
        })

        const loadPluginFileTools = Effect.fn("ToolReload.loadPluginFileTools")(function* (
          files: string[],
          warnings: string[],
        ) {
          const defs: Tool.Def[] = []
          for (const file of files) {
            const loaded = yield* Effect.promise(() => Plugin.reloadPluginEntry(resolvedPluginEntry(file)))
            if (!loaded.ok) {
              // A plugin entry that cannot be re-imported (multi-file / not self-contained)
              // degrades to a warning; its tools keep the previous state.
              warnings.push(`plugin file ${file}: ${loaded.error}`)
              continue
            }
            for (const [id, def] of Object.entries(pluginToolDefs(loaded.mod))) {
              if (!isPluginTool(def)) continue
              defs.push(fromPlugin(id, def, deps))
            }
          }
          return defs
        })

        const loadInstalledPluginTools = Effect.fn("ToolReload.loadInstalledPluginTools")(function* () {
          const defs: Tool.Def[] = []
          const plugins = yield* plugin.list()
          for (const p of plugins) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
              defs.push(fromPlugin(id, def, deps))
            }
          }
          return defs
        })

        // Watcher detection (1/2): filter the core FileWatcher EventV2 stream to this
        // instance's directory and to files inside any config dir's
        // {tool,tools,plugin,plugins} folder. This stream only fires where the core
        // watcher is active (OPENCODE_EXPERIMENTAL_FILEWATCHER + git root, e.g. desktop).
        const unsubscribe = yield* events.listen((event) =>
          Effect.gen(function* () {
            if (event.type !== Watcher.Event.Updated.type) return
            if (event.location?.directory !== ctx.directory) return
            const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
            if (!isWatchedFile(dirs, data.file)) return
            yield* Ref.update(dirty, (set) => new Set(set).add(data.file))
            yield* Queue.offer(triggers, "watcher").pipe(Effect.ignore)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)

        // Watcher detection (2/2): ToolReload's OWN @parcel/watcher subscription over each
        // config dir, deliberately NOT git-gated and independent of
        // OPENCODE_EXPERIMENTAL_FILEWATCHER — tool/plugin files must hot-reload in ANY
        // project root, git or not. Native callback re-enters Effect through EffectBridge;
        // subscriptions are unsubscribed when the instance scope is disposed. If the native
        // binding is unavailable or a dir cannot be subscribed, we degrade to the poll.
        const nativeWatcher = nativeWatcherBinding()
        if (nativeWatcher) {
          const bridge = yield* EffectBridge.make()
          const backend = watcherBackend()
          yield* Effect.logInfo("tool reload watcher: subscribing to config dirs", {
            dirs: dirs.length,
            backend,
            ignoreCount: Ignore.PATTERNS.length,
          })
          const callback = bridge.bind((_error: Error | null, updates: ParcelWatcher.Event[]) => {
            for (const update of updates) {
              if (!isWatchedFile(dirs, update.path)) continue
              const file = update.path
              bridge.fork(
                Effect.gen(function* () {
                  yield* Ref.update(dirty, (set) => new Set(set).add(file))
                  yield* Queue.offer(triggers, "watcher").pipe(Effect.ignore)
                }),
              )
            }
          })
          const subscriptions: ParcelWatcher.AsyncSubscription[] = []
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()))),
          )
          for (const dir of dirs) {
            const pending = nativeWatcher.subscribe(dir, callback, { ignore: Ignore.PATTERNS, backend })
            yield* Effect.promise(() => pending).pipe(
              Effect.tap((subscription) => Effect.sync(() => subscriptions.push(subscription))),
              Effect.catch((error) =>
                Effect.logWarning("tool reload watcher: failed to subscribe", { dir, error: errorMessage(error) }),
              ),
            )
          }
          yield* Effect.logInfo("tool reload watcher: subscribed", {
            subscribed: subscriptions.length,
            attempted: dirs.length,
          })
        } else {
          yield* Effect.logWarning("tool reload watcher: native binding unavailable, falling back to poll", {
            dirs: dirs.length,
          })
        }

        // Poll detection: fingerprint every watched file across all config dirs. Catches
        // changes the watchers miss (global config dir on the core side, newly-created
        // .opencode dirs, half-written saves) and self-heals after the debounce/backoff
        // windows.
        yield* Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(POLL_INTERVAL_MS)
            const changed = yield* pollChanged()
            if (changed) yield* Queue.offer(triggers, "poll").pipe(Effect.ignore)
          }
        }).pipe(Effect.forkScoped)

        // Debounced consumer: wait for a trigger, let the write settle, drain any burst,
        // then run the gated reload once.
        yield* Effect.gen(function* () {
          while (true) {
            const reason = yield* Queue.take(triggers)
            yield* Effect.sleep(DEBOUNCE_MS)
            while (Option.isSome(yield* Queue.poll(triggers))) {}
            yield* run(reason).pipe(Effect.ignore)
          }
        }).pipe(Effect.forkScoped)

        const pollChanged = Effect.fn("ToolReload.pollChanged")(function* () {
          const files = [...scanToolFiles(dirs), ...scanPluginFiles(dirs)]
          const current = new Map<string, Fingerprint>()
          for (const file of files) current.set(file, yield* fingerprint(file))
          const previous = yield* Ref.get(fingerprints)
          const changed = files.filter((file) => {
            const next = current.get(file)!
            const prev = previous.get(file)
            return !prev || prev.size !== next.size || prev.hash !== next.hash
          })
          for (const file of previous.keys()) {
            if (!current.has(file)) changed.push(file)
          }
          if (changed.length) yield* Ref.update(dirty, (set) => new Set([...set, ...changed]))
          yield* Ref.set(fingerprints, current)
          return changed.length > 0
        })

        return { run }
      }),
    )

    const start: Interface["start"] = Effect.fn("ToolReload.start")(function* () {
      yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
    })

    const reload: Interface["reload"] = Effect.fn("ToolReload.reload")(function* (reason: ReloadReason) {
      return yield* InstanceState.useEffect(state, (s) => s.run(reason))
    })

    return Service.of({ start, reload })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, Plugin.node, EventV2Bridge.node, ToolRegistry.node, Agent.node, Truncate.node],
})

// ---- pure helpers ----

function eventData(result: ReloadResult): {
  added: string[]
  updated: string[]
  removed: string[]
  error?: string
} {
  return result.error
    ? { added: result.added, updated: result.updated, removed: result.removed, error: result.error }
    : { added: result.added, updated: result.updated, removed: result.removed }
}

function scanToolFiles(dirs: string[]) {
  return dirs.flatMap((dir) =>
    Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
  )
}

function scanPluginFiles(dirs: string[]) {
  return dirs.flatMap((dir) =>
    Glob.scanSync("{plugin,plugins}/*.{ts,js}", { cwd: dir, absolute: true, dot: true, symlink: true }),
  )
}

// A file is "watched" iff it is a direct child of a config dir's tool/tools/plugin/plugins
// folder. The watcher emits absolute paths with OS-native separators.
function isWatchedFile(dirs: string[], file: string) {
  const ext = path.extname(file)
  if (ext !== ".ts" && ext !== ".js") return false
  const parent = path.dirname(file).replaceAll("\\", "/")
  return dirs.some((dir) => {
    const base = dir.replaceAll("\\", "/")
    return (
      parent === `${base}/tool` ||
      parent === `${base}/tools` ||
      parent === `${base}/plugin` ||
      parent === `${base}/plugins`
    )
  })
}

function isPluginFile(dirs: string[], file: string) {
  const parent = path.dirname(file).replaceAll("\\", "/")
  return dirs.some((dir) => {
    const base = dir.replaceAll("\\", "/")
    return parent === `${base}/plugin` || parent === `${base}/plugins`
  })
}

function resolvedPluginEntry(file: string): PluginLoader.Resolved {
  return { spec: file, options: undefined, deprecated: false, source: "file", target: file, entry: file }
}

// Extract tool defs from a freshly re-imported plugin module. V1 plugin tool maps are
// produced by running server(), which would re-apply hooks — out of scope here — so we
// read whatever tool/tools map is statically available on the module or its default
// descriptor; the "plugin hooks require restart" warning covers the rest.
function pluginToolDefs(mod: Record<string, unknown>): Record<string, ToolDefinition> {
  const descriptor =
    mod.default && typeof mod.default === "object" && mod.default !== null
      ? (mod.default as Record<string, unknown>)
      : mod
  const map = "tool" in descriptor ? descriptor.tool : "tools" in descriptor ? descriptor.tools : undefined
  return map && typeof map === "object" && map !== null ? (map as Record<string, ToolDefinition>) : {}
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

// Lazy @parcel/watcher wrapper, mirroring packages/core/src/filesystem/watcher.ts. The
// native binding packages are platform-specific; missing bindings degrade gracefully.
let cachedWatcher: typeof import("@parcel/watcher") | undefined | null
function nativeWatcherBinding() {
  if (cachedWatcher !== undefined) return cachedWatcher
  try {
    const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    cachedWatcher = createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    cachedWatcher = null
  }
  return cachedWatcher
}

function watcherBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  return "inotify"
}

const fingerprint = Effect.fnUntraced(function* (file: string) {
  const source = yield* Effect.promise(() => Bun.file(file).text()).pipe(
    Effect.catch(() => Effect.succeed("")),
  )
  return { size: source.length, hash: createHash("sha1").update(source, "utf8").digest("hex") }
})

export * as ToolReload from "./reload"
