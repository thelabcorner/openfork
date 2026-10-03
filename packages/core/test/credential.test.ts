import { describe, expect } from "bun:test"
import { Deferred, Effect, Stream } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Credential.node))

describe("Credential", () => {
  it.effect("publishes secret-free changes after committed mutations", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const observed: string[] = []
      const complete = yield* Deferred.make<void>()
      yield* Stream.runForEach(credentials.changes, (change) =>
        Effect.gen(function* () {
          observed.push(change.integrationID)
          if (observed.length === 4) yield* Deferred.succeed(complete, undefined)
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }))

      const created = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "first-secret" }),
      })
      yield* credentials.update(created.id, { label: "renamed" })
      const updated = yield* credentials.get(created.id)
      yield* credentials.compareAndSwapValue(
        created.id,
        updated!.revision,
        Credential.Key.make({ type: "key", key: "second-secret" }),
      )
      yield* credentials.remove(created.id)
      yield* Deferred.await(complete)

      expect(observed).toEqual(Array(4).fill(integrationID))
    }),
  )

  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )
})
