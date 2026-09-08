import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Fiber } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  assembleContext,
  DEFAULT_TITLE_PROMPT,
  isDefaultTitle,
  MAX_TITLE_CONTEXT_CHARS,
  MAX_TITLE_LENGTH,
  sanitizeTitle,
  SessionTitle,
} from "@opencode-ai/core/session/title"
import {
  makeHarness,
  catalogModel,
  generatedTitleCompletion,
  generatedTitleResponse,
  insertSession,
  insertUserMessage,
  setTitle,
  textCompletion,
  transportFailure,
} from "./lib/session-harness"

const h = makeHarness()
const it = test
const fx = h.it
const sessionID = SessionV2.ID.make("ses_title_test")
const epoch = DateTime.makeUnsafe(0)
type RegenerateOptions = Omit<Parameters<SessionTitle.Interface["regenerate"]>[0], "session">

const regenerate = (input: RegenerateOptions = {}) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const title = yield* SessionTitle.Service
    yield* title.regenerate({ session: yield* session.get(sessionID), ...input })
  })

const user = (text: string): SessionMessage.Message =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    files: [],
    agents: [],
    time: { created: epoch },
  })

const assistant = (text: string): SessionMessage.Message =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build",
    model: {
      id: SessionMessage.Assistant.fields.model.fields.id.make("m"),
      providerID: SessionMessage.Assistant.fields.model.fields.providerID.make("p"),
    },
    content: [{ type: "text", id: "t", text }],
    time: { created: epoch },
  })

const waitForTitle = (expected: string, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((yield* session.get(sessionID)).title === expected) return true
      yield* Effect.sleep("10 millis")
    }
    return (yield* session.get(sessionID)).title === expected
  })

const waitForNoChange = (from: string, timeoutMs = 200) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((yield* session.get(sessionID)).title !== from) return false
      yield* Effect.sleep("10 millis")
    }
    return true
  })

describe("SessionTitle.sanitizeTitle", () => {
  it("strips think blocks", () => {
    expect(sanitizeTitle("<think>reasoning</think>\nActual title")).toBe("Actual title")
  })

  it("strips code fences and inline quotes", () => {
    expect(sanitizeTitle("```\nFenced title\n```\n")).toBe("Fenced title")
    expect(sanitizeTitle("`backtick` title")).toBe("backtick title")
    expect(sanitizeTitle("> blockquote title")).toBe("blockquote title")
  })

  it("takes the first non-empty line and trims", () => {
    expect(sanitizeTitle("\n\n  First line  \nsecond line")).toBe("First line")
  })

  it("caps at 60 chars with ellipsis", () => {
    const long = "a".repeat(200)
    const out = sanitizeTitle(long)
    expect(out).toBe("a".repeat(MAX_TITLE_LENGTH - 1) + "…")
    expect(out!.length).toBe(MAX_TITLE_LENGTH)
  })

  it("returns undefined for empty or whitespace output", () => {
    expect(sanitizeTitle("")).toBeUndefined()
    expect(sanitizeTitle("   \n\n ")).toBeUndefined()
    expect(sanitizeTitle("<think>only thinking</think>")).toBeUndefined()
  })
})

describe("SessionTitle.isDefaultTitle", () => {
  it("matches parent and child mechanical titles", () => {
    expect(isDefaultTitle("New session - 2026-08-13T12:34:56.789Z")).toBe(true)
    expect(isDefaultTitle("Child session - 2026-08-13T12:34:56.789Z")).toBe(true)
  })

  it("rejects custom titles and malformed dates", () => {
    expect(isDefaultTitle("Debugging production 500 errors")).toBe(false)
    expect(isDefaultTitle("New session - 2026-08-13")).toBe(false)
  })
})

describe("SessionTitle.assembleContext", () => {
  it("walks newest-first and reverses for presentation", () => {
    const out = assembleContext([user("first"), assistant("middle"), user("last")])
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("middle"))
    expect(out.indexOf("middle")).toBeLessThan(out.indexOf("last"))
  })

  it("pins the first real user message when truncation drops it", () => {
    const big = "x".repeat(MAX_TITLE_CONTEXT_CHARS)
    const first = user("opening intent")
    const messages = [first, assistant(big), assistant("tail")]
    const out = assembleContext(messages)
    // The 8k block plus tail exceed the cap; only newest blocks fit, so the
    // opening intent is pinned at the front.
    expect(out.startsWith("<user>\nopening intent\n</user>")).toBe(true)
  })

  it("includes user, assistant text, and shell output blocks", () => {
    const shell = SessionMessage.Shell.make({
      id: SessionMessage.ID.create(),
      type: "shell",
      callID: "c1",
      command: "ls",
      output: "file.txt",
      time: { created: epoch },
    })
    const out = assembleContext([user("hi"), assistant("hello"), shell])
    expect(out).toContain("<user>\nhi\n</user>")
    expect(out).toContain("<assistant>\nhello\n</assistant>")
    expect(out).toContain("<shell>\nfile.txt\n</shell>")
  })
})

describe("SessionTitle.DEFAULT_TITLE_PROMPT", () => {
  it("is policy-only and leaves completion mechanics to the host protocol", () => {
    expect(DEFAULT_TITLE_PROMPT).toContain("retrieval-oriented titles")
    expect(DEFAULT_TITLE_PROMPT).toContain("Use the same language")
    expect(DEFAULT_TITLE_PROMPT).not.toContain("generated_title")
    expect(DEFAULT_TITLE_PROMPT).not.toContain("ONLY successful completion path")
  })
})

describe("SessionTitle.regenerate", () => {
  fx.live("generates and applies a sanitized title, publishing the durable renamed event", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      yield* insertUserMessage(sessionID, "first message")
      h.enqueueTitle(generatedTitleCompletion("Debugging production 500 errors"))
      yield* regenerate()
      expect(yield* waitForTitle("Debugging production 500 errors")).toBe(true)
      const rows = yield* (yield* Database.Service).db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
      expect(
        rows.some(
          (row) => row.type === EventV2.versionedType(SessionEvent.Renamed.type, SessionEvent.Renamed.durable!.version),
        ),
      ).toBe(true)
      expect(h.titleRequests.length).toBe(1)
    }),
  )

  fx.live("manual rename while generation is in flight wins (baseline mismatch discards)", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "first message")
      h.enqueueTitleEffect(Effect.sleep("75 millis").pipe(Effect.as(generatedTitleResponse("Generated title"))))
      const fiber = yield* regenerate().pipe(Effect.forkScoped)
      yield* Effect.sleep("20 millis")
      yield* setTitle(sessionID, "Manual rename")
      yield* Fiber.join(fiber)
      expect(yield* waitForNoChange("Manual rename", 500)).toBe(true)
      expect((yield* session.get(sessionID)).title).toBe("Manual rename")
    }),
  )

  fx.live("supersedes: a newer regenerate wins, the stale completion no-ops", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "first message")
      h.enqueueTitleEffect(Effect.sleep("75 millis").pipe(Effect.as(generatedTitleResponse("Stale title"))))
      h.enqueueTitle(generatedTitleCompletion("Fresh title"))
      const stale = yield* regenerate().pipe(Effect.forkScoped)
      yield* Effect.sleep("20 millis")
      yield* regenerate()
      yield* Fiber.join(stale)
      expect(yield* waitForTitle("Fresh title")).toBe(true)
      expect((yield* session.get(sessionID)).title).not.toBe("Stale title")
    }),
  )

  fx.live("provider failure clears pending and never writes", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "first message")
      const baseline = (yield* session.get(sessionID)).title
      h.failNextTitle(transportFailure("provider down"))
      yield* Effect.ignore(regenerate())
      expect(yield* waitForNoChange(baseline, 500)).toBe(true)
      expect((yield* session.get(sessionID)).title).toBe(baseline)
    }),
  )

  fx.live("sanitizer yielding empty is treated as failure (no write)", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "first message")
      const baseline = (yield* session.get(sessionID)).title
      h.enqueueTitle(generatedTitleCompletion("<think>only thinking</think>"))
      yield* Effect.ignore(regenerate())
      expect(yield* waitForNoChange(baseline, 500)).toBe(true)
    }),
  )

  fx.live("repairs prose-only output in the same title-agent conversation", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      yield* insertUserMessage(sessionID, "first message")
      h.enqueueTitle(textCompletion(["Looks like a title, but it is only prose"]))
      h.enqueueTitle(generatedTitleCompletion("Recovered structured title"))
      yield* regenerate()
      expect(yield* waitForTitle("Recovered structured title")).toBe(true)
      expect(h.titleRequests).toHaveLength(2)
      const repairTranscript = JSON.stringify(h.titleRequests[1]?.messages)
      expect(repairTranscript).toContain("Looks like a title, but it is only prose")
      expect(repairTranscript).toContain("Protocol correction")
      expect(repairTranscript).toContain("generated_title")
    }),
  )

  fx.live("session with no real user messages no-ops without generation", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      h.enqueueTitle(generatedTitleCompletion("Should not apply"))
      yield* regenerate()
      expect(yield* waitForNoChange((yield* session.get(sessionID)).title, 300)).toBe(true)
      expect(h.titleRequests.length).toBe(0)
    }),
  )

  fx.live("custom policy is system-scoped while host context and protocol remain separate", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "first message")
      h.enqueueTitle(generatedTitleCompletion("Titled"))
      yield* regenerate({ prompt: "Title this as: {previousTitle} / custom" })
      expect(yield* waitForTitle("Titled")).toBe(true)
      const last = h.titleRequests.at(-1)
      const system = JSON.stringify(last?.system)
      const messages = JSON.stringify(last?.messages)
      expect(system).toContain("Title this as: New session - ")
      expect(system).toContain("title-generation-protocol")
      expect(system).toContain("generated_title")
      expect(messages).toContain("title-generation-context")
      expect(messages).toContain("conversation")
      expect(last?.tools.map((item) => item.name)).toEqual(["generated_title"])
      expect(last?.toolChoice).toMatchObject({ type: "required" })
    }),
  )
})

describe("SessionTitle model cascade", () => {
  fx.live("uses the session model fallback when nothing more specific resolves", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "first message")
      h.enqueueTitle(generatedTitleCompletion("Title"))
      yield* regenerate()
      expect(yield* waitForTitle("Title")).toBe(true)
      expect(h.titleRequests.at(-1)?.model.id).toBe("fake-model")
    }),
  )

  fx.live("resolves config small_model through the catalog", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "first message")
      h.addCatalogModel(catalogModel("fake", "small-v1"))
      h.setConfig({ small_model: "fake/small-v1" })
      h.enqueueTitle(generatedTitleCompletion("Title"))
      yield* regenerate()
      expect(yield* waitForTitle("Title")).toBe(true)
      expect(h.titleRequests.at(-1)?.model.id).toBe("small-v1")
    }),
  )

  fx.live("resolves an explicit request model through the catalog", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      yield* insertUserMessage(sessionID, "first message")
      h.addCatalogModel(catalogModel("fake", "picker-v1"))
      h.enqueueTitle(generatedTitleCompletion("Title"))
      yield* regenerate({
        model: ModelV2.Ref.make({
          providerID: ProviderV2.ID.make("fake"),
          id: ModelV2.ID.make("picker-v1"),
        }),
      })
      expect(yield* waitForTitle("Title")).toBe(true)
      expect(h.titleRequests.at(-1)?.model.id).toBe("picker-v1")
    }),
  )

  fx.live("falls back to catalog.model.small for the session provider", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID, { model: { providerID: "fake", id: "fake-model" } })
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "first message")
      h.addCatalogModel(catalogModel("fake", "catalog-small"))
      h.setCatalogSmall("fake", catalogModel("fake", "catalog-small"))
      h.enqueueTitle(generatedTitleCompletion("Title"))
      yield* regenerate()
      expect(yield* waitForTitle("Title")).toBe(true)
      expect(h.titleRequests.at(-1)?.model.id).toBe("catalog-small")
    }),
  )

  fx.live("config title_prompt is used when no request prompt is given", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* insertUserMessage(sessionID, "first message")
      h.setConfig({ title_prompt: "Configured title instruction" })
      h.enqueueTitle(generatedTitleCompletion("Title"))
      yield* regenerate()
      expect(yield* waitForTitle("Title")).toBe(true)
      const request = h.titleRequests.at(-1)
      expect(JSON.stringify(request?.system)).toContain("Configured title instruction")
      expect(JSON.stringify(request?.messages)).not.toContain("Configured title instruction")
    }),
  )
})

describe("SessionTitle.autoTitle", () => {
  const drainOnce = () =>
    Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      return yield* execution.resume(sessionID)
    })

  fx.live("auto-titles a default-titled session after exactly one real user message drains", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
      h.enqueueCompletion(textCompletion(["Answer"]))
      h.enqueueTitle(generatedTitleCompletion("Auto title applied"))
      yield* drainOnce()
      expect(yield* waitForTitle("Auto title applied")).toBe(true)
    }),
  )

  fx.live("never overwrites a custom title", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* setTitle(sessionID, "Custom title")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
      h.enqueueCompletion(textCompletion(["Answer"]))
      h.enqueueTitle(generatedTitleCompletion("Auto title applied"))
      yield* drainOnce()
      expect(yield* waitForNoChange("Custom title", 300)).toBe(true)
      expect(h.titleRequests.length).toBe(0)
    }),
  )

  fx.live("skips sessions with more than one real user message", () =>
    Effect.gen(function* () {
      h.reset()
      yield* insertSession(sessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "second" }), resume: false })
      h.enqueueCompletion(textCompletion(["Answer"]))
      h.enqueueCompletion(textCompletion(["Answer 2"]))
      h.enqueueTitle(generatedTitleCompletion("Should not apply"))
      yield* drainOnce()
      expect(yield* waitForNoChange((yield* session.get(sessionID)).title, 300)).toBe(true)
      expect(h.titleRequests.length).toBe(0)
    }),
  )
})
