import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmBlackboardTable } from "@opencode-ai/core/swarm/sql"
import { SwarmKnowledge } from "@opencode-ai/core/swarm/knowledge"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Swarm } from "@opencode-ai/schema/swarm"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SwarmSessionProjector.node, SwarmV2.node]),
  ),
)

const projectID = ProjectV2.ID.make("swarm-knowledge-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_knowledge")
const sessionA = SessionV2.ID.make("ses_swarm_know_a")
const sessionB = SessionV2.ID.make("ses_swarm_know_b")

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/knowledge",
    title: id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/knowledge"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "knowledge", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([sessionRow(sessionA), sessionRow(sessionB)])
    .run()
    .pipe(Effect.orDie)
  const swarm = yield* service.create({
    projectID,
    workspaceID,
    directory: "/swarm/knowledge",
    name: "knowledge swarm",
    now: 10,
  })
  const a = yield* service.addMember({
    swarmID: swarm.id,
    name: "a",
    kind: "coordinator",
    role: "lead",
    sessionID: sessionA,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  const b = yield* service.addMember({
    swarmID: swarm.id,
    name: "b",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: managedProfile,
    sessionID: sessionB,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  const upstream = yield* service.createTask({ swarmID: swarm.id, title: "upstream", now: 30 })
  const unrelated = yield* service.createTask({ swarmID: swarm.id, title: "unrelated", now: 31 })
  const receiver = yield* service.createTask({ swarmID: swarm.id, title: "receiver", now: 32 })
  return { db, service, swarm, a, b, upstream, unrelated, receiver }
})

describe("SwarmKnowledge.digest", () => {
  const member = Swarm.MemberID.make("swm_1")

  function candidate(input: {
    key: string
    scope: SwarmKnowledge.KnowledgeScope
    updatedAt: number
    value?: Swarm.BlackboardEntry["value"]
    taskID?: Swarm.TaskID
  }): SwarmKnowledge.KnowledgeCandidate {
    return {
      scope: input.scope,
      updatedAt: input.updatedAt,
      entry: {
        swarmID: Swarm.ID.make("swr_1"),
        key: input.key,
        value: input.value ?? { note: input.key },
        contentType: "application/json",
        version: 1,
        authorMemberID: member,
        ...(input.taskID === undefined ? {} : { taskID: input.taskID }),
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(input.updatedAt) },
      },
    }
  }

  test("ranks task scope above related above swarm, and recency only within a scope", () => {
    const result = SwarmKnowledge.digest({
      candidates: [
        candidate({ key: "swarm-old", scope: "swarm", updatedAt: 900 }),
        candidate({ key: "related-new", scope: "related", updatedAt: 900 }),
        candidate({ key: "task-old", scope: "task", updatedAt: 1 }),
        candidate({ key: "task-new", scope: "task", updatedAt: 900 }),
        candidate({ key: "swarm-new", scope: "swarm", updatedAt: 900 }),
      ],
    })
    expect(result.entries.map((entry) => entry.key)).toEqual([
      "task-new",
      "task-old",
      "related-new",
      "swarm-new",
      "swarm-old",
    ])
    expect(result.truncated).toBe(false)
    expect(result.omitted).toBe(0)
  })

  test("is a total order: ties break deterministically on key ascending", () => {
    const input = [
      candidate({ key: "b", scope: "swarm", updatedAt: 5 }),
      candidate({ key: "a", scope: "swarm", updatedAt: 5 }),
      candidate({ key: "c", scope: "swarm", updatedAt: 5 }),
    ]
    const first = SwarmKnowledge.digest({ candidates: input }).entries.map((entry) => entry.key)
    const second = SwarmKnowledge.digest({ candidates: [...input].reverse() }).entries.map((entry) => entry.key)
    expect(first).toEqual(["a", "b", "c"])
    expect(second).toEqual(first)
  })

  test("never lets a lower priority scope displace a higher priority one under byte pressure", () => {
    const result = SwarmKnowledge.digest({
      candidates: [
        candidate({ key: "a-task", scope: "task", updatedAt: 1 }),
        candidate({ key: "b-task", scope: "task", updatedAt: 2, value: { body: "x".repeat(200) } }),
        candidate({ key: "z-swarm", scope: "swarm", updatedAt: 3, value: { body: "y".repeat(400) } }),
      ],
      limits: { maxEntries: 12, maxBytes: 300 },
    })
    expect(result.entries.map((entry) => entry.key)).toEqual(["a-task"])
    expect(result.omitted).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.bytes).toBeLessThanOrEqual(300)
  })

  test("counts an entry larger than the whole budget as omitted instead of emitting nothing", () => {
    const result = SwarmKnowledge.digest({
      candidates: [
        candidate({ key: "huge", scope: "task", updatedAt: 1, value: { body: "x".repeat(5_000) } }),
        candidate({ key: "small", scope: "task", updatedAt: 2 }),
      ],
      limits: { maxBytes: 200 },
    })
    expect(result.entries.map((entry) => entry.key)).toEqual(["small"])
    expect(result.omitted).toBe(1)
    expect(result.scanned).toBe(2)
  })

  test("clamps caller limits into the hard ceiling and falls back on unusable input", () => {
    const unbounded = SwarmKnowledge.resolveLimits({ maxEntries: 100_000, maxBytes: 1_000_000 })
    expect(unbounded).toEqual(SwarmKnowledge.MAX_LIMITS)
    expect(SwarmKnowledge.resolveLimits({ maxEntries: 0, maxBytes: -5 })).toEqual({
      maxEntries: 1,
      maxBytes: 1,
    })
    expect(SwarmKnowledge.resolveLimits({ maxEntries: Number.NaN })).toEqual(SwarmKnowledge.DEFAULT_LIMITS)
    expect(SwarmKnowledge.resolveLimits()).toEqual(SwarmKnowledge.DEFAULT_LIMITS)
  })

  test("charges provenance, not just the value, against the byte budget", () => {
    const lean = candidate({ key: "k", scope: "swarm", updatedAt: 1, value: { body: "abc" } })
    const fat = candidate({
      key: "k",
      scope: "swarm",
      updatedAt: 1,
      value: { body: "abc" },
      taskID: Swarm.TaskID.make("swt_1"),
    })
    expect(SwarmKnowledge.entryBytes(fat)).toBeGreaterThan(SwarmKnowledge.entryBytes(lean))
  })

  test("measures the candidate's real scope, not an assumed task scope", () => {
    const shaped = (scope: SwarmKnowledge.KnowledgeScope) =>
      candidate({ key: "k", scope, updatedAt: 1, value: { body: "abc" } })
    const bytes = (scope: SwarmKnowledge.KnowledgeScope) => SwarmKnowledge.entryBytes(shaped(scope))
    // Identical candidates differing only in scope must differ by exactly the
    // encoded scope label: "task" = 6, "swarm" = 7, "related" = 9 bytes.
    expect(bytes("related") - bytes("task")).toBe(3)
    expect(bytes("swarm") - bytes("task")).toBe(1)
  })

  test("charges the recency it reports, and reports exactly the bytes it charged", () => {
    const early = candidate({ key: "k", scope: "task", updatedAt: 1 })
    const late = candidate({ key: "k", scope: "task", updatedAt: 123_456_789 })
    expect(SwarmKnowledge.entryBytes(late)).toBeGreaterThan(SwarmKnowledge.entryBytes(early))
    const result = SwarmKnowledge.digest({ candidates: [early, late] })
    const admitted = result.entries[0]!
    expect(admitted.scope).toBe("task")
    expect(admitted.updatedAt).toBe(123_456_789)
    expect(admitted.bytes).toBe(SwarmKnowledge.entryBytes(late))
    expect(result.bytes).toBe(admitted.bytes + SwarmKnowledge.entryBytes(early))
  })

  test("reports storage row-cap truncation instead of presenting a capped read as complete", () => {
    const complete = SwarmKnowledge.digest({ candidates: [candidate({ key: "k", scope: "task", updatedAt: 1 })] })
    expect(complete.storageTruncated).toBe(false)
    expect(complete.truncated).toBe(false)

    const capped = SwarmKnowledge.digest({
      candidates: [candidate({ key: "k", scope: "task", updatedAt: 1 })],
      storageTruncated: true,
    })
    // `omitted` stays 0: the withheld rows were never candidates, so a count for
    // them would be a fabricated number rather than a measurement.
    expect(capped.omitted).toBe(0)
    expect(capped.storageTruncated).toBe(true)
    expect(capped.truncated).toBe(true)
  })

  test("reports dropped related tasks as an incomplete retrieval", () => {
    const result = SwarmKnowledge.digest({ candidates: [], droppedRelatedTasks: 3 })
    expect(result.droppedRelatedTasks).toBe(3)
    expect(result.truncated).toBe(true)
  })
})

describe("SwarmKnowledge.selectRelatedTasks", () => {
  const receiving = Swarm.TaskID.make("swt_receiving")

  test("excludes the receiving task and deduplicates while keeping declared order", () => {
    const a = Swarm.TaskID.make("swt_a")
    const b = Swarm.TaskID.make("swt_b")
    const selected = SwarmKnowledge.selectRelatedTasks(receiving, [a, b, a, receiving, b])
    expect(selected.tasks).toEqual([a, b])
    expect(selected.dropped).toBe(0)
  })

  test("bounds the IN (...) predicate and reports what it refused", () => {
    const many = Array.from({ length: SwarmKnowledge.MAX_RELATED_TASKS + 5 }, (_, index) =>
      Swarm.TaskID.make("swt_" + index),
    )
    const selected = SwarmKnowledge.selectRelatedTasks(receiving, many)
    expect(selected.tasks).toHaveLength(SwarmKnowledge.MAX_RELATED_TASKS)
    expect(selected.dropped).toBe(5)
    expect(selected.tasks[0]).toBe(many[0])
  })

  test("treats an absent related set as empty and still keeps ids without a receiver", () => {
    expect(SwarmKnowledge.selectRelatedTasks(undefined, undefined)).toEqual({ tasks: [], dropped: 0 })
    expect(SwarmKnowledge.selectRelatedTasks(undefined, [receiving]).tasks).toEqual([receiving])
  })
})

describe("Swarm.blackboardKnowledge", () => {
  it.effect("returns only swarm-wide, receiving-task, and declared-related knowledge with provenance", () =>
    Effect.gen(function* () {
      const { service, swarm, a, upstream, unrelated, receiver } = yield* setup

      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "constraint/global",
        value: { rule: "never force push" },
        contentType: "application/json",
        authorMemberID: a.id,
        now: 100,
      })
      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "finding/receiver",
        value: { finding: "receiver specific" },
        contentType: "application/json",
        authorMemberID: a.id,
        taskID: receiver.id,
        now: 101,
      })
      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "finding/upstream",
        value: { finding: "predecessor knowledge" },
        contentType: "application/json",
        authorMemberID: a.id,
        taskID: upstream.id,
        now: 102,
      })
      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "finding/unrelated",
        value: { finding: "must not leak" },
        contentType: "application/json",
        authorMemberID: a.id,
        taskID: unrelated.id,
        now: 103,
      })

      const digest = yield* service.blackboardKnowledge({
        swarmID: swarm.id,
        taskID: receiver.id,
        relatedTaskIDs: [upstream.id, receiver.id],
      })

      expect(digest.entries.map((entry) => entry.key)).toEqual([
        "finding/receiver",
        "finding/upstream",
        "constraint/global",
      ])
      expect(digest.entries.map((entry) => entry.scope)).toEqual(["task", "related", "swarm"])
      expect(digest.truncated).toBe(false)

      const taskScoped = digest.entries[0]!
      expect(taskScoped.taskID).toBe(receiver.id)
      expect(taskScoped.authorMemberID).toBe(a.id)
      expect(taskScoped.version).toBe(1)
      expect(taskScoped.updatedAt).toBe(101)
      expect(taskScoped.contentType).toBe("application/json")
      expect(taskScoped.value).toEqual({ finding: "receiver specific" })
      expect(taskScoped.bytes).toBeGreaterThan(0)
      expect(digest.bytes).toBe(digest.entries.reduce((total, entry) => total + entry.bytes, 0))

      // Undeclared task knowledge stays out of the handoff entirely.
      const withoutRelated = yield* service.blackboardKnowledge({
        swarmID: swarm.id,
        taskID: receiver.id,
      })
      expect(withoutRelated.entries.map((entry) => entry.key)).toEqual([
        "finding/receiver",
        "constraint/global",
      ])
    }),
  )

  it.effect("keeps task relevance ahead of recency and bounds bytes independently of Swarm volume", () =>
    Effect.gen(function* () {
      const { service, swarm, a, receiver } = yield* setup
      // Newest entries are swarm-wide noise; the receiving task's own knowledge must win.
      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "noise/newest",
        value: { body: "n".repeat(300) },
        contentType: "application/json",
        authorMemberID: a.id,
        now: 900,
      })
      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "noise/middle",
        value: { body: "n".repeat(300) },
        contentType: "application/json",
        authorMemberID: a.id,
        now: 800,
      })
      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "decision/receiver",
        value: { decision: "keep it" },
        contentType: "application/json",
        authorMemberID: a.id,
        taskID: receiver.id,
        now: 100,
      })

      const bounded = yield* service.blackboardKnowledge({
        swarmID: swarm.id,
        taskID: receiver.id,
        limits: { maxEntries: 12, maxBytes: 400 },
      })
      expect(bounded.entries.map((entry) => entry.key)).toEqual(["decision/receiver"])
      expect(bounded.truncated).toBe(true)
      expect(bounded.omitted).toBe(2)
      expect(bounded.bytes).toBeLessThanOrEqual(400)

      // Caller-supplied limits cannot uncap the projection.
      const uncapped = yield* service.blackboardKnowledge({
        swarmID: swarm.id,
        taskID: receiver.id,
        limits: { maxEntries: 1_000_000, maxBytes: 1_000_000 },
      })
      expect(uncapped.limits).toEqual(SwarmKnowledge.MAX_LIMITS)
      expect(uncapped.entries.map((entry) => entry.key)).toEqual([
        "decision/receiver",
        "noise/newest",
        "noise/middle",
      ])
    }),
  )

  it.effect("reports the current version of a superseded entry rather than every revision", () =>
    Effect.gen(function* () {
      const { service, swarm, a, receiver } = yield* setup
      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "decision/receiver",
        value: { decision: "v1" },
        contentType: "application/json",
        authorMemberID: a.id,
        taskID: receiver.id,
        now: 100,
      })
      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "decision/receiver",
        value: { decision: "v2" },
        contentType: "application/json",
        authorMemberID: a.id,
        taskID: receiver.id,
        expectedVersion: 1,
        now: 150,
      })

      const digest = yield* service.blackboardKnowledge({ swarmID: swarm.id, taskID: receiver.id })
      expect(digest.entries).toHaveLength(1)
      expect(digest.entries[0]!.version).toBe(2)
      expect(digest.entries[0]!.updatedAt).toBe(150)
      expect(digest.entries[0]!.value).toEqual({ decision: "v2" })
    }),
  )

  it.effect("stays inside the Swarm boundary and returns an empty digest for an untouched Swarm", () =>
    Effect.gen(function* () {
      const { service, swarm, receiver } = yield* setup
      const empty = yield* service.blackboardKnowledge({ swarmID: swarm.id, taskID: receiver.id })
      expect(empty.entries).toEqual([])
      expect(empty.bytes).toBe(0)
      expect(empty.truncated).toBe(false)
    }),
  )

  it.effect("bounds hydration with the SQL row cap and reports the cap instead of hiding it", () =>
    Effect.gen(function* () {
      const { db, service, swarm, a, receiver } = yield* setup
      const overflow = SwarmKnowledge.MAX_CANDIDATES + 5
      // Seeded straight into the durable table: the point of the test is the
      // read bound, and 500+ CAS writes would only prove the writer works.
      for (let offset = 0; offset < overflow; offset += 100) {
        yield* db
          .insert(SwarmBlackboardTable)
          .values(
            Array.from({ length: Math.min(100, overflow - offset) }, (_, index) => {
              const position = offset + index
              return {
                swarm_id: swarm.id,
                key: "bulk/" + String(position).padStart(4, "0"),
                value: { position },
                content_type: "application/json",
                version: 1,
                author_member_id: a.id,
                task_id: null,
                time_created: 1_000 + position,
                time_updated: 1_000 + position,
              }
            }),
          )
          .run()
          .pipe(Effect.orDie)
      }

      const digest = yield* service.blackboardKnowledge({ swarmID: swarm.id, taskID: receiver.id })
      // Hard SQL LIMIT: hydration never exceeds the cap however much the Swarm
      // has accumulated, and the withheld rows are reported, not inferred.
      expect(digest.scanned).toBe(SwarmKnowledge.MAX_CANDIDATES)
      expect(digest.scanned).toBeLessThan(overflow)
      expect(digest.storageTruncated).toBe(true)
      expect(digest.truncated).toBe(true)
      expect(digest.omitted).toBeGreaterThan(0)
      expect(digest.entries).toHaveLength(SwarmKnowledge.DEFAULT_LIMITS.maxEntries)
      expect(digest.bytes).toBeLessThanOrEqual(digest.limits.maxBytes)
      // Most recently updated knowledge survives the bounded window.
      expect(digest.entries[0]!.key).toBe("bulk/" + String(overflow - 1).padStart(4, "0"))
    }),
  )

  it.effect("reports related tasks refused by the bounded predicate", () =>
    Effect.gen(function* () {
      const { service, swarm, a, receiver, upstream } = yield* setup
      yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "finding/upstream",
        value: { finding: "predecessor knowledge" },
        contentType: "application/json",
        authorMemberID: a.id,
        taskID: upstream.id,
        now: 100,
      })
      const padding = Array.from({ length: SwarmKnowledge.MAX_RELATED_TASKS + 3 }, (_, index) =>
        Swarm.TaskID.make("swt_pad_" + index),
      )
      const digest = yield* service.blackboardKnowledge({
        swarmID: swarm.id,
        taskID: receiver.id,
        relatedTaskIDs: [upstream.id, ...padding],
      })
      // 1 upstream + MAX_RELATED_TASKS + 3 padding ids = 20 declared, 16 admitted.
      expect(digest.droppedRelatedTasks).toBe(4)
      expect(digest.truncated).toBe(true)
      // Declared order decides what survives the cap, so this is reproducible.
      expect(digest.entries.map((entry) => entry.key)).toEqual(["finding/upstream"])
      expect(digest.entries[0]!.scope).toBe("related")
    }),
  )
})
