import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { jsonSchema } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"
import { it } from "../lib/effect"

const sessionID = "ses_1a2b3c4d5e6f7a8b9c0d1e2f3a"
const requestID = "msg_1a2b3c4d5e6f7a8b9c0d1e2f3a"

const model = {
  id: "big-pickle",
  providerID: "opencode",
  api: { id: "big-pickle", url: "https://opencode.ai/zen/v1", npm: "@ai-sdk/openai-compatible" },
  name: "Big Pickle",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 32000 },
  status: "active",
  options: {},
  headers: {},
} as any

describe("LLM provider request identity", () => {
  it.instance("uses the canonical installation user agent and session-shaped OpenCode headers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMRequestPrep.prepare({
        user: {
          id: requestID,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        } as any,
        sessionID,
        model,
        agent: { name: "build", mode: "primary", options: {}, permission: [] } as any,
        system: [],
        messages: [{ role: "user", content: "Hello" }],
        tools: {
          lookup: {
            description: "Look up a value",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
          },
        },
        provider: { id: "opencode", options: {} } as any,
        auth: undefined,
        plugin: {
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        } as any,
        flags: { outputTokenMax: 32_000, client: "desktop" } as any,
        isWorkflow: false,
      })

      const headers = prepared.headers as Record<string, string>

      // The Console free-tier gate requires `opencode/<channel>/<version>/<client>`.
      expect(headers["User-Agent"]).toMatch(/^opencode\/[^/]+\/[^/]+\/desktop$/)
      expect(headers["x-opencode-session"]).toBe(sessionID)
      expect(headers["x-opencode-request"]).toBe(requestID)
      expect(headers["x-opencode-client"]).toBe("desktop")
      expect(headers["x-opencode-project"]).toBeTruthy()
    }),
  )

  it.instance("does not emit OpenCode identity headers for third-party providers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMRequestPrep.prepare({
        user: {
          id: requestID,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        } as any,
        sessionID,
        model: {
          ...model,
          providerID: "anthropic",
          api: { id: "claude", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
        },
        agent: { name: "build", mode: "primary", options: {}, permission: [] } as any,
        system: [],
        messages: [{ role: "user", content: "Hello" }],
        tools: {},
        provider: { id: "anthropic", options: {} } as any,
        auth: undefined,
        plugin: {
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        } as any,
        flags: { outputTokenMax: 32_000, client: "desktop" } as any,
        isWorkflow: false,
      })

      const headers = prepared.headers as Record<string, string>

      expect(headers["User-Agent"]).toMatch(/^opencode\/[^/]+\/[^/]+\/desktop$/)
      expect(headers["x-opencode-session"]).toBeUndefined()
      expect(headers["x-opencode-project"]).toBeUndefined()
      expect(headers["X-Session-Id"]).toBe(sessionID)
    }),
  )
})
