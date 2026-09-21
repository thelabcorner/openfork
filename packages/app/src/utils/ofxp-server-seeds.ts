import type { OfxpSettingsServerSeed } from "@opencode-ai/sdk/v2/client"
import { ServerConnection } from "@/context/server"

const PEER_ID = /^ofxp_[A-Za-z0-9_-]{43}$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const LOCAL_PROTOCOL = 1
const DEFAULT_TIMEOUT_MS = 5_000

type RecordValue = Record<string, unknown>

type InstanceOfxpProjection = {
  instanceID: string
  realmID: string
  version: string
  ofxp:
    | { enabled: false }
    | {
        enabled: true
        peerID: string
        fingerprint: string
        protocolMin: number
        protocolMax: number
        pairing: boolean
        endpointHints: ReadonlyArray<{ port: number }>
      }
}

export type OfxpSeedHealth = {
  healthy: boolean
  ofxpSeed?: OfxpSettingsServerSeed
}

export type ConfiguredServerOfxpIdentity =
  | { enabled: false }
  | {
      enabled: true
      peerID: string
      fingerprint: string
      realmID: string
      protocolMin: number
      protocolMax: number
      pairing: boolean
      compatible: boolean
    }

function record(value: unknown): RecordValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as RecordValue
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

export function parseInstanceOfxpProjection(value: unknown): InstanceOfxpProjection | undefined {
  const root = record(value)
  const ofxp = record(root?.ofxp)
  if (!root || !ofxp || typeof ofxp.enabled !== "boolean") return
  if (typeof root.instanceID !== "string" || root.instanceID.length === 0 || root.instanceID.length > 256) return
  if (typeof root.realmID !== "string" || root.realmID.length === 0 || root.realmID.length > 256) return
  if (typeof root.version !== "string" || root.version.length === 0 || root.version.length > 64) return
  if (ofxp.enabled === false) {
    return { instanceID: root.instanceID, realmID: root.realmID, version: root.version, ofxp: { enabled: false } }
  }
  if (
    typeof ofxp.peerID !== "string" ||
    !PEER_ID.test(ofxp.peerID) ||
    typeof ofxp.fingerprint !== "string" ||
    !FINGERPRINT.test(ofxp.fingerprint) ||
    !integer(ofxp.protocolMin) ||
    !integer(ofxp.protocolMax) ||
    ofxp.protocolMin > ofxp.protocolMax ||
    typeof ofxp.pairing !== "boolean" ||
    !Array.isArray(ofxp.endpointHints) ||
    ofxp.endpointHints.length === 0 ||
    ofxp.endpointHints.length > 8
  ) {
    return
  }
  const endpointHints = ofxp.endpointHints.flatMap((item) => {
    const candidate = record(item)
    const port = candidate?.port
    return integer(port) && port > 0 && port <= 65_535 ? [{ port }] : []
  })
  if (endpointHints.length === 0) return
  return {
    instanceID: root.instanceID,
    realmID: root.realmID,
    version: root.version,
    ofxp: {
      enabled: true,
      peerID: ofxp.peerID,
      fingerprint: ofxp.fingerprint,
      protocolMin: ofxp.protocolMin,
      protocolMax: ofxp.protocolMax,
      pairing: ofxp.pairing,
      endpointHints,
    },
  }
}

function httpHostname(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return
    return parsed.hostname
  } catch {
    return
  }
}

function sshHostname(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return
  try {
    if (trimmed.includes("://")) return new URL(trimmed).hostname
  } catch {}
  const noUser = trimmed.slice(trimmed.lastIndexOf("@") + 1)
  if (noUser.startsWith("[")) {
    const end = noUser.indexOf("]")
    return end > 1 ? noUser.slice(1, end) : undefined
  }
  const lastColon = noUser.lastIndexOf(":")
  if (lastColon > 0 && noUser.indexOf(":") === lastColon && /^\d+$/.test(noUser.slice(lastColon + 1))) {
    return noUser.slice(0, lastColon)
  }
  return noUser
}

/**
 * Host as seen from another OpenFork backend, not from the renderer.
 *
 * Desktop sidecars and renderer-loopback HTTP connections are deliberately
 * excluded: forwarding localhost to a remote backend would make it dial itself.
 * SSH uses the actual remote host rather than the renderer-local HTTP proxy.
 */
export function serverSeedHost(connection: ServerConnection.Any) {
  if (connection.type === "sidecar") return
  const host = connection.type === "ssh" ? sshHostname(connection.host) : httpHostname(connection.http.url)
  if (!host || LOOPBACK.has(host.toLowerCase())) return
  return host
}

function seedID(connection: ServerConnection.Any, host: string) {
  if (connection.type === "ssh") return `configured:ssh:${host}`
  try {
    const url = new URL(connection.http.url)
    const port = url.port ? `:${url.port}` : ""
    return `configured:${url.protocol}//${host}${port}`
  } catch {
    return `configured:http:${host}`
  }
}

function timeoutSignal(ms: number) {
  const native = AbortSignal.timeout
  if (native) return { signal: native.call(AbortSignal, ms), clear: undefined as (() => void) | undefined }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function boundedSignal(ms: number, external?: AbortSignal) {
  const timeout = timeoutSignal(ms)
  if (!external) return timeout
  if (external.aborted) {
    timeout.clear?.()
    return { signal: external, clear: undefined as (() => void) | undefined }
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  external.addEventListener("abort", abort, { once: true })
  timeout.signal.addEventListener("abort", abort, { once: true })
  return {
    signal: controller.signal,
    clear: () => {
      timeout.clear?.()
      external.removeEventListener("abort", abort)
      timeout.signal.removeEventListener("abort", abort)
    },
  }
}

/**
 * Probe the public, secret-free identity surface of an already configured
 * server. This request intentionally bypasses createSdkForServer so Basic/device
 * credentials can never be attached to the unauthenticated bootstrap probe.
 */
export async function probeConfiguredServerOfxpSeed(
  connection: ServerConnection.Any,
  fetcher: typeof globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<OfxpSettingsServerSeed | undefined> {
  return (await probeConfiguredServerOfxp(connection, fetcher, timeoutMs, signal))?.seed
}

export type ConfiguredServerOfxpProbe = {
  instanceID: string
  ofxp: ConfiguredServerOfxpIdentity
  seed?: OfxpSettingsServerSeed
}

export async function probeConfiguredServerOfxp(
  connection: ServerConnection.Any,
  fetcher: typeof globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ConfiguredServerOfxpProbe | undefined> {
  let url: URL
  try {
    url = new URL("/instance/identity", connection.http.url)
    // The public bootstrap probe must stay credential-free even if a manually
    // entered legacy URL contains HTTP userinfo.
    url.username = ""
    url.password = ""
  } catch {
    return
  }
  const timeout = boundedSignal(timeoutMs, signal)
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: timeout.signal,
    })
    if (!response.ok) return
    const parsed = parseInstanceOfxpProjection(await response.json())
    if (!parsed) return
    if (!parsed.ofxp.enabled) return { instanceID: parsed.instanceID, ofxp: { enabled: false } }
    const compatible = parsed.ofxp.protocolMin <= LOCAL_PROTOCOL && parsed.ofxp.protocolMax >= LOCAL_PROTOCOL
    const identity: ConfiguredServerOfxpIdentity = {
      enabled: true,
      peerID: parsed.ofxp.peerID,
      fingerprint: parsed.ofxp.fingerprint,
      realmID: parsed.realmID,
      protocolMin: parsed.ofxp.protocolMin,
      protocolMax: parsed.ofxp.protocolMax,
      pairing: parsed.ofxp.pairing,
      compatible,
    }
    const host = serverSeedHost(connection)
    const endpoint = parsed.ofxp.endpointHints[0]
    if (!compatible || !host || !endpoint) return { instanceID: parsed.instanceID, ofxp: identity }
    return {
      instanceID: parsed.instanceID,
      ofxp: identity,
      seed: {
        id: seedID(connection, host),
        peerID: parsed.ofxp.peerID,
        realmID: parsed.realmID,
        openforkVersion: parsed.version,
        protocolVersion: LOCAL_PROTOCOL,
        pairing: parsed.ofxp.pairing,
        endpoint: { host, port: endpoint.port },
      },
    }
  } catch {
    return
  } finally {
    timeout.clear?.()
  }
}

export function collectOfxpServerSeeds(
  connections: readonly ServerConnection.Any[],
  health: Readonly<Record<ServerConnection.Key, OfxpSeedHealth | undefined>>,
  destination?: ServerConnection.Key,
) {
  return connections
    .flatMap((connection) => {
      const key = ServerConnection.key(connection)
      if (key === destination) return []
      const state = health[key]
      if (state?.healthy !== true || !state.ofxpSeed) return []
      return [state.ofxpSeed]
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function createOfxpServerSeedSynchronizer() {
  type State = {
    signature?: string
    generation: number
    queue: Promise<void>
  }
  const MAX_DESTINATIONS = 64
  const states = new Map<string, State>()
  const state = (key: string) => {
    const existing = states.get(key)
    if (existing) {
      // Refresh insertion order so eviction approximates LRU without another
      // timer/index structure.
      states.delete(key)
      states.set(key, existing)
      return existing
    }
    if (states.size >= MAX_DESTINATIONS) {
      const oldestKey = states.keys().next().value
      if (oldestKey !== undefined) {
        const oldest = states.get(oldestKey)
        if (oldest) oldest.generation++
        states.delete(oldestKey)
      }
    }
    const next: State = { generation: 0, queue: Promise.resolve() }
    states.set(key, next)
    return next
  }

  return {
    schedule(key: string, signature: string, send: () => Promise<unknown>) {
      const current = state(key)
      if (current.signature === signature) return false
      current.signature = signature
      const generation = ++current.generation
      current.queue = current.queue
        .catch(() => undefined)
        .then(async () => {
          if (generation !== current.generation) return
          try {
            await send()
          } catch {
            if (generation === current.generation && current.signature === signature) current.signature = undefined
          }
        })
      return true
    },
    invalidate(key: string) {
      const current = state(key)
      current.generation++
      current.signature = undefined
    },
    async flush(key: string) {
      await state(key).queue
    },
  }
}
