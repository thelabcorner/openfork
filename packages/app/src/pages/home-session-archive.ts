import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import type { GlobalSession, Session } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

type HomeSession = {
  id: string
  directory: string
}

export async function archiveHomeSession(input: {
  server: ServerConnection.Key
  session: HomeSession
  archive: (sessionID: string) => Promise<unknown>
  remove: () => void
  onError?: (error: unknown) => void
}) {
  await input
    .archive(input.session.id)
    .then(() => {
      input.remove()
      notifySessionTabsRemoved({
        server: input.server,
        directory: input.session.directory,
        sessionIDs: [input.session.id],
      })
    })
    .catch((error) => input.onError?.(error))
}

// Unarchive clears `time.archived` (null on the wire); the session returns to
// the active list via the live session.updated event.
export async function unarchiveHomeSession(input: {
  session: HomeSession
  unarchive: (sessionID: string) => Promise<unknown>
  onError?: (error: unknown) => void
}) {
  await input.unarchive(input.session.id).catch((error) => input.onError?.(error))
}

export const HOME_ARCHIVED_PAGE_LIMIT = 30

export type HomeArchivedPage = {
  sessions: Session[]
  cursor?: number
}

export async function loadArchivedHomeSessions(input: {
  list: (
    query: { archived: true; roots: true; limit: number; cursor?: number },
    options: { signal?: AbortSignal },
  ) => Promise<{ data?: GlobalSession[]; response: Response }>
  cursor?: number
  signal?: AbortSignal
}): Promise<HomeArchivedPage> {
  const response = await input.list(
    {
      archived: true,
      roots: true,
      limit: HOME_ARCHIVED_PAGE_LIMIT,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
    { signal: input.signal },
  )
  // With `archived` set the endpoint only drops its archive exclusion — it
  // does not filter TO archived — so trim non-archived rows client-side.
  const sessions = (response.data ?? [])
    .filter((item) => typeof item.time.archived === "number")
    .map(archivedSessionSummary)
  const next = response.response.headers.get("x-next-cursor")
  return { sessions, ...(next === null ? {} : { cursor: Number(next) }) }
}

function archivedSessionSummary(session: GlobalSession): Session {
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    workspaceID: session.workspaceID,
    directory: session.directory,
    path: session.path,
    parentID: session.parentID,
    cost: session.cost,
    tokens: session.tokens,
    title: session.title,
    agent: session.agent,
    model: session.model && {
      id: session.model.id,
      providerID: session.model.providerID,
      variant: session.model.variant,
    },
    version: session.version,
    time: session.time,
  }
}
