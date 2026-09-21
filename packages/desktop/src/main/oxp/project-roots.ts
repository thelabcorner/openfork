import path from "node:path"

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/

/**
 * Normalize project roots only when they are already expressed in the desktop
 * host's filesystem namespace. Never reinterpret a foreign mount spelling
 * (for example /mnt/e/... on Windows) as a host-native path.
 */
export function normalizeProjectRootsForHost(
  candidates: readonly string[],
  platform: NodeJS.Platform = process.platform,
) {
  const windows = platform === "win32"
  const pathImpl = windows ? path.win32 : path.posix
  const roots = new Map<string, string>()
  let rejected = 0

  for (const candidate of candidates) {
    if (!candidate || candidate.includes("\0")) {
      rejected += 1
      continue
    }
    const native = windows ? WINDOWS_DRIVE_ABSOLUTE.test(candidate) : path.posix.isAbsolute(candidate)
    if (!native) {
      rejected += 1
      continue
    }
    const resolved = pathImpl.resolve(candidate)
    const key = windows ? resolved.toLowerCase() : resolved
    if (!roots.has(key)) roots.set(key, resolved)
  }

  return { roots: [...roots.values()], rejected }
}
