export type NetworkIdentity = {
  instanceID?: string
  realmID: string
  peerID: string
  fingerprint: string
  protocolMin: number
  protocolMax: number
}

// The public projection and durable pin must have identical validation.
// In particular, an empty peer/fingerprint/realm is not an identity and a
// malformed persisted protocol range must never become a trusted pin.
function validIdentityString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)
}

function validProtocolBounds(min: unknown, max: unknown): min is number {
  return typeof min === "number" && typeof max === "number" &&
    Number.isSafeInteger(min) && Number.isSafeInteger(max) &&
    min >= 0 && max >= min
}

export function parseNetworkIdentityProjection(value: unknown): NetworkIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const root = value as Record<string, unknown>
  const ofxpValue = root.ofxp
  if (!ofxpValue || typeof ofxpValue !== "object" || Array.isArray(ofxpValue)) return
  const ofxp = ofxpValue as Record<string, unknown>
  if (
    ofxp.enabled !== true ||
    !validIdentityString(root.realmID) ||
    !validIdentityString(ofxp.peerID) ||
    !validIdentityString(ofxp.fingerprint) ||
    !validProtocolBounds(ofxp.protocolMin, ofxp.protocolMax)
  ) return
  return {
    ...(typeof root.instanceID === "string" ? { instanceID: root.instanceID } : {}),
    realmID: root.realmID,
    peerID: ofxp.peerID,
    fingerprint: ofxp.fingerprint,
    protocolMin: ofxp.protocolMin,
    protocolMax: ofxp.protocolMax as number, // checked by validProtocolBounds
  }
}

export function parseStoredNetworkIdentity(raw: string | undefined): NetworkIdentity | undefined {
  if (!raw) return
  try {
    const value = JSON.parse(raw) as Partial<NetworkIdentity>
    if (
      !validIdentityString(value.realmID) ||
      !validIdentityString(value.peerID) ||
      !validIdentityString(value.fingerprint) ||
      !validProtocolBounds(value.protocolMin, value.protocolMax) ||
      (value.instanceID !== undefined && !validIdentityString(value.instanceID))
    ) return
    return value as NetworkIdentity
  } catch {
    return
  }
}

export function sameNetworkIdentity(expected: NetworkIdentity, actual: NetworkIdentity) {
  return (
    expected.peerID === actual.peerID &&
    expected.fingerprint === actual.fingerprint &&
    expected.realmID === actual.realmID
  )
}

export type PinnedIdentityVerdict = "match" | "mismatch" | "unavailable" | "unpinned"

export function pinnedIdentityVerdict(
  pinned: NetworkIdentity | undefined,
  live: NetworkIdentity | undefined,
): PinnedIdentityVerdict {
  if (!pinned) return "unpinned"
  if (!live) return "unavailable"
  return sameNetworkIdentity(pinned, live) ? "match" : "mismatch"
}