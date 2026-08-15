import { describe, expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import {
  assembleContext,
  DEFAULT_TITLE_PROMPT,
  isDefaultTitle,
  MAX_TITLE_CONTEXT_CHARS,
  MAX_TITLE_LENGTH,
  sanitizeTitle,
  SessionTitle,
} from "@opencode-ai/core/session/title"
import { makeHarness, catalogModel, insertSession, setTitle, textCompletion } from "./lib/session-harness"

const h = makeHarness()
const it = h.it
const sessionID = SessionV2.ID.make("ses_title_test")

const user = (text: string): SessionMessage.Message =>
  SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text, files: [], agents: [] })

const assistant = (text: string): SessionMessage.Message =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build",
    model: { id: SessionMessage.Assistant.fields.model.fields.id.make("m"), providerID: SessionMessage.Assistant.fields.model.fields.providerID.make("p") },
    content: [{ type: "text", id: "t", text }],
    time: { created: new Date(0) },
  })

const waitForTitle = (expected: string, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return yield* Effect.repeat(
      session.get(sessionID).pipe(Effect.map((info) => info.title === expected)),
      Schedule.recurWhile((done: boolean) => !done).pipe(
        Schedule.compose(Schedule.spaced("10 millis")),
        Schedule.upTo(timeoutMs),
      ),
    )
  })

const waitForNoChange = (from: string, timeoutMs = 200) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return yield* Effect.repeat(
      session.get(sessionID).pipe(Effect.map((info) => info.title === from)),
      Schedule.recurWhile((same: boolean) => same).pipe(
        Schedule.compose(Schedule.spaced("10 millis")),
        Schedule.upTo(timeoutMs),
      ),
    )
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
    expect(out).toBe("a".repeat(MAX_TITLE_LENGTH - 2) + "…")
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
      time: { created: new Date(0) },
    })
    const out = assembleContext([user("hi"), assistant("hello"), shell])
    expect(out).toContain("<user>\nhi\n</user>")
    expect(out).toContain("<assistant>\nhello\n</assistant>")
    expect(out).toContain("<shell>\nfile.txt\n</shell>")
  })
})

describe("SessionTitle.DEFAULT_TITLE_PROMPT", () => {
  it("is the verbatim task section of PROMPT_TITLE", () => {
    expect(DEFAULT_TITLE_PROMPT.startsWith("Generate a brief title that would help the user find this conversation later.")).toBe(true)
    expect(DEFAULT_TITLE_PROMPT).toContain("- A single line")
    expect(DEFAULT_TITLE_PROMPT).toContain("- No explanations")
    expect(DEFAULT_TITLE_PROMPT).not.toContain("<task>")
  })
})

describe("SessionTitle.regenerate", () => {
  it("generates and applies a sanitized title, publishing the durable renamed event", () =>
    it("applies generated title", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.enqueueTitle(textCompletion(["Debugging production 500 errors"]))
        yield* session.regenerateTitle({ sessionID })
        expect(yield* waitForTitle("Debugging production 500 errors")).toBe(true)
        const rows = yield* (yield* Database.Service).db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .all()
        expect(rows.some((row) => row.type === "session.next.renamed@1")).toBe(true)
        expect(h.titleRequests.length).toBe(1)
      })))

  it("manual rename while generation is in flight wins (baseline mismatch discards)", () =>
    it("keeps manual title", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.enqueueTitle(textCompletion(["Generated title"]))
        yield* session.regenerateTitle({ sessionID })
        yield* Effect.sleep("30 millis")
        yield* setTitle(sessionID, "Manual rename")
        expect(yield* waitForNoChange("Manual rename", 500)).toBe(true)
        expect((yield* session.get(sessionID)).title).toBe("Manual rename")
      })))

  it("supersedes: a newer regenerate wins, the stale completion no-ops", () =>
    it("applies only the latest request", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.enqueueTitle(textCompletion(["Stale title"]))
        h.enqueueTitle(textCompletion(["Fresh title"]))
        yield* session.regenerateTitle({ sessionID })
        yield* session.regenerateTitle({ sessionID })
        expect(yield* waitForTitle("Fresh title")).toBe(true)
        expect((yield* session.get(sessionID)).title).not.toBe("Stale title")
      })))

  it("provider failure clears pending and never writes", () =>
    it("keeps the existing title on failure", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        const baseline = (yield* session.get(sessionID)).title
        h.failNextTitle(new (class extends Error {})("provider down"))
        yield* session.regenerateTitle({ sessionID })
        expect(yield* waitForNoChange(baseline, 500)).toBe(true)
        expect((yield* session.get(sessionID)).title).toBe(baseline)
      })))

  it("sanitizer yielding empty is treated as failure (no write)", () =>
    it("keeps the existing title on empty output", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        const baseline = (yield* session.get(sessionID)).title
        h.enqueueTitle(textCompletion(["<think>only thinking</think>"]))
        yield* session.regenerateTitle({ sessionID })
        expect(yield* waitForNoChange(baseline, 500)).toBe(true)
      })))

  it("session with no real user messages no-ops without generation", () =>
    it("does not call the LLM", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        h.enqueueTitle(textCompletion(["Should not apply"]))
        yield* session.regenerateTitle({ sessionID })
        expect(yield* waitForNoChange((yield* session.get(sessionID)).title, 300)).toBe(true)
        expect(h.titleRequests.length).toBe(0)
      })))

  it("custom prompt is sent and {previousTitle} replaced", () =>
    it("uses the custom instruction", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.enqueueTitle(textCompletion(["Titled"]))
        yield* session.regenerateTitle({ sessionID, prompt: "Title this as: {previousTitle} / custom" })
        expect(yield* waitForTitle("Titled")).toBe(true)
        const last = h.titleRequests.at(-1)
        const userText = last?.messages.flatMap((m) =>
          m.role === "user" ? m.content.map((c) => (c.type === "text" ? c.text : "")).join("") : [],
        )
        expect(userText?.some((t) => t.includes("Title this as: New session - "))).toBe(true)
        expect(userText?.some((t) => t.includes("<conversation>"))).toBe(true)
      })))
})

describe("SessionTitle model cascade", () => {
  it("uses the session model fallback when nothing more specific resolves", () =>
    it("requests the session model", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.enqueueTitle(textCompletion(["Title"]))
        yield* session.regenerateTitle({ sessionID })
        expect(yield* waitForTitle("Title")).toBe(true)
        expect(h.titleRequests.at(-1)?.model.id).toBe("fake-model")
      })))

  it("resolves config small_model through the catalog", () =>
    it("prefers small_model over the session model", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.addCatalogModel(catalogModel("fake", "small-v1"))
        h.setConfig({ small_model: "fake/small-v1" })
        h.enqueueTitle(textCompletion(["Title"]))
        yield* session.regenerateTitle({ sessionID })
        expect(yield* waitForTitle("Title")).toBe(true)
        expect(h.titleRequests.at(-1)?.model.id).toBe("small-v1")
      })))

  it("resolves an explicit request model through the catalog", () =>
    it("prefers the request model", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.addCatalogModel(catalogModel("fake", "picker-v1"))
        h.enqueueTitle(textCompletion(["Title"]))
        yield* session.regenerateTitle({
          sessionID,
          model: { providerID: "fake", id: "picker-v1" },
        })
        expect(yield* waitForTitle("Title")).toBe(true)
        expect(h.titleRequests.at(-1)?.model.id).toBe("picker-v1")
      })))

  it("falls back to catalog.model.small for the session provider", () =>
    it("uses catalog small", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.addCatalogModel(catalogModel("fake", "catalog-small"))
        h.setCatalogSmall("fake", catalogModel("fake", "catalog-small"))
        h.enqueueTitle(textCompletion(["Title"]))
        yield* session.regenerateTitle({ sessionID })
        expect(yield* waitForTitle("Title")).toBe(true)
        expect(h.titleRequests.at(-1)?.model.id).toBe("catalog-small")
      })))

  it("config title_prompt is used when no request prompt is given", () =>
    it("uses the configured prompt", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.setConfig({ title_prompt: "Configured title instruction" })
        h.enqueueTitle(textCompletion(["Title"]))
        yield* session.regenerateTitle({ sessionID })
        expect(yield* waitForTitle("Title")).toBe(true)
        const userText = h.titleRequests
          .at(-1)
          ?.messages.flatMap((m) => (m.role === "user" ? m.content.map((c) => (c.type === "text" ? c.text : "")) : []))
        expect(userText?.some((t) => t.startsWith("Configured title instruction"))).toBe(true)
      })))
})

describe("SessionTitle.autoTitle", () => {
  const drainOnce = () =>
    Effect.gen(function* () {
      const execution = yield* import("@opencode-ai/core/session/execution").then((m) => m.SessionExecution.Service)
      return yield* execution.resume(sessionID)
    })

  it("auto-titles a default-titled session after exactly one real user message drains", () =>
    it("applies the generated title", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.enqueueCompletion(textCompletion(["Answer"]))
        h.enqueueTitle(textCompletion(["Auto title applied"]))
        yield* drainOnce()
        expect(yield* waitForTitle("Auto title applied")).toBe(true)
      })))

  it("never overwrites a custom title", () =>
    it("keeps the custom title", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* setTitle(sessionID, "Custom title")
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first message" }), resume: false })
        h.enqueueCompletion(textCompletion(["Answer"]))
        h.enqueueTitle(textCompletion(["Auto title applied"]))
        yield* drainOnce()
        expect(yield* waitForNoChange("Custom title", 300)).toBe(true)
        expect(h.titleRequests.length).toBe(0)
      })))

  it("skips sessions with more than one real user message", () =>
    it("does not auto-title multi-message sessions", () =>
      Effect.gen(function* () {
        yield* h.reset()
        yield* insertSession(sessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "first" }), resume: false })
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "second" }), resume: false })
        h.enqueueCompletion(textCompletion(["Answer"]))
        h.enqueueCompletion(textCompletion(["Answer 2"]))
        h.enqueueTitle(textCompletion(["Should not apply"]))
        yield* drainOnce()
        expect(yield* waitForNoChange((yield* session.get(sessionID)).title, 300)).toBe(true)
        expect(h.titleRequests.length).toBe(0)
      })))
})
