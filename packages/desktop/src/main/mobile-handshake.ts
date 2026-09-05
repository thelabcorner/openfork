import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  ENV_INSTANCE_ID,
  ENV_RUN_ID,
  HANDSHAKE_VERSION,
  IDENTITY_PATH,
  handshakePath,
  legacyHandshakePaths,
  removeHandshake,
  writeHandshake,
} from "../../../mobile/dev/handshake"
import { agentTokenPath } from "../../../mobile/dev/agent-token"
import { provisionAgentToken } from "../../../mobile/dev/agent-token-provision"

/**
 * Publishes where the sidecar is listening for the mobile PWA's Vite dev
 * proxy, and — the part that matters — *who* it is.
 *
 * The sidecar takes an ephemeral port, and this machine runs many unrelated
 * opencode processes. Handing the proxy a bare URL meant a stale or recycled
 * port silently pointed the phone at somebody else's backend. So each launch
 * mints an `instanceID`, passes it to the sidecar through the environment, and
 * records it here; the proxy refuses to bind until the server echoes it back
 * on `/instance/identity`.
 *
 * Only meaningful in a source checkout: when packaged, the path below lands
 * inside app.asar and there is no Vite dev server to talk to anyway.
 */

// out/main/index.js -> out/main -> out -> desktop -> packages/mobile
const mobileDir = fileURLToPath(new URL("../../../mobile", import.meta.url))

export type MobileHandshakeOptions = {
  packaged: boolean
  channel?: string
  onLog?: (message: string, meta?: Record<string, unknown>) => void
}

export type MobileHandshake = {
  /** Random per desktop launch. The sidecar must republish this exact value. */
  instanceID: string
  /** Environment additions for the sidecar process. */
  env: Record<string, string>
  /**
   * Records `url` as this launch's backend. Pass `instanceID` when the server
   * was not spawned by us (the v2 daemon path) so the file names the identity
   * that server actually reports rather than one it never received.
   */
  publish(url: string, instanceID?: string): void
  /**
   * Asks a server we did not spawn who it is, so `publish` can pin to a real
   * identity. Resolves `undefined` for anything that cannot answer.
   */
  discover(url: string): Promise<string | undefined>
  /**
   * Ensures a persistent device token exists for local tooling, minting one
   * only if there is not already a working one. Never throws; the desktop does
   * not depend on it.
   */
  ensureAgentToken(url: string, credentials: { username: string; password: string }): Promise<void>
  /** Idempotent; safe to call from every teardown path. */
  revoke(): void
}

export function createMobileHandshake(options: MobileHandshakeOptions): MobileHandshake {
  const log = options.onLog ?? (() => {})
  const instanceID = randomUUID()
  const runID = process.env[ENV_RUN_ID]?.trim() || undefined
  const file = handshakePath(mobileDir)
  const enabled = !options.packaged
  let published = false

  // A v1 checkout tracked `.opencode-dev-url` in git, so `git checkout` could
  // resurrect a months-dead port. Nothing reads it any more, but delete it on
  // sight so no stray tool picks it up either.
  const purgeLegacy = () => {
    if (!enabled) return
    for (const legacy of legacyHandshakePaths(mobileDir)) {
      try {
        removeHandshake(legacy)
      } catch {}
    }
  }

  const revoke = () => {
    if (!enabled) return
    purgeLegacy()
    try {
      removeHandshake(file)
      if (published) log("mobile dev handshake revoked", { file })
    } catch (error) {
      log("failed to revoke mobile dev handshake", { error: String(error) })
    }
    published = false
  }

  // Electron's before-quit/will-quit cover the orderly paths; this catches
  // the rest. Deliberately not a SIGINT/SIGTERM handler — installing one would
  // suppress Node's default terminate-on-signal and make Ctrl+C stop working.
  // A file surviving a hard kill is no longer dangerous (the proxy verifies
  // identity before binding), it just makes the error message less precise.
  if (enabled) process.once("exit", revoke)

  return {
    instanceID,
    env: {
      [ENV_INSTANCE_ID]: instanceID,
      ...(runID ? { [ENV_RUN_ID]: runID } : {}),
    },
    async discover(url: string) {
      if (!enabled) return undefined
      try {
        const response = await fetch(new URL(IDENTITY_PATH, `${url.replace(/\/$/, "")}/`), {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(2500),
        })
        if (!response.ok) return undefined
        const body = (await response.json()) as { instanceID?: unknown }
        return typeof body?.instanceID === "string" && body.instanceID ? body.instanceID : undefined
      } catch {
        return undefined
      }
    },
    publish(url: string, discovered?: string) {
      if (!enabled) return
      purgeLegacy()
      try {
        writeHandshake(file, {
          version: HANDSHAKE_VERSION,
          url: url.replace(/\/$/, ""),
          instanceID: discovered ?? instanceID,
          runID,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          channel: options.channel,
        })
        published = true
        log("mobile dev handshake published", { url, instanceID: discovered ?? instanceID, runID, file })
      } catch (error) {
        // Never fatal: the desktop app itself does not need this file.
        log("failed to publish mobile dev handshake", { error: String(error), file })
      }
    },
    async ensureAgentToken(url: string, credentials: { username: string; password: string }) {
      // Dev-only, exactly like the handshake: a packaged build has no Vite dev
      // server, no writable package directory, and no business minting itself
      // a standing credential.
      if (!enabled) return
      if (!credentials.password) return
      try {
        const result = await provisionAgentToken({
          file: agentTokenPath(mobileDir),
          url,
          username: credentials.username || "opencode",
          password: credentials.password,
          onLog: (message, meta) => log(message, meta),
        })
        if (result.ok) {
          // Deliberately not revoked on exit — the point is that it survives
          // restarts, so tooling can authenticate without a pairing dance.
          log(result.reused ? "reusing dev tooling device token" : "provisioned dev tooling device token", {
            deviceID: result.token.deviceID,
          })
        } else {
          log("could not provision dev tooling device token", { reason: result.reason, detail: result.detail })
        }
      } catch (error) {
        log("could not provision dev tooling device token", { error: String(error) })
      }
    },
    revoke,
  }
}
