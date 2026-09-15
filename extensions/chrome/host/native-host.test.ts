import { describe, expect, test } from "bun:test"
import { encodeNativeMessage, MAX_HOST_TO_EXT, NativeMessageReader } from "./native-host"

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

  test("384 KiB raw visual chunks remain safely below Chrome's 1 MiB host-to-extension frame ceiling", () => {
    const bytes = Buffer.alloc(384 * 1024, 0x5a)
    const frame = encodeNativeMessage({
      type: "artifact_rpc_result",
      response: {
        ok: true,
        id: "visual-read-chunk",
        result: { bytes: bytes.toString("base64"), byteLength: bytes.byteLength },
      },
    })
    expect(frame.byteLength - 4).toBeLessThan(MAX_HOST_TO_EXT)
    expect(frame.byteLength - 4).toBeGreaterThan(512 * 1024)
  })
})
