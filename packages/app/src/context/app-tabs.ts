export const APP_TAB_PAGES = ["settings", "usage", "scheduled", "oxp", "agents"] as const

export type AppTabPage = (typeof APP_TAB_PAGES)[number]

const appTabPages = new Set<string>(APP_TAB_PAGES)
const APP_TAB_ORIGIN = "https://openfork.local"

export function isAppTabPage(value: string): value is AppTabPage {
  return appTabPages.has(value)
}

export function appTabPageFromPathname(pathname: string): AppTabPage | undefined {
  const parts = pathname.split("/").filter(Boolean)
  if (parts[0] === "oxp") {
    if (parts.length === 1) return "oxp"
    if (parts.length === 3 && parts[1] === "activity" && parts[2]) return "oxp"
    return
  }
  if (parts.length !== 1) return
  const page = parts[0]
  return page && isAppTabPage(page) ? page : undefined
}

export function appTabBaseHref(page: AppTabPage) {
  return `/${page}`
}

/** OXP parent activity is a durable identity, not a singleton page selection. */
export function oxpActivityIDFromPathname(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean)
  if (segments.length !== 3 || segments[0] !== "oxp" || segments[1] !== "activity" || !segments[2]) return
  try {
    return decodeURIComponent(segments[2])
  } catch {
    return
  }
}

export function oxpActivityIDFromHref(href?: string): string | undefined {
  return oxpActivityIDFromPathname(href?.split(/[?#]/, 1)[0] ?? "")
}

/**
 * Application tabs normally have one identity per page. OXP detail routes are
 * different: a parent activity is a separate reader/tab, just like a Session.
 * Query/hash changes must never create additional tabs for the same activity.
 */
export function appTabKey(page: AppTabPage, href?: string) {
  if (page !== "oxp") return `app:${page}`
  // The tab store validates hrefs on write and restore. This is a hot identity
  // lookup: avoid a URL allocation for each tab on selection, drag and sorting.
  const activityID = oxpActivityIDFromHref(href)
  return activityID ? `app:oxp:${encodeURIComponent(activityID)}` : "app:oxp"
}

/**
 * App-tab hrefs are persisted and later fed back into the router. Keep them
 * internal and pinned to the tab's own surface so corrupted/stale persisted
 * state can never turn a tab selection into cross-surface or external
 * navigation.
 */
export function normalizeAppTabHref(page: AppTabPage, href?: string) {
  const fallback = appTabBaseHref(page)
  if (!href) return fallback

  try {
    const url = new URL(href, APP_TAB_ORIGIN)
    if (url.origin !== APP_TAB_ORIGIN) return fallback
    if (appTabPageFromPathname(url.pathname) !== page) return fallback
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}
