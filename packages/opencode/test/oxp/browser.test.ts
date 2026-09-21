import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import { Global } from "@opencode-ai/core/global"
import { OxpBrowser } from "@/oxp/browser"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-browser-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const requests: BrowserHostBroker.BrokerRequestInput[] = []

const brokerLayer = Layer.succeed(
  BrowserHostBroker.Service,
  BrowserHostBroker.Service.of({
    register: () => Effect.die("browser test does not register hosts"),
    dispatch: (request) => {
      requests.push(request)
      if (request.operation.name === "status") {
        return Effect.succeed({
          ok: true as const,
          requestId: "browser-status",
          elapsedMs: 1,
          result: {
            status: { connected: false, appearance: "system", recording: { active: false } },
            tabs: [],
          },
        })
      }
      if (request.operation.name === "visual_history") {
        return Effect.succeed({
          ok: true as const,
          requestId: "browser-history",
          elapsedMs: 2,
          result: { history: { root: ".snapeye", baselines: [], runs: [] } },
        })
      }
      return Effect.die(`unexpected browser operation ${request.operation.name}`)
    },
    abort: () => Effect.void,
    pushEvent: () => Effect.void,
    list: () => Effect.succeed([]),
    listTabs: () => Effect.succeed([]),
    assign: () => Effect.die("browser test does not assign tabs"),
    orphanSession: () => Effect.void,
  }),
)

const layer = AppNodeBuilder.build(LayerNode.group([OxpBrowser.node, OxpConfig.node, OxpRoot.node]), [
  [Global.node, Global.layerWith({ config: configDir, state: stateDir })],
  [BrowserHostBroker.node, brokerLayer],
])
const it = testEffect(layer)

beforeEach(async () => {
  requests.length = 0
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpBrowser", () => {
  it.live("is default-off and dispatches with an external connector principal rather than a fake Session", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const browser = yield* OxpBrowser.Service
    yield* config.setEnabled(true)

    const denied = yield* browser.execute({ operation: "status", args: {} }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
    expect(requests).toHaveLength(0)

    const granted = yield* config.setGrant({ browser: true })
    const missingParent = yield* browser.execute({ operation: "status", args: {} }).pipe(Effect.flip)
    expect(missingParent._tag).toBe("OXP_AUTH_DENIED")
    expect(requests).toHaveLength(0)

    const result = yield* browser.execute({ operation: "status", args: {} }, "parent-digest-one")
    expect(result.structured).toMatchObject({ status: { connected: false }, tabs: [] })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sessionId).toBeUndefined()
    expect(requests[0]?.messageId).toBeUndefined()
    expect(requests[0]?.principal).toEqual({
      kind: "external",
      principalId: `oxp:${granted.connector.id}:parent-digest-one`,
    })
    expect(requests[0]?.directory).toBeUndefined()
  }))

  it.live("binds SnapEye project operations to an explicit approved root", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const browser = yield* OxpBrowser.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ browser: true })

    const result = yield* browser.execute(
      { operation: "visual_history", rootID: root.id, args: {} },
      "parent-digest-one",
    )
    expect(result.structured).toEqual({ history: { root: ".snapeye", baselines: [], runs: [] } })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.directory).toBeTruthy()
    expect(path.basename(requests[0]?.directory ?? "")).toBe("workspace")
    expect(requests[0]?.principal?.kind).toBe("external")
  }))
})
