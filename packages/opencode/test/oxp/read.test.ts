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
import { OxpGrounding } from "@/oxp/grounding"
import { OxpRead } from "@/oxp/read"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-read-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(LayerNode.group([OxpRead.node, OxpRoot.node, OxpConfig.node, OxpGrounding.node]), [[Global.node, globalLayer]])
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpRead", () => {
  it.live("reads bounded text through virtual paths and captures connector-scoped grounding", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const read = yield* OxpRead.Service
    const grounding = yield* OxpGrounding.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const file = path.join(rootDir, "a.ts")
    yield* Effect.promise(() => fs.writeFile(file, "one\ntwo\nthree\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    const result = yield* read.execute({ rootID: root.id, path: "a.ts", offset: 2, limit: 1 })
    const current = yield* config.get()

    expect(result.output).toContain(`/${root.alias}/a.ts`)
    expect(result.output).toContain("2: two")
    expect(result.output).not.toContain(rootDir)
    expect(result.metadata?.grounded).toBe(true)
    expect(grounding.scoped(current.connector.id).get(root.id, file)).toBeTruthy()
  }))

  it.live("lists directories without grounding them as file content", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const read = yield* OxpRead.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(path.join(rootDir, "src"), { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "src", "a.ts"), "a"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    const result = yield* read.execute({ rootID: root.id, path: "src" })
    expect(result.output).toContain("a.ts")
    expect(result.metadata?.directory).toBe(true)
    expect(result.output).not.toContain(rootDir)
  }))

  it.live("returns typed attachment handles for supported binary media without embedding native paths", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const read = yield* OxpRead.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "image.png"), Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    const result = yield* read.execute({ rootID: root.id, path: "image.png" })
    expect(result.attachments?.[0]?.handle).toBe(`/${root.alias}/image.png`)
    expect(result.attachments?.[0]?.mediaType).toBe("image/png")
    expect(JSON.stringify(result)).not.toContain(rootDir)
  }))

  it.live("batches known windows with a shared root default and refuses conflicting addressing", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const read = yield* OxpRead.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => Promise.all([fs.writeFile(path.join(rootDir, "a.txt"), "a\n"), fs.writeFile(path.join(rootDir, "b.txt"), "b\n")]))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    const result = yield* read.execute({
      rootID: root.id,
      reads: [{ path: "a.txt" }, { rootID: root.id, path: "b.txt" }],
    })
    expect(result.output).toContain(`/${root.alias}/a.txt`)
    expect(result.output).toContain(`/${root.alias}/b.txt`)
    const mixed = yield* read.execute({ path: `/${root.alias}/a.txt`, reads: [{ rootID: root.id, path: "b.txt" }] }).pipe(Effect.flip)
    expect(mixed._tag).toBe("OXP_INVALID_ARGUMENT")

    const otherDir = path.join(suite, "workspace-other")
    yield* Effect.promise(() => fs.mkdir(otherDir))
    const other = yield* roots.approve(otherDir)
    const conflicting = yield* read.execute({
      rootID: root.id,
      reads: [{ rootID: other.id, path: "other.txt" }],
    }).pipe(Effect.flip)
    expect(conflicting._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(conflicting.detail).toContain("conflicts")
  }))

  it.live("serves 1/3/6 concurrent direct reads without widening root scope", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const read = yield* OxpRead.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "fanout.txt"), "fanout\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    for (const count of [1, 3, 6] as const) {
      const results = yield* Effect.all(
        Array.from({ length: count }, () =>
          read.execute({ rootID: root.id, path: "fanout.txt" }),
        ),
        { concurrency: "unbounded" },
      )
      expect(results).toHaveLength(count)
      for (const result of results) {
        expect(result.output).toContain("fanout")
        expect(result.output).not.toContain(rootDir)
      }
    }
  }))

  it.live("propagates an already-cancelled invocation into the shared read executor", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const read = yield* OxpRead.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "hello\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })
    const controller = new AbortController()
    controller.abort()

    const cancelled = yield* read.execute({ rootID: root.id, path: "a.txt" }, controller.signal).pipe(Effect.flip)
    expect(cancelled._tag).toBe("OXP_CANCELLED")
  }))
})
