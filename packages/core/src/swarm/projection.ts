import { DateTime } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import {
  SwarmBlackboardTable,
  SwarmClaimTable,
  SwarmDeliverableTable,
  SwarmMemberTable,
  SwarmMessageDeliveryTable,
  SwarmMessageTable,
  SwarmTable,
  SwarmTaskDependencyTable,
  SwarmTaskLeaseTable,
  SwarmTaskRunTable,
  SwarmTaskTable,
} from "./sql"

export function hydrateInfo(row: typeof SwarmTable.$inferSelect): Swarm.Info {
  return {
    id: row.id,
    projectID: row.project_id,
    directory: row.directory,
    workspaceID: row.workspace_id ?? undefined,
    name: row.name,
    status: row.status,
    coordinatorMemberID: row.coordinator_member_id ?? undefined,
    policy: row.policy,
    revision: row.revision,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed == null ? undefined : DateTime.makeUnsafe(row.time_completed),
      archived: row.time_archived == null ? undefined : DateTime.makeUnsafe(row.time_archived),
    },
  }
}

export function hydrateMember(row: typeof SwarmMemberTable.$inferSelect): Swarm.Member {
  return {
    id: row.id,
    swarmID: row.swarm_id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    lifecycle: row.lifecycle,
    sessionID: row.session_id ?? undefined,
    bindingGeneration: row.binding_generation,
    desiredProfile: row.desired_profile ?? undefined,
    workspacePolicy: row.workspace_policy,
    capabilities: row.capabilities ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      stopped: row.time_stopped == null ? undefined : DateTime.makeUnsafe(row.time_stopped),
    },
  }
}

export function hydrateTask(row: typeof SwarmTaskTable.$inferSelect): Swarm.Task {
  return {
    id: row.id,
    swarmID: row.swarm_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority,
    createdByMemberID: row.created_by_member_id ?? undefined,
    reservedMemberID: row.reserved_member_id ?? undefined,
    reservedUntil: row.reserved_until == null ? undefined : DateTime.makeUnsafe(row.reserved_until),
    reservationRevision: row.reservation_revision,
    leaseGeneration: row.lease_generation,
    semanticRetryCount: row.semantic_retry_count,
    acceptance: row.acceptance,
    metadata: row.metadata as Record<string, never>,
    readyAt: row.ready_at == null ? undefined : DateTime.makeUnsafe(row.ready_at),
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed == null ? undefined : DateTime.makeUnsafe(row.time_completed),
    },
  }
}

export function hydrateDependency(row: typeof SwarmTaskDependencyTable.$inferSelect): Swarm.TaskDependency {
  return {
    taskID: row.task_id,
    dependsOnTaskID: row.depends_on_task_id,
    requirement: row.requirement,
  }
}

export function hydrateLease(row: typeof SwarmTaskLeaseTable.$inferSelect): Swarm.TaskLease {
  return {
    taskID: row.task_id,
    generation: row.generation,
    ownerMemberID: row.owner_member_id,
    ownerSessionID: row.owner_session_id,
    ownerBindingGeneration: row.owner_binding_generation,
    leaseOwnerProcess: row.lease_owner_process,
    state: row.state,
    holdUserSeq: row.hold_user_seq ?? undefined,
    holdStartedAt: row.hold_started_at == null ? undefined : DateTime.makeUnsafe(row.hold_started_at),
    holdDeadline: row.hold_deadline == null ? undefined : DateTime.makeUnsafe(row.hold_deadline),
    retireReason: row.retire_reason ?? undefined,
    retireRequestedAt:
      row.retire_requested_at == null ? undefined : DateTime.makeUnsafe(row.retire_requested_at),
    acquiredAt: DateTime.makeUnsafe(row.acquired_at),
    expiresAt: DateTime.makeUnsafe(row.expires_at),
    renewedAt: row.renewed_at == null ? undefined : DateTime.makeUnsafe(row.renewed_at),
  }
}

export function hydrateTaskRun(row: typeof SwarmTaskRunTable.$inferSelect): Swarm.TaskRun {
  return {
    id: row.id,
    taskID: row.task_id,
    memberID: row.member_id,
    sessionID: row.session_id,
    bindingGeneration: row.binding_generation,
    leaseGeneration: row.lease_generation,
    sessionInputID: row.session_input_id,
    status: row.status,
    failureKind: row.failure_kind ?? undefined,
    failureDetail: row.failure_detail ?? undefined,
    admittedAt: row.admitted_at == null ? undefined : DateTime.makeUnsafe(row.admitted_at),
    startedAt: row.started_at == null ? undefined : DateTime.makeUnsafe(row.started_at),
    endedAt: row.ended_at == null ? undefined : DateTime.makeUnsafe(row.ended_at),
    createdAt: DateTime.makeUnsafe(row.time_created),
  }
}

export function hydrateMessage(row: typeof SwarmMessageTable.$inferSelect): Swarm.Message {
  return {
    id: row.id,
    swarmID: row.swarm_id,
    senderMemberID: row.sender_member_id,
    senderSessionID: row.sender_session_id,
    senderBindingGeneration: row.sender_binding_generation,
    kind: row.kind,
    body: row.body,
    taskID: row.task_id ?? undefined,
    correlationID: row.correlation_id ?? undefined,
    responseTo: row.response_to ?? undefined,
    priority: row.priority,
    replyExpected: row.reply_expected,
    createdAt: DateTime.makeUnsafe(row.time_created),
    expiresAt: row.expires_at == null ? undefined : DateTime.makeUnsafe(row.expires_at),
  }
}

export function hydrateDelivery(row: typeof SwarmMessageDeliveryTable.$inferSelect): Swarm.Delivery {
  return {
    id: row.id,
    messageID: row.message_id,
    recipientMemberID: row.recipient_member_id,
    state: row.state,
    sessionInputID: row.session_input_id,
    claimGeneration: row.claim_generation,
    claimOwner: row.claim_owner ?? undefined,
    claimExpiresAt: row.claim_expires_at == null ? undefined : DateTime.makeUnsafe(row.claim_expires_at),
    nextAttemptAt: row.next_attempt_at == null ? undefined : DateTime.makeUnsafe(row.next_attempt_at),
    attemptCount: row.attempt_count,
    admittedSessionID: row.admitted_session_id ?? undefined,
    admittedSeq: row.admitted_seq ?? undefined,
    admittedAt: row.admitted_at == null ? undefined : DateTime.makeUnsafe(row.admitted_at),
    error: row.error ?? undefined,
  }
}

export function hydrateBlackboard(row: typeof SwarmBlackboardTable.$inferSelect): Swarm.BlackboardEntry {
  return {
    swarmID: row.swarm_id,
    key: row.key,
    value: row.value as never,
    contentType: row.content_type,
    version: row.version,
    authorMemberID: row.author_member_id,
    taskID: row.task_id ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
    },
  }
}

export function hydrateClaim(row: typeof SwarmClaimTable.$inferSelect): Swarm.Claim {
  return {
    swarmID: row.swarm_id,
    memberID: row.member_id,
    scope: row.scope,
    generation: row.generation,
    expiresAt: row.expires_at == null ? undefined : DateTime.makeUnsafe(row.expires_at),
    releasedAt: row.released_at == null ? undefined : DateTime.makeUnsafe(row.released_at),
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
    },
  }
}

export function hydrateDeliverable(row: typeof SwarmDeliverableTable.$inferSelect): Swarm.Deliverable {
  return {
    id: row.id,
    swarmID: row.swarm_id,
    memberID: row.member_id,
    taskRunID: row.task_run_id ?? undefined,
    summary: row.summary,
    refs: row.refs,
    files: row.files,
    verdict: row.verdict ?? undefined,
    verdictByMemberID: row.verdict_by_member_id ?? undefined,
    createdAt: DateTime.makeUnsafe(row.time_created),
    verdictAt: row.verdict_at == null ? undefined : DateTime.makeUnsafe(row.verdict_at),
  }
}
