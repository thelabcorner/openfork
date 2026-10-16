import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { SessionV2 } from "@opencode-ai/core/session"
import type { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSchema } from "@opencode-ai/core/swarm/schema"
import { Swarm as SwarmModel } from "@opencode-ai/schema/swarm"
import { InstanceState } from "@/effect/instance-state"
import { SwarmCommand } from "@/swarm/command"
import { SwarmTaskBatch } from "@/swarm/task-batch"
import { SwarmCreationKey } from "@/swarm/creation-key"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import { Parameters as NativeParameters } from "@/tool/swarm"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpRuntimeV1 } from "./runtime-v1"
import { OxpSchema } from "./schema"
import { OxpSupervision } from "./supervision"

const SessionIDInput = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({ description: "Approved root containing the Swarm." }),
  sessionID: Schema.optional(SessionIDInput).annotate({
    description: "Existing supervised worker Session required only for task.settle.",
  }),
  ...NativeParameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpSwarm") {}
export const use = serviceUse(Service)

const READ_ACTIONS = new Set<Input["action"]>([
  "list",
  "creation.lookup",
  "get",
  "summary",
  "task.runs",
  "message.list",
  "blackboard.get",
  "claim.list",
  "deliverable.list",
  "recover.effects",
])

function required(value: string | undefined, name: string) {
  const normalized = value?.trim()
  if (!normalized) throw new Error(name + " is required")
  return normalized
}

function contained(base: string, target: string) {
  const rel = path.relative(base, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function executionError(error: unknown, rootPath: string, virtualRoot: string, signal?: AbortSignal): OxpError.Error {
  if (signal?.aborted) return new OxpError.Cancelled({ detail: "OXP Swarm operation was cancelled" })
  if (OxpError.isError(error)) return error
  const raw = error instanceof Error ? error.message : "OpenFork Swarm operation failed"
  const detail = raw.split(rootPath).join(virtualRoot)
  const tag =
    error && typeof error === "object" && "_tag" in error && typeof (error as { _tag?: unknown })._tag === "string"
      ? (error as { _tag: string })._tag
      : undefined
  if (tag === "Swarm.NotFoundError" || /not found|does not exist/i.test(detail))
    return new OxpError.NotFound({ detail })
  if (
    tag === "Swarm.ConflictError" ||
    tag === "Swarm.StaleRevisionError" ||
    tag === "Swarm.StaleFenceError" ||
    tag === "Swarm.InvalidTransitionError" ||
    /conflict|stale|already exists/i.test(detail)
  )
    return new OxpError.Conflict({ detail })
  return new OxpError.InvalidArgument({ detail })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service
    const supervision = yield* OxpSupervision.Service

    const executeRaw = Effect.fn("OxpSwarm.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP Swarm operation was cancelled" })
      // Native force is a separately approved Session permission. An external
      // connector neither owns that Session principal nor inherits its grants.
      // Reject the parameters explicitly rather than silently ignoring them.
      if (input.force !== undefined || input.sourceSwarmId !== undefined)
        return yield* new OxpError.InvalidArgument({
          detail: "force/sourceSwarmId are native Session-only privileges; OXP Swarm uses connector-owned coordinator authority.",
        })
      // admin.* recovery exists for the local operator when no coordinator
      // Session can act. An OXP connector-owned coordinator already holds the
      // stronger coordinator authority, so it uses recover.* and never needs
      // (or gets) the operator-permission shortcut.
      if (input.action.startsWith("admin."))
        return yield* new OxpError.InvalidArgument({
          detail:
            "admin.* recovery actions are local-operator surfaces. An OXP connector-owned coordinator uses recover.effects, recover.contain, recover.session, and task.review instead.",
        })
      const readOnly = READ_ACTIONS.has(input.action)
      const admission = yield* authority.authorize({
        plane: "delegation",
        operation: "swarm." + input.action,
        phase: readOnly ? "read" : "delegate",
        rootID: input.rootID,
      })
      const root = yield* roots.resolveRoot(input.rootID)
      const virtualRoot = "/" + root.root.alias
      const ownerTag = "oxp:connector:" + admission.connectorID

      const settleTarget =
        input.action === "task.settle"
          ? input.sessionID
            ? yield* supervision.resolve(input.sessionID, "session.swarm_settle", input.rootID)
            : yield* new OxpError.InvalidArgument({
                detail: "swarm task.settle requires sessionID for the existing worker Session that owns the task",
              })
          : undefined

      const runtimeTarget: OxpRuntimeV1.Target = {
        directory: root.canonicalPath,
        signal,
        ...(!readOnly
          ? {
              commitGuard: () =>
                Effect.runPromise(authority.revalidate(admission, "commit").pipe(Effect.asVoid)),
            }
          : {}),
      }

      const raw = yield* OxpRuntimeV1.enter(
        runtimeTarget,
        async () => {
          const [
            { SwarmV2: RuntimeSwarm },
            { SwarmMemberSessionWake: RuntimeMemberWake },
            { SwarmProfilePreflight: RuntimeProfilePreflight },
            { SwarmContainment: RuntimeContainment },
            { SwarmTaskRetirement: RuntimeTaskRetirement },
            { SwarmDispatcher: RuntimeDispatcher },
            { Project: RuntimeProject },
          ] = await Promise.all([
            import("@opencode-ai/core/swarm"),
            import("@/swarm/member-session-wake"),
            import("@/swarm/profile-preflight"),
            import("@/swarm/containment"),
            import("@/swarm/task-retirement"),
            import("@/swarm/dispatcher"),
            import("@/project/project"),
          ])
          return Effect.gen(function* () {
            const swarms = yield* RuntimeSwarm.Service
            const memberWake = yield* RuntimeMemberWake.Service
            const profilePreflight = yield* RuntimeProfilePreflight.Service
            const projects = yield* RuntimeProject.Service
            const persistedProject = yield* projects.fromDirectory(root.canonicalPath)
            const projectID = persistedProject.project.id
            const params = input

            const commit = () => OxpRuntimeV1.commitGuard(runtimeTarget)
            const scopedDetail = Effect.fn("OxpSwarm.scopedDetail")(function* (id: SwarmModel.ID) {
              const detail = yield* swarms.get(id)
              if (detail.swarm.projectID !== projectID || !contained(root.canonicalPath, detail.swarm.directory)) {
                return yield* Effect.fail(new Error("Swarm is outside the approved root"))
              }
              return detail
            })
            const coordinator = Effect.fn("OxpSwarm.coordinator")(function* (id: SwarmModel.ID) {
              const detail = yield* scopedDetail(id)
              const coordinatorID = detail.swarm.coordinatorMemberID
              const member = detail.members.find((candidate) => candidate.id === coordinatorID)
              if (
                !member ||
                member.sessionID !== undefined ||
                !member.capabilities?.tags.includes(ownerTag)
              ) {
                return yield* Effect.fail(
                  new Error("This Swarm is not owned by the current OXP connector coordinator"),
                )
              }
              if (member.lifecycle === "stopping" || member.lifecycle === "stopped") {
                return yield* Effect.fail(new Error("OXP coordinator is not active"))
              }
              return { detail, member }
            })
            const id = () => SwarmModel.ID.make(required(params.swarmId, "swarmId"))

            if (params.action === "list") {
              const rows = (yield* swarms.list({
                projectID,
                ...(params.status === undefined ? {} : { status: params.status }),
              })).filter((row) => contained(root.canonicalPath, row.directory))
              return { title: "OpenFork Swarms", value: rows, metadata: { count: rows.length }, mutating: false }
            }
            if (params.action === "creation.lookup") {
              const workspaceID = yield* InstanceState.workspaceID
              const found = yield* SwarmCreationKey.lookup(swarms, {
                requestKey: params.requestKey,
                projectID,
                ...(workspaceID === undefined ? {} : { workspaceID }),
                directory: root.canonicalPath,
                coordinatorCapabilities: { tags: [ownerTag] },
              })
              return {
                title: found.found ? "Creation found (" + found.status + ")" : "No creation under this key",
                value: found,
                metadata: { swarmId: found.swarmId, status: found.found ? found.status : "not_found" },
                mutating: false,
              }
            }

            if (params.action === "delegate") {
              yield* commit()
              const workspaceID = yield* InstanceState.workspaceID
               const created = yield* SwarmCommand.delegatePartial(swarms, profilePreflight, {
                ...(params.requestKey === undefined ? {} : { requestKey: params.requestKey }),
                projectID,
                ...(workspaceID === undefined ? {} : { workspaceID }),
                directory: root.canonicalPath,
                name: required(params.swarmName, "swarmName"),
                coordinatorName: params.coordinatorName?.trim() || "oxp-coordinator",
                coordinatorRole: params.coordinatorRole?.trim() || "external coordinator",
                coordinatorCapabilities: { tags: [ownerTag] },
                beforeWrite: () => commit().pipe(Effect.mapError(() =>
                  new SwarmSchema.ConflictError({
                    code: "swarm.delegate_authority_changed",
                    reason: "The connector's grant changed during Swarm creation. Earlier writes may exist; use creation.lookup to reconcile.",
                  }))),
                members: params.members ?? [],
                tasks: params.tasks ?? [],
              })
              return {
                title: "Created Swarm " + created.swarm.name,
                value: created,
                 metadata: { swarmId: created.swarm.id, memberId: created.coordinator.id, count: created.members.length, failedCount: created.admission.failures.length, status: created.admission.complete ? created.swarm.status : "partial" },
                mutating: true,
              }
            }

            const swarmID = id()
            if (params.action === "get") {
              const detail = yield* scopedDetail(swarmID)
              return { title: "OpenFork Swarm " + detail.swarm.name, value: detail, metadata: { swarmId: swarmID }, mutating: false }
            }
            if (params.action === "summary") {
              yield* scopedDetail(swarmID)
              const summary = yield* swarms.summary(swarmID)
              return { title: "OpenFork Swarm summary", value: summary, metadata: { swarmId: swarmID, status: summary.swarm.status }, mutating: false }
            }
            if (params.action === "set_status" || params.action === "state") {
              const { detail } = yield* coordinator(swarmID)
              const status = params.status
              if (!status || !["active", "paused", "completed", "failed", "archived"].includes(status)) {
                return yield* Effect.fail(new Error("set_status requires status=active|paused|completed|failed|archived"))
              }
              yield* commit()
              const value = yield* swarms.update({ id: swarmID, expectedRevision: detail.swarm.revision, status })
              return { title: "OpenFork Swarm " + value.status, value, metadata: { swarmId: swarmID, status: value.status }, mutating: true }
            }
            if (params.action === "member.add") {
              const { detail } = yield* coordinator(swarmID)
              if (!params.desiredProfile) return yield* Effect.fail(new Error("desiredProfile is required for member.add"))
              if (!params.workspacePolicy) return yield* Effect.fail(new Error("workspacePolicy is required for member.add"))
              // Read-only admission, proven against the catalog owned by the
              // Swarm's own authoritative directory rather than the connector
              // payload or the approval root. It runs before commit() so an
              // unrunnable profile can neither consume the authority recheck
              // nor become a durable connector-owned member row.
              yield* profilePreflight.check({ directory: detail.swarm.directory, profile: params.desiredProfile })
              yield* commit()
              const value = yield* swarms.addMember({
                swarmID,
                name: required(params.memberName, "memberName"),
                kind: "managed_worker",
                role: required(params.memberRole, "memberRole"),
                desiredProfile: params.desiredProfile,
                workspacePolicy: params.workspacePolicy,
                ...(params.capabilities === undefined ? {} : { capabilities: params.capabilities }),
              })
              return { title: "Added Swarm member " + value.name, value, metadata: { swarmId: swarmID, memberId: value.id, status: value.lifecycle }, mutating: true }
            }
            if (params.action === "member.batch") {
              yield* coordinator(swarmID)
              if (!params.members?.length)
                return yield* Effect.fail(new Error("member.batch requires at least one worker"))
              if (params.members.length > 8)
                return yield* Effect.fail(new Error("member.batch accepts up to 8 workers; split larger requests into verifiable stages"))
              const receipt = yield* SwarmCommand.addMembersPartial(swarms, profilePreflight, {
                swarmID,
                members: params.members,
                beforeWrite: commit,
              })
              return {
                title: `Swarm members: ${receipt.created} created, ${receipt.satisfied} satisfied, ${receipt.failed} failed`,
                value: receipt,
                metadata: { swarmId: swarmID, count: receipt.created, failedCount: receipt.failed, status: receipt.failed ? "partial" : "complete" },
                mutating: receipt.created > 0,
              }
            }
            if (params.action === "member.stop" || params.action === "member.resume") {
              const { detail } = yield* coordinator(swarmID)
              const memberID = SwarmModel.MemberID.make(required(params.memberId, "memberId"))
              const current = detail.members.find((member) => member.id === memberID)
              if (!current) return yield* Effect.fail(new Error("Member is not in the Swarm"))
              if (current.kind === "coordinator") return yield* Effect.fail(new Error("Coordinator lifecycle cannot be changed through member actions"))
              const lifecycle = params.action === "member.stop" ? "stopped" as const : "active" as const
              if (current.lifecycle === lifecycle) {
                return { title: "Swarm member already " + lifecycle, value: current, metadata: { swarmId: swarmID, memberId: current.id, status: current.lifecycle }, mutating: false }
              }
              yield* commit()
              const value = yield* swarms.setMemberLifecycle({
                swarmID,
                memberID,
                expectedLifecycle: current.lifecycle,
                lifecycle,
              })
              // OXP enters the native runtime lazily. Materialize and wake the
              // durable owner explicitly so a lifecycle mutation cannot depend
              // on an already-instantiated in-memory EventV2 subscriber.
              //
              // The wakes carry no authority: retirement/dispatch re-read
              // durable Swarm state and enforce the ordinary generation/binding
              // fences before doing any work.
              if (lifecycle === "stopped") {
                const retirement = yield* RuntimeTaskRetirement.Service
                yield* retirement.poke()
              } else {
                const dispatcher = yield* RuntimeDispatcher.Service
                yield* dispatcher.poke()
              }
              return { title: "Swarm member " + lifecycle, value, metadata: { swarmId: swarmID, memberId: value.id, status: value.lifecycle }, mutating: true }
            }
            if (params.action === "task.create") {
              const { detail, member } = yield* coordinator(swarmID)
              const dependencies = (params.dependencies ?? []).map((dependency) => ({
                taskID: SwarmModel.TaskID.make(dependency.taskId),
                ...(dependency.requirement === undefined ? {} : { requirement: dependency.requirement }),
              }))
              let reservedMemberID: SwarmModel.MemberID | undefined
              if (params.reservedMemberId) {
                const candidate = detail.members.find((item) => item.id === SwarmModel.MemberID.make(params.reservedMemberId!))
                if (!candidate || candidate.kind !== "managed_worker") {
                  return yield* Effect.fail(new Error("reservedMemberId must name a managed worker in this Swarm"))
                }
                reservedMemberID = candidate.id
              }
              yield* commit()
              const value = yield* swarms.createTask({
                swarmID,
                allowedStatuses: ["active", "paused"],
                title: required(params.title, "title"),
                ...(params.description === undefined ? {} : { description: params.description }),
                ...(params.priority === undefined ? {} : { priority: params.priority }),
                createdByMemberID: member.id,
                ...(reservedMemberID === undefined ? {} : { reservedMemberID }),
                ...(params.acceptance === undefined ? {} : { acceptance: params.acceptance }),
                ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
                dependencies,
              })
              return { title: "Created Swarm task " + value.title, value, metadata: { swarmId: swarmID, taskId: value.id, status: value.status }, mutating: true }
            }
            if (params.action === "task.batch") {
              const { member } = yield* coordinator(swarmID)
              if (!params.tasks?.length || params.tasks.length > 8)
                return yield* Effect.fail(new Error("task.batch requires 1-8 tasks; split larger requests into dependency-safe stages"))
              const receipt = yield* SwarmTaskBatch.add(swarms, {
                swarmID, createdByMemberID: member.id, tasks: params.tasks,
                beforeWrite: () => coordinator(swarmID).pipe(Effect.flatMap(() => commit())),
              })
              return {
                title: `Swarm tasks: ${receipt.created} created, ${receipt.satisfied} satisfied, ${receipt.failed} failed`,
                value: receipt,
                metadata: {
                  swarmId: swarmID, count: receipt.created, failedCount: receipt.failed,
                  status: receipt.failed ? "partial" : "complete",
                },
                mutating: receipt.created > 0,
              }
            }
            if (params.action === "task.dependencies") {
              yield* coordinator(swarmID)
              const taskID = SwarmModel.TaskID.make(required(params.taskId, "taskId"))
              yield* commit()
              const task = yield* swarms.setTaskDependencies({
                swarmID,
                taskID,
                dependencies: (params.dependencies ?? []).map((dependency) => ({
                  taskID: SwarmModel.TaskID.make(dependency.taskId),
                  ...(dependency.requirement === undefined ? {} : { requirement: dependency.requirement }),
                })),
              })
              const dependencies = yield* swarms.dependencies(taskID)
              return { title: "Updated Swarm task dependencies", value: { task, dependencies }, metadata: { swarmId: swarmID, taskId: taskID, count: dependencies.length }, mutating: true }
            }
            if (params.action === "task.runs") {
              yield* scopedDetail(swarmID)
              const page = yield* swarms.taskRunHistory({
                swarmID,
                ...(params.taskId === undefined ? {} : { taskID: SwarmModel.TaskID.make(params.taskId) }),
                limit: params.limit ?? 50,
                ...(params.runCursor === undefined
                  ? {}
                  : {
                      before: {
                        createdAt: params.runCursor.createdAt,
                        id: SwarmModel.TaskRunID.make(params.runCursor.id),
                      },
                    }),
              })
              return {
                title: "Swarm task runs",
                value: page,
                metadata: {
                  swarmId: swarmID,
                  ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
                  count: page.items.length,
                  status: page.more ? "more" : "complete",
                },
                mutating: false,
              }
            }
            if (params.action === "task.settle") {
              yield* scopedDetail(swarmID)
              if (!settleTarget || !params.sessionID) return yield* Effect.fail(new Error("task.settle requires supervised sessionID"))
              if (params.taskId !== undefined) return yield* Effect.fail(new Error("task.settle derives task authority from the supervised Session; taskId must be omitted"))
              if (!params.settlement) return yield* Effect.fail(new Error("settlement is required for task.settle"))
              if (params.settlement === "failed" && !params.failureKind) return yield* Effect.fail(new Error("failureKind is required for failed task settlement"))
              yield* commit()
              yield* authority.revalidate(settleTarget.admission, "commit")
              const owned = yield* swarms.sessionTaskAuthority({
                swarmID,
                sessionID: SessionV2.ID.make(params.sessionID),
              })
              const value = yield* swarms.settleTask({
                token: owned.token,
                runID: owned.run.id,
                settlement: params.settlement === "completed"
                  ? {
                      type: "completed",
                      ...(params.resultSummary === undefined ? {} : { summary: params.resultSummary }),
                    }
                  : { type: "failed", failureKind: params.failureKind!, ...(params.detail === undefined ? {} : { detail: params.detail }) },
              })
              return { title: "Settled Swarm task", value, metadata: { swarmId: swarmID, memberId: owned.member.id, taskId: value.task.id, status: value.task.status }, mutating: true }
            }
            if (params.action === "task.review") {
              const { member } = yield* coordinator(swarmID)
              const type = required(params.decision, "decision") as
                | "accept"
                | "request_changes"
                | "retry"
                | "fail"
                | "cancel"
              const decision =
                type === "accept"
                  ? ({ type } as const)
                  : ({ type, ...(params.detail === undefined ? {} : { detail: params.detail }) } as const)
              yield* commit()
              const value = yield* swarms.reviewTask({
                swarmID,
                taskID: SwarmModel.TaskID.make(required(params.taskId, "taskId")),
                reviewerMemberID: member.id,
                expectedLeaseGeneration: params.expectedLeaseGeneration!,
                decision,
              })
              return {
                title: "Reviewed Swarm task",
                value,
                metadata: { swarmId: swarmID, taskId: value.id, memberId: member.id, status: value.status },
                mutating: true,
              }
            }
            if (params.action === "message.list") {
              yield* scopedDetail(swarmID)
              const value = yield* swarms.messages({ swarmID, limit: params.limit ?? 50 })
              return { title: "Swarm messages", value, metadata: { swarmId: swarmID, count: value.length }, mutating: false }
            }
            if (params.action === "message.send") {
              const { member } = yield* coordinator(swarmID)
              const broadcast = params.broadcast === true
              if (broadcast && params.targetMemberId) return yield* Effect.fail(new Error("message.send cannot combine broadcast with targetMemberId"))
              if (!broadcast && !params.targetMemberId) return yield* Effect.fail(new Error("message.send requires targetMemberId or broadcast=true"))
              yield* commit()
              const value = yield* swarms.enqueueMessage({
                swarmID,
                senderMemberID: member.id,
                target: broadcast
                  ? { type: "broadcast" }
                  : { type: "member", memberID: SwarmModel.MemberID.make(required(params.targetMemberId, "targetMemberId")) },
                kind: params.kind ?? (params.responseTo ? "response" : "message"),
                body: required(params.body, "body"),
                ...(params.messagePriority === undefined ? {} : { priority: params.messagePriority }),
                ...(params.replyExpected === undefined ? {} : { replyExpected: params.replyExpected }),
                ...(params.taskId === undefined ? {} : { taskID: SwarmModel.TaskID.make(params.taskId) }),
                ...(params.correlationId === undefined ? {} : { correlationID: params.correlationId }),
                ...(params.responseTo === undefined ? {} : { responseTo: SwarmModel.MessageID.make(params.responseTo) }),
                ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }),
              })
              return { title: "Sent Swarm message", value, metadata: { swarmId: swarmID, memberId: member.id, count: value.deliveries.length }, mutating: true }
            }
            if (params.action === "blackboard.get") {
              yield* scopedDetail(swarmID)
              const value = yield* swarms.blackboard({ swarmID, ...(params.key === undefined ? {} : { key: params.key }) })
              return { title: "Swarm blackboard", value, metadata: { swarmId: swarmID, count: value.length }, mutating: false }
            }
            if (params.action === "blackboard.put") {
              const { member } = yield* coordinator(swarmID)
              if (params.value === undefined) return yield* Effect.fail(new Error("value is required for blackboard.put"))
              yield* commit()
              const value = yield* swarms.putBlackboard({
                swarmID,
                key: required(params.key, "key"),
                value: params.value,
                contentType: params.contentType?.trim() || "application/json",
                authorMemberID: member.id,
                ...(params.taskId === undefined ? {} : { taskID: SwarmModel.TaskID.make(params.taskId) }),
                ...(params.expectedVersion === undefined ? {} : { expectedVersion: params.expectedVersion }),
              })
              return { title: "Updated Swarm blackboard", value, metadata: { swarmId: swarmID, memberId: member.id }, mutating: true }
            }
            if (params.action === "claim.list") {
              yield* scopedDetail(swarmID)
              const value = yield* swarms.claims(swarmID)
              return { title: "Swarm claims", value, metadata: { swarmId: swarmID, count: value.length }, mutating: false }
            }
            if (params.action === "claim.acquire") {
              const { member } = yield* coordinator(swarmID)
              yield* commit()
              const value = yield* swarms.acquireClaim({
                swarmID,
                memberID: member.id,
                scope: required(params.scope, "scope"),
                ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }),
              })
              return { title: "Acquired Swarm claim", value: value.claim, metadata: { swarmId: swarmID, memberId: member.id }, mutating: true }
            }
            if (params.action === "claim.renew" || params.action === "claim.release") {
              const { member } = yield* coordinator(swarmID)
              const scope = required(params.scope, "scope")
              const claims = yield* swarms.claims(swarmID)
              const current = claims.find((claim) => claim.memberID === member.id && claim.scope === scope && claim.releasedAt === undefined)
              if (!current) return yield* Effect.fail(new Error("No active claim for the OXP coordinator and scope"))
              const token = { swarmID, memberID: member.id, scope, generation: current.generation } satisfies SwarmV2.ClaimToken
              yield* commit()
              const value = params.action === "claim.renew"
                ? yield* swarms.renewClaim({ token, ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }) })
                : yield* swarms.releaseClaim({ token })
              return { title: (params.action === "claim.renew" ? "Renewed" : "Released") + " Swarm claim", value, metadata: { swarmId: swarmID, memberId: member.id }, mutating: true }
            }
            if (params.action === "deliverable.list") {
              const detail = yield* scopedDetail(swarmID)
              let memberID: SwarmModel.MemberID | undefined
              if (params.memberId) {
                const candidate = SwarmModel.MemberID.make(params.memberId)
                if (!detail.members.some((member) => member.id === candidate)) return yield* Effect.fail(new Error("memberId is not in this Swarm"))
                memberID = candidate
              }
              const value = yield* swarms.deliverables({ swarmID, ...(memberID === undefined ? {} : { memberID }) })
              return { title: "Swarm deliverables", value, metadata: { swarmId: swarmID, count: value.length }, mutating: false }
            }
            if (params.action === "deliverable.publish") {
              const { member } = yield* coordinator(swarmID)
              yield* commit()
              const value = yield* swarms.publishDeliverable({
                swarmID,
                memberID: member.id,
                summary: required(params.deliverableSummary, "deliverableSummary"),
                refs: params.refs ?? [],
                files: params.files ?? [],
              })
              return { title: "Published Swarm deliverable", value, metadata: { swarmId: swarmID, memberId: member.id }, mutating: true }
            }
            if (params.action === "deliverable.review") {
              const { member } = yield* coordinator(swarmID)
              if (!params.verdict) return yield* Effect.fail(new Error("verdict is required for deliverable.review"))
              const deliverableID = SwarmModel.DeliverableID.make(required(params.deliverableId, "deliverableId"))
              const rows = yield* swarms.deliverables({ swarmID })
              if (!rows.some((row) => row.id === deliverableID)) return yield* Effect.fail(new Error("deliverableId is not in this Swarm"))
              yield* commit()
              const value = yield* swarms.verdictDeliverable({ deliverableID, reviewerMemberID: member.id, verdict: params.verdict })
              return { title: "Reviewed Swarm deliverable", value, metadata: { swarmId: swarmID, memberId: member.id }, mutating: true }
            }
            if (params.action === "recover.members") {
              yield* coordinator(swarmID)
              const unresolved = (yield* swarms.unboundManagedMemberTargets({ swarmID })).filter(
                (target) => target.swarm.status === "active" && target.member.lifecycle === "active",
              )
              yield* commit()
              const requested = yield* memberWake.request(swarmID)
              return {
                title: requested ? "Requested Swarm member recovery" : "Swarm recovery runtime unavailable",
                value: {
                  requested,
                  unresolved: unresolved.map((target) => ({
                    memberID: target.member.id,
                    name: target.member.name,
                    bindingGeneration: target.member.bindingGeneration,
                  })),
                },
                metadata: { swarmId: swarmID, count: unresolved.length, status: requested ? "requested" : "runtime_unavailable" },
                mutating: requested,
              }
            }
            if (params.action === "recover.effects") {
              yield* coordinator(swarmID)
              const containment = yield* RuntimeContainment.Service
              const pending = yield* containment.unresolved({ limit: params.limit ?? 32, swarmID })
              const value = pending.map((entry) => ({
                taskId: entry.taskID,
                leaseGeneration: entry.leaseGeneration,
                sessionId: entry.sessionID,
                sessionGeneration: entry.sessionGeneration,
                retireReason: entry.retireReason,
                hazards: entry.hazards,
                hasRecoveringOwner: true,
              }))
              return {
                title: value.length === 0 ? "No unresolved external effects" : `Unresolved external effects (${value.length})`,
                value,
                metadata: {
                  swarmId: swarmID,
                  count: value.length,
                  status: value.length === 0 ? "clear" : "blocked",
                },
                mutating: false,
              }
            }
            if (params.action === "recover.session") {
              yield* coordinator(swarmID)
              const containment = yield* RuntimeContainment.Service
              yield* commit()
              const value = yield* containment.acknowledgeSession({ swarmID, memberID: SwarmModel.MemberID.make(required(params.memberId, "memberId")) })
              return { title: "Session recovery " + value.state, value, metadata: { swarmId: swarmID, status: value.state }, mutating: value.state === "contained" || value.state === "task-owned" }
            }
            if (params.action === "recover.contain") {
              yield* coordinator(swarmID)
              const containment = yield* RuntimeContainment.Service
              const taskID = SwarmModel.TaskID.make(required(params.taskId, "taskId"))
              const leaseGeneration = params.leaseGeneration!
              const pending = (yield* containment.unresolved({ limit: 1, swarmID, taskID })).find(
                (entry) => entry.leaseGeneration === leaseGeneration,
              )
              if (!pending)
                return yield* Effect.fail(
                  new Error(
                    `No unresolved external effect for task ${taskID} at lease generation ${leaseGeneration} in Swarm ${swarmID}. Run recover.effects first.`,
                  ),
                )
              yield* commit()
              const acknowledged = yield* containment.acknowledge({ taskID, generation: leaseGeneration })
              if (acknowledged.state !== "contained")
                return yield* Effect.fail(
                  new Error(
                    `Containment was not acknowledged for task ${taskID} (${acknowledged.state}). The execution fence is unchanged and the task stays fenced.`,
                  ),
                )
              const parked = (yield* swarms.get(swarmID)).tasks.find((task) => task.id === taskID)
              const value = {
                taskId: taskID,
                leaseGeneration,
                sealed: acknowledged.sealed,
                outcome: "unknown" as const,
                taskStatus: parked?.status,
                nextAction: "task.review" as const,
              }
              return {
                title: `Task ${taskID} contained; awaiting review`,
                value,
                metadata: { swarmId: swarmID, taskId: taskID, status: parked?.status },
                mutating: true,
              }
            }
            return yield* Effect.fail(new Error("Unhandled Swarm action: " + params.action))
          })
        },
        "Native OpenFork Swarm runtime operation failed",
      ).pipe(Effect.mapError((error) => executionError(error, root.canonicalPath, virtualRoot, signal)))

      const redact = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(redact)
        if (!value || typeof value !== "object") return value
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          if (key === "directory" && typeof item === "string") {
            out[key] = contained(root.canonicalPath, item) ? roots.toVirtualPath(root.root, path.resolve(item)) : virtualRoot
            continue
          }
          if (key === "capabilities" && item && typeof item === "object") {
            const capabilities = item as { tags?: unknown }
            if (Array.isArray(capabilities.tags)) {
              out[key] = { ...capabilities, tags: capabilities.tags.filter((tag) => tag !== ownerTag) }
              continue
            }
          }
          out[key] = redact(item)
        }
        return out
      }
      const value = redact(raw.value)
      return {
        title: raw.title,
        output: JSON.stringify(value),
        structured: value,
        metadata: { action: input.action, rootID: input.rootID, ...raw.metadata },
        ...(raw.mutating ? { mutation: { attempted: true, committed: true } } : {}),
      } satisfies OxpResult.CapabilityResult
    })

    const execute: Interface["execute"] = (input, signal) =>
      executeRaw(input, signal).pipe(
        Effect.catch((error) =>
          OxpError.isError(error)
            ? Effect.fail(error)
            : Effect.fail(new OxpError.DependencyUnavailable({ detail: "OXP Swarm operation failed" })),
        ),
      )

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    OxpAuthority.node,
    OxpRoot.node,
    OxpSupervision.node,
  ],
})

export * as OxpSwarm from "./swarm"
