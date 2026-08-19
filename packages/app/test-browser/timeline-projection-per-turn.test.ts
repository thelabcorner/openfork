import { describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"

// Faithful-enough stubs of the real implementations (packages/session-ui/src/components/
// message-part.tsx): unlike rows-current.test.ts's structural-only mocks, this suite
// verifies fine-grained Solid reactivity, so the mocks must dereference the SAME fields
// (part.type / part.text) the real ones do -- otherwise the test wouldn't actually
// exercise the store reads it's trying to validate.
mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: (part: { type: string; text?: string }) => (part.type === "tool" ? true : !!part.text?.trim()),
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

const { normalizeSessionMessages } = await import("@/utils/session-message")
const { Timeline, TimelineRow } = await import("@/pages/session/timeline/rows")
const { createTimelineProjection } = await import("@/pages/session/timeline/projection")

function turn(userID: string, assistantID: string, createdAt: number, text: string): SessionMessageInfo[] {
  return [
    { id: userID, type: "user", text: `q-${userID}`, time: { created: createdAt } },
    {
      id: assistantID,
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [{ type: "text", text }],
      time: { created: createdAt + 1, completed: createdAt + 2 },
    },
  ]
}

describe("createTimelineProjection: per-turn reactive memoization", () => {
  test("streaming a delta into the active turn only recomputes that turn, and matches a full non-memoized rebuild", () => {
    createRoot((dispose) => {
      const sourceInit = [...turn("u1", "a1", 1, "answer one"), ...turn("u2", "a2", 10, "answer two"), ...turn("u3", "a3", 20, "answer three")]
      const normalized = normalizeSessionMessages("ses_1", sourceInit)

      const [sessionMessages] = createSignal<SessionMessageInfo[]>(sourceInit)
      const [messageStore] = createStore<{ list: Message[] }>({ list: normalized.messages })
      const [partStore, setPartStore] = createStore<{ map: Record<string, Part[]> }>({
        map: Object.fromEntries(normalized.parts.entries()),
      })
      const [status] = createSignal<SessionStatus>({ type: "busy" })

      const partReadLog: string[] = []
      const parts = (messageID: string) => {
        partReadLog.push(messageID)
        return partStore.map[messageID] ?? []
      }

      const projection = createTimelineProjection({
        messages: () => messageStore.list,
        userMessages: () => messageStore.list.filter((m): m is UserMessage => m.role === "user"),
        sessionMessages,
        parts,
        status,
        showReasoningSummaries: () => true,
        inlineComments: () => true,
      })

      // Prime.
      projection.rows()
      partReadLog.length = 0

      // Stream a delta into the ACTIVE turn's assistant part (a3), matching the in-place
      // `produce` mutation pattern event-reducer.ts's message.part.delta handler uses.
      setPartStore(
        "map",
        "a3",
        produce((draft) => {
          const part = draft.find((p) => p.type === "text")
          if (part && part.type === "text") part.text += " -- streamed more"
        }),
      )
      projection.rows()

      const touchedTurns = new Set(partReadLog)
      expect(touchedTurns.has("a3")).toBe(true)
      expect(touchedTurns.has("u3")).toBe(true)
      expect(touchedTurns.has("a1")).toBe(false)
      expect(touchedTurns.has("a2")).toBe(false)
      expect(touchedTurns.has("u1")).toBe(false)
      expect(touchedTurns.has("u2")).toBe(false)

      // Equivalence: the memoized projection's final rows must match a from-scratch,
      // non-memoized rebuild (Timeline.constructSessionMessageRows) over the same final state.
      const messageByID = new Map(messageStore.list.map((m) => [m.id, m] as const))
      const fresh = Timeline.constructSessionMessageRows(
        sessionMessages(),
        (id) => messageByID.get(id) as UserMessage,
        (id) => partStore.map[id] ?? [],
        true,
        "busy",
        true,
        messageStore.list.filter((m) => m.role === "user"),
      )
      expect(projection.rows().map(TimelineRow.key)).toEqual(fresh.rows.map(TimelineRow.key))
      expect(projection.activeMessageID()).toBe(fresh.activeMessageID)

      dispose()
    })
  })

  test("mutating a historical (non-active) turn's part recomputes only that turn", () => {
    createRoot((dispose) => {
      const sourceInit = [...turn("u1", "a1", 1, "answer one"), ...turn("u2", "a2", 10, "answer two")]
      const normalized = normalizeSessionMessages("ses_1", sourceInit)

      const [sessionMessages] = createSignal<SessionMessageInfo[]>(sourceInit)
      const [messageStore] = createStore<{ list: Message[] }>({ list: normalized.messages })
      const [partStore, setPartStore] = createStore<{ map: Record<string, Part[]> }>({
        map: Object.fromEntries(normalized.parts.entries()),
      })
      const [status] = createSignal<SessionStatus>({ type: "idle" })

      const partReadLog: string[] = []
      const parts = (messageID: string) => {
        partReadLog.push(messageID)
        return partStore.map[messageID] ?? []
      }

      const projection = createTimelineProjection({
        messages: () => messageStore.list,
        userMessages: () => messageStore.list.filter((m): m is UserMessage => m.role === "user"),
        sessionMessages,
        parts,
        status,
        showReasoningSummaries: () => true,
        inlineComments: () => true,
      })

      projection.rows()
      partReadLog.length = 0

      // A synthetic edit to the FIRST (non-active) turn's assistant part -- e.g. a
      // comment/annotation update -- must not force turn two to recompute.
      setPartStore(
        "map",
        "a1",
        produce((draft) => {
          const part = draft.find((p) => p.type === "text")
          if (part && part.type === "text") part.text += " (edited)"
        }),
      )
      projection.rows()

      const touchedTurns = new Set(partReadLog)
      expect(touchedTurns.has("a1")).toBe(true)
      expect(touchedTurns.has("a2")).toBe(false)
      expect(touchedTurns.has("u2")).toBe(false)

      dispose()
    })
  })

  test("a new turn arriving is included correctly and existing turns' output stays byte-identical", () => {
    createRoot((dispose) => {
      const sourceInit = [...turn("u1", "a1", 1, "answer one")]
      const normalized = normalizeSessionMessages("ses_1", sourceInit)

      const [sessionMessages, setSessionMessages] = createSignal<SessionMessageInfo[]>(sourceInit)
      const [messageStore, setMessageStore] = createStore<{ list: Message[] }>({ list: normalized.messages })
      const [partStore, setPartStore] = createStore<{ map: Record<string, Part[]> }>({
        map: Object.fromEntries(normalized.parts.entries()),
      })
      const [status] = createSignal<SessionStatus>({ type: "idle" })

      const projection = createTimelineProjection({
        messages: () => messageStore.list,
        userMessages: () => messageStore.list.filter((m): m is UserMessage => m.role === "user"),
        sessionMessages,
        parts: (id) => partStore.map[id] ?? [],
        status,
        showReasoningSummaries: () => true,
        inlineComments: () => true,
      })

      const before = projection.rows().map(TimelineRow.key)
      expect(before).toEqual(["user-message:u1", "assistant-part:u1:a1:text:0"])

      const added = turn("u2", "a2", 10, "answer two")
      const nextSource = [...sourceInit, ...added]
      const nextNormalized = normalizeSessionMessages("ses_1", nextSource)
      setSessionMessages(nextSource)
      setMessageStore("list", produce((draft) => draft.push(...nextNormalized.messages.slice(normalized.messages.length))))
      for (const [id, value] of nextNormalized.parts) {
        if (!partStore.map[id]) setPartStore("map", id, value)
      }

      const after = projection.rows().map(TimelineRow.key)
      expect(after).toEqual([
        "user-message:u1",
        "assistant-part:u1:a1:text:0",
        "turn-gap:u2",
        "user-message:u2",
        "assistant-part:u2:a2:text:0",
      ])

      dispose()
    })
  })

  test("reconcile()-based message.updated on the active turn (e.g. token/cost) does not disturb inactive turns", () => {
    createRoot((dispose) => {
      const sourceInit = [...turn("u1", "a1", 1, "answer one"), ...turn("u2", "a2", 10, "answer two")]
      const normalized = normalizeSessionMessages("ses_1", sourceInit)

      const [sessionMessages] = createSignal<SessionMessageInfo[]>(sourceInit)
      const [messageStore, setMessageStore] = createStore<{ list: Message[] }>({ list: normalized.messages })
      const [partStore] = createStore<{ map: Record<string, Part[]> }>({
        map: Object.fromEntries(normalized.parts.entries()),
      })
      const [status] = createSignal<SessionStatus>({ type: "idle" })

      const partReadLog: string[] = []
      const parts = (messageID: string) => {
        partReadLog.push(messageID)
        return partStore.map[messageID] ?? []
      }

      const projection = createTimelineProjection({
        messages: () => messageStore.list,
        userMessages: () => messageStore.list.filter((m): m is UserMessage => m.role === "user"),
        sessionMessages,
        parts,
        status,
        showReasoningSummaries: () => true,
        inlineComments: () => true,
      })

      projection.rows()
      partReadLog.length = 0

      const a2Index = messageStore.list.findIndex((m) => m.id === "a2")
      const a2 = messageStore.list[a2Index]!
      setMessageStore("list", a2Index, reconcile({ ...a2, cost: 0.5 } as Message))
      projection.rows()

      const touchedTurns = new Set(partReadLog)
      expect(touchedTurns.has("a1")).toBe(false)
      expect(touchedTurns.has("u1")).toBe(false)

      dispose()
    })
  })
})
