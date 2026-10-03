import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import type { ModelMessage, Tool } from "ai"
import { LLMEvent } from "@opencode-ai/llm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ClaudeRuntimeAdapter, resetSharedState, userHistoryFingerprints } from "../../src/session/llm/claude-runtime"
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

const TEST_CONTEXT = { projectID: "claude", worktree: "/tmp/claude-wt", directory: "/tmp/claude-wt" }
// Runtime is a low-level SDK boundary; always give it an explicit cwd so the
// tests cannot silently rely on a process.cwd() fallback.
const RuntimeCtor = ClaudeAgentRuntime
const testRuntime = (options: ConstructorParameters<typeof ClaudeAgentRuntime>[0] = {}) =>
  new RuntimeCtor({ cwd: TEST_CONTEXT.directory, ...options })

const echoTool = {
  description: "echo fixture",
  execute: async (args: { text: string }) => `echo:${args.text}`,
} as unknown as Tool

const mediaTool = {
  description: "media fixture",
  execute: async () => ({
    title: "image fixture",
    output: "Image read successfully",
    metadata: { fixture: true },
    attachments: [
      {
        type: "file" as const,
        mime: "image/png",
        url: "data:image/png;base64,aGVsbG8=",
      },
    ],
  }),
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
    context: TEST_CONTEXT,
    ...overrides,
  }
}

async function events(stream: ReturnType<typeof ClaudeRuntimeAdapter.stream>) {
  return Effect.runPromise(Stream.runCollect(stream)).then((chunk) => Array.from(chunk))
}

describe("claude runtime integration: fake SDK through the real adapter path", () => {
  test("history fingerprints ignore Plan reminders and promoted tool media", () => {
    const stable = userHistoryFingerprints([
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "answer" },
      {
        role: "user" as const,
        content: "<system-reminder>Plan mode is active.</system-reminder>\n\n two  ",
      },
    ])
    const moved = userHistoryFingerprints([
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "different serialization" },
      { role: "tool" as const, content: [] },
      {
        role: "user" as const,
        content: [{ type: "file", data: "data:image/png;base64,AAAA", mediaType: "image/png" }],
      },
      { role: "user" as const, content: "two" },
      { role: "user" as const, content: "<system-reminder>Plan mode is active.</system-reminder>" },
    ])
    expect(stable).toEqual(moved)
    expect(stable).toHaveLength(2)
  })

  test("tool_use executes through BridgeStore + Permission and the turn continues to completion", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
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

  test("tool-result image attachments stay structured through the fallback continuation", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
    const store = new BridgeStore()
    const bindings = makeMemoryStorage()
    const done = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          store,
          bindings: bindings as BindingStorage,
          tools: { media: mediaTool },
          messages: [{ role: "user" as const, content: "read the image" }],
        }),
      ),
    )

    script.push({ type: "system", subtype: "init", session_id: "ext-media-1" })
    script.push({
      type: "assistant",
      session_id: "ext-media-1",
      message: {
        content: [{ type: "tool_use", id: "call-media", name: "media", input: {} }],
      },
    })

    await script.nextPromptMessage()
    const fedBack = await script.nextPromptMessage()
    const block = fedBack.message.content[0]
    expect(block.type).toBe("tool_result")
    expect(block.tool_use_id).toBe("call-media")
    expect(Array.isArray(block.content)).toBe(true)
    expect(block.content).toEqual([
      { type: "text", text: "Image read successfully" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ])

    script.push({
      type: "assistant",
      session_id: "ext-media-1",
      message: { content: [{ type: "text", text: "I can see it." }] },
    })
    script.push({ type: "result", subtype: "success", is_error: false, result: "I can see it.", session_id: "ext-media-1" })
    script.end()

    const list = await done
    const result = list.find(LLMEvent.is.toolResult)
    expect(result?.result.type).toBe("json")
    expect((result?.result.value as any)?.output).toBe("Image read successfully")
    expect((result?.result.value as any)?.attachments?.[0]).toMatchObject({
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,aGVsbG8=",
    })
  })

  test("auto-heals upstream grep tool_use into canonical find in execution and transcript events", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
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
    const runtime = testRuntime({
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
        content: [{ type: "tool_use", id: "call-mcp-1", name: "mcp__openfork__todo_write", input: { text: "hi" } }],
      },
    })

    await script.waitForRequest(1)
    expect(mcpOptions.tools).toHaveLength(1)
    expect(mcpOptions.tools[0].name).toBe("todo_write")
    expect(script.requests[0].options.tools).toEqual([])
    expect(script.requests[0].options.allowedTools).toEqual(["mcp__openfork__todo_write"])
    expect(Object.keys(script.requests[0].options.mcpServers as Record<string, unknown>)).toEqual(["openfork"])
    expect(script.requests[0].options.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      append: expect.stringContaining("running in OpenFork through the Claude Code harness"),
    })
    const aliases = script.requests[0].options.toolAliases as Record<string, string>
    expect(aliases["TodoWrite"]).toBeUndefined()
    expect(aliases["TodoRead"]).toBeUndefined()
    expect(aliases["todo_write"]).toBe("mcp__openfork__todo_write")

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

  test("Code Mode catalog stays ToolRegistry-owned and reaches Claude through the execute tool description", async () => {
    resetSharedState()
    const script = new SdkScript()
    let mcpOptions: any
    const runtime = testRuntime({
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
    const execute = {
      description: [
        "Run a confined orchestration script with access to connected MCP tools.",
        "# Code Mode",
        "## Available tools (COMPLETE list)",
        "tools.github.list_issues(input: {}): Promise<unknown>",
      ].join("\n"),
      execute: async () => "ok",
    } as unknown as Tool
    const pending = events(ClaudeRuntimeAdapter.stream(baseInput({ runtime, tools: { execute } })))

    script.push({ type: "system", subtype: "init", session_id: "ext-code-mode-1" })
    await script.waitForRequest(1)
    expect(mcpOptions.tools).toHaveLength(1)
    expect(mcpOptions.tools[0].name).toBe("execute")
    expect(mcpOptions.tools[0].description).toContain("# Code Mode")
    expect(mcpOptions.tools[0].description).toContain("tools.github.list_issues")
    expect(String((script.requests[0].options.systemPrompt as { append?: string }).append ?? "")).not.toContain(
      "# Code Mode",
    )

    script.push({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "ext-code-mode-1" })
    script.end()
    await pending
  })

  test("MCP path auto-heals hidden upstream grep alias without registering a grep schema", async () => {
    resetSharedState()
    const script = new SdkScript()
    let mcpOptions: any
    const runtime = testRuntime({
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
    expect(script.requests[0].options.allowedTools).toEqual(["mcp__openfork__find"])
    const aliases = script.requests[0].options.toolAliases as Record<string, string>
    expect(aliases.grep).toBe("mcp__openfork__find")
    expect(aliases.GREP).toBe("mcp__openfork__find")
    expect(aliases.gLoB).toBe("mcp__openfork__find")

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
    const runtime = testRuntime({
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
    const runtime = testRuntime({
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
    expect(aliases.grep).toBe("mcp__openfork__grep")
    expect(aliases.Grep).toBe("mcp__openfork__grep")
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

  test("session-scoped refusal fallback emits a visible note plus host-owned model switch metadata", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
    const pending = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          modelID: "claude-fable-5-1[1m]",
        }),
      ),
    )

    script.push({ type: "system", subtype: "init", session_id: "ext-fallback-1" })
    script.push({
      type: "system",
      subtype: "model_refusal_fallback",
      scope: "session",
      original_model: "claude-fable-5-1[1m]",
      fallback_model: "claude-opus-5-5",
      api_refusal_category: "bio",
    })
    script.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "answer from opus" }] },
    })
    script.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "answer from opus",
      session_id: "ext-fallback-1",
    })
    script.end()

    const list = await pending
    const start = list.find(
      (event) =>
        event.type === "reasoning-start" &&
        event.providerMetadata?.claude?.event === "model_refusal_fallback",
    )
    expect(start?.type).toBe("reasoning-start")
    if (!start || start.type !== "reasoning-start") throw new Error("missing Claude fallback reasoning event")
    expect(start.providerMetadata?.claude).toMatchObject({
      event: "model_refusal_fallback",
      scope: "session",
      originalModelID: "claude-fable-5-1[1m]",
      fallbackModelID: "claude-opus-5-5[1m]",
      category: "bio",
    })
    const note = list
      .filter((event) => event.type === "reasoning-delta")
      .map((event) => event.text)
      .join("")
    expect(note).toContain("Fable 5.1 declined this request (bio)")
    expect(note).toContain("Opus 5.5 answered")
    expect(list.find((event) => event.type === "text-delta")?.text).toBe("answer from opus")
  })

  test("session-scoped fallback rebinds the Claude transcript so the fallback model resumes it next turn", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
    const bindings = makeMemoryStorage()

    const first = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: bindings as BindingStorage,
          tools: {},
          modelID: "claude-fable-5-1[1m]",
          messages: [{ role: "user" as const, content: "one" }],
        }),
      ),
    )
    script.push({ type: "system", subtype: "init", session_id: "ext-fallback-resume" })
    script.push({
      type: "system",
      subtype: "model_refusal_fallback",
      scope: "session",
      original_model: "claude-fable-5-1[1m]",
      fallback_model: "claude-opus-5-5",
    })
    script.push({
      type: "assistant",
      uuid: "leaf-opus",
      parent_tool_use_id: null,
      session_id: "ext-fallback-resume",
      message: { content: [{ type: "text", text: "answered by opus" }] },
    })
    script.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "answered by opus",
      session_id: "ext-fallback-resume",
    })
    script.end()
    await first

    const rebound = bindings.map.get("claude/binding/claude/sess-opencode-1")
    expect(rebound?.modelFamily).toBe("claude-opus-5")
    expect(rebound?.leafUuid).toBe("leaf-opus")

    const second = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: bindings as BindingStorage,
          tools: {},
          modelID: "claude-opus-5-5[1m]",
          messages: [
            { role: "user" as const, content: "one" },
            { role: "assistant" as const, content: "answered by opus" },
            { role: "user" as const, content: "two" },
          ],
          transcriptExists: async () => true,
          transcriptHasEntry: async (_sessionID, uuid) => uuid === "leaf-opus",
        }),
      ),
    )
    await script.waitForRequest(2)
    expect(script.requests[1]?.options.resume).toBe("ext-fallback-resume")
    expect(script.requests[1]?.options.resumeSessionAt).toBe("leaf-opus")
    script.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      session_id: "ext-fallback-resume",
    })
    script.end()
    await second
  })

  test("isolated maintenance turns neither touch the primary binding nor cancel its bridge rows", async () => {
    resetSharedState()
    const bindings = makeMemoryStorage()
    const store = new BridgeStore()
    const primaryScript = new SdkScript()
    const primaryRuntime = testRuntime({ loader: async () => fakeSdk(primaryScript) as never })
    const primary = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime: primaryRuntime,
          bindings: bindings as BindingStorage,
          store,
          tools: {},
          messages: [{ role: "user" as const, content: "primary" }],
        }),
      ),
    )
    primaryScript.push({ type: "system", subtype: "init", session_id: "ext-primary" })
    primaryScript.push({
      type: "assistant",
      uuid: "leaf-primary",
      parent_tool_use_id: null,
      session_id: "ext-primary",
      message: { content: [{ type: "text", text: "primary answer" }] },
    })
    primaryScript.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "primary answer",
      session_id: "ext-primary",
    })
    primaryScript.end()
    await primary

    const bindingBefore = bindings.map.get("claude/binding/claude/sess-opencode-1")
    expect(bindingBefore?.leafUuid).toBe("leaf-primary")
    store.park({
      callID: "primary-live-tool",
      tool: "echo-claude",
      input: {},
      sessionID: "sess-opencode-1",
      scope: { ...TEST_CONTEXT, cwd: TEST_CONTEXT.directory },
    })

    const maintenanceScript = new SdkScript()
    const maintenanceRuntime = testRuntime({ loader: async () => fakeSdk(maintenanceScript) as never })
    const maintenance = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime: maintenanceRuntime,
          bindings: bindings as BindingStorage,
          store,
          continuity: "isolated",
          modelID: "claude-haiku-4-5-20251001",
          tools: {},
          messages: [{ role: "user" as const, content: "generate a title" }],
        }),
      ),
    )
    maintenanceScript.push({ type: "system", subtype: "init", session_id: "ext-maintenance" })
    maintenanceScript.push({
      type: "system",
      subtype: "model_refusal_fallback",
      scope: "session",
      original_model: "claude-haiku-4-5-20251001",
      fallback_model: "claude-sonnet-5",
    })
    maintenanceScript.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "title",
      session_id: "ext-maintenance",
    })
    maintenanceScript.end()
    const maintenanceEvents = await maintenance

    expect(maintenanceScript.requests[0]?.options.resume).toBeUndefined()
    expect(maintenanceScript.requests[0]?.options.resumeSessionAt).toBeUndefined()
    expect(maintenanceScript.requests[0]?.options.persistSession).toBe(false)
    expect(bindings.map.get("claude/binding/claude/sess-opencode-1")).toBe(bindingBefore)
    expect(store.get("primary-live-tool")?.status).toBe("pending")
    expect(
      maintenanceEvents.some(
        (event) =>
          event.type === "reasoning-start" &&
          event.providerMetadata?.claude?.event === "model_refusal_fallback",
      ),
    ).toBe(false)
    expect(
      maintenanceEvents
        .filter((event) => event.type === "reasoning-delta")
        .map((event) => event.text)
        .join(""),
    ).toContain("answered")
  })

  test("second turn resumes the bound external session with only the new user text", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
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

  test("resumed turn does not rewrite an unchanged binding at terminal settlement", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
    const memory = makeMemoryStorage()
    let writes = 0
    const bindings: BindingStorage = {
      read: memory.read,
      write: (key, binding) =>
        Effect.sync(() => {
          writes += 1
          memory.map.set(key.join("/"), binding)
        }),
      remove: memory.remove,
      list: memory.list,
    }

    const first = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings,
          messages: [{ role: "user" as const, content: "one" }],
        }),
      ),
    )
    script.push({ type: "system", subtype: "init", session_id: "ext-write-1" })
    script.push({ type: "result", subtype: "success", is_error: false, result: "one", session_id: "ext-write-1" })
    script.end()
    await first
    expect(writes).toBe(1)

    const second = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings,
          messages: [
            { role: "user" as const, content: "one" },
            { role: "assistant" as const, content: "one" },
            { role: "user" as const, content: "two" },
          ],
        }),
      ),
    )
    await script.waitForRequest(2)
    script.push({ type: "result", subtype: "success", is_error: false, result: "two", session_id: "ext-write-1" })
    script.end()
    await second

    // The second write records the new OpenFork turn boundary. Settlement has
    // no new Claude leaf/model state, so it must not write the same binding
    // again.
    expect(writes).toBe(2)
  })

  test("full-history follow-up pins resume to OpenFork's last observed Claude leaf", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
    const bindings = makeMemoryStorage()

    const first = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: bindings as BindingStorage,
          messages: [{ role: "user" as const, content: "one" }],
        }),
      ),
    )
    script.push({ type: "system", subtype: "init", session_id: "ext-pin-1" })
    script.push({
      type: "assistant",
      uuid: "leaf-1",
      parent_tool_use_id: null,
      session_id: "ext-pin-1",
      message: { content: [{ type: "text", text: "answer one" }] },
    })
    script.push({ type: "result", subtype: "success", is_error: false, result: "answer one", session_id: "ext-pin-1" })
    script.end()
    await first

    const savedFirst = bindings.map.get("claude/binding/claude/sess-opencode-1")
    expect(savedFirst?.leafUuid).toBe("leaf-1")
    expect(savedFirst?.turns).toHaveLength(1)

    const second = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: bindings as BindingStorage,
          messages: [
            { role: "user" as const, content: "one" },
            { role: "assistant" as const, content: "answer one" },
            { role: "user" as const, content: "two" },
          ],
          transcriptExists: async () => true,
          transcriptHasEntry: async (_sessionID, uuid) => uuid === "leaf-1",
        }),
      ),
    )
    await script.waitForRequest(2)
    expect(script.requests[1]?.options.resume).toBe("ext-pin-1")
    expect(script.requests[1]?.options.resumeSessionAt).toBe("leaf-1")

    const resumedPrompt = await script.nextPromptMessage()
    expect(resumedPrompt.message.content).toBe("two")

    script.push({
      type: "assistant",
      uuid: "leaf-2",
      parent_tool_use_id: null,
      session_id: "ext-pin-1",
      message: { content: [{ type: "text", text: "answer two" }] },
    })
    script.push({ type: "result", subtype: "success", is_error: false, result: "answer two", session_id: "ext-pin-1" })
    script.end()
    await second

    const savedSecond = bindings.map.get("claude/binding/claude/sess-opencode-1")
    expect(savedSecond?.leafUuid).toBe("leaf-2")
    expect(savedSecond?.turns).toHaveLength(2)
    expect(savedSecond?.turns?.at(-1)?.leafUuid).toBe("leaf-2")
  })

  test("cancelled first turn persists the drained interruption leaf for the next resume", async () => {
    resetSharedState()
    const script = new SdkScript()
    let queryIndex = 0
    const runtime = testRuntime({
      timeouts: { stopGraceMs: 50 },
      loader: async () =>
        ({
          query: (request: { prompt: unknown; options: Record<string, unknown> }) => {
            script.requests.push(request)
            const turn = queryIndex++
            return {
              events: script.events,
              pid: 9000 + turn,
              interrupt: async () => {
                if (turn !== 0) return
                script.push({
                  type: "user",
                  uuid: "interrupt-marker",
                  parent_tool_use_id: null,
                  session_id: "ext-interrupt-1",
                  message: {
                    content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
                  },
                })
                script.push({
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  terminal_reason: "aborted_tools",
                  session_id: "ext-interrupt-1",
                })
                script.end()
              },
              close: () => script.end(),
            }
          },
        }) as never,
    })
    const bindings = makeMemoryStorage()
    const controller = new AbortController()
    const first = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: bindings as BindingStorage,
          abort: controller.signal,
          messages: [{ role: "user" as const, content: "run it" }],
        }),
      ),
    )
    await script.waitForRequest(1)
    script.push({ type: "system", subtype: "init", session_id: "ext-interrupt-1" })
    script.push({
      type: "assistant",
      uuid: "tool-use-leaf",
      parent_tool_use_id: null,
      session_id: "ext-interrupt-1",
      message: { content: [] },
    })
    controller.abort()
    await first

    const afterCancel = bindings.map.get("claude/binding/claude/sess-opencode-1")
    expect(afterCancel?.claudeSessionID).toBe("ext-interrupt-1")
    expect(afterCancel?.leafUuid).toBe("interrupt-marker")
    expect(afterCancel?.turns?.at(-1)?.leafUuid).toBe("interrupt-marker")

    const second = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: bindings as BindingStorage,
          messages: [
            { role: "user" as const, content: "run it" },
            { role: "assistant" as const, content: "interrupted" },
            { role: "user" as const, content: "do something else" },
          ],
          transcriptHasEntry: async (_sessionID, uuid) => uuid === "interrupt-marker",
        }),
      ),
    )
    await script.waitForRequest(2)
    expect(script.requests[1]?.options.resume).toBe("ext-interrupt-1")
    expect(script.requests[1]?.options.resumeSessionAt).toBe("interrupt-marker")
    script.push({
      type: "assistant",
      uuid: "leaf-after-interrupt",
      parent_tool_use_id: null,
      session_id: "ext-interrupt-1",
      message: { content: [{ type: "text", text: "ok" }] },
    })
    script.push({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "ext-interrupt-1" })
    script.end()
    await second
  })

  test("edited OpenFork history rewinds Claude to the matching transcript leaf", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
    const bindings = makeMemoryStorage()
    let requestCount = 0

    const turn = async (
      messages: readonly ModelMessage[],
      leaf: string,
      answer: string,
      resumeSessionAt?: string,
    ) => {
      const pending = events(
        ClaudeRuntimeAdapter.stream(
          baseInput({
            runtime,
            bindings: bindings as BindingStorage,
            messages,
            transcriptHasEntry: async () => true,
          }),
        ),
      )
      requestCount += 1
      await script.waitForRequest(requestCount)
      const options = script.requests[requestCount - 1]!.options
      if (requestCount === 1) {
        expect(options.resume).toBeUndefined()
        expect(options.resumeSessionAt).toBeUndefined()
      } else {
        expect(options.resume).toBe("ext-edit-1")
        expect(options.resumeSessionAt).toBe(resumeSessionAt)
      }
      script.push({ type: "system", subtype: "init", session_id: "ext-edit-1" })
      script.push({
        type: "assistant",
        uuid: leaf,
        parent_tool_use_id: null,
        session_id: "ext-edit-1",
        message: { content: [{ type: "text", text: answer }] },
      })
      script.push({ type: "result", subtype: "success", is_error: false, result: answer, session_id: "ext-edit-1" })
      script.end()
      await pending
    }

    await turn([{ role: "user" as const, content: "u1" }], "L1", "a1")
    await turn(
      [
        { role: "user" as const, content: "u1" },
        { role: "assistant" as const, content: "a1" },
        { role: "user" as const, content: "u2" },
      ],
      "L2",
      "a2",
      "L1",
    )
    await turn(
      [
        { role: "user" as const, content: "u1" },
        { role: "assistant" as const, content: "a1" },
        { role: "user" as const, content: "u2" },
        { role: "assistant" as const, content: "a2" },
        { role: "user" as const, content: "u3" },
      ],
      "L3",
      "a3",
      "L2",
    )

    // Editing the latest request removes L3 from OpenFork history. The new
    // branch must start at L2, not at the transcript's newest entry.
    await turn(
      [
        { role: "user" as const, content: "u1" },
        { role: "assistant" as const, content: "a1" },
        { role: "user" as const, content: "u2" },
        { role: "assistant" as const, content: "a2" },
        { role: "user" as const, content: "u3 edited" },
      ],
      "L3b",
      "a3b",
      "L2",
    )

    // Editing an older request rewinds farther and trims the abandoned branch.
    await turn(
      [
        { role: "user" as const, content: "u1" },
        { role: "assistant" as const, content: "a1" },
        { role: "user" as const, content: "u2 edited" },
      ],
      "L2b",
      "a2b",
      "L1",
    )

    const saved = bindings.map.get("claude/binding/claude/sess-opencode-1")
    expect(saved?.leafUuid).toBe("L2b")
    expect(saved?.turns).toHaveLength(2)
    expect(saved?.turns?.map((boundary) => boundary.leafUuid)).toEqual(["L1", "L2b"])
  })

  test("failed resumed turn keeps a compact-summary leaf as the next safe resume point", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
    const bindings = makeMemoryStorage()

    const first = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: bindings as BindingStorage,
          messages: [{ role: "user" as const, content: "one" }],
        }),
      ),
    )
    script.push({ type: "system", subtype: "init", session_id: "ext-compact-1" })
    script.push({
      type: "assistant",
      uuid: "leaf-1",
      parent_tool_use_id: null,
      session_id: "ext-compact-1",
      message: { content: [{ type: "text", text: "answer one" }] },
    })
    script.push({ type: "result", subtype: "success", is_error: false, result: "answer one", session_id: "ext-compact-1" })
    script.end()
    await first

    const secondMessages = [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "answer one" },
      { role: "user" as const, content: "two" },
    ]
    const second = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: bindings as BindingStorage,
          messages: secondMessages,
          transcriptHasEntry: async (_sessionID, uuid) => uuid === "leaf-1",
        }),
      ),
    )
    await script.waitForRequest(2)
    expect(script.requests[1]?.options.resumeSessionAt).toBe("leaf-1")
    script.push({
      type: "assistant",
      uuid: "pre-compact",
      parent_tool_use_id: null,
      session_id: "ext-compact-1",
      message: { content: [{ type: "text", text: "partial" }] },
    })
    script.push({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary",
      session_id: "ext-compact-1",
      compact_metadata: { trigger: "auto", pre_tokens: 190000 },
    })
    script.push({
      type: "user",
      uuid: "summary",
      isSynthetic: true,
      parent_tool_use_id: null,
      session_id: "ext-compact-1",
      message: { content: [{ type: "text", text: "This session is being continued..." }] },
    })
    script.push({
      type: "user",
      uuid: "stdout",
      isReplay: true,
      parent_tool_use_id: null,
      session_id: "ext-compact-1",
      message: { content: [{ type: "text", text: "<local-command-stdout>Compacted</local-command-stdout>" }] },
    })
    script.push({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["API Error: 500 boom"],
      session_id: "ext-compact-1",
    })
    script.end()
    await second

    const afterFailure = bindings.map.get("claude/binding/claude/sess-opencode-1")
    expect(afterFailure?.invalidationReason).toBeUndefined()
    expect(afterFailure?.leafUuid).toBe("summary")
    expect(afterFailure?.turns?.at(-1)?.leafUuid).toBe("summary")

    const third = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          bindings: bindings as BindingStorage,
          messages: [
            ...secondMessages,
            { role: "assistant" as const, content: "partial" },
            { role: "user" as const, content: "three" },
          ],
          transcriptHasEntry: async (_sessionID, uuid) => uuid === "summary",
        }),
      ),
    )
    await script.waitForRequest(3)
    expect(script.requests[2]?.options.resume).toBe("ext-compact-1")
    expect(script.requests[2]?.options.resumeSessionAt).toBe("summary")
    script.push({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "ext-compact-1" })
    script.end()
    await third
  })

  test("denied tool surfaces tool-error, feeds is_error back, and the turn still completes", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
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

  test("permission infrastructure failure surfaces the real cause, not a denial", async () => {
    resetSharedState()
    const script = new SdkScript()
    const runtime = testRuntime({ loader: async () => fakeSdk(script) as never })
    const store = new BridgeStore()

    const pending = events(
      ClaudeRuntimeAdapter.stream(
        baseInput({
          runtime,
          store,
          // Mirrors a missing InstanceRef: the check cannot run at all, which
          // must not be misreported to the model as a policy denial.
          permission: { ask: () => Effect.die(new Error("InstanceRef not provided")) },
        }),
      ),
    )

    script.push({ type: "system", subtype: "init", session_id: "ext-rt-infra" })
    script.push({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "call-infra", name: "echo-claude", input: { text: "hi" } }],
      },
    })

    await script.nextPromptMessage() // initial prompt
    const fedBack = await script.nextPromptMessage()
    const block = fedBack.message.content[0]
    expect(block.is_error).toBe(true)
    expect(block.content).toContain("permission check failed")

    script.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "understood" }] },
    })
    script.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "understood",
      session_id: "ext-rt-infra",
    })
    script.end()

    const list = await pending
    const toolError = list.find((event) => event.type === "tool-error")
    expect(toolError?.message).toContain("tool permission check failed")
    expect(store.get("call-infra")?.status).not.toBe("denied")
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
