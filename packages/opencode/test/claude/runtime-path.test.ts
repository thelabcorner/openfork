import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import type { Tool } from "ai"
import { LLMEvent } from "@opencode-ai/llm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ClaudeRuntimeAdapter, resetSharedState } from "../../src/session/llm/claude-runtime"
import { markCanonicalFindToolMap } from "../../src/session/llm/tool-call-heal"
import { ClaudeAgentRuntime } from "../../src/claude/runtime"
import { BridgeStore } from "../../src/claude/bridge"
import { makeMemoryStorage, type BindingStorage } from "../../src/claude/sessions"

// Fake Agent SDK module: query() captures each request and hands back a
// push-controlled event stream plus the streaming-input iterator so the script
// can wait for OpenCode's tool_result feedback exactly like the real CLI does.

class SdkScript {
  requests: Array<{ prompt: unknown; options: Record<string, unknown> }> = []
  private queue: unknown[] = []
  private resolvers: Array<(result: IteratorResult<unknown>) => void> = []
  private iterators = new Map<number, AsyncIterator<unknown>>()

  push(value: unknown) {
    const resolver = this.resolvers.shift()
    if (resolver) resolver({ done: false, value })
    else this.queue.push(value)
  }

  end() {
    for (const resolver of this.resolvers.splice(0)) resolver({ done: true, value: undefined })
  }

  get events(): AsyncIterable<unknown> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<unknown>>((resolve) => {
              const value = self.queue.shift()
              if (value !== undefined) return resolve({ done: false, value })
              self.resolvers.push(resolve)
            }),
        }
      },
    }
  }

  /** Await the next message OpenCode feeds back through the prompt channel. */
  async nextPromptMessage(): Promise<any> {
    if (this.requests.length === 0) await this.waitForRequest(1)
    const index = this.requests.length - 1
    const handle = this.requests.at(-1)!
    let iterator = this.iterators.get(index)
    if (!iterator) {
      iterator = (handle.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      this.iterators.set(index, iterator)
    }
    const result = await iterator.next()
    return result.value
  }

  async waitForRequest(count: number): Promise<void> {
    const deadline = Date.now() + 2000
    while (this.requests.length < count) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for query #${count}`)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
}

function fakeSdk(script: SdkScript) {
  return {
    query: (request: { prompt: unknown; options: Record<string, unknown> }) => {
      script.requests.push(request)
      return {
        events: script.events,
        interrupt: async () => {},
        close: () => script.end(),
        pid: 4242,
      }
    },
  }
}

const echoTool = {
  description: "echo fixture",
  execute: async (args: { text: string }) => `echo:${args.text}`,
} as unknown as Tool

const findTool = {
  description: "find fixture",
  execute: async (args: { glob?: string; grep?: string; path?: string; include?: string }) =>
    `find:${args.glob ?? args.grep}:${args.path ?? ""}:${args.include ?? ""}`,
} as unknown as Tool

function baseInput(overrides: Partial<Parameters<typeof ClaudeRuntimeAdapter.stream>[0]> = {}) {
  const abort = new AbortController().signal
  return {
    sessionID: "sess-opencode-1",
    system: ["You are terse."],
    messages: [{ role: "user" as const, content: "say hi via the tool" }],
    tools: { "echo-claude": echoTool },
    modelID: "claude-sonnet-4-5-20251101",
    providerID: "claude",
    abort,
    permission: { ask: () => Effect.void },
    ruleset: [],
    ...overrides,
  }
}

async function events(stream: ReturnType<typeof ClaudeRuntimeAdapter.stream>) {
  return Effect.runPromise(Stream.runCollect(stream)).then((chunk) => Array.from(chunk))
}

describe("claude runtime integration: fake SDK through the real adapter path", () => {
  test("tool_use executes through BridgeStore + Permission and the turn continues to completion", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = new ClaudeAgentRuntime({ loader: async () => fakeSdk(script) as never })
    const store = new BridgeStore()
    const bindings = makeMemoryStorage()

    const done = events(
      ClaudeRuntimeAdapter.stream(baseInput({ runtime, store, bindings: bindings as BindingStorage })),
    ).then(async (list) => {
      // Script runs while the consumer drains; drive it here in parallel.
      return list
    })

    // Drive the scripted SDK conversation.
    script.push({ type: "system", subtype: "init", session_id: "ext-rt-1" })
    script.push({
      type: "assistant",
      session_id: "ext-rt-1",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-5",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call-1", name: "echo-claude", input: { text: "hi" } },
        ],
      },
    })

    // First fed-back message is the assembled initial prompt.
    const initial = await script.nextPromptMessage()
    expect(initial.type).toBe("user")
    expect(initial.message.role).toBe("user")
    expect(initial.parent_tool_use_id).toBe(null)
    expect(initial.message.content).toContain("say hi via the tool")

    const fedBack = await script.nextPromptMessage()
    expect(fedBack.type).toBe("user")
    expect(fedBack.message.role).toBe("user")
    expect(fedBack.parent_tool_use_id).toBe(null)
    const block = fedBack.message.content[0]
    expect(block.type).toBe("tool_result")
    expect(block.tool_use_id).toBe("call-1")
    expect(block.is_error).toBeUndefined()
    expect(block.content).toBe("echo:hi")

    script.push({
      type: "assistant",
      session_id: "ext-rt-1",
      message: { id: "msg_2", content: [{ type: "text", text: "All done." }] },
    })
    script.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "All done.",
      session_id: "ext-rt-1",
      usage: { input_tokens: 12, output_tokens: 7 },
    })
    script.end()

    const list = await done
    const kinds = list.map((event) => event.type)
    expect(kinds[0]).toBe("step-start")
    expect(kinds).toContain("text-delta")
    expect(list.find((event) => event.type === "text-delta")?.text).toBe("Checking.")
    expect(kinds).toContain("tool-call")
    const toolCall = list.find((event) => event.type === "tool-call")
    expect(toolCall?.name).toBe("echo-claude")
    expect(toolCall?.input).toEqual({ text: "hi" })
    const toolResult = list.find((event) => event.type === "tool-result")
    expect(toolResult?.result.value).toBe("echo:hi")
    expect(toolResult?.providerExecuted).toBe(false)
    expect(kinds).toContain("step-finish")
    const finish = list.find(LLMEvent.is.finish)
    expect(finish).toBeDefined()
    expect(finish?.reason).toBe("stop")
    expect(finish?.usage?.inputTokens).toBe(12)
    expect(finish?.usage?.outputTokens).toBe(7)

    // Bridge recorded an exact-once completed settlement.
    const entry = store.get("call-1")
    expect(entry?.status).toBe("completed")
    expect(entry?.continuationDone).toBe(true)

    // Binding persisted for later resume.
    const saved = bindings.map.get(`claude/binding/claude/sess-opencode-1`) as any
    expect(saved?.claudeSessionID).toBe("ext-rt-1")
    expect(saved?.modelFamily).toBe("claude-sonnet-4")
  })

  test("auto-heals upstream grep tool_use into canonical find in execution and transcript events", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = new ClaudeAgentRuntime({ loader: async () => fakeSdk(script) as never })
    const store = new BridgeStore()
    const permissions: string[] = []
    const pending = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          store,
          tools: markCanonicalFindToolMap({ find: findTool }),
          permission: {
            ask: (request) =>
              Effect.sync(() => {
                permissions.push(request.permission)
              }),
          },
        }),
      ),
    )

    script.push({ type: "system", subtype: "init", session_id: "ext-heal-1" })
    script.push({
      type: "assistant",
      session_id: "ext-heal-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call-heal-1",
            name: "grep",
            input: { pattern: "SessionIngress", path: "src", include: "*.{ts,tsx}" },
          },
        ],
      },
    })

    await script.nextPromptMessage()
    const fedBack = await script.nextPromptMessage()
    expect(fedBack.message.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-heal-1",
      content: "find:SessionIngress:src:*.{ts,tsx}",
    })

    script.push({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } })
    script.push({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "ext-heal-1" })
    script.end()

    const list = await pending
    const call = list.find((event) => event.type === "tool-call")
    expect(call?.name).toBe("find")
    expect(call?.input).toEqual({ grep: "SessionIngress", path: "src", include: "*.{ts,tsx}" })
    const result = list.find((event) => event.type === "tool-result")
    expect(result?.name).toBe("find")
    expect(result?.result.value).toBe("find:SessionIngress:src:*.{ts,tsx}")
    expect(store.get("call-heal-1")?.request.tool).toBe("find")
    expect(permissions).toEqual([])
  })

  test("registers OpenCode tools through the Agent SDK MCP server", async () => {
    resetSharedState()
    const script = new SdkScript()
    let mcpOptions: any
    const runtime = new ClaudeAgentRuntime({
      loader: async () =>
        ({
          createSdkMcpServer: (options: any) => {
            mcpOptions = options
            return { type: "sdk", name: options.name, instance: {} }
          },
          query: (request: any) => {
            script.requests.push(request)
            return { events: script.events, interrupt: async () => {}, close: () => script.end(), pid: 4242 }
          },
        }) as never,
    })
    const store = new BridgeStore()
    const pending = events(ClaudeRuntimeAdapter.stream(baseInput({ runtime, store, tools: { todo_write: echoTool } })))

    script.push({ type: "system", subtype: "init", session_id: "ext-mcp-1" })
    script.push({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "call-mcp-1", name: "mcp__opencode__todo_write", input: { text: "hi" } }],
      },
    })

    await script.waitForRequest(1)
    expect(mcpOptions.tools).toHaveLength(1)
    expect(mcpOptions.tools[0].name).toBe("todo_write")
    expect(script.requests[0].options.tools).toEqual([])
    expect(script.requests[0].options.allowedTools).toEqual(["mcp__opencode__todo_write"])
    expect((script.requests[0].options.toolAliases as Record<string, string>)["TodoWrite"]).toBe(
      "mcp__opencode__todo_write",
    )

    const toolResult = await mcpOptions.tools[0].handler({ text: "hi" }, { signal: new AbortController().signal })
    expect(toolResult.content[0].text).toBe("echo:hi")

    script.push({ type: "assistant", message: { content: [{ type: "text", text: "All done." }] } })
    script.push({ type: "result", subtype: "success", is_error: false, result: "All done.", session_id: "ext-mcp-1" })
    script.end()

    const list = await pending
    expect(list.find((event) => event.type === "tool-call")?.name).toBe("todo_write")
    expect(list.find((event) => event.type === "tool-result")?.result.value).toBe("echo:hi")
    expect(store.get("call-mcp-1")?.status).toBe("completed")
    expect(list.at(-1)?.type).toBe("finish")
  })

  test("MCP path auto-heals hidden upstream grep alias without registering a grep schema", async () => {
    resetSharedState()
    const script = new SdkScript()
    let mcpOptions: any
    const runtime = new ClaudeAgentRuntime({
      loader: async () =>
        ({
          createSdkMcpServer: (options: any) => {
            mcpOptions = options
            return { type: "sdk", name: options.name, instance: {} }
          },
          query: (request: any) => {
            script.requests.push(request)
            return { events: script.events, interrupt: async () => {}, close: () => script.end(), pid: 4242 }
          },
        }) as never,
    })
    const store = new BridgeStore()
    const pending = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          store,
          tools: markCanonicalFindToolMap({ find: findTool }),
        }),
      ),
    )

    script.push({ type: "system", subtype: "init", session_id: "ext-mcp-heal-1" })
    script.push({
      type: "assistant",
      session_id: "ext-mcp-heal-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call-mcp-heal-1",
            name: "grep",
            input: { pattern: "SessionIngress", path: "src", include: "*.{ts,tsx}" },
          },
        ],
      },
    })

    await script.waitForRequest(1)
    expect(mcpOptions.tools).toHaveLength(1)
    expect(mcpOptions.tools[0].name).toBe("find")
    expect(script.requests[0].options.allowedTools).toEqual(["mcp__opencode__find"])
    const aliases = script.requests[0].options.toolAliases as Record<string, string>
    expect(aliases.grep).toBe("mcp__opencode__find")
    expect(aliases.GREP).toBe("mcp__opencode__find")
    expect(aliases.gLoB).toBe("mcp__opencode__find")

    // The Agent SDK resolves the alias by name, then validates against find's
    // canonical schema. Unknown `pattern` is stripped before the handler. Feed
    // exactly that post-validation shape to prove the correlator restores the
    // normalized assistant input rather than executing an empty find request.
    const toolResult = await mcpOptions.tools[0].handler(
      { path: "src", include: "*.{ts,tsx}" },
      { signal: new AbortController().signal },
    )
    expect(toolResult.content[0].text).toBe("find:SessionIngress:src:*.{ts,tsx}")

    script.push({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } })
    script.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      session_id: "ext-mcp-heal-1",
    })
    script.end()

    const list = await pending
    const call = list.find((event) => event.type === "tool-call")
    expect(call?.name).toBe("find")
    expect(call?.input).toEqual({ grep: "SessionIngress", path: "src", include: "*.{ts,tsx}" })
    expect(list.find((event) => event.type === "tool-result")?.name).toBe("find")
    expect(store.get("call-mcp-heal-1")?.request.input).toEqual({
      grep: "SessionIngress",
      path: "src",
      include: "*.{ts,tsx}",
    })
  })

  test("MCP alias correlation matches surviving args when parallel find aliases execute out of order", async () => {
    resetSharedState()
    const script = new SdkScript()
    let mcpOptions: any
    const runtime = new ClaudeAgentRuntime({
      loader: async () =>
        ({
          createSdkMcpServer: (options: any) => {
            mcpOptions = options
            return { type: "sdk", name: options.name, instance: {} }
          },
          query: (request: any) => {
            script.requests.push(request)
            return { events: script.events, interrupt: async () => {}, close: () => script.end(), pid: 4242 }
          },
        }) as never,
    })
    const store = new BridgeStore()
    const pending = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({ runtime, store, tools: markCanonicalFindToolMap({ find: findTool }) }),
      ),
    )

    script.push({ type: "system", subtype: "init", session_id: "ext-mcp-parallel-1" })
    script.push({
      type: "assistant",
      session_id: "ext-mcp-parallel-1",
      message: {
        content: [
          { type: "tool_use", id: "call-glob-first", name: "glob", input: { pattern: "**/*.ts", path: "src" } },
          {
            type: "tool_use",
            id: "call-grep-second",
            name: "grep",
            input: { pattern: "needle", path: "test", include: "*.ts" },
          },
        ],
      },
    })

    await script.waitForRequest(1)
    const findHandler = mcpOptions.tools[0].handler

    // Deliberately execute the second call first. Matching path/include remnants
    // must select call-grep-second rather than blindly consuming FIFO.
    const grepResult = await findHandler(
      { path: "test", include: "*.ts" },
      { signal: new AbortController().signal },
    )
    const globResult = await findHandler({ path: "src" }, { signal: new AbortController().signal })
    expect(grepResult.content[0].text).toBe("find:needle:test:*.ts")
    expect(globResult.content[0].text).toBe("find:**/*.ts:src:")
    expect(store.get("call-grep-second")?.request.input).toEqual({ grep: "needle", path: "test", include: "*.ts" })
    expect(store.get("call-glob-first")?.request.input).toEqual({ glob: "**/*.ts", path: "src" })

    script.push({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } })
    script.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      session_id: "ext-mcp-parallel-1",
    })
    script.end()
    await pending
  })

  test("MCP compatibility aliases never override a genuinely registered grep tool", async () => {
    resetSharedState()
    const script = new SdkScript()
    let mcpOptions: any
    const grepTool = {
      description: "real grep fixture",
      execute: async () => "real-grep",
    } as unknown as Tool
    const runtime = new ClaudeAgentRuntime({
      loader: async () =>
        ({
          createSdkMcpServer: (options: any) => {
            mcpOptions = options
            return { type: "sdk", name: options.name, instance: {} }
          },
          query: (request: any) => {
            script.requests.push(request)
            return { events: script.events, interrupt: async () => {}, close: () => script.end(), pid: 4242 }
          },
        }) as never,
    })
    const pending = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          tools: markCanonicalFindToolMap({ find: findTool, grep: grepTool }),
        }),
      ),
    )

    script.push({ type: "system", subtype: "init", session_id: "ext-mcp-shadow-1" })
    await script.waitForRequest(1)
    const aliases = script.requests[0].options.toolAliases as Record<string, string>
    expect(aliases.grep).toBe("mcp__opencode__grep")
    expect(aliases.Grep).toBe("mcp__opencode__grep")
    expect(mcpOptions.tools.map((tool: { name: string }) => tool.name)).toEqual(["find", "grep"])

    script.push({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } })
    script.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      session_id: "ext-mcp-shadow-1",
    })
    script.end()
    await pending
  })

  test("second turn resumes the bound external session with only the new user text", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = new ClaudeAgentRuntime({ loader: async () => fakeSdk(script) as never })
    const bindings = makeMemoryStorage()
    const shared = { bindings: bindings as BindingStorage }

    const first = events(ClaudeRuntimeAdapter.stream(baseInput({ runtime, bindings: shared.bindings })))
    script.push({ type: "system", subtype: "init", session_id: "ext-rt-9" })
    script.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    })
    script.push({ type: "result", subtype: "success", is_error: false, result: "hello", session_id: "ext-rt-9" })
    script.end()
    await first

    // Second turn on the same OpenCode session must resume ext-rt-9.
    const second = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: shared.bindings,
          messages: [{ role: "user" as const, content: "follow-up question" }],
        }),
      ),
    )
    await script.waitForRequest(2)
    expect(script.requests[1]?.options.resume).toBe("ext-rt-9")
    const resumedPrompt = await script.nextPromptMessage()
    expect(resumedPrompt.message.role).toBe("user")
    expect(resumedPrompt.parent_tool_use_id).toBe(null)
    expect(resumedPrompt.message.content).toBe("follow-up question")

    script.push({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "ext-rt-9" })
    script.end()
    const list = await second
    expect(list.at(-1)?.type).toBe("finish")
  })

  test("denied tool surfaces tool-error, feeds is_error back, and the turn still completes", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = new ClaudeAgentRuntime({ loader: async () => fakeSdk(script) as never })
    const store = new BridgeStore()

    const pending = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          store,
          permission: { ask: () => Effect.fail(new PermissionV1.RejectedError()) },
        }),
      ),
    )

    script.push({ type: "system", subtype: "init", session_id: "ext-rt-2" })
    script.push({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "call-deny", name: "echo-claude", input: { text: "nope" } }],
      },
    })

    await script.nextPromptMessage() // initial prompt
    const fedBack = await script.nextPromptMessage()
    const block = fedBack.message.content[0]
    expect(block.is_error).toBe(true)
    expect(block.content).toContain("denied")

    script.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "understood" }] },
    })
    script.push({ type: "result", subtype: "success", is_error: false, result: "understood", session_id: "ext-rt-2" })
    script.end()

    const list = await pending
    const toolError = list.find((event) => event.type === "tool-error")
    expect(toolError?.message).toBe("tool denied: echo-claude")
    expect(store.get("call-deny")?.status).toBe("denied")
    expect(list.at(-1)?.type).toBe("finish")
  })

  test("rollback gate disables selection without touching the SDK", async () => {
    const off = ClaudeRuntimeAdapter.status({ providerID: "claude", enabled: () => false })
    expect(off.type).toBe("unsupported")
    if (off.type === "unsupported") expect(off.reason).toContain("OPENCODE_DISABLE_CLAUDE_FIRST_PARTY")
    const other = ClaudeRuntimeAdapter.status({ providerID: "openai" })
    expect(other.type).toBe("unsupported")
    const on = ClaudeRuntimeAdapter.status({ providerID: "claude", enabled: () => true })
    expect(on.type).toBe("supported")
  })
})
