import { describe, expect, test } from "bun:test"
import {
  lazyToolCatalog,
  lazyToolDescriptor,
  lazyToolIdentity,
  lazyVisibleArgs,
  readableToolName,
} from "./lazy-tool-model"

describe("lazy broker timeline presentation", () => {
  test("delegated call is presented as its real tool, not an opaque broker contract", () => {
    const input = {
      action: "call",
      contract: "broker-v1:e04b519130fea1e3b019724c",
      tool: "swarm",
      args: { action: "task.settle", taskID: "task_123", reason: "completed" },
    }
    const result = lazyToolIdentity(input, { brokerAction: "call", delegatedTool: "swarm" })
    expect(result).toMatchObject({
      action: "call", target: "swarm", name: "Swarm",
      operation: "Task Settle", subject: "task_123",
    })
    expect(JSON.stringify(result)).not.toContain("broker-v1")
  })

  test("list, describe and pre-result running call use input as the fallback", () => {
    expect(lazyToolIdentity({ action: "list", contract: "secret" })).toMatchObject({ action: "list" })
    expect(lazyToolIdentity({ action: "describe", tool: "usage" })).toMatchObject({
      action: "describe", target: "usage", name: "Usage",
    })
    expect(lazyToolIdentity({ action: "call", tool: "quota", args: { action: "resets" } }, {})).toMatchObject({
      action: "call", target: "quota", operation: "Resets",
    })
    expect(lazyToolIdentity(undefined, { brokerAction: "list" }).action).toBe("list")
  })

  test("metadata delegatedTool takes precedence but not broker verification material", () => {
    const result = lazyToolIdentity({ action: "call", tool: "stale", contract: "private" }, { delegatedTool: "models" })
    expect(result.name).toBe("Models")
    expect(readableToolName("ofxp")).toBe("OFXP")
    expect(readableToolName("sql_query")).toBe("Sql Query")
  })

  test("catalog parsing keeps tool ids and summaries, ignoring instructions", () => {
    const entries = lazyToolCatalog(
      'Available lazy tools:\n- swarm: Native Swarm coordination\n- quota: Read provider limits\n\nBefore calling use action=describe',
    )
    expect(entries).toEqual([
      { id: "swarm", description: "Native Swarm coordination" },
      { id: "quota", description: "Read provider limits" },
    ])
    expect(lazyToolCatalog("No lazy tools are registered.")).toEqual([])
  })

  test("description schema is projected without exposing the contract", () => {
    const output = JSON.stringify({
      tool: "swarm",
      contract: "broker-v1:private",
      description: "Coordinate a native Swarm",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Operation" },
          args: { type: "object" },
        },
        required: ["action"],
      },
    })
    expect(lazyToolDescriptor(output)).toEqual({
      description: "Coordinate a native Swarm",
      parameters: [
        { name: "action", type: "string", required: true, description: "Operation" },
        { name: "args", type: "object", required: false, description: undefined },
      ],
    })
    expect(lazyToolDescriptor("{broken")).toBeUndefined()
    expect(lazyToolDescriptor("n/a")).toBeUndefined()
  })

  test("public params strip hides contracts and sensitive top-level arguments", () => {
    expect(lazyVisibleArgs({
      action: "delegate",
      contract: "broker-v1:secret", apiKey: "private", access_token: "private",
      password: "private", cookie: "private", description: "Inspect and test",
      count: 3, metadata: { sensitive: "not rendered" },
      huge: "x".repeat(1000),
    })).toEqual({ action: "delegate", description: "Inspect and test", count: 3 })
  })
})
