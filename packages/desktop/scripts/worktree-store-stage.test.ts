import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"

import {
  WORKTREE_STORE_DEV_ARCHIVE_ENV,
  WORKTREE_STORE_LOCK_SCHEMA,
  WORKTREE_STORE_TARGETS,
  WorktreeStoreLockError,
} from "./worktree-store-lock"
import {
  WORKTREE_STORE_STAGE_FILE,
  WORKTREE_STORE_VERSION_FILE,
  stageWorktreeStore,
  worktreeStoreOutputDir,
  type WorktreeStoreProbe,
} from "./fetch-worktree-store"
import {
  WORKTREE_STORE_BUNDLE_MANIFEST_FILE,
  WorktreeStoreVerificationError,
  assertSafeArchiveEntries,
  parseVersionOutput,
  sha256Hex,
  verifyHandshake,
} from "./worktree-store-verify"
import {
  WORKTREE_STORE_CLI_ENV,
  WORKTREE_STORE_ROOT_ENV,
  resolveWorktreeStoreSidecarEnv,
} from "../src/main/worktree-store-env"

const packageDir = path.resolve(import.meta.dir, "..")

type Entries = Record<string, string>

async function makePackageRoot(prefix = ".tmp-worktree-stage-") {
  return mkdtemp(path.join(packageDir, prefix))
}

async function buildZip(entries: Entries): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const [name, content] of Object.entries(entries)) {
    await writer.add(name, new TextReader(content))
  }
  const blob = await writer.close()
  return new Uint8Array(await blob.arrayBuffer())
}

async function writePayload(directory: string, entries: Entries) {
  for (const [name, content] of Object.entries(entries)) {
    const file = path.join(directory, ...name.split("/"))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

function lockFile(lock: unknown) {
  return JSON.stringify(lock, null, 2)
}

function pinnedLock(input: { target: string; url: string; size: number; sha256: string; version: string; cli: string; helper?: string }) {
  const pin = {
    version: input.version,
    archive: { url: input.url, size: input.size, sha256: input.sha256 },
    manifest: WORKTREE_STORE_BUNDLE_MANIFEST_FILE,
    cli: input.cli,
    ...(input.helper === undefined ? {} : { helper: input.helper }),
  }
  return {
    schema: WORKTREE_STORE_LOCK_SCHEMA,
    version: input.version,
    targets: Object.fromEntries(WORKTREE_STORE_TARGETS.map((key) => [key, key === input.target ? pin : null])),
  }
}

function uncheckedLock() {
  return {
    schema: WORKTREE_STORE_LOCK_SCHEMA,
    version: null,
    targets: Object.fromEntries(WORKTREE_STORE_TARGETS.map((key) => [key, null])),
  }
}

function probeReturning(responses: Record<string, { status?: number; output?: string; error?: Error }>): {
  probe: WorktreeStoreProbe
  calls: Array<{ executable: string; args: readonly string[] }>
} {
  const calls: Array<{ executable: string; args: readonly string[] }> = []
  return {
    calls,
    probe: (executable, args) => {
      calls.push({ executable, args })
      const name = path.basename(executable)
      const response = responses[name] ?? responses[name.replace(/\.exe$/, "")] ?? {}
      return { status: response.status ?? 0, stdout: response.output ?? "", stderr: "", error: response.error }
    },
  }
}

const cliText = "fake-worktree-store-cli v1.2.3\n"
const helperText = "fake-worktree-store-helper v1.2.3\n"

const fixtureHelpers = [
  {
    id: "refs-block-clone" as const,
    file: "worktree-store.exe",
    content: cliText,
    protocols: { manifest: { magic: "WTRFSBC1", version: 1 }, success: { schemaVersion: 1 } },
  },
  {
    id: "storage-probe" as const,
    file: "worktree-store-helper.exe",
    content: helperText,
    protocols: { success: { schemaVersion: 1 } },
  },
]

function bundleManifestText(arch: "x64" | "arm64" = "x64", cliFile = "worktree-store.exe"): string {
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
      helpers: fixtureHelpers.map((helper) => ({
        id: helper.id,
        relativePath: helper.id === "refs-block-clone" ? cliFile : helper.file,
        sizeBytes: Buffer.byteLength(helper.content),
        sha256: sha256Hex(helper.content),
        target: { os: "windows", arch },
        identity: {
          helperName:
            helper.id === "refs-block-clone" ? "worktree-store-refs-block-clone" : "worktree-store-storage-probe",
          helperVersion: "1.2.3",
          sourceCompatibility: `worktree-store/${helper.id}@1`,
          protocols: helper.protocols,
        },
      })),
    },
    null,
    2,
  )
}

function fullEntries(arch: "x64" | "arm64" = "x64", cliFile = "worktree-store.exe"): Entries {
  return {
    [cliFile]: cliText,
    "worktree-store-helper.exe": helperText,
    [WORKTREE_STORE_BUNDLE_MANIFEST_FILE]: bundleManifestText(arch, cliFile),
  }
}

describe("worktree-store pinned staging", () => {
  test("stages a cached pinned archive after size+digest verification", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries())
      const digest = sha256Hex(bytes)
      const lock = pinnedLock({
        target: "win32-x64",
        url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
        size: bytes.byteLength,
        sha256: digest,
        version: "1.2.3",
        cli: "worktree-store.exe",
        helper: "worktree-store-helper.exe",
      })
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(lock))
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)

      const { probe, calls } = probeReturning({
        "worktree-store": { output: "worktree-store 1.2.3" },
        "worktree-store-helper": { output: "worktree-store-helper 1.2.3" },
      })
      const logs: string[] = []
      const result = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "win32",
        arch: "x64",
        channel: "prod",
        env: {},
        probe,
        log: (message) => logs.push(message),
      })

      expect(result).toMatchObject({ staged: true, targetKey: "win32-x64", source: "pinned" })
      const output = worktreeStoreOutputDir(root)
      expect(await readFile(path.join(output, "worktree-store.exe"), "utf8")).toBe(cliText)
      expect(await readFile(path.join(output, "worktree-store-helper.exe"), "utf8")).toBe(helperText)
      expect(await readFile(path.join(output, WORKTREE_STORE_VERSION_FILE), "utf8")).toBe("1.2.3\n")
      const stamp = JSON.parse(await readFile(path.join(output, WORKTREE_STORE_STAGE_FILE), "utf8"))
      expect(stamp).toMatchObject({
        source: "pinned",
        targetKey: "win32-x64",
        version: "1.2.3",
        archiveSha256: digest,
        archiveSize: bytes.byteLength,
      })
      expect(stamp.lockDigest).toBe(sha256Hex(lockFile(lock)))
      expect(calls.map((call) => path.basename(call.executable))).toEqual(["worktree-store.exe", "worktree-store-helper.exe"])
      expect(calls.every((call) => call.args[0] === "--version")).toBe(true)
      expect(logs.some((message) => message.includes("Pinned worktree-store 1.2.3"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("downloads the pinned archive when the cache is cold", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries("arm64"))
      const lock = pinnedLock({
        target: "win32-arm64",
        url: "https://example.invalid/worktree-store-1.2.3-win32-arm64.zip",
        size: bytes.byteLength,
        sha256: sha256Hex(bytes),
        version: "1.2.3",
        cli: "worktree-store.exe",
      })
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(lock))
      const downloads: string[] = []
      const { probe } = probeReturning({ "worktree-store": { output: "worktree-store 1.2.3" } })

      const result = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "win32",
        arch: "arm64",
        channel: "prod",
        env: {},
        probe,
        fetchImpl: (async (url: string | URL | Request) => {
          downloads.push(String(url))
          return new Response(bytes as unknown as BodyInit)
        }) as unknown as typeof fetch,
      })

      expect(result).toMatchObject({ staged: true, source: "pinned" })
      expect(downloads).toEqual(["https://example.invalid/worktree-store-1.2.3-win32-arm64.zip"])
      expect(existsSync(path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-arm64.zip"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a digest mismatch and discards the cached archive", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries())
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: bytes.byteLength,
            sha256: "b".repeat(64),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)

      const error = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "x64", channel: "prod", env: {} }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("archive-digest")
      expect(existsSync(cache)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects an archive size mismatch", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries())
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: bytes.byteLength + 1,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)

      const error = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "x64", channel: "prod", env: {} }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("archive-size")
      expect(existsSync(cache)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a stale CLI version handshake", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries())
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)

      const { probe } = probeReturning({ "worktree-store": { output: "worktree-store 9.9.9" } })
      const error = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "x64", channel: "prod", env: {}, probe }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("stale-handshake")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a CLI handshake that exits nonzero", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries())
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)

      const { probe } = probeReturning({ "worktree-store": { status: 1, output: "boom" } })
      const error = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "x64", channel: "prod", env: {}, probe }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("handshake-output")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a payload missing its pinned manifest", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip({ "worktree-store": cliText })
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)

      const error = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "x64", channel: "prod", env: {} }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("manifest-missing")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a payload with an undeclared file", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip({ ...fullEntries(), "extra.dll": "sneaky" })
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)

      const error = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "x64", channel: "prod", env: {} }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("unexpected-file")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refuses a bundle manifest whose target does not match the pin", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries("x64"))
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-arm64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-arm64.zip",
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-arm64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)

      const error = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "arm64", channel: "prod", env: {} }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("manifest-target")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refuses a pinned non-Windows target because producer bundle manifests are windows-only", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries())
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "linux-x64",
            url: "https://example.invalid/worktree-store-1.2.3-linux-x64.zip",
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-linux-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)

      const error = await stageWorktreeStore({ packageDir: root, lockPath, platform: "linux", arch: "x64", channel: "prod", env: {} }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("manifest-target")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("flattens a single top-level archive directory", async () => {
    const root = await makePackageRoot()
    try {
      const nested: Entries = Object.fromEntries(
        Object.entries(fullEntries()).map(([name, content]) => [`worktree-store-1.2.3/${name}`, content]),
      )
      const bytes = await buildZip(nested)
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)
      const { probe } = probeReturning({ "worktree-store": { output: "worktree-store 1.2.3" } })

      const result = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "x64", channel: "prod", env: {}, probe })
      expect(result.staged).toBe(true)
      expect(await readFile(path.join(worktreeStoreOutputDir(root), "worktree-store.exe"), "utf8")).toBe(cliText)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves a mapped executable on win32 when the staged bytes are identical", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries())
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "worktree-store.exe",
          }),
        ),
      )
      const cache = path.join(root, "node_modules", ".cache", "openfork-worktree-store", "worktree-store-1.2.3-win32-x64.zip")
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)
      const { probe } = probeReturning({ "worktree-store": { output: "worktree-store 1.2.3" } })
      const logs: string[] = []

      const options = {
        packageDir: root,
        lockPath,
        platform: "win32",
        arch: "x64",
        channel: "prod" as const,
        env: {},
        probe,
        log: (message: string) => logs.push(message),
      }
      await stageWorktreeStore(options)
      const stale = path.join(worktreeStoreOutputDir(root), "stale.tmp")
      await writeFile(stale, "stale")
      await stageWorktreeStore(options)

      expect(logs.filter((message) => message.includes("Preserving the mapped worktree-store executable"))).toHaveLength(1)
      expect(await readFile(path.join(worktreeStoreOutputDir(root), "worktree-store.exe"), "utf8")).toBe(cliText)
      expect(existsSync(path.join(worktreeStoreOutputDir(root), WORKTREE_STORE_STAGE_FILE))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refuses a pinned CLI the packaged runtime cannot discover", async () => {
    const root = await makePackageRoot()
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: 1,
            sha256: "a".repeat(64),
            version: "1.2.3",
            cli: "worktree-store-cli.exe",
          }),
        ),
      )
      let downloads = 0

      const error = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "win32",
        arch: "x64",
        channel: "prod",
        env: {},
        fetchImpl: (async () => {
          downloads += 1
          throw new Error("the layout gate must reject before downloading")
        }) as unknown as typeof fetch,
        log: () => {},
      }).catch((cause) => cause)

      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("layout-mismatch")
      expect(downloads).toBe(0)
      expect(existsSync(worktreeStoreOutputDir(root))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("stages a pinned nested bin/ CLI layout the runtime discovers", async () => {
    const root = await makePackageRoot()
    try {
      const bytes = await buildZip(fullEntries("x64", "bin/worktree-store.exe"))
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(
        lockPath,
        lockFile(
          pinnedLock({
            target: "win32-x64",
            url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            version: "1.2.3",
            cli: "bin/worktree-store.exe",
            helper: "worktree-store-helper.exe",
          }),
        ),
      )
      const cache = path.join(
        root,
        "node_modules",
        ".cache",
        "openfork-worktree-store",
        "worktree-store-1.2.3-win32-x64.zip",
      )
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(cache, bytes)
      const { probe } = probeReturning({
        "worktree-store.exe": { output: "worktree-store 1.2.3" },
        "worktree-store-helper.exe": { output: "worktree-store-helper 1.2.3" },
      })

      const result = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "win32",
        arch: "x64",
        channel: "prod",
        env: {},
        probe,
        log: () => {},
      })

      expect(result).toMatchObject({ staged: true, source: "pinned" })
      const output = worktreeStoreOutputDir(root)
      expect(await readFile(path.join(output, "bin", "worktree-store.exe"), "utf8")).toBe(cliText)
      expect(
        resolveWorktreeStoreSidecarEnv({
          resourcesPath: path.dirname(output),
          platform: "win32",
          env: {},
          exists: existsSync,
        }),
      ).toEqual({
        [WORKTREE_STORE_ROOT_ENV]: output,
        [WORKTREE_STORE_CLI_ENV]: path.join(output, "bin", "worktree-store.exe"),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("worktree-store missing pin and dev override", () => {
  test("production fails closed when unpinned", async () => {
    const root = await makePackageRoot()
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))
      const error = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "x64", channel: "prod", env: {}, log: () => {} }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreLockError)
      expect(error.code).toBe("missing-target")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("beta fails closed with no side effects when unpinned", async () => {
    const root = await makePackageRoot()
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))

      const error = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "win32",
        arch: "x64",
        channel: "beta",
        env: {},
        fetchImpl: (async () => {
          throw new Error("an unpinned beta build must fail before any download")
        }) as unknown as typeof fetch,
        log: () => {},
      }).catch((cause) => cause)

      expect(error).toBeInstanceOf(WorktreeStoreLockError)
      expect(error.code).toBe("missing-target")
      expect(error.message).toMatch(/fails closed/)
      expect(existsSync(worktreeStoreOutputDir(root))).toBe(false)
      expect(existsSync(path.join(root, "node_modules"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("stages a dev-local .zip archive from the explicit override", async () => {
    const root = await makePackageRoot()
    const payload = await makePackageRoot(".tmp-worktree-payload-")
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))
      const archive = path.join(payload, "local-payload.zip")
      await writeFile(archive, await buildZip({ "worktree-store": cliText, "NOTICE.txt": "third party notices\n" }))

      const result = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "linux",
        arch: "x64",
        channel: "dev",
        env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: archive },
        log: () => {},
      })

      expect(result).toMatchObject({ staged: true, source: "dev-local" })
      const output = worktreeStoreOutputDir(root)
      expect(await readFile(path.join(output, "worktree-store"), "utf8")).toBe(cliText)
      expect(await readFile(path.join(output, "NOTICE.txt"), "utf8")).toBe("third party notices\n")
      const bytes = await readFile(archive)
      const stamp = JSON.parse(await readFile(path.join(output, WORKTREE_STORE_STAGE_FILE), "utf8"))
      expect(stamp).toMatchObject({ source: "dev-local", version: "dev-local", archiveSize: bytes.byteLength })
      expect(stamp.archiveSha256).toBe(sha256Hex(bytes))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(payload, { recursive: true, force: true })
    }
  })

  test("dev skips cleanly and clears a stale staged payload", async () => {
    const root = await makePackageRoot()
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))
      const output = worktreeStoreOutputDir(root)
      await mkdir(output, { recursive: true })
      await writeFile(path.join(output, WORKTREE_STORE_STAGE_FILE), "{}")
      await writeFile(path.join(output, WORKTREE_STORE_VERSION_FILE), "stale\n")
      await writeFile(path.join(output, "stale.bin"), "stale")
      const logs: string[] = []

      const result = await stageWorktreeStore({ packageDir: root, lockPath, platform: "win32", arch: "x64", channel: "dev", env: {}, log: (message) => logs.push(message) })

      expect(result).toMatchObject({ staged: false, targetKey: "win32-x64" })
      expect(result.reason).toMatch(/packaging continues without the managed sidecar/)
      expect(existsSync(path.join(output, WORKTREE_STORE_STAGE_FILE))).toBe(false)
      expect(existsSync(path.join(output, "stale.bin"))).toBe(false)
      expect(logs.some((message) => message.includes("Removing a stale worktree-store payload"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("stages an explicit dev-local directory without release verification", async () => {
    const root = await makePackageRoot()
    const payload = await makePackageRoot(".tmp-worktree-payload-")
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))
      await writePayload(payload, { "worktree-store": cliText, "NOTICE.txt": "third party notices\n" })

      const result = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "linux",
        arch: "x64",
        channel: "dev",
        env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: payload },
        log: () => {},
      })

      expect(result).toMatchObject({ staged: true, source: "dev-local" })
      const output = worktreeStoreOutputDir(root)
      expect(await readFile(path.join(output, "worktree-store"), "utf8")).toBe(cliText)
      expect(await readFile(path.join(output, WORKTREE_STORE_VERSION_FILE), "utf8")).toBe("dev-local\n")
      const stamp = JSON.parse(await readFile(path.join(output, WORKTREE_STORE_STAGE_FILE), "utf8"))
      expect(stamp).toMatchObject({ source: "dev-local", version: "dev-local", archiveSha256: null, archiveSize: null })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(payload, { recursive: true, force: true })
    }
  })

  test("verifies a dev-local payload that carries a producer bundle manifest", async () => {
    const root = await makePackageRoot()
    const payload = await makePackageRoot(".tmp-worktree-payload-")
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))
      await writePayload(payload, fullEntries())

      const result = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "linux",
        arch: "x64",
        channel: "dev",
        env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: payload },
        log: () => {},
      })

      expect(result).toMatchObject({ staged: true, source: "dev-local" })
      expect(await readFile(path.join(worktreeStoreOutputDir(root), "worktree-store.exe"), "utf8")).toBe(cliText)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(payload, { recursive: true, force: true })
    }
  })

  test("refuses a dev-local payload whose bundle manifest digest does not match", async () => {
    const root = await makePackageRoot()
    const payload = await makePackageRoot(".tmp-worktree-payload-")
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))
      await writePayload(payload, { ...fullEntries(), "worktree-store.exe": "fake-worktree-store-cli v9.9.9\n" })

      const error = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "linux",
        arch: "x64",
        channel: "dev",
        env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: payload },
        log: () => {},
      }).catch((cause) => cause)

      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("file-digest")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(payload, { recursive: true, force: true })
    }
  })

  test("refuses the dev-local override on non-dev channels", async () => {
    const root = await makePackageRoot()
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))
      const error = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "win32",
        arch: "x64",
        channel: "beta",
        env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: root },
        log: () => {},
      }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreLockError)
      expect(error.code).toBe("dev-override-rejected")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a dev-local archive that does not exist", async () => {
    const root = await makePackageRoot()
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))
      const error = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "win32",
        arch: "x64",
        channel: "dev",
        env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: path.join(root, "missing.zip") },
        log: () => {},
      }).catch((cause) => cause)
      expect(error).toBeInstanceOf(WorktreeStoreLockError)
      expect(error.code).toBe("dev-override-rejected")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("worktree-store safe extraction", () => {
  test("rejects traversal, absolute, and duplicate archive entries", () => {
    for (const entry of ["../escape.txt", "/etc/passwd", "C:/windows/system32/evil.dll", "a/../../b.txt", "a\\b.txt"]) {
      expect(() => assertSafeArchiveEntries([entry], "fixture.zip")).toThrow(WorktreeStoreVerificationError)
    }
    expect(() => assertSafeArchiveEntries(["a.txt", "a.txt"], "fixture.zip")).toThrow(/more than once/)
    expect(() => assertSafeArchiveEntries([], "fixture.zip")).toThrow(/empty/)
    expect(assertSafeArchiveEntries(["bin/tool", "bin/tool.exe", "dir/"], "fixture.zip")).toEqual(["bin/tool", "bin/tool.exe", "dir"])
  })

  test("does not extract a traversal entry from a dev-local zip", async () => {
    const root = await makePackageRoot()
    const payload = await makePackageRoot(".tmp-worktree-evil-")
    try {
      const lockPath = path.join(root, "worktree-store.lock.json")
      await writeFile(lockPath, lockFile(uncheckedLock()))
      const archive = path.join(payload, "evil.zip")
      await writeFile(archive, await buildZip({ "../escape.txt": "escape" }))

      const error = await stageWorktreeStore({
        packageDir: root,
        lockPath,
        platform: "linux",
        arch: "x64",
        channel: "dev",
        env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: archive },
        log: () => {},
      }).catch((cause) => cause)

      expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
      expect(error.code).toBe("unsafe-path")
      expect(existsSync(path.join(root, "escape.txt"))).toBe(false)
      expect(existsSync(path.join(payload, "escape.txt"))).toBe(false)
      expect(existsSync(path.join(worktreeStoreOutputDir(root), "escape.txt"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(payload, { recursive: true, force: true })
    }
  })
})

describe("worktree-store version handshakes", () => {
  test("parses versions from CLI output with and without a v prefix", () => {
    expect(parseVersionOutput("worktree-store 1.2.3", "cli")).toBe("1.2.3")
    expect(parseVersionOutput("worktree-store v1.2.3\n", "cli")).toBe("1.2.3")
    expect(parseVersionOutput("worktree-store v1.2.3-beta.1", "cli")).toBe("1.2.3-beta.1")
    expect(() => parseVersionOutput("no version here", "cli")).toThrow(WorktreeStoreVerificationError)
  })

  test("rejects stale and missing helper handshakes", () => {
    expect(() => verifyHandshake({ cli: "1.2.3" }, { cli: "1.2.3" }, "cli")).not.toThrow()
    expect(() => verifyHandshake({ cli: "1.2.3" }, { cli: "1.2.4" }, "cli")).toThrow(/reported 1.2.4/)
    expect(() => verifyHandshake({ cli: "1.2.3" }, {}, "cli")).toThrow(/did not report a version/)
    expect(() => verifyHandshake({ cli: "1.2.3", helper: "1.2.3" }, { cli: "1.2.3" }, "helper")).toThrow(
      /did not report a version/,
    )
  })
})
