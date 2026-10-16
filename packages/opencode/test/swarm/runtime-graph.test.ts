import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { SwarmV2 } from "@opencode-ai/core/swarm"
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
import { SwarmContainment } from "@/swarm/containment"
import { SwarmRecovery } from "@/swarm/recovery"
import { SwarmDeadlineOwner } from "@/swarm/deadline-owner"
import { SwarmRuntimeGraph } from "@/swarm/runtime-graph"

describe("Swarm runtime graph: every host must execute workers", () => {
  const required = [
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
  ]

  test("owns every worker lifecycle service once, including reconciliation and dispatch", () => {
    expect([...SwarmRuntimeGraph.nodes]).toEqual([...required])
    expect(new Set(SwarmRuntimeGraph.nodes.map((node) => node.name)).size).toBe(required.length)
    expect(SwarmRuntimeGraph.node.kind).toBe("group")
    expect(SwarmRuntimeGraph.node.dependencies).toEqual(required)
    for (const node of required) {
      expect(node.kind).toBe("layer")
      expect(node.implementation).toBeDefined()
    }
  })

  test("cannot silently regress to an API-only host or a dispatch-only host", () => {
    const direct = readFileSync(new URL("../../src/effect/app-runtime.ts", import.meta.url), "utf8")
    const served = readFileSync(new URL("../../src/server/routes/instance/httpapi/server.ts", import.meta.url), "utf8")

    for (const [name, source] of [["direct AppRuntime", direct], ["HTTP sidecar", served]] as const) {
      expect(source, name + " must compose the shared worker runtime").toContain("SwarmRuntimeGraph.node,")
      expect(source, name + " must import the shared runtime owner").toContain(
        'import { SwarmRuntimeGraph } from "@/swarm/runtime-graph"',
      )
    }
  })
})
