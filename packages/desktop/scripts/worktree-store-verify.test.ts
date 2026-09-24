import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  WORKTREE_STORE_BUNDLE_MANIFEST_FILE,
  WorktreeStoreVerificationError,
  assertPackagedStageStamp,
  assertSafeArchiveEntries,
  assertSafeArchiveEntry,
  assertSafeRelativePath,
  findSiblingWorktreeStoreImports,
  mappedExecutableReusable,
  normalizeVersion,
  parseVersionOutput,
  parseWorktreeStoreBundleManifest,
  parseWorktreeStoreStageStamp,
  sha256Hex,
  verifyArchiveBytes,
  verifyExtractedTree,
  verifyHandshake,
  verifyWorktreeStoreBundleTarget,
  verifyWorktreeStoreStageStamp,
  type SourceFile,
} from "./worktree-store-verify"

function expectCode(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(WorktreeStoreVerificationError)
    expect((error as WorktreeStoreVerificationError).code).toBe(code)
    return
  }
  throw new Error(`expected WorktreeStoreVerificationError(${code})`)
}

async function verifyErrorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof WorktreeStoreVerificationError) return error.code
    throw error
  }
  throw new Error("verification unexpectedly succeeded")
}

const pinnedStamp = {
  schemaVersion: 1 as const,
  source: "pinned" as const,
  targetKey: "win32-x64",
  version: "v1.2.3",
  lockDigest: "a".repeat(64),
  archiveSha256: "b".repeat(64),
  archiveSize: 1234,
}

describe("worktree-store path and archive safety", () => {
  test("accepts archive-relative paths and rejects escapes", () => {
    expect(assertSafeRelativePath("bin/worktree-store", "where")).toBe("bin/worktree-store")
    expect(assertSafeRelativePath(WORKTREE_STORE_BUNDLE_MANIFEST_FILE, "where")).toBe(WORKTREE_STORE_BUNDLE_MANIFEST_FILE)
    for (const unsafe of ["", "/etc/passwd", "C:/worktree-store.exe", "..", "../manifest.json", "a/../b", "a\\b", "a//b", "a\0b"]) {
      expectCode(() => assertSafeRelativePath(unsafe, "where"), "unsafe-path")
    }
    expect(assertSafeArchiveEntry("dir/", "where")).toBe("dir")
    expect(assertSafeArchiveEntries(["a", "b/c"], "where")).toEqual(["a", "b/c"])
    expectCode(() => assertSafeArchiveEntries([], "where"), "unsafe-path")
    expectCode(() => assertSafeArchiveEntries(["a", "a"], "where"), "duplicate-entry")
  })

  test("verifies archive bytes by size and sha256", () => {
    const bytes = new TextEncoder().encode("payload")
    const pin = { size: bytes.byteLength, sha256: sha256Hex(bytes) }
    verifyArchiveBytes(bytes, pin, "archive")
    expectCode(() => verifyArchiveBytes(bytes, { ...pin, size: pin.size + 1 }, "archive"), "archive-size")
    expectCode(() => verifyArchiveBytes(bytes, { ...pin, sha256: "0".repeat(64) }, "archive"), "archive-digest")
  })

  test("computes the standard sha256 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})

const refsContent = "REFSEXE1"
const probeContent = "PROBEEXE1"

function helperEntry(id: "refs-block-clone" | "storage-probe", relativePath: string, content: string) {
  return {
    id,
    relativePath,
    sizeBytes: Buffer.byteLength(content),
    sha256: sha256Hex(content),
    target: { os: "windows", arch: "x64" },
    identity:
      id === "refs-block-clone"
        ? {
            helperName: "worktree-store-refs-block-clone",
            helperVersion: "1.2.3",
            sourceCompatibility: "worktree-store/refs-block-clone@1",
            protocols: { manifest: { magic: "WTRFSBC1", version: 1 }, success: { schemaVersion: 1 } },
          }
        : {
            helperName: "worktree-store-storage-probe",
            helperVersion: "1.2.3",
            sourceCompatibility: "worktree-store/storage-probe@1",
            protocols: { success: { schemaVersion: 1 } },
          },
  }
}

function validBundle() {
  return {
    schemaVersion: 1,
    kind: "worktree-store-packaging-bundle",
    bundle: {
      name: "worktree-store",
      packageVersion: "1.2.3",
      managedProtocolVersion: null,
      sourceRevision: "0123456789abcdef",
      target: { os: "windows", arch: "x64" },
    },
    helpers: [
      helperEntry("refs-block-clone", "helpers/refs-block-clone.exe", refsContent),
      helperEntry("storage-probe", "helpers/storage-probe.exe", probeContent),
    ],
  }
}

function mutateBundle(change: (draft: any) => void) {
  const draft = structuredClone(validBundle())
  change(draft)
  return draft
}

describe("worktree-store producer bundle manifest", () => {
  test("parses the producer worktree-store-bundle.json shape", () => {
    const manifest = parseWorktreeStoreBundleManifest(validBundle(), "manifest")
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.kind).toBe("worktree-store-packaging-bundle")
    expect(manifest.bundle.name).toBe("worktree-store")
    expect(manifest.bundle.packageVersion).toBe("1.2.3")
    expect(manifest.bundle.managedProtocolVersion).toBeNull()
    expect(manifest.bundle.sourceRevision).toBe("0123456789abcdef")
    expect(manifest.bundle.target).toEqual({ os: "windows", arch: "x64" })
    expect(manifest.helpers.map((helper) => helper.id)).toEqual(["refs-block-clone", "storage-probe"])
    expect(manifest.helpers[0]!.relativePath).toBe("helpers/refs-block-clone.exe")
    expect(manifest.helpers[0]!.identity.protocols.manifest).toEqual({ magic: "WTRFSBC1", version: 1 })
    expect(manifest.helpers[1]!.identity.protocols.manifest).toBeUndefined()
  })

  test("rejects manifests that are not the producer schema", () => {
    const rejections: Array<[string, unknown, string]> = [
      ["unsupported schema version", mutateBundle((draft) => (draft.schemaVersion = 2)), "manifest-invalid"],
      ["wrong kind", mutateBundle((draft) => (draft.kind = "openfork-sidecar")), "manifest-invalid"],
      ["unknown root field", mutateBundle((draft) => (draft.notes = "extra")), "manifest-invalid"],
      ["missing bundle field", mutateBundle((draft) => delete draft.bundle.sourceRevision), "manifest-invalid"],
      ["wrong bundle name", mutateBundle((draft) => (draft.bundle.name = "opencode")), "manifest-invalid"],
      ["invalid package version", mutateBundle((draft) => (draft.bundle.packageVersion = "../1.2.3")), "manifest-invalid"],
      ["non-windows bundle target", mutateBundle((draft) => (draft.bundle.target.os = "linux")), "manifest-invalid"],
      ["unsupported bundle arch", mutateBundle((draft) => (draft.bundle.target.arch = "ia32")), "manifest-invalid"],
      ["empty helpers", mutateBundle((draft) => (draft.helpers = [])), "manifest-invalid"],
      ["unsorted helpers", mutateBundle((draft) => draft.helpers.reverse()), "manifest-invalid"],
      [
        "duplicate helper ids",
        mutateBundle((draft) => {
          draft.helpers[1].id = "refs-block-clone"
          draft.helpers[1].identity.helperName = "worktree-store-refs-block-clone"
          draft.helpers[1].identity.protocols.manifest = { magic: "WTRFSBC1", version: 1 }
        }),
        "manifest-invalid",
      ],
      ["unknown helper id", mutateBundle((draft) => (draft.helpers[1].id = "storage-prob")), "manifest-invalid"],
      ["helper target mismatch", mutateBundle((draft) => (draft.helpers[0].target.arch = "arm64")), "manifest-invalid"],
      ["traversal helper path", mutateBundle((draft) => (draft.helpers[0].relativePath = "../refs.exe")), "unsafe-path"],
      ["backslash helper path", mutateBundle((draft) => (draft.helpers[0].relativePath = "helpers\\refs.exe")), "unsafe-path"],
      ["colon helper path", mutateBundle((draft) => (draft.helpers[0].relativePath = "helpers/refs:stream.exe")), "unsafe-path"],
      ["windows aliasing helper path", mutateBundle((draft) => (draft.helpers[0].relativePath = "helpers/refs.exe.")), "unsafe-path"],
      ["zero helper size", mutateBundle((draft) => (draft.helpers[0].sizeBytes = 0)), "manifest-invalid"],
      ["fractional helper size", mutateBundle((draft) => (draft.helpers[0].sizeBytes = 1.5)), "manifest-invalid"],
      ["uppercase helper sha256", mutateBundle((draft) => (draft.helpers[0].sha256 = "A".repeat(64))), "manifest-invalid"],
      [
        "identity name mismatch",
        mutateBundle((draft) => (draft.helpers[0].identity.helperName = "worktree-store-storage-probe")),
        "manifest-invalid",
      ],
      [
        "refs missing manifest protocol",
        mutateBundle((draft) => delete draft.helpers[0].identity.protocols.manifest),
        "manifest-invalid",
      ],
      [
        "storage-probe with manifest protocol",
        mutateBundle((draft) => (draft.helpers[1].identity.protocols.manifest = { magic: "WTRFSBC1", version: 1 })),
        "manifest-invalid",
      ],
      ["unknown protocol field", mutateBundle((draft) => (draft.helpers[1].identity.protocols.future = true)), "manifest-invalid"],
      [
        "bad protocol magic",
        mutateBundle((draft) => (draft.helpers[0].identity.protocols.manifest.magic = "bad magic")),
        "manifest-invalid",
      ],
      [
        "bad protocol version",
        mutateBundle((draft) => (draft.helpers[0].identity.protocols.manifest.version = 0)),
        "manifest-invalid",
      ],
      [
        "bad success schema version",
        mutateBundle((draft) => (draft.helpers[1].identity.protocols.success.schemaVersion = 0)),
        "manifest-invalid",
      ],
    ]
    for (const [name, raw, code] of rejections) {
      try {
        parseWorktreeStoreBundleManifest(raw, "manifest")
      } catch (error) {
        expect(error, name).toBeInstanceOf(WorktreeStoreVerificationError)
        expect((error as WorktreeStoreVerificationError).code, name).toBe(code)
        continue
      }
      throw new Error(`expected ${name} to be rejected`)
    }
  })

  test("binds the bundle target to the pinned desktop target", () => {
    const manifest = parseWorktreeStoreBundleManifest(validBundle(), "manifest")
    verifyWorktreeStoreBundleTarget(manifest, "win32-x64", "payload")
    expectCode(() => verifyWorktreeStoreBundleTarget(manifest, "win32-arm64", "payload"), "manifest-target")
    expectCode(() => verifyWorktreeStoreBundleTarget(manifest, "linux-x64", "payload"), "manifest-target")
  })

  test("verifies the extracted tree against the bundle manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openfork-tree-"))
    try {
      await mkdir(path.join(root, "helpers"), { recursive: true })
      await writeFile(path.join(root, "helpers", "refs-block-clone.exe"), refsContent, "utf8")
      await writeFile(path.join(root, "helpers", "storage-probe.exe"), probeContent, "utf8")
      const manifest = validBundle()
      await writeFile(path.join(root, WORKTREE_STORE_BUNDLE_MANIFEST_FILE), JSON.stringify(manifest), "utf8")
      const parsed = parseWorktreeStoreBundleManifest(manifest, "manifest")
      await verifyExtractedTree(root, parsed, WORKTREE_STORE_BUNDLE_MANIFEST_FILE, "payload")

      await writeFile(path.join(root, "VERSION"), "1.2.3\n", "utf8")
      expect(
        await verifyErrorCode(() =>
          verifyExtractedTree(root, parsed, WORKTREE_STORE_BUNDLE_MANIFEST_FILE, "payload"),
        ),
      ).toBe("unexpected-file")
      await verifyExtractedTree(root, parsed, WORKTREE_STORE_BUNDLE_MANIFEST_FILE, "payload", {
        allowUndeclared: ["VERSION"],
      })

      await writeFile(path.join(root, "helpers", "refs-block-clone.exe"), "tampered", "utf8")
      expect(
        await verifyErrorCode(() =>
          verifyExtractedTree(root, parsed, WORKTREE_STORE_BUNDLE_MANIFEST_FILE, "payload", {
            allowUndeclared: ["VERSION"],
          }),
        ),
      ).toBe("file-digest")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports a missing bundle manifest or missing helper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openfork-tree-"))
    try {
      const manifest = parseWorktreeStoreBundleManifest(validBundle(), "manifest")
      expect(
        await verifyErrorCode(() =>
          verifyExtractedTree(root, manifest, WORKTREE_STORE_BUNDLE_MANIFEST_FILE, "payload"),
        ),
      ).toBe("missing-file")

      await writeFile(path.join(root, WORKTREE_STORE_BUNDLE_MANIFEST_FILE), JSON.stringify(validBundle()), "utf8")
      expect(
        await verifyErrorCode(() =>
          verifyExtractedTree(root, manifest, WORKTREE_STORE_BUNDLE_MANIFEST_FILE, "payload"),
        ),
      ).toBe("missing-file")

      await mkdir(path.join(root, "helpers"), { recursive: true })
      await writeFile(path.join(root, "helpers", "refs-block-clone.exe"), refsContent, "utf8")
      await writeFile(path.join(root, "helpers", "storage-probe.exe"), probeContent, "utf8")
      await rm(path.join(root, WORKTREE_STORE_BUNDLE_MANIFEST_FILE))
      expect(
        await verifyErrorCode(() =>
          verifyExtractedTree(root, manifest, WORKTREE_STORE_BUNDLE_MANIFEST_FILE, "payload"),
        ),
      ).toBe("missing-file")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("worktree-store version handshakes", () => {
  test("normalizes and parses reported versions", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3")
    expect(normalizeVersion("1.2.3")).toBe("1.2.3")
    expect(parseVersionOutput("worktree-store 1.2.3\n", "cli")).toBe("1.2.3")
    expect(parseVersionOutput("worktree-store v1.2.3-rc.1", "cli")).toBe("1.2.3-rc.1")
    expectCode(() => parseVersionOutput("no version here", "cli"), "handshake-output")
  })

  test("requires every pinned channel to report the pinned version", () => {
    verifyHandshake({ cli: "1.2.3" }, { cli: "1.2.3" }, "handshake")
    verifyHandshake({ cli: "1.2.3" }, { cli: "1.2.3", helper: "9.9.9" }, "handshake")
    expectCode(() => verifyHandshake({ cli: "1.2.3" }, { cli: "1.2.4" }, "handshake"), "stale-handshake")
    expectCode(() => verifyHandshake({ cli: "1.2.3", helper: "1.2.3" }, { cli: "1.2.3" }, "handshake"), "stale-handshake")
    expectCode(() => verifyHandshake({ cli: "1.2.3" }, {}, "handshake"), "stale-handshake")
  })
})

describe("worktree-store stage stamps", () => {
  test("parses pinned and dev-local stamps and rejects inconsistent ones", () => {
    expect(parseWorktreeStoreStageStamp(pinnedStamp, "stamp")).toEqual(pinnedStamp)
    const devLocal = {
      schemaVersion: 1 as const,
      source: "dev-local" as const,
      targetKey: "linux-x64",
      version: "dev-local",
      lockDigest: "a".repeat(64),
      archiveSha256: null,
      archiveSize: null,
    }
    expect(parseWorktreeStoreStageStamp(devLocal, "stamp")).toEqual(devLocal)
    expectCode(() => parseWorktreeStoreStageStamp({ ...pinnedStamp, archiveSha256: null }, "stamp"), "stamp-invalid")
    expectCode(() => parseWorktreeStoreStageStamp({ ...pinnedStamp, source: "sibling" }, "stamp"), "stamp-invalid")
    expectCode(() => parseWorktreeStoreStageStamp({ ...pinnedStamp, extra: true }, "stamp"), "stamp-invalid")
    expectCode(() => parseWorktreeStoreStageStamp({ ...pinnedStamp, targetKey: "freebsd-x64" }, "stamp"), "stamp-invalid")
    expectCode(() => assertPackagedStageStamp(parseWorktreeStoreStageStamp(devLocal, "stamp"), "stamp"), "dev-local-stamp")
    assertPackagedStageStamp(parseWorktreeStoreStageStamp(pinnedStamp, "stamp"), "stamp")
  })

  test("detects a stamp that no longer matches the checked-in pin", () => {
    const stamp = parseWorktreeStoreStageStamp(pinnedStamp, "stamp")
    const expected = {
      lockDigest: pinnedStamp.lockDigest,
      targetKey: pinnedStamp.targetKey,
      version: pinnedStamp.version,
      archiveSha256: pinnedStamp.archiveSha256,
      archiveSize: pinnedStamp.archiveSize,
    }
    verifyWorktreeStoreStageStamp(stamp, expected, "stamp")
    expectCode(() => verifyWorktreeStoreStageStamp(stamp, { ...expected, lockDigest: "c".repeat(64) }, "stamp"), "stale-lock-stamp")
    expectCode(() => verifyWorktreeStoreStageStamp(stamp, { ...expected, version: "v9.9.9" }, "stamp"), "stale-version")
    expectCode(() => verifyWorktreeStoreStageStamp(stamp, { ...expected, archiveSize: 42 }, "stamp"), "stale-archive")
  })

  test("only reuses a mapped Windows executable with identical bytes", () => {
    expect(mappedExecutableReusable("win32", "a".repeat(64), "a".repeat(64))).toBe(true)
    expect(mappedExecutableReusable("win32", undefined, "a".repeat(64))).toBe(false)
    expect(mappedExecutableReusable("win32", "b".repeat(64), "a".repeat(64))).toBe(false)
    expect(mappedExecutableReusable("linux", "a".repeat(64), "a".repeat(64))).toBe(false)
  })
})

describe("worktree-store sibling-import source guard", () => {
  test("flags bare, dependency, and escaping imports while allowing local modules", () => {
    const sibling = ["worktree", "store"].join("-")
    const violations = findSiblingWorktreeStoreImports([
      { path: "src/a.ts", content: `import { x } from "${sibling}"` },
      { path: "src/b.ts", content: `const y = require("@openfork/${sibling}")` },
      { path: "src/c.ts", content: `import("../../${sibling}/src/index")` },
      { path: "scripts/d.ts", content: `import("../../../${sibling}/src/index")` },
      { path: "src/bad.ts", content: `import { x } from "../${sibling}-evil"` },
      { path: "src/ok.ts", content: `import { stage } from "./worktree-store-lock"` },
      { path: "src/worktree-store-lock.ts", content: `export const stage = () => {}` },
      { path: "src/worktree-store-verify.ts", content: `export const verify = () => {}` },
      { path: "src/main/worktree-store-layout.ts", content: `export const layout = 1` },
      { path: "scripts/ok.ts", content: `import { layout } from "../src/main/${sibling}-layout"` },
      { path: "src/ok2.ts", content: `import { verify } from "./worktree-store-verify"` },
    ])
    expect(violations).toEqual([
      `src/a.ts: imports "${sibling}"`,
      `src/b.ts: imports "@openfork/${sibling}"`,
      `src/c.ts: imports "../../${sibling}/src/index"`,
      `scripts/d.ts: imports "../../../${sibling}/src/index"`,
      `src/bad.ts: imports "../${sibling}-evil"`,
    ])
    expect(
      findSiblingWorktreeStoreImports([
        { path: "package.json", content: JSON.stringify({ dependencies: { [sibling]: "1.0.0" } }) },
      ]),
    ).toEqual([`package.json: dependencies."${sibling}"`])
  })

  test("desktop sources never import a sibling worktree-store package", async () => {
    const root = path.resolve(import.meta.dir, "..")
    const files: SourceFile[] = []
    await collectDesktopSources(root, "", files)
    expect(files.length).toBeGreaterThan(10)
    expect(findSiblingWorktreeStoreImports(files)).toEqual([])
  })
})

async function collectDesktopSources(root: string, relative: string, files: SourceFile[]): Promise<void> {
  for (const entry of await readdir(path.join(root, ...relative.split("/").filter(Boolean)), { withFileTypes: true })) {
    if (["node_modules", "out", "dist", ".turbo", "resources", "native"].includes(entry.name)) continue
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      await collectDesktopSources(root, child, files)
      continue
    }
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name === "package.json") {
      files.push({ path: child, content: await readFile(path.join(root, ...child.split("/")), "utf8") })
    }
  }
}
