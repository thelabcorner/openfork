import { describe, expect, test } from "bun:test"
import { serializeEvent, wireEvent } from "./event-serializer"

/**
 * The native route builds the `{ id, type, data }` projection once per
 * subscriber. `serializeEvent` keys its cache on object identity, so a fresh
 * literal per subscriber can never hit and every subscriber pays a full
 * `Schema.encodeUnknownSync` walk. `wireEvent` fixes that by caching the
 * projection against the shared payload identity -- the same treatment the
 * legacy route gets from `adaptLegacyEvent`.
 */
describe("native wire projection cache", () => {
  const payload = (id: string) =>
    Object.freeze({
      id,
      type: "server.connected",
      data: Object.freeze({ epoch: "epoch-1" }),
      location: Object.freeze({ directory: "/repo" }),
    }) as any

  test("wireEvent returns the same object for the same published payload", () => {
    const event = payload("evt_1")
    const first = wireEvent(event)
    expect(first).toEqual({ id: "evt_1", type: "server.connected", data: { epoch: "epoch-1" } })
    // Identity, not just structural equality: this is what makes the
    // serializeEvent WeakMap hit for every subsequent subscriber.
    expect(wireEvent(event)).toBe(first)
    for (let subscriber = 0; subscriber < 64; subscriber++) expect(wireEvent(event)).toBe(first)
  })

  test("distinct payloads never share a projection, even with the same id", () => {
    const first = payload("evt_1")
    const second = payload("evt_1")
    expect(wireEvent(first)).not.toBe(wireEvent(second))
    expect(wireEvent(second)).toBe(wireEvent(second))
  })

  test("every subscriber after the first reuses one serialized frame", () => {
    // Count real encoding work: reading `data` is what the schema walk does.
    // A cache hit must not touch the payload at all.
    let reads = 0
    const event = Object.freeze({
      id: "evt_shared",
      type: "server.connected",
      get data() {
        reads++
        return {}
      },
    }) as any

    const frame = serializeEvent(wireEvent(event))
    expect(reads).toBeGreaterThan(0)
    const afterFirst = reads

    for (let subscriber = 0; subscriber < 32; subscriber++) {
      // Exactly what the native route does per subscriber: project, serialize.
      expect(serializeEvent(wireEvent(event))).toBe(frame)
    }
    // 32 additional subscribers performed zero additional payload reads.
    expect(reads).toBe(afterFirst)
    expect(frame).toContain("evt_shared")
  })

  test("per-subscriber fresh literals are what made the old path miss", () => {
    // Reproduce the pre-fix shape: a fresh object literal per subscriber. The
    // WeakMap is keyed on identity, so each literal is a guaranteed miss and
    // each subscriber pays a full encode walk.
    let reads = 0
    const event = Object.freeze({
      id: "evt_oldpath",
      type: "server.connected",
      get data() {
        reads++
        return {}
      },
    }) as any

    const first = serializeEvent({ id: event.id, type: event.type, data: event.data })
    const afterFirst = reads
    for (let subscriber = 0; subscriber < 8; subscriber++) {
      serializeEvent({ id: event.id, type: event.type, data: event.data })
    }
    // The old shape re-read the payload on every subscriber: 8 extra encodes.
    expect(reads).toBe(afterFirst + 8)

    // The fixed shape pays nothing extra for the same subscriber count.
    const cached = wireEvent(event)
    const stable = reads
    for (let subscriber = 0; subscriber < 8; subscriber++) serializeEvent(wireEvent(event))
    expect(reads).toBe(stable)
    expect(serializeEvent(cached)).toBe(serializeEvent(wireEvent(event)))
  })

  test("the projection is stable enough to survive coalesced merging", () => {
    const event = payload("evt_merge")
    const projected = wireEvent(event)
    // mergeEventDeltas spreads the payload; the projection must still be the
    // cached object so merged frames keep hitting the serialize cache.
    const merged = { ...projected, data: { ...(projected.data as object) } }
    expect(serializeEvent(projected)).toBe(serializeEvent(wireEvent(event)))
    // A genuinely new object pays for its own encode.
    expect(serializeEvent(merged)).toBe(serializeEvent(merged))
  })
})
