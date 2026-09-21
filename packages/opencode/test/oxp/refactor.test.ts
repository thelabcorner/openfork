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
import { OxpRefactor } from "@/oxp/refactor"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-refactor-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpRefactor.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }))

const prepare = Effect.fnUntraced(function* () {
  const config = yield* OxpConfig.Service
  const roots = yield* OxpRoot.Service
  const refactor = yield* OxpRefactor.Service
  const rootDir = path.join(suite, "workspace")
  yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
  const root = yield* roots.approve(rootDir)
  yield* config.setEnabled(true)
  return { config, roots, refactor, rootDir, root }
})

describe("OxpRefactor", () => {
  it.live("resolves symbols with read authority only and never leaks native root paths", Effect.gen(function* () {
    const { config, refactor, rootDir, root } = yield* prepare()
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.ts"), "export const value = 1\n", "utf8"))
    yield* config.setGrant({ read: true })

    const result = yield* refactor.execute({
      rootID: root.id,
      mode: "resolveSymbol",
      filePath: "a.ts",
      line: 1,
      column: 14,
    })
    expect(result.output).toContain("<symbol")
    expect(result.structured).toMatchObject({ mode: "resolveSymbol", status: "preview" })
    expect(JSON.stringify(result)).not.toContain(rootDir)
    expect(result.mutation).toBeUndefined()
  }))

  it.live("gates durable preview plans and source commits independently behind write authority", Effect.gen(function* () {
    const { config, refactor, rootDir, root } = yield* prepare()
    const file = path.join(rootDir, "a.ts")
    yield* Effect.promise(() => fs.writeFile(file, "import x from 'old-module'\nexport { x }\n", "utf8"))
    yield* config.setGrant({ read: true })

    const denied = yield* refactor.execute({
      rootID: root.id,
      mode: "updateImportSource",
      filePath: "a.ts",
      from: "old-module",
      to: "new-module",
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("old-module")

    yield* config.setGrant({ write: true })
    const preview = yield* refactor.execute({
      rootID: root.id,
      mode: "updateImportSource",
      filePath: "a.ts",
      from: "old-module",
      to: "new-module",
    })
    const previewID = String((preview.structured as { previewId?: string }).previewId)
    expect(previewID).toMatch(/^ref_[A-Za-z0-9_-]+$/)
    expect(preview.mutation).toEqual({ attempted: true, committed: true })
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("old-module")

    const applied = yield* refactor.execute({
      rootID: root.id,
      mode: "updateImportSource",
      filePath: "a.ts",
      from: "old-module",
      to: "new-module",
      previewId: previewID,
      dryRun: false,
      confirm: "REFACTOR",
      runTypecheck: false,
    })
    expect(applied.mutation).toEqual({ attempted: true, committed: true })
    expect((applied.structured as { status: string }).status).toBe("applied")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("new-module")
  }))

  it.live("rejects paths outside the approved root before refactor execution", Effect.gen(function* () {
    const { config, refactor, rootDir, root } = yield* prepare()
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => fs.mkdir(outsideDir))
    const outside = path.join(outsideDir, "outside.ts")
    yield* Effect.promise(() => fs.writeFile(outside, "export const outside = 1\n", "utf8"))
    yield* config.setGrant({ read: true, write: true })

    const escaped = yield* refactor.execute({
      rootID: root.id,
      mode: "resolveSymbol",
      filePath: outside,
      line: 1,
      column: 14,
    }).pipe(Effect.flip)
    expect(escaped._tag).toBe("OXP_PATH_ESCAPE")
    expect(rootDir).not.toBe(outsideDir)
  }))

  it.live("requires process authority only when confirmed apply reaches a real typecheck", Effect.gen(function* () {
    const { config, refactor, rootDir, root } = yield* prepare()
    const file = path.join(rootDir, "a.ts")
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(file, "import x from 'old-module'\nexport { x }\n", "utf8"),
        fs.writeFile(
          path.join(rootDir, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true }, include: ["*.ts"] }),
          "utf8",
        ),
      ]),
    )
    yield* config.setGrant({ read: true, write: true })

    const preview = yield* refactor.execute({
      rootID: root.id,
      mode: "updateImportSource",
      filePath: "a.ts",
      from: "old-module",
      to: "new-module",
    })
    const previewID = String((preview.structured as { previewId?: string }).previewId)

    const denied = yield* refactor.execute({
      rootID: root.id,
      mode: "updateImportSource",
      filePath: "a.ts",
      from: "old-module",
      to: "new-module",
      previewId: previewID,
      dryRun: false,
      confirm: "REFACTOR",
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("old-module")

    yield* config.setGrant({ process: true })
    const applied = yield* refactor.execute({
      rootID: root.id,
      mode: "updateImportSource",
      filePath: "a.ts",
      from: "old-module",
      to: "new-module",
      previewId: previewID,
      dryRun: false,
      confirm: "REFACTOR",
    })
    expect((applied.structured as { status: string }).status).toBe("applied")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("new-module")
  }))

  it.live("rejects a stale saved preview before mutating source", Effect.gen(function* () {
    const { config, refactor, rootDir, root } = yield* prepare()
    const file = path.join(rootDir, "a.ts")
    yield* Effect.promise(() => fs.writeFile(file, "import x from 'old-module'\nexport { x }\n", "utf8"))
    yield* config.setGrant({ read: true, write: true })

    const preview = yield* refactor.execute({
      rootID: root.id,
      mode: "updateImportSource",
      filePath: "a.ts",
      from: "old-module",
      to: "new-module",
    })
    const previewID = String((preview.structured as { previewId?: string }).previewId)
    yield* Effect.promise(() => fs.appendFile(file, "// external change\n", "utf8"))

    const stale = yield* refactor.execute({
      rootID: root.id,
      mode: "updateImportSource",
      filePath: "a.ts",
      from: "old-module",
      to: "new-module",
      previewId: previewID,
      dryRun: false,
      confirm: "REFACTOR",
      runTypecheck: false,
    }).pipe(Effect.flip)

    expect(stale._tag).toBe("OXP_CONFLICT")
    const current = yield* Effect.promise(() => fs.readFile(file, "utf8"))
    expect(current).toContain("old-module")
    expect(current).toContain("// external change")
  }))
})
