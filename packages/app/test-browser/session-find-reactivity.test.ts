import { expect, test } from "bun:test"
import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { createRoot, createSignal } from "solid-js"
import { createSessionFindMatcher } from "../src/pages/session/session-find"

const userMessage = (id: string): UserMessage =>
  ({ id, role: "user", sessionID: "s1", time: { created: 0 } }) as unknown as UserMessage

const textPart = (id: string, messageID: string, text: string): Part =>
  ({ id, type: "text", messageID, sessionID: "s1", text }) as unknown as Part

test("session Find stays idle without a query and isolates streaming work to the changed turn", () => {
  createRoot((dispose) => {
    const turns = [userMessage("u1"), userMessage("u2")]
    const [turnList] = createSignal(turns)
    const [messages] = createSignal<Message[]>([...turns])
    const [u1Parts, setU1Parts] = createSignal<Part[]>([textPart("p1", "u1", "needle stable")])
    const [u2Parts, setU2Parts] = createSignal<Part[]>([textPart("p2", "u2", "unrelated")])
    const reads = new Map<string, number>()
    const getParts = (id: string) => {
      reads.set(id, (reads.get(id) ?? 0) + 1)
      if (id === "u1") return u1Parts()
      if (id === "u2") return u2Parts()
      return []
    }
    const matcher = createSessionFindMatcher({ turns: turnList, sessionMessages: messages, parts: getParts })

    matcher.focus()
    expect(matcher.count()).toBe(0)
    expect(reads.size).toBe(0)

    matcher.setQuery("needle")
    matcher.focus()
    expect(matcher.count()).toBe(1)
    expect(matcher.activeTurnID()).toBe("u1")
    const matched = matcher.matchedTurnIDs()
    const u1Reads = reads.get("u1") ?? 0
    const u2Reads = reads.get("u2") ?? 0

    setU2Parts([textPart("p2", "u2", "unrelated streaming continuation")])
    expect(matcher.count()).toBe(1)
    expect(matcher.matchedTurnIDs()).toBe(matched)
    expect(reads.get("u1") ?? 0).toBe(u1Reads)
    expect(reads.get("u2") ?? 0).toBeGreaterThan(u2Reads)

    setU1Parts([textPart("p1", "u1", "needle stable and streaming")])
    expect(matcher.count()).toBe(1)
    expect(matcher.matchedTurnIDs()).toBe(matched)
    expect(reads.get("u1") ?? 0).toBeGreaterThan(u1Reads)

    dispose()
  })
})
