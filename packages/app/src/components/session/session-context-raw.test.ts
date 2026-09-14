import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  boundedPartsText,
  newestRawMessages,
  RAW_MESSAGE_PAGE_SIZE,
  RAW_MESSAGE_SUMMARY_CHARS,
} from "./session-context-raw"

describe("context raw-history bounds", () => {
  test("5k-message histories mount only the newest 200 rows by default", () => {
    const messages = Array.from({ length: 5_000 }, (_, index) => ({
      id: `m-${index}`,
      sessionID: "s",
      role: "user",
      time: { created: index },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    })) as Message[]
    const started = performance.now()
    const rows = newestRawMessages(messages)
    const elapsed = performance.now() - started
    console.info(`[context-5k-window] rows=${rows.length} elapsedMs=${elapsed.toFixed(3)}`)
    expect(rows).toHaveLength(RAW_MESSAGE_PAGE_SIZE)
    expect(rows[0]?.id).toBe("m-4800")
  })

  test("multi-megabyte message previews remain bounded to about 24 KiB", () => {
    const parts = [
      {
        id: "p",
        sessionID: "s",
        messageID: "m",
        type: "text",
        text: "x".repeat(8 * 1024 * 1024),
      },
    ] as Part[]
    const started = performance.now()
    const preview = boundedPartsText(parts, (part) => (part.type === "text" ? part.text : undefined))!
    const elapsed = performance.now() - started
    console.info(`[context-8m-preview] chars=${preview.length} elapsedMs=${elapsed.toFixed(3)}`)
    expect(preview.length).toBeLessThanOrEqual(RAW_MESSAGE_SUMMARY_CHARS + 3)
    expect(preview.endsWith("…")).toBe(true)
  })
})
