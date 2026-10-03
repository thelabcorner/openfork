import { afterEach, describe, expect } from "bun:test"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ManagedWorktreeBinding } from "@opencode-ai/core/managed-worktree-binding"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { ManagedWorktreeBridge } from "../../src/worktree/managed/bridge"
import type { ManagedCreateInitializeInput } from "../../src/worktree/managed/request"
import { disposeAllInstances, TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { createResult, validCreateInput, wiredProtocolVersionResult, writeStagedFakeCli } from "./managed-fake-cli"

const itUnmanaged = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)

const itManaged = testEffect(
  LayerNode.compile(
    LayerNode.group([Worktree.node, ManagedWorktreeBridge.node, ManagedWorktreeBinding.node, FSUtil.node, Git.node]),
    [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
  ),
)

const WIN_TARGET = process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64")
const winManaged = WIN_TARGET ? itManaged.instance : itManaged.instance.skip

const PINNED_VERSION = "0.1.0-stage-a"
const HEAD = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1"
const BRANCH = "feature/managed-lifecycle"
const TARGET_NAME = "managed-target"

const scopedTmpdir = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const normalize = (input: string) => input.replace(/\\/g, "/").toLowerCase()

const canonicalKey = (directory: string) => {
  const key = DirectoryMaintenanceGuard.existingDirectoryKey(directory)
  if (key === undefined) throw new Error(`expected an existing physical directory key for ${directory}`)
  return key
}

function sha256(bytes: string) {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * A pinned staged payload plus the readiness inputs that make
 * `ManagedWorktreeBridge.resolveActivation` ready on this host.
 */
function readyStage(tmpPath: string, cliConfig: Record<string, unknown> = {}) {
  const stageRoot = path.join(tmpPath, "stage")
  const discoveryDirectory = path.join(tmpPath, "service-discovery")
  const controlPlaneRoot = path.join(tmpPath, "worktree-store")
  mkdirSync(discoveryDirectory, { recursive: true })
  mkdirSync(controlPlaneRoot, { recursive: true })

  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const helpers = [
    { id: "refs-block-clone" as const, relativePath: "helpers/refs-block-clone.exe", bytes: "dedupe-helper-bytes" },
    { id: "storage-probe" as const, relativePath: "helpers/storage-probe.exe", bytes: "probe-helper-bytes" },
  ]
  for (const helper of helpers) {
    const file = path.join(stageRoot, ...helper.relativePath.split("/"))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, helper.bytes, "utf8")
  }
  const manifest = {
    schemaVersion: 1,
    kind: "worktree-store-packaging-bundle",
    bundle: {
      name: "worktree-store",
      packageVersion: PINNED_VERSION,
      managedProtocolVersion: "1",
      sourceRevision: "rev-1",
      target: { os: "windows", arch },
    },
    helpers: helpers.map((helper) => ({
      id: helper.id,
      relativePath: helper.relativePath,
      sizeBytes: Buffer.byteLength(helper.bytes, "utf8"),
      sha256: sha256(helper.bytes),
      target: { os: "windows", arch },
      identity: {
        helperName:
          helper.id === "refs-block-clone" ? "worktree-store-refs-block-clone" : "worktree-store-storage-probe",
        helperVersion: "1.0.0",
        sourceCompatibility: `worktree-store/${helper.id}@1`,
        protocols:
          helper.id === "refs-block-clone"
            ? { manifest: { magic: "WTRFSBC1", version: 1 }, success: { schemaVersion: 1 } }
            : { success: { schemaVersion: 1 } },
      },
    })),
  }
  writeFileSync(
    path.join(stageRoot, "STAGE.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source: "pinned",
        targetKey: `win32-${arch}`,
        version: PINNED_VERSION,
        lockDigest: "a".repeat(64),
        archiveSha256: "b".repeat(64),
        archiveSize: 4096,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  writeFileSync(path.join(stageRoot, "VERSION"), `${PINNED_VERSION}\n`, "utf8")
  writeFileSync(path.join(stageRoot, "worktree-store-bundle.json"), JSON.stringify(manifest), "utf8")

  const results = { "protocol-version": wiredProtocolVersionResult(), ...(cliConfig.results ?? {}) }
  const cli = writeStagedFakeCli(stageRoot, { ...cliConfig, results })
  const activation: ManagedWorktreeBridge.ActivationOptions = {
    capability: {
      root: stageRoot,
      cli: "bin/fake-managed-cli.mjs",
      env: {},
      launcher: (input: { cliFile: string; root: string }) => ({
        path: process.execPath,
        argsPrefix: [input.cliFile, cli.configPath],
        cwd: input.root,
      }),
    },
    controlPlaneRoot,
    discoveryDirectory,
    env: {},
  }
  return { activation, capturePath: cli.capturePath }
}

const expectedRequest = (input: {
  targetPath: string
  branchName?: string
  worktreeId?: string
}): ManagedCreateInitializeInput => ({
  worktreeId: input.worktreeId ?? "wt_lifecycle",
  repositoryId: "repo_lifecycle",
  storageVolumeId: "vol_lifecycle",
  targetPath: input.targetPath,
  branchName: input.branchName ?? BRANCH,
  commitish: "HEAD",
  storagePolicy: validCreateInput().storagePolicy,
  storageProbe: validCreateInput().storageProbe,
  dedupe: validCreateInput().dedupe,
})

const managedOptions = (input: {
  targetPath: string
  branchName?: string
  activation?: ManagedWorktreeBridge.ActivationOptions
  worktreeId?: string
}): Worktree.ManagedCreateOptions => {
  const request = expectedRequest(input)
  return {
    activation: input.activation ?? {},
    request: {
      worktreeId: request.worktreeId,
      repositoryId: request.repositoryId,
      storageVolumeId: request.storageVolumeId,
      commitish: request.commitish,
      storagePolicy: request.storagePolicy,
      storageProbe: request.storageProbe,
      dedupe: request.dedupe,
      targetPath: request.targetPath,
      branchName: request.branchName,
    },
    binding: { installationId: "install_lifecycle", projectId: "project_lifecycle" },
  }
}

const waitReady = Effect.fn("ManagedLifecycleTest.waitReady")(function* () {
  const ready = yield* Deferred.make<{ name: string; branch?: string }>()
  const on = (evt: GlobalEvent) => {
    if (evt.payload.type !== Worktree.Event.Ready.type) return
    Deferred.doneUnsafe(ready, Effect.succeed(evt.payload.properties))
  }
  GlobalBus.on("event", on)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
  return yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
    }),
  )
})

const managedFailure = (exit: Exit.Exit<Worktree.Info, Worktree.Error>) => {
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.squash(exit.cause)
  return error instanceof Worktree.ManagedCreateFailedError ? error : undefined
}

describe("Worktree managed creation lifecycle", () => {
  afterEach(() => disposeAllInstances())

  itManaged.instance(
    "create without managed options keeps the unmanaged path even when the bridge is composed",
    () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const ready = yield* waitReady().pipe(Effect.forkScoped)
        const info = yield* svc.create({ name: "default-unmanaged" })
        yield* Fiber.join(ready)

        expect(normalize(info.directory)).toContain("/worktree/")
        expect(info.branch).toBe("opencode/default-unmanaged")
        const list = yield* svc.list()
        expect(list).toContainEqual(expect.objectContaining({ name: info.name, branch: info.branch }))

        yield* svc.remove({ directory: info.directory })
      }),
    { git: true },
  )

  itUnmanaged.instance(
    "managed options without a composed bridge fall back to the unmanaged path",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scopedTmpdir()
        const targetPath = path.join(tmp.path, TARGET_NAME)
        mkdirSync(targetPath, { recursive: true })
        const svc = yield* Worktree.Service
        const ready = yield* waitReady().pipe(Effect.forkScoped)

        const info = yield* svc.create(
          { name: "no-bridge-fallback" },
          managedOptions({ targetPath, branchName: "feature/no-bridge" }),
        )
        yield* Fiber.join(ready)

        expect(normalize(info.directory)).not.toBe(normalize(targetPath))
        expect(normalize(info.directory)).toContain("/worktree/")
        expect(info.branch).toBe("opencode/no-bridge-fallback")
        const list = yield* svc.list()
        expect(list).toContainEqual(expect.objectContaining({ name: info.name, branch: info.branch }))

        yield* svc.remove({ directory: info.directory })
      }),
    { git: true },
  )

  itManaged.instance(
    "unavailable managed readiness falls back to the unmanaged path with no durable intent",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scopedTmpdir()
        const targetPath = path.join(tmp.path, TARGET_NAME)
        mkdirSync(targetPath, { recursive: true })
        const svc = yield* Worktree.Service
        const bindings = yield* ManagedWorktreeBinding.Service
        const ready = yield* waitReady().pipe(Effect.forkScoped)

        const info = yield* svc.create(
          { name: "unready-fallback" },
          managedOptions({
            targetPath,
            branchName: "feature/unready",
            activation: {
              // An existing directory that is not a staged payload fails the
              // capability resolution before any managed side effect.
              capability: { root: tmp.path, env: {} },
              controlPlaneRoot: path.join(tmp.path, "worktree-store"),
              discoveryDirectory: path.join(tmp.path, "service-discovery"),
              env: {},
            },
          }),
        )
        yield* Fiber.join(ready)

        expect(normalize(info.directory)).toContain("/worktree/")
        expect(yield* bindings.get(targetPath)).toBeUndefined()

        yield* svc.remove({ directory: info.directory })
      }),
    { git: true },
  )

  winManaged(
    "a ready managed result activates the binding, skips the unmanaged git-add, and boots",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const tmp = yield* scopedTmpdir()
        const gitSvc = yield* Git.Service
        const svc = yield* Worktree.Service
        const bindings = yield* ManagedWorktreeBinding.Service

        const branchName = "feature/managed-ready"
        const targetPath = path.join(tmp.path, TARGET_NAME)
        // The manager owns materialization, so the target already exists as a
        // worktree: a leaked unmanaged `git worktree add` would fail here.
        const created = yield* gitSvc.run(["worktree", "add", "-b", branchName, targetPath], { cwd: test.directory })
        expect(created.exitCode).toBe(0)

        const stage = readyStage(tmp.path, {
          results: {
            "managed-create-initialize": createResult(expectedRequest({ targetPath, branchName }), {
              pathKey: canonicalKey(targetPath),
            }),
          },
        })
        const ready = yield* waitReady().pipe(Effect.forkScoped)
        const info = yield* svc.create(
          { name: "managed-ready" },
          managedOptions({ targetPath, branchName, activation: stage.activation }),
        )
        const props = yield* Fiber.join(ready)

        expect(normalize(info.directory)).toBe(normalize(targetPath))
        expect(info.branch).toBe(branchName)
        expect(props.name).toBe(info.name)

        const view = yield* bindings.get(targetPath)
        expect(view?.bindingState).toBe("active")
        expect(view?.worktreeId).toBe("wt_lifecycle")
        expect(view?.head).toBe(HEAD)

        yield* svc.remove({ directory: targetPath })
      }),
    { git: true },
  )

  winManaged(
    "a non-exact managed observation throws with reconcile-required evidence and never falls back",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scopedTmpdir()
        const targetPath = path.join(tmp.path, TARGET_NAME)
        mkdirSync(targetPath, { recursive: true })
        const svc = yield* Worktree.Service
        const bindings = yield* ManagedWorktreeBinding.Service

        const stage = readyStage(tmp.path, {
          results: {
            "managed-create-initialize": createResult(expectedRequest({ targetPath }), {
              pathKey: "c:/elsewhere/not-the-target",
            }),
          },
        })
        const exit = yield* Effect.exit(
          svc.create({ name: "managed-ambiguous" }, managedOptions({ targetPath, activation: stage.activation })),
        )

        const error = managedFailure(exit)
        expect(error).toBeDefined()
        expect(error?.reason).toBe("binding-not-activated")

        const view = yield* bindings.get(targetPath)
        expect(view?.bindingState).toBe("reconcile_required")
        const list = yield* svc.list()
        expect(list).toHaveLength(0)
      }),
    { git: true },
  )

  winManaged(
    "a manager failure throws with reconcile-required evidence and never falls back",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scopedTmpdir()
        const targetPath = path.join(tmp.path, TARGET_NAME)
        mkdirSync(targetPath, { recursive: true })
        const svc = yield* Worktree.Service
        const bindings = yield* ManagedWorktreeBinding.Service

        const stage = readyStage(tmp.path, {
          results: {
            "managed-create-initialize": createResult(expectedRequest({ targetPath }), { worktreeId: "wt_other" }),
          },
        })
        const exit = yield* Effect.exit(
          svc.create({ name: "managed-failure" }, managedOptions({ targetPath, activation: stage.activation })),
        )

        const error = managedFailure(exit)
        expect(error).toBeDefined()
        expect(error?.reason).toBe("ManagedWorktreeProtocolViolationError")

        const view = yield* bindings.get(targetPath)
        expect(view?.bindingState).toBe("reconcile_required")
        expect(view?.stateReason ?? "").toContain("managed-create-initialize failed")
        const list = yield* svc.list()
        expect(list).toHaveLength(0)
      }),
    { git: true },
  )

  winManaged(
    "an existing quarantined binding blocks managed creation and never falls back",
    () =>
      Effect.gen(function* () {
        const tmp = yield* scopedTmpdir()
        const targetPath = path.join(tmp.path, TARGET_NAME)
        mkdirSync(targetPath, { recursive: true })
        const svc = yield* Worktree.Service
        const bindings = yield* ManagedWorktreeBinding.Service
        const request = expectedRequest({ targetPath })

        const intent = yield* bindings.recordCreationIntent({
          directory: targetPath,
          installationId: "install_lifecycle",
          repositoryId: request.repositoryId,
          worktreeId: request.worktreeId,
          storageVolumeId: request.storageVolumeId,
          projectId: "project_lifecycle",
          branchRef: `refs/heads/${request.branchName}`,
          pinRef: `refs/worktree-store/pins/${request.worktreeId}`,
        })
        expect(intent.state).toBe("recorded")
        const quarantined = yield* bindings.activate({
          directory: targetPath,
          expectedGeneration: 1,
          operationId: "op_quarantine",
          observation: {
            installationId: "install_lifecycle",
            repositoryId: request.repositoryId,
            worktreeId: request.worktreeId,
            storageVolumeId: request.storageVolumeId,
            targetPath,
            pathKey: canonicalKey(targetPath),
            ownership: "managed",
            lifecycleState: "quarantined",
            durabilityClass: "quarantined",
            revision: 4,
            head: HEAD,
            branchRef: `refs/heads/${request.branchName}`,
            pinRef: `refs/worktree-store/pins/${request.worktreeId}`,
            createOperationId: "op_create",
            initializationOperationId: "op_initialize",
            quarantined: true,
          },
        })
        expect(quarantined.state).toBe("quarantined")

        const stage = readyStage(tmp.path)
        const exit = yield* Effect.exit(
          svc.create({ name: "managed-quarantined" }, managedOptions({ targetPath, activation: stage.activation })),
        )

        const error = managedFailure(exit)
        expect(error).toBeDefined()
        expect(error?.reason).toBe("binding-conflict")

        const view = yield* bindings.get(targetPath)
        expect(view?.bindingState).toBe("quarantined")
        const list = yield* svc.list()
        expect(list).toHaveLength(0)
      }),
    { git: true },
  )
})
