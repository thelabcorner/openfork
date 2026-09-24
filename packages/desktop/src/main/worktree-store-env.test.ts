import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  WORKTREE_STORE_CLI_ENV,
  WORKTREE_STORE_ROOT_ENV,
  resolveWorktreeStoreSidecarEnv,
} from "./worktree-store-env"
import { WORKTREE_STORE_CLI_CANDIDATES, isWorktreeStoreCliCandidate } from "./worktree-store-layout"

const RESOURCES = "C:\\Program Files\\OpenFork\\resources"

function fakeExists(paths: string[], present: string[]): (path: string) => boolean {
  const set = new Set(present.map((path) => path.toLowerCase()))
  return (candidate) => set.has(candidate.toLowerCase())
}

describe("packaged worktree-store sidecar env", () => {
  test("publishes the staged root and CLI when both exist", () => {
    const root = join(RESOURCES, "worktree-store")
    const cli = join(root, "worktree-store.exe")
    expect(
      resolveWorktreeStoreSidecarEnv({
        resourcesPath: RESOURCES,
        platform: "win32",
        env: {},
        exists: fakeExists([root, cli], [root, cli]),
      }),
    ).toEqual({ [WORKTREE_STORE_ROOT_ENV]: root, [WORKTREE_STORE_CLI_ENV]: cli })
  })

  test("accepts the nested bin/ CLI location", () => {
    const root = join(RESOURCES, "worktree-store")
    const cli = join(root, "bin", "worktree-store.exe")
    expect(
      resolveWorktreeStoreSidecarEnv({
        resourcesPath: RESOURCES,
        platform: "win32",
        env: {},
        exists: fakeExists([root, cli], [root, cli]),
      }),
    ).toEqual({ [WORKTREE_STORE_ROOT_ENV]: root, [WORKTREE_STORE_CLI_ENV]: cli })
  })

  test("publishes nothing fail-closed when the payload or CLI is absent", () => {
    const root = join(RESOURCES, "worktree-store")
    expect(
      resolveWorktreeStoreSidecarEnv({
        resourcesPath: RESOURCES,
        platform: "win32",
        env: {},
        exists: fakeExists([root], []),
      }),
    ).toEqual({})
    expect(
      resolveWorktreeStoreSidecarEnv({
        resourcesPath: RESOURCES,
        platform: "win32",
        env: {},
        exists: fakeExists([root], [root]),
      }),
    ).toEqual({})
    expect(resolveWorktreeStoreSidecarEnv({ resourcesPath: undefined, platform: "win32", env: {} })).toEqual({})
  })

  test("publishes only the staged CLI candidates the build gates accept", () => {
    const root = join(RESOURCES, "worktree-store")
    for (const candidate of WORKTREE_STORE_CLI_CANDIDATES) {
      const cli = join(root, ...candidate.split("/"))
      expect(isWorktreeStoreCliCandidate(candidate)).toBe(true)
      expect(
        resolveWorktreeStoreSidecarEnv({
          resourcesPath: RESOURCES,
          platform: "win32",
          env: {},
          exists: fakeExists([root, cli], [root, cli]),
        }),
      ).toEqual({ [WORKTREE_STORE_ROOT_ENV]: root, [WORKTREE_STORE_CLI_ENV]: cli })
    }
    expect(isWorktreeStoreCliCandidate("worktree-store-cli.exe")).toBe(false)
    expect(
      resolveWorktreeStoreSidecarEnv({
        resourcesPath: RESOURCES,
        platform: "win32",
        env: {},
        exists: fakeExists([root], [root, join(root, "worktree-store-cli.exe")]),
      }),
    ).toEqual({})
  })

  test("never overrides explicit configuration and is Windows-only", () => {
    const root = join(RESOURCES, "worktree-store")
    const cli = join(root, "worktree-store.exe")
    expect(
      resolveWorktreeStoreSidecarEnv({
        resourcesPath: RESOURCES,
        platform: "win32",
        env: { [WORKTREE_STORE_ROOT_ENV]: "D:\\dev-local" },
        exists: fakeExists([root, cli], [root, cli]),
      }),
    ).toEqual({})
    expect(
      resolveWorktreeStoreSidecarEnv({
        resourcesPath: RESOURCES,
        platform: "linux",
        env: {},
        exists: fakeExists([root, cli], [root, cli]),
      }),
    ).toEqual({})
  })
})
