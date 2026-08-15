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
