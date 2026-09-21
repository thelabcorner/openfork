import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpPatch } from "@/oxp/patch"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-patch-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpPatch.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpPatch", () => {
  it.live("applies a verified multi-file patch under one explicit root", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "b.txt"), "bravo\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const result = yield* patch.execute({
      rootID: root.id,
      patchText: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-alpha",
        "+ALPHA",
        "*** Update File: b.txt",
        "@@",
        "-bravo",
        "+BRAVO",
        "*** End Patch",
      ].join("\n"),
    })
    expect(result.mutation).toEqual({ attempted: true, committed: true })
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "a.txt"), "utf8"))).toBe("ALPHA\n")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "b.txt"), "utf8"))).toBe("BRAVO\n")
    expect(JSON.stringify(result)).not.toContain(rootDir)
  }))

  it.live("dry-run is mutation-free and reports the virtual path", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })
    const result = yield* patch.execute({
      rootID: root.id,
      apply: false,
      showDiff: true,
      patchText: "*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+ALPHA\n*** End Patch",
    })
    expect(result.mutation).toEqual({ attempted: false, committed: false })
    expect(result.output).toContain(`/${root.alias}/a.txt`)
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "a.txt"), "utf8"))).toBe("alpha\n")
  }))

  it.live("refuses path escape and write revocation", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })
    const escape = yield* patch.execute({
      rootID: root.id,
      patchText: "*** Begin Patch\n*** Add File: ../escape.txt\n+nope\n*** End Patch",
    }).pipe(Effect.flip)
    expect(["OXP_PATH_ESCAPE", "OXP_INVALID_ARGUMENT"]).toContain(escape._tag)

    yield* config.setGrant({ write: false })
    const denied = yield* patch.execute({
      rootID: root.id,
      patchText: "*** Begin Patch\n*** Add File: safe.txt\n+nope\n*** End Patch",
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
  }))
})
