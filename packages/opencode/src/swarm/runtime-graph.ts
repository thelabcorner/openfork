/**
 * One authoritative process-global Swarm execution graph.
 *
 * The HTTP sidecar and direct AppRuntime are independently composed hosts.
 * Both MUST install the durable member-session reconciler, dispatcher and
 * deadline owner, not merely the Swarm database/API and recovery wake service.
 *
 * Keep this list shared: a writable active Swarm without its runtime owners
 * silently strands managed workers at bindingGeneration=0 indefinitely.
 *
 * Every node is a process-global memoized node; importing the group into both
 * hosts reuses one installed set of listeners/owners per process.
 */
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SwarmMemberSession } from "./member-session"
import { SwarmMemberSessionRunner } from "./member-session-runner"
import { SwarmMemberSessionWake } from "./member-session-wake"
import { SwarmProfilePreflight } from "./profile-preflight"
import { SwarmSessionAdmission } from "./session-admission"
import { SwarmRuntimeRetention } from "./runtime-retention"
import { SwarmTaskExecutor } from "./task-executor"
import { SwarmMailExecutor } from "./mail-executor"
import { SwarmDispatcher } from "./dispatcher"
import { SwarmTaskRetirement } from "./task-retirement"
import { SwarmTaskClosure } from "./task-closure"
import { SwarmContainment } from "./containment"
import { SwarmRecovery } from "./recovery"
import { SwarmDeadlineOwner } from "./deadline-owner"

export const nodes = [
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
  SwarmContainment.node,
  SwarmRecovery.node,
  SwarmDeadlineOwner.node,
] as const

// A nested group compiles to the same flattened services, without expanding
// fifteen heavyweight node types into every host's already-large tuple.
export const node = LayerNode.group(nodes)

export * as SwarmRuntimeGraph from "./runtime-graph"