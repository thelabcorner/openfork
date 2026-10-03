export type OxpConnectionState =
  | "disconnected"
  | "starting"
  | "connected"
  | "offline"
  | "auth-failed"
  | "unavailable"

export type OxpEndpointState = "stopped" | "starting" | "ready" | "error"

export type OxpGrant = {
  read: boolean
  write: boolean
  process: boolean
  git: boolean
  integrations: boolean
  browser: boolean
  filesReceive: boolean
  filesSend: boolean
  automation: boolean
  sessionSupervision: "none" | "approved-roots"
  requestSupervision: boolean
  delegation: "disabled" | "spawn"
  nestedDelegation: boolean
}

export type OxpModelSelection = {
  providerID: string
  modelID: string
  accountID?: string
  variant?: string
}

export type OxpWorkerPolicy = {
  /** Compatibility-only remnants of the retired OXP selection allowlist. */
  models: OxpModelSelection[]
  /** Compatibility-only remnants of the retired OXP selection allowlist. */
  agents: string[]
  defaultModel?: OxpModelSelection
  defaultAgent?: string
  agentRoots?: Array<{
    rootID: string
    agents: string[]
    defaultAgent?: string
  }>
}

export type OxpAgentCatalog = {
  rootID: string
  rootAlias: string
  agents: Array<{
    id: string
    description?: string
    mode: "subagent" | "primary" | "all"
  }>
  nativeDefaultAgent: string
}


export type OxpLifecycle = {
  autoConnect: boolean
  launchAtLogin: boolean
  startHidden: boolean
  closeToTray: boolean
}

export type OxpDesktopState = {
  version: 1
  stateRevision: number
  enabled: boolean
  connector: { id: string; label: string }
  configRevision: number
  roots: Array<{
    id: string
    alias: string
    path: string
    available: boolean
    managedByProject: boolean
  }>
  grant: OxpGrant
  workerPolicy: OxpWorkerPolicy
  endpoint: {
    state: OxpEndpointState
    generation?: number
    schemaFingerprint?: string
  }
  tunnel: {
    state: OxpConnectionState
    tunnelID: string
    lastHandshakeAt?: number
    detail?: string
  }
  openai: {
    apiKeyPresent: boolean
  }
  secureStorage: {
    available: boolean
    credentialState: "ready" | "unreadable"
    detail?: string
  }
  lifecycle: OxpLifecycle
  migration: {
    imported: boolean
    retired: boolean
    canRetire: boolean
    importedAt?: number
    retiredAt?: number
  }
  metrics: {
    lastRequestAt?: number
    lastOperationAt?: number
    calls: number
    failures: number
    augmentationCalls: number
    supervisionCalls: number
    delegationCalls: number
    parentEpochs: number
    parentEpochReminders: number
    unattributedParentCalls: number
    trackedParents: number
  }
}

export interface OxpPlatform {
  getState(): Promise<OxpDesktopState>
  subscribe(cb: (state: OxpDesktopState) => void): Promise<() => void> | (() => void)
  setEnabled(enabled: boolean): Promise<OxpDesktopState>
  setGrant(patch: Partial<OxpGrant>): Promise<OxpDesktopState>
  setWorkerDefaultModel(model?: OxpModelSelection): Promise<OxpDesktopState>
  listWorkerAgents(rootID: string): Promise<OxpAgentCatalog>
  setWorkerDefaultAgent(rootID: string, agent?: string): Promise<OxpDesktopState>
  addRoot(): Promise<OxpDesktopState>
  syncProjectRoots(paths: string[]): Promise<OxpDesktopState>
  renameRoot(rootID: string, alias: string): Promise<OxpDesktopState>
  removeRoot(rootID: string): Promise<OxpDesktopState>
  revealRoot(rootID: string): Promise<boolean>
  setTunnelID(value: string): Promise<OxpDesktopState>
  setOpenAiApiKey(value: string): Promise<OxpDesktopState>
  clearOpenAiApiKey(): Promise<OxpDesktopState>
  resetUnreadableCredentialStore(): Promise<OxpDesktopState>
  setLifecycle(patch: Partial<OxpLifecycle>): Promise<OxpDesktopState>
  importLocalMcp(): Promise<OxpDesktopState>
  autoImportLocalMcp(): Promise<OxpDesktopState>
  retireLocalMcp(): Promise<OxpDesktopState>
  connect(): Promise<OxpDesktopState>
  disconnect(): Promise<OxpDesktopState>
  exportDiagnostics?(): Promise<boolean>
}

const requiredOxpPlatformMethods = [
  "getState",
  "subscribe",
  "setEnabled",
  "setGrant",
  "setWorkerDefaultModel",
  "listWorkerAgents",
  "setWorkerDefaultAgent",
  "addRoot",
  "syncProjectRoots",
  "renameRoot",
  "removeRoot",
  "revealRoot",
  "setTunnelID",
  "setOpenAiApiKey",
  "clearOpenAiApiKey",
  "resetUnreadableCredentialStore",
  "setLifecycle",
  "importLocalMcp",
  "autoImportLocalMcp",
  "retireLocalMcp",
  "connect",
  "disconnect",
] as const satisfies readonly (keyof OxpPlatform)[]

/**
 * Runtime boundary guard for the Electron preload bridge.
 *
 * Renderer HMR can advance independently of the already-loaded preload script,
 * so TypeScript's static ElectronAPI shape is not sufficient during development.
 * Fail closed when the bridge is from an older generation instead of exposing a
 * partial OxpPlatform that will crash at the first newly-added method call.
 */
export function isOxpPlatform(value: unknown): value is OxpPlatform {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return requiredOxpPlatformMethods.every((method) => typeof candidate[method] === "function")
}
