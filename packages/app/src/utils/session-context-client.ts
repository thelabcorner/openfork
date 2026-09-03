import type { SessionContext } from "@opencode-ai/schema/session-context"

const base = "/api"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`session-context ${path} failed ${res.status}: ${body}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export async function applyContextOps(
  sessionID: string,
  operations: SessionContext.ContextOperation[],
): Promise<{ batchID: string; timestamp: number }> {
  return request(`/session/${sessionID}/context/ops`, {
    method: "POST",
    body: JSON.stringify({ operations }),
  })
}

export async function getLedger(sessionID: string): Promise<SessionContext.Ledger> {
  return request(`/session/${sessionID}/context/ledger`)
}

export async function getPreview(sessionID: string): Promise<{
  beforeTokens: number
  afterTokens: number
  removedTokens: number
  messageCount: number
  effectiveCount: number
  earliestMutationIndex?: number
}> {
  return request(`/session/${sessionID}/context/preview`)
}

export async function getOpsHistory(
  sessionID: string,
): Promise<Array<{ id: string; batchID: string; operations: unknown[]; timestamp: number }>> {
  return request(`/session/${sessionID}/context/ops/history`)
}

export async function getForkOrigin(sessionID: string): Promise<{
  sessionID: string
  parentSessionID: string
  sourceMessageID?: string
  edge?: string
  kind: string
  workspaceMode: string
  createdAt: number
}> {
  return request(`/session/${sessionID}/fork-origin`)
}
