import { describe, expect, test } from "bun:test"
import { buildFileDragTransfer, parseFileDragText } from "./file-drag-transfer"

describe("file drag transfer", () => {
  test("bounds a huge selection without iterating or serializing the whole set", () => {
    let visited = 0
    function* paths() {
      for (let index = 0; index < 50_000; index++) {
        visited++
        yield `src/generated/file-${index}.ts`
      }
    }

    const transfer = buildFileDragTransfer(paths(), (path) => `file://${path}`, {
      total: 50_000,
      maxItems: 128,
      maxChars: 1_000_000,
    })

    expect(transfer.included).toBe(128)
    expect(transfer.total).toBe(50_000)
    expect(transfer.truncated).toBe(true)
    expect(visited).toBeLessThanOrEqual(129)
  })

  test("respects the character budget while always admitting the first path", () => {
    const transfer = buildFileDragTransfer(
      ["a".repeat(400), "b".repeat(400)],
      (path) => `file://${path}`,
      { total: 2, maxChars: 256 },
    )
    expect(transfer.included).toBe(1)
    expect(transfer.truncated).toBe(true)
  })

  test("parses single and multi-file OpenCode payloads without accepting mixed text", () => {
    expect(parseFileDragText("file:src/a.ts\nfile:src/b.ts")).toEqual(["src/a.ts", "src/b.ts"])
    expect(parseFileDragText("file:src/a.ts")).toEqual(["src/a.ts"])
    expect(parseFileDragText("file:src/a.ts\nhello")).toEqual([])
  })
})
