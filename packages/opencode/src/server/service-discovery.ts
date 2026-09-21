import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { instanceIdentity, type InstanceIdentity } from "./shared/instance-identity"

export const SERVICE_DISCOVERY_SCHEMA_VERSION = 2
export const SERVICE_DISCOVERY_DIRNAME = "service-discovery"

export type ServiceDescriptor = InstanceIdentity & {
  schemaVersion: typeof SERVICE_DISCOVERY_SCHEMA_VERSION
  url: string
}

export type ServiceDescriptorLease = {
  file: string
  descriptor: ServiceDescriptor
  revoke(): Promise<void>
}

type PublishOptions = {
  directory?: string
}

export function serviceDiscoveryDirectory() {
  return path.join(Global.Path.state, SERVICE_DISCOVERY_DIRNAME)
}

function isLoopback(url: URL) {
  const host = url.hostname.toLowerCase()
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1"
}

function processAppearsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function pruneDeadDescriptors(directory: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
    throw error
  })
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return
      const file = path.join(directory, entry.name)
      const raw = await fs.readFile(file, "utf8").catch(() => undefined)
      if (!raw) return
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        return
      }
      if (!value || typeof value !== "object") return
      const descriptor = value as Record<string, unknown>
      // Only prune schemas we understand. v1 is the immediately previous shape
      // (before realmID); unknown/newer schemas remain untouched.
      if (descriptor.schemaVersion !== 1 && descriptor.schemaVersion !== SERVICE_DISCOVERY_SCHEMA_VERSION) return
      if (typeof descriptor.processID !== "number" || processAppearsAlive(descriptor.processID)) return
      await fs.rm(file, { force: true }).catch(() => undefined)
    }),
  )
}

/**
 * Publish a secret-free rendezvous descriptor after the HTTP listener has bound
 * its real port. The descriptor is only a discovery hint: clients must still
 * prove `/instance/identity` matches before sending credentials or work.
 *
 * Each listener owns a unique file so concurrent OpenCode processes never
 * overwrite one another. A hard crash may leave a stale descriptor; that is
 * intentionally harmless because identity verification is authoritative.
 */
export async function publishServiceDescriptor(
  url: URL,
  options: PublishOptions = {},
): Promise<ServiceDescriptorLease | undefined> {
  if (url.protocol !== "http:" || !isLoopback(url)) return

  const directory = options.directory ?? serviceDiscoveryDirectory()
  const identity = instanceIdentity()
  const descriptor: ServiceDescriptor = {
    schemaVersion: SERVICE_DISCOVERY_SCHEMA_VERSION,
    url: url.origin,
    ...identity,
  }
  const id = randomUUID()
  const file = path.join(directory, `${process.pid}-${id}.json`)
  const temporary = `${file}.${process.pid}.tmp`
  const content = `${JSON.stringify(descriptor, null, 2)}\n`

  await fs.mkdir(directory, { recursive: true })
  await pruneDeadDescriptors(directory)
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }

  let revoked = false
  return {
    file,
    descriptor,
    async revoke() {
      if (revoked) return
      revoked = true
      // Never remove a file that no longer contains the state this listener
      // published. A concurrent/newer writer wins over our teardown.
      const current = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (current === undefined || current !== content) return
      await fs.rm(file, { force: true })
    },
  }
}
