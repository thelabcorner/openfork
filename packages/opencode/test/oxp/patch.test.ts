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

  it.live("returns adjacent candidate context for ambiguous hunks so the caller can self-repair", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(rootDir, "dup.ts"),
        [
          "describe('first', () => {",
          "  const value = makeThing()",
          "})",
          "describe('second', () => {",
          "  const value = makeThing()",
          "})",
        ].join("\n"),
      ),
    )
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const error = yield* patch.execute({
      rootID: root.id,
      patchText: [
        "*** Begin Patch",
        "*** Update File: dup.ts",
        "@@",
        "-  const value = makeThing()",
        "+  const value = makeOtherThing()",
        "*** End Patch",
      ].join("\n"),
    }).pipe(Effect.flip)

    expect(error._tag).toBe("OXP_CONFLICT")
    expect(error.detail).toContain("Candidate contexts")
    expect(error.detail).toContain("describe('first'")
    expect(error.detail).toContain("describe('second'")
  }))

  it.live("applies clean files while reporting an independent conflicting file", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "b.txt"), "bravo-current\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "c.txt"), "charlie\n"))
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
        "-bravo-stale",
        "+BRAVO",
        "*** Update File: c.txt",
        "@@",
        "-charlie",
        "+CHARLIE",
        "*** End Patch",
      ].join("\n"),
    })

    expect(result.mutation).toEqual({ attempted: true, committed: true })
    expect(result.output).toContain("Skipped 1 conflicting file operation")
    expect(result.output).toContain("b.txt")
    expect(result.metadata).toMatchObject({
      applied: true,
      fileCount: 2,
      conflicts: [{ path: `/${root.alias}/b.txt`, phase: "preflight" }],
      resolution: { status: "partial", requested: 3, preflightReady: 2, applied: 2, satisfied: 0, conflicted: 1 },
    })
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "a.txt"), "utf8"))).toBe("ALPHA\n")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "b.txt"), "utf8"))).toBe("bravo-current\n")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "c.txt"), "utf8"))).toBe("CHARLIE\n")
  }))

  it.live("keeps apply:true fail-hard and atomic when any preflight file conflicts", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "b.txt"), "bravo-current\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "c.txt"), "charlie\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const error = yield* patch.execute({
      rootID: root.id,
      apply: true,
      patchText: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-alpha",
        "+ALPHA",
        "*** Update File: b.txt",
        "@@",
        "-bravo-stale",
        "+BRAVO",
        "*** Update File: c.txt",
        "@@",
        "-charlie",
        "+CHARLIE",
        "*** End Patch",
      ].join("\n"),
    }).pipe(Effect.flip)

    expect(error._tag).toBe("OXP_CONFLICT")
    expect(error.detail).toContain("b.txt")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "a.txt"), "utf8"))).toBe("alpha\n")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "b.txt"), "utf8"))).toBe("bravo-current\n")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "c.txt"), "utf8"))).toBe("charlie\n")
  }))

  it.live("dry-run classifies every file without mutating clean siblings", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "b.txt"), "bravo-current\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "c.txt"), "charlie\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const result = yield* patch.execute({
      rootID: root.id,
      apply: false,
      patchText: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-alpha",
        "+ALPHA",
        "*** Update File: b.txt",
        "@@",
        "-bravo-stale",
        "+BRAVO",
        "*** Update File: c.txt",
        "@@",
        "-charlie",
        "+CHARLIE",
        "*** End Patch",
      ].join("\n"),
    })

    expect(result.mutation).toEqual({ attempted: false, committed: false })
    expect(result.metadata).toMatchObject({
      applied: false,
      fileCount: 2,
      conflicts: [{ path: `/${root.alias}/b.txt`, phase: "preflight" }],
      resolution: { status: "partial", requested: 3, preflightReady: 2, applied: 0, satisfied: 0, conflicted: 1 },
    })
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "a.txt"), "utf8"))).toBe("alpha\n")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "b.txt"), "utf8"))).toBe("bravo-current\n")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "c.txt"), "utf8"))).toBe("charlie\n")
  }))

  it.live("treats an already-applied update retry as satisfied without rewriting", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })
    const request = {
      rootID: root.id,
      patchText: "*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+ALPHA\n*** End Patch",
    }

    const first = yield* patch.execute(request)
    expect(first.mutation).toEqual({ attempted: true, committed: true })
    const beforeRetry = yield* Effect.promise(() => fs.stat(path.join(rootDir, "a.txt")))
    const retry = yield* patch.execute(request)
    const afterRetry = yield* Effect.promise(() => fs.stat(path.join(rootDir, "a.txt")))

    expect(retry.mutation).toEqual({ attempted: false, committed: false })
    expect(retry.metadata).toMatchObject({
      applied: false,
      fileCount: 0,
      conflicts: [],
      satisfied: [{ path: `/${root.alias}/a.txt`, reason: "desired-state-already-present" }],
      resolution: { status: "satisfied", requested: 1, preflightReady: 0, applied: 0, satisfied: 1, conflicted: 0 },
    })
    expect(afterRetry.mtimeMs).toBe(beforeRetry.mtimeMs)
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "a.txt"), "utf8"))).toBe("ALPHA\n")
  }))

  it.live("recognizes exact add retries and already-absent deletes as satisfied", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const add = "*** Begin Patch\n*** Add File: a.txt\n+alpha\n*** End Patch"
    const addApplied = yield* patch.execute({ rootID: root.id, patchText: add })
    expect(addApplied.mutation).toEqual({ attempted: true, committed: true })
    const addRetry = yield* patch.execute({ rootID: root.id, patchText: add })
    expect(addRetry.metadata).toMatchObject({
      fileCount: 0,
      satisfied: [{ path: `/${root.alias}/a.txt`, reason: "desired-state-already-present" }],
    })

    const remove = "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch"
    const removeApplied = yield* patch.execute({ rootID: root.id, patchText: remove })
    expect(removeApplied.mutation).toEqual({ attempted: true, committed: true })
    const removeRetry = yield* patch.execute({ rootID: root.id, patchText: remove })
    expect(removeRetry.metadata).toMatchObject({
      fileCount: 0,
      satisfied: [{ path: `/${root.alias}/a.txt`, reason: "file-already-absent" }],
    })
  }))

  it.live("returns satisfied and conflict receipts together when no rewrite is needed", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "ALPHA\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "b.txt"), "bravo-current\n"))
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
        "-bravo-stale",
        "+BRAVO",
        "*** End Patch",
      ].join("\n"),
    })

    expect(result.mutation).toEqual({ attempted: false, committed: false })
    expect(result.metadata).toMatchObject({
      applied: false,
      fileCount: 0,
      conflicts: [{ path: `/${root.alias}/b.txt`, phase: "preflight" }],
      satisfied: [{ path: `/${root.alias}/a.txt`, reason: "desired-state-already-present" }],
      resolution: { status: "partial", requested: 2, preflightReady: 0, applied: 0, satisfied: 1, conflicted: 1 },
    })
    expect(result.output).toContain("Already satisfied 1 file operation")
    expect(result.output).toContain("1 conflicting file operation requires targeted retry")
  }))

  it.live("does not misclassify an ambiguous desired state as satisfied", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "dup.txt"), "new\nkeep\nnew\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const error = yield* patch.execute({
      rootID: root.id,
      patchText: "*** Begin Patch\n*** Update File: dup.txt\n@@\n-old\n+new\n*** End Patch",
    }).pipe(Effect.flip)

    expect(error._tag).toBe("OXP_CONFLICT")
    expect(error.detail).toContain("does not match")
  }))

  it.live("reports every independently detectable bad hunk in one same-file repair receipt", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "one\ntwo\nthree\nfour\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const error = yield* patch.execute({
      rootID: root.id,
      patchText: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-missing-one",
        "+ONE",
        "@@",
        "-missing-two",
        "+TWO",
        "*** End Patch",
      ].join("\n"),
    }).pipe(Effect.flip)

    expect(error._tag).toBe("OXP_CONFLICT")
    expect(error.detail).toContain("2 patch hunks could not be resolved safely")
    expect(error.detail).toContain("--- hunk 1 ---")
    expect(error.detail).toContain("--- hunk 2 ---")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "a.txt"), "utf8"))).toBe("one\ntwo\nthree\nfour\n")
  }))

  it.live("uses an exact unified-diff source line only to disambiguate otherwise-valid duplicate candidates", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "dup.txt"), "same\ntarget\nsame\ntarget\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const result = yield* patch.execute({
      rootID: root.id,
      format: "git",
      patchText: [
        "--- a/dup.txt",
        "+++ b/dup.txt",
        "@@ -3,2 +3,2 @@",
        "-same",
        "-target",
        "+SAME",
        "+target",
      ].join("\n"),
    })

    expect(result.mutation).toEqual({ attempted: true, committed: true })
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "dup.txt"), "utf8"))).toBe("same\ntarget\nSAME\ntarget\n")
  }))

  it.live("does not use a stale unified-diff source line as nearest-candidate authority", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const patch = yield* OxpPatch.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "dup.txt"), "same\ntarget\nsame\ntarget\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ write: true })

    const error = yield* patch.execute({
      rootID: root.id,
      format: "git",
      patchText: [
        "--- a/dup.txt",
        "+++ b/dup.txt",
        "@@ -2,2 +2,2 @@",
        "-same",
        "-target",
        "+SAME",
        "+target",
      ].join("\n"),
    }).pipe(Effect.flip)

    expect(error._tag).toBe("OXP_CONFLICT")
    expect(error.detail).toContain("matches 2 locations")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "dup.txt"), "utf8"))).toBe("same\ntarget\nsame\ntarget\n")
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
