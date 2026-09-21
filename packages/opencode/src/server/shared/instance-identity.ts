import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
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

/**
 * Sent by a client that has already decided *which* opencode it wants. If the
 * value does not name this process, the request is refused instead of being
 * answered with another instance's data.
 *
 * Probing `/instance/identity` and then sending the real request leaves a
 * window — however small — in which the port could belong to someone else. The
 * header closes it: the guarantee stops depending on the port and starts
 * depending on the answer, which only the intended process can give.
 */
export const INSTANCE_EXPECT_HEADER = "x-opencode-expect-instance"

export type InstanceIdentity = {
  /**
   * Stable identity for the durable OpenCode state/profile this process uses.
   * Multiple processes sharing one state/database intentionally share this id;
   * process restarts and ephemeral listener ports do not change it.
   */
  realmID: string
  instanceID: string
  processID: number
  startedAt: string
  version: string
  client?: string
}

const fallback = `anon:${randomUUID()}`
const startedAt = new Date().toISOString()

/**
 * A realm is the durable state boundary, not a process and not a port. Hash the
 * normalized state root so clients can group processes that share credentials
 * and session storage without publishing a local filesystem path.
 */
export function serviceRealmID(stateRoot = Global.Path.state): string {
  const resolved = path.normalize(path.resolve(stateRoot))
  const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved
  return `realm:${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32)}`
}

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
    realmID: serviceRealmID(),
    instanceID: configured || fallback,
    processID: process.pid,
    startedAt,
    version: InstallationVersion,
    ...(client ? { client } : {}),
  }
}
