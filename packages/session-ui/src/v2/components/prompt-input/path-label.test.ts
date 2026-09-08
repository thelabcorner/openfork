import { describe, expect, test } from "bun:test"
import { splitPromptInputV2PathSegments } from "./path-label"

const text = (segments: { text: string }[]) => segments.map((segment) => segment.text).join("")

describe("prompt-input v2 path labels", () => {
  test("does not split a Windows root directory after its first character", () => {
    const result = splitPromptInputV2PathSegments("agent-skills\\", undefined, "a")
    expect(result).toBeDefined()
    expect(text(result!.nameSegments)).toBe("agent-skills")
    expect(text(result!.dirSegments)).toBe("")
  })

  test("renders the nested directory basename before a normalized parent path", () => {
    const result = splitPromptInputV2PathSegments("agent-skills\\lib-docs\\", undefined, "lib")
    expect(result).toBeDefined()
    expect(text(result!.nameSegments)).toBe("lib-docs")
    expect(text(result!.dirSegments)).toBe("agent-skills/")
  })

  test("keeps server highlight offsets aligned while normalizing separators", () => {
    const result = splitPromptInputV2PathSegments("src\\components\\Button.tsx", [15, 16, 17], "but")
    expect(result).toBeDefined()
    expect(text(result!.nameSegments)).toBe("Button.tsx")
    expect(text(result!.dirSegments)).toBe("src/components/")
    expect(result!.nameSegments.some((segment) => segment.matched)).toBeTrue()
  })

  test("leaves root-level files on the ordinary label rendering path", () => {
    expect(splitPromptInputV2PathSegments("README.md", undefined, "read")).toBeUndefined()
  })
})
