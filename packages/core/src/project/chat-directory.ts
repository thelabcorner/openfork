import { chatsRoot } from "./chat-paths"
import { KeyedMutex } from "../effect/keyed-mutex"
import path from "path"
import fs from "fs/promises"

/**
 * Process-wide serialization for lifecycle transitions that can create or
 * reclaim the same Chat scratch directory. Session create/delete and
 * control-plane moves share this mutex, preventing a final-reference cleanup
 * from racing a fork/child creation or a move into the same directory.
 */
export const chatSessionDirectoryMutex = KeyedMutex.makeUnsafe<string>()

function resolved(value: string): string {
  return path.resolve(value)
}

/**
 * A managed Chat scratch directory is exactly one directory beneath the Chat
 * project root. Keeping this predicate intentionally strict prevents cleanup
 * code from ever deleting the root itself or an arbitrary nested/outside path.
 */
export function isChatSessionDirectory(directory: string, rootDirectory = chatsRoot()): boolean {
  const root = resolved(rootDirectory)
  const target = resolved(directory)
  const relative = path.relative(root, target)
  if (!relative || relative === ".") return false
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
  return !relative.includes(path.sep)
}

export function chatSessionDirectoryKey(directory: string, rootDirectory = chatsRoot()): string | undefined {
  if (!isChatSessionDirectory(directory, rootDirectory)) return undefined
  const value = resolved(directory)
  return process.platform === "win32" ? value.toLowerCase() : value
}

export async function ensureChatSessionDirectory(directory: string, rootDirectory = chatsRoot()): Promise<boolean> {
  if (!isChatSessionDirectory(directory, rootDirectory)) return false
  await fs.mkdir(directory, { recursive: true })
  return true
}

export async function removeChatSessionDirectory(directory: string, rootDirectory = chatsRoot()): Promise<boolean> {
  if (!isChatSessionDirectory(directory, rootDirectory)) return false
  await fs.rm(directory, { recursive: true, force: true })
  return true
}

export async function generateChatSessionDirectory(root = chatsRoot()): Promise<string> {
  await fs.mkdir(root, { recursive: true })
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  const dir = path.join(root, `${timestamp}-${random}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}
