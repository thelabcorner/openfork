import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"
import type { ModelMessage } from "ai"
import { createOpenAI } from "@ai-sdk/openai"

const hostedMuse = {
  id: "muse-spark-1.3-contributor",
  providerID: "opencode-go",
  api: { id: "muse-spark-1.3-contributor", npm: "@ai-sdk/openai" },
  capabilities: { input: { image: true, pdf: false } },
} as any

function transcript(): ModelMessage[] {
  return [
    { role: "user", content: "Continue the task" },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "",
          providerOptions: { openai: { itemId: "reasoning-1", reasoningEncryptedContent: "caller-bound" } },
        },
        { type: "text", text: "Checking the files." },
        { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { filePath: "src/a.ts" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read",
          output: { type: "text", value: "source content" },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "",
          providerOptions: { openai: { itemId: "reasoning-2", reasoningEncryptedContent: "caller-bound" } },
        },
      ],
    },
  ]
}

describe("hosted Muse reasoning replay", () => {
  test("omits caller-bound reasoning while retaining tool causality and stored history", () => {
    const source = transcript()
    const before = structuredClone(source)
    const lowered = ProviderTransform.message(source, hostedMuse, { store: false })
    expect(lowered).toHaveLength(3)
    expect(lowered.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect((lowered[1] as any).content.map((part: any) => part.type)).toEqual(["text", "tool-call"])
    expect((lowered[1] as any).content[1].toolCallId).toBe("call-1")
    expect((lowered[2] as any).content[0].toolCallId).toBe("call-1")
    expect(source).toEqual(before)
    expect(JSON.stringify(lowered)).not.toContain("reasoningEncryptedContent")
  })

  test("also protects hosted public Zen Muse, but never unrelated Go models or direct Meta", () => {
    const source = transcript()
    const zen = ProviderTransform.message(structuredClone(source), { ...hostedMuse, providerID: "opencode" }, {})
    expect(zen).toHaveLength(3)
    const other = ProviderTransform.message(structuredClone(source), {
      ...hostedMuse, id: "mimo-v2.6-flash", api: { ...hostedMuse.api, id: "mimo-v2.6-flash" },
    }, {})
    const meta = ProviderTransform.message(structuredClone(source), { ...hostedMuse, providerID: "meta" }, {})
    expect(JSON.stringify(other)).toContain("reasoningEncryptedContent")
    expect(JSON.stringify(meta)).toContain("reasoningEncryptedContent")
    const stored = ProviderTransform.message(structuredClone(source), hostedMuse, { store: true })
    expect(JSON.stringify(stored)).toContain("reasoningEncryptedContent")
  })

  test("does not alter already-safe messages", () => {
    const source: ModelMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: "Thanks" },
    ]
    expect(ProviderTransform.message(source, hostedMuse, {})).toEqual(source)
  })

  test("preserves already valid hosted Muse tool-turn content", () => {
    const source: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking.", providerOptions: { openai: { phase: "commentary" } } },
          { type: "tool-call", toolCallId: "c1", toolName: "read", input: {} },
        ],
      },
    ]
    const result = ProviderTransform.message(source, hostedMuse, {})
    expect(result[0]).toEqual(source[0])
  })

  test("tags unphased intermediate text as commentary before a function call", () => {
    const source: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking the repository." },
          { type: "tool-call", toolCallId: "call-7", toolName: "bash", input: { command: "git status" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-7", toolName: "bash", output: { type: "text", value: "clean" } }],
      },
    ]
    const before = structuredClone(source)
    const outgoing = ProviderTransform.message(source, hostedMuse, { store: false })
    const parts = (outgoing[0] as any).content
    expect(parts.map((part: any) => part.type)).toEqual(["text", "tool-call"])
    expect(parts[0].providerOptions.openai.phase).toBe("commentary")
    expect((outgoing[1] as any).content[0].toolCallId).toBe("call-7")
    expect(source).toEqual(before)
  })

  test("moves trailing Muse commentary before its call without changing stored tool history", () => {
    const source: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-9", toolName: "bash", input: { command: "git log -1" } },
          { type: "text", text: "References checked.", providerOptions: { openai: { phase: "commentary" } } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-9", toolName: "bash", output: { type: "text", value: "ok" } }],
      },
    ]
    const before = structuredClone(source)
    const outgoing = ProviderTransform.message(source, hostedMuse, {})
    const parts = (outgoing[0] as any).content
    expect(parts.map((part: any) => part.type)).toEqual(["text", "tool-call"])
    expect(parts[0].providerOptions.openai.phase).toBe("commentary")
    expect(parts[1].toolCallId).toBe("call-9")
    expect((outgoing[1] as any).content[0].toolCallId).toBe("call-9")
    expect(source).toEqual(before)
    expect((ProviderTransform.message(structuredClone(source), { ...hostedMuse, providerID: "meta" }, {})[0] as any).content[0].type).toBe("tool-call")
    expect((ProviderTransform.message(structuredClone(source), hostedMuse, { store: true })[0] as any).content[0].type).toBe("tool-call")
  })

  test("emits phase-correct, paired function-call history through the actual OpenAI Responses encoder", async () => {
    let wire: any
    const sdk = createOpenAI({
      apiKey: "test-only",
      baseURL: "https://example.invalid/v1",
      fetch: async (_url, init) => {
        wire = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({
          id: "resp_test",
          object: "response",
          model: hostedMuse.id,
          created_at: 1,
          status: "completed",
          output: [
            { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] },
          ],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        }), { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    const source: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-9", toolName: "bash", input: { command: "git log -1" } },
          { type: "text", text: "References checked." },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-9", toolName: "bash", output: { type: "text", value: "ok" } }] },
    ]
    const messages = ProviderTransform.message(source, hostedMuse, { store: false })
    await sdk.responses(hostedMuse.id).doGenerate({
      prompt: messages,
      providerOptions: { openai: { store: false } },
    } as any)
    const input = wire.input as Array<Record<string, any>>
    const idx = input.findIndex((part) => part.type === "function_call")
    expect(idx).toBeGreaterThan(0)
    expect(input[idx - 1].role).toBe("assistant")
    expect(input[idx - 1].phase).toBe("commentary")
    expect(input[idx].call_id).toBe("call-9")
    expect(input[idx + 1].type).toBe("function_call_output")
    expect(input[idx + 1].call_id).toBe("call-9")
  })
})
