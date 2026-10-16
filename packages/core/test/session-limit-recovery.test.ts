import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionLimitRecovery } from "@opencode-ai/core/session/limit-recovery"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node]), [[Database.node, Database.layerFromPath(":memory:")]]),
)

describe("SessionLimitRecovery", () => {
  it.effect("keeps one cursor per session, fences mutations by generation, and keeps snooze orthogonal", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const sessionID = SessionSchema.ID.make("session-limit-recovery")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/limit-recovery"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "limit-recovery",
          directory: "/tmp/limit-recovery",
          title: "Recovery test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const first = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_1"),
        providerID: "provider-a",
        accountID: "account-a",
        modelID: "model-a",
        failureClass: "account-quota",
        resetAt: 10_000,
        resetSource: "provider",
        expectedLatestUserSeq: 5,
        autoResume: true,
        now: 1_000,
      })
      expect(first).toMatchObject({ generation: 1, autoResume: true, expectedLatestUserSeq: 5 })
      expect(first?.continuationID.startsWith("msg_")).toBe(true)
      const duplicate = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_1"),
        providerID: "provider-a",
        accountID: "account-a",
        modelID: "model-a",
        failureClass: "account-quota",
        resetAt: 10_000,
        resetSource: "provider",
        expectedLatestUserSeq: 5,
        autoResume: true,
        now: 1_100,
      })
      expect(duplicate?.generation).toBe(first?.generation)
      expect(duplicate?.continuationID).toBe(first?.continuationID)

      const snoozed = yield* SessionLimitRecovery.setSnooze(db, {
        sessionID,
        generation: first!.generation,
        until: 9_000,
        now: 1_200,
      })
      expect(snoozed?.autoResume).toBe(true)
      expect(DateTime.toEpochMillis(snoozed!.snoozeUntil!)).toBe(9_000)
      yield* SessionLimitRecovery.setAutoResume(db, { sessionID, generation: first!.generation, enabled: false })
      const duplicateAfterUserChanges = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_1"),
        providerID: "provider-a",
        accountID: "account-a",
        modelID: "model-a",
        failureClass: "account-quota",
        resetAt: 10_000,
        resetSource: "provider",
        autoResume: true,
        now: 1_250,
      })
      expect(duplicateAfterUserChanges?.autoResume).toBe(false)
      expect(DateTime.toEpochMillis(duplicateAfterUserChanges!.snoozeUntil!)).toBe(9_000)
      expect(yield* SessionLimitRecovery.due(db, 10_000)).toHaveLength(0)
      expect(yield* SessionLimitRecovery.nextDueAt(db)).toBeUndefined()

      const changedReset = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_1"),
        providerID: "provider-a",
        accountID: "account-a",
        modelID: "model-a",
        failureClass: "account-quota",
        resetAt: 11_000,
        resetSource: "provider",
        expectedLatestUserSeq: 5,
        autoResume: true,
        now: 1_300,
      })
      expect(changedReset?.generation).toBe(2)
      expect(changedReset?.snoozeUntil).toBeUndefined()
      expect(changedReset?.continuationID).not.toBe(first?.continuationID)
      expect(yield* SessionLimitRecovery.setAutoResume(db, {
        sessionID,
        generation: first!.generation,
        enabled: false,
      })).toBeUndefined()
      expect(yield* SessionLimitRecovery.setAutoResume(db, {
        sessionID,
        generation: changedReset!.generation,
        enabled: true,
        now: 10_000,
      })).toMatchObject({ autoResume: true })
      const firstClaim = yield* SessionLimitRecovery.claim(db, {
        sessionID,
        generation: changedReset!.generation,
        owner: "runtime-a",
        now: 11_000,
      })
      expect(firstClaim?.claimOwner).toBe("runtime-a")

      const duplicateWhileClaimed = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_1"),
        providerID: "provider-a",
        accountID: "account-a",
        modelID: "model-a",
        failureClass: "account-quota",
        resetAt: 11_000,
        resetSource: "provider",
        // A later observation must not move the frozen human-focus fence.
        expectedLatestUserSeq: 99,
        autoResume: true,
        now: 11_000,
      })
      expect(duplicateWhileClaimed?.generation).toBe(changedReset!.generation)
      expect(duplicateWhileClaimed?.claimOwner).toBe("runtime-a")
      expect(DateTime.toEpochMillis(duplicateWhileClaimed!.claimExpiresAt!)).toBe(41_000)
      expect(duplicateWhileClaimed?.expectedLatestUserSeq).toBe(5)
      expect(yield* SessionLimitRecovery.due(db, 11_000)).toHaveLength(0)
      expect(yield* SessionLimitRecovery.nextDueAt(db, 11_000)).toBe(41_000)
      expect(yield* SessionLimitRecovery.claim(db, {
        sessionID,
        generation: changedReset!.generation,
        owner: "runtime-b",
        now: 11_000,
      })).toBeUndefined()
      yield* SessionLimitRecovery.releaseClaim(db, {
        sessionID,
        generation: changedReset!.generation,
        owner: "runtime-a",
      })
      const secondClaim = yield* SessionLimitRecovery.claim(db, {
        sessionID,
        generation: changedReset!.generation,
        owner: "runtime-b",
        now: 11_001,
      })
      expect(secondClaim).toMatchObject({ claimOwner: "runtime-b" })
      expect(DateTime.toEpochMillis(secondClaim!.claimExpiresAt!)).toBe(41_001)
      expect(yield* SessionLimitRecovery.nextDueAt(db, 11_001)).toBe(41_001)
      expect(yield* SessionLimitRecovery.claim(db, {
        sessionID,
        generation: changedReset!.generation,
        owner: "runtime-c",
        now: 41_000,
      })).toBeUndefined()
      // Simulate runtime-b disappearing without releasing its durable claim.
      // Claim expiry is the restart/crash recovery handoff: a fresh process can
      // reacquire the exact generation from SQLite once the lease expires.
      expect(yield* SessionLimitRecovery.claim(db, {
        sessionID,
        generation: changedReset!.generation,
        owner: "runtime-c",
        now: 41_001,
      })).toMatchObject({ claimOwner: "runtime-c" })
      expect(yield* SessionLimitRecovery.cancel(db, {
        sessionID,
        generation: changedReset!.generation,
      })).toBe(true)
      expect(yield* SessionLimitRecovery.cancel(db, {
        sessionID,
        generation: changedReset!.generation,
      })).toBe(false)
    }),
  )

  it.effect("does not autonomously schedule observed resets and adjudicates due claims once", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const sessionID = SessionSchema.ID.make("session-limit-claim")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/limit-claim"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "limit-claim",
          directory: "/tmp/limit-claim",
          title: "Claim test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const row = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_2"),
        providerID: "provider-a",
        modelID: "model-a",
        failureClass: "rate-limit",
        resetAt: 2_000,
        resetSource: "observed",
        autoResume: true,
        snoozeUntilReset: true,
        now: 1_000,
      })
      expect(row?.autoResume).toBe(false)
      expect(DateTime.toEpochMillis(row!.snoozeUntil!)).toBe(2_000)
      expect(yield* SessionLimitRecovery.due(db, 2_000)).toHaveLength(0)

      const armed = yield* SessionLimitRecovery.setAutoResume(db, {
        sessionID,
        generation: row!.generation,
        enabled: true,
        now: 1_000,
      })
      expect(armed).toBeUndefined()

      const manual = yield* SessionLimitRecovery.requestManualResume(db, {
        sessionID,
        generation: row!.generation,
        now: 1_500,
      })
      expect(manual).toMatchObject({ manualResume: true, autoResume: false })
      expect(manual?.snoozeUntil).toBeUndefined()
      const reobserved = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_2"),
        providerID: "provider-a",
        modelID: "model-a",
        failureClass: "rate-limit",
        resetAt: 3_000,
        resetSource: "provider",
        autoResume: true,
        now: 1_600,
      })
      expect(reobserved).toMatchObject({
        generation: manual!.generation,
        manualResume: true,
        autoResume: false,
        resetSource: "observed",
      })
      expect(reobserved?.continuationID).toBe(manual?.continuationID)
      expect(DateTime.toEpochMillis(reobserved!.resetAt!)).toBe(2_000)
      expect(yield* SessionLimitRecovery.nextDueAt(db, 1_500)).toBe(1_500)
      expect(yield* SessionLimitRecovery.due(db, 1_500)).toHaveLength(1)
      expect(
        yield* SessionLimitRecovery.claim(db, {
          sessionID,
          generation: row!.generation,
          owner: "manual-runtime",
          now: 1_500,
        }),
      ).toMatchObject({ manualResume: true, claimOwner: "manual-runtime" })
    }),
  )

  it.effect("manual resume authority cannot be re-armed as unattended auto-resume", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const sessionID = SessionSchema.ID.make("session-limit-manual-authority")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/limit-manual-authority"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "limit-manual-authority",
          directory: "/tmp/limit-manual-authority",
          title: "Manual authority",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const recovery = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_manual_authority"),
        providerID: "provider-a",
        modelID: "model-a",
        failureClass: "rate-limit",
        resetAt: 5_000,
        resetSource: "provider",
        autoResume: true,
        now: 1_000,
      })
      expect(recovery).toMatchObject({ autoResume: true, manualResume: false })

      const manual = yield* SessionLimitRecovery.requestManualResume(db, {
        sessionID,
        generation: recovery!.generation,
        now: 1_500,
      })
      expect(manual).toMatchObject({ autoResume: false, manualResume: true })

      expect(
        yield* SessionLimitRecovery.setAutoResume(db, {
          sessionID,
          generation: recovery!.generation,
          enabled: true,
          now: 1_500,
        }),
      ).toBeUndefined()
      expect(yield* SessionLimitRecovery.get(db, sessionID)).toMatchObject({
        autoResume: false,
        manualResume: true,
      })
    }),
  )

  it.effect("generation-fences asynchronous provider reset enrichment", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const sessionID = SessionSchema.ID.make("session-limit-enrichment")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/limit-enrichment"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "limit-enrichment",
          directory: "/tmp/limit-enrichment",
          title: "Enrichment test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const observed = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_enrich"),
        providerID: "provider-a",
        modelID: "model-a",
        failureClass: "rate-limit",
        autoResume: true,
        now: 1_000,
      })
      expect(observed).toMatchObject({ generation: 1, autoResume: false })

      const enriched = yield* SessionLimitRecovery.enrichReset(db, {
        sessionID,
        generation: observed!.generation,
        resetAt: 5_000,
        resetSource: "provider",
        resetObservedAt: 1_100,
        autoResume: true,
        snoozeUntilReset: true,
        now: 1_200,
      })
      expect(enriched).toMatchObject({ generation: 2, autoResume: true, resetSource: "provider" })
      expect(DateTime.toEpochMillis(enriched!.resetAt!)).toBe(5_000)
      expect(DateTime.toEpochMillis(enriched!.snoozeUntil!)).toBe(5_000)
      expect(enriched!.continuationID).not.toBe(observed!.continuationID)

      expect(
        yield* SessionLimitRecovery.enrichReset(db, {
          sessionID,
          generation: observed!.generation,
          resetAt: 6_000,
          resetSource: "provider",
          resetObservedAt: 1_300,
          autoResume: true,
          now: 1_300,
        }),
      ).toBeUndefined()

      const trustedWins = yield* SessionLimitRecovery.enrichReset(db, {
        sessionID,
        generation: enriched!.generation,
        resetAt: 7_000,
        resetSource: "observed",
        resetObservedAt: 1_400,
        autoResume: false,
        now: 1_400,
      })
      expect(trustedWins?.generation).toBe(enriched!.generation)
      expect(DateTime.toEpochMillis(trustedWins!.resetAt!)).toBe(5_000)
    }),
  )

  it.effect("advances generation when reset provenance changes authority for the same deadline", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const sessionID = SessionSchema.ID.make("session-limit-reset-provenance")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/limit-reset-provenance"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "limit-reset-provenance",
          directory: "/tmp/limit-reset-provenance",
          title: "Reset provenance",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const advisory = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_reset_provenance"),
        providerID: "provider-a",
        modelID: "model-a",
        failureClass: "rate-limit",
        resetAt: 5_000,
        resetSource: "observed",
        expectedLatestUserSeq: 3,
        autoResume: true,
        now: 1_000,
      })
      expect(advisory).toMatchObject({ generation: 1, autoResume: false, resetSource: "observed" })

      const trusted = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_reset_provenance"),
        providerID: "provider-a",
        modelID: "model-a",
        failureClass: "rate-limit",
        resetAt: 5_000,
        resetSource: "provider",
        expectedLatestUserSeq: 3,
        autoResume: true,
        now: 1_100,
      })
      expect(trusted).toMatchObject({ generation: 2, autoResume: true, resetSource: "provider" })
      expect(trusted?.continuationID).not.toBe(advisory?.continuationID)
    }),
  )

  it.effect("advances generation when route identity changes for the same stopped assistant", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.global
      const sessionID = SessionSchema.ID.make("session-limit-route-identity")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/tmp/limit-route-identity"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "limit-route-identity",
          directory: "/tmp/limit-route-identity",
          title: "Route identity",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const first = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_route"),
        sourceUserMessageID: SessionMessage.ID.make("msg_limit_route_user"),
        providerID: "provider-a",
        accountID: "account-a",
        modelID: "model-a",
        failureClass: "account-quota",
        resetAt: 5_000,
        resetSource: "provider",
        expectedLatestUserSeq: 3,
        autoResume: true,
        now: 1_000,
      })
      const changed = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_route"),
        sourceUserMessageID: SessionMessage.ID.make("msg_limit_route_user"),
        providerID: "provider-a",
        accountID: "account-b",
        modelID: "model-a",
        failureClass: "account-quota",
        resetAt: 5_000,
        resetSource: "provider",
        expectedLatestUserSeq: 4,
        autoResume: true,
        now: 1_100,
      })
      expect(first?.generation).toBe(1)
      expect(changed).toMatchObject({ generation: 2, accountID: "account-b", expectedLatestUserSeq: 4 })
      expect(changed?.continuationID).not.toBe(first?.continuationID)
    }),
  )
})

test("file-backed recovery survives reopen and an expired claim is safely reclaimed", async () => {
  await using tmp = await tmpdir()
  const databasePath = join(tmp.path, "session-limit-recovery.sqlite")
  const graph = () =>
    AppNodeBuilder.build(LayerNode.group([Database.node]), [[Database.node, Database.layerFromPath(databasePath)]])
  const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
    Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(graph())))

  const projectID = Project.ID.global
  const sessionID = SessionSchema.ID.make("session-limit-file-restart")
  const generation = await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "limit-file-restart",
          directory: tmp.path,
          title: "File-backed recovery",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const recovery = yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_file_restart"),
        providerID: "provider-a",
        modelID: "model-a",
        failureClass: "rate-limit",
        resetAt: 1_000,
        resetSource: "provider",
        expectedLatestUserSeq: 7,
        autoResume: true,
        now: 0,
      })
      if (!recovery) throw new Error("expected durable recovery cursor")
      expect(
        yield* SessionLimitRecovery.claim(db, {
          sessionID,
          generation: recovery.generation,
          owner: "runtime-before-crash",
          now: 1_000,
          leaseMs: 100,
        }),
      ).toMatchObject({ claimOwner: "runtime-before-crash" })
      return recovery.generation
    }),
  )

  const beforeExpiry = await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const current = yield* SessionLimitRecovery.get(db, sessionID)
      const competing = yield* SessionLimitRecovery.claim(db, {
        sessionID,
        generation,
        owner: "runtime-after-restart",
        now: 1_099,
      })
      return {
        current,
        competing,
        nextDueAt: yield* SessionLimitRecovery.nextDueAt(db, 1_099),
        due: yield* SessionLimitRecovery.due(db, 1_099),
      }
    }),
  )
  expect(beforeExpiry.current).toMatchObject({
    generation,
    autoResume: true,
    expectedLatestUserSeq: 7,
    claimOwner: "runtime-before-crash",
  })
  expect(beforeExpiry.competing).toBeUndefined()
  expect(beforeExpiry.nextDueAt).toBe(1_100)
  expect(beforeExpiry.due).toHaveLength(0)

  const reclaimed = await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* SessionLimitRecovery.claim(db, {
        sessionID,
        generation,
        owner: "runtime-after-restart",
        now: 1_100,
      })
    }),
  )
  expect(reclaimed).toMatchObject({
    generation,
    autoResume: true,
    claimOwner: "runtime-after-restart",
    expectedLatestUserSeq: 7,
  })
})


test("recovery generation remains monotonic after cursor deletion and fences stale mutation", async () => {
  await using tmp = await tmpdir()
  const databasePath = join(tmp.path, "session-limit-generation.sqlite")
  const graph = () =>
    AppNodeBuilder.build(LayerNode.group([Database.node]), [[Database.node, Database.layerFromPath(databasePath)]])
  const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
    Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(graph())))

  const projectID = Project.ID.global
  const sessionID = SessionSchema.ID.make("session-limit-generation")
  const first = await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "limit-generation",
          directory: tmp.path,
          title: "Recovery generation",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_generation_1"),
        providerID: "provider-a",
        accountID: "account-a",
        modelID: "model-a",
        failureClass: "account-quota",
        resetAt: 5_000,
        resetSource: "provider",
        autoResume: true,
        now: 1_000,
      })
    }),
  )
  expect(first?.generation).toBe(1)

  await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* SessionLimitRecovery.cancel(db, { sessionID, generation: first!.generation })
    }),
  )

  const second = await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* SessionLimitRecovery.observeFailure(db, {
        sessionID,
        sourceAssistantMessageID: SessionMessage.ID.make("msg_limit_generation_2"),
        providerID: "provider-a",
        accountID: "account-b",
        modelID: "model-a",
        failureClass: "account-quota",
        resetAt: 8_000,
        resetSource: "provider",
        autoResume: true,
        now: 2_000,
      })
    }),
  )
  expect(second?.generation).toBe(2)

  const staleMutation = await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* SessionLimitRecovery.requestManualResume(db, {
        sessionID,
        generation: first!.generation,
      })
    }),
  )
  expect(staleMutation).toBeUndefined()

  const current = await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* SessionLimitRecovery.get(db, sessionID)
    }),
  )
  expect(current).toMatchObject({
    generation: 2,
    accountID: "account-b",
    manualResume: false,
    autoResume: true,
  })
})
