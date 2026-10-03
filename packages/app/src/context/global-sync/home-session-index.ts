import type { Event, Session, SessionV2Info, V2SessionListResponse } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { trimSessions } from "./session-trim"
import { pathKey } from "@/utils/path-key"

export const HOME_V2_SESSION_FIRST_PAGE = 256
export const HOME_V2_SESSION_PAGE_LIMIT = 5_000
export const HOME_SESSION_EVENT_OVERLAY_LIMIT = 512

export type HomeSessionEvent = {
  type: "session.created" | "session.updated" | "session.deleted"
  properties: { sessionID: string; info: Session }
} | {
  type: "session.renamed"
  properties: { sessionID: string; title: string; updated: number }
}
export type HomeSessionEvents = {
  sequence: number
  entries: Array<{ sequence: number; event: HomeSessionEvent }>
  overflowed?: boolean
}
export type HomeSessionIndex = {
  sessions: Session[]
  eventSequence: number
}

export const homeSessionIndexKey = (server: string) => ["home", "session-index", server] as const
export const homeSessionEventsKey = (server: string) => ["home", "session-events", server] as const

type HomeSessionPage = { data?: V2SessionListResponse }

export async function loadHomeSessionIndex(
  list: (
    input: { limit: number; order: "desc"; cursor?: string },
    options: { signal?: AbortSignal },
  ) => Promise<HomeSessionPage>,
  eventSequence = 0,
  signal?: AbortSignal,
) {
  // Max retain: HOME_SESSION_LIMIT (64) per directory, but we don't know
  // directory count here. Start with a deliberately small 256-row probe, then
  // fetch at most one 5k continuation page. Early-exit once the parsed index is
  // already large enough that further background scanning is unlikely to
  // improve the retained Home view. This keeps Home discovery from competing
  // with active session routes on very large databases.
  const SOFT_CAP = 2_000
  const data: SessionV2Info[] = []
  let cursor: string | undefined
  let pages = 0

  for (;;) {
    const limit = pages === 0 ? HOME_V2_SESSION_FIRST_PAGE : HOME_V2_SESSION_PAGE_LIMIT
    const response = await list(
      {
        limit,
        order: "desc",
        ...(cursor ? { cursor } : {}),
      },
      { signal },
    )
    const page = response.data!
    data.push(...page.data)
    pages++
    const sessions = parseHomeSessionIndex(data)
    if (sessions.length >= SOFT_CAP) return { sessions, eventSequence }
    if (page.data.length < limit || !page.cursor.next || pages >= 2) return { sessions, eventSequence }
    cursor = page.cursor.next
  }
}

export function appendHomeSessionEvent(current: HomeSessionEvents | undefined, event: HomeSessionEvent) {
  const sequence = (current?.sequence ?? 0) + 1
  if (current?.overflowed) return { sequence, entries: current.entries, overflowed: true }
  if ((current?.entries.length ?? 0) >= HOME_SESSION_EVENT_OVERLAY_LIMIT) {
    return { sequence, entries: [], overflowed: true }
  }
  return {
    sequence,
    entries: [...(current?.entries ?? []), { sequence, event }],
  }
}

export function trimHomeSessionEvents(current: HomeSessionEvents | undefined, sequence: number): HomeSessionEvents {
  return {
    sequence: current?.sequence ?? sequence,
    entries: (current?.entries ?? []).filter((entry) => entry.sequence > sequence),
  }
}

export function homeSessionIndexSessions(index: HomeSessionIndex | undefined, events: HomeSessionEvents | undefined) {
  if (!index) return []
  return (events?.entries ?? [])
    .filter((entry) => entry.sequence > index.eventSequence)
    .reduce((sessions, entry) => applyHomeSessionEvent(sessions, entry.event), index.sessions)
}

export function homeSessionIndexRefresh(event: Event["type"], connected: boolean, repair = false) {
  if (event === "server.connected") return { connected: true, refetch: repair }
  return {
    connected,
    refetch: event === "global.disposed" || event === "session.next.moved",
  }
}

export function homeSessionIndexRefreshRelevant(event: Event["type"]) {
  return event === "server.connected" || event === "global.disposed" || event === "session.next.moved"
}

export function createHomeSessionIndexCache(queryClient: QueryClient, server: string) {
  const indexKey = homeSessionIndexKey(server)
  const eventsKey = homeSessionEventsKey(server)
  let connected = false
  const removed = new Set<string>()

  return {
    indexKey,
    eventsKey,
    eventSequence() {
      return queryClient.getQueryData<HomeSessionEvents>(eventsKey)?.sequence ?? 0
    },
    complete(sequence: number, snapshot?: readonly Session[]) {
      // Keep post-start events and release optimistic removals once the snapshot
      // or a later event proves that an older fetch can no longer resurrect them.
      const current = queryClient.getQueryData<HomeSessionEvents>(eventsKey)
      if (snapshot) {
        const present = new Set(snapshot.map((session) => session.id))
        for (const sessionID of removed) {
          if (!present.has(sessionID)) removed.delete(sessionID)
        }
      }
      if (!current?.overflowed) {
        for (const entry of current?.entries ?? []) {
          if (entry.sequence <= sequence) continue
          const event = entry.event
          const archived = event.type === "session.updated" && typeof event.properties.info.time.archived === "number"
          if (event.type === "session.deleted" || archived) removed.delete(event.properties.sessionID)
        }
      }
      queryClient.setQueryData<HomeSessionEvents>(
        eventsKey,
        current?.overflowed ? current : trimHomeSessionEvents(current, sequence),
      )
    },
    claimOverflowRepair() {
      const current = queryClient.getQueryData<HomeSessionEvents>(eventsKey)
      if (!current?.overflowed) return false
      queryClient.setQueryData<HomeSessionEvents>(eventsKey, {
        sequence: current.sequence,
        entries: [],
      })
      return true
    },
    sessions(index: HomeSessionIndex | undefined, events: HomeSessionEvents | undefined) {
      const sessions = homeSessionIndexSessions(index, events)
      return removed.size === 0 ? sessions : sessions.filter((session) => !removed.has(session.id))
    },
    live() {
      const query = queryClient.getQueryCache().find({ queryKey: indexKey, exact: true })
      return !!query && query.getObserversCount() > 0
    },
    apply(event: HomeSessionEvent) {
      // `remove()` may keep a tombstone while an older index fetch is in flight.
      // Any authoritative delete/archive/restore event supersedes that guard.
      const archived = event.type === "session.updated" && typeof event.properties.info.time.archived === "number"
      const restored =
        (event.type === "session.created" || event.type === "session.updated") &&
        !event.properties.info.parentID &&
        typeof event.properties.info.time.archived !== "number"
      if (event.type === "session.deleted" || archived || restored) {
        removed.delete(event.properties.sessionID)
      }
      if (!queryClient.getQueryState(indexKey)) return
      const current = queryClient.getQueryData<HomeSessionEvents>(eventsKey)
      const next = appendHomeSessionEvent(current, event)
      if (queryClient.isFetching({ queryKey: indexKey, exact: true }) > 0 || next.overflowed) {
        queryClient.setQueryData(eventsKey, next)
        // Overflow is a one-shot repair signal. Re-invalidating on every later
        // event while the snapshot is slow can repeatedly cancel/restart the
        // same per-directory fetch under a burst of session updates.
        if (next.overflowed && !current?.overflowed)
          void queryClient.invalidateQueries({ queryKey: indexKey, exact: true })
        return
      }

      const index = queryClient.getQueryData<HomeSessionIndex>(indexKey)
      if (index) {
        queryClient.setQueryData<HomeSessionIndex>(indexKey, {
          sessions: applyHomeSessionEvent(index.sessions, event),
          eventSequence: next.sequence,
        })
      }
      queryClient.setQueryData<HomeSessionEvents>(eventsKey, { sequence: next.sequence, entries: [] })
    },
    remove(sessionID: string) {
      if (!queryClient.getQueryState(indexKey)) return
      const current = queryClient.getQueryData<HomeSessionEvents>(eventsKey)
      const eventAlreadyRemoves = (current?.entries ?? []).some(({ event }) => {
        if (event.properties.sessionID !== sessionID) return false
        return event.type === "session.deleted" ||
          (event.type === "session.updated" && typeof event.properties.info.time.archived === "number")
      })
      // Retain an ID only when an older in-flight snapshot could reinsert it.
      // Bound this guard; crossing the cap requests a fresh authoritative index.
      if (queryClient.isFetching({ queryKey: indexKey, exact: true }) > 0 && !eventAlreadyRemoves) {
        if (removed.size < HOME_SESSION_EVENT_OVERLAY_LIMIT) {
          removed.add(sessionID)
        } else if (!current?.overflowed) {
          queryClient.setQueryData<HomeSessionEvents>(eventsKey, {
            sequence: current?.sequence ?? 0,
            entries: [],
            overflowed: true,
          })
          void queryClient.invalidateQueries({ queryKey: indexKey, exact: true })
        }
      }
      queryClient.setQueryData<HomeSessionIndex>(indexKey, (index) => {
        if (!index) return index
        const at = index.sessions.findIndex((session) => session.id === sessionID)
        if (at === -1) return index
        return { ...index, sessions: index.sessions.toSpliced(at, 1) }
      })
    },
    refresh(event: Event["type"], repair = false) {
      const result = homeSessionIndexRefresh(event, connected, repair)
      connected = result.connected
      const sessionChange =
        event === "session.created" || event === "session.updated" || event === "session.deleted"
      // Live Home consumers receive the event through apply(). If Home has no
      // observer, preserve a stale marker so its next mount cannot trust an
      // index that missed session changes while it was unmounted.
      if (sessionChange && this.live()) return
      if (!result.refetch && !sessionChange) return
      void queryClient.invalidateQueries({ queryKey: indexKey, exact: true })
    },
  }
}

// Legacy V2 list adapter retained for callers that need to reconstruct a Home
// index from the current list API. Desktop Home uses the Tier 1 global
// `sessionRoots` projection per explicit directory; do not use this full-scan
// adapter for dense navigation surfaces.
export function parseHomeSessionIndex(sessions: SessionV2Info[]): Session[] {
  return sessions.flatMap((item) => {
    if (item.parentID || typeof item.time.archived === "number") return []
    return [toLegacySummary(item)]
  })
}

export function retainHomeSessions(sessions: Session[], limit: number, now: number) {
  const grouped = Map.groupBy(sessions, (session) => pathKey(session.directory))
  return [...grouped.values()].flatMap((items) => trimSessions(items, { limit, permission: {}, now }))
}

export function applyHomeSessionEvent(sessions: Session[], event: HomeSessionEvent) {
  if (event.type === "session.renamed") {
    const index = sessions.findIndex((session) => session.id === event.properties.sessionID)
    if (index === -1) return sessions
    const current = sessions[index]
    return sessions.with(index, {
      ...current,
      title: event.properties.title,
      time: { ...current.time, updated: event.properties.updated },
    })
  }
  const info = event.properties.info
  const index = sessions.findIndex((session) => session.id === info.id)
  if (event.type === "session.deleted" || info.parentID || typeof info.time.archived === "number") {
    if (index === -1) return sessions
    return sessions.toSpliced(index, 1)
  }
  if (event.type !== "session.created" && event.type !== "session.updated") return sessions
  if (index === -1) return [...sessions, info]
  return sessions.with(index, info)
}

function toLegacySummary(session: SessionV2Info): Session {
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    workspaceID: session.location.workspaceID,
    directory: session.location.directory,
    path: session.subpath,
    parentID: session.parentID,
    cost: session.cost,
    tokens: session.tokens,
    title: session.title,
    agent: session.agent,
    model: session.model,
    version: "",
    time: session.time,
  }
}
