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

/**
 * Set on every proxied request to name the instance it is addressed to. The
 * server answers 409 rather than serving another instance's data, so the
 * guarantee survives a port changing hands between the probe and the request.
 */
export const INSTANCE_EXPECT_HEADER = "x-opencode-expect-instance"

/**
 * A long-lived device token for local tooling, minted once and reused across
 * every desktop restart. Dev-only and gitignored: it is a real credential for
 * the loopback sidecar, and it exists so a human or an agent can actually
 * exercise authenticated endpoints instead of inferring behaviour from 401s.
 */
export const AGENT_TOKEN_FILENAME = ".opencode-dev-agent-token.json"

/** Bumped if the agent token file's shape changes. */
export const AGENT_TOKEN_VERSION = 1

/** Device name the token is registered under, so it is obvious in Settings. */
export const AGENT_DEVICE_NAME = "opencode dev tooling (local)"

/** Served by the Vite dev server: which backend, if any, it is bound to. */
export const DEV_TARGET_STATUS_PATH = "/__opencode/dev-target"

/** Desktop -> sidecar: the value the sidecar must echo back on IDENTITY_PATH. */
export const ENV_INSTANCE_ID = "OPENCODE_INSTANCE_ID"

/** `bun run dev` -> both halves: ties one Vite dev server to one desktop launch. */
export const ENV_RUN_ID = "OPENCODE_DEV_RUN_ID"

/** Escape hatch for pointing the dev proxy at a hand-picked backend. */
export const ENV_PROXY_TARGET = ["VITE_OPENCODE_SERVER_URL", "OPENCODE_DEV_PROXY_TARGET"] as const
