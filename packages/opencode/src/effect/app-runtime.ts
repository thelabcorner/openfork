import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@opencode-ai/core/observability"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Auth } from "@/auth"
import { ForkCredentials } from "@/fork/credentials"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionGroup } from "@/session/group"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { SubagentSupervision } from "@/session/subagent-supervision"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ToolInterrupt } from "@/tool/interrupt"
import { ToolReload } from "@/tool/reload"
import { Format } from "@/format"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@opencode-ai/core/npm"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "./app-node-builder-v1"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { DirectoryActivityFence } from "@opencode-ai/core/directory-activity-fence"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { filesystem, requestExecutor } from "@opencode-ai/core/effect/app-node-platform"
import { Goal } from "@opencode-ai/core/goal"
import { Memory } from "@opencode-ai/core/memory"
import { GoalContext } from "@opencode-ai/core/goal/context"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { GoalAgent } from "@opencode-ai/core/goal/agent"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskAgent } from "@opencode-ai/core/scheduled-task/agent"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { ScheduledTaskLease } from "@opencode-ai/core/scheduled-task/lease"
import { ScheduledTaskExecutor } from "@/scheduled-task/executor"
import { ScheduledTaskRunner } from "@/scheduled-task/runner"
import { SwarmMemberSession } from "@/swarm/member-session"
import { SwarmMemberSessionRunner } from "@/swarm/member-session-runner"
import { SwarmMemberSessionWake } from "@/swarm/member-session-wake"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import { SwarmSessionAdmission } from "@/swarm/session-admission"
import { SwarmRuntimeRetention } from "@/swarm/runtime-retention"
import { SwarmTaskExecutor } from "@/swarm/task-executor"
import { SwarmMailExecutor } from "@/swarm/mail-executor"
import { SwarmDispatcher } from "@/swarm/dispatcher"
import { SwarmTaskRetirement } from "@/swarm/task-retirement"
import { SwarmTaskClosure } from "@/swarm/task-closure"
import { SwarmRecovery } from "@/swarm/recovery"
import { SwarmDeadlineOwner } from "@/swarm/deadline-owner"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SystemOne } from "@/system-one/system-one"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { WakaTimeSessionFlush } from "@/wakatime/session-flush"

export const AppLayer = AppNodeBuilderV1.build(
  LayerNode.group([
    filesystem,
    requestExecutor,
    CrossSpawnSpawner.node,
    Npm.node,
    FSUtil.node,
    Database.node,
    // OFXP trust is a global runtime dependency, not merely a transitive tool
    // implementation detail. Keep it explicit at the AppRuntime boundary so
    // SessionPrompt/ToolRegistry initialization can never observe a partially
    // composed graph and fail with "Service not found: @opencode/core/OfxpPeer".
    OfxpPeer.node,
    Memory.node,
    Goal.node,
    GoalContext.node,
    GoalAutomation.node,
    GoalAgent.node,
    ScheduledTask.node,
    ScheduledTaskSessionBinding.node,
    ScheduledTaskAgent.node,
    ScheduledTaskLease.node,
    ScheduledTaskExecutor.node,
    ScheduledTaskRunner.node,
    SwarmV2.node,
    SwarmMemberSessionWake.node,
    SwarmMemberSession.node,
    SwarmProfilePreflight.node,
    SwarmMemberSessionRunner.node,
    SwarmSessionAdmission.node,
    SwarmRuntimeRetention.node,
    SwarmTaskExecutor.node,
    SwarmMailExecutor.node,
    SwarmDispatcher.node,
    SwarmTaskRetirement.node,
    SwarmTaskClosure.node,
    SwarmRecovery.node,
    SwarmDeadlineOwner.node,
    Auth.node,
    ForkCredentials.node,
    Account.node,
    Config.node,
    Git.node,
    Storage.node,
    Snapshot.node,
    Plugin.node,
    ModelsDev.node,
    Provider.node,
    SystemOne.node,
    ProviderAuth.node,
    Agent.node,
    Skill.node,
    Discovery.node,
    Question.node,
    Permission.node,
    Todo.node,
    Session.node,
    // OXP's lazy V1 Session-control adapter consumes the core V2 Session
    // service directly for attributed agent/model switching. Session.node
    // depends on it transitively, but LayerNode dependencies are provisioned
    // without being exported from AppRuntime, so keep SessionV2 explicit.
    SessionV2.node,
    // OXP delegated batches consume SessionGroup directly. A LayerNode dependency
    // of Session.node is provisioned transitively but is not exported from the
    // compiled AppRuntime, so keep SessionGroup explicit at this boundary.
    SessionGroup.node,
    SessionProjector.node,
    // Session execution ownership is consumed by the V1 prompt/delegation
    // runtime through Effect services rather than a standalone app node.
    // Keep it explicit at the AppRuntime boundary so lazy OXP worker/session
    // entry can never observe a partially composed instance graph.
    SessionExecutionOwner.node,
    // Worktree fence authority must share SessionExecutionOwner's Database and
    // RuntimeOwner identity: guard admission and execution admission race for
    // the same SQLite writer reservation and must never observe split owner
    // rows or a split heartbeat.
    DirectoryMaintenanceGuard.node,
    DirectoryActivityFence.node,
    SessionStatus.node,
    // Task supervision consumes this capability via serviceOption. Keep it
    // explicit at the AppRuntime boundary so production resolves the registry
    // instead of silently degrading to durable-metadata-only supervision.
    SubagentSupervision.node,
    BackgroundJob.node,
    RuntimeFlags.node,
    EventV2Bridge.node,
    SessionRunState.node,
    SessionProcessor.node,
    SessionCompaction.node,
    SessionRevert.node,
    SessionSummary.node,
    SessionPrompt.node,
    Instruction.node,
    LLM.node,
    LSP.node,
    MCP.node,
    McpAuth.node,
    Command.node,
    Truncate.node,
    ToolRegistry.node,
    ToolInterrupt.node,
    ToolReload.node,
    Format.node,
    InstanceStore.node,
    Project.node,
    Vcs.node,
    Workspace.node,
    Worktree.node,
    Installation.node,
    ShareNext.node,
    SessionShare.node,
    // Browser host broker: needed by the session-delete orphan path (CLI +
    // httpapi) and transitively by the browser tools via BrokerClient.
    BrowserHostBroker.node,
    // Tier-0 process-global WakaTime exporter. Direct AppRuntime execution
    // (CLI commands, TUI worker, delegated/remote agents) never builds the
    // httpapi served graph, so the exporter has to be reachable here too or
    // those processes would produce CodingActivity with no consumer.
    //
    // Core's node is a process singleton, so registering it in both this graph
    // and the served graph cannot create a second CodingActivity subscriber.
    WakaTime.node,
    // Tier-0 process-global settlement flush: the single `session.idle`
    // subscriber that asks Core to deliver one session's queued time once
    // durable execution ownership is released. It depends only on the
    // process-global EventV2 bus and the Core exporter, never on a directory,
    // so it belongs beside the exporter in the direct graph for the same
    // reason: direct AppRuntime execution never builds the served graph.
    //
    // Registering it here and in the served graph installs exactly one Idle
    // listener. The adapter is a standard `makeGlobalNode` whose scoped
    // acquireRelease owns the one `EventV2.listenType` subscription, and both
    // graphs build it through the shared process-wide `memoMap`, so the second
    // graph reuses the live layer instead of installing a second listener and
    // the first graph to close releases only its own lease. Its Idle callback
    // calls `WakaTime.requestFlushSession` — Core's O(1) scheduler request, not
    // a delivery — because EventV2 runs that callback inline on the publish
    // path and settlement must never wait on CLI or network work.
    WakaTimeSessionFlush.node,
  ]),
  [[SessionExecution.node, SessionExecutionLocal.node]],
).pipe(Layer.provideMerge(AppNodeBuilderV1.build(Ripgrep.node)), Layer.provideMerge(Observability.layer))

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
