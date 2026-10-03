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

  const id = ids.find((id) => request[id]?.some(include))
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
