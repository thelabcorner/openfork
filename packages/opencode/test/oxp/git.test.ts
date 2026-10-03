import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { AppProcess, AppProcessError } from "@opencode-ai/core/process"
import { OxpConfig } from "@/oxp/config"
import { OxpGit } from "@/oxp/git"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-git-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpGit.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
)
const it = testEffect(layer)

let failureMode: "cancel" | "timeout" | "spawn" = "spawn"
let activeAbort: AbortController | undefined
const failingProcessLayer = Layer.mock(AppProcess.Service, {
  run: () =>
    Effect.gen(function* () {
      if (failureMode === "cancel") {
        activeAbort?.abort()
        return yield* new AppProcessError({
          command: "git rev-parse",
          cause: new Error("Aborted"),
        })
      }
      if (failureMode === "timeout") {
        return yield* new AppProcessError({
          command: "git rev-parse",
          cause: new Error("Timed out"),
        })
      }
      return yield* new AppProcessError({
        command: "git rev-parse",
        cause: new Error("spawn unavailable"),
      })
    }),
})
const failingLayer = AppNodeBuilder.build(
  LayerNode.group([OxpGit.node, OxpRoot.node, OxpConfig.node]),
  [
    [Global.node, Global.layerWith({ config: configDir, state: stateDir })],
    [AppProcess.node, failingProcessLayer],
  ],
)
const failingIt = testEffect(failingLayer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

const git = (dir: string, args: string[]) =>
  Effect.promise(() => Bun.$`git ${args}`.cwd(dir).quiet().nothrow().text())

describe("OxpGit", () => {
  failingIt.live("preserves cancellation, timeout, and process failure during worktree discovery", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const oxpGit = yield* OxpGit.Service
    const rootDir = path.join(suite, "failure-workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ git: true })

    failureMode = "cancel"
    activeAbort = new AbortController()
    const cancelled = yield* oxpGit
      .execute(
        { rootID: root.id, mode: "status" },
        activeAbort.signal,
      )
      .pipe(Effect.flip)
    expect(cancelled._tag).toBe("OXP_CANCELLED")

    failureMode = "timeout"
    activeAbort = undefined
    const timedOut = yield* oxpGit
      .execute({ rootID: root.id, mode: "status" })
      .pipe(Effect.flip)
    expect(timedOut._tag).toBe("OXP_TIMEOUT")

    failureMode = "spawn"
    const unavailable = yield* oxpGit
      .execute({ rootID: root.id, mode: "status" })
      .pipe(Effect.flip)
    expect(unavailable._tag).toBe("OXP_DEPENDENCY_UNAVAILABLE")
    expect(unavailable.detail).toContain("spawn unavailable")
  }))

  it.live("rejects mode-incompatible fields before consulting Git authority", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const oxpGit = yield* OxpGit.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* git(rootDir, ["init", "-q"])
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ git: false })

    const ignoredMessage = yield* oxpGit.execute({
      rootID: root.id,
      mode: "status",
      message: "must-not-be-ignored",
    }).pipe(Effect.flip)
    expect(ignoredMessage._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(ignoredMessage.detail).toContain("git status does not accept: message")

    const missingRef = yield* oxpGit.execute({
      rootID: root.id,
      mode: "show",
    }).pipe(Effect.flip)
    expect(missingRef._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(missingRef.detail).toContain("show mode requires ref")

    const missingArgv = yield* oxpGit.execute({
      rootID: root.id,
      mode: "shell",
    }).pipe(Effect.flip)
    expect(missingArgv._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(missingArgv.detail).toContain("shell mode requires argv")
  }))

  it.live("shares the typed Git executor for read and write operations without a Session", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const oxpGit = yield* OxpGit.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* git(rootDir, ["init", "-q"])
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ git: true })

    const status = yield* oxpGit.execute({ rootID: root.id, mode: "status" })
    expect(status.output).toContain("a.txt")
    expect(status.mutation).toEqual({ attempted: false, committed: false })

    const staged = yield* oxpGit.execute({ rootID: root.id, mode: "stage", paths: ["a.txt"] })
    expect(staged.output).toContain("<staged")
    expect(staged.mutation).toEqual({ attempted: true, committed: true })
    expect(yield* git(rootDir, ["diff", "--cached", "--name-only"])).toContain("a.txt")
    expect(JSON.stringify(staged)).not.toContain(rootDir)
  }))

  it.live("treats commit dry-run as read-only and confirmation as part of the real mutation contract", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const oxpGit = yield* OxpGit.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* git(rootDir, ["init", "-q"])
    yield* git(rootDir, ["config", "user.email", "oxp@test.invalid"])
    yield* git(rootDir, ["config", "user.name", "OXP Test"])
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"))
    yield* git(rootDir, ["add", "a.txt"])
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ git: true })

    const dry = yield* oxpGit.execute({ rootID: root.id, mode: "commit", message: "first" })
    expect(dry.output).toContain('dry-run="true"')
    expect(dry.mutation).toEqual({ attempted: false, committed: false })

    const noConfirm = yield* oxpGit.execute({
      rootID: root.id,
      mode: "commit",
      message: "first",
      dryRun: false,
    }).pipe(Effect.flip)
    expect(noConfirm._tag).toBe("OXP_CONFLICT")

    const committed = yield* oxpGit.execute({
      rootID: root.id,
      mode: "commit",
      message: "first",
      dryRun: false,
      confirm: "COMMIT",
    })
    expect(committed.mutation).toEqual({ attempted: true, committed: true })
    expect(yield* git(rootDir, ["log", "-1", "--format=%s"])).toContain("first")
  }))

  it.live("selects a nested repository worktree inside an approved parent root", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const oxpGit = yield* OxpGit.Service
    const parentDir = path.join(suite, "workspace")
    const repoDir = path.join(parentDir, "opencode")
    yield* Effect.promise(() => fs.mkdir(repoDir, { recursive: true }))
    yield* git(repoDir, ["init", "-q"])
    yield* Effect.promise(() => fs.writeFile(path.join(repoDir, "nested.txt"), "nested repo\n"))
    const root = yield* roots.approve(parentDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ git: true })

    const ambiguous = yield* oxpGit.execute({ rootID: root.id, mode: "status" }).pipe(Effect.flip)
    expect(ambiguous._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(ambiguous.detail).toContain("provide workdir")

    const status = yield* oxpGit.execute({ rootID: root.id, workdir: "opencode", mode: "status" })
    expect(status.output).toContain("nested.txt")
    expect(status.metadata).toMatchObject({ workdir: "opencode" })
  }))

  it.live("keeps Git authority independent from ordinary read/write grants", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const oxpGit = yield* OxpGit.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* git(rootDir, ["init", "-q"])
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true, write: true, git: false })

    const denied = yield* oxpGit.execute({ rootID: root.id, mode: "status" }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
  }))
})
