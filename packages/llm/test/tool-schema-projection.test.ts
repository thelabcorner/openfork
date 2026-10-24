import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../src"
import { OpenAIChat } from "../src/protocols"
import { ToolSchemaProjection } from "../src/protocols/utils/tool-schema"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"

describe("tool schema projections", () => {
  test("anthropic projects root oneOf MCP action branches without changing nested unions or the source", () => {
    const schema = {
      type: "object",
      properties: {
        rootID: { type: "string" },
        path: { type: "string" },
        filter: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      oneOf: [{ required: ["rootID"] }, { required: ["path"] }],
      additionalProperties: false,
    }
    const before = structuredClone(schema)
    const lowered = ToolSchemaProjection.anthropic(schema)
    expect(lowered).toMatchObject({
      type: "object",
      properties: schema.properties,
      additionalProperties: false,
    })
    expect(lowered).not.toHaveProperty("oneOf")
    expect(lowered).not.toHaveProperty("anyOf")
    expect(lowered).not.toHaveProperty("allOf")
    expect(lowered).not.toHaveProperty("required")
    expect(lowered.description).toContain("exactly one")
    expect(schema).toEqual(before)
    expect(ToolSchemaProjection.anthropic(lowered)).toBe(lowered)
  })

  test("anthropic merges root allOf requirements and alternative properties while preserving conflicts under fields", () => {
    const allOf = ToolSchemaProjection.anthropic({
      allOf: [
        { type: "object", required: ["action"], properties: { action: { type: "string" } } },
        { type: "object", required: ["target"], properties: { target: { type: "integer" } } },
      ],
    })
    expect(allOf).toMatchObject({
      type: "object",
      properties: { action: { type: "string" }, target: { type: "integer" } },
      required: ["action", "target"],
    })
    expect(allOf).not.toHaveProperty("allOf")

    const anyOf = ToolSchemaProjection.anthropic({
      anyOf: [
        { type: "object", properties: { value: { type: "string" }, a: { type: "number" } }, required: ["value"] },
        { type: "object", properties: { value: { type: "number" }, b: { type: "boolean" } }, required: ["value"] },
      ],
    })
    expect(anyOf).toMatchObject({
      type: "object",
      required: ["value"],
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "number" }] },
        a: { type: "number" },
        b: { type: "boolean" },
      },
    })
    expect(anyOf).not.toHaveProperty("anyOf")
  })

  test("anthropic leaves compatible schemas untouched by identity", () => {
    const schema = { type: "object", properties: { variants: { oneOf: [{ type: "string" }, { type: "number" }] } } }
    expect(ToolSchemaProjection.anthropic(schema)).toBe(schema)
  })

  test("anthropic exposes required-only alternative field names even with additionalProperties false", () => {
    const input = {
      type: "object",
      additionalProperties: false,
      anyOf: [{ required: ["route"] }, { required: ["file"] }],
    }
    expect(ToolSchemaProjection.anthropic(input)).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { route: {}, file: {} },
    })
    const typed = ToolSchemaProjection.anthropic({
      anyOf: [
        { required: ["route"], properties: { route: { type: "string" } } },
        { required: ["file"] },
      ],
    })
    expect(typed.properties).toEqual({ route: { type: "string" }, file: {} })
  })

  test("moonshot strips $ref siblings and converts tuple arrays to a schema object", () => {
    expect(
      ToolSchemaProjection.moonshot({
        type: "object",
        properties: {
          linked: { $ref: "#/$defs/Linked", description: "drop me" },
          tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
          prefixTuple: { type: "array", prefixItems: [{ type: "boolean" }, { type: "string" }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        linked: { $ref: "#/$defs/Linked" },
        tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        prefixTuple: { type: "array", items: { anyOf: [{ type: "boolean" }, { type: "string" }] } },
      },
    })
  })

  test("gemini handles numeric enums, dangling required fields, untyped arrays, and scalar object keys", () => {
    expect(
      ToolSchemaProjection.gemini({
        type: "object",
        required: ["status", "missing"],
        properties: {
          status: { type: "integer", enum: [1, 2] },
          tags: { type: "array" },
          name: { type: "string", properties: { ignored: { type: "string" } }, required: ["ignored"] },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["1", "2"] },
        tags: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
    })
  })

  test("openai keeps one flat object top-level schema", () => {
    expect(
      ToolSchemaProjection.openAI({
        anyOf: [
          {
            type: "object",
            properties: {
              path: { type: "string" },
              maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
          { type: "object", properties: { resource: { type: "string" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        maybe: { type: "string" },
        resource: { type: "string" },
      },
      additionalProperties: false,
    })
  })

  it.effect("applies model compatibility before protocol projection", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "kimi-k2", compatibility: { toolSchema: "moonshot" } })
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          prompt: "Use the tool.",
          tools: [
            {
              name: "lookup",
              description: "Lookup data.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
                      linked: { $ref: "#/$defs/Linked", description: "drop me" },
                    },
                  },
                ],
              },
            },
          ],
        }),
      )

      expect(prepared.body.tools?.[0]?.function.parameters).toEqual({
        type: "object",
        properties: {
          tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
          linked: { $ref: "#/$defs/Linked" },
        },
        additionalProperties: false,
      })
    }),
  )
})
