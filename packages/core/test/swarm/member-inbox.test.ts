import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq, inArray } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmMessageDeliveryTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SwarmV2.node]),
  ),
)

const projectID = ProjectV2.ID.make("swarm-inbox-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_inbox")
const sessionA = SessionV2.ID.make("ses_swarm_inbox_a")
const sessionB = SessionV2.ID.make("ses_swarm_inbox_b")
const sessionC = SessionV2.ID.make("ses_swarm_inbox_c")

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/inbox",
    title: id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/inbox"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "inbox", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db.insert(SessionTable).values([sessionRow(sessionA), sessionRow(sessionB), sessionRow(sessionC)]).run().pipe(Effect.orDie)
  const swarm = yield* service.create({
    projectID,
    workspaceID,
    directory: "/swarm/inbox",
    name: "inbox swarm",
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

describe("Swarm.memberInbox", () => {
  it.effect("returns only mail addressed to the recipient member", () =>
    Effect.gen(function* () {
      const { service, swarm, a, b, c } = yield* setup
      yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: b.id },
        kind: "message",
        body: "for b only",
        now: 100,
      })
      yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "broadcast" },
        kind: "finding",
        body: "for everyone",
        now: 101,
      })

      const bInbox = yield* service.memberInbox({ swarmID: swarm.id, memberID: b.id })
      // The broadcast expanded into a real per-recipient delivery for b, so it
      // belongs in b's inbox; the member-directed mail is not a c message.
      expect(bInbox.map((row) => row.message.body).sort()).toEqual(["for b only", "for everyone"])
      expect(bInbox.every((row) => row.delivery.recipientMemberID === b.id)).toBe(true)

      const cInbox = yield* service.memberInbox({ swarmID: swarm.id, memberID: c.id })
      expect(cInbox.map((row) => row.message.body)).toEqual(["for everyone"])
    }),
  )

  it.effect("is bounded, newest-first, and filters on durable delivery state", () =>
    Effect.gen(function* () {
      const { db, service, swarm, a, b } = yield* setup
      for (const index of [1, 2, 3]) {
        yield* service.enqueueMessage({
          swarmID: swarm.id,
          senderMemberID: a.id,
          target: { type: "member", memberID: b.id },
          kind: "message",
          body: `msg-${index}`,
          now: 100 + index,
        })
      }
      const newest = yield* service.memberInbox({ swarmID: swarm.id, memberID: b.id, limit: 2 })
      expect(newest.map((row) => row.message.body)).toEqual(["msg-3", "msg-2"])

      // Claim the oldest delivery: it leaves the default pending projection
      // without being expired or failed, so state filtering is load-bearing.
      const rows = yield* service.memberInbox({ swarmID: swarm.id, memberID: b.id, limit: 10 })
      const oldest = rows.find((row) => row.message.body === "msg-1")!
      yield* service.claimDelivery({ deliveryID: oldest.delivery.id, owner: "mail-worker", leaseMs: 1_000, now: 200 })

      const stillVisible = yield* service.memberInbox({ swarmID: swarm.id, memberID: b.id, limit: 10 })
      expect(stillVisible.map((row) => row.message.body)).toContain("msg-1")

      const pendingOnly = yield* service.memberInbox({
        swarmID: swarm.id,
        memberID: b.id,
        limit: 10,
        states: ["pending"],
      })
      expect(pendingOnly.map((row) => row.message.body)).not.toContain("msg-1")

      // Delivery state is durable, so the projection agrees with the row.
      const durable = yield* db
        .select()
        .from(SwarmMessageDeliveryTable)
        .where(inArray(SwarmMessageDeliveryTable.id, [oldest.delivery.id]))
        .get()
        .pipe(Effect.orDie)
      // `.get()` is `row | undefined`. Optional chaining keeps these assertions
      // strict at runtime (a missing row still fails) without a non-null
      // assertion hiding the possibility.
      expect(durable?.state).toBe("claimed")
      expect(durable?.recipient_member_id).toBe(b.id)

      const expired = yield* db
        .select()
        .from(SwarmMessageDeliveryTable)
        .where(eq(SwarmMessageDeliveryTable.id, oldest.delivery.id))
        .get()
        .pipe(Effect.orDie)
      expect(expired?.id).toBe(oldest.delivery.id)
    }),
  )

  it.effect("does not leak another Swarm's deliveries into a member inbox", () =>
    Effect.gen(function* () {
      const { service, swarm, a, b } = yield* setup
      yield* service.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: a.id,
        target: { type: "member", memberID: b.id },
        kind: "message",
        body: "inside",
        now: 100,
      })

      const other = yield* service.create({
        projectID,
        directory: "/swarm/inbox-other",
        name: "other swarm",
        now: 10,
      })
      const otherSender = yield* service.addMember({
        swarmID: other.id,
        name: "x",
        kind: "coordinator",
        role: "lead",
        sessionID: sessionA,
        workspacePolicy: { mode: "shared-read" },
        now: 20,
      })
      // A foreign member id is not a recipient in this Swarm at all.
      yield* service.enqueueMessage({
        swarmID: other.id,
        senderMemberID: otherSender.id,
        target: { type: "broadcast" },
        kind: "message",
        body: "outside",
        now: 100,
      })

      const inbox = yield* service.memberInbox({ swarmID: other.id, memberID: b.id })
      expect(inbox).toEqual([])
      const original = yield* service.memberInbox({ swarmID: swarm.id, memberID: b.id })
      expect(original.map((row) => row.message.body)).toEqual(["inside"])
    }),
  )
})
