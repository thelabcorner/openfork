import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { makeHarness, insertSession, setTitle, textCompletion } from "./lib/session-harness"

let snapshotStarted: Deferred.Deferred<void> | undefined
let snapshotRelease: Deferred.Deferred<Snapshot.ID | undefined> | undefined
let captures = 0

const snapshotLayer = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    capture: () =>
      Effect.suspend(() => {
        captures++
        if (captures !== 1 || !snapshotRelease) return Effect.succeed(Snapshot.ID.make(`tree-${captures}`))
        return (snapshotStarted ? Deferred.succeed(snapshotStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(snapshotRelease)),
        )
      }),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
    retain: () => Effect.void as any,
    release: () => Effect.void as any,
    epoch: () => Effect.succeed("snapshot-overlap-test") as any,
    excludedFiles: () => Effect.succeed([]) as any,
  }),
)

const h = makeHarness({ snapshotLayer })
const sessionID = SessionV2.ID.make("ses_snapshot_overlap")

h.it.effect("starts provider generation before the start snapshot completes but blocks assistant publication", () =>
  Effect.gen(function* () {
    h.reset()
    captures = 0
    snapshotStarted = yield* Deferred.make<void>()
    snapshotRelease = yield* Deferred.make<Snapshot.ID | undefined>()
    const providerStarted = yield* Deferred.make<void>()
    const providerRelease = yield* Deferred.make<void>()
    h.setStreamStarted(providerStarted)
    h.setStreamGate(providerRelease)

    yield* insertSession(sessionID)
    yield* setTitle(sessionID, "snapshot overlap test")
    const session = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "overlap snapshot with provider generation" }), resume: false })
    h.enqueueCompletion(textCompletion(["done"]))

    const drain = yield* execution.resume(sessionID).pipe(Effect.forkChild)
    yield* Deferred.await(snapshotStarted).pipe(Effect.timeout("2 seconds"))
    // This is the key latency invariant. With synchronous pre-provider capture,
    // this wait times out because the provider cannot start until snapshotRelease.
    yield* Deferred.await(providerStarted).pipe(Effect.timeout("2 seconds"))

    // The publisher-level regression separately proves that assistant
    // publication cannot cross this unresolved snapshot. Release it here before
    // provider events flow so this integration test isolates dispatch overlap.
    yield* Deferred.succeed(snapshotRelease, Snapshot.ID.make("tree-start"))
    yield* Deferred.succeed(providerRelease, undefined)
    yield* Fiber.join(drain)
    expect(h.requests).toHaveLength(1)
    expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")).toHaveLength(1)
  }),
)
