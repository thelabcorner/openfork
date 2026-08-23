import type { Session } from "@opencode-ai/sdk/v2/client"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/server"
import type { LocalProject } from "@/context/layout"
import { displayName, projectForSession } from "@/pages/layout/helpers"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { HomeController } from "./home-controller"
import { homeSessionSearchKey, type HomeSessionRecord, type HomeSessionsController } from "./home-sessions-controller"
import { pathKey } from "@/utils/path-key"
import { splitHighlight, type HighlightSegment } from "./home-search-highlight"
import { searchWithDeadline } from "./home-search-deadline"
import {
  normalizeSessionSearchResponse,
  type SessionSearchMessageMatch,
  type SessionSearchResult,
} from "./home-session-search-response"
import { useSessionGroups } from "@/context/session-groups"

const SEARCH_DEBOUNCE_MS = 200
const SEARCH_CACHE_TTL_MS = 60_000
// Upper bound on a single search round-trip: a slow or blocked server (e.g.
// the FTS backfill holding the DB semaphore) must surface the error card,
// never an eternal skeleton. Within the 5-8s window the task allows.
const SEARCH_TIMEOUT_MS = 15_000
const MAX_SESSION_RESULTS = 8
const MAX_MESSAGE_RESULTS = 24

// Marker reason passed to `controller.abort(...)` when the search deadline
// expires. A no-arg `abort()` (new input, close) and this marker are told
// apart by `signal.reason` identity, so the catch path can drop a timed-out
// search into the error state instead of treating it as an expected
// cancellation. Module-level so the identity is stable across calls.
const SEARCH_TIMEOUT_REASON = new Error("home session search timed out")

type SessionSearchEndpoint = {
  v2: {
    session: {
      search: (
        parameters: { query: string; limit?: string; directory?: string; workspace?: string; project?: string },
        options?: { signal?: AbortSignal },
      ) => Promise<unknown>
    }
  }
}

export type HomeSearchHit =
  | {
      key: string
      kind: "session"
      session: Session
      project: LocalProject
      projectName: string
      groupName?: string
    }
  | {
      key: string
      kind: "message"
      message: SessionSearchMessageMatch
      session: Session
      project: LocalProject
      projectName: string
      groupName?: string
      // Highlight segments precomputed once per result so render does zero work.
      segments: HighlightSegment[]
    }

// Structural surface the search controller actually reads from its host, so
// callers outside home/ can supply a focused adapter instead of a full
// HomeController. HomeController satisfies this as-is.
export type HomeSessionSearchHost = {
  project: Pick<HomeController["project"], "list" | "selected">
  server: Pick<HomeController["server"], "list" | "focused" | "focusedContext">
}

type HomeSessionSearchSource = {
  session: Pick<HomeSessionsController["session"], "open">
}

export function createHomeSessionSearchController(
  home: HomeSessionSearchHost,
  sessions: HomeSessionSearchSource,
  options?: { registerFocusCommand?: boolean },
) {
  const command = useCommand()
  const language = useLanguage()
  const sessionGroups = useSessionGroups()
  const [state, setState] = createStore({
    value: "",
    focused: false,
    highlighted: "",
    loading: false,
    error: undefined as string | undefined,
    sessions: [] as Session[],
    messages: [] as SessionSearchMessageMatch[],
  })
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let requestID = 0
  let inFlight: AbortController | undefined
  const cache = new Map<string, { at: number; result: SessionSearchResult }>()

  const query = createMemo(() => state.value.trim())
  const projectByID = createMemo(
    () => new Map(home.project.list().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )

  // Build a map from session ID to group name for search result enrichment
  const sessionGroupMap = createMemo(() => {
    const map = new Map<string, string>()
    for (const group of sessionGroups.list()) {
      for (const sessionId of group.sessionIds) {
        map.set(sessionId, group.name)
      }
    }
    return map
  })

  const hits = createMemo(() => {
    const sessionsHit: HomeSearchHit[] = state.sessions.map((session) => {
      const project = projectFor(session)
      return {
        key: homeSessionSearchKey({ session, project, projectName: "" }),
        kind: "session" as const,
        session,
        project,
        projectName: displayName(project),
        groupName: sessionGroupMap().get(session.id),
      }
    })
    const messagesHit: HomeSearchHit[] = state.messages.map((message) => {
      const session = sessionFromMessageMatch(message)
      const project = projectFor(session)
      return {
        key: `${pathKey(message.directory)}:${message.sessionID}:${message.messageID}`,
        kind: "message" as const,
        message,
        session,
        project,
        projectName: displayName(project),
        groupName: sessionGroupMap().get(message.sessionID),
        segments: splitHighlight(message.snippet, message.matchedTerms),
      }
    })
    return [...sessionsHit, ...messagesHit]
  })
  const active = createMemo(() => {
    if (hits().some((hit) => hit.key === state.highlighted)) return state.highlighted
    return hits()[0]?.key ?? ""
  })
  const open = createMemo(() => state.focused && query().length > 0)
  const placeholder = createMemo(() => {
    const project = home.project.selected()
    if (project) return language.t("home.sessions.search.placeholder.scoped", { scope: displayName(project) })
    if (home.server.list().length > 1) {
      const conn = home.server.focused()
      if (conn) return language.t("home.sessions.search.placeholder.scoped", { scope: serverName(conn) })
    }
    return language.t("home.sessions.search.placeholder")
  })

  function projectFor(session: Session) {
    const directory = sessionDirectory(session)
    const direct = projectByID().get(session.projectID)
    if (direct) return direct
    if (!directory) return home.project.selected() ?? home.project.list()[0] ?? { worktree: "", expanded: false }
    const key = pathKey(directory)
    const project =
      home.project
        .list()
        .find(
          (item) =>
            pathKey(item.worktree) === key ||
            item.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
        ) ?? projectForSession({ ...session, directory }, home.project.list(), projectByID())
    return project ?? { worktree: directory, expanded: false }
  }

  function abortInFlight() {
    inFlight?.abort()
    inFlight = undefined
  }

  // Zero idle cost: this effect only ever runs while the search box is open,
  // and it only schedules a debounced fetch — no network, no timers otherwise.
  createEffect(() => {
    if (!state.focused) return
    const value = query()
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = undefined
    if (!value) {
      abortInFlight()
      return
    }
    abortInFlight()
    const id = ++requestID
    setState({ loading: true, error: undefined })
    debounce = setTimeout(() => void runSearch(value, id), SEARCH_DEBOUNCE_MS)
  })

  onCleanup(() => {
    if (debounce !== undefined) clearTimeout(debounce)
    abortInFlight()
    requestID++
  })

  onCleanup(
    makeEventListener(document, "pointerdown", (event) => {
      if (!open()) return
      const target = event.target
      if (!(target instanceof Node) || root?.contains(target)) return
      close()
    }),
  )

  // Off for non-home hosts: the hidden mod+f focus command would collide with
  // whichever command owns mod+f on that surface (e.g. session.find).
  if (options?.registerFocusCommand !== false) {
    command.register("home.search", () => [
      {
        id: "home.sessions.search.focus",
        title: placeholder(),
        keybind: "mod+f",
        hidden: true,
        onSelect: focus,
      },
    ])
  }

  async function runSearch(value: string, id: number) {
    const ctx = home.server.focusedContext()
    const project = home.project.selected()
    const conn = home.server.focused()
    const cacheKey = `${conn ? ServerConnection.key(conn) : ""}\0${project?.worktree ?? ""}\0${value}`
    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
      applyResult(cached.result, id)
      return
    }
    abortInFlight()
    const controller = new AbortController()
    inFlight = controller
    const startedAt = performance.now()
    try {
      const outcome = await searchWithDeadline(controller, SEARCH_TIMEOUT_MS, SEARCH_TIMEOUT_REASON, (signal) =>
        searchEndpoint(ctx?.sdk.client, value, signal, project),
      )
      if (outcome.kind === "user") return
      if (id !== requestID || !open()) return
      const elapsedMs = Math.round(performance.now() - startedAt)
      if (outcome.kind === "timeout") {
        // Deadline hit on the current query: the user sees the error card,
        // not an eternal skeleton. Nothing is cached, so a later identical
        // query retries cleanly.
        console.warn("[home-search] session search timed out", {
          elapsedMs,
          timeoutMs: SEARCH_TIMEOUT_MS,
          queryLength: value.length,
          scopedDirectory: project?.worktree,
        })
        setState({ loading: false, error: `Timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1_000)}s.` })
        return
      }
      if (elapsedMs > 1_000) {
        console.info("[home-search] session search completed slowly", {
          elapsedMs,
          queryLength: value.length,
          scopedDirectory: project?.worktree,
          titleMatches: outcome.value.titleMatches.length,
          messageMatches: outcome.value.messageMatches.length,
        })
      }
      cache.set(cacheKey, { at: Date.now(), result: outcome.value })
      applyResult(outcome.value, id)
    } catch (cause) {
      if (id !== requestID || !open()) return
      const elapsedMs = Math.round(performance.now() - startedAt)
      console.error("[home-search] session search failed", {
        elapsedMs,
        queryLength: value.length,
        scopedDirectory: project?.worktree,
        cause,
      })
      setState({ loading: false, error: `${describeSearchError(cause)} (${elapsedMs}ms)` })
    } finally {
      if (inFlight === controller) inFlight = undefined
    }
  }

  function applyResult(result: SessionSearchResult, id: number) {
    if (id !== requestID || !open()) return
    setState({
      loading: false,
      error: undefined,
      sessions: result.titleMatches.flatMap((session) => {
        const directory = sessionDirectory(session)
        if (!directory) return []
        return [{ ...session, directory } as Session]
      }).slice(0, MAX_SESSION_RESULTS),
      messages: dedupeMessages(result.messageMatches.filter((match) => !!match.directory)).slice(0, MAX_MESSAGE_RESULTS),
      highlighted: "",
    })
  }

  function focus() {
    input?.focus()
    setState("focused", true)
  }

  function close() {
    requestID++
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = undefined
    abortInFlight()
    setState({
      value: "",
      focused: false,
      highlighted: "",
      loading: false,
      error: undefined,
      sessions: [],
      messages: [],
    })
  }

  function select(hit: HomeSearchHit, options?: { background?: boolean }) {
    const record: HomeSessionRecord = {
      session: hit.session,
      project: hit.project,
      projectName: hit.projectName,
    }
    sessions.session.open(record.session, options)
    if (!options?.background) close()
  }

  return {
    query: {
      value: () => state.value,
      placeholder,
      open,
      focus,
      input: (value: string) => setState({ value, highlighted: "" }),
      close,
    },
    result: {
      loading: () => state.loading,
      error: () => state.error,
      sessions: () => state.sessions,
      messages: () => state.messages,
      list: hits,
      active,
      noResultsLabel: () => language.t("home.sessions.search.results.empty", { query: query() }),
      highlight: (hit: HomeSearchHit) => setState("highlighted", hit.key),
      move: (delta: number) => {
        const options = hits()
        if (options.length === 0) return
        const index = options.findIndex((hit) => hit.key === active())
        const next = ((index === -1 ? 0 : index) + delta + options.length) % options.length
        setState("highlighted", options[next].key)
        list?.querySelector<HTMLElement>(`[data-key="${state.highlighted}"]`)?.scrollIntoView({ block: "nearest" })
      },
      select,
      selectActive: () => {
        const hit = hits().find((item) => item.key === active())
        if (hit) select(hit)
      },
    },
    element: {
      setRoot: (element: HTMLDivElement) => (root = element),
      setInput: (element: HTMLInputElement) => (input = element),
      setList: (element: HTMLDivElement) => (list = element),
    },
  }
}

// Single reconcile seam for the new endpoint: `client.v2.session.search`.
// Contract: GET /api/session/search,
// `client.v2.session.search({ query, limit?, directory?, workspace?, project? })`.
function searchEndpoint(
  client: unknown,
  query: string,
  signal: AbortSignal,
  project: { worktree: string } | undefined,
): Promise<SessionSearchResult> {
  if (!client) return Promise.resolve({ titleMatches: [], messageMatches: [] })
  return (client as SessionSearchEndpoint).v2.session
    .search(
      {
        query,
        limit: String(MAX_SESSION_RESULTS + MAX_MESSAGE_RESULTS),
        ...(project ? { directory: project.worktree } : {}),
      },
      { signal },
    )
    .then(normalizeSessionSearchResponse)
}

// One session may surface multiple message hits (BM25-ranked, highest first);
// collapse to the best (first) hit per session so the list stays scannable.
function dedupeMessages(matches: SessionSearchMessageMatch[]) {
  const seen = new Set<string>()
  return matches.filter((match) => {
    if (seen.has(match.sessionID)) return false
    seen.add(match.sessionID)
    return true
  })
}

function describeSearchError(cause: unknown) {
  if (cause instanceof Error) return cause.message || cause.name
  if (typeof cause === "string") return cause
  if (typeof cause !== "object" || cause === null) return "Unknown search error."
  const record = cause as Record<string, unknown>
  const status = typeof record.status === "number" ? `HTTP ${record.status}` : undefined
  const message = typeof record.message === "string" ? record.message : undefined
  return [status, message].filter(Boolean).join(": ") || "Unknown search error."
}

function sessionDirectory(session: Session) {
  const record = session as unknown as { directory?: unknown; location?: { directory?: unknown } }
  if (typeof record.directory === "string" && record.directory) return record.directory
  if (typeof record.location?.directory === "string" && record.location.directory) return record.location.directory
  return undefined
}

function sessionFromMessageMatch(match: SessionSearchMessageMatch): Session {
  return {
    id: match.sessionID,
    slug: match.sessionID,
    projectID: match.projectID,
    directory: match.directory,
    title: match.sessionTitle,
    version: "",
    time: { created: match.time.created, updated: match.time.created },
  }
}

export type HomeSessionSearchController = ReturnType<typeof createHomeSessionSearchController>
