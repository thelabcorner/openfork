import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionAttachment } from "../src/session-attachment"

describe("SessionAttachment schema", () => {
  test("brands and prefixes each identity", () => {
    const id = SessionAttachment.ID.create()
    const blob = SessionAttachment.BlobID.create()
    const grant = SessionAttachment.GrantID.create()
    expect(id.startsWith("att_")).toBe(true)
    expect(blob.startsWith("abl_")).toBe(true)
    expect(grant.startsWith("agn_")).toBe(true)
    expect(() => Schema.decodeUnknownSync(SessionAttachment.Handle)("upload-1")).not.toThrow()
    expect(() => Schema.decodeUnknownSync(SessionAttachment.Handle)("att_1")).toThrow()
  })

  test("decodes a task grant target and rejects an unknown kind", () => {
    const decode = Schema.decodeUnknownSync(SessionAttachment.GrantTarget)
    const task = decode({
      kind: "task",
      sourceSessionID: "ses_1",
      assistantMessageID: "msg_a",
      toolCallID: "call_1",
      toolPartID: "prt_1",
      childSessionID: "ses_2",
    })
    expect(task.kind).toBe("task")
    expect(() => decode({ kind: "nope" })).toThrow()
  })

  test("decodes a swarm grant target bound to a run and member session", () => {
    const decode = Schema.decodeUnknownSync(SessionAttachment.GrantTarget)
    const swarm = decode({
      kind: "swarm",
      taskID: "swt_1",
      runID: "swrn_1",
      sessionInputID: "msg_input_1",
      memberSessionID: "ses_member",
    })
    expect(swarm.kind).toBe("swarm")
  })

  test("omits undefined optional fields when encoding a manifest", () => {
    const encode = Schema.encodeSync(SessionAttachment.Manifest)
    const encoded = encode({
      sessionID: "ses_1" as never,
      currentTurn: [
        {
          handle: "upload-1" as never,
          id: "att_1" as never,
          mime: "image/png",
          byteLength: 4,
          eligibility: "eligible",
          availability: "available",
        },
      ],
      activeGrants: [],
      truncated: false,
    })
    expect(encoded.currentTurn[0]).not.toHaveProperty("filename")
    expect(encoded.currentTurn[0]).not.toHaveProperty("sourceMessageID")
    expect(encoded.currentTurn[0]).not.toHaveProperty("grantID")
  })

  test("keeps selection, authorization, resolution, and inclusion as separate facts", () => {
    const status = Schema.decodeUnknownSync(SessionAttachment.HandoffStatus)({
      selected: true,
      authorized: true,
      resolved: false,
      includedInProviderRequest: false,
    })
    expect(status.authorized).toBe(true)
    expect(status.includedInProviderRequest).toBe(false)
  })
})
