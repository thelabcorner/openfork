import { Effect } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRender } from "@opencode-ai/core/swarm/render"
import { InstanceState } from "@/effect/instance-state"
import { SwarmCommand } from "@/swarm/command"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import * as Tool from "./tool"
import { Parameters, type Params } from "./swarm-create-schema"

type Metadata = {
  action: "create"
  permission: "swarm.member"
  swarmId: string
  coordinatorMemberId: string
  managedMemberCount: number
  taskCount: number
  status: string
}

function required(value: string, name: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function outputData(value: unknown) {
  return ["[SWARM CREATED]", SwarmRender.fence(JSON.stringify(value, null, 2))].join("\n")
}

type CreateMember = NonNullable<Params["members"]>[number]

function canonicalMember(member: CreateMember) {
  const workspace = member.workspace ?? "shared-read"
  if (member.worktreeBaseRef !== undefined && workspace !== "worktree")
    throw new Tool.InvalidArgumentsError({
      tool: "swarm_create",
      detail: "members[].worktreeBaseRef is only valid when members[].workspace is \"worktree\"",
    })

  return {
    name: required(member.name, "members[].name"),
    role: required(member.role, "members[].role"),
    desiredProfile: {
      agent: member.agent,
      model: {
        providerID: member.providerID,
        id: member.modelID,
        ...(member.accountID === undefined ? {} : { accountID: member.accountID }),
        ...(member.variant === undefined ? {} : { variant: member.variant }),
      },
      permissionBoundary: member.permissionBoundary,
      ...(member.modelRequirements === undefined ? {} : { modelRequirements: member.modelRequirements }),
    },
    workspacePolicy:
      workspace === "worktree"
        ? {
            mode: "worktree" as const,
            ...(member.worktreeBaseRef === undefined ? {} : { baseRef: required(member.worktreeBaseRef, "members[].worktreeBaseRef") }),
          }
        : { mode: workspace },
    ...(member.capabilities === undefined ? {} : { capabilities: member.capabilities }),
  }
}

/**
 * Creation-only native Swarm facade.
 *
 * The broad coordinator/admin surface remains lazy behind the stable tool broker
 * to protect provider prompt/tool-prefix caches. Creation is different: it is a
 * common conversational entry point with a complex nested schema, and live
 * agent telemetry showed repeated broker-envelope mistakes before any domain
 * logic ran. This facade removes only that broker ceremony.
 *
 * It does NOT own creation semantics. SwarmCommand.delegate remains the one
 * fail-closed workflow for profile/coordinator preflight, durable construction,
 * DAG validation, and final activation.
 */
export const SwarmCreateTool = Tool.define<
  typeof Parameters,
  Metadata,
  SwarmV2.Service | SwarmProfilePreflight.Service
>(
  "swarm_create",
  Effect.gen(function* () {
    const swarms = yield* SwarmV2.Service
    const profilePreflight = yield* SwarmProfilePreflight.Service

    return {
      description: [
        "Create one native OpenFork Swarm directly, without the lazy-tool broker.",
        "Use this for initial Swarm creation only; use the lazy swarm capability for inspection, lifecycle, recovery, or later admin changes.",
        "The host derives project, workspace, and coordinator Session authority from the caller.",
        "Managed-worker creation is intentionally flat: name/role/agent/providerID/modelID/permissionBoundary, with optional workspace (default shared-read), account/variant/requirements, and capabilities.",
        "Initial task dependencies reference request-local task keys and are validated before any durable Swarm write.",
      ].join(" "),
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const workspaceID = yield* InstanceState.workspaceID
          const resource = `project:${instance.project.id}:create`
          yield* ctx.ask({
            permission: "swarm.member",
            patterns: [resource],
            always: [resource],
            metadata: { action: "create", resource },
          })

          const created = yield* SwarmCommand.delegate(swarms, profilePreflight, {
            projectID: instance.project.id,
            ...(workspaceID === undefined ? {} : { workspaceID }),
            directory: instance.directory,
            coordinatorSessionID: SessionV2.ID.make(ctx.sessionID),
            name: required(params.name, "name"),
            ...(params.coordinatorName === undefined ? {} : { coordinatorName: params.coordinatorName }),
            ...(params.coordinatorRole === undefined ? {} : { coordinatorRole: params.coordinatorRole }),
            members: (params.members ?? []).map(canonicalMember),
            tasks: params.tasks ?? [],
          })

          return {
            title: `Created Swarm ${created.swarm.name}`,
            output: outputData(created),
            metadata: {
              action: "create" as const,
              permission: "swarm.member" as const,
              swarmId: created.swarm.id,
              coordinatorMemberId: created.coordinator.id,
              managedMemberCount: created.members.length,
              taskCount: created.tasks.length,
              status: created.swarm.status,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
