import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import path from "path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSearch } from "@opencode-ai/core/session/search"
import { partSearchText, searchText, snippet } from "@opencode-ai/core/session/search-text"
import { Prompt } from "@opencode-ai/core/session/prompt"
import {
  MessageTable,
  PartSearchBackfillTable,
  PartTable,
  SearchBackfillTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const itWithoutSession = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
    [[ProjectV2.node, projects]],
  ),
)

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const model = { id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }
const location = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })
type DatabaseService = Database.Interface["db"]

const insertMessage = (
  db: DatabaseService,
  input: {
    sessionID: string
    message: SessionMessage.Message
    seq: number
    search_text?: string
  },
) => {
  const encoded = encodeMessage(input.message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: SessionSchema.ID.make(input.sessionID),
      type,
      seq: input.seq,
      time_created: DateTime.toEpochMillis(input.message.time.created),
      data,
      search_text: input.search_text ?? "",
    })
    .run()
    .pipe(Effect.orDie)
}

describe("SessionSearch extraction", () => {
  const time = { created: DateTime.makeUnsafe(0) }

  it.effect("extracts user, system, and synthetic text", () =>
    Effect.gen(function* () {
      const user = SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text: "hello search world", time })
      const system = SessionMessage.System.make({ id: SessionMessage.ID.create(), type: "system", text: "system boot message", time })
      const synthetic = SessionMessage.Synthetic.make({
        id: SessionMessage.ID.create(),
        type: "synthetic",
        sessionID: SessionV2.ID.make("ses_synthetic"),
        text: "synthetic summary",
        time,
      })
      expect(searchText(user)).toBe("hello search world")
      expect(searchText(system)).toBe("system boot message")
      expect(searchText(synthetic)).toBe("synthetic summary")
    }),
  )

  it.effect("extracts assistant text and reasoning parts but not raw tool JSON", () =>
    Effect.gen(function* () {
      const assistant = SessionMessage.Assistant.make({
        id: SessionMessage.ID.create(),
        type: "assistant",
        agent: "build",
        model,
        content: [
          { type: "text", id: "p1", text: "I refactored the search index" },
          { type: "reasoning", id: "p2", text: "the index needs a backfill" },
          {
            type: "tool",
            id: "p3",
            name: "bash",
            state: { status: "completed", input: { command: "bun test" }, content: [], structured: {} },
            time: { created: DateTime.makeUnsafe(0) },
          },
        ],
        time,
      })
      const extracted = searchText(assistant)
      expect(extracted).toContain("I refactored the search index")
      expect(extracted).toContain("the index needs a backfill")
      expect(extracted).toContain("bun test")
      // Raw JSON keys and structure must never leak into the index.
      expect(extracted).not.toContain('"type"')
      expect(extracted).not.toContain('"content"')
      expect(extracted).not.toContain('"state"')
    }),
  )

  it.effect("truncates tool inputs and shell output to bounded summaries", () =>
    Effect.gen(function* () {
      const huge = "x".repeat(5000)
      const assistant = SessionMessage.Assistant.make({
        id: SessionMessage.ID.create(),
        type: "assistant",
        agent: "build",
        model,
        content: [
          {
            type: "tool",
            id: "p1",
            name: "bash",
            state: { status: "completed", input: { command: huge }, content: [], structured: {} },
            time: { created: DateTime.makeUnsafe(0) },
          },
        ],
        time,
      })
      expect(searchText(assistant).length).toBe(2000)
      const shell = SessionMessage.Shell.make({
        id: SessionMessage.ID.create(),
        type: "shell",
        callID: "call_1",
        command: "bun test",
        output: huge,
        time,
      })
      const shellText = searchText(shell)
      expect(shellText).toContain("bun test")
      // command (8) + space (1) + truncated output (2000)
      expect(shellText.length).toBe(8 + 1 + 2000)
    }),
  )

  it.effect("combines compaction summary and recent text", () =>
    Effect.gen(function* () {
      const compaction = SessionMessage.Compaction.make({
        id: SessionMessage.ID.create(),
        type: "compaction",
        reason: "manual",
        summary: "summarized context",
        recent: "recent messages",
        time,
      })
      expect(searchText(compaction)).toBe("summarized context recent messages")
    }),
  )

  it.effect("extracts nothing for switched messages", () =>
    Effect.gen(function* () {
      const switched = SessionMessage.AgentSwitched.make({
        id: SessionMessage.ID.create(),
        type: "agent-switched",
        agent: "plan",
        time,
      })
      expect(searchText(switched)).toBe("")
    }),
  )
})

describe("SessionSearch snippet", () => {
  it.effect("windows around the first matched term with ellipses", () =>
    Effect.gen(function* () {
      const text = `${"a ".repeat(200)}searchable ${"b ".repeat(200)}`
      const out = snippet(text, ["searchable"])
      expect(out).toContain("searchable")
      expect(out.startsWith("…")).toBe(true)
      expect(out.endsWith("…")).toBe(true)
      expect(out.length).toBeLessThanOrEqual(122)
    }),
  )

  it.effect("returns the full text when short", () =>
    Effect.gen(function* () {
      expect(snippet("short text", ["zzz"])).toBe("short text")
    }),
  )
})

describe("SessionSearch query building", () => {
  it.effect("builds bare prefix terms joined by implicit AND", () =>
    Effect.gen(function* () {
      expect(SessionSearch.matchQuery("session store")).toBe("session* store*")
      expect(SessionSearch.matchQuery("getUser")).toBe("getUser*")
    }),
  )

  it.effect("quotes FTS5 operator keywords", () =>
    Effect.gen(function* () {
      expect(SessionSearch.matchQuery("and or not near")).toBe('"and" "or" "not" "near"')
    }),
  )

  it.effect("splits on every non-word character and strips FTS5 specials", () =>
    Effect.gen(function* () {
      expect(SessionSearch.matchQuery('foo-bar (baz) "qux" a:b')).toBe("foo* bar* baz* qux*")
      expect(SessionSearch.matchQuery("src/utils/foo.ts")).toBe("src* utils* foo* ts*")
      expect(SessionSearch.matchQuery("semi;colon percent%")).toBe("semi* colon* percent*")
    }),
  )

  it.effect("drops terms shorter than 2 characters", () =>
    Effect.gen(function* () {
      expect(SessionSearch.matchQuery("a b cd")).toBe("cd*")
      expect(SessionSearch.matchQuery("! ?")).toBeUndefined()
      expect(SessionSearch.matchQuery("s%")).toBeUndefined()
    }),
  )

  it.effect("caps the term count at 8", () =>
    Effect.gen(function* () {
      expect(SessionSearch.matchQuery("one two three four five six seven eight nine")!.split(" ")).toHaveLength(8)
    }),
  )

  it.effect("never lets pathological input escape into the FTS grammar", () =>
    Effect.gen(function* () {
      const pathological = [
        "s%", "semi;colon", "AND", "OR", "NOT", "NEAR", 'say "hi"', "a:b", "*ab*", "(ab)",
        "foo-bar", "foo-bar-baz-qux-1-2-3-4-5-6-7-8-9", "''''''''''", "%%%%", ";;;",
        "a b c d e f g h i j k l m n o p q r s t u v w x y z", "搜索文件", "getUserById",
      ]
      for (const input of pathological) {
        const match = SessionSearch.matchQuery(input)
        if (!match) continue
        // Every emitted term is either a bare word+`*` or a quoted operator
        // keyword — never raw FTS5 syntax characters.
        for (const term of match.split(" ")) {
          const bare = /^[\p{L}\p{N}_]+\*$/u.test(term)
          const quoted = /^"(and|or|not|near)"$/i.test(term)
          expect(bare || quoted).toBe(true)
        }
      }
    }),
  )
})

describe("SessionV2.search", () => {
  const createSession = (session: SessionV2.Interface, directory: string, title?: string) =>
    Effect.gen(function* () {
      const created = yield* session.create({ location: location(directory) })
      if (title) {
        yield* (yield* Database.Service).db
          .update(SessionTable)
          .set({ title })
          .where(eq(SessionTable.id, created.id))
          .run()
          .pipe(Effect.orDie)
      }
      return created
    })

  const addUserMessage = (sessionID: SessionSchema.ID, text: string) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const db = (yield* Database.Service).db
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
    })

  it.effect("returns title matches (back-compat) and message matches with snippets", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* createSession(session, "/project", "Refactor the search index")
      yield* addUserMessage(created.id, "the quick brown fox jumps over the lazy dog")

      const result = yield* session.search({ query: "Refactor" })
      expect(result.titleMatches.map((info) => info.id)).toContain(created.id)
      expect(result.messageMatches).toHaveLength(0)

      const content = yield* session.search({ query: "quick" })
      expect(content.titleMatches).toHaveLength(0)
      expect(content.messageMatches).toHaveLength(1)
      const match = content.messageMatches[0]
      expect(match.sessionID).toBe(created.id)
      expect(match.sessionTitle).toBe("Refactor the search index")
      expect(match.type).toBe("user")
      expect(match.snippet).toContain("quick")
      expect(match.matchedTerms).toEqual(["quick"])
      expect(typeof match.time.created).toBe("number")
    }),
  )

  it.effect("matches partial identifier prefixes", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* createSession(session, "/project")
      yield* addUserMessage(created.id, "the getUserById helper is broken")

      const result = yield* session.search({ query: "getUser" })
      expect(result.messageMatches).toHaveLength(1)
      expect(result.messageMatches[0].snippet).toContain("getUserById")
    }),
  )

  it.effect("indexes new messages as they are written", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* createSession(session, "/project")
      yield* addUserMessage(created.id, "first message about wiring")

      expect((yield* session.search({ query: "wiring" })).messageMatches).toHaveLength(1)

      yield* addUserMessage(created.id, "second message about plumbing")
      const result = yield* session.search({ query: "plumbing" })
      expect(result.messageMatches).toHaveLength(1)
      expect(result.messageMatches[0].messageID).toBeDefined()
    }),
  )

  it.effect("updates the index when message content changes", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* SessionV2.Service
      const created = yield* createSession(session, "/project")
      const message = SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "old tokenized content",
        time: { created: DateTime.makeUnsafe(0) },
      })
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: created.id,
          type,
          seq: 1,
          time_created: 0,
          data,
          search_text: "old tokenized content",
        })
        .run()
        .pipe(Effect.orDie)

      expect((yield* session.search({ query: "old" })).messageMatches).toHaveLength(1)

      const updated = SessionMessage.User.make({
        id: message.id,
        type: "user",
        text: "brand new content",
        time: { created: DateTime.makeUnsafe(0) },
      })
      const { id: _, type: __, ...data2 } = encodeMessage(updated)
      yield* db
        .update(SessionMessageTable)
        .set({ data: data2, search_text: "brand new content" })
        .where(eq(SessionMessageTable.id, message.id))
        .run()
        .pipe(Effect.orDie)

      expect((yield* session.search({ query: "brand" })).messageMatches).toHaveLength(1)
      expect((yield* session.search({ query: "tokenized" })).messageMatches).toHaveLength(0)
    }),
  )

  it.effect("removes deleted messages from the index", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* SessionV2.Service
      const created = yield* createSession(session, "/project")
      const message = SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "transient content to delete",
        time: { created: DateTime.makeUnsafe(0) },
      })
      yield* insertMessage(db, { sessionID: created.id, message, seq: 1, search_text: "transient content to delete" })

      expect((yield* session.search({ query: "transient" })).messageMatches).toHaveLength(1)

      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.id, message.id))
        .run()
        .pipe(Effect.orDie)

      expect((yield* session.search({ query: "transient" })).messageMatches).toHaveLength(0)
    }),
  )

  it.effect("scopes message and title matches by directory", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const inA = yield* createSession(session, "/project/a", "Title in directory a")
      const inB = yield* createSession(session, "/project/b", "Title in directory b")
      yield* addUserMessage(inA.id, "diamond content in alpha")
      yield* addUserMessage(inB.id, "diamond content in beta")

      const scoped = yield* session.search({ query: "diamond", directory: "/project/a" })
      expect(scoped.messageMatches.map((match) => match.sessionID)).toEqual([inA.id])
      expect(scoped.titleMatches).toHaveLength(0)

      const scopedTitle = yield* session.search({ query: "Title", directory: "/project/a" })
      expect(scopedTitle.titleMatches.map((info) => info.id)).toEqual([inA.id])

      const all = yield* session.search({ query: "diamond" })
      expect(all.messageMatches.map((match) => match.sessionID).sort()).toEqual([inA.id, inB.id].sort())
    }),
  )

  it.effect("respects the limit per group", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      for (const directory of ["/p1", "/p2", "/p3", "/p4", "/p5"]) {
        const created = yield* createSession(session, directory)
        yield* addUserMessage(created.id, "shared needle phrase")
      }
      const result = yield* session.search({ query: "needle", limit: 3 })
      expect(result.messageMatches).toHaveLength(3)
    }),
  )

  it.effect("never defects on pathological user input", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* createSession(session, "/project")
      yield* addUserMessage(created.id, "the quick brown fox jumps over the lazy dog")
      const pathological = [
        "s%", "semi;colon", "AND", "OR", "NOT", "NEAR", 'say "hi"', "a:b", "*ab*", "(ab)",
        "''''''''''", "%%%%", ";;;", "! ?", "a", "搜索文件", "getUserById", "foo-bar-baz-1-2-3-4-5-6-7-8",
      ]
      for (const query of pathological) {
        const outcome = yield* session.search({ query, directory: "/project" }).pipe(
          Effect.catch((error) => Effect.succeed({ error } as const)),
          Effect.catchDefect(() => Effect.succeed({ defect: true } as const)),
        )
        if ("defect" in outcome) return yield* Effect.die(`defect escaped on query: ${query}`)
        const result = outcome as SessionSearch.SearchResult
        expect(Array.isArray(result.titleMatches)).toBe(true)
        expect(Array.isArray(result.messageMatches)).toBe(true)
      }
    }),
  )
})

describe("SessionSearch.backfill", () => {
  itWithoutSession.effect("indexes pre-existing messages with the same extractor", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      // Session rows must exist before messages (FK).
      const sessionID = SessionV2.ID.make("ses_backfill_target")
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "backfill",
          directory: "/project",
          title: "Backfill session",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      // Simulate rows written before the search migration: no search_text set.
      const first = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_backfill_first"),
        type: "user",
        text: "pre-existing content about frobnicate",
        time: { created: DateTime.makeUnsafe(1) },
      })
      const second = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_backfill_second"),
        type: "assistant",
        agent: "build",
        model,
        content: [{ type: "text", id: "p1", text: "the frobnicate refactor is done" }],
        time: { created: DateTime.makeUnsafe(2) },
      })
      yield* insertMessage(db, { sessionID, message: first, seq: 1 })
      yield* insertMessage(db, { sessionID, message: second, seq: 2 })

      // Nothing is searchable before the backfill runs.
      yield* SessionSearch.backfill(db)
      // The backfill marks itself done and never re-runs.
      const state = yield* db
        .select({ done: SearchBackfillTable.done })
        .from(SearchBackfillTable)
        .where(eq(SearchBackfillTable.id, 1))
        .get()
        .pipe(Effect.orDie)
      expect(state?.done).toBe(1)

      const rows = yield* db
        .select({ text: SessionMessageTable.search_text })
        .from(SessionMessageTable)
        .orderBy(SessionMessageTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.text)).toEqual([
        "pre-existing content about frobnicate",
        "the frobnicate refactor is done",
      ])

      // The FTS index now finds both messages.
      const result = yield* SessionSearch.search(db, { query: "frobnicate" })
      expect(result.messageMatches).toHaveLength(2)
      expect(result.messageMatches.map((match) => match.sessionID)).toEqual([sessionID, sessionID])
      expect(result.titleMatches).toHaveLength(0)
    }),
  )

  itWithoutSession.effect("is resumable from the rowid watermark", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = SessionV2.ID.make("ses_backfill_resume")
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "resume",
          directory: "/project",
          title: "Resume session",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const first = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_resume_first"),
        type: "user",
        text: "resumable alpha content",
        time: { created: DateTime.makeUnsafe(1) },
      })
      const second = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_resume_second"),
        type: "user",
        text: "resumable beta content",
        time: { created: DateTime.makeUnsafe(2) },
      })
      // The first row was already indexed by an interrupted prior run (its
      // search_text is set); only the second row remains to be backfilled.
      yield* insertMessage(db, { sessionID, message: first, seq: 1, search_text: "resumable alpha content" })
      yield* insertMessage(db, { sessionID, message: second, seq: 2 })

      // Advance the watermark past the first row, as an interrupted run would.
      yield* db
        .update(SearchBackfillTable)
        .set({ watermark_rowid: 1, done: 0 })
        .where(eq(SearchBackfillTable.id, 1))
        .run()
        .pipe(Effect.orDie)
      yield* SessionSearch.backfill(db)

      const result = yield* SessionSearch.search(db, { query: "resumable" })
      expect(result.messageMatches).toHaveLength(2)
    }),
  )
})

describe("SessionSearch V1 part extraction", () => {
  const base = { id: SessionV1.PartID.make("prt_test"), sessionID: SessionV2.ID.make("ses_test"), messageID: SessionV1.MessageID.make("msg_test") }

  it.effect("extracts text and reasoning part prose", () =>
    Effect.gen(function* () {
      const text = SessionV1.TextPart.make({ ...base, type: "text", text: "the frobnicate refactor", time: { start: 0 } })
      const reasoning = SessionV1.ReasoningPart.make({
        ...base,
        type: "reasoning",
        text: "weighing design tradeoffs",
        time: { start: 0 },
      })
      expect(partSearchText(text)).toContain("frobnicate")
      expect(partSearchText(reasoning)).toContain("tradeoffs")
    }),
  )

  it.effect("extracts a bounded tool input summary and the tool name", () =>
    Effect.gen(function* () {
      const tool = SessionV1.ToolPart.make({
        ...base,
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: { status: "completed", input: { command: "bun test --coverage" }, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
      })
      const extracted = partSearchText(tool)
      expect(extracted).toContain("tool:bash")
      expect(extracted).toContain("bun test")
      expect(extracted.length).toBeLessThanOrEqual(2000 + 20)
    }),
  )

  it.effect("extracts nothing for structural parts", () =>
    Effect.gen(function* () {
      const step = SessionV1.StepStartPart.make({ ...base, type: "step-start", snapshot: "abc" })
      const patch = SessionV1.PatchPart.make({ ...base, type: "patch", hash: "h", files: ["a.ts"] })
      expect(partSearchText(step)).toBe("")
      expect(partSearchText(patch)).toBe("")
    }),
  )
})

describe("SessionSearch V1 part search", () => {
  const createV1Session = (session: SessionV2.Interface, directory: string, title: string) =>
    Effect.gen(function* () {
      const created = yield* session.create({ location: location(directory) })
      yield* (yield* Database.Service).db
        .update(SessionTable)
        .set({ title })
        .where(eq(SessionTable.id, created.id))
        .run()
        .pipe(Effect.orDie)
      return created
    })

  const insertV1Message = (
    db: DatabaseService,
    input: {
      sessionID: string
      messageID: string
      role: "user" | "assistant"
      timeCreated: number
      parts: SessionV1.Part[]
    },
  ) =>
    Effect.gen(function* () {
      yield* db
        .insert(MessageTable)
        .values({
          id: SessionV1.MessageID.make(input.messageID),
          session_id: SessionSchema.ID.make(input.sessionID),
          time_created: input.timeCreated,
          data: {
            role: input.role,
            time: { created: input.timeCreated },
            agent: "build",
            model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("sonnet") },
          } as never,
        })
        .run()
        .pipe(Effect.orDie)
      for (const part of input.parts) {
        const { id: partID, messageID, sessionID: _p, ...partData } = part
        yield* db
          .insert(PartTable)
          .values({
            id: partID,
            message_id: messageID,
            session_id: SessionSchema.ID.make(input.sessionID),
            data: partData as never,
            search_text: partSearchText(part),
          })
          .run()
          .pipe(Effect.orDie)
      }
    })

  it.effect("finds V1 conversation content via part_fts", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* createV1Session(session, "/project", "V1 session title")
      const text = SessionV1.TextPart.make({
        id: SessionV1.PartID.make("prt_v1_text"),
        sessionID: SessionV2.ID.make(created.id),
        messageID: SessionV1.MessageID.make("msg_v1_user"),
        type: "text",
        text: "the search should cover v1 conversations too",
        time: { start: 0 },
      })
      yield* insertV1Message((yield* Database.Service).db, {
        sessionID: created.id,
        messageID: "msg_v1_user",
        role: "user",
        timeCreated: DateTime.toEpochMillis(DateTime.makeUnsafe(1)),
        parts: [text],
      })

      const result = yield* SessionSearch.search((yield* Database.Service).db, { query: "conversations" })
      expect(result.messageMatches).toHaveLength(1)
      const match = result.messageMatches[0]
      expect(match.sessionID).toBe(created.id)
      expect(match.sessionTitle).toBe("V1 session title")
      expect(match.type).toBe("user")
      expect(match.snippet).toContain("conversations")
    }),
  )

  it.effect("merges V1 and V2 message matches with dedupe", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* createV1Session(session, "/project", "Dual store session")
      const v2Message = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_v2_needle"),
        type: "user",
        text: "v2 store needle phrase",
        time: { created: DateTime.makeUnsafe(1) },
      })
      yield* insertMessage((yield* Database.Service).db, {
        sessionID: created.id,
        message: v2Message,
        seq: 1,
        search_text: "v2 store needle phrase",
      })

      const text = SessionV1.TextPart.make({
        id: SessionV1.PartID.make("prt_v1_needle"),
        sessionID: SessionV2.ID.make(created.id),
        messageID: SessionV1.MessageID.make("msg_v1_needle"),
        type: "text",
        text: "v1 store needle phrase",
        time: { start: 0 },
      })
      yield* insertV1Message((yield* Database.Service).db, {
        sessionID: created.id,
        messageID: "msg_v1_needle",
        role: "assistant",
        timeCreated: DateTime.toEpochMillis(DateTime.makeUnsafe(2)),
        parts: [text],
      })

      const result = yield* SessionSearch.search((yield* Database.Service).db, { query: "needle" })
      // One V1 match + one V2 match from distinct messages.
      expect(result.messageMatches.length).toBeGreaterThanOrEqual(2)
      // Distinct message IDs only.
      const ids = new Set(result.messageMatches.map((match) => match.messageID))
      expect(ids.size).toBe(result.messageMatches.length)
    }),
  )
})

describe("SessionSearch.backfillParts", () => {
  itWithoutSession.effect("indexes pre-existing V1 parts with the same extractor", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = SessionV2.ID.make("ses_part_backfill")
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "part-backfill",
          directory: "/project",
          title: "Part backfill session",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const messageID = SessionV1.MessageID.make("msg_part_backfill")
      yield* db
        .insert(MessageTable)
        .values({
          id: messageID,
          session_id: sessionID,
          time_created: 1,
          data: {
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("sonnet") },
          } as never,
        })
        .run()
        .pipe(Effect.orDie)

      // Simulate rows written before the V1 search migration: search_text empty.
      const partID = SessionV1.PartID.make("prt_backfill")
      yield* db
        .insert(PartTable)
        .values({
          id: partID,
          message_id: messageID,
          session_id: sessionID,
          data: { type: "text", text: "pre-existing part about brambleback", time: { start: 0 } } as never,
          search_text: "",
        })
        .run()
        .pipe(Effect.orDie)

      expect((yield* SessionSearch.search(db, { query: "brambleback" })).messageMatches).toHaveLength(0)

      yield* SessionSearch.backfillParts(db)
      const state = yield* db
        .select({ done: PartSearchBackfillTable.done })
        .from(PartSearchBackfillTable)
        .where(eq(PartSearchBackfillTable.id, 1))
        .get()
        .pipe(Effect.orDie)
      expect(state?.done).toBe(1)

      const result = yield* SessionSearch.search(db, { query: "brambleback" })
      expect(result.messageMatches).toHaveLength(1)
      expect(result.messageMatches[0].sessionID).toBe(sessionID)
    }),
  )

  itWithoutSession.effect("is resumable from the part rowid watermark", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = SessionV2.ID.make("ses_part_resume")
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "part-resume",
          directory: "/project",
          title: "Part resume session",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const messageID = SessionV1.MessageID.make("msg_part_resume")
      yield* db
        .insert(MessageTable)
        .values({
          id: messageID,
          session_id: sessionID,
          time_created: 1,
          data: {
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("sonnet") },
          } as never,
        })
        .run()
        .pipe(Effect.orDie)
      const first = SessionV1.PartID.make("prt_resume_first")
      yield* db
        .insert(PartTable)
        .values({
          id: first,
          message_id: messageID,
          session_id: sessionID,
          data: { type: "text", text: "resumable part alpha", time: { start: 0 } } as never,
          search_text: "resumable part alpha",
        })
        .run()
        .pipe(Effect.orDie)
      const secondMessageID = SessionV1.MessageID.make("msg_part_resume_b")
      yield* db
        .insert(MessageTable)
        .values({
          id: secondMessageID,
          session_id: sessionID,
          time_created: 2,
          data: {
            role: "assistant",
            time: { created: 2 },
            agent: "build",
            model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("sonnet") },
          } as never,
        })
        .run()
        .pipe(Effect.orDie)
      const second = SessionV1.PartID.make("prt_resume_second")
      yield* db
        .insert(PartTable)
        .values({
          id: second,
          message_id: secondMessageID,
          session_id: sessionID,
          data: { type: "text", text: "resumable part beta", time: { start: 0 } } as never,
          search_text: "",
        })
        .run()
        .pipe(Effect.orDie)

      // Advance the watermark past the first part row, as an interrupted run would.
      const firstRow = yield* db
        .select({ rowid: sql<number>`rowid` })
        .from(PartTable)
        .where(eq(PartTable.id, first))
        .get()
        .pipe(Effect.orDie)
      yield* db
        .update(PartSearchBackfillTable)
        .set({ watermark_rowid: firstRow!.rowid, done: 0 })
        .where(eq(PartSearchBackfillTable.id, 1))
        .run()
        .pipe(Effect.orDie)
      yield* SessionSearch.backfillParts(db)

      const result = yield* SessionSearch.search(db, { query: "resumable" })
      expect(result.messageMatches).toHaveLength(2)
    }),
  )
})

describe("SessionSearch backfill concurrency", () => {
  // Proves the FTS backfill can never block live queries: the production
  // backfill path opens its OWN SQLite connection (its own semaphore) while
  // searches hit the shared client. Uses a FILE-backed database because the
  // backfill opens a second connection to the same file (an in-memory db would
  // be a different, empty database).
  test("searches complete while the backfill runs on its own connection", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "search-concurrency.sqlite")
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node]),
      [[Database.node, Database.layerFromPath(filename)]],
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service

        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
        const sessionID = SessionV2.ID.make("ses_concurrency")
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: "concurrency",
            directory: "/project",
            title: "Concurrency",
            version: "test",
          })
          .run()

        // Seed pre-migration rows (empty search_text) with enough prose per row
        // that a 5k-row chunk transaction takes long enough to observe the
        // search/backfill interleaving.
        const filler = "lorem ipsum dolor sit amet ".repeat(192) // ~6KB per row
        const now = Date.now()
        yield* db
          .insert(SessionMessageTable)
          .values(
            Array.from({ length: 6000 }, (_, i) => ({
              id: SessionMessage.ID.make(`msg_concurrency_${i}`),
              session_id: sessionID,
              type: "user" as const,
              seq: i + 1,
              time_created: now,
              time_updated: now,
              data: { text: filler, time: { created: now } },
              search_text: "",
            })),
          )
          .run()

        // The PRODUCTION backfill path (dedicated connection) forked mid-test.
        const backfill = yield* SessionSearch.backfillOnOwnConnection(filename).pipe(Effect.forkScoped)

        // Fire searches at the SHARED client while the backfill is running.
        const timings: number[] = []
        for (let i = 0; i < 5; i++) {
          const start = performance.now()
          yield* SessionSearch.search(db, { query: "lorem" }).pipe(Effect.timeout("2 seconds"))
          timings.push(performance.now() - start)
        }

        // Prove the searches really overlapped the backfill: it must still be
        // mid-run (not done) right after the search phase.
        const midState = yield* db
          .select({ done: SearchBackfillTable.done })
          .from(SearchBackfillTable)
          .where(eq(SearchBackfillTable.id, 1))
          .get()
        expect(midState?.done).toBe(0)

        yield* Fiber.join(backfill)

        // The backfill completed without dying on lock contention and populated
        // the FTS index through its own connection.
        const state = yield* db
          .select({ done: SearchBackfillTable.done })
          .from(SearchBackfillTable)
          .where(eq(SearchBackfillTable.id, 1))
          .get()
        expect(state?.done).toBe(1)

        const result = yield* SessionSearch.search(db, { query: "lorem" })
        expect(result.messageMatches.length).toBeGreaterThan(0)

        // Every search stayed well under the bound while the backfill held the
        // WAL write lock — reads on the shared connection never wait on it.
        console.log("search latency while backfill mid-run (ms):", timings)
        expect(Math.max(...timings)).toBeLessThan(1000)
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
  }, 120000)
})
