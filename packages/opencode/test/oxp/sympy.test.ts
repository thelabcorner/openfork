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
import { OxpSympy } from "@/oxp/sympy"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-sympy-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpSympy.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }))

describe("OxpSympy", () => {
  it.live("requires process authority and returns the canonical symbolic result", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sympy = yield* OxpSympy.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)

    const denied = yield* sympy.execute({ rootID: root.id, expr: "x**2 + 2*x + 1", operation: "factor" }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")

    yield* config.setGrant({ process: true })
    const result = yield* sympy.execute({ rootID: root.id, expr: "x**2 + 2*x + 1", operation: "factor" })
    expect(result.output).toContain("(x + 1)**2")
    expect(result.structured).toMatchObject({ status: "ok", kind: "expr", operation: "factor" })
    expect(JSON.stringify(result)).not.toContain(rootDir)
  }))

  it.live("advanced code cannot read ambient secret environment values", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sympy = yield* OxpSympy.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const key = "OPENFORK_OXP_SYMPY_API_KEY"
    const prior = process.env[key]
    process.env[key] = "must-not-reach-sympy"
    try {
      const result = yield* sympy.execute({
        rootID: root.id,
        code: `import os\nos.environ.get("${key}", "missing")`,
      })
      expect(result.output).toContain("missing")
      expect(result.output).not.toContain("must-not-reach-sympy")
    } finally {
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    }
  }))
})
