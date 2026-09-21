import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { RevisionDraftClaimTable, RevisionDraftTable } from "@opencode-ai/core/revision-draft.sql"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, RevisionDraft.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

describe("RevisionDraft", () => {
  test("survives a complete service/database restart on the same SQLite file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openfork-revision-draft-"))
    const databasePath = join(directory, "openfork.db")
    const target = {
      kind: "prompt" as const,
      key: "session:restart-survival",
      sourceFingerprint: "restart-source",
    }

    const makeLayer = () =>
      AppNodeBuilder.build(
        LayerNode.group([Database.node, RevisionDraft.node]),
        [[Database.node, Database.layerFromPath(databasePath)]],
      )

    try {
      const written = await Effect.runPromise(
        Effect.gen(function* () {
          const drafts = yield* RevisionDraft.Service
          const claimID = yield* drafts.claim({ target, now: 100 })
          return yield* drafts.put({
            claimID,
            directory: "/workspace/restart",
            target,
            purpose: "prompt",
            prompt: "revision survives restart",
            references: [{ type: "file", path: "src/restart.ts" }],
            now: 101,
          })
        }).pipe(Effect.provide(makeLayer())),
      )
      expect(written).toBeDefined()

      // The first layer is gone. Build a new Database + RevisionDraft graph
      // against the same on-disk SQLite file, as a restarted server would.
      const recovered = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* RevisionDraft.Service).recover({ kind: target.kind, key: target.key })
        }).pipe(Effect.provide(makeLayer())),
      )

      expect(recovered).toMatchObject({
        id: written!.id,
        directory: "/workspace/restart",
        sourceFingerprint: "restart-source",
        prompt: "revision survives restart",
        references: [{ type: "file", path: "src/restart.ts" }],
        timeCreated: 101,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.live(
    "keeps exactly the latest artifact per target and makes stale acknowledgement harmless",
    Effect.gen(function* () {
      const drafts = yield* RevisionDraft.Service
      const { readDb } = yield* Database.Service
      const target = { kind: "prompt" as const, key: "session:ses_test", sourceFingerprint: "source-a" }

      const firstClaim = yield* drafts.claim({ target, now: 1 })
      const first = yield* drafts.put({
        claimID: firstClaim,
        directory: "/workspace/a",
        target,
        purpose: "prompt",
        prompt: "revision A",
        references: [{ type: "file", path: "a.ts" }],
        now: 10,
      })
      expect(first).toBeDefined()
      expect(yield* drafts.recover({ kind: "prompt", key: target.key })).toMatchObject({
        id: first!.id,
        directory: "/workspace/a",
        sourceFingerprint: "source-a",
        prompt: "revision A",
        references: [{ type: "file", path: "a.ts" }],
        timeCreated: 10,
      })

      const secondTarget = { ...target, sourceFingerprint: "source-b" }
      const secondClaim = yield* drafts.claim({ target: secondTarget, now: 11 })
      const second = yield* drafts.put({
        claimID: secondClaim,
        directory: "/workspace/b",
        target: secondTarget,
        purpose: "prompt",
        prompt: "revision B",
        references: [],
        now: 20,
      })
      expect(second).toBeDefined()
      expect(second!.id).not.toBe(first!.id)
      expect(yield* readDb.select().from(RevisionDraftTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* drafts.recover({ kind: "prompt", key: target.key })).toMatchObject({
        id: second!.id,
        directory: "/workspace/b",
        sourceFingerprint: "source-b",
        prompt: "revision B",
        timeCreated: 20,
      })

      // A renderer holding the superseded id cannot consume the replacement.
      yield* drafts.consume(first!.id)
      expect((yield* drafts.recover({ kind: "prompt", key: target.key }))?.id).toBe(second!.id)

      yield* drafts.consume(second!.id)
      expect(yield* drafts.recover({ kind: "prompt", key: target.key })).toBeUndefined()
    }),
  )

  it.live(
    "isolates the same stable key by semantic target kind",
    Effect.gen(function* () {
      const drafts = yield* RevisionDraft.Service
      const promptTarget = { kind: "prompt" as const, key: "shared", sourceFingerprint: "p" }
      const promptClaim = yield* drafts.claim({ target: promptTarget })
      yield* drafts.put({
        claimID: promptClaim,
        directory: "/workspace",
        target: promptTarget,
        purpose: "prompt",
        prompt: "prompt revision",
        references: [],
      })
      const goalTarget = { kind: "goal" as const, key: "shared", sourceFingerprint: "g" }
      const goalClaim = yield* drafts.claim({ target: goalTarget })
      yield* drafts.put({
        claimID: goalClaim,
        directory: "/workspace",
        target: goalTarget,
        purpose: "goal",
        prompt: "goal revision",
        references: [],
      })

      expect((yield* drafts.recover({ kind: "prompt", key: "shared" }))?.prompt).toBe("prompt revision")
      expect((yield* drafts.recover({ kind: "goal", key: "shared" }))?.prompt).toBe("goal revision")
    }),
  )

  it.live(
    "allows only the newest request claim to commit even when an older provider finishes later",
    Effect.gen(function* () {
      const drafts = yield* RevisionDraft.Service
      const targetA = { kind: "prompt" as const, key: "session:race", sourceFingerprint: "source-a" }
      const targetB = { ...targetA, sourceFingerprint: "source-b" }

      const claimA = yield* drafts.claim({ target: targetA, now: 1 })
      const claimB = yield* drafts.claim({ target: targetB, now: 2 })

      const stale = yield* drafts.put({
        claimID: claimA,
        directory: "/workspace",
        target: targetA,
        purpose: "prompt",
        prompt: "stale A",
        references: [],
        now: 30,
      })
      expect(stale).toBeUndefined()

      const current = yield* drafts.put({
        claimID: claimB,
        directory: "/workspace",
        target: targetB,
        purpose: "prompt",
        prompt: "current B",
        references: [],
        now: 20,
      })
      expect(current?.prompt).toBe("current B")
      expect((yield* drafts.recover({ kind: "prompt", key: targetA.key }))?.prompt).toBe("current B")
    }),
  )

  it.live(
    "does not allow a claim to be replayed against another semantic target",
    Effect.gen(function* () {
      const drafts = yield* RevisionDraft.Service
      const claimed = { kind: "prompt" as const, key: "session:claim-owner", sourceFingerprint: "source-a" }
      const other = { kind: "prompt" as const, key: "session:other-target", sourceFingerprint: "source-b" }
      const claimID = yield* drafts.claim({ target: claimed })

      const replay = yield* drafts.put({
        claimID,
        directory: "/workspace",
        target: other,
        purpose: "prompt",
        prompt: "must not commit",
        references: [],
      })

      expect(replay).toBeUndefined()
      expect(yield* drafts.recover({ kind: "prompt", key: other.key })).toBeUndefined()
    }),
  )

  it.live(
    "binds a generation claim to the exact source fingerprint it was issued for",
    Effect.gen(function* () {
      const drafts = yield* RevisionDraft.Service
      const claimed = { kind: "prompt" as const, key: "session:source-bound", sourceFingerprint: "source-a" }
      const claimID = yield* drafts.claim({ target: claimed })

      const mutated = yield* drafts.put({
        claimID,
        directory: "/workspace",
        target: { ...claimed, sourceFingerprint: "source-b" },
        purpose: "prompt",
        prompt: "must not commit",
        references: [],
      })

      expect(mutated).toBeUndefined()
      expect(yield* drafts.recover({ kind: "prompt", key: claimed.key })).toBeUndefined()

      const valid = yield* drafts.put({
        claimID,
        directory: "/workspace",
        target: claimed,
        purpose: "prompt",
        prompt: "valid source-bound revision",
        references: [],
      })
      expect(valid?.prompt).toBe("valid source-bound revision")
    }),
  )

  it.live(
    "keeps the last completed artifact recoverable when a newer claimed generation fails before commit",
    Effect.gen(function* () {
      const drafts = yield* RevisionDraft.Service
      const { readDb } = yield* Database.Service
      const oldTarget = { kind: "prompt" as const, key: "session:failed-newer", sourceFingerprint: "old-source" }
      const oldClaim = yield* drafts.claim({ target: oldTarget, now: 1 })
      const old = yield* drafts.put({
        claimID: oldClaim,
        directory: "/workspace",
        target: oldTarget,
        purpose: "prompt",
        prompt: "last completed",
        references: [],
        now: 2,
      })
      expect(old?.prompt).toBe("last completed")

      // Simulate a newer request starting successfully but failing in model/runtime
      // work before it ever reaches the commit boundary.
      const failedTarget = { ...oldTarget, sourceFingerprint: "new-source" }
      yield* drafts.claim({ target: failedTarget, now: 3 })

      expect((yield* drafts.recover({ kind: "prompt", key: oldTarget.key }))?.prompt).toBe("last completed")
      expect(yield* readDb.select().from(RevisionDraftTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* readDb.select().from(RevisionDraftClaimTable).all().pipe(Effect.orDie)).toHaveLength(1)

      const replacementTarget = { ...oldTarget, sourceFingerprint: "replacement-source" }
      const replacementClaim = yield* drafts.claim({ target: replacementTarget, now: 4 })
      const replacement = yield* drafts.put({
        claimID: replacementClaim,
        directory: "/workspace",
        target: replacementTarget,
        purpose: "prompt",
        prompt: "replacement completed",
        references: [],
        now: 5,
      })
      expect(replacement?.prompt).toBe("replacement completed")
      expect((yield* drafts.recover({ kind: "prompt", key: oldTarget.key }))?.prompt).toBe("replacement completed")
      expect(yield* readDb.select().from(RevisionDraftClaimTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )
})
