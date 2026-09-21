import { describe, expect, test } from "bun:test"
import {
  loadSwarmPanelCore,
  loadSwarmPanelHistory,
  loadSwarmPanelMemory,
  loadSwarmPanelBlackboardPage,
  loadSwarmPanelClaimPage,
  loadSwarmPanelDeliverablePage,
  loadSwarmPanelMessagePage,
  loadSwarmPanelRunPage,
  indexSwarmPanelDetail,
  type SwarmPanelApi,
} from "./swarm-panel-data"

function api(calls: string[]) {
  const page = { items: [], more: false }
  return {
    detail: async () => {
      calls.push("detail")
      return { data: { swarm: { id: "swr_1" }, members: [], tasks: [], dependencies: [] } }
    },
    summary: async () => {
      calls.push("summary")
      return { data: { swarm: { id: "swr_1" }, memberCount: 0, boundMemberCount: 0, readyTaskCount: 0, workingTaskCount: 0, pendingDeliveryCount: 0 } }
    },
    blackboard: async () => {
      calls.push("blackboard")
      return { data: page }
    },
    claims: async () => {
      calls.push("claims")
      return { data: page }
    },
    deliverables: async () => {
      calls.push("deliverables")
      return { data: page }
    },
    messages: async () => {
      calls.push("messages")
      return { data: page }
    },
    runs: async () => {
      calls.push("runs")
      return { data: page }
    },
  } as unknown as SwarmPanelApi
}

describe("Swarm panel projection loaders", () => {
  test("core mount reads only compact Swarm detail and summary projections", async () => {
    const calls: string[] = []
    await loadSwarmPanelCore(api(calls), "swr_1")
    expect(calls).toEqual(["detail", "summary"])
  })

  test("shared state and history remain explicit lazy surfaces", async () => {
    const calls: string[] = []
    const client = api(calls)
    await loadSwarmPanelMemory(client, { swarmID: "swr_1" })
    expect(calls).toEqual(["blackboard", "claims", "deliverables"])
    calls.length = 0
    await loadSwarmPanelHistory(client, { swarmID: "swr_1" })
    expect(calls).toEqual(["messages", "runs"])
  })

  test("continuation pages address only the ledger being extended", async () => {
    const calls: string[] = []
    const client = api(calls)
    await loadSwarmPanelBlackboardPage(client, "swr_1", "b")
    expect(calls).toEqual(["blackboard"])
    calls.length = 0
    await loadSwarmPanelClaimPage(client, "swr_1", "c")
    expect(calls).toEqual(["claims"])
    calls.length = 0
    await loadSwarmPanelDeliverablePage(client, "swr_1", "d")
    expect(calls).toEqual(["deliverables"])
    calls.length = 0
    await loadSwarmPanelMessagePage(client, "swr_1", "m")
    expect(calls).toEqual(["messages"])
    calls.length = 0
    await loadSwarmPanelRunPage(client, "swr_1", "r")
    expect(calls).toEqual(["runs"])
  })

  test("the panel data contract cannot address Session transcript APIs", () => {
    const calls: string[] = []
    const client = api(calls)
    expect("session" in client).toBe(false)
    expect("prefetch" in client).toBe(false)
    expect("messages" in client).toBe(true)
  })

  test("indexes dense roster/task/DAG projections in one pass instead of filtering edges per task", () => {
    const members = Array.from({ length: 2_000 }, (_, index) => ({ id: "member_" + index }))
    const tasks = Array.from({ length: 5_000 }, (_, index) => ({ id: "task_" + index }))
    const dependencies = Array.from({ length: 10_000 }, (_, index) => ({
      taskID: "task_" + (index % tasks.length),
      dependsOnTaskID: "task_" + ((index + 1) % tasks.length),
      requirement: "require_success",
    }))
    const indexed = indexSwarmPanelDetail({
      swarm: { id: "swr_dense" },
      members,
      tasks,
      dependencies,
    } as never)
    expect(indexed.memberByID.size).toBe(2_000)
    expect(indexed.taskByID.size).toBe(5_000)
    expect([...indexed.dependenciesByTaskID.values()].reduce((sum, bucket) => sum + bucket.length, 0)).toBe(10_000)
    expect(indexed.dependenciesByTaskID.get("task_0")?.length).toBe(2)
  })
})
