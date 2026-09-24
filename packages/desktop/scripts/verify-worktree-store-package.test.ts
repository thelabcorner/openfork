import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  WORKTREE_STORE_STAGE_FILE,
  WORKTREE_STORE_VERSION_FILE,
  type WorktreeStoreProbe,
} from "./fetch-worktree-store"
import { WORKTREE_STORE_LOCK_SCHEMA, WORKTREE_STORE_TARGETS, resolveWorktreeStoreTarget } from "./worktree-store-lock"
import {
  WORKTREE_STORE_BUNDLE_MANIFEST_FILE,
  WorktreeStoreVerificationError,
  sha256Hex,
} from "./worktree-store-verify"
import { verifyPackagedWorktreeStore } from "./verify-worktree-store-package"
import {
  WORKTREE_STORE_CLI_ENV,
  WORKTREE_STORE_ROOT_ENV,
  resolveWorktreeStoreSidecarEnv,
} from "../src/main/worktree-store-env"

const hostTarget = resolveWorktreeStoreTarget(process.platform, process.arch)
const hostArch: "x64" | "arm64" = process.arch === "arm64" ? "arm64" : "x64"
const supportsProducerBundle = process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64")

const cliName = "worktree-store.exe"
const helperName = "worktree-store-helper.exe"
const cliText = "fake-cli-1.2.3"
const helperText = "fake-helper-1.2.3"

function pinnedLock(targetKey: string, overrides: { archiveSha256?: string; cli?: string; helper?: string } = {}) {
  return {
    schema: WORKTREE_STORE_LOCK_SCHEMA,
    version: "1.2.3",
    targets: Object.fromEntries(
      WORKTREE_STORE_TARGETS.map((key) => [
        key,
        key === targetKey
          ? {
              version: "1.2.3",
              archive: {
                url: `https://example.invalid/worktree-store-1.2.3-${targetKey}.zip`,
                size: 4096,
                sha256: overrides.archiveSha256 ?? "c".repeat(64),
              },
              manifest: WORKTREE_STORE_BUNDLE_MANIFEST_FILE,
              cli: overrides.cli ?? cliName,
              helper: overrides.helper ?? helperName,
            }
          : null,
      ]),
    ),
  }
}

function uncheckedLock() {
  return {
    schema: WORKTREE_STORE_LOCK_SCHEMA,
    version: null,
    targets: Object.fromEntries(WORKTREE_STORE_TARGETS.map((key) => [key, null])),
  }
}

function bundleManifestText(cli = cliName, helper = helperName) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      kind: "worktree-store-packaging-bundle",
      bundle: {
        name: "worktree-store",
        packageVersion: "1.2.3",
        managedProtocolVersion: null,
        sourceRevision: null,
        target: { os: "windows", arch: hostArch },
      },
      helpers: [
        {
          id: "refs-block-clone",
          relativePath: cli,
          sizeBytes: Buffer.byteLength(cliText),
          sha256: sha256Hex(cliText),
          target: { os: "windows", arch: hostArch },
          identity: {
            helperName: "worktree-store-refs-block-clone",
            helperVersion: "1.2.3",
            sourceCompatibility: "worktree-store/refs-block-clone@1",
            protocols: { manifest: { magic: "WTRFSBC1", version: 1 }, success: { schemaVersion: 1 } },
          },
        },
        {
          id: "storage-probe",
          relativePath: helper,
          sizeBytes: Buffer.byteLength(helperText),
          sha256: sha256Hex(helperText),
          target: { os: "windows", arch: hostArch },
          identity: {
            helperName: "worktree-store-storage-probe",
            helperVersion: "1.2.3",
            sourceCompatibility: "worktree-store/storage-probe@1",
            protocols: { success: { schemaVersion: 1 } },
          },
        },
      ],
    },
    null,
    2,
  )
}

async function fixture(options: { lock?: unknown; stamp?: unknown; payload?: boolean; cli?: string; helper?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "openfork-package-"))
  const dist = path.join(root, "dist")
  const payload = path.join(dist, "win-unpacked", "resources", "worktree-store")
  const cli = options.cli ?? cliName
  const helper = options.helper ?? helperName
  const lock = options.lock ?? pinnedLock(hostTarget, { cli, helper })
  const lockText = JSON.stringify(lock, null, 2)
  const lockPath = path.join(root, "worktree-store.lock.json")
  await writeFile(lockPath, lockText)
  if (options.payload !== false) {
    for (const [name, content] of [
      [cli, cliText],
      [helper, helperText],
      [WORKTREE_STORE_BUNDLE_MANIFEST_FILE, bundleManifestText(cli, helper)],
    ] as const) {
      const file = path.join(payload, ...name.split("/"))
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content)
    }
    await writeFile(path.join(payload, WORKTREE_STORE_VERSION_FILE), "1.2.3\n")
    const stamp = options.stamp ?? {
      schemaVersion: 1,
      source: "pinned",
      targetKey: hostTarget,
      version: "1.2.3",
      lockDigest: sha256Hex(lockText),
      archiveSha256: "c".repeat(64),
      archiveSize: 4096,
    }
    await writeFile(path.join(payload, WORKTREE_STORE_STAGE_FILE), `${JSON.stringify(stamp, null, 2)}\n`)
  }
  return { root, dist, lockPath, payload }
}

function probeStub(): { probe: WorktreeStoreProbe; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    probe: (executable) => {
      calls.push(path.basename(executable))
      return { status: 0, stdout: "worktree-store 1.2.3\n", stderr: "" }
    },
  }
}

if (supportsProducerBundle) {
  describe("worktree-store packaged verifier", () => {
    test("verifies a packaged pinned sidecar outside app.asar", async () => {
      const { root, dist, lockPath, payload } = await fixture()
      try {
        const { probe, calls } = probeStub()
        await verifyPackagedWorktreeStore(dist, { lockPath, probe, env: {}, channel: "dev" })
        expect(calls).toEqual([cliName, helperName])
        expect(
          resolveWorktreeStoreSidecarEnv({
            resourcesPath: path.dirname(payload),
            platform: "win32",
            env: {},
            exists: existsSync,
          }),
        ).toEqual({
          [WORKTREE_STORE_ROOT_ENV]: payload,
          [WORKTREE_STORE_CLI_ENV]: path.join(payload, cliName),
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    test("rejects a packaged dev-local payload", async () => {
      const { root, dist, lockPath } = await fixture({
        stamp: {
          schemaVersion: 1,
          source: "dev-local",
          targetKey: hostTarget,
          version: "dev-local",
          lockDigest: "a".repeat(64),
          archiveSha256: null,
          archiveSize: null,
        },
      })
      try {
        await expect(verifyPackagedWorktreeStore(dist, { lockPath, probe: probeStub().probe, env: {}, channel: "dev" })).rejects.toThrow(
          /development-only/,
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    test("rejects a packaged payload whose stamp no longer matches the lock", async () => {
      const { root, dist, lockPath } = await fixture({
        stamp: {
          schemaVersion: 1,
          source: "pinned",
          targetKey: hostTarget,
          version: "1.2.3",
          lockDigest: "a".repeat(64),
          archiveSha256: "c".repeat(64),
          archiveSize: 4096,
        },
      })
      try {
        await expect(verifyPackagedWorktreeStore(dist, { lockPath, probe: probeStub().probe, env: {}, channel: "dev" })).rejects.toThrow(
          /staged against lock digest/,
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    test("rejects a packaged payload under app.asar.unpacked", async () => {
      const { root, dist, lockPath, payload } = await fixture()
      try {
        const unpacked = path.join(dist, "win-unpacked", "app.asar.unpacked", "worktree-store")
        await mkdir(path.dirname(unpacked), { recursive: true })
        const { rename } = await import("node:fs/promises")
        await rename(payload, unpacked)
        await expect(verifyPackagedWorktreeStore(dist, { lockPath, probe: probeStub().probe, env: {}, channel: "dev" })).rejects.toThrow(
          /outside app\.asar/,
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    test("rejects a tampered helper against the packaged bundle manifest", async () => {
      const { root, dist, lockPath, payload } = await fixture()
      try {
        await writeFile(path.join(payload, helperName), "fake-helpar-1.2.3")
        const error = await verifyPackagedWorktreeStore(dist, {
          lockPath,
          probe: probeStub().probe,
          env: {},
          channel: "dev",
        }).catch((cause) => cause)
        expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
        expect(error.code).toBe("file-digest")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    test("rejects a packaged payload whose CLI the runtime cannot discover", async () => {
      const { root, dist, lockPath } = await fixture({ cli: "worktree-store-cli.exe" })
      try {
        const error = await verifyPackagedWorktreeStore(dist, {
          lockPath,
          probe: probeStub().probe,
          env: {},
          channel: "dev",
        }).catch((cause) => cause)
        expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
        expect(error.code).toBe("layout-mismatch")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })
}

describe("worktree-store packaged verifier channel gates", () => {
  test("beta and prod fail closed while the lock pins no target", async () => {
    for (const channel of ["beta", "prod"] as const) {
      const { root, dist, lockPath } = await fixture({ lock: uncheckedLock() })
      try {
        await expect(
          verifyPackagedWorktreeStore(dist, { lockPath, probe: probeStub().probe, env: {}, channel }),
        ).rejects.toThrow(/fails closed/)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  test("a packaged payload is refused while the lock pins no target", async () => {
    const { root, dist, lockPath } = await fixture({ lock: uncheckedLock() })
    try {
      await expect(verifyPackagedWorktreeStore(dist, { lockPath, probe: probeStub().probe, env: {}, channel: "dev" })).rejects.toThrow(
        /pins no/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dev verifies an artifact without a managed payload while the lock pins no target", async () => {
    const { root, dist, lockPath } = await fixture({ lock: uncheckedLock(), payload: false })
    try {
      await verifyPackagedWorktreeStore(dist, { lockPath, probe: probeStub().probe, env: {}, channel: "dev" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
