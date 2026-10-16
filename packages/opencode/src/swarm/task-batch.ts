export * as SwarmTaskBatch from "./task-batch"

import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { Swarm } from "@opencode-ai/schema/swarm"
import type { DelegateTask } from "./command"
import { SwarmTaskKey } from "./task-key"

export interface Receipt {
  readonly key: string
  readonly index: number
  readonly status: "created" | "satisfied" | "failed"
  readonly taskId?: Swarm.TaskID
  readonly reason?: string
}

function stableID(swarmID: Swarm.ID, key: string) {
  return SwarmTaskKey.id(swarmID, key)
}

function reason(error: unknown) {
  if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string")
    return error.reason
  return error instanceof Error ? error.message : String(error)
}

/**
 * Patch-style staged task admission. New tasks are committed one at a time in
 * topological order, each with all prerequisite edges inside the same insert
 * transaction. Stable per-Swarm keys permit safe replay after interruption.
 */
export const add = Effect.fn("SwarmTaskBatch.add")(function* (
  service: SwarmV2.Interface,
  input: {
    readonly swarmID: Swarm.ID
    readonly createdByMemberID: Swarm.MemberID
    readonly tasks: readonly DelegateTask[]
    readonly beforeWrite?: () => Effect.Effect<void, unknown>
  },
) {
  const detail = yield* service.get(input.swarmID)
  if (!["active", "paused"].includes(detail.swarm.status))
    return yield* new SwarmV2.SwarmSchema.ValidationError({ reason: "Swarm must be active or paused to admit tasks." })
  const memberByName = new Map(detail.members.filter((m) => m.kind === "managed_worker").map((m) => [m.name, m]))
  const existing = new Map(detail.tasks.map((t) => [t.id, t]))
  const entries = new Map<string, { task: DelegateTask; index: number; id: Swarm.TaskID }>()
  const receipts = new Map<number, Receipt>()
  const fail = (index: number, key: string, message: string) =>
    receipts.set(index, { index, key, status: "failed", reason: message })

  for (const [index, task] of input.tasks.entries()) {
    const key = task.key.trim()
    if (!key) fail(index, task.key, "Stable task key is required.")
    else if (entries.has(key)) fail(index, key, "Duplicate task key within this request.")
    else if (!task.title.trim()) fail(index, key, "Task title is required.")
    else if (task.reservedMemberName !== undefined && !memberByName.has(task.reservedMemberName.trim()))
      fail(index, key, "Unknown managed worker: " + task.reservedMemberName)
    else if (task.attachments?.length)
      fail(index, key, "Attachment handles require initial delegate with an authorized coordinator manifest.")
    else entries.set(key, { task, index, id: stableID(input.swarmID, key) })
  }

  const deps = new Map<string, { key: string; requirement: Swarm.DependencyRequirement }[]>()
  const reverse = new Map([...entries.keys()].map((key) => [key, [] as string[]]))
  const degrees = new Map([...entries.keys()].map((key) => [key, 0]))
  for (const [key, entry] of entries) {
    const list = (entry.task.dependsOn ?? []).map((d) => ({
      key: d.key.trim(), requirement: d.requirement ?? "require_success" as const,
    }))
    deps.set(key, list)
    const seen = new Set<string>()
    for (const dep of list) {
      if (dep.key === key || seen.has(dep.key)) {
        fail(entry.index, key, dep.key === key ? "Self dependency." : "Duplicate dependency: " + dep.key)
        break
      }
      seen.add(dep.key)
      if (!entries.has(dep.key) && !existing.has(stableID(input.swarmID, dep.key))) {
        fail(entry.index, key, "Unknown staged prerequisite: " + dep.key)
        break
      }
    }
    for (const dep of list) {
      if (!entries.has(dep.key)) continue
      degrees.set(key, degrees.get(key)! + 1)
      reverse.get(dep.key)!.push(key)
    }
  }

  // Kahn O(V+E). Everything not visited is a cycle or downstream of one.
  const ready = [...degrees].filter(([, degree]) => degree === 0).map(([key]) => key)
  for (let i = 0; i < ready.length; i++) {
    for (const dependent of reverse.get(ready[i]!) ?? []) {
      const degree = degrees.get(dependent)! - 1
      degrees.set(dependent, degree)
      if (degree === 0) ready.push(dependent)
    }
  }
  const reachable = new Set(ready)
  for (const [key, entry] of entries)
    if (!reachable.has(key)) fail(entry.index, key, "Cycle or dependency on a cycle.")

  const matches = Effect.fn("SwarmTaskBatch.matches")(function* (task: Swarm.Task, key: string) {
    const requested = entries.get(key)!.task
    const actual = yield* service.dependencies(task.id)
    const expected = (deps.get(key) ?? []).map((d) => ({
      dependsOnTaskID: stableID(input.swarmID, d.key), requirement: d.requirement,
    }))
    const byID = (a: { dependsOnTaskID: string }, b: { dependsOnTaskID: string }) =>
      a.dependsOnTaskID.localeCompare(b.dependsOnTaskID)
    return task.title === requested.title.trim() &&
      (task.description ?? "") === (requested.description?.trim() ?? "") &&
      task.priority === (requested.priority ?? 0) &&
      task.createdByMemberID === input.createdByMemberID &&
      task.reservedMemberID === (requested.reservedMemberName ? memberByName.get(requested.reservedMemberName.trim())?.id : undefined) &&
      isDeepStrictEqual(task.acceptance, requested.acceptance ?? { criteria: [] }) &&
      isDeepStrictEqual(task.metadata, requested.metadata ?? {}) &&
      isDeepStrictEqual(
        actual.map((d) => ({ dependsOnTaskID: d.dependsOnTaskID, requirement: d.requirement })).sort(byID),
        expected.sort(byID),
      )
  })

  for (const key of ready) {
    const entry = entries.get(key)!
    if (receipts.has(entry.index)) continue
    const rejected = (deps.get(key) ?? []).find((d) =>
      entries.has(d.key) && receipts.get(entries.get(d.key)!.index)?.status === "failed")
    if (rejected) {
      fail(entry.index, key, "Prerequisite was rejected: " + rejected.key)
      continue
    }
    const prior = existing.get(entry.id)
    if (prior) {
      receipts.set(entry.index, (yield* matches(prior, key))
        ? { key, index: entry.index, status: "satisfied", taskId: entry.id }
        : { key, index: entry.index, status: "failed", taskId: entry.id, reason: "Stable task key already exists with different intent." })
      continue
    }
    if (input.beforeWrite) yield* input.beforeWrite()
    const task = entry.task
    const attempted = yield* service.createTask({
      swarmID: input.swarmID, id: entry.id,
      allowedStatuses: ["active", "paused"],
      title: task.title,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.priority === undefined ? {} : { priority: task.priority }),
      createdByMemberID: input.createdByMemberID,
      ...(task.reservedMemberName === undefined ? {} : { reservedMemberID: memberByName.get(task.reservedMemberName.trim())!.id }),
      ...(task.acceptance === undefined ? {} : { acceptance: task.acceptance }),
      ...(task.metadata === undefined ? {} : { metadata: task.metadata }),
      dependencies: (deps.get(key) ?? []).map((d) => ({ taskID: stableID(input.swarmID, d.key), requirement: d.requirement })),
    }).pipe(
      Effect.map((created) => ({ ok: true as const, created })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    )
    if (attempted.ok) {
      existing.set(entry.id, attempted.created)
      receipts.set(entry.index, { key, index: entry.index, status: "created", taskId: entry.id })
      continue
    }
    const refreshed = yield* service.get(input.swarmID)
    const concurrent = refreshed.tasks.find((task) => task.id === entry.id)
    if (concurrent) existing.set(entry.id, concurrent)
    receipts.set(entry.index, concurrent && (yield* matches(concurrent, key))
      ? { key, index: entry.index, status: "satisfied", taskId: entry.id }
      : { key, index: entry.index, status: "failed", reason: reason(attempted.error) })
    if (!["active", "paused"].includes(refreshed.swarm.status)) {
      for (const [otherKey, other] of entries)
        if (!receipts.has(other.index))
          fail(other.index, otherKey, "Swarm is " + refreshed.swarm.status + "; no further task admission.")
      break
    }
  }

  const ordered = input.tasks.map((task, index) =>
    receipts.get(index) ?? { key: task.key.trim(), index, status: "failed" as const, reason: "Prerequisite was rejected." })
  return {
    swarmId: input.swarmID, receipts: ordered,
    created: ordered.filter((r) => r.status === "created").length,
    satisfied: ordered.filter((r) => r.status === "satisfied").length,
    failed: ordered.filter((r) => r.status === "failed").length,
  }
})
