export * as FileIndex from "./index"

import path from "path"
import { Context, Effect, Layer, Option, Queue, Ref } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { IndexSerialization } from "./index-serialization"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { RelativePath } from "../schema"
import { Hash } from "../util/hash"
import { ChunkStore } from "../search/chunk-store"
import { availableParallelism } from "node:os"

/**
 * Server-side persisted, incrementally-invalidated project file index.
 *
 * The index is a pure directory-enumeration cache: it stores, per directory
 * (relative to the project root), the exact `FileSystem.list` output for that
 * directory. The V1 `file.list` handler derives `name`/`absolute`/`ignored` at
 * serve time (gitignore can change independently), so the index only caches the
 * expensive part — walking and stat'ing directory entries.
 *
 * Persistence is the single global SQLite `file-index/<sha256(root)>.db`
 * (`ChunkStore`, same DB as the search index). The explorer snapshot is stored
 * as `meta` key `fileIndex` (canonical JSON + digest via `IndexSerialization`);
 * search chunks + `fileMeta` live in the same DB. There is no per-project
 * JSON file and no repo-local `.opencode/file-index.json.br` Brotli copy —
 * both were removed. See `packages/core/src/search/index-service.ts` and
 * `chunk-store.ts` — both indexes now share `Global.data/file-index/` and the
 * same `Watcher` pipeline.
 */

export const SCHEMA_VERSION = 1
const DEBOUNCE_MS = 300
// FileIndex is an interactive directory cache, not a second whole-repository
// database. Keep both the live catalog and its durable snapshot bounded. Search
// owns full-project discovery and metadata persistence.
const MAX_LIVE_SUBTREES = 2_048
const MAX_LIVE_ENTRIES = 50_000
const MAX_PERSISTED_SUBTREES = 512
const MAX_PERSISTED_ENTRIES = 4_096
const MAX_PERSISTED_BYTES = 1024 * 1024

export type RootStat = IndexSerialization.IndexRootStat
export type Subtree = IndexSerialization.IndexSubtree
export type IndexState = IndexSerialization.IndexBlobInput

export interface Patch {
  readonly op: "put" | "delete"
  readonly dir: string
  readonly entry?: FileSystem.Entry
  readonly entryPath?: string
}

export interface Interface {
  /** Serve children of `path` from the index, falling back to a scan on miss. */
  readonly list: (path: RelativePath) => Effect.Effect<readonly FileSystem.Entry[]>
  /** O(1) catalog lookup by root-relative path (no trailing slash). */
  readonly lookup: (path: string) => FileSystem.Entry | undefined
  /** Drop a subtree so the next `list` re-scans it from disk. */
  readonly invalidate: (dirPath: string) => Effect.Effect<void>
  /** Apply an incremental put/delete patch to a cached subtree. */
  readonly applyPatch: (patch: Patch) => Effect.Effect<void>
  /** Re-scan one directory. `changedPaths` forces metadata refresh only for the
   * watcher-touched entries; `forceMetadata` is the bounded overflow fallback. */
  readonly refresh: (
    dirPath: string,
    options?: { readonly changedPaths?: readonly string[]; readonly forceMetadata?: boolean },
  ) => Effect.Effect<void>
  /** Force a synchronous persist (used by tests; production uses debounced flush). */
  readonly flush: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileIndex") {}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Normalize a directory path to a subtree key: strip leading "./", trailing
 * "/", and collapse "." to "". */
export function normalizeDirPath(input: string): string {
  return input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "").replace(/^\.$/, "")
}

/** Normalize an entry path to the forward-slash, root-relative convention the
 * contract (and the file-tree client) expects. `FileSystem.list` returns
 * OS-native separators (`\` on Windows); the index stores `/`. */
function normalizeEntryPath(input: string): string {
  return input.replaceAll("\\", "/")
}

function catalogKey(input: string): string {
  return normalizeEntryPath(input).replace(/\/$/, "")
}

function normalizeEntries(entries: readonly FileSystem.Entry[]): FileSystem.Entry[] {
  return entries.map((entry) => ({
    ...entry,
    path: RelativePath.make(normalizeEntryPath(String(entry.path))),
  }))
}

/** Mirror `FileSystem.list` ordering: directories first, then alphabetical. */
export function compareEntries(a: FileSystem.Entry, b: FileSystem.Entry): number {
  if (a.type === b.type) return a.path.localeCompare(b.path)
  return a.type === "directory" ? -1 : 1
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const filesystem = yield* FileSystem.Service
    const global = yield* Global.Service

    const root = yield* fs.realPath(location.directory).pipe(Effect.orDie)
    const cachePath = path.join(global.data, "file-index", `${Hash.sha256(root)}.json`)

    const isOpencodePath = (p: string) => p === ".opencode" || p.startsWith(".opencode/")

    const subtrees = new Map<string, Subtree>()
    const byPath = new Map<string, FileSystem.Entry>()
    const scanVersions = new Map<string, number>()
    const restoredSubtrees = new Set<string>()
    const subtreeTouches = new Map<string, number>()
    let touchClock = 0
    let cachedEntries = 0
    let builtAt = 0
    let rootStat: RootStat | undefined
    let loaded = false
    let persistRevision = 0

    const touchSubtree = (dir: string) => subtreeTouches.set(dir, ++touchClock)
    const dropSubtree = (dir: string) => {
      const prev = subtrees.get(dir)
      if (!prev) return false
      for (const e of prev.entries) byPath.delete(catalogKey(String(e.path)))
      cachedEntries -= prev.entries.length
      subtreeTouches.delete(dir)
      restoredSubtrees.delete(dir)
      scanVersions.delete(dir)
      return subtrees.delete(dir)
    }
    const dropBranch = (dir: string) => {
      const key = normalizeDirPath(dir)
      const prefix = key ? `${key}/` : ""
      let changed = false
      for (const candidate of [...subtrees.keys()]) {
        if (candidate !== key && (!prefix || !candidate.startsWith(prefix))) continue
        if (dropSubtree(candidate)) changed = true
      }
      return changed
    }
    const trimLiveCache = (protectedDir?: string) => {
      if (subtrees.size <= MAX_LIVE_SUBTREES && cachedEntries <= MAX_LIVE_ENTRIES) return
      const victims = [...subtrees.keys()]
        .filter((dir) => dir !== "" && dir !== protectedDir)
        .sort((left, right) => (subtreeTouches.get(left) ?? 0) - (subtreeTouches.get(right) ?? 0))
      for (const dir of victims) {
        if (subtrees.size <= MAX_LIVE_SUBTREES && cachedEntries <= MAX_LIVE_ENTRIES) break
        dropSubtree(dir)
      }
    }

    // A directory listing can never legitimately contain the same path twice,
    // but old persisted snapshots may contain duplicates from earlier hydrate
    // implementations. Deduping here covers restore and live scans and keeps
    // `byPath` consistent with the entries actually stored.
    const setSubtree = (dir: string, entries: FileSystem.Entry[], at = Date.now()) => {
      const prev = subtrees.get(dir)
      if (prev) {
        for (const e of prev.entries) byPath.delete(catalogKey(String(e.path)))
        cachedEntries -= prev.entries.length
      }
      const seen = new Set<string>()
      const deduped: FileSystem.Entry[] = []
      for (const e of entries) {
        const key = catalogKey(String(e.path))
        if (seen.has(key)) continue
        seen.add(key)
        deduped.push(e)
      }
      subtrees.set(dir, { at, entries: deduped })
      cachedEntries += deduped.length
      touchSubtree(dir)
      for (const e of deduped) byPath.set(catalogKey(String(e.path)), e)
      trimLiveCache(dir)
    }

    // Metadata is useful to the explorer, but it must never turn a directory
    // listing into a whole-project content crawl. Keep stat fan-out bounded and
    // only count lines for small batches (typically one/few watcher updates).
    // Large/cold directories get size+mtime only, mirroring SearchIndex's
    // structural-first policy. This avoids reading hundreds/thousands of source
    // files just because a tree node became visible.
    const STAT_CONCURRENCY = Math.max(1, Math.min(6, availableParallelism()))
    const LINE_COUNT_BATCH_LIMIT = 32
    const LINE_COUNT_MAX_BYTES = 512 * 1024
    const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|mp4|mp3|mov|avi|mkv|wasm|pyc|class|o|so|dll|exe|bin|dat|lock)$/i
    const countLines = (bytes: Uint8Array) => {
      if (bytes.byteLength === 0) return 1
      let lines = 1
      for (let index = 0; index < bytes.byteLength; index++) if (bytes[index] === 10) lines++
      return lines
    }
    const attachMeta = (
      entries: readonly FileSystem.Entry[],
      options?: { countLines?: boolean },
    ): Effect.Effect<FileSystem.Entry[]> =>
      Effect.forEach(
        entries,
        (entry) => {
          if (entry.type !== "file") return Effect.succeed(entry)
          const abs = path.join(root, catalogKey(String(entry.path)))
          return fs.stat(abs).pipe(
            Effect.flatMap((info) => {
              const size = Number(info.size)
              const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
              const base = {
                ...entry,
                size: Number.isFinite(size) ? size : undefined,
                mtime: mtime > 0 ? mtime : undefined,
              }
              if (
                options?.countLines === false ||
                !Number.isFinite(size) ||
                size > LINE_COUNT_MAX_BYTES ||
                BINARY_EXT_RE.test(String(entry.path))
              )
                return Effect.succeed(base)
              return fs.readFile(abs).pipe(
                Effect.map((bytes) => ({ ...base, lineCount: countLines(bytes) })),
                Effect.catch(() => Effect.succeed(base)),
              )
            }),
            Effect.catch(() => Effect.succeed(entry)),
          )
        },
        { concurrency: STAT_CONCURRENCY },
      )
    const dirty = yield* Ref.make(false)
    const flushQueue = yield* Queue.dropping<number>(1)

    const currentRootStat = (): Effect.Effect<RootStat> =>
      Effect.gen(function* () {
        const info = yield* fs.stat(root).pipe(Effect.orDie)
        return {
          mtimeMs: Math.round(Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
          size: Number(info.size),
          ino: Number(Option.getOrElse(info.ino, () => 0)),
        }
      })

    const dbPath = ChunkStore.dbPathFor(root, global.data)
    const withStore = <A>(fn: (store: ChunkStore.Interface) => Effect.Effect<A, unknown>) =>
      Effect.gen(function* () {
        const store = yield* ChunkStore.Service
        return yield* fn(store)
      }).pipe(Effect.provide(ChunkStore.layerFromPath(dbPath)), Effect.scoped)

    const persist = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const revision = persistRevision
        const snapshotSubtrees: Record<string, { at: number; entries: readonly FileSystem.Entry[] }> = {}
        // Persist the root plus the hottest directories only. Persisting every
        // expanded directory recreated the old whole-repo mirror: the 78k-node
        // benchmark produced a ~6 MiB blob with hundreds of milliseconds of
        // canonical-JSON/schema work. A bounded warm set retains the useful part
        // of persistence without making startup proportional to repository size.
        const ordered = [...subtrees.keys()].sort((left, right) => {
          if (left === "") return -1
          if (right === "") return 1
          return (subtreeTouches.get(right) ?? 0) - (subtreeTouches.get(left) ?? 0)
        })
        let persistedEntries = 0
        let persistedSubtrees = 0
        for (const dir of ordered) {
          if (persistedSubtrees >= MAX_PERSISTED_SUBTREES) break
          const sub = subtrees.get(dir)
          if (!sub) continue
          if (persistedEntries + sub.entries.length > MAX_PERSISTED_ENTRIES) continue
          snapshotSubtrees[dir] = { at: sub.at, entries: sub.entries.slice() }
          persistedEntries += sub.entries.length
          persistedSubtrees++
        }
        const snapshotRootStat = rootStat ?? (yield* currentRootStat())
        let state: IndexState = {
          schemaVersion: SCHEMA_VERSION,
          builtAt,
          root,
          rootStat: snapshotRootStat,
          subtrees: snapshotSubtrees,
        }
        let bytes = IndexSerialization.encode(state)
        if (bytes.byteLength > MAX_PERSISTED_BYTES) {
          // Pathological single directories / long paths can exceed the byte
          // budget even under the entry cap. Persist an empty valid warm set
          // rather than keeping or replacing it with another startup hazard.
          state = { ...state, subtrees: {} }
          bytes = IndexSerialization.encode(state)
        }
        const str = new TextDecoder().decode(bytes)
        // Unified SQLite persistence: single `file-index/<hash>.db` holds both
        // the search chunks (`ChunkStore`) and the explorer snapshot
        // (`fileIndex` meta). No per-project JSON file is written anymore.
        yield* withStore((store) => store.putMeta("fileIndex", str)).pipe(
          Effect.catch((error) => Effect.logWarning("file index sqlite persist failed", { error }).pipe(Effect.asVoid)),
        )
        if (revision !== persistRevision) return
        // Best-effort migration cleanup: delete legacy global JSON and any
        // lingering sidecars from pre-unified layouts. The SQLite `fileIndex`
        // meta is now the sole durable copy.
        yield* Effect.gen(function* () {
          yield* fs.remove(cachePath, { force: true }).pipe(Effect.ignore)
          const dir = path.dirname(cachePath)
          const base = path.basename(cachePath)
          for (const entry of yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([] as any)))) {
            const name = (entry as any).name as string
            if (name.startsWith(`${base}.`) && (name.endsWith(".chunk") || name.endsWith(".manifest") || name.includes(".front."))) {
              yield* fs.remove(path.join(dir, name), { force: true }).pipe(Effect.ignore)
            }
          }
          const legacyLocal = path.join(root, ".opencode", "file-index.json.br")
          yield* fs.remove(legacyLocal, { force: true }).pipe(Effect.ignore)
          const legacyDir = path.join(root, ".opencode")
          const legacyEntries = yield* fs.readDirectoryEntries(legacyDir).pipe(Effect.catch(() => Effect.succeed([] as any)))
          for (const entry of legacyEntries as any) {
            const name = (entry as any).name as string
            if (name.startsWith("file-index.json.br")) {
              yield* fs.remove(path.join(legacyDir, name), { force: true }).pipe(Effect.ignore)
            }
          }
        }).pipe(Effect.catch(() => Effect.void))
      }).pipe(
        Effect.catch((error) => Effect.logWarning("file index persist failed", { error }).pipe(Effect.asVoid)),
      )

    const markDirty = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        persistRevision++
        yield* Ref.set(dirty, true)
        yield* Queue.offer(flushQueue, 1).pipe(Effect.ignore)
      })

    // Debounced single-writer flush: coalesces bursts (e.g. watcher storms)
    // into one atomic write.
    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(flushQueue)
        yield* Effect.sleep(DEBOUNCE_MS)
        if (!(yield* Ref.get(dirty))) continue
        yield* Ref.set(dirty, false)
        yield* persist()
      }
    }).pipe(Effect.forkScoped)

    const tryLoadFileIndexMeta = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const str = yield* withStore((store) => store.getMeta("fileIndex")).pipe(
          Effect.catch(() => Effect.succeed(undefined as string | undefined)),
        )
        if (!str) return false
        // Old versions could persist the entire repository here. Avoid paying a
        // large JSON parse + schema walk + canonical re-hash on startup. The
        // first lazy scan will replace it with the bounded hot-set format.
        if (str.length > MAX_PERSISTED_BYTES) return false
        const bytes = new TextEncoder().encode(str)
        const blob = yield* IndexSerialization.decode(bytes).pipe(
          Effect.catch(() => Effect.succeed(undefined as IndexSerialization.IndexBlob | undefined)),
        )
        if (!blob) return false
        if (blob.root !== root) return false
        builtAt = blob.builtAt
        rootStat = blob.rootStat
        for (const [dir, sub] of Object.entries(blob.subtrees)) {
          if (isOpencodePath(dir)) continue
          const filtered = sub.entries.filter((e) => !isOpencodePath(String(e.path)))
          setSubtree(dir, normalizeEntries(filtered), sub.at)
          restoredSubtrees.add(dir)
        }
        return true
      }).pipe(Effect.catch(() => Effect.succeed(false)))

    const ensureLoaded = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (loaded) return
        loaded = true
        // Best-effort delete of the repo-local Brotli copy on first load —
        // it is no longer written, but old clones may still have it.
        yield* fs.remove(path.join(root, ".opencode", "file-index.json.br"), { force: true }).pipe(Effect.ignore)
        // Unified SQLite cold start: load only the explorer's own lazy snapshot.
        // Do NOT decode the search index's entire path corpus here. Search keeps
        // those chunks byte-oriented specifically so a 100k+ project does not
        // materialize every path just because the explorer asks for its root.
        // On cache miss, requested directories are scanned lazily below.
        const fromFileIndex = yield* tryLoadFileIndexMeta()
        if (fromFileIndex) return
        const bytes = yield* fs.readFile(cachePath).pipe(Effect.catch(() => Effect.succeed(undefined as Uint8Array | undefined)))
        if (bytes === undefined) return
        if (bytes.byteLength > MAX_PERSISTED_BYTES) return
        const blob = yield* IndexSerialization.decode(bytes).pipe(
          Effect.catch(() => Effect.succeed(undefined as IndexSerialization.IndexBlob | undefined)),
        )
        if (!blob) return
        builtAt = blob.builtAt
        rootStat = blob.rootStat
        for (const [dir, sub] of Object.entries(blob.subtrees)) {
          if (isOpencodePath(dir)) continue
          const filtered = sub.entries.filter((e) => !isOpencodePath(String(e.path)))
          setSubtree(dir, normalizeEntries(filtered), sub.at)
          restoredSubtrees.add(dir)
        }
      })

    const sameEntry = (left: FileSystem.Entry, right: FileSystem.Entry) =>
      left.path === right.path &&
      left.type === right.type &&
      left.size === right.size &&
      left.mtime === right.mtime &&
      left.lineCount === right.lineCount

    /**
     * Verify one directory structurally and preserve metadata for untouched
     * children. Directory enumeration is cheap; stat/read amplification is not.
     * This makes `list()` correct even when native watcher delivery is delayed or
     * disabled, while a one-file watcher change only stats/reads that one file.
     */
    const targetedScan = (
      dirPath: string,
      options?: { readonly changedPaths?: ReadonlySet<string>; readonly forceMetadata?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (isOpencodePath(dirPath)) return
        const version = (scanVersions.get(dirPath) ?? 0) + 1
        scanVersions.set(dirPath, version)
        const listed = yield* filesystem.list({ path: RelativePath.make(dirPath) }).pipe(
          Effect.option,
          Effect.catchDefect(() => Effect.succeed(Option.none())),
        )
        // A directory can disappear between hydrate and verification (deleted
        // while this process was stopped) or between two lists. `orDie` here
        // turned an ordinary offline deletion into an `Unexpected server
        // error` for the whole request, so treat "gone" as "empty": drop the
        // stale subtree instead of serving paths that no longer exist.
        if (Option.isNone(listed)) {
          if (scanVersions.get(dirPath) !== version) return
          if (dropBranch(dirPath)) yield* markDirty()
          return
        }
        const entries = normalizeEntries(listed.value).filter((e) => !isOpencodePath(String(e.path)))
        const previous = subtrees.get(dirPath)
        const previousByPath = new Map(previous?.entries.map((entry) => [catalogKey(String(entry.path)), entry]))
        const restored = restoredSubtrees.has(dirPath)
        const metadataTargets = entries.filter((entry) => {
          if (entry.type !== "file") return false
          const key = catalogKey(String(entry.path))
          const before = previousByPath.get(key)
          if (restored || options?.forceMetadata || options?.changedPaths?.has(key)) return true
          return !before || before.type !== "file" || before.size === undefined || before.mtime === undefined
        })
        const hydrated =
          metadataTargets.length === 0
            ? []
            : yield* attachMeta(metadataTargets, {
                countLines: !options?.forceMetadata && metadataTargets.length <= LINE_COUNT_BATCH_LIMIT,
              })
        const hydratedByPath = new Map(
          hydrated.map((entry) => {
            const key = catalogKey(String(entry.path))
            const before = previousByPath.get(key)
            // Stat-only bulk verification should not erase a valid cached line
            // count. Preserve it only when the file identity metadata matches.
            if (
              entry.lineCount === undefined &&
              before?.lineCount !== undefined &&
              before.size === entry.size &&
              before.mtime === entry.mtime
            ) {
              return [key, { ...entry, lineCount: before.lineCount }] as const
            }
            return [key, entry] as const
          }),
        )
        const next = entries.map((entry) => {
          // Directory aggregate size/mtime used to recursively walk every cached
          // descendant on each root response and became incorrect once the cache
          // was lazy. Directory rows stay structural; their loaded child count is
          // maintained client-side.
          if (entry.type === "directory") return entry
          const key = catalogKey(String(entry.path))
          return hydratedByPath.get(key) ?? previousByPath.get(key) ?? entry
        })
        // A later scan of the same directory started while this one was doing
        // metadata I/O. Never let an older snapshot win merely because it
        // completed last.
        if (scanVersions.get(dirPath) !== version) return
        restoredSubtrees.delete(dirPath)
        const nextDirectoryKeys = new Set(
          entries.filter((entry) => entry.type === "directory").map((entry) => catalogKey(String(entry.path))),
        )
        for (const old of previous?.entries ?? []) {
          if (old.type !== "directory") continue
          const key = catalogKey(String(old.path))
          if (!nextDirectoryKeys.has(key)) dropBranch(key)
        }
        const changed =
          !previous ||
          previous.entries.length !== next.length ||
          previous.entries.some((entry, index) => !next[index] || !sameEntry(entry, next[index]!))
        if (!changed) return
        setSubtree(dirPath, next)
        if (builtAt === 0) builtAt = Date.now()
        if (dirPath === "") rootStat = yield* currentRootStat()
        yield* markDirty()
      })

    const list = Effect.fn("FileIndex.list")(function* (input: RelativePath) {
      yield* ensureLoaded()
      const dirPath = normalizeDirPath(input)
      // Always do one cheap structural verification. This removes the coarse
      // timestamp race that made same-tick creates invisible on Windows and
      // avoids relying on watcher delivery for correctness. Unchanged files keep
      // their cached metadata, so this is readdir-scale work rather than N stats
      // plus N file reads.
      yield* targetedScan(dirPath)
      if (subtrees.has(dirPath)) touchSubtree(dirPath)
      return subtrees.get(dirPath)?.entries ?? []
    })

    const invalidate = Effect.fn("FileIndex.invalidate")(function* (dirPath: string) {
      if (dropSubtree(normalizeDirPath(dirPath))) yield* markDirty()
    })

    const applyPatch = Effect.fn("FileIndex.applyPatch")(function* (patch: Patch) {
      const key = normalizeDirPath(patch.dir)
      const sub = subtrees.get(key)
      if (!sub) return
      if (patch.op === "put" && patch.entry) {
        const rawPath = catalogKey(String(patch.entry.path)) + (patch.entry.type === "directory" ? "/" : "")
        const entry = { ...patch.entry, path: RelativePath.make(rawPath) }
        const stated = entry.type === "file" ? (yield* attachMeta([entry], { countLines: true }))[0]! : entry
        const statedKey = catalogKey(String(stated.path))
        const next = sub.entries.filter((item) => catalogKey(String(item.path)) !== statedKey)
        next.push(stated)
        next.sort(compareEntries)
        setSubtree(key, next)
        yield* markDirty()
      } else if (patch.op === "delete" && patch.entryPath) {
        const entryPath = catalogKey(patch.entryPath)
        const removed = sub.entries.find((item) => catalogKey(String(item.path)) === entryPath)
        const next = sub.entries.filter((item) => catalogKey(String(item.path)) !== entryPath)
        if (next.length !== sub.entries.length) {
          if (removed?.type === "directory") dropBranch(entryPath)
          setSubtree(key, next)
          yield* markDirty()
        }
      }
    })

    const refresh = Effect.fn("FileIndex.refresh")(function* (
      dirPath: string,
      options?: { readonly changedPaths?: readonly string[]; readonly forceMetadata?: boolean },
    ) {
      const changedPaths = options?.changedPaths
        ? new Set(options.changedPaths.map((entryPath) => catalogKey(entryPath)))
        : undefined
      yield* targetedScan(normalizeDirPath(dirPath), {
        changedPaths,
        forceMetadata: options?.forceMetadata,
      })
    })

    const flush = Effect.fn("FileIndex.flush")(function* () {
      yield* Ref.set(dirty, false)
      yield* persist()
    })

    return Service.of({
      list: list as any,
      lookup: (input: string) => byPath.get(catalogKey(input)),
      invalidate,
      applyPatch,
      refresh,
      flush,
    } as any)
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, FileSystem.node, Global.node],
})
