import { describe, expect } from "bun:test"
import { Effect, Layer, LayerMap } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationError, LocationServices } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

type ScriptedAcquire = SessionExecutionOwner.AcquireResult

interface Counters {
  tryAcquire: number
  tryClaimRecovery: number
  completeRecovery: number
  locationGets: number
  runnerRuns: number
}

const blocked = (sessionID: SessionSchema.ID): SessionExecutionOwner.MaintenanceBlocked => ({
  state: "maintenance-blocked",
  reason: "directory-unresolvable",
  sessionID,
  directory: "/maintenance-blocked",
  directoryKey: null,
  guards: [],
})

const busy = (sessionID: SessionSchema.ID): SessionExecutionOwner.AcquireResult => ({
  state: "busy",
  snapshot: {
    sessionID,
    generation: 7,
    ownerID: "runtime-dead" as RuntimeOwner.ID,
  },
})

function harness(script: ReadonlyArray<ScriptedAcquire>) {
  const sessionID = SessionSchema.ID.make("ses_local_maintenance")
  const queue = [...script]
  const counters: Counters = {
    tryAcquire: 0,
    tryClaimRecovery: 0,
    completeRecovery: 0,
    locationGets: 0,
    runnerRuns: 0,
  }

  const recoveryToken: SessionExecutionOwner.RecoveryToken = {
    sessionID,
    ownerID: "runtime-dead" as RuntimeOwner.ID,
    generation: 7,
    recoveryOwnerID: "runtime-recovery" as RuntimeOwner.ID,
  }

  const acquire = () =>
    Effect.sync(() => {
      counters.tryAcquire++
      const next = queue.shift()
      if (!next) throw new Error("Unexpected extra SessionExecutionOwner.tryAcquire")
      return next
    })
  const ownership = SessionExecutionOwner.Service.of({
    tryAcquire: acquire,
    tryAcquireLocal: acquire,
    localActivation: () => Effect.succeed(undefined),
    listWorking: () => Effect.succeed(new Map()),
    listWorkingByDirectory: () => Effect.succeed(new Map()),
    listSessionIDsByDirectory: () => Effect.succeed([]),
    releaseIfDrained: () => Effect.die("releaseIfDrained must not be called while maintenance-blocked"),
    release: () => Effect.die("release must not be called while maintenance-blocked"),
    snapshot: () => Effect.succeed({ sessionID, generation: 7 }),
    requestInterrupt: () => Effect.succeed({ state: "idle" as const }),
    tryClaimRecovery: () =>
      Effect.sync(() => {
        counters.tryClaimRecovery++
        return {
          state: "claimed" as const,
          token: recoveryToken,
          snapshot: {
            sessionID,
            generation: recoveryToken.generation,
            ownerID: recoveryToken.ownerID,
            recoveryOwnerID: recoveryToken.recoveryOwnerID,
          },
        }
      }),
    completeRecovery: () =>
      Effect.sync(() => {
        counters.completeRecovery++
        return "released" as const
      }),
    abandonRecovery: () => Effect.succeed("released" as const),
  })

  const fakeSession = {
    id: sessionID,
    location: {},
  } as unknown as SessionSchema.Info

  const store = SessionStore.Service.of({
    get: () => Effect.succeed(fakeSession),
    context: () => Effect.die("unused SessionStore.context"),
    runnerContext: () => Effect.die("unused SessionStore.runnerContext"),
    message: () => Effect.die("unused SessionStore.message"),
  })

  const automation = GoalAutomation.Service.of({
    pendingSessions: () => Effect.succeed([]),
  } as unknown as GoalAutomation.Interface)

  const runner = SessionRunner.Service.of({
    run: () =>
      Effect.sync(() => {
        counters.runnerRuns++
      }),
  })

  const locations = {
    get: () => {
      counters.locationGets++
      return Layer.succeed(SessionRunner.Service, runner)
    },
  } as unknown as LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>

  const dbNode = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(":memory:"),
    deps: [],
  })
  const ownerNode = makeGlobalNode({
    service: SessionExecutionOwner.Service,
    layer: Layer.succeed(SessionExecutionOwner.Service, ownership),
    deps: [],
  })
  const storeNode = makeGlobalNode({
    service: SessionStore.Service,
    layer: Layer.succeed(SessionStore.Service, store),
    deps: [],
  })
  const automationNode = makeGlobalNode({
    service: GoalAutomation.Service,
    layer: Layer.succeed(GoalAutomation.Service, automation),
    deps: [],
  })
  const locationNode = makeGlobalNode({
    service: LocationServiceMap.Service,
    layer: Layer.succeed(LocationServiceMap.Service, locations),
    deps: [],
  })

  const layer = AppNodeBuilder.build(SessionExecutionLocal.node, [
    [Database.node, dbNode],
    [SessionExecutionOwner.node, ownerNode],
    [SessionStore.node, storeNode],
    [GoalAutomation.node, automationNode],
    [LocationServiceMap.node, locationNode],
  ])

  return { it: testEffect(layer), sessionID, counters }
}

describe("SessionExecutionLocal maintenance admission", () => {
  {
    const h = harness([blocked(SessionSchema.ID.make("ses_local_maintenance"))])
    h.it.effect("maintenance-blocked returns before recovery or runner lookup", () =>
      Effect.gen(function* () {
        const execution = yield* SessionExecution.Service
        yield* execution.resume(h.sessionID)

        expect(h.counters.tryAcquire).toBe(1)
        expect(h.counters.tryClaimRecovery).toBe(0)
        expect(h.counters.completeRecovery).toBe(0)
        expect(h.counters.locationGets).toBe(0)
        expect(h.counters.runnerRuns).toBe(0)
      }),
    )
  }

  {
    const id = SessionSchema.ID.make("ses_local_maintenance")
    const h = harness([busy(id), blocked(id)])
    h.it.effect("busy recovery retry stops when maintenance becomes authoritative", () =>
      Effect.gen(function* () {
        const execution = yield* SessionExecution.Service
        yield* execution.resume(h.sessionID)

        expect(h.counters.tryAcquire).toBe(2)
        expect(h.counters.tryClaimRecovery).toBe(1)
        expect(h.counters.completeRecovery).toBe(1)
        expect(h.counters.locationGets).toBe(0)
        expect(h.counters.runnerRuns).toBe(0)
      }),
    )
  }
})
