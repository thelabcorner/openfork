import { Schema } from "effect"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Permission } from "@opencode-ai/schema/permission"
import { Provider } from "@opencode-ai/schema/provider"
import { Swarm as SwarmModel } from "@opencode-ai/schema/swarm"

export const DependencyInput = Schema.Struct({
  key: Schema.String.annotate({
    description: "Request-local predecessor task key.",
  }),
  requirement: Schema.optional(SwarmModel.DependencyRequirement).annotate({
    description: "Dependency gate; defaults to require_success.",
  }),
})

/**
 * Compatibility shape owned by the lazy/admin Swarm surface and OXP.
 *
 * Keep this nested wire contract stable for existing callers. The eager
 * creation facade intentionally projects a flatter CreateMemberInput below.
 */
export const DelegateMemberInput = Schema.Struct({
  name: Schema.String.annotate({ description: "Unique worker roster name." }),
  role: Schema.String.annotate({ description: "Concise worker role." }),
  desiredProfile: SwarmModel.MemberExecutionProfile.annotate({
    description:
      "Explicit managed-worker execution profile: agent, provider/model, hard permissionBoundary, and optional model requirements.",
  }),
  workspacePolicy: SwarmModel.WorkspacePolicy.annotate({
    description: "Worker workspace policy: shared-read, shared-write, or isolated worktree.",
  }),
  capabilities: Schema.optional(SwarmModel.MemberCapabilities).annotate({
    description: "Optional routing/capability metadata; not provider model capabilities.",
  }),
})

/**
 * Provider-facing creation member.
 *
 * Creation telemetry showed models correctly constructed every execution-profile
 * leaf but misplaced workspacePolicy outside members[]. Flatten the profile and
 * workspace fields here so the common one-call path cannot fail on wrapper
 * nesting. SwarmCommand still receives the exact canonical nested structures.
 */
export const CreateMemberInput = Schema.Struct({
  name: Schema.String.annotate({ description: "Unique worker roster name." }),
  role: Schema.String.annotate({ description: "Concise worker role." }),
  agent: Agent.ID.annotate({ description: "Managed worker agent id." }),
  providerID: Provider.ID.annotate({ description: "Managed worker model provider id." }),
  modelID: Model.ID.annotate({ description: "Managed worker model id." }),
  accountID: Schema.optional(Schema.String).annotate({ description: "Optional provider account id." }),
  variant: Schema.optional(Model.VariantID).annotate({ description: "Optional model variant id." }),
  permissionBoundary: Permission.Boundary.annotate({
    description:
      "Explicit hard execution ceiling as [{action, resource, effect}]. Saved approvals can never override a deny in this boundary.",
  }),
  modelRequirements: Schema.optional(Schema.Array(SwarmModel.ModelRequirement)).annotate({
    description: "Optional closed provider/model capability requirements.",
  }),
  workspace: Schema.optional(Schema.Literals(["shared-read", "shared-write", "worktree"])).annotate({
    description: "Worker workspace mode. Omit for the safe default shared-read.",
  }),
  worktreeBaseRef: Schema.optional(Schema.String).annotate({
    description: "Optional base ref when workspace=worktree; invalid for other workspace modes.",
  }),
  capabilities: Schema.optional(SwarmModel.MemberCapabilities).annotate({
    description: "Optional semantic routing metadata; never provider/model requirements.",
  }),
})

export const TaskInput = Schema.Struct({
  key: Schema.String.annotate({
    description: "Unique request-local task key used by dependsOn.",
  }),
  title: Schema.String.annotate({ description: "Human-readable task title." }),
  description: Schema.optional(Schema.String).annotate({
    description: "Worker instructions for this task.",
  }),
  priority: Schema.optional(Schema.Int).annotate({
    description: "Scheduler priority.",
  }),
  reservedMemberName: Schema.optional(Schema.String).annotate({
    description: "Reserve this task to a managed worker roster name.",
  }),
  acceptance: Schema.optional(SwarmModel.TaskAcceptance).annotate({
    description: "Explicit acceptance criteria.",
  }),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)).annotate({
    description: "Structured low-authority task metadata.",
  }),
  dependsOn: Schema.optional(Schema.Array(DependencyInput)).annotate({
    description: "Prerequisite task keys. Dependencies may reference tasks declared later in the same request.",
  }),
})

/**
 * Provider-visible creation-only facade.
 *
 * This is intentionally much narrower than the lazy composite Swarm admin tool:
 * no inner action, no Swarm/member/task ids, no broker contract, and no runtime
 * authority tokens. The host derives project/workspace/coordinator Session and
 * delegates to the exact same SwarmCommand workflow used by lazy delegate.
 */
export const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "Name for the new native Swarm.",
  }),
  coordinatorName: Schema.optional(Schema.String).annotate({
    description: "Optional coordinator roster name; defaults to coordinator.",
  }),
  coordinatorRole: Schema.optional(Schema.String).annotate({
    description: "Optional coordinator role; defaults to coordinator.",
  }),
  members: Schema.optional(Schema.Array(CreateMemberInput)).annotate({
    description:
      "Managed workers using flat execution fields. permissionBoundary is explicit; workspace safely defaults to shared-read.",
  }),
  tasks: Schema.optional(Schema.Array(TaskInput)).annotate({
    description: "Initial task DAG. dependsOn references request-local task keys.",
  }),
})

export type Params = Schema.Schema.Type<typeof Parameters>
