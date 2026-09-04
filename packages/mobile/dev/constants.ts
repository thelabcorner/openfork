/**
 * Names shared by the three parties in the dev binding handshake: the Electron
 * main process, this package's Vite dev server, and the PWA running in the
 * browser. Kept free of imports — `dev/handshake.ts` pulls in `node:fs`, so
 * browser code cannot import that file, and drifting copies of these strings
 * is exactly how a handshake silently stops handshaking.
 */

/** Bumped whenever the on-disk handshake shape changes; a mismatch fails closed. */
export const HANDSHAKE_VERSION = 2

export const HANDSHAKE_FILENAME = ".opencode-dev-handshake.json"

/**
 * v1 wrote a bare URL here with no identity at all, and the file was (wrongly)
 * tracked in git — so `git checkout` could resurrect a months-dead port.
 * Nothing reads it any more; both halves delete it on sight.
 */
export const LEGACY_HANDSHAKE_FILENAMES = [".opencode-dev-url"]

/** Unauthenticated identity echo, served by every opencode built after this change. */
export const IDENTITY_PATH = "/instance/identity"

/** Served by the Vite dev server: which backend, if any, it is bound to. */
export const DEV_TARGET_STATUS_PATH = "/__opencode/dev-target"

/** Desktop -> sidecar: the value the sidecar must echo back on IDENTITY_PATH. */
export const ENV_INSTANCE_ID = "OPENCODE_INSTANCE_ID"

/** `bun run dev` -> both halves: ties one Vite dev server to one desktop launch. */
export const ENV_RUN_ID = "OPENCODE_DEV_RUN_ID"

/** Escape hatch for pointing the dev proxy at a hand-picked backend. */
export const ENV_PROXY_TARGET = ["VITE_OPENCODE_SERVER_URL", "OPENCODE_DEV_PROXY_TARGET"] as const
