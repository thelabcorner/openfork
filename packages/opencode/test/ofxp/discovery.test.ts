import { describe, expect, test } from "bun:test"
import { OfxpDiscovery } from "../../src/ofxp/discovery"
import { OfxpMetrics } from "../../src/ofxp/metrics"

function peerID(seed: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const char = alphabet[seed % alphabet.length]!
  return `ofxp_${char.repeat(43)}`
}

function service(input: {
  peerID: string
  fqdn?: string
  host?: string
  port?: number
  realm?: string
  version?: string
  pairing?: string
  addresses?: string[]
}) {
  return {
    txt: {
      protocol: "1",
      peer: input.peerID,
      realm: input.realm ?? "realm:test",
      version: input.version ?? "1.0.0",
      pairing: input.pairing ?? "1",
    },
    fqdn: input.fqdn ?? `peer-${input.peerID}._ofxp._tcp.local`,
    host: input.host ?? "peer.local",
    port: input.port ?? 45678,
    addresses: input.addresses ?? ["192.0.2.10", "not-an-ip"],
  }
}

function seed(input: {
  peerID: string
  source?: "known" | "server"
  id?: string
  host?: string
  port?: number
  realmID?: string
  version?: string
  protocolVersion?: number
  pairing?: boolean
  addresses?: string[]
}): OfxpDiscovery.CandidateSeed {
  return {
    source: input.source ?? "server",
    id: input.id ?? `seed:${input.peerID}`,
    peerID: input.peerID,
    realmID: input.realmID ?? "realm:test",
    openforkVersion: input.version ?? "1.0.0",
    protocolVersion: input.protocolVersion ?? 1,
    pairing: input.pairing ?? true,
    endpoint: {
      host: input.host ?? "seed.example",
      port: input.port ?? 45679,
      addresses: input.addresses ?? ["192.0.2.20", "not-an-ip"],
    },
  }
}

describe("OFXP discovery candidate projection", () => {
  test("projects only bounded secret-free routing metadata", () => {
    const peer = peerID(1)
    const projected = OfxpDiscovery.projectService(service({ peerID: peer }))
    expect(projected).toEqual({
      peerID: peer,
      realmID: "realm:test",
      openforkVersion: "1.0.0",
      protocolVersion: 1,
      pairing: true,
      source: "mdns",
      id: `peer-${peer}._ofxp._tcp.local`,
      fqdn: `peer-${peer}._ofxp._tcp.local`,
      endpoint: { host: "peer.local", port: 45678, addresses: ["192.0.2.10"] },
    })
  })

  test("rejects unsupported protocol, malformed peer IDs, and invalid ports", () => {
    const peer = peerID(2)
    expect(
      OfxpDiscovery.projectService({ ...service({ peerID: peer }), txt: { protocol: "2", peer } }),
    ).toBeUndefined()
    expect(OfxpDiscovery.projectService(service({ peerID: "not-a-peer" }))).toBeUndefined()
    expect(OfxpDiscovery.projectService(service({ peerID: peer, port: 0 }))).toBeUndefined()
  })

  test("validates passive known/server seeds without granting them special authority", () => {
    const peer = peerID(6)
    expect(OfxpDiscovery.projectSeed(seed({ peerID: peer }))).toEqual({
      peerID: peer,
      realmID: "realm:test",
      openforkVersion: "1.0.0",
      protocolVersion: 1,
      pairing: true,
      source: "server",
      id: `seed:${peer}`,
      endpoint: { host: "seed.example", port: 45679, addresses: ["192.0.2.20"] },
    })
    expect(
      OfxpDiscovery.projectSeed({
        ...seed({ peerID: peer }),
        endpoint: { host: "seed.example", port: 45679, addresses: ["192.0.2.20", 42, null] },
      } as never)?.endpoint.addresses,
    ).toEqual(["192.0.2.20"])
    expect(OfxpDiscovery.projectSeed(seed({ peerID: "bad-peer" }))).toBeUndefined()
    expect(OfxpDiscovery.projectSeed(seed({ peerID: peer, protocolVersion: 2 }))).toBeUndefined()
    expect(OfxpDiscovery.projectSeed(seed({ peerID: peer, port: 0 }))).toBeUndefined()
  })

  test("self-filters and deduplicates one peer across several advertised endpoints", () => {
    const local = peerID(3)
    const remote = peerID(4)
    const directory = new OfxpDiscovery.Directory(local as never)

    expect(directory.up(service({ peerID: local }), 10)).toBe(false)
    expect(directory.up(service({ peerID: remote, fqdn: "remote-a._ofxp._tcp.local", port: 4001 }), 20)).toBe(true)
    expect(directory.up(service({ peerID: remote, fqdn: "remote-b._ofxp._tcp.local", port: 4002 }), 30)).toBe(true)

    const [candidate] = directory.list()
    expect(directory.list()).toHaveLength(1)
    expect(candidate?.peerID).toBe(remote)
    expect(candidate?.instances.map((entry) => entry.endpoint.port).sort()).toEqual([4001, 4002])

    expect(directory.down({ fqdn: "remote-a._ofxp._tcp.local" })).toBe(true)
    expect(directory.list()[0]?.instances).toHaveLength(1)
  })

  test("deduplicates one peer across providers and removes only the requested provider instance", () => {
    const local = peerID(7)
    const remote = peerID(8)
    const directory = new OfxpDiscovery.Directory(local as never)
    expect(directory.up(service({ peerID: remote, fqdn: "remote._ofxp._tcp.local", port: 4100 }), 10)).toBe(true)
    expect(directory.upSeed(seed({ peerID: remote, source: "server", id: "configured-server", port: 4200 }), 20)).toBe(true)
    expect(directory.upSeed(seed({ peerID: remote, source: "known", id: "last-authenticated", port: 4300 }), 30)).toBe(true)

    const [candidate] = directory.list()
    expect(directory.list()).toHaveLength(1)
    expect(candidate?.instances.map((entry) => entry.source).sort()).toEqual(["known", "mdns", "server"])
    expect(candidate?.instances.map((entry) => entry.endpoint.port).sort()).toEqual([4100, 4200, 4300])

    expect(directory.downSeed({ source: "server", id: "configured-server" })).toBe(true)
    expect(directory.list()[0]?.instances.map((entry) => entry.source).sort()).toEqual(["known", "mdns"])
  })

  test("reconciles one passive provider without erasing other discovery providers", () => {
    const local = peerID(50)
    const mdnsPeer = peerID(51)
    const serverPeer = peerID(52)
    const replacementPeer = peerID(53)
    const directory = new OfxpDiscovery.Directory(local as never)
    directory.up(service({ peerID: mdnsPeer, fqdn: "mdns._ofxp._tcp.local" }), 10)

    expect(
      directory.replaceSeeds(
        "server",
        [seed({ peerID: serverPeer, source: "server", id: "configured-a", port: 4401 })],
        20,
      ),
    ).toBe(1)
    expect(directory.list().map((item) => item.peerID).sort()).toEqual([mdnsPeer, serverPeer].sort())

    expect(
      directory.replaceSeeds(
        "server",
        [seed({ peerID: replacementPeer, source: "server", id: "configured-b", port: 4402 })],
        30,
      ),
    ).toBe(1)
    expect(directory.list().map((item) => item.peerID).sort()).toEqual([mdnsPeer, replacementPeer].sort())

    expect(directory.clearSource("server")).toBe(1)
    expect(directory.list().map((item) => item.peerID)).toEqual([mdnsPeer])
  })

  test("self-filters passive seeds through the same directory boundary", () => {
    const local = peerID(9)
    const directory = new OfxpDiscovery.Directory(local as never)
    expect(directory.upSeed(seed({ peerID: local }), 10)).toBe(false)
    expect(directory.list()).toEqual([])
  })

  test("evicts stale observations in one bounded sweep and emits once", () => {
    const local = peerID(10)
    const remote = peerID(11)
    const directory = new OfxpDiscovery.Directory(local as never)
    let changes = 0
    directory.subscribe(() => changes++)
    directory.up(service({ peerID: remote, fqdn: "old._ofxp._tcp.local" }), 10)
    directory.upSeed(seed({ peerID: remote, source: "server", id: "fresh" }), 30)
    expect(changes).toBe(2)

    expect(directory.expireOlderThan(20)).toBe(1)
    expect(changes).toBe(3)
    expect(directory.list()[0]?.instances.map((entry) => entry.id)).toEqual(["fresh"])
    expect(directory.expireOlderThan(20)).toBe(0)
    expect(directory.expireOlderThan(Number.NaN)).toBe(0)
    expect(changes).toBe(3)
  })

  test("bounds candidate cardinality without allocating per-candidate timers", () => {
    const local = peerID(5)
    const directory = new OfxpDiscovery.Directory(local as never, 3)
    const peers = Array.from({ length: 5 }, (_, index) => peerID(index + 10))
    peers.forEach((peer, index) => directory.up(service({ peerID: peer, fqdn: `p${index}._ofxp._tcp.local` }), index + 1))
    const result = directory.list()
    expect(result).toHaveLength(3)
    expect(result.map((entry) => entry.peerID)).toEqual([peers[4]!, peers[3]!, peers[2]!])
  })

  test("bounds endpoint fanout from one maliciously noisy peer", () => {
    const local = peerID(20)
    const remote = peerID(21)
    const directory = new OfxpDiscovery.Directory(local as never)
    for (let i = 0; i < OfxpDiscovery.MAX_INSTANCES_PER_PEER + 20; i++) {
      directory.up(service({ peerID: remote, fqdn: `noisy-${i}._ofxp._tcp.local`, port: 10_000 + i }), i + 1)
    }
    expect(directory.list()).toHaveLength(1)
    expect(directory.list()[0]?.instances).toHaveLength(OfxpDiscovery.MAX_INSTANCES_PER_PEER)
    expect(directory.list()[0]?.instances[0]?.endpoint.port).toBe(10_000 + OfxpDiscovery.MAX_INSTANCES_PER_PEER + 19)
  })

  test("projects candidate cardinality into one aggregate process metric", () => {
    const local = peerID(40)
    const first = peerID(41)
    const second = peerID(42)
    const metrics = new OfxpMetrics.Metrics()
    const directory = new OfxpDiscovery.Directory(local as never, OfxpDiscovery.MAX_CANDIDATES, metrics)

    directory.up(service({ peerID: first, fqdn: "first-a._ofxp._tcp.local" }))
    directory.up(service({ peerID: first, fqdn: "first-b._ofxp._tcp.local" }))
    directory.upSeed(seed({ peerID: second, source: "server", id: "second" }))
    expect(metrics.snapshot().discoveryCandidates).toBe(2)

    directory.down({ fqdn: "first-a._ofxp._tcp.local" })
    expect(metrics.snapshot().discoveryCandidates).toBe(2)
    directory.down({ fqdn: "first-b._ofxp._tcp.local" })
    expect(metrics.snapshot().discoveryCandidates).toBe(1)
    directory.clear()
    expect(metrics.snapshot().discoveryCandidates).toBe(0)
  })
})
