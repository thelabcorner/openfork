import { describe, expect, test } from "bun:test"
import { parseToolError } from "./tool-error-parse"

describe("parseToolError", () => {
  test("does not mistake a quoted patch excerpt for a stack trace", () => {
    const error = [
      "patch verification failed for 1 file(s):",
      "  client/src/components/resize/GroupResizeHandles.tsx: update: Failed to find expected lines in C:\\repo\\GroupResizeHandles.tsx:",
      "    const computedHitZone = Math.max(computedHandleSize + 4, 18 / Math.sqrt(scale));",
      "    const computedRotateCornerHitZone = Math.max(10, 12 / Math.sqrt(scale));",
      "",
      "Current file content closest to the expected lines:",
      "",
      " 1135 |",
      " 1136 |   // Visual size scales smoothly with zoom: base 10px.",
      ">1137 |   const computedHandleSize = Math.max(6, 10 / Math.sqrt(scale));",
      " 1138 |   const computedRotationOffset = -Math.max(40, 30 / Math.sqrt(scale));",
      "",
      "Nothing was applied. Fix the hunks and resubmit.",
    ].join("\n")

    const parsed = parseToolError(error)

    // The old heuristic collapsed everything below line 2 behind "Show stack".
    expect(parsed.stack).toEqual([])
    expect(parsed.blocks.map((block) => block.kind)).toEqual(["text", "code", "text", "code", "text"])

    const quoted = parsed.blocks[1]!
    expect(quoted.kind).toBe("code")
    if (quoted.kind !== "code") throw new Error("unreachable")
    expect(quoted.lines).toHaveLength(2)
    expect(quoted.lines[0]!.text).toBe("  const computedHitZone = Math.max(computedHandleSize + 4, 18 / Math.sqrt(scale));")

    const excerpt = parsed.blocks[3]!
    if (excerpt.kind !== "code") throw new Error("unreachable")
    expect(excerpt.lines.map((line) => line.number)).toEqual(["1135", "1136", "1137", "1138"])
    expect(excerpt.lines.filter((line) => line.marker).map((line) => line.number)).toEqual(["1137"])

    const last = parsed.blocks[4]!
    if (last.kind !== "text") throw new Error("unreachable")
    expect(last.text).toBe("Nothing was applied. Fix the hunks and resubmit.")
  })

  test("still detects a real stack trace", () => {
    const parsed = parseToolError(
      [
        "TypeError: Cannot read properties of undefined (reading 'id')",
        "    at resolve (/repo/src/resolve.ts:12:9)",
        "    at async handle (/repo/src/handle.ts:44:3)",
        "    at async /repo/src/main.ts:8:1",
      ].join("\n"),
    )

    expect(parsed.type).toBe("TypeError")
    expect(parsed.stack).toHaveLength(3)
    expect(parsed.blocks).toHaveLength(1)
    expect(parsed.blocks[0]).toEqual({
      kind: "text",
      text: "TypeError: Cannot read properties of undefined (reading 'id')",
    })
  })

  test("keeps a one-or-two frame tail inline rather than hiding it", () => {
    const parsed = parseToolError("ENOENT: no such file or directory\n    at open (fs.ts:1:1)")
    expect(parsed.stack).toEqual([])
  })

  test("splits model-facing remediation off the end", () => {
    const parsed = parseToolError(
      "oldString cannot be empty when editing an existing file.\nPlease provide the exact text to replace.",
    )
    expect(parsed.hints).toEqual(["Please provide the exact text to replace."])
    expect(parsed.blocks).toHaveLength(1)
  })

  test("leaves a plain one-line error alone", () => {
    const parsed = parseToolError("Error: File not found: src/missing.ts")
    expect(parsed.type).toBeUndefined()
    expect(parsed.stack).toEqual([])
    expect(parsed.hints).toEqual([])
    expect(parsed.blocks).toEqual([{ kind: "text", text: "File not found: src/missing.ts" }])
  })
})
