import { base64Encode } from "@opencode-ai/core/util/encode"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

export function projectAutoAcceptPolicy(autoAccept: Record<string, boolean>, directory: string) {
  const prefix = `${base64Encode(directory)}/`
  const result: Record<string, boolean> = {}
  const directoryValue = autoAccept[directoryAcceptKey(directory)]
  if (directoryValue !== undefined) result["*"] = directoryValue
  for (const [key, value] of Object.entries(autoAccept)) {
    if (!key.startsWith(prefix)) continue
    const sessionID = key.slice(prefix.length)
    if (sessionID && sessionID !== "*") result[sessionID] = value
  }
  return result
}

export function enqueuePolicyUpdate(
  queue: Map<string, Promise<boolean>>,
  directory: string,
  update: () => Promise<boolean>,
  maxLocations = 2048,
) {
  const existing = queue.get(directory)
  if (!existing && queue.size >= maxLocations) return Promise.resolve(false)
  const previous = existing ?? Promise.resolve(true)
  let request!: Promise<boolean>
  request = previous.catch(() => false).then(update).finally(() => {
    if (queue.get(directory) === request) queue.delete(directory)
  })
  queue.delete(directory)
  queue.set(directory, request)
  return request
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return autoAccept[key] ?? autoAccept[sessionID]
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

/**
 * Tri-state read of an explicit directory-wide choice. Unlike
 * `isDirectoryAutoAccepting`, `undefined` means the directory has never been
 * toggled, so a new-session default may apply; `false` is an explicit choice
 * and must win over that default.
 */
export function directoryAutoAccept(autoAccept: Record<string, boolean>, directory: string) {
  return autoAccept[directoryAcceptKey(directory)]
}

/**
 * Effective auto-accept for a session that does not exist yet.
 *
 * Precedence: an explicit directory-wide choice (respect an established
 * project decision) then the configured new-session preference. Per-session
 * state cannot exist here; once the session is created the permission service
 * materializes this value as an explicit per-session key, so later default
 * changes or directory changes cannot silently rewrite it.
 */
export function resolveNewSessionAutoAccept(
  autoAccept: Record<string, boolean>,
  directory: string | undefined,
  preference: boolean,
) {
  if (!directory) return preference
  return directoryAutoAccept(autoAccept, directory) ?? preference
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
}
