export * as SearchIndex from "./index-service"

import path from "path"
import { Context, Effect, Layer, Option, Queue, Scope } from "effect"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { Watcher } from "../filesystem/watcher"
import { ChunkStore, KIND_DIR, KIND_FILE } from "./chunk-store"
import { compareBytes, frontDecode } from "./front-code"
import type { SymbolEntry } from "./symbols"

export interface PathEntry {
  readonly path: string
  readonly isDir: boolean
  /** Seal-time capture only (Tier-2 metadata); undefined until sealed & stat succeeds. */
  readonly size?: number
  readonly mtime?: number
  readonly lineCount?: number
}

const DEBOUNCE_MS = 150
const CHUNK_SIZE = 8192
const LINE_COUNT_MAX_BYTES = 512 * 1024
const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|mp4|mp3|mov|avi|mkv|wasm|pyc|class|o|so|dll|exe|bin|dat|lock)$/i

const shouldCountLines = (p: string, size: number): boolean => {
  if (!Number.isFinite(size) || size <= 0 || size > LINE_COUNT_MAX_BYTES) return false
  if (BINARY_EXT_RE.test(p)) return false
  return true
}

export interface Interface {
  /** Full snapshot: persisted base + watcher deltas. Strings materialize lazily. */
  readonly loadAll: () => Effect.Effect<{ paths: PathEntry[]; symbols: SymbolEntry[] }, unknown, unknown>
  /** Raw decompressed chunks for byte-oriented matching; no path strings allocated. */
  readonly readRawChunks: (isDir: boolean) => Effect.Effect<readonly ChunkStore.RawChunk[], unknown, unknown>
  /** Lazily materialize one chunk for display/top-K rows. */
  readonly decodeChunk: (seq: number) => Effect.Effect<readonly string[], unknown, unknown>
  readonly subscribe: (listener: (updates: readonly PathEntry[]) => void) => Effect.Effect<() => void, never, never>
  readonly upsert: (entry: PathEntry) => Effect.Effect<void, never, never>
  readonly remove: (entryPath: string) => Effect.Effect<void, never, never>
  readonly seal: () => Effect.Effect<void, unknown, unknown>
  readonly compact: () => Effect.Effect<void, unknown, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Search/Index") {}

// Static composition: the store layer's connection finalizer must attach to
// the CONSUMER's scope. Wrapping this in Layer.unwrap (for path derivation)
// attached it to a transient build scope instead — the DB closed before the
// first post-construction query. Path-dependent wiring composes at the call
// site (search.ts) via layerWith(dbPathFor(...)).
export const layerWith = (dbPath: string) => serviceLayer.pipe(Layer.provideMerge(ChunkStore.layerFromPath(dbPath)))

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const events = yield* EventV2.Service
    const ripgrep = yield* Ripgrep.Service
    const scope = yield* Scope.Scope
    const root = yield* fs.realPath(location.directory).pipe(Effect.orDie)
    const store = yield* ChunkStore.Service

    // Hot-state model: raw chunk bodies are the BASE (bytes-only, ~10ms @185k);
    // `tombstones` removes base rows; `pending` holds unsent watcher ops;
    // `sealed` holds persisted-but-not-yet-rescanned adds. Display strings
    // materialize lazily on first full decode (~70-100ms eager wall at 184k,
    // JSC per-string floor — matcher consumes raw chunks instead).
    let rawFileChunks: ChunkStore.RawChunk[] = []
    let rawDirChunks: ChunkStore.RawChunk[] = []
    const tombstones = new Set<string>()
    const pending = new Map<string, PathEntry | undefined>()
    const sealed = new Map<string, PathEntry>()
    // Tier-2 metadata (size/mtime) captured at seal time, kept as a SEPARATE
    // key-value blob in the meta table (like `tombstones`) rather than inside
    // the front-coded path-byte chunks. Front-coding compresses sorted path
    // bytes only — there is no per-entry slot for auxiliary fields, so this
    // side-map is the safe extension point. Best-effort: a stat failure just
    // omits size/mtime for that path.
    const fileMeta = new Map<string, { size: number; mtime: number; lineCount?: number }>()
    const symbols = new Map<string, SymbolEntry[]>()
    const listeners = new Set<(updates: readonly PathEntry[]) => void>()

    const ancestors = (entryPath: string) => {
      const parts = entryPath.split("/")
      return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
    }
    const record = (entry: PathEntry) => {
      tombstones.delete(entry.path)
      sealed.delete(entry.path)
      pending.set(entry.path, entry)
      if (!entry.isDir) {
        for (const ancestor of ancestors(entry.path)) {
          if (!sealed.has(ancestor) && !pending.has(ancestor)) pending.set(ancestor, { path: ancestor, isDir: true })
        }
      }
    }
    const deleteEntry = (entryPath: string) => {
      pending.delete(entryPath)
      sealed.delete(entryPath)
      tombstones.add(entryPath)
      symbols.delete(entryPath)
      fileMeta.delete(entryPath)
    }

    const loadRaw = Effect.gen(function* () {
      const [fileChunks, dirChunks, storedTombstones, storedFileMeta] = yield* Effect.all([
        store.readRaw(KIND_FILE).pipe(Effect.catch(() => Effect.succeed<ChunkStore.RawChunk[]>([]))),
        store.readRaw(KIND_DIR).pipe(Effect.catch(() => Effect.succeed<ChunkStore.RawChunk[]>([]))),
        store.getMeta("tombstones").pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined))),
        store.getMeta("fileMeta").pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined))),
      ])
      rawFileChunks = fileChunks
      rawDirChunks = dirChunks
      tombstones.clear()
      if (storedTombstones) for (const entryPath of JSON.parse(storedTombstones) as string[]) tombstones.add(entryPath)
      fileMeta.clear()
      if (storedFileMeta) {
        const parsed = JSON.parse(storedFileMeta) as Array<[string, { size: number; mtime: number; lineCount?: number }]>
        for (const [entryPath, meta] of parsed) fileMeta.set(entryPath, meta)
      }
    })
    yield* loadRaw

    // A new cache has no chunks; seed files once with the same bounded rg walk
    // as the legacy search layer. Awaited inline (only on a fresh cache) so the
    // first snapshot is complete; record() materializes every ancestor folder
    // into the directory stream before the first debounced seal.
    if (rawFileChunks.length === 0 && rawDirChunks.length === 0) {
      yield* ripgrep
        .find({
          cwd: location.directory,
          pattern: "*",
          limit: location.vcs ? Number.MAX_SAFE_INTEGER : 100_000,
          onEntry: (entry) => Effect.sync(() => record({ path: String(entry.path), isDir: false })),
        })
        .pipe(Effect.orDie, Effect.asVoid)
    }

    const snapshot = (): PathEntry[] => {
      const out: PathEntry[] = []
      const seen = new Set<string>()
      const push = (entry: PathEntry) => {
        if (seen.has(entry.path) || tombstones.has(entry.path)) return
        seen.add(entry.path)
        const meta = !entry.isDir ? fileMeta.get(entry.path) : undefined
        out.push(
          meta ? { ...entry, size: meta.size, mtime: meta.mtime, lineCount: meta.lineCount } : entry,
        )
      }
      // Base rows with a pending record are stale: deleted or superseded by
      // the overlay copies below.
      for (const chunk of rawFileChunks)
        for (const entryPath of frontDecode(chunk.body, chunk.count))
          if (!pending.has(entryPath)) push({ path: entryPath, isDir: false })
      for (const chunk of rawDirChunks)
        for (const entryPath of frontDecode(chunk.body, chunk.count))
          if (!pending.has(entryPath)) push({ path: entryPath, isDir: true })
      for (const entry of sealed.values()) push(entry)
      for (const entry of pending.values()) if (entry !== undefined) push(entry)
      return out
    }

    const seal = Effect.gen(function* () {
      if (pending.size === 0) return
      const adds: PathEntry[] = []
      for (const entry of pending.values()) if (entry !== undefined) adds.push(entry)
      const grouped = [KIND_FILE, KIND_DIR].flatMap((kind) => {
        const entries = adds
          .filter((entry) => (entry.isDir ? KIND_DIR : KIND_FILE) === kind)
          .map((entry) => new TextEncoder().encode(entry.path))
          .sort(compareBytes)
        return Array.from({ length: Math.ceil(entries.length / CHUNK_SIZE) }, (_, index) => ({
          kind,
          entries: entries.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
        }))
      })
      if (grouped.length > 0) yield* store.append(grouped)
      for (const [entryPath, entry] of [...pending]) {
        pending.delete(entryPath)
        if (entry !== undefined) sealed.set(entryPath, entry)
      }
      yield* store.putMeta("tombstones", JSON.stringify([...tombstones])).pipe(Effect.ignore)
      // Tier-2: best-effort stat capture for newly sealed files, alongside
      // (not inside) the front-coded stream. One extra stat (+ optional line
      // count for text files) per newly sealed file per debounced seal — bounded
      // by watcher churn, not query volume.
      const statTargets = adds.filter((entry) => !entry.isDir)
      if (statTargets.length > 0) {
        yield* Effect.forEach(
          statTargets,
          (entry) =>
            fs.stat(path.join(root, entry.path)).pipe(
              Effect.flatMap((info) => {
                const size = Number(info.size)
                const mtime = info.mtime._tag === "Some" ? info.mtime.value.getTime() : Date.now()
                if (!shouldCountLines(entry.path, size)) {
                  fileMeta.set(entry.path, { size, mtime })
                  return Effect.void
                }
                return fs.readFileStringSafe(path.join(root, entry.path)).pipe(
                  Effect.map((text) => {
                    const lineCount = text === undefined ? undefined : text.split("\n").length
                    fileMeta.set(entry.path, { size, mtime, lineCount })
                  }),
                  Effect.catch(() => {
                    fileMeta.set(entry.path, { size, mtime })
                    return Effect.void
                  }),
                )
              }),
              Effect.catch(() => Effect.void),
            ),
          { concurrency: 8 },
        )
        yield* store.putMeta("fileMeta", JSON.stringify([...fileMeta])).pipe(Effect.ignore)
      }
    })

    // If this was a fresh cache the ripgrep seed above left the full file set in
    // `pending`. Flush it immediately so Tier-2 metadata (size/mtime/lineCount)
    // is persisted without waiting for the next watcher event.
    if (pending.size > 0) {
      yield* seal.pipe(Effect.ignore)
    }

    // Backfill Tier-2 metadata for existing persisted chunks that were created
    // before size/mtime/lineCount capture existed (or before the immediate-seal
    // flush above). Runs in the background so startup stays fast.
    yield* Effect.forkIn(
      Effect.gen(function* () {
        const missing = snapshot().filter((p) => !p.isDir && !fileMeta.has(p.path))
        if (missing.length === 0) return
        // Cap background work on enormous repos; prioritize visible files later
        // via query-time enrichment if needed.
        const batchSize = 1000
        for (let i = 0; i < missing.length; i += batchSize) {
          const batch = missing.slice(i, i + batchSize)
          yield* Effect.forEach(
            batch,
            (entry) =>
              fs.stat(path.join(root, entry.path)).pipe(
                Effect.flatMap((info) => {
                  const size = Number(info.size)
                  const mtime = info.mtime._tag === "Some" ? info.mtime.value.getTime() : Date.now()
                  if (!shouldCountLines(entry.path, size)) {
                    fileMeta.set(entry.path, { size, mtime })
                    return Effect.void
                  }
                  return fs.readFileStringSafe(path.join(root, entry.path)).pipe(
                    Effect.map((text) => {
                      const lineCount = text === undefined ? undefined : text.split("\n").length
                      fileMeta.set(entry.path, { size, mtime, lineCount })
                    }),
                    Effect.catch(() => {
                      fileMeta.set(entry.path, { size, mtime })
                      return Effect.void
                    }),
                  )
                }),
                Effect.catch(() => Effect.void),
              ),
            { concurrency: 8 },
          )
          yield* store.putMeta("fileMeta", JSON.stringify([...fileMeta])).pipe(Effect.ignore)
        }
      }),
      scope,
    )

    const queue = yield* Queue.dropping<void>(256)
    yield* events.listen((event) =>
      Effect.gen(function* () {
        if (event.type !== Watcher.Event.Updated.type) return
        const data = event.data as { file: string; event: "add" | "change" | "unlink" }
        if (event.location && event.location.directory !== location.directory) return
        const relative = path.relative(location.directory, data.file).replaceAll("\\", "/")
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return
        if (data.event === "unlink") deleteEntry(relative)
        else record({ path: relative, isDir: yield* fs.isDir(data.file) })
        yield* Queue.offer(queue, undefined).pipe(Effect.ignore)
      }),
    )
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          yield* Queue.take(queue)
          yield* Effect.sleep(DEBOUNCE_MS)
          while (true) {
            const next = yield* Queue.poll(queue)
            if (Option.isNone(next)) break
          }
          const updates = [...sealed.values()].filter((entry) => !tombstones.has(entry.path))
          for (const listener of listeners) listener(updates)
          yield* seal.pipe(Effect.ignore)
        }
      }),
      scope,
    )

    return Service.of({
      loadAll: () =>
        Effect.succeed({
          paths: snapshot(),
          symbols: [...symbols.values()].flat(),
        }),
      readRawChunks: (isDir) => store.readRaw(isDir ? KIND_DIR : KIND_FILE),
      decodeChunk: (seq) => store.decodeChunk(seq),
      subscribe: (listener) =>
        Effect.sync(() => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }),
      upsert: (entry) =>
        Effect.sync(() => {
          record(entry)
        }),
      remove: (entryPath) =>
        Effect.sync(() => {
          deleteEntry(entryPath)
        }),
      seal: () => seal,
      compact: () =>
        Effect.gen(function* () {
          const paths = snapshot()
          const files: Uint8Array[] = []
          const dirs: Uint8Array[] = []
          for (const entry of paths) (entry.isDir ? dirs : files).push(new TextEncoder().encode(entry.path))
          files.sort(compareBytes)
          dirs.sort(compareBytes)
          yield* store.clear()
          tombstones.clear()
          yield* store.putMeta("tombstones", "[]").pipe(Effect.ignore)
          // fileMeta entries survive compaction (paths unchanged); re-persist as-is.
          yield* store.putMeta("fileMeta", JSON.stringify([...fileMeta])).pipe(Effect.ignore)
          const chunks: ChunkStore.ChunkInput[] = []
          for (const [kind, entries] of [
            [KIND_FILE, files],
            [KIND_DIR, dirs],
          ] as const)
            for (let i = 0; i < entries.length; i += CHUNK_SIZE)
              chunks.push({ kind, entries: entries.slice(i, i + CHUNK_SIZE) })
          if (chunks.length > 0) yield* store.append(chunks)
          sealed.clear()
          yield* loadRaw
        }),
    })
  }),
)

