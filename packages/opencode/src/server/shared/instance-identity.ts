import { randomUUID } from "node:crypto"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

/**
 * Set by whoever launched this process (today: the Electron desktop shell) to
 * a value it also records in the mobile dev handshake file. Republishing it on
 * `/instance/identity` is what lets a client prove it reached *this* server
 * and not one of the many other opencode processes on the machine — a
 * listening port is not evidence of identity.
 */
export const INSTANCE_ID_ENV = "OPENCODE_INSTANCE_ID"

export const INSTANCE_IDENTITY_PATH = "/instance/identity"

export type InstanceIdentity = {
  instanceID: string
  processID: number
  startedAt: string
  version: string
  client?: string
}

const fallback = `anon:${randomUUID()}`
const startedAt = new Date().toISOString()

/**
 * Processes nobody claimed still answer, with an `anon:` id: callers need to
 * tell "an opencode that is not mine" apart from "not an opencode at all",
 * and those two failures need very different advice.
 *
 * The payload is deliberately free of user data — this route is
 * unauthenticated, like `/pair/claim`, because it is the step that runs
 * *before* a client is willing to send credentials anywhere.
 */
export function instanceIdentity(): InstanceIdentity {
  const configured = process.env[INSTANCE_ID_ENV]?.trim()
  const client = process.env["OPENCODE_CLIENT"]?.trim()
  return {
    instanceID: configured || fallback,
    processID: process.pid,
    startedAt,
    version: InstallationVersion,
    ...(client ? { client } : {}),
  }
}
