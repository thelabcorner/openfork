// Canonical first-party Claude provider/model metadata.
// Discovery is pure/static: no SDK load, no CLI spawn, no network call.

import { Schema } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

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

// Plugin-ported subscription model IDs (from @openchamber/opencode-claude catalog)
// These are the models exposed for Claude Subscription / Claude Code CLI auth.
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
  // plugin-ported additional models for full parity with opencode-claude
  MODEL_FABLE,
  MODEL_OPUS_5,
  MODEL_SONNET_5,
  MODEL_HAIKU_ALIAS,
  MODEL_OPUS_4_8,
  MODEL_SONNET_4_6,
  MODEL_HAIKU_4_5,
]

export const ClaudeModelStatus = Schema.Literals(["active", "unavailable", "setup-required", "deprecated"])
export type ClaudeModelStatus = typeof ClaudeModelStatus.Type

// Capability profile for Claude family (matches Anthropic SDK behavior)
export const CLAUDE_CAPABILITIES = {
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
} as const

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
  readonly capabilities: typeof CLAUDE_CAPABILITIES
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

// Resolve alias -> canonical model ID; returns undefined for unknown aliases.
export function resolveAlias(alias: string): string | undefined {
  const normalized = alias.trim()
  if (MODEL_IDS.includes(normalized)) return normalized
  return ALIASES[normalized] ?? undefined
}

// Return true if the model ID is a Claude-family model.
export function isClaudeModel(modelID: string): boolean {
  return MODEL_IDS.includes(modelID) || MODEL_IDS.some((id) => modelID.toLowerCase().includes(id.toLowerCase()))
}

export * as ClaudeModels from "./models"
