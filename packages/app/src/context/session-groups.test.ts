import { describe, expect, test } from "bun:test"
import { eventInvalidatesSessionGroupNavigation } from "./session-groups"

describe("SessionGroup virtual Swarm invalidation", () => {
  test("refreshes navigation only for Swarm events that can change virtual group identity or membership", () => {
    for (const type of ["swarm.created", "swarm.updated", "swarm.member.updated"]) {
      expect(eventInvalidatesSessionGroupNavigation(type)).toBe(true)
    }
    for (const type of [
      "swarm.task.updated",
      "swarm.task.dependencies.updated",
      "swarm.task.run.updated",
      "swarm.message.created",
      "swarm.delivery.updated",
      "swarm.blackboard.updated",
      "swarm.claim.updated",
      "swarm.deliverable.updated",
      "session.updated",
    ]) {
      expect(eventInvalidatesSessionGroupNavigation(type)).toBe(false)
    }
  })
})
