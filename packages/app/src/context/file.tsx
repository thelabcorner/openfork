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
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
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

    const inflight = new Map<string, Promise<void>>()
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })
    const watcherRefresh = {
      disposed: false,
      running: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      queue: new Set<string>(),
      stale: new Set<string>(),
    }

    const tree = createFileTreeStore({
      scope,
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
      scope()
      tree.switchScope()
      inflight.clear()
      resetFileContentLru()
      setStore("file", reconcile({}))
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
          if (scope() !== directory) return
          const content = x.data
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) return
          setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
        })
        .finally(() => {
          inflight.delete(key)
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

    const treeConsumerVisible = () => layout.fileTree.opened() || layout.projectExplorer.opened()

    const drainWatcherRefreshQueue = () => {
      if (watcherRefresh.disposed || watcherRefresh.running || watcherRefresh.timer) return
      if (watcherRefresh.queue.size === 0) return

      watcherRefresh.timer = setTimeout(() => {
        watcherRefresh.timer = undefined
        if (watcherRefresh.disposed) return

        const next = watcherRefresh.queue.values().next().value
        if (typeof next !== "string") return
        watcherRefresh.queue.delete(next)

        if (!treeConsumerVisible()) {
          watcherRefresh.stale.add(next)
          watcherRefresh.queue.forEach((dir) => watcherRefresh.stale.add(dir))
          watcherRefresh.queue.clear()
          return
        }

        watcherRefresh.running = true
        void tree.listDir(next, { force: true }).finally(() => {
          watcherRefresh.running = false
          drainWatcherRefreshQueue()
        })
      }, WATCHER_TREE_REFRESH_DELAY_MS)
    }

    const refreshTreeDirFromWatcher = (dir: string) => {
      if (!treeConsumerVisible()) {
        watcherRefresh.stale.add(dir)
        return
      }
      watcherRefresh.queue.add(dir)
      drainWatcherRefreshQueue()
    }

    createEffect(() => {
      if (!treeConsumerVisible()) return
      // Only refresh dirs still loaded in the tree. Events that landed while the
      // tree was hidden may reference dirs that were reset on a project switch;
      // refreshing those would be wasted work and a burst of listDir calls.
      for (const dir of watcherRefresh.stale) {
        if (tree.isLoaded(dir)) watcherRefresh.queue.add(dir)
      }
      watcherRefresh.stale.clear()
      drainWatcherRefreshQueue()
    })

    const stop = sdk().event.listen((e) => {
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        hasFile: (file) => treeConsumerVisible() && Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          void load(file, { force: true })
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: refreshTreeDirFromWatcher,
        onInvalidate: (file) => gitStatus.invalidate(file),
      })
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
      watcherRefresh.disposed = true
      if (watcherRefresh.timer) clearTimeout(watcherRefresh.timer)
      watcherRefresh.queue.clear()
      watcherRefresh.stale.clear()
      gitStatus.dispose()
      // FileProvider fully remounts on every navigation away from a session and back
      // (e.g. via Home or a draft tab -- those routes don't share this provider tree).
      // Save the current scope's tree into the module-level cache so the next mount for
      // the same directory seeds warm instead of paying a full uncached re-list.
      tree.persist()
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
        expand: tree.expandDir,
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
      searchFilesAndDirectories: (query: string) => search(query, "true"),
    }
  },
})
