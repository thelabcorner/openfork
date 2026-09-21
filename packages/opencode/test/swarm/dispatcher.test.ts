import { beforeEach, describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmDispatcher } from "@/swarm/dispatcher"
import { SwarmMailExecutor } from "@/swarm/mail-executor"
import { SwarmTaskExecutor } from "@/swarm/task-executor"
import { testEffect } from "../lib/effect"

const swarmID = Swarm.ID.make("swr_dispatcher_test")
const memberID = Swarm.MemberID.make("swm_dispatcher_worker")
const taskID = Swarm.TaskID.make("swt_dispatcher_task")
const deliveryID = Swarm.DeliveryID.make("swd_dispatcher_delivery")
const timestamp = DateTime.makeUnsafe(1)

const task = Swarm.Task.make({
  id: taskID,
  swarmID,
  title: "dispatch me",
  status: "ready",
  priority: 0,
  reservationRevision: 0,
  leaseGeneration: 0,
  semanticRetryCount: 0,
  acceptance: { criteria: [] },
  metadata: {},
  readyAt: timestamp,
  time: { created: timestamp, updated: timestamp },
})

const member = Swarm.Member.make({
  id: memberID,
  swarmID,
  name: "worker",
  kind: "managed_worker",
  role: "worker",
  lifecycle: "active",
  sessionID: SessionID.make("ses_dispatcher_worker"),
  bindingGeneration: 1,
  workspacePolicy: { mode: "shared-read" },
  time: { created: timestamp, updated: timestamp },
})

const assignment: SwarmV2.ReadyAssignment = { task, member }

let ready: ReadonlyArray<SwarmV2.ReadyAssignment> = []
let deliveries: ReadonlyArray<Swarm.DeliveryID> = []
let scanCalls = 0
let taskCalls: SwarmV2.ReadyAssignment[] = []
let mailCalls: Swarm.DeliveryID[] = []
let readyOverride: (() => Effect.Effect<ReadonlyArray<SwarmV2.ReadyAssignment>>) | undefined

const fakeSwarmLayer = Layer.succeed(
  SwarmV2.Service,
  SwarmV2.Service.of({
    readyAssignments: () =>
      Effect.suspend(() => {
        scanCalls++
        return readyOverride ? readyOverride() : Effect.succeed(ready)
      }),
    claimableDeliveryIDs: () => Effect.succeed(deliveries),
  } as never),
)

const fakeTaskLayer = Layer.succeed(
  SwarmTaskExecutor.Service,
  SwarmTaskExecutor.Service.of({
    execute: (input) =>
      Effect.sync(() => {
        taskCalls.push(input)
        return { state: "admitted", taskID: input.task.id } as never
      }),
  }),
)

const fakeMailLayer = Layer.succeed(
  SwarmMailExecutor.Service,
  SwarmMailExecutor.Service.of({
    execute: (input) =>
      Effect.sync(() => {
        mailCalls.push(input)
        return { state: "admitted", deliveryID: input } as const
      }),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SwarmDispatcher.node]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [SwarmV2.node, fakeSwarmLayer],
      [SwarmTaskExecutor.node, fakeTaskLayer],
      [SwarmMailExecutor.node, fakeMailLayer],
    ],
  ),
)

beforeEach(() => {
  ready = []
  deliveries = []
  scanCalls = 0
  taskCalls = []
  mailCalls = []
  readyOverride = undefined
})

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let index = 0; index < 2_000; index++) {
      if (predicate()) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("waitFor timed out"))
  })

const waitForEffect = (predicate: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let index = 0; index < 2_000; index++) {
      if (yield* predicate) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("waitForEffect timed out"))
  })

describe("SwarmDispatcher", () => {
  it.live("startup performs one authoritative bounded task/mail drain", () =>
    Effect.gen(function* () {
      ready = [assignment]
      deliveries = [deliveryID]
      const dispatcher = yield* SwarmDispatcher.Service

      yield* waitFor(() => taskCalls.length === 1 && mailCalls.length === 1)
      expect(taskCalls).toEqual([assignment])
      expect(mailCalls).toEqual([deliveryID])
      expect(yield* dispatcher.activeDrains()).toBeLessThanOrEqual(1)
    }),
  )

  it.live("relevant durable events wake a fresh authoritative scan", () =>
    Effect.gen(function* () {
      const dispatcher = yield* SwarmDispatcher.Service
      const events = yield* EventV2.Service
      yield* waitFor(() => scanCalls >= 1)
      expect(taskCalls).toHaveLength(0)

      ready = [assignment]
      yield* events.publish(Swarm.Event.TaskUpdated, { swarmID, task })
      yield* waitFor(() => taskCalls.length === 1)
      expect(yield* dispatcher.activeDrains()).toBeLessThanOrEqual(1)
    }),
  )

  it.live("burst wakes coalesce behind one active drain and cause one fresh follow-up scan", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      readyOverride = () => Deferred.await(gate).pipe(Effect.as([]))
      const dispatcher = yield* SwarmDispatcher.Service
      yield* waitFor(() => scanCalls === 1)
      expect(yield* dispatcher.activeDrains()).toBe(1)

      yield* Effect.all(Array.from({ length: 100 }, () => dispatcher.poke()), {
        concurrency: "unbounded",
        discard: true,
      })
      expect(yield* dispatcher.activeDrains()).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      yield* waitFor(() => scanCalls >= 2)
      yield* waitForEffect(dispatcher.activeDrains().pipe(Effect.map((value) => value === 0)))
      expect(scanCalls).toBe(2)
    }),
  )
})
