import { afterEach, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import {
  OxpInvocationTable,
  OxpParentActivityTable,
} from "@opencode-ai/core/oxp-activity/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Project } from "@/project/project"
import { Question } from "@/question"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { SessionTool } from "@/tool/session"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

// :memory: database keeps OXP rows isolated per test: the empty-state test
// stays deterministic and seeded rows never leak into the shared database.
const layer = AppNodeBuilder.build(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    Project.node,
    Question.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)

const it = testEffect(layer)

const ctx = (sessionID: SessionID, messageID: MessageID) => ({
  sessionID,
  messageID,
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [] as SessionV1.WithParts[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const seedActivity = Effect.fn("SessionOxpTest.seedActivity")(function* (input: {
  id: string
  title?: string | null
  lastSeenAt: number
  archivedAt?: number | null
}) {
  const database = yield* Database.Service
  const now = Date.now()
  yield* database.db
    .insert(OxpParentActivityTable)
    .values({
      id: input.id as any,
      title: input.title ?? null,
      first_seen_at: now - 1000,
      last_seen_at: input.lastSeenAt,
      call_count: 7,
      failure_count: 2,
      augmentation_calls: 4,
      supervision_calls: 2,
      delegation_calls: 1,
      observed_epoch_count: 3,
      last_tool: "read",
      last_root_alias: "root-a",
      time_archived: input.archivedAt ?? null,
    })
    .run()
    .pipe(Effect.orDie)
})

const seedInvocation = Effect.fn("SessionOxpTest.seedInvocation")(function* (input: {
  id: string
  activityID: string
  tool: string
  startedAt: number
}) {
  const database = yield* Database.Service
  yield* database.db
    .insert(OxpInvocationTable)
    .values({
      id: input.id as any,
      activity_id: input.activityID as any,
      host_run_id: "host-run-1",
      plane: "augmentation" as any,
      tool: input.tool,
      action: "read-file",
      root_alias: "root-a",
      status: "success" as any,
      time_started: input.startedAt,
      time_completed: input.startedAt + 10,
    })
    .run()
    .pipe(Effect.orDie)
})

const runOxp = Effect.fn("SessionOxpTest.runOxp")(function* (params?: Record<string, unknown>) {
  const toolInfo = yield* Tool.init(yield* SessionTool)
  const result = yield* toolInfo.execute(
    { action: "oxp", ...(params ?? {}) } as any,
    ctx(SessionID.make("ses_oxp_probe"), MessageID.ascending()),
  )
  return { result, output: JSON.parse(result.output) as any }
})

describe("session tool oxp action", () => {
  it.live("returns an empty list, not an error, when no OXP activity exists", () =>
    Effect.gen(function* () {
      const { result, output } = yield* runOxp()
      expect(result.title).toBe("Inspect OXP activity")
      expect(result.metadata).toMatchObject({ action: "oxp", count: 0 })
      expect(output).toMatchObject({
        temporal: {
          retrievedAt: expect.any(Number),
          retrievedAtIso: expect.any(String),
          order: "last_seen_desc",
        },
        activities: [],
        truncated: false,
      })
    }),
  )

  it.live("lists a seeded activity with title and camelCase projection", () =>
    Effect.gen(function* () {
      yield* seedActivity({ id: "oxp-test-activity-1", title: "Design GitHub Tool", lastSeenAt: 1700000000000 })
      const { output } = yield* runOxp()
      expect(output.activities).toHaveLength(1)
      expect(output.activities[0]).toMatchObject({
        id: "oxp-test-activity-1",
        title: "Design GitHub Tool",
        firstSeenAt: expect.any(Number),
        firstSeenAtIso: expect.any(String),
        lastSeenAt: 1700000000000,
        lastSeenAtIso: "2023-11-14T22:13:20.000Z",
        lastSeenAgeMs: expect.any(Number),
        timeBasis: "oxp_activity_observed",
        callCount: 7,
        failureCount: 2,
        planeMix: { augmentation: 4, supervision: 2, delegation: 1 },
        observedEpochCount: 3,
        lastTool: "read",
        lastRootAlias: "root-a",
        archived: false,
      })
      expect(output.truncated).toBe(false)
    }),
  )

  it.live("falls back to root alias then untitled for display, keeping the raw id", () =>
    Effect.gen(function* () {
      yield* seedActivity({ id: "oxp-test-activity-untitled", title: null, lastSeenAt: 1700000000000 })
      const { output } = yield* runOxp()
      expect(output.activities[0]).toMatchObject({ id: "oxp-test-activity-untitled", title: "root-a" })
    }),
  )

  it.live("hides archived activities unless oxpIncludeArchived is set", () =>
    Effect.gen(function* () {
      yield* seedActivity({ id: "oxp-test-active", title: "Active", lastSeenAt: 1700000000002 })
      yield* seedActivity({
        id: "oxp-test-archived",
        title: "Archived",
        lastSeenAt: 1700000000001,
        archivedAt: 1700000000005,
      })
      const hidden = yield* runOxp()
      expect(hidden.output.activities.map((a: any) => a.id)).toEqual(["oxp-test-active"])
      const shown = yield* runOxp({ oxpIncludeArchived: true })
      expect(shown.output.activities.map((a: any) => a.id)).toEqual(["oxp-test-active", "oxp-test-archived"])
      expect(shown.output.activities[1]).toMatchObject({ archived: true })
    }),
  )

  it.live("returns recent invocations for oxpActivityId without args or results", () =>
    Effect.gen(function* () {
      yield* seedActivity({ id: "oxp-test-detail", title: "Detail", lastSeenAt: 1700000000000 })
      yield* seedInvocation({ id: "oxp-test-inv-1", activityID: "oxp-test-detail", tool: "read", startedAt: 1700000000000 })
      yield* seedInvocation({ id: "oxp-test-inv-2", activityID: "oxp-test-detail", tool: "edit", startedAt: 1700000000001 })
      const { result, output } = yield* runOxp({ oxpActivityId: "oxp-test-detail" })
      expect(result.title).toBe("Inspect OXP activity")
      expect(result.metadata).toMatchObject({ action: "oxp", activityId: "oxp-test-detail", count: 2 })
      expect(output.activity).toMatchObject({ id: "oxp-test-detail", title: "Detail" })
      expect(output.temporal).toMatchObject({
        retrievedAt: expect.any(Number),
        retrievedAtIso: expect.any(String),
        order: "started_desc",
      })
      expect(output.invocations.map((item: any) => item.id)).toEqual(["oxp-test-inv-2", "oxp-test-inv-1"])
      expect(output.invocations[0]).toMatchObject({
        id: "oxp-test-inv-2",
        tool: "edit",
        action: "read-file",
        status: "success",
        rootAlias: "root-a",
        startedAt: 1700000000001,
        startedAtIso: "2023-11-14T22:13:20.001Z",
        startedAgeMs: expect.any(Number),
        completedAt: 1700000000011,
        completedAtIso: "2023-11-14T22:13:20.011Z",
        timeBasis: "oxp_invocation_event",
      })
      expect(output.invocations[1]).toMatchObject({
        id: "oxp-test-inv-1",
        tool: "read",
        startedAt: 1700000000000,
        startedAtIso: "2023-11-14T22:13:20.000Z",
        completedAtIso: "2023-11-14T22:13:20.010Z",
        timeBasis: "oxp_invocation_event",
      })
      expect(JSON.stringify(output)).not.toContain("request")
      expect(output).not.toHaveProperty("details")
    }),
  )

  it.live("returns a not-found result instead of throwing for an unknown oxpActivityId", () =>
    Effect.gen(function* () {
      const { result, output } = yield* runOxp({ oxpActivityId: "oxp-test-missing" })
      expect(result.title).toBe("OXP activity not found")
      expect(output).toEqual({ activityId: "oxp-test-missing", found: false })
    }),
  )

  it.live("works with no directory or instance context", () =>
    Effect.gen(function* () {
      // it.live provides no TestInstance and this body never calls
      // provideInstance: InstanceState.context would die here, so success
      // proves the oxp path materializes no workspace instance.
      yield* seedActivity({ id: "oxp-test-no-instance", title: "No instance", lastSeenAt: 1700000000000 })
      const { output } = yield* runOxp()
      expect(output.activities).toHaveLength(1)
      expect(output.activities[0].id).toBe("oxp-test-no-instance")
    }),
  )

  it.live("rejects scope combined with oxp", () =>
    Effect.gen(function* () {
      const toolInfo = yield* Tool.init(yield* SessionTool)
      const exit = yield* toolInfo
        .execute(
          { action: "oxp", scope: "global" } as any,
          ctx(SessionID.make("ses_oxp_probe"), MessageID.ascending()),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.live("rejects oxpLimit on non-oxp actions", () =>
    Effect.gen(function* () {
      const toolInfo = yield* Tool.init(yield* SessionTool)
      const exit = yield* toolInfo
        .execute({ action: "list", oxpLimit: 5 } as any, ctx(SessionID.make("ses_oxp_probe"), MessageID.ascending()))
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
