import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { sessionStatusIsWorking } from "@/utils/session-status"
import type { ChatSidebarRowState } from "./chat-sidebar-tree"

/**
 * Project the server-owned sparse status/permission maps and the notification
 * owner's sparse unread index into one semantic navigation index. An idle
 * session is absent, so 10,000 idle roots never need individual reactive reads.
 * Precedence matches the existing rowState: attention > error > working >
 * unread > idle. This is a DERIVED, disposable read-only view, not a second
 * lifecycle authority or a per-session subscription layer.
 */
export function indexChatSidebarRowStates<Permission>(input: {
  statuses: Readonly<Record<string, SessionStatus | undefined>>
  paused: Readonly<Record<string, boolean | undefined>>
  questions: Readonly<Record<string, readonly unknown[] | undefined>>
  permissions: Readonly<Record<string, readonly Permission[] | undefined>>
  unseenCounts: Readonly<Record<string, number | undefined>>
  unseenErrors: Readonly<Record<string, boolean | undefined>>
  directoryByID: ReadonlyMap<string, string>
  autoResponds: (permission: Permission, directory: string) => boolean
}): ReadonlyMap<string, ChatSidebarRowState> {
  const states = new Map<string, ChatSidebarRowState>()
  for (const [id, count] of Object.entries(input.unseenCounts)) {
    if (count && count > 0) states.set(id, "unread")
  }
  for (const [id, status] of Object.entries(input.statuses)) {
    if (sessionStatusIsWorking(status?.type) && input.paused[id] !== true) states.set(id, "working")
  }
  for (const [id, error] of Object.entries(input.unseenErrors)) {
    if (error) states.set(id, "error")
  }
  for (const [id, questions] of Object.entries(input.questions)) {
    if (questions?.length) states.set(id, "attention")
  }
  for (const [id, permissions] of Object.entries(input.permissions)) {
    if (!permissions?.length || states.get(id) === "attention") continue
    const directory = input.directoryByID.get(id) ?? ""
    for (const permission of permissions) {
      if (input.autoResponds(permission, directory)) continue
      states.set(id, "attention")
      break
    }
  }
  return states
}

/** Suppress section rebuilds when sparse owner data changed without changing
 * any semantic status (e.g. retry attempt metadata or notification timestamps).
 */
export function sameChatSidebarRowStateIndex(
  a: ReadonlyMap<string, ChatSidebarRowState>,
  b: ReadonlyMap<string, ChatSidebarRowState>,
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, state] of a) if (b.get(id) !== state) return false
  return true
}