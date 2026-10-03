import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmTaskRunTable } from "@opencode-ai/core/swarm/sql"
import { TASK_RUN_RESULT_SUMMARY_MAX_BYTES } from "@opencode-ai/core/swarm/bounds"
import {
  byteLength,
  buildHandoff,
  clampText,
  outcomeOf,
  HANDOFF_LIMITS,
  type HandoffPredecessorRow,
} from "@opencode-ai/core/swarm/handoff"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Swarm } from "@opencode-ai/schema/swarm"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SwarmV2.node])),
)

const projectID = ProjectV2.ID.make("swarm-handoff-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_handoff")
const coordinatorSession = SessionV2.ID.make("ses_swarm_handoff_coordinator")
const workerSession = SessionV2.ID.make("ses_swarm_handoff_worker")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/handoff"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm handoff", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([coordinatorSession, workerSession].map((id) => ({
      id,
      project_id: projectID,
      workspace_id: workspaceID,
      slug: id,
      directory: "/swarm/handoff",
      title: id,
      version: "test",
    })))
    .run()
    .pipe(Effect.orDie)
})

const createRunnable = Effect.fn("handoff.createRunnable")(function* (name: string, now = 100) {
  const swarms = yield* SwarmV2.Service
  const swarm = yield* swarms.create({
    projectID,
    workspaceID,
    directory: "/swarm/handoff",
    name,
    now,
  })
  const coordinator = yield* swarms.addMember({
    swarmID: swarm.id,
    name: "coordinator",
    kind: "coordinator",
    role: "Lead",
    sessionID: coordinatorSession,
    workspacePolicy: { mode: "shared-read" },
    now: now + 1,
  })
  const worker = yield* swarms.addMember({
    swarmID: swarm.id,
    name: "worker",
    kind: "managed_worker",
    role: "Builder",
    desiredProfile: managedProfile,
    sessionID: workerSession,
    workspacePolicy: { mode: "shared-write" },
    now: now + 2,
  })
  const active = yield* swarms.update({
    id: swarm.id,
    expectedRevision: swarm.revision,
    coordinatorMemberID: coordinator.id,
    status: "active",
    now: now + 3,
  })
  return { swarm: active, coordinator, worker }
})

/** Run a predecessor task through admission/start and settle it terminally. */
const runPredecessor = Effect.fn("handoff.runPredecessor")(function* (input: {
  swarmID: Swarm.ID
  memberID: Swarm.MemberID
  title: string
  settlement:
    | { type: "completed"; summary?: string }
    | { type: "failed"; failureKind: Swarm.TaskFailureKind; detail?: string }
  now: number
  runIndex: number
}) {
  const swarms = yield* SwarmV2.Service
  const task = yield* swarms.createTask({
    swarmID: input.swarmID,
    title: input.title,
    now: input.now,
  })
  const claimed = yield* swarms.claimTask({
    swarmID: input.swarmID,
    taskID: task.id,
    memberID: input.memberID,
    processOwner: "handoff-test",
    leaseMs: 60_000,
    now: input.now + 1,
  })
  const run = yield* swarms.recordTaskRun({
    token: claimed.token,
    sessionInputID: SessionMessage.ID.make("msg_swarm_handoff_run_" + input.runIndex),
    admittedAt: input.now + 2,
    now: input.now + 2,
  })
  yield* swarms.startTaskRun({ token: claimed.token, runID: run.id, now: input.now + 3 })
  yield* swarms.settleTask({
    token: claimed.token,
    runID: run.id,
    settlement: input.settlement,
    now: input.now + 4,
  })
  return { task, run }
})

describe("Swarm bounded predecessor handoff", () => {
  it.effect("carries predecessor identity, durable outcome, deliverables, and shared state into a dependent task", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("handoff", 100)

      const predecessor = yield* runPredecessor({
        swarmID: swarm.id,
        memberID: worker.id,
        title: "establish the baseline",
        settlement: { type: "completed" },
        now: 1_000,
        runIndex: 0,
      })
      yield* swarms.publishDeliverable({
        swarmID: swarm.id,
        memberID: worker.id,
        taskRunID: predecessor.run.id,
        summary: "baseline is green",
        refs: ["swr_baseline"],
        files: ["reports/baseline.md"],
        now: 1_100,
      })
      yield* swarms.putBlackboard({
        swarmID: swarm.id,
        key: "baseline/finding",
        value: { ok: true },
        contentType: "application/json",
        authorMemberID: worker.id,
        taskID: predecessor.task.id,
        now: 1_110,
      })
      const dependent = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "extend the baseline",
        dependencies: [{ taskID: predecessor.task.id }],
        now: 1_200,
      })

      const handoff = yield* swarms.taskHandoff(dependent.id)
      expect(handoff.predecessors.length).toBe(1)
      expect(handoff.predecessors[0]).toMatchObject({
        taskID: predecessor.task.id,
        requirement: "require_success",
        status: "completed",
        completed: true,
        outcome: "completed",
        semanticRetryCount: 0,
        resultMemberID: worker.id,
        resultSummary: "",
      })
      expect(handoff.predecessors[0]!.summary).toContain("baseline is green")
      expect(handoff.predecessors[0]!.deliverables.length).toBe(1)
      expect(handoff.predecessors[0]!.deliverables[0]!.files).toEqual(["reports/baseline.md"])
      expect(handoff.predecessors[0]!.deliverables[0]!.refsAreReferences).toBe(true)
      expect(handoff.predecessors[0]!.shared.map((item) => item.key)).toEqual(["baseline/finding"])
      expect(handoff.predecessors[0]!.shared[0]).toMatchObject({
        authorMemberID: worker.id,
        version: 1,
        contentType: "application/json",
      })
      expect(handoff.droppedPredecessors).toBe(0)
      expect(handoff.truncated).toBe(false)
      expect(handoff.totalBytes).toBeGreaterThan(0)
      expect(handoff.totalBytes).toBeLessThanOrEqual(HANDOFF_LIMITS.totalBytes)
    }),
  )

  it.effect("carries a successful run result without requiring a separate deliverable", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("handoff-result-summary", 150)

      const predecessor = yield* runPredecessor({
        swarmID: swarm.id,
        memberID: worker.id,
        title: "extract exact facts",
        settlement: {
          type: "completed",
          summary: "fact one; fact two; fact three",
        },
        now: 1_500,
        runIndex: 50,
      })
      const dependent = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "consume exact facts",
        dependencies: [{ taskID: predecessor.task.id }],
        now: 1_600,
      })

      const handoff = yield* swarms.taskHandoff(dependent.id)
      expect(handoff.predecessors).toHaveLength(1)
      expect(handoff.predecessors[0]!.resultMemberID).toBe(worker.id)
      expect(handoff.predecessors[0]!.resultSummary).toBe("fact one; fact two; fact three")
      expect(handoff.predecessors[0]!.summary).toBe("")
      expect(handoff.predecessors[0]!.deliverables).toEqual([])
      expect(byteLength(handoff.predecessors[0]!.resultSummary)).toBeLessThanOrEqual(
        HANDOFF_LIMITS.resultSummaryBytes,
      )
    }),
  )

  it.effect("bounds durable UTF-8 result summaries independently from deliverable summaries", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("handoff-result-bounds", 175)
      const oversized = "🧪".repeat(TASK_RUN_RESULT_SUMMARY_MAX_BYTES)

      const predecessor = yield* runPredecessor({
        swarmID: swarm.id,
        memberID: worker.id,
        title: "produce bounded result",
        settlement: { type: "completed", summary: oversized },
        now: 1_750,
        runIndex: 51,
      })
      yield* swarms.publishDeliverable({
        swarmID: swarm.id,
        memberID: worker.id,
        taskRunID: predecessor.run.id,
        summary: "published evidence summary",
        now: 1_800,
      })
      const dependent = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "consume bounded result",
        dependencies: [{ taskID: predecessor.task.id }],
        now: 1_850,
      })

      const history = yield* swarms.taskRunHistory({
        swarmID: swarm.id,
        taskID: predecessor.task.id,
        limit: 1,
      })
      const run = history.items[0]!
      expect(run.id).toBe(predecessor.run.id)
      expect(run.resultSummary).toBeDefined()
      expect(byteLength(run.resultSummary!)).toBeLessThanOrEqual(TASK_RUN_RESULT_SUMMARY_MAX_BYTES)
      expect(run.resultSummary).toEndWith(" [truncated]")

      const handoff = yield* swarms.taskHandoff(dependent.id)
      const projected = handoff.predecessors[0]!
      expect(projected.resultMemberID).toBe(worker.id)
      expect(projected.resultSummary).toContain("🧪")
      expect(projected.resultSummary).toEndWith(" [truncated]")
      expect(byteLength(projected.resultSummary)).toBeLessThanOrEqual(HANDOFF_LIMITS.resultSummaryBytes)
      expect(projected.summary).toBe("published evidence summary")
      expect(byteLength(projected.summary)).toBeLessThanOrEqual(HANDOFF_LIMITS.summaryBytes)
      // The 2 KiB predecessor budget is intentionally large enough
      // to preserve one bounded successful-run result and its structured
      // deliverable together. Truncation still reports the oversized result
      // clamp itself rather than silently implying full-fidelity text.
      expect(projected.deliverables).toHaveLength(1)
      expect(projected.droppedDeliverables).toBe(0)
      expect(handoff.truncated).toBe(true)
    }),
  )

  it.effect("projects the latest successful retry result instead of an earlier failed attempt", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("handoff-retry-result", 190)
      const task = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "retry then succeed",
        now: 1_900,
      })

      const first = yield* swarms.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: worker.id,
        processOwner: "handoff-retry",
        leaseMs: 60_000,
        now: 1_901,
      })
      const firstRun = yield* swarms.recordTaskRun({
        token: first.token,
        sessionInputID: SessionMessage.ID.make("msg_swarm_handoff_retry_1"),
        now: 1_902,
      })
      yield* swarms.startTaskRun({ token: first.token, runID: firstRun.id, now: 1_903 })
      yield* swarms.settleTask({
        token: first.token,
        runID: firstRun.id,
        settlement: { type: "failed", failureKind: "provider", detail: "transient provider failure" },
        now: 1_904,
      })

      const second = yield* swarms.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: worker.id,
        processOwner: "handoff-retry",
        leaseMs: 60_000,
        now: 1_910,
      })
      const secondRun = yield* swarms.recordTaskRun({
        token: second.token,
        sessionInputID: SessionMessage.ID.make("msg_swarm_handoff_retry_2"),
        now: 1_911,
      })
      yield* swarms.startTaskRun({ token: second.token, runID: secondRun.id, now: 1_912 })
      yield* swarms.settleTask({
        token: second.token,
        runID: secondRun.id,
        settlement: { type: "completed", summary: "second attempt produced the durable answer" },
        now: 1_913,
      })

      const dependent = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "consume retry result",
        dependencies: [{ taskID: task.id }],
        now: 1_920,
      })
      const handoff = yield* swarms.taskHandoff(dependent.id)
      expect(handoff.predecessors).toHaveLength(1)
      expect(handoff.predecessors[0]).toMatchObject({
        taskID: task.id,
        status: "completed",
        outcome: "completed",
        semanticRetryCount: 0,
        resultMemberID: worker.id,
        resultSummary: "second attempt produced the durable answer",
      })
      expect(handoff.predecessors[0]!.resultSummary).not.toContain("transient provider failure")
    }),
  )

  it.effect("selects the run that produced the terminal task status instead of a newer superseded trace", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { db } = yield* Database.Service
      const { swarm, worker } = yield* createRunnable("handoff-terminal-run-selection", 195)

      const predecessor = yield* runPredecessor({
        swarmID: swarm.id,
        memberID: worker.id,
        title: "complete before stray retirement trace",
        settlement: { type: "completed", summary: "authoritative completed result" },
        now: 1_950,
        runIndex: 52,
      })

      // Adversarial append-only trace: a later-created superseded attempt must
      // never replace the completed run that explains task.status=completed.
      yield* db
        .insert(SwarmTaskRunTable)
        .values({
          id: Swarm.TaskRunID.make("swrn_swarm_handoff_terminal_selection"),
          task_id: predecessor.task.id,
          member_id: worker.id,
          session_id: workerSession,
          binding_generation: 1,
          lease_generation: 99,
          session_input_id: SessionMessage.ID.make("msg_swarm_handoff_terminal_selection"),
          status: "superseded",
          ended_at: 9_999,
          time_created: 9_999,
        })
        .run()
        .pipe(Effect.orDie)

      const dependent = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "consume authoritative terminal result",
        dependencies: [{ taskID: predecessor.task.id }],
        now: 10_000,
      })

      const handoff = yield* swarms.taskHandoff(dependent.id)
      expect(handoff.predecessors[0]).toMatchObject({
        taskID: predecessor.task.id,
        status: "completed",
        outcome: "completed",
        resultMemberID: worker.id,
        resultSummary: "authoritative completed result",
      })
    }),
  )

  it.effect("gives a require_terminal successor the durable failure reason, not just status=failed", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("handoff-failure", 200)

      const predecessor = yield* runPredecessor({
        swarmID: swarm.id,
        memberID: worker.id,
        title: "attempt the impossible",
        settlement: {
          type: "failed",
          failureKind: "semantic",
          detail: "premise refuted; the metric is not measurable",
        },
        now: 2_000,
        runIndex: 1,
      })
      expect(predecessor.task.id).toBeDefined()
      const dependent = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "recover from the refuted premise",
        dependencies: [{ taskID: predecessor.task.id, requirement: "require_terminal" }],
        now: 2_100,
      })
      const settled = yield* swarms.get(swarm.id)
      expect(settled.tasks.find((task) => task.id === predecessor.task.id)?.status).toBe("failed")
      // require_terminal must unblock the successor once the predecessor is terminal.
      expect(settled.tasks.find((task) => task.id === dependent.id)?.status).toBe("ready")

      const handoff = yield* swarms.taskHandoff(dependent.id)
      const projected = handoff.predecessors[0]!
      expect(projected.requirement).toBe("require_terminal")
      expect(projected.status).toBe("failed")
      expect(projected.outcome).toBe("failed:semantic — premise refuted; the metric is not measurable")
      expect(projected.semanticRetryCount).toBe(1)
    }),
  )

  it.effect("is independent of predecessor Session history length and never leaks it", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { db } = yield* Database.Service
      const { swarm, worker } = yield* createRunnable("handoff-history", 300)

      const predecessor = yield* runPredecessor({
        swarmID: swarm.id,
        memberID: worker.id,
        title: "produce a finding",
        settlement: { type: "completed", summary: "durable run finding" },
        now: 3_000,
        runIndex: 2,
      })
      yield* swarms.publishDeliverable({
        swarmID: swarm.id,
        memberID: worker.id,
        taskRunID: predecessor.run.id,
        summary: "finding recorded",
        now: 3_100,
      })
      const dependent = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "consume the finding",
        dependencies: [{ taskID: predecessor.task.id }],
        now: 3_200,
      })

      const before = yield* swarms.taskHandoff(dependent.id)
      expect(before.predecessors[0]?.resultSummary).toBe("durable run finding")
      const rendered = JSON.stringify(before)

      // Negative invariant: a predecessor that produced a very long Session
      // transcript must not change the handoff at all. If this projection ever
      // hydrated predecessor history, the payload would grow or its bytes would
      // move with message count.
      yield* db
        .insert(SessionMessageTable)
        .values(
          Array.from({ length: 400 }, (_, index) => ({
            id: SessionMessage.ID.make("msg_swarm_handoff_history_" + index),
            session_id: workerSession,
            type: "assistant" as const,
            seq: index,
            data: { role: "assistant", time: { created: 3_500 + index, completed: 3_500 + index } },
            search_text: "secret-transcript-" + index,
          })),
        )
        .run()
        .pipe(Effect.orDie)

      const after = yield* swarms.taskHandoff(dependent.id)
      expect(JSON.stringify(after)).toBe(rendered)
      expect(after.totalBytes).toBe(before.totalBytes)
      expect(JSON.stringify(after)).not.toContain("secret-transcript")
    }),
  )

  it.effect("caps DAG degree and per-predecessor knowledge at the read, and reports the omission", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("handoff-bounds", 400)

      const predecessorIDs: Swarm.TaskID[] = []
      for (let index = 0; index < HANDOFF_LIMITS.predecessors + 4; index++) {
        const predecessor = yield* runPredecessor({
          swarmID: swarm.id,
          memberID: worker.id,
          title: "predecessor " + index,
          settlement: { type: "completed" },
          now: 4_000 + index * 10,
          runIndex: 100 + index,
        })
        predecessorIDs.push(predecessor.task.id)
        for (let publish = 0; publish < HANDOFF_LIMITS.deliverables + 3; publish++)
          yield* swarms.publishDeliverable({
            swarmID: swarm.id,
            memberID: worker.id,
            taskRunID: predecessor.run.id,
            summary: `deliverable ${index}/${publish}`,
            refs: Array.from({ length: HANDOFF_LIMITS.refs + 3 }, (_, ref) => `ref-${index}-${ref}`),
            files: Array.from({ length: HANDOFF_LIMITS.files + 3 }, (_, file) => `file-${index}-${file}.md`),
            now: 4_600 + index * 100 + publish,
          })
        for (let entry = 0; entry < HANDOFF_LIMITS.sharedEntries + 3; entry++)
          yield* swarms.putBlackboard({
            swarmID: swarm.id,
            key: `finding/${index}/${entry}`,
            value: { entry, note: "x".repeat(4_000) },
            contentType: "application/json",
            authorMemberID: worker.id,
            taskID: predecessor.task.id,
            now: 4_800 + index * 100 + entry,
          })
      }

      const dependent = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "depend on everything",
        dependencies: predecessorIDs.map((taskID) => ({ taskID })),
        now: 9_000,
      })
      const handoff = yield* swarms.taskHandoff(dependent.id)

      expect(handoff.predecessors.length).toBeLessThanOrEqual(HANDOFF_LIMITS.predecessors)
      expect(handoff.droppedPredecessors).toBeGreaterThan(0)
      expect(handoff.truncated).toBe(true)
      expect(handoff.totalBytes).toBeLessThanOrEqual(HANDOFF_LIMITS.totalBytes)
      for (const predecessor of handoff.predecessors) {
        expect(predecessor.deliverables.length).toBeLessThanOrEqual(HANDOFF_LIMITS.deliverables)
        expect(predecessor.shared.length).toBeLessThanOrEqual(HANDOFF_LIMITS.sharedEntries)
        expect(predecessor.droppedDeliverables).toBeGreaterThan(0)
        // Every retained field is bounded by its own clamp, so no single row can
        // dominate the payload.
        expect(byteLength(predecessor.title)).toBeLessThanOrEqual(HANDOFF_LIMITS.summaryBytes + 32)
        expect(byteLength(predecessor.summary)).toBeLessThanOrEqual(HANDOFF_LIMITS.summaryBytes + 64)
        for (const entry of predecessor.shared)
          expect(byteLength(entry.value)).toBeLessThanOrEqual(HANDOFF_LIMITS.sharedValueBytes + 32)
      }
    }),
  )

  it.effect("fences cross-Swarm and unknown-task requests instead of selecting state", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const first = yield* createRunnable("handoff-fence-a", 500)
      const second = yield* createRunnable("handoff-fence-b", 600)

      const predecessor = yield* runPredecessor({
        swarmID: first.swarm.id,
        memberID: first.worker.id,
        title: "private to the first swarm",
        settlement: { type: "completed" },
        now: 5_000,
        runIndex: 3,
      })
      const dependent = yield* swarms.createTask({
        swarmID: first.swarm.id,
        title: "successor",
        dependencies: [{ taskID: predecessor.task.id }],
        now: 5_100,
      })

      const owned = yield* swarms.taskHandoff(dependent.id, { swarmID: first.swarm.id })
      expect(owned.predecessors.map((item) => item.taskID)).toEqual([predecessor.task.id])

      const foreign = yield* swarms.taskHandoff(dependent.id, { swarmID: second.swarm.id })
      expect(foreign.predecessors).toEqual([])
      expect(foreign.truncated).toBe(false)

      const missing = yield* swarms.taskHandoff(Swarm.TaskID.make("swt_does_not_exist"))
      expect(missing.predecessors).toEqual([])

      // A task with no declared dependency edge injects nothing at all.
      const independent = yield* swarms.createTask({ swarmID: first.swarm.id, title: "no deps", now: 5_200 })
      expect((yield* swarms.taskHandoff(independent.id)).predecessors).toEqual([])
    }),
  )

  it.effect("is deterministic for identical durable rows", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("handoff-determinism", 700)

      const predecessor = yield* runPredecessor({
        swarmID: swarm.id,
        memberID: worker.id,
        title: "deterministic predecessor",
        settlement: { type: "completed" },
        now: 6_000,
        runIndex: 4,
      })
      for (let index = 0; index < 3; index++)
        yield* swarms.publishDeliverable({
          swarmID: swarm.id,
          memberID: worker.id,
          taskRunID: predecessor.run.id,
          summary: `stable ${index}`,
          now: 6_100 + index,
        })
      for (let index = 0; index < 3; index++)
        yield* swarms.putBlackboard({
          swarmID: swarm.id,
          key: `stable/${index}`,
          value: { index },
          contentType: "application/json",
          authorMemberID: worker.id,
          taskID: predecessor.task.id,
          now: 6_200 + index,
        })
      const dependent = yield* swarms.createTask({
        swarmID: swarm.id,
        title: "deterministic successor",
        dependencies: [{ taskID: predecessor.task.id }],
        now: 6_300,
      })

      const first = JSON.stringify(yield* swarms.taskHandoff(dependent.id))
      const second = JSON.stringify(yield* swarms.taskHandoff(dependent.id))
      expect(second).toBe(first)
    }),
  )
})

describe("Swarm handoff pure bounds", () => {
  test("clamps on a UTF-8 boundary and reports UTF-8 bytes, not code units", () => {
    expect(byteLength("ok")).toBe(2)
    expect(byteLength("é")).toBe(2)
    expect(byteLength("漢")).toBe(3)
    const clamped = clampText("漢".repeat(10), 10)
    expect(byteLength(clamped)).toBeLessThanOrEqual(10)
    // A clamp must never split a multi-byte character into replacement output.
    expect(clamped.includes("�")).toBe(false)
    expect(clampText("abc", 0)).toBe("")
    // The bound holds even when the truncation marker alone exceeds the budget.
    for (const budget of [1, 2, 5, 11, 12, 13, 64]) {
      const value = clampText("漢".repeat(200), budget)
      expect(byteLength(value)).toBeLessThanOrEqual(budget)
      expect(value).not.toContain("�")
    }
    expect(clampText("abcdef", 64)).toBe("abcdef")
    expect(clampText("a".repeat(40), 20)).toContain("[truncated]")
    expect(byteLength(clampText("a".repeat(40), 20))).toBe(20)
  })

  test("derives a host outcome that explains a terminal failure", () => {
    expect(outcomeOf("completed", undefined, HANDOFF_LIMITS)).toBe("completed")
    expect(outcomeOf("cancelled", undefined, HANDOFF_LIMITS)).toBe("cancelled")
    expect(outcomeOf("review_pending", undefined, HANDOFF_LIMITS)).toBe("review_pending")
    expect(outcomeOf("failed", undefined, HANDOFF_LIMITS)).toBe("failed")
    expect(
      outcomeOf(
        "failed",
        { status: "failed", failureKind: "permission", failureDetail: "denied by policy", failureLength: 15 },
        HANDOFF_LIMITS,
      ),
    ).toBe("failed:permission — denied by policy")
    expect(
      outcomeOf(
        "failed",
        { status: "failed", failureKind: "provider", failureDetail: "   ", failureLength: 3 },
        HANDOFF_LIMITS,
      ),
    ).toBe("failed:provider")
  })

  test("builds a bounded, deterministic projection and degrades one noisy predecessor instead of the whole handoff", () => {
    const predecessors: HandoffPredecessorRow[] = Array.from({ length: 12 }, (_, index) => ({
      taskID: Swarm.TaskID.make("swt_p" + index),
      requirement: "require_success" as const,
      title: `predecessor ${index}`,
      status: "completed" as const,
      completed: true,
      outcome: "completed",
      semanticRetryCount: 0,
    }))
    const noisy: HandoffPredecessorRow = {
      taskID: Swarm.TaskID.make("swt_noisy"),
      requirement: "require_success",
      title: "noisy",
      status: "completed",
      completed: true,
      outcome: "completed",
      semanticRetryCount: 3,
    }
const input = {
      predecessors: [...predecessors, noisy],
      deliverables: [
        {
          id: Swarm.DeliverableID.make("swdlv_noisy"),
          taskID: noisy.taskID,
          memberID: Swarm.MemberID.make("swm_author"),
          summary: "s".repeat(4_000),
          refs: Array.from({ length: 20 }, (_, index) => `ref-${index}`),
          files: Array.from({ length: 20 }, (_, index) => `file-${index}.md`),
          verdict: undefined,
          listsClamped: false,
        },
      ],
      shared: [
        {
          taskID: noisy.taskID,
          key: "noisy/key",
          value: "v".repeat(4_000),
          contentType: "application/json",
          version: 1,
          authorMemberID: Swarm.MemberID.make("swm_author"),
          valueClamped: true,
        },
      ],
      droppedPredecessors: 3,
    }
    const handoff = buildHandoff(input)

    expect(handoff.predecessors.length).toBeLessThanOrEqual(HANDOFF_LIMITS.predecessors)
    expect(handoff.droppedPredecessors).toBeGreaterThanOrEqual(3)
    expect(handoff.truncated).toBe(true)
    expect(handoff.totalBytes).toBeLessThanOrEqual(HANDOFF_LIMITS.totalBytes)
    expect(JSON.stringify(handoff)).toBe(JSON.stringify(buildHandoff(input)))
    expect(buildHandoff({ predecessors: [], deliverables: [], shared: [] }).predecessors).toEqual([])
  })
})