import { describe, expect, test } from "bun:test"
import { projectSessionActivity } from "./session-activity-proof"

const core = (...ids: string[]) => new Set(ids)
const owner = (...items: Array<[string, "busy" | "interrupted"]>) =>
  new Map(items.map(([id, type]) => [id, { type }]))

describe("session activity proof projection", () => {
  test("never promotes an unverified durable owner into a running spinner", () => {
    expect(projectSessionActivity(core(), owner(["orphan", "interrupted"]), core()))
      .toEqual({ orphan: { type: "interrupted" } })
  })

  test("requires exact live Core coordinator or V1 activation to claim running", () => {
    expect(projectSessionActivity(core("core-worker"), owner(
      ["v1-main", "busy"],
      ["child-crashed", "interrupted"],
    ), core())).toEqual({
      "core-worker": { type: "running" },
      "v1-main": { type: "running" },
      "child-crashed": { type: "interrupted" },
    })
  })

  test("retired telemetry with no owner or coordinator cannot restore false activity", () => {
    expect(projectSessionActivity(core(), owner(), core())).toEqual({})
  })

  test("one cancelled swarm member cannot falsely cancel or activate its siblings", () => {
    const result = projectSessionActivity(core("swarm-a"), owner(
      ["swarm-b", "interrupted"],
      ["special-auditor", "busy"],
    ), core())
    expect(result["swarm-a"]).toEqual({ type: "running" })
    expect(result["swarm-b"]).toEqual({ type: "interrupted" })
    expect(result["special-auditor"]).toEqual({ type: "running" })
  })

  test("durable explicit Pause wins during a generation transition", () => {
    expect(projectSessionActivity(core("s"), owner(["s", "busy"]), core("s")))
      .toEqual({ s: { type: "paused" } })
  })
})
