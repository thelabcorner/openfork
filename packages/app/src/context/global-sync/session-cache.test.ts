import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, QuestionRequest, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { dropSessionCaches, estimateSessionCacheBytes, pickSessionCacheEvictions } from "./session-cache"

const msg = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const part = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) as Part

describe("app session cache", () => {
  test("dropSessionCaches clears orphaned parts without message rows", () => {
    const store: {
      session_status: Record<string, SessionStatus | undefined>
      session_diff: Record<string, FileDiffInfo[] | undefined>
      todo: Record<string, Todo[] | undefined>
      message: Record<string, Message[] | undefined>
      session_message: Record<string, never[] | undefined>
      part: Record<string, Part[] | undefined>
      permission: Record<string, PermissionRequest[] | undefined>
      question: Record<string, QuestionRequest[] | undefined>
      part_text_accum_delta: Record<string, string | undefined>
    } = {
      session_status: { ses_1: { type: "busy" } as SessionStatus },
      session_diff: { ses_1: [] },
      todo: { ses_1: [] as Todo[] },
      message: {},
      session_message: {},
      part: { msg_1: [part("prt_1", "ses_1", "msg_1")] },
      permission: { ses_1: [] as PermissionRequest[] },
      question: { ses_1: [] as QuestionRequest[] },
      part_text_accum_delta: { prt_1: "streamed text" },
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
    expect(store.part.msg_1).toBeUndefined()
    expect(store.part_text_accum_delta.prt_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.session_diff.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
  })

  test("dropSessionCaches clears message-backed parts", () => {
    const m = msg("msg_1", "ses_1")
    const store: {
      session_status: Record<string, SessionStatus | undefined>
      session_diff: Record<string, FileDiffInfo[] | undefined>
      todo: Record<string, Todo[] | undefined>
      message: Record<string, Message[] | undefined>
      session_message: Record<string, never[] | undefined>
      part: Record<string, Part[] | undefined>
      permission: Record<string, PermissionRequest[] | undefined>
      question: Record<string, QuestionRequest[] | undefined>
      part_text_accum_delta: Record<string, string | undefined>
    } = {
      session_status: {},
      session_diff: {},
      todo: {},
      message: { ses_1: [m] },
      session_message: {},
      part: { [m.id]: [part("prt_1", "ses_1", m.id)] },
      permission: {},
      question: {},
      part_text_accum_delta: {},
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
    expect(store.part[m.id]).toBeUndefined()
  })

  test("pickSessionCacheEvictions preserves requested sessions", () => {
    const seen = new Set(["ses_1", "ses_2", "ses_3"])

    const stale = pickSessionCacheEvictions({
      seen,
      keep: "ses_4",
      limit: 2,
      preserve: ["ses_1"],
    })

    expect(stale).toEqual(["ses_2", "ses_3"])
    expect([...seen]).toEqual(["ses_1", "ses_4"])
  })

  test("pickSessionCacheEvictions evicts oldest idle sessions to meet a byte budget", () => {
    const seen = new Set(["ses_1", "ses_2", "ses_3"])
    const weights = new Map([
      ["ses_1", 80],
      ["ses_2", 30],
      ["ses_3", 20],
      ["ses_4", 10],
    ])
    const stale = pickSessionCacheEvictions({
      seen,
      keep: "ses_4",
      limit: 40,
      preserve: ["ses_2"],
      weights,
      maxBytes: 70,
    })

    expect(stale).toEqual(["ses_1"])
    expect([...seen]).toEqual(["ses_2", "ses_3", "ses_4"])
  })

  test("estimateSessionCacheBytes accounts for large inline media strings", () => {
    const m = msg("msg_media", "ses_media")
    const payload = "x".repeat(6 * 1024 * 1024)
    const store = {
      session_status: {},
      session_diff: {},
      todo: {},
      message: { ses_media: [m] },
      session_message: {},
      part: {
        [m.id]: [
          {
            id: "prt_media",
            sessionID: "ses_media",
            messageID: m.id,
            type: "file",
            url: `data:image/png;base64,${payload}`,
            mime: "image/png",
          } as unknown as Part,
        ],
      },
      permission: {},
      question: {},
      part_text_accum_delta: {},
    }

    expect(estimateSessionCacheBytes(store, "ses_media")).toBeGreaterThan(12 * 1024 * 1024)
  })
})
