import { describe, expect, test } from "bun:test"
import { OfxpMetrics } from "../../src/ofxp/metrics"

describe("OFXP bounded metrics", () => {
  test("tracks the normative gauges, counters, and invocation planes without labels", () => {
    const metrics = new OfxpMetrics.Metrics()
    metrics.set("discoveryCandidates", 4)
    metrics.set("trustedPeers", 3)
    metrics.set("onlineTrustedPeers", 2)
    metrics.increment("pairingAttempts")
    metrics.increment("connectionsOpened", 2)
    metrics.increment("authorityDenials")
    metrics.invocation("augmentation", 3)
    metrics.invocation("messaging")

    expect(metrics.snapshot()).toEqual({
      discoveryCandidates: 4,
      trustedPeers: 3,
      onlineTrustedPeers: 2,
      pairingAttempts: 1,
      pairingFailures: 0,
      pairingRateLimits: 0,
      connectionsOpened: 2,
      connectionsReused: 0,
      connectionsFailed: 0,
      invocationFailures: 0,
      authorityDenials: 1,
      identityMismatches: 0,
      ambiguousMutations: 0,
      workerStarts: 0,
      peerMessagesSent: 0,
      peerMessagesReceived: 0,
      peerMessagesDeduplicated: 0,
      invocationsByPlane: {
        augmentation: 3,
        supervision: 0,
        delegation: 0,
        messaging: 1,
      },
    })
  })

  test("normalizes invalid values and saturates instead of overflowing", () => {
    const metrics = new OfxpMetrics.Metrics()
    metrics.set("trustedPeers", -1)
    metrics.set("onlineTrustedPeers", Number.NaN)
    metrics.set("discoveryCandidates", 3.9)
    metrics.increment("pairingFailures", -2)
    metrics.increment("connectionsFailed", Number.POSITIVE_INFINITY)
    metrics.increment("workerStarts", Number.MAX_SAFE_INTEGER)
    metrics.increment("workerStarts", 10)
    metrics.invocation("delegation", Number.MAX_SAFE_INTEGER)
    metrics.invocation("delegation", 1)

    const snapshot = metrics.snapshot()
    expect(snapshot.trustedPeers).toBe(0)
    expect(snapshot.onlineTrustedPeers).toBe(0)
    expect(snapshot.discoveryCandidates).toBe(3)
    expect(snapshot.pairingFailures).toBe(0)
    expect(snapshot.connectionsFailed).toBe(0)
    expect(snapshot.workerStarts).toBe(Number.MAX_SAFE_INTEGER)
    expect(snapshot.invocationsByPlane.delegation).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("returns detached snapshots and resets explicitly", () => {
    const metrics = new OfxpMetrics.Metrics()
    metrics.increment("peerMessagesReceived", 2)
    metrics.invocation("supervision", 2)
    const first = metrics.snapshot()
    ;(first.invocationsByPlane as Record<string, number>).supervision = 99
    expect(metrics.snapshot().invocationsByPlane.supervision).toBe(2)

    metrics.reset()
    const reset = metrics.snapshot()
    expect(Object.values(reset).flatMap((value) => (typeof value === "number" ? [value] : Object.values(value)))).toEqual(
      Array(21).fill(0),
    )
  })
})
