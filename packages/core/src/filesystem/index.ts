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
import { IndexFrontcode } from "./index-frontcode"

/**
 * Server-side persisted, incrementally-invalidated project file index.
 *
 * The index is a pure directory-enumeration cache: it stores, per directory
 * (relative to the project root), the exact `FileSystem.list` output for that
 * directory. The V1 `file.list` handler derives `name`/`absolute`/`ignored` at
 * serve time (gitignore can change independently), so the index only caches the
 * expensive part — walking and stat'ing directory entries.
 *
 * Persistence follows `contract/index-format` (schemaVersion 1): a JSON blob at
 * `{Global.Path.data}/file-index/<sha256(realpath(root))>.json`, written
 * atomically via temp+rename, with an embedded sha256 digest over the canonical
 * JSON. Freshness is gated on the root directory's stat signature; per-subtree
 * staleness is handled by `invalidate`/`applyPatch`/`refresh` (fed by the
 * watcher).
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
    const frontManifestPath = `${cachePath}.front.manifest`

    const subtrees = new Map<string, Subtree>()
    let builtAt = 0
    let rootStat: RootStat | undefined
    let loaded = false
    let persistRevision = 0
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

    const persist = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const revision = persistRevision
        const snapshotSubtrees = Object.fromEntries(Array.from(subtrees.entries(), ([dir, sub]) => [dir, { at: sub.at, entries: [...sub.entries] }]))
        const snapshotRootStat = rootStat ?? (yield* currentRootStat())
        const state: IndexState = {
          schemaVersion: SCHEMA_VERSION,
          builtAt,
          root,
          rootStat: snapshotRootStat,
          subtrees: snapshotSubtrees,
        }
        const bytes = IndexSerialization.encode(state)
        yield* fs.ensureDir(path.dirname(cachePath))
        const tmp = `${cachePath}.${Math.random().toString(36).slice(2)}.tmp`
        yield* fs.writeFile(tmp, bytes)
        yield* fs.rename(tmp, cachePath)

        // Cold snapshots are immutable generations. Chunks are published first;
        // the manifest rename is the commit point, so an interrupted write keeps
        // the previous generation readable. Mutable watcher updates remain in the
        // in-memory map and are coalesced by the existing debounce queue.
        const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        const entries = Object.entries(snapshotSubtrees).flatMap(([dir, sub]) =>
          sub.entries.map((entry) => ({ dir, path: String(entry.path), type: entry.type } as IndexFrontcode.FrontEntry)),
        ).toSorted((a, b) => a.dir.localeCompare(b.dir) || a.path.localeCompare(b.path) || a.type.localeCompare(b.type))
        const chunks: IndexFrontcode.FrontChunk[] = []
        for (let first = 0; first < entries.length; first += 128) {
          const frame = IndexFrontcode.encodeChunk(entries.slice(first, first + 128))
          const name = `${path.basename(cachePath)}.${generation}.${chunks.length}.chunk`
          yield* fs.writeFile(path.join(path.dirname(cachePath), name), frame)
          chunks.push({ name, first, count: Math.min(128, entries.length - first), rawBytes: IndexFrontcode.chunkRawBytes(frame), storedBytes: frame.byteLength, sha256: IndexFrontcode.chunkDigest(frame) })
        }
        const manifest: IndexFrontcode.FrontManifest = {
          format: "file-index-frontcode",
          version: 1,
          generation,
          builtAt,
          root,
          rootStat: snapshotRootStat,
          chunks,
        }
        const frontTmp = `${frontManifestPath}.${generation}.tmp`
        yield* fs.writeFile(frontTmp, new TextEncoder().encode(JSON.stringify(manifest)))
        if (revision !== persistRevision) return
        yield* fs.rename(frontTmp, frontManifestPath)
        // Best-effort reachability GC: only generation chunk files for this
        // index are considered, and the just-published manifest's names are
        // retained. Orphans from interrupted publication cannot affect loads.
        yield* Effect.gen(function* () {
          const names = new Set(manifest.chunks.map((chunk) => chunk.name))
          for (const entry of yield* fs.readDirectoryEntries(path.dirname(cachePath))) {
            if (entry.name.startsWith(`${path.basename(cachePath)}.`) && entry.name.endsWith(".chunk") && !names.has(entry.name)) {
              yield* fs.remove(path.join(path.dirname(cachePath), entry.name), { force: true }).pipe(Effect.ignore)
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
    // into one atomic write. Mirrors search.ts's Queue.dropping + debounce.
    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(flushQueue)
        yield* Effect.sleep(DEBOUNCE_MS)
        if (!(yield* Ref.get(dirty))) continue
        yield* Ref.set(dirty, false)
        yield* persist()
      }
    }).pipe(Effect.forkScoped)

    const ensureLoaded = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (loaded) return
        loaded = true
        const frontLoaded = yield* Effect.gen(function* () {
          const manifestBytes = yield* fs.readFile(frontManifestPath)
          const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as IndexFrontcode.FrontManifest
          if (
            manifest.format !== "file-index-frontcode" ||
            manifest.version !== 1 ||
            manifest.root !== root ||
            !Number.isFinite(manifest.builtAt) ||
            !manifest.rootStat ||
            !Number.isFinite(manifest.rootStat.mtimeMs) ||
            !Number.isFinite(manifest.rootStat.size) ||
            !Number.isFinite(manifest.rootStat.ino) ||
            !Array.isArray(manifest.chunks) ||
            manifest.chunks.length > 100_000
          ) return false
          const decoded = new Map<string, Subtree>()
          let expectedFirst = 0
          let previousKey = ""
          for (const chunk of manifest.chunks) {
            if (chunk.first !== expectedFirst || chunk.count < 1 || chunk.count > 128 || chunk.rawBytes < 0 || path.basename(chunk.name) !== chunk.name || chunk.storedBytes < 13 || chunk.storedBytes > 32 * 1024 * 1024) return false
            const frame = yield* fs.readFile(path.join(path.dirname(frontManifestPath), chunk.name))
            if (frame.byteLength !== chunk.storedBytes || IndexFrontcode.chunkDigest(frame) !== chunk.sha256) return false
            if (IndexFrontcode.chunkRawBytes(frame) !== chunk.rawBytes) return false
            for (const entry of IndexFrontcode.decodeChunk(frame)) {
              const key = `${entry.dir}\u0000${entry.path}\u0000${entry.type}`
              if (key <= previousKey || entry.path.includes("\\") || entry.path === "" || entry.path.split("/").includes("..")) return false
              previousKey = key
              const current = decoded.get(entry.dir)
              const entries = [...(current?.entries ?? []), { path: RelativePath.make(entry.path), type: entry.type }]
              decoded.set(entry.dir, { at: current?.at ?? manifest.builtAt, entries })
            }
            expectedFirst += chunk.count
          }
          builtAt = manifest.builtAt
          rootStat = manifest.rootStat
          for (const [dir, sub] of decoded) subtrees.set(dir, { at: sub.at, entries: [...sub.entries].sort(compareEntries) })
          return true
        }).pipe(Effect.catch(() => Effect.succeed(false)))
        if (frontLoaded) return
        const bytes = yield* fs.readFile(cachePath).pipe(Effect.catch(() => Effect.succeed(undefined as Uint8Array | undefined)))
        if (bytes === undefined) return
        const blob = yield* IndexSerialization.decode(bytes).pipe(
          Effect.catch(() => Effect.succeed(undefined as IndexSerialization.IndexBlob | undefined)),
        )
        if (!blob) return
        builtAt = blob.builtAt
        rootStat = blob.rootStat
        for (const [dir, sub] of Object.entries(blob.subtrees)) {
          subtrees.set(dir, { at: sub.at, entries: normalizeEntries(sub.entries) })
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
          subtrees.clear()
          rootStat = undefined
          builtAt = 0
        }
      })

    const buildDir = (dirPath: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const listed = yield* filesystem.list({ path: RelativePath.make(dirPath) }).pipe(Effect.option)
        if (Option.isNone(listed)) return // unreadable dir: skip, don't cache
        const entries = normalizeEntries(listed.value)
        subtrees.set(dirPath, { at: Date.now(), entries })
        for (const entry of entries) {
          if (entry.type === "directory") yield* buildDir(normalizeDirPath(entry.path))
        }
      })

    const fullBuild = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        subtrees.clear()
        yield* buildDir("")
        builtAt = Date.now()
        rootStat = yield* currentRootStat()
        yield* markDirty()
      })

    const targetedScan = (dirPath: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entries = normalizeEntries(yield* filesystem.list({ path: RelativePath.make(dirPath) }).pipe(Effect.orDie))
        subtrees.set(dirPath, { at: Date.now(), entries })
        yield* markDirty()
      })

    const list = Effect.fn("FileIndex.list")(function* (input: RelativePath) {
      yield* ensureLoaded()
      yield* checkFreshness()
      if (subtrees.size === 0) yield* fullBuild()
      const dirPath = normalizeDirPath(input)
      const cached = subtrees.get(dirPath)
      if (cached) return cached.entries
      yield* targetedScan(dirPath)
      return subtrees.get(dirPath)!.entries
    })

    const invalidate = Effect.fn("FileIndex.invalidate")(function* (dirPath: string) {
      if (subtrees.delete(normalizeDirPath(dirPath))) yield* markDirty()
    })

    const applyPatch = Effect.fn("FileIndex.applyPatch")(function* (patch: Patch) {
      const key = normalizeDirPath(patch.dir)
      const sub = subtrees.get(key)
      if (!sub) return
      if (patch.op === "put" && patch.entry) {
        const entry = { ...patch.entry, path: RelativePath.make(normalizeEntryPath(String(patch.entry.path))) }
        const next = sub.entries.filter((item) => item.path !== entry.path)
        next.push(entry)
        next.sort(compareEntries)
        subtrees.set(key, { at: Date.now(), entries: next })
        yield* markDirty()
      } else if (patch.op === "delete" && patch.entryPath) {
        const entryPath = normalizeEntryPath(patch.entryPath)
        const next = sub.entries.filter((item) => item.path !== entryPath)
        if (next.length !== sub.entries.length) {
          subtrees.set(key, { at: Date.now(), entries: next })
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

    return Service.of({ list, invalidate, applyPatch, refresh, flush })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, FileSystem.node, Global.node],
})
