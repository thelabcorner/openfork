import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Schema } from "effect"
import { GlobalBus } from "@/bus/global"
import { EventV2Bridge, hasLegacyConsumer, registerLegacyTransport } from "@/event-v2-bridge"
import { testEffect } from "./lib/effect"

/**
 * The legacy bridge allocation gate.
 *
 * Regression: the gate used to be
 *   `GlobalBus.listenerCount("event") === 0 && GlobalBus.listenerCount("event.replay") === 0`
 * which can never fire, because the global HTTP route registers an
 * `event.replay` capture listener at group construction for the whole process
 * lifetime. Every publish therefore resolved the instance context, built a
 * legacy envelope and broadcast it, even with zero legacy clients connected.
 *
 * A REGISTERED listener is not a CONNECTED client. These tests pin the new
 * semantics: the gate keys off connected subscribers, and a process-lifetime
 * registration may not defeat it.
 */

const Probe = EventV2.define({
  type: "bridge.gate.probe",
  schema: { n: Schema.Number },
})

const it = testEffect(LayerNode.compile(LayerNode.group([EventV2Bridge.node])))

/**
 * Spy on `GlobalBus.emit` instead of attaching an `event` listener.
 *
 * Attaching a listener would itself open the OLD gate (which keyed off
 * `listenerCount("event")`), so a listener-based observer can never prove the
 * defect. The spy records what the bridge actually emits without registering
 * anything on the bus.
 */
function spyOnEmit<A>(body: Effect.Effect<A, any, any>) {
  return Effect.gen(function* () {
    const emitted: Array<{ channel: string; type?: string; n?: number }> = []
    const original = GlobalBus.emit.bind(GlobalBus)
    const patched = ((channel: any, event: any) => {
      if (event?.payload?.type === "bridge.gate.probe") {
        emitted.push({ channel, type: event.payload.type, n: event.payload.properties?.n })
      }
      return original(channel, event)
    }) as typeof GlobalBus.emit
    ;(GlobalBus as any).emit = patched
    try {
      const result = yield* body
      return { result, emitted }
    } finally {
      ;(GlobalBus as any).emit = original
    }
  })
}

describe("bridge allocation gate", () => {
  it.effect("a process-lifetime replay registration does not defeat the gate", () =>
    Effect.gen(function* () {
      // Reproduce exactly what global.ts does: a capture listener registered
      // for the whole process, with no client connected.
      const capture = () => {}
      GlobalBus.on("event.replay", capture)
      try {
        expect(GlobalBus.listenerCount("event.replay")).toBeGreaterThan(0)
        // The old gate was permanently false under exactly this condition.
        expect(hasLegacyConsumer()).toBe(false)
      } finally {
        GlobalBus.off("event.replay", capture)
      }
    }),
  )

  it.effect("a real 'event' listener counts as a legacy consumer", () =>
    Effect.gen(function* () {
      const listener = () => {}
      GlobalBus.on("event", listener)
      try {
        expect(hasLegacyConsumer()).toBe(true)
      } finally {
        GlobalBus.off("event", listener)
      }
      expect(hasLegacyConsumer()).toBe(false)
    }),
  )

  it.effect("a connected transport opens the gate; release closes it", () =>
    Effect.gen(function* () {
      let connected = false
      const unregister = registerLegacyTransport(() => connected)
      try {
        expect(hasLegacyConsumer()).toBe(false)
        connected = true
        expect(hasLegacyConsumer()).toBe(true)
        connected = false
        // Registered-but-idle must not count.
        expect(hasLegacyConsumer()).toBe(false)
      } finally {
        unregister()
      }
      connected = true
      expect(hasLegacyConsumer()).toBe(false)
      connected = false
    }),
  )

  it.effect("zero legacy consumers: the bridge allocates no legacy envelope", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      // Simulate the global route: a process-lifetime capture listener with no
      // client connected. This is what permanently defeated the old gate.
      const capture = () => {}
      GlobalBus.on("event.replay", capture)
      try {
        expect(GlobalBus.listenerCount("event.replay")).toBeGreaterThan(0)
        expect(GlobalBus.listenerCount("event")).toBe(0)
        expect(hasLegacyConsumer()).toBe(false)

        const { emitted } = yield* spyOnEmit(
          Effect.gen(function* () {
            for (let n = 0; n < 25; n++) yield* events.publish(Probe, { n })
          }),
        )
        // The defect: the old gate saw the replay listener and emitted anyway.
        expect(emitted).toEqual([])
        // Native sequencing is unaffected: the bridge ring still advanced.
        expect(events.replayLatest()).toBeGreaterThan(0)
      } finally {
        GlobalBus.off("event.replay", capture)
      }
    }),
  )

  it.effect("a connected transport alone makes the bridge emit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      let connected = false
      const unregister = registerLegacyTransport(() => connected)
      try {
        connected = true
        expect(hasLegacyConsumer()).toBe(true)
        const { emitted } = yield* spyOnEmit(
          Effect.gen(function* () {
            for (let n = 0; n < 3; n++) yield* events.publish(Probe, { n })
          }),
        )
        expect(emitted.map((e) => e.n)).toEqual([0, 1, 2])
        expect(emitted.every((e) => e.channel === "event")).toBe(true)
      } finally {
        unregister()
        connected = false
      }
    }),
  )

  it.effect("an idle transport does not make the bridge emit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const unregister = registerLegacyTransport(() => false)
      try {
        expect(hasLegacyConsumer()).toBe(false)
        const { emitted } = yield* spyOnEmit(
          Effect.gen(function* () {
            for (let n = 0; n < 5; n++) yield* events.publish(Probe, { n })
          }),
        )
        expect(emitted).toEqual([])
      } finally {
        unregister()
      }
    }),
  )
})
