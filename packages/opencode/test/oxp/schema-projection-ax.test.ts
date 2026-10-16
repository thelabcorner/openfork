import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BrokerContract } from "@/tool/broker-contract"
import { OxpSchemaProjection } from "@/oxp/schema-projection"
import { OxpBrowser } from "@/oxp/browser"

function descriptions(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found
  if (Array.isArray(value)) {
    for (const item of value) descriptions(item, found)
    return found
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "description" && typeof item === "string") found.push(item)
    else descriptions(item, found)
  }
  return found
}

describe("AX semantic schema projection", () => {
  test("never strips null from a required field that the canonical decoder accepts", () => {
    const nullable = Schema.Struct({ value: Schema.NullOr(Schema.String) })
    expect(Schema.decodeUnknownSync(nullable)({ value: null })).toEqual({ value: null })
    for (const guidance of ["compact", "balanced", "full"] as const) {
      const projected = OxpSchemaProjection.inputSchema(nullable, guidance) as Record<string, any>
      expect(projected.required).toContain("value")
      expect(projected.properties.value.anyOf).toContainEqual({ type: "null" })
      expect(projected.properties.value.anyOf).toContainEqual({ type: "string" })
    }
  })

  test("keeps accepted NaN literal unions while collapsing only the exact compiler-created numeric sentinel pattern", () => {
    const validLiteral = Schema.Struct({ value: Schema.Union([Schema.Number, Schema.Literal("NaN")]) })
    expect(Schema.decodeUnknownSync(validLiteral)({ value: "NaN" })).toEqual({ value: "NaN" })
    for (const guidance of ["compact", "balanced", "full"] as const) {
      const projected = OxpSchemaProjection.inputSchema(validLiteral, guidance) as Record<string, any>
      expect(JSON.stringify(projected.properties.value)).toContain('"NaN"')
      const number = OxpSchemaProjection.inputSchema(Schema.Struct({ value: Schema.Number }), guidance) as Record<string, any>
      expect(number.properties.value).toEqual({ type: "number" })
      const nullableNumber = OxpSchemaProjection.inputSchema(Schema.Struct({ value: Schema.NullOr(Schema.Number) }), guidance) as Record<string, any>
      expect(nullableNumber.properties.value.anyOf).toContainEqual({ type: "null" })
    }
  })

  const schema = Schema.Struct({
    action: Schema.Literals(["list", "commit"]).annotate({
      description: "Choose list for safe inspection or commit to write; commit requires the write grant.",
    }),
    rootID: Schema.String.annotate({
      description: "Approved workspace identity, not an arbitrary filesystem path.",
    }),
    expectedVersion: Schema.optional(Schema.Int).annotate({
      description: "Required for updates; a stale version must fail without overwriting data.",
    }),
    nested: Schema.optional(Schema.Struct({
      mode: Schema.Literals(["read", "write"]).annotate({ description: "Only write if explicitly authorized." }),
    })),
  })

  test("retains authored action and argument semantics only in on-demand balanced descriptors", () => {
    const result = OxpSchemaProjection.inputSchema(schema) as Record<string, any>
    expect(result.properties.action.description).toContain("write grant")
    expect(result.properties.rootID.description).toContain("Approved workspace")
    expect(result.properties.expectedVersion.description).toContain("stale version")
    expect(descriptions(result).length).toBeGreaterThanOrEqual(3)
    expect(result.additionalProperties).toBe(false)
    expect(result.properties.action.enum).toEqual(["list", "commit"])
  })

  test("keeps the old minimal schema available without deleting validation constraints", () => {
    const result = OxpSchemaProjection.inputSchema(schema, "compact") as Record<string, any>
    expect(descriptions(result)).toEqual([])
    expect(result.required).toContain("rootID")
    expect(result.properties.action.enum).toEqual(["list", "commit"])
  })

  test("does not mistake an input property named description for discardable schema help", () => {
    const words = Schema.Struct({
      description: Schema.optional(Schema.String).annotate({
        description: "Task instructions, not an annotation to remove.",
      }),
      nested: Schema.Struct({
        description: Schema.String.annotate({ description: "Nested user-authored description." }),
      }),
      items: Schema.Array(Schema.Struct({
        description: Schema.String.annotate({ description: "Array entry description." }),
      })),
    })
    for (const mode of ["compact", "balanced", "full"] as const) {
      const result = OxpSchemaProjection.inputSchema(words, mode) as Record<string, any>
      // Nullable JSON Schema alternatives are retained, but the actual user
      // field and its string alternative must never disappear.
      expect(result.properties.description.anyOf).toContainEqual({ type: "string" })
      expect(result.properties.nested.properties.description.type).toBe("string")
      expect(result.properties.items.items.properties.description.type).toBe("string")
      expect(result.properties.nested.required).toContain("description")
      expect(result.properties.items.items.required).toContain("description")
      if (mode === "compact") expect(descriptions(result)).toEqual([])
      else expect(descriptions(result)).toContain("Array entry description.")
    }
  })

  test("retains medium-length safety guidance but offers unbounded full guidance", () => {
    const long = "Critical authorization invariant. ".repeat(16)
    const oversized = "Long exception-handling instruction. ".repeat(48)
    const schema = Schema.Struct({
      action: Schema.String.annotate({ description: long }),
      extendedHelp: Schema.optional(Schema.String).annotate({ description: oversized }),
    })
    const balanced = OxpSchemaProjection.inputSchema(schema) as Record<string, any>
    const full = OxpSchemaProjection.inputSchema(schema, "full") as Record<string, any>
    expect(balanced.properties.action.description).toBe(long)
    expect(balanced.properties.extendedHelp.description).toBeUndefined()
    expect(full.properties.action.description).toBe(long)
    expect(full.properties.extendedHelp.description).toBe(oversized)
  })

  test("caps large descriptors, never truncates prose and leaves types intact", () => {
    const props: Record<string, Schema.Top> = {}
    for (let i = 0; i < 160; i++)
      props["field" + i] = Schema.optional(Schema.String).annotate({
        description: "Choose this optional value only if the selected operation needs it. " + i.toString().padStart(3, "0"),
      })
    const schema = Schema.Struct(props)
    const result = OxpSchemaProjection.inputSchema(schema) as Record<string, any>
    const all = descriptions(result)
    expect(all.join("").length).toBeLessThanOrEqual(OxpSchemaProjection.BALANCED_GUIDANCE_CHARS)
    expect(all.length).toBeGreaterThan(0)
    expect(all.length).toBeLessThan(160)
    expect(Object.keys(result.properties)).toHaveLength(160)
    expect(all.every((value) => value.endsWith("0") || value.endsWith("1") || /[2-9]$/.test(value))).toBe(true)
  })

  test("preserves structural unions and transitive $defs without dangling references", () => {
    const recursive = Schema.Struct({
      kind: Schema.Literals(["parent", "leaf"]).annotate({ description: "Discriminates parent versus leaf operations." }),
      inner: Schema.optional(Schema.Struct({ value: Schema.Number.annotate({ description: "Numeric payload." }) })),
    })
    const combined = Schema.Struct({ entries: Schema.Array(recursive) })
    for (const mode of ["compact", "balanced", "full"] as const) {
      const result = OxpSchemaProjection.inputSchema(combined, mode) as Record<string, any>
      expect(result.properties.entries).toBeDefined()
      expect(result.required).toEqual(["entries"])
      expect(JSON.stringify(result)).toContain('"kind"')
    }
  })

  test("keeps broker contracts deterministic and tied to the schema the agent sees", () => {
    const a = OxpSchemaProjection.inputSchema(schema)
    const b = OxpSchemaProjection.inputSchema(schema)
    const c = OxpSchemaProjection.inputSchema(schema, "compact")
    expect(a).toEqual(b)
    const inputs = { broker: "capability", target: "ax-fixture", description: "AX test capability" }
    expect(BrokerContract.make({ ...inputs, schema: a }))
      .toBe(BrokerContract.make({ ...inputs, schema: b }))
    expect(BrokerContract.make({ ...inputs, schema: a }))
      .not.toBe(BrokerContract.make({ ...inputs, schema: c }))
  })

  test("focuses a real browser operation without dragging 29 unrelated branches into context", () => {
    const complete = OxpSchemaProjection.definitionInputSchema({ schema: OxpBrowser.Parameters })
    const focused = OxpSchemaProjection.focusedInputSchema({ schema: OxpBrowser.Parameters }, "navigate")
    expect(focused).toBeDefined()
    const branch = focused as Record<string, any>
    expect(branch.anyOf).toBeUndefined()
    expect(branch.properties.operation.enum).toEqual(["navigate"])
    expect(branch.required).toContain("args")
    expect(JSON.stringify(focused).length).toBeLessThan(JSON.stringify(complete).length / 6)
    expect(OxpSchemaProjection.focusedInputSchema({ schema: OxpBrowser.Parameters }, "imaginary")).toBeUndefined()
    const metadata = { broker: "capability", target: "browser", description: "OXP browser" }
    expect(BrokerContract.make({ ...metadata, schema: focused }))
      .not.toBe(BrokerContract.make({ ...metadata, schema: complete }))
  })

  test("never pretends a flat multifunction schema has action-specific required fields", () => {
    expect(OxpSchemaProjection.focusedInputSchema({ schema }, "list")).toBeUndefined()
  })
})
