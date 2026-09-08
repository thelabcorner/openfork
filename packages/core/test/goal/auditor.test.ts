import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, LLMResponse, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { GoalV2 } from "@opencode-ai/core/goal"
import { GoalAuditor } from "@opencode-ai/core/goal/auditor"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Config } from "@opencode-ai/core/config"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const projectID = ProjectV2.ID.make("goal-auditor-project")
const sessionID = SessionV2.ID.make("ses_goal_auditor")
const directory = AbsolutePath.make(process.cwd())
const workerRef: ModelV2.Ref = {
  providerID: ProviderV2.ID.make("worker-provider"),
  id: ModelV2.ID.make("worker-model"),
}
const auditorRef: ModelV2.Ref = {
  providerID: ProviderV2.ID.make("audit-provider"),
  id: ModelV2.ID.make("audit-model"),
}
const workerModel = Model.make({ id: "worker-model", provider: "worker-provider", route: OpenAIChat.route })
const auditorModel = Model.make({ id: "audit-model", provider: "audit-provider", route: OpenAIChat.route })

const generateRequests: LLMRequest[] = []
let generateResponses: LLMResponse[] = []
const readCalls: string[] = []
const grepCalls: string[] = []
const globCalls: string[] = []
let configEntries: Config.Entry[] = []
let resolvedRefs: ModelV2.Ref[] = []

const llmClient = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (() => Effect.die("unused")) as unknown as LLMClientShape["stream"],
    generate: (request) => {
      generateRequests.push(request)
      const next = generateResponses.shift()
      return next ? Effect.succeed(next) : Effect.die("auditor test exhausted generated responses")
    },
  }),
)

const fileEntry = FileSystem.Entry.make({ path: RelativePath.make("src/feature.ts"), type: "file" })
const filesystem = Layer.succeed(
  FileSystem.Service,
  FileSystem.Service.of({
    read: ({ path }) => {
      readCalls.push(path)
      return Effect.succeed({ content: new TextEncoder().encode("export const shipped = true\n"), mime: "text/plain" })
    },
    grep: (input) => {
      grepCalls.push(input.pattern)
      return Effect.succeed([
        FileSystem.Match.make({
          entry: fileEntry,
          line: 1,
          offset: 0,
          text: "export const shipped = true",
          submatches: [],
        }),
      ])
    },
    glob: (input) => {
      globCalls.push(input.pattern)
      return Effect.succeed([fileEntry])
    },
    list: () => Effect.die("unused"),
    find: () => Effect.die("unused"),
    searchMentions: () => Effect.die("unused"),
  }),
)

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed(configEntries),
  }),
)

const models = SessionRunnerModel.layerWith(
  () => Effect.succeed(workerModel),
  (ref) => {
    resolvedRefs.push(ref)
    return Effect.succeed(
      ref.providerID === auditorRef.providerID && ref.id === auditorRef.id ? auditorModel : workerModel,
    )
  },
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, GoalV2.node, GoalAuditor.node]), [
    [LayerNodePlatform.llmClient, llmClient],
    [FileSystem.node, filesystem],
    [Config.node, config],
    [SessionRunnerModel.node, models],
    [Location.node, Location.boundNode({ directory })],
  ]),
)

const response = (...calls: Array<{ id: string; name: string; input: unknown }>) =>
  LLMResponse.fromEvents([
    ...calls.map((call) => LLMEvent.toolCall(call)),
    LLMEvent.finish({ reason: calls.length ? "tool-calls" : "stop" }),
  ])!
const proseResponse = (text: string) =>
  LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "audit-prose" }),
    LLMEvent.textDelta({ id: "audit-prose", text }),
    LLMEvent.textEnd({ id: "audit-prose" }),
    LLMEvent.finish({ reason: "stop" }),
  ])!

const verdict = (id: string, decision: "continue" | "complete" | "blocked" = "continue", progressMade = true) =>
  response({
    id,
    name: "audit_verdict",
    input: {
      decision,
      rationale:
        decision === "complete" ? "All requested work is supported by evidence." : "Verified work remains actionable.",
      progressMade,
      ...(decision === "blocked"
        ? {
            blocker: "External credential required",
            continuationPrompt:
              "Inspect the credential boundary and verify whether a non-secret local workaround exists.",
          }
        : decision === "continue"
          ? { continuationPrompt: "Finish the remaining implementation and verify the exact acceptance criterion." }
          : {}),
    },
  })

const setup = Effect.gen(function* () {
  generateRequests.length = 0
  generateResponses = []
  readCalls.length = 0
  grepCalls.length = 0
  globCalls.length = 0
  configEntries = []
  resolvedRefs = []

  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug: sessionID,
      directory,
      title: "Goal auditor",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const focusedGoal = (options: { maxAttempts?: number; configuredModel?: boolean } = {}) =>
  Effect.gen(function* () {
    const goals = yield* GoalV2.Service
    const created = yield* goals
      .create({
        projectID,
        title: "Audit Goal Mode",
        objective: "Verify the implementation before autonomous continuation.",
        criteria: ["The implementation is present and supported by evidence"],
        continuationPolicy: { mode: "auto_continue" },
        auditorPolicy: {
          maxAttempts: options.maxAttempts ?? 1,
          ...(options.configuredModel ? { model: auditorRef } : {}),
        },
      })
      .pipe(Effect.orDie)
    const active = yield* goals
      .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
      .pipe(Effect.orDie)
    yield* goals.focus({ goalID: active.goal.id, sessionID }).pipe(Effect.orDie)
    return active
  })

describe("GoalAuditor", () => {
  it.effect("performs read-only reconnaissance before committing audit_verdict", () =>
    Effect.gen(function* () {
      yield* setup
      yield* focusedGoal({ configuredModel: true })
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({ auditor_prompt: "CUSTOM AUDITOR PROMPT" }),
        }),
      ]
      generateResponses = [
        response(
          { id: "read-1", name: "read", input: { path: "src/feature.ts" } },
          { id: "grep-1", name: "grep", input: { pattern: "shipped", path: "src" } },
          { id: "glob-1", name: "glob", input: { pattern: "src/**/*.ts" } },
        ),
        verdict("verdict-1", "continue", true),
      ]

      const auditor = yield* GoalAuditor.Service
      const result = yield* auditor.evaluate({
        sessionID,
        workerModel: workerRef,
        latestWork: "Worker says it shipped.",
      })

      expect(result).toMatchObject({ ok: true, model: auditorRef, rounds: 2 })
      if (!result.ok) return
      expect(result.tools).toEqual(["read", "grep", "glob", "audit_verdict"])
      expect(readCalls).toEqual(["src/feature.ts"])
      expect(grepCalls).toEqual(["shipped"])
      expect(globCalls).toEqual(["src/**/*.ts"])
      expect(resolvedRefs).toEqual([auditorRef])
      expect(generateRequests).toHaveLength(2)
      for (const request of generateRequests) {
        expect(request.tools.map((tool) => tool.name).sort()).toEqual(["audit_verdict", "glob", "grep", "read"])
      }
      expect(JSON.stringify(generateRequests[0]!.system)).toContain("CUSTOM AUDITOR PROMPT")
      expect(JSON.stringify(generateRequests[0]!.system)).toContain("<goal-auditor-protocol>")
      expect(JSON.stringify(generateRequests[0]!.system)).toContain("continuationPrompt")
      expect(JSON.stringify(generateRequests[1]!.messages)).toContain("export const shipped = true")
      expect(JSON.stringify(generateRequests[1]!.messages)).toContain("src/feature.ts:1")
      expect(result.verdict).toMatchObject({
        decision: "continue",
        continuationPrompt: "Finish the remaining implementation and verify the exact acceptance criterion.",
      })
    }),
  )

  it.effect("blocks sensitive-file reads before the filesystem service is invoked", () =>
    Effect.gen(function* () {
      yield* setup
      yield* focusedGoal()
      generateResponses = [
        response({ id: "read-secret", name: "read", input: { path: ".env" } }),
        verdict("verdict-safe", "continue", false),
      ]

      const result = yield* (yield* GoalAuditor.Service).evaluate({ sessionID, workerModel: workerRef })
      expect(result.ok).toBe(true)
      expect(readCalls).toEqual([])
      expect(JSON.stringify(generateRequests[1]!.messages)).toContain("Sensitive files are not available")
    }),
  )

  it.effect("forces audit_verdict on the final bounded inspection round", () =>
    Effect.gen(function* () {
      yield* setup
      yield* focusedGoal()
      generateResponses = [
        ...Array.from({ length: 8 }, (_, index) =>
          response({ id: `glob-${index}`, name: "glob", input: { pattern: "src/**/*.ts" } }),
        ),
        verdict("final-verdict", "continue", false),
      ]

      const result = yield* (yield* GoalAuditor.Service).evaluate({ sessionID, workerModel: workerRef })
      expect(result).toMatchObject({ ok: true, rounds: 9 })
      expect(generateRequests).toHaveLength(9)
      expect(generateRequests.at(-1)?.toolChoice).toMatchObject({ type: "required" })
      expect(generateRequests.at(-1)?.tools.map((tool) => tool.name)).toEqual(["audit_verdict"])
    }),
  )

  it.effect("repairs a prose/no-tool audit in the same auditor conversation", () =>
    Effect.gen(function* () {
      yield* setup
      yield* focusedGoal()
      generateResponses = [proseResponse("I think more work remains."), verdict("repaired-verdict", "continue", true)]

      const result = yield* (yield* GoalAuditor.Service).evaluate({ sessionID, workerModel: workerRef })
      expect(result.ok).toBe(true)
      expect(generateRequests).toHaveLength(2)
      expect(generateRequests[1]!.tools.map((tool) => tool.name)).toEqual(["audit_verdict"])
      const repairTranscript = JSON.stringify(generateRequests[1]!.messages)
      expect(repairTranscript).toContain("Protocol correction")
      expect(repairTranscript).toContain("audit_verdict")
    }),
  )

  it.effect("repairs an invalid audit_verdict payload in the same auditor conversation", () =>
    Effect.gen(function* () {
      yield* setup
      yield* focusedGoal()
      generateResponses = [
        response({
          id: "missing-continuation",
          name: "audit_verdict",
          input: {
            decision: "continue",
            rationale: "More work remains.",
            progressMade: true,
          },
        }),
        verdict("valid-after-payload-repair", "continue", true),
      ]

      const result = yield* (yield* GoalAuditor.Service).evaluate({ sessionID, workerModel: workerRef })
      expect(result.ok).toBe(true)
      expect(generateRequests).toHaveLength(2)
      expect(generateRequests[1]!.tools.map((tool) => tool.name)).toEqual(["audit_verdict"])
      const transcript = JSON.stringify(generateRequests[1]!.messages)
      expect(transcript).toContain("Protocol correction")
      expect(transcript).toContain("host rejected the previous completion")
      expect(transcript).toContain("audit_verdict")
    }),
  )

  it.effect("repairs mixed terminal tool usage without executing the extra read", () =>
    Effect.gen(function* () {
      yield* setup
      yield* focusedGoal()
      generateResponses = [
        response(
          { id: "read-and-finish", name: "read", input: { path: "src/feature.ts" } },
          {
            id: "mixed-verdict",
            name: "audit_verdict",
            input: {
              decision: "continue",
              rationale: "More work remains.",
              progressMade: true,
              continuationPrompt: "Finish the remaining implementation.",
            },
          },
        ),
        verdict("valid-after-mixed-repair", "continue", true),
      ]

      const result = yield* (yield* GoalAuditor.Service).evaluate({ sessionID, workerModel: workerRef })
      expect(result.ok).toBe(true)
      expect(readCalls).toEqual([])
      expect(generateRequests).toHaveLength(2)
      expect(generateRequests[1]!.tools.map((tool) => tool.name)).toEqual(["audit_verdict"])
      const transcript = JSON.stringify(generateRequests[1]!.messages)
      expect(transcript).toContain("Protocol error")
      expect(transcript).toContain("Protocol correction")
    }),
  )

  it.effect("fails deterministically when invalid audit_verdict payload repair is exhausted", () =>
    Effect.gen(function* () {
      yield* setup
      yield* focusedGoal({ maxAttempts: 1 })
      const invalid = () =>
        response({
          id: `invalid-${Math.random()}`,
          name: "audit_verdict",
          input: { decision: "continue", rationale: "More work remains.", progressMade: true },
        })
      generateResponses = [invalid(), invalid()]

      const result = yield* (yield* GoalAuditor.Service).evaluate({ sessionID, workerModel: workerRef })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain("Invalid audit_verdict payload")
      expect(result.error).toContain("after 1 auditor attempt")
      expect(generateRequests).toHaveLength(2)
    }),
  )

  it.effect("retries malformed audits only up to the per-Goal maxAttempts", () =>
    Effect.gen(function* () {
      yield* setup
      yield* focusedGoal({ maxAttempts: 2 })
      // Each auditor attempt gets one bounded same-conversation repair after a
      // prose/no-tool response. Neither response is ever interpreted as a verdict.
      generateResponses = [response(), response(), response(), response()]

      const result = yield* (yield* GoalAuditor.Service).evaluate({ sessionID, workerModel: workerRef })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain("after 2 auditor attempts")
      expect(generateRequests).toHaveLength(4)
      expect(JSON.stringify(generateRequests[1]!.messages)).toContain("Protocol correction")
      expect(JSON.stringify(generateRequests[3]!.messages)).toContain("Protocol correction")
    }),
  )
})
