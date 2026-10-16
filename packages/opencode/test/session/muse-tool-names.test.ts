import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { normalizeMuseToolNames, restoreMuseToolEvent } from "@/session/llm/muse-tool-names"
import { LLMEvent } from "@opencode-ai/llm"

const muse = { providerID: "opencode-go", api: { id: "muse-spark-1.3-contributor" } } as any
const other = { providerID: "opencode-go", api: { id: "deepseek-v4.1-flash" } } as any
const sample = { description: "Execute the tool" } as any

describe("Muse Spark tool name lowering", () => {
  test("aliases overlong names without changing execute identity or stored history", () => {
    const long = "some-remote-service_".repeat(4) + "execute"
    const sourceTools = { [long]: sample, read: sample }
    const sourceMessages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: long, input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: long, output: { type: "text", value: "ok" } }] },
    ] as any
    const result = normalizeMuseToolNames(muse, sourceTools, sourceMessages)
    const alias = Object.keys(result.tools).find((name) => name !== "read")!
    expect(alias.length).toBe(64)
    expect(alias.startsWith("some-remote-service_")).toBe(true)
    expect(result.tools[alias]).toBe(sample)
    expect((result.messages[0].content as any)[0].toolName).toBe(alias)
    expect((result.messages[1].content as any)[0].toolName).toBe(alias)
    expect((sourceMessages[0].content as any)[0].toolName).toBe(long)
    expect(normalizeMuseToolNames(muse, sourceTools, sourceMessages).tools).toHaveProperty(alias)
  })

  test("avoids collisions with preexisting short tool names", () => {
    const long = "tool-name".repeat(12)
    const digest = createHash("sha256").update(long).digest("hex").slice(0, 16)
    const colliding = long.slice(0, 47) + "_" + digest
    const result = normalizeMuseToolNames(muse, { [long]: sample, [colliding]: sample }, [])
    expect(Object.keys(result.tools)).toHaveLength(2)
    expect(result.tools[colliding]).toBe(sample)
  })

  test("no-op for non-Muse and already-compatible tools", () => {
    const tools = { read: sample }
    const messages = [{ role: "user", content: "hello" }] as any
    const original = normalizeMuseToolNames(other, tools, messages)
    const pass = normalizeMuseToolNames(muse, tools, messages)
    expect(original.tools).toBe(tools)
    expect(original.messages).toBe(messages)
    expect(pass.tools).toBe(tools)
    expect(pass.messages).toBe(messages)
    expect(pass.canonicalByAlias).toEqual({})
  })

  test("validates punctuation in current tools AND poison names in historical tool calls", () => {
    const canonical = "mcp:browser/read"
    const poisoned = "ash:execute"
    const sourceMessages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: poisoned, input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: poisoned, output: { type: "text", value: "error" } }] },
    ] as any
    const before = structuredClone(sourceMessages)
    const lowered = normalizeMuseToolNames(muse, { [canonical]: sample, "safe.id": sample }, sourceMessages)
    const wireName = Object.keys(lowered.tools).find((name) => name !== "safe.id")!
    expect(wireName).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/)
    expect(wireName).not.toBe(canonical)
    expect(lowered.canonicalByAlias[wireName]).toBe(canonical)
    const historical = (lowered.messages[0].content as any)[0].toolName
    expect(historical).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/)
    expect((lowered.messages[1].content as any)[0].toolName).toBe(historical)
    expect(lowered.canonicalByAlias[historical]).toBe(poisoned)
    expect(sourceMessages).toEqual(before)
  })

  test("normalizes Meta's at-most-one-dot rule and preserves paired overlong historical call IDs", () => {
    const name = "namespace.service.read"
    const callID = "call-" + "x".repeat(150)
    const messages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: callID, toolName: name, input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: callID, toolName: name, output: { type: "text", value: "ok" } }] },
    ] as any
    const original = structuredClone(messages)
    const normalized = normalizeMuseToolNames(muse, { [name]: sample, "one.dot": sample }, messages)
    const alias = Object.keys(normalized.tools).find((item) => item !== "one.dot")!
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(normalized.canonicalByAlias[alias]).toBe(name)
    const parts = normalized.messages.map((message) => message.content[0] as any)
    expect(parts.map((part) => part.toolName)).toEqual([alias, alias])
    expect(parts[0].toolCallId).toBe(parts[1].toolCallId)
    expect(parts[0].toolCallId.length).toBeLessThanOrEqual(64)
    expect(parts[0].toolCallId.length).toBeGreaterThan(0)
    expect(normalizeMuseToolNames(muse, { [name]: sample }, messages).messages[0].content[0].toolCallId).toBe(parts[0].toolCallId)
    expect(messages).toEqual(original)
    expect(normalizeMuseToolNames(other, { [name]: sample }, messages).messages).toBe(messages)
  })

  test("normalizes empty call IDs without changing otherwise valid tools or content", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "", toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "", toolName: "read", output: { type: "text", value: "ok" } }] },
    ] as any
    const tools = { read: sample }
    const normalized = normalizeMuseToolNames(muse, tools, messages)
    expect(normalized.tools).toBe(tools)
    expect(normalized.messages.map((message) => (message.content[0] as any).toolCallId)).toEqual([
      normalized.messages[0].content[0].toolCallId,
      normalized.messages[0].content[0].toolCallId,
    ])
    expect(normalized.messages[0].content[0].toolCallId).not.toBe("")
    expect((messages[0].content as any)[0].toolCallId).toBe("")
  })

  test("restores all tool events before they reach persistence, including error paths", () => {
    const original = "mcp:browser/read"
    const lowered = normalizeMuseToolNames(muse, { [original]: sample }, [])
    const alias = Object.keys(lowered.tools)[0]!
    const events: LLMEvent[] = [
      LLMEvent.toolInputStart({ id: "c1", name: alias }),
      LLMEvent.toolInputDelta({ id: "c1", name: alias, text: "{}" }),
      LLMEvent.toolInputEnd({ id: "c1", name: alias }),
      LLMEvent.toolCall({ id: "c1", name: alias, input: {} }),
      LLMEvent.toolResult({ id: "c1", name: alias, result: { type: "text", value: "ok" } }),
      LLMEvent.toolError({ id: "c1", name: alias, message: "no" }),
    ]
    for (const event of events) {
      const restored = restoreMuseToolEvent(event, lowered.canonicalByAlias)
      expect((restored as any).name).toBe(original)
      expect(restoreMuseToolEvent(event, {})).toBe(event)
      expect((event as any).name).toBe(alias)
    }
    const unknown = LLMEvent.toolCall({ id: "c2", name: "unknown", input: {} })
    expect(restoreMuseToolEvent(unknown, lowered.canonicalByAlias)).toBe(unknown)
  })
})
