import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import * as SessionToolOutput from "@opencode-ai/core/session/tool-output"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))
const ownerIt = testEffect(
  LayerNode.compile(LayerNode.group([Truncate.node, Agent.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

const params = Schema.Struct({ input: Schema.String })

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  it.effect("object-defined tool does not mutate the original init object", () =>
    Effect.gen(function* () {
      const original = makeTool("test")
      const originalExecute = original.execute

      const info = yield* Tool.define("test-tool", Effect.succeed(original))

      yield* info.init()
      yield* info.init()
      yield* info.init()

      expect(original.execute).toBe(originalExecute)
    }),
  )

  it.effect("effect-defined tool returns fresh objects and is unaffected", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      )

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("object-defined tool returns distinct objects per init() call", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("test-copy", Effect.succeed(makeTool("test")))

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("execute receives decoded parameters", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(5))),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const ctx = makeCtx()
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      yield* execute({}, ctx)
      yield* execute({ count: "7" }, ctx)

      expect(calls).toEqual([{ count: 5 }, { count: 7 }])
    }),
  )

  it.effect("derives a retention owner only for explicitly provider-owned calls", () =>
    Effect.gen(function* () {
      const base = makeCtx()
      expect(Tool.timelineOwner(base)).toBeUndefined()
      expect(Tool.timelineOwner({ ...base, callID: "call_1" })).toEqual({
        sessionID: base.sessionID,
        messageID: base.messageID,
        toolCallID: "call_1",
      })
      expect(Tool.timelineOwner({ ...base, callID: "call_1", retention: "none" })).toBeUndefined()
    }),
  )

  ownerIt.live("timelineOutput advertisement implies a complete durable page", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_timeline_e2e")
      const messageID = MessageID.make("msg_timeline_e2e")
      const callID = "call_timeline_e2e"
      const directory = AbsolutePath.make(process.cwd())
      const now = Date.now()
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: sessionID,
          directory,
          title: "timeline e2e",
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
          id: messageID,
          session_id: sessionID,
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
          message_id: messageID,
          session_id: sessionID,
          time_created: now,
          time_updated: now,
          data: {
            type: "tool",
            callID,
            tool: "timeline-e2e",
            state: { status: "running", input: {}, time: { start: now } },
          } as never,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const full = "Z".repeat(Truncate.MAX_BYTES * 2)
      const info = yield* Tool.define(
        "timeline-e2e",
        Effect.succeed({
          description: "oversized provider output",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "timeline-e2e", output: full, metadata: {} })
          },
        }),
      )
      const tool = yield* info.init()
      const result = yield* tool.execute({ input: "x" }, { ...makeCtx(), sessionID, messageID, callID })
      const metadata = result.metadata as typeof result.metadata & Truncate.ProjectionMetadata

      expect(metadata.timelineOutput).toBe(true)
      const page = yield* SessionToolOutput.page({ sessionID, messageID, toolCallID: callID, offset: 0 })
      expect(page?.complete).toBe(true)
      expect(page?.totalChars).toBe(full.length)
      const pageText = page?.text ?? ""
      expect(pageText.length).toBeGreaterThan(0)
      expect(full.startsWith(pageText)).toBe(true)
    }),
  )

  it.effect("producer truncated=false cannot bypass the final provider-facing bound", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "bounded-false",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return Effect.succeed({
              title: "test",
              output: "HEAD-" + "x".repeat(Truncate.MAX_BYTES * 2) + "-TAIL",
              metadata: { truncated: false },
            })
          },
        }),
      )
      const tool = yield* info.init()
      const result = yield* tool.execute({ input: "x" }, makeCtx())
      const metadata = result.metadata as typeof result.metadata & Truncate.ProjectionMetadata

      expect(metadata.truncated).toBe(true)
      expect(metadata.producerTruncated).toBe(false)
      expect(metadata.providerTruncated).toBe(true)
      // Direct/tool-test contexts legitimately have no provider tool-call ID.
      // Oversized output must remain a bounded success without pretending that
      // durable timeline recovery exists.
      expect("timelineOutput" in metadata).toBe(false)
      expect(result.output).toContain("HEAD-")
      expect(result.output).toContain("-TAIL")
      expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(Truncate.MAX_BYTES)
      expect(typeof metadata.outputPath).toBe("string")
      expect(metadata.providerOutputPath).toBe(metadata.outputPath)
      expect(metadata.outputProjection?.segments).toHaveLength(2)
      expect(metadata.outputProjection?.segments[0]?.startByte).toBe(0)
      expect(metadata.outputProjection?.segments[1]?.endByte).toBe(metadata.outputProjection?.originalBytes)
    }),
  )

  it.effect("producer truncated=true remains distinct from provider truncation and keeps producer spill authority", () =>
    Effect.gen(function* () {
      const producerPath = "/producer/full-output"
      const info = yield* Tool.define(
        "bounded-true",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return Effect.succeed({
              title: "test",
              output: "HEAD-" + "y".repeat(Truncate.MAX_BYTES * 2) + "-TAIL",
              metadata: { truncated: true, outputPath: producerPath },
            })
          },
        }),
      )
      const tool = yield* info.init()
      const result = yield* tool.execute({ input: "x" }, makeCtx())
      const metadata = result.metadata as typeof result.metadata & Truncate.ProjectionMetadata

      expect(metadata.truncated).toBe(true)
      expect(metadata.producerTruncated).toBe(true)
      expect(metadata.providerTruncated).toBe(true)
      expect(metadata.outputPath).toBe(producerPath)
      expect(typeof metadata.providerOutputPath).toBe("string")
      expect(metadata.providerOutputPath).not.toBe(producerPath)
      expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(Truncate.MAX_BYTES)
    }),
  )

  // Regression for #28438: the wrap is the canonical "untyped → typed" boundary.
  // When the LLM emits a tool call with a payload that fails the parameter
  // schema, the wrap must surface a typed `Tool.InvalidArgumentsError` whose
  // `.message` is the actionable prose the AI SDK feeds back to the model.
  it.effect("invalid args surface as Tool.InvalidArgumentsError with friendly message and JSON path", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        questions: Schema.Array(
          Schema.Struct({
            question: Schema.String,
            options: Schema.Array(Schema.String),
          }),
        ),
      })
      const info = yield* Tool.define(
        "qtest",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      // Missing required `question` field on the first questions[] entry.
      const exit = yield* execute({ questions: [{ options: ["a"] }] }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      // The wrap ends with Effect.orDie, so the failure lives in the cause as a
      // defect. Recover the typed instance from there.
      const die = exit.cause.reasons.find(Cause.isDieReason)
      const error = die?.defect
      expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
      const args = error as Tool.InvalidArgumentsError
      expect(args.tool).toBe("qtest")
      expect(args.message).toContain("qtest tool was called with invalid arguments")
      expect(args.message).toContain("Please rewrite the input")
      expect(args.message).toContain(`["questions"][0]["question"]`)
    }),
  )
})
