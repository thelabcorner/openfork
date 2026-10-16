export type PathKey = string & { _brand: "PathKey" }

/** Workspace API calls require an explicit absolute location. `global` is a
 * server event-stream sentinel, never a workspace directory. */
export function isAbsoluteWorkspaceDirectory(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value === "global") return false
  if (value.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  return /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value)
}

const isDrive = (value: string) => {
  if (value.length !== 2) return false
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

export const pathKey = (path: string | undefined) => {
  // Sync-store sessions can lack `directory`; callers compare keys rather than
  // consume them, so missing input maps to "" instead of crashing on .length.
  if (!path) return "" as PathKey
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  const trimmed = trimTrailingSlashes(value)
  if (!trimmed && value.startsWith("/")) return "/" as PathKey
  if (isDrive(trimmed)) return `${trimmed}/` as PathKey
  return trimmed as PathKey
}
