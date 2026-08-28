import { describe, it, expect } from "bun:test"
import { ClaudeProvider, migrateLegacyReference } from "../../src/claude/provider"
import { MODEL_IDS, MODEL_METADATA, OPENAI_COMPATIBLE_NPM, modelApi } from "../../src/claude/models"

describe("provider-wiring: claude integration", () => {
  it("discoverPure is pure/static with no SDK load or CLI spawn", () => {
    const result = ClaudeProvider.discoverPure()
    expect(String(result.providerID)).toBe("claude")
    expect(result.status).toBe("unavailable")
    expect(result.errorCategory).toBe("setup")
    expect(typeof result.setupState).toBe("object")
    expect(result.setupState!.executableDetected).toBe(false)
  })

  it("legacy aliases resolve through migrateLegacyReference", () => {
    expect(migrateLegacyReference("claude/sonnet")).toBe("claude-sonnet-4-5-20251101")
    expect(migrateLegacyReference("claude/opus")).toBe("claude-opus-4-6")
    expect(migrateLegacyReference("claude-sonnet-4-5-20251101")).toBe("claude-sonnet-4-5-20251101")
    expect(migrateLegacyReference("unknown")).toBeUndefined()
  })

  it("model metadata covers all canonical IDs with capabilities", () => {
    for (const id of MODEL_IDS) {
      const meta = MODEL_METADATA[id]
      expect(meta).toBeDefined()
      expect(meta!.capabilities.toolcall).toBe(true)
      expect(meta!.capabilities.reasoning).toBe(true)
    }
  })

  it("provider loader preserves unavailable/setup states", () => {
    const discovery = ClaudeProvider.discoverPure()
    expect(discovery.status).toBe("unavailable")
    expect(discovery.setupState!.cliAuthStatus).toBe("unknown")
    expect(discovery.setupState!.requiresApproval).toBe(false)
  })

  it("host-visible models use openai-compatible npm like opencode-claude", () => {
    expect(OPENAI_COMPATIBLE_NPM).toBe("@ai-sdk/openai-compatible")
    expect(modelApi("sonnet").npm).toBe(OPENAI_COMPATIBLE_NPM)
    expect(modelApi("sonnet").url).toContain("127.0.0.1")
  })

  it("sdk user prompt matches opencode-claude streaming-input shape", async () => {
    const { sdkUserPrompt } = await import("../../src/session/llm/claude-runtime")
    expect(sdkUserPrompt("hi")).toEqual({
      type: "user",
      message: { role: "user", content: "hi" },
      parent_tool_use_id: null,
    })
  })

  it("auth methods match plugin labels", async () => {
    const { buildClaudeAuthMethods } = await import("../../src/plugin/claude")
    expect(buildClaudeAuthMethods(true, ".").map((m) => m.label)).toEqual(["Sign in with Claude Code CLI"])
    expect(buildClaudeAuthMethods(false, ".").map((m) => m.label)).toEqual(["Install Claude Code CLI and sign in"])
  })

  it("buildPrompt omits OpenCode system and wraps history like the plugin", async () => {
    const { buildPrompt } = await import("../../src/session/llm/claude-runtime")
    expect(
      buildPrompt({
        system: ["You are OpenCode."],
        messages: [{ role: "user", content: "hello" }],
        resume: false,
      }),
    ).toBe("hello")
    const transferred = buildPrompt({
      system: ["ignored"],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
      resume: false,
    })
    expect(transferred).toContain("<conversation_history>")
    expect(transferred).toContain("User:\nfirst")
    expect(transferred).toContain("Latest user message:\nsecond")
    expect(transferred).not.toContain("ignored")
    expect(buildPrompt({ system: [], messages: [{ role: "user", content: "only" }], resume: true })).toBe("only")
  })

  it("buildPrompt returns Anthropic blocks for attachments (matches plugin latestUserPrompt)", async () => {
    const { buildPrompt } = await import("../../src/session/llm/claude-runtime")
    // fresh turn, only current user with attach → blocks directly (no history wrapper needed)
    const withImage = buildPrompt({
      system: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "describe" }, { type: "image", image: "data:image/png;base64,Zm9v" }] },
      ],
      resume: false,
    })
    expect(Array.isArray(withImage)).toBe(true)
    const arr = withImage as any[]
    // contains the user's text part + image block; no synthetic header when no prior history
    expect(arr.some((b) => b.type === "text" && b.text === "describe")).toBe(true)
    expect(arr.some((b) => b.type === "image" && b.source?.type === "base64" && b.source.data === "Zm9v")).toBe(true)

    const resumeAttach = buildPrompt({
      system: [],
      messages: [{ role: "user", content: [{ type: "image", image: "data:image/png;base64,Zm9v" }] }],
      resume: true,
    })
    expect(Array.isArray(resumeAttach)).toBe(true)
    expect((resumeAttach as any[]).some((b) => b.type === "image")).toBe(true)

    // history + attach: header present + blocks
    const histAttach = buildPrompt({
      system: [],
      messages: [
        { role: "user", content: "prev" },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text: "now with pic" }, { type: "image", image: "data:image/png;base64,Zm9v" }] },
      ],
      resume: false,
    })
    expect(Array.isArray(histAttach)).toBe(true)
    const ha = histAttach as any[]
    expect(ha.some((b) => b.type === "text" && /conversation_history/.test(b.text))).toBe(true)
    expect(ha.some((b) => b.type === "image")).toBe(true)

    // text only still string, exact match preserved
    expect(
      buildPrompt({ system: [], messages: [{ role: "user", content: "plain" }], resume: false }),
    ).toBe("plain")
  })

})
