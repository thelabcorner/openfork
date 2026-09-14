/**
 * Extract the session target carried by a notification/deep-link URL.
 *
 * Service-worker cold navigation opens the root document with `?session=<id>`
 * while warm navigation forwards that same canonical URL through PUSH_NAVIGATE.
 * The legacy `/session/:id` shape is still accepted for old notifications and
 * external deep links, but it is never used as the document URL because that
 * pathname collides with the same-origin session API.
 */
export function sessionIDFromNavigationUrl(url: string, base: string) {
  try {
    const parsed = new URL(url, base)
    const query = parsed.searchParams.get("session")?.trim()
    if (query) return query
    const pathname = parsed.pathname
    const match = pathname.match(/^\/session\/([^/]+)\/?$/)
    if (!match?.[1]) return undefined
    return decodeURIComponent(match[1]) || undefined
  } catch {
    return undefined
  }
}
