export * as SwarmCommand from "./command"

import { Effect } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"

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
  readonly dependsOn?: ReadonlyArray<{
    readonly key: string
    readonly requirement?: Swarm.DependencyRequirement
  }>
}

export interface DelegateInput {
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

  const created = yield* service.create({
    projectID: input.projectID,
    ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    directory: input.directory,
    name: input.name,
  })
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
  for (const task of input.tasks ?? []) taskIDByKey.set(task.key.trim(), Swarm.TaskID.create())

  const tasks = new Map<string, Swarm.Task>()
  for (const task of input.tasks ?? []) {
    const key = task.key.trim()
    const reservedMember = task.reservedMemberName ? memberByName.get(task.reservedMemberName.trim()) : undefined
    const createdTask = yield* service.createTask({
      swarmID: created.id,
      id: taskIDByKey.get(key)!,
      title: task.title,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.priority === undefined ? {} : { priority: task.priority }),
      createdByMemberID: coordinator.id,
      ...(reservedMember === undefined ? {} : { reservedMemberID: reservedMember.id }),
      ...(task.acceptance === undefined ? {} : { acceptance: task.acceptance }),
      ...(task.metadata === undefined ? {} : { metadata: task.metadata }),
    })
    tasks.set(key, createdTask)
  }

  for (const task of input.tasks ?? []) {
    if (!task.dependsOn || task.dependsOn.length === 0) continue
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
