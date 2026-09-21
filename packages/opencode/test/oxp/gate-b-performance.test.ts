import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { OxpCapability } from "@/oxp/capability"
import { OxpConfig } from "@/oxp/config"
import { OxpRead } from "@/oxp/read"
import { OxpRoot } from "@/oxp/root"
import { OxpMcpControl } from "@/oxp/mcp-control"
import { OxpSessionControl } from "@/oxp/session-control"
import { OxpSystemOneControl } from "@/oxp/system-one-control"
import { ReadFilesystem } from "@/read/filesystem"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-gate-b-perf-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const noMcpControl = Layer.succeed(
  OxpMcpControl.Service,
  OxpMcpControl.Service.of({
    list: () => Effect.die("Gate B perf must not enter native MCP runtime"),
    call: () => Effect.die("Gate B perf must not enter native MCP runtime"),
  }),
)
const noSystemOneControl = Layer.succeed(
  OxpSystemOneControl.Service,
  OxpSystemOneControl.Service.of({
    infer: () => Effect.die("Gate B perf must not enter System One runtime control"),
  }),
)
const noSessionControl = Layer.succeed(
  OxpSessionControl.Service,
  OxpSessionControl.Service.of({
    pause: () => Effect.die("Gate B perf must not enter Session runtime control"),
    resume: () => Effect.die("Gate B perf must not enter Session runtime control"),
    abort: () => Effect.die("Gate B perf must not enter Session runtime control"),
    setSelection: () => Effect.die("Gate B perf must not enter Session runtime control"),
    send: () => Effect.die("Gate B perf must not enter Session runtime control"),
    turn: () => Effect.die("Gate B perf must not enter Session runtime control"),
    backgroundSubagents: () => Effect.die("Gate B perf must not enter Session runtime control"),
    todoGet: () => Effect.die("Gate B perf must not enter Session runtime control"),
    todoSet: () => Effect.die("Gate B perf must not enter Session runtime control"),
    checkpoint: () => Effect.die("Gate B perf must not enter Session runtime control"),
    goal: () => Effect.die("Gate B perf must not enter Session runtime control"),
  }),
)
const layer = AppNodeBuilder.build(
  LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, OxpRead.node, OxpCapability.node, OxpRoot.node, OxpConfig.node]),
  [
    [Global.node, globalLayer],
    [OxpMcpControl.node, noMcpControl],
    [OxpSystemOneControl.node, noSystemOneControl],
    [OxpSessionControl.node, noSessionControl],
  ],
)
const it = testEffect(layer)

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
const p95 = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] ?? 0

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OXP Gate B performance proof", () => {
  it.live("separates raw filesystem read cost from OXP admission/projection overhead", Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const read = yield* OxpRead.Service
    const capability = yield* OxpCapability.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const file = path.join(rootDir, "fixture.txt")
    yield* Effect.promise(() => fs.writeFile(file, Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n")))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    yield* ReadFilesystem.clampRead(afs, file, { offset: 1, limit: 20 })
    yield* read.execute({ rootID: root.id, path: "fixture.txt", offset: 1, limit: 20 })
    yield* capability.list()
    yield* capability.describe("read")

    const raw: number[] = []
    const wrapped: number[] = []
    const lists: number[] = []
    const describes: number[] = []
    for (let index = 0; index < 80; index++) {
      let start = performance.now()
      yield* ReadFilesystem.clampRead(afs, file, { offset: 1, limit: 20 })
      raw.push(performance.now() - start)

      start = performance.now()
      yield* read.execute({ rootID: root.id, path: "fixture.txt", offset: 1, limit: 20 })
      wrapped.push(performance.now() - start)
    }
    for (let index = 0; index < 300; index++) {
      let start = performance.now()
      yield* capability.list()
      lists.push(performance.now() - start)
      start = performance.now()
      yield* capability.describe("read")
      describes.push(performance.now() - start)
    }

    const report = {
      rawRead: { medianMs: median(raw), p95Ms: p95(raw), samples: raw.length },
      oxpRead: { medianMs: median(wrapped), p95Ms: p95(wrapped), samples: wrapped.length },
      adapterOverheadMedianMs: Math.max(0, median(wrapped) - median(raw)),
      capabilityList: { medianMs: median(lists), p95Ms: p95(lists), samples: lists.length },
      capabilityDescribe: { medianMs: median(describes), p95Ms: p95(describes), samples: describes.length },
    }
    console.log("OXP_GATE_B_PERF", JSON.stringify(report))

    expect(report.oxpRead.medianMs).toBeLessThan(100)
    expect(report.adapterOverheadMedianMs).toBeLessThan(100)
    expect(report.capabilityList.medianMs).toBeLessThan(25)
    expect(report.capabilityDescribe.medianMs).toBeLessThan(25)
  }), { timeout: 30_000 })
})
