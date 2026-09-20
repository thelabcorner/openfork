export * as Swarm from "./swarm"

import { Schema } from "effect"
import { Agent } from "./agent"
import { define, inventory } from "./event"
import { descending } from "./identifier"
import { Model } from "./model"
import { Permission } from "./permission"
import { ProjectID } from "./project-id"
import { DateTimeUtcFromMillis, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"
import { SwarmID } from "./swarm-id"
import { WorkspaceID } from "./workspace-id"

export const ID = SwarmID
export type ID = SwarmID

function childID<const Prefix extends string, const Brand extends string>(prefix: Prefix, brand: Brand) {
  return Schema.String.check(Schema.isStartsWith(prefix)).pipe(
    Schema.brand(brand),
    statics((schema) => ({ create: () => schema.make(prefix + descending()) })),
  )
}

export const MemberID = childID("swm_", "SwarmMemberID")
export type MemberID = typeof MemberID.Type
export const TaskID = childID("swt_", "SwarmTaskID")
export type TaskID = typeof TaskID.Type
export const TaskRunID = childID("swrn_", "SwarmTaskRunID")
export type TaskRunID = typeof TaskRunID.Type
export const MessageID = childID("swmsg_", "SwarmMessageID")
export type MessageID = typeof MessageID.Type
export const DeliveryID = childID("swd_", "SwarmDeliveryID")
export type DeliveryID = typeof DeliveryID.Type
export const DeliverableID = childID("swdlv_", "SwarmDeliverableID")
export type DeliverableID = typeof DeliverableID.Type

export const Status = Schema.Literals([
  "creating",
  "active",
  "paused",
  "stopping",
  "completed",
  "failed",
  "archived",
]).annotate({ identifier: "Swarm.Status" })
export type Status = typeof Status.Type

export const MemberKind = Schema.Literals(["coordinator", "managed_worker", "external", "guest"]).annotate({
  identifier: "Swarm.MemberKind",
})
export type MemberKind = typeof MemberKind.Type

export const MemberLifecycle = Schema.Literals(["active", "held", "stopping", "stopped"]).annotate({
  identifier: "Swarm.MemberLifecycle",
})
export type MemberLifecycle = typeof MemberLifecycle.Type

export const WorkspacePolicy = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("shared-read") }),
  Schema.Struct({ mode: Schema.Literal("shared-write") }),
  Schema.Struct({
    mode: Schema.Literal("worktree"),
    baseRef: optional(Schema.String),
  }),
]).annotate({ identifier: "Swarm.WorkspacePolicy" })
export type WorkspacePolicy = typeof WorkspacePolicy.Type

export interface MemberExecutionProfile extends Schema.Schema.Type<typeof MemberExecutionProfile> {}
export const MemberExecutionProfile = Schema.Struct({
  agent: Agent.ID,
  model: Model.Ref,
  permissionBoundary: Permission.Boundary,
  requestedCapabilities: optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Swarm.MemberExecutionProfile" })

export interface MemberCapabilities extends Schema.Schema.Type<typeof MemberCapabilities> {}
export const MemberCapabilities = Schema.Struct({
  tags: Schema.Array(Schema.String),
}).annotate({ identifier: "Swarm.MemberCapabilities" })

/**
 * Deliberately small in the first milestone. New policy knobs may be added as
 * optional fields without changing the relational schema.
 */
export interface Policy extends Schema.Schema.Type<typeof Policy> {}
export const Policy = Schema.Struct({}).annotate({ identifier: "Swarm.Policy" })

export const TaskStatus = Schema.Literals([
  "pending",
  "blocked",
  "ready",
  "working",
  "review_pending",
  "changes_requested",
  "completed",
  "failed",
  "cancelled",
]).annotate({ identifier: "Swarm.TaskStatus" })
export type TaskStatus = typeof TaskStatus.Type

export const DependencyRequirement = Schema.Literals(["require_success", "require_terminal"]).annotate({
  identifier: "Swarm.DependencyRequirement",
})
export type DependencyRequirement = typeof DependencyRequirement.Type

export const LeaseState = Schema.Literals(["active", "human_hold", "retiring"]).annotate({
  identifier: "Swarm.LeaseState",
})
export type LeaseState = typeof LeaseState.Type

export const TaskRunStatus = Schema.Literals([
  "admitted",
  "running",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]).annotate({ identifier: "Swarm.TaskRunStatus" })
export type TaskRunStatus = typeof TaskRunStatus.Type

export const TaskFailureKind = Schema.Literals([
  "semantic",
  "provider",
  "tool",
  "permission",
  "timeout",
  "session_aborted",
  "stale_binding",
  "stale_lease",
  "internal",
]).annotate({ identifier: "Swarm.TaskFailureKind" })
export type TaskFailureKind = typeof TaskFailureKind.Type

export interface TaskAcceptance extends Schema.Schema.Type<typeof TaskAcceptance> {}
export const TaskAcceptance = Schema.Struct({
  criteria: Schema.Array(Schema.String),
}).annotate({ identifier: "Swarm.TaskAcceptance" })

export const MessageKind = Schema.Literals([
  "message",
  "request",
  "response",
  "finding",
  "handoff",
  "blocker",
  "decision",
  "review",
  "control",
]).annotate({
  identifier: "Swarm.MessageKind",
})
export type MessageKind = typeof MessageKind.Type

export const MessagePriority = Schema.Literals(["low", "normal", "high", "urgent"]).annotate({
  identifier: "Swarm.MessagePriority",
})
export type MessagePriority = typeof MessagePriority.Type

export const DeliveryState = Schema.Literals(["pending", "claimed", "admitted", "expired", "failed"]).annotate({
  identifier: "Swarm.DeliveryState",
})
export type DeliveryState = typeof DeliveryState.Type

export const DeliverableVerdict = Schema.Literals(["accepted", "rejected"]).annotate({
  identifier: "Swarm.DeliverableVerdict",
})
export type DeliverableVerdict = typeof DeliverableVerdict.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectID,
  directory: Schema.String,
  workspaceID: optional(WorkspaceID),
  name: Schema.String,
  status: Status,
  coordinatorMemberID: optional(MemberID),
  policy: Policy,
  revision: Schema.Int,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: optional(DateTimeUtcFromMillis),
    archived: optional(DateTimeUtcFromMillis),
  }),
}).annotate({ identifier: "Swarm.Info" })

export interface Member extends Schema.Schema.Type<typeof Member> {}
export const Member = Schema.Struct({
  id: MemberID,
  swarmID: ID,
  name: Schema.String,
  kind: MemberKind,
  role: Schema.String,
  lifecycle: MemberLifecycle,
  sessionID: optional(SessionID),
  bindingGeneration: Schema.Int,
  desiredProfile: optional(MemberExecutionProfile),
  workspacePolicy: WorkspacePolicy,
  capabilities: optional(MemberCapabilities),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    stopped: optional(DateTimeUtcFromMillis),
  }),
}).annotate({ identifier: "Swarm.Member" })

export interface Task extends Schema.Schema.Type<typeof Task> {}
export const Task = Schema.Struct({
  id: TaskID,
  swarmID: ID,
  title: Schema.String,
  description: optional(Schema.String),
  status: TaskStatus,
  priority: Schema.Int,
  createdByMemberID: optional(MemberID),
  reservedMemberID: optional(MemberID),
  reservedUntil: optional(DateTimeUtcFromMillis),
  reservationRevision: Schema.Int,
  leaseGeneration: Schema.Int,
  semanticRetryCount: Schema.Int,
  acceptance: TaskAcceptance,
  metadata: Schema.Record(Schema.String, Schema.Json),
  readyAt: optional(DateTimeUtcFromMillis),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: optional(DateTimeUtcFromMillis),
  }),
}).annotate({ identifier: "Swarm.Task" })

export interface TaskDependency extends Schema.Schema.Type<typeof TaskDependency> {}
export const TaskDependency = Schema.Struct({
  taskID: TaskID,
  dependsOnTaskID: TaskID,
  requirement: DependencyRequirement,
}).annotate({ identifier: "Swarm.TaskDependency" })

export interface TaskLease extends Schema.Schema.Type<typeof TaskLease> {}
export const TaskLease = Schema.Struct({
  taskID: TaskID,
  generation: Schema.Int,
  ownerMemberID: MemberID,
  ownerSessionID: SessionID,
  ownerBindingGeneration: Schema.Int,
  leaseOwnerProcess: Schema.String,
  state: LeaseState,
  holdUserSeq: optional(Schema.Int),
  holdStartedAt: optional(DateTimeUtcFromMillis),
  holdDeadline: optional(DateTimeUtcFromMillis),
  retireReason: optional(Schema.String),
  retireRequestedAt: optional(DateTimeUtcFromMillis),
  acquiredAt: DateTimeUtcFromMillis,
  expiresAt: DateTimeUtcFromMillis,
  renewedAt: optional(DateTimeUtcFromMillis),
}).annotate({ identifier: "Swarm.TaskLease" })

export interface TaskRun extends Schema.Schema.Type<typeof TaskRun> {}
export const TaskRun = Schema.Struct({
  id: TaskRunID,
  taskID: TaskID,
  memberID: MemberID,
  sessionID: SessionID,
  bindingGeneration: Schema.Int,
  leaseGeneration: Schema.Int,
  sessionInputID: SessionMessage.ID,
  status: TaskRunStatus,
  failureKind: optional(TaskFailureKind),
  failureDetail: optional(Schema.String),
  admittedAt: optional(DateTimeUtcFromMillis),
  startedAt: optional(DateTimeUtcFromMillis),
  endedAt: optional(DateTimeUtcFromMillis),
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Swarm.TaskRun" })

export interface Message extends Schema.Schema.Type<typeof Message> {}
export const Message = Schema.Struct({
  id: MessageID,
  swarmID: ID,
  senderMemberID: MemberID,
  /** Immutable Session binding that authored this message at enqueue time. */
  senderSessionID: SessionID,
  /** Member binding generation paired with senderSessionID; rebinding never rewrites provenance. */
  senderBindingGeneration: Schema.Int,
  kind: MessageKind,
  body: Schema.String,
  taskID: optional(TaskID),
  correlationID: optional(Schema.String),
  responseTo: optional(MessageID),
  priority: MessagePriority,
  /** False is a structural fire-and-forget contract, never inferred from text. */
  replyExpected: Schema.Boolean,
  createdAt: DateTimeUtcFromMillis,
  expiresAt: optional(DateTimeUtcFromMillis),
}).annotate({ identifier: "Swarm.Message" })

export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}
export const Delivery = Schema.Struct({
  id: DeliveryID,
  messageID: MessageID,
  recipientMemberID: MemberID,
  state: DeliveryState,
  sessionInputID: SessionMessage.ID,
  claimGeneration: Schema.Int,
  claimOwner: optional(Schema.String),
  claimExpiresAt: optional(DateTimeUtcFromMillis),
  nextAttemptAt: optional(DateTimeUtcFromMillis),
  attemptCount: Schema.Int,
  admittedSessionID: optional(SessionID),
  admittedSeq: optional(Schema.Int),
  admittedAt: optional(DateTimeUtcFromMillis),
  error: optional(Schema.String),
}).annotate({ identifier: "Swarm.Delivery" })

export interface BlackboardEntry extends Schema.Schema.Type<typeof BlackboardEntry> {}
export const BlackboardEntry = Schema.Struct({
  swarmID: ID,
  key: Schema.String,
  value: Schema.Json,
  contentType: Schema.String,
  version: Schema.Int,
  authorMemberID: MemberID,
  taskID: optional(TaskID),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Swarm.BlackboardEntry" })

export interface Claim extends Schema.Schema.Type<typeof Claim> {}
export const Claim = Schema.Struct({
  swarmID: ID,
  memberID: MemberID,
  scope: Schema.String,
  generation: Schema.Int,
  expiresAt: optional(DateTimeUtcFromMillis),
  releasedAt: optional(DateTimeUtcFromMillis),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Swarm.Claim" })

export interface Deliverable extends Schema.Schema.Type<typeof Deliverable> {}
export const Deliverable = Schema.Struct({
  id: DeliverableID,
  swarmID: ID,
  memberID: MemberID,
  taskRunID: optional(TaskRunID),
  summary: Schema.String,
  refs: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  verdict: optional(DeliverableVerdict),
  verdictByMemberID: optional(MemberID),
  createdAt: DateTimeUtcFromMillis,
  verdictAt: optional(DateTimeUtcFromMillis),
}).annotate({ identifier: "Swarm.Deliverable" })

export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({
  swarm: Info,
  memberCount: Schema.Int,
  boundMemberCount: Schema.Int,
  readyTaskCount: Schema.Int,
  workingTaskCount: Schema.Int,
  pendingDeliveryCount: Schema.Int,
}).annotate({ identifier: "Swarm.Summary" })

export interface Detail extends Schema.Schema.Type<typeof Detail> {}
export const Detail = Schema.Struct({
  swarm: Info,
  members: Schema.Array(Member),
  tasks: Schema.Array(Task),
}).annotate({ identifier: "Swarm.Detail" })

/**
 * Bounded navigation projection consumed by SessionGroup/UI composition.
 * Deliberately excludes task/message/history/runtime state.
 */
export interface NavigationMember extends Schema.Schema.Type<typeof NavigationMember> {}
export const NavigationMember = Schema.Struct({
  memberID: MemberID,
  sessionID: SessionID,
  title: Schema.String,
  slug: Schema.String,
  projectID: ProjectID,
  directory: Schema.String,
  parentID: optional(SessionID),
  version: Schema.String,
  position: Schema.Int,
  timeAdded: DateTimeUtcFromMillis,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    archived: optional(DateTimeUtcFromMillis),
  }),
}).annotate({ identifier: "Swarm.NavigationMember" })

export interface NavigationGroup extends Schema.Schema.Type<typeof NavigationGroup> {}
export const NavigationGroup = Schema.Struct({
  swarm: Info,
  coordinatorSessionID: optional(SessionID),
  members: Schema.Array(NavigationMember),
}).annotate({ identifier: "Swarm.NavigationGroup" })

const Created = define({
  type: "swarm.created",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, info: Info },
})
const Updated = define({
  type: "swarm.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, info: Info },
})
const MemberUpdated = define({
  type: "swarm.member.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, member: Member },
})
const TaskUpdated = define({
  type: "swarm.task.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, task: Task },
})
const TaskDependenciesUpdated = define({
  type: "swarm.task.dependencies.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, task: Task, dependencies: Schema.Array(TaskDependency) },
})
const TaskLeaseUpdated = define({
  type: "swarm.task.lease.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, task: Task, lease: optional(TaskLease) },
})
const TaskRunUpdated = define({
  type: "swarm.task.run.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, task: Task, run: TaskRun, lease: optional(TaskLease) },
})
const MessageCreated = define({
  type: "swarm.message.created",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, message: Message, deliveries: Schema.Array(Delivery) },
})
const DeliveryUpdated = define({
  type: "swarm.delivery.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, delivery: Delivery },
})
const BlackboardUpdated = define({
  type: "swarm.blackboard.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, entry: BlackboardEntry },
})
const ClaimUpdated = define({
  type: "swarm.claim.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, claim: Claim },
})
const DeliverableUpdated = define({
  type: "swarm.deliverable.updated",
  durable: { version: 1, aggregate: "swarmID" },
  schema: { swarmID: ID, deliverable: Deliverable },
})

export const Event = {
  Created,
  Updated,
  MemberUpdated,
  TaskUpdated,
  TaskDependenciesUpdated,
  TaskLeaseUpdated,
  TaskRunUpdated,
  MessageCreated,
  DeliveryUpdated,
  BlackboardUpdated,
  ClaimUpdated,
  DeliverableUpdated,
  Definitions: inventory(
    Created,
    Updated,
    MemberUpdated,
    TaskUpdated,
    TaskDependenciesUpdated,
    TaskLeaseUpdated,
    TaskRunUpdated,
    MessageCreated,
    DeliveryUpdated,
    BlackboardUpdated,
    ClaimUpdated,
    DeliverableUpdated,
  ),
} as const
