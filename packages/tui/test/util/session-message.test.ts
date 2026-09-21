import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
  isHistoricalMessage,
  isSemanticUserMessage,
  isStateProjectionMessage,
  isWorkerPromptMessage,
  semanticKind,
} from "../../src/util/session-message"

const message = (provenance?: UserMessage["provenance"]): UserMessage => ({
  id: "msg_test",
  sessionID: "ses_test",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "test", modelID: "model" },
  ...(provenance ? { provenance } : {}),
})

describe("TUI session message provenance", () => {
  test("keeps legacy unstamped user turns compatible", () => {
    const value = message()
    expect(semanticKind(value)).toBe("user")
    expect(isSemanticUserMessage(value)).toBe(true)
    expect(isWorkerPromptMessage(value)).toBe(true)
  })

  test("does not treat Goal continuations as human or worker prompts", () => {
    const value = message({
      owner: "host",
      source: "goal.continuation",
      sourceMessageID: "msg_user",
      ref: "reservation_1",
    })
    expect(semanticKind(value)).toBe("synthetic")
    expect(isSemanticUserMessage(value)).toBe(false)
    expect(isWorkerPromptMessage(value)).toBe(false)
  })

  test("allows trusted host prompt admission to supply worker configuration without becoming human input", () => {
    const value = message({ owner: "host", source: "host.prompt" })
    expect(semanticKind(value)).toBe("synthetic")
    expect(isSemanticUserMessage(value)).toBe(false)
    expect(isWorkerPromptMessage(value)).toBe(true)
  })

  test("keeps shell turns distinct from human prompts", () => {
    const value = message({ owner: "user", source: "shell" })
    expect(semanticKind(value)).toBe("shell")
    expect(isSemanticUserMessage(value)).toBe(false)
    expect(isWorkerPromptMessage(value)).toBe(false)
  })

  test("identifies replaceable Goal state as transparent provider-user context", () => {
    const value = message({ owner: "host", source: "goal.progress", ref: "goal-state:test" })
    expect(semanticKind(value)).toBe("synthetic")
    expect(isStateProjectionMessage(value)).toBe(true)
    expect(isSemanticUserMessage(value)).toBe(false)
    expect(isWorkerPromptMessage(value)).toBe(false)
  })

  test("keeps imported history presentationally semantic without treating it as live state", () => {
    const value = message({ owner: "user", source: "prompt", lifetime: "historical" })
    expect(isHistoricalMessage(value)).toBe(true)
    expect(isSemanticUserMessage(value)).toBe(true)
    expect(isWorkerPromptMessage(value)).toBe(false)
    expect(isStateProjectionMessage(value)).toBe(false)
  })
})
