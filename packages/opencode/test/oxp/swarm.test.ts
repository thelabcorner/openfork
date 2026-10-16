import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SwarmMemberTable, SwarmTaskLeaseTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
import { OxpRuntimeV1 } from "@/oxp/runtime-v1"
import { OxpSchema } from "@/oxp/schema"
import { OxpSwarm } from "@/oxp/swarm"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-swarm-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpSwarm.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }))

const prepare = Effect.fnUntraced(function* (name = "workspace") {
  const config = yield* OxpConfig.Service
  const roots = yield* OxpRoot.Service
  const swarm = yield* OxpSwarm.Service
  const directory = path.join(suite, name)
  yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
  const root = yield* roots.approve(directory)
  yield* config.setEnabled(true)
  yield* config.setGrant({ delegation: "spawn", sessionSupervision: "approved-roots" })
  return { config, roots, swarm, directory, root }
})

describe("OxpSwarm", () => {
  it.live("looks up creation keys under the authenticated connector root without mutating", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const key = "ambiguous-reply-1"
    const absent = yield* swarm.execute({ rootID: root.id, action: "creation.lookup", requestKey: key })
    expect(absent.structured).toMatchObject({ found: false })
    expect(absent.mutation).toBeUndefined()
    const created = yield* swarm.execute({
      rootID: root.id, action: "delegate", swarmName: "OXP reconciled", requestKey: key,
      tasks: [{ key: "first", title: "First" }],
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id
    const found = yield* swarm.execute({ rootID: root.id, action: "creation.lookup", requestKey: key })
    expect(found.structured).toMatchObject({
      found: true, swarmId: swarmID, status: "active", setup: "durable",
      taskCounts: { total: 1, ready: 1 },
    })
    expect(found.mutation).toBeUndefined()
    expect((found.structured as { execution: string }).execution).toContain("NOT verified")
    const other = yield* swarm.execute({ rootID: root.id, action: "creation.lookup", requestKey: "other" })
    expect(other.structured).toMatchObject({ found: false })
  }))

  it.live("treats a connector-scoped requestKey replay as conflict rather than a second Swarm", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const request = { rootID: root.id, action: "delegate" as const,
      swarmName: "Only once", requestKey: "only-once-1" }
    const created = yield* swarm.execute(request)
    const firstID = (created.structured as { swarm: { id: string } }).swarm.id
    const repeat = yield* swarm.execute(request).pipe(Effect.flip)
    expect(repeat._tag).toBe("OXP_CONFLICT")
    expect(repeat.detail).toContain(firstID)
    const changed = yield* swarm.execute({ ...request, swarmName: "Different intent" }).pipe(Effect.flip)
    expect(changed._tag).toBe("OXP_CONFLICT")
    const found = yield* swarm.execute({ rootID: root.id, action: "list" })
    expect((found.structured as Array<{ id: string; name: string }>).filter((row) => row.name === "Only once").map((row) => row.id)).toEqual([firstID])
  }))

  it.live("rejects native-only force authority before any connector-side mutation", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const denied = yield* swarm.execute({
      rootID: root.id, action: "delegate", swarmName: "Must not create", force: true,
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_INVALID_ARGUMENT")
    const deniedOrigin = yield* swarm.execute({
      rootID: root.id, action: "list", sourceSwarmId: "sw_untrusted",
    }).pipe(Effect.flip)
    expect(deniedOrigin._tag).toBe("OXP_INVALID_ARGUMENT")
    const found = yield* swarm.execute({ rootID: root.id, action: "list" })
    // Other tests may share the in-process project catalog. Inspect exactly
    // the forbidden candidate, rather than assuming global Swarm emptiness.
    expect((found.structured as Array<{ name: string }>).some((row) => row.name === "Must not create")).toBe(false)
  }))

  it.live("executes staged task DAG admissions through the authorized OXP dispatcher and replays matching keys", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id, action: "delegate", swarmName: "Staged task bridge",
      tasks: [{ key: "foundation", title: "Foundation" }],
    })
    const swarmID = (created.structured as { swarm: { id: string }; tasks: Array<{ id: string }> }).swarm.id
    const foundationID = (created.structured as { tasks: Array<{ id: string }> }).tasks[0]!.id
    const requested = [
      { key: "followup", title: "Follow-up", dependsOn: [{ key: "foundation" }] },
      { key: "broken", title: "Broken", dependsOn: [{ key: "unknown" }] },
      { key: "other", title: "Independent" },
    ]
    const first = yield* swarm.execute({
      rootID: root.id, action: "task.batch", swarmId: swarmID, tasks: requested,
    })
    expect(first.metadata).toMatchObject({ count: 2, failedCount: 1, status: "partial" })
    const receipts = (first.structured as {
      receipts: Array<{ key: string; status: string; taskId?: string }>
    }).receipts
    expect(receipts.map((item) => item.status)).toEqual(["created", "failed", "created"])
    const followupID = receipts[0]!.taskId!
    const detail = yield* swarm.execute({ rootID: root.id, action: "get", swarmId: swarmID })
    const followup = (detail.structured as { tasks: Array<{ id: string; status: string }> }).tasks.find(
      (item) => item.id === followupID,
    )
    expect(followup?.status).toBe("blocked")
    const repeat = yield* swarm.execute({
      rootID: root.id, action: "task.batch", swarmId: swarmID,
      tasks: [requested[0]!, requested[2]!],
    })
    expect(repeat.metadata).toMatchObject({ count: 0, failedCount: 0, status: "complete" })
    expect((repeat.structured as { receipts: Array<{ status: string }> }).receipts.map((r) => r.status))
      .toEqual(["satisfied", "satisfied"])
    expect(foundationID.startsWith("swt_b_")).toBe(true)
  }))

  it.live("creates a connector-owned unbound coordinator without leaking its ownership tag", Effect.gen(function* () {
    const { swarm, directory, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "OXP research",
      coordinatorName: "parent",
      coordinatorRole: "coordinate",
    })
    const value = created.structured as {
      swarm: { id: string; directory: string; status: string }
      coordinator: { sessionID?: string; capabilities?: { tags?: string[] } }
    }
    expect(value.swarm.status).toBe("active")
    expect(value.coordinator.sessionID).toBeUndefined()
    expect(value.coordinator.capabilities?.tags ?? []).toEqual([])
    expect(JSON.stringify(created)).not.toContain("oxp:connector:")
    expect(JSON.stringify(created)).not.toContain(directory)
    expect(value.swarm.directory).toBe("/" + root.alias)

    const paused = yield* swarm.execute({
      rootID: root.id,
      action: "state",
      swarmId: value.swarm.id,
      status: "paused",
    })
    expect((paused.structured as { status: string }).status).toBe("paused")
  }))

  it.live("exposes bounded durable TaskRun audit as a root-confined read", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "Task run audit",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id

    const runs = yield* swarm.execute({
      rootID: root.id,
      action: "task.runs",
      swarmId: swarmID,
      limit: 1,
    })
    expect(runs.structured).toMatchObject({ items: [], more: false })
    expect(runs.metadata).toMatchObject({ swarmId: swarmID, count: 0, status: "complete" })
  }))

  it.live("routes member recovery through the authoritative AppRuntime wake owner", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "Runtime wake owner",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id

    const recovered = yield* swarm.execute({
      rootID: root.id,
      action: "recover.members",
      swarmId: swarmID,
    })
    expect(recovered.structured).toMatchObject({ requested: true, unresolved: [] })
    expect(recovered.metadata).toMatchObject({ status: "requested", count: 0 })
  }))

  it.live("member.stop wakes native task retirement for a durable active lease", Effect.gen(function* () {
    const { swarm, root, directory } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "Lifecycle retirement wake",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id
    const taskResult = yield* swarm.execute({
      rootID: root.id,
      action: "task.create",
      swarmId: swarmID,
      title: "retire after operator stop",
    })
    const taskID = (taskResult.structured as { id: string }).id
    const memberID = "swm_oxp_retirement_wake"
    const now = Date.now()

    // Adapter-only setup: Core retirement behavior is covered in the dedicated
    // Swarm suite. Here we create the smallest valid durable authority shape so
    // this test isolates whether the OXP lifecycle adapter wakes that owner.
    yield* OxpRuntimeV1.enter({ directory }, async () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(SwarmMemberTable)
          .values({
            id: memberID as never,
            swarm_id: swarmID as never,
            name: "retirement-worker",
            kind: "managed_worker",
            role: "worker",
            lifecycle: "active",
            binding_generation: 1,
            workspace_policy: { mode: "shared-read" },
            time_created: now,
            time_updated: now,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SwarmTaskTable)
          .set({ status: "working", lease_generation: 1, ready_at: null, time_updated: now })
          .where(eq(SwarmTaskTable.id, taskID as never))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SwarmTaskLeaseTable)
          .values({
            task_id: taskID as never,
            generation: 1,
            owner_member_id: memberID as never,
            owner_session_id: "ses_oxp_retirement_wake" as never,
            owner_binding_generation: 1,
            lease_owner_process: "test:oxp-retirement-wake",
            state: "active",
            acquired_at: now,
            expires_at: now + 60_000,
          })
          .run()
          .pipe(Effect.orDie)
      }),
    )

    const stopped = yield* swarm.execute({
      rootID: root.id,
      action: "member.stop",
      swarmId: swarmID,
      memberId: memberID,
    })
    expect(stopped.metadata).toMatchObject({ memberId: memberID, status: "stopped" })

    let task: { status: string; leaseGeneration: number } | undefined
    for (let index = 0; index < 200; index++) {
      const detail = yield* swarm.execute({ rootID: root.id, action: "get", swarmId: swarmID })
      task = (detail.structured as { tasks: Array<{ id: string; status: string; leaseGeneration: number }> }).tasks
        .find((item) => item.id === taskID)
      if (task?.status === "ready") break
      yield* Effect.sleep("5 millis")
    }
    expect(task).toMatchObject({ status: "ready", leaseGeneration: 2 })
  }))

  it.live("exposes effect recovery as a bounded read and refuses unlisted containment", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "Effect recovery bridge",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id
    const taskResult = yield* swarm.execute({
      rootID: root.id,
      action: "task.create",
      swarmId: swarmID,
      title: "ordinary task",
    })
    const taskID = (taskResult.structured as { id: string }).id

    const effects = yield* swarm.execute({
      rootID: root.id,
      action: "recover.effects",
      swarmId: swarmID,
      limit: 8,
    })
    expect(effects.structured).toEqual([])
    expect(effects.metadata).toMatchObject({ swarmId: swarmID, count: 0, status: "clear" })
    expect(effects.mutation).toBeUndefined()

    const refused = yield* swarm.execute({
      rootID: root.id,
      action: "recover.contain",
      swarmId: swarmID,
      taskId: taskID,
      leaseGeneration: 1,
    }).pipe(Effect.flip)
    expect(refused._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(refused.detail).toContain("Run recover.effects first")
  }))

  it.live("fences coordinator mutation to the connector principal that created the Swarm", Effect.gen(function* () {
    const { config, swarm, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "Connector fenced",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id

    yield* config.update((current) => ({
      ...current,
      connector: {
        ...current.connector,
        id: OxpSchema.ConnectorID.make(randomUUID()),
      },
    }))

    const denied = yield* swarm.execute({
      rootID: root.id,
      action: "state",
      swarmId: swarmID,
      status: "paused",
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(denied.detail).toContain("not owned by the current OXP connector")
  }))

  it.live("keeps Swarm discovery root-confined even when multiple approved roots share the durable store", Effect.gen(function* () {
    const { config, roots, swarm, root: first } = yield* prepare("first")
    const secondDir = path.join(suite, "second")
    yield* Effect.promise(() => fs.mkdir(secondDir, { recursive: true }))
    const second = yield* roots.approve(secondDir)

    const firstCreated = yield* swarm.execute({
      rootID: first.id,
      action: "delegate",
      swarmName: "First root",
    })
    const secondCreated = yield* swarm.execute({
      rootID: second.id,
      action: "delegate",
      swarmName: "Second root",
    })
    const firstID = (firstCreated.structured as { swarm: { id: string } }).swarm.id
    const secondID = (secondCreated.structured as { swarm: { id: string } }).swarm.id

    const firstList = yield* swarm.execute({ rootID: first.id, action: "list" })
    const rows = firstList.structured as Array<{ id: string }>
    expect(rows.map((row) => row.id)).toContain(firstID)
    expect(rows.map((row) => row.id)).not.toContain(secondID)

    const escaped = yield* swarm.execute({
      rootID: first.id,
      action: "get",
      swarmId: secondID,
    }).pipe(Effect.flip)
    expect(escaped._tag).toBe("OXP_INVALID_ARGUMENT")
    void config
  }))

  it.live("refuses worker task settlement without an explicitly supervised real Session", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "Settlement boundary",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id

    const denied = yield* swarm.execute({
      rootID: root.id,
      action: "task.settle",
      swarmId: swarmID,
      settlement: "completed",
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(denied.detail).toContain("existing worker Session")
  }))

  it.live("reviews a review_pending task through the OXP coordinator with an exact lease fence", Effect.gen(function* () {
    const { swarm, root, directory } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "Review bridge",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id
    const taskResult = yield* swarm.execute({
      rootID: root.id,
      action: "task.create",
      swarmId: swarmID,
      title: "parked for review",
    })
    const taskID = (taskResult.structured as { id: string }).id

    // Adapter regression setup: review_pending is a lease-free state. The Core
    // state machine owns how real runs reach it; this test isolates whether the
    // OXP adapter can exercise the already-tested review transition at all.
    yield* OxpRuntimeV1.enter({ directory }, async () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .update(SwarmTaskTable)
          .set({ status: "review_pending", lease_generation: 4, time_updated: Date.now() })
          .where(eq(SwarmTaskTable.id, taskID as never))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    const stale = yield* swarm.execute({
      rootID: root.id,
      action: "task.review",
      swarmId: swarmID,
      taskId: taskID,
      decision: "accept",
      expectedLeaseGeneration: 3,
    }).pipe(Effect.flip)
    expect(stale._tag).toBe("OXP_CONFLICT")

    const accepted = yield* swarm.execute({
      rootID: root.id,
      action: "task.review",
      swarmId: swarmID,
      taskId: taskID,
      decision: "accept",
      expectedLeaseGeneration: 4,
    })
    expect(accepted.metadata).toMatchObject({ taskId: taskID, status: "completed" })

    const detail = yield* swarm.execute({ rootID: root.id, action: "get", swarmId: swarmID })
    const task = (detail.structured as { tasks: Array<{ id: string; status: string; leaseGeneration: number }> }).tasks
      .find((item) => item.id === taskID)
    expect(task).toMatchObject({ status: "completed", leaseGeneration: 5 })
  }))

  it.live("refuses member.add with an unrunnable profile and leaves no durable member row", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "Member profile admission",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id

    const denied = yield* swarm.execute({
      rootID: root.id,
      action: "member.add",
      swarmId: swarmID,
      memberName: "ghost",
      memberRole: "research",
      // A provider/model pair no catalog can resolve. Preflight owns this
      // rejection, so it must land before addMember commits anything.
      desiredProfile: {
        agent: Agent.ID.make("build"),
        model: { providerID: Provider.ID.make("no-such-provider"), id: Model.ID.make("no-such-model") },
        permissionBoundary: [],
      },
      workspacePolicy: { mode: "shared-read" },
    }).pipe(Effect.flip)

    // The refusal must originate from the shared profile preflight, not from the
    // argument-presence guards above it.
    expect(denied.detail).toContain("Swarm operation rejected")
    expect(["OXP_INVALID_ARGUMENT", "OXP_NOT_FOUND"]).toContain(denied._tag)

    // Negative invariant: a refused profile creates zero durable members. Only
    // the connector-owned coordinator exists.
    const after = yield* swarm.execute({ rootID: root.id, action: "get", swarmId: swarmID })
    const members = (after.structured as { members: ReadonlyArray<{ name: string }> }).members
    expect(members.map((member) => member.name)).toEqual(["oxp-coordinator"])
  }))

  it.live("executes staged member.batch as a partial receipt without admitting invalid profiles", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "OXP batch admission",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id
    const response = yield* swarm.execute({
      rootID: root.id,
      action: "member.batch",
      swarmId: swarmID,
      members: [
        {
          name: "ghost-a",
          role: "research",
          desiredProfile: {
            agent: Agent.ID.make("missing-agent-a"),
            model: { providerID: Provider.ID.make("missing"), id: Model.ID.make("missing") },
            permissionBoundary: [],
          },
          workspacePolicy: { mode: "shared-read" },
        },
        {
          name: "ghost-b",
          role: "research",
          desiredProfile: {
            agent: Agent.ID.make("missing-agent-b"),
            model: { providerID: Provider.ID.make("missing"), id: Model.ID.make("missing") },
            permissionBoundary: [],
          },
          workspacePolicy: { mode: "shared-read" },
        },
      ],
    })
    expect(response.structured).toMatchObject({
      swarmId: swarmID,
      created: 0,
      satisfied: 0,
      failed: 2,
      receipts: [{ status: "failed" }, { status: "failed" }],
    })
    expect(response.metadata).toMatchObject({ status: "partial", count: 0, failedCount: 2 })
    const detail = yield* swarm.execute({ rootID: root.id, action: "get", swarmId: swarmID })
    expect((detail.structured as { members: unknown[] }).members).toHaveLength(1)
  }))

  it.live("rejects an unknown agent before catalog resolution and still writes no member row", Effect.gen(function* () {
    const { swarm, root } = yield* prepare()
    const created = yield* swarm.execute({
      rootID: root.id,
      action: "delegate",
      swarmName: "Member profile admission positive",
    })
    const swarmID = (created.structured as { swarm: { id: string } }).swarm.id

    // Agent resolution runs first, so this proves the gate short-circuits on the
    // cheap check and never reaches the provider catalog for a doomed request.
    const denied = yield* swarm.execute({
      rootID: root.id,
      action: "member.add",
      swarmId: swarmID,
      memberName: "ghost-agent",
      memberRole: "research",
      desiredProfile: {
        agent: Agent.ID.make("definitely-not-an-openfork-agent"),
        model: { providerID: Provider.ID.make("no-such-provider"), id: Model.ID.make("no-such-model") },
        permissionBoundary: [],
      },
      workspacePolicy: { mode: "shared-read" },
    }).pipe(Effect.flip)
    expect(denied.detail).toContain("must use the swarm-m agent mode")

    const after = yield* swarm.execute({ rootID: root.id, action: "get", swarmId: swarmID })
    expect((after.structured as { members: unknown[] }).members).toHaveLength(1)
  }))
})
