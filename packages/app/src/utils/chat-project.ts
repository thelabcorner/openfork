import { CHAT_PROJECT_ID } from "@opencode-ai/core/project/chat"
import { pathKey } from "@/utils/path-key"

export type ChatProjectLike = {
  id?: string
  worktree: string
  name?: string
}

export function findChatProject<T extends ChatProjectLike>(projects: readonly T[]): T | undefined {
  return projects.find((project) => project.id === CHAT_PROJECT_ID)
}

export function isReservedChatProjectPath(directory: string) {
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  return ["/.local/share/openfork/chats", "/.local/share/opencode/chats"].some(
    (suffix) => normalized === suffix || normalized.endsWith(suffix),
  )
}

/**
 * Matches both the canonical server-owned Chat project and the legacy browser
 * faux-project (`/.local/share/opencode/chats`) that was persisted before the
 * renderer tried to derive HOME itself. This is intentionally narrow to the
 * OpenFork chats directory plus that one legacy migration alias.
 */
export function isChatProjectAlias(project: ChatProjectLike, canonical: ChatProjectLike): boolean {
  if (project.id === CHAT_PROJECT_ID) return true
  if (pathKey(project.worktree) === pathKey(canonical.worktree)) return true
  return isReservedChatProjectPath(project.worktree) && isReservedChatProjectPath(canonical.worktree)
}

export function chatProjectKey(project: ChatProjectLike | undefined): string | undefined {
  if (!project) return undefined
  return pathKey(project.worktree)
}
