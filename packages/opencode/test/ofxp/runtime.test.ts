import { describe, expect, spyOn } from "bun:test"
import path from "node:path"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpIdentityStore } from "@opencode-ai/core/ofxp-peer/identity-store"
import { OfxpPairing } from "@opencode-ai/core/ofxp-peer/pairing"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpRekey } from "@opencode-ai/core/ofxp-peer/rekey"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { Config } from "../../src/config/config"
import { OfxpCapability } from "../../src/ofxp/capability"
import { OfxpCertificate } from "../../src/ofxp/certificate"
import { OfxpConnectionManager } from "../../src/ofxp/connection-manager"
import { OfxpRuntime } from "../../src/ofxp/runtime"
import { OfxpTransport } from "../../src/ofxp/transport"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

class MemoryStore implements OfxpIdentityStore.RotatableStore {
  value?: string
  async read() {
    return this.value
  }
  async writeIfAbsent(value: string) {
    if (this.value !== undefined) return false
    this.value = value
    return true
  }
  async replaceIfCurrent(expected: string, value: string) {
    if (this.value === undefined) return false
    const current = OfxpIdentityStore.parse(this.value)
    const wanted = OfxpIdentityStore.parse(expected)
    if (
      current.peerID !== wanted.peerID ||
      current.fingerprint !== wanted.fingerprint ||
      current.privateKeyPkcs8 !== wanted.privateKeyPkcs8
    ) {
      return false
    }
    this.value = value
    return true
  }
}

class CreateOnlyMemoryStore implements OfxpIdentityStore.Store {
  value?: string
  async read() {
    return this.value
  }
  async writeIfAbsent(value: string) {
    if (this.value !== undefined) return false
    this.value = value
    return true
  }
}

class ConcurrentWinnerMemoryStore extends MemoryStore {
  override async replaceIfCurrent(expected: string, value: string) {
    if (this.value === undefined) return false
    const current = OfxpIdentityStore.parse(this.value)
    const wanted = OfxpIdentityStore.parse(expected)
    if (
      current.peerID !== wanted.peerID ||
      current.fingerprint !== wanted.fingerprint ||
      current.privateKeyPkcs8 !== wanted.privateKeyPkcs8
    ) {
      return false
    }
    // Simulate another process winning publication immediately before this
    // process receives its CAS result.
    this.value = value
    return false
  }
}

function generated(label: string, realmID = "realm:remote") {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID,
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    } satisfies Ofxp.PeerIdentity,
  }
}

const configState = { enabled: false, failWrites: false }
const configLayer = Layer.mock(Config.Service, {
  getGlobal: () => Effect.succeed({ ofxp: { enabled: configState.enabled } }),
  updateGlobal: (patch) =>
    configState.failWrites
      ? Effect.die(new Error("simulated global config write failure"))
      : Effect.sync(() => {
          const next = patch.ofxp?.enabled ?? configState.enabled
          const changed = next !== configState.enabled
          configState.enabled = next
          return { info: { ofxp: { enabled: next } }, changed }
        }),
})

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Global.node, OfxpPeer.node, OfxpRuntime.node]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [Global.node, Global.layerWith({ state: "/tmp/ofxp-runtime-test-state" })],
    [Config.node, configLayer],
  ],
)
const it = testEffect(layer)

const authorityRemote = generated("Authority change remote")
const stableAuthorityRecord = (): OfxpPeer.Record => ({
  info: {
    id: authorityRemote.key.peerID,
    realmID: authorityRemote.identity.realmID,
    label: authorityRemote.identity.label,
    fingerprint: authorityRemote.key.fingerprint,
    rekeyState: "stable",
    pairedAt: 1,
    grantRevision: 1,
  },
  publicKeySpki: authorityRemote.key.publicKeySpki,
  grant: { ...Ofxp.DENY_GRANT },
})
let authorityRecord = stableAuthorityRecord()
let authorityListener: OfxpPeer.ChangeListener | undefined
const authorityPeerLayer = Layer.mock(OfxpPeer.Service, {
  get: (peerID) =>
    peerID === authorityRecord.info.id
      ? Effect.succeed(authorityRecord)
      : Effect.fail(new OfxpPeer.OfxpPeerSchema.NotFoundError({ peerID })),
  subscribe: (listener) => {
    authorityListener = listener
    return () => {
      if (authorityListener === listener) authorityListener = undefined
    }
  },
})
const authorityLayer = AppNodeBuilder.build(
  LayerNode.group([Global.node, OfxpPeer.node, OfxpCapability.node, OfxpRuntime.node]),
  [
    [Global.node, Global.layerWith({ state: "/tmp/ofxp-runtime-authority-test-state" })],
    [Config.node, configLayer],
    [OfxpPeer.node, authorityPeerLayer],
    [OfxpCapability.node, Layer.mock(OfxpCapability.Service, { dispatch: () => Effect.succeed({}) })],
  ],
)
const authorityIt = testEffect(authorityLayer)

const waitFor = (predicate: () => Effect.Effect<boolean>, timeoutMs = 4_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!(yield* predicate())) {
      if (Date.now() >= deadline) return false
      yield* Effect.sleep("50 millis")
    }
    return true
  })

describe("OFXP process-global runtime", () => {
  authorityIt.live("invalidates pooled transport on sibling authority changes without conflating pairing authority", () =>
    Effect.gen(function* () {
      configState.enabled = false
      configState.failWrites = false
      authorityRecord = stableAuthorityRecord()
      const runtime = yield* OfxpRuntime.Service
      const closePeer = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(OfxpConnectionManager.Manager.prototype, "closePeer").mockImplementation(async () => undefined),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      const cancelPeer = yield* Effect.acquireRelease(
        Effect.sync(() => spyOn(OfxpPairing.Coordinator.prototype, "cancelPeer")),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )

      yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Authority runtime",
        identityStore: new MemoryStore(),
      })
      expect(authorityListener).toBeDefined()

      authorityListener!({ peerID: authorityRemote.key.peerID, kind: "authority-changed" })
      expect(
        yield* waitFor(() => Effect.sync(() => closePeer.mock.calls.some(([peerID]) => peerID === authorityRemote.key.peerID))),
      ).toBe(true)
      expect(cancelPeer.mock.calls.some(([peerID]) => peerID === authorityRemote.key.peerID)).toBe(false)

      authorityRecord = {
        ...authorityRecord,
        info: { ...authorityRecord.info, revokedAt: Date.now() },
      }
      authorityListener!({ peerID: authorityRemote.key.peerID, kind: "authority-changed" })
      expect(
        yield* waitFor(() => Effect.sync(() => cancelPeer.mock.calls.some(([peerID]) => peerID === authorityRemote.key.peerID))),
      ).toBe(true)

      yield* runtime.stop()
    }),
  )

  it.effect("is inactive and allocation-free until explicitly started", () =>
    Effect.gen(function* () {
      const runtime = yield* OfxpRuntime.Service
      expect(yield* runtime.status()).toEqual({ active: false, discovery: "disabled" })
      expect(yield* runtime.candidates()).toEqual([])
      expect(yield* runtime.connectionStatuses()).toEqual([])
      expect(yield* runtime.pairingPreviews()).toEqual([])
    }),
  )

  it.effect("retains sanitized ServerConnection seeds across disabled state and serves them without mDNS", () =>
    Effect.gen(function* () {
      const runtime = yield* OfxpRuntime.Service
      const remote = generated("Configured server seed", "realm:configured-server")
      expect(yield* runtime.bootstrap()).toEqual({ enabled: false })

      expect(
        yield* runtime.replaceServerSeeds([
          {
            source: "known",
            id: "configured:http://remote.example",
            peerID: remote.key.peerID,
            realmID: remote.identity.realmID,
            openforkVersion: "9.9.9",
            protocolVersion: 1,
            pairing: true,
            endpoint: { host: "remote.example", port: 9443, addresses: ["192.0.2.44", "not-an-ip"] },
          },
        ]),
      ).toBe(1)
      expect(yield* runtime.candidates()).toEqual([])

      const started = yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Seed target",
        identityStore: new MemoryStore(),
      })
      expect(started.discovery).toBe("disabled")
      if (started.peerID === undefined || started.port === undefined) {
        throw new Error("OFXP runtime start did not report its bound listener identity")
      }
      const bootstrap = yield* runtime.bootstrap()
      expect(bootstrap.enabled).toBe(true)
      if (!bootstrap.enabled) throw new Error("OFXP bootstrap unexpectedly disabled")
      expect(bootstrap.peerID).toBe(started.peerID)
      expect(bootstrap.fingerprint).toStartWith("sha256:")
      expect(bootstrap.protocolMin).toBe(1)
      expect(bootstrap.protocolMax).toBe(1)
      expect(bootstrap.endpointHints).toEqual([{ port: started.port }])
      expect(JSON.stringify(bootstrap)).not.toContain("privateKey")
      expect(JSON.stringify(bootstrap)).not.toContain("password")

      const previousPublicOrigin = process.env.OPENCODE_PUBLIC_URL
      process.env.OPENCODE_PUBLIC_URL = "https://api.example.com/"
      try {
        const advertised = yield* runtime.bootstrap()
        expect(advertised.enabled).toBe(true)
        if (!advertised.enabled) throw new Error("OFXP bootstrap unexpectedly disabled")
        expect(advertised.publicOrigin).toBe("https://api.example.com")
      } finally {
        if (previousPublicOrigin === undefined) delete process.env.OPENCODE_PUBLIC_URL
        else process.env.OPENCODE_PUBLIC_URL = previousPublicOrigin
      }

      const [candidate] = yield* runtime.candidates()
      expect(candidate?.peerID).toBe(remote.key.peerID)
      expect(candidate?.realmID).toBe(remote.identity.realmID)
      expect(candidate?.instances).toEqual([
        {
          source: "server",
          id: "configured:http://remote.example",
          endpoint: { host: "remote.example", port: 9443, addresses: ["192.0.2.44"] },
        },
      ])

      expect(yield* runtime.replaceServerSeeds([])).toBe(0)
      expect(yield* runtime.candidates()).toEqual([])
      yield* runtime.stop()
    }),
  )

  it.effect("starts one listener, preserves identity across restart, and stops convergently", () =>
    Effect.gen(function* () {
      const runtime = yield* OfxpRuntime.Service
      const store = new MemoryStore()
      const first = yield* runtime.start({ host: "127.0.0.1", discovery: false, label: "Desktop", identityStore: store })
      expect(first.active).toBe(true)
      expect(first.discovery).toBe("disabled")
      expect(first.port).toBeGreaterThan(0)
      const duplicate = yield* runtime.start({ host: "127.0.0.1", discovery: false, identityStore: store })
      expect(duplicate.port).toBe(first.port)
      expect(duplicate.peerID).toBe(first.peerID)

      yield* runtime.stop()
      expect((yield* runtime.status()).active).toBe(false)

      const second = yield* runtime.start({ host: "127.0.0.1", discovery: false, label: "Desktop", identityStore: store })
      expect(second.peerID).toBe(first.peerID)
      yield* runtime.stop()
    }),
  )

  it.effect("persists the operator enable preference only after the runtime transition succeeds", () =>
    Effect.gen(function* () {
      configState.enabled = false
      configState.failWrites = false
      const runtime = yield* OfxpRuntime.Service
      const store = new MemoryStore()
      const enabled = yield* runtime.setEnabled(true, {
        host: "127.0.0.1",
        discovery: false,
        label: "Desktop",
        identityStore: store,
      })
      expect(enabled.active).toBe(true)
      expect(configState.enabled).toBe(true)

      const disabled = yield* runtime.setEnabled(false)
      expect(disabled.active).toBe(false)
      expect(configState.enabled).toBe(false)
    }),
  )

  it.effect("restores the pre-call runtime state when preference persistence fails", () =>
    Effect.gen(function* () {
      configState.enabled = false
      configState.failWrites = true
      const runtime = yield* OfxpRuntime.Service
      const store = new MemoryStore()

      const failedEnable = yield* Effect.exit(
        runtime.setEnabled(true, {
          host: "127.0.0.1",
          discovery: false,
          label: "Desktop",
          identityStore: store,
        }),
      )
      expect(Exit.isFailure(failedEnable)).toBe(true)
      expect((yield* runtime.status()).active).toBe(false)
      expect(configState.enabled).toBe(false)

      configState.failWrites = false
      yield* runtime.setEnabled(true, {
        host: "127.0.0.1",
        discovery: false,
        label: "Desktop",
        identityStore: store,
      })
      expect((yield* runtime.status()).active).toBe(true)
      expect(configState.enabled).toBe(true)

      configState.failWrites = true
      const failedDisable = yield* Effect.exit(runtime.setEnabled(false))
      expect(Exit.isFailure(failedDisable)).toBe(true)
      expect((yield* runtime.status()).active).toBe(true)
      expect(configState.enabled).toBe(true)

      configState.failWrites = false
      yield* runtime.setEnabled(false)
      expect((yield* runtime.status()).active).toBe(false)
      expect(configState.enabled).toBe(false)
    }),
  )

  it.effect("rotates the durable identity, restarts on the same listener port, and retains continuity across restart", () =>
    Effect.gen(function* () {
      const runtime = yield* OfxpRuntime.Service
      const store = new MemoryStore()
      const first = yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Desktop",
        identityStore: store,
      })
      expect(first.peerID).toBeDefined()
      expect(first.port).toBeGreaterThan(0)

      const rotated = yield* runtime.rotateIdentity(first.peerID!)
      expect(rotated.active).toBe(true)
      expect(rotated.peerID).not.toBe(first.peerID)
      expect(rotated.port).toBe(first.port)
      expect(rotated.rotation?.previousPeerID).toBe(first.peerID)
      const rotatedPeerID = rotated.peerID!

      const durable = yield* Effect.promise(() => OfxpIdentityStore.loadOrCreateStored(store))
      expect(durable.key.peerID).toBe(rotatedPeerID)
      expect(durable.continuityProof?.previousPeerID).toBe(first.peerID)
      expect(durable.continuityProof?.next.id).toBe(rotatedPeerID)

      const remote = generated("Remote verifier")
      const remoteMaterial = yield* Effect.promise(() => OfxpCertificate.issue(remote.key))
      const remotePairing = new OfxpPairing.Coordinator(remote.identity)
      const offer = remotePairing.begin()
      const response = yield* Effect.promise(() =>
        OfxpTransport.offerPairing({
          material: remoteMaterial,
          endpoint: { host: "127.0.0.1", port: rotated.port! },
          expectedPeerID: rotatedPeerID,
          offer,
        }),
      )
      const preview = remotePairing.acceptAnswer(response.answer)
      expect(preview.rekeyProof?.previousPeerID).toBe(first.peerID)
      expect(preview.rekeyProof?.next.id).toBe(rotatedPeerID)

      yield* runtime.stop()
      const restarted = yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Desktop",
        identityStore: store,
      })
      expect(restarted.peerID).toBe(rotatedPeerID)
      expect(restarted.rotation?.previousPeerID).toBe(first.peerID)
      yield* runtime.stop()
    }),
  )

  it.effect("does not mutate trust for a rotated remote peer until fresh SAS confirmation", () =>
    Effect.gen(function* () {
      const runtime = yield* OfxpRuntime.Service
      const peers = yield* OfxpPeer.Service
      const store = new MemoryStore()
      const local = yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Local verifier",
        identityStore: store,
      })

      const previous = generated("Remote previous", "realm:remote-rotation")
      const next = generated("Remote next", previous.identity.realmID)
      const oldTrusted = yield* peers.trust({ identity: previous.identity })
      yield* peers.setGrant({
        peerID: previous.key.peerID,
        expectedRevision: oldTrusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, messaging: true },
      })
      const proof = OfxpRekey.create({
        current: previous.key,
        currentRealmID: previous.identity.realmID,
        next: next.identity,
      })

      const remoteMaterial = yield* Effect.promise(() => OfxpCertificate.issue(next.key))
      const remotePairing = new OfxpPairing.Coordinator(next.identity)
      const offer = remotePairing.begin(Date.now(), proof)
      const response = yield* Effect.promise(() =>
        OfxpTransport.offerPairing({
          material: remoteMaterial,
          endpoint: { host: "127.0.0.1", port: local.port! },
          expectedPeerID: local.peerID!,
          offer,
        }),
      )
      const remotePreview = remotePairing.acceptAnswer(response.answer)
      const localPreview = (yield* runtime.pairingPreviews()).find((item) => item.pairingID === offer.pairingID)
      expect(localPreview?.sas).toBe(remotePreview.sas)
      expect(localPreview?.rekeyProof?.previousPeerID).toBe(previous.key.peerID)

      // Merely receiving valid continuity proof is not a trust mutation.
      expect((yield* peers.list()).map((item) => item.info.id)).toEqual([previous.key.peerID])
      const before = yield* peers.get(previous.key.peerID)
      expect(before.info.revokedAt).toBeUndefined()
      expect(before.grant.messaging).toBe(true)

      const confirmed = yield* runtime.confirmPairing(offer.pairingID)
      expect(confirmed.info.id).toBe(next.key.peerID)
      expect(confirmed.grant).toEqual(Ofxp.DENY_GRANT)
      expect(confirmed.info.grantRevision).toBe(1)

      const after = yield* peers.list({ includeRevoked: true })
      const old = after.find((item) => item.info.id === previous.key.peerID)
      expect(old?.info.revokedAt).toBeDefined()
      expect(old?.info.rekeyState).toBe("required")
      expect((yield* peers.list()).map((item) => item.info.id)).toEqual([next.key.peerID])
      yield* runtime.stop()
    }),
  )

  it.effect("fails closed without changing identity when the configured store cannot rotate atomically", () =>
    Effect.gen(function* () {
      const runtime = yield* OfxpRuntime.Service
      const store = new CreateOnlyMemoryStore()
      const first = yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Non-rotatable",
        identityStore: store,
      })
      const result = yield* Effect.exit(runtime.rotateIdentity(first.peerID!))
      expect(Exit.isFailure(result)).toBe(true)
      const current = yield* runtime.status()
      expect(current.active).toBe(true)
      expect(current.peerID).toBe(first.peerID)
      yield* runtime.stop()
    }),
  )

  it.effect("converges on the durable winner when another process wins the rotation CAS", () =>
    Effect.gen(function* () {
      const runtime = yield* OfxpRuntime.Service
      const store = new ConcurrentWinnerMemoryStore()
      const first = yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Concurrent rotation",
        identityStore: store,
      })

      const converged = yield* runtime.rotateIdentity(first.peerID!)
      expect(converged.active).toBe(true)
      expect(converged.peerID).not.toBe(first.peerID)
      expect(converged.rotation?.previousPeerID).toBe(first.peerID)
      const convergedPeerID = converged.peerID!
      expect((yield* runtime.status()).peerID).toBe(convergedPeerID)

      const durable = yield* Effect.promise(() => OfxpIdentityStore.loadOrCreateStored(store))
      expect(durable.key.peerID).toBe(convergedPeerID)
      expect(durable.continuityProof?.previousPeerID).toBe(first.peerID)
      yield* runtime.stop()
    }),
  )

  it.live("automatically retires a superseded listener and converges to an externally rotated FileStore identity", () =>
    Effect.gen(function* () {
      const runtime = yield* OfxpRuntime.Service
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
      )
      const file = path.join(tmp.path, "ofxp", "identity.json")
      const observer = new OfxpIdentityStore.FileStore(file)
      const writer = new OfxpIdentityStore.FileStore(file)
      const first = yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Cross-process identity",
        identityStore: observer,
      })
      const durable = yield* Effect.promise(() => OfxpIdentityStore.loadOrCreateStored(writer))
      expect(first.peerID).toBe(durable.key.peerID)

      const next = OfxpIdentity.generateKeyPair()
      expect(yield* Effect.promise(() => OfxpIdentityStore.rotateIfCurrent(writer, durable.key, next))).toBe(true)
      expect(
        yield* waitFor(
          Effect.fnUntraced(function* () {
            return (yield* runtime.status()).peerID === next.peerID
          }),
        ),
      ).toBe(true)

      const converged = yield* runtime.status()
      expect(converged.active).toBe(true)
      expect(converged.peerID).toBe(next.peerID)
      expect(converged.port).toBe(first.port)
      yield* runtime.stop()
    }),
  )

  it.effect("fences rotation generation and requires proof expiry plus explicit finalization before another rotation", () =>
    Effect.gen(function* () {
      const runtime = yield* OfxpRuntime.Service
      const store = new MemoryStore()
      const first = yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Finalize rotation",
        identityStore: store,
      })
      const previousStored = yield* Effect.promise(() => OfxpIdentityStore.loadOrCreateStored(store))
      const rotated = yield* runtime.rotateIdentity(first.peerID!)
      expect(rotated.rotation?.previousPeerID).toBe(first.peerID)
      expect(rotated.rotation?.expired).toBe(false)
      const rotatedPeerID = rotated.peerID!

      const staleFinalize = yield* Effect.exit(runtime.finalizeIdentityRotation(first.peerID!))
      expect(Exit.isFailure(staleFinalize)).toBe(true)

      const blocked = yield* Effect.exit(runtime.rotateIdentity(rotatedPeerID))
      expect(Exit.isFailure(blocked)).toBe(true)

      const earlyFinalize = yield* Effect.exit(runtime.finalizeIdentityRotation(rotatedPeerID))
      expect(Exit.isFailure(earlyFinalize)).toBe(true)
      const stillPending = yield* Effect.promise(() => OfxpIdentityStore.loadOrCreateStored(store))
      expect(stillPending.continuityProof?.previousPeerID).toBe(first.peerID)

      // Recreate the same persisted continuity relationship with a valid old-key
      // signature whose cryptographic window has already expired. This models a
      // restart after the five-minute continuity interval without waiting in-test.
      yield* runtime.stop()
      const currentStored = yield* Effect.promise(() => OfxpIdentityStore.loadOrCreateStored(store))
      const currentProof = currentStored.continuityProof!
      const expiredProof = OfxpRekey.create({
        current: previousStored.key,
        currentRealmID: currentProof.next.realmID,
        next: currentProof.next,
        now: Date.now() - OfxpRekey.TTL_MS - 1,
      })
      expect(
        yield* Effect.promise(() =>
          OfxpIdentityStore.rotateIfCurrent(store, currentStored.key, currentStored.key, expiredProof),
        ),
      ).toBe(true)

      const restarted = yield* runtime.start({
        host: "127.0.0.1",
        discovery: false,
        label: "Finalize rotation",
        identityStore: store,
      })
      expect(restarted.peerID).toBe(rotatedPeerID)
      expect(restarted.rotation?.expired).toBe(true)

      const finalized = yield* runtime.finalizeIdentityRotation(rotatedPeerID)
      expect(finalized.peerID).toBe(rotatedPeerID)
      expect(finalized.rotation).toBeUndefined()
      const durable = yield* Effect.promise(() => OfxpIdentityStore.loadOrCreateStored(store))
      expect(durable.key.peerID).toBe(rotatedPeerID)
      expect(durable.continuityProof).toBeUndefined()

      const second = yield* runtime.rotateIdentity(rotatedPeerID)
      expect(second.peerID).not.toBe(rotatedPeerID)
      expect(second.rotation?.previousPeerID).toBe(rotatedPeerID)
      yield* runtime.stop()
    }),
  )
})
