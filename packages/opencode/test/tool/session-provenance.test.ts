import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Parameters } from "@/tool/session"
import { ToolJsonSchema } from "@/tool/json-schema"

describe("SessionTool surface", () => {
  test("provider-visible actions are inspection-only", () => {
    const schema = ToolJsonSchema.fromSchema(Parameters)
    expect(schema.properties?.action).toMatchObject({ enum: ["list", "search", "get", "status", "messages", "children"] })
    for (const action of ["create", "send", "fork"] as const) {
      expect(Result.isFailure(Schema.decodeUnknownResult(Parameters)({ action }))).toBe(true)
    }
  })

  test("search exposes bounded recall inputs without mutation fields", () => {
    const properties = ToolJsonSchema.fromSchema(Parameters).properties ?? {}
    expect(properties).toHaveProperty("query")
    expect(properties).toHaveProperty("tool")
    expect(properties).toHaveProperty("scope")
    expect(properties).toHaveProperty("limit")
    expect(properties).toHaveProperty("repairIndex")
  })

  test("model surface contains no prompt/model/delegation mutation fields", () => {
    const properties = ToolJsonSchema.fromSchema(Parameters).properties ?? {}
    for (const key of ["prompt", "title", "messageId", "model", "agent", "variant", "lastAssistant"]) {
      expect(properties).not.toHaveProperty(key)
    }
  })
})
