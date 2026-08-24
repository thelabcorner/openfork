import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { Database } from "@opencode-ai/core/database/database"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { ArchiveTool } from "./archive"
import { JsonTool } from "./json"
import { BackgroundTool } from "./background"
import { SqliteTool } from "./sqlite"
import { GitTool } from "./git"
import { CheckpointTool } from "./checkpoint"
import { TurnCheckpoint } from "@/session/checkpoint"
import { Snapshot } from "@/snapshot"
import { TypecheckTool } from "./typecheck"
import { ProjectTool } from "./project"
import { SymbolsTool } from "./symbols"
import { TestTool } from "./test"
import { RefactorTool } from "./refactor"
import { SympyTool } from "./sympy"
import * as Tool from "./tool"
import { buildCustomTools } from "./custom"
import { Config } from "@/config/config"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { WebSearchTool } from "./websearch"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { PatchTool } from "./patch"
import { BrowserStatusTool } from "./browser/status"
import { BrowserOpenTool } from "./browser/open"
import { BrowserClaimTool } from "./browser/claim"
import { BrowserNavigateTool } from "./browser/navigate"
import { BrowserResizeTool } from "./browser/resize"
import { BrowserSetAppearanceTool } from "./browser/set-appearance"
import { BrowserSnapshotTool } from "./browser/snapshot"
import { BrowserScreenshotTool } from "./browser/screenshot"
import { BrowserClickTool } from "./browser/click"
import { BrowserTypeTool } from "./browser/type"
import { BrowserPressTool } from "./browser/press"
import { BrowserScrollTool } from "./browser/scroll"
import { BrowserEvaluateTool } from "./browser/evaluate"
import { BrowserWaitForTool } from "./browser/wait-for"
import { BrowserRecordingStartTool } from "./browser/recording-start"
import { BrowserRecordingStopTool } from "./browser/recording-stop"
import { BrowserCloseTool } from "./browser/close"
import { BrowserQueryTool } from "./browser/query"
import { BrowserHighlightTool } from "./browser/highlight"
import { BrowserAnnotateTool } from "./browser/annotate"
import { BrowserProfilerStartTool } from "./browser/profiler-start"
import { BrowserProfilerStopTool } from "./browser/profiler-stop"
import { BrowserReactInspectTool } from "./browser/react-inspect"
import { BrowserOpenDevtoolsTool } from "./browser/open-devtools"
import { BrowserExtensionsListTool } from "./browser/extensions-list"
import { BrokerClient } from "@/browser/broker-client"
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
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { McpCatalog } from "@/mcp/catalog"

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

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
  }) => Effect.Effect<Tool.Def[]>
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
    const agent = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const mcp = yield* MCP.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const archivetool = yield* ArchiveTool
    const jsontool = yield* JsonTool
    const backgroundtool = yield* BackgroundTool
    const sqlitetool = yield* SqliteTool
    const gittool = yield* GitTool
    const checkpointtool = yield* CheckpointTool
    const typechecktool = yield* TypecheckTool
    const projecttool = yield* ProjectTool
    const symbolstool = yield* SymbolsTool
    const testtool = yield* TestTool
    const refactortool = yield* RefactorTool
    const sympytool = yield* SympyTool
    const patchTool = yield* PatchTool
    const browserStatus = yield* BrowserStatusTool
    const browserOpen = yield* BrowserOpenTool
    const browserClaim = yield* BrowserClaimTool
    const browserNavigate = yield* BrowserNavigateTool
    const browserResize = yield* BrowserResizeTool
    const browserSetAppearance = yield* BrowserSetAppearanceTool
    const browserSnapshot = yield* BrowserSnapshotTool
    const browserScreenshot = yield* BrowserScreenshotTool
    const browserClick = yield* BrowserClickTool
    const browserType = yield* BrowserTypeTool
    const browserPress = yield* BrowserPressTool
    const browserScroll = yield* BrowserScrollTool
    const browserEvaluate = yield* BrowserEvaluateTool
    const browserWaitFor = yield* BrowserWaitForTool
    const browserRecordingStart = yield* BrowserRecordingStartTool
    const browserRecordingStop = yield* BrowserRecordingStopTool
    const browserClose = yield* BrowserCloseTool
    const browserQuery = yield* BrowserQueryTool
    const browserHighlight = yield* BrowserHighlightTool
    const browserAnnotate = yield* BrowserAnnotateTool
    const browserProfilerStart = yield* BrowserProfilerStartTool
    const browserProfilerStop = yield* BrowserProfilerStopTool
    const browserReactInspect = yield* BrowserReactInspectTool
    const browserOpenDevtools = yield* BrowserOpenDevtoolsTool
    const browserExtensionsList = yield* BrowserExtensionsListTool
    const codeMode = flags.experimentalCodeMode ? yield* Effect.promise(() => import("./code-mode")) : undefined
    const codeModeTool = codeMode ? yield* codeMode.CodeModeTool : undefined

    const state = yield* InstanceState.make<Ref.Ref<State>>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const dirs = yield* config.directories()
        const plugins = yield* plugin.list()
        const custom = yield* buildCustomTools(dirs, plugins, {
          agent,
          truncate,
          directory: ctx.directory,
          worktree: ctx.worktree,
          waitForDependencies: config.waitForDependencies,
        })

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          archive: Tool.init(archivetool),
          json: Tool.init(jsontool),
          background: Tool.init(backgroundtool),
          sqlite: Tool.init(sqlitetool),
          git: Tool.init(gittool),
          checkpoint: Tool.init(checkpointtool),
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
          browserStatus: Tool.init(browserStatus),
          browserOpen: Tool.init(browserOpen),
          browserClaim: Tool.init(browserClaim),
          browserNavigate: Tool.init(browserNavigate),
          browserResize: Tool.init(browserResize),
          browserSetAppearance: Tool.init(browserSetAppearance),
          browserSnapshot: Tool.init(browserSnapshot),
          browserScreenshot: Tool.init(browserScreenshot),
          browserClick: Tool.init(browserClick),
          browserType: Tool.init(browserType),
          browserPress: Tool.init(browserPress),
          browserScroll: Tool.init(browserScroll),
          browserEvaluate: Tool.init(browserEvaluate),
          browserWaitFor: Tool.init(browserWaitFor),
          browserRecordingStart: Tool.init(browserRecordingStart),
          browserRecordingStop: Tool.init(browserRecordingStop),
          browserClose: Tool.init(browserClose),
          browserQuery: Tool.init(browserQuery),
          browserHighlight: Tool.init(browserHighlight),
          browserAnnotate: Tool.init(browserAnnotate),
          browserProfilerStart: Tool.init(browserProfilerStart),
          browserProfilerStop: Tool.init(browserProfilerStop),
          browserReactInspect: Tool.init(browserReactInspect),
          browserOpenDevtools: Tool.init(browserOpenDevtools),
          browserExtensionsList: Tool.init(browserExtensionsList),
          ...(codeModeTool ? { execute: Tool.init(codeModeTool) } : {}),
        })

        return yield* Ref.make<State>({
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.fetch,
            tool.todo,
            tool.search,
            tool.skill,
            tool.archive,
            tool.json,
            tool.background,
            tool.sqlite,
            tool.git,
            tool.typecheck,
            tool.project,
            tool.symbols,
            tool.test,
            tool.refactor,
            tool.sympy,
            tool.patchTool,
            tool.patch,
            tool.browserStatus,
            tool.browserOpen,
            tool.browserClaim,
            tool.browserNavigate,
            tool.browserResize,
            tool.browserSetAppearance,
            tool.browserSnapshot,
            tool.browserScreenshot,
            tool.browserClick,
            tool.browserType,
            tool.browserPress,
            tool.browserScroll,
            tool.browserEvaluate,
            tool.browserWaitFor,
            tool.browserRecordingStart,
            tool.browserRecordingStop,
            tool.browserClose,
            tool.browserQuery,
            tool.browserHighlight,
            tool.browserAnnotate,
            tool.browserProfilerStart,
            tool.browserProfilerStop,
            tool.browserReactInspect,
            tool.browserOpenDevtools,
            tool.browserExtensionsList,
            ...(tool.execute ? [tool.execute] : []),
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
          ],
          task: tool.task,
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
      const stateRef = yield* InstanceState.get(state)
      const current = yield* Ref.get(stateRef)
      // Invariant: in-flight execute closures were captured at build time (the
      // ai-sdk tool() wraps the def at resolve), so this swap affects only the
      // NEXT resolve — a running tool call keeps the def it started with.
      yield* Ref.set(stateRef, { ...current, custom })
      const currentIds = new Set(current.custom.map((tool) => tool.id))
      const nextIds = new Set(custom.map((tool) => tool.id))
      return {
        added: custom.filter((tool) => !currentIds.has(tool.id)).map((tool) => tool.id),
        updated: custom.filter((tool) => currentIds.has(tool.id)).map((tool) => tool.id),
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

    const describeCodeMode = Effect.fn("ToolRegistry.describeCodeMode")(function* (input: {
      agent: Agent.Info
      permission?: PermissionV1.Ruleset
    }) {
      if (!codeMode) return
      const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
      const tools = Permission.visibleTools(yield* mcp.tools(), ruleset)
      if (Object.keys(tools).length === 0) return
      return codeMode.describeCatalog(tools, Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize))
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const filtered = (yield* all()).filter((tool) => {
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled(input.providerID, {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
            firecrawl: flags.enableFirecrawl,
            duckduckgo: flags.enableDuckDuckGo,
            brave: flags.enableBrave,
            tavily: flags.enableTavily,
            searxng: flags.enableSearxng,
          })
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      const codeModeDescription = filtered.some((tool) => tool.id === "execute")
        ? yield* describeCodeMode(input)
        : undefined
      const visible = filtered.filter((tool) => tool.id !== "execute" || codeModeDescription)

      return yield* Effect.forEach(
        visible,
        Effect.fnUntraced(function* (tool: Tool.Def) {
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
            id: tool.id,
            description: [
              output.description,
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === "execute" ? codeModeDescription : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* readState()
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools, refreshCustom })
  }),
)

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
    BackgroundJob.node,
    ShellJobs.node,
    Provider.node,
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
    MCP.node,
    Database.node,
    Snapshot.node,
    TurnCheckpoint.node,
    Ripgrep.node,
    RipgrepBinary.node,
    BrokerClient.node,
  ],
})

export { buildCustomTools, fromPlugin, isPluginTool } from "./custom"

export * as ToolRegistry from "./registry"
