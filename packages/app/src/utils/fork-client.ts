import { authTokenFromCredentials } from "./server"

/**
 * Plain, hand-authenticated fetch client for the fork-owned `/fork/*`
 * routes. Deliberately bypasses the generated/vendored SDK clients (see
 * handoff notes on the vendor-tarball naming mismatch) — these routes are
 * new, fork-only additions, so there's nothing to keep in sync with a
 * generator, and a raw fetch avoids depending on the vendor tarball at all.
 */

export type ForkServer = { url: string; username?: string; password?: string }

export type ForkCredentialInfo = {
  id: string
  label: string
  active: boolean
  timeCreated: number
}

export type ForkWindowUsage = {
  label: "5h" | "week" | "month"
  spentUSD: number
  limitUSD: number
  estimatedPercent?: number
  resetsAt: number
  clearsAt?: number
  lastUsedAt?: number
  callsInWindow: number
  // "api" = fresh official overlay, "local" = no official snapshot, "cached" =
  // served from a stale snapshot. Type as a superset so old servers parse.
  source?: "api" | "local" | "cached"
  status?: string
}

export type ForkOfficialEnvelope = {
  fetchedAt: number
  ageMs: number
  status: "ok" | "stale" | "error"
}

export type ForkCredentialUsage = {
  credentialID: string
  windows: ForkWindowUsage[]
  // Additive envelope metadata about the official snapshot served for this
  // credential (age/status of the remote OpenCode Go usage data). Absent for
  // old servers / local-only responses; always treat as optional.
  official?: ForkOfficialEnvelope
}

export type ForkUsageResult = {
  aggregate: ForkWindowUsage[]
  byCredential: ForkCredentialUsage[]
}

function authHeader(server: ForkServer): Record<string, string> {
  if (!server.password) return {}
  return { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
}

async function request<T>(server: ForkServer, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${server.url}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeader(server),
      ...init?.headers,
    },
  })
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status}`)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const ForkClient = {
  list: (server: ForkServer) => request<ForkCredentialInfo[]>(server, "/fork/credential"),
  add: (server: ForkServer, input: { key: string; label?: string; directory?: string }) =>
    request<ForkCredentialInfo>(
      server,
      `/fork/credential${input.directory ? `?directory=${encodeURIComponent(input.directory)}` : ""}`,
      { method: "POST", body: JSON.stringify({ key: input.key, label: input.label }) },
    ),
  select: (server: ForkServer, id: string, directory?: string) =>
    request<boolean>(
      server,
      `/fork/credential/${encodeURIComponent(id)}/select${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
      { method: "POST" },
    ),
  rename: (server: ForkServer, id: string, label: string) =>
    request<boolean>(server, `/fork/credential/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ label }),
    }),
  remove: (server: ForkServer, id: string, directory?: string) =>
    request<boolean>(
      server,
      `/fork/credential/${encodeURIComponent(id)}${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
      { method: "DELETE" },
    ),
  usage: (server: ForkServer) => request<ForkUsageResult>(server, "/fork/usage"),
}
