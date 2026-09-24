import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  WORKTREE_STORE_DEV_ARCHIVE_ENV,
  WORKTREE_STORE_LOCK_FILE,
  WORKTREE_STORE_LOCK_SCHEMA,
  WORKTREE_STORE_TARGETS,
  WorktreeStoreLockError,
  loadWorktreeStoreLock,
  parseWorktreeStoreLock,
  resolveWorktreeStoreSource,
  resolveWorktreeStoreTarget,
  worktreeStoreLockPath,
} from "./worktree-store-lock"
import { WORKTREE_STORE_BUNDLE_MANIFEST_FILE } from "./worktree-store-verify"

const packageDir = path.resolve(import.meta.dir, "..")

const pin = () => ({
  version: "1.2.3",
  archive: {
    url: "https://example.invalid/worktree-store-1.2.3-win32-x64.zip",
    size: 4096,
    sha256: "a".repeat(64),
  },
  manifest: WORKTREE_STORE_BUNDLE_MANIFEST_FILE,
  cli: "worktree-store.exe",
  helper: "worktree-store-helper.exe",
})

function lockWith(target: string, value: unknown) {
  return {
    schema: WORKTREE_STORE_LOCK_SCHEMA,
    version: value === null ? null : "1.2.3",
    targets: Object.fromEntries(WORKTREE_STORE_TARGETS.map((key) => [key, key === target ? value : null])),
  }
}

function mutate(change: (draft: ReturnType<typeof lockWith>) => void) {
  const draft = lockWith("win32-x64", pin())
  change(draft)
  return draft
}

function lockError(run: () => unknown): WorktreeStoreLockError {
  try {
    run()
  } catch (error) {
    if (error instanceof WorktreeStoreLockError) return error
    throw error
  }
  throw new Error("expected a WorktreeStoreLockError")
}

describe("worktree-store lock schema", () => {
  test("the checked-in lock parses and pins no target", async () => {
    const loaded = await loadWorktreeStoreLock()
    expect(loaded.schema).toBe(WORKTREE_STORE_LOCK_SCHEMA)
    expect(loaded.version).toBeNull()
    for (const key of WORKTREE_STORE_TARGETS) expect(loaded.targets[key]).toBeNull()
    expect(worktreeStoreLockPath(packageDir)).toBe(path.join(packageDir, WORKTREE_STORE_LOCK_FILE))
  })

  test("parses a fully pinned synthetic target", () => {
    const lock = parseWorktreeStoreLock(lockWith("win32-x64", pin()))
    expect(lock.targets["win32-x64"]).toEqual(pin())
    expect(lock.targets["linux-x64"]).toBeNull()
  })

  test("accepts a cli-only pin without a helper", () => {
    const cliOnly = { ...pin(), helper: undefined }
    delete (cliOnly as { helper?: unknown }).helper
    const lock = parseWorktreeStoreLock(lockWith("darwin-arm64", cliOnly))
    expect(lock.targets["darwin-arm64"]?.helper).toBeUndefined()
  })

  const rejections: Array<[string, () => unknown]> = [
    ["non-object lock", () => []],
    ["unknown top-level field", () => mutate((draft) => Object.assign(draft, { extra: true }))],
    ["unsupported schema", () => mutate((draft) => Object.assign(draft, { schema: "openfork.other/v1" }))],
    ["missing version field", () => mutate((draft) => delete (draft as Record<string, unknown>).version)],
    ["non-semver version", () => mutate((draft) => Object.assign(draft, { version: "latest" }))],
    [
      "missing target key",
      () => mutate((draft) => delete (draft.targets as Record<string, unknown>)["linux-x64"]),
    ],
    [
      "unknown target key",
      () => mutate((draft) => Object.assign(draft.targets, { "freebsd-x64": null })),
    ],
    [
      "unknown pin field",
      () => mutate((draft) => Object.assign(draft.targets["win32-x64"] as object, { extra: 1 })),
    ],
    [
      "non-semver pin version",
      () => mutate((draft) => Object.assign(draft.targets["win32-x64"] as object, { version: "v1.2.3" })),
    ],
    [
      "http archive url",
      () =>
        mutate((draft) =>
          Object.assign((draft.targets["win32-x64"] as { archive: object }).archive, {
            url: "http://example.invalid/a.zip",
          }),
        ),
    ],
    [
      "uppercase sha256",
      () =>
        mutate((draft) =>
          Object.assign((draft.targets["win32-x64"] as { archive: object }).archive, { sha256: "A".repeat(64) }),
        ),
    ],
    [
      "zero archive size",
      () =>
        mutate((draft) => Object.assign((draft.targets["win32-x64"] as { archive: object }).archive, { size: 0 })),
    ],
    [
      "fractional archive size",
      () =>
        mutate((draft) =>
          Object.assign((draft.targets["win32-x64"] as { archive: object }).archive, { size: 10.5 }),
        ),
    ],
    [
      "unknown archive field",
      () =>
        mutate((draft) =>
          Object.assign((draft.targets["win32-x64"] as { archive: object }).archive, { format: "zip" }),
        ),
    ],
    [
      "absolute manifest path",
      () => mutate((draft) => Object.assign(draft.targets["win32-x64"] as object, { manifest: `/${WORKTREE_STORE_BUNDLE_MANIFEST_FILE}` })),
    ],
    [
      "traversing manifest path",
      () => mutate((draft) => Object.assign(draft.targets["win32-x64"] as object, { manifest: `../${WORKTREE_STORE_BUNDLE_MANIFEST_FILE}` })),
    ],
    [
      "backslash manifest path",
      () =>
        mutate((draft) => Object.assign(draft.targets["win32-x64"] as object, { manifest: `sub\\${WORKTREE_STORE_BUNDLE_MANIFEST_FILE}` })),
    ],
    [
      "absolute cli path",
      () => mutate((draft) => Object.assign(draft.targets["win32-x64"] as object, { cli: "C:/worktree-store.exe" })),
    ],
    [
      "empty helper path",
      () => mutate((draft) => Object.assign(draft.targets["win32-x64"] as object, { helper: "" })),
    ],
  ]

  for (const [name, build] of rejections) {
    test(`rejects ${name}`, () => {
      expect(() => parseWorktreeStoreLock(build())).toThrow(WorktreeStoreLockError)
    })
  }

  test("fails closed when the lock file is missing or malformed", async () => {
    const directory = await mkdtemp(path.join(packageDir, ".tmp-lock-test-"))
    try {
      const missing = await loadWorktreeStoreLock(path.join(directory, "missing.json")).catch((cause) => cause)
      expect(missing).toBeInstanceOf(WorktreeStoreLockError)
      expect(missing.code).toBe("lock-missing")

      const invalid = path.join(directory, "invalid.json")
      await writeFile(invalid, "{ not json")
      const malformed = await loadWorktreeStoreLock(invalid).catch((cause) => cause)
      expect(malformed).toBeInstanceOf(WorktreeStoreLockError)
      expect(malformed.code).toBe("invalid-json")

      const empty = path.join(directory, "empty.json")
      await writeFile(empty, JSON.stringify({ schema: WORKTREE_STORE_LOCK_SCHEMA, version: null, targets: {} }))
      const incomplete = await loadWorktreeStoreLock(empty).catch((cause) => cause)
      expect(incomplete).toBeInstanceOf(WorktreeStoreLockError)
      expect(incomplete.code).toBe("missing-target")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("worktree-store target resolution", () => {
  test("accepts the six supported keys", () => {
    expect(resolveWorktreeStoreTarget("win32", "x64")).toBe("win32-x64")
    expect(resolveWorktreeStoreTarget("darwin", "arm64")).toBe("darwin-arm64")
    expect(resolveWorktreeStoreTarget("linux", "x64")).toBe("linux-x64")
  })

  test("rejects unsupported platform and architecture", () => {
    expect(lockError(() => resolveWorktreeStoreTarget("freebsd", "x64")).code).toBe("missing-target")
    expect(lockError(() => resolveWorktreeStoreTarget("win32", "ia32")).code).toBe("missing-target")
  })
})

describe("worktree-store source resolution", () => {
  const unpinned = parseWorktreeStoreLock(
    Object.fromEntries(
      Object.entries({ schema: WORKTREE_STORE_LOCK_SCHEMA, version: null, targets: Object.fromEntries(WORKTREE_STORE_TARGETS.map((key) => [key, null])) }),
    ),
  )
  const pinned = parseWorktreeStoreLock(lockWith("win32-x64", pin()))

  test("a pinned target always wins", () => {
    const source = resolveWorktreeStoreSource({ lock: pinned, target: "win32-x64", channel: "prod", env: {} })
    expect(source.kind).toBe("pinned")
    if (source.kind === "pinned") expect(source.pin.version).toBe("1.2.3")
  })

  test("every unpinned target fails closed for beta and prod", () => {
    for (const channel of ["beta", "prod"] as const) {
      for (const target of WORKTREE_STORE_TARGETS) {
        const error = lockError(() => resolveWorktreeStoreSource({ lock: unpinned, target, channel, env: {} }))
        expect(error.code).toBe("missing-target")
        expect(error.message).toMatch(/fails closed/)
      }
    }
  })

  test("dev builds without a pin are unavailable rather than fabricated", () => {
    const source = resolveWorktreeStoreSource({ lock: unpinned, target: "win32-x64", channel: "dev", env: {} })
    expect(source.kind).toBe("unavailable")
  })

  test("honors the development-only local archive override on dev", () => {
    const source = resolveWorktreeStoreSource({
      lock: unpinned,
      target: "win32-x64",
      channel: "dev",
      env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: "C:/tmp/worktree-store-dev" },
    })
    expect(source).toEqual({ kind: "local", path: "C:/tmp/worktree-store-dev" })
  })

  test("refuses the local override outside dev and against a pin", () => {
    for (const channel of ["beta", "prod"] as const) {
      expect(
        lockError(() =>
          resolveWorktreeStoreSource({
            lock: pinned,
            target: "win32-x64",
            channel,
            env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: "C:/tmp/worktree-store-dev" },
          }),
        ).code,
      ).toBe("dev-override-rejected")
    }
    expect(
      lockError(() =>
        resolveWorktreeStoreSource({
          lock: pinned,
          target: "win32-x64",
          channel: "dev",
          env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: "C:/tmp/worktree-store-dev" },
        }),
      ).code,
    ).toBe("dev-override-rejected")
  })

  test("refuses the local override on beta and prod even while the lock pins nothing", () => {
    for (const channel of ["beta", "prod"] as const) {
      expect(
        lockError(() =>
          resolveWorktreeStoreSource({
            lock: unpinned,
            target: "win32-x64",
            channel,
            env: { [WORKTREE_STORE_DEV_ARCHIVE_ENV]: "C:/tmp/worktree-store-dev" },
          }),
        ).code,
      ).toBe("dev-override-rejected")
    }
  })
})
