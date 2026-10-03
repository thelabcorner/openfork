// Canonical first-party Claude provider/model metadata.
// Discovery is pure/static: no SDK load, no CLI spawn, no network call.

import { Schema } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Global } from "@opencode-ai/core/global"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import fs from "node:fs"
import path from "node:path"

export const PROVIDER_ID = ProviderV2.ID.make("claude")

// Same host-visible contract as @openchamber/opencode-claude: models resolve
// through the bundled OpenAI-compatible SDK. Agent SDK stays lazy in runtime.
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
export const PROXY_API_KEY = "claude-code-proxy"
export const PROXY_BASE_URL = "http://127.0.0.1/v1"

export function modelApi(id: string) {
  return { id, url: PROXY_BASE_URL, npm: OPENAI_COMPATIBLE_NPM }
}

// Stable Claude model IDs (canonical, not aliases)
export const MODEL_SONNET = "claude-sonnet-4-5-20251101"
export const MODEL_OPUS = "claude-opus-4-6"
export const MODEL_HAIKU = "claude-haiku-4-5-20251001"
export const MODEL_CODEX = "claude-codex-4-5"

// Legacy moving aliases retained only for reference migration. They are NOT
// members of the first-party subscription catalog; that catalog is derived
// from Agent SDK supportedModels() below.
export const MODEL_FABLE = "fable"
export const MODEL_OPUS_5 = "opus"
export const MODEL_SONNET_5 = "sonnet"
export const MODEL_HAIKU_ALIAS = "haiku"

// Pinned versions also exposed by the plugin
export const MODEL_OPUS_4_8 = "claude-opus-4-8"
export const MODEL_SONNET_4_6 = "claude-sonnet-4-6"
export const MODEL_HAIKU_4_5 = "claude-haiku-4-5"

const LIMIT_1M = { context: 1_000_000, output: 128_000 } as const
const LIMIT_200K = { context: 200_000, output: 64_000 } as const

// Alias mapping: legacy/reference forms -> canonical model IDs
export const ALIASES: Record<string, string> = {
  "claude/sonnet": MODEL_SONNET,
  "claude/opus": MODEL_OPUS,
  "claude/haiku": MODEL_HAIKU,
  "claude/codex": MODEL_CODEX,
  "claude/claude-sonnet-4-5": MODEL_SONNET,
  "claude/claude-opus-4-6": MODEL_OPUS,
  "claude/claude-haiku-4-5": MODEL_HAIKU,
  // short forms for plugin-ported subscription models
  sonnet: MODEL_SONNET_5,
  opus: MODEL_OPUS_5,
  haiku: MODEL_HAIKU_ALIAS,
  fable: MODEL_FABLE,
  "claude/sonnet5": MODEL_SONNET_5,
  "claude/opus5": MODEL_OPUS_5,
}

export const MODEL_IDS = [
  MODEL_SONNET,
  MODEL_OPUS,
  MODEL_HAIKU,
  MODEL_CODEX,
  MODEL_OPUS_4_8,
  MODEL_SONNET_4_6,
  MODEL_HAIKU_4_5,
]

export const ClaudeModelStatus = Schema.Literals(["active", "unavailable", "setup-required", "deprecated"])
export type ClaudeModelStatus = typeof ClaudeModelStatus.Type

export interface ClaudeCapabilities {
  temperature: boolean
  reasoning: boolean
  attachment: boolean
  toolcall: boolean
  input: {
    text: boolean
    audio: boolean
    image: boolean
    video: boolean
    pdf: boolean
  }
  output: {
    text: boolean
    audio: boolean
    image: boolean
    video: boolean
    pdf: boolean
  }
  interleaved: boolean
}

// Capability profile for Claude family (matches Anthropic SDK behavior).
// Dynamic subscription rows can narrow individual booleans from models.dev or
// the SDK's supported-effort surface without changing this baseline.
export const CLAUDE_CAPABILITIES: ClaudeCapabilities = {
  temperature: false,
  reasoning: true,
  attachment: true,
  toolcall: true,
  input: {
    text: true,
    audio: false,
    image: true,
    video: false,
    pdf: true,
  },
  output: {
    text: true,
    audio: false,
    image: false,
    video: false,
    pdf: false,
  },
  interleaved: false,
}

// Effort variants for modern adaptive-thinking Claude models (4.7+ / Opus 4.5+)
export const ADAPTIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
export type AdaptiveEffort = (typeof ADAPTIVE_EFFORTS)[number]

export function isClaudeEffort(value: unknown): value is AdaptiveEffort {
  return typeof value === "string" && (ADAPTIVE_EFFORTS as readonly string[]).includes(value)
}

// Stable model metadata (no runtime dependency on SDK/CLI)
export interface ClaudeModelInfo {
  readonly id: string
  readonly name: string
  readonly family: string
  readonly status: ClaudeModelStatus
  readonly capabilities: ClaudeCapabilities
  readonly variants: Record<string, Record<string, unknown>>
  readonly releaseDate: string
  readonly contextLimit: number
  readonly outputLimit: number
}

export const MODEL_METADATA: Record<string, ClaudeModelInfo> = {
  [MODEL_SONNET]: {
    id: MODEL_SONNET,
    name: "Claude Sonnet 4.5",
    family: "claude-sonnet",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      max: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    },
    releaseDate: "2025-11-01",
    contextLimit: 200_000,
    outputLimit: 64_000,
  },
  [MODEL_OPUS]: {
    id: MODEL_OPUS,
    name: "Claude Opus 4.6",
    family: "claude-opus",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      max: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    },
    releaseDate: "2026-02-05",
    contextLimit: 1_000_000,
    outputLimit: 128_000,
  },
  [MODEL_HAIKU]: {
    id: MODEL_HAIKU,
    name: "Claude Haiku 4.5",
    family: "claude-haiku",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    },
    releaseDate: "2025-10-01",
    contextLimit: 200_000,
    outputLimit: 32_000,
  },
  [MODEL_CODEX]: {
    id: MODEL_CODEX,
    name: "Claude Codex 4.5",
    family: "claude-codex",
    status: "unavailable",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {},
    releaseDate: "",
    contextLimit: 0,
    outputLimit: 0,
  },
  // --- Ported from @openchamber/opencode-claude for first-party Claude Subscription parity ---
  [MODEL_FABLE]: {
    id: MODEL_FABLE,
    name: "Fable 5",
    family: "claude-fable",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      xhigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" },
      max: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    },
    releaseDate: "",
    contextLimit: LIMIT_1M.context,
    outputLimit: LIMIT_1M.output,
  },
  [MODEL_OPUS_5]: {
    id: MODEL_OPUS_5,
    name: "Opus 5",
    family: "claude-opus",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      xhigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" },
      max: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    },
    releaseDate: "",
    contextLimit: LIMIT_1M.context,
    outputLimit: LIMIT_1M.output,
  },
  [MODEL_SONNET_5]: {
    id: MODEL_SONNET_5,
    name: "Sonnet 5",
    family: "claude-sonnet",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      xhigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" },
      max: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    },
    releaseDate: "",
    contextLimit: LIMIT_1M.context,
    outputLimit: LIMIT_1M.output,
  },
  [MODEL_HAIKU_ALIAS]: {
    id: MODEL_HAIKU_ALIAS,
    name: "Haiku 4.5",
    family: "claude-haiku",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    },
    releaseDate: "",
    contextLimit: LIMIT_200K.context,
    outputLimit: LIMIT_200K.output,
  },
  [MODEL_OPUS_4_8]: {
    id: MODEL_OPUS_4_8,
    name: "Opus 4.8",
    family: "claude-opus",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      xhigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" },
      max: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    },
    releaseDate: "",
    contextLimit: LIMIT_1M.context,
    outputLimit: LIMIT_1M.output,
  },
  [MODEL_SONNET_4_6]: {
    id: MODEL_SONNET_4_6,
    name: "Sonnet 4.6",
    family: "claude-sonnet",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      xhigh: { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" },
      max: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    },
    releaseDate: "",
    contextLimit: LIMIT_1M.context,
    outputLimit: LIMIT_1M.output,
  },
  [MODEL_HAIKU_4_5]: {
    id: MODEL_HAIKU_4_5,
    name: "Haiku 4.5",
    family: "claude-haiku",
    status: "active",
    capabilities: CLAUDE_CAPABILITIES,
    variants: {
      low: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      medium: { thinking: { type: "adaptive", display: "summarized" }, effort: "medium" },
      high: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    },
    releaseDate: "",
    contextLimit: LIMIT_200K.context,
    outputLimit: LIMIT_200K.output,
  },
}

/**
 * Claude Subscription model discovery is account-scoped. The static metadata
 * above remains an API-key/emergency compatibility fallback, but it is not the
 * authoritative subscription catalog.
 *
 * The official Agent SDK query handle exposes supportedModels(). We persist
 * that account-visible list in OpenFork's cache and synchronously consume it
 * during provider assembly so passive provider listing never starts Claude.
 * models.dev is used only to enrich/fallback metadata; it cannot prove which
 * models the signed-in Claude subscription can actually use.
 */
export interface ClaudeSdkModelRow {
  readonly value: string
  readonly displayName?: string
  readonly resolvedModel?: string
  readonly supportedEffortLevels?: readonly string[]
}

const SUBSCRIPTION_CACHE_VERSION = 1
export const CLAUDE_SUBSCRIPTION_MODEL_REFRESH_MS = 10 * 60_000
const SUBSCRIPTION_CACHE_MAX_MODELS = 64
const SUBSCRIPTION_CACHE_FILE = "claude-subscription-models.json"

interface SubscriptionCache {
  readonly version: typeof SUBSCRIPTION_CACHE_VERSION
  readonly fetchedAt: number
  readonly models: Record<string, ClaudeModelInfo>
}

let subscriptionCacheLoaded = false
let subscriptionCache: SubscriptionCache | undefined
let subscriptionCatalogRevision = 0

function isTestEnv() {
  return process.env.NODE_ENV === "test" || !!process.env.BUN_TEST || !!process.env.OPENCODE_TEST_HOME || !!process.env.VITEST
}

function subscriptionCacheFile() {
  return path.join(Global.Path.cache, SUBSCRIPTION_CACHE_FILE)
}

function validModelID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value)
}

function validCachedModel(value: unknown): value is ClaudeModelInfo {
  if (!value || typeof value !== "object") return false
  const model = value as ClaudeModelInfo
  return (
    validModelID(model.id) &&
    typeof model.name === "string" &&
    typeof model.family === "string" &&
    Number.isFinite(model.contextLimit) &&
    model.contextLimit > 0 &&
    Number.isFinite(model.outputLimit) &&
    model.outputLimit > 0 &&
    !!model.capabilities &&
    typeof model.variants === "object"
  )
}

function loadSubscriptionCache() {
  if (subscriptionCacheLoaded) return
  subscriptionCacheLoaded = true
  if (isTestEnv()) return
  try {
    const parsed = JSON.parse(fs.readFileSync(subscriptionCacheFile(), "utf8")) as SubscriptionCache
    const entries = Object.entries(parsed.models ?? {})
    if (parsed.version !== SUBSCRIPTION_CACHE_VERSION) return
    if (
      !Number.isFinite(parsed.fetchedAt) ||
      parsed.fetchedAt < 0 ||
      parsed.fetchedAt > Date.now() + CLAUDE_SUBSCRIPTION_MODEL_REFRESH_MS
    )
      return
    if (entries.length === 0 || entries.length > SUBSCRIPTION_CACHE_MAX_MODELS) return
    if (!entries.every(([id, model]) => id === model.id && validCachedModel(model))) return
    subscriptionCache = parsed
    // Process-local change detector for Provider's per-instance materialization.
    // The exact persisted timestamp is irrelevant; non-zero means "loaded".
    subscriptionCatalogRevision = 1
  } catch {
    // Cache miss/corruption is non-fatal.
  }
}

function persistSubscriptionCache(cache: SubscriptionCache) {
  if (isTestEnv()) return
  try {
    const file = subscriptionCacheFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 })
    try {
      fs.renameSync(tmp, file)
    } catch {
      // Windows cannot always replace an existing file atomically.
      fs.writeFileSync(file, JSON.stringify(cache), { mode: 0o600 })
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  } catch {
    // Cache only: runtime correctness never depends on persistence.
  }
}

export function claudeSubscriptionCatalogNeedsRefresh(now = Date.now()): boolean {
  loadSubscriptionCache()
  return !subscriptionCache || now - subscriptionCache.fetchedAt >= CLAUDE_SUBSCRIPTION_MODEL_REFRESH_MS
}

/** Process-local revision of the account-authoritative subscription catalog. */
export function claudeSubscriptionCatalogRevision(): number {
  loadSubscriptionCache()
  return subscriptionCatalogRevision
}

export function modelNameFromId(id: string | undefined): string | undefined {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(id?.trim() ?? "")
  if (!match) return undefined
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase()
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`
}

/**
 * Convert Claude Code's refusal-fallback model into the concrete OpenFork
 * subscription catalog identity. Claude may report the base model even when
 * the user selected a 1M variant; preserve that context choice when the
 * fallback family exposes a corresponding [1m] row.
 */
export function claudeFallbackCatalogID(fallback: string, original: string): string {
  const catalog = getClaudeSubscriptionModelMetadata()
  const normalized = normalizeClaudeModelID(fallback.trim())
  const explicitOneM = /\[1m\]$/i.test(normalized)
  const base = normalized.replace(/\[1m\]$/i, "")
  const wantsOneM = explicitOneM || /\[1m\]$/i.test(original)
  const candidates = wantsOneM ? [`${base}[1m]`, base] : [base, `${base}[1m]`]
  for (const candidate of candidates) {
    if (catalog[candidate]) return candidate
  }
  return normalized
}

const ONE_M_FAMILIES: ReadonlyArray<{ match: RegExp; mode: "default" | "optional" | "fixed" }> = [
  { match: /^claude-fable-5/, mode: "default" },
  { match: /^claude-opus-5/, mode: "default" },
  { match: /^claude-opus-4-6/, mode: "default" },
  { match: /^claude-opus-4-[78]/, mode: "fixed" },
  { match: /^claude-sonnet-(5|4-6)/, mode: "optional" },
]

function normalizeClaudeModelID(id: string) {
  return id.replace(/^claude-([a-z]+)-(\d+)\.(\d+)/i, "claude-$1-$2-$3")
}

function familyOf(id: string) {
  const match = /^claude-([a-z]+)/i.exec(id)
  return match ? `claude-${match[1]!.toLowerCase()}` : "claude"
}

function effortVariants(efforts: readonly string[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    efforts
      .filter(isClaudeEffort)
      .map((effort) => [effort, { thinking: { type: "adaptive", display: "summarized" }, effort }]),
  )
}

function modelDevEntry(provider: ModelsDev.Provider | undefined, id: string): ModelsDev.Model | undefined {
  if (!provider) return undefined
  const base = id.replace(/\[1m\]$/i, "")
  return (
    provider.models[base] ??
    provider.models[base.replace(/-(\d+)-(\d+)(?=$|-)/, "-$1.$2")] ??
    provider.models[base.replace(/-(\d+)\.(\d+)(?=$|-)/, "-$1-$2")]
  )
}

function dynamicInfo(input: {
  id: string
  name: string
  context: number
  output: number
  efforts: readonly string[]
  modelsDev?: ModelsDev.Provider
}): ClaudeModelInfo {
  const source = modelDevEntry(input.modelsDev, input.id)
  const efforts = input.efforts.filter(isClaudeEffort)
  const reasoning = source?.reasoning ?? efforts.length > 0
  return {
    id: input.id,
    name: input.name,
    family: source?.family ?? familyOf(input.id),
    status: source?.status === "deprecated" ? "deprecated" : "active",
    capabilities: {
      ...CLAUDE_CAPABILITIES,
      reasoning,
      attachment: source?.attachment ?? CLAUDE_CAPABILITIES.attachment,
      toolcall: source?.tool_call ?? CLAUDE_CAPABILITIES.toolcall,
    },
    variants: reasoning ? effortVariants(efforts) : {},
    releaseDate: source?.release_date ?? "",
    // The Claude Code SDK/family rules define the actual selectable context
    // surface (including [1m]); models.dev is API metadata and must not rewrite
    // those subscription runtime semantics.
    contextLimit: input.context,
    outputLimit: input.output,
  }
}

export function claudeSubscriptionModelsFromSdk(
  rows: readonly ClaudeSdkModelRow[],
  modelsDev?: ModelsDev.Provider,
): Record<string, ClaudeModelInfo> {
  const out: Record<string, ClaudeModelInfo> = {}
  const add = (id: string, name: string, context: number, output: number, efforts: readonly string[]) => {
    if (!validModelID(id) || out[id]) return
    out[id] = dynamicInfo({ id, name, context, output, efforts, modelsDev })
  }

  for (const row of rows) {
    const value = typeof row?.value === "string" ? row.value.trim() : ""
    if (!value || value === "default") continue
    const resolved =
      typeof row.resolvedModel === "string" && row.resolvedModel.trim() ? row.resolvedModel.trim() : value
    const base = normalizeClaudeModelID(resolved.replace(/\[1m\]$/i, ""))
    if (!/^claude-/i.test(base)) continue
    const efforts = (row.supportedEffortLevels ?? []).filter(isClaudeEffort)
    const name = modelNameFromId(base) ?? row.displayName?.trim() ?? base
    const explicitOneM = /\[1m\]$/i.test(value) || /\[1m\]$/i.test(resolved)
    const rule = explicitOneM ? { mode: "default" as const } : ONE_M_FAMILIES.find((item) => item.match.test(base))

    if (rule?.mode === "default") {
      add(`${base}[1m]`, name, LIMIT_1M.context, LIMIT_1M.output, efforts)
      continue
    }
    if (rule?.mode === "fixed") {
      add(base, name, LIMIT_1M.context, LIMIT_1M.output, efforts)
      continue
    }
    if (rule?.mode === "optional") {
      add(base, name, LIMIT_200K.context, LIMIT_200K.output, efforts)
      add(`${base}[1m]`, `${name} (1M)`, LIMIT_1M.context, LIMIT_1M.output, efforts)
      continue
    }
    add(base, name, LIMIT_200K.context, LIMIT_200K.output, efforts)
  }
  return out
}

function emergencySubscriptionModels(modelsDev?: ModelsDev.Provider): Record<string, ClaudeModelInfo> {
  // Bootstrap only. These concrete IDs mirror the current upstream
  // opencode-claude fallback. models.dev may enrich these rows, but it never
  // decides which subscription models the signed-in account is entitled to.
  return claudeSubscriptionModelsFromSdk([
    {
      value: "claude-opus-5-5",
      resolvedModel: "claude-opus-5-5",
      supportedEffortLevels: [...ADAPTIVE_EFFORTS],
    },
    {
      value: "claude-fable-5-1",
      resolvedModel: "claude-fable-5-1",
      supportedEffortLevels: [...ADAPTIVE_EFFORTS],
    },
    {
      value: "claude-sonnet-5",
      resolvedModel: "claude-sonnet-5",
      supportedEffortLevels: [...ADAPTIVE_EFFORTS],
    },
    {
      value: "claude-haiku-4-5",
      resolvedModel: "claude-haiku-4-5",
      supportedEffortLevels: [],
    },
    {
      value: "claude-opus-4-8",
      resolvedModel: "claude-opus-4-8",
      supportedEffortLevels: [...ADAPTIVE_EFFORTS],
    },
  ], modelsDev)
}

export function getClaudeSubscriptionModelMetadata(modelsDev?: ModelsDev.Provider): Record<string, ClaudeModelInfo> {
  loadSubscriptionCache()
  if (subscriptionCache && Object.keys(subscriptionCache.models).length) {
    return Object.fromEntries(
      Object.entries(subscriptionCache.models).map(([id, cached]) => {
        const source = modelDevEntry(modelsDev, id)
        if (!source) return [id, cached]
        return [
          id,
          {
            ...cached,
            name: modelNameFromId(id) ?? cached.name,
            family: source.family ?? cached.family,
            releaseDate: source.release_date || cached.releaseDate,
            contextLimit: cached.contextLimit,
            outputLimit: cached.outputLimit,
          },
        ]
      }),
    )
  }
  return emergencySubscriptionModels(modelsDev)
}

export function recordClaudeSubscriptionModels(rows: readonly ClaudeSdkModelRow[], now = Date.now()): boolean {
  const models = claudeSubscriptionModelsFromSdk(rows)
  const size = Object.keys(models).length
  if (size === 0 || size > SUBSCRIPTION_CACHE_MAX_MODELS) return false
  loadSubscriptionCache()
  const changed = JSON.stringify(subscriptionCache?.models ?? {}) !== JSON.stringify(models)
  subscriptionCache = { version: SUBSCRIPTION_CACHE_VERSION, fetchedAt: now, models }
  persistSubscriptionCache(subscriptionCache)
  if (changed) subscriptionCatalogRevision += 1
  return changed
}

export function resetClaudeSubscriptionModelCacheForTest() {
  subscriptionCacheLoaded = true
  subscriptionCache = undefined
  subscriptionCatalogRevision += 1
}

// Resolve alias -> canonical model ID; returns undefined for unknown aliases.
export function resolveAlias(alias: string): string | undefined {
  const normalized = alias.trim()
  const subscription = getClaudeSubscriptionModelMetadata()
  if (subscription[normalized]) return normalized

  const family =
    normalized === "sonnet" || normalized === "claude/sonnet"
      ? "claude-sonnet"
      : normalized === "opus" || normalized === "claude/opus"
        ? "claude-opus"
        : normalized === "haiku" || normalized === "claude/haiku"
          ? "claude-haiku"
          : normalized === "fable" || normalized === "claude/fable"
            ? "claude-fable"
            : undefined
  if (family) {
    const candidates = Object.values(subscription)
      .filter((model) => model.family === family)
      .sort((a, b) => {
        const aOneM = /\[1m\]$/i.test(a.id)
        const bOneM = /\[1m\]$/i.test(b.id)
        if (aOneM !== bOneM) return aOneM ? 1 : -1
        return b.id.localeCompare(a.id, undefined, { numeric: true })
      })
    if (candidates[0]) return candidates[0].id
    return undefined
  }

  if (MODEL_IDS.includes(normalized)) return normalized
  return ALIASES[normalized] ?? undefined
}

// Return true if the model ID is a Claude-family model.
export function isClaudeModel(modelID: string): boolean {
  if (
    MODEL_IDS.includes(modelID) ||
    Boolean(getClaudeSubscriptionModelMetadata()[modelID]) ||
    /^claude-(opus|sonnet|haiku|fable)-/i.test(modelID)
  )
    return true
  const resolved = resolveAlias(modelID)
  return Boolean(resolved && /^claude-(opus|sonnet|haiku|fable)-/i.test(resolved))
}

export * as ClaudeModels from "./models"
