import type { Session } from "@opencode-ai/sdk/v2/client"
import { isAbsoluteWorkspaceDirectory, pathKey } from "@/utils/path-key"

type SessionMetadataOwner = {
  get(sessionID: string): Session | undefined
  resolve(sessionID: string, options?: { priority?: "background" | "interactive" | "critical" }): Promise<Session>
}

/** Resolve notification metadata through the server-scoped Session owner.
 * Event-stream `global` is a routing sentinel, never a workspace directory.
 * This intentionally reads only Session metadata; notification badges must
 * not create a directory child or hydrate message history. */
export async function resolveNotificationSession(
  owner: SessionMetadataOwner,
  eventDirectory: string,
  sessionID: string | undefined,
): Promise<Session | undefined> {
  if (!sessionID) return
  const cached = owner.get(sessionID)
  if (
    cached &&
    isAbsoluteWorkspaceDirectory(cached.directory) &&
    (eventDirectory === "global" || pathKey(cached.directory) === pathKey(eventDirectory))
  )
    return cached

  if (eventDirectory !== "global" && !isAbsoluteWorkspaceDirectory(eventDirectory)) return
  try {
    const session = await owner.resolve(sessionID, { priority: "background" })
    if (!isAbsoluteWorkspaceDirectory(session.directory)) return
    if (eventDirectory !== "global" && pathKey(session.directory) !== pathKey(eventDirectory)) return
    return session
  } catch {
    return
  }
}
