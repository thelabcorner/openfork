export * as ExternalPath from "./external-path"

type Platform = "win32" | "posix"

const defaultPlatform = (): Platform => {
  if (typeof process === "undefined") return "posix"
  return process.platform === "win32" ? "win32" : "posix"
}

const sep = (platform: Platform) => (platform === "win32" ? "\\" : "/")

/**
 * True when the token is shaped like a path outside any project root:
 * Windows drive (`C:`, `C:\`, `C:/Users`), UNC/device (`\\server\share`),
 * POSIX absolute (`/home/...`), or home-relative (`~`, `~/...`).
 * Project-relative tokens return false. Shape-only: existence is not checked.
 */
export function isExternalPathToken(token: string): boolean {
  if (!token) return false
  if (token === "~") return true
  if (token.startsWith("~/") || token.startsWith("~\\")) return true
  if (token.startsWith("\\\\") || token.startsWith("//")) return true
  if (/^[A-Za-z]:$/.test(token)) return true
  if (/^[A-Za-z]:[\\/]/.test(token)) return true
  if (token.startsWith("/")) return true
  return false
}

function splitSegments(rest: string): string[] {
  return rest.split(/[\\/]/).filter((segment) => segment.length > 0)
}

/**
 * Normalize an external-path token: expand `~` when `home` is supplied,
 * rewrite separators to the target platform, collapse duplicates, and strip
 * trailing separators (directory form). Non-external tokens pass through
 * unchanged. Pure: no filesystem access, safe in the browser.
 */
export function normalizeExternalPathToken(
  token: string,
  options?: { home?: string; platform?: Platform },
): string {
  if (!isExternalPathToken(token)) return token
  const platform = options?.platform ?? defaultPlatform()
  const separator = sep(platform)

  let expanded = token
  if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) {
    if (!options?.home) return token
    const rest = token.slice(1).replace(/^[\\/]/, "")
    expanded = rest ? options.home + separator + rest : options.home
  }

  const uncLead = expanded.startsWith("\\\\") || expanded.startsWith("//")
  const driveMatch = expanded.match(/^([A-Za-z]):(?:[\\/](.*))?$/)
  const segments = splitSegments(driveMatch ? (driveMatch[2] ?? "") : expanded)

  if (uncLead) return separator.repeat(2) + segments.join(separator)
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase() + ":"
    if (segments.length === 0) return drive + separator
    return drive + separator + segments.join(separator)
  }
  if (segments.length === 0) return separator
  return separator + segments.join(separator)
}
