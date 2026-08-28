function homeDir(): string {
  try {
    if (typeof process !== "undefined" && process.env) {
      return process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || "/"
    }
  } catch {
    // Browser context — process may be polyfilled or undefined.
  }
  return "/"
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p && p !== ".")
    .join("/")
    .replace(/\/+/g, "/")
}

export const chatsRoot = () => {
  return joinPath(homeDir(), ".local", "share", "opencode", "chats")
}

export const isChatDirectory = (directory: string): boolean => {
  const root = chatsRoot().toLowerCase()
  const dir = directory.toLowerCase()
  return dir === root || (dir.startsWith(root + "/") && dir !== root)
}
