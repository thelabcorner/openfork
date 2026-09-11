import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTitle } from "@opencode-ai/core/session/title"
import {
  generatedTitleCompletion,
  insertSession,
  insertUserMessage,
  makeHarness,
  textCompletion,
} from "./lib/session-harness"

const h = makeHarness()
const it = h.it
const sessionID = SessionV2.ID.make("ses_title_protocol_test")

const invalidTitleCompletion = () => [
  LLMEvent.toolCall({ id: "generated-title-invalid", name: SessionTitle.GENERATED_TITLE_TOOL, input: { nope: true } }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

describe("SessionTitle structured protocol", () => {
  it.live("keeps policy, host context, protocol, and final artifact on separate channels", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "debug 500 errors in production")
      const title = yield* SessionTitle.Service

      h.enqueueTitle(generatedTitleCompletion("Debugging production 500 errors"))
      const baseline = yield* session.get(sessionID)
      yield* title.regenerate({
        session: baseline,
        prompt: "Prefer direct, technical titles. Previous: {previousTitle}",
      })

      expect(h.titleRequests.length).toBe(1)
      expect((yield* session.get(sessionID)).title).toBe("Debugging production 500 errors")
      const request = h.titleRequests.at(-1)
      expect(request).toBeDefined()
      const system = JSON.stringify(request?.system)
      const messages = JSON.stringify(request?.messages)
      expect(system).toContain(`Previous: ${baseline.title}`)
      expect(system).toContain("title-generation-protocol")
      expect(system).toContain("IMMEDIATELY END GENERATION")
      expect(messages).toContain("title-generation-context")
      expect(messages).toContain("debug 500 errors in production")
      expect(messages).not.toContain("Prefer direct, technical titles")
      expect(request?.tools.map((item) => item.name)).toEqual([SessionTitle.GENERATED_TITLE_TOOL])
      expect(request?.toolChoice).toMatchObject({ type: "required" })
    }),
  )

  it.live("repairs prose in the same title-agent conversation instead of inferring a title from it", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "hello")
      const title = yield* SessionTitle.Service

      h.enqueueTitle(textCompletion(["This looks like a title but is only prose"]))
      h.enqueueTitle(generatedTitleCompletion("Friendly hello"))
      yield* title.regenerate({ session: yield* session.get(sessionID) })

      expect((yield* session.get(sessionID)).title).toBe("Friendly hello")
      expect(h.titleRequests).toHaveLength(2)
      const retry = JSON.stringify(h.titleRequests[1]!.messages)
      expect(retry).toContain("This looks like a title but is only prose")
      expect(retry).toContain("Protocol correction")
      expect(retry).toContain(SessionTitle.GENERATED_TITLE_TOOL)
    }),
  )

  it.live("repairs an invalid generated_title payload in the same title-agent conversation", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "refactor the parser")
      const title = yield* SessionTitle.Service

      h.enqueueTitle(invalidTitleCompletion())
      h.enqueueTitle(generatedTitleCompletion("Parser refactor"))
      yield* title.regenerate({ session: yield* session.get(sessionID) })

      expect((yield* session.get(sessionID)).title).toBe("Parser refactor")
      expect(h.titleRequests).toHaveLength(2)
      const retry = JSON.stringify(h.titleRequests[1]!.messages)
      expect(retry).toContain("Protocol error")
      expect(retry).toContain("host rejected the previous completion")
      expect(retry).toContain("Protocol correction")
    }),
  )

  it.live("preserves the original title after the bounded completion repair is exhausted", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "hello")
      const baseline = (yield* session.get(sessionID)).title
      const title = yield* SessionTitle.Service

      h.enqueueTitle(textCompletion(["First prose failure"]))
      h.enqueueTitle(textCompletion(["Second prose failure"]))
      yield* Effect.ignore(title.regenerate({ session: yield* session.get(sessionID) }))

      expect((yield* session.get(sessionID)).title).toBe(baseline)
      expect(h.titleRequests).toHaveLength(2)
      expect(JSON.stringify(h.titleRequests[1]!.messages)).toContain("Protocol correction")
    }),
  )
})
