import { promises as fs } from "node:fs"
import path from "node:path"

export type OxpLifecycle = {
  autoConnect: boolean
  launchAtLogin: boolean
  startHidden: boolean
  closeToTray: boolean
}

export type OxpDesktopConfig = {
  version: 1
  tunnelID: string
  lifecycle: OxpLifecycle
  migration: {
    localMcpConfigPath?: string
    importedAt?: number
    retiredAt?: number
  }
}

const DEFAULT_CONFIG: OxpDesktopConfig = {
  version: 1,
  tunnelID: "",
  lifecycle: {
    autoConnect: false,
    launchAtLogin: false,
    startHidden: false,
    closeToTray: false,
  },
  migration: {},
}

const TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/

function parse(raw: unknown): OxpDesktopConfig {
  const value = raw && typeof raw === "object" ? (raw as Partial<OxpDesktopConfig>) : {}
  const lifecycle: Partial<OxpLifecycle> =
    value.lifecycle && typeof value.lifecycle === "object" ? value.lifecycle : {}
  const tunnelID = typeof value.tunnelID === "string" ? value.tunnelID.trim() : ""
  const migrationRaw =
    value.migration && typeof value.migration === "object"
      ? value.migration as Partial<OxpDesktopConfig["migration"]>
      : {}
  const localMcpConfigPath =
    typeof migrationRaw.localMcpConfigPath === "string" &&
    migrationRaw.localMcpConfigPath.length > 0 &&
    migrationRaw.localMcpConfigPath.length <= 4096 &&
    path.isAbsolute(migrationRaw.localMcpConfigPath)
      ? migrationRaw.localMcpConfigPath
      : undefined
  const importedAt =
    typeof migrationRaw.importedAt === "number" && Number.isSafeInteger(migrationRaw.importedAt) && migrationRaw.importedAt >= 0
      ? migrationRaw.importedAt
      : undefined
  const retiredAt =
    typeof migrationRaw.retiredAt === "number" && Number.isSafeInteger(migrationRaw.retiredAt) && migrationRaw.retiredAt >= 0
      ? migrationRaw.retiredAt
      : undefined
  return {
    version: 1,
    tunnelID: tunnelID && TUNNEL_ID.test(tunnelID) ? tunnelID : "",
    lifecycle: {
      autoConnect: lifecycle.autoConnect === true,
      launchAtLogin: lifecycle.launchAtLogin === true,
      startHidden: lifecycle.startHidden === true,
      closeToTray: lifecycle.closeToTray === true,
    },
    migration: {
      ...(localMcpConfigPath ? { localMcpConfigPath } : {}),
      ...(importedAt !== undefined ? { importedAt } : {}),
      ...(retiredAt !== undefined ? { retiredAt } : {}),
    },
  }
}

export class OxpDesktopConfigStore {
  private readonly file: string
  private current: OxpDesktopConfig = structuredClone(DEFAULT_CONFIG)
  private queue: Promise<void> = Promise.resolve()
  private initialized = false

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, "oxp-desktop.json")
  }

  async initialize() {
    try {
      this.current = parse(JSON.parse(await fs.readFile(this.file, "utf8")))
    } catch {
      this.current = structuredClone(DEFAULT_CONFIG)
    }
    this.initialized = true
    return this.get()
  }

  get(): OxpDesktopConfig {
    return structuredClone(this.current)
  }

  async update(mutator: (draft: OxpDesktopConfig) => void) {
    if (!this.initialized) await this.initialize()
    // Serialize the complete read-modify-write transaction. Computing the draft
    // before entering the queue lets concurrent callers derive from the same
    // stale snapshot and silently lose one another's fields even though the
    // physical writes themselves are serialized.
    const write = this.queue.then(async () => {
      const draft = this.get()
      mutator(draft)
      const next = parse(draft)
      const payload = `${JSON.stringify(next, null, 2)}\n`
      const temp = `${this.file}.${process.pid}.tmp`
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.writeFile(temp, payload, { encoding: "utf8", mode: 0o600 })
      await fs.rename(temp, this.file)
      this.current = next
      return this.get()
    })
    this.queue = write.then(() => undefined, () => undefined)
    return write
  }

  async setTunnelID(value: string) {
    const tunnelID = value.trim()
    if (tunnelID && !TUNNEL_ID.test(tunnelID)) {
      throw new Error("Tunnel ID must use the tunnel_<32 lowercase hex> format.")
    }
    return this.update((draft) => {
      draft.tunnelID = tunnelID
    })
  }

  async setLifecycle(patch: Partial<OxpLifecycle>) {
    return this.update((draft) => {
      draft.lifecycle = { ...draft.lifecycle, ...patch }
    })
  }

  async applyLegacyMigration(input: {
    sourceFile: string
    tunnelID?: string
    lifecycle: OxpLifecycle
    importedAt: number
  }) {
    if (!path.isAbsolute(input.sourceFile)) throw new Error("Legacy migration source must be absolute.")
    if (input.tunnelID && !TUNNEL_ID.test(input.tunnelID)) throw new Error("Legacy migration tunnel ID is invalid.")
    return this.update((draft) => {
      if (input.tunnelID) draft.tunnelID = input.tunnelID
      draft.lifecycle = { ...input.lifecycle }
      draft.migration = {
        localMcpConfigPath: input.sourceFile,
        importedAt: input.importedAt,
      }
    })
  }

  async markLegacyRetired(retiredAt: number) {
    if (!Number.isSafeInteger(retiredAt) || retiredAt < 0) throw new Error("Invalid legacy retirement timestamp.")
    return this.update((draft) => {
      if (!draft.migration.localMcpConfigPath || draft.migration.importedAt === undefined) {
        throw new Error("No imported localMCP configuration is available to retire.")
      }
      draft.migration.retiredAt = retiredAt
    })
  }
}

export const isValidTunnelID = (value: string) => TUNNEL_ID.test(value)
