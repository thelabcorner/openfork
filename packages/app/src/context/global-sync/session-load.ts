import type { SessionApi } from "@opencode-ai/client/promise"
import { normalizeSessionInfo } from "@/utils/session"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"

type RootSessions = {
  readonly data: Session[]
  readonly limit: number
  readonly limited: boolean
}

export async function loadRootSessions(input: {
  api: Pick<SessionApi, "list">
  directory: string
  limit: number
}): Promise<RootSessions> {
  const result = await input.api.list({
    directory: input.directory,
    // This path exists only as the compatibility fallback when the newer
    // bootstrap-free /global/session/roots route is unavailable. The pinned
    // promise client predates the `roots` query field and would silently drop
    // it at runtime; older V2 servers represented root sessions with the
    // nullable parent filter instead.
    parentID: null,
    limit: input.limit,
    order: "desc",
  })
  return {
    data: result.data.map(normalizeSessionInfo),
    limit: input.limit,
    limited: true,
  }
}

/**
 * Server-global startup path: reads recent roots directly from durable session
 * storage and therefore does not wait for directory config/plugin bootstrap.
 * Newer OpenFork servers expose this on every protocol generation. Callers
 * should fall back to the instance-scoped list only when an older server lacks
 * the route.
 */
export async function loadRootSessionsFast(input: {
  client: OpencodeClient
  directory: string
  limit: number
}): Promise<RootSessions> {
  const result = await input.client.global.sessionRoots({
    directory: input.directory,
    limit: String(input.limit),
  })
  return {
    data: (result.data ?? []).map(normalizeSessionInfo),
    limit: input.limit,
    limited: true,
  }
}

export function rootSessionFastPathUnavailable(error: unknown) {
  if (!error || typeof error !== "object") return false
  const direct = "status" in error ? Number((error as { status?: unknown }).status) : undefined
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : undefined
  const caused = cause && "status" in cause ? Number((cause as { status?: unknown }).status) : undefined
  const response = "response" in error && (error as { response?: unknown }).response
  const responded =
    response && typeof response === "object" && "status" in response
      ? Number((response as { status?: unknown }).status)
      : undefined
  const status = direct ?? caused ?? responded
  return status === 404 || status === 405
}

export async function loadRootSessionsV1(input: {
  client: OpencodeClient
  directory: string
  limit: number
}): Promise<RootSessions> {
  try {
    const result = await input.client.session.list({ directory: input.directory, roots: true, limit: input.limit })
    return { data: (result.data ?? []).map(normalizeSessionInfo), limit: input.limit, limited: true }
  } catch {
    const result = await input.client.session.list({ directory: input.directory, roots: true })
    return { data: (result.data ?? []).map(normalizeSessionInfo), limit: input.limit, limited: false }
  }
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}
