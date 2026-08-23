import { describe, expect } from "bun:test"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Device, PAIRING, CLAIM_RATE_LIMIT } from "@opencode-ai/core/device"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Device.node))

describe("Device", () => {
  it.effect("creates, verifies, lists, and revokes devices", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const created = yield* devices.create({ name: "iPhone" })

      expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(created.device.tokenPrefix).toBe(created.token.slice(0, 8))
      expect(created.device.name).toBe("iPhone")
      expect(created.device.revokedAt).toBeUndefined()

      expect(yield* devices.verify(created.token)).toEqual(created.device)
      expect(yield* devices.verify("not-a-real-token")).toBeUndefined()

      const listed = yield* devices.list()
      expect(listed).toHaveLength(1)
      expect(listed[0]?.id).toBe(created.device.id)

      expect(yield* devices.revoke(created.device.id)).toBe(true)
      expect(yield* devices.verify(created.token)).toBeUndefined()
      const revoked = (yield* devices.list())[0]
      expect(revoked?.revokedAt).toBeDefined()
      // Revoking twice is idempotent; unknown ids report false.
      expect(yield* devices.revoke(created.device.id)).toBe(true)
      expect(yield* devices.revoke("dev_missing")).toBe(false)
    }),
  )

  it.effect("touch records last-seen", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const created = yield* devices.create()
      expect(created.device.lastSeenAt).toBeUndefined()
      yield* devices.touch(created.device.id)
      expect((yield* devices.verify(created.token))?.lastSeenAt).toBeDefined()
    }),
  )

  it.effect("pairing ceremony: claim mints a one-time device token", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const pairing = yield* devices.beginPairing()

      expect(pairing.code).toMatch(new RegExp(`^[${PAIRING.alphabet}]{${PAIRING.codeLength}}$`))
      expect(new Date(pairing.expiresAt).getTime()).toBeGreaterThan(0)

      const claimed = yield* devices.claim({ code: pairing.code.toLowerCase(), ip: "10.0.0.1", name: "Phone" })
      expect(claimed.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(claimed.device.name).toBe("Phone")
      expect(yield* devices.verify(claimed.token)).toBeDefined()

      // Single-use: the same code cannot claim twice.
      const again = yield* devices.claim({ code: pairing.code }).pipe(Effect.flip)
      expect(again._tag).toBe("PairCodeError")
      expect(again.reason).toBe("invalid")
    }),
  )

  it.effect("pairing code dies after the configured number of failed attempts", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const pairing = yield* devices.beginPairing()

      for (let i = 0; i < PAIRING.maxAttempts - 1; i++) {
        const error = yield* Effect.flip(devices.claim({ code: "WRONG" }))
        expect(error.reason).toBe("invalid")
      }
      // The correct code still works before the cap is hit.
      yield* devices.claim({ code: pairing.code })
    }),
  )

  it.effect("pairing code is exhausted after max failed attempts", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const pairing = yield* devices.beginPairing()

      for (let i = 0; i < PAIRING.maxAttempts; i++) {
        const error = yield* Effect.flip(devices.claim({ code: "WRONG" }))
        expect(error.reason).toBe("invalid")
      }
      const dead = yield* Effect.flip(devices.claim({ code: pairing.code }))
      expect(dead.reason).toBe("exhausted")
    }),
  )

  it.effect("pairing code expires after the TTL", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const pairing = yield* devices.beginPairing()
      yield* TestClock.adjust(PAIRING.ttlMs + 1)
      const error = yield* Effect.flip(devices.claim({ code: pairing.code }))
      expect(error.reason).toBe("expired")
    }),
  )

  it.effect("claim rate-limits per client IP", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      for (let i = 0; i < CLAIM_RATE_LIMIT.burst; i++) {
        yield* Effect.flip(devices.claim({ code: "NOPE", ip: "192.168.0.9" })).pipe(Effect.ignore)
      }
      const limited = yield* Effect.flip(devices.claim({ code: "NOPE", ip: "192.168.0.9" }))
      expect(limited._tag).toBe("ClaimRateLimitedError")
      expect(limited.retryAfterMs).toBeGreaterThan(0)
      // A different IP is unaffected.
      yield* Effect.flip(devices.claim({ code: "NOPE", ip: "192.168.0.10" }))
    }),
  )
})
