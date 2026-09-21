export * as SwarmRecovery from "./recovery"

import { Context, Effect, Layer, Ref, Semaphore } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"

/** Heartbeat age is only a cheap candidate gate. It never proves death. */
export const OWNER_SUSPECT_MS = RuntimeOwner.HEARTBEAT_INTERVAL_MS * 3
export const OWNER_RECHECK_MS = RuntimeOwner.HEARTBEAT_INTERVAL_MS
export const OWNER_SCAN_BATCH = 32

export interface ReconcileResult {
  readonly scannedOwners: number
  readonly retiredLeases: number
  /** Earliest time this reconciler should be called again. */
  readonly nextProbeAt?: number
}

export interface Interface {
  /**
   * Reconcile scheduler owners from fresh durable Swarm rows.
   *
   * This service owns no timer. The returned deadline is consumed by the one
   * global Swarm deadline owner. RuntimeOwner alone decides whether local death
   * is actually proven.
   */
  readonly reconcile: (input?: { readonly now?: number }) => Effect.Effect<ReconcileResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmRecovery") {}

interface ScanState {
  readonly afterProcessOwner?: string
  readonly cycleNextProbeAt?: number
}

const earlier = (left: number | undefined, right: number | undefined) =>
  left === undefined ? right : right === undefined ? left : Math.min(left, right)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const swarm = yield* SwarmV2.Service
    const runtime = yield* RuntimeOwner.Service
    const state = yield* Ref.make<ScanState>({})
    const lock = Semaphore.makeUnsafe(1)

    const reconcile: Interface["reconcile"] = Effect.fn("SwarmRecovery.reconcile")(function* (input) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const now = input?.now ?? Date.now()
          const previous = yield* Ref.get(state)
          const owners = yield* swarm.activeLeaseOwnerProcessIDs({
            excludeProcessOwner: runtime.id,
            ...(previous.afterProcessOwner === undefined
              ? {}
              : { afterProcessOwner: previous.afterProcessOwner }),
            limit: OWNER_SCAN_BATCH,
          })

          let nextProbeAt = previous.cycleNextProbeAt
          let retiredLeases = 0
          let lastFullyProcessedOwner = previous.afterProcessOwner
          let continueImmediately = false

          for (const processOwner of owners) {
            const ownerID = processOwner as RuntimeOwner.ID
            const snapshot = yield* runtime.snapshot(ownerID)
            if (!snapshot) {
              // No RuntimeOwner evidence means no death proof. Ordinary lease
              // expiry remains the fail-closed convergence path.
              lastFullyProcessedOwner = processOwner
              continue
            }

            const suspectAt = snapshot.heartbeatAt + OWNER_SUSPECT_MS
            if (suspectAt > now) {
              nextProbeAt = earlier(nextProbeAt, suspectAt)
              lastFullyProcessedOwner = processOwner
              continue
            }

            const proof = yield* runtime.proveLocalDeath(ownerID)
            if (proof !== "dead") {
              nextProbeAt = earlier(nextProbeAt, now + OWNER_RECHECK_MS)
              lastFullyProcessedOwner = processOwner
              continue
            }

            const remaining = Math.max(0, SwarmRuntimePolicy.DEADLINE_BATCH - retiredLeases)
            if (remaining === 0) {
              continueImmediately = true
              break
            }
            const targets = yield* swarm.processLeaseTargets({
              processOwner,
              limit: remaining,
            })
            const results = yield* Effect.forEach(
              targets,
              (target) =>
                swarm
                  .requestTaskRetirement({
                    token: target.token,
                    reason: "lease_owner_lost",
                    now,
                  })
                  .pipe(Effect.exit),
              { concurrency: SwarmRuntimePolicy.DEADLINE_CONCURRENCY },
            )
            retiredLeases += results.filter((result) => result._tag === "Success").length

            // Filling the remaining global lease budget does not prove this
            // owner's leases are drained. Revisit it from the preceding cursor
            // in one fresh authoritative pass.
            if (targets.length === remaining && remaining > 0) {
              continueImmediately = true
              break
            }
            lastFullyProcessedOwner = processOwner
          }

          if (continueImmediately) {
            yield* Ref.set(state, {
              ...(lastFullyProcessedOwner === undefined
                ? {}
                : { afterProcessOwner: lastFullyProcessedOwner }),
              ...(nextProbeAt === undefined ? {} : { cycleNextProbeAt: nextProbeAt }),
            })
            return {
              scannedOwners: owners.length,
              retiredLeases,
              nextProbeAt: now,
            } satisfies ReconcileResult
          }

          if (owners.length === OWNER_SCAN_BATCH) {
            const cursor = owners.at(-1)
            yield* Ref.set(state, {
              ...(cursor === undefined ? {} : { afterProcessOwner: cursor }),
              ...(nextProbeAt === undefined ? {} : { cycleNextProbeAt: nextProbeAt }),
            })
            return {
              scannedOwners: owners.length,
              retiredLeases,
              nextProbeAt: now,
            } satisfies ReconcileResult
          }

          // End of one bounded sweep. Reset the latency cursor; correctness is
          // always reconstructed from durable rows on the next call.
          yield* Ref.set(state, {})
          return {
            scannedOwners: owners.length,
            retiredLeases,
            ...(nextProbeAt === undefined ? {} : { nextProbeAt }),
          } satisfies ReconcileResult
        }),
      )
    })

    return Service.of({ reconcile })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SwarmV2.node, RuntimeOwner.node],
})
