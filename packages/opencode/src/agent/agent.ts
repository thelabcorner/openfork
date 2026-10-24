import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { OpenCodeHostedUserAgent } from "@opencode-ai/core/installation/version"
import type { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"
import { Usage as UsageAnalytics } from "@/usage/usage"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"

import { generateObject, streamObject, wrapLanguageModel, type ModelMessage } from "ai"
import { Usage as LLMUsage } from "@opencode-ai/llm"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_DREAMER from "./prompt/dreamer.txt"
import PROMPT_SWARM_MEMBER from "./prompt/swarm-member.txt"
import PROMPT_SWARM_COORDINATOR from "./prompt/swarm-coordinator.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import { DEFAULT_PROMPT as PROMPT_TITLE } from "@opencode-ai/core/session/title-prompt"
import { DEFAULT_PROMPT as PROMPT_REVISOR } from "@opencode-ai/core/prompt-revisor-prompt"
import { Permission } from "@/permission"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import { LEGACY_PROJECT_CONFIG_DIRNAME, PROJECT_CONFIG_DIRNAME } from "@opencode-ai/core/storage-identity"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { Agent as AgentContract } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
      accountID: Schema.optional(Schema.String),
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

/**
 * Built-in identity and shipped mode/hidden defaults come from the shared agent
 * contract. Config may override effective exposure later in this state builder;
 * `AgentContract.builtIn` throwing here still ensures a newly shipped native
 * agent cannot exist without declaring its default topology once.
 */
function native(id: string) {
  const topology = AgentContract.builtIn(id)
  if (!topology) throw new Error(`built-in agent "${id}" is missing from the shared agent contract topology`)
  return topology
}

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID; accountID?: string }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError | Provider.UnsupportedModelPrimitiveError | Provider.RouteResolutionError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

const routeAttribution = (
  routed: Provider.TransientRoutedModel | undefined,
): UsageRouteAttribution.Committed | undefined =>
  routed?.route.route.kind === "account"
    ? { routeKind: "account", accountID: routed.route.route.accountID }
    : routed?.route.route.kind === "public"
      ? { routeKind: "public" }
      : undefined

type StructuredUsage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly reasoningTokens?: number
  readonly cachedInputTokens?: number
  readonly inputTokenDetails?: { readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
  readonly outputTokenDetails?: { readonly reasoningTokens?: number }
}

const finiteToken = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

function normalizeStructuredUsage(value: StructuredUsage) {
  const cacheRead = finiteToken(value.inputTokenDetails?.cacheReadTokens ?? value.cachedInputTokens)
  const cacheWrite = finiteToken(value.inputTokenDetails?.cacheWriteTokens)
  const reasoning = finiteToken(value.outputTokenDetails?.reasoningTokens ?? value.reasoningTokens)
  const inputTotal = finiteToken(value.inputTokens)
  const outputTotal = finiteToken(value.outputTokens)
  const input = Math.max(0, inputTotal - cacheRead - cacheWrite)
  const output = Math.max(0, outputTotal - reasoning)
  const totalTokens = Math.max(
    finiteToken(value.totalTokens),
    input + cacheRead + cacheWrite + output + reasoning,
  )
  return {
    raw: new LLMUsage({
      inputTokens: inputTotal,
      outputTokens: outputTotal,
      totalTokens,
      cacheReadInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
      reasoningTokens: reasoning,
    }),
    tokens: { input, cacheRead, cacheWrite, output, reasoning },
    totalTokens,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const usage = yield* UsageAnalytics.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = Object.keys(cfg.references ?? cfg.reference ?? {}).length
          ? yield* Effect.gen(function* () {
              yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
              return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
          : []
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: native("build").mode,
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  general: "deny",
                },
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(PROJECT_CONFIG_DIRNAME, "plans", "*.md")]: "allow",
                  [path.join(LEGACY_PROJECT_CONFIG_DIRNAME, "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: native("plan").mode,
            native: true,
          },
          yolo: {
            name: "yolo",
            description:
              "Full-autonomy mode for trusted development work. Routine permissions are auto-approved; catastrophic recursive deletes remain hard-blocked.",
            options: {},
            permission: Permission.merge(defaults, user, Permission.fromConfig({ "*": "allow" })),
            mode: native("yolo").mode,
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: native("general").mode,
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: native("explore").mode,
            native: true,
          },
          dreamer: {
            name: "dreamer",
            description: "Host-owned special agent for background historical investigation. Searches authorized Session history and memory; never codes or edits.",
            mode: native("dreamer").mode,
            hidden: native("dreamer").hidden,
            native: true,
            prompt: PROMPT_DREAMER,
            permission: Permission.fromConfig({ "*": "deny", session: "allow", memory: "allow" }),
            options: {},
          },
          "swarm-m": {
            name: "swarm-m",
            description: "Native Swarm member mode for peer collaboration and task execution.",
            prompt: PROMPT_SWARM_MEMBER,
            permission: Permission.merge(defaults, user),
            options: {},
            mode: native("swarm-m").mode,
            native: true,
            hidden: native("swarm-m").hidden,
          },
          "swarm-c": {
            name: "swarm-c",
            description: "Native Swarm coordinator mode for delegation, review, and coordination.",
            prompt: PROMPT_SWARM_COORDINATOR,
            permission: Permission.merge(defaults, user),
            options: {},
            mode: native("swarm-c").mode,
            native: true,
            hidden: native("swarm-c").hidden,
          },
          compaction: {
            name: "compaction",
            mode: native("compaction").mode,
            native: true,
            hidden: native("compaction").hidden,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: native("title").mode,
            options: {},
            native: true,
            hidden: native("title").hidden,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          "prompt-revisor": {
            name: "prompt-revisor",
            description: "Read-only host-owned prompt and Goal revision agent.",
            mode: native("prompt-revisor").mode,
            native: true,
            hidden: native("prompt-revisor").hidden,
            steps: 3,
            prompt: PROMPT_REVISOR,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                read: "allow",
                question: "allow",
                composer_context: "allow",
                revision_progress: "allow",
                revised_prompt: "allow",
              }),
              user,
            ),
            options: {},
          },
          summary: {
            name: "summary",
            mode: native("summary").mode,
            options: {},
            native: true,
            hidden: native("summary").hidden,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          const swarmRolePrompt = key === "swarm-m" || key === "swarm-c"
          if (value.disable && !swarmRolePrompt) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          // Keep the host-owned Swarm peer/coordinator contract present even
          // when a project adds agent-specific guidance through config.
          item.prompt = swarmRolePrompt
            ? [item.prompt, value.prompt].filter((part): part is string => Boolean(part)).join("\n\n")
            : value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // YOLO is deliberately stronger than project/global permission policy.
        // Keep the final wildcard last so a project-level ask/deny cannot turn
        // trusted autonomous work back into a modal permission loop.
        if (agents.yolo) {
          agents.yolo.permission = Permission.merge(agents.yolo.permission, Permission.fromConfig({ "*": "allow" }))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        // Dreamer is a host-owned special agent, not a delegated subagent:
        // its policy is not editable through project config. No shell, code,
        // task, write, plugin or broker capability is ever granted, and the
        // special-agent exposure (hidden primary, non-delegatable) comes from
        // the shared built-in contract so config cannot reopen Task access.
        if (agents.dreamer) {
          agents.dreamer.name = "dreamer"
          agents.dreamer.prompt = PROMPT_DREAMER
          agents.dreamer.permission = Permission.fromConfig({ "*": "deny", session: "allow", memory: "allow" })
          agents.dreamer.mode = native("dreamer").mode
          agents.dreamer.hidden = native("dreamer").hidden
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          const preferred = cfg.default_agent ?? "build"
          return Object.values(agents).toSorted((a, b) => {
            const aPreferred = a.name === preferred
            const bPreferred = b.name === preferred
            if (aPreferred !== bPreferred) return aPreferred ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID; accountID?: string }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const routed = yield* provider.resolveTransientRoutedModel({
          providerID: model.providerID,
          modelID: model.modelID,
          ...(input.model?.accountID
            ? { accountID: input.model.accountID }
            : { routeIntent: { kind: "strategy" as const } }),
          executionPurpose: "special-agent",
        })
        if (Provider.isHostedZenProvider(model.providerID) && (!routed || routed.route.route.kind !== "account")) {
          return yield* new Provider.RouteResolutionError({
            providerID: model.providerID,
            modelID: model.modelID,
            cause: new Error("No authoritative OpenCode route resolved for hosted Agent.generate"),
          })
        }
        const resolved =
          routed?.model ?? (yield* provider.getModel(model.providerID, model.modelID, input.model?.accountID))
        const route = routeAttribution(routed)
        const hosted = resolved.providerID.startsWith("opencode")
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // A committed transient OpenCode route already owns auth. Legacy Auth
        // remains available only for intentionally direct providers.
        const authInfo = routed ? undefined : yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"
        const requestSessionID = SessionID.descending()
        const requestID = MessageID.ascending()
        const instance = hosted ? yield* InstanceState.context : undefined
        const headers = hosted
          ? {
              ...(instance?.project.id ? { "x-opencode-project": instance.project.id } : {}),
              "x-opencode-session": requestSessionID,
              "x-opencode-request": requestID,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
              "User-Agent": OpenCodeHostedUserAgent(),
            }
          : undefined
        const exactLanguage = hosted
          ? wrapLanguageModel({
              model: language,
              middleware: {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  // AI SDK appends its own `ai/<version>` suffix before model
                  // middleware runs. OpenCode's hosted service expects the exact
                  // upstream OpenCode User-Agent, so restore it at the final
                  // provider boundary rather than merely preparing it earlier.
                  return {
                    ...args.params,
                    headers: {
                      ...args.params.headers,
                      "user-agent": OpenCodeHostedUserAgent(),
                    },
                  }
                },
              },
            })
          : language
        const startedAt = Date.now()

        const recordUsage = Effect.fn("Agent.generate.recordUsage")(function* (raw: StructuredUsage) {
          const normalized = normalizeStructuredUsage(raw)
          const priced = Session.getUsage({ model: resolved, usage: normalized.raw })
          yield* usage.recordMaintenance({
            agent: "agent_generator",
            providerID: resolved.providerID,
            modelID: resolved.id,
            ...(route ? { route } : {}),
            projectID: instance?.project.id ?? null,
            sessionID: null,
            cost: priced.cost,
            tokens: normalized.tokens,
            totalTokens: normalized.totalTokens,
            startedAt,
            completedAt: Date.now(),
          })
        })

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          ...(headers ? { headers } : {}),
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: exactLanguage,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          const generated = yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return {
              object: await result.object,
              usage: await result.usage,
            }
          })
          yield* recordUsage(generated.usage)
          return generated.object
        }

        const generated = yield* Effect.promise(() => generateObject(params))
        yield* recordUsage(generated.usage)
        return generated.object
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Auth.node, Plugin.node, Skill.node, Provider.node, UsageAnalytics.node, locationServiceMapNode],
})

export * as Agent from "./agent"
