import { describe, expect, test } from "bun:test"
import { codePointLength, requestContextChars, resultContextChars } from "@/oxp/context-footprint"

describe("OXP context footprint", () => {
  test("counts Unicode code points instead of UTF-16 code units", () => {
    expect("A😀Z".length).toBe(4)
    expect(codePointLength("A😀Z")).toBe(3)
  })

  test("measures the serialized request boundary without persisting content", () => {
    const args = { path: "/tmp/😀.txt", limit: 12 }
    expect(requestContextChars(args)).toBe([...JSON.stringify(args)].length)
  })

  test("counts only text returned through MCP content", () => {
    expect(
      resultContextChars({
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "😀" },
          {
            type: "image",
            data: "AAAA",
            mimeType: "image/png",
          },
        ],
      }),
    ).toBe(6)
  })
})
