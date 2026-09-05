import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@/utils/toast"
import { useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createPathHelpers } from "./file/path"
import { normalizeMentionPage } from "@/components/prompt-input/at-mention-search"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { useServerSDK } from "./server-sdk"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { createFileTreeStore } from "./file/tree-store"
import { invalidateFromWatcher } from "./file/watcher"
import { createGitStatusStore } from "./file/git-status"
import { normalizeFileTreeV2Path } from "@/components/file-tree-v2-model"
import { perf } from "@/context/perf"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }

export type MentionSymbolKind = "fn" | "method" | "class" | "interface" | "type" | "enum" | "const" | (string & {})

export type MentionResult =
  | {
      kind: "file"
      path: string
      type?: "file" | "directory"
      positions?: number[]
      /** Basename start offset in the full path; positions are basename-relative when > 0. */
      baseOffset?: number
      size?: number
      mtime?: number
      lineCount?: number
    }
  | {
      kind: "symbol"
      name: string
      path: string
      line: number
      symbolKind: MentionSymbolKind
      positions?: number[]
    }

export interface MentionSearchPage {
  results: MentionResult[]
  hasMore: boolean
}
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

const WATCHER_TREE_REFRESH_DELAY_MS = 120
const WATCHER_TREE_REFRESH_CONCURRENCY = 4
const WATCHER_DIR_QUEUE_MAX = 512
const WATCHER_FILE_QUEUE_MAX = 256
const WATCHER_FILE_REFRESH_DELAY_MS = 80
const WATCHER_FILE_REFRESH_CONCURRENCY = 2
const DEFAULT_MAX_CONTENT_SCOPES = 5

// Module-level (not per-store), mirroring tree-store's scopeCache: keeps a project's
// loaded file *content* across a scope switch and across a FileProvider remount, not
// just within one provider's lifetime. Previously every scope change unconditionally
// wiped store.file (see the old `setStore("file", reconcile({}))` here), so revisiting
// a project always re-fetched every open file's content even seconds later -- unlike
// the directory tree, which already had this cache. Bounded by the same maxScopes as
// tree-store so a long session doesn't grow this unbounded.
const contentScopeCache = new Map<string, Record<string, FileState>>()

function touchContentScope(key: string) {
  const snap = contentScopeCache.get(key)
  if (!snap) return
  contentScopeCache.delete(key)
  contentScopeCache.set(key, snap)
}

function evictContentScopes(maxScopes: number) {
  while (contentScopeCache.size > maxScopes) {
    const oldest = contentScopeCache.keys().next().value
    if (oldest === undefined) break
    contentScopeCache.delete(oldest)
  }
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    useSync()
    const params = useParams()
    const serverSDK = useServerSDK()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk().directory)
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(() =>
      SessionStateKey.from(serverSDK().scope, SessionRouteKey.fromRoute(base64Encode(sdk().directory), params.id)),
    )
    const openTabPaths = createMemo(() => new Set(tabs.all().map((tab) => path.pathFromTab(tab))))

    const inflight = new Map<string, Promise<void>>()
    let providerDisposed = false
    let currentContentScope = scope()
    const initialContentSnapshot = contentScopeCache.get(currentContentScope)
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: initialContentSnapshot ? { ...initialContentSnapshot } : {},
    })
    if (initialContentSnapshot) {
      touchContentScope(currentContentScope)
      for (const file of Object.values(initialContentSnapshot)) {
        if (!file.content) continue
        touchFileContent(file.path, approxBytes(file.content))
      }
    }
    const watcherRefresh = {
      disposed: false,
      running: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      queue: new Set<string>(),
      stale: new Set<string>(),
      staleAll: false,
      fileRunning: false,
      fileTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      fileQueue: new Set<string>(),
    }

    const tree = createFileTreeStore({
      scope,
      schedulerKey: () => serverSDK().url,
      normalizeDir: path.normalizeDir,
      list: (dir) =>
        sdk()
          .client.file.list({ path: dir })
          .then((x) => x.data ?? []),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    const gitStatus = createGitStatusStore({
      scope,
      normalize: normalizeFileTreeV2Path,
      fetchStatus: () =>
        sdk()
          .client.file.status()
          .then((x) => x.data ?? []),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    const treeConsumerVisible = () => layout.fileTree.opened() || layout.projectExplorer.opened()

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    createEffect(() => {
      const next = scope()
      tree.switchScope()
      if (next === currentContentScope) return

      // A provider can change projects while watcher/file refreshes are still
      // queued. Those paths belong to the previous scope; carrying them into
      // the new sidecar wastes permits and can make the first interactive
      // expansion wait behind stale work. In-flight reads are guarded by the
      // scope check in `load`, so only the not-yet-started queues need to be
      // discarded here.
      watcherRefresh.queue.clear()
      watcherRefresh.stale.clear()
      watcherRefresh.fileQueue.clear()
      watcherRefresh.staleAll = false
      if (watcherRefresh.timer) clearTimeout(watcherRefresh.timer)
      watcherRefresh.timer = undefined
      if (watcherRefresh.fileTimer) clearTimeout(watcherRefresh.fileTimer)
      watcherRefresh.fileTimer = undefined

      contentScopeCache.set(currentContentScope, { ...store.file })
      evictContentScopes(DEFAULT_MAX_CONTENT_SCOPES)
      currentContentScope = next
      inflight.clear()
      resetFileContentLru()

      const cached = contentScopeCache.get(next)
      if (!cached) {
        setStore("file", reconcile({}))
        return
      }
      touchContentScope(next)
      setStore("file", reconcile(cached))
      for (const file of Object.values(cached)) {
        if (!file.content) continue
        touchFileContent(file.path, approxBytes(file.content))
      }
    })

    // Keep the status snapshot aligned with the active project. The status
    // store itself deduplicates cached scopes and ignores completions from an
    // old scope; this effect makes the initial load and scope switches
    // observable instead of waiting for a consumer to remember `ensure()`.
    createEffect(() => {
      // A hidden session still records the boolean dirty bit, but it should
      // not start a full git-status scan for every watcher burst. Re-entering
      // the explorer runs this effect again; the status store sees the dirty
      // cache and schedules one debounced refresh then.
      scope()
      if (treeConsumerVisible()) gitStatus.ensure()
    })

    const viewCache = createFileViewCache(serverSDK().scope)
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const load = (input: string, options?: { force?: boolean }) => {
      if (providerDisposed) return Promise.resolve()
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      const pending = inflight.get(key)
      if (pending) return pending

      setLoading(file)

      const promise = sdk()
        .client.file.read({ path: file })
        .then((x) => {
          if (providerDisposed || scope() !== directory) return
          const content = x.data
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (providerDisposed || scope() !== directory) return
          setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
        })
        .finally(() => {
          if (inflight.get(key) === promise) inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false", options?: { limit?: number; signal?: AbortSignal }) =>
      serverSDK()
        .api.file.find(
          {
            location: { directory: sdk().directory },
            query,
            type: dirs === "true" ? undefined : "file",
            limit: options?.limit,
          },
          { signal: options?.signal },
        )
        .then(
          (x) => x.data.map((entry) => path.normalize(entry.path)),
          (error) => {
            if (options?.signal?.aborted) throw error
            return []
          },
        )

    // /find/search (index-backed mention search) with graceful degradation to the
    // legacy file find for older servers; the unavailable flag sticks so a 404
    // server doesn't take the probe on every keystroke.
    let mentionsIndexUnavailable = false

    const searchMentionsFallback = (
      query: string,
      options?: { limit?: number; offset?: number; signal?: AbortSignal },
    ): Promise<MentionSearchPage> =>
      search(query, "true", options).then((paths) => ({
        results: paths.map((path): MentionResult => {
          if (!path.endsWith("/")) return { kind: "file", path }
          return { kind: "file", path: path.replace(/\/+$/, ""), type: "directory" }
        }),
        hasMore: false,
      }))

    const searchMentions = (
      query: string,
      options?: { limit?: number; offset?: number; signal?: AbortSignal },
    ): Promise<MentionSearchPage> => {
      if (mentionsIndexUnavailable) return searchMentionsFallback(query, options)
      return serverSDK()
        .api.find.search({
          location: { directory: sdk().directory },
          query,
          limit: options?.limit,
          offset: options?.offset,
          signal: options?.signal,
        })
        .then(
          (x) => normalizeMentionPage(x.data),
          (error) => {
            if (options?.signal?.aborted) throw error
            mentionsIndexUnavailable = true
            return searchMentionsFallback(query, options)
          },
        )
    }

    const enqueueWatcherDirectory = (target: Set<string>, directory: string) => {
      if (target.has(directory)) return
      // A branch switch or dependency install can produce thousands of watcher
      // notifications. Keep the set bounded and mark the loaded tree stale;
      // the visible-pane effect re-lists those directories lazily instead of
      // pretending that a root refresh repaired deep expanded branches.
      if (target.size >= WATCHER_DIR_QUEUE_MAX) {
        target.clear()
        watcherRefresh.staleAll = true
        return
      }
      target.add(directory)
    }

    const enqueueWatcherFile = (file: string) => {
      if (watcherRefresh.disposed) return
      if (!watcherRefresh.fileQueue.has(file) && watcherRefresh.fileQueue.size >= WATCHER_FILE_QUEUE_MAX) {
        // Keep the newest invalidations. File events are edge-triggered by the
        // watcher, so a later edit will requeue anything evicted here.
        const oldest = watcherRefresh.fileQueue.values().next().value
        if (typeof oldest === "string") watcherRefresh.fileQueue.delete(oldest)
      }
      watcherRefresh.fileQueue.add(file)
    }

    const drainWatcherFileQueue = () => {
      if (watcherRefresh.disposed || watcherRefresh.fileRunning || watcherRefresh.fileTimer) return
      if (watcherRefresh.fileQueue.size === 0) return

      watcherRefresh.fileTimer = setTimeout(() => {
        watcherRefresh.fileTimer = undefined
        if (watcherRefresh.disposed) return
        const next = [...watcherRefresh.fileQueue]
        watcherRefresh.fileQueue.clear()
        if (next.length === 0) return

        watcherRefresh.fileRunning = true
        let cursor = 0
        const worker = async () => {
          while (!watcherRefresh.disposed && cursor < next.length) {
            const file = next[cursor++]
            if (file) await load(file, { force: true })
          }
        }
        const workers = Array.from({ length: Math.min(WATCHER_FILE_REFRESH_CONCURRENCY, next.length) }, () => worker())
        void Promise.all(workers)
          .catch(() => undefined)
          .finally(() => {
            watcherRefresh.fileRunning = false
            drainWatcherFileQueue()
          })
      }, WATCHER_FILE_REFRESH_DELAY_MS)
    }

    const drainWatcherRefreshQueue = () => {
      if (watcherRefresh.disposed || watcherRefresh.running || watcherRefresh.timer) return
      if (watcherRefresh.queue.size === 0) return

      watcherRefresh.timer = setTimeout(() => {
        watcherRefresh.timer = undefined
        if (watcherRefresh.disposed) return

        const next: string[] = []
        while (next.length < WATCHER_TREE_REFRESH_CONCURRENCY && watcherRefresh.queue.size > 0) {
          const dir = watcherRefresh.queue.values().next().value
          if (typeof dir !== "string") break
          watcherRefresh.queue.delete(dir)
          next.push(dir)
        }
        if (next.length === 0) return

        if (!treeConsumerVisible()) {
          next.forEach((dir) => enqueueWatcherDirectory(watcherRefresh.stale, dir))
          watcherRefresh.queue.forEach((dir) => enqueueWatcherDirectory(watcherRefresh.stale, dir))
          watcherRefresh.queue.clear()
          return
        }

        watcherRefresh.running = true
        void Promise.all(
          next.map((dir) => tree.listDir(dir, { force: true, priority: "background" })),
        ).finally(() => {
          watcherRefresh.running = false
          drainWatcherRefreshQueue()
        })
      }, WATCHER_TREE_REFRESH_DELAY_MS)
    }

    const refreshTreeDirFromWatcher = (dir: string) => {
      const normalized = path.normalize(dir)
      if (!treeConsumerVisible()) {
        enqueueWatcherDirectory(watcherRefresh.stale, normalized)
        return
      }
      enqueueWatcherDirectory(watcherRefresh.queue, normalized)
      drainWatcherRefreshQueue()
    }

    createEffect(() => {
      if (!treeConsumerVisible()) return
      if (watcherRefresh.staleAll) {
        // A bounded queue overflow is a loss of precise paths. Mark the whole
        // loaded index stale and re-list lazily by directory, rather than
        // pretending the root refresh repaired deep expanded branches.
        const loaded = tree.loadedDirectories()
        watcherRefresh.staleAll = false
        tree.markAllStale()
        for (const dir of loaded) enqueueWatcherDirectory(watcherRefresh.queue, dir)
      }
      // Only refresh dirs still loaded in the tree. Events that landed while the
      // tree was hidden may reference dirs that were reset on a project switch;
      // refreshing those would be wasted work and a burst of listDir calls.
      for (const dir of watcherRefresh.stale) {
        if (tree.isLoaded(dir)) enqueueWatcherDirectory(watcherRefresh.queue, dir)
      }
      watcherRefresh.stale.clear()
      drainWatcherRefreshQueue()
    })

    // Subscribe by event type so the explorer does not execute a callback for
    // every session/tool/LSP event carried by the shared SSE stream.
    const stop = sdk().event.on("file.watcher.updated", (event) => {
      const watcherStarted = performance.now()
      invalidateFromWatcher(event, {
        normalize: path.normalize,
        hasFile: (file) => treeConsumerVisible() && Boolean(store.file[file]),
        isOpen: (file) => openTabPaths().has(file),
        loadFile: (file) => {
          enqueueWatcherFile(file)
          drainWatcherFileQueue()
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: refreshTreeDirFromWatcher,
        onInvalidate: (file) => gitStatus.invalidate(file, { schedule: treeConsumerVisible() }),
      })
      perf.span("watcher", performance.now() - watcherStarted)
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      providerDisposed = true
      watcherRefresh.disposed = true
      if (watcherRefresh.timer) clearTimeout(watcherRefresh.timer)
      if (watcherRefresh.fileTimer) clearTimeout(watcherRefresh.fileTimer)
      if (watcherRefresh.staleAll || watcherRefresh.queue.size > 0 || watcherRefresh.stale.size > 0) {
        // Persist the loss of precise watcher paths so a provider remount
        // cannot present a silently stale cached tree as authoritative.
        tree.markAllStale()
      }
      watcherRefresh.queue.clear()
      watcherRefresh.stale.clear()
      watcherRefresh.staleAll = false
      watcherRefresh.fileQueue.clear()
      gitStatus.dispose()
      // FileProvider fully remounts on every navigation away from a session and back
      // (e.g. via Home or a draft tab -- those routes don't share this provider tree).
      // Save the current scope's tree into the module-level cache so the next mount for
      // the same directory seeds warm instead of paying a full uncached re-list.
      tree.persist()
      tree.dispose()
      contentScopeCache.set(currentContentScope, { ...store.file })
      touchContentScope(currentContentScope)
      evictContentScopes(DEFAULT_MAX_CONTENT_SCOPES)
      stop()
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        state: tree.dirState,
        children: tree.children,
        allNodes: tree.allNodes,
        hasNode: tree.hasNode,
        expand: tree.expandDir,
        beginGeneration: tree.beginGeneration,
        collapse: tree.collapseDir,
        expandAll: tree.expandAll,
        collapseAll: tree.collapseAll,
        prewarm: tree.prewarm,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      gitStatus: gitStatus.status,
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string, options?: { limit?: number; signal?: AbortSignal }) =>
        search(query, "false", options),
      searchFilesAndDirectories: (query: string, options?: { limit?: number; signal?: AbortSignal }) =>
        search(query, "true", options),
      searchMentions,
    }
  },
})
