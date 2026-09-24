import { existsSync } from "node:fs"
import { join } from "node:path"

import { WORKTREE_STORE_CLI_CANDIDATES, WORKTREE_STORE_RESOURCE_DIRECTORY } from "./worktree-store-layout"

export { WORKTREE_STORE_RESOURCE_DIRECTORY }

/**
 * Packaged managed-sidecar discovery for the OpenFork server sidecar env.
 *
 * The Electron main process is the only process that knows the packaged
 * resource root before the server starts, so it publishes the staged
 * worktree-store payload location to the server as explicit environment.
 * Resolution is deterministic and fail-closed: nothing is published unless the
 * staged root *and* the CLI executable both exist on disk.
 *
 * An explicit environment already present always wins, so a developer or an
 * operator can point OpenFork at a different (for example dev-local) payload.
 */
export const WORKTREE_STORE_ROOT_ENV = "OPENFORK_WORKTREE_STORE_ROOT"
export const WORKTREE_STORE_CLI_ENV = "OPENFORK_WORKTREE_STORE_CLI"

export function resolveWorktreeStoreSidecarEnv(
  input: {
    readonly resourcesPath?: string | undefined
    readonly platform?: NodeJS.Platform
    readonly env?: Record<string, string | undefined>
    readonly exists?: (path: string) => boolean
  } = {},
): Record<string, string> {
  const env = input.env ?? process.env
  if (env[WORKTREE_STORE_ROOT_ENV] !== undefined || env[WORKTREE_STORE_CLI_ENV] !== undefined) return {}
  const platform = input.platform ?? process.platform
  if (platform !== "win32") return {}
  const resourcesPath = input.resourcesPath
  if (resourcesPath === undefined || resourcesPath.length === 0) return {}

  const exists = input.exists ?? existsSync
  const root = join(resourcesPath, WORKTREE_STORE_RESOURCE_DIRECTORY)
  if (!exists(root)) return {}
  const cli = WORKTREE_STORE_CLI_CANDIDATES.map((name) => join(root, ...name.split("/"))).find((candidate) =>
    exists(candidate),
  )
  if (cli === undefined) return {}
  return { [WORKTREE_STORE_ROOT_ENV]: root, [WORKTREE_STORE_CLI_ENV]: cli }
}
