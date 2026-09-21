import { promises as fs } from "node:fs"
import path from "node:path"
import { app, shell } from "electron"
import { write as writeLog } from "../logging"
import type { OxpSidecarClient } from "../server"
import type { SidecarOxpGrant, SidecarOxpState } from "../sidecar-protocol"
import { OxpDesktopConfigStore, type OxpLifecycle, isValidTunnelID } from "./config"
import { EMPTY_GRANT, EMPTY_METRICS, type OxpDesktopState, type OxpStateListener } from "./contracts"
import { OxpCredentials, type SecureStorageStatus } from "./credentials"
import { OxpEndpointGenerationTracker } from "./generation"
import { OxpLifecycleOwner } from "./lifecycle"
import { findLocalMcpMigrationFile, readLocalMcpMigration, retireLocalMcpConfig } from "./migration"
import { normalizeProjectRootsForHost } from "./project-roots"
import { startOpenAiTunnel, type OxpTunnelReport, type TunnelHandle } from "./tunnel"

const DEFAULT_CONNECTOR = Object.freeze({ id: "unavailable", label: "OpenFork OXP" })

function normalizeGrantPatch(current: SidecarOxpGrant, patch: Partial<SidecarOxpGrant>) {
  const next = { ...current, ...patch }
  if (next.sessionSupervision === "none") next.requestSupervision = false
  if (next.delegation === "disabled") next.nestedDelegation = false
  return next
}

function activeTunnel(state: OxpTunnelReport["state"]) {
  return state === "starting" || state === "connected" || state === "offline"
}

function sameProjection(a: OxpDesktopState | undefined, b: OxpDesktopState) {
  if (!a) return false
  const { stateRevision: _aRevision, ...left } = a
  const { stateRevision: _bRevision, ...right } = b
  return JSON.stringify(left) === JSON.stringify(right)
}

export class OxpController {
  private readonly config: OxpDesktopConfigStore
  private readonly credentials: OxpCredentials
  private readonly lifecycle = new OxpLifecycleOwner()
  private readonly listeners = new Set<OxpStateListener>()
  private initialized: Promise<void> | undefined
  private secureStorage: SecureStorageStatus = { available: false, detail: "Secure storage has not been checked yet." }
  private sidecar: OxpSidecarClient | undefined
  private sidecarState: SidecarOxpState | undefined
  private sidecarSubscription: (() => void) | undefined
  private sidecarClosedSubscription: (() => void) | undefined
  private sidecarEpoch = 0
  private readonly endpointGeneration = new OxpEndpointGenerationTracker()
  private tunnel: TunnelHandle | undefined
  private tunnelReport: OxpTunnelReport = { state: "disconnected", detail: "Disconnected." }
  private connectionGeneration = 0
  private operation: Promise<void> = Promise.resolve()
  private projectionGeneration = 0
  private lastProjection: OxpDesktopState | undefined
  /** Latest renderer-owned local project catalog. Replayed when the sidecar attaches. */
  private desiredProjectRoots: string[] | undefined
  private shuttingDown = false
  private shutdownInFlight: Promise<void> | undefined

  constructor(
    private readonly userDataPath: string,
    credentials?: OxpCredentials,
  ) {
    this.config = new OxpDesktopConfigStore(userDataPath)
    this.credentials = credentials ?? new OxpCredentials(userDataPath)
  }

  initialize() {
    return (this.initialized ??= this.initializeOnce())
  }

  private async initializeOnce() {
    // Startup pays only for the tiny non-secret lifecycle config. OS keyring
    // initialization is deferred until Settings/connect/credential use so an
    // unused, disabled OXP installation stays off the normal desktop hot path.
    const desktopConfig = await this.config.initialize()
    this.lifecycle.prepareInitialWindowVisibility(desktopConfig.lifecycle)
    await this.lifecycle.apply(desktopConfig.lifecycle).catch((error) => {
      writeLog("oxp", "desktop lifecycle policy could not be fully applied", { error: String(error) }, "warn")
    })
    await this.refreshProjection()
  }

  subscribe(listener: OxpStateListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async getState() {
    await this.initialize()
    this.secureStorage = await this.credentials.status()
    return this.refreshProjection()
  }

  private async projectState(stateRevision: number): Promise<OxpDesktopState> {
    const desktop = this.config.get()
    const sidecar = this.sidecarState
    const apiKeyPresent = this.secureStorage.available ? await this.credentials.hasOpenAiApiKey().catch(() => false) : false
    const importedAt = desktop.migration.importedAt
    const retiredAt = desktop.migration.retiredAt
    const migrationVerified =
      importedAt !== undefined &&
      retiredAt === undefined &&
      sidecar?.enabled === true &&
      sidecar.endpoint.state === "ready" &&
      this.endpointGeneration.current() > 0 &&
      this.tunnelReport.state === "connected" &&
      this.tunnelReport.handshakeAt !== undefined
    return {
      version: 1,
      stateRevision,
      enabled: sidecar?.enabled ?? false,
      connector: sidecar?.connector ?? DEFAULT_CONNECTOR,
      configRevision: sidecar?.configRevision ?? 0,
      roots: sidecar?.roots.map((root) => ({ ...root })) ?? [],
      grant: { ...(sidecar?.grant ?? EMPTY_GRANT) },
      endpoint: sidecar
        ? {
            state: sidecar.endpoint.state,
            ...(sidecar.endpoint.state === "ready" && this.endpointGeneration.current() > 0
              ? { generation: this.endpointGeneration.current() }
              : {}),
            ...(sidecar.endpoint.schemaFingerprint ? { schemaFingerprint: sidecar.endpoint.schemaFingerprint } : {}),
          }
        : { state: "stopped" },
      tunnel: {
        state: this.tunnelReport.state,
        tunnelID: desktop.tunnelID,
        ...(this.tunnelReport.handshakeAt ? { lastHandshakeAt: this.tunnelReport.handshakeAt } : {}),
        ...(this.tunnelReport.detail ? { detail: this.tunnelReport.detail } : {}),
      },
      openai: { apiKeyPresent },
      secureStorage: { ...this.secureStorage, credentialState: this.credentials.credentialState() },
      lifecycle: { ...desktop.lifecycle },
      migration: {
        imported: importedAt !== undefined,
        retired: retiredAt !== undefined,
        canRetire: migrationVerified,
        ...(importedAt !== undefined ? { importedAt } : {}),
        ...(retiredAt !== undefined ? { retiredAt } : {}),
      },
      metrics: { ...(sidecar?.metrics ?? EMPTY_METRICS) },
    }
  }

  private async refreshProjection() {
    const generation = ++this.projectionGeneration
    const next = await this.projectState(generation)
    if (generation !== this.projectionGeneration) return next
    const same = sameProjection(this.lastProjection, next)
    this.lastProjection = next
    if (!same) {
      for (const listener of this.listeners) {
        try {
          listener(next)
        } catch {}
      }
    }
    return next
  }

  async attachSidecar(sidecar: OxpSidecarClient) {
    await this.initialize()
    return this.enqueue(() => this.attachSidecarNow(sidecar))
  }

  private async attachSidecarNow(sidecar: OxpSidecarClient) {
    const epoch = ++this.sidecarEpoch
    this.sidecarSubscription?.()
    this.sidecarClosedSubscription?.()
    this.sidecar = sidecar
    this.sidecarState = undefined
    this.endpointGeneration.attach(epoch)
    this.connectionGeneration += 1
    let retirementBlocked = false
    try {
      await this.stopTunnelOnly()
    } catch {
      // The replacement sidecar still becomes the authoritative local runtime,
      // but an unproven old tunnel tree remains owned and blocks all future
      // Connect attempts through stopTunnelOnly(). Do not abandon sidecar state
      // subscriptions merely because transport retirement failed.
      retirementBlocked = true
    }
    this.tunnelReport = retirementBlocked
      ? { state: "unavailable", detail: "The previous tunnel process could not be stopped safely." }
      : { state: "disconnected", detail: "Local OpenFork runtime changed. Reconnect when ready." }
    this.sidecarSubscription = sidecar.subscribe((state) => {
      if (this.shuttingDown) return
      if (this.sidecarEpoch !== epoch || this.sidecar !== sidecar) return
      const observed = this.observeSidecarState(sidecar, state)
      if (!observed.accepted) return
      if (observed.endpointChanged && activeTunnel(this.tunnelReport.state)) {
        // A tunnel is bound to one exact secret local URL. Invalidate callbacks
        // immediately even if Connect is still starting and has not installed
        // its handle yet. Then serialize retirement/reconnection so an old
        // route can never become authoritative or coexist with a new tree.
        this.connectionGeneration += 1
        this.tunnelReport = { state: "starting", detail: "Local OXP endpoint changed; reconnecting…" }
        void this.refreshProjection()
        void this.enqueue(async () => {
          if (this.sidecarEpoch !== epoch || this.sidecar !== sidecar) return
          try {
            await this.stopTunnelOnly()
          } catch {
            this.tunnelReport = { state: "unavailable", detail: "The previous tunnel process could not be stopped safely." }
            await this.refreshProjection()
            return
          }
          if (this.sidecarEpoch !== epoch || this.sidecar !== sidecar || !this.sidecarState?.enabled) {
            this.tunnelReport = { state: "disconnected", detail: "Disconnected." }
            await this.refreshProjection()
            return
          }
          await this.connectNow().catch(async () => {
            this.tunnelReport = { state: "unavailable", detail: "Unable to reconnect to the refreshed local OXP endpoint." }
            await this.refreshProjection()
          })
        })
        return
      }
      void this.refreshProjection()
    })
    this.sidecarClosedSubscription = sidecar.onClosed(() => {
      if (this.shuttingDown) return
      if (this.sidecarEpoch !== epoch || this.sidecar !== sidecar) return
      this.sidecar = undefined
      this.sidecarState = undefined
      this.endpointGeneration.detach()
      this.sidecarSubscription?.()
      this.sidecarSubscription = undefined
      this.sidecarClosedSubscription = undefined
      this.connectionGeneration += 1
      this.tunnelReport = { state: "unavailable", detail: "The local OpenFork runtime stopped." }
      void this.stopTunnelOnly()
        .catch((error) => {
          writeLog("oxp", "could not prove the tunnel tree stopped after sidecar exit", undefined, "error")
          this.tunnelReport = { state: "unavailable", detail: "The previous tunnel process could not be stopped safely." }
          return error
        })
        .finally(() => this.refreshProjection())
    })
    try {
      const state = await sidecar.request({ action: "get-state" })
      if (this.sidecarEpoch !== epoch || this.sidecar !== sidecar) return
      const accepted = this.acceptSidecarState(sidecar, state)
      this.secureStorage = await this.credentials.status()
      // Electron main is the sole durable credential owner. Every sidecar
      // attachment receives the same OXP OpenAI key (or an explicit clear), so
      // Files and future OXP-owned OpenAI APIs cannot drift from tunnel auth.
      const openAiCredential = this.secureStorage.available
        ? await this.credentials.getOpenAiApiKey().catch(() => null)
        : null
      const syncedCredential = await sidecar.request({
        action: "set-openai-api-key",
        ...(openAiCredential ? { value: openAiCredential } : {}),
      })
      if (this.sidecarEpoch !== epoch || this.sidecar !== sidecar) return
      this.acceptSidecarState(sidecar, syncedCredential)
      if (this.desiredProjectRoots) {
        const synced = await sidecar.request({ action: "sync-project-roots", paths: this.desiredProjectRoots })
        if (this.sidecarEpoch !== epoch || this.sidecar !== sidecar) return
        this.acceptSidecarState(sidecar, synced)
      }
      await this.refreshProjection()
      if (!retirementBlocked && accepted.enabled && this.config.get().lifecycle.autoConnect) {
        void this.connect().catch(() => undefined)
      }
    } catch {
      if (this.sidecarEpoch !== epoch || this.sidecar !== sidecar) return
      writeLog("oxp", "could not read OXP state from sidecar", undefined, "warn")
      await this.refreshProjection()
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error("OpenAI Exchange is shutting down."))
    const run = this.operation.then(operation, operation)
    this.operation = run.then(() => undefined, () => undefined)
    return run
  }

  private requireSidecar() {
    if (!this.sidecar) throw new Error("The local OpenFork sidecar is not ready yet.")
    return this.sidecar
  }

  private observeSidecarState(sidecar: OxpSidecarClient, state: SidecarOxpState) {
    if (this.sidecar !== sidecar) throw new Error("The OpenFork sidecar changed while the operation was running.")
    const observed = this.endpointGeneration.observe(this.sidecarEpoch, state.endpoint, state.configRevision)
    if (!observed.accepted) {
      return { accepted: false as const, endpointChanged: false, state: this.sidecarState ?? state }
    }
    this.sidecarState = state
    return { accepted: true as const, endpointChanged: observed.changed, state }
  }

  private acceptSidecarState(sidecar: OxpSidecarClient, state: SidecarOxpState) {
    return this.observeSidecarState(sidecar, state).state
  }

  async setEnabled(enabled: boolean) {
    await this.initialize()
    return this.enqueue(async () => {
      const sidecar = this.requireSidecar()
      if (!enabled) {
        // Revoke admission first. Existing tunnel/process teardown happens only
        // after the sidecar has committed the new config revision.
        this.acceptSidecarState(sidecar, await sidecar.request({ action: "set-enabled", enabled: false }))
        this.connectionGeneration += 1
        let tunnelError: unknown
        try {
          await this.stopTunnelOnly()
        } catch (error) {
          tunnelError = error
        }
        // The local listener must still retire after authority has been revoked,
        // even if the old remote process tree could not be proven dead.
        this.acceptSidecarState(sidecar, await sidecar.request({ action: "stop" }))
        this.tunnelReport = tunnelError
          ? { state: "unavailable", detail: "OXP is disabled, but the previous tunnel process could not be stopped safely." }
          : { state: "disconnected", detail: "OXP is disabled." }
        const state = await this.refreshProjection()
        if (tunnelError) throw tunnelError
        return state
      }
      this.acceptSidecarState(sidecar, await sidecar.request({ action: "set-enabled", enabled: true }))
      const state = await this.refreshProjection()
      if (this.config.get().lifecycle.autoConnect) void this.connect().catch(() => undefined)
      return state
    })
  }

  async setGrant(patch: Partial<SidecarOxpGrant>) {
    await this.initialize()
    return this.enqueue(async () => {
      const sidecar = this.requireSidecar()
      const current = this.sidecarState?.grant ?? EMPTY_GRANT
      const normalized = normalizeGrantPatch(current, patch)
      const delta = Object.fromEntries(
        Object.entries(normalized).filter(([key, value]) => current[key as keyof SidecarOxpGrant] !== value),
      ) as Partial<SidecarOxpGrant>
      if (Object.keys(delta).length) {
        this.acceptSidecarState(sidecar, await sidecar.request({ action: "set-grant", patch: delta }))
      }
      return this.refreshProjection()
    })
  }


  async addRoot(candidate: string) {
    await this.initialize()
    return this.enqueue(async () => {
      const sidecar = this.requireSidecar()
      this.acceptSidecarState(sidecar, await sidecar.request({ action: "approve-root", path: candidate }))
      return this.refreshProjection()
    })
  }

  async syncProjectRoots(candidates: readonly string[]) {
    await this.initialize()
    // Store desired state before entering the serialized sidecar lane. If the
    // renderer publishes while the sidecar is restarting, attachSidecarNow()
    // replays this exact catalog as soon as the replacement runtime is ready.
    const normalized = normalizeProjectRootsForHost(candidates)
    this.desiredProjectRoots = normalized.roots
    if (normalized.rejected > 0) {
      writeLog(
        "oxp",
        "ignored project roots outside the desktop filesystem namespace",
        { count: normalized.rejected, platform: process.platform },
        "warn",
      )
    }
    return this.enqueue(async () => {
      const sidecar = this.sidecar
      if (!sidecar) return this.refreshProjection()
      const desired = this.desiredProjectRoots ?? []
      this.acceptSidecarState(sidecar, await sidecar.request({ action: "sync-project-roots", paths: desired }))
      return this.refreshProjection()
    })
  }

  async renameRoot(rootID: string, alias: string) {
    await this.initialize()
    return this.enqueue(async () => {
      const sidecar = this.requireSidecar()
      this.acceptSidecarState(sidecar, await sidecar.request({ action: "rename-root", rootID, alias }))
      return this.refreshProjection()
    })
  }

  async removeRoot(rootID: string) {
    await this.initialize()
    return this.enqueue(async () => {
      const sidecar = this.requireSidecar()
      this.acceptSidecarState(sidecar, await sidecar.request({ action: "remove-root", rootID }))
      return this.refreshProjection()
    })
  }

  async revealRoot(rootID: string) {
    await this.initialize()
    const root = this.sidecarState?.roots.find((candidate) => candidate.id === rootID)
    if (!root) return false
    shell.showItemInFolder(root.path)
    return true
  }

  async setTunnelID(value: string) {
    await this.initialize()
    return this.enqueue(async () => {
      const reconnect = activeTunnel(this.tunnelReport.state)
      if (reconnect) {
        this.connectionGeneration += 1
        await this.stopTunnelOnly()
      }
      try {
        await this.config.setTunnelID(value)
      } catch (error) {
        if (reconnect) {
          // The old ID is still durable because config publication is atomic.
          // Restore the prior desired connection rather than leaving a dead
          // process projected as connected after a settings write failure.
          await this.connectNow().catch(async () => {
            this.tunnelReport = { state: "unavailable", detail: "Tunnel settings were not saved and the previous connection could not be restored." }
            await this.refreshProjection()
          })
        }
        throw error
      }
      await this.refreshProjection()
      if (reconnect) await this.connectNow()
      return this.refreshProjection()
    })
  }

  async setOpenAiApiKey(value: string) {
    await this.initialize()
    return this.enqueue(async () => {
      const previous = await this.credentials.getOpenAiApiKey()
      const reconnect = activeTunnel(this.tunnelReport.state)
      if (reconnect) {
        this.connectionGeneration += 1
        await this.stopTunnelOnly()
      }
      try {
        await this.credentials.setOpenAiApiKey(value)
        const sidecar = this.sidecar
        if (sidecar) {
          this.acceptSidecarState(
            sidecar,
            await sidecar.request({ action: "set-openai-api-key", value: value.trim() }),
          )
        }
      } catch (error) {
        // Credential persistence and the sidecar's in-memory projection form a
        // small cross-process transaction. Compensate back to the previously
        // authoritative value if the second leg fails.
        await this.credentials.setOpenAiApiKey(previous ?? "").catch(() => undefined)
        const sidecar = this.sidecar
        if (sidecar) {
          await sidecar.request({
            action: "set-openai-api-key",
            ...(previous ? { value: previous } : {}),
          }).then((state) => this.acceptSidecarState(sidecar, state)).catch(() => undefined)
        }
        if (reconnect) {
          await this.connectNow().catch(async () => {
            this.tunnelReport = { state: "unavailable", detail: "OXP OpenAI credential could not be changed and the previous connection could not be restored." }
            await this.refreshProjection()
          })
        }
        await this.refreshProjection().catch(() => undefined)
        throw error
      }
      this.secureStorage = await this.credentials.status()
      await this.refreshProjection()
      if (reconnect) await this.connectNow()
      return this.refreshProjection()
    })
  }

  async clearOpenAiApiKey() {
    await this.initialize()
    return this.enqueue(async () => {
      this.connectionGeneration += 1
      let tunnelError: unknown
      try {
        await this.stopTunnelOnly()
      } catch (error) {
        tunnelError = error
      }
      // Credential deletion is its own security operation. Do not let a stuck
      // child process prevent removal of the durable secret from safeStorage.
      await this.credentials.clearOpenAiApiKey()
      let sidecarError: unknown
      const sidecar = this.sidecar
      if (sidecar) {
        try {
          this.acceptSidecarState(sidecar, await sidecar.request({ action: "set-openai-api-key" }))
        } catch (error) {
          // The durable secret is already gone. Surface inability to prove the
          // live sidecar forgot its in-memory projection instead of pretending
          // credential revocation fully succeeded.
          sidecarError = error
        }
      }
      this.secureStorage = await this.credentials.status()
      this.tunnelReport = tunnelError || sidecarError
        ? { state: "unavailable", detail: "OXP OpenAI credential removed from secure storage, but complete live-process revocation could not be proven." }
        : { state: "disconnected", detail: "OXP OpenAI credential removed." }
      const state = await this.refreshProjection()
      if (sidecarError) throw sidecarError
      if (tunnelError) throw tunnelError
      return state
    })
  }

  async resetUnreadableCredentialStore() {
    await this.initialize()
    return this.enqueue(async () => {
      // Force one authoritative read so stale renderer state cannot trigger a
      // destructive reset after the store has become readable again.
      await this.credentials.getOpenAiApiKey().catch(() => null)
      if (this.credentials.credentialState() !== "unreadable") return this.refreshProjection()

      this.connectionGeneration += 1
      let tunnelError: unknown
      try {
        await this.stopTunnelOnly()
      } catch (error) {
        tunnelError = error
      }

      const reset = await this.credentials.resetUnreadable()
      if (!reset) return this.refreshProjection()

      let sidecarError: unknown
      const sidecar = this.sidecar
      if (sidecar) {
        try {
          this.acceptSidecarState(sidecar, await sidecar.request({ action: "set-openai-api-key" }))
        } catch (error) {
          sidecarError = error
        }
      }

      this.secureStorage = await this.credentials.status()
      this.tunnelReport = tunnelError || sidecarError
        ? { state: "unavailable", detail: "Unreadable OXP credential state was reset, but complete live-process revocation could not be proven." }
        : { state: "disconnected", detail: "Unreadable OXP credential state reset." }
      const state = await this.refreshProjection()
      if (sidecarError) throw sidecarError
      if (tunnelError) throw tunnelError
      return state
    })
  }

  async setLifecycle(patch: Partial<OxpLifecycle>) {
    await this.initialize()
    return this.enqueue(async () => {
      const before = this.config.get().lifecycle
      const next = { ...before, ...patch }
      await this.lifecycle.apply(next)
      try {
        await this.config.setLifecycle(patch)
      } catch (error) {
        await this.lifecycle.apply(before).catch(() => undefined)
        throw error
      }
      const state = await this.refreshProjection()
      if (patch.autoConnect === true && this.sidecarState?.enabled && !activeTunnel(this.tunnelReport.state)) {
        void this.connect().catch(() => undefined)
      }
      return state
    })
  }

  async importLocalMcpConfig(file: string) {
    await this.initialize()
    const plan = await readLocalMcpMigration(file)
    return this.enqueue(async () => {
      const sidecar = this.requireSidecar()
      const previousLifecycle = this.config.get().lifecycle
      const lifecycle = {
        ...plan.lifecycle,
        // A checkout must never register itself as the machine's login app.
        // The installed build preserves the standalone user's preference.
        launchAtLogin: app.isPackaged && plan.lifecycle.launchAtLogin,
      }
      this.acceptSidecarState(
        sidecar,
        await sidecar.request({ action: "import-legacy-config", plan: plan.sidecar }),
      )
      await this.lifecycle.apply(lifecycle)
      try {
        await this.config.applyLegacyMigration({
          sourceFile: plan.sourceFile,
          ...(plan.tunnelID ? { tunnelID: plan.tunnelID } : {}),
          lifecycle,
          importedAt: Date.now(),
        })
      } catch (error) {
        await this.lifecycle.apply(previousLifecycle).catch(() => undefined)
        throw error
      }
      // Credentials deliberately do not migrate. In particular, importing
      // autoConnect does not synthesize a tunnel credential or trigger a
      // connection attempt as a side effect of reading the legacy config.
      return this.refreshProjection()
    })
  }

  async autoImportLocalMcpConfig() {
    const file = await findLocalMcpMigrationFile(app.getPath("appData"))
    return this.importLocalMcpConfig(file)
  }

  async retireLocalMcpConnector() {
    await this.initialize()
    return this.enqueue(async () => {
      const current = await this.refreshProjection()
      if (!current.migration.canRetire) {
        throw new Error("Verify a live OXP tunnel connection before disabling the standalone localMCP connector.")
      }
      const sourceFile = this.config.get().migration.localMcpConfigPath
      if (!sourceFile) throw new Error("No imported localMCP configuration is available to retire.")
      await retireLocalMcpConfig(sourceFile)
      await this.config.markLegacyRetired(Date.now())
      return this.refreshProjection()
    })
  }

  connect() {
    return this.initialize().then(() => this.enqueue(() => this.connectNow()))
  }

  private async connectNow() {
    // Connect is idempotent at the desktop owner. Repeated renderer actions or
    // auto-connect convergence must never churn a healthy tunnel tree merely
    // because the same desired state was requested twice.
    if (this.tunnel && activeTunnel(this.tunnelReport.state)) return this.refreshProjection()
    const sidecar = this.requireSidecar()
    const current = this.sidecarState ?? this.acceptSidecarState(sidecar, await sidecar.request({ action: "get-state" }))
    if (!current.enabled) throw new Error("Enable OXP before connecting the Secure MCP Tunnel.")
    const desktop = this.config.get()
    if (!isValidTunnelID(desktop.tunnelID)) throw new Error("Save a valid OpenAI Secure MCP Tunnel ID first.")
    const apiKey = await this.credentials.getOpenAiApiKey()
    if (!apiKey) throw new Error("Save an OXP OpenAI API key first.")

    const generation = ++this.connectionGeneration
    await this.stopTunnelOnly()
    this.tunnelReport = { state: "starting", detail: "Starting local OXP endpoint…" }
    await this.refreshProjection()
    const started = this.acceptSidecarState(sidecar, await sidecar.request({ action: "start" }))
    const endpointUrl = started.endpoint.url
    if (started.endpoint.state !== "ready" || !endpointUrl) throw new Error("The sidecar did not provide a ready OXP endpoint.")
    const endpointGeneration = this.endpointGeneration.current()
    let handle: TunnelHandle
    try {
      handle = await startOpenAiTunnel({
        localUrl: endpointUrl,
        tunnelID: desktop.tunnelID,
        apiKey,
        label: started.connector.label,
        report: (report) => {
          if (
            generation !== this.connectionGeneration ||
            this.sidecar !== sidecar ||
            endpointGeneration !== this.endpointGeneration.current()
          ) return
          this.tunnelReport = report
          void this.refreshProjection()
        },
      })
    } catch (error) {
      if (generation === this.connectionGeneration && this.sidecar === sidecar) {
        this.tunnelReport = { state: "unavailable", detail: "Unable to start the OpenAI Secure MCP Tunnel." }
        await this.refreshProjection()
      }
      throw error
    }
    if (
      generation !== this.connectionGeneration ||
      this.sidecar !== sidecar ||
      endpointGeneration !== this.endpointGeneration.current()
    ) {
      try {
        await handle.stop()
      } catch (error) {
        // Keep ownership of an unproven stale tree. A later Connect must hit
        // stopTunnelOnly() and fail closed rather than starting in parallel.
        if (!this.tunnel) this.tunnel = handle
        this.tunnelReport = { state: "unavailable", detail: "A stale tunnel process could not be stopped safely." }
        await this.refreshProjection()
        throw error
      }
      return this.refreshProjection()
    }
    this.tunnel = handle
    return this.refreshProjection()
  }

  disconnect() {
    return this.initialize().then(() =>
      this.enqueue(async () => {
        this.connectionGeneration += 1
        try {
          await this.stopTunnelOnly()
        } catch (error) {
          this.tunnelReport = { state: "unavailable", detail: "The previous tunnel process could not be stopped safely." }
          await this.refreshProjection()
          throw error
        }
        // Disconnect is transport-only. An enabled connector deliberately keeps
        // its secret loopback endpoint ready; only Disable or application
        // shutdown retires local OXP authority.
        this.tunnelReport = { state: "disconnected", detail: "Disconnected." }
        return this.refreshProjection()
      }),
    )
  }

  private async stopTunnelOnly() {
    const tunnel = this.tunnel
    if (!tunnel) return
    await tunnel.stop()
    if (this.tunnel === tunnel) this.tunnel = undefined
  }

  async exportDiagnostics() {
    await this.initialize()
    const state = await this.getState()
    const directory = path.join(this.userDataPath, "diagnostics")
    await fs.mkdir(directory, { recursive: true })
    const file = path.join(directory, `openfork-oxp-${new Date().toISOString().replaceAll(":", "-")}.json`)
    // Diagnostics are deliberately less privileged than the live Settings
    // projection. Preserve useful topology/counters while removing native root
    // paths and the account-scoped tunnel identifier. Secret endpoint URLs and
    // API-key material never enter OxpDesktopState in the first place.
    const payload = {
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      state: {
        ...state,
        roots: state.roots.map(({ path: _path, ...root }) => root),
        tunnel: { ...state.tunnel, tunnelID: state.tunnel.tunnelID ? "[configured]" : "" },
      },
    }
    await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    shell.showItemInFolder(file)
    return true
  }

  async shutdown() {
    return (this.shutdownInFlight ??= this.shutdownNow())
  }

  private async shutdownNow() {
    this.shuttingDown = true
    this.connectionGeneration += 1
    // Drain the operation owner after closing admission. Existing work may
    // finish, but nothing queued after the shutdown fence can create a fresh
    // endpoint/tunnel behind teardown.
    await this.operation.catch(() => undefined)
    this.connectionGeneration += 1
    const sidecar = this.sidecar
    // Stop remote reachability first, then the secret local endpoint. The
    // ordinary OpenFork sidecar process is terminated by the outer desktop
    // owner only after this method resolves.
    let tunnelError: unknown
    try {
      await this.stopTunnelOnly()
    } catch (error) {
      tunnelError = error
      writeLog("oxp", "could not prove tunnel process-tree termination during shutdown", undefined, "error")
    }
    if (sidecar) await sidecar.request({ action: "stop" }).catch(() => undefined)
    this.sidecarSubscription?.()
    this.sidecarClosedSubscription?.()
    this.sidecarSubscription = undefined
    this.sidecarClosedSubscription = undefined
    this.sidecar = undefined
    this.sidecarState = undefined
    this.endpointGeneration.detach()
    this.lifecycle.dispose()
    if (tunnelError) throw tunnelError
  }
}
