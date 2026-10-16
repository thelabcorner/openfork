import { describe, expect, test } from "bun:test"
import { Agent as AgentContract } from "@opencode-ai/schema/agent"
import { isHostOwnedSpecialAgent, requiresAccountBackedHostedRoute } from "@/special-agent/hosted-route-policy"

describe("hosted route guard uses canonical special-agent identity", () => {
  test("every canonical built-in special agent is protected", () => {
    for (const builtin of AgentContract.SpecialBuiltInTopology) {
      expect(isHostOwnedSpecialAgent(builtin.id)).toBe(true)
    }
  })

  test("request-local special agents are protected", () => {
    for (const name of ["goal-auditor", "goal-revisor", "spad-auditor", "project-copy-name"]) {
      expect(isHostOwnedSpecialAgent(name)).toBe(true)
    }
  })

  test("ordinary interactive agents remain eligible for user-owned routing", () => {
    for (const name of ["build", "plan", "yolo", "general", "explore", "swarm-m", "swarm-c"]) {
      expect(isHostOwnedSpecialAgent(name)).toBe(false)
    }
  })

  test("detached special-agent Session identity restricts hosted Public even with an ordinary turn agent", () => {
    expect(requiresAccountBackedHostedRoute({ hostedProvider: true, agent: "build", sessionAgent: "dreamer" })).toBe(true)
    expect(requiresAccountBackedHostedRoute({ hostedProvider: true, agent: "build", sessionAgent: "summary" })).toBe(true)
    expect(requiresAccountBackedHostedRoute({ hostedProvider: true, agent: "goal-auditor" })).toBe(true)
    expect(requiresAccountBackedHostedRoute({ hostedProvider: true, agent: "build", sessionAgent: "build" })).toBe(false)
    expect(requiresAccountBackedHostedRoute({ hostedProvider: false, agent: "dreamer" })).toBe(false)
  })
})