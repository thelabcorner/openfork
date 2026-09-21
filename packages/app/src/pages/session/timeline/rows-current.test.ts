import { describe, expect, mock, test } from "bun:test"
import type { SessionMessageInfo } from "@/utils/session-message-info"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { UserTurnSource } from "@opencode-ai/schema/session-v1"
import { isSemanticUserMessage, normalizeSessionMessages } from "@/utils/session-message"
import type { TimelineRow as TimelineRowNS } from "./rows"

mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({
      type: "part" as const,
      key: ref.part.id,
      ref: { messageID: ref.messageID, partID: ref.part.id },
    })),
}))

// rows.ts now imports the markdown-height predictor, which imports the shared
// text-layout lib (pretext-timeline workstream). Stub the lib so this suite
// runs before it lands; the flag defaults to "off" (no hint computed), and the
// gating test below flips it to "pretext" to observe the hint.
let textLayoutModeValue: "off" | "prior" | "pretext" = "off"
mock.module("@/lib/text-layout", () => ({
  estimateTextHeight: (text: string) => (text ? 100 : undefined),
  prepareTextLayout: () => undefined,
  textLayoutMode: () => textLayoutModeValue,
}))

const { Timeline, TimelineRow } = await import("./rows")

describe("current session timeline rows", () => {
  test("keeps a Goal continuation out of the human timeline root while attaching its assistant to the prior user turn", () => {
    const source = [
      { id: "msg_user", type: "user", text: "do the work", time: { created: 1 } },
      { id: "msg_goal", type: "synthetic", text: "continue after audit", time: { created: 2 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "continued" }],
        time: { created: 3, completed: 4 },
      },
    ] satisfies SessionMessageInfo[]
    const user = {
      id: "msg_user",
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      provenance: { owner: "user" as const, source: UserTurnSource.Prompt },
    } as UserMessage
    const continuation = {
      ...user,
      id: "msg_goal",
      time: { created: 2 },
      provenance: {
        owner: "host" as const,
        source: UserTurnSource.GoalContinuation,
        sourceMessageID: "msg_user",
      },
    } as UserMessage
    const assistant = {
      id: "msg_assistant",
      sessionID: "ses_1",
      role: "assistant" as const,
      parentID: "msg_goal",
      time: { created: 3, completed: 4 },
      agent: "build",
      mode: "build",
      providerID: "provider",
      modelID: "model",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } as AssistantMessage
    const messages = new Map<string, UserMessage | AssistantMessage>([
      [user.id, user],
      [continuation.id, continuation],
      [assistant.id, assistant],
    ])
    const parts = new Map<string, Part[]>([
      [user.id, [{ id: "part_user", sessionID: "ses_1", messageID: user.id, type: "text", text: "do the work" }]],
      [
        continuation.id,
        [
          {
            id: "part_goal",
            sessionID: "ses_1",
            messageID: continuation.id,
            type: "text",
            text: "continue after audit",
            synthetic: true,
          },
        ],
      ],
      [assistant.id, [{ id: "part_answer", sessionID: "ses_1", messageID: assistant.id, type: "text", text: "continued" }]],
    ])

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => parts.get(messageID) ?? [],
      true,
      false,
      "idle",
      false,
      [...messages.values()].filter(isSemanticUserMessage),
    )

    expect(result.activeMessageID).toBe(user.id)
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_user",
      "assistant-part:msg_user:part_answer",
    ])
  })

  test("uses explicit continuation lineage instead of the nearest adjacent user turn", () => {
    const source = [
      {
        id: "msg_root_a",
        type: "user",
        text: "root A",
        provenance: { owner: "user", source: UserTurnSource.Prompt },
        time: { created: 1 },
      },
      {
        id: "msg_root_b",
        type: "user",
        text: "root B",
        provenance: { owner: "user", source: UserTurnSource.Prompt },
        time: { created: 2 },
      },
      {
        id: "msg_goal",
        type: "synthetic",
        sessionID: "ses_1",
        text: "continue A",
        provenance: {
          owner: "host",
          source: UserTurnSource.GoalContinuation,
          sourceMessageID: "msg_root_a",
          ref: "reservation-a",
        },
        time: { created: 3 },
      },
      {
        id: "msg_goal_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "continued A" }],
        time: { created: 4, completed: 5 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      false,
      "idle",
      false,
      normalized.messages.filter(isSemanticUserMessage),
    )

    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_root_a",
      "assistant-part:msg_root_a:msg_goal_assistant:text:0",
      "turn-gap:msg_root_b",
      "user-message:msg_root_b",
    ])
  })

  test("keeps current Goal state transparent to timeline turn grouping", () => {
    const source = [
      {
        id: "msg_root",
        type: "user",
        text: "root",
        provenance: { owner: "user", source: UserTurnSource.Prompt },
        time: { created: 1 },
      },
      {
        id: "msg_state",
        type: "synthetic",
        sessionID: "ses_1",
        text: '<goal_progress state="current" />',
        provenance: { owner: "host", source: UserTurnSource.GoalProgress, ref: "goal-state:timeline" },
        time: { created: 2 },
      },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "response" }],
        time: { created: 3, completed: 4 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const grouped = Timeline.groupTurns(
      source,
      (messageID) => messages.get(messageID),
      normalized.messages.filter(isSemanticUserMessage),
    )

    expect(grouped.turns).toHaveLength(1)
    expect(grouped.turns[0]?.user.id).toBe("msg_root")
    expect(grouped.turns[0]?.assistants.map((message) => message.id)).toEqual(["msg_assistant"])
    expect(grouped.turnByUserID.has("msg_state")).toBe(false)
  })

  test("renders host-originated work without a human user row", () => {
    const source = [
      { id: "msg_host", type: "synthetic", text: "scheduled work", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "done" }],
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]
    const host = {
      id: "msg_host",
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      provenance: { owner: "host" as const, source: UserTurnSource.HostPrompt },
    } as UserMessage
    const assistant = {
      id: "msg_assistant",
      sessionID: "ses_1",
      role: "assistant" as const,
      parentID: host.id,
      time: { created: 2, completed: 3 },
      agent: "build",
      mode: "build",
      providerID: "provider",
      modelID: "model",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } as AssistantMessage
    const parts = new Map<string, Part[]>([
      [host.id, [{ id: "part_host", sessionID: "ses_1", messageID: host.id, type: "text", text: "scheduled work" }]],
      [assistant.id, [{ id: "part_answer", sessionID: "ses_1", messageID: assistant.id, type: "text", text: "done" }]],
    ])
    const messages = new Map<string, UserMessage | AssistantMessage>([
      [host.id, host],
      [assistant.id, assistant],
    ])

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => parts.get(messageID) ?? [],
      true,
      false,
      "idle",
      false,
      [],
    )

    expect(result.activeMessageID).toBe(host.id)
    expect(result.rows.map(TimelineRow.key)).toEqual(["assistant-part:msg_host:part_answer"])
  })

  test("renders a Goal Auditor assistant under its hidden synthetic root", () => {
    const source = [
      {
        id: "msg_auditor_prompt",
        type: "synthetic",
        text: "audit the latest Goal worker cycle",
        provenance: { owner: "host" as const, source: "special-agent.goal-auditor" },
        time: { created: 1 },
      },
      {
        id: "msg_auditor_assistant",
        type: "assistant",
        agent: "goal_auditor",
        model: { id: "auditor-model", providerID: "opencode" },
        content: [{ type: "text" as const, text: "Live auditor output" }],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_auditor", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      false,
      "idle",
      false,
      [],
    )

    expect(result.rows.map(TimelineRow.key)).toEqual([
      "assistant-part:msg_auditor_prompt:msg_auditor_assistant:text:0",
    ])
  })

  test("treats a V1 scheduled-task Synthetic provenance turn as a hidden worker root", () => {
    const source = [
      { id: "msg_scheduled", type: "user", text: "scheduled work", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "done" }],
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]
    const scheduled = {
      id: "msg_scheduled",
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      provenance: { owner: "host" as const, source: UserTurnSource.ScheduledTaskRun, ref: "str_test" },
    } as UserMessage
    const assistant = {
      id: "msg_assistant",
      sessionID: "ses_1",
      role: "assistant" as const,
      parentID: scheduled.id,
      time: { created: 2, completed: 3 },
      agent: "build",
      mode: "build",
      providerID: "provider",
      modelID: "model",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } as AssistantMessage
    const parts = new Map<string, Part[]>([
      [
        scheduled.id,
        [{ id: "part_scheduled", sessionID: "ses_1", messageID: scheduled.id, type: "text", text: "scheduled work" }],
      ],
      [assistant.id, [{ id: "part_answer", sessionID: "ses_1", messageID: assistant.id, type: "text", text: "done" }]],
    ])
    const messages = new Map<string, UserMessage | AssistantMessage>([
      [scheduled.id, scheduled],
      [assistant.id, assistant],
    ])

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => parts.get(messageID) ?? [],
      true,
      false,
      "idle",
      false,
      [],
    )

    expect(result.activeMessageID).toBe(scheduled.id)
    expect(result.rows.map(TimelineRow.key)).toEqual(["assistant-part:msg_scheduled:part_answer"])
  })

  test("derives turns and tagged rows from chronological current messages", () => {
    const source = [
      { id: "msg_1", type: "user", text: "first", time: { created: 1 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_3", type: "user", text: "second", time: { created: 4 } },
      {
        id: "msg_4",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "reasoning", text: "working" }],
        time: { created: 5 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      false,
      "busy",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.activeMessageID).toBe("msg_3")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_1",
      "assistant-part:msg_1:msg_2:text:0",
      "turn-gap:msg_3",
      "user-message:msg_3",
      "assistant-part:msg_3:msg_4:reasoning:0",
    ])
  })

  test("renders a current shell message as a standalone turn", () => {
    const source = [
      {
        id: "msg_shell",
        type: "shell",
        shellID: "shell_1",
        command: "pwd",
        status: "exited",
        exit: 0,
        output: { output: "/repo", cursor: 5, size: 5, truncated: false },
        time: { created: 1, completed: 2 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      false,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.activeMessageID).toBe("msg_shell")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_shell",
      "assistant-part:msg_shell:msg_shell:tool",
    ])
  })

  test("keeps a projected parent missing from the source page before newer turns", () => {
    const source = [
      { id: "msg_user_1", type: "user", text: "first question", time: { created: 1 } },
      {
        id: "msg_assistant_1",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "first answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_user_2", type: "user", text: "second question", time: { created: 4 } },
      {
        id: "msg_assistant_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "second answer" }],
        time: { created: 5, completed: 6 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source.slice(1),
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      false,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_user_1",
      "assistant-part:msg_user_1:msg_assistant_1:text:0",
      "turn-gap:msg_user_2",
      "user-message:msg_user_2",
      "assistant-part:msg_user_2:msg_assistant_2:text:0",
    ])
  })

  test("renders an optimistic user turn and thinking before the protocol message arrives", () => {
    const source = [
      { id: "msg_z", type: "user", text: "existing", time: { created: 1 } },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const optimistic = {
      id: "msg_a",
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 2 },
      agent: "build",
      model: { modelID: "model", providerID: "provider" },
    }
    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) =>
        messageID === optimistic.id ? optimistic : normalized.messages.find((message) => message.id === messageID),
      () => [],
      true,
      false,
      "busy",
      true,
      [...normalized.messages.filter((message) => message.role === "user"), optimistic],
    )

    expect(result.activeMessageID).toBe(optimistic.id)
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_z",
      "turn-gap:msg_a",
      "user-message:msg_a",
      "thinking:msg_a",
    ])
  })

  test("removes a failed assistant error when the turn continues streaming", () => {
    const source = [
      { id: "msg_user", type: "user", text: "recover", time: { created: 1 } },
      {
        id: "msg_failed",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        error: { type: "ProviderError", message: "temporary failure" },
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_recovery",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "streaming again" }],
        time: { created: 4 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      false,
      "busy",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart"])
  })

  test("gates the markdown height hint on the working turn during streaming", () => {
    const source = [
      { id: "msg_user_1", type: "user", text: "first question", time: { created: 1 } },
      {
        id: "msg_assistant_1",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "first answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_user_2", type: "user", text: "second question", time: { created: 4 } },
      {
        id: "msg_assistant_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "second answer" }],
        time: { created: 5 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    textLayoutModeValue = "pretext"
    try {
      const result = Timeline.constructSessionMessageRows(
        source,
        (messageID) => messages.get(messageID),
        (messageID) => normalized.parts.get(messageID) ?? [],
        true,
        false,
        "busy",
        true,
        normalized.messages.filter((message) => message.role === "user"),
      )
      const parts = result.rows.filter(
        (row): row is Extract<TimelineRowNS.TimelineRow, { _tag: "AssistantPart" }> => row._tag === "AssistantPart",
      )
      expect(parts).toHaveLength(2)
      // Completed (non-active) turn keeps the advisory pre-mount hint...
      expect(parts[0]?.heightHint).toBeTypeOf("number")
      // ...while the streaming (active + busy) turn omits it so row equality
      // stays stable across part deltas — no markdown remount mid-stream
      // (the pretext-timeline benchmark regression this gate fixes).
      expect(parts[1]?.heightHint).toBeUndefined()
    } finally {
      textLayoutModeValue = "off"
    }
  })
})
