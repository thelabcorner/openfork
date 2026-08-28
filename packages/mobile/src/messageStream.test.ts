import { describe, expect, test } from "bun:test"
import { reduceMessageEvent } from "./messageStream"

describe("message stream reduction", () => {
  test("projects current text deltas and authoritative completion", () => {
    let messages: any[] = []
    const apply = (type: string, props: any) => {
      messages = reduceMessageEvent(messages, type, props).messages
    }
    const base = { sessionID: "s1", assistantMessageID: "m1", timestamp: 1 }
    apply("session.next.step.started", { ...base, agent: "build", model: { providerID: "openai", modelID: "gpt" } })
    apply("session.next.text.started", { ...base, textID: "p1" })
    apply("session.next.text.delta", { ...base, textID: "p1", delta: "Hel" })
    apply("session.next.text.delta", { ...base, textID: "p1", delta: "lo" })
    expect(messages[0].parts[0].text).toBe("Hello")

    apply("session.next.text.ended", { ...base, textID: "p1", text: "Hello!", timestamp: 2 })
    apply("session.next.step.ended", { ...base, timestamp: 3, finish: "stop", cost: 1, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } })
    expect(messages[0].parts[0].text).toBe("Hello!")
    expect(messages[0].info.time.completed).toBe(3)
  })

  test("projects compatibility part snapshots and deltas", () => {
    const info = { id: "m1", sessionID: "s1", role: "assistant", time: { created: 1 } }
    let result = reduceMessageEvent([], "message.updated", { sessionID: "s1", info })
    result = reduceMessageEvent(result.messages, "message.part.updated", {
      sessionID: "s1",
      part: { id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "A" },
    })
    result = reduceMessageEvent(result.messages, "message.part.delta", {
      sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "B",
    })
    expect((result.messages[0]!.parts[0] as any).text).toBe("AB")
  })

  test("projects current tool lifecycle without waiting for a snapshot", () => {
    let messages: any[] = []
    const apply = (type: string, props: any) => {
      messages = reduceMessageEvent(messages, type, props).messages
    }
    const base = { sessionID: "s1", assistantMessageID: "m1" }
    apply("session.next.step.started", { ...base, timestamp: 1, agent: "build", model: { providerID: "openai", id: "gpt" } })
    apply("session.next.tool.input.started", { ...base, timestamp: 2, callID: "call-1", name: "bash" })
    apply("session.next.tool.input.ended", { ...base, timestamp: 3, callID: "call-1", text: "{\"command\":\"pwd\"}" })
    apply("session.next.tool.called", { ...base, timestamp: 4, callID: "call-1", tool: "bash", input: { command: "pwd" } })
    expect(messages[0].parts[0].state).toMatchObject({ status: "running", input: { command: "pwd" } })

    apply("session.next.tool.progress", { ...base, timestamp: 5, callID: "call-1", structured: { title: "Working" }, content: [] })
    apply("session.next.tool.success", { ...base, timestamp: 6, callID: "call-1", structured: { title: "Complete" }, content: [{ type: "text", text: "/tmp" }], provider: { executed: true } })
    expect(messages[0].parts[0].state).toEqual({
      status: "completed",
      input: { command: "pwd" },
      output: "/tmp",
      title: "Complete",
      metadata: { title: "Complete" },
      time: { start: 4, end: 6 },
    })
  })

  test("projects current tool failure", () => {
    let messages: any[] = []
    const apply = (type: string, props: any) => {
      messages = reduceMessageEvent(messages, type, props).messages
    }
    const base = { sessionID: "s1", assistantMessageID: "m1", callID: "call-1" }
    apply("session.next.step.started", { ...base, timestamp: 1, agent: "build", model: { providerID: "openai", id: "gpt" } })
    apply("session.next.tool.input.started", { ...base, timestamp: 2, name: "bash" })
    apply("session.next.tool.called", { ...base, timestamp: 3, tool: "bash", input: { command: "false" } })
    apply("session.next.tool.failed", { ...base, timestamp: 4, error: { type: "unknown", message: "exit 1" }, provider: { executed: true } })
    expect(messages[0].parts[0].state).toMatchObject({
      status: "error",
      input: { command: "false" },
      error: "exit 1",
      time: { start: 3, end: 4 },
    })
  })

  test("marks orphan deltas stale instead of inventing messages", () => {
    const result = reduceMessageEvent([], "message.part.delta", {
      sessionID: "s1", messageID: "missing", partID: "missing", field: "text", delta: "lost",
    })
    expect(result.changed).toBe(false)
    expect(result.stale).toBe(true)
  })

  test("recovers a reasoning part when its live started event was missed", () => {
    const base = { sessionID: "s1", assistantMessageID: "m1", timestamp: 1 }
    let result = reduceMessageEvent([], "session.next.step.started", {
      ...base,
      agent: "build",
      model: { providerID: "openai", id: "gpt" },
    })
    result = reduceMessageEvent(result.messages, "session.next.reasoning.delta", {
      ...base,
      reasoningID: "r1",
      delta: "Thinking now",
    })
    expect(result.changed).toBe(true)
    expect(result.stale).toBeUndefined()
    expect(result.messages[0]!.parts[0]).toMatchObject({ type: "reasoning", text: "Thinking now" })
  })

  test("does not erase streamed reasoning when a duplicate start arrives late", () => {
    const base = { sessionID: "s1", assistantMessageID: "m1", reasoningID: "r1", timestamp: 1 }
    let result = reduceMessageEvent([], "session.next.step.started", {
      ...base,
      agent: "build",
      model: { providerID: "openai", id: "gpt" },
    })
    result = reduceMessageEvent(result.messages, "session.next.reasoning.started", base)
    result = reduceMessageEvent(result.messages, "session.next.reasoning.delta", { ...base, delta: "Visible" })
    result = reduceMessageEvent(result.messages, "session.next.reasoning.started", base)
    expect(result.changed).toBe(false)
    expect(result.messages[0]!.parts[0]).toMatchObject({ type: "reasoning", text: "Visible" })
  })
})
