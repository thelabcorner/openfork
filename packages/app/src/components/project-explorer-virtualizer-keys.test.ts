import { createRoot, createSignal } from "solid-js"
import { describe, expect, test } from "bun:test"
import { createProjectExplorerKeyResolver } from "./project-explorer-virtualizer-keys"

describe("Project Explorer virtualizer key stability", () => {
  test("metadata-only views retain the same key resolver and read current row metadata", () => {
    createRoot((dispose) => {
      const original = [{ node: { path: "src/file.ts", mtime: 1 } }, { node: { path: "README.md", mtime: 1 } }]
      const [view, setView] = createSignal({ keySignature: "live:1:0", rows: original })
      const resolve = createProjectExplorerKeyResolver(() => ({
        keySignature: view().keySignature,
        at: (index: number) => view().rows[index],
      }))
      const first = resolve()
      expect(first(0)).toBe("src/file.ts")
      expect(first(1)).toBe("README.md")
      setView({
        keySignature: "live:1:0",
        rows: [{ node: { path: "src/file.ts", mtime: 2 } }, { node: { path: "README.md", mtime: 1 } }],
      })
      expect(resolve()).toBe(first)
      expect(first(0)).toBe("src/file.ts")
      setView({
        keySignature: "live:1:1",
        rows: [{ node: { path: "README.md", mtime: 1 } }, { node: { path: "src/file.ts", mtime: 2 } }],
      })
      const reordered = resolve()
      expect(reordered).not.toBe(first)
      expect(reordered(0)).toBe("README.md")
      expect(reordered(1)).toBe("src/file.ts")
      expect(reordered(2)).toBe(2)
      dispose()
    })
  })
})
