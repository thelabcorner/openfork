import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  anthropicToOpenAIChat,
  coalesceAdjacentMessages,
  ensureTrailingUserContinuation,
  extractContentParts,
  extractText,
  lastUserText,
  parseSseFrames,
  safeParse,
  splitModelContextSuffix,
  sseToAnthropicBody,
  toAnthropicMessages,
  toAnthropicToolChoice,
  toAnthropicTools,
  verdentSSEToOpenAI,
  verdentLimitSnapshot,
  setTestVerdentAccountStore,
  fetchVerdentAccountProfile,
  VerdentPlugin,
} from "@/plugin/verdent"
import { VerdentRegistry, VerdentVault, stableVerdentIdentity, uidFromToken } from "@/plugin/verdent-accounts"
import { WorkBuddyEntitlementGovernor } from "@/plugin/workbuddy-governor"
import { verdent } from "@/quota/providers/verdent"
import { buildVerdentFreeSnapshot, isVerdentFreeModelID } from "@/usage/verdent-free"

// ---------------------------------------------------------------- extractText / extractContentParts

describe("verdent extract helpers", () => {
  test("extractText from string", () => {
    expect(extractText("hello")).toBe("hello")
  })
  test("extractText from text array", () => {
    expect(
      extractText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab")
  })
  test("extractText ignores non-text parts", () => {
    expect(
      extractText([
        { type: "image_url", image_url: { url: "x" } },
        { type: "text", text: "hi" },
      ]),
    ).toBe("hi")
  })
  test("extractContentParts handles string", () => {
    expect(extractContentParts("hi")).toEqual([{ type: "text", text: "hi" }])
  })
  test("extractContentParts empty string", () => {
    expect(extractContentParts("")).toEqual([])
  })
  test("extractContentParts array with image", () => {
    const parts = extractContentParts([{ type: "image_url", image_url: { url: "https://x.com/a.png" } }])
    expect(parts[0].type).toBe("image")
  })
})

// ---------------------------------------------------------------- toAnthropicMessages

describe("toAnthropicMessages", () => {
  test("system message extracted", () => {
    const { system, messages } = toAnthropicMessages(
      { messages: [{ role: "system", content: "sys" }] },
      "glm-5.3-flash-free",
    )
    expect(system.length).toBe(1)
    expect(system[0].text).toBe("sys")
    expect(messages.length).toBe(0)
  })

  test("system array content", () => {
    const { system } = toAnthropicMessages(
      {
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
      "m",
    )
    // first text creates system entry via extractText ("ab"), but also array handling adds second? The dedup prevents double-count but we get at least 1
    expect(system.length).toBeGreaterThanOrEqual(1)
  })

  test("user text message", () => {
    const { messages } = toAnthropicMessages({ messages: [{ role: "user", content: "hello" }] }, "m")
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }], model: "m" }])
  })

  test("assistant with tool_calls", () => {
    const { messages } = toAnthropicMessages(
      {
        messages: [
          {
            role: "assistant",
            content: "thinking",
            tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"x"}' } }],
          },
        ],
      },
      "m",
    )
    expect(messages[0].role).toBe("assistant")
    expect(messages[0].content.some((c: any) => c.type === "text")).toBe(true)
    expect(messages[0].content.some((c: any) => c.type === "tool_use" && c.name === "read")).toBe(true)
    const toolUse = messages[0].content.find((c: any) => c.type === "tool_use")
    expect(toolUse!.input).toEqual({ path: "x" })
  })

  test("assistant tool_calls only (no content)", () => {
    const { messages } = toAnthropicMessages(
      {
        messages: [
          { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] },
        ],
      },
      "m",
    )
    expect(messages.length).toBe(1)
    expect(messages[0].content[0].type).toBe("tool_use")
  })

  test("tool result mapped to user tool_result", () => {
    const { messages } = toAnthropicMessages(
      { messages: [{ role: "tool", tool_call_id: "call_1", content: "result text" }] },
      "m",
    )
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe("user")
    expect(messages[0].content[0].type).toBe("tool_result")
    expect(messages[0].content[0].tool_use_id).toBe("call_1")
    expect(messages[0].content[0].content).toBe("result text")
  })

  test("multiple parallel tool results are merged per-role", () => {
    const { messages } = toAnthropicMessages(
      {
        messages: [
          { role: "tool", tool_call_id: "c1", content: "r1" },
          { role: "tool", tool_call_id: "c2", content: "r2" },
        ],
      },
      "m",
    )
    // consecutive user (tool_result) messages get merged
    expect(messages.length).toBe(1)
    expect(messages[0].content.length).toBe(2)
  })

  test("invalid tool_calls without name are skipped", () => {
    const { messages } = toAnthropicMessages(
      { messages: [{ role: "assistant", content: "hi", tool_calls: [{ id: "x", function: { arguments: "{}" } }] }] },
      "m",
    )
    expect(messages[0].content.length).toBe(1) // only text, no tool_use
  })

  test("assistant content array with text parts", () => {
    const { messages } = toAnthropicMessages(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
      "m",
    )
    expect(messages[0].content.length).toBe(2)
  })

  test("empty messages skipped", () => {
    const { messages } = toAnthropicMessages({ messages: [{ role: "user", content: "" }] }, "m")
    expect(messages.length).toBe(0)
  })

  test("all messages carry model stamp", () => {
    const { messages } = toAnthropicMessages(
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "ho" },
        ],
      },
      "deepseek-v4-flash-free",
    )
    expect(messages.every((m) => m.model === "deepseek-v4-flash-free")).toBe(true)
  })
})

// ---------------------------------------------------------------- toAnthropicTools / tool_choice

describe("toAnthropicTools", () => {
  test("empty returns undefined", () => {
    expect(toAnthropicTools({ tools: [] })).toBeUndefined()
    expect(toAnthropicTools({})).toBeUndefined()
  })
  test("maps function tools", () => {
    const out = toAnthropicTools({
      tools: [
        {
          function: {
            name: "read",
            description: "r",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    })
    expect(out![0].name).toBe("read")
    expect(out![0].input_schema.properties.path).toBeDefined()
  })
  test("skips tools without name", () => {
    expect(toAnthropicTools({ tools: [{ function: { description: "x" } }] })).toBeUndefined()
  })
})

describe("toAnthropicToolChoice", () => {
  test("string auto/required/none", () => {
    expect(toAnthropicToolChoice({ tool_choice: "auto" })).toEqual({ type: "auto" })
    expect(toAnthropicToolChoice({ tool_choice: "required" })).toEqual({ type: "any" })
    expect(toAnthropicToolChoice({ tool_choice: "none" })).toEqual({ type: "none" })
  })
  test("function specific", () => {
    expect(toAnthropicToolChoice({ tool_choice: { type: "function", function: { name: "read" } } })).toEqual({
      type: "tool",
      name: "read",
    })
  })
  test("passthrough anthropic already", () => {
    expect(toAnthropicToolChoice({ tool_choice: { type: "tool", name: "read" } })).toEqual({
      type: "tool",
      name: "read",
    })
  })
  test("undefined returns undefined", () => {
    expect(toAnthropicToolChoice({})).toBeUndefined()
  })
})

// ---------------------------------------------------------------- safeParse

describe("safeParse", () => {
  test("valid json", () => {
    expect(safeParse('{"a":1}')).toEqual({ a: 1 })
  })
  test("empty string", () => {
    expect(safeParse("")).toEqual({})
  })
  test("invalid returns {}", () => {
    expect(safeParse("{bad")).toEqual({})
  })
})

// ---------------------------------------------------------------- anthropicToOpenAIChat

describe("anthropicToOpenAIChat", () => {
  test("text only", () => {
    const out = anthropicToOpenAIChat({ content: [{ type: "text", text: "hi" }] }, "m")
    expect(out.choices[0].message.content).toBe("hi")
    expect(out.choices[0].finish_reason).toBe("stop")
  })
  test("thinking mapped to reasoning_content", () => {
    const out = anthropicToOpenAIChat({ content: [{ type: "thinking", thinking: "hmm" }] }, "m")
    expect(out.choices[0].message.reasoning_content).toBe("hmm")
  })
  test("tool_use mapped to tool_calls with JSON args", () => {
    const out = anthropicToOpenAIChat(
      { content: [{ type: "tool_use", id: "id1", name: "read", input: { path: "x" } }] },
      "m",
    )
    expect(out.choices[0].finish_reason).toBe("tool_calls")
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("read")
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe('{"path":"x"}')
  })
  test("parallel tool_use each gets entry", () => {
    const out = anthropicToOpenAIChat(
      {
        content: [
          { type: "tool_use", id: "a", name: "read", input: {} },
          { type: "tool_use", id: "b", name: "bash", input: { cmd: "ls" } },
        ],
      },
      "m",
    )
    expect(out.choices[0].message.tool_calls.length).toBe(2)
  })
  test("usage mapped", () => {
    const out = anthropicToOpenAIChat(
      { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 5 } },
      "m",
    )
    expect(out.usage.prompt_tokens).toBe(10)
    expect(out.usage.completion_tokens).toBe(5)
    expect(out.usage.total_tokens).toBe(15)
  })
})

// ---------------------------------------------------------------- sseToAnthropicBody

describe("sseToAnthropicBody", () => {
  test("collects text deltas", () => {
    const sse =
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"hello "}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"text":"world"}}\n\n'
    const body = sseToAnthropicBody(sse)
    expect(body!.content[0].text).toBe("hello world")
  })
  test("collects thinking", () => {
    const sse = 'data: {"type":"content_block_delta","index":0,"delta":{"thinking":"hmm"}}\n\n'
    const body = sseToAnthropicBody(sse)
    expect(body!.content.some((c: any) => c.type === "thinking")).toBe(true)
  })
  test("collects tool_use via partial_json", () => {
    const sse =
      [
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"partial_json":"{\\"path\\""}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"partial_json":":\\"x\\"}"}}',
      ].join("\n\n") + "\n\n"
    const body = sseToAnthropicBody(sse)
    const tool = body!.content.find((c: any) => c.type === "tool_use")
    expect(tool).toBeDefined()
    expect(tool.input).toEqual({ path: "x" })
  })
  test("handles parallel tool indices", () => {
    const sse =
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"read"}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"b","name":"bash"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"partial_json":"{\\"path\\":\\"x\\"}"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"partial_json":"{\\"cmd\\":\\"ls\\"}"}}',
      ].join("\n\n") + "\n\n"
    const body = sseToAnthropicBody(sse)
    expect(body!.content.filter((c: any) => c.type === "tool_use").length).toBe(2)
  })
  test("handles input_json variant", () => {
    const sse =
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"read"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"input_json":"{\\"path\\":\\"x\\"}"}}\n\n'
    const body = sseToAnthropicBody(sse)
    expect(body!.content.find((c: any) => c.type === "tool_use").input).toEqual({ path: "x" })
  })
  test("ignores [DONE]", () => {
    const sse = "data: [DONE]\n\n"
    expect(sseToAnthropicBody(sse)).toBeNull()
  })
  test("captures usage from message_stop", () => {
    const sse =
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"hi"}}\n\ndata: {"type":"message_stop","usage":{"input_tokens":10}}\n\n'
    expect(sseToAnthropicBody(sse)!.usage.input_tokens).toBe(10)
  })
  test("returns null on empty", () => {
    expect(sseToAnthropicBody("")).toBeNull()
  })
})

// ---------------------------------------------------------------- verdentSSEToOpenAI

describe("verdentSSEToOpenAI", () => {
  function parseChunks(events: string[]): any[] {
    return events
      .filter((e) => e.startsWith("data: ") && !e.includes("[DONE]"))
      .map((e) => JSON.parse(e.slice(5).trim()))
  }

  test("text delta produces content chunk", () => {
    const sse =
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"hi"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    const chunks = parseChunks(verdentSSEToOpenAI(sse, "m"))
    expect(chunks.some((c) => c.choices[0].delta.content === "hi")).toBe(true)
  })

  test("thinking delta produces reasoning_content", () => {
    const sse =
      'data: {"type":"content_block_delta","index":0,"delta":{"thinking":"hmm"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    const chunks = parseChunks(verdentSSEToOpenAI(sse, "m"))
    expect(chunks.some((c) => c.choices[0].delta.reasoning_content === "hmm")).toBe(true)
  })

  test("multiple thinking deltas remain separate and CRLF-framed", () => {
    const sse = [
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"thinking":"first "}}\r\n\r\n',
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"thinking":"second"}}\r\n\r\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\r\n\r\n',
    ].join("")
    expect(parseSseFrames(sse)).toHaveLength(3)
    const chunks = parseChunks(verdentSSEToOpenAI(sse, "m"))
    expect(
      chunks.filter((c) => c.choices[0].delta.reasoning_content).map((c) => c.choices[0].delta.reasoning_content),
    ).toEqual(["first ", "second"])
  })

  test("terminal stream errors do not receive a fabricated success footer", () => {
    const sse = [
      'data: {"type":"content_block_delta","index":0,"delta":{"thinking":"partial"}}\n\n',
      'event: error\ndata: {"type":"error","error":"weekly limit reached"}\n\n',
    ].join("")
    const chunks = parseChunks(verdentSSEToOpenAI(sse, "m"))
    expect(chunks.some((c) => c.error?.type === "rate_limit_error")).toBe(true)
    expect(chunks.some((c) => c.choices?.[0]?.finish_reason)).toBe(false)
  })

  test("tool_use start + partial_json streamed correctly", () => {
    const sse =
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"partial_json":"{\\"path\\""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"partial_json":":\\"x\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      ].join("\n\n") + "\n\n"
    const chunks = parseChunks(verdentSSEToOpenAI(sse, "m"))
    const toolChunks = chunks.filter((c) => c.choices[0].delta.tool_calls)
    expect(toolChunks.length).toBeGreaterThanOrEqual(2)
    // first tool chunk has id+name, subsequent have args
    expect(toolChunks[0].choices[0].delta.tool_calls[0].id).toBe("toolu_1")
    expect(toolChunks[0].choices[0].delta.tool_calls[0].function.name).toBe("read")
    expect(toolChunks[1].choices[0].delta.tool_calls[0].function.arguments.length).toBeGreaterThan(0)
    // finish reason is tool_calls
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls")
  })

  test("parallel tools get distinct indices", () => {
    const sse =
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"read"}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"b","name":"bash"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"partial_json":"{\\"path\\":\\"x\\"}"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"partial_json":"{\\"cmd\\":\\"ls\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      ].join("\n\n") + "\n\n"
    const chunks = parseChunks(verdentSSEToOpenAI(sse, "m"))
    const indices = chunks
      .filter((c) => c.choices[0].delta.tool_calls)
      .map((c) => c.choices[0].delta.tool_calls[0].index)
    expect(new Set(indices).size).toBe(2)
  })

  test("stop without tool_use gives finish stop", () => {
    const sse =
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"hi"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    const chunks = parseChunks(verdentSSEToOpenAI(sse, "m"))
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop")
  })

  test("max_tokens stop mapped to length", () => {
    const sse = 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n'
    const chunks = parseChunks(verdentSSEToOpenAI(sse, "m"))
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("length")
  })

  test("content_block_start text included", () => {
    const sse =
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    const chunks = parseChunks(verdentSSEToOpenAI(sse, "m"))
    expect(chunks.some((c) => c.choices[0].delta.content === "hello")).toBe(true)
  })
})

// ---------------------------------------------------------------- round-trip sanity: OpenAI tool call -> Anthropic -> OpenAI

describe("verdent toolcall round-trip", () => {
  test("single tool call survives round-trip", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"x"}' } }],
        },
      ],
    }
    const { messages } = toAnthropicMessages(payload, "m")
    const toolUse = messages[0].content.find((c: any) => c.type === "tool_use")
    expect(toolUse!.name).toBe("read")
    // back to OpenAI
    const openai = anthropicToOpenAIChat({ content: [toolUse] }, "m")
    expect(openai.choices[0].message.tool_calls[0].function.name).toBe("read")
    expect(JSON.parse(openai.choices[0].message.tool_calls[0].function.arguments)).toEqual({ path: "x" })
  })

  test("parallel tool calls round-trip preserves count and ids", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c1", function: { name: "read", arguments: '{"path":"a"}' } },
            { id: "c2", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          ],
        },
      ],
    }
    const { messages } = toAnthropicMessages(payload, "m")
    expect(messages[0].content.filter((c: any) => c.type === "tool_use").length).toBe(2)
    const openai = anthropicToOpenAIChat({ content: messages[0].content }, "m")
    expect(openai.choices[0].message.tool_calls.length).toBe(2)
    expect(openai.choices[0].finish_reason).toBe("tool_calls")
  })

  test("tool result round-trip preserves tool_use_id", () => {
    const payload = { messages: [{ role: "tool", tool_call_id: "call_1", content: "ok" }] }
    const { messages } = toAnthropicMessages(payload, "m")
    expect(messages[0].content[0].tool_use_id).toBe("call_1")
  })
})

// ---------------------------------------------------------------- ASAR edge cases: prompt detection, trailing continuation, coalesce

describe("verdent ASAR edge cases", () => {
  test("lastUserText handles string and array content", () => {
    expect(lastUserText({ messages: [{ role: "user", content: "hello" }] })).toBe("hello")
    expect(
      lastUserText({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      }),
    ).toBe("ab")
    expect(
      lastUserText({
        messages: [
          { role: "user", content: "  " },
          { role: "user", content: "real" },
        ],
      }),
    ).toBe("real")
    expect(lastUserText({ messages: [{ role: "tool", content: "x" }] })).toBe("")
    // picks last user, not assistant
    expect(
      lastUserText({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "second" },
        ],
      }),
    ).toBe("second")
  })

  test("coalesceAdjacentMessages merges same-role", () => {
    const input: any[] = [
      { role: "user", content: [{ type: "text", text: "a" }], model: "m" },
      { role: "user", content: [{ type: "text", text: "b" }], model: "m" },
      { role: "assistant", content: [{ type: "text", text: "hi" }], model: "m" },
    ]
    const out = coalesceAdjacentMessages(input)
    expect(out.length).toBe(2)
    expect(out[0].content.length).toBe(2)
  })

  test("ensureTrailingUserContinuation appends when assistant last without tool_use", () => {
    const msgs: any[] = [{ role: "assistant", content: [{ type: "text", text: "done" }], model: "m" }]
    const out = ensureTrailingUserContinuation(msgs)
    expect(out.length).toBe(2)
    expect(out[1].role).toBe("user")
  })

  test("ensureTrailingUserContinuation does not append when tool_use present", () => {
    const msgs: any[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read", input: {} }], model: "m" },
    ]
    expect(ensureTrailingUserContinuation(msgs).length).toBe(1)
  })

  test("ensureTrailingUserContinuation does not append when last is user", () => {
    const msgs: any[] = [{ role: "user", content: [{ type: "text", text: "hi" }], model: "m" }]
    expect(ensureTrailingUserContinuation(msgs).length).toBe(1)
  })

  test("toAnthropicMessages skips mixed empty after fixes still preserves tool_use", () => {
    // opencode often sends assistant with tool_calls and empty content string
    const { messages } = toAnthropicMessages(
      {
        messages: [
          { role: "user", content: "do read" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"x"}' } }],
          },
          { role: "tool", tool_call_id: "c1", content: '{"content":"file"}' },
        ],
      },
      "m",
    )
    expect(messages.length).toBe(3)
    expect(messages[1].content[0].type).toBe("tool_use")
    expect(messages[2].content[0].type).toBe("tool_result")
  })
})

describe("verdent account identity and vault", () => {
  test("context-qualified model ids retain their upstream window", () => {
    expect(splitModelContextSuffix("glm-5.3-flash-free@300k")).toEqual({
      base: "glm-5.3-flash-free",
      tokens: 300_000,
    })
  })

  test("free-model accounting accepts context and account-qualified ids", () => {
    expect(isVerdentFreeModelID("glm-5.3-flash-free")).toBe(true)
    expect(isVerdentFreeModelID("glm-5.3-flash-free@300k@vd-account")).toBe(true)
    expect(isVerdentFreeModelID("glm-5.3-flash")).toBe(false)
  })

  test("free-model snapshots count qualified ids in shared buckets", () => {
    const now = 1_000_000_000
    const snapshot = buildVerdentFreeSnapshot({
      now,
      historyMs: 7 * 24 * 60 * 60 * 1000,
      requests: [
        { at: now - 1_000, modelID: "glm-5.3-flash-free@300k@vd-account" },
        { at: now - 2_000, modelID: "deepseek-v4-flash-free@vd-other" },
      ],
      limitErrors: [{ at: now - 500, modelID: "glm-5.3-flash-free@vd-account", raw: "weekly limit reached" }],
    })
    expect(snapshot.current5hCount).toBe(2)
    expect(snapshot.currentWeekCount).toBe(2)
    expect(snapshot.limitHits[0]?.window).toBe("weekly")
    expect(snapshot.limitHits[0]?.requestsInWeek).toBe(2)
  })

  test("vault save trims and derives missing credential identity", () => {
    const root = mkdtempSync(join(tmpdir(), "verdent-credential-test-"))
    try {
      const vault = new VerdentVault(root)
      const saved = vault.save({
        path: "",
        accessToken: "  opaque-token  ",
        uid: "",
        nickname: "",
        expiresAt: Number.NaN,
      })
      expect(saved.accessToken).toBe("opaque-token")
      expect(saved.uid).toMatch(/^tok-/)
      expect(saved.nickname).toBe(saved.uid)
      expect(saved.expiresAt).toBe(0)
      expect(() => vault.save({ ...saved, accessToken: "   " })).toThrow("accessToken")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("registry imports nested auth-file token shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "verdent-auth-file-test-"))
    try {
      const authPath = join(root, "auth.json")
      writeFileSync(authPath, JSON.stringify({ account: { access_token: "nested-token", uid: "nested-user" } }))
      const registry = new VerdentRegistry({
        authFiles: [authPath],
        vault: new VerdentVault(join(root, "vault")),
        persistenceDir: join(root, "state"),
      })
      expect(registry.all()).toHaveLength(1)
      expect(registry.all()[0]?.credential.accessToken).toBe("nested-token")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("stable identity does not change when nickname changes", () => {
    const credential = {
      path: "old.json",
      accessToken: "opaque-token",
      uid: "verdent-user-1",
      nickname: "old@example.com",
      expiresAt: 0,
    }
    expect(stableVerdentIdentity({ ...credential, nickname: "new@example.com", path: "new.json" })).toBe(
      stableVerdentIdentity(credential),
    )
  })

  test("token rotation updates the existing account instead of creating a second one", () => {
    const root = mkdtempSync(join(tmpdir(), "verdent-accounts-test-"))
    try {
      const registry = new VerdentRegistry({ vault: new VerdentVault(root), persistenceDir: join(root, "state") })
      const payload = Buffer.from(JSON.stringify({ sub: "verdent-user-1" })).toString("base64url")
      const first = registry.importToken(`header.${payload}.first`, "team-1", "first")
      const second = registry.importToken(`header.${payload}.second`, "team-1", "renamed")
      expect(second.id).toBe(first.id)
      expect(registry.all()).toHaveLength(1)
      expect(registry.get(first.id)?.credential.accessToken).toBe(`header.${payload}.second`)
      expect(registry.get(first.id)?.credential.nickname).toBe("renamed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("in-band weekly limits block only the affected account/model bucket", () => {
    const root = mkdtempSync(join(tmpdir(), "verdent-governor-test-"))
    try {
      const governor = new WorkBuddyEntitlementGovernor({ persistenceFile: join(root, "state.json") })
      governor.recordInBandRateLimit("glm-5.3-flash-free", "You've reached the model weekly limit")
      expect(governor.canAdmitModel("glm-5.3-flash-free")).toBe(false)
      expect(governor.canAdmitModel("deepseek-v4-flash-free")).toBe(true)
      expect(governor.metrics().models["glm-5.3-flash-free"]?.exhaustedObserved).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("quota snapshot exposes enrolled accounts before model observations exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "verdent-quota-test-"))
    try {
      setTestVerdentAccountStore(root)
      const vault = new VerdentVault(root)
      const account = vault.save({
        path: "",
        accessToken: "opaque-token",
        uid: "verdent-user-1",
        nickname: "Account A",
        expiresAt: 0,
      })

      const result = await Effect.runPromise(
        verdent({
          snapshot: () =>
            Effect.succeed({
              since: 0,
              until: Date.now(),
              current5hCount: 0,
              currentWeekCount: 0,
              requests: [],
              limitHits: [],
            }),
        }).fetch(),
      )

      expect(result.usage?.verdentAccounts).toEqual([
        {
          accountId: stableVerdentIdentity(account),
          label: "Account A",
          models: [],
        },
      ])
      expect(verdentLimitSnapshot()).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("preserves exact numeric user_id claims from JWT text", () => {
    const userId = "9007199254740993123456789"
    const payload = Buffer.from(`{"user_id":${userId}}`).toString("base64url")
    expect(uidFromToken(`header.${payload}.signature`)).toBe(userId)
  })

  test("desktop import uses profile nickname and keeps one account", async () => {
    const root = mkdtempSync(join(tmpdir(), "verdent-profile-test-"))
    try {
      const registry = new VerdentRegistry({ vault: new VerdentVault(root), persistenceDir: join(root, "state") })
      const payload = Buffer.from('{"user_id":12345678901234567890}').toString("base64url")
      const token = `header.${payload}.signature`
      const account = await registry.importCurrentDesktopAccount(
        async () => token,
        async () => ({ nickname: "person@example.com" }),
      )
      expect(account.uid).toBe("12345678901234567890")
      expect(account.nickname).toBe("person@example.com")
      expect(registry.all()).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("profile lookup prefers email and caches the result", async () => {
    const token = "profile-cache-token"
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (input, init) => {
      calls++
      expect(String(input)).toBe("https://test.verdent/user/center/info")
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`)
      return Response.json({ data: { email: "person@example.com", userKey: "opaque-key" } })
    }) as typeof fetch
    const originalBase = process.env.VERDENT_PROFILE_BASE_URL
    process.env.VERDENT_PROFILE_BASE_URL = "https://test.verdent"
    try {
      expect(await fetchVerdentAccountProfile(token)).toEqual({
        nickname: "person@example.com",
        email: "person@example.com",
        teamId: undefined,
      })
      expect(await fetchVerdentAccountProfile(token)).toEqual({
        nickname: "person@example.com",
        email: "person@example.com",
        teamId: undefined,
      })
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      if (originalBase === undefined) delete process.env.VERDENT_PROFILE_BASE_URL
      else process.env.VERDENT_PROFILE_BASE_URL = originalBase
    }
  })

  test("migrates legacy token-hash account and governor state on import", async () => {
    const root = mkdtempSync(join(tmpdir(), "verdent-migration-test-"))
    try {
      const token = `header.${Buffer.from('{"user_id":9007199254740993123456789}').toString("base64url")}.signature`
      const oldCredential = {
        path: join(root, "verdent-legacy.json"),
        accessToken: token,
        uid: "9007199254740993000000000",
        nickname: "legacy",
        expiresAt: 0,
      }
      writeFileSync(oldCredential.path, JSON.stringify({ schema: 1, enrolledAt: Date.now(), ...oldCredential }), {
        mode: 0o600,
      })
      const oldId = stableVerdentIdentity(oldCredential)
      const stateDir = join(root, "state")
      const oldState = join(stateDir, `${oldId}-verdent-entitlement.json`)
      const newRegistry = new VerdentRegistry({ vault: new VerdentVault(root), persistenceDir: stateDir })
      writeFileSync(oldState, "{}", { mode: 0o600 })

      const account = await newRegistry.importCurrentDesktopAccount(async () => token)
      const newState = join(stateDir, `${account.id}-verdent-entitlement.json`)
      expect(account.uid).toBe("9007199254740993123456789")
      expect(existsSync(newState)).toBe(true)
      expect(existsSync(oldState)).toBe(false)
      expect(newRegistry.all()).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("switching desktop logins keeps every previously imported account", async () => {
    const root = mkdtempSync(join(tmpdir(), "verdent-multi-desktop-test-"))
    try {
      const registry = new VerdentRegistry({ vault: new VerdentVault(root), persistenceDir: join(root, "state") })
      const tokenFor = (userId: string) =>
        `header.${Buffer.from(`{"user_id":${userId}}`).toString("base64url")}.signature`
      const tokenA = tokenFor("11111111111111111111")
      const tokenB = tokenFor("22222222222222222222")

      const accountA = await registry.importCurrentDesktopAccount(
        async () => tokenA,
        async () => ({ nickname: "a@example.com", email: "a@example.com" }),
      )
      // User logs out of A and logs into B in the desktop app, then imports again.
      const accountB = await registry.importCurrentDesktopAccount(
        async () => tokenB,
        async () => ({ nickname: "b@example.com", email: "b@example.com" }),
      )
      expect(accountA.id).not.toBe(accountB.id)
      expect(registry.all()).toHaveLength(2)

      // Desktop logged out entirely (no keychain token): vault accounts survive.
      const freshView = new VerdentRegistry({
        vault: new VerdentVault(root),
        persistenceDir: join(root, "state"),
      })
      expect(freshView.all()).toHaveLength(2)
      const ids = new Set(freshView.all().map((account) => account.id))
      expect(ids.has(accountA.id)).toBe(true)
      expect(ids.has(accountB.id)).toBe(true)

      // Re-importing A after switching back updates it instead of duplicating.
      await registry.importCurrentDesktopAccount(
        async () => tokenA,
        async () => ({ nickname: "a@example.com", email: "a@example.com" }),
      )
      expect(registry.all()).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
