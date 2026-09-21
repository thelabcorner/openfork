export * as OfxpMetrics from "./metrics"

import type { Ofxp } from "@opencode-ai/schema/ofxp"

export const GAUGES = ["discoveryCandidates", "trustedPeers", "onlineTrustedPeers"] as const
export const COUNTERS = [
  "pairingAttempts",
  "pairingFailures",
  "pairingRateLimits",
  "connectionsOpened",
  "connectionsReused",
  "connectionsFailed",
  "invocationFailures",
  "authorityDenials",
  "identityMismatches",
  "ambiguousMutations",
  "workerStarts",
  "peerMessagesSent",
  "peerMessagesReceived",
  "peerMessagesDeduplicated",
] as const

export type Gauge = (typeof GAUGES)[number]
export type Counter = (typeof COUNTERS)[number]

const PLANES = ["augmentation", "supervision", "delegation", "messaging"] as const satisfies readonly Ofxp.Plane[]

export interface Snapshot {
  readonly discoveryCandidates: number
  readonly trustedPeers: number
  readonly onlineTrustedPeers: number
  readonly pairingAttempts: number
  readonly pairingFailures: number
  readonly pairingRateLimits: number
  readonly connectionsOpened: number
  readonly connectionsReused: number
  readonly connectionsFailed: number
  readonly invocationsByPlane: Readonly<Record<Ofxp.Plane, number>>
  readonly invocationFailures: number
  readonly authorityDenials: number
  readonly identityMismatches: number
  readonly ambiguousMutations: number
  readonly workerStarts: number
  readonly peerMessagesSent: number
  readonly peerMessagesReceived: number
  readonly peerMessagesDeduplicated: number
}

function amount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

/**
 * Process-global OFXP operational counters.
 *
 * This owner deliberately retains no peer/session/path/payload labels. That
 * keeps observability O(1) in peer count and prevents metrics from becoming a
 * second activity/history store.
 */
export class Metrics {
  private readonly gauges = Object.fromEntries(GAUGES.map((key) => [key, 0])) as Record<Gauge, number>
  private readonly counters = Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Record<Counter, number>
  private readonly planes = Object.fromEntries(PLANES.map((key) => [key, 0])) as Record<Ofxp.Plane, number>

  set(key: Gauge, value: number) {
    this.gauges[key] = amount(value)
  }

  increment(key: Counter, by = 1) {
    const delta = amount(by)
    this.counters[key] = Math.min(Number.MAX_SAFE_INTEGER, this.counters[key] + delta)
  }

  invocation(plane: Ofxp.Plane, by = 1) {
    const delta = amount(by)
    this.planes[plane] = Math.min(Number.MAX_SAFE_INTEGER, this.planes[plane] + delta)
  }

  snapshot(): Snapshot {
    return {
      ...this.gauges,
      ...this.counters,
      invocationsByPlane: { ...this.planes },
    }
  }

  reset() {
    for (const key of GAUGES) this.gauges[key] = 0
    for (const key of COUNTERS) this.counters[key] = 0
    for (const key of PLANES) this.planes[key] = 0
  }
}

/** One process-global metrics owner; callers must not allocate per-peer copies. */
export const global = new Metrics()
