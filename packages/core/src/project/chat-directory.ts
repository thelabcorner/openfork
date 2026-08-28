import { chatsRoot } from "./chat-paths"
import path from "path"
import fs from "fs/promises"

export async function generateChatSessionDirectory(): Promise<string> {
  const root = chatsRoot()
  await fs.mkdir(root, { recursive: true })
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  const dir = path.join(root, `${timestamp}-${random}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}
