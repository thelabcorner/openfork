import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/schema/session-v1"
import { overlayCurrentPartSnapshots } from "../../src/session/current-part-overlay"

describe("overlayCurrentPartSnapshots", () => {
  test("repairs durable empty text with the active producer snapshot", () => {
    const durable = {
      info: { id: "msg_active" },
      parts: [
        {
          id: "prt_active",
          sessionID: "ses_active",
          messageID: "msg_active",
          type: "text",
          text: "",
          time: { start: 1 },
        } as Extract<Part, { type: "text" }>,
      ],
    }
    const live = {
      id: "prt_active",
      sessionID: "ses_active",
      messageID: "msg_active",
      type: "text",
      text: "uncommitted provider prefix",
      time: { start: 1 },
    } as Extract<Part, { type: "text" }>

    const repaired = overlayCurrentPartSnapshots([durable], [live])
    expect(repaired[0]?.parts).toEqual([live])
    expect(durable.parts[0]?.text).toBe("")
  })

  test("adds an active part published just before the initial durable row", () => {
    const message = { info: { id: "msg_active" }, parts: [] as Part[] }
    const live = {
      id: "prt_active",
      sessionID: "ses_active",
      messageID: "msg_active",
      type: "text",
      text: "prefix",
      time: { start: 1 },
    } as Extract<Part, { type: "text" }>

    expect(overlayCurrentPartSnapshots([message], [live])[0]?.parts).toEqual([live])
  })

  test("does not alter history when no producer-owned part is active", () => {
    const message = { info: { id: "msg_done" }, parts: [] as Part[] }
    expect(overlayCurrentPartSnapshots([message], [])).toEqual([message])
  })
})
