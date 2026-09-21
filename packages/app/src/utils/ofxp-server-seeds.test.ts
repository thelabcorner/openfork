import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import {
  collectOfxpServerSeeds,
  createOfxpServerSeedSynchronizer,
  parseInstanceOfxpProjection,
  probeConfiguredServerOfxp,
  probeConfiguredServerOfxpSeed,
  serverSeedHost,
} from "./ofxp-server-seeds"

const peerID = `ofxp_${"A".repeat(43)}`
const fingerprint = `sha256:${"b".repeat(64)}`
const projection = {
  realmID: "realm:remote",
  instanceID: "remote-instance",
  processID: 42,
  startedAt: "2026-09-20T00:00:00.000Z",
  version: "1.18.30",
  ofxp: {
    enabled: true,
    peerID,
    fingerprint,
    protocolMin: 1,
    protocolMax: 1,
    pairing: true,
    endpointHints: [{ port: 9443 }],
  },
}

describe("OFXP configured-server seed projection", () => {
  test("strictly validates the public identity projection", () => {
    expect(parseInstanceOfxpProjection(projection)?.ofxp.enabled).toBe(true)
    expect(parseInstanceOfxpProjection({ ...projection, ofxp: { enabled: false } })?.ofxp).toEqual({
      enabled: false,
    })
    expect(parseInstanceOfxpProjection({ ...projection, ofxp: { ...projection.ofxp, peerID: "bad" } })).toBeUndefined()
    expect(
      parseInstanceOfxpProjection({ ...projection, ofxp: { ...projection.ofxp, fingerprint: "sha256:not-a-key" } }),
    ).toBeUndefined()
    expect(
      parseInstanceOfxpProjection({ ...projection, ofxp: { ...projection.ofxp, endpointHints: [{ port: 0 }] } }),
    ).toBeUndefined()
  })

  test("never sends configured credentials and never includes them in the seed", async () => {
    const connection: ServerConnection.Http = {
      type: "http",
      http: {
        url: "https://embedded-user:embedded-pass@remote.example:4096",
        username: "sensitive-user",
        password: "sensitive-password",
      },
    }
    let request: Request | undefined
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init)
      return Response.json(projection)
    }) as typeof globalThis.fetch

    const seed = await probeConfiguredServerOfxpSeed(connection, fetcher)
    expect(request?.url).toBe("https://remote.example:4096/instance/identity")
    expect(request?.headers.get("authorization")).toBeNull()
    expect(seed).toEqual({
      id: "configured:https://remote.example:4096",
      peerID,
      realmID: "realm:remote",
      openforkVersion: "1.18.30",
      protocolVersion: 1,
      pairing: true,
      endpoint: { host: "remote.example", port: 9443 },
    })
    expect(JSON.stringify(seed)).not.toContain("sensitive-user")
    expect(JSON.stringify(seed)).not.toContain("sensitive-password")
  })

  test("retains public process generation even when the source OFXP runtime is disabled", async () => {
    const connection: ServerConnection.Http = {
      type: "http",
      http: { url: "https://disabled.example", username: "user", password: "secret" },
    }
    let request: Request | undefined
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init)
      return Response.json({
        ...projection,
        instanceID: "remote-process-2",
        ofxp: { enabled: false },
      })
    }) as typeof globalThis.fetch

    expect(await probeConfiguredServerOfxp(connection, fetcher)).toEqual({
      instanceID: "remote-process-2",
      ofxp: { enabled: false },
    })
    expect(request?.headers.get("authorization")).toBeNull()
  })

  test("uses the real SSH host for seeds while still probing local identities", async () => {
    const ssh: ServerConnection.Ssh = {
      type: "ssh",
      host: "alice@workstation.example:22",
      http: { url: "http://127.0.0.1:51001", password: "proxy-secret" },
    }
    const sidecar: ServerConnection.Sidecar = {
      type: "sidecar",
      variant: "base",
      http: { url: "http://127.0.0.1:4096" },
    }
    const loopback: ServerConnection.Http = {
      type: "http",
      http: { url: "http://localhost:4096" },
    }
    expect(serverSeedHost(ssh)).toBe("workstation.example")
    expect(serverSeedHost(sidecar)).toBeUndefined()
    expect(serverSeedHost(loopback)).toBeUndefined()

    let calls = 0
    const fetcher = (async () => {
      calls++
      return Response.json(projection)
    }) as typeof globalThis.fetch
    expect(await probeConfiguredServerOfxpSeed(sidecar, fetcher)).toBeUndefined()
    expect(await probeConfiguredServerOfxpSeed(loopback, fetcher)).toBeUndefined()
    expect(calls).toBe(2)
    expect((await probeConfiguredServerOfxp(sidecar, fetcher))?.ofxp).toMatchObject({
      enabled: true,
      peerID,
      fingerprint,
      compatible: true,
    })
  })

  test("cancels an in-flight public identity probe when its caller is superseded", async () => {
    const connection: ServerConnection.Http = {
      type: "http",
      http: { url: "https://slow.example" },
    }
    const abort = new AbortController()
    let observedAbort = false
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        signal?.addEventListener(
          "abort",
          () => {
            observedAbort = true
            reject(new DOMException("Aborted", "AbortError"))
          },
          { once: true },
        )
      })) as typeof globalThis.fetch

    const pending = probeConfiguredServerOfxp(connection, fetcher, 30_000, abort.signal)
    abort.abort()
    expect(await pending).toBeUndefined()
    expect(observedAbort).toBe(true)
  })

  test("removes disabled, unhealthy, deleted, and destination servers from the reconciled snapshot", () => {
    const destination: ServerConnection.Http = { type: "http", http: { url: "https://a.example" } }
    const enabled: ServerConnection.Http = { type: "http", http: { url: "https://b.example" } }
    const disabled: ServerConnection.Http = { type: "http", http: { url: "https://c.example" } }
    const removed: ServerConnection.Http = { type: "http", http: { url: "https://removed.example" } }
    const seed = {
      id: "configured:https://b.example",
      peerID,
      realmID: "realm:remote",
      openforkVersion: "1.18.30",
      protocolVersion: 1,
      pairing: true,
      endpoint: { host: "b.example", port: 9443 },
    }

    expect(
      collectOfxpServerSeeds(
        [destination, enabled, disabled],
        {
          ["https://a.example" as ServerConnection.Key]: { healthy: true, ofxpSeed: seed },
          ["https://b.example" as ServerConnection.Key]: { healthy: true, ofxpSeed: seed },
          ["https://c.example" as ServerConnection.Key]: { healthy: true },
          ["https://removed.example" as ServerConnection.Key]: { healthy: true, ofxpSeed: seed },
        },
        "https://a.example" as ServerConnection.Key,
      ),
    ).toEqual([seed])

    expect(
      collectOfxpServerSeeds(
        [destination, enabled],
        {
          ["https://a.example" as ServerConnection.Key]: { healthy: true },
          ["https://b.example" as ServerConnection.Key]: { healthy: false, ofxpSeed: seed },
        },
        "https://a.example" as ServerConnection.Key,
      ),
    ).toEqual([])
  })

  test("serializes writes so the newest snapshot wins even when an older send is slow", async () => {
    const sync = createOfxpServerSeedSynchronizer()
    const delivered: string[] = []
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    expect(
      sync.schedule("backend-a", "A", async () => {
        delivered.push("A:start")
        markStarted()
        await first
        delivered.push("A:end")
      }),
    ).toBe(true)
    await started
    expect(
      sync.schedule("backend-a", "B", async () => {
        delivered.push("B")
      }),
    ).toBe(true)
    releaseFirst()
    await sync.flush("backend-a")

    expect(delivered).toEqual(["A:start", "A:end", "B"])
    expect(sync.schedule("backend-a", "B", async () => delivered.push("duplicate"))).toBe(false)
  })

  test("supersedes queued stale snapshots before they start", async () => {
    const sync = createOfxpServerSeedSynchronizer()
    const delivered: string[] = []
    sync.schedule("backend-b", "A", async () => delivered.push("A"))
    sync.schedule("backend-b", "B", async () => delivered.push("B"))
    await sync.flush("backend-b")
    expect(delivered).toEqual(["B"])
  })

  test("bounds dedupe state across historical destination churn", () => {
    const sync = createOfxpServerSeedSynchronizer()
    expect(sync.schedule("oldest", "same", async () => undefined)).toBe(true)
    for (let index = 0; index < 64; index++) {
      sync.schedule(`backend-${index}`, "seed", async () => undefined)
    }
    // The oldest key was evicted at the 64-destination ceiling, so revisiting
    // it must schedule a fresh authoritative snapshot rather than trusting
    // process-lifetime historical state.
    expect(sync.schedule("oldest", "same", async () => undefined)).toBe(true)
  })
})
