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

/**
 * Closed vocabulary of provider/model runtime capabilities a managed member can
 * require from its execution profile.
 *
 * This is a deliberately different axis from {@link MemberCapabilities} `tags`.
 * Tags are semantic/routing labels a coordinator invents ("research", "audit",
 * "preregistration"). Model requirements are provider/model facts the runtime
 * resolves against the live catalog and can prove or disprove. The two used to
 * share one unvalidated `requestedCapabilities: string[]`, which let a persisted
 * Swarm request the tag "preregistration" and leave every worker permanently
 * unbound with zero task runs. Making this a closed set makes that unrepresentable.
 */
export const ModelRequirement = Schema.Literals([
  "toolcall",
  "reasoning",
  "attachment",
  "temperature",
  "input_text",
  "input_audio",
  "input_image",
  "input_video",
  "input_pdf",
  "output_text",
  "output_audio",
  "output_image",
  "output_video",
  "output_pdf",
]).annotate({ identifier: "Swarm.ModelRequirement" })
export type ModelRequirement = typeof ModelRequirement.Type

export interface MemberExecutionProfile extends Schema.Schema.Type<typeof MemberExecutionProfile> {}
export const MemberExecutionProfile = Schema.Struct({
  agent: Agent.ID,
  model: Model.Ref,
  permissionBoundary: Permission.Boundary,
  /**
   * Capabilities the resolved provider/model must actually publish. Every entry
   * is checked before the first durable Swarm write and again before the managed
   * member Session is materialized.
   *
   * Rows persisted before this rename carry the retired `requestedCapabilities`
   * key. That key is a migration input only: it is absent from this contract and
   * never re-encoded. Read it through {@link normalizeLegacyExecutionProfile},
   * which recovers recognized runtime requirements and refuses to silently
   * weaken an unrecognized one.
   */
  modelRequirements: optional(Schema.Array(ModelRequirement)),
}).annotate({ identifier: "Swarm.MemberExecutionProfile" })

export interface MemberCapabilities extends Schema.Schema.Type<typeof MemberCapabilities> {}
export const MemberCapabilities = Schema.Struct({
  /** Semantic/routing labels for this member. Never a provider/model requirement. */
  tags: Schema.Array(Schema.String),
  /**
   * Legacy stored capability values that were actually semantic routing tags.
   * Reported for operator visibility only; never a reason to refuse a member.
   */
  legacyRoutingTags: optional(Schema.Array(Schema.String)),
  /**
   * Legacy stored capability values this runtime cannot map onto the closed
   * {@link ModelRequirement} vocabulary and therefore cannot prove against the
   * model catalog.
   *
   * A non-empty list is a fail-closed signal: the member's historical profile
   * expressed a constraint nothing can verify, so it must not be materialized
   * rather than silently run against a possibly-wrong model.
   */
  legacyUnprovenRequirements: optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Swarm.MemberCapabilities" })

/**
 * Legacy `requestedCapabilities` spellings that were real provider/model runtime
 * capabilities, mapped onto the closed {@link ModelRequirement} vocabulary.
 *
 * Keys are compared after trim + lowercase, matching the retired runtime
 * matcher. Anything absent here is NOT silently discarded; see
 * {@link normalizeLegacyExecutionProfile}.
 */
export const LEGACY_MODEL_REQUIREMENT_ALIASES: { readonly [legacy: string]: ModelRequirement } = {
  tools: "toolcall",
  toolcall: "toolcall",
  reasoning: "reasoning",
  attachment: "attachment",
  temperature: "temperature",
  text: "input_text",
  "input:text": "input_text",
  input_text: "input_text",
  audio: "input_audio",
  "input:audio": "input_audio",
  input_audio: "input_audio",
  image: "input_image",
  "input:image": "input_image",
  input_image: "input_image",
  video: "input_video",
  "input:video": "input_video",
  input_video: "input_video",
  pdf: "input_pdf",
  "input:pdf": "input_pdf",
  input_pdf: "input_pdf",
  "output:text": "output_text",
  output_text: "output_text",
  "output:audio": "output_audio",
  output_audio: "output_audio",
  "output:image": "output_image",
  output_image: "output_image",
  "output:video": "output_video",
  output_video: "output_video",
  "output:pdf": "output_pdf",
  output_pdf: "output_pdf",
}

/**
 * Semantic routing tags observed in persisted `requestedCapabilities` columns.
 *
 * These were never provider/model requirements, so keeping them as requirements
 * stranded their members forever. They are reported (see
 * {@link normalizeLegacyExecutionProfile}) rather than migrated, because this
 * schema cannot authoritatively rewrite the member's separate `tags` column.
 */
export const LEGACY_SEMANTIC_ROUTING_TAGS: readonly string[] = ["research", "preregistration", "audit", "adversarial"]

export interface LegacyProfileNormalization {
  readonly profile: MemberExecutionProfile
  /** Legacy values recognized as semantic routing tags; reported, not migrated. */
  readonly routingTags: readonly string[]
  /** Legacy values that cannot be proven against the model catalog. */
  readonly unproven: readonly string[]
}

/**
 * Compatibility boundary for durable `desired_profile` JSON written before
 * {@link ModelRequirement} existed.
 *
 * Raw hydration means historical rows still carry `requestedCapabilities`. The
 * contract intentionally has no such key, so this function is the one place
 * that converts stored state into the current contract:
 *
 * - recognized runtime aliases migrate to `modelRequirements`;
 * - recognized semantic routing tags are reported, not silently reinterpreted;
 * - anything else is reported as unproven, so the member fails closed instead
 *   of running against a model that may not satisfy the original constraint.
 *
 * Pure: safe to call from a read projection.
 */
export function normalizeLegacyExecutionProfile(stored: unknown): LegacyProfileNormalization {
  const raw = (stored && typeof stored === "object" ? stored : {}) as {
    requestedCapabilities?: unknown
    modelRequirements?: unknown
  }
  const legacy = Array.isArray(raw.requestedCapabilities) ? raw.requestedCapabilities : []
  const current = Array.isArray(raw.modelRequirements) ? (raw.modelRequirements as ModelRequirement[]) : []

  const migrated = new Set<ModelRequirement>(current)
  const routingTags: string[] = []
  const unproven: string[] = []
  const semantic = new Set(LEGACY_SEMANTIC_ROUTING_TAGS)

  for (const value of legacy) {
    if (typeof value !== "string") {
      unproven.push(`legacy capability entry is not a string: ${JSON.stringify(value)}`)
      continue
    }
    const key = value.trim().toLowerCase()
    const alias = LEGACY_MODEL_REQUIREMENT_ALIASES[key]
    if (alias) {
      migrated.add(alias)
      continue
    }
    if (semantic.has(key)) {
      routingTags.push(value.trim())
      continue
    }
    unproven.push(`"${value}" is not a known model requirement and cannot be proven against the model catalog`)
  }

  const profile: Record<string, unknown> = { ...(stored as Record<string, unknown>) }
  delete profile.requestedCapabilities
  if (migrated.size > 0) profile.modelRequirements = [...migrated]
  else delete profile.modelRequirements
  return {
    profile: profile as unknown as MemberExecutionProfile,
    routingTags,
    unproven,
  }
}

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
  // Execution reached a proven quiescent end but the worker never settled the
  // task semantically. Truthfully distinct from completed (never claimed
  // success) and from failed (never a semantic failure), and terminal so no
  // later lifecycle path can mistake the run for live work.
  "unsettled",
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
  /** Bounded result authored by the worker that successfully completed this run. */
  resultSummary: optional(Schema.String),
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

/**
 * Compact, bounded lifecycle observability for exactly one Swarm.
 *
 * Authoritative source: durable `swarm_*` rows only, grouped by the Swarm domain
 * owner at read time. No field may be reconstructed from Session message
 * history, part scans, rendered timeline rows, or a client-side recount, and no
 * consumer may re-derive these numbers per rendered row.
 *
 * The counters deliberately keep three terminal run facts apart so operational
 * observability cannot manufacture semantic truth:
 *
 * - `completed`/`failed` are explicit settlements the worker (or a reviewer)
 *   actually declared;
 * - `unsettled` is a proven quiescent execution end with **no** semantic
 *   settlement — neither success nor failure;
 * - `superseded` plus `unowned` are operational churn: authority loss, expiry,
 *   preemption, or an assignment whose lease is gone.
 */
export interface Reliability extends Schema.Schema.Type<typeof Reliability> {}
export const Reliability = Schema.Struct({
  tasks: Schema.Struct({
    total: Schema.Int,
    pending: Schema.Int,
    blocked: Schema.Int,
    ready: Schema.Int,
    working: Schema.Int,
    reviewPending: Schema.Int,
    changesRequested: Schema.Int,
    completed: Schema.Int,
    failed: Schema.Int,
    cancelled: Schema.Int,
  }).annotate({ identifier: "Swarm.ReliabilityTasks" }),
  runs: Schema.Struct({
    total: Schema.Int,
    admitted: Schema.Int,
    running: Schema.Int,
    completed: Schema.Int,
    failed: Schema.Int,
    cancelled: Schema.Int,
    unsettled: Schema.Int,
    superseded: Schema.Int,
    /** Failed runs whose durable `failure_kind` is `semantic` (task-true failure). */
    semanticFailure: Schema.Int,
    /** Failed runs whose durable `failure_kind` is anything operational. */
    operationalFailure: Schema.Int,
    /**
     * Admitted/running runs with no owning lease. An owning lease is `active`
     * **or** `human_hold`: a human-preempted lease still fences its run, so it
     * must not be reported as lost authority. A non-zero value means execution
     * authority was actually replaced while the run still looks live, which is
     * the measurable pre-condition of an uncontrolled replay loop.
     */
    unowned: Schema.Int,
  }).annotate({ identifier: "Swarm.ReliabilityRuns" }),
  leases: Schema.Struct({
    active: Schema.Int,
    humanHold: Schema.Int,
    retiring: Schema.Int,
    /** Non-retiring leases whose deadline is already past at read time. */
    expired: Schema.Int,
  }).annotate({ identifier: "Swarm.ReliabilityLeases" }),
  members: Schema.Struct({
    total: Schema.Int,
    managedWorker: Schema.Int,
    boundManagedWorker: Schema.Int,
    /**
     * Managed workers holding a durable desired execution profile but no live
     * Session binding. This proves an unbound roster intent, **not** that
     * materialization failed: a worker that was simply never dispatched has the
     * same shape. Materialization failure still requires a durable
     * materialization-outcome field owned by the creation-preflight lane.
     */
    unboundConfiguredManagedWorker: Schema.Int,
    held: Schema.Int,
    stopped: Schema.Int,
  }).annotate({ identifier: "Swarm.ReliabilityMembers" }),
  collaboration: Schema.Struct({
    messages: Schema.Int,
    deliveries: Schema.Int,
    pendingDeliveries: Schema.Int,
    claimedDeliveries: Schema.Int,
    admittedDeliveries: Schema.Int,
    expiredDeliveries: Schema.Int,
    failedDeliveries: Schema.Int,
    /** Deliveries that needed at least one retry/defer cycle. */
    retriedDeliveries: Schema.Int,
    blackboardEntries: Schema.Int,
    /** Successful Blackboard writes: initial create plus every CAS overwrite. */
    blackboardWrites: Schema.Int,
    /** Retained claim rows for this Swarm, including released and expired ones. */
    totalClaimRows: Schema.Int,
    deliverables: Schema.Int,
    deliverablesAwaitingVerdict: Schema.Int,
  }).annotate({ identifier: "Swarm.ReliabilityCollaboration" }),
}).annotate({ identifier: "Swarm.Reliability" })

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
