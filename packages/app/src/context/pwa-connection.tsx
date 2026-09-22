import { createContext, type ParentProps, useContext } from "solid-js"

export type PwaNetworkIdentity = {
  instanceID?: string
  realmID: string
  peerID: string
  fingerprint: string
  protocolMin: number
  protocolMax: number
}

export type PwaEndpointMigrationResult =
  | "migrated"
  | "invalid-url"
  | "unpinned"
  | "identity-unavailable"
  | "identity-mismatch"
  | "credential-invalid"
  | "unreachable"

export type PwaConnectionContextValue = {
  serverUrl: string
  deviceID?: string
  networkIdentity?: PwaNetworkIdentity
  forgetDevice?: () => void
  migrateEndpoint?: (nextUrl: string) => Promise<PwaEndpointMigrationResult>
}

const PwaConnectionContext = createContext<PwaConnectionContextValue>()

export function PwaConnectionProvider(props: ParentProps<{ value: PwaConnectionContextValue }>) {
  return <PwaConnectionContext.Provider value={props.value}>{props.children}</PwaConnectionContext.Provider>
}

export function usePwaConnection() {
  return useContext(PwaConnectionContext)
}