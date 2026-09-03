import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { randomBytes } from "crypto"
import { AdmissionError, type RunGenerationOpts } from "./workbuddy-governor"
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
 * listener). Ensure loopback hosts are exempt from any proxy in the environment.
 */
function ensureLoopbackProxyBypass() {
  const loopback = ["127.0.0.1", "localhost", "[::1]"]
  for (const key of ["no_proxy", "NO_PROXY"]) {
    const cur = process.env[key]
    const set = new Set((cur ?? "").split(",").map((s) => s.trim()).filter(Boolean))
    let changed = false
    for (const h of loopback) if (!set.has(h)) { set.add(h); changed = true }
    if (changed) process.env[key] = [...set].join(",")
  }
}
ensureLoopbackProxyBypass()

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
const USER_AGENT = "codebuddy2openai/2.0"
const REQUEST_TIMEOUT_MS = 5 * 60_000
const DISCOVERY_TTL_MS = 5 * 60_000

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
 * models; the CLI's own `workbuddy-ai/<version>` UA returns the full product
 * configuration (`data.models` + `data.agents`). Discovery therefore has to
 * present that UA or it silently gets an empty catalog.
 *
 * The previous `/console/enterprises/personal/models` path was never a real
 * route - it 500s at the gateway - which is why OpenFork fell back to a
 * hardcoded list that drifted from what the app shows.
 */
const CONFIG_PATH = "/v3/config"
const CATALOG_USER_AGENT = "workbuddy-ai/5.4.2"

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

/** Headers for an upstream call. Never log the result of this function. */
function upstreamHeaders(cred: Credential, extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${cred.accessToken}`,
    "X-User-Id": cred.uid,
    "X-Enterprise-Id": cred.enterpriseId,
    "X-Tenant-Id": cred.enterpriseId,
    "X-Domain": cred.domain,
    "User-Agent": USER_AGENT,
    ...extra,
  }
}

// --- refresh (singleflight, account-local) ----------------------------------

const refreshInflight = new Map<string, Promise<boolean>>()

async function refresh(account: WorkBuddyAccount): Promise<boolean> {
  const cred = account.credential
  if (!cred.refreshToken) return false
  try {
    const res = await fetch(`${backendFor(cred)}/v2/plugin/auth/token/refresh`, {
      method: "POST",
      headers: upstreamHeaders(cred, {
        "X-Refresh-Token": cred.refreshToken,
        "X-Auth-Refresh-Source": "plugin",
      }),
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as any
    const token = body?.data?.accessToken
    if (typeof token !== "string" || !token) return false
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
    return true
  } catch {
    return false
  }
}

/** Singleflight: concurrent generations share one refresh for ONE account. */
function singleflightRefresh(account: WorkBuddyAccount): Promise<boolean> {
  const key = account.id
  const existing = refreshInflight.get(key)
  if (existing) return existing
  const p = refresh(account).finally(() => refreshInflight.delete(key))
  refreshInflight.set(key, p)
  return p
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

type UpstreamFailure = { status: number; code?: string; message: string }

function classify(status: number, raw: string): UpstreamFailure {
  const code = raw.match(/"code"\s*:\s*("?\d+"?)/)?.[1]?.replace(/"/g, "")
  const message = raw.match(/"msg"\s*:\s*"([^"]{0,200})"/)?.[1]
  return { status, code, message: message ?? `upstream returned HTTP ${status}` }
}

/** Map backend conditions onto distinct OpenCode-relevant classes. */
function toClientError(failure: UpstreamFailure): { status: number; body: any } {
  const detail = failure.code ? `[${failure.code}] ${failure.message}` : failure.message
  if (failure.status === 401 || failure.status === 403) {
    return {
      status: 401,
      body: { error: { message: `WorkBuddy session is not authorized. Open the WorkBuddy desktop app and confirm you are signed in. ${detail}`, type: "authentication_error" } },
    }
  }
  if (failure.status === 402 || /insufficient credit|积分不足|credit/i.test(failure.message)) {
    return {
      status: 402,
      body: { error: { message: `WorkBuddy credits exhausted for this account. ${detail}`, type: "quota_exceeded" } },
    }
  }
  if (failure.status === 429) {
    return { status: 429, body: { error: { message: `WorkBuddy rate limit reached. ${detail}`, type: "rate_limit_error" } } }
  }
  if (/model \[.*\](service info|not found|is invalid)|service info/i.test(failure.message)) {
    return { status: 404, body: { error: { message: `Model is not available on this WorkBuddy account. ${detail}`, type: "model_not_found" } } }
  }
  if (failure.status >= 500) {
    return { status: 502, body: { error: { message: `WorkBuddy upstream failure. ${detail}`, type: "upstream_error" } } }
  }
  return { status: failure.status || 502, body: { error: { message: `WorkBuddy request failed. ${detail}`, type: "upstream_error" } } }
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

async function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    // Loopback only. This proxy fronts a personal entitlement and must never
    // be reachable from another machine.
    server.listen(0, host, () => {
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
  // Parallelize the two catalog sources - worst-case 15s not 30s
  const [fromConfig, fromEnterprise] = await Promise.all([discoverFromConfig(cred), discoverFromEnterprise(cred)])
  return fromConfig ?? fromEnterprise
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
  return out.length ? out : null
}

/** Extract only explicit selectable sizes; min/max bounds are not choices. */
export function parseWorkBuddyContextWindows(raw: unknown, fallback: number): number[] {
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
  return [...new Set(values)].sort((a, b) => a - b)
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

/** Primary source: the product configuration the WorkBuddy app itself uses. */
async function discoverFromConfig(cred: Credential): Promise<CatalogEntry[] | null> {
  try {
    const res = await fetch(`${backendFor(cred)}${CONFIG_PATH}`, {
      // The UA is the gate: without the CLI's own UA this returns no models.
      headers: upstreamHeaders(cred, { "User-Agent": CATALOG_USER_AGENT }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    return parseConfigPayload((await res.json()) as any)
  } catch {
    return null
  }
}

/**
 * Secondary source, used only for enterprise accounts. The CLI layers this over
 * the global config when the credential carries an enterpriseId.
 */
async function discoverFromEnterprise(cred: Credential): Promise<CatalogEntry[] | null> {
  const enterpriseId = cred.enterpriseId
  if (!enterpriseId) return null
  try {
    const res = await fetch(
      `${backendFor(cred)}/console/enterprises/${encodeURIComponent(enterpriseId)}/config/models`,
      {
        headers: upstreamHeaders(cred, { "User-Agent": CATALOG_USER_AGENT }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) return null
    return parseConfigPayload((await res.json()) as any)
  } catch {
    return null
  }
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
  const cred = account?.credential
  const staticCatalog = cred && /codebuddy\.cn|workbuddy\.cn/.test(cred.domain) ? CN_CATALOG : GLOBAL_CATALOG
  const key = account?.id ?? `anonymous:${cred?.domain ?? "global"}`
  const cached = discoveryCache.get(key)
  const now = Date.now()
  if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.catalog
  if (cred) {
    const live = await discoverCatalog(cred)
    if (live && live.length) {
      const merged = mergeCatalog(staticCatalog, live)
      discoveryCache.set(key, { at: now, catalog: merged })
      if (account) account.catalog = { ids: new Set(merged.map((entry) => entry.id)), updatedAt: now }
      return merged
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
  return {
    model: context.model,
    ...(split.accountID ? { accountId: split.accountID } : {}),
    ...(context.contextWindowTokens !== undefined ? { contextWindowTokens: context.contextWindowTokens } : {}),
  }
}

async function handleCompletions(req: IncomingMessage, res: ServerResponse, payload: any) {
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
    return sendJson(res, accounts.length ? 429 : 401, {
      error: {
        message: accounts.length
          ? `No eligible WorkBuddy account currently supports ${requestedModel}; choose an account or wait for its entitlement window.`
          : "No signed-in WorkBuddy desktop session found. Sign in to the WorkBuddy desktop app, then retry.",
        type: accounts.length ? "account_unavailable" : "authentication_error",
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

  const body: Record<string, unknown> = {
    model: requestedModel,
    messages,
    // Non-streaming is rejected upstream, so always stream and fold if needed.
    stream: true,
    stream_options: { include_usage: true },
  }
  if (decoded.contextWindowTokens !== undefined) body.context_window_tokens = decoded.contextWindowTokens
  // Pass through the OpenAI fields the backend understands.
  for (const key of [
    "tools", "tool_choice", "temperature", "top_p", "stop",
    "presence_penalty", "frequency_penalty", "reasoning_effort",
    "max_tokens", "max_completion_tokens", "response_format", "user", "context_window_tokens", "contextWindowTokens",
  ]) {
    if (payload?.[key] !== undefined) body[key] = payload[key]
  }

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
      headers: upstreamHeaders(cred),
      body: JSON.stringify(body),
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })

  let result
  try {
    // The ACCOUNT governor owns admission, the generation-commit point, and the
    // single auth-recovery retry. handleCompletions never re-issues a generation.
    result = await account.governor.runGeneration({
      priority: priorityFor(payload, messages),
      genKey: `${account.id}:${requestId}`,
      model: requestedModel,
      session,
      isExpired: () => isExpired(cred),
      refresh: () => singleflightRefresh(account),
      transport,
      signal: cancellation.signal,
      enrollmentEpoch: cred.enrollmentEpoch,
    })
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
              : "rate_limit_error"
      const status = e.kind === "quota" ? 402 : e.kind === "queue" ? 503 : e.kind === "cancel" ? 499 : e.kind === "duplicate" ? 409 : 429
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
    const mapped = toClientError(classify(upstream.status, raw))
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
      account.governor.recordUsage(requestedModel, acc.usage)
      if (!cancellation.signal.aborted && !res.writableEnded && !res.destroyed) {
        return sendJson(res, 200, completionFrom(acc, requestedModel))
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
      account.governor.recordUsage(requestedModel, acc.usage)
    }
    if (!res.writableEnded && !res.destroyed && !cancellation.signal.aborted) {
      res.write("data: [DONE]\n\n")
      res.end()
    }
  } finally {
    // The governor lease spans the entire SSE body, not just fetch headers.
    result.lease.release()
    cleanupCancellation()
  }
}

async function ensureProxy(): Promise<ProxyState | undefined> {
  if (state) return state

  const token = randomBytes(32).toString("hex")

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  })

  const port = await listen(server, "127.0.0.1").catch(() => 0)
  if (!port) return undefined

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
      if (input.message?.id) output.headers["x-opencode-request"] = input.message.id
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
      if (!current) return
      state = undefined
      await new Promise<void>((resolve) => current.server.close(() => resolve()))
    },
  }
}
