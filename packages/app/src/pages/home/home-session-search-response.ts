import type { Session } from "@opencode-ai/sdk/v2/client"

export type SessionSearchMessageMatch = {
  sessionID: string
  messageID: string
  sessionTitle: string
  directory: string
  projectID: string
  time: { created: number }
  type: string
  snippet: string
  matchedTerms: string[]
}

export type SessionSearchResult = {
  titleMatches: Session[]
  messageMatches: SessionSearchMessageMatch[]
}

export function normalizeSessionSearchResponse(response: unknown): SessionSearchResult {
  if (isSessionSearchResult(response)) return response
  const record = asRecord(response)
  if (isSessionSearchResult(record?.data)) return record.data
  const data = asRecord(record?.data)
  if (isSessionSearchResult(data?.data)) return data.data
  return { titleMatches: [], messageMatches: [] }
}

function isSessionSearchResult(value: unknown): value is SessionSearchResult {
  const record = asRecord(value)
  return Array.isArray(record?.titleMatches) && Array.isArray(record.messageMatches)
}

function asRecord(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  return value as Record<string, unknown>
}
