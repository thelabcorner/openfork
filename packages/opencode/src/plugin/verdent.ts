import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { createCipheriv, createHash, randomBytes, randomUUID } from "crypto"
import { execSync } from "child_process"
import * as os from "os"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { requiredSystemBlocks } from "./verdent-system"
import { VerdentRegistry, VerdentRouter, VerdentVault, verdentAccountLabels, uidFromToken } from "./verdent-accounts"
import { AdmissionError, WorkBuddyEntitlementGovernor } from "./workbuddy-governor"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"

/**
 * Verdent provider plugin.
 *
 * Exposes Verdent's logged-in (free) models — GLM-5.3-Flash,
 * DeepSeek-V4-Flash-0731, GPT-5.6 Luna Free — to OpenCode as a standard
 * OpenAI-compatible provider by running a loopback proxy:
 *
 *   OpenCode -> @ai-sdk/openai-compatible -> 127.0.0.1:<ephemeral>/v1 -> Verdent
 *
 * The local hop is required for two reasons established by ASAR inspection of
 * Verdent 2.12.3 (app.asar, dist/index.mjs):
 *
 *   1. There is no public OpenAI-compatible surface for Verdent's own models.
 * The bundled `BUILTIN_PROVIDERS` registry is pure BYOK (OpenAI,
 *      Anthropic, DeepSeek, SiliconFlow, Ollama, ...). The free/eco models are
 *      served only by Verdent's cloud LLM proxy (`llm-proxy.verdent.ai`).
 *   2. That cloud proxy speaks a custom encrypted protocol (not Anthropic,
 *      not OpenAI): POST `https://llm-proxy.verdent.ai/llm/stream`
 *      headers `authorization: Bearer <token>`, `cookie: token=<token>`,
 *      `verdent-proxy-beta: hybrid-stream@20250919`, `X-Version-Code`
 *      body `{ channel:"deck", model, session_id, conv_id, react_id,
 *              react_type:"Main Agent", stream:true, max_tokens,
 *              system: proxyEncode(...), messages: proxyEncode(...),
 *              agent_name:"VerdentDeck", encrypt:true, is_eco, is_auto }`
 *      where `proxyEncode` is AES-256-GCM with static key `codeck502deck_25_09_15v7`.
 *
 * So this plugin's loopback proxy accepts OpenAI `/v1/chat/completions` (what
 * the AI SDK emits), encrypts it into the Verdent proxy format, and translates
 * the SSE response back to OpenAI.
 *
 * Auth delegation: the plugin never forges tokens. It reads the current
 * Verdent desktop session from the OS credential store (keytar service
 * `ai.verdent.deck`, account `access-token`) — the same secret the app itself
 * uses — or accepts an explicitly provided token. The plaintext token is
 * never logged.
 *
 * Security: loopback-only listener, per-process bearer token, tokens never
 * logged, and `no_proxy`/loopback bypass so an environment HTTP(S)_PROXY does
 * not intercept 127.0.0.1 traffic.
 */

const PROVIDER_ID = "verdent"
const NPM = "@ai-sdk/openai-compatible"
const REQUEST_TIMEOUT_MS = 5 * 60_000
const DISCOVERY_TTL_MS = 5 * 60_000

const VERDENT_PROXY_PROD_BASE_URL = "https://llm-proxy.verdent.ai"
const VERDENT_PROFILE_PROD_BASE_URL = "https://agent.verdent.ai"
const VERDENT_PROFILE_FENJI_BASE_URL = "https://fenji-agent.verdent.ai"
const VERDENT_PROFILE_DEV_BASE_URL = "https://dev-agent.verdent.ai"
const VERDENT_AUTH_PROD_BASE_URL = "https://www.verdent.ai"
const VERDENT_LOGIN_PROD_BASE_URL = "https://login.verdent.ai"
const VERDENT_AUTH_PATH = "/auth"
const VERDENT_AUTH_CALLBACK_PATH = "/auth/callback"
const VERDENT_PKCE_CALLBACK_PATH = "/passport/pkce/callback"
const VERDENT_AUTH_FENJI_BASE_URL = "https://fenji.verdent.ai"
const VERDENT_AUTH_DEV_BASE_URL = "https://test.verdent.ai"
const VERDENT_LOGIN_FENJI_BASE_URL = "https://fenji-login.verdent.ai"
const VERDENT_LOGIN_DEV_BASE_URL = "https://dev-login.verdent.ai"
const PROXY_BETA_HEADER = "hybrid-stream@20250919"
const PROXY_SIGN = "codeck502deck_25_09_15v7"
const PROXY_KEY = (() => {
  const b64 = Buffer.from(PROXY_SIGN, "utf-8").toString("base64")
  return Buffer.from(b64, "utf-8").subarray(0, 32)
})()
const VERDENT_CURRENT_VERSION = "2.12.3"

// --- multi-account (very similar to workbuddy-accounts) -----------------------
let verdentRegistry = new VerdentRegistry()
let verdentRouter = new VerdentRouter({ registry: verdentRegistry })
let fallbackAccount: import("./verdent-accounts").VerdentAccount | undefined

function getFallbackAccount(token: string): import("./verdent-accounts").VerdentAccount {
  if (fallbackAccount?.credential.accessToken === token) return fallbackAccount
  const suffix = createHash("sha256").update(token).digest("hex").slice(0, 12)
  fallbackAccount = {
    id: `vd-single-${suffix}`,
    uid: `single-${suffix}`,
    nickname: "single",
    authPath: "ephemeral",
    credential: { path: "ephemeral", accessToken: token, uid: `single-${suffix}`, nickname: "single", expiresAt: 0 },
    governor: new WorkBuddyEntitlementGovernor({
      persistenceFile: `${os.tmpdir()}/opencode-verdent-single-${suffix}.json`,
    }),
    mtime: 0,
    source: "env",
  }
  return fallbackAccount
}

/** Test-only: isolate the verdent vault from the user's real store. */
export function setTestVerdentAccountStore(root: string | undefined) {
  if (!root) return
  verdentRegistry = new VerdentRegistry({ vault: new VerdentVault(root), persistenceDir: `${root}/state` })
  verdentRouter = new VerdentRouter({ registry: verdentRegistry })
  fallbackAccount = undefined
}

export function verdentLimitSnapshot(now = Date.now()) {
  const accounts = verdentRegistry.all()
  const labels = verdentAccountLabels(accounts)
  return accounts.map((account) => ({
    accountId: account.id,
    label: labels.get(account.id) ?? account.id,
    // The shared governor seeds WorkBuddy's canonical hy3/hy4 rows so its
    // picker can show promotional models before first use. Those placeholders
    // are not Verdent models; only pass through real Verdent observations.
    models: account.governor
      .modelReports(now)
      .filter((report) => report.model !== "hy3" && report.model !== "hy4-preview"),
  }))
}

// --- 1:1 replica helpers (verdent ASAR 24896294, 25221128, 25078050) ---------
// Memoized: these hit execSync and block the event loop; on the request hot
// path they must not re-run per generation.
let _cachedMachineId: string | undefined
let _cachedOsVersion: string | undefined
let _cachedShell: string | undefined
let _cachedDeviceModel: string | undefined | null

function getMachineId2(): string {
  if (_cachedMachineId !== undefined) return _cachedMachineId
  // ASAR machineIdSync(true) at 24896294: win32 REG, lowercased
  let result = ""
  try {
    if (process.platform === "win32") {
      const out = execSync(
        "%windir%\\System32\\REG.exe QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid",
        { encoding: "utf8" },
      )
      const id = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
      if (id) result = id.toLowerCase()
    } else if (process.platform === "darwin") {
      const out = execSync("/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice", { encoding: "utf8" })
      const line = out.split("\n").find((l) => l.includes("IOPlatformUUID"))
      if (line) {
        const p = line.split('" = "')
        if (p.length === 2) result = p[1].slice(0, -1).toLowerCase()
      }
    } else {
      try {
        result = execSync("( cat /var/lib/dbus/machine-id /etc/machine-id 2> /dev/null || hostname ) | head -n 1", {
          encoding: "utf8",
        })
          .replace(/\r+|\n+|\s+/g, "")
          .toLowerCase()
      } catch {}
    }
  } catch {}
  _cachedMachineId = result
  return result
}
function detectOsVersion(): string {
  if (_cachedOsVersion !== undefined) return _cachedOsVersion
  let result: string
  try {
    if (process.platform === "darwin")
      result = `macOS ${execSync("sw_vers -productVersion", { encoding: "utf8", timeout: 3000 }).trim()}`
    else if (process.platform === "win32") result = `${os.type()} ${os.release()}`
    else result = `Linux ${execSync("uname -r", { encoding: "utf8", timeout: 3000 }).trim()}`
  } catch {
    result = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"
  }
  _cachedOsVersion = result
  return result
}
function detectShell(): string {
  // SHELL/ComSpec/WSL_DISTRO_NAME are effectively static per process; memoize the
  // first observed value so we don't read env on every request.
  if (_cachedShell !== undefined) return _cachedShell
  let result: string
  if (process.platform === "win32") {
    const sh = process.env.SHELL ?? ""
    if (sh.toLowerCase().includes("bash")) result = "gitbash"
    else if ((process.env.ComSpec ?? "").toLowerCase().includes("powershell")) result = "powershell"
    else result = "cmd"
  } else if (process.env.WSL_DISTRO_NAME) result = "wsl-bash"
  else {
    const sh = process.env.SHELL ?? ""
    if (sh.includes("zsh")) result = "zsh"
    else if (sh.includes("bash")) result = "bash"
    else result = "unknown"
  }
  _cachedShell = result
  return result
}
function buildEnv(input?: { osVersion?: string; shell?: string }) {
  return {
    platform: process.platform,
    os_version: input?.osVersion ?? "",
    shell: input?.shell ?? "",
    today_date: new Date().toISOString().split("T")[0] ?? "",
  }
}
/** Captured desktop sends the CPU model name as `Device-Model` (e.g. "AMD Ryzen 9 5900X 12-Core Processor"). */
function detectDeviceModel(): string | undefined {
  if (_cachedDeviceModel !== undefined) return _cachedDeviceModel ?? undefined
  if (process.platform !== "win32") {
    _cachedDeviceModel = null
    return undefined
  }
  for (const command of [
    "wmic cpu get name",
    'powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)"',
  ]) {
    try {
      const lines = execSync(command, { encoding: "utf8", timeout: 5000 })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      const name = command.startsWith("wmic") ? lines[1] : lines[0]
      if (name) {
        _cachedDeviceModel = name
        return name
      }
    } catch {}
  }
  _cachedDeviceModel = null
  return undefined
}
function resolveDeviceId(): string {
  return process.env.VERDENT_DEVICE_ID?.trim() || getMachineId2()
}
function resolveTeamId(): string | undefined {
  return process.env.VERDENT_TEAM_ID?.trim() || undefined
}

/** The desktop sends the raw user prompt text in the trace metadata (captured: "test\n\n"). */
export function lastUserText(payload: any): string {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "user") continue
    const c = m?.content
    if (typeof c === "string" && c.trim()) return c
    if (Array.isArray(c)) {
      const text = c
        .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
        .map((p: any) => p.text)
        .join("")
      if (text.trim()) return text
      const fallback = c.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
      if (fallback.trim()) return fallback
    }
  }
  return ""
}

// ASAR: VerdentProxyProvider buildProxyMessages enforces strict role alternation.
// OpenAI SDK may send consecutive same-role messages. ASAR validateProxyMessageRoles
// throws on adjacent same-role. We repair by merging consecutive same-role messages.
export function coalesceAdjacentMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const msg of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === msg.role) {
      prev.content.push(...msg.content)
    } else {
      out.push({ ...msg, content: [...msg.content] })
    }
  }
  return out
}

// ASAR: ensureTrailingProxyUserContinuationMessage - TRAILING_ASSISTANT_CONTINUATION_PROMPT = "Please continue."
const TRAILING_CONTINUATION_TEXT = "Please continue."
export function ensureTrailingUserContinuation(messages: AnthropicMessage[]): AnthropicMessage[] {
  const last = messages.at(-1)
  if (!last || last.role !== "assistant") return messages
  const hasToolUse = last.content.some((b) => b.type === "tool_use")
  if (hasToolUse) return messages
  return [
    ...messages,
    { role: "user", content: [{ type: "text", text: TRAILING_CONTINUATION_TEXT }], model: last.model },
  ]
}

// ASAR: normalizeTools / shouldDropApplyPatchForModel
const NATIVE_TOOLS = new Set(["apply_patch"])
function shouldDropApplyPatchForModel(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes("moonshot") || m.includes("minimax") || m.includes("zhipu")
}
function normalizeAnthropicToolsForModel(tools: any[] | undefined, model: string): any[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const useNativeApplyPatch = /^gpt-5\.\d/i.test(model)
  const filtered = shouldDropApplyPatchForModel(model) ? tools.filter((t) => t.name !== "apply_patch") : tools
  return filtered.map((tool) => {
    if (tool.name === "apply_patch" && useNativeApplyPatch) return { type: "apply_patch" }
    if (NATIVE_TOOLS.has(tool.name) && Object.keys(tool.input_schema?.properties ?? {}).length === 0)
      return { type: tool.name }
    return tool
  })
}

/**
 * Captured desktop sends a catalog version token like "model-catalog-1788228440985".
 * Best-effort: use the discovery cache when it is warm, otherwise omit the field.
 */
function modelCatalogVersion(): string | undefined {
  const override = process.env.VERDENT_MODEL_CATALOG_VERSION?.trim()
  if (override) return override
  if (discoveryCache) return `model-catalog-${discoveryCache.at}`
  return undefined
}

function proxyEncode(data: unknown): string {
  const plaintext = Buffer.from(JSON.stringify(data), "utf-8")
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", PROXY_KEY, nonce)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, encrypted, tag]).toString("base64")
}

/** Upstream Verdent cloud proxy target. Overridable for local testing. */
function verdentProxyEndpoint(): string {
  return (
    process.env.VERDENT_PROXY_ENDPOINT ??
    process.env.VERDENT_ENDPOINT ??
    process.env.VERDENT_LLM_PROXY ??
    `${VERDENT_PROXY_PROD_BASE_URL}/llm/stream`
  )
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
    const set = new Set(
      (cur ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    let changed = false
    for (const h of loopback)
      if (!set.has(h)) {
        set.add(h)
        changed = true
      }
    if (changed) process.env[key] = [...set].join(",")
  }
}
ensureLoopbackProxyBypass()

/** keytar service/account where the Verdent desktop stores its cloud token. */
const KEYTAR_SERVICE = "ai.verdent.deck"
const KEYTAR_ACCOUNT = "access-token"

type CatalogEntry = {
  id: string
  name: string
  family: string
  context: number
  output: number
  reasoning: boolean
  attachment: boolean
  /** ASAR parseRemoteContextWindows: selectable context windows ({display:"300K",tokens:3e5}). */
  contextWindows?: Array<{ display: string; tokens: number }>
  /** ASAR parseRemoteEffortLevels / supportedReasoningEfforts: selectable effort labels (low..max). */
  efforts?: string[]
}

/** ASAR parseContextWindow accepts "300K"/"1M" style strings. */
export function parseContextWindowDisplay(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined
  const m = raw.trim().match(/^([\d.]+)\s*([KkMm])$/)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n)) return undefined
  return m[2].toLowerCase() === "m" ? Math.round(n * 1_000_000) : Math.round(n * 1_000)
}

/** ASAR parseRemoteContextWindows shape: {contextWindowDisplay, contextWindowTokens}. */
export function parseContextWindows(raw: unknown): Array<{ display: string; tokens: number }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Array<{ display: string; tokens: number }> = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const display = (item as any).contextWindowDisplay ?? (item as any).display
    const tokens = (item as any).contextWindowTokens ?? (item as any).tokens
    if (typeof display !== "string" || typeof tokens !== "number" || !Number.isFinite(tokens)) continue
    out.push({ display, tokens })
  }
  return out.length > 0 ? out : undefined
}

/** ASAR parseRemoteEffortLevels shape: {level, label} or plain strings. */
export function parseEffortLevels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === "string" && item) out.push(item.toLowerCase())
    else if (item && typeof item === "object" && typeof (item as any).label === "string")
      out.push((item as any).label.toLowerCase())
  }
  return out.length > 0 ? [...new Set(out)] : undefined
}

/**
 * Expand one catalog entry into one Model item per selectable context window
 * (ASAR exposes 300K + 1M for DeepSeek/GLM). The base id keeps the DEFAULT
 * (largest) window so existing saved selections keep working; extra windows
 * become suffixed ids `model@300k` that handleCompletions parses back into
 * `context_window_tokens` for the upstream body.
 */
export function expandCatalogEntry(entry: CatalogEntry): CatalogEntry[] {
  if (!entry.contextWindows || entry.contextWindows.length <= 1) return [entry]
  const sorted = [...entry.contextWindows].sort((a, b) => b.tokens - a.tokens)
  const out: CatalogEntry[] = [{ ...entry, context: sorted[0].tokens }]
  for (const w of sorted.slice(1)) {
    if (w.tokens >= sorted[0].tokens) continue
    out.push({
      ...entry,
      id: `${entry.id}@${w.display.toLowerCase().replace(/\s+/g, "")}`,
      name: `${entry.name} (${w.display})`,
      context: w.tokens,
    })
  }
  return out
}

/** Reverse of expandCatalogEntry's id suffix: "model@300k" -> {base, tokens}. */
export function splitModelContextSuffix(model: string): { base: string; tokens: number | undefined } {
  const match = model.match(/^(.*)@([^@]+)$/)
  if (!match) return { base: model, tokens: undefined }
  const parsed = parseContextWindowDisplay(match[2]!)
  if (parsed === undefined) return { base: model, tokens: undefined }
  return { base: match[1]!, tokens: parsed }
}

function decodeVerdentAccountModel(model: string): { model: string; accountId?: string; contextWindowTokens?: number } {
  // Account suffix is appended after any context-window suffix, e.g.
  // `glm-5.3-flash-free@300k@vd-abc`.
  const split = splitAccountModelID(model, [{ id: "verdent", accountPrefix: "vd-", aliasMarkers: [] }])
  const ctx = splitModelContextSuffix(split.baseModelID)
  return {
    model: ctx.base,
    ...(split.accountID ? { accountId: split.accountID } : {}),
    ...(ctx.tokens !== undefined ? { contextWindowTokens: ctx.tokens } : {}),
  }
}

const DEFAULT_EFFORTS = ["low", "high", "max"]

/**
 * Static fallback catalog. The two confirmed free models from the Verdent UI
 * (2026-08-31) plus the known free GPT-5.6 Luna. Context windows reflect the
 * upstream catalog (`deepseek-v4-flash` reports 1M). Live discovery overlays
 * this; static is the last-resort fallback so the provider is usable even when
 * the catalog endpoint is unreachable.
 */
const FALLBACK_CATALOG: CatalogEntry[] = [
  {
    id: "deepseek-v4-flash-free",
    name: "DeepSeek-V4-Flash-0731",
    family: "deepseek",
    context: 1_048_576,
    output: 64_000,
    reasoning: true,
    attachment: false,
    // ASAR defaultAgentModels: contextWindows [{300K},{1M}], supportsReasoningEffort
    contextWindows: [
      { display: "300K", tokens: 300_000 },
      { display: "1M", tokens: 1_048_576 },
    ],
    efforts: DEFAULT_EFFORTS,
  },
  {
    id: "glm-5.3-flash-free",
    name: "GLM-5.3-Flash",
    family: "glm",
    context: 1_048_576,
    output: 64_000,
    reasoning: true,
    attachment: true,
    contextWindows: [
      { display: "300K", tokens: 300_000 },
      { display: "1M", tokens: 1_048_576 },
    ],
    efforts: DEFAULT_EFFORTS,
  },
]

// --------------------------------------------------------------- token source

type TokenSource = {
  label: string
  get(): Promise<string | null>
}

/** Load the app's bundled keytar native module if present on disk. */
function loadBundledKeytar(): any | undefined {
  try {
    const candidates: string[] = []
    if (process.env.VERDENT_APP_DIR) candidates.push(process.env.VERDENT_APP_DIR)
    if (process.platform === "win32") {
      const local = process.env.LOCALAPPDATA
      if (local) candidates.push(`${local}\\Programs\\Verdent\\resources\\app.asar.unpacked\\node_modules\\keytar`)
      candidates.push("C:\\Program Files\\Verdent\\resources\\app.asar.unpacked\\node_modules\\keytar")
    } else if (process.platform === "darwin") {
      candidates.push("/Applications/Verdent.app/Contents/Resources/app.asar.unpacked/node_modules/keytar")
      candidates.push(
        `${process.env.HOME ?? ""}/Applications/Verdent.app/Contents/Resources/app.asar.unpacked/node_modules/keytar`,
      )
    } else {
      candidates.push("/opt/Verdent/resources/app.asar.unpacked/node_modules/keytar")
      candidates.push(`${process.env.HOME ?? ""}/.local/share/Verdent/resources/app.asar.unpacked/node_modules/keytar`)
    }
    for (const base of candidates) {
      if (!base) continue
      try {
        return require(`${base.replace(/\\/g, "/")}/lib/keytar.js`)
      } catch {
        // try next candidate
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

function keytarTokenSource(): TokenSource {
  const kt = loadBundledKeytar()
  return {
    label: "Verdent desktop keychain",
    async get() {
      if (!kt) return null
      try {
        const raw = await kt.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)
        if (!raw) return null
        const info = JSON.parse(raw)
        return typeof info?.accessToken === "string" ? info.accessToken : null
      } catch {
        return null
      }
    },
  }
}

function envTokenSource(): TokenSource {
  return {
    label: "VERDENT_ACCESS_TOKEN",
    async get() {
      const v = process.env.VERDENT_ACCESS_TOKEN?.trim()
      return v || null
    },
  }
}

const DESKTOP_TOKEN_SOURCE = keytarTokenSource()
const TOKEN_SOURCES: TokenSource[] = [envTokenSource(), DESKTOP_TOKEN_SOURCE]

let cachedToken: { token: string; at: number } | undefined

async function resolveToken(): Promise<string | null> {
  if (cachedToken && Date.now() - cachedToken.at < 60_000) return cachedToken.token
  for (const source of TOKEN_SOURCES) {
    const token = await source.get().catch(() => null)
    if (token) {
      cachedToken = { token, at: Date.now() }
      return token
    }
  }
  return null
}

async function resolveDesktopToken(): Promise<string | null> {
  return DESKTOP_TOKEN_SOURCE.get().catch(() => null)
}

export type VerdentAccountProfile = {
  nickname?: string
  teamId?: string
  expiresAt?: number
}

const profileCache = new Map<string, { at: number; profile: VerdentAccountProfile | undefined }>()
const PROFILE_CACHE_TTL_MS = 5 * 60_000

function verdentProfileBaseURL(): string {
  const configured = process.env.VERDENT_PROFILE_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, "")
  const stage = verdentStage()
  const fallback =
    stage === "dev"
      ? VERDENT_PROFILE_DEV_BASE_URL
      : stage === "fenji"
        ? VERDENT_PROFILE_FENJI_BASE_URL
        : VERDENT_PROFILE_PROD_BASE_URL
  return fallback
}

/** Best-effort profile enrichment; a token remains usable when this endpoint is unavailable. */
export async function fetchVerdentAccountProfile(token: string): Promise<VerdentAccountProfile | undefined> {
  const cached = profileCache.get(token)
  if (cached && Date.now() - cached.at < PROFILE_CACHE_TTL_MS) return cached.profile

  try {
    const response = await fetch(`${verdentProfileBaseURL()}/user/center/info`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Cookie: `token=${token}`,
        "User-Agent": `opencode/${InstallationVersion}`,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      profileCache.set(token, { at: Date.now(), profile: undefined })
      return undefined
    }

    const body = (await response.json()) as any
    const root = body?.data ?? body
    const user = root?.user ?? root?.userInfo ?? root
    const email = [user?.email, root?.email, body?.email].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    )
    const nickname = [email, user?.nickname, user?.displayName, root?.nickname]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim()
    const teamId = [user?.teamId, root?.teamId].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    )
    const profile = nickname || teamId ? { nickname, teamId } : undefined
    profileCache.set(token, { at: Date.now(), profile })
    return profile
  } catch {
    profileCache.set(token, { at: Date.now(), profile: undefined })
    return undefined
  }
}

// --------------------------------------------------------------- discovery

let discoveryCache: { at: number; catalog: CatalogEntry[] } | undefined = undefined

/**
 * Best-effort live catalog. The Verdent app fetches its model catalog from the
 * cloud; we attempt the same origin and fall back to the static list. Returns
 * null on total failure so the caller uses FALLBACK_CATALOG.
 */
async function discoverCatalog(): Promise<CatalogEntry[] | null> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.catalog
  // Multi-account: try any vault/env account first, then single-token fallback.
  let token: string | null = null
  let catalogTeamId: string | undefined
  try {
    const accounts = verdentRegistry.all()
    if (accounts.length) {
      token = accounts[0]!.credential.accessToken
      catalogTeamId = accounts[0]!.credential.teamId
    }
  } catch {}
  token ??= await resolveToken()
  if (!token) return null
  try {
    const res = await fetch(`${VERDENT_PROXY_PROD_BASE_URL}/config/model_list`, {
      method: "GET",
      headers: clientHeaders(token, catalogTeamId),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as any
    const models: any[] = body?.data?.model_config ?? body?.model_config ?? []
    if (!Array.isArray(models)) return null
    // Free models: costMultiplier 0, is_limit_free, or a "-free" key suffix.
    const entries: CatalogEntry[] = models
      .filter((m: any) => m?.key && (m.costMultiplier === 0 || m.is_limit_free === true || /-free$/.test(m.key)))
      .map((m: any) => ({
        id: m.key,
        name: m.label ?? m.key,
        family: (m.provider?.[0] ?? m.family ?? m.key).toString().toLowerCase(),
        context: Number(m.context_window_tokens ?? m.context_window ?? 0) || 1_048_576,
        output: Number(m.default_max_output_tokens ?? 0) || 64_000,
        reasoning: Boolean(m.supportsReasoningEffort ?? m.supports_thinking ?? m.reasoning),
        attachment: Boolean(m.supportsImages ?? m.attachment),
        contextWindows: parseContextWindows(m.contextWindows ?? m.context_windows),
        efforts: parseEffortLevels(m.effortLevels ?? m.effort_levels ?? m.supportedReasoningEfforts),
      }))
    if (entries.length === 0) return null
    const merged = mergeCatalogs(entries, FALLBACK_CATALOG)
    discoveryCache = { at: Date.now(), catalog: merged }
    return merged
  } catch {
    return null
  }
}

function mergeCatalogs(a: CatalogEntry[], b: CatalogEntry[]): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>()
  for (const e of [...b, ...a]) if (!byId.has(e.id)) byId.set(e.id, e)
  return [...byId.values()]
}

// ------------------------------------------------------------------ http server

type ProxyState = {
  server: Server
  port: number
  localToken: string
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

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, () => {
      const addr = server.address()
      resolve(typeof addr === "object" && addr ? addr.port : 0)
    })
  })
}

// --- OpenAI -> Anthropic Messages translation --------------------------------

type AnthropicMessage = {
  role: "user" | "assistant"
  content: Array<{ type: string; [k: string]: any }>
  /** 1:1 with capture: the desktop stamps the model key on every message. */
  model?: string
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
      .map((p: any) => p.text)
      .join("")
  }
  return ""
}

export function extractContentParts(content: unknown): Array<{ type: string; [k: string]: any }> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (Array.isArray(content)) {
    const parts: Array<{ type: string; [k: string]: any }> = []
    for (const p of content) {
      if (p?.type === "text" && typeof p?.text === "string" && p.text) parts.push({ type: "text", text: p.text })
      else if (p?.type === "image_url" && p?.image_url?.url) {
        // Verdent models with attachment=true can carry images; pass through as base64 if present
        parts.push({ type: "image", source: { type: "url", url: p.image_url.url } })
      }
    }
    return parts
  }
  return []
}

export function toAnthropicMessages(payload: any, model: string): { system: any[]; messages: AnthropicMessage[] } {
  const system: any[] = []
  const messages: AnthropicMessage[] = []
  const raw = Array.isArray(payload?.messages) ? payload.messages : []
  for (const m of raw) {
    const rawRole = m?.role
    if (rawRole === "system") {
      const text = extractText(m?.content)
      if (text) system.push({ type: "text", text, cache_control: { type: "ephemeral" } })
      // Also handle content array with multiple system blocks
      if (Array.isArray(m?.content)) {
        for (const p of m.content) {
          if (p?.type === "text" && typeof p?.text === "string" && p.text && p.text !== text) {
            system.push({ type: "text", text: p.text, cache_control: { type: "ephemeral" } })
          }
        }
      }
      continue
    }
    if (rawRole === "tool") {
      // Each OpenAI tool message -> separate Anthropic user message with single tool_result
      // This preserves the 1:1 tool_call_id linkage even when multiple tools run in parallel
      const text = extractText(m?.content)
      const toolResult: any = {
        type: "tool_result",
        tool_use_id: m?.tool_call_id ?? "",
        content: text || "",
        is_error: false,
      }
      messages.push({ role: "user", content: [toolResult], model })
      continue
    }
    if (rawRole === "assistant") {
      const content: Array<{ type: string; [k: string]: any }> = []
      // Handle both string and array content on assistant messages
      for (const part of extractContentParts(m?.content)) content.push(part)
      // Tool calls are only valid on assistant messages — map each to tool_use
      for (const tc of m?.tool_calls ?? []) {
        if (!tc?.function?.name) continue
        content.push({
          type: "tool_use",
          id: tc?.id ?? `toolu_${randomBytes(12).toString("hex")}`,
          name: tc.function.name,
          input: safeParse(tc?.function?.arguments ?? "{}"),
        })
      }
      // Anthropic requires at least one content block; skip truly empty turns
      // but preserve tool_use-only turns (common in agent loops)
      if (content.length === 0) continue
      messages.push({ role: "assistant", content, model })
      continue
    }
    // user (and any unknown role defaults to user)
    const content: Array<{ type: string; [k: string]: any }> = []
    for (const part of extractContentParts(m?.content)) content.push(part)
    if (content.length === 0) continue
    messages.push({ role: "user", content, model })
  }
  // Anthropic requires strict user/assistant alternation. Collapse consecutive
  // same-role messages by merging their content arrays (mirrors workbuddy's
  // role-coercion for the system-first requirement).
  const merged: AnthropicMessage[] = []
  for (const msg of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      last.content.push(...msg.content)
    } else {
      merged.push(msg)
    }
  }
  return { system, messages: merged }
}

/**
 * Verdent's Main Agent router requires the two system-context blocks that its
 * desktop app appends after the caller-controlled identity prompt. The first
 * block is deliberately ours; captured replay proved its text may change while
 * the two trailing blocks must remain present.
 */
function toVerdentSystem(system: any[], model: string): any[] {
  const callerText = system
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n")
  const rawBlocks = requiredSystemBlocks()
  // requiredSystemBlocks() may return a cached array; clone before mutating so
  // concurrent requests for different models don't contaminate each other.
  const blocks = rawBlocks.map((block) => ({ ...block, text: block.text.replaceAll("glm-5.3-flash-free", model) }))
  return [{ type: "text", text: callerText || "You are a helpful coding assistant." }, ...blocks]
}

export function safeParse(s: string): any {
  try {
    return JSON.parse(s || "{}")
  } catch {
    return {}
  }
}

export function toAnthropicTools(payload: any): any[] | undefined {
  const tools = Array.isArray(payload?.tools) ? payload.tools : []
  if (tools.length === 0) return undefined
  const out: any[] = []
  for (const t of tools) {
    const name = t?.function?.name
    if (typeof name !== "string" || !name) continue
    out.push({
      name,
      description: t?.function?.description ?? "",
      input_schema: t?.function?.parameters ?? { type: "object", properties: {} },
    })
  }
  return out.length ? out : undefined
}

export function toAnthropicToolChoice(payload: any): any | undefined {
  const tc = payload?.tool_choice
  if (tc === undefined || tc === null) return undefined
  if (typeof tc === "string") {
    if (tc === "auto") return { type: "auto" }
    if (tc === "required" || tc === "any") return { type: "any" }
    if (tc === "none") return { type: "none" }
    return undefined
  }
  if (typeof tc === "object") {
    if (tc.type === "function" && tc.function?.name) return { type: "tool", name: tc.function.name }
    if (tc.type === "auto" || tc.type === "any" || tc.type === "tool" || tc.type === "none") return tc
  }
  return undefined
}

// --- Anthropic Messages -> OpenAI translation --------------------------------

export function anthropicToOpenAIChat(body: any, requestedModel: string): any {
  const content = Array.isArray(body?.content) ? body.content : []
  let text = ""
  let reasoning = ""
  const toolCalls: any[] = []
  for (const block of content) {
    if (block?.type === "text") text += block.text ?? ""
    else if (block?.type === "thinking") reasoning += block.thinking ?? ""
    else if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop"
  const message: any = { role: "assistant", content: text }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  let usage: any = undefined
  if (body?.usage) {
    const u = body.usage
    const prompt = u.input_tokens ?? 0
    const completion = u.output_tokens ?? 0
    usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    }
    const cachedRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0
    const cachedCreation = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0
    const cached = cachedRead + cachedCreation
    if (
      cached > 0 ||
      typeof u.cache_read_input_tokens === "number" ||
      typeof u.cache_creation_input_tokens === "number"
    ) {
      usage.prompt_tokens_details = { cached_tokens: cachedRead || cached }
      // Preserve creation detail if present (some UIs read it)
      if (cachedCreation > 0) (usage.prompt_tokens_details as any).cache_creation_tokens = cachedCreation
    }
  }
  return {
    id: body?.id ?? `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? requestedModel,
    choices: [{ index: 0, logprobs: null, finish_reason: finishReason, message }],
    usage,
  }
}

function anthropicToOpenAISSE(body: any, requestedModel: string): string[] {
  const content = Array.isArray(body?.content) ? body.content : []
  const events: string[] = []
  const finishReason = content.some((b: any) => b?.type === "tool_use") ? "tool_calls" : "stop"
  let toolIndex = 0
  for (const block of content) {
    if (block?.type === "text" && block.text) {
      events.push(sse({ choices: [{ index: 0, delta: { content: block.text }, finish_reason: null }] }))
    } else if (block?.type === "thinking" && block.thinking) {
      events.push(sse({ choices: [{ index: 0, delta: { reasoning_content: block.thinking }, finish_reason: null }] }))
    } else if (block?.type === "tool_use") {
      events.push(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex++,
                    id: block.id,
                    type: "function",
                    function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      )
    }
  }
  // Include usage on the final chunk if present (mirrors streaming usage emission)
  const usage = body?.usage
    ? (() => {
        const u = body.usage
        const prompt = u.input_tokens ?? 0
        const completion = u.output_tokens ?? 0
        const cachedRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0
        const cachedCreation = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0
        const base: any = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
        if (
          cachedRead ||
          cachedCreation ||
          typeof u.cache_read_input_tokens === "number" ||
          typeof u.cache_creation_input_tokens === "number"
        ) {
          base.prompt_tokens_details = { cached_tokens: cachedRead || cachedRead + cachedCreation }
          if (cachedCreation > 0) (base.prompt_tokens_details as any).cache_creation_tokens = cachedCreation
        }
        return base
      })()
    : undefined
  if (usage) {
    events.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage }))
    // Also emit the AI-SDK `choices:[]` variant for adapters that expect it
    events.push(sse({ choices: [], usage }))
  } else {
    events.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }))
  }
  events.push("data: [DONE]\n\n")
  return events
}

export function sse(obj: any): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/**
 * ASAR parseSseFrame: split one frame into `event:` type and joined `data:`
 * payload (multi-line data arrays join with a space). Frames are separated by
 * blank lines; \r is normalized before splitting (readEventStream does the
 * same replace before split).
 */
export function parseSseFrames(sseText: string): Array<{ eventType: string | undefined; rawData: string | undefined }> {
  const normalized = sseText.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const out: Array<{ eventType: string | undefined; rawData: string | undefined }> = []
  for (const frame of normalized.split("\n\n")) {
    if (!frame.trim()) continue
    let eventType: string | undefined
    const dataLines: string[] = []
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.replace(/^event:\s*/, "").trim()
        continue
      }
      if (line.startsWith("data:")) dataLines.push(line.replace(/^data:\s*/, ""))
    }
    out.push({ eventType, rawData: dataLines.length > 0 ? dataLines.join(" ") : undefined })
  }
  return out
}

/** ASAR normalizeSseEventType: event-name resolution, lowercase, JSON type wins unless absent. */
function normalizeFrameEventType(eventType: string | undefined, parsedType: unknown): string | undefined {
  const fromJson = typeof parsedType === "string" ? parsedType : undefined
  const normalized = (fromJson ?? eventType)?.trim().toLowerCase()
  return normalized || undefined
}

/** Captured desktop sends "pc" / "windows" in both headers and trace metadata. */
function resolveDeviceType(): string {
  return process.env.VERDENT_DEVICE_TYPE?.trim() || "pc"
}
function resolveOsType(): string {
  return (
    process.env.VERDENT_OS_TYPE?.trim() ||
    (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux")
  )
}

/**
 * Headers the Verdent desktop client sends to its cloud LLM proxy
 * (VerdentProxyProvider, dist/index.mjs). Replicated verbatim so the upstream
 * treats OpenFork's requests as a normal first-party client and applies the
 * same free-model entitlement. Values mirror the app: OS/CPU-Arch fall back to
 * the platform, version comes from the Verdent app package when discoverable,
 * and the rest are best-effort identity headers (no secrets).
 */
function clientHeaders(token: string, accountTeamId?: string): Record<string, string> {
  // 1:1 with VerdentProxyProvider at 26262770: OS/CPU-Arch/agent_type + X-Version-Code/Device-Model/X-Device-ID/X-Team-ID/X-Device-Type/X-OS-Type
  // 1:1 with the captured desktop request: OS is the full `os.type() os.release()`
  // string (e.g. "Windows_NT 10.0.22631"), NOT the bare process.platform.
  const osName = `${os.type()} ${os.release()}`
  const cpuArch = process.arch
  const version = process.env.VERDENT_APP_VERSION ?? process.env.VERDENT_VERSION ?? VERDENT_CURRENT_VERSION
  // Captured desktop sends the CPU model name here (e.g. "AMD Ryzen 9 5900X ...").
  const deviceModel = process.env.VERDENT_DEVICE_MODEL?.trim() ?? detectDeviceModel()
  const deviceId = resolveDeviceId()
  // Captured desktop sends "0" for a personal (non-team) context.
  const teamId = accountTeamId?.trim() || resolveTeamId() || "0"
  // device_type/os_type mirror buildClientInfoHeaders at current ASAR (pc/windows)
  const deviceType = resolveDeviceType()
  const osType = resolveOsType()
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "*/*",
    "accept-language": "*",
    "sec-fetch-mode": "cors",
    "user-agent": "node",
    "accept-encoding": "gzip, deflate, br",
    authorization: `Bearer ${token}`,
    cookie: `token=${token}`,
    "verdent-proxy-beta": PROXY_BETA_HEADER,
    OS: osName,
    "CPU-Arch": cpuArch,
    agent_type: "ts_agent",
  }
  if (version) headers["X-Version-Code"] = version
  if (deviceModel) headers["Device-Model"] = deviceModel
  if (deviceId) headers["X-Device-ID"] = deviceId
  if (teamId) headers["X-Team-ID"] = teamId
  if (deviceType) headers["X-Device-Type"] = deviceType
  if (osType) headers["X-OS-Type"] = osType
  return headers
}

/**
 * 1:1 with the captured desktop request.
 *
 * session_id is stable for the whole session; conv_id is a DISTINCT
 * per-conversation UUID (captured: session_id session_9ae78629… with
 * conv_id conv_ebe56dd7… — different values). react_id is a fresh per-turn
 * `model_agent_` UUID.
 */
const sessionAnchor = randomUUID()

function buildVerdentIds() {
  const sessionId = `session_${sessionAnchor}`
  const proxyConvId = `conv_${randomUUID()}`
  const reactId = `model_agent_${randomUUID()}`
  return { sessionId, convId: proxyConvId, reactId }
}

// ----- Verdent free-limit detection (5h 400 shared, weekly) ---------------
// Verdent's proxy can surface limit errors in three ways:
//   - HTTP 429 with body "rate_limit..." (rare)
//   - HTTP 200 with SSE error frame: {"type":"error","error":"You've reached the glm-5.3-flash-free limit for the weekly limit."}
//   - HTTP 400/403 with body containing "...limit..."
// The desktop shows "Model Limit Reached" for the SSE case while opencode would
// previously surface "not authorized". Detect all variants and map them to 429
// so the SDK surfaces a quota error and our usage tracker counts the hit.
function isVerdentRateLimitHint(raw: string): boolean {
  const lower = raw.toLowerCase()
  // Structured / exact phrasings first — high confidence, no fuzzy fallback needed.
  if (lower.includes("rate_limit") || lower.includes("rate limit") || lower.includes("rate-limit")) return true
  if (
    lower.includes("quota") ||
    lower.includes("too many requests") ||
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted")
  )
    return true
  if (
    lower.includes("model limit reached") ||
    lower.includes("weekly limit") ||
    lower.includes("5-hour") ||
    lower.includes("5 hour")
  )
    return true
  // 429 as a structured code, not as a substring of a token count / timestamp / ID.
  if (
    lower.includes('"code":429') ||
    lower.includes('"code":"429"') ||
    lower.includes('"status":429') ||
    lower.includes('"status":"429"')
  )
    return true
  if (
    /\b429\b/.test(raw) &&
    (lower.includes("error") || lower.includes("rate") || lower.includes("limit") || lower.includes("quota"))
  )
    return true
  // Fuzzy fallback: "limit" plus a strong qualifier. Avoid `limit && glm` alone — that
  // would misclassify "context limit exceeded" mentioning the model name.
  if (
    lower.includes("limit") &&
    (lower.includes("reached") || lower.includes("weekly") || lower.includes("5h") || lower.includes("free limit"))
  )
    return true
  return false
}

function isVerdentRateLimitStatus(status: number, raw: string): boolean {
  if (status === 429) return true
  return isVerdentRateLimitHint(raw)
}

function verdentRateLimitDetailFromSSE(sseText: string): string | undefined {
  for (const { eventType, rawData } of parseSseFrames(sseText)) {
    if (!rawData || rawData === "[DONE]") continue
    if (!isVerdentRateLimitHint(rawData)) continue
    const event = eventType?.trim().toLowerCase()
    if (event === "error" || event === "stream_error") return rawData.slice(0, 600)
    let parsed: any
    try {
      parsed = JSON.parse(rawData)
    } catch {
      continue
    }
    const type = normalizeFrameEventType(eventType, parsed?.type)
    if (type === "error" || type === "stream_error" || parsed?.error) return rawData.slice(0, 600)
  }
  return undefined
}

function sseBoundary(buffer: string): { index: number; length: number } | undefined {
  let best: { index: number; length: number } | undefined
  for (const [separator, length] of [
    ["\n\n", 2],
    ["\r\n\r\n", 4],
    ["\r\r", 2],
  ] as const) {
    const index = buffer.indexOf(separator)
    if (index >= 0 && (!best || index < best.index)) best = { index, length }
  }
  return best
}

function replayResponseBody(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!)
        return
      }
      const next = await reader.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}

/**
 * Inspect only the beginning of an SSE response. Verdent sometimes returns a
 * 200 response whose first event is an in-band quota error; the governor needs
 * a 429 status before it admits the body. Never call `response.text()` here:
 * that would buffer the entire generation and defeat realtime reasoning.
 */
async function peekVerdentSse(response: Response): Promise<Response> {
  const body = response.body
  if (!body) return response
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  let inspected = ""
  let frameCursor = 0
  let frameCount = 0
  let bytes = 0
  let safeToStream = false
  while (!safeToStream && bytes < 64 * 1024 && frameCount < 8) {
    const next = await reader.read()
    if (next.done) {
      inspected += decoder.decode()
      break
    }
    const chunk = next.value
    chunks.push(chunk)
    bytes += chunk.byteLength
    inspected += decoder.decode(chunk, { stream: true })
    for (;;) {
      const boundary = sseBoundary(inspected.slice(frameCursor))
      if (!boundary) break
      const start = frameCursor
      const end = start + boundary.index
      const frame = inspected.slice(start, end)
      frameCursor = end + boundary.length
      frameCount++
      const detail = verdentRateLimitDetailFromSSE(frame)
      if (detail) {
        return new Response(replayResponseBody(chunks, reader), {
          status: 429,
          headers: new Headers(response.headers),
          statusText: response.statusText,
        })
      }
      const parsed = (() => {
        const data = parseSseFrames(`${frame}\n\n`)[0]?.rawData
        try {
          return data ? JSON.parse(data) : undefined
        } catch {
          return undefined
        }
      })()
      const type = normalizeFrameEventType(parseSseFrames(`${frame}\n\n`)[0]?.eventType, parsed?.type)
      // A normal response can be handed back as soon as the first meaningful
      // content/terminal frame is available. Message-start and heartbeat-only
      // prefixes are cheap to inspect while still allowing an early error.
      if (
        type === "content_block_start" ||
        type === "content_block_delta" ||
        type === "message_stop" ||
        type === "error" ||
        type === "stream_error" ||
        rawFrameIsDone(frame)
      ) {
        safeToStream = true
        break
      }
      if (frameCount >= 8 || bytes >= 64 * 1024) {
        safeToStream = true
        break
      }
    }
  }
  return new Response(replayResponseBody(chunks, reader), {
    status: response.status,
    headers: new Headers(response.headers),
    statusText: response.statusText,
  })
}

function rawFrameIsDone(frame: string): boolean {
  return parseSseFrames(`${frame}\n\n`)[0]?.rawData === "[DONE]"
}

function verdentPriorityFor(payload: any, messages: any[]): number {
  if (messages.some((m: any) => m?.role === "tool")) return 0
  const tiny = typeof payload?.max_tokens === "number" && payload.max_tokens <= 64
  const single = messages.filter((m: any) => m?.role === "user").length <= 1
  if (!payload?.tools && tiny && single) return 4
  return 2
}

// --- request handling --------------------------------------------------------

async function handleCompletions(req: IncomingMessage, res: ServerResponse, payload: any) {
  const requestedModelRaw = typeof payload?.model === "string" ? payload.model : "deepseek-v4-flash-free"
  const decodedRequest = decodeVerdentAccountModel(requestedModelRaw)
  const requestedModel = decodedRequest.model
  const explicitAccountId =
    decodedRequest.accountId ??
    (req.headers["x-verdent-account"] as string | undefined) ??
    (req.headers["x-account-id"] as string | undefined)
  const sessionHeader =
    (req.headers["x-opencode-session"] as string | undefined) ??
    (req.headers["x-session-affinity"] as string | undefined) ??
    (req.headers["x-session-id"] as string | undefined) ??
    "default"
  const requestId =
    (req.headers["x-opencode-request"] as string | undefined) ??
    (req.headers["x-request-id"] as string | undefined) ??
    randomBytes(12).toString("hex")

  // Multi-account selection — very similar to workbuddy's AccountRouter.
  // Explicit `@vd-...` suffix or `x-verdent-account` header rebinds the session.
  let account: import("./verdent-accounts").VerdentAccount | undefined
  let token: string | undefined
  const selection = verdentRouter.select(sessionHeader, requestedModel, explicitAccountId)
  if (selection) {
    account = selection.account
    token = account.credential.accessToken
  } else {
    const accounts = verdentRegistry.all()
    if (accounts.length) {
      return sendJson(res, 429, {
        error: {
          message: `No eligible Verdent account currently supports ${requestedModel}; choose an account or wait for its window to reset.`,
          type: "account_unavailable",
        },
      })
    }
    // Fallback single-token mode for users who haven't migrated to the vault yet.
    const fallbackToken = await resolveToken()
    if (!fallbackToken) {
      return sendJson(res, 401, {
        error: {
          message:
            "No Verdent session found. Open the Verdent desktop app and sign in, or set VERDENT_ACCESS_TOKEN / add an account via the vault.",
          type: "authentication_error",
        },
      })
    }
    token = fallbackToken
    account = getFallbackAccount(fallbackToken)
  }
  if (!account || !token) {
    return sendJson(res, 401, { error: { message: "No Verdent session found.", type: "authentication_error" } })
  }
  // "@300k" suffix from per-context-window model items selects the upstream
  // context_window_tokens; the base id goes on the wire.
  const model = requestedModel
  const contextFromId = decodedRequest.contextWindowTokens
  const { system, messages: rawMessages } = toAnthropicMessages(payload, model)
  const messages = ensureTrailingUserContinuation(coalesceAdjacentMessages(rawMessages))
  const verdentSystem = toVerdentSystem(system, model)
  const rawTools = toAnthropicTools(payload)
  const tools = normalizeAnthropicToolsForModel(rawTools, model)
  const { sessionId, convId, reactId } = buildVerdentIds()
  const stream = Boolean(payload?.stream)

  // Verdent's cloud proxy speaks a custom encrypted protocol (dist/index.mjs
  // VerdentProxyProvider). The body fields below mirror that provider:
  //   POST https://llm-proxy.verdent.ai/llm/stream
  //   headers: authorization Bearer, cookie, verdent-proxy-beta, OS/CPU-Arch,
  //            X-Version-Code (must be current, e.g. 2.12.3)
  //   body: { channel, model, session_id, conv_id, react_id, react_type,
  //           stream, max_tokens, system: proxyEncode(...),
  //           messages: proxyEncode(...), agent_name, encrypt: true, ... }
  const env = buildEnv({ osVersion: detectOsVersion(), shell: detectShell() })
  // Key order below mirrors the captured desktop request exactly:
  // channel, model, session_id, conv_id, react_id, react_type, stream,
  // max_tokens, temperature, system, tools, tool_choice, messages,
  // agent_name, env, encrypt, custom_trace_tags_tmp,
  // custom_trace_metadata_tmp, model_catalog_version, is_eco, is_auto, native_api
  const toolChoice = toAnthropicToolChoice(payload)
  // Effort: variant options merge into the OpenAI body as `reasoningEffort`
  // (session/llm/request.ts variant merge); AI SDK serializes it as
  // `reasoning_effort`. ASAR sends `effort: string` on the proxy body.
  const effort = payload?.reasoning_effort ?? payload?.reasoningEffort ?? payload?.effort ?? undefined
  // Context window: model-item suffix wins, then explicit request fields.
  const contextWindowTokens =
    contextFromId ?? payload?.context_window_tokens ?? payload?.contextWindowTokens ?? undefined
  const requestBody: any = {
    channel: "deck",
    model,
    session_id: sessionId,
    conv_id: convId,
    react_id: reactId,
    react_type: "Main Agent",
    stream: true,
    // Captured desktop sends 64000 for this model; match it when unset.
    max_tokens: payload?.max_tokens ?? payload?.maxOutputTokens ?? 64_000,
    // Captured desktop always sends temperature (1 for main agent turns).
    temperature: typeof payload?.temperature === "number" ? payload.temperature : 1,
    system: proxyEncode(verdentSystem),
    ...(tools && tools.length > 0
      ? { tools: proxyEncode(tools), ...(toolChoice ? { tool_choice: toolChoice } : { tool_choice: { type: "auto" } }) }
      : toolChoice
        ? { tool_choice: toolChoice }
        : {}),
    messages: proxyEncode(messages),
    agent_name: "VerdentDeck",
    env,
    encrypt: true,
    // 1:1 with the captured desktop request: these three are ALWAYS present
    // (tags is an empty array, metadata carries routing/cwd/scene info).
    custom_trace_tags_tmp: [],
    custom_trace_metadata_tmp: {
      selected_model_id: model,
      effective_model_id: model,
      image_route_selected_model_is_byok: false,
      cwd: process.cwd(),
      conversation_scene: "worker",
      conversation_prompt_source: "user",
      action_type: "text",
      device_type: resolveDeviceType(),
      os_type: resolveOsType(),
      user_query: lastUserText(payload),
    },
    model_catalog_version: modelCatalogVersion(),
    // ASAR: `...typeof input.effort=="string"?{effort}:{}` and
    // `...typeof input.contextWindowTokens=="number"?{context_window_tokens}:{}`.
    ...(typeof effort === "string" && effort ? { effort } : {}),
    ...(typeof contextWindowTokens === "number" && contextWindowTokens > 0
      ? { context_window_tokens: contextWindowTokens }
      : {}),
    is_eco: false,
    is_auto: false,
    // 1:1 with ASAR 26257828: the desktop always sends this trailing field
    native_api: process.env.VERDENT_NATIVE_API === "true",
  }
  // Per-account headers — teamId is per-credential, not global.
  const headers: Record<string, string> = {
    ...clientHeaders(token),
    "X-Team-ID": account.credential.teamId ?? resolveTeamId() ?? "0",
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

  let result: Awaited<ReturnType<typeof account.governor.runGeneration>> | undefined
  try {
    result = await account.governor.runGeneration({
      priority: verdentPriorityFor(payload, messages),
      genKey: `${account.id}:${requestId}`,
      model: requestedModel,
      session: sessionHeader,
      isExpired: () => false,
      refresh: async () => false,
      transport: async () => {
        const res = await fetch(verdentProxyEndpoint(), {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        })
        // Verdent can surface free-model limits as 200 + SSE error frames.
        // Peek only a bounded prefix so the governor can learn an early 429
        // without buffering the generation before reasoning reaches the client.
        if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) return peekVerdentSse(res)
        return res
      },
      signal: cancellation.signal,
      enrollmentEpoch: account.credential.enrollmentEpoch,
    })
  } catch (e) {
    cleanupCancellation()
    if (cancellation.signal.aborted) return
    if (e instanceof AdmissionError) {
      const status =
        e.kind === "quota"
          ? 402
          : e.kind === "queue"
            ? 503
            : e.kind === "cancel"
              ? 499
              : e.kind === "duplicate"
                ? 409
                : 429
      const type =
        e.kind === "quota"
          ? "quota_exhausted"
          : e.kind === "queue"
            ? "unavailable_error"
            : e.kind === "cancel"
              ? "canceled"
              : e.kind === "duplicate"
                ? "duplicate_request"
                : "rate_limit_error"
      if (!res.headersSent && !res.writableEnded) {
        return sendJson(
          res,
          status,
          { error: { message: e.message, type } },
          e.retryAfter > 0 ? { "Retry-After": String(e.retryAfter) } : undefined,
        )
      }
      return
    }
    throw e
  }
  const upstream = result.res
  // Lease spans the entire SSE body, not just headers — release after draining.
  let leaseReleased = false
  const releaseLease = () => {
    if (!leaseReleased) {
      leaseReleased = true
      try {
        result!.lease.release()
      } catch {}
    }
  }

  try {
    if (!upstream.ok) {
      const raw = await upstream.text().catch(() => "")
      const status = upstream.status === 401 || upstream.status === 403 ? 401 : upstream.status
      const isRateLimit = isVerdentRateLimitStatus(upstream.status, raw)
      if (isRateLimit) account.governor.recordInBandRateLimit(model, raw)
      releaseLease()
      return sendJson(res, isRateLimit ? 429 : status, {
        error: {
          message: isRateLimit
            ? `Verdent rate limit: ${raw.slice(0, 600)}`
            : `Verdent session is not authorized or the model is unavailable. Open the Verdent desktop app and confirm you are signed in. ${raw.slice(0, 600)}`,
          type: isRateLimit ? "rate_limit_error" : "upstream_error",
        },
      })
    }

    const contentType = upstream.headers.get("content-type") ?? ""

    if (!stream) {
      // Non-streaming OpenAI call: upstream still returns SSE (stream:true);
      // collect the stream and synthesize a single chat.completion.
      if (contentType.includes("text/event-stream")) {
        const text = await upstream.text()
        const limitDetail = verdentRateLimitDetailFromSSE(text)
        if (limitDetail) {
          account.governor.recordInBandRateLimit(model, limitDetail)
          return sendJson(res, 429, {
            error: { message: `Verdent rate limit: ${limitDetail}`, type: "rate_limit_error" },
          })
        }
        const assembled = sseToAnthropicBody(text)
        if (assembled) return sendJson(res, 200, anthropicToOpenAIChat(assembled, model))
        // Fallback: treat raw SSE text as content
        return sendJson(res, 200, anthropicToOpenAIChat({ content: [{ type: "text", text }], model }, model))
      }
      const body = (await upstream.json().catch(() => null)) as any
      if (body) {
        const bodyText = JSON.stringify(body)
        if (isVerdentRateLimitHint(bodyText)) {
          account.governor.recordInBandRateLimit(model, bodyText)
          return sendJson(res, 429, {
            error: { message: `Verdent rate limit: ${bodyText.slice(0, 600)}`, type: "rate_limit_error" },
          })
        }
        return sendJson(res, 200, anthropicToOpenAIChat(body, model))
      }
      const text = await upstream.text()
      if (isVerdentRateLimitHint(text)) {
        account.governor.recordInBandRateLimit(model, text)
        return sendJson(res, 429, {
          error: { message: `Verdent rate limit: ${text.slice(0, 600)}`, type: "rate_limit_error" },
        })
      }
      return sendJson(res, 200, anthropicToOpenAIChat({ content: [{ type: "text", text }], model }, model))
    }

    // Streaming OpenAI call: translate Verdent SSE (Anthropic-style events)
    // into OpenAI SSE. Use incremental frame-by-frame translation so
    // reasoning deltas (`reasoning_content`) stream in realtime instead of
    // being buffered until the upstream completes. We peek at the first
    // SSE frame(s) before committing to 200 so an in-band rate-limit error
    // (200 + event:error with "weekly limit" / "model limit reached") can
    // still be surfaced as HTTP 429.
    if (contentType.includes("text/event-stream")) {
      // Prefer true streaming: pipe upstream SSE incrementally.
      // Fall back to buffered text if body is not a stream (e.g. mocked).
      if (upstream.body) {
        let earlyError: string | undefined
        try {
          earlyError = await pipeVerdentStream(upstream, res, model, {
            signal: cancellation.signal,
            onRateLimit: (detail) => account.governor.recordInBandRateLimit(model, detail),
          })
        } catch (e: any) {
          if (!res.headersSent) {
            return sendJson(res, 502, {
              error: { message: `Verdent upstream error: ${e?.message ?? "unknown"}`, type: "upstream_error" },
            })
          }
          try {
            res.end()
          } catch {}
          return
        }
        if (earlyError) {
          // pipeVerdentStream detected an early rate-limit before headers.
          // It already sent 429 JSON; just return.
          return
        }
        return
      }
      // Fallback: no stream body (should not happen), buffer.
      const text = await upstream.text()
      const limitDetail = verdentRateLimitDetailFromSSE(text)
      if (limitDetail) {
        account.governor.recordInBandRateLimit(model, limitDetail)
        return sendJson(res, 429, {
          error: { message: `Verdent rate limit: ${limitDetail}`, type: "rate_limit_error" },
        })
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-verdent-model": model,
      })
      const openaiEvents = verdentSSEToOpenAI(text, model)
      for (const ev of openaiEvents) {
        if (res.writableEnded) break
        res.write(ev)
      }
      res.end()
      return
    }

    const text = await upstream.text()
    if (isVerdentRateLimitHint(text) && text.toLowerCase().includes("error")) {
      const limitDetail = verdentRateLimitDetailFromSSE(text) ?? text.slice(0, 600)
      account.governor.recordInBandRateLimit(model, limitDetail)
      return sendJson(res, 429, { error: { message: `Verdent rate limit: ${limitDetail}`, type: "rate_limit_error" } })
    }
    if (text.includes("data:") || text.includes("event:")) {
      // This can also be SSE despite missing content-type (e.g. via proxy).
      // Use the same incremental pipe if we had a stream, but here we only
      // have buffered text, so translate buffered.
      const limitDetail2 = verdentRateLimitDetailFromSSE(text)
      if (limitDetail2) {
        account.governor.recordInBandRateLimit(model, limitDetail2)
        return sendJson(res, 429, {
          error: { message: `Verdent rate limit: ${limitDetail2}`, type: "rate_limit_error" },
        })
      }
      const openaiEvents = verdentSSEToOpenAI(text, model)
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-verdent-model": model,
      })
      for (const ev of openaiEvents) res.write(ev)
      res.end()
      return
    }
    try {
      const body = JSON.parse(text)
      const bodyText = JSON.stringify(body)
      if (isVerdentRateLimitHint(bodyText)) {
        account.governor.recordInBandRateLimit(model, bodyText)
        return sendJson(res, 429, {
          error: { message: `Verdent rate limit: ${bodyText.slice(0, 600)}`, type: "rate_limit_error" },
        })
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-verdent-model": model,
      })
      for (const ev of anthropicToOpenAISSE(body, model)) res.write(ev)
    } catch {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-verdent-model": model,
      })
      res.write(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] }))
      res.write("data: [DONE]\n\n")
    }
    res.end()
  } catch (err: any) {
    if (cancellation.signal.aborted || res.destroyed || res.writableEnded) return
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: `Verdent upstream error: ${err?.message ?? "unknown"}`, type: "upstream_error" },
      })
    } else {
      res.end()
    }
  } finally {
    cleanupCancellation()
    releaseLease()
  }
}

export function sseToAnthropicBody(sseText: string): any | null {
  // Collect Anthropic content blocks from Verdent SSE so a non-streaming
  // caller can be satisfied even though the proxy always streams.
  // Handles text, thinking, and tool_use blocks — mirrors workbuddy's
  // Accumulated pattern but for Anthropic's content_block_* events.
  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolMap = new Map<number, { id: string; name: string; json: string }>()
  let usage: any = undefined
  let model: string | undefined
  let sawMessageStop = false
  // ASAR readEventStream frame discipline: event: lines, multi-line data,
  // [DONE]/message_integrity terminal, heartbeat/ping skipped, in-band errors
  // abort assembly, frames after message_stop dropped.
  for (const { eventType, rawData } of parseSseFrames(sseText)) {
    if (!rawData) continue
    const raw = rawData
    if (raw === "[DONE]") break
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const type = normalizeFrameEventType(eventType, parsed?.type)
    if (type === "heartbeat" || type === "ping") continue
    if (type === "stream_error" || type === "error") break
    if (!parsed || typeof parsed !== "object") continue
    const obj = type && parsed.type !== type ? { ...parsed, type } : parsed
    if (sawMessageStop && obj.type !== "message_integrity") continue
    if (obj.type === "message_integrity") break
    if (obj.type === "content_block_start") {
      const block = obj.content_block
      const idx = typeof obj.index === "number" ? obj.index : 0
      if (block?.type === "text" && typeof block.text === "string" && block.text) textParts.push(block.text)
      else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking)
        thinkingParts.push(block.thinking)
      else if (block?.type === "tool_use" || block?.type === "server_tool_use") {
        toolMap.set(idx, {
          id: block.id ?? `toolu_${randomBytes(12).toString("hex")}`,
          name: block.name ?? "",
          json: "",
        })
        // Anthropic may include partial input in the start event
        if (block.input && typeof block.input === "object" && Object.keys(block.input).length > 0) {
          toolMap.get(idx)!.json = JSON.stringify(block.input)
        }
      }
    } else if (obj.type === "content_block_delta") {
      const idx = typeof obj.index === "number" ? obj.index : 0
      const d = obj?.delta
      // ASAR emits both bare fields (text/thinking/partial_json) and typed deltas (type:"text_delta"/"thinking_delta"/"input_json_delta")
      if (typeof d?.text === "string" && d.text) textParts.push(d.text)
      else if (typeof d?.thinking === "string" && d.thinking) thinkingParts.push(d.thinking)
      else if (typeof d?.partial_json === "string" && d.partial_json) {
        const entry = toolMap.get(idx)
        if (entry) entry.json += d.partial_json
        else toolMap.set(idx, { id: `toolu_${randomBytes(12).toString("hex")}`, name: "", json: d.partial_json })
      } else if (typeof d?.input_json === "string" && d.input_json) {
        const entry = toolMap.get(idx)
        if (entry) entry.json += d.input_json
        else toolMap.set(idx, { id: `toolu_${randomBytes(12).toString("hex")}`, name: "", json: d.input_json })
      } else if (d?.type === "text_delta" && typeof d?.text === "string" && d.text) textParts.push(d.text)
      else if (d?.type === "thinking_delta" && typeof d?.thinking === "string" && d.thinking)
        thinkingParts.push(d.thinking)
      else if (d?.type === "input_json_delta" && typeof d?.partial_json === "string" && d.partial_json) {
        const entry = toolMap.get(idx)
        if (entry) entry.json += d.partial_json
        else toolMap.set(idx, { id: `toolu_${randomBytes(12).toString("hex")}`, name: "", json: d.partial_json })
      } else if (d?.type === "signature_delta" && typeof d?.signature === "string" && d.signature) {
        // ignore signature — only needed for thinking integrity, not content
      }
    } else if (obj.type === "message_delta") {
      // capture usage regardless of stop_reason presence; ASAR's message_delta carries output_tokens — merge, don't overwrite
      if (obj?.usage) usage = { ...(usage ?? {}), ...obj.usage }
    } else if (obj.type === "message_stop") {
      // ASAR normalizeStopUsage: terminal usage is authoritative; merge keeps
      // message_start's input_tokens when message_stop omits them.
      if (obj?.usage) usage = { ...(usage ?? {}), ...obj.usage }
      sawMessageStop = true
    } else if (obj.type === "message_start" && obj?.message) {
      if (obj.message?.model) model = obj.message.model
      if (obj.message?.usage) usage = { ...(usage ?? {}), ...obj.message.usage }
      if (Array.isArray(obj.message?.content)) {
        for (const b of obj.message.content) {
          if (b?.type === "text" && b.text) textParts.push(b.text)
          else if (b?.type === "thinking" && b.thinking) thinkingParts.push(b.thinking)
          else if (b?.type === "tool_use")
            toolMap.set(toolMap.size, { id: b.id, name: b.name, json: JSON.stringify(b.input ?? {}) })
        }
      }
    } else if (Array.isArray(obj?.content)) {
      for (const b of obj.content) {
        if (b?.type === "text" && b.text) textParts.push(b.text)
        else if (b?.type === "thinking" && b.thinking) thinkingParts.push(b.thinking)
        else if (b?.type === "tool_use")
          toolMap.set(toolMap.size, { id: b.id, name: b.name, json: JSON.stringify(b.input ?? {}) })
      }
      if (obj.usage) usage = { ...(usage ?? {}), ...obj.usage }
      if (obj.model) model = obj.model
    }
    if (obj?.usage) usage = { ...(usage ?? {}), ...obj.usage }
    if (obj?.model) model = obj.model
  }
  const blocks: any[] = []
  if (textParts.length) blocks.push({ type: "text", text: textParts.join("") })
  if (thinkingParts.length) blocks.push({ type: "thinking", thinking: thinkingParts.join("") })
  for (const [, entry] of [...toolMap.entries()].sort((a, b) => a[0] - b[0])) {
    let input: any = {}
    if (entry.json) {
      try {
        input = JSON.parse(entry.json)
      } catch {
        // Incomplete JSON during streaming — preserve empty and let caller handle
        input = {}
      }
    }
    blocks.push({ type: "tool_use", id: entry.id, name: entry.name, input })
  }
  if (blocks.length === 0) return null
  return { content: blocks, usage, model }
}

// Shared SSE→OpenAI translator — single state machine for both buffered
// (verdentsSEToOpenAI) and incremental (pipeVerdentStream) sinks. This
// eliminates the previous triplicate (buffered + web-reader + async-iterable)
// that had to be kept in sync by hand.
type VerdentOpenAISink = {
  pushDelta: (delta: any) => void
  pushError: (detail: string, isLimit: boolean, raw: string) => void
}

function createVerdentOpenAITranslator(modelRef: { current: string }, sink: VerdentOpenAISink) {
  const toolIndexMap = new Map<number, number>()
  let nextToolIndex = 0
  let sawContent = false
  let sawMessageStop = false
  let sawTerminalFrame = false
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let cacheRead: number | undefined
  let cacheCreation: number | undefined
  let finishReason: string | undefined
  let terminalError = false

  const now = () => Math.floor(Date.now() / 1000)
  const chunkId = () => `chatcmpl-${reactShortId()}`

  function ingestUsage(u: any) {
    if (!u || typeof u !== "object") return
    if (typeof u.input_tokens === "number") inputTokens = u.input_tokens
    if (typeof u.output_tokens === "number") outputTokens = u.output_tokens
    if (typeof u.cache_read_input_tokens === "number") cacheRead = u.cache_read_input_tokens
    if (typeof u.cache_creation_input_tokens === "number") cacheCreation = u.cache_creation_input_tokens
  }
  function buildUsage(): any | undefined {
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      cacheRead === undefined &&
      cacheCreation === undefined
    )
      return undefined
    const prompt = inputTokens ?? 0
    const completion = outputTokens ?? 0
    const out: any = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
    const cached = (cacheRead ?? 0) + (cacheCreation ?? 0)
    if (cached > 0 || cacheRead !== undefined || cacheCreation !== undefined) {
      out.prompt_tokens_details = { cached_tokens: cacheRead ?? cached }
      if (cacheCreation !== undefined && cacheCreation > 0)
        (out.prompt_tokens_details as any).cache_creation_tokens = cacheCreation
    }
    return out
  }
  const pushDelta = (delta: any) => {
    sawContent = true
    sink.pushDelta(delta)
  }
  const handleFrame = (eventType: string | undefined, rawData: string | undefined): "error" | "done" | undefined => {
    if (!rawData) return undefined
    if (terminalError) return "error"
    const raw = rawData
    if (raw === "[DONE]") {
      sawTerminalFrame = true
      return "done"
    }
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    const type = normalizeFrameEventType(eventType, parsed?.type)
    if (type === "heartbeat" || type === "ping") return undefined
    if (type === "stream_error" || type === "error") {
      const detail =
        typeof parsed?.error === "string" ? parsed.error : typeof parsed?.message === "string" ? parsed.message : raw
      const detailStr = String(detail)
      const isLimit = isVerdentRateLimitHint(detailStr) || isVerdentRateLimitHint(raw)
      sink.pushError(detailStr, isLimit, raw)
      terminalError = true
      sawTerminalFrame = true
      return "error"
    }
    if (!parsed || typeof parsed !== "object") return undefined
    const obj = type && parsed.type !== type ? { ...parsed, type } : parsed
    if (sawMessageStop && obj.type !== "message_integrity") return undefined
    if (obj?.usage) ingestUsage(obj.usage)
    if (obj?.message?.usage) ingestUsage(obj.message.usage)
    if (obj.type === "message_start") {
      if (obj?.message?.usage) ingestUsage(obj.message.usage)
    } else if (obj.type === "content_block_start") {
      const block = obj.content_block
      const aIdx = typeof obj.index === "number" ? obj.index : 0
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        pushDelta({ content: block.text })
      } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        pushDelta({ reasoning_content: block.thinking })
      } else if (block?.type === "tool_use" || block?.type === "server_tool_use") {
        let oIdx = toolIndexMap.get(aIdx)
        if (oIdx === undefined) {
          oIdx = nextToolIndex++
          toolIndexMap.set(aIdx, oIdx)
        }
        pushDelta({
          tool_calls: [
            { index: oIdx, id: block.id, type: "function", function: { name: block.name ?? "", arguments: "" } },
          ],
        })
      }
    } else if (obj.type === "content_block_delta") {
      const aIdx = typeof obj.index === "number" ? obj.index : 0
      const d = obj?.delta
      if (typeof d?.text === "string" && d.text) pushDelta({ content: d.text })
      else if (typeof d?.thinking === "string" && d.thinking) pushDelta({ reasoning_content: d.thinking })
      else if (typeof d?.partial_json === "string" && d.partial_json) {
        let oIdx = toolIndexMap.get(aIdx)
        if (oIdx === undefined) {
          oIdx = nextToolIndex++
          toolIndexMap.set(aIdx, oIdx)
        }
        pushDelta({ tool_calls: [{ index: oIdx, type: "function", function: { arguments: d.partial_json } }] })
      } else if (typeof d?.input_json === "string" && d.input_json) {
        let oIdx = toolIndexMap.get(aIdx)
        if (oIdx === undefined) {
          oIdx = nextToolIndex++
          toolIndexMap.set(aIdx, oIdx)
        }
        pushDelta({ tool_calls: [{ index: oIdx, type: "function", function: { arguments: d.input_json } }] })
      } else if (d?.type === "text_delta" && typeof d?.text === "string" && d.text) pushDelta({ content: d.text })
      else if (d?.type === "thinking_delta" && typeof d?.thinking === "string" && d.thinking)
        pushDelta({ reasoning_content: d.thinking })
      else if (d?.type === "input_json_delta" && typeof d?.partial_json === "string" && d.partial_json) {
        let oIdx = toolIndexMap.get(aIdx)
        if (oIdx === undefined) {
          oIdx = nextToolIndex++
          toolIndexMap.set(aIdx, oIdx)
        }
        pushDelta({ tool_calls: [{ index: oIdx, type: "function", function: { arguments: d.partial_json } }] })
      } else if (typeof d?.signature === "string" || d?.type === "signature_delta") {
        // no OpenAI equivalent
      }
    } else if (obj.type === "message_delta") {
      if (obj?.usage) ingestUsage(obj.usage)
      const stopReason = obj?.delta?.stop_reason
      finishReason = stopReason === "tool_use" ? "tool_calls" : stopReason === "max_tokens" ? "length" : "stop"
    } else if (obj.type === "message_stop") {
      if (obj?.usage) ingestUsage(obj.usage)
      if (!finishReason) finishReason = toolIndexMap.size > 0 ? "tool_calls" : "stop"
      sawMessageStop = true
    } else if (obj.type === "message_integrity") {
      sawTerminalFrame = true
    } else if (obj.type === "content_block_stop") {
      // no-op
    }
    return undefined
  }

  const finalizeStreaming = (write: (event: string) => void) => {
    if (terminalError) return
    if (!sawContent && !finishReason) {
      write(
        sse({
          id: chunkId(),
          object: "chat.completion.chunk",
          created: now(),
          model: modelRef.current,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      )
    }
    const usage = buildUsage()
    const reason = finishReason ?? (toolIndexMap.size > 0 ? "tool_calls" : "stop")
    write(
      usage
        ? sse({
            id: chunkId(),
            object: "chat.completion.chunk",
            created: now(),
            model: modelRef.current,
            choices: [{ index: 0, delta: {}, finish_reason: reason }],
            usage,
          })
        : sse({
            id: chunkId(),
            object: "chat.completion.chunk",
            created: now(),
            model: modelRef.current,
            choices: [{ index: 0, delta: {}, finish_reason: reason }],
          }),
    )
    if (usage)
      write(
        sse({
          id: chunkId(),
          object: "chat.completion.chunk",
          created: now(),
          model: modelRef.current,
          choices: [],
          usage,
        }),
      )
    write("data: [DONE]\n\n")
  }

  return {
    handleFrame,
    finalizeStreaming,
  }
}

export function verdentSSEToOpenAI(sseText: string, model: string): string[] {
  // Buffered path — single state machine shared with pipeVerdentStream.
  const events: string[] = []
  const modelRef = { current: model }
  const translator = createVerdentOpenAITranslator(modelRef, {
    pushDelta: (delta: any) => {
      events.push(
        sse({
          id: `chatcmpl-${reactShortId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelRef.current,
          choices: [{ index: 0, delta, finish_reason: null }],
        }),
      )
    },
    pushError: (detail: string, isLimit: boolean) => {
      events.push(
        sse({
          error: {
            message: `${isLimit ? "Verdent rate limit" : "Verdent upstream stream error"}: ${detail.slice(0, 500)}`,
            type: isLimit ? "rate_limit_error" : "upstream_error",
          },
        }),
      )
    },
  })
  for (const { eventType, rawData } of parseSseFrames(sseText)) {
    const sig = translator.handleFrame(eventType, rawData)
    if (sig === "error" || sig === "done") break
  }
  translator.finalizeStreaming((event: string) => events.push(event))
  return events
}

function pipeVerdentStream(
  upstream: Response,
  res: ServerResponse,
  model: string,
  options: { signal?: AbortSignal; onRateLimit?: (detail: string, raw: string) => void } = {},
): Promise<string | undefined> {
  const body: any = (upstream as any).body
  if (!body) return Promise.resolve(undefined)

  const modelRef = { current: model }
  let headersSent = false
  let earlyRateLimited = false
  let streamError = false
  let upstreamDone = false

  const ensureHeaders = () => {
    if (res.destroyed || res.writableEnded) return false
    if (!headersSent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-verdent-model": model,
      })
      headersSent = true
    }
    return true
  }

  const translator = createVerdentOpenAITranslator(modelRef, {
    pushDelta: (delta: any) => {
      if (!ensureHeaders()) return
      try {
        res.write(
          sse({
            id: `chatcmpl-${reactShortId()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelRef.current,
            choices: [{ index: 0, delta, finish_reason: null }],
          }),
        )
      } catch {}
    },
    pushError: (detail: string, isLimit: boolean, raw: string) => {
      if (isLimit) options.onRateLimit?.(detail, raw)
      if (!headersSent && isLimit) {
        try {
          sendJson(res as any, 429, {
            error: { message: `Verdent rate limit: ${detail.slice(0, 600)}`, type: "rate_limit_error" },
          })
        } catch {}
        earlyRateLimited = true
        return
      }
      if (!ensureHeaders()) return
      try {
        res.write(
          sse({
            error: {
              message: `${isLimit ? "Verdent rate limit" : "Verdent upstream stream error"}: ${detail.slice(0, 500)}`,
              type: isLimit ? "rate_limit_error" : "upstream_error",
            },
          }),
        )
      } catch {}
    },
  })

  const decoder = new TextDecoder()
  let sseBuffer = ""

  const processFrame = (frame: string): string | undefined => {
    if (!frame.trim()) return undefined
    let eventType: string | undefined
    const dataLines: string[] = []
    for (const line of frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
      if (line.startsWith("event:")) eventType = line.replace(/^event:\s*/, "").trim()
      else if (line.startsWith("data:")) dataLines.push(line.replace(/^data:\s*/, ""))
    }
    const rawData = dataLines.length > 0 ? dataLines.join(" ") : undefined
    const sig = translator.handleFrame(eventType, rawData)
    if (earlyRateLimited) return "rate_limited"
    if (sig === "error") streamError = true
    return sig
  }

  const finalize = () => {
    if (earlyRateLimited) return
    if (!headersSent) ensureHeaders()
    translator.finalizeStreaming((event: string) => {
      if (!ensureHeaders()) return
      try {
        res.write(event)
      } catch {}
    })
    try {
      res.end()
    } catch {}
  }

  const getAsyncIterable = (): AsyncIterable<Uint8Array | string> => {
    try {
      if (typeof body.getReader === "function") {
        const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
        return {
          [Symbol.asyncIterator]: async function* () {
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                yield value as Uint8Array
              }
            } finally {
              try {
                await reader.cancel()
              } catch {}
            }
          },
        } as AsyncIterable<Uint8Array>
      }
    } catch {}
    if (typeof (body as any)[Symbol.asyncIterator] === "function") {
      return body as AsyncIterable<Uint8Array | string>
    }
    return {
      [Symbol.asyncIterator]: async function* () {
        const text = await (async () => {
          try {
            return (await (body as any).text?.()) ?? ""
          } catch {
            return ""
          }
        })()
        if (text) yield text
      },
    } as AsyncIterable<string>
  }

  return (async () => {
    const iterable = getAsyncIterable()
    try {
      for await (const chunk of iterable) {
        if (options.signal?.aborted) return "canceled"
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk as Uint8Array, { stream: true })
        sseBuffer += text
        let boundary: { index: number; length: number } | undefined
        while ((boundary = sseBoundary(sseBuffer)) !== undefined) {
          const frame = sseBuffer.slice(0, boundary.index)
          sseBuffer = sseBuffer.slice(boundary.index + boundary.length)
          const sig = processFrame(frame)
          if (sig === "rate_limited") return "rate_limited"
          if (sig === "error") break
          if (sig === "done") {
            upstreamDone = true
            break
          }
          if (earlyRateLimited) return "rate_limited"
        }
        if (earlyRateLimited) return "rate_limited"
        if (streamError) break
        if (upstreamDone) break
      }
      sseBuffer += decoder.decode()
      if (!streamError && !upstreamDone && sseBuffer.trim()) {
        const sig = processFrame(sseBuffer)
        if (sig === "rate_limited") return "rate_limited"
        if (sig === "error") streamError = true
      }
    } catch (e: any) {
      if (!headersSent) throw e
      if (!options.signal?.aborted && !earlyRateLimited && !streamError) {
        translator.handleFrame(
          "error",
          JSON.stringify({ type: "stream_error", message: e?.message ?? "stream read failed" }),
        )
        streamError = true
      }
    }
    if (earlyRateLimited) return "rate_limited"
    if (options.signal?.aborted) {
      try {
        if (!res.writableEnded) res.end()
      } catch {}
      return "canceled"
    }
    if (streamError) {
      try {
        if (!res.writableEnded) res.end()
      } catch {}
      return "stream_error"
    }
    finalize()
    return undefined
  })()
}

function reactShortId(): string {
  return randomBytes(6).toString("hex")
}

async function ensureProxy(): Promise<ProxyState | undefined> {
  if (state) return state
  // Multi-account: allow proxy to start if any vault/env account exists, even
  // when the single-token resolveToken() is empty (e.g. after moving to vault).
  let token: string | null = null
  try {
    const accounts = verdentRegistry.all()
    if (accounts.length) token = accounts[0]!.credential.accessToken
  } catch {}
  token ??= await resolveToken()
  if (!token) return undefined

  const server = createServer((req, res) => {
    ;(async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1")
        const path = url.pathname
        const auth = req.headers.authorization ?? ""
        if (auth !== `Bearer ${state?.localToken}`) {
          return sendJson(res, 401, { error: { message: "Invalid local proxy token.", type: "authentication_error" } })
        }

        if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
          const catalog = (await discoverCatalog()) ?? FALLBACK_CATALOG
          const data = catalog.map((entry) => ({
            id: entry.id,
            object: "model",
            created: 0,
            owned_by: PROVIDER_ID,
            context: entry.context,
          }))
          return sendJson(res, 200, { object: "list", data })
        }

        if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
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
        if (!res.headersSent) sendJson(res, 500, { error: { message: "Verdent proxy error.", type: "internal_error" } })
      }
    })()
  })

  const port = await listen(server, "127.0.0.1").catch(() => 0)
  if (!port) return undefined
  const proxyToken = randomBytes(24).toString("hex")
  state = { server, port, localToken: proxyToken }
  return state
}

// --------------------------------------------------------------- browser login

export type VerdentOAuthTokenResponse = {
  token?: string
  access_token?: string
  accessToken?: string
  expireTime?: number
  expires_in?: number
  data?: Record<string, unknown>
}

export type VerdentOAuthOptions = {
  authBaseUrl?: string
  loginBaseUrl?: string
  tokenUrl?: string
}

type VerdentOAuthCallback = {
  code: string
  state: string
}

type PendingVerdentOAuth = {
  state: string
  requestId: string
  callbackNonce: string
  resolve: (result: VerdentOAuthCallback) => void
  reject: (error: Error) => void
}

let verdentOAuthServer: Server | undefined
let verdentOAuthPending: PendingVerdentOAuth | undefined

function verdentStage(): "dev" | "fenji" | "prod" {
  const stage = process.env.VERDENT_STAGE?.trim().toLowerCase()
  if (stage === "dev" || stage === "fenji") return stage
  return "prod"
}

function oauthAuthBaseURL(options: VerdentOAuthOptions): string {
  const configured = options.authBaseUrl?.trim() || process.env.VERDENT_AUTH_BASE_URL?.trim()
  const stage = verdentStage()
  const fallback =
    stage === "dev"
      ? VERDENT_AUTH_DEV_BASE_URL
      : stage === "fenji"
        ? VERDENT_AUTH_FENJI_BASE_URL
        : VERDENT_AUTH_PROD_BASE_URL
  return (configured || fallback).replace(/\/+$/, "")
}

function oauthLoginBaseURL(options: VerdentOAuthOptions): string {
  const configured = options.loginBaseUrl?.trim() || process.env.VERDENT_LOGIN_BASE_URL?.trim()
  const stage = verdentStage()
  const fallback =
    stage === "dev"
      ? VERDENT_LOGIN_DEV_BASE_URL
      : stage === "fenji"
        ? VERDENT_LOGIN_FENJI_BASE_URL
        : VERDENT_LOGIN_PROD_BASE_URL
  return (configured || fallback).replace(/\/+$/, "")
}

function oauthTokenURL(options: VerdentOAuthOptions): string {
  return options.tokenUrl?.trim() || `${oauthLoginBaseURL(options)}${VERDENT_PKCE_CALLBACK_PATH}`
}

function oauthState(): string {
  return randomBytes(32).toString("base64url")
}

function oauthCodeVerifier(): string {
  return randomBytes(32).toString("base64url")
}

function oauthCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

function oauthErrorMessage(url: URL): string | undefined {
  const error = url.searchParams.get("error")
  if (!error) return undefined
  return url.searchParams.get("error_description") || url.searchParams.get("uh") || error
}

async function startVerdentOAuthServer(): Promise<{ port: number }> {
  if (verdentOAuthServer) {
    const address = verdentOAuthServer.address()
    if (typeof address === "object" && address) return { port: address.port }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method !== "GET" || url.pathname !== VERDENT_AUTH_CALLBACK_PATH) {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    const pending = verdentOAuthPending
    const error = oauthErrorMessage(url)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const requestId = url.searchParams.get("rid")
    const callbackNonce = url.searchParams.get("nonce")

    if (!pending) {
      const detail = "No Verdent authorization is pending."
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(OauthCallbackPage.error(detail, { provider: "Verdent" }))
      return
    }

    if (
      !state ||
      state !== pending.state ||
      requestId !== pending.requestId ||
      callbackNonce !== pending.callbackNonce
    ) {
      const detail = "Invalid OAuth callback state."
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(OauthCallbackPage.error(detail, { provider: "Verdent" }))
      return
    }

    if (error) {
      verdentOAuthPending = undefined
      pending.reject(new Error(error))
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(OauthCallbackPage.error(error, { provider: "Verdent" }))
      return
    }

    if (!code) {
      verdentOAuthPending = undefined
      pending.reject(new Error("Missing OAuth authorization code."))
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(OauthCallbackPage.error("Missing OAuth authorization code.", { provider: "Verdent" }))
      return
    }

    verdentOAuthPending = undefined
    pending.resolve({ code, state })
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.success({ provider: "Verdent" }))
  })

  const port = await listen(server, "127.0.0.1")
  if (!port) throw new Error("Unable to start Verdent OAuth callback server")
  verdentOAuthServer = server
  return { port }
}

function stopVerdentOAuthServer() {
  const pending = verdentOAuthPending
  verdentOAuthPending = undefined
  pending?.reject(new Error("Verdent authorization was cancelled"))
  const server = verdentOAuthServer
  verdentOAuthServer = undefined
  server?.close()
}

function waitForVerdentOAuthCallback(
  state: string,
  requestId: string,
  callbackNonce: string,
): Promise<VerdentOAuthCallback> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!verdentOAuthPending) return
      verdentOAuthPending = undefined
      reject(new Error("Verdent OAuth callback timed out - authorization took too long"))
      verdentOAuthServer?.close()
      verdentOAuthServer = undefined
    }, 5 * 60_000)

    verdentOAuthPending = {
      state,
      requestId,
      callbackNonce,
      resolve: (result) => {
        clearTimeout(timeout)
        resolve(result)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

function tokenFromOAuthResponse(body: VerdentOAuthTokenResponse): string | undefined {
  const data = body.data
  return [body.token, body.access_token, body.accessToken, data?.token, data?.access_token, data?.accessToken]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim()
}

async function exchangeVerdentAuthorizationCode(
  code: string,
  codeVerifier: string,
  options: VerdentOAuthOptions,
): Promise<VerdentOAuthTokenResponse> {
  const response = await fetch(oauthTokenURL(options), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": `opencode/${InstallationVersion}`,
    },
    body: JSON.stringify({ code, codeVerifier }),
  })
  const body = (await response.json().catch(() => ({}))) as VerdentOAuthTokenResponse
  if (!response.ok) {
    throw new Error(`Verdent OAuth token exchange failed (${response.status})`)
  }
  if (!tokenFromOAuthResponse(body)) throw new Error("Verdent OAuth response is missing data.token")
  return body
}

function verdentOAuthExpiresAt(tokens: VerdentOAuthTokenResponse): number {
  const expireTime = Number(tokens.data?.expireTime ?? tokens.expireTime)
  if (Number.isFinite(expireTime) && expireTime > 0) return expireTime * 1000
  const expiresIn = Number(tokens.expires_in)
  return Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0
}

// ------------------------------------------------------------------------ plugin

function toModel(
  baseURL: string,
  headers: Record<string, string>,
  entry: CatalogEntry,
  exposedId = entry.id,
  accountLabel?: string,
): Model {
  // Variants drive the composer's effort picker (lightbulb). Each variant's
  // options merge into the OpenAI request (session/llm/request.ts merges
  // model.variants[variant] into `options`), so `reasoningEffort` lands in the
  // OpenAI body and handleCompletions forwards it upstream as `effort`.
  const efforts = entry.reasoning ? (entry.efforts?.length ? entry.efforts : DEFAULT_EFFORTS) : []
  const variants = Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
  const displayName = accountLabel ? `${entry.name} (${accountLabel})` : entry.name
  return {
    id: exposedId,
    providerID: PROVIDER_ID,
    name: displayName,
    family: entry.family,
    api: { id: exposedId, url: baseURL, npm: NPM },
    status: "active",
    headers,
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: entry.context, output: entry.output },
    capabilities: {
      temperature: true,
      reasoning: entry.reasoning,
      attachment: entry.attachment,
      toolcall: true,
      input: { text: true, audio: false, image: entry.attachment, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    release_date: "",
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
  }
}

export async function VerdentPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    provider: {
      id: PROVIDER_ID,
      async models(provider, context) {
        // Provider auth is the canonical CLI/UI storage for manually pasted
        // tokens. Mirror it into the account vault so routing and entitlement
        // state are shared with desktop imports and env accounts.
        if (context.auth?.type === "api" && typeof context.auth.key === "string" && context.auth.key.trim()) {
          try {
            verdentRegistry.importToken(context.auth.key, undefined, context.auth.metadata?.nickname)
          } catch {}
        }
        const proxy = await ensureProxy().catch(() => undefined)
        if (!proxy) return provider.models

        const baseURL = `http://127.0.0.1:${proxy.port}/v1`
        const headers = { Authorization: `Bearer ${proxy.localToken}` }
        const catalog = (await discoverCatalog()) ?? FALLBACK_CATALOG
        const merged: Record<string, Model> = { ...provider.models }
        const accounts = verdentRegistry.all()
        if (accounts.length === 0) {
          for (const entry of catalog.flatMap(expandCatalogEntry)) {
            merged[entry.id] = toModel(baseURL, headers, entry)
          }
          return merged
        }
        const labels = verdentAccountLabels(accounts)
        // Bare IDs for automatic (session-affine) routing.
        for (const entry of catalog.flatMap(expandCatalogEntry)) {
          if (!merged[entry.id]) merged[entry.id] = toModel(baseURL, headers, entry)
        }
        for (const account of accounts) {
          const label = labels.get(account.id) ?? account.id
          for (const entry of catalog.flatMap(expandCatalogEntry)) {
            const exposedId = `${entry.id}@${account.id}`
            merged[exposedId] = toModel(baseURL, headers, entry, exposedId, label)
          }
        }
        return merged
      },
    },

    "chat.headers": async (input, output) => {
      if (input.model.providerID !== PROVIDER_ID) return
      output.headers["x-opencode-session"] = input.sessionID
      if (input.message?.id) output.headers["x-opencode-request"] = input.message.id
      const accountId = decodeVerdentAccountModel(input.model.id).accountId
      if (accountId) output.headers["x-verdent-account"] = accountId
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "Import from existing desktop login",
          async authorize() {
            return {
              url: "",
              instructions: "Import the currently signed-in Verdent desktop account into OpenCode.",
              method: "auto" as const,
              async callback() {
                try {
                  const account = await verdentRegistry.importCurrentDesktopAccount(
                    resolveDesktopToken,
                    fetchVerdentAccountProfile,
                  )
                  return {
                    type: "success" as const,
                    key: account.credential.accessToken,
                    provider: PROVIDER_ID,
                    metadata: { accountId: account.id, uid: account.uid, source: "desktop-import" },
                  }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "Login with browser",
          async authorize() {
            const options: VerdentOAuthOptions = {}
            const started = await startVerdentOAuthServer()
            const codeVerifier = oauthCodeVerifier()
            const state = oauthState()
            const requestId = randomUUID()
            const callbackNonce = randomBytes(16).toString("hex")
            const deepLink = `verdent://auth/callback?rid=${encodeURIComponent(requestId)}&nonce=${encodeURIComponent(callbackNonce)}`
            const callback = new URL(`http://127.0.0.1:${started.port}${VERDENT_AUTH_CALLBACK_PATH}`)
            callback.searchParams.set("rid", requestId)
            callback.searchParams.set("nonce", callbackNonce)
            callback.searchParams.set("wake_callback", deepLink)
            const authUrl = new URL(`${oauthAuthBaseURL(options)}${VERDENT_AUTH_PATH}`)
            authUrl.search = new URLSearchParams({
              challenge: oauthCodeChallenge(codeVerifier),
              state,
              intent: "signin",
              callback: callback.toString(),
              ots: "deck",
              source: "deck",
              id: resolveDeviceId() || randomUUID(),
            }).toString()
            const callbackPromise = waitForVerdentOAuthCallback(state, requestId, callbackNonce)
            return {
              url: authUrl.toString(),
              instructions: "Complete Verdent authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              async callback() {
                try {
                  const completed = await callbackPromise
                  const tokens = await exchangeVerdentAuthorizationCode(completed.code, codeVerifier, options)
                  const accessToken = tokenFromOAuthResponse(tokens)
                  if (!accessToken) return { type: "failed" as const }
                  const uid = uidFromToken(accessToken)
                  const profile = await fetchVerdentAccountProfile(accessToken)
                  const account = verdentRegistry.enrollCredential({
                    path: "oauth:verdent",
                    accessToken,
                    uid,
                    nickname: profile?.nickname ?? uid,
                    teamId: profile?.teamId,
                    expiresAt: verdentOAuthExpiresAt(tokens),
                  })
                  return {
                    type: "success" as const,
                    key: accessToken,
                    provider: PROVIDER_ID,
                    metadata: { accountId: account.id, uid: account.uid, source: "browser-oauth" },
                  }
                } catch {
                  return { type: "failed" as const }
                } finally {
                  stopVerdentOAuthServer()
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "Verdent access token",
        },
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
