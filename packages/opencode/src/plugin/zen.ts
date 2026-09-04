import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeRuntime } from "@/effect/run-service"
import { ForkCredentials } from "@/fork/credentials"
import { errorMessage } from "@/util/error"
import { ZenAccountPool, stableZenIdentity, type ZenAccount, type ZenVaultCredential } from "./zen-accounts"

/**
 * OpenCode Zen multi-key routing plugin.
 *
 * Zen is a plain OpenAI-compatible API, so no loopback proxy is needed. Both
 * "opencode" (Zen free) and "opencode-go" (Go paid) share the same physical
 * keys — the `OPENCODE_API_KEY` environment variables plus the fork vault —
 * and route requests through one `ZenAccountPool` via `zenProviderFetch`, an
 * options.fetch wrapper injected by the provider loaders. The wrapper parses
 * the request body's model field, splits the `@zen-...` account suffix,
 * resolves the key (suffixed id => that account, bare id => the default
 * account), rewrites the wire model id to the base id (upstream never sees
 * the suffix), sets the Authorization header, and observes non-ok responses
 * into the pool's in-memory 402/429 tracking.
 *
 * Per-account model variants are emitted from the provider.models hook as
 * `${baseModelID}@${account.id}` with `${baseName} (${label})` display names,
 * for both provider ids; the bare catalog models remain the default-account
 * entries. There is deliberately no session binding, governor, persistence,
 * or fork-active precedence — this mirrors how verdent/workbuddy bind one key
 * per session, except here the "session" is the model's account suffix.
 *
 * Failures and completions are still observed through the "event" hook as a
 * secondary path: an APIError on a persisted assistant message is attributed
 * to the account named by the message's model suffix, and a completed message
 * with no error clears the pool's failure state — this also catches in-band
 * errors inside 200 SSE streams the fetch wrapper cannot see.
 *
 * Vault credentials live in the fork SQLite store behind the Effect-based
 * `ForkCredentials` service. zen.ts is otherwise plain async JS, so it reads
 * them through a small dedicated runtime built over `ForkCredentials.node`
 * (compiled with the shared memo map, so the global Database layer is shared
 * with the app runtime — not a second connection).
 */

const PROVIDER_ID = "opencode"
const GO_PROVIDER_ID = "opencode-go"
const VAULT_SYNC_TTL_MS = 15_000
const DEFAULT_RETRY_AFTER_MS = 30_000

let pool = new ZenAccountPool()
let testFetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined
let testVaultCredentials: ZenVaultCredential[] | undefined

// Vault sync ------------------------------------------------------------------

const VAULT_UNAVAILABLE = [] as ZenVaultCredential[]

function makeVaultRuntime() {
  return makeRuntime(ForkCredentials.Service, AppNodeBuilder.build(ForkCredentials.node))
}
let vaultRuntime: ReturnType<typeof makeVaultRuntime> | undefined
let lastVaultSyncAt = 0
let vaultSyncInFlight: Promise<void> | undefined

async function readVaultCredentials(): Promise<ZenVaultCredential[]> {
  if (testVaultCredentials !== undefined) return testVaultCredentials
  try {
    vaultRuntime ??= makeVaultRuntime()
    const infos = await vaultRuntime.runPromise((credentials) => credentials.list())
    return infos.map((info) => ({
      vaultId: info.id,
      apiKey: info.key,
      label: info.label,
      isDefault: info.active,
    }))
  } catch (error) {
    // The fork store is unreachable (e.g. embedded server without the Effect
    // services): keep the current env state instead of dropping vault accounts
    // that may already be in the pool.
    console.warn("[zen] vault credentials unavailable; using environment keys only", errorMessage(error))
    return VAULT_UNAVAILABLE
  }
}

/**
 * Fresh-sync the pool with the vault (single-flight, TTL-cached). Env keys are
 * already eagerly reflected by the pool's own sync(); this only adds/refreshes
 * vault keys. On a read failure the current pool is left untouched.
 */
async function fetchAndApplyVault(): Promise<void> {
  try {
    const vault = await readVaultCredentials()
    if (vault !== VAULT_UNAVAILABLE) pool.sync(vault)
  } finally {
    lastVaultSyncAt = Date.now()
  }
}

async function syncVault(force = false): Promise<void> {
  if (testVaultCredentials !== undefined) {
    pool.sync(testVaultCredentials)
    lastVaultSyncAt = Date.now()
    return
  }
  if (force) lastVaultSyncAt = 0
  const now = Date.now()
  if (!force && now - lastVaultSyncAt < VAULT_SYNC_TTL_MS) return
  const wasInFlight = vaultSyncInFlight !== undefined
  vaultSyncInFlight ??= fetchAndApplyVault().finally(() => {
    vaultSyncInFlight = undefined
  })
  await vaultSyncInFlight
  // A force (vault mutation bump) that arrived while a sync was already
  // running was coalesced into that read; if it read the store before the
  // mutation landed, the pool would stay stale for the whole TTL. Re-run once
  // so add / remove / rename / set-default mutations are reflected promptly.
  if (force && wasInFlight) {
    lastVaultSyncAt = 0
    vaultSyncInFlight ??= fetchAndApplyVault().finally(() => {
      vaultSyncInFlight = undefined
    })
    await vaultSyncInFlight
  }
}

/**
 * Await a fresh pool re-sync (single-flight, TTL-gated, stale-while-revalidate).
 * Provider loaders call this before reading `zenQuotaAccounts()` so env keys
 * and vault keys are both present when they decide whether the zen providers
 * are available.
 */
export function syncZenAccountPool(): Promise<void> {
  return syncVault()
}

// Routing ---------------------------------------------------------------------

function parseBodyModel(init: RequestInit | undefined): { body: any; model?: string } {
  if (typeof init?.body !== "string" || !init.body) return { body: undefined }
  try {
    const parsed = JSON.parse(init.body)
    return { body: parsed, model: typeof parsed?.model === "string" ? parsed.model : undefined }
  } catch {
    return { body: undefined }
  }
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after")
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return Date.now() + seconds * 1000
    const date = Date.parse(raw)
    if (Number.isFinite(date)) return date
  }
  return Date.now() + DEFAULT_RETRY_AFTER_MS
}

/**
 * Zen-specific account split for the request router (the shared schema split
 * is deliberately conservative across all account-model providers). For the
 * zen providers the LAST `@zen-` marker is authoritative routing metadata, so
 * this additionally neutralizes malformed ids that could otherwise carry an
 * account suffix (or the `@zen-auto:*` sentinel) onto the upstream wire:
 *
 *   - `base@300k@zen-<hash>` keeps the context suffix and routes to `<hash>`;
 *   - `base@zen-<hash>@300k` (junk after the account) truncates the junk,
 *     routes to `<hash>`, and sends `base`;
 *   - `base@zen-x@zen-y` (double account) routes on the LAST account and strips
 *     every trailing marker from the wire id.
 *
 * An id whose only `@zen-` marker sits at index 0 (pure routing metadata, no
 * model) is returned untouched, mirroring the schema's `separator <= 0` guard.
 */
function resolveZenModelParts(modelID: string): { baseModelID: string; accountID?: string } {
  const marker = modelID.lastIndexOf("@zen-")
  if (marker <= 0) return { baseModelID: modelID }
  // Everything past the last marker is the account segment; truncate any junk
  // that follows it (`base@zen-<hash>@300k` => account `zen-<hash>`).
  const accountID = modelID.slice(marker + 1).split("@")[0] || undefined
  let base = modelID.slice(0, marker)
  for (;;) {
    const next = base.lastIndexOf("@zen-")
    if (next <= 0) break
    base = base.slice(0, next)
  }
  return { baseModelID: base, accountID }
}

/**
 * Single routing/auth authority for every opencode / opencode-go request. See
 * the module doc: splits `@zen-...` account suffixes, picks the key, resolves
 * the default key for bare models, de-qualifies the wire model id, sets
 * Authorization, and observes non-ok responses.
 */
export async function zenProviderFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const baseFetch = testFetch ?? fetch
  await syncVault()
  if (pool.all().length === 0) return baseFetch(url, init)

  const headers = new Headers(init?.headers)
  const { body, model: requestedModel } = parseBodyModel(init)
  const split = typeof requestedModel === "string" ? resolveZenModelParts(requestedModel) : undefined
  const qualified = split?.accountID !== undefined
  const baseModel = split?.baseModelID ?? requestedModel

  // No session affinity or learned failover: the model suffix names the
  // account outright, and a bare id means the user-designated default key.
  let account: ZenAccount | undefined
  if (split?.accountID) account = pool.get(split.accountID)
  account ??= pool.defaultAccount()

  let nextInit = init
  if (account) {
    headers.set("Authorization", `Bearer ${account.apiKey}`)
    nextInit = { ...init, headers }
  }
  if (qualified && baseModel && body) {
    nextInit = { ...nextInit, body: JSON.stringify({ ...body, model: baseModel }) }
  }

  const response = await baseFetch(url, nextInit)
  if (account && !response.ok) {
    pool.observe(account.id, response.status, retryAfterMs(response))
  }
  return response
}

// Observation (event hook) -----------------------------------------------------

function observedError(info: any):
  | {
      status?: number
      body?: string
      headers?: Record<string, string>
    }
  | undefined {
  const error = info?.error
  if (!error || error.name !== "APIError") return undefined
  const data = error.data ?? error
  return {
    status: typeof data?.statusCode === "number" ? data.statusCode : undefined,
    body: typeof data?.responseBody === "string" ? data.responseBody : undefined,
    headers:
      data?.responseHeaders && typeof data.responseHeaders === "object" ? (data.responseHeaders as Record<string, string>) : undefined,
  }
}

function retryAfterFromHeaders(headers: Record<string, string> | undefined): number {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"]
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return Date.now() + seconds * 1000
    const date = Date.parse(raw)
    if (Number.isFinite(date)) return date
  }
  return Date.now() + DEFAULT_RETRY_AFTER_MS
}

async function zenEventHook({ event }: { event: any }) {
  const payload = event as { type?: string; properties?: any }
  if (payload?.type !== "message.updated") return
  const properties = payload.properties
  const info = properties?.info
  if (!info) return
  if (info.providerID !== PROVIDER_ID && info.providerID !== GO_PROVIDER_ID) return
  const split = typeof info.modelID === "string" ? resolveZenModelParts(info.modelID) : undefined
  const accountId = split?.accountID
  if (!accountId) return

  const error = observedError(info)
  if (error) {
    if (error.status) pool.observe(accountId, error.status, retryAfterFromHeaders(error.headers))
    return
  }
  // A completed assistant message with no error is direct evidence the
  // account works; only feed it when the pool currently holds the key back,
  // so ordinary updates do not keep re-clearing state.
  const completedAt = info?.time?.completed
  if (typeof completedAt !== "number") return
  if (pool.state(accountId, completedAt).state === "READY") return
  pool.observe(accountId, 200, undefined)
}

// Model hooks -----------------------------------------------------------------

function mergeAccountModels(models: Record<string, Model>): Record<string, Model> {
  const accounts = pool.all()
  if (accounts.length === 0) return models
  const merged: Record<string, Model> = { ...models }
  for (const account of accounts) {
    for (const model of Object.values(models)) {
      // Never re-qualify ids that already carry an account suffix.
      if (splitAccountModelID(model.id).accountID !== undefined) continue
      const exposedId = `${model.id}@${account.id}`
      merged[exposedId] = {
        ...model,
        id: exposedId,
        name: `${model.name} (${account.label})`,
        api: { ...model.api, id: exposedId },
      }
    }
  }
  return merged
}

// Public API ------------------------------------------------------------------

export function zenLimitSnapshot(now = Date.now()) {
  return pool.snapshot(now)
}

/**
 * Synchronous pool accounts with their wire keys, for quota adapters that must
 * read the official usage gate per routed key. Returns the CURRENT pool state
 * (env keys are eager; vault keys reflect the last successful sync).
 */
export function zenQuotaAccounts(): {
  accountId: string
  apiKey: string
  label: string
  isDefault: boolean
}[] {
  return pool.all().map((account) => ({
    accountId: account.id,
    apiKey: account.apiKey,
    label: account.label,
    isDefault: account.isDefault,
  }))
}

/**
 * Force the pool to re-read the vault on the next routing/refreshing call.
 * Called by the fork credential surface after a mutation (add / remove /
 * rename / set-default) so the pool's account set and default pick up the
 * change without waiting out the TTL.
 */
export function bumpZenVaultPool() {
  lastVaultSyncAt = 0
  void syncVault(true)
}

export async function ZenPlugin(_input: PluginInput): Promise<Hooks> {
  // Warm the pool so the model picker lists vault accounts on first render.
  void syncVault()
  return {
    provider: {
      id: PROVIDER_ID,
      models: async (provider) => mergeAccountModels(provider.models),
    },
    event: async ({ event }) => zenEventHook({ event: event as any }),
  }
}

/** opencode-go shares the same pool; models-only so the event hook runs once. */
export async function ZenGoPlugin(_input: PluginInput): Promise<Hooks> {
  void syncVault()
  return {
    provider: {
      id: GO_PROVIDER_ID,
      models: async (provider) => mergeAccountModels(provider.models),
    },
  }
}

// Test helpers -----------------------------------------------------------------

/**
 * Test-only: replace the base fetch used by the provider wrapper. Passing
 * `undefined` restores the real `fetch`.
 */
export function setTestZenFetch(value: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined) {
  testFetch = value
}

/**
 * Test-only: pin the vault credential list (bypassing the SQLite store) and
 * resync the pool from it. Passing `undefined` restores the real vault read.
 * `vaultId` is derived at sync time from the key, so test fixtures omit it.
 */
export function setTestZenVaultCredentials(credentials: (Omit<ZenVaultCredential, "vaultId"> | ZenVaultCredential)[] | undefined) {
  const normalized = credentials?.map((credential) => "vaultId" in credential ? credential : { ...credential, vaultId: stableZenIdentity(credential.apiKey) })
  testVaultCredentials = normalized
  pool.sync(normalized ?? [])
  lastVaultSyncAt = Date.now()
}

/** Test-only: replace the pool with a fresh instance so tests are isolated. */
export function resetZenPoolForTest() {
  vaultRuntime = undefined
  lastVaultSyncAt = 0
  vaultSyncInFlight = undefined
  pool = new ZenAccountPool()
}
