import { createAtMentionSearch, type MentionSearchPageOf } from "./at-mention-search"
import { ExternalPath } from "@opencode-ai/schema/external-path"

export { ExternalPath }

export type ExternalPathEntry = {
  name: string
  absolute: string
  type: "file" | "directory" | "symlink" | "other"
}

export type ExternalPathFetchResult =
  | { status: "ok"; base: string; entries: ExternalPathEntry[] }
  | { status: "pending" }
  | { status: "denied" }

export type ExternalPathFetch = (input: {
  token: string
  filter: string
  signal: AbortSignal
}) => Promise<ExternalPathFetchResult>

export type ExternalPathRow = {
  kind: "external"
  name: string
  path: string
  isDir: boolean
  base: string
  status: "ok" | "pending" | "denied"
}

const EXTERNAL_LIST_LIMIT = 200

/**
 * Split a typed external token into the directory prefix to list and the
 * trailing segment used as a substring filter. Returns undefined for tokens
 * that are not external-path shaped (caller should fall back to project search).
 */
export function splitExternalToken(query: string): { token: string; filter: string } | undefined {
  if (!ExternalPath.isExternalPathToken(query)) return undefined
  const cut = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"))
  if (cut === -1) return { token: query, filter: "" }
  return { token: query.slice(0, cut + 1), filter: query.slice(cut + 1) }
}

/**
 * Raw-fetch adapter for GET /fs/external-list. The endpoint gates through the
 * external_directory permission: first access to a subtree prompts the user,
 * remembered grants pass silently, config denies and rejections map to
 * "denied", an in-flight ask for the same glob maps to "pending".
 */
export function createExternalPathFetch(input: {
  url: string
  authorization?: string
  sessionID: () => string | undefined
  fetch?: typeof globalThis.fetch
}): ExternalPathFetch {
  return async ({ token, filter, signal }) => {
    const sessionID = input.sessionID()
    if (!sessionID) return { status: "denied" }
    const params = new URLSearchParams({ path: token, sessionID, limit: String(EXTERNAL_LIST_LIMIT) })
    if (filter) params.set("query", filter)
    const headers = new Headers()
    if (input.authorization) headers.set("authorization", input.authorization)
    const doFetch = input.fetch ?? globalThis.fetch
    let response: Response
    try {
      response = await doFetch(new URL(`/fs/external-list?${params}`, input.url), { headers, signal })
    } catch (cause) {
      if (signal.aborted) throw cause
      return { status: "ok", base: "", entries: [] }
    }
    if (response.status === 409) return { status: "pending" }
    if (response.status === 403) return { status: "denied" }
    if (!response.ok) return { status: "ok", base: "", entries: [] }
    const body = (await response.json()) as { base?: string; entries?: ExternalPathEntry[] }
    return { status: "ok" as const, base: body.base ?? "", entries: body.entries ?? [] }
  }
}

function stateRow(token: string, status: "pending" | "denied"): ExternalPathRow {
  return { kind: "external", name: token, path: token, isDir: true, base: token, status }
}

/**
 * Typeahead source for @external-path queries. Rows carry kind:"external" so
 * the popover groups them under the sticky external header; pending/denied
 * surface as single state rows instead of entries.
 */
export function createExternalPathMentionSearch(fetch: ExternalPathFetch) {
  return createAtMentionSearch<ExternalPathRow>((query, options): Promise<MentionSearchPageOf<ExternalPathRow>> => {
    const split = splitExternalToken(query)
    if (!split) return Promise.resolve({ results: [], hasMore: false })
    return fetch({ token: split.token, filter: split.filter, signal: options.signal }).then((result) => {
      if (result.status === "pending") return { results: [stateRow(split.token, "pending")], hasMore: false }
      if (result.status === "denied") return { results: [stateRow(split.token, "denied")], hasMore: false }
      return {
        results: result.entries.map(
          (entry): ExternalPathRow => ({
            kind: "external",
            name: entry.name,
            path: entry.absolute,
            isDir: entry.type === "directory",
            base: result.base,
            status: "ok",
          }),
        ),
        hasMore: false,
      }
    })
  })
}

/**
 * Insert-time proactive grant: listing one entry of the target's directory
 * forces the server-side ask if the subtree is not already allowed, so the
 * approval dialog appears at mention time rather than mid-session later.
 */
export function ensureExternalPathPermission(fetch: ExternalPathFetch, path: string): Promise<"granted" | "denied"> {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  const dir = cut === -1 ? path : path.slice(0, cut + 1)
  return fetch({ token: dir, filter: "", signal: new AbortController().signal }).then((result) =>
    result.status === "denied" ? ("denied" as const) : ("granted" as const),
  )
}
