/**
 * Shared staged-layout contract between the desktop build scripts and the
 * packaged runtime.
 *
 * `scripts/fetch-worktree-store.ts` stages a pinned payload into
 * `<resources>/worktree-store`; the Electron main process later publishes that
 * location to the server sidecar by probing exactly these CLI names. Both sides
 * import this module so a pinned archive whose CLI name the runtime cannot
 * discover fails packaging instead of shipping an unreachable sidecar.
 */
export const WORKTREE_STORE_RESOURCE_DIRECTORY = "worktree-store"

export const WORKTREE_STORE_CLI_CANDIDATES = ["worktree-store.exe", "bin/worktree-store.exe"] as const

export function isWorktreeStoreCliCandidate(relativePath: string): boolean {
  return (WORKTREE_STORE_CLI_CANDIDATES as readonly string[]).includes(relativePath)
}
