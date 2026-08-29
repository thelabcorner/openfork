export * as FileIndex from "./index"

import path from "path"
import { Context, Effect, Layer, Option, Queue, Ref, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { IndexSerialization } from "./index-serialization"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { RelativePath } from "../schema"
import { Hash } from "../util/hash"
import { ChunkStore, KIND_DIR, KIND_FILE } from "../search/chunk-store"
import { frontDecode } from "../search/front-code"

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
  /** Re-scan a single directory and patch the index. */
  readonly refresh: (dirPath: string) => Effect.Effect<void>
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
    let builtAt = 0
    let rootStat: RootStat | undefined
    let loaded = false
    let persistRevision = 0

    const setSubtree = (dir: string, entries: FileSystem.Entry[], at = Date.now()) => {
      const prev = subtrees.get(dir)
      if (prev) {
        for (const e of prev.entries) byPath.delete(catalogKey(String(e.path)))
      }
      subtrees.set(dir, { at, entries })
      for (const e of entries) byPath.set(catalogKey(String(e.path)), e)
    }

    const dropSubtree = (dir: string) => {
      const prev = subtrees.get(dir)
      if (!prev) return false
      for (const e of prev.entries) byPath.delete(catalogKey(String(e.path)))
      return subtrees.delete(dir)
    }

    const STAT_CONCURRENCY = 24
    const attachMeta = (entries: readonly FileSystem.Entry[]): Effect.Effect<FileSystem.Entry[]> =>
      Effect.forEach(
        entries,
        (entry) => {
          if (entry.type !== "file") return Effect.succeed(entry)
          const abs = path.join(root, catalogKey(String(entry.path)))
          return fs.stat(abs).pipe(
            Effect.map((info) => {
              const size = Number(info.size)
              const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
              return {
                ...entry,
                size: Number.isFinite(size) ? size : undefined,
                mtime: mtime > 0 ? mtime : undefined,
              }
            }),
            Effect.catch(() => Effect.succeed(entry)),
          )
        },
        { concurrency: STAT_CONCURRENCY },
      )

    const subtreeBytes = (dir: string, memo: Map<string, number | undefined>): number | undefined => {
      if (memo.has(dir)) return memo.get(dir)
      const sub = subtrees.get(dir)
      if (!sub) {
        memo.set(dir, undefined)
        return undefined
      }
      let total = 0
      let any = false
      for (const e of sub.entries) {
        if (e.type === "file") {
          if (typeof e.size === "number") {
            total += e.size
            any = true
          }
          continue
        }
        const nested = subtreeBytes(catalogKey(String(e.path)), memo)
        if (nested !== undefined) {
          total += nested
          any = true
        }
      }
      const result = any ? total : undefined
      memo.set(dir, result)
      return result
    }

    const subtreeMtime = (dir: string, memo: Map<string, number | undefined>): number | undefined => {
      if (memo.has(dir)) return memo.get(dir)
      const sub = subtrees.get(dir)
      if (!sub) {
        memo.set(dir, undefined)
        return undefined
      }
      let max: number | undefined
      for (const e of sub.entries) {
        if (e.type === "file") {
          if (typeof e.mtime === "number" && e.mtime > 0) {
            if (max === undefined || e.mtime > max) max = e.mtime
          }
          continue
        }
        const nested = subtreeMtime(catalogKey(String(e.path)), memo)
        if (nested !== undefined && (max === undefined || nested > max)) max = nested
      }
      memo.set(dir, max)
      return max
    }

    const withDirMeta = (entries: readonly FileSystem.Entry[]): FileSystem.Entry[] => {
      if (entries.length === 0) return [...entries]
      const sizeMemo = new Map<string, number | undefined>()
      const mtimeMemo = new Map<string, number | undefined>()
      return entries.map((e) => {
        if (e.type !== "directory") return e
        const bytes = subtreeBytes(catalogKey(String(e.path)), sizeMemo)
        const max = subtreeMtime(catalogKey(String(e.path)), mtimeMemo)
        if (bytes === undefined && max === undefined) return e
        return {
          ...e,
          ...(bytes !== undefined ? { size: bytes } : {}),
          ...(max !== undefined ? { mtime: max } : {}),
        }
      })
    }
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
        for (const [dir, sub] of subtrees) snapshotSubtrees[dir] = { at: sub.at, entries: sub.entries.slice() }
        const snapshotRootStat = rootStat ?? (yield* currentRootStat())
        const state: IndexState = {
          schemaVersion: SCHEMA_VERSION,
          builtAt,
          root,
          rootStat: snapshotRootStat,
          subtrees: snapshotSubtrees,
        }
        const bytes = IndexSerialization.encode(state)
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
        }
        return true
      }).pipe(Effect.catch(() => Effect.succeed(false)))

    const tryLoadFromSearchDB = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const exists = yield* fs.stat(dbPath).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        )
        if (!exists) return false
        const ok = yield* Effect.gen(function* () {
          const store = yield* ChunkStore.Service
          const [fileChunks, dirChunks, storedFileMeta, storedTombstones] = yield* Effect.all([
            store.readRaw(KIND_FILE).pipe(Effect.catch(() => Effect.succeed([] as ChunkStore.RawChunk[]))),
            store.readRaw(KIND_DIR).pipe(Effect.catch(() => Effect.succeed([] as ChunkStore.RawChunk[]))),
            store.getMeta("fileMeta").pipe(Effect.catch(() => Effect.succeed(undefined as string | undefined))),
            store.getMeta("tombstones").pipe(Effect.catch(() => Effect.succeed(undefined as string | undefined))),
          ])
          if (fileChunks.length === 0 && dirChunks.length === 0) return false
          const fileMeta = new Map<string, { size: number; mtime: number; lineCount?: number }>()
          if (storedFileMeta) {
            try {
              const parsed = JSON.parse(storedFileMeta) as Array<[string, { size: number; mtime: number; lineCount?: number }]>
              for (const [p, m] of parsed) fileMeta.set(p, m)
            } catch {}
          }
          const tombstones = new Set<string>()
          if (storedTombstones) {
            try {
              for (const p of JSON.parse(storedTombstones) as string[]) tombstones.add(p)
            } catch {}
          }
          const groups = new Map<string, FileSystem.Entry[]>()
          const ensureGroup = (dir: string) => {
            if (!groups.has(dir)) groups.set(dir, [])
            return groups.get(dir)!
          }
          ensureGroup("")
          const pushPath = (p: string, isDir: boolean) => {
            if (tombstones.has(p)) return
            if (isOpencodePath(p)) return
            const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""
            if (isOpencodePath(dir)) return
            const meta = !isDir ? fileMeta.get(p) : undefined
            const entry: FileSystem.Entry = {
              path: RelativePath.make(p + (isDir ? "/" : "")),
              type: isDir ? "directory" : "file",
              ...(meta?.size !== undefined ? { size: meta.size } : {}),
              ...(meta?.mtime !== undefined ? { mtime: meta.mtime } : {}),
            }
            ensureGroup(dir).push(entry)
            if (isDir) ensureGroup(p)
          }
          for (const chunk of fileChunks) for (const pp of frontDecode(chunk.body, chunk.count)) pushPath(pp, false)
          for (const chunk of dirChunks) for (const pp of frontDecode(chunk.body, chunk.count)) pushPath(pp, true)
          const now = Date.now()
          let any = false
          for (const [dir, entries] of groups) {
            if (entries.length === 0 && dir !== "") continue
            entries.sort(compareEntries)
            setSubtree(dir, entries, now)
            any = true
          }
          if (!any) return false
          builtAt = now
          rootStat = yield* currentRootStat()
          return true
        }).pipe(Effect.provide(ChunkStore.layerFromPath(dbPath)), Effect.scoped)
        return ok
      }).pipe(Effect.catch(() => Effect.succeed(false)))

    const ensureLoaded = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (loaded) return
        loaded = true
        // Best-effort delete of the repo-local Brotli copy on first load —
        // it is no longer written, but old clones may still have it.
        yield* fs.remove(path.join(root, ".opencode", "file-index.json.br"), { force: true }).pipe(Effect.ignore)
        // Unified SQLite cold start: `file-index/<hash>.db` is the single
        // durable copy. Try the explorer's own `fileIndex` meta first
        // (written via `persist()`), then the search chunks grouping
        // (for upgrades where only the search DB exists), then the legacy
        // global JSON blob.
        const fromFileIndex = yield* tryLoadFileIndexMeta()
        if (fromFileIndex) return
        const fromSearch = yield* tryLoadFromSearchDB()
        if (fromSearch) return
        const bytes = yield* fs.readFile(cachePath).pipe(Effect.catch(() => Effect.succeed(undefined as Uint8Array | undefined)))
        if (bytes === undefined) return
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
        }
      })

    const checkFreshness = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* currentRootStat()
        if (
          rootStat &&
          (current.mtimeMs !== Math.floor(rootStat.mtimeMs) ||
            current.size !== rootStat.size ||
            current.ino !== rootStat.ino)
        ) {
          rootStat = current
        }
      })

    const buildDir = (dirPath: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (isOpencodePath(dirPath)) return
        const listed = yield* filesystem.list({ path: RelativePath.make(dirPath) }).pipe(Effect.option)
        if (Option.isNone(listed)) return
        const raw = normalizeEntries(listed.value).filter((e) => !isOpencodePath(String(e.path)))
        const withMeta = yield* attachMeta(raw)
        setSubtree(dirPath, withMeta)
        for (const entry of withMeta) {
          if (entry.type === "directory") yield* buildDir(normalizeDirPath(entry.path))
        }
      })

    const fullBuild = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        byPath.clear()
        subtrees.clear()
        yield* buildDir("")
        builtAt = Date.now()
        rootStat = yield* currentRootStat()
        yield* markDirty()
      })

    const targetedScan = (dirPath: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (isOpencodePath(dirPath)) return
        const entries = normalizeEntries(yield* filesystem.list({ path: RelativePath.make(dirPath) }).pipe(Effect.orDie)).filter(
          (e) => !isOpencodePath(String(e.path)),
        )
        const withMeta = yield* attachMeta(entries)
        setSubtree(dirPath, withMeta)
        yield* markDirty()
      })

    const scope = yield* Scope.Scope
    const isDirStale = (dirPath: string, at: number) =>
      Effect.gen(function* () {
        const abs = path.join(root, dirPath)
        const info: any = yield* (fs.stat(abs) as any).pipe(Effect.catch(() => Effect.succeed(undefined as any)) as any)
        if (!info) return true
        const mtimeOpt = (info as { mtime?: Option.Option<Date> }).mtime as Option.Option<Date> | undefined
        const mtime = mtimeOpt ? Option.getOrElse(mtimeOpt, () => new Date(0)).getTime() : 0
        // Unified staleness: any mtime newer than or equal to the cached
        // `at` triggers a targeted rescan. The previous `+1000` ms guard hid
        // newly added files created within the same second as the cached `at`
        // (flaky on fast test tmpdirs and on Windows where dir mtime
        // granularity is coarse). Coarse FS is handled by the fallback
        // `checkFreshness` rootStat path and by the watcher; a false-positive
        // rescan is cheap compared to permanently hiding a new file.
        return mtime >= at
      }).pipe(Effect.catch(() => Effect.succeed(true)) as any) as Effect.Effect<boolean>

    const list = Effect.fn("FileIndex.list")(function* (input: RelativePath) {
      yield* ensureLoaded()
      yield* checkFreshness()
      const dirPath = normalizeDirPath(input)
      const cached = subtrees.get(dirPath)
      if (cached) {
        if (yield* isDirStale(dirPath, cached.at)) {
          yield* targetedScan(dirPath)
          return withDirMeta(subtrees.get(dirPath)!.entries)
        }
        if (cached.entries.some((e) => e.type === "file" && e.size === undefined)) {
          const withMeta = yield* attachMeta(cached.entries)
          setSubtree(dirPath, withMeta, cached.at)
          yield* markDirty()
          return withDirMeta(withMeta)
        }
        return withDirMeta(cached.entries)
      }
      if (subtrees.size === 0) {
        yield* targetedScan(dirPath)
        yield* (fullBuild().pipe(
          Effect.catch(() => Effect.void),
          Effect.forkIn(scope),
          Effect.ignore as any,
        ) as any)
        return withDirMeta(subtrees.get(dirPath)!.entries)
      }
      yield* targetedScan(dirPath)
      return withDirMeta(subtrees.get(dirPath)!.entries)
    })

    const invalidate = Effect.fn("FileIndex.invalidate")(function* (dirPath: string) {
      if (dropSubtree(normalizeDirPath(dirPath))) yield* markDirty()
    })

    const applyPatch = Effect.fn("FileIndex.applyPatch")(function* (patch: Patch) {
      const key = normalizeDirPath(patch.dir)
      const sub = subtrees.get(key)
      if (!sub) return
      if (patch.op === "put" && patch.entry) {
        const entry = { ...patch.entry, path: RelativePath.make(normalizeEntryPath(String(patch.entry.path))) }
        const stated = entry.type === "file" ? (yield* attachMeta([entry]))[0]! : entry
        const next = sub.entries.filter((item) => item.path !== stated.path)
        next.push(stated)
        next.sort(compareEntries)
        setSubtree(key, next)
        yield* markDirty()
      } else if (patch.op === "delete" && patch.entryPath) {
        const entryPath = normalizeEntryPath(patch.entryPath)
        const next = sub.entries.filter((item) => item.path !== entryPath)
        if (next.length !== sub.entries.length) {
          setSubtree(key, next)
          yield* markDirty()
        }
      }
    })

    const refresh = Effect.fn("FileIndex.refresh")(function* (dirPath: string) {
      yield* targetedScan(normalizeDirPath(dirPath))
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
