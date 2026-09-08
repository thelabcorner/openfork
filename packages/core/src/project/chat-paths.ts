import { CHAT_PROJECT_ID, CHAT_PROJECT_NAME } from "./chat"

export { CHAT_PROJECT_ID, CHAT_PROJECT_NAME }

function homeDir(): string {
  try {
    if (typeof process !== "undefined" && process.env) {
      if (process.env.OPENCODE_TEST_HOME) return process.env.OPENCODE_TEST_HOME
      if (process.platform === "win32") {
        return process.env.USERPROFILE || process.env.HOME || process.env.HOMEPATH || "/"
      }
      return process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || "/"
    }
  } catch {
    // Browser context — process may be polyfilled or undefined.
  }
  return "/"
}

function dataDir(): string {
  try {
    if (typeof process !== "undefined" && process.env?.XDG_DATA_HOME) return process.env.XDG_DATA_HOME
  } catch {
    // Browser context — process may be polyfilled or undefined.
  }
  return joinPath(homeDir(), ".local", "share")
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p && p !== ".")
    .join("/")
    .replace(/\/+/g, "/")
}

function comparablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "")
  return typeof process !== "undefined" && process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export const chatsRoot = () => {
  return joinPath(dataDir(), "opencode", "chats")
}

export const isChatDirectoryWithin = (directory: string, rootDirectory: string): boolean => {
  const root = comparablePath(rootDirectory)
  const dir = comparablePath(directory)
  return dir === root || dir.startsWith(root + "/")
}

export const isChatDirectory = (directory: string): boolean => isChatDirectoryWithin(directory, chatsRoot())
