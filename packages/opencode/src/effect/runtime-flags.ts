import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("OPENCODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {
  autoShare: bool("OPENCODE_AUTO_SHARE"),
  pure: bool("OPENCODE_PURE"),
  disableDefaultPlugins: bool("OPENCODE_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("OPENCODE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("OPENCODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("OPENCODE_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("OPENCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("OPENCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  // First-party Claude (`claude` provider) opt-out. The external
  // @openchamber/opencode-claude plugin remains independently available as `claude-code`.
  disableClaudeCodeFirstParty: Config.all({
    current: bool("OPENCODE_DISABLE_CLAUDE_FIRST_PARTY"),
    legacy: bool("OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY"),
  }).pipe(Config.map((flags) => flags.current || flags.legacy)),
  enableExa: Config.all({
    experimental,
    enabled: bool("OPENCODE_ENABLE_EXA"),
    legacy: bool("OPENCODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("OPENCODE_ENABLE_PARALLEL"),
    legacy: bool("OPENCODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableFirecrawl: Config.all({
    enabled: bool("OPENCODE_ENABLE_FIRECRAWL"),
    legacy: bool("OPENCODE_EXPERIMENTAL_FIRECRAWL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableDuckDuckGo: Config.all({
    enabled: bool("OPENCODE_ENABLE_DUCKDUCKGO"),
    legacy: bool("OPENCODE_EXPERIMENTAL_DUCKDUCKGO"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableBrave: Config.all({
    enabled: bool("OPENCODE_ENABLE_BRAVE"),
    legacy: bool("OPENCODE_EXPERIMENTAL_BRAVE"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableTavily: Config.all({
    enabled: bool("OPENCODE_ENABLE_TAVILY"),
    legacy: bool("OPENCODE_EXPERIMENTAL_TAVILY"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableSearxng: Config.all({
    enabled: bool("OPENCODE_ENABLE_SEARXNG"),
    legacy: bool("OPENCODE_EXPERIMENTAL_SEARXNG"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("OPENCODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("OPENCODE_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("OPENCODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("OPENCODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("OPENCODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("OPENCODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("OPENCODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("OPENCODE_EXPERIMENTAL_WEBSOCKETS"),
  // Structural performance unlocks. All default-OFF; each requires the
  // equivalence gate in docs/perf-structural-unlocks before enabling.
  experimentalIncrementalTranscript: bool("OPENCODE_EXPERIMENTAL_INCREMENTAL_TRANSCRIPT"),
  experimentalDbWriteBatch: bool("OPENCODE_EXPERIMENTAL_DB_WRITE_BATCH"),
  experimentalDbReadWriteSplit: bool("OPENCODE_EXPERIMENTAL_DB_READ_WRITE_SPLIT"),
  client: Config.string("OPENCODE_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
