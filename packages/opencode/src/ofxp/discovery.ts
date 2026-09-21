export * as OfxpDiscovery from "./discovery"

import { Bonjour, type Browser, type Service } from "bonjour-service"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpMetrics } from "./metrics"

export const MDNS_SERVICE_TYPE = "ofxp"
export const PROTOCOL_VERSION = 1
export const MAX_CANDIDATES = 256
export const MAX_INSTANCES_PER_PEER = 8

export type CandidateSource = "mdns" | "known" | "server"

export type Endpoint = {
  readonly host: string
  readonly port: number
  readonly addresses: readonly string[]
}

export type CandidateInstance = {
  readonly source: CandidateSource
  readonly id: string
  readonly fqdn?: string
  readonly endpoint: Endpoint
}

export type Candidate = {
  readonly peerID: Ofxp.PeerID
  readonly realmID: string
  readonly openforkVersion: string
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly pairing: boolean
  readonly instances: readonly CandidateInstance[]
  readonly lastSeenAt: number
}

type Projection = {
  readonly peerID: Ofxp.PeerID
  readonly realmID: string
  readonly openforkVersion: string
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly pairing: boolean
  readonly source: CandidateSource
  readonly id: string
  readonly fqdn?: string
  readonly endpoint: Endpoint
}

export type CandidateSeed = {
  readonly source: Exclude<CandidateSource, "mdns">
  readonly id: string
  readonly peerID: string
  readonly realmID: string
  readonly openforkVersion: string
  readonly protocolVersion: number
  readonly pairing: boolean
  readonly endpoint: {
    readonly host: string
    readonly port: number
    readonly addresses?: readonly unknown[]
  }
}

function text(value: unknown) {
  if (typeof value === "string") return value
}

function bounded(value: unknown, max: number) {
  const result = text(value)?.trim()
  if (!result || result.length > max || /[\x00-\x1f\x7f]/.test(result)) return
  return result
}

function parsePeerID(value: unknown) {
  const result = bounded(value, 80)
  if (!result) return
  try {
    return Ofxp.PeerID.make(result)
  } catch {
    return
  }
}

function normalizeHost(value: unknown) {
  const host = bounded(value, 253)
  if (!host || /\s/.test(host)) return
  return host
}

function normalizeAddresses(values: readonly unknown[] | undefined) {
  if (!values) return []
  return [
    ...new Set(
      values.flatMap((value) => {
        if (typeof value !== "string") return []
        const normalized = value.trim()
        return normalized.length > 0 &&
          normalized.length <= 64 &&
          !/\s|[\x00-\x1f\x7f]/.test(normalized) &&
          /^[0-9A-Fa-f:.%]+$/.test(normalized)
          ? [normalized]
          : []
      }),
    ),
  ].slice(0, 16)
}

/**
 * Parse only the secret-free routing projection carried by DNS-SD. This returns
 * an untrusted candidate. Cryptographic identity proof happens during pairing /
 * authenticated transport, never here.
 */
export function projectService(service: Pick<Service, "txt" | "fqdn" | "host" | "port" | "addresses">) {
  const txt = service.txt
  if (!txt || typeof txt !== "object") return
  const values = txt as Record<string, unknown>
  if (bounded(values.protocol, 8) !== String(PROTOCOL_VERSION)) return
  const peerID = parsePeerID(values.peer)
  const realmID = bounded(values.realm, 256)
  const openforkVersion = bounded(values.version, 64)
  const fqdn = bounded(service.fqdn, 512)
  const host = normalizeHost(service.host)
  if (!peerID || !realmID || !openforkVersion || !fqdn || !host) return
  if (!Number.isSafeInteger(service.port) || service.port <= 0 || service.port > 65_535) return
  return {
    peerID,
    realmID,
    openforkVersion,
    protocolVersion: PROTOCOL_VERSION,
    pairing: bounded(values.pairing, 8) === "1",
    source: "mdns",
    id: fqdn,
    fqdn,
    endpoint: {
      host,
      port: service.port,
      addresses: normalizeAddresses(service.addresses),
    },
  } satisfies Projection
}

/**
 * Validate one passive, secret-free candidate hint from a non-mDNS provider.
 * The result is still untrusted; pairing/TLS owns identity verification.
 */
export function projectSeed(seed: CandidateSeed) {
  if (seed.source !== "known" && seed.source !== "server") return
  if (seed.protocolVersion !== PROTOCOL_VERSION) return
  const id = bounded(seed.id, 512)
  const peerID = parsePeerID(seed.peerID)
  const realmID = bounded(seed.realmID, 256)
  const openforkVersion = bounded(seed.openforkVersion, 64)
  const host = normalizeHost(seed.endpoint.host)
  if (!id || !peerID || !realmID || !openforkVersion || !host) return
  if (!Number.isSafeInteger(seed.endpoint.port) || seed.endpoint.port <= 0 || seed.endpoint.port > 65_535) return
  return {
    peerID,
    realmID,
    openforkVersion,
    protocolVersion: PROTOCOL_VERSION,
    pairing: seed.pairing === true,
    source: seed.source,
    id,
    endpoint: {
      host,
      port: seed.endpoint.port,
      addresses: normalizeAddresses(seed.endpoint.addresses),
    },
  } satisfies Projection
}

type Entry = {
  readonly projection: Projection
  readonly seenAt: number
}

function projectionKey(projection: Pick<Projection, "source" | "id">) {
  return projection.source + "\u0000" + projection.id
}

/**
 * Process-global Tier-0 candidate projection. Candidate count is hard-bounded;
 * there is no per-peer timer, connection, workspace, or health loop.
 */
export class Directory {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly localPeerID: Ofxp.PeerID,
    private readonly maxCandidates = MAX_CANDIDATES,
    private readonly metrics: OfxpMetrics.Metrics = OfxpMetrics.global,
  ) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    this.metrics.set("discoveryCandidates", new Set([...this.entries.values()].map((entry) => entry.projection.peerID)).size)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {}
    }
  }

  up(service: Pick<Service, "txt" | "fqdn" | "host" | "port" | "addresses">, now = Date.now()) {
    const projection = projectService(service)
    if (!projection || projection.peerID === this.localPeerID) return false
    this.entries.set(projectionKey(projection), { projection, seenAt: now })
    this.trimInstances(projection.peerID)
    this.trim()
    this.emit()
    return true
  }

  down(service: Pick<Service, "fqdn">) {
    const fqdn = bounded(service.fqdn, 512)
    if (!fqdn) return false
    const removed = this.entries.delete(projectionKey({ source: "mdns", id: fqdn }))
    if (removed) this.emit()
    return removed
  }

  upSeed(seed: CandidateSeed, now = Date.now()) {
    const projection = projectSeed(seed)
    if (!projection || projection.peerID === this.localPeerID) return false
    this.entries.set(projectionKey(projection), { projection, seenAt: now })
    this.trimInstances(projection.peerID)
    this.trim()
    this.emit()
    return true
  }

  downSeed(seed: Pick<CandidateSeed, "source" | "id">) {
    if (seed.source !== "known" && seed.source !== "server") return false
    const id = bounded(seed.id, 512)
    if (!id) return false
    const removed = this.entries.delete(projectionKey({ source: seed.source, id }))
    if (removed) this.emit()
    return removed
  }

  /**
   * Evict stale provider observations in one bounded global sweep.
   *
   * The runtime may call this from one process-global maintenance cadence;
   * candidates never allocate their own timers or reconnect loops.
   */
  expireOlderThan(cutoff: number) {
    if (!Number.isFinite(cutoff)) return 0
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.seenAt >= cutoff) continue
      this.entries.delete(key)
      removed++
    }
    if (removed > 0) this.emit()
    return removed
  }

  clear() {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.emit()
  }

  list(): readonly Candidate[] {
    const peers = new Map<Ofxp.PeerID, Entry[]>()
    for (const entry of this.entries.values()) {
      const bucket = peers.get(entry.projection.peerID)
      if (bucket) bucket.push(entry)
      else peers.set(entry.projection.peerID, [entry])
    }
    return [...peers.entries()]
      .map(([peerID, entries]) => {
        entries.sort(
          (a, b) =>
            b.seenAt - a.seenAt ||
            a.projection.source.localeCompare(b.projection.source) ||
            a.projection.id.localeCompare(b.projection.id),
        )
        const latest = entries[0]!
        return {
          peerID,
          realmID: latest.projection.realmID,
          openforkVersion: latest.projection.openforkVersion,
          protocolVersion: PROTOCOL_VERSION,
          pairing: entries.some((entry) => entry.projection.pairing),
          instances: entries.map((entry) => ({
            source: entry.projection.source,
            id: entry.projection.id,
            ...(entry.projection.fqdn ? { fqdn: entry.projection.fqdn } : {}),
            endpoint: entry.projection.endpoint,
          })),
          lastSeenAt: Math.max(...entries.map((entry) => entry.seenAt)),
        } satisfies Candidate
      })
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.peerID.localeCompare(b.peerID))
  }

  private trim() {
    const peerLastSeen = new Map<Ofxp.PeerID, number>()
    for (const entry of this.entries.values()) {
      peerLastSeen.set(entry.projection.peerID, Math.max(peerLastSeen.get(entry.projection.peerID) ?? 0, entry.seenAt))
    }
    if (peerLastSeen.size <= this.maxCandidates) return
    const remove = [...peerLastSeen.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, peerLastSeen.size - this.maxCandidates)
    const peers = new Set(remove.map(([peerID]) => peerID))
    for (const [key, entry] of this.entries) if (peers.has(entry.projection.peerID)) this.entries.delete(key)
  }

  private trimInstances(peerID: Ofxp.PeerID) {
    const instances = [...this.entries.entries()]
      .filter(([, entry]) => entry.projection.peerID === peerID)
      .sort((a, b) => b[1].seenAt - a[1].seenAt || a[0].localeCompare(b[0]))
    for (const [key] of instances.slice(MAX_INSTANCES_PER_PEER)) this.entries.delete(key)
  }
}

export type MdnsOptions = {
  readonly peerID: Ofxp.PeerID
  readonly realmID: string
  readonly openforkVersion: string
  readonly port: number
  readonly pairing: boolean
  readonly onError?: (error: unknown) => void
}

/**
 * Symmetric OFXP LAN presence: the same enabled instance advertises its inbound
 * listener and browses for peers it may call outbound. It conveys no trust.
 */
export class Mdns {
  readonly directory: Directory
  private bonjour?: Bonjour
  private browser?: Browser
  private published?: Service

  constructor(private readonly options: MdnsOptions) {
    this.directory = new Directory(options.peerID)
  }

  start() {
    if (this.bonjour) return
    if (!Number.isSafeInteger(this.options.port) || this.options.port <= 0 || this.options.port > 65_535) {
      throw new Error("OFXP mDNS requires a bound listener port")
    }
    const bonjour = new Bonjour(undefined, (error: unknown) => this.options.onError?.(error))
    try {
      const published = bonjour.publish({
        name: `openfork-${this.options.peerID.slice(-12)}`,
        type: MDNS_SERVICE_TYPE,
        protocol: "tcp",
        port: this.options.port,
        txt: {
          protocol: String(PROTOCOL_VERSION),
          peer: this.options.peerID,
          realm: this.options.realmID,
          version: this.options.openforkVersion,
          pairing: this.options.pairing ? "1" : "0",
        },
      })
      const publishedEvents = published as Service & {
        on(event: "error", listener: (error: unknown) => void): unknown
      }
      publishedEvents.on("error", (error: unknown) => this.options.onError?.(error))
      const browser = bonjour.find({ type: MDNS_SERVICE_TYPE, protocol: "tcp" }) as Browser & {
        on(event: "up" | "down" | "srv-update" | "txt-update", listener: (service: Service) => void): unknown
      }
      browser.on("up", (service: Service) => this.directory.up(service))
      browser.on("down", (service: Service) => this.directory.down(service))
      browser.on("srv-update", (service: Service) => this.directory.up(service))
      browser.on("txt-update", (service: Service) => this.directory.up(service))
      this.published = published
      this.browser = browser
      this.bonjour = bonjour
    } catch (error) {
      try {
        bonjour.destroy()
      } catch {}
      this.published = undefined
      this.browser = undefined
      this.bonjour = undefined
      throw error
    }
  }

  stop() {
    const bonjour = this.bonjour
    if (!bonjour) return
    this.bonjour = undefined
    this.browser?.stop()
    this.browser = undefined
    try {
      this.published?.stop?.()
    } catch {}
    this.published = undefined
    try {
      bonjour.unpublishAll()
      bonjour.destroy()
    } finally {
      this.directory.clear()
    }
  }
}

