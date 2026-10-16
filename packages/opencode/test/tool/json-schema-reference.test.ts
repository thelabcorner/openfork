import { describe, expect, test } from "bun:test"
import { ToolJsonSchema } from "../../src/tool/json-schema"

describe("provider tool-schema fast path", () => {
  test("reference-free schemas discard unused definitions and do not alias caller-owned objects", () => {
    const source = {
      type: "object" as const,
      properties: {
        name: { type: "string" as "string" | "number" },
        children: { type: "array" as const, items: { type: "string" as const } },
      },
      $defs: { notUsed: { type: "integer" as const } },
    }
    const result = ToolJsonSchema.fromJsonSchema(source)
    expect(result).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        children: { type: "array", items: { type: "string" } },
      },
    })
    source.properties.name.type = "number"
    expect(ToolJsonSchema.fromJsonSchema(source).properties?.name).toEqual({ type: "number" })
    expect(result.properties?.name).toEqual({ type: "string" })
  })

  test("multiple local references still inline correctly and remove fully resolved definitions", () => {
    const source = {
      type: "object" as const,
      properties: {
        left: { $ref: "#/$defs/Item" },
        right: { $ref: "#/$defs/Item" },
      },
      $defs: { Item: { type: "object" as const, properties: { value: { type: "number" as const } } } },
    }
    const result = ToolJsonSchema.fromJsonSchema(source)
    expect(result).not.toHaveProperty("$defs")
    expect(result.properties?.left).toEqual({ type: "object", properties: { value: { type: "number" } } })
    expect(result.properties?.right).toEqual(result.properties?.left)
  })

  test("recursive local references retain definitions needed by remaining cycles", () => {
    const source = {
      type: "object" as const,
      properties: { first: { $ref: "#/$defs/Item" } },
      $defs: {
        Item: {
          type: "object" as const,
          properties: { next: { $ref: "#/$defs/Item" } },
        },
      },
    }
    const result = ToolJsonSchema.fromJsonSchema(source)
    expect(result.$defs).toBeDefined()
    expect(result.properties?.first).toMatchObject({
      type: "object",
      properties: { next: { $ref: "#/$defs/Item" } },
    })
  })

  test("external refs remain untouched; local definition pruning is independent", () => {
    const source = {
      type: "object" as const,
      properties: { input: { $ref: "https://example.test/schema.json#/$defs/Thing" } },
      definitions: { otherwiseUnused: { type: "number" as const } },
    }
    const result = ToolJsonSchema.fromJsonSchema(source)
    expect(result.properties?.input).toEqual({ $ref: "https://example.test/schema.json#/$defs/Thing" })
    expect(result).not.toHaveProperty("definitions")
  })
})
