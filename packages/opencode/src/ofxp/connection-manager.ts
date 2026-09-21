export * as OfxpConnectionManager from "./connection-manager"

import { Ofxp } from "@opencode-ai/schema/ofxp"
import type { Material, PeerCertificateIdentity } from "./certificate"
import { OfxpTransport } from "./transport"
import { OfxpMetrics } from "./metrics"

export const DEFAULT_MAX_CONNECTIONS = 16
export const MAX_ENDPOINT_ATTEMPTS = 8

export interface TargetEndpoint {
  readonly host: string
  readonly port: number
}

export interface ConnectionLike {
  readonly peer: PeerCertificateIdentity
  readonly isOpen: boolean
  readonly pendingCount: number
  request<T = unknown>(method: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T>
  close(): Promise<void>
}

export type Connector = (options: {
  readonly material: Material
  readonly host: string
  readonly port: number
  readonly expectedPeerID: Ofxp.PeerID
}) => Promise<ConnectionLike>

export type OnConnect = (connection: ConnectionLike, peerID: Ofxp.PeerID) => Promise<void>

type Active = {
  readonly connection: ConnectionLike
  readonly endpoint: TargetEndpoint
  used: number
}

export interface ConnectionStatus {
  readonly peerID: Ofxp.PeerID
  readonly endpoint: TargetEndpoint
  readonly pendingRequests: number
}

function endpointKey(endpoint: TargetEndpoint) {
  return `${endpoint.host}\u0000${endpoint.port}`
}

function normalizedEndpoints(values: readonly TargetEndpoint[]) {
  const seen = new Set<string>()
  const result: TargetEndpoint[] = []
  for (const endpoint of values) {
    const host = endpoint.host.trim()
    if (!host || host.length > 253) continue
    if (!Number.isSafeInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65_535) continue
    const normalized = { host, port: endpoint.port }
    const key = endpointKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
    if (result.length >= MAX_ENDPOINT_ATTEMPTS) break
  }
  return result
}

/**
 * Process-global, demand-driven outbound peer connection owner.
 *
 * There are deliberately no per-peer health timers or reconnect loops. A peer is
 * dialed only when real work needs it; concurrent dialers share one promise.
 */
export class Manager {
  private readonly active = new Map<Ofxp.PeerID, Active>()
  private readonly connecting = new Map<Ofxp.PeerID, Promise<ConnectionLike>>()
  private sequence = 0
  private stopped = false

  constructor(
    private readonly material: Material,
    private readonly maxConnections = DEFAULT_MAX_CONNECTIONS,
    private readonly connector: Connector = (options) => OfxpTransport.ClientConnection.connect(options),
    private readonly onConnect?: OnConnect,
    private readonly metrics: OfxpMetrics.Metrics = OfxpMetrics.global,
  ) {
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 128) {
      throw new Error("OFXP connection pool size must be between 1 and 128")
    }
  }

  get size() {
    this.pruneClosed()
    return this.active.size
  }

  get pendingDials() {
    return this.connecting.size
  }

  /**
   * Transient Tier-0 routing projection for operator surfaces.
   * These endpoints describe currently authenticated pooled connections only;
   * they are never durable peer identity or trust material and cause no I/O.
   */
  snapshot(): readonly ConnectionStatus[] {
    this.pruneClosed()
    return [...this.active.entries()]
      .map(([peerID, row]) => ({
        peerID,
        endpoint: { ...row.endpoint },
        pendingRequests: row.connection.pendingCount,
      }))
      .sort((a, b) => a.peerID.localeCompare(b.peerID))
  }

  private touch(row: Active) {
    row.used = ++this.sequence
  }

  private pruneClosed() {
    for (const [peerID, row] of this.active) if (!row.connection.isOpen) this.active.delete(peerID)
  }

  private async reserveSlot(exceptPeerID: Ofxp.PeerID) {
    this.pruneClosed()
    if (this.active.size < this.maxConnections) return
    const idle = [...this.active.entries()]
      .filter(([peerID, row]) => peerID !== exceptPeerID && row.connection.pendingCount === 0)
      .sort((a, b) => a[1].used - b[1].used || a[0].localeCompare(b[0]))[0]
    if (!idle) throw new Error("OFXP connection pool is saturated with active requests")
    this.active.delete(idle[0])
    await idle[1].connection.close().catch(() => undefined)
  }

  async get(peerID: Ofxp.PeerID, endpoints: readonly TargetEndpoint[]) {
    if (this.stopped) throw new Error("OFXP connection manager is stopped")
    const current = this.active.get(peerID)
    if (current?.connection.isOpen) {
      this.touch(current)
      this.metrics.increment("connectionsReused")
      return current.connection
    }
    if (current) this.active.delete(peerID)

    const existingDial = this.connecting.get(peerID)
    if (existingDial) return existingDial

    const candidates = normalizedEndpoints(endpoints)
    if (candidates.length === 0) throw new Error(`OFXP peer ${peerID} has no usable endpoint`)

    const dial = (async () => {
      await this.reserveSlot(peerID)
      let lastError: unknown
      for (const endpoint of candidates) {
        if (this.stopped) throw new Error("OFXP connection manager is stopped")
        try {
          const connection = await this.connector({
            material: this.material,
            host: endpoint.host,
            port: endpoint.port,
            expectedPeerID: peerID,
          })
          if (this.stopped) {
            await connection.close().catch(() => undefined)
            throw new Error("OFXP connection manager is stopped")
          }
          if (!connection.isOpen || connection.peer.peerID !== peerID) {
            await connection.close().catch(() => undefined)
            throw new Error("OFXP connector returned the wrong or closed peer connection")
          }
          try {
            await this.onConnect?.(connection, peerID)
          } catch (error) {
            await connection.close().catch(() => undefined)
            throw error
          }
          const row: Active = { connection, endpoint: { ...endpoint }, used: 0 }
          this.touch(row)
          this.active.set(peerID, row)
          this.metrics.increment("connectionsOpened")
          return connection
        } catch (error) {
          lastError = error
        }
      }
      if (!this.stopped) this.metrics.increment("connectionsFailed")
      throw lastError instanceof Error ? lastError : new Error(`Unable to connect to OFXP peer ${peerID}`)
    })()

    this.connecting.set(peerID, dial)
    try {
      return await dial
    } finally {
      if (this.connecting.get(peerID) === dial) this.connecting.delete(peerID)
    }
  }

  async request<T = unknown>(
    peerID: Ofxp.PeerID,
    endpoints: readonly TargetEndpoint[],
    method: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) {
    const connection = await this.get(peerID, endpoints)
    const row = this.active.get(peerID)
    if (row) this.touch(row)
    try {
      return await connection.request<T>(method, body, timeoutMs, signal)
    } finally {
      if (!connection.isOpen && this.active.get(peerID)?.connection === connection) this.active.delete(peerID)
      else if (row) this.touch(row)
    }
  }

  async closePeer(peerID: Ofxp.PeerID) {
    const row = this.active.get(peerID)
    if (!row) return
    await row.connection.close()
    if (this.active.get(peerID) === row) this.active.delete(peerID)
  }

  async stop() {
    this.stopped = true
    // A dial that was already inside the connector when stop began must settle
    // before teardown can truthfully claim convergence. The post-connect stopped
    // check above prevents such a dial from publishing a new active row.
    await Promise.allSettled([...this.connecting.values()])

    const failures: unknown[] = []
    for (const [peerID, row] of [...this.active.entries()]) {
      try {
        await row.connection.close()
        if (this.active.get(peerID) === row) this.active.delete(peerID)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Unable to close all OFXP peer connections")
  }
}

