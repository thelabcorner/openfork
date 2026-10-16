import { describe, expect, test } from "bun:test"
import {
  CODE_RUN_TRACE_MAX_FRAMES,
  CODE_RUN_TRACE_MAX_ID_CHARS,
  CODE_RUN_TRACE_MAX_REF_CHARS,
  CODE_RUN_TRACE_MAX_TITLE_CHARS,
  ToolPart,
  isCodeRunTrace,
} from "../src/v1/session"
import { Schema } from "effect"

describe("CodeRunTrace browser contract", () => {
  test("keeps ordinary tool metadata open while validating a typed trace field", () => {
    const trace = {
      version: 1 as const,
      rootFrameID: "code:prt_trace",
      frames: [],
      counters: { calls: 0, failed: 0, active: 0 },
    }
    const part = Schema.decodeUnknownSync(ToolPart)({
      id: "prt_metadata",
      sessionID: "ses_metadata",
      messageID: "msg_metadata",
      type: "tool",
      callID: "call_metadata",
      tool: "shell",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        title: "shell",
        metadata: { output: "stdout", exitCode: 0, background: false, trace },
        time: { start: 1, end: 2 },
      },
      metadata: { sessionId: "ses_child", files: ["a.txt"], trace },
    })

    expect(part.state.status).toBe("completed")
    if (part.state.status !== "completed") throw new Error("unexpected tool state")
    expect(part.state.metadata.output).toBe("stdout")
    expect(part.state.metadata.exitCode).toBe(0)
    expect(part.metadata?.sessionId).toBe("ses_child")
    expect(isCodeRunTrace(part.state.metadata.trace)).toBe(true)
  })

  test("accepts the schema-owned bounded projection shape", () => {
    expect(
      isCodeRunTrace({
        version: 1,
        rootFrameID: "code:prt_trace",
        frames: [
          {
            frameID: "code:prt_trace#1",
            ref: "native:read",
            kind: "native",
            depth: 0,
            startedAt: 1,
            finishedAt: 2,
            durationMs: 1,
            status: "succeeded",
            attachmentCount: 0,
          },
        ],
        counters: { calls: 1, failed: 0, active: 0 },
      }),
    ).toBe(true)
  })

  test("rejects arbitrary tool metadata masquerading as a trace", () => {
    expect(
      isCodeRunTrace({
        version: 1,
        rootFrameID: "code:prt_trace",
        frames: [{ ref: "native:read", metadata: { secret: "no" } }],
        counters: { calls: 1, failed: 0, active: 0 },
      }),
    ).toBe(false)
  })

  test("rejects traces whose retained frame list exceeds the wire bound", () => {
    const frame = {
      frameID: "code:prt_trace#1",
      ref: "native:read",
      kind: "native" as const,
      depth: 0,
      startedAt: 1,
      status: "succeeded" as const,
    }
    expect(
      isCodeRunTrace({
        version: 1,
        rootFrameID: "code:prt_trace",
        frames: Array.from({ length: CODE_RUN_TRACE_MAX_FRAMES + 1 }, (_, index) => ({
          ...frame,
          frameID: `code:prt_trace#${index + 1}`,
        })),
        counters: { calls: CODE_RUN_TRACE_MAX_FRAMES + 1, failed: 0, active: 0 },
      }),
    ).toBe(false)
  })

  test("rejects oversized durable trace strings", () => {
    const base = {
      version: 1 as const,
      rootFrameID: "code:prt_trace",
      frames: [
        {
          frameID: "code:prt_trace#1",
          ref: "native:read",
          kind: "native" as const,
          depth: 0,
          startedAt: 1,
          status: "succeeded" as const,
          title: "read",
        },
      ],
      counters: { calls: 1, failed: 0, active: 0 },
    }

    expect(
      isCodeRunTrace({
        ...base,
        rootFrameID: "r".repeat(CODE_RUN_TRACE_MAX_ID_CHARS + 1),
      }),
    ).toBe(false)
    expect(
      isCodeRunTrace({
        ...base,
        frames: [{ ...base.frames[0], frameID: "f".repeat(CODE_RUN_TRACE_MAX_ID_CHARS + 1) }],
      }),
    ).toBe(false)
    expect(
      isCodeRunTrace({
        ...base,
        frames: [{ ...base.frames[0], ref: "x".repeat(CODE_RUN_TRACE_MAX_REF_CHARS + 1) }],
      }),
    ).toBe(false)
    expect(
      isCodeRunTrace({
        ...base,
        frames: [{ ...base.frames[0], title: "t".repeat(CODE_RUN_TRACE_MAX_TITLE_CHARS + 1) }],
      }),
    ).toBe(false)
  })
})
