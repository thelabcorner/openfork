/**
 * A persistent, dev-only device token for local tooling.
 *
 * Everything about this stack is verifiable *except* authenticated endpoints:
 * the sidecar's master password is generated per launch and never written
 * down, so anyone debugging from outside the app can only ever see `401` and
 * guess. That is how a completely dead proxy survived a full review — status
 * codes matched, and nobody could open a session to find out otherwise.
 *
 * So the desktop pairs itself one real device, once, and records the token
 * here. It is *not* revoked on exit: re-minting per launch would defeat the
 * point, and the token is already scoped to a loopback sidecar on this
 * machine. Gitignored, and never created in a packaged build.
 *
 * Same constraints as handshake.ts: `node:` builtins only, and never resolve
 * paths from `import.meta.url` — electron-vite bundles this into `out/main/`.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { AGENT_TOKEN_FILENAME, AGENT_TOKEN_VERSION } from "./constants"

export { AGENT_DEVICE_NAME, AGENT_TOKEN_FILENAME, AGENT_TOKEN_VERSION } from "./constants"

export type DevAgentToken = {
  version: number
  /** `Authorization: Basic base64("device:" + token)`. */
  token: string
  deviceID: string
  deviceName: string
  createdAt: string
}

export function agentTokenPath(mobileDir: string) {
  return join(mobileDir, AGENT_TOKEN_FILENAME)
}

/** `Authorization` value for a device token, matching packages/mobile/src/api.ts. */
export function deviceAuthorization(token: string) {
  return `Basic ${Buffer.from(`device:${token}`).toString("base64")}`
}

export function writeAgentToken(file: string, value: DevAgentToken) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  try {
    // No-op on Windows, but on POSIX this is a credential and should not be
    // group/world readable.
    chmodSync(temporary, 0o600)
  } catch {}
  renameSync(temporary, file)
}

export function removeAgentToken(file: string) {
  rmSync(file, { force: true })
  rmSync(`${file}.${process.pid}.tmp`, { force: true })
}

export function parseAgentToken(raw: string): DevAgentToken | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const value = parsed as Record<string, unknown>
  if (typeof value.token !== "string" || !value.token) return undefined
  // A file from a future shape is not something to guess at: re-mint instead.
  if (value.version !== AGENT_TOKEN_VERSION) return undefined
  return {
    version: AGENT_TOKEN_VERSION,
    token: value.token,
    deviceID: typeof value.deviceID === "string" ? value.deviceID : "",
    deviceName: typeof value.deviceName === "string" ? value.deviceName : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
  }
}

export function readAgentToken(file: string): DevAgentToken | undefined {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  if (!raw.trim()) return undefined
  return parseAgentToken(raw)
}
