import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ManagedExecutable } from "../../src/worktree/managed/client"
import type { ManagedCreateInitializeInput } from "../../src/worktree/managed/request"

export const FAKE_CLI_SOURCE = `import { appendFileSync, readFileSync } from "node:fs"

const config = JSON.parse(readFileSync(process.argv[2], "utf8"))
let input = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) input += chunk

if (typeof config.capturePath === "string") {
  appendFileSync(config.capturePath, JSON.stringify({ pid: process.pid, argv: process.argv.slice(3), stdin: input }) + "\\n")
}

if (typeof config.sleepMs === "number" && config.sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, config.sleepMs))
}

if (typeof config.stderr === "string") process.stderr.write(config.stderr)

if (typeof config.rawStdout === "string") {
  process.stdout.write(config.rawStdout)
} else {
  let request = {}
  try { request = JSON.parse(input) } catch {}
  const perCommand = config.results && typeof config.results === "object" ? config.results[request.command] : undefined
  const response = config.response ?? { protocolVersion: 1, ok: true, command: request.command, result: perCommand ?? {} }
  process.stdout.write(JSON.stringify(response) + "\\n")
}

process.exitCode = typeof config.exitCode === "number" ? config.exitCode : 0
`

export interface FakeCli {
  readonly scriptPath: string
  readonly configPath: string
  readonly capturePath: string
  readonly executable: ManagedExecutable
}

export function writeFakeCli(directory: string, config: Record<string, unknown>): FakeCli {
  mkdirSync(directory, { recursive: true })
  const scriptPath = path.join(directory, "fake-managed-cli.mjs")
  const configPath = path.join(directory, "fake-managed-config.json")
  const capturePath =
    typeof config.capturePath === "string" ? config.capturePath : path.join(directory, "fake-managed-capture.jsonl")
  writeFileSync(scriptPath, FAKE_CLI_SOURCE, "utf8")
  writeFileSync(configPath, JSON.stringify({ ...config, capturePath }), "utf8")
  return {
    scriptPath,
    configPath,
    capturePath,
    executable: { path: process.execPath, argsPrefix: [scriptPath, configPath] },
  }
}

export function writeStagedFakeCli(root: string, config: Record<string, unknown>): { cliRelativePath: string; cliFile: string; configPath: string; capturePath: string } {
  const bin = path.join(root, "bin")
  mkdirSync(bin, { recursive: true })
  const cliFile = path.join(bin, "fake-managed-cli.mjs")
  const configPath = path.join(bin, "fake-managed-config.json")
  writeFileSync(cliFile, FAKE_CLI_SOURCE, "utf8")
  writeFileSync(configPath, JSON.stringify(config), "utf8")
  return {
    cliRelativePath: "bin/fake-managed-cli.mjs",
    cliFile,
    configPath,
    capturePath: path.join(root, "fake-managed-capture.jsonl"),
  }
}

export function captureRecords(capturePath: string): { pid: number; argv: string[]; stdin: string }[] {
  try {
    const text = readFileSync(capturePath, "utf8")
    return text
      .split("\n")
      .filter((line: string) => line.trim().length > 0)
      .map((line: string) => JSON.parse(line))
  } catch {
    return []
  }
}

export function protocolVersionResult(): Record<string, unknown> {
  return {
    managedProtocolVersion: 1,
    packageName: "worktree-store",
    packageVersion: "0.1.0-stage-a",
    runtime: { bun: "1.3.14", platform: "win32", arch: "x64", pid: 4242 },
    commands: ["protocol-version", "managed-create-initialize", "managed-status"],
    exitCodes: {
      success: 0,
      invalidRequest: 2,
      contentionRetryable: 3,
      reconcileQuarantineFatal: 4,
      internalDefect: 5,
    },
    capabilities: {
      protocolVersion: { opensControlPlaneDatabase: false },
      managedCreateInitialize: {
        acquiresSingleWriterCoordinator: true,
        completesOnlyAtExactIdleClean: true,
        requiresRegisteredRepository: true,
        requiresRegisteredStorageVolume: true,
        requiresExplicitStorageIdentity: true,
        requiresNativeStorageProbeHelper: true,
        requiresNativeDedupeHelper: true,
        dedupeFenceAdapter: "not-wired",
        neverFallsBackToUnmanagedGit: true,
      },
      managedStatus: { readOnly: true, acquiresSingleWriterCoordinator: false, liveGitLockEvidence: true },
    },
    prerequisites: ["fixture prerequisites"],
  }
}

export function wiredFenceAdapterCapability(): Record<string, unknown> {
  return {
    status: "wired",
    adapter: "openfork-http-directory-activity-fence",
    requiresActivityFenceConfig: true,
    requiresOpenForkDiscoveryDirectory: true,
    connectsOnlyWhenDonorRequiresExclusion: true,
    missingConfigurationFailsClosedWhenDonorRequired: true,
  }
}

export function wiredProtocolVersionResult(): Record<string, unknown> {
  const base = protocolVersionResult()
  const capabilities = base.capabilities as Record<string, unknown>
  const managedCreateInitialize = capabilities.managedCreateInitialize as Record<string, unknown>
  return {
    ...base,
    capabilities: {
      ...capabilities,
      managedCreateInitialize: { ...managedCreateInitialize, dedupeFenceAdapter: wiredFenceAdapterCapability() },
    },
  }
}

export const VOLUME_GUID = "\\\\?\\Volume{2e52778b-5c90-487c-86e1-6f6fcc8a9b72}\\"

export function validCreateInput(overrides: Partial<ManagedCreateInitializeInput> = {}): ManagedCreateInitializeInput {
  return {
    worktreeId: "wt_test",
    repositoryId: "repo_test",
    repositoryPath: "C:\\repos\\repo",
    storageVolumeId: "vol_test",
    targetPath: "W:\\managed\\wt-test",
    branchName: "feature/managed",
    commitish: "HEAD",
    storagePolicy: {
      managedRootPath: "W:\\managed",
      acceptedVolumeGuids: [VOLUME_GUID],
      expectedPartitionGuid: "{2e52778b-5c90-487c-86e1-6f6fcc8a9b72}",
      expectedDiskGuid: "{dae64908-fc8b-48d7-a795-89427457343a}",
      expectedBackingPath: "\\\\?\\Volume{1e7cbce1-a013-4dfd-9e92-a2bbd3ba1f3d}\\fixture.vhdx",
      expectedFilesystem: "ReFS",
      expectedLabel: "WT-TEST",
      requireBlockCloning: true,
      requireDevDrive: true,
      requireTrustedDevDrive: true,
      minimumVolumeFreeBytes: 1,
      minimumVolumeFreeRatio: 0,
      minimumHostFreeBytes: 1,
      minimumHostFreeRatio: 0,
    },
    storageProbe: { helperPath: "C:\\helpers\\storage-probe.exe", helperArgsPrefix: ["--quiet"] },
    dedupe: { nativeHelperPath: "C:\\helpers\\refs-block-clone.exe", minimumCandidateBytes: 4096 },
    ...overrides,
  }
}

const HEAD = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1"
const TIMESTAMP = "2026-01-01T00:00:00.000Z"

export function statusResult(worktreeId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worktreeId,
    repository: {
      id: "repo_test",
      canonicalTopLevel: "C:\\repos\\repo",
      gitCommonDir: "C:\\repos\\repo\\.git",
      objectFormat: "sha1",
      identityMethod: "canonical-top-level",
      createdAt: TIMESTAMP,
      lastSeenAt: TIMESTAMP,
    },
    storageVolume: null,
    worktree: {
      repositoryId: "repo_test",
      storageVolumeId: null,
      path: "W:\\managed\\wt-test",
      pathKey: "w:\\managed\\wt-test",
      ownership: "managed",
      head: HEAD,
      branchRef: "refs/heads/feature/managed",
      pinRef: `refs/worktree-store/pins/${worktreeId}`,
      durabilityClass: "reconstructable_clean",
      lifecycleState: "idle_clean",
      revision: 3,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    revision: { actual: 3, openOperationExpectedRevisions: [] },
    quarantine: { quarantined: false, lifecycleState: "idle_clean", durabilityClass: "reconstructable_clean" },
    handoff: {
      reconcileRequired: false,
      reasons: [],
      openOperationCount: 0,
      unresolvedGuardAttemptCount: 0,
      reconcileRequiredGuardAttemptCount: 0,
      reconcileRequiredActivityClaimCount: 0,
      reconcileRequiredMaintenanceGuardCount: 0,
    },
    operations: { open: [], latest: [] },
    guardAttempts: [],
    activityClaims: [],
    maintenanceGuards: [],
    gitEvidence: {
      probe: "ok",
      repositoryPath: "C:\\repos\\repo",
      worktreePath: "W:\\managed\\wt-test",
      registered: true,
      locked: false,
      lockReason: null,
      head: HEAD,
      branchRef: "refs/heads/feature/managed",
      bare: false,
      detached: false,
      prunable: false,
      unknownAttributes: [],
      error: null,
    },
    ...overrides,
  }
}

export function createResult(input: ManagedCreateInitializeInput, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worktreeId: input.worktreeId,
    repositoryId: input.repositoryId,
    storageVolumeId: input.storageVolumeId,
    targetPath: input.targetPath,
    pathKey: input.targetPath.toLowerCase(),
    ownership: "managed",
    lifecycleState: "idle_clean",
    durabilityClass: "reconstructable_clean",
    revision: 4,
    head: HEAD,
    branchRef: `refs/heads/${input.branchName}`,
    pinRef: `refs/worktree-store/pins/${input.worktreeId}`,
    createOperationId: "op_create",
    initializationOperationId: "op_initialize",
    summary: { initialized: true },
    idempotent: false,
    ...overrides,
  }
}
