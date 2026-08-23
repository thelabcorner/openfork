import type { DirectorySDK } from "@/context/sdk"

// Seam between the pairing UI and server-auth's (p1) endpoints. Every
// unified-SDK call lives here so route shapes land in one place. The routes
// (/pair/begin, /devices, /devices/{deviceID}) are instance/httpapi — they
// exist ONLY in @opencode-ai/sdk/v2, never in packages/client.

export interface PairingSession {
  /** URL the QR code encodes — the phone opens it to claim the session. */
  url: string
  /** 6-char OTP for manual transcription, e.g. "K7M2XQ". */
  code: string
  /** Epoch ms when the session expires (server mints 90s TTL codes). */
  expiresAt: number
}

export interface PairedDevice {
  id: string
  name: string
  /** Epoch ms when the device was paired. */
  created: number
  /** Epoch ms of last activity, if reported. */
  lastSeen?: number
  /** Token prefix shown so users can identify the credential. */
  prefix: string
}

export const PAIRING_TTL_MS = 90_000

const epochMs = (iso: string) => {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

export const beginPairing = async (sdk: DirectorySDK): Promise<PairingSession> => {
  const response = await sdk.client.pair.begin({ throwOnError: true })
  const result = response.data
  return { url: result.url, code: result.code, expiresAt: epochMs(result.expiresAt) }
}

export const listDevices = async (sdk: DirectorySDK): Promise<PairedDevice[]> => {
  const response = await sdk.client.device.list({ throwOnError: true })
  // The registry soft-revokes and keeps rows — the manager shows active devices only.
  return response.data
    .filter((device) => device.revokedAt === undefined)
    .map((device) => ({
      id: device.id,
      name: device.name,
      created: epochMs(device.createdAt),
      lastSeen: device.lastSeenAt === undefined ? undefined : epochMs(device.lastSeenAt),
      prefix: device.tokenPrefix,
    }))
}

export const revokeDevice = async (sdk: DirectorySDK, id: string): Promise<void> => {
  await sdk.client.device.remove({ deviceID: id }, { throwOnError: true })
}

// Grouped OTP display: "K7M2XQ" -> "K7M-2XQ".
export const formatPairingCode = (code: string) =>
  code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code
