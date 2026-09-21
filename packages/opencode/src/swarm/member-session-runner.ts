export * as SwarmMemberSessionRunner from "./member-session-runner"

import { Context, Effect, Layer, Ref, Semaphore } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmMemberSession } from "./member-session"
import { SwarmMemberSessionWake } from "./member-session-wake"
import { make as makeCoalescedDrain } from "@/effect/coalesced-drain"

export interface Interface {
  /** Idempotent startup reconciliation + durable wake listener activation. */
  readonly start: () => Effect.Effect<void>
  /** Explicit diagnostic/test trigger; normal production convergence is event-driven. */
  readonly poke: () => Effect.Effect<void>
  /** 0 or 1 — one process-global reconciliation batch at a time. */
  readonly activeReconciliations: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmMemberSessionRunner") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const lifecycle = yield* SwarmMemberSession.Service
    const events = yield* EventV2.Service
    const wake = yield* SwarmMemberSessionWake.Service
    const started = yield* Ref.make(false)
    const startLock = Semaphore.makeUnsafe(1)
    const pending = yield* Ref.make<{ global: boolean; swarms: ReadonlySet<Swarm.ID> }>({
      global: false,
      swarms: new Set<Swarm.ID>(),
    })

    const scanOnce = Effect.fn("SwarmMemberSessionRunner.scanOnce")(function* () {
      const scope = yield* Ref.getAndSet(pending, { global: false, swarms: new Set<Swarm.ID>() })
      const results = scope.global
        ? [yield* lifecycle.reconcile()]
        : yield* Effect.forEach(
            [...scope.swarms],
            (swarmID) => lifecycle.reconcile({ swarmID }),
            { concurrency: 1 },
          )
      const failed = results.flatMap((result) => result.failed)
      if (failed.length > 0) {
        yield* Effect.logWarning("Swarm managed-member reconciliation completed with failures", {
          scanned: results.reduce((total, result) => total + result.scanned, 0),
          bound: results.reduce((total, result) => total + result.bound, 0),
          alreadyBound: results.reduce((total, result) => total + result.alreadyBound, 0),
          cleaned: results.reduce((total, result) => total + result.cleaned, 0),
          preserved: results.reduce((total, result) => total + result.preserved, 0),
          failed,
        })
      }
    })

    const drain = yield* makeCoalescedDrain({
      name: "SwarmMemberSessionRunner",
      drain: scanOnce().pipe(Effect.asVoid),
      onCause: (cause) => Effect.logError("Swarm managed-member reconciliation failed", { cause }),
    })
    const queueWake = Effect.fn("SwarmMemberSessionRunner.queueWake")(function* (swarmID?: Swarm.ID) {
      yield* Ref.update(pending, (current) => {
        if (current.global || swarmID === undefined) return { global: true, swarms: new Set<Swarm.ID>() }
        const swarms = new Set(current.swarms)
        swarms.add(swarmID)
        return { global: false, swarms }
      })
      yield* drain.wake()
    })
    const uninstallWake = yield* wake.install((swarmID) => queueWake(swarmID).pipe(Effect.ignore))
    yield* Effect.addFinalizer(() => uninstallWake)

    const start: Interface["start"] = Effect.fn("SwarmMemberSessionRunner.start")(function* () {
      yield* startLock.withPermit(
        Effect.gen(function* () {
          if (yield* Ref.get(started)) return
          yield* Ref.set(started, true)
          yield* queueWake()
        }),
      )
    })

    const poke: Interface["poke"] = Effect.fn("SwarmMemberSessionRunner.poke")(function* () {
      yield* queueWake()
    })

    const activeReconciliations: Interface["activeReconciliations"] = Effect.fn(
      "SwarmMemberSessionRunner.activeReconciliations",
    )(function* () {
      return yield* drain.active()
    })

    const unsubscribe = yield* events.listen((event) => {
      if (
        event.type !== "swarm.member.updated" &&
        event.type !== "swarm.updated" &&
        event.type !== "session.deleted"
      ) {
        return Effect.void
      }
      return queueWake().pipe(Effect.ignore)
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    yield* Effect.forkScoped(start())
    return Service.of({ start, poke, activeReconciliations })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SwarmMemberSession.node, SwarmMemberSessionWake.node, EventV2.node],
})
