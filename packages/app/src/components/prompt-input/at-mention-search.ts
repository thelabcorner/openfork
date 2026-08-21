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

type WireNumber = number | string

interface WireMentionPage {
  results: Array<
    | {
        kind: "symbol"
        name: string
        path: string
        line: WireNumber
        symbolKind: string
        positions?: WireNumber[]
      }
    | {
        kind: "file"
        path: string
        type?: "file" | "directory"
        positions?: WireNumber[]
        baseOffset?: WireNumber
      }
  >
  hasMore: boolean
}

// Normalizes a /find/search page into the app-internal contract: OpenAPI numeric
// string-sentinels coerced, and file-row match positions projected from
// full-path coordinates onto the basename the row renders.
export function normalizeMentionPage(page: WireMentionPage): { results: MentionResult[]; hasMore: boolean } {
  return {
    results: page.results.map((entry): MentionResult => {
      if (entry.kind === "symbol") {
        return {
          kind: "symbol",
          name: entry.name,
          path: entry.path,
          line: Number(entry.line),
          symbolKind: entry.symbolKind,
          positions: entry.positions?.map(Number),
        }
      }
      const baseOffset = entry.baseOffset === undefined ? undefined : Number(entry.baseOffset)
      const positions =
        entry.positions && baseOffset !== undefined && baseOffset > 0
          ? entry.positions.map(Number).filter((p) => p >= baseOffset).map((p) => p - baseOffset)
          : entry.positions?.map(Number)
      return { kind: "file", path: entry.path, type: entry.type, positions }
    }),
    hasMore: page.hasMore,
  }
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
