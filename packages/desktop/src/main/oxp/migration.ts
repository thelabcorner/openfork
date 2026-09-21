import { promises as fs } from "node:fs"
import path from "node:path"
import type { SidecarLegacyImport, SidecarOxpGrant } from "../sidecar-protocol"
import { isValidTunnelID, type OxpLifecycle } from "./config"

const MAX_CONFIG_BYTES = 1024 * 1024
const ROOT_NAME = /^[a-z0-9._-]{1,32}$/
const ALLOWED_TOP_LEVEL = new Set(["connectorName", "roots", "permissions", "tunnel", "preferences"])
const ALLOWED_ROOT = new Set(["name", "path"])
const ALLOWED_PERMISSIONS = new Set(["read", "write", "shell", "git", "plugins", "filesReceive", "filesSend"])
const ALLOWED_TUNNEL = new Set(["kind", "tunnelId", "binaryPath"])
const ALLOWED_PREFERENCES = new Set(["launchAtLogin", "startHidden", "autoConnect", "closeToTray"])
const AUTO_IMPORT_APP_DIRS = ["localMCP-chat", "localmcp-chat", "dev.localmcp.chat"] as const

type LegacyPermissions = {
  read: boolean
  write: boolean
  shell: boolean
  git: boolean
  plugins: boolean
  filesReceive: boolean
  filesSend: boolean
}

type LegacyConfig = {
  connectorName: string
  roots: Array<{ name: string; path: string }>
  permissions: LegacyPermissions
  tunnel: { kind: "openai" | "cloudflared" | "manual"; tunnelId: string; binaryPath: string }
  preferences: OxpLifecycle
}

export type LocalMcpMigrationPlan = {
  readonly sourceFile: string
  readonly sidecar: SidecarLegacyImport
  readonly tunnelID?: string
  readonly lifecycle: OxpLifecycle
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid localMCP ${field}.`)
  return value as Record<string, unknown>
}

function rejectExtra(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string) {
  const extra = Object.keys(value).find((key) => !allowed.has(key))
  if (extra) {
    // Legacy config has never stored credentials. Refuse unknown fields rather
    // than copying them into an OXP migration transaction where an old or
    // hand-edited plaintext secret could accidentally gain a second lifetime.
    throw new Error(`Unsupported localMCP ${field} field: ${extra}`)
  }
}

function legacyBoolean(value: unknown, defaultValue: boolean) {
  return value === undefined ? defaultValue : value === true
}

function parseLegacy(value: unknown): LegacyConfig {
  const raw = record(value, "configuration")
  rejectExtra(raw, ALLOWED_TOP_LEVEL, "configuration")

  const rootsRaw = raw.roots === undefined ? [] : raw.roots
  if (!Array.isArray(rootsRaw) || rootsRaw.length > 64) throw new Error("Invalid localMCP approved roots.")
  const roots = rootsRaw.map((item, index) => {
    const root = record(item, `root ${index + 1}`)
    rejectExtra(root, ALLOWED_ROOT, `root ${index + 1}`)
    if (typeof root.name !== "string" || !ROOT_NAME.test(root.name)) throw new Error("Invalid localMCP root alias.")
    if (typeof root.path !== "string" || root.path.length === 0 || root.path.length > 4096 || !path.isAbsolute(root.path)) {
      throw new Error("Invalid localMCP root path.")
    }
    return { name: root.name, path: root.path }
  })

  const permissionsRaw = raw.permissions === undefined ? {} : record(raw.permissions, "permissions")
  rejectExtra(permissionsRaw, ALLOWED_PERMISSIONS, "permissions")
  const permissions: LegacyPermissions = {
    read: legacyBoolean(permissionsRaw.read, true),
    write: legacyBoolean(permissionsRaw.write, true),
    shell: legacyBoolean(permissionsRaw.shell, true),
    git: legacyBoolean(permissionsRaw.git, true),
    plugins: legacyBoolean(permissionsRaw.plugins, true),
    // Mirror standalone localMCP's compatibility defaults exactly.
    filesReceive: legacyBoolean(permissionsRaw.filesReceive, true),
    filesSend: permissionsRaw.filesSend === true,
  }

  const tunnelRaw = raw.tunnel === undefined ? {} : record(raw.tunnel, "tunnel")
  rejectExtra(tunnelRaw, ALLOWED_TUNNEL, "tunnel")
  const kind: LegacyConfig["tunnel"]["kind"] =
    tunnelRaw.kind === "cloudflared" || tunnelRaw.kind === "manual" || tunnelRaw.kind === "openai"
      ? tunnelRaw.kind
      : "openai"
  const tunnel = {
    kind,
    tunnelId: typeof tunnelRaw.tunnelId === "string" ? tunnelRaw.tunnelId : "",
    binaryPath: typeof tunnelRaw.binaryPath === "string" ? tunnelRaw.binaryPath : "",
  }

  const preferencesRaw = raw.preferences === undefined ? {} : record(raw.preferences, "preferences")
  rejectExtra(preferencesRaw, ALLOWED_PREFERENCES, "preferences")
  const preferences: OxpLifecycle = {
    launchAtLogin: preferencesRaw.launchAtLogin === true,
    startHidden: preferencesRaw.startHidden === true,
    autoConnect: preferencesRaw.autoConnect === true,
    closeToTray: preferencesRaw.closeToTray === true,
  }

  const connectorName =
    typeof raw.connectorName === "string" && raw.connectorName.length > 0 && raw.connectorName.length <= 48
      ? raw.connectorName
      : "localMCP-chat"

  return { connectorName, roots, permissions, tunnel, preferences }
}

function grant(permissions: LegacyPermissions): Partial<SidecarOxpGrant> {
  return {
    read: permissions.read,
    write: permissions.write,
    process: permissions.shell,
    git: permissions.git,
    integrations: permissions.plugins,
    browser: false,
    filesReceive: permissions.filesReceive,
    filesSend: permissions.filesSend,
    automation: false,
    sessionSupervision: "none",
    requestSupervision: false,
    delegation: "disabled",
    nestedDelegation: false,
  }
}

async function readBoundedJson(file: string) {
  const info = await fs.stat(file)
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error("localMCP configuration is missing or too large.")
  const text = await fs.readFile(file, "utf8")
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error("localMCP configuration is not valid JSON.")
  }
}

export async function readLocalMcpMigration(file: string): Promise<LocalMcpMigrationPlan> {
  if (path.basename(file).toLowerCase() !== "localmcp-chat.json") {
    throw new Error("Choose localMCP-chat.json.")
  }
  const parsed = parseLegacy(await readBoundedJson(file))
  return {
    sourceFile: path.resolve(file),
    sidecar: {
      roots: parsed.roots.map((root) => ({ path: root.path, alias: root.name })),
      grant: grant(parsed.permissions),
    },
    ...(parsed.tunnel.kind === "openai" && isValidTunnelID(parsed.tunnel.tunnelId)
      ? { tunnelID: parsed.tunnel.tunnelId }
      : {}),
    lifecycle: parsed.preferences,
  }
}

/**
 * Locate the standalone application's non-secret configuration from Electron's
 * appData directory. This intentionally discovers only localmcp-chat.json;
 * standalone credentials remain in its OS-protected secret store and are never
 * copied by migration.
 */
export async function findLocalMcpMigrationFile(appDataDir: string): Promise<string> {
  if (!path.isAbsolute(appDataDir)) throw new Error("Electron app data path must be absolute.")
  const candidates = AUTO_IMPORT_APP_DIRS.map((dir) => path.join(appDataDir, dir, "localmcp-chat.json"))
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const info = await fs.stat(candidate)
      if (info.isFile()) return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
  }
  throw new Error("Could not find localMCP-chat.json automatically. Use Manual import instead.")
}

/**
 * Retire only standalone behavior that can make the old connector come back on
 * its own. The normalized rewrite intentionally contains only the documented
 * legacy schema, so unknown/plaintext secret fields are never recopied.
 */
export async function retireLocalMcpConfig(file: string): Promise<void> {
  const parsed = parseLegacy(await readBoundedJson(file))
  const retired: LegacyConfig = {
    ...parsed,
    preferences: {
      launchAtLogin: false,
      startHidden: false,
      autoConnect: false,
      closeToTray: false,
    },
  }
  const temporary = `${file}.${process.pid}.openfork-retire.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(retired, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  })
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export const __testing = { parseLegacy, grant }
