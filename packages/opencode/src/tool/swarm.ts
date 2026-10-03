import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRender } from "@opencode-ai/core/swarm/render"
import { Swarm as SwarmModel } from "@opencode-ai/schema/swarm"
import { InstanceState } from "@/effect/instance-state"
import { SwarmCommand } from "@/swarm/command"
import { SwarmContainment } from "@/swarm/containment"
import { SwarmMemberSessionWake } from "@/swarm/member-session-wake"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import * as Tool from "./tool"
import { DelegateMemberInput, TaskInput as DelegateTaskInput } from "./swarm-create-schema"
import DESCRIPTION from "./swarm.txt"

const TaskDependencyInput = Schema.Struct({
  taskId: Schema.String,
  requirement: Schema.optional(SwarmModel.DependencyRequirement),
})

const MEMBER_SETTLEMENT_FAILURES = [
  "semantic",
  "provider",
  "tool",
  "permission",
  "timeout",
  "session_aborted",
  "internal",
] as const

const SWARM_ACTIONS = [
  "list",
  "get",
  "summary",
  "delegate",
  "set_status",
  "state",
  "member.add",
  "member.stop",
  "member.resume",
  "task.create",
  "task.dependencies",
  "task.runs",
  "task.settle",
  "message.list",
  "message.send",
  "blackboard.get",
  "blackboard.put",
  "claim.list",
  "claim.acquire",
  "claim.renew",
  "claim.release",
  "deliverable.list",
  "deliverable.publish",
  "deliverable.review",
  "recover.members",
  "recover.effects",
  "recover.contain",
  "task.review",
] as const

/**
 * One source of truth for action-specific input shape.
 *
 * `required` fields must be present (a blank/whitespace-only string counts as
 * absent). `oneOf` groups are satisfied when any single labeled member of the
 * group is satisfied, which encodes conditional requirements such as
 * "either a direct recipient or a broadcast" without inventing new prose.
 * `forbidden` fields encode inputs the host deliberately refuses as authority
 * (for example a model-supplied task id for task settlement).
 *
 * The human-facing `Required inputs by action` block is generated from this
 * table, so the documented contract and the enforced schema cannot drift.
 */
interface ActionInputShape {
  readonly required: readonly string[]
  readonly oneOf?: readonly (readonly string[])[]
  readonly when?: readonly { readonly when: string; readonly requires: readonly string[] }[]
  readonly note?: string
  readonly forbidden?: Readonly<Record<string, string>>
}

const ACTION_INPUTS = {
  list: { required: [] },
  get: {
    required: ["swarmId"],
    note: "full Swarm detail only; use task.runs for TaskRun/result audit",
    forbidden: { taskId: "get does not filter by taskId; use task.runs for run-level audit" },
  },
  summary: { required: ["swarmId"] },
  delegate: { required: ["swarmName"] },
  "set_status": {
    required: ["swarmId", "status"],
    note: "mutating Swarm lifecycle action; `state` is the deprecated alias of this action",
  },
  state: { required: ["swarmId", "status"], note: "deprecated alias of set_status" },
  "member.add": { required: ["swarmId", "memberName", "memberRole", "desiredProfile", "workspacePolicy"] },
  "member.stop": { required: ["swarmId", "memberId"] },
  "member.resume": { required: ["swarmId", "memberId"] },
  "task.create": { required: ["swarmId", "title"] },
  "task.dependencies": { required: ["swarmId", "taskId"] },
  "task.runs": {
    required: ["swarmId"],
    note: "bounded newest-first TaskRun audit; optional taskId, limit (1-200), and runCursor. Pass response.next back as runCursor to page older runs",
  },
  "task.settle": {
    required: ["swarmId", "settlement"],
    when: [{ when: "settlement=failed", requires: ["failureKind"] }],
    note: "omit taskId and member identity; completed settlement may include resultSummary for durable successor handoff",
    forbidden: { taskId: "task.settle derives current task authority from the caller Session; taskId must be omitted" },
  },
  "message.list": { required: ["swarmId"] },
  "message.send": {
    required: ["swarmId", "body"],
    oneOf: [["targetMemberId", "broadcast=true"]],
  },
  "blackboard.get": { required: ["swarmId"] },
  "blackboard.put": {
    required: ["swarmId", "key", "value"],
    note: "expectedVersion is required when overwriting",
  },
  "claim.list": { required: ["swarmId"] },
  "claim.acquire": { required: ["swarmId", "scope"] },
  "claim.renew": { required: ["swarmId", "scope"] },
  "claim.release": { required: ["swarmId", "scope"] },
  "deliverable.list": { required: ["swarmId"] },
  "deliverable.publish": { required: ["swarmId", "deliverableSummary"] },
  "deliverable.review": { required: ["swarmId", "deliverableId", "verdict"] },
  "recover.members": { required: ["swarmId"] },
  "recover.effects": {
    required: ["swarmId"],
    note: "read-only; lists retiring leases fenced by unresolved external effects",
  },
  "recover.contain": {
    required: ["swarmId", "taskId", "leaseGeneration"],
    note: "explicit containment acknowledgement; requires a recover.effects entry for this Swarm",
  },
  "task.review": {
    required: ["swarmId", "taskId", "decision", "expectedLeaseGeneration"],
    note: "expectedLeaseGeneration is the task's current leaseGeneration as last observed; a stale value fails closed",
  },
} as const satisfies Record<(typeof SWARM_ACTIONS)[number], ActionInputShape>

type ActionInput = ActionInputShape

function requirementText(input: ActionInput): string {
  const head: string[] = []
  if (input.required.length > 0) head.push(input.required.join(", "))
  for (const group of input.oneOf ?? []) head.push(`either ${group.join(" or ")}`)
  if (head.length === 0) return "none"
  const extras = [
    ...(input.when ?? []).map((rule) => `when ${rule.when} also require ${rule.requires.join(", ")}`),
    ...(input.note ? [input.note] : []),
  ]
  return head.join(", and ") + (extras.length > 0 ? `; ${extras.join("; ")}` : "")
}

export const ACTION_REQUIREMENTS_DESCRIPTION = [
  "Required inputs by action:",
  ...SWARM_ACTIONS.map((action) => `- ${action}: ${requirementText(ACTION_INPUTS[action])}`),
].join("\n")

/**
 * Presence test for action-specific requirements. Only genuinely absent values
 * count as missing: `false` and `0` are real inputs, and a whitespace-only
 * string is treated as absent because every Swarm identifier/scope is matched
 * against durable host state. A `field=value` label compares the decoded
 * scalar, so `broadcast=true` is satisfied by either the boolean or the
 * losslessly coerced `"true"` string.
 */
function supplied(params: Record<string, unknown>, label: string) {
  const [field, expected] = label.split("=")
  const value = params[field!]
  if (expected === undefined) return value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "")
  return value !== undefined && value !== null && String(value) === expected
}

/**
 * Lossless scalar coercion for model serialization noise. A numeric string is
 * accepted only when it is an exact integer literal, so `"50"` decodes to `50`
 * while `"50.5"`, `"1e3"`, `""`, and `"abc"` still fail loudly. Target bounds
 * (for example the bounded read limit) are part of the decoded schema, so
 * coercion cannot widen a limit.
 */
function LosslessInteger<S extends Schema.Top & { readonly Type: number; readonly Encoded: number }>(target: S) {
  return Schema.Union([target, Schema.String]).pipe(
    Schema.decodeTo(target, {
      decode: SchemaGetter.transformOrFail((value) => {
        if (typeof value === "number") return Effect.succeed(value)
        if (typeof value !== "string" || !/^[+-]?\d+$/.test(value.trim()))
          return Effect.fail(
            new SchemaIssue.InvalidValue(Option.some(value), { message: "expected an integer, not a string" }),
          )
        const parsed = Number(value.trim())
        if (!Number.isSafeInteger(parsed))
          return Effect.fail(
            new SchemaIssue.InvalidValue(Option.some(value), { message: "expected an integer within the safe range" }),
          )
        return Effect.succeed(parsed)
      }),
      encode: SchemaGetter.passthrough(),
    }),
  )
}

/** Only the exact literals "true"/"false" coerce; Boolean("false") would not. */
const LosslessBoolean = Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => (typeof value === "boolean" ? value : value === "true")),
    encode: SchemaGetter.passthrough(),
  }),
)

const BoundedReadLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
const TaskRunCursorInput = Schema.Struct({
  createdAt: LosslessInteger(Schema.Int).annotate({ description: "task.runs continuation timestamp from response.next.createdAt." }),
  id: Schema.String.annotate({ description: "task.runs continuation run id from response.next.id." }),
})

const SwarmArguments = Schema.Struct({
  action: Schema.Literals([
    ...SWARM_ACTIONS,
  ]).annotate({ description: "Swarm action to perform." }),
  swarmId: Schema.optional(Schema.String).annotate({ description: "Target Swarm id. Required except for list and delegate." }),
  status: Schema.optional(SwarmModel.Status).annotate({ description: "list filter, or set_status target status." }),
  limit: Schema.optional(LosslessInteger(BoundedReadLimit)).annotate({ description: "Bounded read limit. message.list and task.runs default to 50." }),
  runCursor: Schema.optional(TaskRunCursorInput).annotate({
    description: "task.runs keyset cursor. Pass the previous task.runs response.next object unchanged to continue older runs.",
  }),
  swarmName: Schema.optional(Schema.String).annotate({ description: "delegate: new Swarm name." }),
  coordinatorName: Schema.optional(Schema.String).annotate({ description: "delegate: coordinator roster name." }),
  coordinatorRole: Schema.optional(Schema.String).annotate({ description: "delegate: coordinator role." }),
  members: Schema.optional(Schema.Array(DelegateMemberInput)).annotate({ description: "delegate: managed workers with explicit execution/profile authority." }),
  tasks: Schema.optional(Schema.Array(DelegateTaskInput)).annotate({ description: "delegate: initial DAG tasks. dependsOn references request-local task keys." }),
  memberId: Schema.optional(Schema.String).annotate({ description: "member lifecycle target or optional deliverable.list filter." }),
  memberName: Schema.optional(Schema.String).annotate({ description: "member.add: unique member name." }),
  memberRole: Schema.optional(Schema.String).annotate({ description: "member.add: member role." }),
  desiredProfile: Schema.optional(SwarmModel.MemberExecutionProfile).annotate({ description: "member.add: explicit agent/model/hard permission boundary." }),
  workspacePolicy: Schema.optional(SwarmModel.WorkspacePolicy).annotate({ description: "member.add: shared-read, shared-write, or worktree policy." }),
  capabilities: Schema.optional(SwarmModel.MemberCapabilities).annotate({ description: "member.add: optional capability tags." }),
  taskId: Schema.optional(Schema.String).annotate({ description: "task.create/dependencies/blackboard link target, or optional task.runs filter. Not accepted as task.settle authority." }),
  title: Schema.optional(Schema.String).annotate({ description: "task.create: task title." }),
  description: Schema.optional(Schema.String).annotate({ description: "task.create: task description." }),
  priority: Schema.optional(LosslessInteger(Schema.Int)).annotate({ description: "task.create: scheduler priority." }),
  reservedMemberId: Schema.optional(Schema.String).annotate({ description: "task.create: reserve to an existing managed member." }),
  acceptance: Schema.optional(SwarmModel.TaskAcceptance).annotate({ description: "task.create: explicit acceptance criteria." }),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)).annotate({ description: "task.create: structured low-authority metadata." }),
  dependencies: Schema.optional(Schema.Array(TaskDependencyInput)).annotate({ description: "task.create/task.dependencies: prerequisite task ids and requirements." }),
  settlement: Schema.optional(Schema.Literals(["completed", "failed"])).annotate({ description: "task.settle: member-side outcome." }),
  resultSummary: Schema.optional(Schema.String).annotate({ description: "task.settle completed: concise result for durable successor handoff." }),
  failureKind: Schema.optional(Schema.Literals(MEMBER_SETTLEMENT_FAILURES)).annotate({ description: "task.settle failed: typed failure category." }),
  detail: Schema.optional(Schema.String).annotate({ description: "task.settle failed: concise failure detail." }),
  targetMemberId: Schema.optional(Schema.String).annotate({ description: "message.send: direct recipient. Omit only when broadcast=true." }),
  broadcast: Schema.optional(LosslessBoolean).annotate({ description: "message.send: send to all live peers." }),
  kind: Schema.optional(SwarmModel.MessageKind).annotate({ description: "message.send message kind." }),
  body: Schema.optional(Schema.String).annotate({ description: "message.send body." }),
  messagePriority: Schema.optional(SwarmModel.MessagePriority).annotate({ description: "message.send priority." }),
  replyExpected: Schema.optional(LosslessBoolean).annotate({ description: "message.send explicit reply contract." }),
  correlationId: Schema.optional(Schema.String).annotate({ description: "message.send optional correlation id." }),
  responseTo: Schema.optional(Schema.String).annotate({ description: "message.send reply-to message id." }),
  expiresAt: Schema.optional(LosslessInteger(Schema.Number)).annotate({ description: "message/claim expiration as epoch milliseconds." }),
  key: Schema.optional(Schema.String).annotate({ description: "blackboard key." }),
  value: Schema.optional(Schema.Json).annotate({ description: "blackboard.put JSON value." }),
  contentType: Schema.optional(Schema.String).annotate({ description: "blackboard.put content type." }),
  expectedVersion: Schema.optional(LosslessInteger(Schema.Int)).annotate({ description: "blackboard.put compare-and-set version; required for overwrites." }),
  scope: Schema.optional(Schema.String).annotate({ description: "claim scope, e.g. path/lane identifier." }),
  deliverableId: Schema.optional(Schema.String).annotate({ description: "deliverable.review target id." }),
  deliverableSummary: Schema.optional(Schema.String).annotate({ description: "deliverable.publish summary." }),
  refs: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "deliverable.publish evidence refs." }),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "deliverable.publish artifact paths." }),
  verdict: Schema.optional(SwarmModel.DeliverableVerdict).annotate({ description: "deliverable.review verdict." }),
  decision: Schema.optional(
    Schema.Literals(["accept", "request_changes", "retry", "fail", "cancel"]).annotate({
      description: "task.review: reviewer decision for a review_pending/changes_requested task.",
    }),
  ),
  expectedLeaseGeneration: Schema.optional(LosslessInteger(Schema.Int)).annotate({
    description:
      "task.review: exact leaseGeneration the decision was made against. Required; a stale value fails closed.",
  }),
  leaseGeneration: Schema.optional(LosslessInteger(Schema.Int)).annotate({
    description: "recover.contain: exact retiring lease generation to acknowledge containment for.",
  }),
})

/**
 * Action-specific validation runs at tool-schema decode time, before any Swarm
 * service call, permission ask, or durable mutation. A missing action input is
 * therefore a schema error the model can rewrite, not a late runtime throw.
 */
const ActionInputs = Schema.makeFilter<Schema.Schema.Type<typeof SwarmArguments>>(
  (value) => {
    const params = value as Record<string, unknown>
    const input: ActionInput | undefined = ACTION_INPUTS[params.action as keyof typeof ACTION_INPUTS]
    if (!input) return true
    const action = params.action
    const missing = input.required.filter((field) => !supplied(params, field))
    if (missing.length > 0)
      return `action "${action}" is missing required input(s): ${missing.join(", ")}. Required inputs: ${requirementText(input)}.`
    for (const group of input.oneOf ?? []) {
      if (group.some((label) => supplied(params, label))) continue
      return `action "${action}" needs one of: ${group.join(" or ")}.`
    }
    for (const rule of input.when ?? []) {
      if (!supplied(params, rule.when)) continue
      const absent = rule.requires.filter((field) => !supplied(params, field))
      if (absent.length > 0)
        return `action "${action}" requires ${rule.requires.join(", ")} when ${rule.when}; missing: ${absent.join(", ")}.`
    }
    for (const [field, message] of Object.entries(input.forbidden ?? {})) {
      if (supplied(params, field)) return `action "${action}" must not include ${field}: ${message}.`
    }
    return true
  },
  {
    description: "Action-specific required inputs for the selected Swarm action.",
    message: "invalid Swarm action arguments",
  },
)

/**
 * The tool contract is the single decode boundary: action-specific required
 * inputs are enforced here, so a malformed Swarm call fails before it can ask
 * for permission or reach the Swarm service.
 */
export const Parameters = SwarmArguments.check(ActionInputs)

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = {
  action: Params["action"]
  permission: string
  swarmId?: string
  memberId?: string
  taskId?: string
  count?: number
  status?: string
}

const LEAF_PERMISSION: Record<Params["action"], string> = {
  list: "swarm.read",
  get: "swarm.read",
  summary: "swarm.read",
  delegate: "swarm.member",
  "set_status": "swarm.member",
  state: "swarm.member",
  "member.add": "swarm.member",
  "member.stop": "swarm.member",
  "member.resume": "swarm.member",
  "task.create": "swarm.task",
  "task.dependencies": "swarm.task",
  "task.runs": "swarm.read",
  "task.settle": "swarm.task",
  "message.list": "swarm.read",
  "message.send": "swarm.message",
  "blackboard.get": "swarm.read",
  "blackboard.put": "swarm.memory",
  "claim.list": "swarm.read",
  "claim.acquire": "swarm.memory",
  "claim.renew": "swarm.memory",
  "claim.release": "swarm.memory",
  "deliverable.list": "swarm.read",
  "deliverable.publish": "swarm.review",
  "deliverable.review": "swarm.review",
  "recover.members": "swarm.member",
  "recover.effects": "swarm.read",
  "recover.contain": "swarm.review",
  "task.review": "swarm.review",
}

function required(value: string | undefined, name: string) {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function swarmID(value: string | undefined) {
  return SwarmModel.ID.make(required(value, "swarmId"))
}

function memberID(value: string | undefined, name = "memberId") {
  return SwarmModel.MemberID.make(required(value, name))
}

function taskID(value: string | undefined, name = "taskId") {
  return SwarmModel.TaskID.make(required(value, name))
}

function outputData(label: string, value: unknown) {
  return [`[SWARM ${label}]`, SwarmRender.fence(JSON.stringify(value, null, 2))].join("\n")
}

function result(action: Params["action"], permission: string, title: string, output: string, metadata: Omit<Metadata, "action" | "permission"> = {}) {
  return { title, output, metadata: { action, permission, ...metadata } satisfies Metadata }
}

export const SwarmTool = Tool.define<
  typeof Parameters,
  Metadata,
  SwarmV2.Service | SwarmMemberSessionWake.Service | SwarmProfilePreflight.Service | SwarmContainment.Service
>(
  "swarm",
  Effect.gen(function* () {
    const swarms = yield* SwarmV2.Service
    const memberWake = yield* SwarmMemberSessionWake.Service
    const profilePreflight = yield* SwarmProfilePreflight.Service
    const containment = yield* SwarmContainment.Service

    const scopedDetail = Effect.fn("SwarmTool.scopedDetail")(function* (id: SwarmModel.ID) {
      const instance = yield* InstanceState.context
      const detail = yield* swarms.get(id)
      if (detail.swarm.projectID !== instance.project.id)
        return yield* Effect.fail(new Error(`Swarm ${id} is outside the current project.`))
      return detail
    })

    const callerMember = Effect.fn("SwarmTool.callerMember")(function* (id: SwarmModel.ID, ctx: Tool.Context<Metadata>) {
      yield* scopedDetail(id)
      const sessionID = SessionV2.ID.make(ctx.sessionID)
      const matches = (yield* swarms.membersForSession(sessionID)).filter((member) => member.swarmID === id)
      if (matches.length !== 1)
        return yield* Effect.fail(new Error(matches.length === 0 ? `Caller Session is not a member of Swarm ${id}.` : `Caller Session has ambiguous membership in Swarm ${id}.`))
      const member = matches[0]!
      if (member.lifecycle === "stopping" || member.lifecycle === "stopped")
        return yield* Effect.fail(new Error(`Caller member is ${member.lifecycle} and cannot mutate Swarm state.`))
      return member
    })

    const coordinator = Effect.fn("SwarmTool.coordinator")(function* (id: SwarmModel.ID, ctx: Tool.Context<Metadata>) {
      const detail = yield* scopedDetail(id)
      const caller = yield* callerMember(id, ctx)
      if (detail.swarm.coordinatorMemberID !== caller.id)
        return yield* Effect.fail(new Error(`Action requires the recorded coordinator of Swarm ${id}.`))
      return { detail, caller }
    })

    const ask = Effect.fn("SwarmTool.ask")(function* (params: Params, ctx: Tool.Context<Metadata>) {
      const permission = LEAF_PERMISSION[params.action]
      const instance = yield* InstanceState.context
      const resource = params.action === "delegate"
        ? `project:${instance.project.id}:create`
        : params.action === "list"
          ? `project:${instance.project.id}`
          : `swarm:${required(params.swarmId, "swarmId")}`
      yield* ctx.ask({ permission, patterns: [resource], always: [resource], metadata: { action: params.action, resource } })
      return permission
    })

    const execute = Effect.fn("SwarmTool.execute")(function* (params: Params, ctx: Tool.Context<Metadata>) {
      const permission = yield* ask(params, ctx)
      const instance = yield* InstanceState.context

      if (params.action === "list") {
        const rows = yield* swarms.list({ projectID: instance.project.id, ...(params.status === undefined ? {} : { status: params.status }) })
        const compact = rows.map((swarm) => ({ id: swarm.id, name: swarm.name, status: swarm.status, coordinatorMemberID: swarm.coordinatorMemberID, revision: swarm.revision, workspaceID: swarm.workspaceID, directory: swarm.directory }))
        return result(params.action, permission, `Swarms (${compact.length})`, outputData("LIST", compact), { count: compact.length })
      }

      if (params.action === "delegate") {
        const workspaceID = yield* InstanceState.workspaceID
        const created = yield* SwarmCommand.delegate(swarms, profilePreflight, {
          projectID: instance.project.id,
          ...(workspaceID === undefined ? {} : { workspaceID }),
          directory: instance.directory,
          coordinatorSessionID: SessionV2.ID.make(ctx.sessionID),
          name: required(params.swarmName, "swarmName"),
          ...(params.coordinatorName === undefined ? {} : { coordinatorName: params.coordinatorName }),
          ...(params.coordinatorRole === undefined ? {} : { coordinatorRole: params.coordinatorRole }),
          members: params.members ?? [],
          tasks: params.tasks ?? [],
        })
        return result(params.action, permission, `Created Swarm ${created.swarm.name}`, outputData("DELEGATE", created), { swarmId: created.swarm.id, memberId: created.coordinator.id, count: created.members.length, status: created.swarm.status })
      }

      const id = swarmID(params.swarmId)

      if (params.action === "get") {
        const detail = yield* scopedDetail(id)
        return result(params.action, permission, `Swarm ${detail.swarm.name}`, outputData("DETAIL", detail), { swarmId: id, count: detail.members.length + detail.tasks.length, status: detail.swarm.status })
      }
      if (params.action === "summary") {
        yield* scopedDetail(id)
        const summary = yield* swarms.summary(id)
        return result(params.action, permission, `Swarm summary ${summary.swarm.name}`, outputData("SUMMARY", summary), { swarmId: id, status: summary.swarm.status })
      }
      if (params.action === "set_status" || params.action === "state") {
        const { detail } = yield* coordinator(id, ctx)
        const status = params.status
        if (!status || !["active", "paused", "completed", "failed", "archived"].includes(status))
          throw new Error("set_status requires status=active|paused|completed|failed|archived")
        const updated = yield* swarms.update({ id, expectedRevision: detail.swarm.revision, status })
        return result(params.action, permission, `Swarm ${updated.status}`, outputData("STATE", updated), { swarmId: id, status: updated.status })
      }
      if (params.action === "member.add") {
        const { detail } = yield* coordinator(id, ctx)
        if (!params.desiredProfile) throw new Error("desiredProfile is required for member.add")
        if (!params.workspacePolicy) throw new Error("workspacePolicy is required for member.add")
        // An unbound managed member is worse than an absent one: it looks
        // dispatchable, never materializes, and leaves its tasks permanently
        // unclaimed. So the execution profile is proven runnable against the
        // Swarm's own workspace catalog before the first durable member row, using
        // the same owner the delegate workflow and member materialization use.
        yield* profilePreflight.check({ directory: detail.swarm.directory, profile: params.desiredProfile })
        const member = yield* swarms.addMember({ swarmID: id, name: required(params.memberName, "memberName"), kind: "managed_worker", role: required(params.memberRole, "memberRole"), desiredProfile: params.desiredProfile, workspacePolicy: params.workspacePolicy, ...(params.capabilities === undefined ? {} : { capabilities: params.capabilities }) })
        return result(params.action, permission, `Added member ${member.name}`, outputData("MEMBER", member), { swarmId: id, memberId: member.id, status: member.lifecycle })
      }
      if (params.action === "member.stop" || params.action === "member.resume") {
        const { detail } = yield* coordinator(id, ctx)
        const targetID = memberID(params.memberId)
        const target = detail.members.find((member) => member.id === targetID)
        if (!target) throw new Error(`Member not found in Swarm ${id}: ${targetID}`)
        if (target.kind === "coordinator") throw new Error("Coordinator lifecycle cannot be changed through member actions.")
        const lifecycle = params.action === "member.stop" ? "stopped" : "active"
        if (target.lifecycle === lifecycle)
          return result(params.action, permission, `Member already ${lifecycle}`, outputData("MEMBER", target), { swarmId: id, memberId: target.id, status: target.lifecycle })
        const member = yield* swarms.setMemberLifecycle({ swarmID: id, memberID: target.id, expectedLifecycle: target.lifecycle, lifecycle })
        return result(params.action, permission, `Member ${member.name} ${lifecycle}`, outputData("MEMBER", member), { swarmId: id, memberId: member.id, status: member.lifecycle })
      }
      if (params.action === "task.create") {
        const { caller, detail } = yield* coordinator(id, ctx)
        const dependencies = (params.dependencies ?? []).map((dependency) => ({ taskID: SwarmModel.TaskID.make(dependency.taskId), ...(dependency.requirement === undefined ? {} : { requirement: dependency.requirement }) }))
        let reservedMemberID: SwarmModel.MemberID | undefined
        if (params.reservedMemberId) {
          const target = detail.members.find((member) => member.id === SwarmModel.MemberID.make(params.reservedMemberId!))
          if (!target) throw new Error(`Reserved member is not in Swarm ${id}: ${params.reservedMemberId}`)
          if (target.kind !== "managed_worker") throw new Error("Tasks may only be reserved to managed workers.")
          reservedMemberID = target.id
        }
        const task = yield* swarms.createTask({ swarmID: id, title: required(params.title, "title"), ...(params.description === undefined ? {} : { description: params.description }), ...(params.priority === undefined ? {} : { priority: params.priority }), createdByMemberID: caller.id, ...(reservedMemberID === undefined ? {} : { reservedMemberID }), ...(params.acceptance === undefined ? {} : { acceptance: params.acceptance }), ...(params.metadata === undefined ? {} : { metadata: params.metadata }), dependencies })
        return result(params.action, permission, `Created task ${task.title}`, outputData("TASK", task), { swarmId: id, taskId: task.id, status: task.status })
      }
      if (params.action === "task.dependencies") {
        yield* coordinator(id, ctx)
        const targetID = taskID(params.taskId)
        const detail = yield* scopedDetail(id)
        if (!detail.tasks.some((task) => task.id === targetID)) throw new Error(`Task is not in Swarm ${id}: ${targetID}`)
        const task = yield* swarms.setTaskDependencies({ swarmID: id, taskID: targetID, dependencies: (params.dependencies ?? []).map((dependency) => ({ taskID: SwarmModel.TaskID.make(dependency.taskId), ...(dependency.requirement === undefined ? {} : { requirement: dependency.requirement }) })) })
        const dependencies = yield* swarms.dependencies(targetID)
        return result(params.action, permission, "Updated task dependencies", outputData("TASK DEPENDENCIES", { task, dependencies }), { swarmId: id, taskId: task.id, count: dependencies.length, status: task.status })
      }
      if (params.action === "task.runs") {
        yield* scopedDetail(id)
        const page = yield* swarms.taskRunHistory({
          swarmID: id,
          ...(params.taskId === undefined ? {} : { taskID: taskID(params.taskId) }),
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
        return result(
          params.action,
          permission,
          `Swarm task runs (${page.items.length})`,
          outputData("TASK RUNS", page),
          {
            swarmId: id,
            ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
            count: page.items.length,
            status: page.more ? "more" : "complete",
          },
        )
      }
      if (params.action === "task.settle") {
        yield* scopedDetail(id)
        if (params.taskId !== undefined)
          throw new Error("task.settle derives current task authority from the caller Session; taskId must be omitted")
        const settlement = params.settlement
        if (!settlement) throw new Error("settlement is required for task.settle")
        if (settlement === "failed" && !params.failureKind) throw new Error("failureKind is required for failed task settlement")
        const authority = yield* swarms.sessionTaskAuthority({ swarmID: id, sessionID: SessionV2.ID.make(ctx.sessionID) })
        const settled = yield* swarms.settleTask({
          token: authority.token,
          runID: authority.run.id,
          settlement:
            settlement === "completed"
              ? {
                  type: "completed",
                  ...(params.resultSummary === undefined ? {} : { summary: params.resultSummary }),
                }
              : {
                  type: "failed",
                  failureKind: params.failureKind!,
                  ...(params.detail === undefined ? {} : { detail: params.detail }),
                },
        })
        return result(params.action, permission, `Task ${settled.task.status}`, outputData("TASK SETTLEMENT", settled), { swarmId: id, memberId: authority.member.id, taskId: settled.task.id, status: settled.task.status })
      }
      if (params.action === "message.list") {
        yield* scopedDetail(id)
        const messages = yield* swarms.messages({ swarmID: id, limit: params.limit ?? 50 })
        const rendered = messages.length === 0 ? "[SWARM MESSAGES]\n(no messages)" : ["[SWARM MESSAGES]", ...messages.map((message) => SwarmRender.peer(message))].join("\n\n")
        return result(params.action, permission, `Swarm messages (${messages.length})`, rendered, { swarmId: id, count: messages.length })
      }
      if (params.action === "message.send") {
        const sender = yield* callerMember(id, ctx)
        const broadcast = params.broadcast === true
        if (broadcast && params.targetMemberId) throw new Error("message.send cannot combine broadcast with targetMemberId")
        if (!broadcast && !params.targetMemberId) throw new Error("message.send requires targetMemberId or broadcast=true")
        const sent = yield* swarms.enqueueMessage({ swarmID: id, senderMemberID: sender.id, target: broadcast ? { type: "broadcast" } : { type: "member", memberID: memberID(params.targetMemberId, "targetMemberId") }, kind: params.kind ?? (params.responseTo ? "response" : "message"), body: required(params.body, "body"), ...(params.messagePriority === undefined ? {} : { priority: params.messagePriority }), ...(params.replyExpected === undefined ? {} : { replyExpected: params.replyExpected }), ...(params.taskId === undefined ? {} : { taskID: SwarmModel.TaskID.make(params.taskId) }), ...(params.correlationId === undefined ? {} : { correlationID: params.correlationId }), ...(params.responseTo === undefined ? {} : { responseTo: SwarmModel.MessageID.make(params.responseTo) }), ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }) })
        return result(params.action, permission, `Sent ${sent.message.kind}`, [SwarmRender.peer(sent.message), outputData("DELIVERIES", sent.deliveries)].join("\n\n"), { swarmId: id, memberId: sender.id, count: sent.deliveries.length })
      }
      if (params.action === "blackboard.get") {
        yield* scopedDetail(id)
        const rows = yield* swarms.blackboard({ swarmID: id, ...(params.key === undefined ? {} : { key: params.key }) })
        return result(params.action, permission, `Blackboard (${rows.length})`, outputData("BLACKBOARD", rows), { swarmId: id, count: rows.length })
      }
      if (params.action === "blackboard.put") {
        const author = yield* callerMember(id, ctx)
        if (params.value === undefined) throw new Error("value is required for blackboard.put")
        const entry = yield* swarms.putBlackboard({ swarmID: id, key: required(params.key, "key"), value: params.value, contentType: params.contentType?.trim() || "application/json", authorMemberID: author.id, ...(params.taskId === undefined ? {} : { taskID: SwarmModel.TaskID.make(params.taskId) }), ...(params.expectedVersion === undefined ? {} : { expectedVersion: params.expectedVersion }) })
        return result(params.action, permission, `Blackboard ${entry.key} v${entry.version}`, outputData("BLACKBOARD", entry), { swarmId: id, memberId: author.id })
      }
      if (params.action === "claim.list") {
        yield* scopedDetail(id)
        const claims = yield* swarms.claims(id)
        return result(params.action, permission, `Claims (${claims.length})`, outputData("CLAIMS", claims), { swarmId: id, count: claims.length })
      }
      if (params.action === "claim.acquire") {
        const member = yield* callerMember(id, ctx)
        const acquired = yield* swarms.acquireClaim({ swarmID: id, memberID: member.id, scope: required(params.scope, "scope"), ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }) })
        return result(params.action, permission, `Claimed ${acquired.claim.scope}`, outputData("CLAIM", acquired.claim), { swarmId: id, memberId: member.id })
      }
      if (params.action === "claim.renew" || params.action === "claim.release") {
        const member = yield* callerMember(id, ctx)
        const scope = required(params.scope, "scope")
        const claims = yield* swarms.claims(id)
        const current = claims.find((claim) => claim.memberID === member.id && claim.scope === scope && claim.releasedAt === undefined)
        if (!current) throw new Error(`No active claim for caller member and scope: ${scope}`)
        const token = { swarmID: id, memberID: member.id, scope, generation: current.generation } satisfies SwarmV2.ClaimToken
        const claim = params.action === "claim.renew"
          ? yield* swarms.renewClaim({ token, ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }) })
          : yield* swarms.releaseClaim({ token })
        return result(params.action, permission, `${params.action === "claim.renew" ? "Renewed" : "Released"} claim ${scope}`, outputData("CLAIM", claim), { swarmId: id, memberId: member.id })
      }
      if (params.action === "deliverable.list") {
        const detail = yield* scopedDetail(id)
        let filter: SwarmModel.MemberID | undefined
        if (params.memberId) {
          const candidate = SwarmModel.MemberID.make(params.memberId)
          if (!detail.members.some((member) => member.id === candidate)) throw new Error(`Member is not in Swarm ${id}: ${params.memberId}`)
          filter = candidate
        }
        const rows = yield* swarms.deliverables({ swarmID: id, ...(filter === undefined ? {} : { memberID: filter }) })
        return result(params.action, permission, `Deliverables (${rows.length})`, outputData("DELIVERABLES", rows), { swarmId: id, count: rows.length })
      }
      if (params.action === "deliverable.publish") {
        const member = yield* callerMember(id, ctx)
        const authority = yield* swarms.sessionTaskAuthority({ swarmID: id, sessionID: SessionV2.ID.make(ctx.sessionID) }).pipe(Effect.option)
        const deliverable = yield* swarms.publishDeliverable({ swarmID: id, memberID: member.id, ...(authority._tag === "Some" ? { taskRunID: authority.value.run.id } : {}), summary: required(params.deliverableSummary, "deliverableSummary"), refs: params.refs ?? [], files: params.files ?? [] })
        return result(params.action, permission, "Published deliverable", outputData("DELIVERABLE", deliverable), { swarmId: id, memberId: member.id })
      }
      if (params.action === "deliverable.review") {
        const reviewer = yield* callerMember(id, ctx)
        if (!params.verdict) throw new Error("verdict is required for deliverable.review")
        const deliverables = yield* swarms.deliverables({ swarmID: id })
        const targetID = SwarmModel.DeliverableID.make(required(params.deliverableId, "deliverableId"))
        if (!deliverables.some((item) => item.id === targetID)) throw new Error(`Deliverable is not in Swarm ${id}: ${targetID}`)
        const deliverable = yield* swarms.verdictDeliverable({ deliverableID: targetID, reviewerMemberID: reviewer.id, verdict: params.verdict })
        return result(params.action, permission, `Deliverable ${deliverable.verdict}`, outputData("DELIVERABLE", deliverable), { swarmId: id, memberId: reviewer.id })
      }
      if (params.action === "recover.members") {
        yield* coordinator(id, ctx)
        const unresolved = (yield* swarms.unboundManagedMemberTargets({ swarmID: id })).filter(
          (target) => target.swarm.status === "active" && target.member.lifecycle === "active",
        )
        const requested = yield* memberWake.request(id)
        return result(
          params.action,
          permission,
          requested ? "Requested Swarm member recovery" : "Swarm recovery runtime unavailable",
          outputData("RECOVERY", {
            requested,
            unresolved: unresolved.map((target) => ({
              memberID: target.member.id,
              name: target.member.name,
              bindingGeneration: target.member.bindingGeneration,
            })),
          }),
          { swarmId: id, count: unresolved.length, status: requested ? "requested" : "runtime_unavailable" },
        )
      }
      if (params.action === "recover.effects") {
        yield* coordinator(id, ctx)
        const pending = (yield* containment.unresolved({ limit: params.limit ?? 32 })).filter(
          (entry) => entry.swarmID === id,
        )
        // Compact operational projection: enough for an operator to act, without
        // replaying transcripts. The decision itself belongs to recover.contain.
        const rows = pending.map((entry) => ({
          taskId: entry.taskID,
          leaseGeneration: entry.leaseGeneration,
          sessionId: entry.sessionID,
          sessionGeneration: entry.sessionGeneration,
          retireReason: entry.retireReason,
          hazards: entry.hazards,
          hasRecoveringOwner: true,
        }))
        return result(
          params.action,
          permission,
          rows.length === 0 ? "No unresolved external effects" : `Unresolved external effects (${rows.length})`,
          outputData("EFFECTS", rows),
          { swarmId: id, count: rows.length, status: rows.length === 0 ? "clear" : "blocked" },
        )
      }
      if (params.action === "recover.contain") {
        yield* coordinator(id, ctx)
        const target = taskID(params.taskId)
        const generation = params.leaseGeneration!
        // Fail closed on Swarm scope: acknowledge only resolves a (task,
        // generation) pair that is durably fenced in *this* Swarm. A bare task id
        // from another Swarm must never be reachable through this action.
        const pending = (yield* containment.unresolved({ limit: 256 })).find(
          (entry) => entry.swarmID === id && entry.taskID === target && entry.leaseGeneration === generation,
        )
        if (!pending)
          throw new Error(
            `No unresolved external effect for task ${target} at lease generation ${generation} in Swarm ${id}. Run recover.effects first.`,
          )
        const acknowledged = yield* containment.acknowledge({ taskID: target, generation })
        if (acknowledged.state !== "contained")
          throw new Error(
            `Containment was not acknowledged for task ${target} (${acknowledged.state}). The execution fence is unchanged and the task stays fenced.`,
          )
        const parked = (yield* swarms.get(id)).tasks.find((task) => task.id === target)
        return result(
          params.action,
          permission,
          `Task ${target} contained; awaiting review`,
          outputData("CONTAINED", {
            taskId: target,
            leaseGeneration: generation,
            sealed: acknowledged.sealed,
            // The external outcome is unknown, not failed and not successful.
            outcome: "unknown",
            taskStatus: parked?.status,
            nextAction: "task.review",
          }),
          { swarmId: id, taskId: target, status: parked?.status },
        )
      }
      if (params.action === "task.review") {
        const { caller } = yield* coordinator(id, ctx)
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
        const task = yield* swarms.reviewTask({
          swarmID: id,
          taskID: taskID(params.taskId),
          reviewerMemberID: caller.id,
          // Required on purpose: the coordinator must decide against the
          // generation it actually observed, so a stale observation fails
          // closed instead of silently reviewing a newer execution.
          expectedLeaseGeneration: params.expectedLeaseGeneration!,
          decision,
        })
        return result(
          params.action,
          permission,
          `Task ${task.status}`,
          outputData("TASK", { ...task, leaseGeneration: task.leaseGeneration }),
          { swarmId: id, taskId: task.id, memberId: caller.id, status: task.status },
        )
      }
      return yield* Effect.die(`Unhandled Swarm action: ${params.action}`)
    })

    return {
      exposure: "lazy" as const,
      description: `${DESCRIPTION}\n\n${ACTION_REQUIREMENTS_DESCRIPTION}`,
      parameters: Parameters,
      execute: (params, ctx) => execute(params, ctx).pipe(Effect.orDie),
    }
  }),
)
