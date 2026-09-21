import { describe, expect, test } from "bun:test"
import {
  hasSessionMessageStateSemantics,
  isSessionMessageStateProjection,
  type SessionMessageInfo,
} from "./session-message-info"
import { UserTurnSource } from "@opencode-ai/schema/session-v1"
import {
  isSemanticUserMessage,
  isStateProjectionMessage,
  hasStateSemanticsMessage,
  isConversationParentMessage,
  latestRestorableUserMessage,
  normalizeSessionMessages,
  userTurnPresentation,
} from "./session-message"

describe("normalizeSessionMessages", () => {
  test("projects current turns into stable legacy rendering records", () => {
    const source = [
      { id: "msg_1", type: "agent-switched", agent: "build", time: { created: 1 } },
      {
        id: "msg_2",
        type: "model-switched",
        model: { id: "claude", providerID: "anthropic", variant: "high" },
        time: { created: 2 },
      },
      {
        id: "msg_3",
        type: "user",
        text: "inspect @src/client.ts",
        files: [
          {
            data: "aGVsbG8=",
            mime: "text/plain",
            name: "note.txt",
            source: { type: "inline" },
          },
          {
            data: "ZXhwb3J0IHt9",
            mime: "text/plain",
            name: "client.ts",
            source: { type: "inline" },
            mention: { text: "@src/client.ts", start: 8, end: 22 },
          },
        ],
        agents: [{ name: "review", mention: { text: "@review", start: 0, end: 7 } }],
        time: { created: 3 },
      },
      {
        id: "msg_4",
        type: "assistant",
        agent: "build",
        model: { id: "claude", providerID: "anthropic", variant: "high" },
        content: [
          { type: "reasoning", text: "Thinking", time: { created: 4, completed: 5 } },
          { type: "text", text: "Result" },
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "note.txt" },
              metadata: { title: "note.txt" },
              content: [{ type: "text", text: "hello" }],
            },
            time: { created: 5, ran: 6, completed: 7 },
          },
        ],
        cost: 0.1,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
        time: { created: 4, completed: 7 },
      },
      {
        id: "msg_5",
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "summary",
        recent: "recent",
        time: { created: 8 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toMatchObject({
      id: "msg_3",
      role: "user",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude", variant: "high" },
      provenance: { owner: "user", source: "prompt" },
    })
    expect(isSemanticUserMessage(result.messages[0]!)).toBe(true)
    expect(result.messages[1]).toMatchObject({ id: "msg_4", role: "assistant", parentID: "msg_3", cost: 0.1 })
    expect(result.parts.get("msg_3")?.map((part) => part.id)).toEqual([
      "msg_3:text:0",
      "msg_3:file:0",
      "msg_3:file:1",
      "msg_3:agent:0",
      "msg_5:compaction",
    ])
    expect(result.parts.get("msg_3")?.[2]).toMatchObject({
      type: "file",
      source: {
        type: "file",
        path: "src/client.ts",
        text: { value: "@src/client.ts", start: 8, end: 22 },
      },
    })
    expect(result.parts.get("msg_4")?.map((part) => part.id)).toEqual(["msg_4:reasoning:0", "msg_4:text:0", "call_1"])
    expect(result.parts.get("msg_4")?.[2]).toMatchObject({
      type: "tool",
      tool: "read",
      state: { status: "completed", output: "hello" },
    })
  })

  test("does not invent a parent for an assistant-only page", () => {
    const source = [
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "orphan" }],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    expect(normalizeSessionMessages("ses_1", source).messages).toEqual([])
  })

  test("projects a current shell message into a renderable standalone turn", () => {
    const source = [
      {
        id: "msg_shell",
        type: "shell",
        shellID: "shell_1",
        command: "printf hello",
        status: "exited",
        exit: 0,
        output: { output: "hello", cursor: 5, size: 5, truncated: false },
        time: { created: 1, completed: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.messages).toEqual([
      expect.objectContaining({
        id: "msg_shell",
        role: "user",
        provenance: { owner: "user", source: "shell" },
      }),
      expect.objectContaining({ id: "msg_shell:assistant", role: "assistant", parentID: "msg_shell" }),
    ])
    expect(userTurnPresentation(result.messages[0]!)).toBe("shell")
    expect(isSemanticUserMessage(result.messages[0]!)).toBe(false)
    expect(result.parts.get("msg_shell")).toEqual([expect.objectContaining({ type: "text", text: "printf hello" })])
    expect(result.parts.get("msg_shell:assistant")).toEqual([
      expect.objectContaining({
        type: "tool",
        tool: "bash",
        state: expect.objectContaining({
          status: "completed",
          input: { command: "printf hello" },
          output: "hello",
          title: "Shell",
        }),
      }),
    ])
  })

  test("projects current synthetic messages as host-owned compatibility turns", () => {
    const source = [
      {
        id: "msg_synthetic",
        type: "synthetic",
        sessionID: "ses_1",
        text: "Continue from the prior checkpoint.",
        time: { created: 1 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)
    const message = result.messages[0]

    expect(message).toMatchObject({
      id: "msg_synthetic",
      role: "user",
      provenance: { owner: "host", source: "v2.synthetic" },
    })
    expect(userTurnPresentation(message!)).toBe("synthetic")
    expect(isSemanticUserMessage(message!)).toBe(false)
  })

  test("preserves native current user and synthetic provenance without compatibility rewriting", () => {
    const source = [
      {
        id: "msg_host",
        type: "user",
        text: "scheduled work",
        provenance: { owner: "host", source: UserTurnSource.HostPrompt },
        time: { created: 1 },
      },
      {
        id: "msg_goal",
        type: "synthetic",
        sessionID: "ses_1",
        text: "continue after audit",
        provenance: {
          owner: "host",
          source: UserTurnSource.GoalContinuation,
          sourceMessageID: "msg_host",
          ref: "reservation-1",
        },
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)
    expect(result.messages).toMatchObject([
      {
        id: "msg_host",
        provenance: { owner: "host", source: UserTurnSource.HostPrompt },
      },
      {
        id: "msg_goal",
        provenance: {
          owner: "host",
          source: UserTurnSource.GoalContinuation,
          sourceMessageID: "msg_host",
          ref: "reservation-1",
        },
      },
    ])
    expect(userTurnPresentation(result.messages[0]!)).toBe("host")
    expect(userTurnPresentation(result.messages[1]!)).toBe("synthetic")
  })

  test("keeps current state projections transparent to assistant parenting", () => {
    const source = [
      {
        id: "msg_root",
        type: "user",
        text: "root request",
        provenance: { owner: "user", source: UserTurnSource.Prompt },
        time: { created: 1 },
      },
      {
        id: "msg_state",
        type: "synthetic",
        sessionID: "ses_1",
        text: '<goal_progress state="current" />',
        provenance: { owner: "host", source: UserTurnSource.GoalProgress, ref: "goal-state:test" },
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

    const result = normalizeSessionMessages("ses_1", source)
    const state = result.messages.find((message) => message.id === "msg_state")
    const assistant = result.messages.find((message) => message.id === "msg_assistant")
    expect(state && isStateProjectionMessage(state)).toBe(true)
    expect(state && isConversationParentMessage(state)).toBe(false)
    expect(isConversationParentMessage(result.messages[0]!)).toBe(true)
    expect(assistant).toMatchObject({ role: "assistant", parentID: "msg_root" })
  })

  test("historical state-shaped records remain history instead of becoming live STATE", () => {
    const source = [
      {
        id: "msg_root",
        type: "user",
        text: "root request",
        provenance: { owner: "user", source: UserTurnSource.Prompt },
        time: { created: 0 },
      },
      {
        id: "msg_historical_state",
        type: "synthetic",
        sessionID: "ses_1",
        text: "old Goal progress",
        provenance: {
          owner: "host",
          source: UserTurnSource.GoalProgress,
          lifetime: "historical",
          ref: "goal-state:old",
        },
        time: { created: 1 },
      },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "response" }],
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]

    expect(isSessionMessageStateProjection(source[1]!)).toBe(false)
    expect(hasSessionMessageStateSemantics(source[1]!)).toBe(true)
    const result = normalizeSessionMessages("ses_1", source)
    const historical = result.messages.find((message) => message.id === "msg_historical_state")!
    const assistant = result.messages.find((message) => message.id === "msg_assistant")
    expect(isStateProjectionMessage(historical)).toBe(false)
    expect(hasStateSemanticsMessage(historical)).toBe(true)
    expect(isConversationParentMessage(historical)).toBe(false)
    expect(assistant).toMatchObject({ role: "assistant", parentID: "msg_root" })
  })

  test("historical semantic users cannot restore current Session model state", () => {
    const live = {
      id: "msg_live_restore",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "live" },
      provenance: { owner: "user" as const, source: UserTurnSource.Prompt },
    } as any
    const historical = {
      ...live,
      id: "msg_historical_restore",
      model: { providerID: "test", modelID: "stale" },
      provenance: { ...live.provenance, lifetime: "historical" as const },
    }

    expect(latestRestorableUserMessage([live, historical])?.id).toBe(live.id)
  })

  test("adapts current edit fields for the legacy edit renderer", () => {
    const source = [
      { id: "msg_user", type: "user", text: "edit it", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "call_edit",
            name: "edit",
            state: {
              status: "completed",
              input: { path: "/repo/README.md", oldString: "old", newString: "new" },
              content: [{ type: "text", text: "Edited file successfully" }],
              metadata: {
                files: [
                  {
                    file: "README.md",
                    patch: "@@ -1 +1 @@\n-old\n+new",
                    additions: 1,
                    deletions: 1,
                    status: "modified",
                  },
                ],
                replacements: 1,
              },
            },
            time: { created: 2, ran: 3, completed: 4 },
          },
        ],
        time: { created: 2, completed: 4 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.parts.get("msg_assistant")).toEqual([
      expect.objectContaining({
        type: "tool",
        tool: "edit",
        state: expect.objectContaining({
          status: "completed",
          input: expect.objectContaining({ path: "/repo/README.md", filePath: "/repo/README.md" }),
          metadata: expect.objectContaining({
            filediff: {
              file: "README.md",
              patch: "@@ -1 +1 @@\n-old\n+new",
              additions: 1,
              deletions: 1,
            },
          }),
        }),
      }),
    ])
  })
})
