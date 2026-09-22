import { authTokenFromCredentials } from "./server"

/**
 * Plain, hand-authenticated fetch client for the fork-owned `/fork/*`
 * routes. Deliberately bypasses the generated/vendored SDK clients (see
 * handoff notes on the vendor-tarball naming mismatch): these routes
 * ARE part of the unified OpenCodeHttpApi (packages/opencode
 * httpapi/groups/fork-credential), so the generated unified SDK must be
 * regenerated in lockstep, but the app keeps this thin fetch layer so the
 * dialog/composer never depends on that tarball.
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
  // Routing identity in the unified Zen account pool (`zen-<hash>`), shared by
  // env and vault keys. Per-account spend in the model picker is keyed off
  // this; the vault UUID in `credentialID` stays the store key.
  accountID?: string
  windows: ForkWindowUsage[]
  // Additive envelope metadata about the official snapshot served for this
  // credential (age/status of the remote OpenCode Go usage data). Absent for
  // old servers / local-only responses; always treat as optional.
  official?: ForkOfficialEnvelope
}

export type ForkUsageResult = {
  aggregate: ForkWindowUsage[]
  byCredential: ForkCredentialUsage[]
  // Pool account a bare opencode-go request routes to (may be an env key the
  // vault has no row for). Absent when the pool is empty or on old servers.
  defaultAccountID?: string
  defaultAccountLabel?: string
  // Actual bare opencode-go route after provider-auth > pool precedence.
  routedAccountID?: string
  routedAccountLabel?: string
  routedAccountSource?: "provider" | "pool"
}

export type ForkCapacityEvidence = {
  observations: number
  requestEffectiveSamples: number
  sessionEffectiveSamples: number
  personalWeight: number
  // Additive hierarchy detail; optional so the renderer remains compatible with
  // older servers while never reconstructing the estimator locally.
  baseObservations?: number
  baseRequestEffectiveSamples?: number
  baseSessionEffectiveSamples?: number
  basePersonalWeight?: number
  accountObservations?: number
  accountRequestEffectiveSamples?: number
  accountSessionEffectiveSamples?: number
  accountPersonalWeight?: number
  localRequestsApplied?: number
  localFractionConsumed?: number
  localUnnormalizedRequests?: number
}

export type ForkCapacityPredictiveRange =
  | {
      status: "learning"
      effectiveSamples: number
      matureAt: number
    }
  | {
      status: "calibrated"
      effectiveSamples: number
      matureAt: number
      targetCoverage: number
      heldOutCoverage: number
      calibrationBudget: 5 | 20 | 100
      lowerRequests: number
      upperRequests: number
    }
  | {
      status: "unavailable"
      effectiveSamples: number
      matureAt: number
      reason: "incomplete-local-accounting"
    }

export type ForkCapacityEstimate = {
  modelID: string
  accountID?: string
  baselineRequests: number
  estimatedRequests: number
  remainingFraction: number
  remainingPercent: number
  workloadMultiplier: number
  workloadSource?: "published-prior" | "personal-base" | "account-hierarchical"
  personalized: boolean
  resetAt: number
  quotaStatus: "ok" | "stale"
  // Additive so older servers remain readable. New servers mark a projection
  // unusable when post-snapshot local consumption cannot be normalized exactly.
  projectionStatus?: "ok" | "incomplete-local-accounting"
  // Additive for compatibility with older servers. New servers expose either a
  // calibrated mature-evidence range or an explicit learning/unavailable state.
  predictiveRange?: ForkCapacityPredictiveRange
  evidence: ForkCapacityEvidence
}



export type ForkProviderCapacityEvidence = {
  observations: number
  requestEffectiveSamples: number
  sessionEffectiveSamples: number
}

export type ForkProviderCapacityEstimate = {
  providerID: string
  modelID?: string
  accountID?: string
  accountLabel?: string
  status: "ready" | "learning" | "unavailable" | "unlimited"
  source:
    | "direct-request-budget"
    | "published-request-rate"
    | "published-model-capacity"
    | "standardized-workload-prior"
    | "personal-current-price"
    | "provider-observed-burn"
    | "unmetered"
    | "insufficient-evidence"
  estimatedRequests: number | null
  remainingPercent: number | null
  resetAt: number | null
  personalized: boolean
  limitingWindow?: string
  reason?: string
  evidence: ForkProviderCapacityEvidence
}

export type ForkProviderCapacity = {
  quotaProviderID: string
  providerName: string
  modelProviderIDs: string[]
  status: "ok" | "error" | "not-configured"
  reason?: string
  defaultEstimates: ForkProviderCapacityEstimate[]
  estimates: ForkProviderCapacityEstimate[]
  accounts: Array<{
    accountID: string
    accountLabel?: string
    defaultEstimate?: ForkProviderCapacityEstimate
    estimates: ForkProviderCapacityEstimate[]
  }>
}

export type ForkCapacityResult = {
  providerID: "opencode-go"
  priorStatus: "ok" | "stale" | "error"
  priorFetchedAt: number
  routedAccountID?: string
  routed: ForkCapacityEstimate[]
  accounts: Array<{
    accountID: string
    estimates: ForkCapacityEstimate[]
  }>
  /** Additive generalized provider projections; absent on older servers. */
  providers?: ForkProviderCapacity[]
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
  setDefault: (server: ForkServer, id: string, directory?: string) =>
    request<boolean>(
      server,
      `/fork/credential/${encodeURIComponent(id)}/default${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
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
  capacity: (server: ForkServer) => request<ForkCapacityResult>(server, "/fork/capacity"),
}
