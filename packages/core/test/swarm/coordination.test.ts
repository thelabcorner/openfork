import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmMessageDeliveryTable } from "@opencode-ai/core/swarm/sql"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SwarmSessionProjector.node, SwarmV2.node]),
  ),
)

const projectID = ProjectV2.ID.make("swarm-coordination-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_coordination")
const sessionA = SessionV2.ID.make("ses_swarm_coord_a")
const sessionB = SessionV2.ID.make("ses_swarm_coord_b")
const sessionC = SessionV2.ID.make("ses_swarm_coord_c")
const sessionD = SessionV2.ID.make("ses_swarm_coord_d")

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/coordination",
    title: id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/coordination"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "coordination", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([sessionRow(sessionA), sessionRow(sessionB), sessionRow(sessionC), sessionRow(sessionD)])
    .run()
    .pipe(Effect.orDie)
  const swarm = yield* service.create({
    projectID,
    workspaceID,
    directory: "/swarm/coordination",
    name: "coordination swarm",
    now: 10,
  })
  const a = yield* service.addMember({
    swarmID: swarm.id,
    name: "a",
    kind: "coordinator",
    role: "lead",
    sessionID: sessionA,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  const b = yield* service.addMember({
    swarmID: swarm.id,
    name: "b",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: managedProfile,
    sessionID: sessionB,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  const c = yield* service.addMember({
    swarmID: swarm.id,
    name: "c",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: managedProfile,
    sessionID: sessionC,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  return { db, service, swarm, a, b, c }
})

describe("Swarm messaging and receipt fencing", () => {
  it.effect("commits peer SessionInput and delivery admission atomically, rolling both back on recipient rebind", () =>
    Effect.gen(function* () {
      const { db, service, swarm, a, b } = yield* setup
      const events = yield* EventV2.Service
      const sent = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: b.id },
        kind: "message",
        body: "atomic peer message",
        now: 100,
      })
      const delivery = sent.deliveries[0]!
      const claimed = yield* service.claimDelivery({
        deliveryID: delivery.id,
        owner: "mail-worker",
        leaseMs: 1_000,
        now: 101,
      })
      const admitted = yield* SessionInput.admitSynthetic(db, events, {
        id: delivery.sessionInputID,
        sessionID: claimed.token.recipientSessionID,
        content: { text: sent.message.body },
        origin: {
          producer: SessionTurnProvenance.Source.SwarmPeer,
          actor: { type: "session" as const, sessionID: sent.message.senderSessionID },
          ref: delivery.id,
        },
        admissionClass: "host",
        delivery: "queue",
        expectedLatestUserSeq: undefined,
        commit: (seq) =>
          SwarmV2.commitDeliveryAdmission(db, {
            token: claimed.token,
            admittedSessionID: claimed.token.recipientSessionID,
            admittedSeq: seq,
            admittedAt: 102,
          }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
      })
      expect(admitted.id).toBe(delivery.sessionInputID)
      const receipt = yield* db
        .select()
        .from(SwarmMessageDeliveryTable)
        .where(eq(SwarmMessageDeliveryTable.id, delivery.id))
        .get()
        .pipe(Effect.orDie)
      expect(receipt?.state).toBe("admitted")
      expect(receipt?.admitted_seq).toBe(admitted.admittedSeq)

      const staleSent = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: b.id },
        kind: "message",
        body: "stale peer message",
        now: 110,
      })
      const staleDelivery = staleSent.deliveries[0]!
      const staleClaim = yield* service.claimDelivery({
        deliveryID: staleDelivery.id,
        owner: "mail-worker",
        leaseMs: 1_000,
        now: 111,
      })
      yield* service.rebindMember({
        swarmID: swarm.id,
        memberID: b.id,
        expectedBindingGeneration: staleClaim.token.recipientBindingGeneration,
        sessionID: sessionD,
        now: 112,
      })
      const staleAdmission = yield* SessionInput.admitSynthetic(db, events, {
        id: staleDelivery.sessionInputID,
        sessionID: staleClaim.token.recipientSessionID,
        content: { text: staleSent.message.body },
        origin: {
          producer: SessionTurnProvenance.Source.SwarmPeer,
          actor: { type: "session" as const, sessionID: staleSent.message.senderSessionID },
          ref: staleDelivery.id,
        },
        admissionClass: "host",
        delivery: "queue",
        expectedLatestUserSeq: undefined,
        commit: (seq) =>
          SwarmV2.commitDeliveryAdmission(db, {
            token: staleClaim.token,
            admittedSessionID: staleClaim.token.recipientSessionID,
            admittedSeq: seq,
            admittedAt: 113,
          }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
      }).pipe(Effect.exit)
      expect(staleAdmission._tag).toBe("Failure")
      expect(yield* SessionInput.findEntry(db, staleDelivery.sessionInputID)).toBeUndefined()
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, staleDelivery.sessionInputID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      const staleReceipt = yield* db
        .select()
        .from(SwarmMessageDeliveryTable)
        .where(eq(SwarmMessageDeliveryTable.id, staleDelivery.id))
        .get()
        .pipe(Effect.orDie)
      expect(staleReceipt?.state).toBe("claimed")
      expect(staleReceipt?.admitted_seq).toBeNull()
    }),
  )

  it.effect("rejects admission after message TTL and expires receipts durably without consuming failure attempts", () =>
    Effect.gen(function* () {
      const { db, service, swarm, a, b, c } = yield* setup
      const events = yield* EventV2.Service
      const sent = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: b.id },
        kind: "message",
        body: "short-lived message",
        expiresAt: 105,
        now: 100,
      })
      const delivery = sent.deliveries[0]!
      const claimed = yield* service.claimDelivery({
        deliveryID: delivery.id,
        owner: "ttl-worker",
        leaseMs: 1_000,
        now: 101,
      })
      const late = yield* SessionInput.admitSynthetic(db, events, {
        id: delivery.sessionInputID,
        sessionID: claimed.token.recipientSessionID,
        content: { text: sent.message.body },
        origin: {
          producer: SessionTurnProvenance.Source.SwarmPeer,
          actor: { type: "session" as const, sessionID: sent.message.senderSessionID },
          ref: delivery.id,
        },
        admissionClass: "host",
        delivery: "queue",
        expectedLatestUserSeq: undefined,
        commit: (seq) =>
          SwarmV2.commitDeliveryAdmission(db, {
            token: claimed.token,
            admittedSessionID: claimed.token.recipientSessionID,
            admittedSeq: seq,
            admittedAt: 106,
          }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
      }).pipe(Effect.exit)
      expect(late._tag).toBe("Failure")
      expect(yield* SessionInput.findEntry(db, delivery.sessionInputID)).toBeUndefined()

      const expiredClaim = yield* service.expireDelivery({ deliveryID: delivery.id, now: 106 })
      expect(expiredClaim.state).toBe("expired")
      expect(expiredClaim.attemptCount).toBe(0)

      const pending = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: c.id },
        kind: "finding",
        body: "expire without claim",
        expiresAt: 205,
        now: 200,
      })
      expect(yield* service.claimableDeliveryIDs({ now: 201, limit: 16 })).toContain(pending.deliveries[0]!.id)
      const swept = yield* service.expireDueDeliveries({ now: 206, limit: 16 })
      expect(swept.map((item) => item.id)).toContain(pending.deliveries[0]!.id)
      expect(swept.find((item) => item.id === pending.deliveries[0]!.id)?.attemptCount).toBe(0)
      expect(yield* service.claimableDeliveryIDs({ now: 206, limit: 16 })).not.toContain(pending.deliveries[0]!.id)
    }),
  )
  it.effect("normalizes direct/broadcast messages and preserves request/reply correlation", () =>
    Effect.gen(function* () {
      const { service, swarm, a, b, c } = yield* setup

      const direct = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: b.id },
        kind: "request",
        body: "status?",
        now: 100,
      })
      expect(direct.deliveries).toHaveLength(1)
      expect(direct.deliveries[0]!.recipientMemberID).toBe(b.id)
      expect(direct.message.correlationID).toBe(direct.message.id)
      expect(direct.message.replyExpected).toBe(true)
      expect(direct.message.senderSessionID).toBe(sessionA)
      expect(direct.message.senderBindingGeneration).toBe(a.bindingGeneration)

      const self = yield* service
        .enqueueMessage({
          swarmID: swarm.id,
          senderMemberID: a.id,
          target: { type: "member", memberID: a.id },
          kind: "message",
          body: "nope",
        })
        .pipe(Effect.flip)
      expect(self._tag).toBe("Swarm.ValidationError")

      yield* service.setMemberLifecycle({
        swarmID: swarm.id,
        memberID: c.id,
        expectedLifecycle: "active",
        lifecycle: "stopped",
        now: 101,
      })
      const broadcast = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "broadcast" },
        kind: "decision",
        body: "contract v4",
        now: 102,
      })
      expect(broadcast.deliveries.map((item) => item.recipientMemberID)).toEqual([b.id])
      expect(broadcast.message.replyExpected).toBe(false)

      const reply = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: b.id,
        target: { type: "member", memberID: a.id },
        kind: "response",
        body: "green",
        responseTo: direct.message.id,
        now: 103,
      })
      expect(reply.message.responseTo).toBe(direct.message.id)
      expect(reply.message.correlationID).toBe(direct.message.correlationID)
    }),
  )

  it.effect("snapshots sender Session provenance so later member rebind cannot rewrite history", () =>
    Effect.gen(function* () {
      const { service, swarm, a, b } = yield* setup
      const sent = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: b.id },
        kind: "message",
        body: "authored before rebind",
        now: 100,
      })

      yield* service.rebindMember({
        swarmID: swarm.id,
        memberID: a.id,
        expectedBindingGeneration: a.bindingGeneration,
        sessionID: sessionD,
        now: 101,
      })

      const [recorded] = yield* service.messages({ swarmID: swarm.id, limit: 10 })
      expect(recorded?.id).toBe(sent.message.id)
      expect(recorded?.senderSessionID).toBe(sessionA)
      expect(recorded?.senderBindingGeneration).toBe(a.bindingGeneration)
    }),
  )

  it.effect("fences delivery admission against member rebind and supports generation-safe reclaim", () =>
    Effect.gen(function* () {
      const { db, service, swarm, a, b } = yield* setup
      const sent = yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: b.id },
        kind: "message",
        body: "hello",
        now: 100,
      })
      const deliveryID = sent.deliveries[0]!.id
      const claimed = yield* service.claimDelivery({
        deliveryID,
        owner: "dispatcher-a",
        leaseMs: 50,
        now: 101,
      })
      expect(claimed.token.recipientSessionID).toBe(sessionB)

      yield* service.rebindMember({
        swarmID: swarm.id,
        memberID: b.id,
        expectedBindingGeneration: claimed.token.recipientBindingGeneration,
        sessionID: sessionD,
        now: 102,
      })
      const staleAdmission = yield* SwarmV2.commitDeliveryAdmission(db, {
        token: claimed.token,
        admittedSessionID: sessionB,
        admittedSeq: 7,
        admittedAt: 103,
      }).pipe(Effect.flip)
      expect(staleAdmission._tag).toBe("Swarm.StaleFenceError")

      const retry = yield* service.releaseDelivery({
        token: claimed.token,
        outcome: { type: "retry", nextAttemptAt: 160, error: "binding changed" },
        now: 104,
      })
      expect(retry.state).toBe("pending")
      expect(retry.attemptCount).toBe(1)

      const reclaimed = yield* service.claimDelivery({
        deliveryID,
        owner: "dispatcher-b",
        leaseMs: 50,
        now: 160,
      })
      expect(reclaimed.token.generation).toBe(claimed.token.generation + 1)
      expect(reclaimed.token.recipientSessionID).toBe(sessionD)
      const staleRelease = yield* service
        .releaseDelivery({
          token: claimed.token,
          outcome: { type: "failed", error: "stale dispatcher" },
          now: 160,
        })
        .pipe(Effect.flip)
      expect(staleRelease._tag).toBe("Swarm.StaleFenceError")
      const admitted = yield* SwarmV2.commitDeliveryAdmission(db, {
        token: reclaimed.token,
        admittedSessionID: sessionD,
        admittedSeq: 8,
        admittedAt: 161,
      })
      expect(admitted.state).toBe("admitted")
      expect(admitted.admittedSeq).toBe(8)
      expect(admitted.sessionInputID).toBe(sent.deliveries[0]!.sessionInputID)
    }),
  )
})

describe("Swarm shared state", () => {
  it.effect("enforces blackboard CAS and claim generations without history-row growth", () =>
    Effect.gen(function* () {
      const { service, swarm, a } = yield* setup
      const first = yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "contract/api",
        value: { version: 1 },
        contentType: "application/json",
        authorMemberID: a.id,
        expectedVersion: 0,
        now: 100,
      })
      expect(first.version).toBe(1)
      const second = yield* service.putBlackboard({
        swarmID: swarm.id,
        key: "contract/api",
        value: { version: 2 },
        contentType: "application/json",
        authorMemberID: a.id,
        expectedVersion: 1,
        now: 101,
      })
      expect(second.version).toBe(2)
      const stale = yield* service
        .putBlackboard({
          swarmID: swarm.id,
          key: "contract/api",
          value: { version: 3 },
          contentType: "application/json",
          authorMemberID: a.id,
          expectedVersion: 1,
          now: 102,
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("Swarm.ConflictError")
      expect((yield* service.blackboard({ swarmID: swarm.id, key: "contract/api" }))[0]!.version).toBe(2)

      const acquired = yield* service.acquireClaim({
        swarmID: swarm.id,
        memberID: a.id,
        scope: "src/core/**",
        expiresAt: 200,
        now: 110,
      })
      expect(acquired.token.generation).toBe(1)
      yield* service.renewClaim({ token: acquired.token, expiresAt: 220, now: 120 })
      yield* service.releaseClaim({ token: acquired.token, now: 130 })
      const reacquired = yield* service.acquireClaim({
        swarmID: swarm.id,
        memberID: a.id,
        scope: "src/core/**",
        expiresAt: 300,
        now: 140,
      })
      expect(reacquired.token.generation).toBe(2)
      expect((yield* service.claims(swarm.id))).toHaveLength(1)
      const staleRenewal = yield* service
        .renewClaim({ token: acquired.token, expiresAt: 310, now: 150 })
        .pipe(Effect.flip)
      expect(staleRenewal._tag).toBe("Swarm.StaleFenceError")
      const staleRelease = yield* service.releaseClaim({ token: acquired.token, now: 151 }).pipe(Effect.flip)
      expect(staleRelease._tag).toBe("Swarm.StaleFenceError")
    }),
  )

  it.effect("makes deliverable verdicts one-shot", () =>
    Effect.gen(function* () {
      const { service, swarm, a, b } = yield* setup
      const deliverable = yield* service.publishDeliverable({
        swarmID: swarm.id,
        memberID: b.id,
        summary: "Implemented deterministic mailbox receipt fencing",
        refs: ["message:test"],
        files: ["src/swarm/messaging.ts"],
        now: 100,
      })
      const accepted = yield* service.verdictDeliverable({
        deliverableID: deliverable.id,
        reviewerMemberID: a.id,
        verdict: "accepted",
        now: 110,
      })
      expect(accepted.verdict).toBe("accepted")
      const secondVerdict = yield* service
        .verdictDeliverable({
          deliverableID: deliverable.id,
          reviewerMemberID: a.id,
          verdict: "rejected",
          now: 120,
        })
        .pipe(Effect.flip)
      expect(secondVerdict._tag).toBe("Swarm.ConflictError")
      expect((yield* service.deliverables({ swarmID: swarm.id }))[0]!.verdict).toBe("accepted")
    }),
  )
})
