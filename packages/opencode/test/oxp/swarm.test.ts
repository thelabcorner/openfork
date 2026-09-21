import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
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
})
