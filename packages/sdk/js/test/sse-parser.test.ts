import { describe, expect, test } from "bun:test"
import { createSseParser, SseParseError } from "../src/sse-parser"

describe("incremental SSE parser", () => {
  test("retains multiline data, spaces and cursor metadata across every split", () => {
    const wire = "id: epoch:12  \r\ndata:first\r\n: heartbeat\r\ndata: second\r\nretry: 150\r\n\r\n"
    for (let split = 0; split <= wire.length; split++) {
      const parser = createSseParser()
      const frames = [...parser.push(wire.slice(0, split)), ...parser.push(wire.slice(split))]
      expect(frames).toEqual([{ data: "first\nsecond", hasData: true, event: undefined, id: "epoch:12  ", retry: 150 }])
    }
  })

  test("ignores invalid retry fields and IDs with NUL", () => {
    const parser = createSseParser()
    const frames = parser.push("id: good\nid: bad\0id\nretry: 50\nretry: -1\nretry: 12junk\nretry: 1e3\ndata:x\n\n")
    expect(frames[0]).toMatchObject({ id: "good", retry: 50, data: "x" })
  })

  test("supports UTF-8 sequences split at every byte boundary via the streaming decoder", () => {
    const bytes = new TextEncoder().encode("data: café 🐈 中文\n\n")
    for (let split = 0; split <= bytes.length; split++) {
      const parser = createSseParser()
      const decoder = new TextDecoder()
      const frames = [
        ...parser.push(decoder.decode(bytes.subarray(0, split), { stream: true })),
        ...parser.push(decoder.decode(bytes.subarray(split))),
      ]
      expect(frames[0]?.data).toBe("café 🐈 中文")
    }
  })

  test("enforces the field-content byte limit for ASCII and multibyte input", () => {
    const limit = 8 * 1024 * 1024
    expect(createSseParser().push("data:" + "x".repeat(limit - 5) + "\n\n")[0]?.data?.length).toBe(limit - 5)
    expect(() => createSseParser().push("data:" + "x".repeat(limit - 4))).toThrow(SseParseError)
    expect(() => createSseParser().push("data:" + "é".repeat(limit / 2))).toThrow(SseParseError)
  })

  test("retains metadata on data-less frames so the transport can advance its cursor", () => {
    expect(createSseParser().push("id: epoch:8\n: heartbeat\n\n")[0]).toMatchObject({ id: "epoch:8", hasData: false })
  })
  test("keeps framing across split CRLF chunks and exposes metadata", () => {
    const parser = createSseParser()

    expect(parser.push('id: 42\nevent: ready\nretry: 125\ndata: {"ok":')).toEqual([])
    expect(parser.push('true}\r')).toEqual([])
    expect(parser.push('\n\r\ndata: {"next":1}\n\n')).toEqual([
      {
        data: '{"ok":true}',
        hasData: true,
        event: "ready",
        id: "42",
        retry: 125,
      },
      {
        data: '{"next":1}',
        hasData: true,
        event: undefined,
        id: undefined,
        retry: undefined,
      },
    ])
  })

  test("flushes an unterminated final event at EOF", () => {
    const parser = createSseParser()
    expect(parser.push('data: {"eof":true}', true)).toEqual([
      {
        data: '{"eof":true}',
        hasData: true,
        event: undefined,
        id: undefined,
        retry: undefined,
      },
    ])
  })

  test("bounds an event that never terminates", () => {
    const parser = createSseParser()
    expect(() => parser.push("data:" + "x".repeat(8 * 1024 * 1024))).toThrow(SseParseError)
  })

  test("does not rebuild long data lines for every network chunk", () => {
    const parser = createSseParser()
    const chunks = ["data: ", ...Array.from({ length: 2048 }, () => "x".repeat(1024)), "\n\n"]
    const frames = chunks.flatMap((chunk) => parser.push(chunk))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.data?.length).toBe(2_097_152)
  })
})
