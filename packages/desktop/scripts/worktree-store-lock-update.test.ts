import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"

import {
  WORKTREE_STORE_LOCK_SCHEMA,
  WORKTREE_STORE_TARGETS,
  WorktreeStoreLockError,
  loadWorktreeStoreLock,
  type WorktreeStoreLock,
} from "./worktree-store-lock"
import {
  WORKTREE_STORE_BUNDLE_MANIFEST_FILE,
  WorktreeStoreVerificationError,
  sha256Hex,
} from "./worktree-store-verify"
import { stageWorktreeStore, type WorktreeStoreProbe } from "./fetch-worktree-store"
import { updateWorktreeStoreLock } from "./worktree-store-lock-update"

const packageDir = path.resolve(import.meta.dir, "..")

const cliText = "fake-worktree-store-cli v1.2.3\n"
const helperText = "fake-worktree-store-helper v1.2.3\n"
const cliFile = "worktree-store.exe"
const helperFile = "worktree-store-helper.exe"

function emptyLock(): WorktreeStoreLock {
  return {
    schema: WORKTREE_STORE_LOCK_SCHEMA,
    version: null,
    targets: Object.fromEntries(WORKTREE_STORE_TARGETS.map((key) => [key, null])) as WorktreeStoreLock["targets"],
  }
}

function bundleManifestText(arch: "x64" | "arm64" = "x64"): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      kind: "worktree-store-packaging-bundle",
      bundle: {
        name: "worktree-store",
        packageVersion: "1.2.3",
        managedProtocolVersion: null,
        sourceRevision: null,
        target: { os: "windows", arch },
      },
      helpers: [
        {
          id: "refs-block-clone",
          relativePath: cliFile,
          sizeBytes: Buffer.byteLength(cliText),
          sha256: sha256Hex(cliText),
          target: { os: "windows", arch },
          identity: {
            helperName: "worktree-store-refs-block-clone",
            helperVersion: "1.2.3",
            sourceCompatibility: "worktree-store/refs-block-clone@1",
            protocols: { manifest: { magic: "WTRFSBC1", version: 1 }, success: { schemaVersion: 1 } },
          },
        },
        {
          id: "storage-probe",
          relativePath: helperFile,
          sizeBytes: Buffer.byteLength(helperText),
          sha256: sha256Hex(helperText),
          target: { os: "windows", arch },
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

async function buildZip(entries: Record<string, string>): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const [name, content] of Object.entries(entries)) {
    await writer.add(name, new TextReader(content))
  }
  const blob = await writer.close()
  return new Uint8Array(await blob.arrayBuffer())
}

async function fixture(arch: "x64" | "arm64" = "x64") {
  const root = await mkdtemp(path.join(packageDir, ".tmp-worktree-lock-update-"))
  const lockPath = path.join(root, "worktree-store.lock.json")
  await writeFile(lockPath, `${JSON.stringify(emptyLock(), null, 2)}\n`)
  const bytes = await buildZip({
    [cliFile]: cliText,
    [helperFile]: helperText,
    [WORKTREE_STORE_BUNDLE_MANIFEST_FILE]: bundleManifestText(arch),
  })
  const archive = path.join(root, "artifact.zip")
  await writeFile(archive, bytes)
  return { root, lockPath, archive, bytes }
}

function probeStub(): WorktreeStoreProbe {
  return () => ({ status: 0, stdout: "worktree-store 1.2.3\n", stderr: "" })
}

describe("worktree-store lock update", () => {
  test("pins an explicit artifact and the written lock stages it", async () => {
    const { root, lockPath, archive, bytes } = await fixture()
    try {
      const url = "https://example.invalid/worktree-store-1.2.3-win32-x64.zip"
      const result = await updateWorktreeStoreLock({ target: "win32-x64", url, archivePath: archive, lockPath, log: () => {} })

      expect(result.written).toBe(true)
      expect(result.pin).toMatchObject({ version: "1.2.3", cli: cliFile, helper: helperFile })
      expect(result.pin.archive).toEqual({ url, size: bytes.byteLength, sha256: sha256Hex(bytes) })

      const loaded = await loadWorktreeStoreLock(lockPath)
      expect(loaded.version).toBe("1.2.3")
      expect(loaded.targets["win32-x64"]).toEqual(result.pin)
      for (const key of WORKTREE_STORE_TARGETS) if (key !== "win32-x64") expect(loaded.targets[key]).toBeNull()

      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", path.posix.basename(new URL(url).pathname))
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)
      const staged = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "win32",
        arch: "x64",
        channel: "prod",
        env: {},
        probe: probeStub(),
        log: () => {},
      })
      expect(staged).toMatchObject({ staged: true, targetKey: "win32-x64", source: "pinned" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refuses to invent release data", async () => {
    const { root, lockPath, archive } = await fixture()
    try {
      const cases = [
        () => updateWorktreeStoreLock({ target: "win32-x64", url: "", archivePath: archive, lockPath }),
        () => updateWorktreeStoreLock({ target: "win32-x64", url: "http://example.invalid/a.zip", archivePath: archive, lockPath }),
        () =>
          updateWorktreeStoreLock({
            target: "win32-x64",
            url: "https://example.invalid/a.zip",
            archivePath: path.join(root, "missing.zip"),
            lockPath,
          }),
        () => updateWorktreeStoreLock({ target: "win32-x64", url: "https://example.invalid/a.zip", archivePath: archive, lockPath, version: "9.9.9" }),
        () =>
          updateWorktreeStoreLock({
            target: "win32-x64",
            url: "https://example.invalid/a.zip",
            archivePath: archive,
            lockPath,
            cli: "other.exe",
          }),
      ]
      for (const run of cases) {
        const error = await run().catch((cause) => cause)
        expect(error).toBeInstanceOf(WorktreeStoreLockError)
        expect(error.code).toBe("invalid-input")
      }

      const missing = await updateWorktreeStoreLock({
        target: "win32-x64",
        url: "https://example.invalid/a.zip",
        archivePath: archive,
        lockPath: path.join(root, "absent.json"),
      }).catch((cause) => cause)
      expect(missing).toBeInstanceOf(WorktreeStoreLockError)
      expect(missing.code).toBe("lock-missing")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refuses an archive whose manifest targets another architecture", async () => {
    const { root, lockPath, archive } = await fixture("arm64")
    try {
      const error = await updateWorktreeStoreLock({
        target: "win32-x64",
        url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
        archivePath: archive,
        lockPath,
      }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("manifest-target")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dry run reports the pin without touching the lock", async () => {
    const { root, lockPath, archive } = await fixture()
    try {
      const before = await readFile(lockPath, "utf8")
      const result = await updateWorktreeStoreLock({
        target: "win32-x64",
        url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
        archivePath: archive,
        lockPath,
        dryRun: true,
        log: () => {},
      })
      expect(result.written).toBe(false)
      expect(result.lock.version).toBe("1.2.3")
      expect(await readFile(lockPath, "utf8")).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
