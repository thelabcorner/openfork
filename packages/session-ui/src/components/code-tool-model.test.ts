import { describe, expect, test } from "bun:test"
import {
  codeAttachmentLabel,
  codeOutputLifecycle,
  codeTraceOmittedLabel,
} from "./code-tool-model"

describe("Code tool lifecycle presentation", () => {
  test("keeps live trace visible before a final tool output exists", () => {
    const view = codeOutputLifecycle({
      metadata: {
        action: "run",
        trace: {
          version: 1,
          rootFrameID: "root",
          frames: [
            {
              frameID: "frame-1",
              ref: "native:orders/lookup",
              kind: "native",
              depth: 1,
              startedAt: 1,
              status: "running",
              title: "Lookup order",
              attachmentCount: 1,
            },
          ],
          counters: { calls: 1, failed: 0, active: 1 },
        },
      },
    })

    expect(view.parsed).toBeUndefined()
    expect(view.isError).toBe(false)
    expect(view.trace?.frames[0]).toMatchObject({
      ref: "native:orders/lookup",
      title: "Lookup order",
      depth: 1,
      attachmentCount: 1,
      status: "running",
    })
    expect(view.trace?.counters).toEqual({ calls: 1, failed: 0, active: 1 })
  })

  test("keeps the final bounded trace alongside a structured failure", () => {
    const view = codeOutputLifecycle({
      output: JSON.stringify({
        ok: false,
        runID: "run:prt_failed",
        error: {
          kind: "CapabilityFailed",
          message: "leaf failed",
          recovery: "Revise the call and rerun.",
        },
        calls: { total: 3, failed: 1 },
      }),
      metadata: {
        action: "call",
        error: true,
        trace: {
          version: 1,
          rootFrameID: "root",
          frames: [
            {
              frameID: "frame-1",
              ref: "native:test/fail",
              kind: "native",
              depth: 0,
              startedAt: 1,
              finishedAt: 2,
              durationMs: 1,
              status: "failed",
              title: "Failing leaf",
            },
          ],
          counters: { calls: 3, failed: 1, active: 0 },
          truncated: { frames: 2 },
        },
      },
    })

    expect(view.isError).toBe(true)
    expect(view.parsed?.ok).toBe(false)
    expect(view.trace?.frames[0]?.status).toBe("failed")
    expect(view.trace?.truncated?.frames).toBe(2)
  })

  test("uses accurate bounded-trace and attachment copy", () => {
    expect(codeAttachmentLabel(1)).toBe("1 attachment")
    expect(codeAttachmentLabel(3)).toBe("3 attachments")
    expect(codeTraceOmittedLabel(1)).toBe("+1 frame omitted from the bounded retained trace")
    expect(codeTraceOmittedLabel(4)).toBe("+4 frames omitted from the bounded retained trace")
  })
})