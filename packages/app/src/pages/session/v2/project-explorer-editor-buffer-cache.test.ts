import { describe, expect, test } from "bun:test"
import { trimProjectExplorerEditorBuffers, type CacheableEditorBuffer } from "./project-explorer-editor-buffer-cache"

describe("project explorer editor clean-buffer cache", () => {
  test("evicts oldest clean inactive content while preserving active and dirty buffers", () => {
    const buffers = [
      { path: "old.ts", savedContent: "a".repeat(100), dirty: false },
      { path: "dirty.ts", savedContent: "b".repeat(100), dirty: true },
      { path: "active.ts", savedContent: "c".repeat(100), dirty: false },
    ]
    const next = trimProjectExplorerEditorBuffers(buffers, "active.ts", 220)
    expect(next[0]).toMatchObject({ path: "old.ts", savedContent: "", cold: true })
    expect(next[1]).toEqual(buffers[1])
    expect(next[2]).toEqual(buffers[2])
  })

  test("releases binary payloads with the clean tab", () => {
    const next = trimProjectExplorerEditorBuffers<CacheableEditorBuffer>(
      [{ path: "image.png", savedContent: "", binary: "x".repeat(500), dirty: false }],
      undefined,
      100,
    )
    expect(next[0]?.cold).toBe(true)
    expect(next[0]?.binary).toBeUndefined()
  })

  test("returns the original array when already within budget", () => {
    const buffers = [{ path: "a.ts", savedContent: "small", dirty: false }]
    expect(trimProjectExplorerEditorBuffers(buffers, undefined, 100)).toBe(buffers)
  })
})
