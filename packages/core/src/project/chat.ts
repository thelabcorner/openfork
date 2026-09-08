export const CHAT_PROJECT_ID = "chats" as const
export const CHAT_PROJECT_NAME = "Chat" as const

/**
 * Browser-safe identity check for OpenCode's built-in projectless chat
 * workspace. Filesystem discovery intentionally lives in chat-paths.ts: the
 * canonical path is server-owned and must never be reconstructed by a client.
 */
export function isChatProject(project: { id?: string } | undefined): boolean {
  return project?.id === CHAT_PROJECT_ID
}
