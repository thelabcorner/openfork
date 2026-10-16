export * as SwarmCommand from "./command"

import { Effect } from "effect"
import { isDeepStrictEqual } from "node:util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import { SwarmTaskKey } from "./task-key"
import { SwarmCreationKey } from "./creation-key"

export interface DelegateMember {
  readonly name: string
  readonly role: string
  readonly desiredProfile: Swarm.MemberExecutionProfile
  readonly workspacePolicy: Swarm.WorkspacePolicy
  readonly capabilities?: Swarm.MemberCapabilities
}

export interface DelegateTask {
  /** Stable request-local handle used only to wire dependencies. */
  readonly key: string
  readonly title: string
  readonly description?: string
  readonly priority?: number
  readonly reservedMemberName?: string
  readonly acceptance?: Swarm.TaskAcceptance
  readonly metadata?: Record<string, unknown>
  /** Selected symbolic attachment handles to deliver to the assigned member. */
  readonly attachments?: ReadonlyArray<string>
  readonly dependsOn?: ReadonlyArray<{
    readonly key: string
    readonly requirement?: Swarm.DependencyRequirement
  }>
}

export interface DelegateInput {
  /** Optional caller-chosen stable idempotency key scoped to the coordinator principal. */
  readonly requestKey?: string
  readonly projectID: ProjectV2.ID
  readonly workspaceID?: WorkspaceV2.ID
  readonly directory: string
  /**
   * Native Session coordinators bind here. External protocol coordinators are
   * deliberately allowed to remain unbound; their durable principal identity
   * belongs in coordinatorCapabilities instead of a fabricated Session.
   */
  readonly coordinatorSessionID?: SessionV2.ID
  readonly coordinatorCapabilities?: Swarm.MemberCapabilities
  readonly name: string
  readonly coordinatorName?: string
  readonly coordinatorRole?: string
  readonly members?: readonly DelegateMember[]
  readonly tasks?: readonly DelegateTask[]
  /**
   * Trusted adapter-owned authorization callback, immediately before EACH
   * durable mutation. A declined/revoked grant must stop the invocation, not
    * return an ordinary partial-admission failure and continue writing.
    */
  readonly beforeWrite?: () => Effect.Effect<void, SwarmV2.SwarmSchema.Error>
}

export interface DelegateResult {
  readonly swarm: Swarm.Info
  readonly coordinator: Swarm.Member
  readonly members: readonly Swarm.Member[]
  readonly tasks: readonly Swarm.Task[]
}

function invalid(reason: string) {
  return new SwarmV2.SwarmSchema.ValidationError({ reason })
}

const validate = Effect.fn("SwarmCommand.validateDelegate")(function* (input: DelegateInput) {
  if (input.requestKey !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.requestKey))
      return yield* invalid("requestKey must be 1-128 ASCII letters/digits/._:- characters, starting with a letter or digit.")
    if (!input.coordinatorSessionID &&
      !input.coordinatorCapabilities?.tags?.some((tag) => tag.startsWith("oxp:connector:")))
      return yield* invalid("requestKey requires a trusted coordinator Session or connector-owned principal.")
  }
  const coordinatorName = input.coordinatorName?.trim() || "coordinator"
  const members = [...(input.members ?? [])]
  const tasks = [...(input.tasks ?? [])]

  const names = new Set<string>([coordinatorName])
  const managedNames = new Set<string>()
  for (const member of members) {
    const name = member.name.trim()
    if (!name) return yield* invalid("Managed member name is required.")
    if (!member.role.trim()) return yield* invalid(`Managed member role is required: ${name}`)
    if (names.has(name)) return yield* invalid(`Duplicate Swarm member name: ${name}`)
    names.add(name)
    managedNames.add(name)
  }

  const keys = new Set<string>()
  for (const task of tasks) {
    const key = task.key.trim()
    if (!key) return yield* invalid("Delegated task key is required.")
    if (!task.title.trim()) return yield* invalid(`Delegated task title is required: ${key}`)
    if (keys.has(key)) return yield* invalid(`Duplicate delegated task key: ${key}`)
    keys.add(key)
  }

  const edges = new Map<string, string[]>()
  for (const task of tasks) {
    if (task.reservedMemberName !== undefined && !managedNames.has(task.reservedMemberName.trim()))
      return yield* invalid(`Unknown reserved member: ${task.reservedMemberName}`)
    const dependencies: string[] = []
    const seenDependencies = new Set<string>()
    for (const dependency of task.dependsOn ?? []) {
      const key = dependency.key.trim()
      if (!keys.has(key)) return yield* invalid(`Unknown task dependency key: ${dependency.key}`)
      if (key === task.key.trim()) return yield* invalid(`Task ${task.key} cannot depend on itself.`)
      if (seenDependencies.has(key))
        return yield* invalid(`Task ${task.key} contains duplicate dependency: ${dependency.key}`)
      seenDependencies.add(key)
      dependencies.push(key)
    }
    edges.set(task.key.trim(), dependencies)
  }

  // Kahn's algorithm gives one bounded O(V+E) preflight so no dependency cycle
  // can strand an otherwise valid Swarm midway through durable setup.
  const indegree = new Map<string, number>([...keys].map((key) => [key, 0]))
  const dependents = new Map([...keys].map((key) => [key, [] as string[]] as const))
  for (const [task, dependencies] of edges) {
    indegree.set(task, dependencies.length)
    for (const dependency of dependencies) dependents.get(dependency)!.push(task)
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([key]) => key)
  let visited = 0
  for (let index = 0; index < ready.length; index++) {
    const current = ready[index]!
    visited++
    for (const dependent of dependents.get(current) ?? []) {
      const next = indegree.get(dependent)! - 1
      indegree.set(dependent, next)
      if (next === 0) ready.push(dependent)
    }
  }
  if (visited !== keys.size) return yield* invalid("Delegated task dependencies contain a cycle.")
})

/**
 * Managed members must be runnable before a single durable Swarm row exists.
 *
 * Without this, `create` commits a `creating` Swarm and the coordinator/member
 * rows before agent, provider/model/account, variant, or model-requirement
 * resolution is ever attempted. The first durable artifact of an invalid
 * request is therefore a permanently stranded Swarm with zero task runs.
 *
 * The check itself is owned by SwarmProfilePreflight, which the managed-member
 * materialization path also uses; this only orders it ahead of the first write.
 */
const preflightProfiles = Effect.fn("SwarmCommand.preflightProfiles")(function* (
  preflight: SwarmProfilePreflight.Interface,
  input: DelegateInput,
) {
  for (const member of input.members ?? []) {
    yield* preflight.check({ directory: input.directory, profile: member.desiredProfile })
  }
})

/**
 * Fail-closed high-level Swarm creation workflow.
 *
 * EventV2 deliberately has no multi-event batch publish. The durable
 * `creating` status is therefore the transaction boundary between incomplete
 * setup and runnable work: member Session materialization and scheduling both
 * require `active`. Every avoidable cross-reference error — names, task keys,
 * reservations, dependency cycles, and each managed member's runnable execution
 * profile — is validated before the first write, and activation is the final
 * exact-revision mutation.
 */
export const delegate = Effect.fn("SwarmCommand.delegate")(function* (
  service: SwarmV2.Interface,
  preflight: SwarmProfilePreflight.Interface,
  input: DelegateInput,
) {
  yield* validate(input)
  yield* preflightProfiles(preflight, input)

  // The coordinator binding is deterministic authority input, not setup state.
  // Prove it before the first Swarm write so producer-owned/child/cross-scope
  // callers cannot strand an empty `creating` aggregate. addMember re-runs the
  // same Core validator transactionally, so a concurrent Session change still
  // fails closed; abandoned-creating recovery remains the crash/race fallback.
  if (input.coordinatorSessionID !== undefined)
    yield* service.preflightMemberSession({
      projectID: input.projectID,
      ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
      sessionID: input.coordinatorSessionID,
    })

  if (input.beforeWrite) yield* input.beforeWrite()
  const created = yield* service.create({
    ...(input.requestKey === undefined ? {} : { id: SwarmCreationKey.id(input) }),
    projectID: input.projectID,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    directory: input.directory,
    name: input.name,
  })
  if (input.beforeWrite) yield* input.beforeWrite()
  const coordinator = yield* service.addMember({
    swarmID: created.id,
    name: input.coordinatorName?.trim() || "coordinator",
    kind: "coordinator",
    role: input.coordinatorRole?.trim() || "coordinator",
    ...(input.coordinatorSessionID === undefined ? {} : { sessionID: input.coordinatorSessionID }),
    workspacePolicy: { mode: "shared-read" },
    ...(input.coordinatorCapabilities === undefined ? {} : { capabilities: input.coordinatorCapabilities }),
  })

  const members: Swarm.Member[] = []
  const memberByName = new Map<string, Swarm.Member>([[coordinator.name, coordinator]])
  for (const member of input.members ?? []) {
    if (input.beforeWrite) yield* input.beforeWrite()
    const createdMember = yield* service.addMember({
      swarmID: created.id,
      name: member.name,
      kind: "managed_worker",
      role: member.role,
      desiredProfile: member.desiredProfile,
      workspacePolicy: member.workspacePolicy,
      ...(member.capabilities === undefined ? {} : { capabilities: member.capabilities }),
    })
    members.push(createdMember)
    memberByName.set(createdMember.name, createdMember)
  }

  const taskIDByKey = new Map<string, Swarm.TaskID>()
  for (const task of input.tasks ?? []) taskIDByKey.set(task.key.trim(), SwarmTaskKey.id(created.id, task.key))

  const tasks = new Map<string, Swarm.Task>()
  for (const task of input.tasks ?? []) {
    if (input.beforeWrite) yield* input.beforeWrite()
    const key = task.key.trim()
    const reservedMember = task.reservedMemberName ? memberByName.get(task.reservedMemberName.trim()) : undefined
    // Snapshot the coordinator's explicit attachment selection onto the durable
    // task. The assigned member's session-input ID makes delivery idempotent;
    // handles are resolved (and grants bound to the exact run/member session)
    // only at admission, never here.
    const taskMetadata =
      task.attachments && task.attachments.length > 0
        ? {
            ...(task.metadata ?? {}),
            attachments: {
              sourceSessionID: input.coordinatorSessionID ?? null,
              handles: [...task.attachments],
            },
          }
        : task.metadata
    const createdTask = yield* service.createTask({
      swarmID: created.id,
      id: taskIDByKey.get(key)!,
      title: task.title,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.priority === undefined ? {} : { priority: task.priority }),
      createdByMemberID: coordinator.id,
      ...(reservedMember === undefined ? {} : { reservedMemberID: reservedMember.id }),
      ...(task.acceptance === undefined ? {} : { acceptance: task.acceptance }),
      ...(taskMetadata === undefined ? {} : { metadata: taskMetadata }),
    })
    tasks.set(key, createdTask)
  }

  for (const task of input.tasks ?? []) {
    if (!task.dependsOn || task.dependsOn.length === 0) continue
    if (input.beforeWrite) yield* input.beforeWrite()
    const key = task.key.trim()
    const updated = yield* service.setTaskDependencies({
      swarmID: created.id,
      taskID: taskIDByKey.get(key)!,
      dependencies: task.dependsOn.map((dependency) => ({
        taskID: taskIDByKey.get(dependency.key.trim())!,
        ...(dependency.requirement === undefined ? {} : { requirement: dependency.requirement }),
      })),
    })
    tasks.set(key, updated)
  }

  if (input.beforeWrite) yield* input.beforeWrite()
  const active = yield* service.update({
    id: created.id,
    expectedRevision: created.revision,
    coordinatorMemberID: coordinator.id,
    status: "active",
  })
  return {
    swarm: active,
    coordinator,
    members,
    tasks: [...tasks.values()],
  } satisfies DelegateResult
})

/** A failed independent admission is data, not a reason to replay successful work. */
export interface AdmissionFailure {
  readonly kind: "member" | "task"
  readonly key: string
  /** Zero-based position in the original array; disambiguates duplicate names. */
  readonly index?: number
  readonly reason: string
}

export interface AdmissionReceipt {
  readonly key: string
  readonly index: number
  readonly status: "created" | "satisfied" | "failed"
  readonly memberId?: Swarm.MemberID
  readonly reason?: string
}

function message(error: unknown): string {
  if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string")
    return error.reason
  return error instanceof Error ? error.message : String(error)
}

/**
 * Patch-style initial admission. One invalid profile, duplicate name, broken
 * reservation, or cyclic task component cannot discard independent valid work.
 * The surviving DAG is still passed to delegate(), which constructs it behind
 * the existing creating -> active fence. No task can run with half its edges.
 */
export const delegatePartial = Effect.fn("SwarmCommand.delegatePartial")(function* (
  service: SwarmV2.Interface,
  preflight: SwarmProfilePreflight.Interface,
  input: DelegateInput,
) {
  const failures: AdmissionFailure[] = []
  const members: DelegateMember[] = []
  const seen = new Set([input.coordinatorName?.trim() || "coordinator"])
  // A team commonly chooses the SAME provider/model/permission profile for
  // several independent workers. Checking that profile N times (and again
  // inside delegate) pays for redundant catalog/account resolution. Group
  // *exact JSON-equivalent* provider-visible profiles first, then resolve each
  // distinct profile once with bounded parallelism. Invalid/duplicate roster
  // names are still accounted for in original input order below.
  //
  // Durable admission remains sequential and creating -> active fenced.
  // The cache is invocation-local and never reused for future worker wakeups.
  const profiles = new WeakMap<object, SwarmProfilePreflight.Resolved>()
  const requested = input.members ?? []
  const fingerprints = requested.map((member) =>
    member.name.trim() && member.role.trim() ? JSON.stringify(member.desiredProfile) : undefined)
  const unique = new Map<string, { member: DelegateMember; firstIndex: number }>()
  for (const [index, member] of requested.entries()) {
    const key = fingerprints[index]
    if (key !== undefined && !unique.has(key)) unique.set(key, { member, firstIndex: index })
  }
  const evaluated = yield* Effect.forEach([...unique.entries()], ([key, { member }]) =>
    preflight.check({ directory: input.directory, profile: member.desiredProfile }).pipe(
      Effect.map((resolved) => ({ key, ok: true as const, resolved })),
      Effect.catch((error) => Effect.succeed({ key, ok: false as const, error })),
    ), { concurrency: 4 })
  const byProfile = new Map(evaluated.map((item) => [item.key, item]))
  // Cache only SUCCESS. A temporarily unavailable provider can fail the first
  // worker then recover for an identical sibling. Sharing a negative result
  // would violate the partial-admission contract by discarding that sibling.
  const attempts = yield* Effect.forEach(requested, (member, index) => Effect.gen(function* () {
    const key = fingerprints[index]
    if (key === undefined) return { ok: false as const, error: invalid("Member name and role are required.") }
    const checked = byProfile.get(key)!
    if (checked.ok || unique.get(key)!.firstIndex === index) return checked
    return yield* preflight.check({ directory: input.directory, profile: member.desiredProfile }).pipe(
      Effect.map((resolved) => ({ key, ok: true as const, resolved })),
      Effect.catch((error) => Effect.succeed({ key, ok: false as const, error })),
    )
  }), { concurrency: 4 })
  for (const [index, member] of requested.entries()) {
    const checked = attempts[index]!
    if (checked.ok) profiles.set(member.desiredProfile, checked.resolved)
  }
  for (const [index, member] of requested.entries()) {
    const name = member.name.trim()
    const checked = attempts[index]!
    let reason: string | undefined
    if (!name) reason = "Member name is required."
    else if (!member.role.trim()) reason = "Member role is required."
    else if (seen.has(name)) reason = "Duplicate member name: " + name
    if (!reason && !checked.ok) reason = message(checked.error)
    if (reason) failures.push({ kind: "member", key: name || member.name, index, reason })
    else {
      seen.add(name)
      members.push(member)
    }
  }

  // Preserve the first task key and reject later duplicates independently.
  const tasks = new Map<string, DelegateTask>()
  const rejectedTasks = new Set<string>()
  const liveNames = new Set(members.map((member) => member.name.trim()))
  const taskIndices = new Map<string, number>()
  for (const [index, task] of (input.tasks ?? []).entries()) {
    const key = task.key.trim()
    let reason: string | undefined
    if (!key) reason = "Task key is required."
    else if (!task.title.trim()) reason = "Task title is required."
    else if (tasks.has(key)) reason = "Duplicate task key: " + key
    else if (task.reservedMemberName && !liveNames.has(task.reservedMemberName.trim()))
      reason = "Reserved managed member was not admitted: " + task.reservedMemberName
    if (reason) failures.push({ kind: "task", key: key || task.key, index, reason })
    else {
      tasks.set(key, task)
      taskIndices.set(key, index)
    }
  }
  // Reject missing, duplicated and self-edges. Cascade a rejected dependency
  // only to its dependents; unrelated tasks remain admissible.
  for (const [key, task] of tasks) {
    const deps = new Set<string>()
    for (const dependency of task.dependsOn ?? []) {
      const dep = dependency.key.trim()
      const reason = dep === key
        ? "Self dependency: " + dep
        : deps.has(dep)
          ? "Duplicate dependency: " + dep
          : !tasks.has(dep)
            ? "Unknown dependency: " + dep
            : undefined
      if (reason) {
        failures.push({ kind: "task", key, index: taskIndices.get(key), reason })
        rejectedTasks.add(key)
        break
      }
      deps.add(dep)
    }
  }
  // Build one reverse adjacency index and propagate invalid prerequisites in
  // O(tasks + edges), rather than rescanning the entire graph for each level.
  const dependents = new Map([...tasks.keys()].map((key) => [key, [] as string[]]))
  for (const [key, task] of tasks)
    for (const dep of task.dependsOn ?? []) dependents.get(dep.key.trim())?.push(key)
  const rejectedQueue = [...rejectedTasks]
  for (let i = 0; i < rejectedQueue.length; i++) {
    const key = rejectedQueue[i]!
    for (const dependent of dependents.get(key) ?? []) {
      if (rejectedTasks.has(dependent)) continue
      rejectedTasks.add(dependent)
      failures.push({ kind: "task", key: dependent, index: taskIndices.get(dependent), reason: "Dependency was rejected: " + key })
      rejectedQueue.push(dependent)
    }
  }
  // Kahn's algorithm identifies every node stranded downstream of a cycle.
  const remaining = [...tasks].filter(([key]) => !rejectedTasks.has(key))
  const inDegree = new Map(remaining.map(([key, task]) => [key, (task.dependsOn ?? []).length]))
  const queue = [...inDegree].filter(([, degree]) => degree === 0).map(([key]) => key)
  for (let i = 0; i < queue.length; i++) {
    for (const dependent of dependents.get(queue[i]!) ?? []) {
      const previous = inDegree.get(dependent)
      if (previous === undefined) continue
      const next = previous - 1
      inDegree.set(dependent, next)
      if (next === 0) queue.push(dependent)
    }
  }
  const viable = new Set(queue)
  for (const [key] of remaining) {
    if (viable.has(key)) continue
    failures.push({ kind: "task", key, index: taskIndices.get(key), reason: "Dependency cycle or dependency on a cycle." })
  }

  const scopedPreflight: SwarmProfilePreflight.Interface = {
    check: (request) => {
      const resolved = request.directory === input.directory ? profiles.get(request.profile) : undefined
      return resolved === undefined ? preflight.check(request) : Effect.succeed(resolved)
    },
  }
  const result = yield* delegate(service, scopedPreflight, {
    ...input,
    members,
    tasks: [...tasks].filter(([key]) => viable.has(key)).map(([, task]) => task),
  })
  return {
    ...result,
    admission: {
      acceptedMembers: members.map((member) => member.name.trim()),
      acceptedTasks: [...tasks.keys()].filter((key) => viable.has(key)),
      failures,
      complete: failures.length === 0,
    },
  }
})

function matchingMember(found: Swarm.Member, candidate: DelegateMember): boolean {
  return found.kind === "managed_worker" &&
    found.role === candidate.role.trim() &&
    isDeepStrictEqual(found.desiredProfile, candidate.desiredProfile) &&
    isDeepStrictEqual(found.workspacePolicy, candidate.workspacePolicy) &&
    isDeepStrictEqual(found.capabilities, candidate.capabilities)
}

function matchingReceipt(found: Swarm.Member, candidate: DelegateMember, index: number): AdmissionReceipt {
  const key = candidate.name.trim()
  const same = matchingMember(found, candidate)
  if (same && found.lifecycle === "active")
    return { key, index, status: "satisfied", memberId: found.id }
  return {
    key, index, status: "failed", memberId: found.id,
    reason: same
      ? `Member exists but is ${found.lifecycle}; use member.resume after verifying its current state.`
      : "Name already exists with a different role, profile, workspace, or capabilities.",
  }
}

/**
 * Incremental admission to an existing Swarm. One caller grant covers the
 * batch; the enclosing adapter must authenticate the coordinator first.
 * beforeWrite revalidates external authority immediately before each commit.
 * Do not catch defects, interruption, cancellation, or authorization failure.
 */
export const addMembersPartial = Effect.fn("SwarmCommand.addMembersPartial")(function* (
  service: SwarmV2.Interface,
  preflight: SwarmProfilePreflight.Interface,
  input: {
    readonly swarmID: Swarm.ID
    readonly members: readonly DelegateMember[]
    readonly beforeWrite?: () => Effect.Effect<void, unknown>
  },
) {
  const detail = yield* service.get(input.swarmID)
  if (detail.swarm.status !== "active" && detail.swarm.status !== "paused")
    return yield* invalid("Swarm must be active or paused to admit members.")
  const existing = new Map(detail.members.map((member) => [member.name, member]))
  const receipts: AdmissionReceipt[] = []
  // No speculative preflights past an external authority revocation: staged
  // admission writes are deliberately serial. Reuse only successful, exact
  // within-invocation profile checks across distinct worker roster names.
  const verifiedProfiles = new Set<string>()
  for (const [index, candidate] of input.members.entries()) {
    const name = candidate.name.trim()
    if (!name || !candidate.role.trim()) {
      receipts.push({ key: name || candidate.name, index, status: "failed", reason: "Member name and role are required." })
      continue
    }
    const found = existing.get(name)
    if (found) {
      receipts.push(matchingReceipt(found, candidate, index))
      continue
    }
    const fingerprint = JSON.stringify(candidate.desiredProfile)
    const checked = verifiedProfiles.has(fingerprint)
      ? { ok: true as const }
      : yield* preflight.check({
          directory: detail.swarm.directory,
          profile: candidate.desiredProfile,
        }).pipe(
          Effect.map(() => ({ ok: true as const })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        )
    if (!checked.ok) {
      receipts.push({ key: name, index, status: "failed", reason: message(checked.error) })
      continue
    }
    verifiedProfiles.add(fingerprint)
    if (input.beforeWrite) yield* input.beforeWrite()
    const added = yield* service.addMember({
      swarmID: input.swarmID,
      allowedStatuses: ["active", "paused"],
      name,
      kind: "managed_worker",
      role: candidate.role.trim(),
      desiredProfile: candidate.desiredProfile,
      workspacePolicy: candidate.workspacePolicy,
      ...(candidate.capabilities === undefined ? {} : { capabilities: candidate.capabilities }),
    }).pipe(
      Effect.map((member) => ({ ok: true as const, member })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    )
    if (!added.ok) {
      // Re-read after a concurrent writer: a following member must see the
      // actual durable roster, never an optimistic local guess. A concurrent
      // identical insert can be SATISFIED instead of spuriously FAILED.
      const refreshed = yield* service.get(input.swarmID)
      const concurrent = refreshed.members.find((member) => member.name === name)
      receipts.push(concurrent
        ? matchingReceipt(concurrent, candidate, index)
        : { key: name, index, status: "failed", reason: message(added.error) })
      existing.clear()
      for (const member of refreshed.members) existing.set(member.name, member)
      if (refreshed.swarm.status !== "active" && refreshed.swarm.status !== "paused") {
        // The lifecycle fence failed while building this stage. Return the
        // committed receipts and mark remaining entries without futile
        // preflights, further writes, or a swallowed authorization exception.
        for (let next = index + 1; next < input.members.length; next++)
          receipts.push({
            key: input.members[next]!.name.trim(),
            index: next,
            status: "failed",
            reason: `Swarm is ${refreshed.swarm.status}; it no longer accepts members.`,
          })
        break
      }
      continue
    }
    existing.set(name, added.member)
    receipts.push({ key: name, index, status: "created", memberId: added.member.id })
  }
  return {
    swarmId: input.swarmID,
    receipts,
    created: receipts.filter((receipt) => receipt.status === "created").length,
    satisfied: receipts.filter((receipt) => receipt.status === "satisfied").length,
    failed: receipts.filter((receipt) => receipt.status === "failed").length,
  }
})
