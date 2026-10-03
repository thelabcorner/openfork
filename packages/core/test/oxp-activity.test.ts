import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { OxpActivity as OxpActivityContract } from "@opencode-ai/schema/oxp-activity"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    OxpActivity.node,
    OxpActivityInspection.node,
  ]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

const failingEventLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    OxpActivity.node,
    OxpActivityInspection.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [
      EventV2.node,
      Layer.mock(EventV2.Service)({
        publish: () => Effect.die("synthetic live projection failure"),
      }),
    ],
  ],
)
const failingEventIt = testEffect(failingEventLayer)

describe("OxpActivity", () => {
  failingEventIt.live(
    "keeps durable truth successful when live projection publication fails",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const started = yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "event-failure-parent",
          scope: "unknown",
        },
        hostRunID: "host-event-failure",
        plane: "augmentation",
        tool: "read",
        startedAt: 500,
      })
      expect((yield* inspection.get(started.activityID))?.call_count).toBe(1)
      expect(
        yield* activity.settle({
          invocationID: started.invocationID,
          status: "committed",
          mutationAttempted: true,
          mutationCommitted: true,
          completedAt: 550,
        }),
      ).toBe(true)
      const page = yield* inspection.invocations({
        activityID: started.activityID,
      })
      expect(page.items[0]).toMatchObject({
        status: "committed",
        mutation_attempted: true,
        mutation_committed: true,
        time_completed: 550,
      })
    }),
  )

  it.live(
    "rejects safe summaries above the 8 KiB persistence budget before writing history",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const exit = yield* Effect.exit(
        activity.begin({
          correlation: {
            scheme: "mcp-session-id",
            digest: "oversized-summary-parent",
            scope: "unknown",
          },
          hostRunID: "host-summary-budget",
          plane: "augmentation",
          tool: "read",
          summary: { payload: "x".repeat(9 * 1024) },
        }),
      )
      expect(exit._tag).toBe("Failure")
      expect(yield* inspection.list()).toEqual([])
    }),
  )

  it.live(
    "stores request/outcome detail separately from compact invocation rows and cascades it with history deletion",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const started = yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "detail-parent",
          scope: "unknown",
        },
        hostRunID: "host-detail",
        plane: "augmentation",
        tool: "process",
        action: "start",
        detail: {
          args: {
            command: "bun test packages/core",
            workdir: "packages/core",
          },
        },
      })
      yield* activity.settle({
        invocationID: started.invocationID,
        status: "success",
        detail: {
          output: "42 pass",
          metadata: { exitCode: 0 },
        },
      })

      const page = yield* inspection.invocations({ activityID: started.activityID })
      expect(page.items).toHaveLength(1)
      expect(JSON.stringify(page.items[0])).not.toContain("bun test packages/core")
      expect(JSON.stringify(page.items[0])).not.toContain("42 pass")

      expect(yield* inspection.invocationDetail(started.invocationID)).toEqual({
        invocation_id: started.invocationID,
        request: {
          args: {
            command: "bun test packages/core",
            workdir: "packages/core",
          },
        },
        outcome: {
          output: "42 pass",
          metadata: { exitCode: 0 },
        },
      })

      expect(yield* activity.deleteHistory(started.activityID)).toBe(true)
      expect(yield* inspection.invocationDetail(started.invocationID)).toBeUndefined()
    }),
  )

  it.live(
    "recreates a deleted parent when the same correlation is observed again",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const correlation = {
        scheme: "mcp-session-id",
        digest: "digest-recreated-parent",
        scope: "unknown",
      } as const

      const first = yield* activity.begin({
        correlation,
        hostRunID: "host-recreate",
        observedEpoch: 1,
        plane: "augmentation",
        tool: "read",
      })
      yield* activity.settle({
        invocationID: first.invocationID,
        status: "success",
      })
      expect(yield* activity.deleteHistory(first.activityID)).toBe(true)

      const second = yield* activity.begin({
        correlation,
        hostRunID: "host-recreate",
        observedEpoch: 2,
        plane: "augmentation",
        tool: "read",
      })

      expect(second.activityID).not.toBe(first.activityID)
      expect(second.activityCreated).toBe(true)
      expect(yield* inspection.get(second.activityID)).toMatchObject({
        id: second.activityID,
        call_count: 1,
      })
    }),
  )

  it.live(
    "deduplicates one correlation into one durable parent while preserving concurrent spans",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const starts = yield* Effect.all(
        Array.from({ length: 6 }, (_, index) =>
          activity.begin({
            correlation: {
              scheme: "mcp-session-id",
              digest: "digest-parent-a",
              scope: "unknown",
            },
            hostRunID: "host-a",
            observedEpoch: 1,
            plane: index % 2 === 0 ? "augmentation" : "delegation",
            tool: index % 2 === 0 ? "read" : "openfork_worker",
            action: index % 2 === 0 ? undefined : "start",
            rootID: "root-a",
            rootAlias: "opencode",
            startedAt: 1000 + index,
          }),
        ),
        { concurrency: "unbounded" },
      )
      expect(new Set(starts.map((item) => item.activityID)).size).toBe(1)
      expect(new Set(starts.map((item) => item.invocationID)).size).toBe(6)

      const [summary] = yield* inspection.list()
      expect(summary).toMatchObject({
        call_count: 6,
        augmentation_calls: 3,
        delegation_calls: 3,
        observed_epoch_count: 1,
        last_root_alias: "opencode",
      })
      const page = yield* inspection.invocations({
        activityID: starts[0]!.activityID,
      })
      expect(page.items).toHaveLength(6)
      expect(page.items.every((item) => item.status === "running")).toBe(true)
    }),
  )

  it.live(
    "settles exactly once and preserves committed-vs-failed truth",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const started = yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "digest-parent-b",
          scope: "unknown",
        },
        hostRunID: "host-a",
        plane: "delegation",
        tool: "openfork_worker",
        action: "start",
        startedAt: 2000,
      })
      expect(
        yield* activity.settle({
          invocationID: started.invocationID,
          status: "cancelled_after_commit",
          mutationAttempted: true,
          mutationCommitted: true,
          errorCode: "OXP_CANCELLED",
          completedAt: 2100,
        }),
      ).toBe(true)
      expect(
        yield* activity.settle({
          invocationID: started.invocationID,
          status: "failed",
          completedAt: 2200,
        }),
      ).toBe(false)

      const summary = yield* inspection.get(started.activityID)
      expect(summary?.failure_count).toBe(1)
      const page = yield* inspection.invocations({
        activityID: started.activityID,
      })
      expect(page.items[0]).toMatchObject({
        status: "cancelled_after_commit",
        mutation_attempted: true,
        mutation_committed: true,
        time_completed: 2100,
      })
    }),
  )

  it.live(
    "stores causal links without coupling native resource deletion",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const started = yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "digest-parent-c",
          scope: "unknown",
        },
        hostRunID: "host-a",
        plane: "delegation",
        tool: "openfork_worker",
        action: "start",
      })
      yield* activity.link({
        invocationID: started.invocationID,
        kind: "worker_session",
        ref: "ses_worker_123",
        relation: "created",
        label: "build",
      })
      yield* activity.link({
        invocationID: started.invocationID,
        kind: "worker_session",
        ref: "ses_worker_123",
        relation: "created",
        label: "build",
      })
      yield* activity.link({
        invocationID: started.invocationID,
        kind: "worker_session",
        ref: "ses_worker_123",
        relation: "created",
        label: "build",
      })
      const page = yield* inspection.invocations({
        activityID: started.activityID,
      })
      expect(page.links).toEqual([
        expect.objectContaining({
          ref: "ses_worker_123",
          kind: "worker_session",
          relation: "created",
        }),
      ])
      expect(
        yield* inspection.resource({
          kind: "worker_session",
          ref: "ses_worker_123",
        }),
      ).toEqual([
        expect.objectContaining({
          activityID: started.activityID,
          invocationID: started.invocationID,
          kind: "worker_session",
          relation: "created",
          tool: "openfork_worker",
        }),
      ])
      expect(yield* activity.deleteHistory(started.activityID)).toBe(true)
      expect(
        yield* inspection.get(started.activityID),
      ).toBeUndefined()
      expect(
        yield* inspection.resource({
          kind: "worker_session",
          ref: "ses_worker_123",
        }),
      ).toEqual([])

      const { readDb } = yield* Database.Service
      const foreignKeys = yield* readDb.all<{
        table: string
        from: string
        to: string
      }>(sql.raw("PRAGMA foreign_key_list(oxp_invocation_link)"))
      expect(foreignKeys).toEqual([
        expect.objectContaining({
          table: "oxp_invocation",
          from: "invocation_id",
          to: "id",
        }),
      ])
    }),
  )

  it.live(
    "emits link-added only for a newly inserted causal link",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const events = yield* EventV2.Service
      const started = yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "link-event-dedup",
          scope: "unknown",
        },
        hostRunID: "host-link-events",
        plane: "delegation",
        tool: "openfork_worker",
      })
      let linkEvents = 0
      const unsubscribe = yield* events.listenType(
        OxpActivityContract.Event.LinkAdded,
        () =>
          Effect.sync(() => {
            linkEvents += 1
          }),
      )
      const link = {
        invocationID: started.invocationID,
        kind: "worker_session" as const,
        ref: "ses_same_worker",
        relation: "created",
      }
      yield* activity.link(link)
      yield* activity.link(link)
      yield* unsubscribe
      expect(linkEvents).toBe(1)
    }),
  )

  it.live(
    "never exposes the correlation digest through parent summaries",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "raw-never-egresses",
          scope: "unknown",
        },
        hostRunID: "host-a",
        plane: "augmentation",
        tool: "read",
      })
      const summaries = yield* inspection.list()
      expect(JSON.stringify(summaries)).not.toContain("raw-never-egresses")
    }),
  )

  it.live(
    "publishes compact post-commit invalidations without private activity payloads",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const events = yield* EventV2.Service
      const seen: Array<{ type: string; data: unknown }> = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (!event.type.startsWith("oxpActivity.")) return
          seen.push({ type: event.type, data: event.data })
        }),
      )

      const started = yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "private-digest-events",
          scope: "unknown",
        },
        hostRunID: "host-events",
        plane: "delegation",
        tool: "openfork_worker",
        action: "start",
      })
      yield* activity.link({
        invocationID: started.invocationID,
        kind: "worker_session",
        ref: "ses_private_link_payload",
        relation: "created",
      })
      yield* activity.settle({
        invocationID: started.invocationID,
        status: "committed",
        mutationAttempted: true,
        mutationCommitted: true,
      })
      yield* activity.rename(started.activityID, "Local title")
      yield* activity.deleteHistory(started.activityID)
      yield* unsubscribe

      expect(seen.map((event) => event.type)).toEqual([
        "oxpActivity.created",
        "oxpActivity.invocation.started",
        "oxpActivity.link.added",
        "oxpActivity.updated",
        "oxpActivity.invocation.settled",
        "oxpActivity.updated",
        "oxpActivity.removed",
      ])
      const serialized = JSON.stringify(seen)
      expect(serialized).not.toContain("private-digest-events")
      expect(serialized).not.toContain("ses_private_link_payload")
      expect(serialized).not.toContain("openfork_worker")
    }),
  )

  it.live(
    "interrupts only still-running spans from the selected host generation",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const first = yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "host-recovery-parent",
          scope: "unknown",
        },
        hostRunID: "runtime-owner:dead-host",
        plane: "augmentation",
        tool: "read",
        startedAt: 3000,
      })
      const settled = yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "host-recovery-parent",
          scope: "unknown",
        },
        hostRunID: "runtime-owner:dead-host",
        plane: "supervision",
        tool: "openfork_session",
        startedAt: 3001,
      })
      yield* activity.settle({
        invocationID: settled.invocationID,
        status: "success",
        completedAt: 3010,
      })
      const foreignLive = yield* activity.begin({
        correlation: {
          scheme: "mcp-session-id",
          digest: "host-recovery-other-parent",
          scope: "unknown",
        },
        hostRunID: "runtime-owner:live-host",
        plane: "augmentation",
        tool: "grep",
        startedAt: 3002,
      })

      expect(new Set(yield* activity.runningHostRuns())).toEqual(
        new Set(["runtime-owner:dead-host", "runtime-owner:live-host"]),
      )
      expect(yield* activity.interruptHostRun("runtime-owner:dead-host", 3020)).toBe(1)
      expect(yield* activity.interruptHostRun("runtime-owner:dead-host", 3030)).toBe(0)

      const page = yield* inspection.invocations({ activityID: first.activityID })
      expect(page.items.find((item) => item.id === first.invocationID)).toMatchObject({
        status: "interrupted",
        error_code: "OXP_HOST_INTERRUPTED",
        mutation_attempted: false,
        mutation_committed: false,
        time_completed: 3020,
      })
      expect(page.items.find((item) => item.id === settled.invocationID)?.status).toBe("success")
      expect((yield* inspection.get(first.activityID))?.failure_count).toBe(1)

      const livePage = yield* inspection.invocations({ activityID: foreignLive.activityID })
      expect(livePage.items[0]?.status).toBe("running")
    }),
  )

  it.live(
    "paginates parents and invocation spans without gaps or duplicates across timestamp ties",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const parents = yield* Effect.all(
        Array.from({ length: 5 }, (_, index) =>
          activity.begin({
            correlation: {
              scheme: "mcp-session-id",
              digest: `pagination-parent-${index}`,
              scope: "unknown",
            },
            hostRunID: "host-pagination",
            plane: "augmentation",
            tool: "read",
            startedAt: 10_000,
          }),
        ),
      )

      const seenParents: string[] = []
      let parentCursor:
        | { lastSeenAt: number; id: (typeof parents)[number]["activityID"] }
        | undefined
      for (;;) {
        const page = yield* inspection.list({
          limit: 2,
          ...(parentCursor ? { before: parentCursor } : {}),
        })
        seenParents.push(...page.map((row) => row.id))
        const tail = page.at(-1)
        if (page.length < 2 || !tail) break
        parentCursor = { lastSeenAt: tail.last_seen_at, id: tail.id }
      }
      expect(seenParents).toHaveLength(5)
      expect(new Set(seenParents).size).toBe(5)
      expect(new Set(seenParents)).toEqual(
        new Set(parents.map((parent) => parent.activityID)),
      )

      const parent = parents[0]!
      const tied = yield* Effect.all(
        Array.from({ length: 7 }, () =>
          activity.begin({
            correlation: {
              scheme: "mcp-session-id",
              digest: "pagination-parent-0",
              scope: "unknown",
            },
            hostRunID: "host-pagination",
            plane: "supervision",
            tool: "openfork_session",
            startedAt: 20_000,
          }),
        ),
      )
      const seenInvocations: string[] = []
      let invocationCursor:
        | { startedAt: number; id: (typeof tied)[number]["invocationID"] }
        | undefined
      for (;;) {
        const page = yield* inspection.invocations({
          activityID: parent.activityID,
          limit: 3,
          ...(invocationCursor ? { before: invocationCursor } : {}),
        })
        seenInvocations.push(...page.items.map((row) => row.id))
        if (!page.more || !page.before) break
        invocationCursor = page.before
      }
      // The activity already owns its initial parent-creation invocation plus
      // the seven tied rows created above.
      expect(seenInvocations).toHaveLength(8)
      expect(new Set(seenInvocations).size).toBe(8)
      for (const row of tied)
        expect(seenInvocations).toContain(row.invocationID)
    }),
  )

  it.live(
    "preserves exact cardinality and settlement counters under 96 concurrent parent calls",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const starts = yield* Effect.all(
        Array.from({ length: 96 }, (_, index) =>
          activity.begin({
            correlation: {
              scheme: "mcp-session-id",
              digest: "concurrency-parent-96",
              scope: "unknown",
            },
            hostRunID: "host-concurrency-96",
            observedEpoch: 4,
            plane:
              index % 3 === 0
                ? "augmentation"
                : index % 3 === 1
                  ? "supervision"
                  : "delegation",
            tool: index % 3 === 2 ? "openfork_worker" : "read",
            startedAt: 30_000 + index,
          }),
        ),
        { concurrency: "unbounded" },
      )
      expect(new Set(starts.map((row) => row.activityID)).size).toBe(1)
      expect(new Set(starts.map((row) => row.invocationID)).size).toBe(96)

      yield* Effect.all(
        starts.map((row, index) =>
          activity.settle({
            invocationID: row.invocationID,
            status: index % 5 === 0 ? "failed" : "success",
            completedAt: 31_000 + index,
          }),
        ),
        { concurrency: "unbounded" },
      )

      const summary = yield* inspection.get(starts[0]!.activityID)
      expect(summary).toMatchObject({
        call_count: 96,
        failure_count: 20,
        augmentation_calls: 32,
        supervision_calls: 32,
        delegation_calls: 32,
        observed_epoch_count: 1,
      })
      const page = yield* inspection.invocations({
        activityID: starts[0]!.activityID,
        limit: 200,
      })
      expect(page.items).toHaveLength(96)
      expect(page.items.filter((row) => row.status === "failed")).toHaveLength(20)
      expect(page.items.filter((row) => row.status === "success")).toHaveLength(76)
    }),
  )

  it.live(
    "counts observed epoch segments across host generations instead of taking the maximum epoch number",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const correlation = {
        scheme: "mcp-session-id",
        digest: "epoch-segment-parent",
        scope: "unknown" as const,
      }
      const inputs = [
        { hostRunID: "runtime-owner:host-a", observedEpoch: 1 },
        { hostRunID: "runtime-owner:host-a", observedEpoch: 1 },
        { hostRunID: "runtime-owner:host-a", observedEpoch: 2 },
        { hostRunID: "runtime-owner:host-b", observedEpoch: 1 },
        { hostRunID: "runtime-owner:host-b", observedEpoch: 1 },
      ] as const

      const rows = []
      for (const input of inputs) {
        rows.push(
          yield* activity.begin({
            correlation,
            ...input,
            plane: "augmentation",
            tool: "read",
          }),
        )
      }
      const summary = yield* inspection.get(rows[0]!.activityID)
      expect(summary?.call_count).toBe(5)
      expect(summary?.observed_epoch_count).toBe(3)
    }),
  )
})

