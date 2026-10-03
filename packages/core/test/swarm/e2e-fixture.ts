import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSchema } from "@opencode-ai/core/swarm/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionSynthetic } from "@opencode-ai/schema/session-synthetic"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
import { managedProfile } from "./fixture"

/**
 * Deterministic, provider-free harness for the native Swarm lifecycle.
 *
 * Every step drives the same authoritative services and the same durable Session
 * events that production uses:
 *
 * - creation mirrors `SwarmCommand.delegate`'s ordering (create -> roster ->
 *   tasks -> dependency edges -> exact-revision activation) but stays inside
 *   Core, so no provider/model resolution is required;
 * - materialization is the real `rebindMember` Session-binding transition that
 *   `SwarmMemberSession` performs, so binding-generation fences are exercised;
 * - assignment admission and promotion are published as genuine
 *   `SessionEvent.SyntheticAdmitted` / `SyntheticPromoted` events carrying Swarm
 *   provenance, so `SwarmSessionProjector` — not this harness — owns run
 *   creation and the `running` transition;
 * - preemption uses `SessionInput.revokeSynthetic`, the real `SyntheticRevoked`
 *   path a human prompt triggers.
 *
 * Nothing here reconstructs state from message history or rendered output, and
 * every projection is typed with the owner's real return type so a domain error
 * can never be erased by a narrower structural cast.
 */

export interface SwarmE2eScope {
  readonly projectID: ProjectV2.ID
  readonly workspaceID: WorkspaceV2.ID
  readonly directory: string
}

export function e2eScope(name: string): SwarmE2eScope {
  return {
    projectID: ProjectV2.ID.make(name as never),
    workspaceID: WorkspaceV2.ID.make(`wrk_${name}` as never),
    directory: `/swarm/${name}`,
  }
}

export interface SwarmE2eState {
  readonly scope: SwarmE2eScope
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly swarms: SwarmV2.Interface
  readonly swarm: Swarm.Info
  readonly coordinator: Swarm.Member
  readonly workers: readonly [Swarm.Member, Swarm.Member]
  readonly taskA: Swarm.Task
  readonly taskB: Swarm.Task
  readonly reliability: (now?: number) => Effect.Effect<Swarm.Reliability, SwarmSchema.Error>
}

export interface MaterializedState extends SwarmE2eState {
  /** Worker Session ids, index-aligned with `workers`. */
  readonly sessions: readonly [SessionV2.ID, SessionV2.ID]
}

/**
 * Fail-closed delegate-shaped setup with a two-task DAG.
 *
 * Managed members are created as durable *intent* with no Session binding, which
 * is the real pre-materialization shape: the Swarm is already `active` while
 * both workers still owe a Session.
 */
export const delegateSwarm = Effect.fn("SwarmE2e.delegate")(function* (scope: SwarmE2eScope, name: string) {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const swarms = yield* SwarmV2.Service

  const created = yield* swarms.create({
    projectID: scope.projectID,
    workspaceID: scope.workspaceID,
    directory: scope.directory,
    name,
    now: 10,
  })
  const coordinator = yield* swarms.addMember({
    swarmID: created.id,
    name: "coordinator",
    kind: "coordinator",
    role: "coordinator",
    workspacePolicy: { mode: "shared-read" },
    now: 11,
  })
  const first = yield* swarms.addMember({
    swarmID: created.id,
    name: "alpha",
    kind: "managed_worker",
    role: "Builder",
    desiredProfile: managedProfile,
    workspacePolicy: { mode: "shared-read" },
    now: 12,
  })
  const second = yield* swarms.addMember({
    swarmID: created.id,
    name: "beta",
    kind: "managed_worker",
    role: "Reviewer",
    desiredProfile: managedProfile,
    workspacePolicy: { mode: "shared-read" },
    now: 13,
  })

  const taskA = yield* swarms.createTask({ swarmID: created.id, title: "produce finding", now: 20 })
  const taskB = yield* swarms.createTask({ swarmID: created.id, title: "consume finding", now: 21 })
  yield* swarms.setTaskDependencies({
    swarmID: created.id,
    taskID: taskB.id,
    dependencies: [{ taskID: taskA.id, requirement: "require_success" }],
  })

  // Activation is the final exact-revision mutation, exactly as in delegate().
  const swarm = yield* swarms.update({
    id: created.id,
    expectedRevision: created.revision,
    coordinatorMemberID: coordinator.id,
    status: "active",
    now: 30,
  })

  return {
    scope,
    db,
    events,
    swarms,
    swarm,
    coordinator,
    workers: [first, second] as const,
    taskA,
    taskB,
    reliability: (now?: number) => swarms.reliability({ swarmID: swarm.id, ...(now === undefined ? {} : { now }) }),
  }
})

/**
 * Bind every managed member to a real durable root Session.
 *
 * This is the materialization fact `SwarmMemberSession` produces. The Session
 * row must already exist so `validateSessionScope` can prove project/workspace
 * scope, and every bind bumps `binding_generation` so stale tokens are fenced.
 */
export const materializeWorkers = Effect.fn("SwarmE2e.materialize")(function* (state: SwarmE2eState) {
  const sessions: [SessionV2.ID, SessionV2.ID] = [
    SessionV2.ID.make(`ses_swarm_e2e_alpha` as never),
    SessionV2.ID.make(`ses_swarm_e2e_beta` as never),
  ]
  for (const [index, worker] of state.workers.entries()) {
    const sessionID = sessions[index]!
    yield* state.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: state.scope.projectID,
        workspace_id: state.scope.workspaceID,
        slug: sessionID,
        directory: state.scope.directory,
        title: sessionID,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* state.swarms.rebindMember({
      swarmID: state.swarm.id,
      memberID: worker.id,
      expectedBindingGeneration: worker.bindingGeneration,
      sessionID,
      now: 40 + index,
    })
  }
  return { ...state, sessions } satisfies MaterializedState
})

/**
 * Claim a task for a worker and publish the real Swarm assignment admission.
 *
 * The `swarm_task_run` row is created by `SwarmSessionProjector` reacting to the
 * admitted event, exactly as when `SwarmSessionAdmission.assignment` admits into
 * a materialized worker Session.
 */
export const dispatchAssignment = Effect.fn("SwarmE2e.dispatch")(function* (
  state: MaterializedState,
  input: { taskID: Swarm.TaskID; workerIndex: 0 | 1; now: number },
) {
  const worker = state.workers[input.workerIndex]
  const sessionID = state.sessions[input.workerIndex]
  const claim = yield* state.swarms.claimTask({
    swarmID: state.swarm.id,
    taskID: input.taskID,
    memberID: worker.id,
    processOwner: "swarm-e2e-owner",
    leaseMs: 600_000,
    now: input.now,
  })
  const runID = Swarm.TaskRunID.create()
  const inputID = SessionMessage.ID.create()
  yield* SessionInput.admitSynthetic(state.db, state.events, {
    id: inputID,
    sessionID,
    content: { text: `assignment: ${input.taskID}` },
    origin: SessionSynthetic.Origin.make({
      producer: SessionTurnProvenance.Source.SwarmAssignment,
      actor: { type: "host" },
      ref: runID,
    }),
    admissionClass: "host",
    delivery: "queue",
    userPreemptible: true,
    // Property presence with an undefined value is intentional: it asserts that
    // no semantic User turn may be admitted after this read.
    expectedLatestUserSeq: undefined,
  })
  return { claim, runID, inputID, worker, sessionID }
})

/** Promote the admitted assignment, driving the projector's `running` transition. */
export const promoteAssignment = Effect.fn("SwarmE2e.promote")(function* (
  state: MaterializedState,
  sessionID: SessionV2.ID,
) {
  return yield* SessionInput.promoteNextQueued(state.db, state.events, sessionID)
})

/**
 * Human-focus preemption of a still-pending assignment.
 *
 * This is the ledger's `pending assignment revoked: superseded` shape: the run
 * never started, so it is operational churn and never a task verdict.
 */
export const preemptPendingAssignment = Effect.fn("SwarmE2e.preempt")(function* (
  state: MaterializedState,
  input: { sessionID: SessionV2.ID; inputID: SessionMessage.ID },
) {
  return yield* SessionInput.revokeSynthetic(state.db, state.events, {
    sessionID: input.sessionID,
    id: input.inputID,
    reason: "superseded",
  })
})

/** Explicit worker settlement through the authoritative lease token. */
export const settleExplicitly = Effect.fn("SwarmE2e.settle")(function* (
  state: SwarmE2eState,
  input: { token: SwarmV2.LeaseToken; runID: Swarm.TaskRunID; now: number },
) {
  return yield* state.swarms.settleTask({
    token: input.token,
    runID: input.runID,
    settlement: { type: "completed" },
    now: input.now,
  })
})

/**
 * Quiescence-verified closure of an execution that ended without a settlement.
 *
 * Production only calls this after proving Session quiescence. The durable
 * outcome must be `review_pending`, never `completed`/`failed`, and must not
 * consume the semantic retry budget.
 */
export const closeWithoutSettlement = Effect.fn("SwarmE2e.closeUnsettled")(function* (
  state: SwarmE2eState,
  input: { token: SwarmV2.LeaseToken; runID: Swarm.TaskRunID; now: number },
) {
  return yield* state.swarms.settleTask({
    token: input.token,
    runID: input.runID,
    settlement: { type: "unsettled", detail: "execution ended without settlement" },
    now: input.now,
  })
})

/** The level-triggered scheduler must never return a settled task again. */
export const dispatchableTaskIDs = Effect.fn("SwarmE2e.dispatchable")(function* (state: SwarmE2eState, now: number) {
  const ready = yield* state.swarms.readyAssignments({ now })
  return ready.map((assignment) => assignment.task.id)
})

/** Directed peer mail with real claim fencing and projector-driven admission. */
export const peerRoundtrip = Effect.fn("SwarmE2e.peerRoundtrip")(function* (
  state: MaterializedState,
  input: { from: 0 | 1; to: 0 | 1; body: string; now: number; owner: string },
) {
  const sender = state.workers[input.from]
  const recipient = state.workers[input.to]
  const enqueued = yield* state.swarms.enqueueMessage({
    swarmID: state.swarm.id,
    senderMemberID: sender.id,
    target: { type: "member", memberID: recipient.id },
    kind: "finding",
    body: input.body,
    replyExpected: false,
    now: input.now,
  })
  const delivery = enqueued.deliveries[0]!
  const inbox = yield* state.swarms.memberInbox({
    swarmID: state.swarm.id,
    memberID: recipient.id,
    limit: 10,
  })
  const claimed = yield* state.swarms.claimDelivery({
    deliveryID: delivery.id,
    owner: input.owner,
    leaseMs: 60_000,
    now: input.now + 1,
  })
  yield* SessionInput.admitSynthetic(state.db, state.events, {
    id: delivery.sessionInputID,
    sessionID: claimed.token.recipientSessionID,
    content: { text: input.body },
    origin: SessionSynthetic.Origin.make({
      producer: SessionTurnProvenance.Source.SwarmPeer,
      actor: { type: "session", sessionID: claimed.message.senderSessionID },
      ref: delivery.id,
    }),
    admissionClass: "host",
    delivery: "queue",
    userPreemptible: false,
    expectedLatestUserSeq: undefined,
  })
  return { delivery, claimed, inbox, recipient }
})
