import { describe, expect, test } from "bun:test"
import {
  boundDreamerMessages,
  DREAMER_MESSAGE_TEXT_LIMIT,
  DREAMER_MESSAGE_TOTAL_TEXT_LIMIT,
} from "@/tool/session"

describe("Dreamer historical transcript output budgets", () => {
  test("preserves both ends of one long message, identifying the omitted middle", () => {
    const messages = [{ id: "msg1", text: "BEGIN" + "a".repeat(90_000) + "END" }]
    const result = boundDreamerMessages(messages)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.id).toBe("msg1")
    expect(result.messages[0]?.text.startsWith("BEGIN")).toBe(true)
    expect(result.messages[0]?.text.endsWith("END")).toBe(true)
    expect(result.messages[0]?.text).toContain("historical message excerpt omitted")
    expect(Buffer.byteLength(JSON.stringify(result.messages[0]?.text), "utf8") - 2).toBeLessThanOrEqual(DREAMER_MESSAGE_TEXT_LIMIT)
    expect(result.messages[0]?.textTruncated).toBe(true)
    expect(result.messages[0]?.omittedCharacters).toBeGreaterThan(messages[0]!.text.length - DREAMER_MESSAGE_TEXT_LIMIT)
    expect(result.truncated).toBe(true)
    expect(messages[0]?.text.length).toBe(90_008)
  })

  test("bounds batches by total text, preserving the latest evidence and chronological order", () => {
    const messages = Array.from({ length: 100 }, (_, id) => ({ id, text: `${id}:` + "x".repeat(75_000) }))
    const result = boundDreamerMessages(messages)
    expect(result.messages.map((message) => message.id)).toEqual([96, 97, 98, 99])
    expect(result.omittedMessages).toBe(96)
    expect(result.messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message.text), "utf8") - 2, 0))
      .toBeLessThanOrEqual(DREAMER_MESSAGE_TOTAL_TEXT_LIMIT)
    expect(result.messages.every((message) => message.textTruncated)).toBe(true)
    expect(result.truncated).toBe(true)
  })

  test("does not claim truncation at the exact boundary", () => {
    const messages = Array.from({ length: 4 }, (_, id) => ({ id, text: "x".repeat(DREAMER_MESSAGE_TEXT_LIMIT) }))
    const result = boundDreamerMessages(messages)
    expect(result.messages).toEqual(messages)
    expect(result.truncated).toBe(false)
    expect(result.omittedMessages).toBe(0)
    expect(result.textBudget).toBe(DREAMER_MESSAGE_TOTAL_TEXT_LIMIT)
  })

  test("empty and short messages remain intact", () => {
    const messages = [{ text: "" }, { text: "verified user correction" }]
    expect(boundDreamerMessages(messages)).toMatchObject({ messages, truncated: false, omittedMessages: 0 })
  })

  test("unicode and JSON-escaped controls cannot evade serialized UTF-8 budgets", () => {
    const messages = Array.from({ length: 30 }, (_, id) => ({ id, text: "\u0000😀\n".repeat(8_000) }))
    const result = boundDreamerMessages(messages)
    const bytes = result.messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message.text), "utf8") - 2, 0)
    expect(bytes).toBeLessThanOrEqual(DREAMER_MESSAGE_TOTAL_TEXT_LIMIT)
    expect(result.messages.length).toBeLessThan(messages.length)
    expect(result.truncated).toBe(true)
    expect(result.messages.every((message) => Buffer.byteLength(JSON.stringify(message.text), "utf8") - 2 <= DREAMER_MESSAGE_TEXT_LIMIT)).toBe(true)
  })
})