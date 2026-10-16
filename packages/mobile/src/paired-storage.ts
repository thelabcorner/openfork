import { normalizeServerUrl } from "./pairing-input"
import { parseStoredNetworkIdentity, type NetworkIdentity } from "./network-identity"

export const PAIRED_CONNECTION_KEY = "opencode.mobile.pairedConnection.v1"

export type TrustedPairing = {
  serverUrl: string
  token: string
  deviceID?: string
  networkIdentity: NetworkIdentity
}

/** A malformed current record must NEVER fall back to older independent keys. */
export function readTrustedPairing(storage: Pick<Storage, "getItem">, options?: { allowInsecureRemote?: boolean }):
  | { kind: "absent" | "corrupt" }
  | { kind: "valid"; value: TrustedPairing } {
  let text: string | null
  try {
    text = storage.getItem(PAIRED_CONNECTION_KEY)
  } catch {
    return { kind: "corrupt" }
  }
  if (text === null) return { kind: "absent" }
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value.version !== 1 || typeof value.serverUrl !== "string" || typeof value.token !== "string")
      return { kind: "corrupt" }
    if (!value.token || value.token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value.token))
      return { kind: "corrupt" }
    if (normalizeServerUrl(value.serverUrl, options) !== value.serverUrl) return { kind: "corrupt" }
    const networkIdentity = parseStoredNetworkIdentity(JSON.stringify(value.networkIdentity))
    if (!networkIdentity) return { kind: "corrupt" }
    if (value.deviceID !== undefined && typeof value.deviceID !== "string") return { kind: "corrupt" }
    return {
      kind: "valid",
      value: {
        serverUrl: value.serverUrl,
        token: value.token,
        deviceID: value.deviceID as string | undefined,
        networkIdentity,
      },
    }
  } catch {
    return { kind: "corrupt" }
  }
}

/** A single localStorage transaction binds endpoint, credential and identity. */
export function writeTrustedPairing(
  storage: Pick<Storage, "setItem" | "getItem">,
  value: TrustedPairing,
  options?: { allowInsecureRemote?: boolean },
): boolean {
  const body = JSON.stringify({ version: 1, ...value })
  // Validate before writing: accepting an invalid tuple would falsely report
  // pairing persistence now, but fail to restore it after the next restart.
  if (readTrustedPairing({ getItem: () => body }, options).kind !== "valid") return false
  try {
    storage.setItem(PAIRED_CONNECTION_KEY, body)
    return storage.getItem(PAIRED_CONNECTION_KEY) === body
  } catch {
    return false
  }
}

export function removeTrustedPairing(storage: Pick<Storage, "removeItem">) {
  try {
    storage.removeItem(PAIRED_CONNECTION_KEY)
  } catch {
    // Private browsing and disabled storage can reject writes. In-memory state
    // is still invalidated by the owner's generation gate.
  }
}