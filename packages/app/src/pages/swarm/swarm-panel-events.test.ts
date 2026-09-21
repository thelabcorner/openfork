import { describe, expect, test } from "bun:test"
import { swarmPanelEventInvalidations } from "./swarm-panel-events"

describe("swarmPanelEventInvalidations", () => {
  test("routes high-frequency events only to projections that can change", () => {
    expect([...swarmPanelEventInvalidations("swarm.member.updated")]).toEqual(["core"])
    expect([...swarmPanelEventInvalidations("swarm.blackboard.updated")]).toEqual(["memory"])
    expect([...swarmPanelEventInvalidations("swarm.message.created")]).toEqual(["core", "history"])
    expect([...swarmPanelEventInvalidations("swarm.task.run.updated")]).toEqual(["core", "history"])
    expect([...swarmPanelEventInvalidations("session.telemetry.updated")]).toEqual([])
  })

  test("does not refetch lazy memory/history surfaces for unrelated Swarm churn", () => {
    for (const type of [
      "swarm.task.updated",
      "swarm.task.dependencies.updated",
      "swarm.task.lease.updated",
      "swarm.member.updated",
    ]) {
      const invalidations = swarmPanelEventInvalidations(type)
      expect(invalidations.has("core")).toBe(true)
      expect(invalidations.has("memory")).toBe(false)
      expect(invalidations.has("history")).toBe(false)
    }
  })
})
