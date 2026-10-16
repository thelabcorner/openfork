import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import * as SessionToolOutput from "@opencode-ai/core/session/tool-output"
import { MessageID, PartID } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const directory = AbsolutePath.make(process.cwd())

const owner = {
  sessionID: SessionSchema.ID.make("ses_tool_output"),
  messageID: MessageID.make("msg_tool_output"),
  toolCallID: "call_tool_output",
} satisfies SessionToolOutput.Owner

const seedOwner = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: owner.sessionID,
      project_id: Project.ID.global,
      slug: owner.sessionID,
      directory,
      title: "Tool output retention",
      version: "test",
      time_created: now,
      time_updated: now,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(MessageTable)
    .values({
      id: owner.messageID,
      session_id: owner.sessionID,
      time_created: now,
      time_updated: now,
      data: {
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: "test", modelID: "test" },
      } as never,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(PartTable)
    .values({
      id: PartID.ascending(),
      message_id: owner.messageID,
      session_id: owner.sessionID,
      time_created: now,
      time_updated: now,
      data: {
        type: "tool",
        callID: owner.toolCallID,
        tool: "test",
        state: { status: "running", input: {}, time: { start: now } },
      } as never,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("SessionToolOutput", () => {
  it.live("keeps the first completed retention authoritative", () =>
    Effect.gen(function* () {
      yield* seedOwner
      yield* SessionToolOutput.persist(owner, "FULL RAW PRODUCER OUTPUT")
      yield* SessionToolOutput.persist(owner, "smaller provider projection")

      const page = yield* SessionToolOutput.page({ ...owner, offset: 0 })
      expect(page?.complete).toBe(true)
      expect(page?.text).toBe("FULL RAW PRODUCER OUTPUT")
      expect(page?.totalChars).toBe(Array.from("FULL RAW PRODUCER OUTPUT").length)
    }),
  )

  it.live("restarts incomplete crash residue but refuses to reopen a completed owner", () =>
    Effect.gen(function* () {
      yield* seedOwner
      yield* SessionToolOutput.begin(owner)
      yield* SessionToolOutput.append(owner, 0, 0, "stale partial")

      // An incomplete stream is recoverable crash residue. A restart owns the
      // same durable identity and replaces it before any completion is exposed.
      yield* SessionToolOutput.begin(owner)
      yield* SessionToolOutput.append(owner, 0, 0, "recovered")
      yield* SessionToolOutput.finish(owner)

      const page = yield* SessionToolOutput.page({ ...owner, offset: 0 })
      expect(page?.complete).toBe(true)
      expect(page?.text).toBe("recovered")

      const reopened = yield* SessionToolOutput.begin(owner).pipe(Effect.exit)
      expect(Exit.isFailure(reopened)).toBe(true)
      expect((yield* SessionToolOutput.page({ ...owner, offset: 0 }))?.text).toBe("recovered")
    }),
  )

  it.live("refuses retention for a tool-call identity without a durable ToolPart", () =>
    Effect.gen(function* () {
      yield* seedOwner
      const unknown = { ...owner, toolCallID: "call_missing" }
      expect(Exit.isFailure(yield* SessionToolOutput.begin(unknown).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* SessionToolOutput.persist(unknown, "content").pipe(Effect.exit))).toBe(true)
      expect(yield* SessionToolOutput.page({ ...unknown, offset: 0 })).toBeUndefined()
    }),
  )

  it.live("refuses retention without a tool-call identity", () =>
    Effect.gen(function* () {
      yield* seedOwner
      const empty = { ...owner, toolCallID: "" }
      expect(Exit.isFailure(yield* SessionToolOutput.persist(empty, "content").pipe(Effect.exit))).toBe(true)
    }),
  )

  it.live("concurrent persist for one owner converges to a single complete retention", () =>
    Effect.gen(function* () {
      yield* seedOwner
      const first = "A".repeat(4000)
      const second = "B".repeat(6000)
      yield* Effect.all(
        [SessionToolOutput.persist(owner, first), SessionToolOutput.persist(owner, second)],
        { concurrency: 2 },
      )

      const page = yield* SessionToolOutput.page({ ...owner, offset: 0 })
      if (!page) throw new Error("expected a retained page")
      expect(page.complete).toBe(true)
      expect([first, second]).toContain(page.text)
      expect([first.length, second.length]).toContain(page.totalChars)

      // A completed retention is first-writer authoritative; a late writer
      // must not replace or mix the settled page.
      yield* SessionToolOutput.persist(owner, "late writer")
      const after = yield* SessionToolOutput.page({ ...owner, offset: 0 })
      if (!after) throw new Error("expected a retained page after the late writer")
      expect(after.text).toBe(page.text)
      expect(after.totalChars).toBe(page.totalChars)
    }),
  )
})