import { Schema } from "effect"
import { SwarmCreationKey } from "@/swarm/creation-key"
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
      "Explicit managed-worker execution profile: agent must be swarm-m, provider/model is selected independently, with hard permissionBoundary and optional model requirements.",
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
  providerID: Provider.ID.annotate({ description: "Managed worker model provider id." }),
  modelID: Model.ID.annotate({ description: "Exact catalog model ID. For OpenCode Go, choose either an account-qualified modelID or a base modelID with the matching stable accountID; do not mix two different account selectors." }),
  accountID: Schema.optional(Schema.String).annotate({
    description: "Optional stable provider account ID from the live model catalog (e.g. zen-...). Display labels such as key3 are not IDs. Do not combine a modelID ending in @accountID with a different accountID.",
  }),
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
  attachments: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional symbolic handles for user uploads to deliver to the assigned member's initial model request. Only handles shown in the coordinator's attachment manifest, returned by an explicit session-index lookup, or already granted are accepted; omitted or empty means no attachments.",
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
  requestKey: Schema.optional(SwarmCreationKey.Input).annotate({
    description: "Optional retry-safe creation key (1-128 ASCII letters/digits/._:-). Reusing the same key from this coordinator Session never creates another Swarm; on conflict inspect the reported swarmId rather than assuming completion.",
  }),
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
      "Managed workers always run in the dedicated swarm-m agent mode. Choose provider/model separately. permissionBoundary is explicit; workspace safely defaults to shared-read.",
  }),
  tasks: Schema.optional(Schema.Array(TaskInput)).annotate({
    description: "Initial task DAG. dependsOn references initial task keys. Keys remain addressable by later lazy swarm task.batch calls; stage large requests based on measured failure risk.",
  }),
})

export type Params = Schema.Schema.Type<typeof Parameters>
