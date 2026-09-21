import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { UserTurnSource } from "@opencode-ai/schema/session-v1"
import {
  isTimelineReady,
  loadOlderTimeline,
  selectUserMessages,
  selectVisibleUserMessages,
} from "./model"

const user = (id: string) => ({ id, role: "user" }) as UserMessage
const assistant = (id: string) => ({ id, role: "assistant" }) as AssistantMessage

describe("timeline model", () => {
  test("selects users and applies the revert boundary", () => {
    const messages: Message[] = [user("msg_z"), assistant("msg_a"), user("msg_b"), user("msg_c")]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_c"])
    expect(selectVisibleUserMessages(users, "msg_b").map((message) => message.id)).toEqual(["msg_z"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })

  test("excludes explicit V1 orchestration turns from semantic user navigation", () => {
    const messages: Message[] = [
      user("msg_user"),
      {
        ...user("msg_goal"),
        provenance: { owner: "host", source: UserTurnSource.GoalContinuation, sourceMessageID: "msg_user" },
      },
      {
        ...user("msg_host"),
        provenance: { owner: "host", source: UserTurnSource.HostPrompt },
      },
      {
        ...user("msg_scheduled"),
        provenance: { owner: "host", source: UserTurnSource.ScheduledTaskRun, ref: "str_test" },
      },
      {
        ...user("msg_plan"),
        provenance: { owner: "user", source: UserTurnSource.PlanApproval },
      },
      assistant("msg_assistant"),
    ]

    expect(selectUserMessages(messages).map((message) => message.id)).toEqual(["msg_user"])
    expect(isTimelineReady(messages.slice(1), true)).toBe(false)
  })

  test("waits for an assistant-only load to hydrate its user root", () => {
    expect(isTimelineReady([assistant("msg_2")], true)).toBe(false)
    expect(isTimelineReady([user("msg_1"), assistant("msg_2")], true)).toBe(true)
    expect(isTimelineReady([], false)).toBe(true)
  })

  test("historical semantic users stay visible but cannot restore live model state", () => {
    const live = {
      ...user("msg_live"),
      provenance: { owner: "user" as const, source: UserTurnSource.Prompt },
    }
    const historical = {
      ...user("msg_imported"),
      provenance: { owner: "user" as const, source: UserTurnSource.Prompt, lifetime: "historical" as const },
    }
    const users = selectUserMessages([live, historical])

    expect(users.map((message) => message.id)).toEqual(["msg_live", "msg_imported"])
  })

  test("loads exactly one opaque cursor page", async () => {
    let calls = 0
    const anchors: Array<string | boolean> = []

    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
      before: () => anchors.push("before"),
      after: (done) => anchors.push("after", done),
    })

    expect(calls).toBe(1)
    expect(anchors).toEqual(["before", "after", true])
  })

  test("stops when a page adds no raw messages", async () => {
    let calls = 0
    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
    })

    expect(calls).toBe(1)
  })

  test("does not restore an anchor after the session changes", async () => {
    let sessionID = "ses_old"
    let restore = 0

    await loadOlderTimeline({
      sessionID: () => sessionID,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        sessionID = "ses_new"
      },
      after: () => {
        restore += 1
      },
    })

    expect(restore).toBe(0)
  })

  test("releases the anchor when loading history fails", async () => {
    let restore = 0

    await expect(
      loadOlderTimeline({
        sessionID: () => "ses_test",
        more: () => true,
        loading: () => false,
        loadMore: async () => {
          throw new Error("history failed")
        },
        after: () => {
          restore += 1
        },
      }),
    ).rejects.toThrow("history failed")

    expect(restore).toBe(1)
  })
})
