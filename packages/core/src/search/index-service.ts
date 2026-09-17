export * as SearchIndex from "./index-service"

import path from "path"
import { Context, Effect, Layer, Option, Queue, Scope } from "effect"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { Flock } from "../util/flock"
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
const BULK_METADATA_GRACE_MS = 200
const METADATA_CHUNK_SIZE = 256
const LINE_COUNT_MAX_BYTES = 512 * 1024
const COLD_SEED_LOCK_STALE_MS = 60_000
const COLD_SEED_LOCK_TIMEOUT_MS = 10 * 60 * 1000
// A persisted index younger than this is trusted without a fresh authoritative
// walk. The value only coalesces near-simultaneous hosts building the same
// location service; a genuine process restart (branch switch, external move
// while closed) is older than the grace and reconciles.
export const RECONCILE_TTL_MS = 30_000
const INDEXED_AT_KEY = "indexedAt"
// Reconcile rewrites the base when watcher deltas have fragmented the store or
// when removals have accumulated a tombstone blob large enough that every later
// seal would re-serialize it. Both keep loadRaw() proportional to the live set
// on subsequent opens instead of to history.
const COMPACT_CHUNK_THRESHOLD = 64
const COMPACT_TOMBSTONE_THRESHOLD = 1024
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
  /** O(1) live metadata lookup, hydrated asynchronously after structural seals. */
  readonly fileMetadata: (entryPath: string) => { size: number; mtime: number; lineCount?: number } | undefined
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
    // Tier-2 metadata (size/mtime) queued by seals and hydrated asynchronously,
    // kept as a SEPARATE
    // key-value blob in the meta table (like `tombstones`) rather than inside
    // the front-coded path-byte chunks. Front-coding compresses sorted path
    // bytes only — there is no per-entry slot for auxiliary fields, so this
    // side-map is the safe extension point. Best-effort: a stat failure just
    // omits size/mtime for that path.
    const fileMeta = new Map<string, { size: number; mtime: number; lineCount?: number }>()
    const symbols = new Map<string, SymbolEntry[]>()
    const listeners = new Set<(updates: readonly PathEntry[]) => void>()
    let snapshotCache: PathEntry[] | undefined
    let snapshotLookup: Map<string, number> | undefined
    const metadataPending = new Map<string, { entry: PathEntry; countLines: boolean }>()
    const metadataWake = yield* Queue.dropping<void>(1)

    const setFileMeta = (entryPath: string, meta: { size: number; mtime: number; lineCount?: number }) => {
      // A bulk stat/read can race an unlink that arrived while the I/O was in
      // flight. Never resurrect metadata for a path already tombstoned by the
      // watcher.
      if (tombstones.has(entryPath)) return
      fileMeta.set(entryPath, meta)
      const index = snapshotLookup?.get(entryPath)
      if (index === undefined || !snapshotCache) return
      const row = snapshotCache[index]
      if (!row) return
      // Keep the snapshot ARRAY identity stable so the file-only fast matcher
      // can reuse its prepared masks/base offsets while metadata hydrates in the
      // background. Only the row object changes; its path/isDir are immutable.
      snapshotCache[index] = { ...row, ...meta }
    }

    const setStatOnlyMeta = (entryPath: string, size: number, mtime: number) => {
      const previous = fileMeta.get(entryPath)
      // Preserve a line count only when it was measured for the exact same file
      // version. If mtime changed, carrying the old count forward would be stale.
      setFileMeta(
        entryPath,
        previous?.mtime === mtime && previous.lineCount !== undefined
          ? { size, mtime, lineCount: previous.lineCount }
          : { size, mtime },
      )
    }

    const invalidateSnapshot = () => {
      snapshotCache = undefined
      snapshotLookup = undefined
    }

    const ancestors = (entryPath: string) => {
      const parts = entryPath.split("/")
      return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
    }
    const record = (entry: PathEntry) => {
      invalidateSnapshot()
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
      invalidateSnapshot()
      pending.delete(entryPath)
      sealed.delete(entryPath)
      tombstones.add(entryPath)
      symbols.delete(entryPath)
      fileMeta.delete(entryPath)
      metadataPending.delete(entryPath)
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
      invalidateSnapshot()
      tombstones.clear()
      if (storedTombstones) for (const entryPath of JSON.parse(storedTombstones) as string[]) tombstones.add(entryPath)
      fileMeta.clear()
      if (storedFileMeta) {
        const parsed = JSON.parse(storedFileMeta) as Array<
          [string, { size: number; mtime: number; lineCount?: number }]
        >
        for (const [entryPath, meta] of parsed) fileMeta.set(entryPath, meta)
      }
    })
    yield* loadRaw

    const snapshot = (): PathEntry[] => {
      if (snapshotCache) return snapshotCache
      const out: PathEntry[] = []
      const seen = new Set<string>()
      const push = (entry: PathEntry) => {
        if (seen.has(entry.path) || tombstones.has(entry.path)) return
        seen.add(entry.path)
        const meta = !entry.isDir ? fileMeta.get(entry.path) : undefined
        out.push(meta ? { ...entry, size: meta.size, mtime: meta.mtime, lineCount: meta.lineCount } : entry)
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
      snapshotCache = out
      snapshotLookup = new Map(out.map((entry, index) => [entry.path, index]))
      return out
    }

    const queueMetadata = (entries: readonly PathEntry[], countLines: boolean) =>
      Effect.gen(function* () {
        for (const entry of entries) {
          if (entry.isDir) continue
          const previous = metadataPending.get(entry.path)
          metadataPending.set(entry.path, {
            entry,
            countLines: countLines || previous?.countLines === true,
          })
        }
        if (metadataPending.size > 0) yield* Queue.offer(metadataWake, undefined).pipe(Effect.ignore)
      })

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
      // Metadata is deliberately NOT collected inline. A fresh index can contain
      // 100k+ files; stat'ing and reading every text file here used to block the
      // first @-mention request behind seconds/minutes of unrelated I/O. Queue
      // metadata after the structural seal and let the low-priority worker below
      // hydrate it without holding up search readiness.
      const statTargets = adds.filter((entry) => !entry.isDir)
      if (statTargets.length > 0) yield* queueMetadata(statTargets, statTargets.length <= 64)
    })

    // Authoritative tree enumeration shared by cold seeding and reopen
    // reconciliation. `seed` records every enumerated file; `reconcile` diffs
    // the live tree against the persisted base so moves/deletes that happened
    // while no watcher was running (process down, branch switch, network mount)
    // cannot keep serving paths that no longer exist. Only net-new files are
    // recorded, so unchanged rows keep their persisted Tier-2 metadata instead
    // of being re-stat'd on every open.
    const walkAndApply = (mode: "seed" | "reconcile") =>
      Effect.gen(function* () {
        const walkLimit = location.vcs ? Number.MAX_SAFE_INTEGER : 100_000
        const found = new Set<string>()
        yield* ripgrep
          .find({
            cwd: location.directory,
            pattern: "*",
            limit: walkLimit,
            onEntry: (entry) => Effect.sync(() => found.add(String(entry.path))),
          })
          .pipe(Effect.orDie, Effect.asVoid)
        if (mode === "seed") {
          for (const file of found) record({ path: file, isDir: false })
        } else {
          // `ripgrep.find` stops feeding onEntry at `limit`; a result that
          // reaches the cap is not proof the rest of the tree is gone. Only a
          // complete walk may delete, otherwise a huge repo would have its
          // truncated tail tombstoned. Additions are always safe.
          const complete = found.size < walkLimit
          const dirs = new Set<string>()
          for (const file of found) for (const ancestor of ancestors(file)) dirs.add(ancestor)
          const current = snapshot()
          const present = new Set(current.map((entry) => entry.path))
          if (complete) {
            for (const entry of current) {
              if (entry.isDir ? dirs.has(entry.path) : found.has(entry.path)) continue
              deleteEntry(entry.path)
            }
          }
          for (const file of found) if (!present.has(file)) record({ path: file, isDir: false })
        }
        if (pending.size > 0) yield* seal.pipe(Effect.ignore)
      })

    // Rewrites the persisted base from the live snapshot: one chunk per CHUNK_SIZE
    // entries per kind instead of the accumulated delta chunks, and tombstones
    // are cleared. Called only while holding the reconcile lease so a concurrent
    // host never observes a half-cleared store (the freshness marker is published
    // only after this completes).
    const compact = Effect.gen(function* () {
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
    })

    // Cold seeding is a MACHINE-WIDE operation for this physical index DB. ACP,
    // Desktop, and other hosts can construct the same project service at nearly
    // the same time. Without election they all see an empty DB and independently
    // launch a whole-repository rg walk before the first writer seals chunks.
    //
    // The elected owner walks + seals while holding a DB-local crash-recovering
    // lease. Contenders wait cheaply, then re-read the chunks written by the
    // winner and skip discovery. This prevents N-host cold-start CPU and duplicate
    // chunk amplification without introducing a process-specific XDG namespace.
    //
    // The same lease serializes reopen reconciliation: a persisted index written
    // while no watcher was running cannot be trusted, so when the freshness
    // marker is missing or older than RECONCILE_TTL_MS the elected owner
    // re-enumerates the tree and applies the diff. Near-simultaneous hosts share
    // the winner's result instead of each running their own walk.
    const dbPath = ChunkStore.dbPathFor(root, global.data)
    const lockDir = path.join(path.dirname(dbPath), ".opencode-runtime-locks")
    const readIndexedAt = store.getMeta(INDEXED_AT_KEY).pipe(
      Effect.catch(() => Effect.succeed(undefined as string | undefined)),
      Effect.map((raw) => {
        const value = raw === undefined ? Number.NaN : Number(raw)
        return Number.isFinite(value) ? value : undefined
      }),
    )
    const freshEnough = (hasChunks: boolean, at: number | undefined) =>
      hasChunks && at !== undefined && Date.now() - at < RECONCILE_TTL_MS
    const persistedChunks = rawFileChunks.length > 0 || rawDirChunks.length > 0
    if (!freshEnough(persistedChunks, yield* readIndexedAt)) {
      yield* Effect.scoped(
        Flock.effect(`search-index-cold-seed:${dbPath}`, {
          dir: lockDir,
          staleMs: COLD_SEED_LOCK_STALE_MS,
          timeoutMs: COLD_SEED_LOCK_TIMEOUT_MS,
          baseDelayMs: 100,
          maxDelayMs: 2_000,
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              // Another process may have seeded/reconciled while this host was
              // waiting for ownership. Re-read under the lease before doing any
              // expensive discovery.
              yield* loadRaw
              const hasChunks = rawFileChunks.length > 0 || rawDirChunks.length > 0
              if (freshEnough(hasChunks, yield* readIndexedAt)) return

              const mode = hasChunks ? "reconcile" : "seed"
              yield* walkAndApply(mode)

              // A reconcile removes ghosts, and those tombstones plus the one
              // delta chunk per watcher batch are what make later opens slow:
              // `readRaw` pays for every accumulated chunk. Rewriting the base
              // here keeps every later loadRaw() proportional to the live set.
              const chunkCount = rawFileChunks.length + rawDirChunks.length
              if (tombstones.size > COMPACT_TOMBSTONE_THRESHOLD || chunkCount > COMPACT_CHUNK_THRESHOLD) {
                yield* compact
              } else {
                yield* store.putMeta("tombstones", JSON.stringify([...tombstones])).pipe(Effect.ignore)
              }

              // Persist the freshness marker BEFORE releasing ownership. That is
              // what makes the next contender's loadRaw() an O(chunks) path
              // instead of another full repository walk; it is written after
              // compaction so a fresh marker proves the store is not mid-rewrite.
              yield* store.putMeta(INDEXED_AT_KEY, String(Date.now())).pipe(Effect.ignore)
            }),
          ),
        ),
      ).pipe(Effect.orDie)
    }

    // Low-priority metadata hydrator. Bulk seed/backfill does stat-only work;
    // line counts are reserved for small watcher batches where reading one or a
    // few edited files is cheap and useful. Persist once per drained wave rather
    // than JSON-stringifying the entire metadata map every 1000 files (quadratic
    // write amplification on huge repositories).
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          yield* Queue.take(metadataWake)
          // Coalesce rapid watcher seals before snapshotting the pending map.
          yield* Effect.sleep(25)
          // On a cold 100k+ project, give the first interactive query a short
          // uncontended grace window before bulk stat traffic begins. Small
          // watcher batches (the latency-sensitive case) bypass this delay.
          if (metadataPending.size > 64) yield* Effect.sleep(BULK_METADATA_GRACE_MS)
          const priority: Array<{ entry: PathEntry; countLines: boolean }> = []
          const bulk: Array<{ entry: PathEntry; countLines: boolean }> = []
          for (const item of metadataPending.values()) (item.countLines ? priority : bulk).push(item)
          metadataPending.clear()
          const work = priority.length === 0 ? bulk : priority.concat(bulk)
          if (work.length === 0) continue
          const chunkSize = METADATA_CHUNK_SIZE
          for (let i = 0; i < work.length; i += chunkSize) {
            const chunk = work.slice(i, i + chunkSize)
            yield* Effect.forEach(
              chunk,
              ({ entry, countLines }) =>
                fs.stat(path.join(root, entry.path)).pipe(
                  Effect.flatMap((info) => {
                    const size = Number(info.size)
                    const mtime = info.mtime._tag === "Some" ? info.mtime.value.getTime() : Date.now()
                    if (!countLines || !shouldCountLines(entry.path, size)) {
                      setStatOnlyMeta(entry.path, size, mtime)
                      return Effect.void
                    }
                    return fs.readFileStringSafe(path.join(root, entry.path)).pipe(
                      Effect.map((text) => {
                        const lineCount = text === undefined ? undefined : text.split("\n").length
                        setFileMeta(entry.path, { size, mtime, lineCount })
                      }),
                      Effect.catch(() => {
                        setFileMeta(entry.path, { size, mtime })
                        return Effect.void
                      }),
                    )
                  }),
                  Effect.catch(() => Effect.void),
                ),
              { concurrency: 8 },
            )
            // Cooperative breathing room keeps a bulk metadata backfill from
            // competing with interactive search for an entire event-loop turn.
            if (work.length > chunkSize) yield* Effect.sleep(5)
          }
          yield* store.putMeta("fileMeta", JSON.stringify([...fileMeta])).pipe(Effect.ignore)
        }
      }),
      scope,
    )

    // Existing persisted indexes may predate metadata. Even materializing the
    // full path snapshot can cost tens of milliseconds at 100k+ entries, so do
    // not do that while building the service. Schedule the entire discovery +
    // stat-only backfill after the interactive grace period instead.
    yield* Effect.forkIn(
      Effect.gen(function* () {
        yield* Effect.sleep(BULK_METADATA_GRACE_MS)
        const missing = snapshot().filter((p) => !p.isDir && !fileMeta.has(p.path))
        if (missing.length > 0) yield* queueMetadata(missing, false)
      }),
      scope,
    )

    const queue = yield* Queue.dropping<void>(256)
    yield* events.listenLocation(
      Watcher.Event.Updated,
      { directory: location.directory, workspaceID: location.workspaceID },
      (event) =>
      Effect.gen(function* () {
        const data = event.data as { file: string; event: "add" | "change" | "unlink" }
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
      fileMetadata: (entryPath) => fileMeta.get(entryPath),
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
      compact: () => compact,
    })
  }),
)
