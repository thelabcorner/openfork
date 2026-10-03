import type { SidecarOxpGrant, SidecarOxpWorkerPolicy } from "../sidecar-protocol"
import type { OxpLifecycle } from "./config"

export type OxpConnectionState =
  | "disconnected"
  | "starting"
  | "connected"
  | "offline"
  | "auth-failed"
  | "unavailable"

export type OxpDesktopState = {
  version: 1
  /** Monotonic Electron-main projection revision used to reject stale async UI responses. */
  stateRevision: number
  enabled: boolean
  connector: { id: string; label: string }
  configRevision: number
  roots: Array<{ id: string; alias: string; path: string; available: boolean; managedByProject: boolean }>
  grant: SidecarOxpGrant
  workerPolicy: SidecarOxpWorkerPolicy
  endpoint: {
    state: "stopped" | "starting" | "ready" | "error"
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

export type OxpStateListener = (state: OxpDesktopState) => void

export const EMPTY_GRANT: SidecarOxpGrant = Object.freeze({
  read: false,
  write: false,
  process: false,
  git: false,
  integrations: false,
  browser: false,
  filesReceive: false,
  filesSend: false,
  automation: false,
  sessionSupervision: "none",
  requestSupervision: false,
  delegation: "disabled",
  nestedDelegation: false,
})

export const EMPTY_METRICS: OxpDesktopState["metrics"] = Object.freeze({
  calls: 0,
  failures: 0,
  augmentationCalls: 0,
  supervisionCalls: 0,
  delegationCalls: 0,
  parentEpochs: 0,
  parentEpochReminders: 0,
  unattributedParentCalls: 0,
  trackedParents: 0,
})
