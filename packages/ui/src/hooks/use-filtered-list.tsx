import fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, map, pipe } from "remeda"
import { createEffect, createMemo, createResource, on } from "solid-js"
import { createStore } from "solid-js/store"
import { createList } from "solid-list"

export interface FilteredListProps<T> {
  items: T[] | ((filter: string) => T[] | Promise<T[]>)
  key: (item: T) => string
  filterKeys?: string[]
  current?: T
  groupBy?: (x: T) => string
  sortBy?: (a: T, b: T) => number
  sortGroupsBy?: (a: { category: string; items: T[] }, b: { category: string; items: T[] }) => number
  skipFilter?: (item: T) => boolean
  onSelect?: (value: T | undefined, index: number) => void
  noInitialSelection?: boolean
}

function splitCamelCase(text: string): string[] {
  // Split PascalCase / camelCase by detecting uppercase letters that start new words.
  // Example: "dialogSelectModel" -> ["dialog", "select", "model"]
  // Example: "DialogSelectModel" -> ["Dialog", "Select", "Model"]
  const words = text
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
  return words.filter((w) => w.length > 0)
}

function extractAcronym(text: string): string {
  // Extract acronym from PascalCase / camelCase by taking the first letter of each word segment.
  // Example: "DialogSelectModel" -> "DSM"
  const words = splitCamelCase(text)
  return words.map((w) => w[0]?.toUpperCase() ?? "").join("")
}

function getNestedValue(obj: any, path: string): string {
  return path.split(".").reduce((val, key) => (val !== null && val !== undefined ? val[key] : undefined), obj) ?? ""
}

function densityBonus(needle: string, haystack: string): number {
  if (!needle || typeof needle !== "string" || !haystack || typeof haystack !== "string") return 0
  const needleTokens = needle
    .toLowerCase()
    .split(/[\s\-_.]+/)
    .filter((t) => t.length > 0)
  if (needleTokens.length === 0) return 0
  const hayLower = haystack.toLowerCase()
  let maxConsecutive = 0
  let currentConsecutive = 0
  let tokenIndex = 0
  // Scan haystack for consecutive token sequence matches
  for (let i = 0; i < hayLower.length; i++) {
    const remaining = hayLower.slice(i)
    if (tokenIndex < needleTokens.length && remaining.startsWith(needleTokens[tokenIndex])) {
      currentConsecutive++
      i += needleTokens[tokenIndex].length - 1
      tokenIndex++
      if (currentConsecutive > maxConsecutive) maxConsecutive = currentConsecutive
    } else {
      // Reset: try to match current token from this position
      if (tokenIndex > 0) {
        // Backtrack: try to restart sequence from earlier token
        tokenIndex = 0
        currentConsecutive = 0
        i-- // retry same position with reset
      } else {
        currentConsecutive = 0
      }
    }
  }
  // Also count any partial consecutive runs found
  return maxConsecutive
}

function tokenScore(needle: string, haystack: string): number {
  const needleTokens = needle
    .toLowerCase()
    .split(/[\s\-_.]+/)
    .filter((t) => t.length > 0)
  if (needleTokens.length === 0) return 0
  const hayLower = haystack.toLowerCase()

  // Build expanded token set: original text + camel-split words + acronym
  const camelWords = splitCamelCase(haystack)
  const acronym = extractAcronym(haystack)
  const expandedTokens = [
    ...camelWords.map((w) => w.toLowerCase()),
    acronym.toLowerCase(),
  ].filter((t) => t.length > 0)

  let score = 0
  for (const token of needleTokens) {
    // Check original haystack first
    const inOriginal = hayLower.includes(token)
    const inExpanded = expandedTokens.some((et) => et === token || et.includes(token))

    if (!inOriginal && !inExpanded) return 0

    // Score acronym hits with very high priority
    const acronymLower = acronym.toLowerCase()
    if (token === acronymLower && acronymLower.length > 0) {
      score += 10 // High priority for acronym match
      continue
    }

    // Original haystack scoring
    const index = hayLower.indexOf(token)
    const isAtPositionZero = index === 0
    const isAfterDelimiter = index > 0 && /[\/\.\-\_\s]/.test(hayLower[index - 1])
    if (isAtPositionZero || isAfterDelimiter) {
      score += 2
    } else {
      score += 1
    }

    // Also score against camel-split words
    for (const word of camelWords) {
      const wordLower = word.toLowerCase()
      if (wordLower === token) {
        score += 2 // Word-level match on split token
      } else if (wordLower.includes(token)) {
        score += 1
      }
    }
  }
  return score
}

function recencyBonus(item: any): number {
  // Small UX tweak: recently-modified files rank slightly higher.
  // Uses the `mtime` field from PromptInputV2Suggestion (file search results).
  // 7-day window, linear decay, capped at +30 points so it never overrides
  // a strong token match.
  const mtime = (item as any)?.mtime
  if (typeof mtime !== "number" || !Number.isFinite(mtime) || mtime <= 0) return 0
  const daysSince = (Date.now() - mtime) / (1000 * 60 * 60 * 24)
  if (daysSince >= 7) return 0
  return Math.min(30, Math.max(0, (7 - daysSince) * 5))
}

function filterWithTokens<T>(needle: string, items: T[], keys?: string[]): T[] {
  if (!needle) return items
  const needleTokens = needle
    .toLowerCase()
    .split(/[\s\-_.]+/)
    .filter((t) => t.length > 0)
  if (needleTokens.length === 0) return items

  const results = items
    .map((item) => {
      const text = keys ? keys.map((k) => String(getNestedValue(item, k))).join(" ") : String(item)
      const score = tokenScore(needle, text) + recencyBonus(item)
      return { item, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || String(a.item).localeCompare(String(b.item)))
    .map(({ item }) => item)
  return results
}

export function useFilteredList<T>(props: FilteredListProps<T>) {
  const [store, setStore] = createStore<{ filter: string }>({ filter: "" })

  type Group = { category: string; items: [T, ...T[]] }
  const empty: Group[] = []

  const [grouped, { refetch }] = createResource(
    () => ({
      filter: store.filter,
      items: typeof props.items === "function" ? props.items(store.filter) : props.items,
    }),
    async ({ filter, items }) => {
      const query = filter ?? ""
      const needle = query.toLowerCase()
      const all = (await Promise.resolve(items)) || []
      const result = pipe(
        all,
        (x) => {
          if (!needle) return x
          const skipFilter = props.skipFilter
          const filterable = skipFilter ? x.filter((item) => !skipFilter(item)) : x
          const skipped = skipFilter ? x.filter(skipFilter) : []

          let filtered: T[]
          const tokenFiltered = filterWithTokens(needle, filterable, props.filterKeys)
          let fuzzFiltered: T[] = []
          if (!props.filterKeys && Array.isArray(filterable) && filterable.every((e) => typeof e === "string")) {
            fuzzFiltered = fuzzysort.go(needle, filterable).map((x: any) => x.target) as T[]
          } else {
            fuzzFiltered = fuzzysort.go(needle, filterable, { keys: props.filterKeys! }).map((x: any) => x.obj)
          }
          // Combine: token matches first (ranked by score), then fuzzysort-only hits
          // Score fuzzFiltered hits with density bonus for consecutive token sequences
          const tokenSet = new Set(tokenFiltered.map((item) => props.key(item)))
          const fuzzWithDensity = fuzzFiltered
            .filter((item) => !tokenSet.has(props.key(item)))
            .map((item) => {
              const text = props.filterKeys
                ? props.filterKeys.map((k) => String(getNestedValue(item, k))).join(" ")
                : String(item)
              const density = densityBonus(query, text)
              return { item, density }
            })
          // Sort combined: token score first, then density bonus, then alphabetical
          const tokenWithScore = tokenFiltered.map((item) => {
            const text = props.filterKeys
              ? props.filterKeys.map((k) => String(getNestedValue(item, k))).join(" ")
              : String(item)
            return { item, score: tokenScore(query, text), density: densityBonus(query, text) }
          })
          const combinedSorted = [
            ...tokenWithScore.sort((a, b) => {
              if (b.score !== a.score) return b.score - a.score
              if (b.density !== a.density) return b.density - a.density
              return String(a.item).localeCompare(String(b.item))
            }).map(({ item }) => item),
            ...fuzzWithDensity.sort((a, b) => {
              if (b.density !== a.density) return b.density - a.density
              return String(a.item).localeCompare(String(b.item))
            }).map(({ item }) => item),
          ]
          filtered = combinedSorted
          return skipped.length ? [...filtered, ...skipped] : filtered
        },
        groupBy((x) => (props.groupBy ? props.groupBy(x) : "")),
        entries(),
        map(([k, v]) => ({ category: k, items: props.sortBy ? v.sort(props.sortBy) : v })),
        (groups) => (props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups),
      )
      return result
    },
    { initialValue: empty },
  )

  const flat = createMemo(() => {
    return pipe(
      grouped.latest || [],
      flatMap((x) => x.items),
    )
  })

  function initialActive() {
    if (props.noInitialSelection) return ""
    if (props.current) return props.key(props.current)

    const items = flat()
    if (items.length === 0) return ""
    return props.key(items[0])
  }

  const list = createList({
    items: () => flat().map(props.key),
    initialActive: initialActive(),
    loop: true,
  })

  const reset = () => {
    if (props.noInitialSelection) {
      list.setActive("")
      return
    }
    const all = flat()
    if (all.length === 0) return
    list.setActive(props.key(all[0]))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const selectedIndex = flat().findIndex((x) => props.key(x) === list.active())
      const selected = flat()[selectedIndex]
      if (selected) props.onSelect?.(selected, selectedIndex)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "n" || event.key === "p") {
        event.preventDefault()
        const navEvent = new KeyboardEvent("keydown", {
          key: event.key === "n" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
        })
        list.onKeyDown(navEvent)
      }
    } else {
      // Skip list navigation for text editing shortcuts (e.g., Option+Arrow, Option+Backspace on macOS)
      if (event.altKey || event.metaKey) return
      list.onKeyDown(event)
    }
  }

  createEffect(
    on(grouped, () => {
      reset()
    }),
  )

  const onInput = (value: string) => {
    setStore("filter", value)
  }

  return {
    grouped,
    filter: () => store.filter,
    flat,
    reset,
    refetch,
    clear: () => setStore("filter", ""),
    onKeyDown,
    onInput,
    active: list.active,
    setActive: list.setActive,
  }
}
