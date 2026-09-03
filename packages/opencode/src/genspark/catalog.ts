// Genspark LLM-proxy provider metadata.
//
// The catalog is the same payload `gsk init-opencode` writes to opencode.json:
// `GET {host}/api/tool_cli/opencode-config` (client.js getOpencodeConfig) — an
// authenticated metadata endpoint, NOT a chat completion, so refreshing it
// costs no credits. We call that endpoint directly instead of shelling out to
// the CLI, because `init-opencode` writes a file into the user's project
// (index.js:1937-1943) and spawning node just to parse JSON we can read with
// HttpClient would be strictly worse.
//
// MODEL_METADATA below is a snapshot of that payload, used only as a fallback
// (no credential, offline, or fetch failure). The gsk CLI caches its own
// catalog for 24h keyed on base_url (config.js:232-282); we mirror that.
//
// Credits note (2026-09-01): Genspark packs are $20 / 7500 credits = 375
// credits per dollar, valid 3 months. Live probe of
// `GET /api/tool_cli/me` returned `credit_balance: 10270.85` (stacked packs).
// One real session (`ses_fa420c096ffedHcSjgzWc59E30`,
// `Downloads/new-session---2026-09-01t07-29-12-553z.json.br:1`,
// deep-seek-v4-flash, 53,044 tokens for 12 credits) burned 12/53.044 ≈ 226
// credits/M (≈ $0.603/M). That matches a $0.60/M flash tier and validates the
// 375× conversion used in `useGensparkUsage`.

import { Duration, Effect, Layer, Option, Schema, Context } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"

// Mirrors @genspark/cli/dist/config.js GSK_CLI_CAPS and package.json version.
// Sent so the backend returns the grouped view and for telemetry, matching CLI.
const GSK_CLI_CAPS = "cli-groups-v2,cli-paths-v3,cli-actions-v4"
const GSK_CLI_VERSION = "1.7.1"

export const PROVIDER_ID = "genspark"
export const PROVIDER_NAME = "Genspark"

/** Genspark's own opencode integration sends this marker on every call. */
export const PROXY_OPTION = { litellmProxy: true }

const DEFAULT_HOST = "https://www.genspark.ai"

/** Host for both proxy and metadata endpoints; GENSPARK_BASE_URL / GSK_BASE_URL override. */
export function host(): string {
  const value = [process.env.GENSPARK_BASE_URL, process.env.GSK_BASE_URL].find(
    (item) => typeof item === "string" && item.trim() !== "",
  )
  return (value ?? DEFAULT_HOST).trim().replace(/\/+$/, "")
}

/**
 * LiteLLM-backed proxy endpoint. The host can be pointed at a mirror via
 * GENSPARK_BASE_URL / GSK_BASE_URL (the gsk CLI's own override variable).
 */
export function apiURL(): string {
  return `${host()}/api/llm_proxy/v1`
}

const CAPABILITY_IMAGE_INPUT = {
  temperature: true,
  reasoning: true,
  attachment: true,
  toolcall: true,
  input: { text: true, audio: false, image: true, video: false, pdf: false },
  output: { text: true, audio: false, image: false, video: false, pdf: false },
  interleaved: false,
} as const

const CAPABILITY_PLAIN = {
  ...CAPABILITY_IMAGE_INPUT,
  reasoning: false,
} as const

/** GPT-5.x and Kimi K3 fix sampling and reject any non-default temperature. */
const CAPABILITY_FIXED_SAMPLING = {
  ...CAPABILITY_PLAIN,
  temperature: false,
} as const

/** Same fixed-sampling constraint, but the model does emit reasoning. */
const CAPABILITY_FIXED_SAMPLING_REASONING = {
  ...CAPABILITY_IMAGE_INPUT,
  temperature: false,
} as const

const EFFORTS_LMH = {
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
} satisfies Record<string, Record<string, string>>

const EFFORTS_XHIGH = {
  ...EFFORTS_LMH,
  xhigh: { reasoningEffort: "xhigh" },
} satisfies Record<string, Record<string, string>>

const EFFORTS_FULL = {
  none: { reasoningEffort: "none" },
  ...EFFORTS_XHIGH,
  max: { reasoningEffort: "max" },
} satisfies Record<string, Record<string, string>>

const LIMIT_1M_OUT_128K = { context: 1_000_000, input: 872_000, output: 128_000 } as const

export interface GensparkModelInfo {
  readonly name: string
  /**
   * Family key used by Provider.getSmallModel to pick a cheap model for
   * housekeeping calls (titles, summaries). `claude-haiku` is the preferred
   * family, so the haiku entry is what those calls resolve to. The endpoint
   * has no such field, so it is derived from the model id.
   */
  readonly family: string
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
  readonly capabilities:
    | typeof CAPABILITY_IMAGE_INPUT
    | typeof CAPABILITY_PLAIN
    | typeof CAPABILITY_FIXED_SAMPLING
    | typeof CAPABILITY_FIXED_SAMPLING_REASONING
  readonly variants: Record<string, Record<string, string>>
}

/** Family is a local concern (small-model selection); the endpoint omits it. */
export function familyFor(id: string): string {
  if (id.startsWith("claude-haiku")) return "claude-haiku"
  if (id.startsWith("claude-sonnet")) return "claude-sonnet"
  if (id.startsWith("claude-opus")) return "claude-opus"
  if (id.startsWith("claude-fable")) return "claude-fable"
  if (id.startsWith("gpt-")) return "gpt"
  if (id.startsWith("deep-seek") || id.startsWith("deepseek")) return "deepseek"
  if (id.startsWith("glm-")) return "glm"
  if (id.startsWith("kimi-")) return "kimi"
  if (id.startsWith("minimax-")) return "minimax"
  if (id.startsWith("grok-")) return "grok"
  if (id.startsWith("solar-")) return "solar"
  return "other"
}

/**
 * Fallback snapshot of the official server-side catalog (30 models), captured
 * from /api/tool_cli/opencode-config. Used when the live fetch is unavailable.
 */
export const MODEL_METADATA: Record<string, GensparkModelInfo> = {
  "claude-fable-5": {
    name: "Claude Fable 5",
    family: "claude-fable",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_XHIGH,
  },
  "claude-opus-5": {
    name: "Claude Opus 5",
    family: "claude-opus",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_XHIGH,
  },
  "claude-opus-4-8": {
    name: "Claude Opus 4.8",
    family: "claude-opus",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_XHIGH,
  },
  "claude-opus-4-7": {
    name: "Claude Opus 4.7",
    family: "claude-opus",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_XHIGH,
  },
  "claude-opus-4-6-1m": {
    name: "Claude Opus 4.6 (1M)",
    family: "claude-opus",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_LMH,
  },
  "claude-sonnet-4-6-1m": {
    name: "Claude Sonnet 4.6 (1M)",
    family: "claude-sonnet",
    limit: { context: 1_000_000, input: 936_000, output: 64_000 },
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_LMH,
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    family: "claude-opus",
    limit: { context: 200_000, input: 72_000, output: 128_000 },
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_LMH,
  },
  "claude-sonnet-5": {
    name: "Claude Sonnet 5",
    family: "claude-sonnet",
    limit: { context: 400_000, input: 336_000, output: 64_000 },
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_XHIGH,
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    family: "claude-sonnet",
    limit: { context: 200_000, input: 136_000, output: 64_000 },
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_LMH,
  },
  "claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    family: "claude-haiku",
    limit: { context: 200_000, input: 136_000, output: 64_000 },
    capabilities: CAPABILITY_IMAGE_INPUT,
    variants: EFFORTS_LMH,
  },
  "gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    family: "gpt",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_FIXED_SAMPLING_REASONING,
    variants: EFFORTS_FULL,
  },
  "gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    family: "gpt",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_FIXED_SAMPLING_REASONING,
    variants: EFFORTS_FULL,
  },
  "gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    family: "gpt",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_FIXED_SAMPLING_REASONING,
    variants: EFFORTS_FULL,
  },
  "gpt-5.5": {
    name: "GPT-5.5",
    family: "gpt",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_FIXED_SAMPLING,
    variants: {},
  },
  "gpt-5.4": {
    name: "GPT-5.4",
    family: "gpt",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_FIXED_SAMPLING,
    variants: {},
  },
  "gpt-5.2": {
    name: "GPT-5.2",
    family: "gpt",
    limit: { context: 400_000, input: 272_000, output: 128_000 },
    capabilities: CAPABILITY_FIXED_SAMPLING,
    variants: {},
  },
  "gpt-5.4-mini": {
    name: "GPT-5.4 Mini",
    family: "gpt",
    limit: { context: 400_000, input: 272_000, output: 128_000 },
    capabilities: CAPABILITY_FIXED_SAMPLING,
    variants: {},
  },
  "gpt-5.4-nano": {
    name: "GPT-5.4 Nano",
    family: "gpt",
    limit: { context: 400_000, input: 272_000, output: 128_000 },
    capabilities: CAPABILITY_FIXED_SAMPLING,
    variants: {},
  },
  "deep-seek-v4-pro-baseten": {
    name: "DeepSeek V4 Pro (Baseten)",
    family: "deepseek",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "deepseek-v4-pro-0813": {
    name: "DeepSeek V4 Pro 0813",
    family: "deepseek",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "deep-seek-v4-flash": {
    name: "DeepSeek V4 Flash",
    family: "deepseek",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "glm-5p3": {
    name: "GLM-5.3",
    family: "glm",
    limit: { context: 1_000_000, input: 868_928, output: 131_072 },
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "glm-5p2": {
    name: "GLM-5.2",
    family: "glm",
    limit: LIMIT_1M_OUT_128K,
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "kimi-k3": {
    name: "Kimi K3",
    family: "kimi",
    limit: { context: 1_048_576, input: 1_015_808, output: 32_768 },
    capabilities: CAPABILITY_FIXED_SAMPLING,
    variants: {},
  },
  "kimi-k2p6": {
    name: "Kimi K2.6",
    family: "kimi",
    limit: { context: 262_144, input: 242_144, output: 16_384 },
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "minimax-m3": {
    name: "MiniMax M3",
    family: "minimax",
    limit: { context: 524_288, input: 491_520, output: 32_768 },
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "minimax-m2p7": {
    name: "MiniMax M2.7",
    family: "minimax",
    limit: { context: 196_608, input: 176_608, output: 16_384 },
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "grok-4.6": {
    name: "Grok 4.6",
    family: "grok",
    limit: { context: 200_000, input: 167_232, output: 32_768 },
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "grok-4.5": {
    name: "Grok 4.5",
    family: "grok",
    limit: { context: 200_000, input: 167_232, output: 32_768 },
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
  "solar-pro4": {
    name: "Solar Pro 4",
    family: "solar",
    limit: { context: 524_288, input: 458_752, output: 65_536 },
    capabilities: CAPABILITY_PLAIN,
    variants: {},
  },
}

export const MODEL_IDS = Object.keys(MODEL_METADATA)

/** Default model, matching the gsk CLI's `init-opencode` default. */
export const DEFAULT_MODEL_ID = "claude-opus-4-6-1m"

const GSK_CONFIG_DIR = ".genspark-tool-cli"

/** Path of the gsk CLI's config file, honouring its GSK_CONFIG override. */
export function gskConfigPath(): string {
  const override = process.env.GSK_CONFIG?.trim()
  if (override) return override
  return path.join(os.homedir(), GSK_CONFIG_DIR, "config.json")
}

/**
 * Reads the API key saved by `gsk login` (npm @genspark/cli). Returns a
 * trimmed key or undefined when the file is missing or carries none.
 */
export async function readGskCliApiKey(): Promise<string | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(gskConfigPath(), "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { api_key?: unknown }
    if (typeof parsed.api_key !== "string") return undefined
    const key = parsed.api_key.trim()
    return key || undefined
  } catch {
    return undefined
  }
}

/**
 * Credential priority, highest first: a key stored through `opencode auth`,
 * the GSK_API_KEY / GENSPARK_API_KEY environment variables, then the gsk CLI
 * login file. Returns undefined when no credential source resolves.
 */
export async function resolveApiKey(input: {
  authKey?: string
  env: Record<string, string | undefined>
}): Promise<string | undefined> {
  const stored = input.authKey?.trim()
  if (stored) return stored
  const fromEnv = [input.env["GSK_API_KEY"], input.env["GENSPARK_API_KEY"]].find(
    (value) => typeof value === "string" && value.trim() !== "",
  )
  if (fromEnv) return fromEnv.trim()
  return readGskCliApiKey()
}

// ---------------------------------------------------------------------------
// Live catalog
// ---------------------------------------------------------------------------

/**
 * Wire shape of /api/tool_cli/opencode-config. Deliberately permissive: unknown
 * fields are ignored and an entry that fails to decode is skipped rather than
 * failing the refresh, so a server-side addition cannot break model listing.
 */
const LiveConfig = Schema.Struct({
  provider: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        models: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
})

const LiveModel = Schema.Struct({
  name: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.optional(Schema.Number),
      input: Schema.optional(Schema.Number),
      output: Schema.optional(Schema.Number),
    }),
  ),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  reasoning: Schema.optional(Schema.Boolean),
  variants: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
})

export interface Catalog {
  readonly models: Record<string, GensparkModelInfo>
  /** True when `models` came from the live endpoint or its on-disk cache. */
  readonly live: boolean
}

/** 24h, matching the gsk CLI's own catalog cache TTL. */
const CATALOG_TTL = Duration.hours(24)

/** Provider key the server uses for the LLM proxy in the generated config. */
const CONFIG_PROVIDER_KEY = "genspark-llm-proxy"

function cacheFile(): string {
  // Keyed on host so switching GENSPARK_BASE_URL cannot serve another
  // environment's catalog — the same invalidation the CLI applies (config.js).
  return path.join(Global.Path.cache, `genspark-catalog-${Hash.fast(host())}.json`)
}

/** Converts one endpoint entry into the metadata shape, or undefined if unusable. */
function toModelInfo(id: string, raw: unknown): GensparkModelInfo | undefined {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(LiveModel)(raw))
  if (!parsed) return undefined
  const context = parsed.limit?.context
  if (typeof context !== "number" || !Number.isFinite(context)) return undefined
  const fallback = MODEL_METADATA[id]
  const image = parsed.modalities?.input?.includes("image") ?? fallback?.capabilities.input.image ?? false
  const reasoning = parsed.reasoning ?? fallback?.capabilities.reasoning ?? false
  const base = image ? CAPABILITY_IMAGE_INPUT : CAPABILITY_PLAIN
  return {
    name: parsed.name ?? fallback?.name ?? id,
    family: familyFor(id),
    limit: {
      context,
      input: parsed.limit?.input ?? fallback?.limit.input,
      output: parsed.limit?.output ?? fallback?.limit.output ?? 8192,
    },
    capabilities: { ...base, reasoning } as GensparkModelInfo["capabilities"],
    variants: (parsed.variants ?? fallback?.variants ?? {}) as Record<string, Record<string, string>>,
  }
}

function modelsFrom(entries: Record<string, unknown>): Record<string, GensparkModelInfo> | undefined {
  const result: Record<string, GensparkModelInfo> = {}
  for (const [id, raw] of Object.entries(entries)) {
    const info = toModelInfo(id, raw)
    if (info) result[id] = info
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function configModels(raw: unknown): Record<string, unknown> | undefined {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(LiveConfig)(raw))
  return parsed?.provider?.[CONFIG_PROVIDER_KEY]?.models
}

export interface Interface {
  /**
   * Catalog, using the cached live copy when fresh and falling back to the
   * static snapshot. Never fails. Costs a metadata request at most once per TTL.
   */
  readonly get: (apiKey: string | undefined) => Effect.Effect<Catalog>
  /** Force a refresh. Opt-in only; costs a metadata request, never a completion. */
  readonly refresh: (apiKey: string | undefined) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GensparkCatalog") {}

const layer: Layer.Layer<Service, never, FSUtil.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service

    const isTestEnv = () =>
      process.env.NODE_ENV === "test" ||
      !!process.env.BUN_TEST ||
      !!process.env.OPENCODE_TEST_HOME ||
      !!process.env.VITEST

    const fromDisk = Effect.fnUntraced(function* () {
      const filepath = cacheFile()
      const stat = yield* fsys.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return undefined
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      if (Date.now() - mtime >= Duration.toMillis(CATALOG_TTL)) return undefined
      const raw = yield* fsys.readJson(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const models = configModels(raw)
      if (!models) return undefined
      const parsed = modelsFrom(models)
      return parsed ? { models: parsed, live: true } : undefined
    })

    const fetchRemote = Effect.fn("GensparkCatalog.fetchRemote")(function* (apiKey: string) {
      const response = yield* Effect.promise(() =>
        fetch(`${host()}/api/tool_cli/opencode-config`, {
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": apiKey,
            "X-GSK-CLI-Caps": GSK_CLI_CAPS,
            "X-GSK-CLI-Version": GSK_CLI_VERSION,
          },
          signal: AbortSignal.timeout(10_000),
        }),
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = yield* Effect.promise(() => response.text())
      const body: unknown = JSON.parse(text)
      const entries = configModels(body)
      if (!entries) return undefined
      const parsed = modelsFrom(entries)
      if (!parsed) return undefined
      const filepath = cacheFile()
      const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
      yield* fsys
        .writeWithDirs(tempfile, text)
        .pipe(
          Effect.andThen(fsys.rename(tempfile, filepath)),
          Effect.catch(() => fsys.remove(tempfile, { force: true }).pipe(Effect.ignore)),
        )
        .pipe(Effect.ignore)
      return { models: parsed, live: true }
    })

    const populate = (apiKey: string | undefined) =>
      Effect.gen(function* () {
        if (!apiKey) return { models: MODEL_METADATA, live: false }
        if (isTestEnv()) return { models: MODEL_METADATA, live: false }
        const disk = yield* fromDisk()
        if (disk) return disk
        const remote = yield* Effect.scoped(
          Effect.gen(function* () {
            const filepath = cacheFile()
            const lockKey = `genspark-catalog:${filepath}`
            yield* Flock.effect(lockKey)
            // Re-check under the lock: another process may have written it.
            const again = yield* fromDisk()
            if (again) return again
            return yield* fetchRemote(apiKey)
          }),
        )
        return remote ?? { models: MODEL_METADATA, live: false }
      }).pipe(Effect.orElseSucceed((): Catalog => ({ models: MODEL_METADATA, live: false })))

    // Keyed on credential + host so switching accounts or GENSPARK_BASE_URL
    // never serves a stale catalog. Map, not single slot, so concurrent
    // `it.instance` tests with different env don't race on one cachedKey.
    const cache = new Map<string, Catalog>()
    const cacheKeyFor = (apiKey: string | undefined) => `${apiKey ?? ""}::${host()}`
    const load = Effect.fn("GensparkCatalog.load")(function* (apiKey: string | undefined, force: boolean) {
      const k = cacheKeyFor(apiKey)
      if (!force) {
        const hit = cache.get(k)
        if (hit) return hit
      }
      const next = yield* populate(apiKey)
      cache.set(k, next)
      return next
    })

    return Service.of({
      get: (apiKey) => load(apiKey, false),
      refresh: (apiKey) => load(apiKey, true).pipe(Effect.asVoid),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })

export * as GensparkCatalog from "./catalog"
