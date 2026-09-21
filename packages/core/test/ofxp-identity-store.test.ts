import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OfxpIdentityStore } from "@opencode-ai/core/ofxp-peer/identity-store"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpRekey } from "@opencode-ai/core/ofxp-peer/rekey"
import { tmpdir } from "./fixture/tmpdir"

describe("OFXP identity store", () => {
  test("atomically converges concurrent creators on one durable peer identity", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "ofxp", "identity.json")
    const stores = Array.from({ length: 16 }, () => new OfxpIdentityStore.FileStore(file))
    const keys = await Promise.all(stores.map((store) => OfxpIdentityStore.loadOrCreate(store)))

    expect(new Set(keys.map((key) => key.peerID)).size).toBe(1)
    expect(new Set(keys.map((key) => key.fingerprint)).size).toBe(1)
    const reopened = await OfxpIdentityStore.loadOrCreate(new OfxpIdentityStore.FileStore(file))
    expect(reopened.peerID).toBe(keys[0]!.peerID)
  })

  test("fails closed on corrupt durable identity instead of silently rotating it", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "ofxp", "identity.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{definitely-not-json", { encoding: "utf8", mode: 0o600 })

    await expect(OfxpIdentityStore.loadOrCreate(new OfxpIdentityStore.FileStore(file))).rejects.toThrow(
      "Stored OFXP identity material is invalid JSON",
    )
    expect(await fs.readFile(file, "utf8")).toBe("{definitely-not-json")
  })

  test("rejects an oversized identity file before parsing", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "ofxp", "identity.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "x".repeat(40 * 1024), { encoding: "utf8", mode: 0o600 })
    await expect(new OfxpIdentityStore.FileStore(file).read()).rejects.toThrow("unexpectedly large")
  })

  test("compare-and-swaps one durable identity and rejects a stale writer", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "ofxp", "identity.json")
    const store = new OfxpIdentityStore.FileStore(file)
    const current = await OfxpIdentityStore.loadOrCreate(store)
    const next = OfxpIdentity.generateKeyPair()

    expect(await OfxpIdentityStore.rotateIfCurrent(store, current, next)).toBe(true)
    expect((await OfxpIdentityStore.loadOrCreate(store)).peerID).toBe(next.peerID)

    const staleNext = OfxpIdentity.generateKeyPair()
    expect(await OfxpIdentityStore.rotateIfCurrent(store, current, staleNext)).toBe(false)
    expect((await OfxpIdentityStore.loadOrCreate(store)).peerID).toBe(next.peerID)
  })

  test("admits exactly one concurrent identity rotation from the same expected key", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "ofxp", "identity.json")
    const initialStore = new OfxpIdentityStore.FileStore(file)
    const current = await OfxpIdentityStore.loadOrCreate(initialStore)
    const candidates = Array.from({ length: 8 }, () => OfxpIdentity.generateKeyPair())
    const stores = candidates.map(() => new OfxpIdentityStore.FileStore(file))

    const results = await Promise.all(
      stores.map((store, index) => OfxpIdentityStore.rotateIfCurrent(store, current, candidates[index]!)),
    )
    expect(results.filter(Boolean)).toHaveLength(1)

    const winner = candidates[results.findIndex(Boolean)]!
    const reopened = await OfxpIdentityStore.loadOrCreate(new OfxpIdentityStore.FileStore(file))
    expect(reopened.peerID).toBe(winner.peerID)
    expect(reopened.fingerprint).toBe(winner.fingerprint)
  })

  test("atomically persists the replacement key with its crash-recovery continuity proof", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "ofxp", "identity.json")
    const store = new OfxpIdentityStore.FileStore(file)
    const current = await OfxpIdentityStore.loadOrCreate(store)
    const next = OfxpIdentity.generateKeyPair()
    const nextIdentity = {
      id: next.peerID,
      realmID: "realm:store-rekey",
      label: "Rotated",
      publicKeySpki: next.publicKeySpki,
      fingerprint: next.fingerprint,
    }
    const proof = OfxpRekey.create({
      current,
      currentRealmID: nextIdentity.realmID,
      next: nextIdentity,
      now: 1_000,
    })

    expect(await OfxpIdentityStore.rotateIfCurrent(store, current, next, proof)).toBe(true)
    const reopened = await OfxpIdentityStore.loadOrCreateStored(new OfxpIdentityStore.FileStore(file))
    expect(reopened.key.peerID).toBe(next.peerID)
    expect(reopened.continuityProof).toEqual(proof)
  })

  test("clears only the current key's continuity proof with an exact record CAS", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "ofxp", "identity.json")
    const store = new OfxpIdentityStore.FileStore(file)
    const current = await OfxpIdentityStore.loadOrCreate(store)
    const next = OfxpIdentity.generateKeyPair()
    const nextIdentity = {
      id: next.peerID,
      realmID: "realm:clear-rekey",
      label: "Rotated",
      publicKeySpki: next.publicKeySpki,
      fingerprint: next.fingerprint,
    }
    const proof = OfxpRekey.create({
      current,
      currentRealmID: nextIdentity.realmID,
      next: nextIdentity,
      now: 5_000,
    })
    expect(await OfxpIdentityStore.rotateIfCurrent(store, current, next, proof)).toBe(true)

    expect(await OfxpIdentityStore.clearContinuityProofIfCurrent(store, next)).toBe(true)
    const cleared = await OfxpIdentityStore.loadOrCreateStored(store)
    expect(cleared.key.peerID).toBe(next.peerID)
    expect(cleared.continuityProof).toBeUndefined()

    expect(await OfxpIdentityStore.clearContinuityProofIfCurrent(store, current)).toBe(false)
  })

  test("observes atomic cross-process identity replacement without exposing key material", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "ofxp", "identity.json")
    const writer = new OfxpIdentityStore.FileStore(file)
    const observer = new OfxpIdentityStore.FileStore(file)
    const current = await OfxpIdentityStore.loadOrCreate(writer)
    const next = OfxpIdentity.generateKeyPair()
    let notifications = 0
    let resolve!: () => void
    const changed = new Promise<void>((done) => {
      resolve = done
    })
    const stop = observer.watch(
      () => {
        notifications++
        resolve()
      },
      { intervalMs: 50 },
    )

    expect(OfxpIdentityStore.supportsWatch(observer)).toBe(true)
    expect(await OfxpIdentityStore.rotateIfCurrent(writer, current, next)).toBe(true)
    await Promise.race([
      changed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("identity watch timed out")), 2_000)),
    ])
    expect(notifications).toBeGreaterThan(0)
    expect((await OfxpIdentityStore.loadOrCreate(observer)).peerID).toBe(next.peerID)

    stop()
    const afterStop = notifications
    const third = OfxpIdentity.generateKeyPair()
    expect(await OfxpIdentityStore.rotateIfCurrent(writer, next, third)).toBe(true)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
    expect(notifications).toBe(afterStop)
  })
})
