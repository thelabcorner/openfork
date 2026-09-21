import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Swarm } from "@opencode-ai/schema/swarm"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { WorkspaceID } from "@opencode-ai/schema/workspace-id"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Authorization } from "../middleware/authorization"
import { ApiNotFoundError, ConflictError, InvalidCursorError, InvalidRequestError } from "../errors"
import { described } from "./metadata"

const root = "/swarm"

export const SwarmPaths = {
  list: root,
  detail: `${root}/:swarmID`,
  summary: `${root}/:swarmID/summary`,
  messages: `${root}/:swarmID/message`,
  runs: `${root}/:swarmID/run`,
  blackboard: `${root}/:swarmID/blackboard`,
  claims: `${root}/:swarmID/claim`,
  deliverables: `${root}/:swarmID/deliverable`,
  delegate: "/swarm/delegate",
  update: "/swarm/:swarmID",
  memberAdd: "/swarm/:swarmID/member",
  memberLifecycle: "/swarm/:swarmID/member/:memberID/lifecycle",
  memberConfigure: "/swarm/:swarmID/member/:memberID/configure",
  taskCreate: "/swarm/:swarmID/task",
  taskDependencies: "/swarm/:swarmID/task/:taskID/dependencies",
  recover: "/swarm/:swarmID/recover",
} as const

export const SwarmListQuery = Schema.Struct({
  projectID: Schema.optionalKey(ProjectID),
  workspaceID: Schema.optionalKey(WorkspaceID),
  status: Schema.optionalKey(Swarm.Status),
  limit: Schema.optionalKey(Schema.NumberFromString),
})

const PageQuery = Schema.Struct({
  limit: Schema.optionalKey(Schema.NumberFromString),
  cursor: Schema.optionalKey(Schema.String),
})

export const SwarmMessageQuery = PageQuery
export const SwarmRunQuery = Schema.Struct({
  limit: Schema.optionalKey(Schema.NumberFromString),
  cursor: Schema.optionalKey(Schema.String),
  taskID: Schema.optionalKey(Swarm.TaskID),
})
export const SwarmBlackboardQuery = PageQuery
export const SwarmClaimQuery = PageQuery
export const SwarmDeliverableQuery = Schema.Struct({
  limit: Schema.optionalKey(Schema.NumberFromString),
  cursor: Schema.optionalKey(Schema.String),
  memberID: Schema.optionalKey(Swarm.MemberID),
})

export const SwarmDetailResponse = Schema.Struct({
  swarm: Swarm.Info,
  members: Schema.Array(Swarm.Member),
  tasks: Schema.Array(Swarm.Task),
  dependencies: Schema.Array(Swarm.TaskDependency),
}).annotate({ identifier: "SwarmHttpApi.Detail" })

export const SwarmMessageHistoryEntry = Schema.Struct({
  message: Swarm.Message,
  deliveries: Schema.Array(Swarm.Delivery),
}).annotate({ identifier: "SwarmHttpApi.MessageHistoryEntry" })

const page = <A>(item: Schema.Schema<A>, identifier: string) =>
  Schema.Struct({
    items: Schema.Array(item),
    more: Schema.Boolean,
    nextCursor: Schema.optionalKey(Schema.String),
  }).annotate({ identifier })

export const SwarmMessageHistoryPage = page(SwarmMessageHistoryEntry, "SwarmHttpApi.MessageHistoryPage")
export const SwarmTaskRunHistoryPage = page(Swarm.TaskRun, "SwarmHttpApi.TaskRunHistoryPage")
export const SwarmBlackboardPage = page(Swarm.BlackboardEntry, "SwarmHttpApi.BlackboardPage")
export const SwarmClaimPage = page(Swarm.Claim, "SwarmHttpApi.ClaimPage")
export const SwarmDeliverablePage = page(Swarm.Deliverable, "SwarmHttpApi.DeliverablePage")

const DelegateDependency = Schema.Struct({
  key: Schema.String,
  requirement: Schema.optionalKey(Swarm.DependencyRequirement),
})

const DelegateMember = Schema.Struct({
  name: Schema.String,
  role: Schema.String,
  desiredProfile: Swarm.MemberExecutionProfile,
  workspacePolicy: Swarm.WorkspacePolicy,
  capabilities: Schema.optionalKey(Swarm.MemberCapabilities),
})

const DelegateTask = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Schema.Int),
  reservedMemberName: Schema.optionalKey(Schema.String),
  acceptance: Schema.optionalKey(Swarm.TaskAcceptance),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  dependsOn: Schema.optionalKey(Schema.Array(DelegateDependency)),
})

export const SwarmDelegatePayload = Schema.Struct({
  projectID: ProjectID,
  workspaceID: Schema.optionalKey(WorkspaceID),
  directory: Schema.String,
  coordinatorSessionID: SessionID,
  name: Schema.String,
  coordinatorName: Schema.optionalKey(Schema.String),
  coordinatorRole: Schema.optionalKey(Schema.String),
  members: Schema.optionalKey(Schema.Array(DelegateMember)),
  tasks: Schema.optionalKey(Schema.Array(DelegateTask)),
})

export const SwarmDelegateResponse = Schema.Struct({
  swarm: Swarm.Info,
  coordinator: Swarm.Member,
  members: Schema.Array(Swarm.Member),
  tasks: Schema.Array(Swarm.Task),
}).annotate({ identifier: "SwarmHttpApi.DelegateResponse" })

export const SwarmUpdatePayload = Schema.Struct({
  expectedRevision: Schema.Int,
  name: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["active", "paused", "completed", "failed", "archived"])),
  policy: Schema.optionalKey(Swarm.Policy),
})

export const SwarmMemberAddPayload = Schema.Struct({
  name: Schema.String,
  role: Schema.String,
  desiredProfile: Swarm.MemberExecutionProfile,
  workspacePolicy: Swarm.WorkspacePolicy,
  capabilities: Schema.optionalKey(Swarm.MemberCapabilities),
})

export const SwarmMemberLifecyclePayload = Schema.Struct({
  expectedLifecycle: Schema.Literals(["active", "stopped"]),
  lifecycle: Schema.Literals(["active", "stopped"]),
})

export const SwarmMemberConfigurePayload = Schema.Struct({
  expectedBindingGeneration: Schema.Int,
  desiredProfile: Swarm.MemberExecutionProfile,
  workspacePolicy: Swarm.WorkspacePolicy,
  capabilities: Schema.optionalKey(Swarm.MemberCapabilities),
})

const TaskDependency = Schema.Struct({
  taskID: Swarm.TaskID,
  requirement: Schema.optionalKey(Swarm.DependencyRequirement),
})

export const SwarmTaskCreatePayload = Schema.Struct({
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Schema.Int),
  reservedMemberID: Schema.optionalKey(Swarm.MemberID),
  acceptance: Schema.optionalKey(Swarm.TaskAcceptance),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  dependencies: Schema.optionalKey(Schema.Array(TaskDependency)),
})

export const SwarmTaskDependenciesPayload = Schema.Struct({
  dependencies: Schema.Array(TaskDependency),
})

export const SwarmRecoveryResponse = Schema.Struct({
  requested: Schema.Boolean,
  unresolved: Schema.Array(
    Schema.Struct({
      memberID: Swarm.MemberID,
      name: Schema.String,
      bindingGeneration: Schema.Int,
    }),
  ),
}).annotate({ identifier: "SwarmHttpApi.RecoveryResponse" })

const errors = [InvalidRequestError, InvalidCursorError, ApiNotFoundError, ConflictError] as const

export const SwarmApi = HttpApi.make("swarm").add(
  HttpApiGroup.make("swarm")
    .add(
      HttpApiEndpoint.get("list", SwarmPaths.list, {
        query: SwarmListQuery,
        success: described(Schema.Array(Swarm.Summary), "Compact Swarm summaries"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.list",
          summary: "List Swarms",
          description:
            "Bounded Tier 0 summary catalog. Counts are aggregated in bulk and the endpoint never materializes an Instance or hydrates Session history.",
        }),
      ),
      HttpApiEndpoint.get("detail", SwarmPaths.detail, {
        params: { swarmID: Swarm.ID },
        success: described(SwarmDetailResponse, "Swarm roster, tasks, and dependency graph"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.detail",
          summary: "Get Swarm detail",
          description:
            "Durable roster/task projection plus the whole DAG edge set. Live Session status remains owned by Session telemetry.",
        }),
      ),
      HttpApiEndpoint.get("summary", SwarmPaths.summary, {
        params: { swarmID: Swarm.ID },
        success: described(Swarm.Summary, "Compact Swarm summary"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.summary",
          summary: "Get Swarm summary",
          description: "Cheap durable aggregate status without Instance or transcript materialization.",
        }),
      ),
      HttpApiEndpoint.get("messages", SwarmPaths.messages, {
        params: { swarmID: Swarm.ID },
        query: SwarmMessageQuery,
        success: described(SwarmMessageHistoryPage, "Paged Swarm message and delivery history"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.messages",
          summary: "Get Swarm message history",
          description:
            "Newest-first bounded history. Delivery receipts are fetched in one batch for the page; cursor is opaque.",
        }),
      ),
      HttpApiEndpoint.get("runs", SwarmPaths.runs, {
        params: { swarmID: Swarm.ID },
        query: SwarmRunQuery,
        success: described(SwarmTaskRunHistoryPage, "Paged Swarm task-run history"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.runs",
          summary: "Get Swarm task-run history",
          description: "Newest-first bounded run history, optionally scoped to one exact task id.",
        }),
      ),
      HttpApiEndpoint.get("blackboard", SwarmPaths.blackboard, {
        params: { swarmID: Swarm.ID },
        query: SwarmBlackboardQuery,
        success: described(SwarmBlackboardPage, "Paged Swarm blackboard"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.blackboard",
          summary: "Get Swarm blackboard",
          description: "Bounded key-ordered shared-state projection.",
        }),
      ),
      HttpApiEndpoint.get("claims", SwarmPaths.claims, {
        params: { swarmID: Swarm.ID },
        query: SwarmClaimQuery,
        success: described(SwarmClaimPage, "Paged Swarm claims"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.claims",
          summary: "Get Swarm claims",
          description: "Bounded deterministic claim projection; no worker runtime is consulted.",
        }),
      ),
      HttpApiEndpoint.get("deliverables", SwarmPaths.deliverables, {
        params: { swarmID: Swarm.ID },
        query: SwarmDeliverableQuery,
        success: described(SwarmDeliverablePage, "Paged Swarm deliverables"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.deliverables",
          summary: "Get Swarm deliverables",
          description: "Newest-first bounded deliverable ledger, optionally scoped to one exact member id.",
        }),
      ),
      HttpApiEndpoint.post("delegate", SwarmPaths.delegate, {
        payload: SwarmDelegatePayload,
        success: described(SwarmDelegateResponse, "Created native Swarm"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.delegate",
          summary: "Create a native Swarm",
          description:
            "Authenticated operator workflow. All cross references are validated before activation; the supplied coordinator Session is operator intent, not inferred model authority.",
        }),
      ),
      HttpApiEndpoint.patch("update", SwarmPaths.update, {
        params: { swarmID: Swarm.ID },
        payload: SwarmUpdatePayload,
        success: described(Swarm.Info, "Updated Swarm"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.update",
          summary: "Update Swarm state",
          description: "Exact-revision operator mutation for pause/resume/completion/archive and metadata.",
        }),
      ),
      HttpApiEndpoint.post("memberAdd", SwarmPaths.memberAdd, {
        params: { swarmID: Swarm.ID },
        payload: SwarmMemberAddPayload,
        success: described(Swarm.Member, "Added managed Swarm member"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.memberAdd",
          summary: "Add managed member",
          description: "Adds durable managed-worker intent; the process-global member Session owner performs materialization.",
        }),
      ),
      HttpApiEndpoint.patch("memberLifecycle", SwarmPaths.memberLifecycle, {
        params: { swarmID: Swarm.ID, memberID: Swarm.MemberID },
        payload: SwarmMemberLifecyclePayload,
        success: described(Swarm.Member, "Updated member lifecycle"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.memberLifecycle",
          summary: "Stop or resume managed member",
          description:
            "Exact lifecycle mutation. Stop invalidates the Session binding fence; runtime retirement/reconciliation remains owned by canonical process-global services.",
        }),
      ),
      HttpApiEndpoint.patch("memberConfigure", SwarmPaths.memberConfigure, {
        params: { swarmID: Swarm.ID, memberID: Swarm.MemberID },
        payload: SwarmMemberConfigurePayload,
        success: described(Swarm.Member, "Configured managed member"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.memberConfigure",
          summary: "Configure member execution profile",
          description:
            "Requires the managed member to be stopped and unbound at the exact binding generation; resume creates a fresh Session from the new intent.",
        }),
      ),
      HttpApiEndpoint.post("taskCreate", SwarmPaths.taskCreate, {
        params: { swarmID: Swarm.ID },
        payload: SwarmTaskCreatePayload,
        success: described(Swarm.Task, "Created Swarm task"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.taskCreate",
          summary: "Create Swarm task",
          description:
            "Operator-authored task intent. No member identity is accepted or synthesized; optional reservation uses an exact member id.",
        }),
      ),
      HttpApiEndpoint.put("taskDependencies", SwarmPaths.taskDependencies, {
        params: { swarmID: Swarm.ID, taskID: Swarm.TaskID },
        payload: SwarmTaskDependenciesPayload,
        success: described(Swarm.Task, "Updated task dependencies"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.taskDependencies",
          summary: "Replace task dependencies",
          description: "Validated whole-edge replacement with native DAG cycle checks.",
        }),
      ),
      HttpApiEndpoint.post("recover", SwarmPaths.recover, {
        params: { swarmID: Swarm.ID },
        success: described(SwarmRecoveryResponse, "Requested member reconciliation"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "swarm.recover",
          summary: "Request member recovery",
          description:
            "Requests the existing disposable reconciliation wake only. Durable state and the process-global member Session owner retain correctness and execution ownership.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "swarm",
        description: "Tier 0 first-party durable Swarm inspection API.",
      }),
    )
    .middleware(Authorization),
)
