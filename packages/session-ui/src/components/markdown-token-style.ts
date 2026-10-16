import { getTokenStyleObject, stringifyTokenStyle, type ThemedToken } from "shiki"

/**
 * TextMate grammar tokens overwhelmingly reuse the same handful of foreground
 * colors/font flags. Avoid allocating a style object and serializing it for
 * every occurrence. Cache is per worker and strictly bounded. An explicit
 * htmlStyle overrides token colors exactly as it did before optimization.
 */
export function createTokenStyleSerializer(maxEntries = 512) {
  const cache = new Map<string, string>()
  return (token: ThemedToken): string => {
    if (token.htmlStyle !== undefined)
      return stringifyTokenStyle(token.htmlStyle)
    // Shiki getTokenStyleObject reads only color/bgColor/fontStyle.
    // These are CSS colors and numeric bitflags, so NUL is an unambiguous key
    // separator without JSON.stringify or intermediary style allocations.
    const key = `${token.color ?? ""}\0${token.bgColor ?? ""}\0${token.fontStyle ?? 0}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const formatted = stringifyTokenStyle(getTokenStyleObject(token))
    if (cache.size < maxEntries) cache.set(key, formatted)
    return formatted
  }
}
