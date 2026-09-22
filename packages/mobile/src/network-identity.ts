export type NetworkIdentity = {
  instanceID?: string
  realmID: string
  peerID: string
  fingerprint: string
  protocolMin: number
  protocolMax: number
}

export function parseNetworkIdentityProjection(value: unknown): NetworkIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const root = value as Record<string, unknown>
  const ofxpValue = root.ofxp
  if (!ofxpValue || typeof ofxpValue !== "object" || Array.isArray(ofxpValue)) return
  const ofxp = ofxpValue as Record<string, unknown>
  if (
    ofxp.enabled !== true ||
    typeof root.realmID !== "string" ||
    typeof ofxp.peerID !== "string" ||
    typeof ofxp.fingerprint !== "string" ||
    typeof ofxp.protocolMin !== "number" ||
    typeof ofxp.protocolMax !== "number" ||
    !Number.isSafeInteger(ofxp.protocolMin) ||
    !Number.isSafeInteger(ofxp.protocolMax) ||
    ofxp.protocolMin > ofxp.protocolMax
  ) return
  return {
    ...(typeof root.instanceID === "string" ? { instanceID: root.instanceID } : {}),
    realmID: root.realmID,
    peerID: ofxp.peerID,
    fingerprint: ofxp.fingerprint,
    protocolMin: ofxp.protocolMin,
    protocolMax: ofxp.protocolMax,
  }
}

export function parseStoredNetworkIdentity(raw: string | undefined): NetworkIdentity | undefined {
  if (!raw) return
  try {
    const value = JSON.parse(raw) as Partial<NetworkIdentity>
    if (
      typeof value.realmID !== "string" ||
      typeof value.peerID !== "string" ||
      typeof value.fingerprint !== "string" ||
      typeof value.protocolMin !== "number" ||
      typeof value.protocolMax !== "number"
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