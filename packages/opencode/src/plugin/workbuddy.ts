import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { createHash, randomBytes } from "crypto"
import { AdmissionError, type RefreshResult, type RunGenerationOpts } from "./workbuddy-governor"
import { workBuddyClientHeaders, workBuddyUserAgent } from "./workbuddy-identity"
import {
  isAccountForbidden,
  isBalanceExhausted,
  isValidationError,
  parseErrorCode,
  parseErrorMessage,
  WORKBUDDY_REQUEST_ILLEGAL_CODE,
  WORKBUDDY_THINKING_ROUNDTRIP_CODE,
} from "./workbuddy-model-entitlement"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import {
  AccountRegistry,
  AccountRouter,
  AccountVault,
  accountLabels,
  pollWorkBuddyOAuth,
  startWorkBuddyOAuth,
  type Credential,
  type WorkBuddyAccount,
  type WorkBuddyOAuthRealm,
} from "./workbuddy-accounts"

/**
 * Test-only transport/backend injection. This is deliberately NOT a production
 * relay/mirror surface: it exists solely so integration tests can substitute a
 * fake upstream without altering the real Tencent endpoint routing. Production
 * routing is driven exclusively by the credential's `auth.domain`.
 */
let injectedBackend: string | undefined
export function setTestBackend(url: string | undefined) {
  injectedBackend = url
}

/**
 * The local proxy hop is the user's own machine. It must NEVER be routed through
 * an HTTP(S) proxy (some environments set HTTP_PROXY/HTTPS_PROXY globally, and
 * undici will otherwise send 127.0.0.1 traffic through it, breaking the loopback
 * listener).
 *
 * Gateway hosts are included for parity with the official client: its
 * `CommonHeaderHttpInterceptor` sets `proxy = false` on every REST call, so
 * WorkBuddy traffic never traverses an environment proxy. Routing ours through
 * one would both change the egress IP seen by Tencent and hand a third-party
 * proxy the request metadata for no benefit.
 */
function ensureLoopbackProxyBypass() {
  const hosts = [
    "127.0.0.1",
    "localhost",
    "[::1]",
    "www.workbuddy.ai",
    "staging.workbuddy.ai",
    "www.workbuddy.cn",
    "www.codebuddy.cn",
    "www.codebuddy.ai",
    "copilot.tencent.com",
    "staging-copilot.tencent.com",
    "staging-codebuddy.tencent.com",
  ]
  for (const key of ["no_proxy", "NO_PROXY"]) {
    const cur = process.env[key]
    const set = new Set((cur ?? "").split(",").map((s) => s.trim()).filter(Boolean))
    let changed = false
    for (const h of hosts) if (!set.has(h)) { set.add(h); changed = true }
    if (changed) process.env[key] = [...set].join(",")
  }
}
ensureLoopbackProxyBypass()

// ---- lightweight profiling (enabled only with WB_PROFILE=1) ----
const WB_PROFILE = process.env.WB_PROFILE === "1"
const wbProfileData = new Map<string, number[]>()
function wbMark(name: string, start: number) {
  if (!WB_PROFILE) return
  const dur = performance.now() - start
  const arr = wbProfileData.get(name) ?? []
  arr.push(dur)
  wbProfileData.set(name, arr)
}
export function getWorkBuddyProfile(): Record<string, { count: number; totalMs: number; meanMs: number }> {
  const out: Record<string, any> = {}
  for (const [k, v] of wbProfileData) {
    const total = v.reduce((a, b) => a + b, 0)
    out[k] = { count: v.length, totalMs: total, meanMs: v.length ? total / v.length : 0 }
  }
  return out
}
export function resetWorkBuddyProfile() { wbProfileData.clear() }

/**
 * Tencent WorkBuddy / CodeBuddy provider plugin.
 *
 * Exposes the models behind an already-authenticated WorkBuddy / CodeBuddy desktop
 * session to OpenCode as a standard OpenAI-compatible provider.
 *
 *   OpenCode -> @ai-sdk/openai-compatible -> 127.0.0.1:<ephemeral>/v1 -> Tencent
 *
 * The local hop is not decoration. The Tencent backend cannot be consumed by a
 * stock OpenAI client, all four points verified live on 2026-08-29:
 *
 *   1. Non-streaming is rejected (code 11101, "Non-stream chat request is
 *      currently not supported"), but OpenCode issues non-streaming calls for
 *      titles/summaries. So we always stream upstream and fold to a single
 *      completion when the client asked for one.
 *   2. messages[0] MUST have role "system" (else code 11128).
 *   3. Every delta carries `tool_calls: []`, including pure reasoning deltas.
 *      Some translators treat the key's presence as meaningful and terminate or
 *      reopen message state, so empty arrays are stripped.
 *   4. Reasoning arrives as a separate `reasoning_content` delta.
 *
 * Auth delegation: the plugin never extracts or forges tokens. It imports the
 * current desktop session or enrolls through Tencent's normal OAuth flow, then
 * refreshes through Tencent's own `/v2/plugin/auth/token/refresh` endpoint.
 * OpenFork persists only the user-authorized account records in its own
 * per-UID vault; it never writes back to the official desktop `.info` file.
 *
 * Security: loopback-only listener, per-process bearer token, and tokens are
 * never logged. The desktop credential is read only for additive discovery import
 * or the explicit "Import current desktop login" action.
 */

const PROVIDER_ID = "workbuddy"
const NPM = "@ai-sdk/openai-compatible"
/**
 * Official desktop user agent (see workbuddy-identity.ts). The previous
 * self-branded `codebuddy2openai/2.0` string was the loudest
 * "third-party reverse proxy" signal we emitted; the composed first-party UA
 * is also accepted by the `/v3/config` gate (verified live 2026-09-16).
 */
const USER_AGENT = workBuddyUserAgent()
const REQUEST_TIMEOUT_MS = 5 * 60_000
const DISCOVERY_TTL_MS = 5 * 60_000

/**
 * Preferred loopback port for the local proxy hop.
 *
 * This MUST be stable rather than ephemeral. Every emitted model carries
 * `api.url = http://127.0.0.1:<port>/v1`, and that string is baked into the
 * model objects OpenCode keeps and dispatches chat completions against. With an
 * ephemeral port, a proxy restart (process reload, listener crash) rebinds on a
 * DIFFERENT port while every cached model still points at the dead one, so
 * every request fails with ECONNREFUSED and retries forever.
 *
 * Falling back to an ephemeral port on EADDRINUSE keeps two concurrent
 * OpenCode instances working; the second instance simply advertises its own
 * ephemeral port to its own models.
 */
const PROXY_PORT = 19_731

/** Stable bearer for the loopback hop — rotated only on process restart. */
let cachedProxyToken: string | undefined
function proxyToken(): string {
  if (!cachedProxyToken) cachedProxyToken = randomBytes(32).toString("hex")
  return cachedProxyToken
}

/** Extra listeners kept alive for stale `api.url`s left in cached models. */
const extraServers = new Map<number, Server>()

async function ensureExtraServer(port: number, token: string): Promise<void> {
  if (extraServers.has(port)) return
  const server = createServer(makeProxyHandler(token))
  server.on("close", () => extraServers.delete(port))
  server.on("error", () => {
    extraServers.delete(port)
    try { server.close() } catch {}
  })
  const bound = await listen(server, "127.0.0.1", port).catch(() => 0)
  if (!bound) {
    server.removeAllListeners()
    try { server.close() } catch {}
    return
  }
  extraServers.set(port, server)
}

/**
 * Product-configuration endpoint that IS the model catalog.
 *
 * Verified live 2026-08-29 against the official WorkBuddy desktop CLI
 * (`resources/app.asar.unpacked/cli/dist/codebuddy.js`): the CLI resolves its
 * model list from `GET {backend}/v3/config` (CloudProductProvider), and its
 * enterprise override from
 * `GET /console/enterprises/{enterpriseId}/config/models` (ModelsProductProvider).
 *
 * The endpoint is User-Agent gated. A generic UA is answered with a trimmed
 * payload containing only `enterpriseId` and a couple of feature flags and NO
 * models; a first-party UA returns the full product configuration
 * (`data.models` + `data.agents`). Discovery therefore has to present the
 * desktop's own composed UA (see workbuddy-identity.ts), verified live
 * 2026-09-16 to return the full catalog.
 *
 * The previous `/console/enterprises/personal/models` path was never a real
 * route - it 500s at the gateway - which is why OpenFork fell back to a
 * hardcoded list that drifted from what the app shows.
 */
const CONFIG_PATH = "/v3/config"

/**
 * Realm routing is driven by the credential's own `auth.domain`.
 * Verified: a `www.workbuddy.ai` (Global) credential is rejected by
 * `copilot.tencent.com` with 401, and vice versa - the two are separate backends.
 */
const BACKENDS: Record<string, string> = {
  "www.workbuddy.ai": "https://www.workbuddy.ai",
  "staging.workbuddy.ai": "https://staging.workbuddy.ai",
  "www.workbuddy.cn": "https://copilot.tencent.com",
  "www.codebuddy.cn": "https://copilot.tencent.com",
}
const DEFAULT_BACKEND = "https://www.workbuddy.ai"

type CatalogEntry = {
  id: string
  name: string
  family: string
  context: number
  /** Selectable context sizes advertised by WorkBuddy, including the default. */
  contextWindows?: number[]
  output: number
  reasoning: boolean
  release: string
  attachment: boolean
  /**
   * Consumption rate in WorkBuddy credits per request, as published by the
   * catalog (`credits: "x0.79 credits"` / `"x3.47"`). `0` means "rate not
   * published" and is distinct from a genuine `0x` free promotion — see
   * `creditsFree` below.
   */
  credits: number
  /** True when the catalog advertises the model as currently free (`"x0.00"`). */
  creditsFree: boolean
  /** The catalog's raw credit string, kept for display. */
  creditsLabel: string
  /** Active promotion badge, e.g. "Free now". */
  promotionLabel?: string
}

const CONTEXT_MODEL_MARKER = "#ctx-"

function contextModelId(modelID: string, context: number): string {
  return `${modelID}${CONTEXT_MODEL_MARKER}${context}`
}

export function decodeWorkBuddyContextModel(modelID: string): { model: string; contextWindowTokens?: number } {
  const match = modelID.match(/^(.*)#ctx-(\d+)$/)
  if (!match) return { model: modelID }
  const contextWindowTokens = Number(match[2])
  return Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0
    ? { model: match[1]!, contextWindowTokens }
    : { model: modelID }
}

function formatContextWindow(context: number): string {
  if (context >= 1_000_000) return `${context / 1_000_000}M context`
  if (context >= 1_000) return `${Math.round(context / 1_000)}K context`
  return `${context} context`
}

function contextWindowsFor(entry: CatalogEntry): number[] {
  const values = [entry.context, ...(entry.contextWindows ?? [])].filter((value) => Number.isSafeInteger(value) && value > 0)
  return [...new Set(values)].sort((a, b) => a - b)
}

/**
 * Static fallback catalog. Ids confirmed available on the WorkBuddy Global realm
 * by live probing (2026-08-29). Hy3 and DeepSeek-v4 ids are CN-only. Live
 * discovery (issue #3) overlays this; static is the last-resort fallback.
 */
const GLOBAL_CATALOG: CatalogEntry[] = [
  { id: "hy4-preview", name: "Hy4 Preview", family: "hunyuan", context: 1_048_576, output: 65_536, reasoning: true, release: "2026-08-28", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "glm-5.2", name: "GLM-5.2", family: "glm", context: 131_072, output: 32_768, reasoning: true, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "glm-5.1", name: "GLM-5.1", family: "glm", context: 131_072, output: 32_768, reasoning: true, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "glm-5v-turbo", name: "GLM-5V Turbo", family: "glm", context: 131_072, output: 32_768, reasoning: false, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "kimi-k2.6", name: "Kimi K2.6", family: "kimi", context: 131_072, output: 32_768, reasoning: true, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "kimi-k2.5", name: "Kimi K2.5", family: "kimi", context: 131_072, output: 32_768, reasoning: true, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "minimax-m3", name: "MiniMax M3", family: "minimax", context: 131_072, output: 32_768, reasoning: true, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
]

/** CN realm spelling differs; only used when the credential is a CN credential. */
const CN_CATALOG: CatalogEntry[] = [
  { id: "hy4-preview", name: "Hy4 Preview", family: "hunyuan", context: 1_048_576, output: 65_536, reasoning: true, release: "2026-08-28", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "hy3-preview-agent", name: "Hy3 Preview Agent", family: "hunyuan", context: 131_072, output: 32_768, reasoning: true, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "glm-5.2", name: "GLM-5.2", family: "glm", context: 131_072, output: 32_768, reasoning: true, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "deepseek", context: 131_072, output: 32_768, reasoning: true, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", family: "deepseek", context: 131_072, output: 32_768, reasoning: false, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
  { id: "minimax-m3-pay", name: "MiniMax M3", family: "minimax", context: 131_072, output: 32_768, reasoning: true, release: "", attachment: false, credits: 0, creditsFree: false, creditsLabel: "" },
]

// ---------------------------------------------------------------- multi-account

/** All discovered accounts and a session-affine router live for this provider. */
let accountRegistry = new AccountRegistry()
let accountRouter = new AccountRouter({ registry: accountRegistry })

/** Test-only: isolate the account vault from the user's real WorkBuddy store. */
export function setTestAccountStore(root: string | undefined) {
  if (!root) return
  accountRegistry = new AccountRegistry({ vault: new AccountVault(root), persistenceDir: `${root}/state` })
  accountRouter = new AccountRouter({ registry: accountRegistry })
}

/** Live, non-secret account/model quota snapshot consumed by the Limits adapter. */
export function workBuddyLimitSnapshot(now = Date.now()) {
  const accounts = accountRegistry.all()
  const labels = accountLabels(accounts)
  return accounts.map((account) => ({
    accountId: account.id,
    label: labels.get(account.id) ?? account.id,
    models: account.governor.modelReports(now),
  }))
}

/**
 * Pushed by the quota adapter (`quota/providers/workbuddy.ts`) after a fresh
 * package-balance read succeeds. Tencent's backend runs its own
 * Basic+Gift+Extra balance check before every generation regardless of a
 * model's published rate, so `AccountRouter.select()` needs this cached
 * figure to steer automatic (non-pinned) requests away from a known-drained
 * account instead of discovering it the hard way with a wasted 402.
 */
export function recordWorkBuddyPackageCredits(accountId: string, combinedRemaining: number) {
  accountRegistry.get(accountId)?.governor.setPackageCredits(combinedRemaining)
}

function backendFor(cred: Credential): string {
  // Production routing is driven solely by the credential's auth.domain. The
  // only override is the test-only injected backend (setTestBackend).
  if (injectedBackend) return injectedBackend
  return BACKENDS[cred.domain] ?? DEFAULT_BACKEND
}

function isExpired(cred: Credential): boolean {
  // Treat a missing/zero expiry as unknown and let the backend decide.
  return cred.expiresAt > 0 && Date.now() >= cred.expiresAt - 60_000
}

/** Headers for an upstream POST. Never log the result of this function. */
export function upstreamHeaders(cred: Credential, extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    Authorization: `Bearer ${cred.accessToken}`,
    ...(cred.uid ? { "X-User-Id": cred.uid } : {}),
    // The official client omits identity headers when the value is empty;
    // sending `X-Enterprise-Id: ""` was a gratuitous anomaly.
    ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId, "X-Tenant-Id": cred.enterpriseId } : {}),
    ...(cred.domain ? { "X-Domain": cred.domain } : {}),
    "User-Agent": USER_AGENT,
    ...workBuddyClientHeaders(),
    ...extra,
  }
}

/** GET variant: no body, so no Content-Type (official clients omit it). */
export function upstreamGetHeaders(cred: Credential, extra?: Record<string, string>): Record<string, string> {
  const headers = upstreamHeaders(cred, extra)
  delete headers["Content-Type"]
  return headers
}

/** Random UUID-shaped value derived from a seed. */
function deterministicUuid(seed: string): string {
  const bytes = createHash("sha1").update(seed).digest("hex").slice(0, 32).split("")
  bytes[12] = "5"
  bytes[16] = ((parseInt(bytes[16]!, 16) & 0x3) | 0x8).toString(16)
  const hex = bytes.join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * `X-Request-ID`, exactly as the official `CommonHeaderHttpInterceptor`
 * stamps it on every REST call (32 hex chars; falls back to the trace id when
 * one exists). `X-Trace-ID` is deliberately NOT sent: the official client only
 * adds it when a real trace context is active, and fabricating one would claim
 * tracing participation we do not have.
 */
export function upstreamTraceHeaders(): Record<string, string> {
  return { "X-Request-ID": randomBytes(16).toString("hex") }
}

/**
 * Conversation-lifecycle headers every official model request carries
 * (`X-Conversation-ID`, `X-Conversation-Request-ID`,
 * `X-Conversation-Message-ID`, `X-Request-ID`, `X-Agent-Intent`,
 * `X-Agent-Type`). The official client generates these locally from its
 * session/message UUIDs, so ours follow the same scheme: conversation
 * identity is stable per (account, OpenCode session), message identity per
 * request.
 */
export function upstreamConversationHeaders(accountId: string, session: string): Record<string, string> {
  const messageId = randomBytes(16).toString("hex")
  return {
    "X-Conversation-ID": deterministicUuid(`${accountId}:${session}`),
    "X-Conversation-Request-ID": deterministicUuid(`${accountId}:${session}:${messageId}`),
    "X-Conversation-Message-ID": messageId,
    "X-Request-ID": messageId,
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
  }
}

// --- refresh (singleflight, account-local) ----------------------------------

/**
 * Result of one credential re-auth attempt against Tencent's refresh endpoint.
 *
 * `rejected` is deliberately distinct from `transient`: the backend answered
 * 401/403 on `X-Refresh-Token`, which means the saved refresh token is dead.
 * Network/5xx/timeout failures must never be persisted as AUTH_INVALID — that
 * is how a network blip becomes a phantom sign-out.
 */
export type AccountRefreshOutcome = "refreshed" | "rejected" | "transient" | "unavailable"

const refreshInflight = new Map<string, Promise<AccountRefreshOutcome>>()

/**
 * Headers for the refresh call, mirroring the official client exactly
 * (`cli/dist/codebuddy.js`, `AccountScopedExternalLinkAuthenticationProvider
 * .refreshSession`): X-Domain + X-Refresh-Token + X-Auth-Refresh-Source and
 * NO `Authorization`. The stale bearer is the thing being replaced; sending
 * it can trip the backend's own 401 gate before X-Refresh-Token is read.
 */
function refreshHeaders(cred: Credential): Record<string, string> {
  const headers = upstreamHeaders(cred, {
    "X-Refresh-Token": cred.refreshToken,
    "X-Auth-Refresh-Source": "plugin",
    ...upstreamTraceHeaders(),
  })
  // The stale bearer is the thing being replaced; the official client never
  // sends Authorization on refresh.
  delete headers.Authorization
  return headers
}

/**
 * Renew this account's access token from its saved refresh token, persisting
 * the rotated pair to the OpenFork vault. The desktop `.info` file is never
 * written. Failure classification follows the official client's own mapping
 * (`isAuthenticationInvalidError`): 401/403 on the refresh call is the only
 * "rejected" verdict; everything else is transient.
 */
async function refresh(account: WorkBuddyAccount): Promise<AccountRefreshOutcome> {
  const cred = account.credential
  // The official WorkBuddy platform treats "no refresh token" as a valid
  // state (ApiKey-style credentials) and skips token renewal entirely.
  if (!cred.refreshToken) return "unavailable"
  let res: Response
  try {
    res = await fetch(`${backendFor(cred)}/v2/plugin/auth/token/refresh`, {
      method: "POST",
      headers: refreshHeaders(cred),
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return "transient"
  }
  if (res.status === 401 || res.status === 403) return "rejected"
  if (!res.ok) return "transient"
  const body = (await res.json().catch(() => undefined)) as any
  const token = body?.data?.accessToken
  // A 200 without a token is not evidence the refresh token is dead (the
  // official client raises a SignError here, not UnauthorizedError).
  if (typeof token !== "string" || !token) return "transient"
  cred.accessToken = token
  if (typeof body?.data?.refreshToken === "string" && body.data.refreshToken) {
    cred.refreshToken = body.data.refreshToken
  }
  if (typeof body?.data?.expiresIn === "number" && body.data.expiresIn > 0) {
    cred.expiresAt = Date.now() + body.data.expiresIn * 1000
  }
  // The OpenFork vault, not the desktop .info file, owns this account's
  // refresh-token lifecycle. This prevents the next registry scan from
  // replacing a fresh in-memory token with stale desktop contents.
  accountRegistry.persistCredential(account)
  return "refreshed"
}

/** Singleflight: concurrent generations share one refresh for ONE account. */
function singleflightRefresh(account: WorkBuddyAccount): Promise<AccountRefreshOutcome> {
  const key = account.id
  const existing = refreshInflight.get(key)
  if (existing) return existing
  const p = refresh(account).finally(() => refreshInflight.delete(key))
  refreshInflight.set(key, p)
  return p
}

/**
 * The plugin's single owner for automatic credential re-auth: every refresh
 * consumer collapses onto one upstream call per account, and the vault always
 * reflects the token the transports observe. A refresh token the backend has
 * rejected cannot be renewed programmatically — Tencent's login is an
 * interactive browser OAuth state flow — so that case is surfaced as a clear
 * error and the explicit "Add WorkBuddy account" / desktop-import actions stay
 * the user-facing recovery path.
 */
export function reauthenticateAccount(account: WorkBuddyAccount): Promise<AccountRefreshOutcome> {
  return singleflightRefresh(account)
}

/** Governor-facing adapter: transient failures never imply a rejected token. */
function toRefreshResult(outcome: AccountRefreshOutcome): RefreshResult {
  return outcome === "refreshed" ? { ok: true } : { ok: false, rejected: outcome === "rejected" }
}

// ------------------------------------------------------------------- sse / quirks

/** Drop an empty tool_calls array; keep anything that carries a real call. */
function normalizeDelta(delta: any): any {
  if (!delta || typeof delta !== "object") return delta
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) {
    const next = { ...delta }
    delete next.tool_calls
    return next
  }
  return delta
}

function normalizeChunk(chunk: any): any {
  if (!chunk || !Array.isArray(chunk.choices)) return chunk
  return {
    ...chunk,
    choices: chunk.choices.map((choice: any) =>
      choice && choice.delta ? { ...choice, delta: normalizeDelta(choice.delta) } : choice,
    ),
  }
}

function* parseSSE(buffer: string): Generator<[any, string]> {
  let rest = buffer
  for (;;) {
    const idx = rest.indexOf("\n")
    if (idx === -1) break
    const line = rest.slice(0, idx).trim()
    rest = rest.slice(idx + 1)
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    try {
      yield [normalizeChunk(JSON.parse(data)), rest]
    } catch {
      // ignore malformed frame
    }
  }
  return
}

type Accumulated = {
  id: string
  model: string
  created: number
  content: string
  reasoning: string
  finishReason: string | null
  usage: any
  toolCalls: Map<number, { id?: string; name?: string; args: string }>
}

function newAccumulator(requestedModel: string): Accumulated {
  return {
    id: "",
    model: requestedModel,
    created: Math.floor(Date.now() / 1000),
    content: "",
    reasoning: "",
    finishReason: null,
    usage: null,
    toolCalls: new Map(),
  }
}

function absorb(acc: Accumulated, chunk: any) {
  if (!chunk || typeof chunk !== "object") return
  if (chunk.id) acc.id = chunk.id
  if (chunk.model) acc.model = chunk.model
  if (chunk.created) acc.created = chunk.created
  if (chunk.usage) acc.usage = chunk.usage
  for (const choice of chunk.choices ?? []) {
    if (choice?.finish_reason) acc.finishReason = choice.finish_reason
    const delta = choice?.delta
    if (!delta) continue
    if (typeof delta.content === "string") acc.content += delta.content
    if (typeof delta.reasoning_content === "string") acc.reasoning += delta.reasoning_content
    for (const call of delta.tool_calls ?? []) {
      const index = call?.index ?? 0
      const slot = acc.toolCalls.get(index) ?? { args: "" }
      if (call.id) slot.id = call.id
      if (call.function?.name) slot.name = call.function.name
      if (typeof call.function?.arguments === "string") slot.args += call.function.arguments
      acc.toolCalls.set(index, slot)
    }
  }
}

function completionFrom(acc: Accumulated, requestedModel: string) {
  const toolCalls = [...acc.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      index,
      id: call.id,
      type: "function" as const,
      function: { name: call.name ?? "", arguments: call.args },
    }))
  const finishReason = toolCalls.length > 0 ? "tool_calls" : (acc.finishReason ?? "stop")
  return {
    id: acc.id || `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: acc.created,
    model: acc.model || requestedModel,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: finishReason,
        message: {
          role: "assistant",
          content: acc.content,
          ...(acc.reasoning ? { reasoning_content: acc.reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: acc.usage ?? undefined,
  }
}

// --------------------------------------------------------------- error semantics
//
// Tencent's numeric `code` is authoritative; the HTTP status is transport.
// Classification follows the official client's own taxonomy
// (cli/dist/codebuddy.js `classifyErrorDetail`): 11140/11142 are
// `auth_forbidden` (account-level restriction, HTTP 403), 401 is
// `auth_expired`, and 11155 is a request-shape validation rejection (HTTP
// 400). 11140 is NOT request-shaped: live bisection 2026-09-16 showed an
// affected account failing every model — including a minimal system+user
// body — while other accounts succeeded with identical requests, and a
// freshly refreshed token pair still received 11140. Branching on HTTP
// status alone would misclassify it either as "not authorized" (wrong: the
// session endpoint answers 200) or as an illegal body (wrong: only switching
// account or clearing the Tencent restriction helps). Every branch below
// therefore checks the Tencent code FIRST.

type UpstreamFailure = { status: number; code?: number; message: string; raw: string }

export function classify(status: number, raw: string): UpstreamFailure {
  return {
    status,
    code: parseErrorCode(raw),
    message: parseErrorMessage(raw, `upstream returned HTTP ${status}`),
    raw,
  }
}

export type WorkBuddyErrorContext = {
  /** Disambiguated account label (nickname/email) when the failing account is known. */
  accountLabel?: string
  /** Stable account id tail for disambiguation when nicknames collide. */
  accountId?: string
  /** Bare upstream model id (account suffix and #ctx- alias already stripped). */
  model?: string
  /** True when a token refresh was attempted for this generation and failed. */
  refreshAttempted?: boolean
}

/** Map backend conditions onto distinct OpenCode-relevant classes. */
export function toClientError(
  failure: UpstreamFailure,
  ctx: WorkBuddyErrorContext = {},
): { status: number; body: any } {
  const detail = failure.code !== undefined ? `[${failure.code}] ${failure.message}` : failure.message
  const account = ctx.accountLabel ?? (ctx.accountId ? `account …${ctx.accountId.slice(-4)}` : "this account")
  const model = ctx.model ? ` for model ${ctx.model}` : ""
  if (isAccountForbidden(failure.raw)) {
    return {
      status: 403,
      body: {
        error: {
          message:
            `WorkBuddy has restricted ${account} (code ${failure.code ?? WORKBUDDY_REQUEST_ILLEGAL_CODE}, auth_forbidden)${model}. ` +
            `This is a Tencent-side account restriction, not a request or token problem — verified live: the account fails ` +
            `every model (even a minimal request) while other signed-in accounts succeed, and re-authenticating does not clear it. ` +
            `Switch to another account (model@wb-…) or contact WorkBuddy support about the restriction. ${detail}`,
          type: "account_forbidden",
        },
      },
    }
  }
  if (failure.code === WORKBUDDY_THINKING_ROUNDTRIP_CODE || (/reasoning_content/i.test(failure.raw) && /thinking mode/i.test(failure.raw))) {
    return {
      status: 400,
      body: {
        error: {
          message:
            `WorkBuddy requires the previous turn's reasoning to be echoed back in thinking mode (code 11155)${model} on ${account}. ` +
            `OpenFork repairs history automatically before forwarding — if you see this, the previous turn genuinely ` +
            `carried no reasoning (e.g. a reason-free tool-call turn) or history was rewritten mid-session ` +
            `(model switch, compaction). ${detail} Retry the turn; if it persists on a thinking model, report the ` +
            `model id and whether the previous turn used tools.`,
          type: "invalid_request_error",
        },
      },
    }
  }
  if (failure.status === 401 || failure.status === 403) {
    const refreshNote = ctx.refreshAttempted
      ? "A token refresh was attempted and failed — OpenFork's saved vault token for this account is stale. "
      : ""
    return {
      status: 401,
      body: {
        error: {
          message:
            `WorkBuddy session is not authorized for ${account}${model}. ${refreshNote}${detail} ` +
            `Re-enroll that account ("Add WorkBuddy account") or run "Import current WorkBuddy desktop login", then retry. ` +
            `Opening the desktop app alone does not refresh OpenFork's saved vault token.`,
          type: "authentication_error",
        },
      },
    }
  }
  if (failure.status === 402 || isBalanceExhausted(failure.raw) || /insufficient credit|积分不足|credit/i.test(failure.message)) {
    return {
      status: 402,
      body: { error: { message: `WorkBuddy credits exhausted for ${account}${model}. ${detail}`, type: "quota_exceeded" } },
    }
  }
  if (failure.status === 429) {
    return { status: 429, body: { error: { message: `WorkBuddy rate limit reached for ${account}${model}. ${detail}`, type: "rate_limit_error" } } }
  }
  if (/model \[.*\](service info|not found|is invalid)|service info/i.test(failure.message)) {
    return { status: 404, body: { error: { message: `Model${ctx.model ? ` ${ctx.model}` : ""} is not available on ${account}. ${detail}`, type: "model_not_found" } } }
  }
  if (failure.status >= 500) {
    return { status: 502, body: { error: { message: `WorkBuddy upstream failure for ${account}${model}. ${detail}`, type: "upstream_error" } } }
  }
  return { status: failure.status || 502, body: { error: { message: `WorkBuddy request failed for ${account}${model}. ${detail}`, type: "upstream_error" } } }
}

/**
 * Build the Tencent `/v2/chat/completions` body.
 *
 * Tencent's validator is strict (it rejects non-streaming with 11101 and a
 * missing leading system message with 11128). Only fields proven against the
 * live backend by the probe scripts (`script/probe-*.mjs`: model, messages,
 * stream, stream_options, max_tokens, tools, tool_choice) plus the standard
 * OpenAI sampling fields are forwarded. Everything else the AI SDK may send —
 * `reasoning_effort`, `response_format`, `user`, and OpenFork's own
 * `context_window_tokens` routing hint (`#ctx-` alias) — is deliberately
 * dropped; context selection stays a client-side `limit.context` on the
 * exposed Model and never goes on the wire.
 */
const UPSTREAM_PASSTHROUGH = [
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "max_tokens",
  "max_completion_tokens",
] as const

export function buildUpstreamBody(payload: any, messages: any[], requestedModel: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: requestedModel,
    messages,
    // Non-streaming is rejected upstream, so always stream and fold if needed.
    stream: true,
    stream_options: { include_usage: true },
  }
  for (const key of UPSTREAM_PASSTHROUGH) {
    if (payload?.[key] !== undefined) body[key] = payload[key]
  }
  return body
}

// -------------------------------------------- thinking-mode history repair (11155)
//
// Tencent requires the previous turn's `reasoning_content` to be echoed back
// whenever the conversation is in thinking mode (code 11155; mirrors
// DeepSeek's echo requirement — QwenLM/qwen-code#3579, Tencent ask/2211416,
// where the field is specifically lost around tool-call turns). The standard
// chain preserves it (stored reasoning part -> AI SDK `reasoning_content` ->
// verbatim forward), but three shapes arrive without it and would 11155:
//
//   1. tool-call turns the model answered with no thinking text (no
//      `reasoning_content` was ever produced, yet thinking mode is on);
//   2. history rewritten mid-session (model/account switch degrades reasoning
//      to text in `toModelMessagesEffect`'s differentModel path; compaction
//      summaries never had thinking);
//   3. exotic clients sending the thinking under a non-canonical key.
//
// The proxy owns the Tencent translation, so it repairs here — one point,
// downstream of every core path — instead of touching the shared core
// projection every provider relies on. The repair is strictly additive and
// gated on positive thinking-mode evidence, so non-thinking traffic is
// byte-identical to before.

/** True when the catalog marks this bare model id as a reasoning model. */
export function isReasoningModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  for (const cache of discoveryCache.values()) {
    for (const entry of cache.catalog) {
      if (entry.id.toLowerCase() === id && entry.reasoning) return true
    }
  }
  for (const entry of [...GLOBAL_CATALOG, ...CN_CATALOG]) {
    if (entry.id.toLowerCase() === id && entry.reasoning) return true
  }
  return false
}

/** Test-only: prime the live-catalog side of `isReasoningModel`. */
export function setDiscoveryCacheForTest(accountId: string, catalog: CatalogEntry[]): void {
  discoveryCache.set(accountId, { at: Date.now(), catalog })
}

/**
 * Positive thinking-mode evidence: some assistant turn already carries
 * `reasoning_content`, or the requested model is a known reasoning model.
 * Both directions matter — the echo case (1) and the thinker-with-silent-
 * history case (2) above.
 */
export function detectThinkingMode(messages: any[], requestedModel: string): boolean {
  if (isReasoningModel(requestedModel)) return true
  return messages.some(
    (m) => m?.role === "assistant" && typeof m?.reasoning_content === "string",
  )
}

/**
 * Ensure every assistant message carries `reasoning_content`. Existing values
 * are preserved byte-identical (never rewritten); a non-canonical `reasoning`
 * string is adopted when present; otherwise the field defaults to `""`.
 * Non-assistant messages and message order are untouched, so the 11128
 * system-first invariant cannot shift.
 */
export function repairHistoryForThinking(messages: any[]): any[] {
  return messages.map((m) => {
    if (!m || m.role !== "assistant" || typeof m.reasoning_content === "string") return m
    const adopted = typeof (m as any).reasoning === "string" ? (m as any).reasoning : ""
    return { ...m, reasoning_content: adopted }
  })
}

// ------------------------------------------------------------------ http server

type ProxyState = {
  server: Server
  port: number
  token: string
}

let state: ProxyState | undefined

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...(headers ?? {}),
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

async function listen(server: Server, host: string, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    // Loopback only. This proxy fronts a personal entitlement and must never
    // be reachable from another machine.
    server.listen(port, host, () => {
      const addr = server.address()
      resolve(typeof addr === "object" && addr ? addr.port : 0)
    })
  })
}

// --- live model discovery (issue #3), cache + fallback ------------------------

const discoveryCache = new Map<string, { at: number; catalog: CatalogEntry[] }>()

/**
 * Live catalog from the product-configuration endpoint. Best-effort; returns
 * null on any failure so the caller can fall back to last-known-good then
 * static.
 *
 * Shape (verified live 2026-08-29): `data.models` is the universe and
 * `data.agents[name=="cli"].models` is the CLI-allowed subset. We intersect
 * them so OpenFork exposes exactly what the WorkBuddy app offers the CLI.
 *
 * The endpoint is UA-gated: it must be called with the CLI's own
 * `workbuddy-ai/<version>` UA or it answers with a payload that has no models.
 */
async function discoverCatalog(cred: Credential): Promise<CatalogEntry[] | null> {
  return (await discoverCatalogDetailed(cred)).entries
}

/**
 * Catalog discovery that also reports whether every attempted source rejected
 * the credential (401/403) as opposed to merely failing (network, 5xx, empty
 * payload). The boolean is the demand-driven auth signal consumed by
 * `catalogFor` → `validateAccountAuth`: no new probe endpoint, no timers, no
 * generation entitlement burned.
 */
async function discoverCatalogDetailed(cred: Credential): Promise<{
  entries: CatalogEntry[] | null
  unauthorized: boolean
}> {
  // Parallelize the two catalog sources - worst-case 15s not 30s
  const [fromConfig, fromEnterprise] = await Promise.all([discoverFromConfig(cred), discoverFromEnterprise(cred)])
  const attempted = cred.enterpriseId ? [fromConfig, fromEnterprise] : [fromConfig]
  return {
    entries: fromConfig.entries ?? fromEnterprise.entries,
    unauthorized: attempted.length > 0 && attempted.every((source) => source.unauthorized),
  }
}

/**
 * Live per-model consumption rates, keyed by model id.
 *
 * Exported for the WorkBuddy quota adapter so the model picker can turn "this
 * account has N credits left" into "≈ M requests on this model". It is a
 * read-only view of the same discovery the provider uses, so the rate shown in
 * the picker can never drift from the catalog that produced the model list.
 *
 * Best-effort: returns an empty map when the catalog is unreachable rather than
 * throwing — a missing rate degrades the picker to no bar, never to an error.
 */
export async function discoverWorkBuddyCatalog(
  cred: Credential,
): Promise<Map<string, { credits: number; creditsFree: boolean; creditsLabel: string; promotionLabel?: string }>> {
  const catalog = await discoverCatalog(cred).catch(() => null)
  const out = new Map<string, { credits: number; creditsFree: boolean; creditsLabel: string; promotionLabel?: string }>()
  for (const entry of catalog ?? []) {
    out.set(entry.id, {
      credits: entry.credits,
      creditsFree: entry.creditsFree,
      creditsLabel: entry.creditsLabel,
      ...(entry.promotionLabel ? { promotionLabel: entry.promotionLabel } : {}),
    })
  }
  return out
}

/**
 * Parse the shared product-configuration payload. Both the global `/v3/config`
 * and the per-enterprise `/console/enterprises/{id}/config/models` answer with
 * the same product schema, so one parser serves both.
 */
function parseConfigPayload(json: any): CatalogEntry[] | null {
  const _pcStart = WB_PROFILE ? performance.now() : 0
  const data = json?.data
  // `/v3/config` nests models under `data`; the enterprise route returns the
  // model array directly as `data`.
  const allModels: any[] = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : []
  if (!allModels.length) return null

  const agents: any[] = Array.isArray(data?.agents) ? data.agents : []
  const cli = agents.find((a) => a?.name === "cli") ?? {}
  const cliIds = new Set<string>(
    (cli?.models ?? []).map((m: any) => (typeof m === "string" ? m : m?.id)).filter(Boolean),
  )
  const promotions = promotionLabels(data?.modelPromotions)

  const out: CatalogEntry[] = []
  for (const m of allModels) {
    if (!m || m?.disabled === true || m?.enabled === false) continue
    const id = m?.id ?? m?.modelId
    if (typeof id !== "string" || !id) continue
    // Skipped only when the payload carries an agent section; a present but
    // empty CLI list would otherwise hide every model.
    if (cliIds.size && !cliIds.has(id)) continue
    const credits = parseCreditRate(m?.credits)
    const context = Number(m?.maxInputTokens ?? m?.contextWindow?.defaultLength ?? m?.maxAllowedSize ?? 0) || 0
    const contextWindows = parseWorkBuddyContextWindows(m?.contextWindow, context)
    out.push({
      id,
      name: typeof m?.name === "string" && m.name ? m.name : id,
      family: familyFor(id, m?.vendor),
      context,
      ...(contextWindows.length > 0 ? { contextWindows } : {}),
      output: Number(m?.maxOutputTokens ?? m?.maxTokens ?? 0) || 0,
      reasoning: Boolean(m?.supportsReasoning ?? m?.reasoning),
      release: typeof m?.release === "string" ? m.release : "",
      attachment: Boolean(m?.supportsImages ?? m?.supportsImage),
      credits: credits.rate,
      creditsFree: credits.free,
      creditsLabel: credits.label,
      ...(promotions.get(id) ? { promotionLabel: promotions.get(id) } : {}),
    })
  }
  const ret = out.length ? out : null
  if (WB_PROFILE) wbMark("parseConfigPayload", _pcStart)
  return ret
}

/** Extract only explicit selectable sizes; min/max bounds are not choices. */
export function parseWorkBuddyContextWindows(raw: unknown, fallback: number): number[] {
  const _pwcwStart = WB_PROFILE ? performance.now() : 0
  const values: number[] = []
  const add = (value: unknown) => {
    const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
    if (Number.isSafeInteger(n) && n > 0) values.push(n)
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>
        add(record.tokens ?? record.tokenCount ?? record.length ?? record.size ?? record.value)
      } else add(item)
    }
  } else if (raw && typeof raw === "object") {
    const object = raw as Record<string, unknown>
    for (const key of [
      "supportedLengths",
      "allowedLengths",
      "availableLengths",
      "lengths",
      "windowSizes",
      "contextSizes",
      "supported",
      "presets",
      "choices",
      "values",
    ]) {
      const list = object[key]
      if (Array.isArray(list)) for (const item of list) {
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>
          add(record.tokens ?? record.tokenCount ?? record.length ?? record.size ?? record.value)
        } else add(item)
      }
    }
    add(object.defaultLength)
  }
  add(fallback)
  const ret = [...new Set(values)].sort((a, b) => a - b)
  if (WB_PROFILE) wbMark("parseWorkBuddyContextWindows", _pwcwStart)
  return ret
}

/**
 * Parse the catalog's credit string into a per-request rate.
 *
 * Observed live forms: `"x0.79 credits"`, `"x3.47"`, `"x0.00"`. A model with no
 * published rate (`undefined`) yields `rate: 0`, which callers must treat as
 * "unknown", NOT as free — `creditsFree` distinguishes a real `0x` promotion.
 */
function parseCreditRate(raw: unknown): { rate: number; free: boolean; label: string } {
  if (typeof raw !== "string" && typeof raw !== "number") return { rate: 0, free: false, label: "" }
  const label = String(raw).trim()
  const match = label.match(/x\s*([0-9]*\.?[0-9]+)/i)
  const rate = match ? Number(match[1]) : Number(label)
  const parsed = Number.isFinite(rate) ? rate : 0
  return { rate: parsed, free: parsed <= 0 && label !== "", label }
}

/**
 * Map model id -> active promotion badge label (e.g. "Free now").
 *
 * Promotions carry a `discount.factor`, so a promoted model may still publish a
 * non-zero base rate while being free right now. Only enabled promotions are
 * surfaced, and the badge label is preferred over a generic "Free".
 */
function promotionLabels(raw: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(raw)) return out
  for (const promo of raw) {
    if (!promo || promo?.enabled === false) continue
    const id = promo?.id
    if (typeof id !== "string" || !id) continue
    const label = promo?.badge?.label
    // Promotion ids are `<modelId>-fr…`; match the model by prefix so a
    // suffix-decorated id still resolves to its model.
    for (const key of [id, id.replace(/-fr.*$/, "")]) {
      if (key && typeof label === "string" && label && !out.has(key)) out.set(key, label)
    }
  }
  return out
}

/** Model family from the id, falling back to the vendor code in the payload. */
function familyFor(id: string, vendor?: unknown): string {
  const prefixes: Array<[string, string]> = [
    ["hy", "hunyuan"],
    ["glm", "glm"],
    ["kimi", "kimi"],
    ["minimax", "minimax"],
    ["deepseek", "deepseek"],
    ["gpt", "openai"],
    ["gemini", "gemini"],
    ["claude", "anthropic"],
    ["qwen", "qwen"],
  ]
  for (const [prefix, family] of prefixes) if (id.startsWith(prefix)) return family
  if (typeof vendor === "string" && vendor) return vendor
  return "unknown"
}

/** One catalog source fetch: entries on success, plus whether auth rejected it. */
type ConfigSourceResult = { entries: CatalogEntry[] | null; unauthorized: boolean }

/** Primary source: the product configuration the WorkBuddy app itself uses. */
async function discoverFromConfig(cred: Credential): Promise<ConfigSourceResult> {
  try {
    const res = await fetch(`${backendFor(cred)}${CONFIG_PATH}`, {
      // The UA is the gate: without the CLI's own UA this returns no models.
      headers: upstreamGetHeaders(cred),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { entries: null, unauthorized: res.status === 401 || res.status === 403 }
    return { entries: parseConfigPayload((await res.json()) as any), unauthorized: false }
  } catch {
    return { entries: null, unauthorized: false }
  }
}

/**
 * Secondary source, used only for enterprise accounts. The CLI layers this over
 * the global config when the credential carries an enterpriseId.
 */
async function discoverFromEnterprise(cred: Credential): Promise<ConfigSourceResult> {
  const enterpriseId = cred.enterpriseId
  // Not attempted (no enterprise) is NOT unauthorized — the combiner in
  // discoverCatalogDetailed only counts attempted sources.
  if (!enterpriseId) return { entries: null, unauthorized: false }
  try {
    const res = await fetch(
      `${backendFor(cred)}/console/enterprises/${encodeURIComponent(enterpriseId)}/config/models`,
      {
        headers: upstreamGetHeaders(cred),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) return { entries: null, unauthorized: res.status === 401 || res.status === 403 }
    return { entries: parseConfigPayload((await res.json()) as any), unauthorized: false }
  } catch {
    return { entries: null, unauthorized: false }
  }
}

// ------------------------------------------------- proactive auth validation (Tier 0)
//
// AUTH_INVALID was previously learned only after a real generation burned a
// 401 — every new dead token cost a wasted generation, and catalog/quota
// 401s were invisible to the governor. This is the owned validation
// procedure: a cheap, bootstrap-free account-session read (Tier 0
// authentication validation — never an Instance, never generation
// entitlement), with the same refresh-then-judge semantics as generations.
// The single producer of learned auth state stays the account governor;
// the quota adapter deliberately stays out (it has no refresh ownership —
// see its file header) and only READS the fact via workBuddyLimitSnapshot.

export type AuthVerdict = "valid" | "invalid" | "unknown"

/**
 * Account-session endpoint the official client itself validates against
 * (`GET {endpoint}/v2/plugin/accounts`; ASAR `getAccountSnapshot`, called from
 * `refreshSession` and after login). Verified live against `www.workbuddy.ai`
 * 2026-09-16: HTTP 200 `{code:0,data:{accounts:[…]}}`.
 */
const ACCOUNTS_PATH = "/v2/plugin/accounts"

/**
 * Single cheap authenticated read: ok / auth-rejected / anything else.
 * A 2xx with an unexpected payload is "error", never "ok" — a malformed
 * answer must not be mistaken for a healthy session.
 */
async function probeAccountSession(cred: Credential): Promise<"ok" | "unauthorized" | "error"> {
  try {
    const res = await fetch(`${backendFor(cred)}${ACCOUNTS_PATH}`, {
      headers: upstreamGetHeaders(cred),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return res.status === 401 || res.status === 403 ? "unauthorized" : "error"
    const body = (await res.json().catch(() => undefined)) as any
    return Array.isArray(body?.data?.accounts) ? "ok" : "error"
  } catch {
    return "error"
  }
}

const AUTH_VALIDATION_COOLDOWN_MS = 30_000

/**
 * Singleflight + throttle for proactive validation.
 *
 * `catalogFor` runs discovery for every account on every provider refresh;
 * when a credential is dead, the failure path used to re-probe (and
 * re-attempt refresh) on every invocation. The verdict is already
 * materialized on the account governor, so repeats inside the window return
 * it without any network work: a definitively rejected credential must not
 * become a retry loop, and a network blip must not become one either.
 * `valid` is never throttled — the next real read is the recomputation.
 */
const authValidationInflight = new Map<string, Promise<AuthVerdict>>()
const authValidationVerdicts = new Map<string, { verdict: AuthVerdict; until: number }>()

export function validateAccountAuth(account: WorkBuddyAccount): Promise<AuthVerdict> {
  const key = account.id
  const existing = authValidationInflight.get(key)
  if (existing) return existing
  const cached = authValidationVerdicts.get(key)
  if (cached && Date.now() < cached.until) return Promise.resolve(cached.verdict)
  const run = probeAndLearnAuth(account)
    .then((verdict) => {
      if (verdict === "valid") authValidationVerdicts.delete(key)
      else authValidationVerdicts.set(key, { verdict, until: Date.now() + AUTH_VALIDATION_COOLDOWN_MS })
      return verdict
    })
    .finally(() => authValidationInflight.delete(key))
  authValidationInflight.set(key, run)
  return run
}

/**
 * Validate one account's vault credential without spending generation
 * entitlement. Mirrors generation semantics (refresh-if-expired, then one
 * refresh + re-probe on rejection) and folds the verdict into the governor:
 * valid clears a learned AUTH_INVALID, invalid persists it, unknown (network
 * / 5xx) changes nothing — a blip must never exile an account.
 */
async function probeAndLearnAuth(account: WorkBuddyAccount): Promise<AuthVerdict> {
  const cred = account.credential
  if (isExpired(cred)) await singleflightRefresh(account)
  const first = await probeAccountSession(cred)
  if (first === "ok") {
    account.governor.clearAuthInvalid()
    return "valid"
  }
  if (first === "error") return "unknown"
  // Unauthorized: one refresh + re-probe before learning anything. A single
  // 401 is not yet a verdict (clock skew, rotation race).
  await singleflightRefresh(account)
  const second = await probeAccountSession(cred)
  if (second === "ok") {
    account.governor.clearAuthInvalid()
    return "valid"
  }
  if (second === "error") return "unknown"
  account.governor.markAuthInvalid(401)
  return "invalid"
}

/**
 * Fill gaps in the live catalog from the static catalog (issue #4).
 *
 * The live catalog is authoritative about WHICH models exist: a model the
 * endpoint no longer returns is gone and must not be advertised. Static entries
 * are only used to backfill metadata the live payload omitted, so a stale id
 * can never linger in the picker.
 */
function mergeCatalog(staticCatalog: CatalogEntry[], live: CatalogEntry[]): CatalogEntry[] {
  const staticById = new Map<string, CatalogEntry>()
  for (const e of staticCatalog) staticById.set(e.id, e)

  const out: CatalogEntry[] = []
  for (const e of live) {
    const cur = staticById.get(e.id)
    if (!cur) {
      out.push(e)
      continue
    }
    // Never advertise a SMALLER context than we already know (conservative).
    out.push({
      ...e,
      name: e.name || cur.name,
      family: e.family && e.family !== "unknown" ? e.family : cur.family,
      context: Math.max(cur.context, e.context),
      contextWindows: contextWindowsFor({
        ...cur,
        ...e,
        context: Math.max(cur.context, e.context),
        contextWindows: [...(cur.contextWindows ?? []), ...(e.contextWindows ?? [])],
      }),
      output: e.output || cur.output,
      reasoning: e.reasoning || cur.reasoning,
      attachment: e.attachment || cur.attachment,
      release: e.release || cur.release,
      // The live payload owns the rate; only borrow the static value when the
      // live entry published none (`0` means unknown, not free).
      credits: e.credits || cur.credits,
      creditsFree: e.credits > 0 ? e.creditsFree : e.creditsFree || cur.creditsFree,
      creditsLabel: e.creditsLabel || cur.creditsLabel,
      promotionLabel: e.promotionLabel ?? cur.promotionLabel,
    })
  }
  return out
}

/** live -> cached -> static fallback. */
async function catalogFor(account: WorkBuddyAccount | undefined): Promise<CatalogEntry[]> {
  const _catStart = WB_PROFILE ? performance.now() : 0
  const cred = account?.credential
  const staticCatalog = cred && /codebuddy\.cn|workbuddy\.cn/.test(cred.domain) ? CN_CATALOG : GLOBAL_CATALOG
  const key = account?.id ?? `anonymous:${cred?.domain ?? "global"}`
  const cached = discoveryCache.get(key)
  const now = Date.now()
  if (cached && now - cached.at < DISCOVERY_TTL_MS) { if (WB_PROFILE) wbMark("catalogFor:cacheHit", _catStart); return cached.catalog }
  if (cred) {
    const probed = await discoverCatalogDetailed(cred)
    if (probed.entries && probed.entries.length) {
      const merged = mergeCatalog(staticCatalog, probed.entries)
      discoveryCache.set(key, { at: now, catalog: merged })
      if (account) account.catalog = { ids: new Set(merged.map((entry) => entry.id)), updatedAt: now }
      return merged
    }
    if (account && probed.unauthorized) {
      // Demand-driven auth validation on the existing catalog traffic: no new
      // timers, no extra requests on the happy path, no generation
      // entitlement burned. A healed credential (refresh inside validation)
      // gets one immediate discovery retry so the picker heals in the same
      // pass instead of serving stale static data for 5 more minutes.
      if ((await validateAccountAuth(account)) === "valid") {
        const retry = await discoverCatalog(cred)
        if (retry && retry.length) {
          const merged = mergeCatalog(staticCatalog, retry)
          discoveryCache.set(key, { at: now, catalog: merged })
          account.catalog = { ids: new Set(merged.map((entry) => entry.id)), updatedAt: now }
          return merged
        }
      }
    }
  }
  if (cached) return cached.catalog // last-known-good for THIS account
  if (account?.catalog) {
    return [...account.catalog.ids].map((id) => ({
      id,
      name: id,
      family: "unknown",
      context: 0,
      output: 0,
      reasoning: false,
      release: "",
      attachment: false,
      credits: 0,
      creditsFree: false,
      creditsLabel: "",
    }))
  }
  return staticCatalog
}

// --- priority (issue #9: tool-continuation jumps titles) ----------------------

function priorityFor(payload: any, messages: any[]): number {
  // P0: this generation continues an agent loop that is waiting on a tool result.
  if (messages.some((m) => m?.role === "tool")) return 0
  // P4 (heuristic): a title/summary - no tools, tiny output budget, single short turn.
  const tiny = typeof payload?.max_tokens === "number" && payload.max_tokens <= 64
  const single = messages.filter((m) => m?.role === "user").length <= 1
  if (!payload?.tools && tiny && single) return 4
  return 2
}

function decodeAccountModel(requestedModel: string): { model: string; accountId?: string; contextWindowTokens?: number } {
  const split = splitAccountModelID(requestedModel, [{ id: "workbuddy", accountPrefix: "wb-", aliasMarkers: ["#ctx-"] }])
  const context = decodeWorkBuddyContextModel(split.baseModelID)
  // NOTE: `contextWindowTokens` is intentionally NEVER sent upstream (see
  // buildUpstreamBody) — it only selects the client-side `limit.context`.
  // Stripping the `#ctx-` alias here is still load-bearing: the bare catalog
  // id is what Tencent validates, and an unstripped alias is rejected.
  return {
    model: context.model,
    ...(split.accountID ? { accountId: split.accountID } : {}),
    ...(context.contextWindowTokens !== undefined ? { contextWindowTokens: context.contextWindowTokens } : {}),
  }
}

async function handleCompletions(req: IncomingMessage, res: ServerResponse, payload: any) {
  const _hcStart = WB_PROFILE ? performance.now() : 0
  const encodedModel = typeof payload?.model === "string" ? payload.model : ""
  if (!encodedModel) return sendJson(res, 400, { error: { message: "`model` is required", type: "invalid_request_error" } })

  const decoded = decodeAccountModel(encodedModel)
  const requestedModel = decoded.model
  const session =
    (req.headers["x-opencode-session"] as string | undefined) ??
    (req.headers["x-session-affinity"] as string | undefined) ??
    (req.headers["x-session-id"] as string | undefined) ??
    "default"
  const requestId =
    (req.headers["x-opencode-request"] as string | undefined) ??
    (req.headers["x-request-id"] as string | undefined) ??
    randomBytes(12).toString("hex")
  const explicitAccount = decoded.accountId ?? (req.headers["x-workbuddy-account"] as string | undefined)
  const selection = accountRouter.select(session, requestedModel, explicitAccount)
  if (!selection) {
    const accounts = accountRegistry.all()
    // An all-forbidden pool is a distinct, actionable diagnosis: the session
    // endpoint answers 200 for a restricted account, so the default account
    // message would send the user to sign in again for something
    // re-authentication cannot clear.
    const allForbidden = accounts.length > 0 && accounts.every((account) => account.governor.isAccountForbidden())
    const status = accounts.length === 0 ? 401 : allForbidden ? 403 : 429
    const message =
      accounts.length === 0
        ? "No signed-in WorkBuddy desktop session found. Sign in to the WorkBuddy desktop app, then retry."
        : allForbidden
          ? "Every signed-in WorkBuddy account is currently restricted by WorkBuddy (auth_forbidden, code 11140). This is a Tencent-side account restriction — re-authenticating does not clear it. Add or switch to another WorkBuddy account, or contact WorkBuddy support."
          : `No eligible WorkBuddy account currently supports ${requestedModel}; choose an account or wait for its entitlement window.`
    return sendJson(res, status, {
      error: {
        message,
        type: accounts.length === 0 ? "authentication_error" : allForbidden ? "account_forbidden" : "account_unavailable",
      },
    })
  }
  const account = selection.account
  const cred = account.credential

  const messages = Array.isArray(payload?.messages) ? [...payload.messages] : []
  // Backend contract (code 11128): the first message must be a system prompt.
  if (messages.length === 0 || messages[0]?.role !== "system") {
    messages.unshift({ role: "system", content: "You are a helpful assistant." })
  }
  // Backend contract (code 11155): in thinking mode every assistant turn must
  // echo `reasoning_content`. Repair additively (see repairHistoryForThinking);
  // non-thinking traffic passes through untouched.
  if (detectThinkingMode(messages, requestedModel)) {
    const repaired = repairHistoryForThinking(messages)
    messages.length = 0
    messages.push(...repaired)
  }

  const body = buildUpstreamBody(payload, messages, requestedModel)

  const cancellation = new AbortController()
  const abortOnClientClose = () => {
    if (!res.writableEnded) cancellation.abort()
  }
  req.once("aborted", abortOnClientClose)
  res.once("close", abortOnClientClose)
  const cleanupCancellation = () => {
    req.removeListener("aborted", abortOnClientClose)
    res.removeListener("close", abortOnClientClose)
  }
  const transport: RunGenerationOpts["transport"] = () =>
    fetch(`${backendFor(cred)}/v2/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(cred, upstreamConversationHeaders(account.id, session)),
      body: JSON.stringify(body),
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })

  let result
  let _govStart2 = WB_PROFILE ? performance.now() : 0
  // Tracks whether the governor attempted a token refresh for this
  // generation, so a terminal 401 can say so instead of implying the user
  // never signed in.
  let refreshAttempted = false
  try {
    // The ACCOUNT governor owns admission, the generation-commit point, and the
    // single auth-recovery retry. handleCompletions never re-issues a generation.
    result = await account.governor.runGeneration({
      priority: priorityFor(payload, messages),
      genKey: `${account.id}:${requestId}`,
      model: requestedModel,
      session,
      isExpired: () => isExpired(cred),
      refresh: () => {
        refreshAttempted = true
        return singleflightRefresh(account).then(toRefreshResult)
      },
      transport,
      signal: cancellation.signal,
      enrollmentEpoch: cred.enrollmentEpoch,
    })
    if (WB_PROFILE) wbMark("handleCompletions:governor", _govStart2)
  } catch (e) {
    if (e instanceof AdmissionError) {
      cleanupCancellation()
      const headers: Record<string, string> = e.retryAfter > 0 ? { "Retry-After": String(e.retryAfter) } : {}
      const type = e.kind === "quota"
        ? "quota_exhausted"
        : e.kind === "queue"
          ? "unavailable_error"
          : e.kind === "cancel"
            ? "canceled"
            : e.kind === "duplicate"
              ? "duplicate_request"
              : e.kind === "forbidden"
                ? "account_forbidden"
                : "rate_limit_error"
      const status = e.kind === "quota" ? 402 : e.kind === "queue" ? 503 : e.kind === "cancel" ? 499 : e.kind === "duplicate" ? 409 : e.kind === "forbidden" ? 403 : 429
      if (res.writableEnded || res.destroyed) return
      return sendJson(res, status, { error: { message: e.message, type } }, headers)
    }
    cleanupCancellation()
    return sendJson(res, 502, {
      error: { message: "Could not reach the WorkBuddy backend.", type: "upstream_error" },
    })
  }

  const upstream = result.res
  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "")
    const accountLabel = account.nickname.trim() || account.uid || account.id
    // The vault token is dead but the desktop app may have signed in again
    // since (same stable id, fresher token). Heal additively so the NEXT
    // request succeeds; this request still reports the failure that happened.
    let healed = false
    // Desktop heal is for dead tokens only: account-forbidden and
    // validation rejections carry no token signal, so they must not trigger
    // it (a heal cannot clear a Tencent-side account restriction).
    if ((upstream.status === 401 || upstream.status === 403) && !isValidationError(raw) && !isAccountForbidden(raw)) {
      try {
        healed = accountRegistry.tryHealFromDesktop(account)
      } catch {
        healed = false
      }
    }
    const mapped = toClientError(classify(upstream.status, raw), {
      accountLabel,
      accountId: account.id,
      model: requestedModel,
      refreshAttempted,
    })
    if (healed) {
      const note =
        " The current desktop login was newer than OpenFork's saved token, so it has been re-imported — retry the request."
      mapped.body.error.message = `${mapped.body.error.message}${note}`
    }
    // Non-success responses are terminal at the HTTP-header boundary; unlike
    // successful SSE responses they are not handed to the body-draining path.
    // Release the account lease here so an auth/quota/429 response cannot pin
    // the account's active-generation budget forever.
    result.lease.release()
    cleanupCancellation()
    return sendJson(res, mapped.status, mapped.body)
  }

  try {
    const wantsStream = payload?.stream === true

    if (!wantsStream) {
      const acc = newAccumulator(requestedModel)
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          for (const [chunk, rest] of parseSSE(buffer)) {
            absorb(acc, chunk)
            buffer = rest
          }
        }
      } catch {
        // Client cancellation/upstream drop: release in finally below.
      }
      // Credit/token accounting is per completed generation, so it is recorded
      // once here — after the body is drained — rather than per SSE chunk, and
      // only on a path that actually reached the client.
      { const _ru = WB_PROFILE ? performance.now() : 0; account.governor.recordUsage(requestedModel, acc.usage); if (WB_PROFILE) wbMark("handleCompletions:recordUsage", _ru) }
      if (!cancellation.signal.aborted && !res.writableEnded && !res.destroyed) {
        const _js = WB_PROFILE ? performance.now() : 0; const r = sendJson(res, 200, completionFrom(acc, requestedModel)); if (WB_PROFILE) wbMark("handleCompletions:sendJson", _js); return r
      }
      return
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    // The streamed path still needs the usage object: the final chunk carries
    // the per-request credit/token accounting, and without absorbing it the
    // governor would never learn real spend for streaming callers (the common
    // case for the agent loop).
    const acc = newAccumulator(requestedModel)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (cancellation.signal.aborted || res.destroyed) break
        buffer += decoder.decode(value, { stream: true })
        for (const [chunk, rest] of parseSSE(buffer)) {
          if (cancellation.signal.aborted || res.destroyed) break
          absorb(acc, chunk)
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          buffer = rest
        }
      }
    } catch {
      // Client disconnected or upstream dropped mid-stream.
    }
    // Record only when the stream ran to completion: a cancelled or truncated
    // generation produced no final usage and must not be counted.
    if (!cancellation.signal.aborted && !res.destroyed) {
      const _ru2 = WB_PROFILE ? performance.now() : 0; account.governor.recordUsage(requestedModel, acc.usage); if (WB_PROFILE) wbMark("handleCompletions:recordUsage", _ru2)
    }
    if (!res.writableEnded && !res.destroyed && !cancellation.signal.aborted) {
      res.write("data: [DONE]\n\n")
      res.end()
    }
  } finally {
    // The governor lease spans the entire SSE body, not just fetch headers.
    result.lease.release()
    cleanupCancellation()
    if (WB_PROFILE) wbMark("handleCompletions", _hcStart)
  }
}

let ensureProxyInflight: Promise<ProxyState | undefined> | undefined

/**
 * Start (or return) the loopback proxy.
 *
 * Self-healing: a previous listener that died takes `state` down with it via the
 * close/error handlers below, so this transparently re-listens on the next call
 * instead of handing back a dead port forever.
 */
async function ensureProxy(): Promise<ProxyState | undefined> {
  if (state?.server.listening) return state
  // Concurrent callers share one startup; otherwise two racing calls would each
  // bind a socket and the loser's port would leak.
  if (ensureProxyInflight) return ensureProxyInflight
  ensureProxyInflight = startProxy().finally(() => {
    ensureProxyInflight = undefined
  })
  return ensureProxyInflight
}

function makeProxyHandler(token: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1")
        const path = url.pathname.replace(/\/+$/, "")

        if (path === "/health") {
          const accounts = accountRegistry.all()
          return sendJson(res, 200, {
            ok: true,
            provider: PROVIDER_ID,
            signed_in: accounts.length > 0,
            accounts: accounts.map((account) => ({
              id: account.id,
              nickname: account.nickname,
              uid: account.uid,
              realm: account.realm,
              auth_file: account.authPath.split(/[\\/]/).pop(),
              metrics: account.governor.metrics(),
            })),
            bindings: accountRouter.bindingsSnapshot(),
          })
        }

        if (path === "/metrics") {
          return sendJson(res, 200, {
            accounts: accountRegistry.snapshot(),
            bindings: accountRouter.bindingsSnapshot(),
          })
        }

        if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
          const accounts = accountRegistry.all()
          const selectedId = url.searchParams.get("account") ?? undefined
          const selected = selectedId ? accounts.find((account) => account.id === selectedId) : accounts[0]
        const output: any[] = []
        const seen = new Set<string>()
        for (const account of accounts) {
            if (selected && account.id !== selected.id && selectedId) continue
            const catalog = await catalogFor(account)
            for (const entry of catalog) {
              for (const item of exposedModels("", entry, selectedId ? undefined : account.id)) {
                if (seen.has(item.id)) continue
                seen.add(item.id)
                output.push({ id: item.id, object: "model", created: 0, owned_by: `${PROVIDER_ID}:${account.id}`, context: item.limit.context })
              }
            }
          }
          // Keep the ergonomic default `workbuddy/hy4-preview` for automatic
          // assignment when no explicit account is requested.
          if (!selectedId && selected) {
            const catalog = await catalogFor(selected)
            for (const entry of catalog) {
              for (const item of exposedModels("", entry)) {
                if (seen.has(item.id)) continue
                seen.add(item.id)
                output.push({ id: item.id, object: "model", created: 0, owned_by: PROVIDER_ID, context: item.limit.context })
              }
            }
          }
          return sendJson(res, 200, { object: "list", data: output })
        }

        if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
          const auth = req.headers.authorization ?? ""
          if (auth !== `Bearer ${token}`) {
            return sendJson(res, 401, {
              error: { message: "Invalid local proxy token.", type: "authentication_error" },
            })
          }
          let payload: any
          try {
            payload = await readBody(req)
          } catch {
            return sendJson(res, 400, { error: { message: "Body is not valid JSON.", type: "invalid_request_error" } })
          }
          return await handleCompletions(req, res, payload)
        }

        return sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error" } })
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { error: { message: "WorkBuddy proxy error.", type: "internal_error" } })
        }
      }
    })()
  }
}

async function startProxy(): Promise<ProxyState | undefined> {
  const token = proxyToken()

  const server = createServer(makeProxyHandler(token))

  // Prefer the stable port so model URLs survive a proxy restart; fall back to
  // an ephemeral port when another OpenCode instance already holds it.
  // Handlers are attached AFTER a successful bind so an EADDRINUSE during
  // start-up doesn't prematurely close the server before the fallback attempt.
  let port = await listen(server, "127.0.0.1", PROXY_PORT).catch(() => 0)
  if (!port) {
    port = await listen(server, "127.0.0.1", 0).catch(() => 0)
    if (!port) {
      server.removeAllListeners()
      return undefined
    }
  }

  // A listener that dies for ANY reason (socket error, loopback stack reset,
  // dispose()) must drop `state` so the next ensureProxy() re-binds. Without
  // this the cached port is handed out forever and every request after a crash
  // fails with ECONNREFUSED against a port nothing is listening on.
  server.on("close", () => {
    if (state?.server === server) state = undefined
  })
  // Keep a persistent error handler: the one-shot handler inside listen() is
  // removed after bind succeeds, and an error event with no listener would
  // otherwise crash the process.
  server.on("error", () => {
    if (state?.server === server) state = undefined
    server.close()
  })

  state = { server, port, token }
  return state
}

// ------------------------------------------------------------------------ plugin

function toModel(
  baseURL: string,
  headers: Record<string, string>,
  entry: CatalogEntry,
  exposedId = entry.id,
  accountLabel?: string,
  contextWindowTokens = entry.context,
): Model {
  const hasAlternateContext = contextWindowsFor(entry).length > 1 && exposedId.includes(CONTEXT_MODEL_MARKER)
  return {
    id: exposedId,
    providerID: PROVIDER_ID,
    // Account-qualified models show a human label (nickname, usually the email)
    // instead of the `wb-...` routing id, which is unreadable in a picker.
    name: `${accountLabel ? `${entry.name} (${accountLabel})` : entry.name}${hasAlternateContext ? ` (${formatContextWindow(contextWindowTokens)})` : ""}`,
    family: entry.family,
    // Keep the exposed alias on the transport model so the loopback proxy can
    // recover the selected context size and account before forwarding the bare
    // WorkBuddy catalog id upstream.
    api: { id: exposedId, url: baseURL, npm: NPM },
    status: "active",
    headers,
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: contextWindowTokens, output: entry.output },
    capabilities: {
      temperature: true,
      reasoning: entry.reasoning,
      attachment: entry.attachment,
      toolcall: true,
      input: { text: true, audio: false, image: entry.attachment, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    release_date: entry.release,
    variants: undefined,
  }
}

function exposedModels(baseURL: string, entry: CatalogEntry, accountId?: string, accountLabel?: string, headers: Record<string, string> = {}) {
  const windows = contextWindowsFor(entry)
  const suffix = accountId ? `@${accountId}` : ""
  const models: Model[] = [toModel(baseURL, headers, entry, `${entry.id}${suffix}`, accountLabel, entry.context)]
  for (const context of windows) {
    if (context === entry.context) continue
    const id = `${contextModelId(entry.id, context)}${suffix}`
    models.push(toModel(baseURL, headers, entry, id, accountLabel, context))
  }
  return models
}

function oauthMethod(realm: WorkBuddyOAuthRealm, label: string) {
  return {
    type: "oauth" as const,
    label,
    async authorize() {
      const started = await startWorkBuddyOAuth(realm)
      return {
        method: "auto" as const,
        url: started.url,
        instructions: "Complete Tencent authorization in the browser. OpenFork will poll the login state and save this account in its own vault.",
        async callback() {
          for (;;) {
            const result = await pollWorkBuddyOAuth(started.state, accountRegistry.vault)
            if (result.status === "success") {
              const account = accountRegistry.enrollCredential(result.credential)
              return {
                type: "success" as const,
                provider: PROVIDER_ID,
                access: account.credential.accessToken,
                refresh: account.credential.refreshToken,
                expires: Math.floor(account.credential.expiresAt / 1000),
                accountId: account.uid,
                enterpriseUrl: account.realm,
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 2000))
          }
        },
      }
    },
  }
}

export async function WorkBuddyPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        const proxy = await ensureProxy().catch(() => undefined)
        if (!proxy) return provider.models

        // Heal stale cached models (e.g. an old ephemeral 59731 from before
        // the stable-port fix). Reviving the old listener makes the immediate
        // retry succeed even before the provider database is overwritten with
        // the new stable URL.
        {
          const stale = new Set<number>()
          for (const m of Object.values(provider.models as Record<string, any>)) {
            const url = m?.api?.url as string | undefined
            if (!url || !url.includes("127.0.0.1")) continue
            const mm = url.match(/http:\/\/127\.0\.0\.1:(\d+)\/v1/)
            if (!mm) continue
            const p = Number(mm[1])
            if (Number.isSafeInteger(p) && p !== proxy.port) stale.add(p)
          }
          for (const p of stale) void ensureExtraServer(p, proxy.token).catch(() => {})
        }

        const baseURL = `http://127.0.0.1:${proxy.port}/v1`
        // The per-process token keeps unrelated local processes off this proxy.
            const headers = { Authorization: `Bearer ${proxy.token}` }
        const accounts = accountRegistry.all()
        const labels = accountLabels(accounts)
        const merged: Record<string, Model> = { ...provider.models }
        for (const account of accounts) {
          const catalog = await catalogFor(account)
          for (const entry of catalog) {
            for (const item of exposedModels(baseURL, entry, account.id, labels.get(account.id), { ...headers, "X-WorkBuddy-Account": account.id })) {
              merged[item.id] = item
            }
          }
        }

        // Preserve the ergonomic automatic-assignment model ids. They route to
        // whichever account the session router binds, never by per-turn rotation.
        const first = accounts[0]
        if (first) {
          const catalog = await catalogFor(first)
          for (const entry of catalog) {
            if (!merged[entry.id]) {
              for (const item of exposedModels(baseURL, entry, undefined, undefined, headers)) merged[item.id] = item
            }
          }
        }
        return merged
      },
    },

    "chat.headers": async (input, output) => {
      if (input.model.providerID !== PROVIDER_ID) return
      // OpenFork's normal provider path supplies x-session-affinity and
      // X-Session-Id, but make the canonical header explicit for this provider.
      // The message id is the logical-generation identity used to prevent a
      // duplicate transport attempt from being mistaken for a new request.
      output.headers["x-opencode-session"] = input.sessionID
      if (input.message?.id) {
        // Multiple distinct generations can be derived from the same user
        // message in the same turn (title generation is forked in parallel
        // with the main streamText — see SessionPrompt.prompt.ts:1425-1431).
        // Both pass `user: firstInfo` on a fresh session, which makes their
        // `info.id` identical; without this namespace the workbuddy
        // governor's top-level duplicate guard would reject the second
        // in-flight request and the session would never start. Prefixing
        // by the agent purpose keeps the same user message id under a
        // distinct genKey per generation.
        const purpose = input.agent === "title" ? "title" : "main"
        output.headers["x-opencode-request"] = `${purpose}:${input.message.id}`
      }
      // Heal a stale `Authorization` baked into a cached Model (old token
      // from before the stable-token fix). `model.headers` is stale until the
      // next provider refresh, but `chat.headers` runs per-request and can
      // inject the live token so the immediate retry succeeds.
      const proxy = await ensureProxy().catch(() => undefined)
      if (proxy) output.headers["Authorization"] = `Bearer ${proxy.token}`
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Import current WorkBuddy desktop login",
          async authorize() {
            try {
              const account = accountRegistry.importCurrentDesktopAccount()
              return {
                type: "success" as const,
                key: `workbuddy-account:${account.id}`,
                provider: PROVIDER_ID,
                metadata: {
                  accountId: account.id,
                  uid: account.uid,
                  account: account.nickname,
                  realm: account.realm,
                  source: "desktop-import",
                },
              }
            } catch {
              return { type: "failed" as const }
            }
          },
        },
        oauthMethod("global", "Add WorkBuddy Global account"),
        oauthMethod("cn", "Add CodeBuddy CN account"),
      ],
    },

    async dispose() {
      const current = state
      if (current) {
        state = undefined
        await new Promise<void>((resolve) => current.server.close(() => resolve()))
      }
      // Close any revived stale listeners as well.
      const extras = [...extraServers.values()]
      extraServers.clear()
      await Promise.all(extras.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
    },
  }
}
