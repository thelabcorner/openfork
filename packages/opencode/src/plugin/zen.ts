import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeRuntime } from "@/effect/run-service"
import { ForkCredentials } from "@/fork/credentials"
import { errorMessage } from "@/util/error"
import { withRoutedAccount } from "@/provider/routing-metadata"
import { ZenAccountPool, stableZenIdentity, type ZenVaultCredential } from "./zen-accounts"

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
   * or fork-active precedence — unlike WorkBuddy's session binding, the
   * "session" here is the model's account suffix.

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
export const ZEN_PUBLIC_API_KEY = "public"
const VAULT_SYNC_TTL_MS = 15_000
const DEFAULT_RETRY_AFTER_MS = 30_000
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models"
const ZEN_MODEL_DISCOVERY_TTL_MS = 5 * 60_000
const ZEN_MODEL_DISCOVERY_STALE_GRACE_MS = 6 * 60 * 60_000
const ZEN_MODEL_DISCOVERY_TIMEOUT_MS = 3_000
const ZEN_MODEL_DISCOVERY_CACHE_VERSION = 1
const ZEN_MODEL_DISCOVERY_CACHE_FILE = "zen-public-models.json"
const ZEN_MODEL_DISCOVERY_MAX_MODELS = 2_048
const ZEN_MODEL_DISCOVERY_MAX_ID_LENGTH = 256

export type ZenSystemOneModel = {
  readonly id: string
  readonly name: string
  readonly baseURL: string
  readonly cost: {
    readonly input: number
    readonly output: number
  }
}

let pool = new ZenAccountPool()
let testFetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined
let testVaultCredentials: ZenVaultCredential[] | undefined
type ZenAdvertisedModelsCache = {
  readonly fetchedAt: number
  readonly ids: ReadonlySet<string>
}

export type ZenHostedCatalogState = "fresh" | "stale" | "expired" | "unavailable"

export type ZenHostedCatalog = {
  readonly state: ZenHostedCatalogState
  readonly fetchedAt?: number
  readonly ids: ReadonlySet<string>
}

type PersistedZenHostedCatalog = {
  readonly version: number
  readonly fetchedAt: number
  readonly ids: readonly string[]
}

let zenAdvertisedModelsCache: ZenAdvertisedModelsCache | undefined
let zenAdvertisedModelsCacheLoaded = false
let zenAdvertisedModelsInFlight: Promise<ZenAdvertisedModelsCache> | undefined
let testZenCatalogCacheFile: string | undefined

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

export type ZenRequestRoute = {
  modelID?: string
  accountID?: string
  apiKey?: string
  missingAccountID?: string
}

function bearerApiKey(headers: Headers): string | undefined {
  const raw = headers.get("authorization")?.trim()
  if (!raw) return
  const match = /^Bearer\s+(.+)$/i.exec(raw)
  const token = match?.[1]?.trim()
  return token || undefined
}

/**
 * Resolve Zen routing metadata without performing transport. This is the
 * account/auth authority shared by OpenAI-compatible chat transport and
 * non-generative provider primitives such as System One.
 *
 * Explicit account routing is always strongest and fails closed so a removed
 * account can never silently fall through to another key.
 *
 * Bare routing intentionally differs by provider:
 * - opencode (Zen): unified pool default > legacy/direct provider bearer.
 *   Provider auth is only a compatibility fallback when the pool is empty.
 * - opencode-go: directly connected provider bearer > unified pool default.
 *
 * This matches the fork credential/usage contract: Go supports a separately
 * connected provider credential, while Zen's multi-account pool is the routing
 * authority once it has any account.
 */
export async function resolveZenRequest(
  modelID: string | undefined,
  preferredApiKey?: string,
  providerID: string = PROVIDER_ID,
): Promise<ZenRequestRoute> {
  await syncVault()
  const split = typeof modelID === "string" ? resolveZenModelParts(modelID) : undefined
  if (split?.accountID) {
    const account = pool.get(split.accountID)
    if (!account) {
      return { modelID: split.baseModelID, missingAccountID: split.accountID }
    }
    return { modelID: split.baseModelID, accountID: account.id, apiKey: account.apiKey }
  }

  // Public is a real credential-free route, not an invitation to pick the
  // current account-pool default. Once the provider deliberately selects the
  // upstream public sentinel, preserve it all the way to transport.
  //
  // Explicit account-qualified models above remain stronger. Go does not expose
  // a public route, so its existing direct/default-account behavior is unchanged.
  if (providerID === PROVIDER_ID && preferredApiKey === ZEN_PUBLIC_API_KEY) {
    return {
      modelID: split?.baseModelID ?? modelID,
      apiKey: ZEN_PUBLIC_API_KEY,
    }
  }

  const account = pool.defaultAccount()
  const preferredPoolAccount =
    preferredApiKey && preferredApiKey !== ZEN_PUBLIC_API_KEY
      ? pool.get(stableZenIdentity(preferredApiKey))
      : undefined

  // Go alone has an independent direct-provider credential surface. Preserve
  // that selection even when the same physical key also exists in the pool;
  // attach accountID when possible so quota/error observation stays tied to
  // the unified identity.
  if (providerID === GO_PROVIDER_ID && preferredApiKey && preferredApiKey !== ZEN_PUBLIC_API_KEY) {
    return {
      modelID: split?.baseModelID ?? modelID,
      accountID: preferredPoolAccount?.id,
      apiKey: preferredApiKey,
    }
  }

  // Any populated pool owns ordinary bare authenticated Zen routing. This also
  // prevents stale legacy auth.json state from shadowing the user-selected vault
  // account. The explicit public sentinel was handled above and never enters the
  // account pool.
  if (account) {
    return {
      modelID: split?.baseModelID ?? modelID,
      accountID: account.id,
      apiKey: account.apiKey,
    }
  }

  // Compatibility fallback for installations that have not yet populated the
  // unified pool but still carry a provider credential / public sentinel.
  return {
    modelID: split?.baseModelID ?? modelID,
    apiKey: preferredApiKey,
  }
}

function isTestEnv() {
  return process.env.NODE_ENV === "test" || !!process.env.BUN_TEST || !!process.env.OPENCODE_TEST_HOME || !!process.env.VITEST
}

function zenCatalogCacheFile() {
  return testZenCatalogCacheFile ?? path.join(Global.Path.cache, ZEN_MODEL_DISCOVERY_CACHE_FILE)
}

function persistenceEnabled() {
  return !isTestEnv() || testZenCatalogCacheFile !== undefined
}

function validZenModelID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ZEN_MODEL_DISCOVERY_MAX_ID_LENGTH &&
    !/[\x00-\x1f\x7f]/.test(value)
  )
}

function catalogState(cache: ZenAdvertisedModelsCache, now = Date.now()): ZenHostedCatalogState {
  const age = Math.max(0, now - cache.fetchedAt)
  if (age < ZEN_MODEL_DISCOVERY_TTL_MS) return "fresh"
  if (age <= ZEN_MODEL_DISCOVERY_STALE_GRACE_MS) return "stale"
  return "expired"
}

function loadPersistedZenCatalog() {
  if (zenAdvertisedModelsCacheLoaded) return
  zenAdvertisedModelsCacheLoaded = true
  if (!persistenceEnabled()) return
  try {
    const parsed = JSON.parse(fs.readFileSync(zenCatalogCacheFile(), "utf8")) as PersistedZenHostedCatalog
    if (parsed.version !== ZEN_MODEL_DISCOVERY_CACHE_VERSION) return
    if (!Number.isFinite(parsed.fetchedAt) || parsed.fetchedAt < 0) return
    // Reject implausibly future cache timestamps instead of letting corruption
    // make a snapshot appear fresh for an unbounded period.
    if (parsed.fetchedAt > Date.now() + ZEN_MODEL_DISCOVERY_TTL_MS) return
    if (!Array.isArray(parsed.ids) || parsed.ids.length === 0 || parsed.ids.length > ZEN_MODEL_DISCOVERY_MAX_MODELS) return
    if (!parsed.ids.every(validZenModelID)) return
    zenAdvertisedModelsCache = {
      fetchedAt: parsed.fetchedAt,
      ids: new Set(parsed.ids),
    }
  } catch {
    // Cache miss/corruption is non-fatal. The next live refresh owns recovery.
  }
}

function persistZenCatalog(cache: ZenAdvertisedModelsCache) {
  if (!persistenceEnabled()) return
  try {
    const file = zenCatalogCacheFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = JSON.stringify({
      version: ZEN_MODEL_DISCOVERY_CACHE_VERSION,
      fetchedAt: cache.fetchedAt,
      ids: [...cache.ids],
    } satisfies PersistedZenHostedCatalog)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, payload, { mode: 0o600 })
    try {
      fs.renameSync(tmp, file)
    } catch {
      // Windows cannot always replace an existing target atomically.
      fs.writeFileSync(file, payload, { mode: 0o600 })
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  } catch {
    // This is a cache only. Live discovery remains the correctness source.
  }
}

function validateAdvertisedZenModels(body: unknown): ReadonlySet<string> {
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("Zen model discovery returned an invalid model list")
  }
  if (body.data.length === 0 || body.data.length > ZEN_MODEL_DISCOVERY_MAX_MODELS) {
    throw new Error("Zen model discovery returned an implausible model count")
  }
  const ids = new Set<string>()
  for (const item of body.data) {
    if (!item || typeof item !== "object" || !("id" in item) || !validZenModelID(item.id)) {
      throw new Error("Zen model discovery returned an invalid model entry")
    }
    ids.add(item.id)
  }
  return ids
}

async function refreshAdvertisedZenModels(): Promise<ZenAdvertisedModelsCache> {
  if (isTestEnv() && testFetch === undefined && testZenCatalogCacheFile === undefined) {
    throw new Error("Zen model discovery is disabled in tests without an explicit test fetch")
  }
  zenAdvertisedModelsInFlight ??= (async () => {
    const response = await (testFetch ?? fetch)(ZEN_MODELS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ZEN_MODEL_DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error("Zen model discovery failed with HTTP " + response.status)
    const ids = validateAdvertisedZenModels((await response.json()) as unknown)
    const cache = { fetchedAt: Date.now(), ids } satisfies ZenAdvertisedModelsCache
    zenAdvertisedModelsCache = cache
    zenAdvertisedModelsCacheLoaded = true
    persistZenCatalog(cache)
    return cache
  })().finally(() => {
    zenAdvertisedModelsInFlight = undefined
  })
  return zenAdvertisedModelsInFlight
}

/**
 * Current hosted Zen catalog with explicit freshness semantics.
 *
 * Fresh data is returned directly. Stale-but-bounded data remains usable while
 * one background refresh runs. Expired data gets one synchronous refresh attempt
 * and remains observable as expired if the gateway is unavailable.
 */
export async function zenHostedCatalog(): Promise<ZenHostedCatalog> {
  loadPersistedZenCatalog()
  const cached = zenAdvertisedModelsCache
  if (cached) {
    const state = catalogState(cached)
    if (state === "fresh") return { state, fetchedAt: cached.fetchedAt, ids: cached.ids }
    if (state === "stale") {
      void refreshAdvertisedZenModels().catch(() => undefined)
      return { state, fetchedAt: cached.fetchedAt, ids: cached.ids }
    }
  }

  try {
    const refreshed = await refreshAdvertisedZenModels()
    return { state: "fresh", fetchedAt: refreshed.fetchedAt, ids: refreshed.ids }
  } catch {
    if (cached) return { state: "expired", fetchedAt: cached.fetchedAt, ids: cached.ids }
    return { state: "unavailable", ids: new Set() }
  }
}

async function advertisedZenModelIDs(): Promise<ReadonlySet<string>> {
  const catalog = await zenHostedCatalog()
  if (catalog.state === "fresh" || catalog.state === "stale") return catalog.ids
  throw new Error("Zen hosted model catalog is not currently usable")
}

/**
 * Resolve the documented zero-cost Zen System One model when models.dev lags
 * the hosted gateway's own /models surface.
 *
 * This is intentionally narrow and fail-closed:
 * - only the exact free Jev compatibility id is eligible;
 * - the live Zen /models endpoint must currently advertise the base id;
 * - Go is not synthesized here because its hosted catalog does not advertise
 *   Jev today;
 * - paid Jev remains catalog-owned so local billing metadata cannot drift.
 */
export async function discoverZenSystemOneModel(modelID: string): Promise<ZenSystemOneModel | undefined> {
  const { baseModelID } = resolveZenModelParts(modelID)
  if (baseModelID !== "jev-1.13-free") return
  try {
    const advertised = await advertisedZenModelIDs()
    if (!advertised.has(baseModelID)) return
  } catch {
    return
  }
  return {
    id: modelID,
    name: "Jev 1.13 Free",
    baseURL: "https://opencode.ai/zen/v1",
    cost: { input: 0, output: 0 },
  }
}

export function observeZenRequest(
  accountID: string | undefined,
  status: number,
  headers?: Record<string, string>,
) {
  if (!accountID) return
  pool.observe(accountID, status, status === 429 ? retryAfterFromHeaders(headers) : undefined)
}

/**
 * Single routing/auth authority for every opencode / opencode-go request. See
 * the module doc: splits `@zen-...` account suffixes, picks the key, resolves
 * the default key for bare models, de-qualifies the wire model id, sets
 * Authorization, and observes non-ok responses.
 */
async function routedZenProviderFetch(
  providerID: typeof PROVIDER_ID | typeof GO_PROVIDER_ID,
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const baseFetch = testFetch ?? fetch
  const headers = new Headers(init?.headers)
  const { body, model: requestedModel } = parseBodyModel(init)
  const route = await resolveZenRequest(requestedModel, bearerApiKey(headers), providerID)
  if (route.missingAccountID) {
    throw new Error(`Selected OpenCode account ${route.missingAccountID} is no longer available`)
  }
  const qualified = route.modelID !== requestedModel

  let nextInit = init
  if (route.apiKey) {
    headers.set("Authorization", `Bearer ${route.apiKey}`)
    nextInit = { ...init, headers }
  }
  if (qualified && route.modelID && body) {
    nextInit = { ...nextInit, body: JSON.stringify({ ...body, model: route.modelID }) }
  }

  const response = await baseFetch(url, nextInit)
  if (route.accountID && !response.ok) {
    pool.observe(route.accountID, response.status, retryAfterMs(response))
  }
  return withRoutedAccount(response, route.accountID)
}

export function zenProviderFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return routedZenProviderFetch(PROVIDER_ID, url, init)
}

export function zenGoProviderFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return routedZenProviderFetch(GO_PROVIDER_ID, url, init)
}

/**
 * Transport for an already-committed hosted account route.
 *
 * Unlike `zenProviderFetch`, this never selects: it reuses the bearer the
 * committed route binding already injected, refuses a request that carries a
 * different explicit `@zen-` account, keeps model de-qualification and
 * rate-limit observation, and reports the committed account back through
 * `withRoutedAccount`. A committed route can therefore never be replaced by
 * the pool default at the physical boundary.
 */
export function committedZenProviderFetch(
  accountID: string,
): (url: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    const baseFetch = testFetch ?? fetch
    const headers = new Headers(init?.headers)
    if (!bearerApiKey(headers)) {
      throw new Error("Committed OpenCode route is missing its selected credential")
    }
    const { body, model: requestedModel } = parseBodyModel(init)
    const split = typeof requestedModel === "string" ? resolveZenModelParts(requestedModel) : undefined
    if (split?.accountID && split.accountID !== accountID) {
      throw new Error(
        `Requested OpenCode account ${split.accountID} does not match the committed route account ${accountID}`,
      )
    }

    const dequalified = split?.accountID && body && split.baseModelID !== requestedModel
    const nextInit = dequalified ? { ...init, body: JSON.stringify({ ...body, model: split!.baseModelID }) } : init
    const response = await baseFetch(url, nextInit)
    if (!response.ok) pool.observe(accountID, response.status, retryAfterMs(response))
    return withRoutedAccount(response, accountID)
  }
}

/**
 * Transport for an already-committed Public hosted route.
 *
 * A committed Public route is credential-free and account-free, so this never
 * consults `resolveZenRequest`, the pool default, env, or configured provider
 * credentials: it pins the public sentinel the committed route already
 * selected. Model de-qualification is preserved, and an explicit `@zen-`
 * account suffix fails closed because Public has no account to authorize.
 */
export function committedPublicZenProviderFetch(
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const baseFetch = testFetch ?? fetch
  const headers = new Headers(init?.headers)
  if (bearerApiKey(headers) !== ZEN_PUBLIC_API_KEY) {
    throw new Error("Committed Public OpenCode route is missing its public credential")
  }
  const { body, model: requestedModel } = parseBodyModel(init)
  const split = typeof requestedModel === "string" ? resolveZenModelParts(requestedModel) : undefined
  if (split?.accountID) {
    throw new Error(`Requested OpenCode account ${split.accountID} cannot be authorized by a committed Public route`)
  }
  const dequalified = split && body && split.baseModelID !== requestedModel
  const nextInit = dequalified ? { ...init, body: JSON.stringify({ ...body, model: split!.baseModelID }) } : init
  // Public route health is owned by the shared route-health owner, and a Public
  // route has no account, so there is deliberately no pool observation here.
  return baseFetch(url, nextInit)
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

export function zenAccountModelAliases(modelID: string, modelName: string): Array<{ id: string; name: string }> {
  if (splitAccountModelID(modelID).accountID !== undefined) return []
  return pool.all().map((account) => ({
    id: `${modelID}@${account.id}`,
    name: `${modelName} (${account.label})`,
  }))
}

function mergeAccountModels(models: Record<string, Model>): Record<string, Model> {
  const accounts = pool.all()
  if (accounts.length === 0) return models
  const merged: Record<string, Model> = { ...models }
  for (const model of Object.values(models)) {
    for (const alias of zenAccountModelAliases(model.id, model.name)) {
      const exposedId = alias.id
      merged[exposedId] = {
        ...model,
        id: exposedId,
        name: alias.name,
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
      accounts: async () => {
        await syncVault()
        return pool.all().map((account) => ({ id: account.id, label: account.label }))
      },
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
      accounts: async () => {
        await syncVault()
        return pool.all().map((account) => ({ id: account.id, label: account.label }))
      },
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
  zenAdvertisedModelsCache = undefined
  zenAdvertisedModelsCacheLoaded = false
  zenAdvertisedModelsInFlight = undefined
}

/** Test-only: redirect durable hosted-catalog cache I/O to an isolated file. */
export function setTestZenCatalogCacheFile(value: string | undefined) {
  testZenCatalogCacheFile = value
  zenAdvertisedModelsCache = undefined
  zenAdvertisedModelsCacheLoaded = false
  zenAdvertisedModelsInFlight = undefined
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
  zenAdvertisedModelsCache = undefined
  zenAdvertisedModelsCacheLoaded = false
  zenAdvertisedModelsInFlight = undefined
  testZenCatalogCacheFile = undefined
  pool = new ZenAccountPool()
}
