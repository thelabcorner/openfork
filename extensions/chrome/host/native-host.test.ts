import { describe, expect, test } from "bun:test"
import { encodeNativeMessage, NativeMessageReader } from "./native-host"

describe("NativeMessageReader", () => {
  test("decodes a large native frame split across many small stdin chunks", () => {
    const payload = { id: "large", data: "x".repeat(512 * 1024) }
    const frame = encodeNativeMessage(payload)
    const reader = new NativeMessageReader()
    const messages: unknown[] = []
    for (let offset = 0; offset < frame.length; offset += 1024) {
      messages.push(...reader.push(frame.subarray(offset, Math.min(frame.length, offset + 1024))))
    }
    expect(messages).toEqual([payload])
  })

  test("decodes back-to-back frames while preserving a partial tail", () => {
    const first = encodeNativeMessage({ id: 1 })
    const second = encodeNativeMessage({ id: 2, value: "tail" })
    const joined = Buffer.concat([first, second])
    const split = first.length + 3
    const reader = new NativeMessageReader()
    expect(reader.push(joined.subarray(0, split))).toEqual([{ id: 1 }])
    expect(reader.push(joined.subarray(split))).toEqual([{ id: 2, value: "tail" }])
  })
})
