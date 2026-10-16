import { describe, expect, test } from "bun:test"
import type { CodeRunTraceView } from "@opencode-ai/core/v1/session"
import { codeTracePresentation } from "../../src/util/code-trace-presentation"

function trace(): CodeRunTraceView {
  return {
    version: 1,
    rootFrameID: "code:root",
    frames: [
      {
        frameID: "frame-1",
        ref: "native:read",
        kind: "native",
        depth: 0,
        startedAt: 1,
        status: "succeeded",
        title: "Read source",
        attachmentCount: 1,
      },
      {
        frameID: "frame-2",
        ref: "native:write",
        kind: "native",
        depth: 1,
        startedAt: 2,
        status: "failed",
        title: "Write result",
      },
      {
        frameID: "frame-3",
        ref: "native:test",
        kind: "native",
        depth: 1,
        startedAt: 3,
        status: "running",
      },
    ],
    counters: { calls: 6, failed: 1, active: 1 },
    truncated: { frames: 2 },
  }
}

describe("Code trace TUI presentation", () => {
  test("renders counters, status, titles, depth, and attachment counts", () => {
    const lines = codeTracePresentation(trace(), 5)

    expect(lines[0]).toBe("↳ 6 calls, 1 failed, 1 active")
    expect(lines).toContain("↳ ✓ native:read — Read source · 1 attachment")
    expect(lines).toContain("  ↳ ✗ native:write — Write result")
    expect(lines).toContain("  ↳ … native:test")
  })

  test("distinguishes retained preview clipping from producer-side truncation", () => {
    const lines = codeTracePresentation(trace(), 2)

    expect(lines).toContain("↳ … 1 retained frame not shown")
    expect(lines).toContain("↳ trace capped · 2 frames not retained")
  })
})