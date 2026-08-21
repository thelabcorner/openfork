import { debounce } from "@solid-primitives/scheduled"
import { createSignal, onCleanup } from "solid-js"
import type { AtOption } from "./slash-popover"
import type { MentionResult } from "@/context/file"

const MENTION_SEARCH_DEBOUNCE_MS = 70
const MENTION_SEARCH_PAGE_SIZE = 200

export interface MentionSearchPageOf<T> {
  results: T[]
  hasMore: boolean
}

// Maps ranked server mention results to popover options, dropping paths that
// are already surfaced by the pinned recents section.
export function toMentionOptions(results: MentionResult[], recentPaths: readonly string[]): AtOption[] {
  let seen: Set<string> | undefined
  return results.flatMap((entry): AtOption[] => {
    if (entry.kind === "file") {
      if (!seen) seen = new Set(recentPaths)
      if (seen.has(entry.path)) return []
      return [
        {
          type: "file",
          path: entry.path,
          display: entry.path,
          isDir: entry.type === "directory",
          positions: entry.positions,
        },
      ]
    }
    return [
      {
        type: "symbol",
        name: entry.name,
        path: entry.path,
        line: entry.line,
        symbolKind: entry.symbolKind,
        display: entry.name,
        positions: entry.positions,
      },
    ]
  })
}

export function createAtMentionSearch<T>(
  search: (query: string, options: { signal: AbortSignal; limit: number; offset: number }) => Promise<MentionSearchPageOf<T>>,
) {
  const [results, setResults] = createSignal<T[]>([])
  const [searching, setSearching] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [hasMore, setHasMore] = createSignal(false)
  let controller: AbortController | undefined
  let generation = 0
  let query = ""

  const stale = (token: number, signal: AbortSignal) => token !== generation || signal.aborted

  const run = debounce(() => {
    controller?.abort()
    const next = new AbortController()
    controller = next
    const token = ++generation
    setSearching(true)
    search(query, { signal: next.signal, limit: MENTION_SEARCH_PAGE_SIZE, offset: 0 })
      .then((page) => {
        if (stale(token, next.signal)) return
        setResults(page.results)
        setHasMore(page.hasMore)
      })
      .catch(() => {
        if (stale(token, next.signal)) return
        setResults([])
        setHasMore(false)
      })
      .finally(() => {
        if (token !== generation) return
        setSearching(false)
      })
  }, MENTION_SEARCH_DEBOUNCE_MS)

  const loadMore = () => {
    if (!hasMore() || loadingMore() || searching()) return
    controller?.abort()
    const next = new AbortController()
    controller = next
    const token = ++generation
    setLoadingMore(true)
    search(query, { signal: next.signal, limit: MENTION_SEARCH_PAGE_SIZE, offset: results().length })
      .then((page) => {
        if (stale(token, next.signal)) return
        setResults((prev) => [...prev, ...page.results])
        setHasMore(page.hasMore)
      })
      .catch(() => {
        if (stale(token, next.signal)) return
        setHasMore(false)
      })
      .finally(() => {
        if (token !== generation) return
        setLoadingMore(false)
      })
  }

  const cancel = () => {
    run.clear()
    generation++
    controller?.abort()
    query = ""
    setResults([])
    setHasMore(false)
    setSearching(false)
    setLoadingMore(false)
  }

  const onInput = (value: string) => {
    if (!value.trim()) {
      cancel()
      return
    }
    query = value
    run()
  }

  onCleanup(cancel)

  return { results, searching, loadingMore, hasMore, onInput, loadMore }
}
