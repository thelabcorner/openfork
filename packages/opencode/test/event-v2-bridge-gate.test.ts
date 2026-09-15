import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Schema } from "effect"
import { GlobalBus } from "@/bus/global"
import { EventV2Bridge, hasLegacyConsumer, hasLegacySyncConsumer, registerLegacyTransport } from "@/event-v2-bridge"
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

const DurableProbe = EventV2.define({
  type: "bridge.gate.durable-probe",
  durable: { version: 1, aggregate: "aggregateID" },
  schema: { aggregateID: Schema.String, n: Schema.Number },
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
      const type = event?.payload?.type
      if (type === "bridge.gate.probe" || type === "bridge.gate.durable-probe" || type === "sync") {
        emitted.push({
          channel,
          type,
          n: type === "sync" ? event.payload.syncEvent?.data?.n : event.payload.properties?.n,
        })
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
        expect(hasLegacySyncConsumer()).toBe(true)
      } finally {
        GlobalBus.off("event", listener)
      }
      expect(hasLegacyConsumer()).toBe(false)
      expect(hasLegacySyncConsumer()).toBe(false)
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
        // `/api/event` owns native replay independently. With no compatibility
        // `/event` subscriber, the bridge ring itself stays completely idle.
        expect(events.replayLatest()).toBe(0)
      } finally {
        GlobalBus.off("event.replay", capture)
      }
    }),
  )

  it.effect("captures replay only while a compatibility range is connected", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      yield* events.publish(Probe, { n: 0 })
      expect(events.replayLatest()).toBe(0)

      const first = events.replayConnect()
      expect(first.after).toBe(0)
      yield* events.publish(Probe, { n: 1 })
      expect(events.replayLatest()).toBe(1)

      const second = events.replayConnect()
      expect(second.epoch).toBe(first.epoch)
      expect(second.after).toBe(1)
      yield* events.publish(Probe, { n: 2 })
      expect(events.replayLatest()).toBe(2)

      first.release()
      yield* events.publish(Probe, { n: 3 })
      expect(events.replayLatest()).toBe(3)
      second.release()

      // Idle publishes are not retained. The next compatibility range starts a
      // fresh epoch/window rather than pretending it can replay the idle gap.
      yield* events.publish(Probe, { n: 4 })
      expect(events.replayLatest()).toBe(3)
      const next = events.replayConnect()
      expect(next.epoch).not.toBe(first.epoch)
      expect(next.after).toBe(0)
      next.release()
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

  it.effect("interest-aware transport emits compatibility without duplicate durable sync", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      let connected = true
      let listeners = 0
      const transportListener = () => {}
      GlobalBus.on("event", transportListener)
      listeners = 1
      const unregister = registerLegacyTransport({
        isActive: () => connected,
        listenerCount: () => listeners,
        needsSync: () => false,
      })
      try {
        expect(hasLegacyConsumer()).toBe(true)
        expect(hasLegacySyncConsumer()).toBe(false)
        const { emitted } = yield* spyOnEmit(
          events.publish(DurableProbe, { aggregateID: "agg_desktop", n: 1 }),
        )
        expect(emitted.map((event) => event.type)).toEqual(["bridge.gate.durable-probe"])
      } finally {
        unregister()
        listeners = 0
        connected = false
        GlobalBus.off("event", transportListener)
      }
    }),
  )

  it.effect("direct in-process consumer keeps durable sync enabled beside an interest-aware transport", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const transportListener = () => {}
      const directListener = () => {}
      GlobalBus.on("event", transportListener)
      GlobalBus.on("event", directListener)
      const unregister = registerLegacyTransport({
        isActive: () => true,
        listenerCount: () => 1,
        needsSync: () => false,
      })
      try {
        expect(hasLegacyConsumer()).toBe(true)
        expect(hasLegacySyncConsumer()).toBe(true)
        const { emitted } = yield* spyOnEmit(
          events.publish(DurableProbe, { aggregateID: "agg_direct", n: 2 }),
        )
        expect(emitted.map((event) => event.type)).toEqual(["bridge.gate.durable-probe", "sync"])
      } finally {
        unregister()
        GlobalBus.off("event", directListener)
        GlobalBus.off("event", transportListener)
      }
    }),
  )

  it.effect("sync-capable transport keeps durable sync enabled while active", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const transportListener = () => {}
      GlobalBus.on("event", transportListener)
      const unregister = registerLegacyTransport({
        isActive: () => true,
        listenerCount: () => 1,
        needsSync: () => true,
      })
      try {
        expect(hasLegacySyncConsumer()).toBe(true)
        const { emitted } = yield* spyOnEmit(
          events.publish(DurableProbe, { aggregateID: "agg_sync", n: 3 }),
        )
        expect(emitted.map((event) => event.type)).toEqual(["bridge.gate.durable-probe", "sync"])
      } finally {
        unregister()
        GlobalBus.off("event", transportListener)
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
