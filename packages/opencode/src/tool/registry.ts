import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createHash } from "node:crypto"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { FindTool } from "./find"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { Database } from "@opencode-ai/core/database/database"
import { TodoWriteTool } from "./todo"
import { WebTool } from "./web"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { ArchiveTool } from "./archive"
import { JsonTool } from "./json"
import { BackgroundTool } from "./background"
import { MemoryTool } from "./memory"
import { DreamTool } from "./dream"
import { SqliteTool } from "./sqlite"
import { GitTool } from "./git"
import { GithubTool } from "./github"
import { QuotaTool } from "./quota"
import { UsageTool } from "./usage"
import { ModelsTool } from "./models"
import { Git } from "@/git"
import { Checkpoint } from "@opencode-ai/core/checkpoint"
import { CheckpointTool } from "./checkpoint"
import { GoalTool } from "./goal"
import { ScheduledTaskTool } from "./scheduled-task"
import { SwarmTool } from "./swarm"
import { SwarmCreateTool } from "./swarm-create"
import { SwarmMemberTool } from "./swarm-member"
import { SessionTool } from "./session"
import { TurnCheckpoint } from "@/session/checkpoint"
import { Snapshot } from "@/snapshot"
import { TypecheckTool } from "./typecheck"
import { ProjectTool } from "./project"
import { SymbolsTool } from "./symbols"
import { Symbols } from "@/symbols/service"
import { TestTool } from "./test"
import { RefactorTool } from "./refactor"
import { SympyTool } from "./sympy"
import { createToolAccessTool, isLazyTool, TOOL_ACCESS_ID } from "./access"
import * as Tool from "./tool"
import * as Capability from "./capability"
import { ToolJsonSchema } from "./json-schema"
import { buildCustomTools } from "./custom"
import { Config } from "@/config/config"
import { SessionStatus } from "@/session/status"
import { Project } from "@/project/project"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { PatchTool } from "./patch"
import { BrowserTool } from "./browser"
import { OfxpTool } from "./ofxp"
import { CodeTool } from "./code"
import { RuntimeRefreshTool } from "./runtime-refresh"
import { BrokerClient } from "@/browser/broker-client"
import { OfxpRuntime } from "@/ofxp/runtime"
import { ExternalToolCoverage } from "@/exchange/tool-coverage"
import { Effect, Layer, Context, Ref } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { ShellJobs } from "@/background/shell-jobs"
import { MonitorDelivery } from "@/background/monitor-delivery"
import { SessionIngress } from "@/session/ingress"
import { ShellJob } from "@/background/shell-job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MCP } from "@/mcp"
import { ToolInterrupt } from "@/tool/interrupt"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { McpCatalog } from "@/mcp/catalog"
import * as McpResourceTools from "@/mcp/resource-capabilities"
import { Memory } from "@opencode-ai/core/memory"
import { GoalAgent } from "@opencode-ai/core/goal/agent"
import { ScheduledTaskAgent } from "@opencode-ai/core/scheduled-task/agent"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmMemberSessionWake } from "@/swarm/member-session-wake"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import { SwarmContainment } from "@/swarm/containment"
import { SavedCodeCatalog } from "@/code/saved"
import * as SavedCapability from "@/code/saved-capability"
import type { SessionID } from "@/session/schema"
import { Quota } from "@/quota/quota"
import { Usage } from "@/usage/usage"
import { ModelsDev } from "@opencode-ai/core/models-dev"

export function webSearchEnabled(
  providerID: ProviderV2.ID,
  flags = { exa: false, parallel: false, firecrawl: false, duckduckgo: false, brave: false, tavily: false, searxng: false },
) {
  return (
    providerID === ProviderV2.ID.opencode ||
    providerID === ProviderV2.ID.make("opencode-go") ||
    flags.exa ||
    flags.parallel ||
    flags.firecrawl ||
    flags.duckduckgo ||
    flags.brave ||
    flags.tavily ||
    flags.searxng
  )
}

type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  generation: number
  custom: Tool.Def[]
  builtin: Tool.Def[]
  read: ReadDef
}

const snapshotReadOnlyTools = new Set([
  "invalid",
  "question",
  "read",
  "find",
  "web",
  "todo",
  "skill",
  "memory",
  "github",
  "quota",
  "usage",
  "project",
  "symbols",
  "sympy",
  "lsp",
  // Delegators do not own the leaf operation lifetime. Their nested tools are
  // independently guarded at the same registry boundary.
  "task",
  "session",
  "goal",
  "scheduled_task",
  "swarm_create",
  "ofxp",
  TOOL_ACCESS_ID,
])

function inputRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Conservative worktree-mutation classification for Snapshot reuse.
 *
 * Unknown/custom/plugin tools intentionally default to `true`. Only operations
 * whose semantics are provably read-only preserve a completed project tree.
 * This function classifies filesystem authority, not DB/session mutation.
 */
export function toolMayMutateWorkspace(toolID: string, input: unknown): boolean {
  if (snapshotReadOnlyTools.has(toolID)) return false
  const args = inputRecord(input)

  switch (toolID) {
    case "code":
      // Discovery and exact contract inspection cannot mutate the project tree.
      // run/call may dispatch mutating leaves, while save publishes a durable
      // filesystem-authoritative artifact, so every other Code action remains
      // conservatively mutating.
      return args.action !== "search" && args.action !== "describe"
    case "archive":
      return args.action !== "list" && args.action !== "read"
    case "json": {
      const mode = args.mode ?? "validate"
      if (mode !== "format" && mode !== "patch") return false
      return args.dryRun === false
    }
    case "sqlite":
      return args.action === "run" || args.action === "export"
    case "git": {
      const mode = args.mode ?? "status"
      return !["help", "status", "summary", "diff", "log", "show"].includes(String(mode))
    }
    case "checkpoint":
      return args.mode === "restore"
    case "background":
      return !["list", "status", "read", "wait"].includes(String(args.action))
    case "swarm":
      return args.action === "recover.members"
    case "dream":
      return false
    case "swarm_member":
      // Session-derived Swarm collaboration is durable-domain state only. It
      // never reads or writes workspace files: `files` in publish records a path
      // reference, it does not transfer bytes.
      return false
    default:
      return true
  }
}

const delegatedPermissionTools = new Set([FindTool.id, WebTool.id, BrowserTool.id])

// Host-owned Dreamer is a historical read-only role, not an ordinary
// configurable coding agent. An inherited Session allow or a custom/MCP
// registration must never extend these two inspection leaves.
const dreamerAllows = (toolID: string) => toolID === "memory" || toolID === "session"

const nonCodeCallableTools = new Set(["invalid", TOOL_ACCESS_ID, "code"])

const durableCapabilityTools = new Set([
  "background",
  "dream",
  "goal",
  "scheduled_task",
  "task",
  "session",
  "swarm",
  "swarm_create",
  "ofxp",
])

function capabilityLifetime(toolID: string): Capability.Lifetime {
  return durableCapabilityTools.has(toolID) ? "durable" : "inline"
}

/**
 * Provider-visible aliases must never widen an older permission boundary.
 *
 * swarm_create is a direct UX facade over the lazy swarm owner, so an existing
 * broad swarm deny also denies creation. A tool-specific deny still applies
 * independently; an explicit facade allow cannot punch through the owner deny.
 */
const providerPermissionOwners: Readonly<Record<string, string>> = {
  swarm_create: "swarm",
  dream: "task",
}

type ModelSelectionInput = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
}

function selectModelTools(tools: readonly Tool.Def[], input: ModelSelectionInput, includeLazy: boolean) {
  const usePatch =
    input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")

  return tools.filter((tool) => {
    if (!includeLazy && isLazyTool(tool)) return false
    if (tool.id === ApplyPatchTool.id) return usePatch
    if (tool.id === PatchTool.id) return !usePatch
    if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch
    return true
  })
}

function fingerprint(parts: readonly string[]) {
  let hash = 0x811c9dc5
  for (const part of parts) {
    for (let index = 0; index < part.length; index++) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function searchGeneration(entries: readonly Capability.Registration[]) {
  const hash = createHash("sha256")
  for (const entry of [...entries].sort((a, b) => a.identity.ref.localeCompare(b.identity.ref))) {
    hash.update(entry.identity.ref)
    hash.update("\0")
    hash.update(entry.identity.segments.join("\0"))
    hash.update("\0")
    hash.update(entry.kind)
    hash.update("\0")
    hash.update(entry.description)
    hash.update("\0")
    hash.update(entry.codeCallable ? "1" : "0")
    hash.update("\xff")
  }
  return `search:${hash.digest("hex")}`
}

function providerPolicy(toolID: string, ruleset: PermissionV1.Ruleset): PermissionV1.Rule {
  const owner = providerPermissionOwners[toolID]
  if (owner) {
    const ownerPolicy = Permission.evaluate(owner, "*", ruleset)
    if (ownerPolicy.action === "deny") return ownerPolicy
  }

  if (!delegatedPermissionTools.has(toolID)) return Permission.evaluate(toolID, "*", ruleset)
  return (
    ruleset.findLast((rule) => rule.permission === toolID && rule.pattern === "*") ?? {
      action: "allow",
      permission: toolID,
      pattern: "*",
    }
  )
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
  }) => Effect.Effect<Tool.Def[]>
  readonly capabilities: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
    /** Real provider-root session; required for physical-scope saved overlays. */
    sessionID?: SessionID
  }) => Effect.Effect<Capability.Inventory>
  readonly refreshCustom: (custom: Tool.Def[]) => Effect.Effect<{
    added: string[]
    updated: string[]
    removed: string[]
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const mcp = yield* MCP.Service
    const snapshot = yield* Snapshot.Service
    const session = yield* Session.Service
    const savedCatalog = yield* SavedCodeCatalog.Service

    const guardSnapshot = <T extends Tool.Def>(tool: T): T => {
      const execute = tool.execute
      return {
        ...tool,
        execute: (args: unknown, ctx: Tool.Context) =>
          toolMayMutateWorkspace(tool.id, args)
            ? snapshot.withMutation(execute(args as never, ctx), `tool:${tool.id}`)
            : execute(args as never, ctx),
      } as T
    }

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webtool = yield* WebTool
    const shell = yield* ShellTool
    const findtool = yield* FindTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const archivetool = yield* ArchiveTool
    const jsontool = yield* JsonTool
    const backgroundtool = yield* BackgroundTool
    const memorytool = yield* MemoryTool
    const dreamtool = yield* DreamTool
    const sqlitetool = yield* SqliteTool
    const gittool = yield* GitTool
    const githubtool = yield* GithubTool
    const quotaTool = yield* QuotaTool
    const usageTool = yield* UsageTool
    const modelsTool = yield* ModelsTool
    const checkpointtool = yield* CheckpointTool
    const goaltool = yield* GoalTool
    const scheduledtasktool = yield* ScheduledTaskTool
    const swarmtool = yield* SwarmTool
    const swarmcreatetool = yield* SwarmCreateTool
    const swarmmembertool = yield* SwarmMemberTool
    const sessiontool = yield* SessionTool
    const typechecktool = yield* TypecheckTool
    const projecttool = yield* ProjectTool
    const symbolstool = yield* SymbolsTool
    const testtool = yield* TestTool
    const refactortool = yield* RefactorTool
    const sympytool = yield* SympyTool
    const patchTool = yield* PatchTool
    const browsertool = yield* BrowserTool
    const ofxptool = yield* OfxpTool
    const codeTool = yield* CodeTool
    const runtimeRefreshTool = yield* RuntimeRefreshTool

    const state = yield* InstanceState.make<Ref.Ref<State>>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const dirs = yield* config.directories()
        const plugins = yield* plugin.list()
        const custom = (
          yield* buildCustomTools(dirs, plugins, {
            truncate,
            directory: ctx.directory,
            worktree: ctx.worktree,
            waitForDependencies: config.waitForDependencies,
          })
        ).map(guardSnapshot)

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const raw = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          find: Tool.init(findtool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          web: Tool.init(webtool),
          todo: Tool.init(todo),
          skill: Tool.init(skilltool),
          archive: Tool.init(archivetool),
          json: Tool.init(jsontool),
          background: Tool.init(backgroundtool),
          memory: Tool.init(memorytool),
          dream: Tool.init(dreamtool),
          sqlite: Tool.init(sqlitetool),
          git: Tool.init(gittool),
          github: Tool.init(githubtool),
          quota: Tool.init(quotaTool),
          usage: Tool.init(usageTool),
          models: Tool.init(modelsTool),
          checkpoint: Tool.init(checkpointtool),
          goal: Tool.init(goaltool),
          scheduledTask: Tool.init(scheduledtasktool),
          swarm: Tool.init(swarmtool),
          swarmCreate: Tool.init(swarmcreatetool),
          swarmMember: Tool.init(swarmmembertool),
          session: Tool.init(sessiontool),
          typecheck: Tool.init(typechecktool),
          project: Tool.init(projecttool),
          symbols: Tool.init(symbolstool),
          test: Tool.init(testtool),
          refactor: Tool.init(refactortool),
          sympy: Tool.init(sympytool),
          patchTool: Tool.init(patchTool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          browser: Tool.init(browsertool),
          ofxp: Tool.init(ofxptool),
          code: Tool.init(codeTool),
          runtimeRefresh: Tool.init(runtimeRefreshTool),
        })

        const tool = Object.fromEntries(
          Object.entries(raw).map(([key, value]) => [key, guardSnapshot(value)]),
        ) as typeof raw

        const lazy = [...Object.values(tool), ...custom].filter(isLazyTool)
        const toolAccessDef = createToolAccessTool(lazy, plugin)

        // OFXP parity is an architectural invariant, not a hand-maintained
        // checklist. Every provider-visible builtin must have an explicit
        // remote semantic equivalent (which may intentionally be supervision,
        // delegation, an alias, or an intrinsic broker behavior).
        ExternalToolCoverage.assertNativeCovered([
          ...Object.values(tool).map((item) => item.id),
          toolAccessDef.id,
        ])

        return yield* Ref.make<State>({
          generation: 1,
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.find,
            tool.edit,
            tool.write,
            tool.task,
            tool.web,
            tool.todo,
            tool.skill,
            tool.archive,
            tool.json,
            tool.background,
            tool.memory,
            tool.dream,
            tool.sqlite,
            tool.git,
            tool.github,
            tool.quota,
            tool.usage,
            tool.models,
            tool.checkpoint,
            tool.goal,
            tool.scheduledTask,
            tool.swarm,
            tool.swarmCreate,
            tool.swarmMember,
            tool.session,
            tool.typecheck,
            tool.project,
            tool.symbols,
            tool.test,
            toolAccessDef,
            tool.refactor,
            tool.sympy,
            tool.patchTool,
            tool.patch,
            tool.browser,
            tool.ofxp,
            tool.code,
            tool.runtimeRefresh,
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
          ],
          read: tool.read,
        })
      }),
    )

    const readState = Effect.fn("ToolRegistry.readState")(function* () {
      const stateRef = yield* InstanceState.get(state)
      return yield* Ref.get(stateRef)
    })

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* readState()
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const refreshCustom: Interface["refreshCustom"] = Effect.fn("ToolRegistry.refreshCustom")(function* (
      custom: Tool.Def[],
    ) {
      const guarded = custom.map(guardSnapshot)
      const stateRef = yield* InstanceState.get(state)
      const current = yield* Ref.get(stateRef)
      // Invariant: in-flight execute closures were captured at build time (the
      // ai-sdk tool() wraps the def at resolve), so this swap affects only the
      // NEXT resolve ΓÇö a running tool call keeps the def it started with.
      const lazy = [...current.builtin, ...guarded].filter(isLazyTool)
      const builtin = current.builtin.map((tool) =>
        tool.id === TOOL_ACCESS_ID ? createToolAccessTool(lazy, plugin) : tool,
      )
      yield* Ref.set(stateRef, { ...current, generation: current.generation + 1, builtin, custom: guarded })
      const currentIds = new Set(current.custom.map((tool) => tool.id))
      const nextIds = new Set(guarded.map((tool) => tool.id))
      return {
        added: guarded.filter((tool) => !currentIds.has(tool.id)).map((tool) => tool.id),
        updated: guarded.filter((tool) => currentIds.has(tool.id)).map((tool) => tool.id),
        removed: current.custom.filter((tool) => !nextIds.has(tool.id)).map((tool) => tool.id),
      }
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const shapeDefinition = Effect.fn("ToolRegistry.shapeDefinition")(function* (
      tool: Tool.Def,
      input: { agent: Agent.Info },
    ) {
      const output = {
        description: tool.description,
        parameters: tool.parameters,
        jsonSchema: tool.jsonSchema,
      }
      yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
      const jsonSchema =
        output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
          ? output.jsonSchema
          : undefined
      return {
        description: [
          output.description,
          tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        parameters: output.parameters,
        jsonSchema,
      }
    })

    const capabilities: Interface["capabilities"] = Effect.fn("ToolRegistry.capabilities")(function* (input) {
      const current = yield* readState()
      const dreamer = input.agent.name === "dreamer"
      const candidates = selectModelTools([...current.builtin, ...current.custom], input, true)
        .filter((tool) => !dreamer || dreamerAllows(tool.id))
      const nativeEntries = yield* Effect.forEach(
        candidates,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          const shaped = yield* shapeDefinition(tool, input)
          const shapedTool = {
            ...tool,
            description: shaped.description,
            parameters: shaped.parameters,
            jsonSchema: shaped.jsonSchema,
          } as Tool.Def
          const inputSchema = ToolJsonSchema.fromTool(shapedTool)
          const initialized = Tool.hasSemantic(tool)
          const identity = Capability.nativeIdentity(tool.id)
          const owner = providerPermissionOwners[tool.id]

          return {
            identity,
            kind: isLazyTool(tool) ? "lazy" : "native",
            description: shaped.description,
            inputSchema,
            permissionKey: tool.id,
            ...(owner ? { delegatesTo: [owner] } : {}),
            invokeSemantic: initialized
              ? (args, ctx) => tool.semantic(args as never, ctx)
              : (args, ctx) => tool.execute(args as never, ctx),
            authorize: ({ authority }) => {
              const policy = providerPolicy(tool.id, authority.ruleset)
              return policy.action === "deny"
                ? Effect.fail(new PermissionV1.DeniedError({ ruleset: [policy] }))
                : Effect.void
            },
            authorityBinding: `native:${tool.id}`,
            classifyWorkspaceMutation: (args) => toolMayMutateWorkspace(tool.id, args),
            codeCallable: initialized && !nonCodeCallableTools.has(tool.id),
            lifetime: capabilityLifetime(tool.id),
          } satisfies Capability.Registration
        }),
        { concurrency: 8 },
      )

      const exactMcp = yield* mcp.exactTools()
      const mcpClients = yield* mcp.clients()
      const resourceServers = Object.entries(mcpClients)
        .filter(([, client]) => !!client.getServerCapabilities()?.resources)
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b))
      const permissionKeyCounts = new Map<string, number>()
      for (const entry of exactMcp) {
        const permissionKey = McpCatalog.toolName(entry.server, entry.def.name)
        permissionKeyCounts.set(permissionKey, (permissionKeyCounts.get(permissionKey) ?? 0) + 1)
      }

      const mcpEntries: Capability.Registration[] = (dreamer ? [] : exactMcp).map((entry) => {
        const permissionKey = McpCatalog.toolName(entry.server, entry.def.name)
        const collision = (permissionKeyCounts.get(permissionKey) ?? 0) > 1
        const inputSchema = ToolJsonSchema.fromJsonSchema({
          ...(entry.def.inputSchema as JSONSchema7),
          type: "object",
          properties: (entry.def.inputSchema.properties ?? {}) as JSONSchema7["properties"],
          additionalProperties: false,
        })
        const outputSchema = entry.def.outputSchema
          ? ToolJsonSchema.fromJsonSchema(entry.def.outputSchema as JSONSchema7)
          : undefined
        const identity = Capability.mcpIdentity(entry.server, entry.def.name)

        return {
          identity,
          kind: "mcp",
          description: entry.def.description ?? "",
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          permissionKey,
          invokeSemantic: (args, ctx) =>
            Effect.gen(function* () {
              yield* ctx.ask({
                permission: permissionKey,
                metadata: { server: entry.server, tool: entry.def.name },
                patterns: ["*"],
                always: ["*"],
              })
              const result = yield* mcp.invokeTool({
                server: entry.server,
                tool: entry.def.name,
                args,
                signal: ctx.abort,
              })
              const projected = McpCatalog.projectToolResult(result)
              return {
                title: "",
                metadata: projected.metadata,
                output: projected.output,
                ...(projected.data === undefined ? {} : { data: projected.data }),
                ...(projected.attachments ? { attachments: projected.attachments } : {}),
              }
            }),
          authorize: ({ authority }) => {
            const policy = Permission.evaluate(permissionKey, "*", authority.ruleset)
            return policy.action === "deny"
              ? Effect.fail(new PermissionV1.DeniedError({ ruleset: [policy] }))
              : Effect.void
          },
          authorityBinding: `mcp:${Capability.encodeSegment(entry.server)}`,
          classifyWorkspaceMutation: () => true,
          codeCallable: !collision,
          lifetime: "inline",
          ...(collision
            ? {
                diagnostic: {
                  kind: "AmbiguousPermissionIdentity",
                  message: `MCP capability ${identity.ref} collides on legacy permission key ${permissionKey}`,
                },
              }
            : {}),
        } satisfies Capability.Registration
      })

      const resourceEntries: Capability.Registration[] =
        dreamer || resourceServers.length === 0
          ? []
          : McpResourceTools.definitions.map((definition) => ({
              identity: Capability.mcpResourceIdentity(definition.id),
              kind: "mcp-resource",
              description: definition.description,
              inputSchema: definition.inputSchema,
              permissionKey: "read",
              invokeSemantic: (args, ctx) => definition.invoke(mcp, args, ctx),
              authorize: ({ authority, args }) =>
                McpResourceTools.authorize(mcp, definition.id, args, authority.ruleset),
              authorityBinding: `mcp-resource:${resourceServers
                .map((server) => Capability.encodeSegment(server))
                .join(",")}`,
              classifyWorkspaceMutation: () => false,
              codeCallable: true,
              lifetime: "inline",
            }))

      const baseEntries = [...nativeEntries, ...mcpEntries, ...resourceEntries]
      let savedItems: readonly SavedCodeCatalog.LoadedRevision[] = []
      let savedContext: SavedCodeCatalog.ScopeContext | undefined
      if (!dreamer && input.sessionID) {
        const physical = yield* session
          .physicalScope(input.sessionID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (physical) {
          savedContext = {
            project: {
              root: physical.root,
              key: physical.key,
            },
          }
          savedItems = yield* savedCatalog
            .list(savedContext)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  `Saved Code catalog discovery failed closed: ${cause instanceof Error ? cause.message : String(cause)}`,
                ).pipe(Effect.as([] as readonly SavedCodeCatalog.LoadedRevision[])),
              ),
            )
        }
      }
      const savedEntries = SavedCapability.registrations(
        savedItems,
        baseEntries,
        savedContext
          ? { resolveExact: (selector) => savedCatalog.resolve(savedContext!, selector) }
          : {},
      )
      const entries = [...baseEntries, ...savedEntries]
      const refs = new Set<string>()
      for (const entry of entries) {
        if (refs.has(entry.identity.ref)) {
          return yield* Effect.die(new Error(`Duplicate capability ref: ${entry.identity.ref}`))
        }
        refs.add(entry.identity.ref)
      }

      return {
        generation: `registry:${current.generation}:${input.providerID}:${input.modelID}:mcp:${fingerprint([...exactMcp.flatMap((entry) => [entry.server, entry.def.name, entry.def.description ?? "", JSON.stringify(entry.def.inputSchema), JSON.stringify(entry.def.outputSchema ?? null)]), ...resourceServers.map((server) => `resource:${server}`)])}:saved:${fingerprint(savedItems.flatMap((item) => [item.handle, item.manifest?.descriptorFingerprint ?? "", item.admitted ? "1" : "0", item.diagnostic?.kind ?? "", item.diagnostic?.message ?? ""]))}`,
        searchGeneration: searchGeneration(entries),
        entries: Object.freeze(entries),
        byRef: new Map(entries.map((entry) => [entry.identity.ref, entry] as const)),
      } satisfies Capability.Inventory
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
      const current = yield* readState()
      const candidates = selectModelTools([...current.builtin, ...current.custom], input, false)
        .filter((tool) => input.agent.name !== "dreamer" || dreamerAllows(tool.id))
      // IMPORTANT: do not filter provider-visible tools by session permission here.
      // The tool prefix is cache-sensitive. A local/session policy such as
      // `swarm_* = deny` must not mutate the manifest and destroy prompt-cache
      // reuse. Instead, keep the schema stable and enforce explicit denies in the
      // returned execute closure before the underlying tool can run.
      const filtered = candidates

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          // Composite provider tools defer action-specific authorization to
          // their delegated leaf tools. This preserves legacy rules such as
          // `*=deny, grep=allow, glob=allow` after the provider-facing merge.
          const policy = providerPolicy(tool.id, ruleset)
          const shaped = yield* shapeDefinition(tool, input)
          return {
            id: tool.id,
            description: shaped.description,
            parameters: shaped.parameters,
            jsonSchema: shaped.jsonSchema,
            execute:
              policy.action === "deny"
                ? () => Effect.die(new PermissionV1.DeniedError({ ruleset: [policy] }))
                : tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: 8 },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* readState()
      return { read: s.read }
    })

    return Service.of({ ids, all, named, tools, capabilities, refreshCustom })
  }),
)

// Concrete fallback node for the canonical location map. Node identity is the
// service key, so the server's canonical map replaces this by name at the app
// boundary (see server.ts). Tests that compile this node directly still get a
// working (lazily-built) map.
const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Config.node,
    Plugin.node,
    Question.node,
    Todo.node,
    Agent.node,
    Skill.node,
    Session.node,
    SessionStatus.node,
    Project.node,
    BackgroundJob.node,
    ShellJobs.node,
    MonitorDelivery.node,
    SessionIngress.node,
    ShellJob.node,
    Provider.node,
    Permission.node,
    LSP.node,
    Instruction.node,
    FSUtil.node,
    EventV2Bridge.node,
    httpClient,
    CrossSpawnSpawner.node,
    AppProcess.node,
    Format.node,
    Truncate.node,
    RuntimeFlags.node,
    // CodeTool executes through the shared invocation gateway and acquires
    // ToolInterrupt while ToolRegistry is being built. LayerNode dependencies
    // are locally scoped, so the process-level group registration is not enough.
    ToolInterrupt.node,
    MCP.node,
    Database.node,
    Quota.node,
    Usage.node,
    ModelsDev.node,
    Checkpoint.readNode,
    Snapshot.node,
    TurnCheckpoint.node,
    Git.node,
    GoalAgent.node,
    ScheduledTaskAgent.node,
    SwarmV2.node,
    SwarmMemberSessionWake.node,
    SwarmProfilePreflight.node,
    SwarmContainment.node,
    Ripgrep.node,
    Symbols.node,
    RipgrepBinary.node,
    BrokerClient.node,
    OfxpRuntime.node,
    Memory.node,
    SavedCodeCatalog.node,
    locationServiceMapNode,
  ],
})

export { buildCustomTools, fromPlugin, isPluginTool } from "./custom"

export * as ToolRegistry from "./registry"
