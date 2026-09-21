import { expect, test } from "bun:test"
import { createOpencodeClient, type OfxpGrant, type OfxpSettingsState } from "../src/v2/client"

const state: OfxpSettingsState = {
  status: {
    active: true,
    peerID: "peer-local",
    port: 9443,
    discovery: "active",
    identityRotationSupported: true,
    rotation: { previousPeerID: "peer-local-old", expiresAt: 123_456, expired: false },
  },
  candidates: [],
  pairings: [
    {
      pairingID: "pair-rotation",
      peer: {
        id: "peer-new",
        realmID: "realm:peer",
        label: "Rotated peer",
        fingerprint: "sha256:rotation",
      },
      sas: "123456",
      expiresAt: 123_456,
      continuityClaim: { previousPeerID: "peer-old", expiresAt: 123_456 },
    },
  ],
  peers: [],
  activity: [],
}

const grant: OfxpGrant = {
  read: true,
  write: false,
  git: false,
  process: false,
  integrations: false,
  browser: false,
  filesReceive: false,
  filesSend: false,
  automation: false,
  messaging: true,
  sessionSupervision: "none",
  requestSupervision: false,
  delegation: "disabled",
  nestedDelegation: false,
}

test("OFXP settings client preserves the operator route contract", async () => {
  const requests: Request[] = []
  const client = createOpencodeClient({
    baseUrl: "http://openfork.test",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request.clone())
      return new Response(JSON.stringify(state), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  await client.ofxp.state({ throwOnError: true })
  await client.ofxp.runtime({ ofxpSettingsRuntimePayload: { enabled: true } }, { throwOnError: true })
  await client.ofxp.discovery.serverSeeds(
    {
      ofxpSettingsServerSeedsPayload: {
        seeds: [
          {
            id: "configured:http://remote.example",
            peerID: "peer-seed",
            realmID: "realm:remote",
            openforkVersion: "1.18.30",
            protocolVersion: 1,
            pairing: true,
            endpoint: { host: "remote.example", port: 9443, addresses: ["192.0.2.44"] },
          },
        ],
      },
    },
    { throwOnError: true },
  )
  await client.ofxp.rotateIdentity({ throwOnError: true })
  await client.ofxp.finalizeIdentityRotation({ throwOnError: true })
  await client.ofxp.pair({ peerID: "peer-a" }, { throwOnError: true })
  await client.ofxp.pairing.confirm({ pairingID: "pair-a" }, { throwOnError: true })
  await client.ofxp.pairing.cancel({ pairingID: "pair-b" }, { throwOnError: true })
  await client.ofxp.peer.grant(
    { peerID: "peer-a", ofxpSettingsGrantPayload: { expectedRevision: 7, grant } },
    { throwOnError: true },
  )
  await client.ofxp.peer.root.add(
    {
      peerID: "peer-a",
      ofxpSettingsRootPayload: {
        expectedRevision: 7,
        alias: "project",
        canonicalPath: "/srv/project",
        source: "project",
      },
    },
    { throwOnError: true },
  )
  await client.ofxp.peer.root.remove({ peerID: "peer-a", rootID: "root-a" }, { throwOnError: true })
  await client.ofxp.peer.revoke(
    { peerID: "peer-a", ofxpSettingsRevokePayload: { expectedRevision: 7 } },
    { throwOnError: true },
  )

  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/ofxp/state"],
    ["PATCH", "/ofxp/runtime"],
    ["PUT", "/ofxp/discovery/server-seeds"],
    ["POST", "/ofxp/runtime/rotate-identity"],
    ["POST", "/ofxp/runtime/rotation/finalize"],
    ["POST", "/ofxp/peer/peer-a/pair"],
    ["POST", "/ofxp/pairing/pair-a/confirm"],
    ["DELETE", "/ofxp/pairing/pair-b"],
    ["PATCH", "/ofxp/peer/peer-a/grant"],
    ["POST", "/ofxp/peer/peer-a/root"],
    ["DELETE", "/ofxp/peer/peer-a/root/root-a"],
    ["DELETE", "/ofxp/peer/peer-a"],
  ])

  expect(await requests[1]!.json()).toEqual({ enabled: true })
  expect(await requests[2]!.json()).toEqual({
    seeds: [
      {
        id: "configured:http://remote.example",
        peerID: "peer-seed",
        realmID: "realm:remote",
        openforkVersion: "1.18.30",
        protocolVersion: 1,
        pairing: true,
        endpoint: { host: "remote.example", port: 9443, addresses: ["192.0.2.44"] },
      },
    ],
  })
  expect(await requests[8]!.json()).toEqual({ expectedRevision: 7, grant })
  expect(await requests[9]!.json()).toEqual({
    expectedRevision: 7,
    alias: "project",
    canonicalPath: "/srv/project",
    source: "project",
  })
  expect(await requests[11]!.json()).toEqual({ expectedRevision: 7 })
})

