import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
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
    expect(denied.detail).toContain("Agent not found")

    const after = yield* swarm.execute({ rootID: root.id, action: "get", swarmId: swarmID })
    expect((after.structured as { members: unknown[] }).members).toHaveLength(1)
  }))
})
