import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

const QUERY_DEBOUNCE_MS = 200
// Bounds a single tool part's contribution to the search blob so one huge tool
// output/input can't dominate recompute cost. Generous vs. the server's search
// index cap since this never touches a DB, just guards a worst case.
const MAX_PART_TEXT_LENGTH = 20_000

const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)

function partSearchText(part: Part): string {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text
    case "tool": {
      const state = part.state
      const input = truncate(JSON.stringify(state.input ?? {}), MAX_PART_TEXT_LENGTH)
      const extra =
        state.status === "completed"
          ? truncate(state.output, MAX_PART_TEXT_LENGTH)
          : state.status === "error"
            ? truncate(state.error, MAX_PART_TEXT_LENGTH)
            : ""
      return `${part.tool} ${input} ${extra}`.trim()
    }
    default:
      return ""
  }
}

function messageSearchText(message: Message, parts: Part[]): string {
  if (message.role === "user")
    return parts
      .filter((part) => part.type === "text")
      .map((part) => truncate(part.text, MAX_PART_TEXT_LENGTH))
      .join(" ")
  return parts.map(partSearchText).join(" ")
}

function partLength(part: Part): number {
  if (part.type === "text" || part.type === "reasoning") return part.text.length
  if (part.type === "tool") {
    const state = part.state
    if (state.status === "completed") return state.output.length
    if (state.status === "error") return state.error.length
    return 0
  }
  return 0
}

// Cheap structural fingerprint of a turn's content (part count + last part's
// id/length) — avoids re-deriving and re-lowercasing a turn's full text just
// to check whether it's still current. Heuristic, not a hash: parts stream
// in monotonically (append-only) in practice, so a length/id change is what
// actually signals new content; a same-length in-place edit of the last part
// would go undetected, which is an acceptable, deliberate trade for avoiding
// a full-text comparison on every rebuild.
function turnSignature(turnID: string, assistantIDs: string[], parts: (messageID: string) => Part[]): string {
  const sig = (id: string) => {
    const list = parts(id)
    const last = list[list.length - 1]
    return last ? `${id}:${list.length}:${last.id}:${partLength(last)}` : `${id}:0`
  }
  return [turnID, ...assistantIDs].map(sig).join("|")
}

export type TurnTextCache = Map<string, { signature: string; text: string }>

// Text is grouped by turn (the user message that started it) so navigation
// can reuse MessageTimeline's existing userMessageID-keyed scroll seam.
// `cache` lets repeated calls skip rebuilding (and re-lowercasing) turns
// whose content hasn't actually changed since the last build — the bulk of
// the corpus during a normal editing/streaming session.
export function buildTurnSearchText(
  turns: UserMessage[],
  sessionMessages: Message[],
  parts: (messageID: string) => Part[],
  cache?: TurnTextCache,
): Map<string, string> {
  const assistantsByParent = new Map<string, Message[]>()
  for (const message of sessionMessages) {
    if (message.role !== "assistant") continue
    const list = assistantsByParent.get(message.parentID)
    if (list) list.push(message)
    else assistantsByParent.set(message.parentID, [message])
  }

  const map = new Map<string, string>()
  for (const turn of turns) {
    const assistants = assistantsByParent.get(turn.id) ?? []
    const signature = cache && turnSignature(turn.id, assistants.map((m) => m.id), parts)
    const cached = signature !== undefined ? cache?.get(turn.id) : undefined
    if (cached && signature !== undefined && cached.signature === signature) {
      map.set(turn.id, cached.text)
      continue
    }

    const text = [
      messageSearchText(turn, parts(turn.id)),
      ...assistants.map((message) => messageSearchText(message, parts(message.id))),
    ]
      .join(" ")
      .toLowerCase()
    map.set(turn.id, text)
    if (cache && signature !== undefined) cache.set(turn.id, { signature, text })
  }
  return map
}

// Pure match step: given the query, returns matching turn ids in transcript
// order. Kept separate from the reactive controller so it's directly testable.
export function matchSessionTurns(
  turns: UserMessage[],
  sessionMessages: Message[],
  parts: (messageID: string) => Part[],
  query: string,
): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const text = buildTurnSearchText(turns, sessionMessages, parts)
  return turns.flatMap((turn) => (text.get(turn.id)?.includes(needle) ? [turn.id] : []))
}

// Debounce is driven by plain setTimeout (not a reactive effect) so it's a
// direct, imperative reaction to `setQuery` calls: easy to reason about and
// exercisable in tests without depending on a render/effect scheduler.
// The caller is expected to react to `activeTurnID()` changes (e.g. via
// `createEffect(on(...))`) to scroll the timeline — kept out of this module
// so it stays pure state + computation with no owned side effects.
export function createSessionFindMatcher(input: {
  turns: Accessor<UserMessage[]>
  sessionMessages: Accessor<Message[]>
  parts: (messageID: string) => Part[]
}) {
  const [state, setState] = createStore({
    open: false,
    query: "",
    debouncedQuery: "",
    index: 0,
  })
  let debounce: ReturnType<typeof setTimeout> | undefined
  const textCache: TurnTextCache = new Map()

  const clearDebounce = () => {
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = undefined
  }

  // Corpus building is its own memo, separate from query filtering, and only
  // tracks session data (turns/messages/parts) — not the query. So typing
  // doesn't rebuild it, and per-turn caching means only turns whose content
  // actually changed (e.g. the one actively streaming) get re-scanned.
  const turnText = createMemo(() => {
    if (!state.open) return undefined
    return buildTurnSearchText(input.turns(), input.sessionMessages(), input.parts, textCache)
  })

  // Zero idle cost: only scans while the bar is open, and only on the
  // debounced query so keystrokes don't each trigger a full-session scan.
  const matches = createMemo(() => {
    const text = turnText()
    if (!text) return []
    const needle = state.debouncedQuery.trim().toLowerCase()
    if (!needle) return []
    return input.turns().flatMap((turn) => (text.get(turn.id)?.includes(needle) ? [turn.id] : []))
  })

  const activeTurnID = createMemo(() => matches()[state.index])
  const matchedTurnIDs = createMemo(() => new Set(matches()))

  const step = (dir: 1 | -1) => {
    const total = matches().length
    if (total === 0) return
    setState("index", (index) => (index + dir + total) % total)
  }

  return {
    open: () => state.open,
    query: () => state.query,
    index: () => state.index,
    count: () => matches().length,
    activeTurnID,
    matchedTurnIDs,
    setQuery: (value: string) => {
      setState({ query: value, index: 0 })
      clearDebounce()
      debounce = setTimeout(() => setState("debouncedQuery", value), QUERY_DEBOUNCE_MS)
    },
    focus: () => {
      clearDebounce()
      setState({ open: true, debouncedQuery: state.query })
    },
    close: () => {
      clearDebounce()
      setState({ open: false, query: "", debouncedQuery: "", index: 0 })
    },
    next: () => step(1),
    prev: () => step(-1),
  }
}

function scrollParent(el: HTMLElement): HTMLElement | undefined {
  let parent = el.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    if (style.overflowY === "auto" || style.overflowY === "scroll") return parent
    parent = parent.parentElement
  }
}

// Anchors the find bar to the top-left of the timeline's scroll container
// (deliberately opposite find-in-file's top-right placement, so the two
// don't compete for the same corner when both are visible).
export function createSessionFindBarPosition(wrapper: () => HTMLElement | undefined) {
  const [pos, setPos] = createSignal({ top: 8, left: 8 })

  const update = () => {
    const element = wrapper()
    if (!element || typeof window === "undefined") return
    const root = scrollParent(element) ?? element
    const rect = root.getBoundingClientRect()
    const title = parseFloat(getComputedStyle(root).getPropertyValue("--session-title-height"))
    const header = Number.isNaN(title) ? 0 : title

    setPos({
      top: Math.round(rect.top) + header + 4,
      left: Math.round(rect.left) + 8,
    })
  }

  createEffect(() => {
    const element = wrapper()
    if (!element) return
    update()
    makeEventListener(window, "resize", update, { passive: true })
    const root = scrollParent(element) ?? element
    createResizeObserver(root, update)
  })

  return pos
}
