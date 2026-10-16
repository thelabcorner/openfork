import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import * as ZenFreeUsage from "@/usage/zen-free"

test("Zen quota participates in the shared analytical pool lease, never borrowing its slot behind another owner", async () => {
  let leases=0
  let statementCount=0
  const reader={
    all: () => Effect.gen(function* () {
      yield* Effect.sleep("10 millis")
      statementCount++
      return []
    }),
  }
  const fake={
    scanDb: () => Effect.die("the shared scanDb bypass must not be invoked"),
    withScanDb: <A,E,R>(body:(reader:Database.DatabaseShape)=>Effect.Effect<A,E,R>) => {
      leases++
      return body(reader as never)
    },
  }
  const implementation=ZenFreeUsage.node.implementation as Layer.Layer<
    ZenFreeUsage.Service,never,Database.Service
  >
  const service=await Effect.runPromise(Effect.provide(
    ZenFreeUsage.Service,
    Layer.provide(implementation,Layer.succeed(Database.Service,fake as never)),
  ))
  const values=await Effect.runPromise(Effect.forEach(
    Array.from({length:16}),()=>service.snapshot(),{concurrency:16},
  ))
  expect(values).toHaveLength(16)
  expect(values.every(value=>value===values[0])).toBe(true)
  expect(leases).toBe(1)
  expect(statementCount).toBe(2)
})
