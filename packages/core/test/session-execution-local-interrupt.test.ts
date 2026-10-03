import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, LayerMap } from "effect"
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

describe("SessionExecutionLocal interrupt ownership", () => {
  const sessionID = SessionSchema.ID.make("ses_local_interrupt_release")
  const token: SessionExecutionOwner.Token = {
    sessionID,
    ownerID: "runtime-local" as RuntimeOwner.ID,
    generation: 1,
  }

  const started = Deferred.makeUnsafe<void>()
  const events: string[] = []
  let exactReleases = 0
  let conditionalReleases = 0

  const ownership = SessionExecutionOwner.Service.of({
    tryAcquire: () => Effect.succeed({ state: "acquired" as const, token }),
    tryAcquireLocal: () => Effect.succeed({ state: "acquired" as const, token }),
    localActivation: () => Effect.succeed(token),
    listWorking: () => Effect.succeed(new Map()),
    listWorkingByDirectory: () => Effect.succeed(new Map()),
    listSessionIDsByDirectory: () => Effect.succeed([]),
    releaseIfDrained: () =>
      Effect.sync(() => {
        conditionalReleases++
        events.push("conditional-release")
        return "released" as const
      }),
    release: () =>
      Effect.sync(() => {
        exactReleases++
        events.push("exact-release")
        return "released" as const
      }),
    snapshot: () => Effect.succeed({ sessionID, generation: 1, ownerID: token.ownerID }),
    requestInterrupt: () =>
      Effect.succeed({
        state: "requested" as const,
        token,
        interruptGeneration: 1,
      }),
    tryClaimRecovery: () => Effect.die("recovery must not run"),
    completeRecovery: () => Effect.die("recovery must not run"),
    abandonRecovery: () => Effect.die("recovery must not run"),
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
      Effect.gen(function* () {
        events.push("runner-start")
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            events.push("runner-finalized")
          }),
        ),
      ),
  })
  const locations = {
    get: () => Layer.succeed(SessionRunner.Service, runner),
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

  const it = testEffect(
    AppNodeBuilder.build(SessionExecutionLocal.node, [
      [Database.node, dbNode],
      [SessionExecutionOwner.node, ownerNode],
      [SessionStore.node, storeNode],
      [GoalAutomation.node, automationNode],
      [LocationServiceMap.node, locationNode],
    ]),
  )

  it.effect("quiesces the runner before exact-releasing an interrupted generation", () =>
    Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      yield* Effect.forkChild(execution.resume(sessionID))
      yield* Deferred.await(started)

      yield* execution.interrupt(sessionID)

      expect(events).toContain("runner-finalized")
      expect(exactReleases).toBe(1)
      expect(conditionalReleases).toBe(0)
      expect(events.indexOf("runner-finalized")).toBeLessThan(events.indexOf("exact-release"))
    }).pipe(Effect.timeout("5 seconds")),
  )
})
