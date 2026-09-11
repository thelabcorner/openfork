import { describe, expect, test } from "bun:test"
import { normalizeMentionPage } from "./at-mention-search"

describe("normalizeMentionPage", () => {
  test("preserves directory classification while stripping file-only metadata", () => {
    const page = normalizeMentionPage({
      results: [
        {
          kind: "file" as const,
          path: "src/components",
          type: "directory" as const,
          size: "0",
          mtime: "0",
          lineCount: "0",
        },
      ],
      hasMore: false,
    })

    expect(page.results).toEqual([
      {
        kind: "file",
        path: "src/components",
        type: "directory",
        positions: undefined,
        baseOffset: undefined,
        size: undefined,
        mtime: undefined,
        lineCount: undefined,
      },
    ])
  })

  test("infers directory from a trailing separator when an older server omits type", () => {
    const page = normalizeMentionPage({
      results: [{ kind: "file" as const, path: "src/components/", size: 0, lineCount: 0 }],
      hasMore: false,
    })

    const result = page.results[0]
    expect(result?.kind).toBe("file")
    if (result?.kind !== "file") throw new Error("expected file-kind path result")
    expect(result.type).toBe("directory")
    expect(result.size).toBeUndefined()
    expect(result.lineCount).toBeUndefined()
  })

  test("retains legitimate zero metadata for an empty regular file", () => {
    const page = normalizeMentionPage({
      results: [{ kind: "file" as const, path: "empty.ts", type: "file" as const, size: 0, lineCount: 0 }],
      hasMore: false,
    })

    const result = page.results[0]
    expect(result?.kind).toBe("file")
    if (result?.kind !== "file") throw new Error("expected file-kind path result")
    expect(result.type).toBe("file")
    expect(result.size).toBe(0)
    expect(result.lineCount).toBe(0)
  })
})
