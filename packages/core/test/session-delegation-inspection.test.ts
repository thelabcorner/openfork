import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionDelegationInspection } from "@opencode-ai/core/session/delegation-inspection"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    RuntimeOwner.node,
    SessionExecutionOwner.node,
    SessionDelegationInspection.node,
  ]),
)
const it = testEffect(layer)

const workerID = SessionSchema.ID.make("ses_delegation_inspection_worker")
const ordinaryID = SessionSchema.ID.make("ses_delegation_inspection_ordinary")

const origin = {
  producer: "oxp",
  principalRef: "oxp:connector-test",
  invocationRef: "oxp-inv:test",
  rootRef: "root-test",
  agent: "build",
  model: {
    providerID: "workbuddy",
    modelID: "deepseek-v4.1-flash",
    accountID: "wb-explicit",
    variant: "max",
  },
  nestedDelegation: true,
} as const

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db
    .insert(ProjectTable)
    .values({
      id: Project.ID.global,
      worktree: AbsolutePath.make("/delegation-inspection"),
      sandboxes: [],
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: workerID,
        project_id: Project.ID.global,
        slug: String(workerID),
        directory: "/delegation-inspection",
        title: "delegated worker",
        version: "test",
        agent: origin.agent,
        model: {
          providerID: origin.model.providerID,
          id: origin.model.modelID,
          accountID: origin.model.accountID,
          variant: origin.model.variant,
        },
        metadata: SessionMetadataOwnership.delegatedWorker(origin),
        time_created: now - 10,
        time_updated: now,
      },
      {
        id: ordinaryID,
        project_id: Project.ID.global,
        slug: String(ordinaryID),
        directory: "/delegation-inspection",
        title: "ordinary session",
        version: "test",
        time_created: now - 20,
        time_updated: now - 5,
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

describe("SessionDelegationInspection", () => {
  it.effect(
    "projects protected worker origin and durable execution-owner state without runtime bootstrap",
    Effect.gen(function* () {
      yield* seed
      const inspection = yield* SessionDelegationInspection.Service
      const execution = yield* SessionExecutionOwner.Service

      expect(yield* inspection.getWorker(ordinaryID)).toBeUndefined()
      expect(yield* inspection.getWorker(workerID)).toMatchObject({
        id: workerID,
        agent: "build",
        model: origin.model,
        origin,
        malformedOrigin: false,
        execution: {
          generation: 0,
          owned: false,
        },
      })

      expect(
        (yield* inspection.listWorkers({
          producer: "oxp",
          principalRef: origin.principalRef,
          rootRef: origin.rootRef,
        })).map((row) => row.id),
      ).toEqual([workerID])
      expect(
        yield* inspection.listWorkers({
          producer: "oxp",
          principalRef: "oxp:someone-else",
        }),
      ).toEqual([])

      const acquired = yield* execution.tryAcquire(workerID)
      expect(acquired.state).toBe("acquired")
      if (acquired.state !== "acquired") return

      expect(yield* inspection.getWorker(workerID)).toMatchObject({
        id: workerID,
        execution: {
          generation: acquired.token.generation,
          owned: true,
        },
      })

      expect(yield* execution.release(acquired.token)).toBe("released")
      expect(yield* inspection.getWorker(workerID)).toMatchObject({
        id: workerID,
        execution: {
          generation: acquired.token.generation,
          owned: false,
        },
      })
    }),
  )
})
