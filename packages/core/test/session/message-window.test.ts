import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import {
  projectTimelineMessagePage,
} from "@opencode-ai/core/session/message-window"

const assistant = (content: SessionMessage.Assistant["content"]): SessionMessage.Assistant =>
  ({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content,
    time: { created: 1 },
  }) as unknown as SessionMessage.Assistant

describe("SessionMessageWindow", () => {
  test("preserves every pathological content item and string", () => {
    const source = assistant(
      Array.from({ length: 80_000 }, (_, index) => ({
        id: `prt_${index}`,
        type: "text" as const,
        text: "x".repeat(512),
      })),
    )
    const page = projectTimelineMessagePage([source])
    const encoded = JSON.stringify(page.data)

    expect(page.data).toHaveLength(1)
    expect(page.windowed).toEqual([])
    expect(page.data[0]).toEqual(source)
    expect(page.data[0]?.type === "assistant" ? page.data[0].content : []).toHaveLength(80_000)
    expect(page.bytes).toBe(Buffer.byteLength(encoded))
    expect(page.bytes).toBeGreaterThan(960 * 1024)
    expect(source.content).toHaveLength(80_000)
  })

  test("preserves message order and complete content regardless of former byte budget", () => {
    const messages = Array.from({ length: 12 }, () => assistant([{ id: "prt_text", type: "text", text: "ok" }]))
    const page = projectTimelineMessagePage(messages, 1024)

    expect(page.data.map((message) => message.id)).toEqual(messages.map((message) => message.id))
    expect(page.data).toEqual(messages)
    expect(page.windowed).toEqual([])
    expect(page.bytes).toBe(Buffer.byteLength(JSON.stringify(messages)))
  })
})
