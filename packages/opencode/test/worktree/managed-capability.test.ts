import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { ProtocolViolationError, UnavailableError } from "../../src/worktree/managed/client"
import {
  CAPABILITY_CODES,
  ManagedWorktreeCapability,
  WORKTREE_STORE_BUNDLE_MANIFEST_FILE,
  WORKTREE_STORE_CLI_ENV,
  WORKTREE_STORE_DISCOVERY_DIR_ENV,
  WORKTREE_STORE_ROOT_ENV,
  WORKTREE_STORE_STAGE_FILE,
  WORKTREE_STORE_VERSION_FILE,
  assertBundleRelativePath,
  currentTargetKey,
} from "../../src/worktree/managed/capability"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { FAKE_CLI_SOURCE, protocolVersionResult, wiredProtocolVersionResult, writeStagedFakeCli } from "./managed-fake-cli"

const HOST_TARGET = currentTargetKey(process.platform, process.arch)
const HOST_ARCH = HOST_TARGET?.split("-")[1] ?? "x64"
const OTHER_ARCH = HOST_ARCH === "arm64" ? "x64" : "arm64"
const PINNED_VERSION = "0.1.0-stage-a"

const it = testEffect(LayerNode.compile(LayerNode.group([ManagedWorktreeCapability.node])))
const live = it.live
const liveWindows = HOST_TARGET === undefined ? live.skip : live
const liveNonWindows = HOST_TARGET === undefined ? live : live.skip

const scopedTmpdir = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function helperEntry(id: "refs-block-clone" | "storage-probe", relativePath: string, bytes: string) {
  const protocols =
    id === "refs-block-clone"
      ? { manifest: { magic: "WTRFSBC1", version: 1 }, success: { schemaVersion: 1 } }
      : { success: { schemaVersion: 1 } }
  return {
    id,
    relativePath,
    sizeBytes: Buffer.byteLength(bytes, "utf8"),
    sha256: sha256(bytes),
    target: { os: "windows", arch: HOST_ARCH },
    identity: {
      helperName: id === "refs-block-clone" ? "worktree-store-refs-block-clone" : "worktree-store-storage-probe",
      helperVersion: "1.0.0",
      sourceCompatibility: `worktree-store/${id}@1`,
      protocols,
    },
  }
}

function bundleManifest(helpers: unknown[], bundleOverrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "worktree-store-packaging-bundle",
    bundle: {
      name: "worktree-store",
      packageVersion: PINNED_VERSION,
      managedProtocolVersion: "1",
      sourceRevision: "rev-1",
      target: { os: "windows", arch: HOST_ARCH },
      ...bundleOverrides,
    },
    helpers,
  }
}

function stageDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    source: "pinned",
    targetKey: HOST_TARGET,
    version: PINNED_VERSION,
    lockDigest: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    archiveSize: 4096,
    ...overrides,
  }
}

interface StagedFixture {
  root: string
  cli: string
  configPath: string
  capturePath: string
}

function writeStage(
  root: string,
  options: {
    stage?: Record<string, unknown>
    manifest?: Record<string, unknown>
    version?: string
    helpers?: { id: "refs-block-clone" | "storage-probe"; relativePath: string; bytes: string }[]
    cliConfig?: Record<string, unknown>
    skipStage?: boolean
    skipVersion?: boolean
    skipManifest?: boolean
  } = {},
): StagedFixture {
  mkdirSync(root, { recursive: true })
  const helperSpecs = options.helpers ?? [
    { id: "refs-block-clone" as const, relativePath: "helpers/refs-block-clone.exe", bytes: "dedupe-helper-bytes" },
    { id: "storage-probe" as const, relativePath: "helpers/storage-probe.exe", bytes: "probe-helper-bytes" },
  ]
  for (const spec of helperSpecs) {
    const file = path.join(root, ...spec.relativePath.split("/"))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, spec.bytes, "utf8")
  }
  const manifest =
    options.manifest ?? bundleManifest(helperSpecs.map((spec) => helperEntry(spec.id, spec.relativePath, spec.bytes)))
  const stage = options.stage ?? stageDocument()
  if (!options.skipStage) {
    writeFileSync(path.join(root, WORKTREE_STORE_STAGE_FILE), `${JSON.stringify(stage, null, 2)}\n`, "utf8")
  }
  if (!options.skipVersion) {
    writeFileSync(path.join(root, WORKTREE_STORE_VERSION_FILE), `${options.version ?? PINNED_VERSION}\n`, "utf8")
  }
  if (!options.skipManifest) {
    writeFileSync(path.join(root, WORKTREE_STORE_BUNDLE_MANIFEST_FILE), JSON.stringify(manifest), "utf8")
  }

  const cli = writeStagedFakeCli(root, {
    results: { "protocol-version": protocolVersionResult() },
    ...options.cliConfig,
  })
  return { root, cli: cli.cliRelativePath, configPath: cli.configPath, capturePath: cli.capturePath }
}

const bunLauncher = (fixture: StagedFixture) => (input: { cliFile: string; root: string }) => ({
  path: process.execPath,
  argsPrefix: [input.cliFile, fixture.configPath],
  cwd: input.root,
})

function resolveError(options: {
  root?: string
  cli?: string
  discoveryDirectory?: string
  mode?: "production" | "dev"
  env?: Record<string, string | undefined>
  launcher?: (input: { cliFile: string; root: string }) => { path: string; argsPrefix: string[]; cwd?: string }
}) {
  return Effect.gen(function* () {
    const capability = yield* ManagedWorktreeCapability.Service
    return yield* capability.resolve({ env: {}, ...options }).pipe(Effect.flip)
  })
}

describe("managed worktree capability", () => {
  liveWindows("resolves a pinned stage and caches by stage digest", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path)
      const capability = yield* ManagedWorktreeCapability.Service
      const first = yield* capability.resolve({
        root: fixture.root,
        cli: fixture.cli,
        env: {},
        launcher: bunLauncher(fixture),
      })
      expect(first.mode).toBe("production")
      expect(first.version).toBe(PINNED_VERSION)
      expect(first.stage.source).toBe("pinned")
      expect(first.helpers).toHaveLength(2)
      expect(first.neverFallsBackToUnmanagedGit).toBe(true)
      expect(first.cliFile).toContain("fake-managed-cli.mjs")
      expect(Object.isFrozen(first)).toBe(true)

      const cached = yield* capability.resolve({
        root: fixture.root,
        cli: fixture.cli,
        env: {},
        launcher: bunLauncher(fixture),
      })
      expect(cached).toBe(first)

      writeFileSync(
        path.join(tmp.path, WORKTREE_STORE_STAGE_FILE),
        `${JSON.stringify(stageDocument({ lockDigest: "c".repeat(64) }), null, 2)}\n`,
        "utf8",
      )
      const refreshed = yield* capability.resolve({
        root: fixture.root,
        cli: fixture.cli,
        env: {},
        launcher: bunLauncher(fixture),
      })
      expect(refreshed).not.toBe(first)
      expect(refreshed.stage.lockDigest).toBe("c".repeat(64))
    }),
  )

  live("rejects a missing stage root", () =>
    Effect.gen(function* () {
      const error = yield* resolveError({})
      expect(error).toBeInstanceOf(UnavailableError)
      expect((error as UnavailableError).code).toBe(CAPABILITY_CODES.rootMissing)
    }),
  )

  live("rejects a non-directory root, a root inside app.asar, and a relative root", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const file = path.join(tmp.path, "not-a-directory.txt")
      writeFileSync(file, "x", "utf8")
      const notDirectory = yield* resolveError({ root: file, cli: "bin/cli.exe" })
      expect((notDirectory as UnavailableError).code).toBe(CAPABILITY_CODES.rootNotDirectory)

      const asar = yield* resolveError({ root: path.join(tmp.path, "app.asar", "worktree-store"), cli: "cli.exe" })
      expect((asar as UnavailableError).code).toBe(CAPABILITY_CODES.rootInsideAsar)

      const relative = yield* resolveError({ root: "worktree-store", cli: "cli.exe" })
      expect((relative as UnavailableError).code).toBe(CAPABILITY_CODES.rootNotAbsolute)
    }),
  )

  liveWindows("rejects a missing STAGE.json, VERSION, or bundle manifest", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const empty = writeStage(tmp.path, { skipStage: true, skipVersion: true, skipManifest: true })
      const missingStage = yield* resolveError({ root: empty.root, cli: "cli.exe", launcher: bunLauncher(empty) })
      expect((missingStage as UnavailableError).code).toBe(CAPABILITY_CODES.stageMissing)

      const missingVersion = writeStage(path.join(tmp.path, "no-version"), { skipVersion: true })
      const versionError = yield* resolveError({
        root: missingVersion.root,
        cli: missingVersion.cli,
        launcher: bunLauncher(missingVersion),
      })
      expect((versionError as UnavailableError).code).toBe(CAPABILITY_CODES.stageMissing)

      const missingManifest = writeStage(path.join(tmp.path, "no-manifest"), { skipManifest: true })
      const manifestError = yield* resolveError({
        root: missingManifest.root,
        cli: missingManifest.cli,
        launcher: bunLauncher(missingManifest),
      })
      expect((manifestError as UnavailableError).code).toBe(CAPABILITY_CODES.manifestMissing)
    }),
  )

  liveWindows("rejects a dev-local stage in production but allows it in dev mode", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path, {
        stage: stageDocument({ source: "dev-local", version: "dev-local", archiveSha256: null, archiveSize: null }),
        version: "dev-local",
        helpers: [{ id: "refs-block-clone", relativePath: "helpers/refs-block-clone.exe", bytes: "dedupe-helper-bytes" }],
      })
      const rejected = yield* resolveError({
        root: fixture.root,
        cli: fixture.cli,
        launcher: bunLauncher(fixture),
      })
      expect(rejected).toBeInstanceOf(UnavailableError)
      expect((rejected as UnavailableError).code).toBe(CAPABILITY_CODES.devLocalInProduction)

      const capability = yield* ManagedWorktreeCapability.Service
      const descriptor = yield* capability.resolve({
        root: fixture.root,
        cli: fixture.cli,
        mode: "dev",
        env: {},
        launcher: bunLauncher(fixture),
      })
      expect(descriptor.mode).toBe("dev")
      expect(descriptor.stage.source).toBe("dev-local")
    }),
  )

  liveWindows("rejects a stage for another target", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path, { stage: stageDocument({ targetKey: `win32-${OTHER_ARCH}` }) })
      const error = yield* resolveError({
        root: fixture.root,
        cli: fixture.cli,
        launcher: bunLauncher(fixture),
      })
      expect((error as UnavailableError).code).toBe(CAPABILITY_CODES.targetMismatch)
    }),
  )

  liveWindows("rejects version and protocol mismatches between VERSION, STAGE, and bundle", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const versionMismatch = writeStage(path.join(tmp.path, "version"), { version: "9.9.9" })
      const versionError = yield* resolveError({
        root: versionMismatch.root,
        cli: versionMismatch.cli,
        launcher: bunLauncher(versionMismatch),
      })
      expect((versionError as UnavailableError).code).toBe(CAPABILITY_CODES.versionMismatch)

      const packageMismatch = writeStage(path.join(tmp.path, "package"), {
        manifest: bundleManifest(
          [helperEntry("refs-block-clone", "helpers/refs-block-clone.exe", "dedupe-helper-bytes")],
          { packageVersion: "0.0.9" },
        ),
      })
      const packageError = yield* resolveError({
        root: packageMismatch.root,
        cli: packageMismatch.cli,
        launcher: bunLauncher(packageMismatch),
      })
      expect((packageError as UnavailableError).code).toBe(CAPABILITY_CODES.versionMismatch)

      const protocolMismatch = writeStage(path.join(tmp.path, "protocol"), {
        manifest: bundleManifest(
          [helperEntry("refs-block-clone", "helpers/refs-block-clone.exe", "dedupe-helper-bytes")],
          { managedProtocolVersion: "2" },
        ),
      })
      const protocolError = yield* resolveError({
        root: protocolMismatch.root,
        cli: protocolMismatch.cli,
        launcher: bunLauncher(protocolMismatch),
      })
      expect((protocolError as UnavailableError).code).toBe(CAPABILITY_CODES.protocolUnsupported)
    }),
  )

  liveWindows("rejects helper digest drift and missing helper bytes", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path)
      writeFileSync(path.join(tmp.path, "helpers", "refs-block-clone.exe"), "tampered-helper-bytes", "utf8")
      const error = yield* resolveError({
        root: fixture.root,
        cli: fixture.cli,
        launcher: bunLauncher(fixture),
      })
      expect(error).toBeInstanceOf(UnavailableError)
      expect((error as UnavailableError).code).toBe(CAPABILITY_CODES.helperInvalid)

      const short = writeStage(path.join(tmp.path, "short-helper"), {
        helpers: [{ id: "refs-block-clone", relativePath: "helpers/refs-block-clone.exe", bytes: "dedupe-helper-bytes" }],
      })
      writeFileSync(path.join(tmp.path, "short-helper", "helpers", "refs-block-clone.exe"), "short", "utf8")
      const shortError = yield* resolveError({
        root: short.root,
        cli: short.cli,
        launcher: bunLauncher(short),
      })
      expect((shortError as UnavailableError).code).toBe(CAPABILITY_CODES.helperInvalid)
    }),
  )

  liveWindows("rejects a CLI outside the stage root or missing entirely", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path)
      writeFileSync(path.join(tmp.path, "outside-cli.mjs"), "// outside", "utf8")

      const escape = yield* resolveError({
        root: fixture.root,
        cli: "../outside-cli.mjs",
        launcher: bunLauncher(fixture),
      })
      expect(escape).toBeInstanceOf(UnavailableError)
      expect((escape as UnavailableError).code).toBe(CAPABILITY_CODES.cliEscape)

      const absoluteEscape = yield* resolveError({
        root: fixture.root,
        cli: path.resolve(fixture.root, "..", "outside-cli.mjs"),
        launcher: bunLauncher(fixture),
      })
      expect((absoluteEscape as UnavailableError).code).toBe(CAPABILITY_CODES.cliEscape)

      const missing = yield* resolveError({
        root: fixture.root,
        cli: "bin/does-not-exist.exe",
        launcher: bunLauncher(fixture),
      })
      expect((missing as UnavailableError).code).toBe(CAPABILITY_CODES.cliMissing)
    }),
  )

  liveWindows("rejects a sidecar that would fall back to unmanaged Git", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const handshake = protocolVersionResult()
      const capabilities = { ...(handshake.capabilities as Record<string, unknown>) }
      capabilities.managedCreateInitialize = {
        ...(capabilities.managedCreateInitialize as Record<string, unknown>),
        neverFallsBackToUnmanagedGit: false,
      }
      const fixture = writeStage(tmp.path, {
        cliConfig: { results: { "protocol-version": { ...handshake, capabilities } } },
      })
      const error = yield* resolveError({
        root: fixture.root,
        cli: fixture.cli,
        launcher: bunLauncher(fixture),
      })
      expect(error).toBeInstanceOf(UnavailableError)
      expect((error as UnavailableError).code).toBe(CAPABILITY_CODES.fallbackForbidden)
    }),
  )

  liveWindows("rejects a sidecar that reports a different pinned version", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path, {
        cliConfig: { results: { "protocol-version": { ...protocolVersionResult(), packageVersion: "9.9.9" } } },
      })
      const error = yield* resolveError({
        root: fixture.root,
        cli: fixture.cli,
        launcher: bunLauncher(fixture),
      })
      expect((error as UnavailableError).code).toBe(CAPABILITY_CODES.versionMismatch)
    }),
  )

  liveWindows("propagates a protocol-version mismatch as a protocol violation", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path, {
        cliConfig: { response: { protocolVersion: 2, ok: true, command: "protocol-version", result: {} } },
      })
      const error = yield* resolveError({
        root: fixture.root,
        cli: fixture.cli,
        launcher: bunLauncher(fixture),
      })
      expect(error).toBeInstanceOf(ProtocolViolationError)
    }),
  )

  liveWindows("reads explicit env configuration", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path)
      const capability = yield* ManagedWorktreeCapability.Service
      const descriptor = yield* capability.resolve({
        env: { [WORKTREE_STORE_ROOT_ENV]: fixture.root, [WORKTREE_STORE_CLI_ENV]: fixture.cli },
        launcher: bunLauncher(fixture),
      })
      expect(descriptor.root).toBe(fixture.root)
      expect(descriptor.cliFile).toContain("fake-managed-cli.mjs")
      expect(descriptor.discoveryDirectory).toBeNull()
      expect(descriptor.fenceAdapter.fenceReady).toBe(false)
    }),
  )

  liveWindows("discovers the conventional staged CLI and records the discovery directory", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path)
      writeFileSync(path.join(fixture.root, "worktree-store.exe"), FAKE_CLI_SOURCE, "utf8")
      const discoveryDirectory = path.join(tmp.path, "service-discovery")
      mkdirSync(discoveryDirectory, { recursive: true })

      const capability = yield* ManagedWorktreeCapability.Service
      const descriptor = yield* capability.resolve({
        root: fixture.root,
        discoveryDirectory,
        env: {},
        launcher: bunLauncher(fixture),
      })
      expect(descriptor.cliFile).toBe(path.join(descriptor.root, "worktree-store.exe"))
      expect(descriptor.discoveryDirectory).toBe(path.resolve(discoveryDirectory))
      // The staged fake advertises the legacy opaque token, which proves
      // nothing about a wired adapter and therefore can never be fence-ready.
      expect(descriptor.fenceAdapter.status).toBe("not-wired")
      expect(descriptor.fenceAdapter.fenceReady).toBe(false)

      const fromEnv = yield* capability.resolve({
        root: fixture.root,
        env: { [WORKTREE_STORE_DISCOVERY_DIR_ENV]: discoveryDirectory },
        launcher: bunLauncher(fixture),
      })
      expect(fromEnv.discoveryDirectory).toBe(path.resolve(discoveryDirectory))
    }),
  )

  liveWindows("rejects a relative discovery directory and readiness-fails a token-only handshake", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const relative = writeStage(path.join(tmp.path, "relative"), {
        cliConfig: { results: { "protocol-version": wiredProtocolVersionResult() } },
      })
      const error = yield* resolveError({
        root: relative.root,
        cli: relative.cli,
        discoveryDirectory: "service-discovery",
        env: {},
        launcher: bunLauncher(relative),
      })
      expect((error as UnavailableError).code).toBe(CAPABILITY_CODES.discoveryDirectoryNotAbsolute)

      const legacy = writeStage(path.join(tmp.path, "legacy"))
      const capability = yield* ManagedWorktreeCapability.Service
      const descriptor = yield* capability.resolve({
        root: legacy.root,
        cli: legacy.cli,
        env: {},
        launcher: bunLauncher(legacy),
      })
      expect(descriptor.fenceAdapter.fenceReady).toBe(false)
    }),
  )

  liveWindows("marks the exact wired fence adapter as ready", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const fixture = writeStage(tmp.path, {
        cliConfig: { results: { "protocol-version": wiredProtocolVersionResult() } },
      })
      const capability = yield* ManagedWorktreeCapability.Service
      const descriptor = yield* capability.resolve({
        root: fixture.root,
        cli: fixture.cli,
        env: {},
        launcher: bunLauncher(fixture),
      })
      expect(descriptor.fenceAdapter.status).toBe("wired")
      expect(descriptor.fenceAdapter.adapter).toBe("openfork-http-directory-activity-fence")
      expect(descriptor.fenceAdapter.fenceReady).toBe(true)
    }),
  )
})

describe("managed worktree capability platform policy", () => {
  test("currentTargetKey only supports win32 x64/arm64", () => {
    expect(currentTargetKey("win32", "x64")).toBe("win32-x64")
    expect(currentTargetKey("win32", "arm64")).toBe("win32-arm64")
    expect(currentTargetKey("darwin", "arm64")).toBeUndefined()
    expect(currentTargetKey("linux", "x64")).toBeUndefined()
    expect(currentTargetKey("win32", "ia32")).toBeUndefined()
  })

  liveNonWindows("rejects the managed sidecar on unsupported hosts", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const error = yield* resolveError({ root: tmp.path, cli: "cli.exe" })
      expect(error).toBeInstanceOf(UnavailableError)
      expect((error as UnavailableError).code).toBe(CAPABILITY_CODES.platformUnsupported)
    }),
  )

  test("bundle-relative paths reject traversal and absolute forms", () => {
    expect(assertBundleRelativePath("helpers/x.exe", "fixture")).toBe("helpers/x.exe")
    expect(() => assertBundleRelativePath("../x.exe", "fixture")).toThrow()
    expect(() => assertBundleRelativePath("C:\\x.exe", "fixture")).toThrow()
    expect(() => assertBundleRelativePath("a/./b.exe", "fixture")).toThrow()
    expect(() => assertBundleRelativePath("a//b.exe", "fixture")).toThrow()
  })
})
