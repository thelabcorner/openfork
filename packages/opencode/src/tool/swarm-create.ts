import { Effect } from "effect"
import { Agent } from "@opencode-ai/schema/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRender } from "@opencode-ai/core/swarm/render"
import { InstanceState } from "@/effect/instance-state"
import { SwarmCommand } from "@/swarm/command"
import { SwarmAX } from "@/swarm/ax-projection"
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
  failedCount: number
  complete: boolean
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
      agent: Agent.ID.make("swarm-m"),
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
        "Managed workers always use the dedicated swarm-m agent mode. Choose their provider/model and hard permissionBoundary separately, with optional workspace (default shared-read), account/variant/requirements, and capabilities.",
        "For large requests, stage independent workers and DAG tasks through lazy swarm member.batch/task.batch after creation; adjust batch sizes to measured reliability and dependency coupling, not an arbitrary fixed count.",
        "Task keys remain stable across stages. Each batch can accept up to eight entries. Read partial receipts before retrying any failed entry.",
        "Set requestKey for initial creation if retries are possible. A lost-response retry with the same key fails with the original Swarm id; inspect the durable Swarm instead of creating duplicates or assuming identical task intent.",
        "Independent invalid members and task components are reported as failed while valid members and dependency-safe tasks are retained. Check admission.failures and retry ONLY those; never replay accepted members.",
        "The surviving task DAG is validated and fully constructed before activation; unsafe cross-item dependencies are not admitted.",
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

          const accepted: ReturnType<typeof canonicalMember>[] = []
          const acceptedInputIndices: number[] = []
          const normalizationFailures: SwarmCommand.AdmissionFailure[] = []
          for (const [index, member] of (params.members ?? []).entries()) {
            try {
              accepted.push(canonicalMember(member))
              acceptedInputIndices.push(index)
            } catch (error) {
              normalizationFailures.push({
                kind: "member",
                key: member.name,
                index,
                reason: error instanceof Error ? error.message : String(error),
              })
            }
          }
          const created = yield* SwarmCommand.delegatePartial(swarms, profilePreflight, {
            ...(params.requestKey === undefined ? {} : { requestKey: params.requestKey }),
            projectID: instance.project.id,
            ...(workspaceID === undefined ? {} : { workspaceID }),
            directory: instance.directory,
            coordinatorSessionID: SessionV2.ID.make(ctx.sessionID),
            name: required(params.name, "name"),
            ...(params.coordinatorName === undefined ? {} : { coordinatorName: params.coordinatorName }),
            ...(params.coordinatorRole === undefined ? {} : { coordinatorRole: params.coordinatorRole }),
            members: accepted,
            tasks: params.tasks ?? [],
          })
          const admission = {
            ...created.admission,
            failures: [
              ...normalizationFailures,
              ...created.admission.failures.map((failure) => failure.kind === "member" && failure.index !== undefined
                ? { ...failure, index: acceptedInputIndices[failure.index] }
                : failure),
            ].sort((left, right) => left.kind === right.kind
              ? (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER)
              : left.kind === "member" ? -1 : 1),
            complete: normalizationFailures.length === 0 && created.admission.complete,
          }

          return {
            title: `Created Swarm ${created.swarm.name}`,
            output: outputData(SwarmAX.creation({ ...created, admission })),
            metadata: {
              action: "create" as const,
              permission: "swarm.member" as const,
              swarmId: created.swarm.id,
              coordinatorMemberId: created.coordinator.id,
              managedMemberCount: created.members.length,
              taskCount: created.tasks.length,
              status: admission.complete ? created.swarm.status : "partial",
              failedCount: admission.failures.length,
              complete: admission.complete,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
