import { describe, expect, test } from "bun:test"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import type { PeerCertificateIdentity } from "../../src/ofxp/certificate"
import { OfxpConnectionManager } from "../../src/ofxp/connection-manager"
import { OfxpMetrics } from "../../src/ofxp/metrics"

function peer(seed: number) {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    certIdentity: {
      peerID: key.peerID,
      fingerprint: key.fingerprint,
      publicKeySpki: key.publicKeySpki,
    },
  }
}

function material() {
  const key = OfxpIdentity.generateKeyPair()
  return { peerID: key.peerID, key: key.privateKeyPkcs8, cert: "test", notBefore: 0, notAfter: Number.MAX_SAFE_INTEGER }
}

class FakeConnection implements OfxpConnectionManager.ConnectionLike {
  open = true
  requests = 0
  pending = 0
  closed = 0
  constructor(
    readonly peer: PeerCertificateIdentity,
    private closeFailures = 0,
  ) {}
  get isOpen() {
    return this.open
  }
  get pendingCount() {
    return this.pending
  }
  async request<T = unknown>() {
    this.requests++
    return { ok: true } as T
  }
  async close() {
    this.closed++
    if (this.closeFailures > 0) {
      this.closeFailures--
      throw new Error("close failed")
    }
    this.open = false
  }
}

describe("OFXP outbound connection manager", () => {
  test("deduplicates a concurrent dial storm for one peer", async () => {
    const remote = peer(1)
    let dials = 0
    const connection = new FakeConnection(remote.certIdentity)
    const manager = new OfxpConnectionManager.Manager(material(), 8, async () => {
      dials++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return connection
    })
    const results = await Promise.all(
      Array.from({ length: 32 }, () => manager.get(remote.key.peerID, [{ host: "127.0.0.1", port: 4000 }])),
    )
    expect(dials).toBe(1)
    expect(new Set(results).size).toBe(1)
    expect(manager.size).toBe(1)
    await manager.stop()
  })

  test("reuses an open connection without redialing", async () => {
    const remote = peer(2)
    let dials = 0
    const connection = new FakeConnection(remote.certIdentity)
    const manager = new OfxpConnectionManager.Manager(material(), 8, async () => {
      dials++
      return connection
    })
    await manager.request(remote.key.peerID, [{ host: "127.0.0.1", port: 4000 }], "hello")
    await manager.request(remote.key.peerID, [{ host: "127.0.0.1", port: 4000 }], "hello")
    expect(dials).toBe(1)
    expect(connection.requests).toBe(2)
    await manager.stop()
  })

  test("records only aggregate connection opened/reused/failed metrics", async () => {
    const remote = peer(35)
    const metrics = new OfxpMetrics.Metrics()
    const connection = new FakeConnection(remote.certIdentity)
    let fail = false
    const manager = new OfxpConnectionManager.Manager(
      material(),
      8,
      async () => {
        if (fail) throw new Error("dial failed")
        return connection
      },
      undefined,
      metrics,
    )

    await manager.get(remote.key.peerID, [{ host: "remote", port: 1 }])
    await manager.get(remote.key.peerID, [{ host: "remote", port: 1 }])
    await manager.closePeer(remote.key.peerID)
    fail = true
    await expect(manager.get(remote.key.peerID, [{ host: "remote", port: 1 }])).rejects.toThrow("dial failed")

    const snapshot = metrics.snapshot()
    expect(snapshot.connectionsOpened).toBe(1)
    expect(snapshot.connectionsReused).toBe(1)
    expect(snapshot.connectionsFailed).toBe(1)
    await manager.stop()
  })

  test("runs connection negotiation exactly once for a reused pooled connection", async () => {
    const remote = peer(20)
    const connection = new FakeConnection(remote.certIdentity)
    let negotiated = 0
    const manager = new OfxpConnectionManager.Manager(
      material(),
      8,
      async () => connection,
      async () => {
        negotiated++
      },
    )
    await manager.request(remote.key.peerID, [{ host: "127.0.0.1", port: 4000 }], "one")
    await manager.request(remote.key.peerID, [{ host: "127.0.0.1", port: 4000 }], "two")
    expect(negotiated).toBe(1)
    expect(connection.requests).toBe(2)
    await manager.stop()
  })

  test("projects the endpoint that actually authenticated after dial failover without redialing", async () => {
    const remote = peer(21)
    const connection = new FakeConnection(remote.certIdentity)
    const attempts: string[] = []
    const manager = new OfxpConnectionManager.Manager(material(), 8, async (options) => {
      attempts.push(`${options.host}:${options.port}`)
      if (options.host === "bad") throw new Error("unreachable")
      return connection
    })

    await manager.get(remote.key.peerID, [
      { host: "bad", port: 4000 },
      { host: "good", port: 4001 },
    ])
    expect(attempts).toEqual(["bad:4000", "good:4001"])
    expect(manager.snapshot()).toEqual([
      {
        peerID: remote.key.peerID,
        endpoint: { host: "good", port: 4001 },
        pendingRequests: 0,
      },
    ])

    await manager.get(remote.key.peerID, [{ host: "new-hint", port: 5000 }])
    expect(attempts).toEqual(["bad:4000", "good:4001"])
    expect(manager.snapshot()[0]?.endpoint).toEqual({ host: "good", port: 4001 })

    connection.open = false
    expect(manager.snapshot()).toEqual([])
    await manager.stop()
  })

  test("evicts the least-recently-used idle connection at the bound", async () => {
    const a = peer(3)
    const b = peer(4)
    const c = peer(5)
    const byPeer = new Map([
      [a.key.peerID, new FakeConnection(a.certIdentity)],
      [b.key.peerID, new FakeConnection(b.certIdentity)],
      [c.key.peerID, new FakeConnection(c.certIdentity)],
    ])
    const manager = new OfxpConnectionManager.Manager(material(), 2, async (options) => byPeer.get(options.expectedPeerID)!)
    await manager.get(a.key.peerID, [{ host: "a", port: 1 }])
    await manager.get(b.key.peerID, [{ host: "b", port: 2 }])
    await manager.get(b.key.peerID, [{ host: "b", port: 2 }])
    await manager.get(c.key.peerID, [{ host: "c", port: 3 }])
    expect(byPeer.get(a.key.peerID)?.closed).toBe(1)
    expect(byPeer.get(b.key.peerID)?.isOpen).toBe(true)
    expect(byPeer.get(c.key.peerID)?.isOpen).toBe(true)
    expect(manager.size).toBe(2)
    await manager.stop()
  })

  test("closePeer evicts only the targeted authenticated connection and is idempotent", async () => {
    const a = peer(30)
    const b = peer(31)
    const first = new FakeConnection(a.certIdentity)
    const second = new FakeConnection(b.certIdentity)
    const byPeer = new Map([
      [a.key.peerID, first],
      [b.key.peerID, second],
    ])
    const manager = new OfxpConnectionManager.Manager(material(), 4, async (options) => byPeer.get(options.expectedPeerID)!)

    await manager.get(a.key.peerID, [{ host: "a", port: 1 }])
    await manager.get(b.key.peerID, [{ host: "b", port: 2 }])
    expect(manager.size).toBe(2)

    await manager.closePeer(a.key.peerID)
    expect(first.closed).toBe(1)
    expect(second.closed).toBe(0)
    expect(manager.snapshot().map((entry) => entry.peerID)).toEqual([b.key.peerID])

    await manager.closePeer(a.key.peerID)
    expect(first.closed).toBe(1)
    await manager.stop()
  })

  test("stop waits for an in-flight dial and never publishes its late connection", async () => {
    const remote = peer(32)
    const connection = new FakeConnection(remote.certIdentity)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const manager = new OfxpConnectionManager.Manager(material(), 4, async () => {
      await gate
      return connection
    })

    const dial = manager.get(remote.key.peerID, [{ host: "late", port: 1 }])
    await Promise.resolve()
    const stopping = manager.stop()
    release()
    await expect(dial).rejects.toThrow("stopped")
    await stopping
    expect(connection.closed).toBe(1)
    expect(manager.size).toBe(0)
  })

  test("retains failed-close ownership so stop and closePeer can retry to convergence", async () => {
    const remote = peer(33)
    const connection = new FakeConnection(remote.certIdentity, 1)
    const manager = new OfxpConnectionManager.Manager(material(), 4, async () => connection)
    await manager.get(remote.key.peerID, [{ host: "remote", port: 1 }])

    await expect(manager.closePeer(remote.key.peerID)).rejects.toThrow("close failed")
    expect(manager.size).toBe(1)
    await manager.closePeer(remote.key.peerID)
    expect(manager.size).toBe(0)

    const other = peer(34)
    const retry = new FakeConnection(other.certIdentity, 1)
    const manager2 = new OfxpConnectionManager.Manager(material(), 4, async () => retry)
    await manager2.get(other.key.peerID, [{ host: "other", port: 2 }])
    await expect(manager2.stop()).rejects.toThrow("Unable to close all OFXP peer connections")
    expect(manager2.size).toBe(1)
    await manager2.stop()
    expect(manager2.size).toBe(0)
  })

  test("never evicts a connection with live requests", async () => {
    const a = peer(6)
    const b = peer(7)
    const first = new FakeConnection(a.certIdentity)
    first.pending = 1
    const second = new FakeConnection(b.certIdentity)
    const manager = new OfxpConnectionManager.Manager(material(), 1, async (options) =>
      options.expectedPeerID === a.key.peerID ? first : second,
    )
    await manager.get(a.key.peerID, [{ host: "a", port: 1 }])
    await expect(manager.get(b.key.peerID, [{ host: "b", port: 2 }])).rejects.toThrow("saturated")
    expect(first.closed).toBe(0)
    await manager.stop()
  })
})
