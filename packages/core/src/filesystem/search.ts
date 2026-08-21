export * as FileSystemSearch from "./search"

import { makeLocationNode } from "../effect/app-node"
import path from "path"
import { Context, Effect, Layer, Option, Queue, Scope } from "effect"
import { EventV2 } from "../event"
import { Fff } from "#fff"
import fuzzysort from "fuzzysort"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { Flag } from "../flag/flag"
import { Watcher } from "./watcher"
import { Matcher } from "../search/matcher"
import { SearchIndex } from "../search/index-service"
import { ChunkStore } from "../search/chunk-store"
import { Global } from "../global"

// Mention-search session cache shared by backends that can enumerate paths:
// the prepared index is keyed by a cheap revision stamp so watcher deltas
// trigger a rebuild only when the candidate set actually changed.
const MENTION_BUILD_LIMIT = 100_000

function mentionSessionKey(paths: readonly { path: string }[], symbols: readonly unknown[]): string {
  return `${paths.length}:${symbols.length}:${paths.length > 0 ? (paths[0]!.path + "|" + paths[paths.length - 1]!.path) : ""}`
}

const mentionsState = new WeakMap<object, { key: string; session: Matcher.QuerySession }>()

function mentionsFromEntries(
  owner: object,
  paths: readonly Matcher.PathEntry[],
  symbols: readonly Matcher.SymbolEntry[],
  input: { query: string; limit: number; offset: number; symbols: boolean },
): Matcher.QueryPage {
  const key = mentionSessionKey(paths, symbols)
  let state = mentionsState.get(owner)
  if (!state || state.key !== key) {
    if (paths.length > MENTION_BUILD_LIMIT) {
      // oversized corpus without the byte-first store seam: fall back to
      // caller-provided ranking by returning an empty page (handler degrades)
      return { files: [], symbols: [], results: [], hasMore: false, total: 0 }
    }
    state = { key, session: Matcher.createSession(Matcher.prepare({ paths, symbols })) }
    mentionsState.set(owner, state)
  }
  return state.session.query(input.query, { limit: input.limit, offset: input.offset, symbols: input.symbols })
}

export interface Interface {
  readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[]>
  readonly glob: (input: FileSystem.GlobInput) => Effect.Effect<readonly FileSystem.Entry[]>
  readonly grep: (input: FileSystem.GrepInput) => Effect.Effect<readonly FileSystem.Match[]>
  /** Fuzzy mention search over paths (+symbols where the backend provides them). */
  readonly searchMentions: (input: {
    query: string
    limit: number
    offset: number
    symbols: boolean
  }) => Effect.Effect<Matcher.QueryPage>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileSystem/Search") {}

const DEBOUNCE_MS = 150

export const ripgrepLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const known = new Set<string>()
    const directories = new Set<string>()
    const dirCounts = new Map<string, number>()
    const state = {
      files: [] as string[],
      directories: [] as string[],
    }

    // Register a relative path (seed or watcher event) with its ancestor dirs, so
    // directories stay mentionable. Same dir derivation as the original seed walk:
    // path prefixes joined with "/", displayed with a trailing path.sep.
    const registerFile = (rel: string) => {
      if (known.has(rel)) return
      known.add(rel)
      state.files.push(rel)
      const parts = rel.split("/")
      parts.slice(0, -1).forEach((_, index) => {
        const key = parts.slice(0, index + 1).join("/")
        const count = (dirCounts.get(key) ?? 0) + 1
        dirCounts.set(key, count)
        directories.add(key + path.sep)
      })
    }

    const unregisterFile = (rel: string) => {
      if (!known.delete(rel)) return
      const index = state.files.indexOf(rel)
      if (index >= 0) state.files.splice(index, 1)
      const parts = rel.split("/")
      parts.slice(0, -1).forEach((_, index) => {
        const key = parts.slice(0, index + 1).join("/")
        const count = (dirCounts.get(key) ?? 1) - 1
        if (count <= 0) {
          dirCounts.delete(key)
          directories.delete(key + path.sep)
        } else {
          dirCounts.set(key, count)
        }
      })
    }

    // Watcher events carry absolute paths; skip anything outside the root, any
    // dot-segment (rg's --files skips hidden files/dirs, incl. .git — mirror that),
    // and event types for paths the rg seed would never list.
    const applyEvent = (file: string, event: "add" | "change" | "unlink") => {
      const rel = path.relative(location.directory, file).replaceAll("\\", "/")
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return
      if (rel.split("/").some((segment) => segment === "" || segment.startsWith("."))) return
      if (event === "unlink") unregisterFile(rel)
      else registerFile(rel)
    }

    yield* ripgrep
      .find({
        cwd: location.directory,
        pattern: "*",
        limit: location.vcs ? Number.MAX_SAFE_INTEGER : 100_000,
        onEntry: (entry) =>
          Effect.sync(() => {
            registerFile(entry.path)
          }),
      })
      .pipe(
        Effect.orDie,
        Effect.tap(() => Effect.sync(() => (state.directories = Array.from(directories)))),
        Effect.asVoid,
        Effect.forkIn(scope),
      )

    // Incremental freshness: consume file.watcher.updated events (location-filtered,
    // debounced batch, latest event per path wins) so the frozen rg snapshot stays
    // in sync with the filesystem — new/renamed/deleted/untracked files included.
    const queue = yield* Queue.dropping<{ file: string; event: "add" | "change" | "unlink" }>(1024)
    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (event.type !== Watcher.Event.Updated.type) return
        const data = event.data as { file: string; event: "add" | "change" | "unlink" }
        if (event.location && event.location.directory !== location.directory) return
        yield* Queue.offer(queue, data).pipe(Effect.ignore)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

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
        for (const [file, event] of batch) applyEvent(file, event)
        state.directories = Array.from(directories)
      }
    }).pipe(Effect.forkScoped)

    return Service.of({
      glob: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep
            .glob({
              cwd,
              pattern: input.pattern,
              limit: input.limit ?? Number.MAX_SAFE_INTEGER,
            })
            .pipe(
              Effect.map((result) =>
                result.map((entry) =>
                  FileSystem.Entry.make({
                    ...entry,
                    path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                  }),
                ),
              ),
              Effect.orDie,
            )
        }),
      grep: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep
            .grep({
              cwd,
              pattern: input.pattern,
              file: info.type === "File" ? path.basename(target) : undefined,
              include: input.include,
              limit: input.limit ?? Number.MAX_SAFE_INTEGER,
            })
            .pipe(
              Effect.map((result) =>
                result.map((match) =>
                  FileSystem.Match.make({
                    ...match,
                    entry: FileSystem.Entry.make({
                      ...match.entry,
                      path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, match.entry.path))),
                    }),
                  }),
                ),
              ),
              Effect.orDie,
            )
        }),
      find: (input) =>
        Effect.gen(function* () {
          const items =
            input.type === "file"
              ? state.files
              : input.type === "directory"
                ? state.directories
                : [...state.files, ...state.directories]
          return fuzzysort.go(input.query, items, { limit: input.limit ?? 50 }).map((item) => {
            const relative = item.target
            const type = relative.endsWith(path.sep) ? ("directory" as const) : ("file" as const)
            return FileSystem.Entry.make({
              path: RelativePath.make(relative),
              type,
            })
          })
        }),
      searchMentions: (input) =>
        Effect.sync(() => {
          const paths: Matcher.PathEntry[] = state.files.map((p) => ({ path: p, isDir: false }))
          for (const d of state.directories) {
            const trimmed = d.endsWith(path.sep) ? d.slice(0, -path.sep.length) : d
            paths.push({ path: trimmed, isDir: true })
          }
          return mentionsFromEntries(state, paths, [], input)
        }),
    })
  }),
)

export const fffLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const result = yield* Effect.try({
      try: () =>
        Fff.create({
          basePath: location.directory,
          aiMode: true,
          disableMmapCache: true,
          disableContentIndexing: true,
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((error) => Effect.logWarning("failed to initialize fff", { error }).pipe(Effect.as(undefined))),
    )
    if (!result?.ok) {
      if (result) yield* Effect.logWarning("failed to initialize fff", { error: result.error })
      return Service.of({
        find: () => Effect.succeed([]),
        glob: () => Effect.succeed([]),
        grep: () => Effect.succeed([]),
        searchMentions: () => Effect.succeed({ files: [], symbols: [], results: [], hasMore: false, total: 0 }),
      })
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => result.value.destroy()).pipe(Effect.ignore))
    return Service.of({
      glob: (input) =>
        Effect.sync(() => {
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          const found = result.value.glob(prefix ? `${prefix}/${input.pattern}` : input.pattern, {
            pageIndex: 0,
            pageSize: input.limit,
          })
          if (!found.ok) throw found.error
          return found.value.items.map((item) =>
            FileSystem.Entry.make({
              path: RelativePath.make(item.relativePath.replaceAll("\\", "/")),
              type: "file",
            }),
          )
        }),
      grep: (input) =>
        Effect.sync(() => {
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          const found = result.value.grep(
            [prefix ? `${prefix}/**` : undefined, input.include, input.pattern]
              .filter((value) => value !== undefined)
              .join(" "),
            { mode: "regex", pageSize: input.limit, timeBudgetMs: 1_500 },
          )
          if (!found.ok) throw found.error
          return found.value.items.map((match) => {
            const bytes = Buffer.from(match.lineContent)
            return FileSystem.Match.make({
              entry: FileSystem.Entry.make({
                path: RelativePath.make(match.relativePath.replaceAll("\\", "/")),
                type: "file",
              }),
              line: match.lineNumber,
              offset: match.byteOffset,
              text: match.lineContent.length > 2_000 ? match.lineContent.slice(0, 2_000) + "..." : match.lineContent,
              submatches: match.matchRanges.map(([start, end]) => ({
                text: bytes.subarray(start, end).toString("utf8"),
                start,
                end,
              })),
            })
          })
        }),
      find: (input) =>
        Effect.sync(() => {
          const options = { pageIndex: 0, pageSize: input.limit ?? 50 }
          const items = (() => {
            if (input.type === "file") {
              const found = result.value.fileSearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "file" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            if (input.type === "directory") {
              const found = result.value.directorySearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "directory" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            const found = result.value.mixedSearch(input.query.trim(), options)
            if (!found.ok) throw found.error
            return found.value.items.map((item, index) => ({
              path: item.item.relativePath,
              type: item.type,
              score: found.value.scores[index]?.total ?? 0,
            }))
          })()
          return items
            .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
            .map((item) => {
              const relative = item.path.replaceAll("\\", "/").replace(/\/$/, "")
              return FileSystem.Entry.make({
                path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                type: item.type,
              })
            })
        }),
      searchMentions: (input) =>
        Effect.sync(() => {
          const options = { pageIndex: 0, pageSize: input.limit + input.offset }
          const found = result.value.mixedSearch(input.query.trim(), options)
          if (!found.ok) throw found.error
          const items = found.value.items
            .map((item, index) => ({
              path: item.item.relativePath.replaceAll("\\", "/").replace(/\/$/, "") + (item.type === "directory" ? "/" : ""),
              type: item.type,
              score: found.value.scores[index]?.total ?? 0,
            }))
            .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
          const page = Math.max(0, input.offset)
          const window = items.slice(page, page + input.limit)
          const results: Matcher.UnifiedResult[] = window.map((item) => ({
            kind: "file" as const,
            path: item.path,
            type: item.type,
            score: item.score,
            positions: mentionPositions(item.path, input.query),
            baseOffset: item.path.lastIndexOf("/", item.path.length - 2) + 1,
          }))
          return {
            files: [],
            symbols: [],
            results,
            hasMore: page + window.length < items.length,
            total: items.length,
          }
        }),
    })
  }),
)

// highlight indices of the (single-token lowercased) query inside text,
// computed post-hoc for backends that rank without exposing positions
function mentionPositions(text: string, query: string): number[] | undefined {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return undefined
  const lower = text.toLowerCase()
  const out: number[] = []
  for (const tok of tokens) {
    let from = 0
    for (const ch of tok) {
      const idx = lower.indexOf(ch, from)
      if (idx < 0) break
      out.push(idx)
      from = idx + 1
    }
  }
  if (out.length === 0) return undefined
  out.sort((a, b) => a - b)
  return [...new Set(out)]
}

const indexLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const index = yield* SearchIndex.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return Service.of({
      glob: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep.glob({ cwd, pattern: input.pattern, limit: input.limit ?? Number.MAX_SAFE_INTEGER }).pipe(
            Effect.map((result) => result.map((entry) => FileSystem.Entry.make({ path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))), type: entry.type }))),
            Effect.orDie,
          ) as Effect.Effect<FileSystem.Entry[]>
        }),
      grep: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep.grep({ cwd, pattern: input.pattern, file: info.type === "File" ? path.basename(target) : undefined, include: input.include, limit: input.limit ?? Number.MAX_SAFE_INTEGER }).pipe(Effect.orDie)
        }),
      find: (input) =>
        Effect.gen(function* () {
          const snapshot = yield* (index.loadAll().pipe(Effect.orDie) as Effect.Effect<{ paths: SearchIndex.PathEntry[]; symbols: never[] }>)
          const targets = snapshot.paths
            .filter((entry) => input.type === undefined || (input.type === "directory") === entry.isDir)
            .map((entry) => (entry.isDir ? entry.path + path.sep : entry.path))
          return fuzzysort.go(input.query, targets, { limit: input.limit ?? 50 }).map((item) => {
            const relative = item.target
            const isDir = relative.endsWith(path.sep)
            return FileSystem.Entry.make({ path: RelativePath.make(relative), type: isDir ? "directory" : "file" })
          })
        }),
      searchMentions: (input) =>
        Effect.gen(function* () {
          const snapshot = yield* (index.loadAll().pipe(Effect.orDie) as Effect.Effect<{
            paths: SearchIndex.PathEntry[]
            symbols: Matcher.SymbolEntry[]
          }>)
          return mentionsFromEntries(index, snapshot.paths, snapshot.symbols, input)
        }),
    })
  }),
)

// Path-derived store wiring: layerWith composes the chunk-store statically so
// its connection finalizer attaches to the consumer scope (unwrap here only
// defers the path derivation until Location is available).
const indexComposite = Layer.unwrap(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const root = yield* fs.realPath(location.directory).pipe(Effect.orDie)
    return indexLayer.pipe(Layer.provideMerge(SearchIndex.layerWith(ChunkStore.dbPathFor(root, global.data))))
  }),
)
const baseLayer = Layer.unwrap(Effect.sync(() => (Flag.OPENCODE_DISABLE_FFF || !Fff.available() ? ripgrepLayer : fffLayer)))
const layer = Layer.unwrap(Effect.sync(() => (Flag.OPENCODE_SEARCH_INDEX ? indexComposite : baseLayer)))

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Location.node, Ripgrep.node, EventV2.node, Global.node] })
