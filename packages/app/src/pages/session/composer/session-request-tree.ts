import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"

function indexSessionChildren(session: Session[]) {
  const children = new Map<string, string[]>()
  for (const item of session) {
    if (!item.parentID) continue
    const siblings = children.get(item.parentID)
    if (siblings) siblings.push(item.id)
    else children.set(item.parentID, [item.id])
  }
  return children
}

function sessionTreeRequest<T>(
  session: Session[] | ReadonlyMap<string, string[]>,
  request: Record<string, T[] | undefined>,
  sessionID?: string,
  include: (item: T) => boolean = () => true,
) {
  if (!sessionID) return
  const children = Array.isArray(session) ? indexSessionChildren(session) : session

  // Pending requests are commonly on the tab's own session. Resolve that case
  // without traversing its delegated-worker tree, but retain the original
  // two-phase traversal for sparse/absent descendant requests. Fusing the
  // checks into the BFS was slower in the measured no-request case.
  const own = request[sessionID]
  if (own?.some(include)) return own.find(include)

  const seen = new Set([sessionID])
  const ids = [sessionID]
  for (const id of ids) {
    const list = children.get(id)
    if (!list) continue
    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }
  const id = ids.find((id) => id !== sessionID && request[id]?.some(include))
  if (!id) return
  return request[id]?.find(include)
}

export function sessionPermissionRequest(
  session: Session[] | ReadonlyMap<string, string[]>,
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: PermissionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}

export function sessionQuestionRequest(
  session: Session[] | ReadonlyMap<string, string[]>,
  request: Record<string, QuestionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: QuestionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}
