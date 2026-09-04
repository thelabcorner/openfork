/**
 * Dev-time binding handshake between the Electron desktop shell, the opencode
 * sidecar it spawns, and the mobile PWA's Vite dev server.
 *
 * Why this exists: the sidecar binds an ephemeral port, so the Vite proxy has
 * to be told where it is. It used to be told by a file containing a bare URL
 * and it trusted that URL unconditionally. On a machine that runs many
 * unrelated opencode processes (JetBrains ACP agents, `opencode serve`, other
 * checkouts, older versions) a stale or recycled port silently pointed the PWA
 * at *somebody else's* backend. A listening port is not evidence of identity.
 *
 * So the desktop now mints a random `instanceID` per launch, hands it to the
 * sidecar via `OPENCODE_INSTANCE_ID`, and records it here. The sidecar
 * republishes it on `GET /instance/identity`. Nothing binds until that echo
 * matches, which makes misbinding impossible rather than merely unlikely.
 *
 * This module is imported by BOTH `packages/mobile/vite.config.ts` and the
 * Electron main process, so it must stay dependency-free and use only
 * `node:` builtins. It must never resolve paths from `import.meta.url` —
 * electron-vite bundles it into `out/main/`, where that would point at the
 * wrong directory. Callers pass their own `packages/mobile` directory in.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { HANDSHAKE_FILENAME, LEGACY_HANDSHAKE_FILENAMES } from "./constants"

export {
  ENV_INSTANCE_ID,
  ENV_PROXY_TARGET,
  ENV_RUN_ID,
  HANDSHAKE_FILENAME,
  HANDSHAKE_VERSION,
  IDENTITY_PATH,
  LEGACY_HANDSHAKE_FILENAMES,
} from "./constants"

export type DevHandshake = {
  version: number
  /** Origin of the sidecar, e.g. `http://127.0.0.1:63841`. */
  url: string
  /** Random per desktop launch. The whole point of this file. */
  instanceID: string
  /** Shared by every process in one `bun run dev`, when present. */
  runID?: string
  /** Electron main's pid, for `Get-CimInstance` style forensics. */
  pid: number
  startedAt: string
  /** `dev` | `beta` | `prod` — surfaced in errors so mixed channels are obvious. */
  channel?: string
}

export type InstanceIdentity = {
  instanceID: string
  processID?: number
  startedAt?: string
  version?: string
  client?: string
}

export function handshakePath(mobileDir: string) {
  return join(mobileDir, HANDSHAKE_FILENAME)
}

export function legacyHandshakePaths(mobileDir: string) {
  return LEGACY_HANDSHAKE_FILENAMES.map((name) => join(mobileDir, name))
}

export function writeHandshake(file: string, value: DevHandshake) {
  mkdirSync(dirname(file), { recursive: true })
  // Same-directory rename is atomic, so the Vite side can never observe a
  // half-written file and proxy to a truncated URL.
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  renameSync(temporary, file)
}

export function removeHandshake(file: string) {
  rmSync(file, { force: true })
  rmSync(`${file}.${process.pid}.tmp`, { force: true })
}

export function parseHandshake(raw: string): DevHandshake | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const value = parsed as Record<string, unknown>
  if (typeof value.url !== "string" || !value.url) return undefined
  if (typeof value.instanceID !== "string" || !value.instanceID) return undefined
  return {
    version: typeof value.version === "number" ? value.version : 0,
    url: value.url.replace(/\/$/, ""),
    instanceID: value.instanceID,
    runID: typeof value.runID === "string" && value.runID ? value.runID : undefined,
    pid: typeof value.pid === "number" ? value.pid : 0,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    channel: typeof value.channel === "string" && value.channel ? value.channel : undefined,
  }
}

export function readHandshake(file: string): { raw: string; handshake: DevHandshake | undefined } | undefined {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  if (!raw.trim()) return undefined
  return { raw, handshake: parseHandshake(raw) }
}
