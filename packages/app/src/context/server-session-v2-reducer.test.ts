import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode-ai/client/promise"
import { createV2SessionReducer } from "./server-session-v2-reducer"

const event = (input: object) => input as OpenCodeEvent
const base = { created: 1, location: { directory: "/repo" }, durable: { aggregateID: "ses_1", seq: 1, version: 1 } }

describe("v2 session reducer", () => {
  test("projects promoted input and streaming assistant content", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result?.kind === "messages") messages = result.messages
      return result
    }

    apply({
      ...base,
      id: "evt_admitted",
      type: "session.input.admitted",
      data: {
        sessionID: "ses_1",
        inputID: "msg_user",
        input: { type: "user", delivery: "steer", data: { text: "hello" } },
      },
    })
    apply({
      ...base,
      id: "evt_promoted",
      type: "session.input.promoted",
      data: { sessionID: "ses_1", inputID: "msg_user" },
    })
    apply({
      ...base,
      id: "evt_step",
      type: "session.step.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    apply({
      ...base,
      id: "evt_text_start",
      type: "session.text.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", ordinal: 0 },
    })
    apply({
      ...base,
      id: "evt_text_delta",
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", ordinal: 0, delta: "hel" },
    })
    apply({
      ...base,
      id: "evt_text_end",
      type: "session.text.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", ordinal: 0, text: "hello" },
    })

    expect(messages[0]).toMatchObject({ id: "msg_user", type: "user", text: "hello" })
    expect(messages[1]).toMatchObject({
      id: "msg_assistant",
      type: "assistant",
      content: [{ type: "text", text: "hello" }],
    })
  })

  test("folds tool, retry, and completion events", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result?.kind === "messages") messages = result.messages
    }

    apply({
      ...base,
      id: "evt_step",
      type: "session.step.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    apply({
      ...base,
      id: "evt_tool_start",
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", callID: "call_1", name: "bash" },
    })
    apply({
      ...base,
      id: "evt_tool_delta",
      type: "session.tool.input.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", callID: "call_1", delta: "{}" },
    })
    apply({
      ...base,
      id: "evt_tool_called",
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", callID: "call_1", input: {}, executed: true },
    })
    apply({
      ...base,
      id: "evt_tool_success",
      type: "session.tool.success",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        metadata: {},
        content: [{ type: "text", text: "done" }],
        executed: true,
      },
    })
    apply({
      ...base,
      id: "evt_retry",
      type: "session.retry.scheduled",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        attempt: 2,
        at: 10,
        error: { type: "ProviderError", message: "retry" },
      },
    })
    apply({ ...base, id: "evt_done", type: "session.execution.succeeded", data: { sessionID: "ses_1" } })

    expect(messages[0]).toMatchObject({
      type: "assistant",
      retry: undefined,
      content: [{ type: "tool", id: "call_1", state: { status: "completed", content: [{ text: "done" }] } }],
    })
  })

  test("requests hydration when promotion admission was missed", () => {
    const result = createV2SessionReducer().reduce(
      [],
      event({
        ...base,
        id: "evt_promoted",
        type: "session.input.promoted",
        data: { sessionID: "ses_1", inputID: "msg_user" },
      }),
    )

    expect(result).toMatchObject({ sessionID: "ses_1", missing: "msg_user", touched: [] })
  })

  test("keeps indexed assistant deltas lazy and leaves the source graph untouched", () => {
    const reducer = createV2SessionReducer()
    const history = Array.from({ length: 1_000 }, (_, index) => ({
      id: `msg_user_${index}`,
      type: "user" as const,
      text: `history ${index}`,
      time: { created: index + 1 },
    }))
    const content = Object.freeze([{ type: "text" as const, text: "prefix" }])
    const assistant = Object.freeze({
      id: "msg_assistant",
      type: "assistant" as const,
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content,
      time: { created: 2_000 },
    })
    const source = Object.freeze([...history, assistant]) as readonly SessionMessageInfo[]

    const result = reducer.reduce(
      source,
      event({
        ...base,
        id: "evt_text_delta_lazy",
        type: "session.text.delta",
        data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", ordinal: 0, delta: " suffix" },
      }),
    )

    expect(result?.incremental).toMatchObject({
      kind: "assistant-content",
      index: 1_000,
      messageID: "msg_assistant",
      partIndex: 0,
      content: { type: "text", text: "prefix suffix" },
    })
    // The high-frequency path must expose the compatibility array lazily. A
    // plain value here would mean we already paid the O(history + content)
    // copies even though projectV2 consumes only `incremental`.
    expect(Object.getOwnPropertyDescriptor(result!, "messages")?.get).toBeTypeOf("function")
    expect(source.at(-1) === assistant).toBe(true)
    expect(assistant.content).toBe(content)
    expect(content[0]?.text).toBe("prefix")

    // The legacy/fallback contract remains intact when somebody actually asks
    // for the complete array, and materialization still must not mutate input.
    const materialized = result!.messages!
    expect(materialized).not.toBe(source)
    expect(materialized.slice(0, -1)).toEqual(history)
    expect(materialized.at(-1)).toMatchObject({
      id: "msg_assistant",
      content: [{ type: "text", text: "prefix suffix" }],
    })
    expect(source.at(-1) === assistant).toBe(true)
    expect(content[0]?.text).toBe("prefix")
  })

  test("projects current session.next text streams through the same lazy indexed path", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result?.kind === "messages") messages = result.messages
      return result
    }

    apply({
      id: "evt_next_step",
      type: "session.next.step.started",
      data: {
        sessionID: "ses_1",
        timestamp: 10,
        assistantMessageID: "msg_next_assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        requestSentAt: 9,
      },
    })
    apply({
      id: "evt_next_text_start",
      type: "session.next.text.started",
      data: {
        sessionID: "ses_1",
        timestamp: 11,
        assistantMessageID: "msg_next_assistant",
        textID: "txt_1",
      },
    })

    const before = messages
    const assistantBefore = before.at(-1)
    const delta = reducer.reduce(
      before,
      event({
        id: "evt_next_text_delta",
        type: "session.next.text.delta",
        data: {
          sessionID: "ses_1",
          timestamp: 12,
          assistantMessageID: "msg_next_assistant",
          textID: "txt_1",
          delta: "hel",
        },
      }),
    )

    expect(delta?.incremental).toMatchObject({
      kind: "assistant-content",
      messageID: "msg_next_assistant",
      partID: "msg_next_assistant:text:0",
      partIndex: 0,
      content: { type: "text", text: "hel" },
    })
    expect(Object.getOwnPropertyDescriptor(delta!, "messages")?.get).toBeTypeOf("function")
    expect(before.at(-1)).toBe(assistantBefore)
    messages = delta!.messages!

    apply({
      id: "evt_next_text_end",
      type: "session.next.text.ended",
      data: {
        sessionID: "ses_1",
        timestamp: 13,
        assistantMessageID: "msg_next_assistant",
        textID: "txt_1",
        text: "hello",
      },
    })

    expect(messages.at(-1)).toMatchObject({
      id: "msg_next_assistant",
      type: "assistant",
      time: { created: 10, requestSentAt: 9, firstTokenAt: 11 },
      content: [{ type: "text", text: "hello" }],
    })
  })

  test("recovers an unmapped current stream id from the latest compatible history slot", () => {
    const reducer = createV2SessionReducer()
    const source = [
      {
        id: "msg_assistant",
        type: "assistant" as const,
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          { type: "text" as const, text: "older" },
          { type: "text" as const, text: "hydrated" },
        ],
        time: { created: 1 },
      },
    ] satisfies SessionMessageInfo[]

    const result = reducer.reduce(
      source,
      event({
        id: "evt_reconnect_delta",
        type: "session.next.text.delta",
        data: {
          sessionID: "ses_1",
          timestamp: 2,
          assistantMessageID: "msg_assistant",
          textID: "txt_live_after_hydration",
          delta: " suffix",
        },
      }),
    )

    expect(result?.incremental).toMatchObject({ partIndex: 1, partID: "msg_assistant:text:1" })
    expect(result!.messages![0]).toMatchObject({
      content: [
        { type: "text", text: "older" },
        { type: "text", text: "hydrated suffix" },
      ],
    })
  })

  test("projects current reasoning ids through stable legacy ordinals", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result?.kind === "messages") messages = result.messages
      return result
    }

    apply({
      id: "evt_reason_step",
      type: "session.next.step.started",
      data: {
        sessionID: "ses_1",
        timestamp: 1,
        assistantMessageID: "msg_reason",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    apply({
      id: "evt_reason_start",
      type: "session.next.reasoning.started",
      data: {
        sessionID: "ses_1",
        timestamp: 2,
        assistantMessageID: "msg_reason",
        reasoningID: "rsn_native",
        providerMetadata: { trace: "start" },
      },
    })
    const delta = apply({
      id: "evt_reason_delta",
      type: "session.next.reasoning.delta",
      data: {
        sessionID: "ses_1",
        timestamp: 3,
        assistantMessageID: "msg_reason",
        reasoningID: "rsn_native",
        delta: "think",
      },
    })
    expect(delta?.incremental).toMatchObject({
      partID: "msg_reason:reasoning:0",
      partIndex: 0,
      content: { type: "reasoning", text: "think" },
    })
    apply({
      id: "evt_reason_end",
      type: "session.next.reasoning.ended",
      data: {
        sessionID: "ses_1",
        timestamp: 4,
        assistantMessageID: "msg_reason",
        reasoningID: "rsn_native",
        text: "thinking complete",
        providerMetadata: { trace: "end" },
      },
    })

    expect(messages.at(-1)).toMatchObject({
      id: "msg_reason",
      time: { firstTokenAt: 2 },
      content: [
        {
          type: "reasoning",
          text: "thinking complete",
          state: { trace: "end" },
          time: { created: 2, completed: 4 },
        },
      ],
    })
  })

  test("folds current tool lifecycle without leaving streaming snapshots behind", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result?.kind === "messages") messages = result.messages
      return result
    }

    apply({
      id: "evt_tool_step",
      type: "session.next.step.started",
      data: {
        sessionID: "ses_1",
        timestamp: 1,
        assistantMessageID: "msg_tool",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    apply({
      id: "evt_tool_input_start",
      type: "session.next.tool.input.started",
      data: {
        sessionID: "ses_1",
        timestamp: 2,
        assistantMessageID: "msg_tool",
        callID: "call_native",
        name: "bash",
      },
    })
    apply({
      id: "evt_tool_input_delta",
      type: "session.next.tool.input.delta",
      data: {
        sessionID: "ses_1",
        timestamp: 3,
        assistantMessageID: "msg_tool",
        callID: "call_native",
        delta: '{"command":"ec',
      },
    })
    apply({
      id: "evt_tool_input_end",
      type: "session.next.tool.input.ended",
      data: {
        sessionID: "ses_1",
        timestamp: 4,
        assistantMessageID: "msg_tool",
        callID: "call_native",
        text: '{"command":"echo hi"}',
      },
    })
    apply({
      id: "evt_tool_called",
      type: "session.next.tool.called",
      data: {
        sessionID: "ses_1",
        timestamp: 5,
        assistantMessageID: "msg_tool",
        callID: "call_native",
        tool: "bash",
        input: { command: "echo hi" },
        provider: { executed: false, metadata: { call: "meta" } },
      },
    })
    apply({
      id: "evt_tool_progress",
      type: "session.next.tool.progress",
      data: {
        sessionID: "ses_1",
        timestamp: 6,
        assistantMessageID: "msg_tool",
        callID: "call_native",
        structured: { phase: "running" },
        content: [{ type: "text", text: "partial" }],
      },
    })
    const success = apply({
      id: "evt_tool_success",
      type: "session.next.tool.success",
      data: {
        sessionID: "ses_1",
        timestamp: 7,
        assistantMessageID: "msg_tool",
        callID: "call_native",
        structured: { phase: "done" },
        content: [{ type: "text", text: "done" }],
        outputPaths: [],
        provider: { executed: false, metadata: { result: "meta" } },
      },
    })

    expect(success?.incremental).toMatchObject({
      kind: "assistant-content",
      messageID: "msg_tool",
      partID: "call_native",
      content: { type: "tool", state: { status: "completed" } },
    })
    expect(messages.at(-1)).toMatchObject({
      content: [
        {
          type: "tool",
          id: "call_native",
          name: "bash",
          providerState: { call: "meta" },
          providerResultState: { result: "meta" },
          state: {
            status: "completed",
            input: { command: "echo hi" },
            metadata: { phase: "done" },
            content: [{ type: "text", text: "done" }],
          },
          time: { created: 2, ran: 5, completed: 7 },
        },
      ],
    })
  })

  test("folds current tool failure and current compaction lifecycle", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result?.kind === "messages") messages = result.messages
      return result
    }

    apply({
      id: "evt_fail_step",
      type: "session.next.step.started",
      data: {
        sessionID: "ses_1",
        timestamp: 1,
        assistantMessageID: "msg_fail",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    apply({
      id: "evt_fail_tool_start",
      type: "session.next.tool.input.started",
      data: {
        sessionID: "ses_1",
        timestamp: 2,
        assistantMessageID: "msg_fail",
        callID: "call_fail",
        name: "bash",
      },
    })
    apply({
      id: "evt_fail_tool_called",
      type: "session.next.tool.called",
      data: {
        sessionID: "ses_1",
        timestamp: 3,
        assistantMessageID: "msg_fail",
        callID: "call_fail",
        tool: "bash",
        input: { command: "false" },
        provider: { executed: false },
      },
    })
    apply({
      id: "evt_fail_tool",
      type: "session.next.tool.failed",
      data: {
        sessionID: "ses_1",
        timestamp: 4,
        assistantMessageID: "msg_fail",
        callID: "call_fail",
        error: { type: "unknown", message: "boom" },
        provider: { executed: false },
      },
    })
    expect(messages.at(-1)).toMatchObject({
      content: [{ type: "tool", id: "call_fail", state: { status: "error", error: { message: "boom" } } }],
    })

    apply({
      id: "evt_compact_start",
      type: "session.next.compaction.started",
      data: { sessionID: "ses_1", timestamp: 5, messageID: "msg_compact", reason: "auto" },
    })
    apply({
      id: "evt_compact_delta_a",
      type: "session.next.compaction.delta",
      data: { sessionID: "ses_1", timestamp: 6, messageID: "msg_compact", text: "summary " },
    })
    apply({
      id: "evt_compact_delta_b",
      type: "session.next.compaction.delta",
      data: { sessionID: "ses_1", timestamp: 7, messageID: "msg_compact", text: "stream" },
    })
    apply({
      id: "evt_compact_end",
      type: "session.next.compaction.ended",
      data: {
        sessionID: "ses_1",
        timestamp: 8,
        messageID: "msg_compact",
        reason: "auto",
        text: "summary stream",
        recent: "recent context",
      },
    })
    expect(messages.at(-1)).toMatchObject({
      id: "msg_compact",
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "summary stream",
      recent: "recent context",
      time: { created: 5 },
    })
  })

  test("current compaction deltas reuse the stream index instead of rescanning session history", () => {
    const reducer = createV2SessionReducer()
    const source: SessionMessageInfo[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `msg_${index}`,
      type: "user" as const,
      text: `message ${index}`,
      time: { created: index },
    }))
    source.push({
      id: "msg_compact",
      type: "compaction",
      status: "running",
      reason: "auto",
      summary: "",
      recent: "",
      time: { created: 1_001 },
    })

    const first = reducer.reduce(source, {
      id: "evt_compact_delta_first",
      type: "session.next.compaction.delta",
      data: { sessionID: "ses_1", timestamp: 1_002, messageID: "msg_compact", text: "a" },
    } as any)
    expect(first?.incremental).toMatchObject({ kind: "message", index: 1_000 })

    const current = first?.messages ?? source
    const guarded = new Proxy(current, {
      get(target, property, receiver) {
        if (property === "findLast" || property === "findLastIndex") {
          throw new Error("steady-state compaction delta rescanned session history")
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const second = reducer.reduce(guarded, {
      id: "evt_compact_delta_second",
      type: "session.next.compaction.delta",
      data: { sessionID: "ses_1", timestamp: 1_003, messageID: "msg_compact", text: "b" },
    } as any)

    expect(second?.incremental).toMatchObject({
      kind: "message",
      index: 1_000,
      message: { id: "msg_compact", summary: "ab" },
    })
  })

  test("control events preserve the hot stream index without touching history", () => {
    const reducer = createV2SessionReducer()
    const source: SessionMessageInfo[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `msg_${index}`,
      type: "user" as const,
      text: `history ${index}`,
      time: { created: index },
    }))
    source.push({
      id: "msg_live",
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [{ type: "text", text: "prefix" }],
      time: { created: 5_001 },
    })

    const first = reducer.reduce(source, {
      ...base,
      id: "evt_delta_first",
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_live", ordinal: 0, delta: " a" },
    } as any)
    expect(first?.incremental).toMatchObject({ kind: "assistant-content", index: 5_000 })
    if (first?.kind !== "messages") throw new Error("expected indexed message reduction")
    const current = first.messages

    const guarded = new Proxy(current, {
      get(target, property, receiver) {
        if (property === "forEach" || property === "find" || property === "findLast" || property === "map" || property === "slice")
          throw new Error(`control/interleaved delta rescanned history through ${String(property)}`)
        return Reflect.get(target, property, receiver)
      },
    })
    const control = reducer.reduce(guarded, {
      id: "evt_rename",
      type: "session.next.renamed",
      data: { sessionID: "ses_1", timestamp: 5_002, title: "renamed" },
    } as any)

    expect(control).toEqual({ kind: "unchanged", sessionID: "ses_1", touched: [] })

    const second = reducer.reduce(guarded, {
      ...base,
      id: "evt_delta_second",
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_live", ordinal: 0, delta: " b" },
    } as any)
    expect(second?.incremental).toMatchObject({
      kind: "assistant-content",
      index: 5_000,
      content: { type: "text", text: "prefix a b" },
    })
  })
})
