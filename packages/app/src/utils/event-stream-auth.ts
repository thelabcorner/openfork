import { authTokenFromCredentials } from "@/utils/server"
import { DEVICE_AUTH_USERNAME } from "@/utils/pwa-pairing"

// EventSource-style contexts cannot always rely on headers (native
// EventSource cannot set any; some embedded webviews drop Authorization on
// cross-origin event streams). The server accepts Basic credentials as an
// ?auth_token=<base64(user:pass)> query param — the same treatment the PTY
// websocket already gets in terminal-websocket-url.ts. This module applies it
// to SSE event-stream requests only, so the token never leaks into URLs of
// regular API calls.

const EVENT_STREAM_PATHS = ["/event", "/api/event", "/global/event"]

export function isEventStreamPath(pathname: string) {
  return EVENT_STREAM_PATHS.includes(pathname)
}

/**
 * Append credentials as an auth_token query param on event-stream URLs.
 * Pure: non-event URLs and credential-less inputs pass through untouched.
 * Device tokens travel RAW (the server's device-token check reads the query
 * value verbatim); regular passwords keep the base64 user:pass convention
 * used by the PTY websocket.
 */
export function appendEventStreamAuthToken(
  url: string | URL,
  credentials: { username?: string; password?: string },
): URL {
  const next = new URL(url)
  if (!credentials.password) return next
  if (!isEventStreamPath(next.pathname)) return next
  if (next.searchParams.has("auth_token")) return next
  const token =
    credentials.username === DEVICE_AUTH_USERNAME
      ? credentials.password
      : authTokenFromCredentials({ username: credentials.username, password: credentials.password })
  next.searchParams.set("auth_token", token)
  return next
}

/**
 * Fetch wrapper for the dedicated event-stream SDK clients: rewrites the
 * request URL per appendEventStreamAuthToken before delegating. Handles all
 * three fetch input shapes (string, URL, Request).
 */
export function eventStreamFetch(base: typeof globalThis.fetch, credentials: { username?: string; password?: string }) {
  const fetcher = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof input === "string" || input instanceof URL) {
      return base(appendEventStreamAuthToken(input, credentials), init)
    }
    const url = appendEventStreamAuthToken(input.url, credentials)
    if (url.href === input.url) return base(input, init)
    return base(new Request(url, input), init)
  }
  return Object.assign(
    fetcher,
    base.preconnect ? { preconnect: base.preconnect.bind(base) } : {},
  ) as typeof globalThis.fetch
}
