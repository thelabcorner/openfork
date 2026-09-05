export function stripFileProtocol(input: string) {
  if (!input.startsWith("file://")) return input
  return input.slice("file://".length)
}

export function stripQueryAndHash(input: string) {
  const hashIndex = input.indexOf("#")
  const queryIndex = input.indexOf("?")

  if (hashIndex !== -1 && queryIndex !== -1) {
    return input.slice(0, Math.min(hashIndex, queryIndex))
  }

  if (hashIndex !== -1) return input.slice(0, hashIndex)
  if (queryIndex !== -1) return input.slice(0, queryIndex)
  return input
}

export function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function decodeFilePath(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export function encodeFilePath(filepath: string): string {
  // Normalize Windows paths: convert backslashes to forward slashes
  let normalized = filepath.replace(/\\/g, "/")

  // Handle Windows absolute paths (D:/path -> /D:/path for proper file:// URLs)
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = "/" + normalized
  }

  // Encode each path segment (preserving forward slashes as path separators)
  // Keep the colon in Windows drive letters (`/C:/...`) so downstream file URL parsers
  // can reliably detect drives.
  return normalized
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
}

export function createPathHelpers(scope: () => string) {
  const MAX_NORMALIZE_CACHE = 4096
  let cachedScope: string | undefined
  let cachedWindows = false
  let cachedCanonicalRoot = ""
  const normalizeCache = new Map<string, string>()
  const rootInfo = () => {
    const root = scope()
    if (root === cachedScope) return { root, windows: cachedWindows, canonical: cachedCanonicalRoot }
    cachedScope = root
    normalizeCache.clear()
    cachedWindows = /^[A-Za-z]:/.test(root) || root.startsWith("\\\\")
    cachedCanonicalRoot = cachedWindows ? root.replace(/\\/g, "/").toLowerCase() : root.replace(/\\/g, "/")
    return { root, windows: cachedWindows, canonical: cachedCanonicalRoot }
  }

  const normalize = (input: string) => {
    const info = rootInfo()
    const cached = normalizeCache.get(input)
    if (cached !== undefined) {
      // Touch the entry so repeated watcher events retain their hot paths while
      // the bounded map sheds old paths from a large branch switch.
      normalizeCache.delete(input)
      normalizeCache.set(input, cached)
      return cached
    }

    let path = unquoteGitPath(decodeFilePath(stripQueryAndHash(stripFileProtocol(input))))

    // Separator-agnostic prefix stripping for Cygwin/native Windows compatibility
    // Only case-insensitive on Windows (drive letter or UNC paths)
    const canonPath = info.windows ? path.replace(/\\/g, "/").toLowerCase() : path.replace(/\\/g, "/")
    if (
      canonPath.startsWith(info.canonical) &&
      (info.canonical.endsWith("/") || canonPath === info.canonical || canonPath[info.canonical.length] === "/")
    ) {
      // Slice from original path to preserve native separators
      path = path.slice(info.root.length)
    }

    if (path.startsWith("./") || path.startsWith(".\\")) {
      path = path.slice(2)
    }

    if (path.startsWith("/") || path.startsWith("\\")) {
      path = path.slice(1)
    }
    normalizeCache.set(input, path)
    while (normalizeCache.size > MAX_NORMALIZE_CACHE) {
      const oldest = normalizeCache.keys().next().value
      if (oldest === undefined) break
      normalizeCache.delete(oldest)
    }
    return path
  }

  const tab = (input: string) => {
    const path = normalize(input)
    return `file://${encodeFilePath(path)}`
  }

  const pathFromTab = (tabValue: string) => {
    if (!tabValue.startsWith("file://")) return
    return normalize(tabValue)
  }

  const normalizeDir = (input: string) => {
    const path = normalize(input)
    return (rootInfo().windows ? path.replace(/\\/g, "/") : path).replace(/\/+$/, "")
  }

  return {
    normalize,
    tab,
    pathFromTab,
    normalizeDir,
  }
}
