import { describe, expect, mock, test } from "bun:test"
import type { Part, UserMessage } from "@opencode-ai/sdk/v2"
import { createCommentMetadata } from "@/utils/comment-note"
import { systemInjectionPreview, systemInjectionSegments, systemInjectionSignature } from "./system-injection"

// Same stubs as rows-current.test.ts: importing ./rows otherwise pulls the
// markdown worker and the shared text-layout lib into a plain bun test process.
mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({
      type: "part" as const,
      key: ref.part.id,
      ref: { messageID: ref.messageID, partID: ref.part.id },
    })),
}))
mock.module("@/lib/text-layout", () => ({
  estimateTextHeight: (text: string) => (text ? 100 : undefined),
  prepareTextLayout: () => undefined,
  textLayoutMode: () => "off" as const,
}))

const { Timeline, TimelineRow } = await import("./rows")

const textPart = (id: string, text: string, extra: Partial<Extract<Part, { type: "text" }>> = {}): Part =>
  ({
    id,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text,
    ...extra,
  }) as Part

const user = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "user",
  time: { created: 1 },
} as UserMessage

describe("system injection projection", () => {
  test("selects synthetic text parts and nothing else", () => {
    const parts = [
      textPart("prt_1", "what the user typed"),
      textPart("prt_2", "Continue with your task.", { synthetic: true }),
      textPart("prt_3", "user-only note", { ignored: true }),
      textPart("prt_4", "   ", { synthetic: true }),
      { id: "prt_5", sessionID: "ses_1", messageID: "msg_1", type: "file", mime: "text/plain", url: "x" } as Part,
      textPart("prt_6", "You are now in plan mode.", { synthetic: true }),
    ]
    expect(systemInjectionSegments(parts)).toEqual([
      { id: "prt_2", text: "Continue with your task." },
      { id: "prt_6", text: "You are now in plan mode." },
    ])
  })

  test("excludes inline file comments, which already render as comment cards", () => {
    const parts = [
      textPart("prt_1", "review this", {
        synthetic: true,
        metadata: createCommentMetadata({ path: "src/a.ts", comment: "fix" }),
      }),
      textPart("prt_2", "real injection", { synthetic: true }),
    ]
    expect(systemInjectionSegments(parts).map((segment) => segment.id)).toEqual(["prt_2"])
  })

  test("signature changes only when the injection set changes", () => {
    const base = [textPart("prt_1", "typed"), textPart("prt_2", "injected", { synthetic: true })]
    expect(systemInjectionSignature(base)).toEqual({ signature: "prt_2", count: 1 })

    // Streaming/assistant growth elsewhere in the turn must not move it.
    const grown = [...base, textPart("prt_3", "more typed text")]
    expect(systemInjectionSignature(grown)).toEqual({ signature: "prt_2", count: 1 })

    const appended = [...base, textPart("prt_4", "second injection", { synthetic: true })]
    expect(systemInjectionSignature(appended)).toEqual({ signature: "prt_2,prt_4", count: 2 })
  })

  test("preview takes the first non-blank line", () => {
    expect(systemInjectionPreview([{ id: "prt_1", text: "\n\n  Plan mode is active.\nDetails follow." }])).toBe(
      "Plan mode is active.",
    )
    expect(systemInjectionPreview([])).toBe("")
  })
})

describe("system injection rows", () => {
  const parts: Record<string, Part[]> = {
    msg_1: [textPart("prt_1", "typed"), textPart("prt_2", "injected", { synthetic: true })],
  }
  const build = (showSystemInjections: boolean) =>
    Timeline.constructMessageRows(user, (id) => parts[id] ?? [], [], 0, true, showSystemInjections, "idle", false, false)

  test("emits no row and does no scanning while the setting is off", () => {
    expect(build(false).map(TimelineRow.key)).toEqual(["user-message:msg_1"])
  })

  test("emits one row directly beneath the prompt it was attached to", () => {
    const rows = build(true)
    expect(rows.map(TimelineRow.key)).toEqual(["user-message:msg_1", "system-injection:msg_1"])
    const row = rows[1]
    expect(row?._tag).toBe("SystemInjection")
    if (row?._tag !== "SystemInjection") throw new Error("expected SystemInjection row")
    expect(row.signature).toBe("prt_2")
    expect(row.count).toBe(1)
  })

  // The dominant real shape: background-shell results, tool preambles and
  // pasted-file expansions arrive as a user message whose ONLY part is
  // synthetic. Today that renders an empty bubble and nothing else, which is
  // exactly the blank gap users report as "the system message is missing".
  test("emits the row for a turn whose only part is an injection", () => {
    const onlyInjection: Record<string, Part[]> = {
      msg_1: [
        textPart("prt_1", '<background_shell job="t14-suite" state="completed" exit="0">', { synthetic: true }),
      ],
    }
    const rows = Timeline.constructMessageRows(
      user,
      (id) => onlyInjection[id] ?? [],
      [],
      0,
      true,
      true,
      "idle",
      false,
      false,
    )
    expect(rows.map(TimelineRow.key)).toEqual(["user-message:msg_1", "system-injection:msg_1"])
  })

  test("rebuilt rows stay structurally equal so the virtualizer does not churn", () => {
    expect(TimelineRow.equals(build(true)[1], build(true)[1])).toBe(true)
  })
})
