import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Schema } from "effect"
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
  it.live("returns typed root-required for relative edits without explicit root identity", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const edit = yield* OxpEdit.Service
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const error = yield* edit.execute({
      path: "relative.txt",
      oldString: "one",
      newString: "two",
    }).pipe(Effect.flip)
    expect(error._tag).toBe("OXP_ROOT_REQUIRED")
    expect(error.detail).toContain("explicit approved root")
  }))

  it.live("self-heals explicit edit content into atomic create/replace semantics", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const edit = yield* OxpEdit.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const created = yield* edit.execute({
      rootID: root.id,
      path: "new-guide.md",
      content: "# Storage Guide\n\nUse the write surface when you already have the whole file.\n",
    })
    expect(created.mutation).toEqual({ attempted: true, committed: true })
    expect(created.metadata).toMatchObject({ routedFrom: "edit", routedTo: "write" })
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "new-guide.md"), "utf8"))).toContain(
      "Use the write surface",
    )

    const replaced = yield* edit.execute({
      rootID: root.id,
      path: "new-guide.md",
      content: "# Replacement\n",
    })
    expect(replaced.metadata).toMatchObject({ routedFrom: "edit", routedTo: "write" })
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "new-guide.md"), "utf8"))).toBe(
      "# Replacement\n",
    )
  }))

  it.live("self-heals only unambiguous missing-file creation-shaped edit requests", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const edit = yield* OxpEdit.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const cases = [
      {
        name: "empty-old.md",
        input: { oldString: "", newString: "created from empty oldString\n" },
        expected: "created from empty oldString\n",
      },
      {
        name: "prepend.md",
        input: { insertAt: 0, newText: "created from prepend\n" },
        expected: "created from prepend\n",
      },
      {
        name: "append.md",
        input: { appendFile: true as const, newText: "created from append\n" },
        expected: "created from append\n",
      },
    ]

    for (const item of cases) {
      const result = yield* edit.execute({ rootID: root.id, path: item.name, ...item.input })
      expect(result.metadata).toMatchObject({ routedFrom: "edit", routedTo: "write" })
      expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, item.name), "utf8"))).toBe(item.expected)
    }

    const ambiguous = yield* edit.execute({
      rootID: root.id,
      path: "ambiguous.md",
      oldString: "something expected",
      newString: "replacement",
    }).pipe(Effect.flip)
    expect(ambiguous._tag).toBe("OXP_NOT_FOUND")
    expect(ambiguous.detail).toContain("retry this same edit tool with content")
  }))

  it.live("publishes a typed transport envelope while runtime rejects mixed and underspecified strategies", Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(OxpEdit.Parameters, { onExcessProperty: "error" })
    const exact = yield* decode({ path: "a.ts", oldString: "one", newString: "two" })
    expect(exact).toMatchObject({ path: "a.ts", oldString: "one", newString: "two" })
    const content = yield* decode({ path: "a.ts", content: "whole file" })
    expect(content).toMatchObject({ path: "a.ts", content: "whole file" })
    const prepend = yield* decode({ path: "a.ts", insertAt: 0, newText: "header" })
    expect(prepend).toMatchObject({ path: "a.ts", insertAt: 0, newText: "header" })

    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const edit = yield* OxpEdit.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.ts"), "one\ntwo\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    for (const input of [
      {
        rootID: root.id,
        path: "a.ts",
        oldString: "one",
        newString: "two",
        startLine: 1,
        endLine: 2,
        oldText: "one",
      },
      {
        rootID: root.id,
        path: "a.ts",
        startLine: 1,
        endLine: 2,
        newText: "replacement",
      },
      {
        rootID: root.id,
        path: "a.ts",
        insertAt: 1,
        newText: "replacement",
      },
    ]) {
      const error = yield* edit.execute(input).pipe(Effect.flip)
      expect(error._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(error.detail).toContain("exactly one strategy")
    }

    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "a.ts"), "utf8"))).toBe("one\ntwo\n")
  }))

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

  it.live("treats an identical exact replacement as a successful no-op", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const edit = yield* OxpEdit.Service
    const rootDir = path.join(suite, "workspace")
    const target = path.join(rootDir, "a.txt")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(target, "alpha\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const result = yield* edit.execute({
      rootID: root.id,
      path: "a.txt",
      oldString: "alpha",
      newString: "alpha",
    })

    expect(result.mutation).toEqual({ attempted: false, committed: false })
    expect(result.output).toContain("No changes to apply")
    expect(result.output).not.toContain(rootDir)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("alpha\n")
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
