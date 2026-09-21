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
import { OxpEdit } from "@/oxp/edit"
import { OxpGrounding } from "@/oxp/grounding"
import { OxpRead } from "@/oxp/read"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-edit-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpEdit.node, OxpRead.node, OxpRoot.node, OxpConfig.node, OxpGrounding.node]),
  [[Global.node, globalLayer]],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpEdit", () => {
  it.live("reuses the precision edit engine under OXP authority without fabricating a Session", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const read = yield* OxpRead.Service
    const edit = yield* OxpEdit.Service
    const rootDir = path.join(suite, "workspace")
    const target = path.join(rootDir, "a.ts")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(target, "const value = 1\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true, write: true })

    yield* read.execute({ rootID: root.id, path: "a.ts" })
    const result = yield* edit.execute({
      rootID: root.id,
      path: "a.ts",
      oldString: "const value = 1",
      newString: "const value = 2",
    })

    expect(result.mutation).toEqual({ attempted: true, committed: true })
    expect(result.metadata?.path).toBe(`/${root.alias}/a.ts`)
    expect(result.output).not.toContain(rootDir)
    expect(String(result.metadata?.diff)).not.toContain(rootDir)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("const value = 2\n")
  }))

  it.live("hard-refuses a grounded file changed outside OXP after the read", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const read = yield* OxpRead.Service
    const edit = yield* OxpEdit.Service
    const rootDir = path.join(suite, "workspace")
    const target = path.join(rootDir, "a.txt")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(target, "alpha\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true, write: true })

    yield* read.execute({ rootID: root.id, path: "a.txt" })
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 8)))
    yield* Effect.promise(() => fs.writeFile(target, "bravo\n"))

    const denied = yield* edit.execute({
      rootID: root.id,
      path: "a.txt",
      oldString: "alpha",
      newString: "updated",
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_CONFLICT")
    expect(denied.message).toContain("read it again")
    expect(denied.message).not.toContain(rootDir)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("bravo\n")
  }))

  it.live("serializes same-file mutations and revalidates the loser against current bytes", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const edit = yield* OxpEdit.Service
    const rootDir = path.join(suite, "workspace")
    const target = path.join(rootDir, "a.txt")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(target, "one\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const run = (replacement: string) =>
      edit.execute({
        rootID: root.id,
        path: "a.txt",
        oldString: "one",
        newString: replacement,
      }).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      )
    const results = yield* Effect.all([run("first"), run("second")], { concurrency: 2 })
    expect(results.filter((item) => item.ok).length).toBe(1)
    const failure = results.find((item) => !item.ok)
    expect(failure && !failure.ok ? failure.error._tag : undefined).toBe("OXP_CONFLICT")
    const final = yield* Effect.promise(() => fs.readFile(target, "utf8"))
    expect(["first\n", "second\n"]).toContain(final)
  }))

  it.live("warns but safely validates a line-targeted edit when no prior OXP read exists", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const edit = yield* OxpEdit.Service
    const rootDir = path.join(suite, "workspace")
    const target = path.join(rootDir, "a.txt")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(target, "one\ntwo\nthree\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const result = yield* edit.execute({
      rootID: root.id,
      path: "a.txt",
      line: 2,
      oldText: "two",
      newText: "TWO",
    })
    expect(result.mutation?.committed).toBe(true)
    expect(result.metadata?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("no OXP read-grounding record")]))
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("one\nTWO\nthree\n")
  }))

  it.live("keeps write authority independent from read authority", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const edit = yield* OxpEdit.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "one\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true, write: false })

    const denied = yield* edit.execute({
      rootID: root.id,
      path: "a.txt",
      oldString: "one",
      newString: "two",
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
  }))
})
