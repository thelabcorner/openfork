import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { buildTurnSearchText, matchSessionTurns, type TurnTextCache } from "./session-find"

const userMessage = (id: string): UserMessage =>
  ({ id, role: "user", sessionID: "s1", time: { created: 0 } }) as unknown as UserMessage

const assistantMessage = (id: string, parentID: string): Message =>
  ({ id, role: "assistant", parentID, sessionID: "s1", time: { created: 0 } }) as unknown as Message

const textPart = (id: string, messageID: string, text: string): Part =>
  ({ id, type: "text", messageID, sessionID: "s1", text }) as unknown as Part

const reasoningPart = (id: string, messageID: string, text: string): Part =>
  ({ id, type: "reasoning", messageID, sessionID: "s1", text, time: { start: 0 } }) as unknown as Part

const toolPart = (id: string, messageID: string, tool: string, state: ToolPart["state"]): Part =>
  ({ id, type: "tool", messageID, sessionID: "s1", callID: id, tool, state }) as unknown as Part

describe("matchSessionTurns", () => {
  test("matches user message text", () => {
    const turns = [userMessage("u1"), userMessage("u2")]
    const messages: Message[] = [turns[0], turns[1]]
    const parts: Record<string, Part[]> = {
      u1: [textPart("p1", "u1", "how do I center a div")],
      u2: [textPart("p2", "u2", "unrelated question")],
    }
    const result = matchSessionTurns(turns, messages, (id) => parts[id] ?? [], "center a div")
    expect(result).toEqual(["u1"])
  })

  test("matches assistant reasoning and tool input/output for the owning turn", () => {
    const turn = userMessage("u1")
    const assistant = assistantMessage("a1", "u1")
    const messages: Message[] = [turn, assistant]
    const parts: Record<string, Part[]> = {
      u1: [textPart("p1", "u1", "fix the bug")],
      a1: [
        reasoningPart("p2", "a1", "the root cause is a race condition"),
        toolPart("p3", "a1", "bash", {
          status: "completed",
          input: { command: "grep -rn TODO" },
          output: "found 3 matches",
          title: "grep",
          metadata: {},
          time: { start: 0, end: 1 },
        }),
      ],
    }
    const getParts = (id: string) => parts[id] ?? []

    expect(matchSessionTurns([turn], messages, getParts, "race condition")).toEqual(["u1"])
    expect(matchSessionTurns([turn], messages, getParts, "TODO")).toEqual(["u1"])
    expect(matchSessionTurns([turn], messages, getParts, "found 3 matches")).toEqual(["u1"])
    expect(matchSessionTurns([turn], messages, getParts, "nothing here")).toEqual([])
  })

  test("is case-insensitive and returns matches in transcript order", () => {
    const turns = [userMessage("u1"), userMessage("u2"), userMessage("u3")]
    const messages: Message[] = [...turns]
    const parts: Record<string, Part[]> = {
      u1: [textPart("p1", "u1", "Alpha")],
      u2: [textPart("p2", "u2", "beta")],
      u3: [textPart("p3", "u3", "ALPHA again")],
    }
    const result = matchSessionTurns(turns, messages, (id) => parts[id] ?? [], "alpha")
    expect(result).toEqual(["u1", "u3"])
  })

  test("empty query matches nothing", () => {
    const turns = [userMessage("u1")]
    const messages: Message[] = [...turns]
    const parts: Record<string, Part[]> = { u1: [textPart("p1", "u1", "hello")] }
    expect(matchSessionTurns(turns, messages, (id) => parts[id] ?? [], "  ")).toEqual([])
  })
})

describe("buildTurnSearchText caching", () => {
  test("reuses cached text for an unchanged turn and rebuilds a changed one", () => {
    const turns = [userMessage("u1"), userMessage("u2")]
    const messages: Message[] = [...turns]
    const parts: Record<string, Part[]> = {
      u1: [textPart("p1", "u1", "stable content")],
      u2: [textPart("p2", "u2", "original content")],
    }
    const cache: TurnTextCache = new Map()
    const getParts = (id: string) => parts[id] ?? []

    const first = buildTurnSearchText(turns, messages, getParts, cache)
    expect(first.get("u1")).toBe("stable content")
    expect(first.get("u2")).toBe("original content")

    // Only u2's content actually changes; u1's signature (part count/id/length) is identical.
    parts.u2 = [textPart("p2", "u2", "updated content")]
    const second = buildTurnSearchText(turns, messages, getParts, cache)
    expect(second.get("u1")).toBe("stable content")
    expect(second.get("u2")).toBe("updated content")
  })
})
