import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecutionBoundary } from "@opencode-ai/core/session/execution-boundary"
import { SessionExecutionBoundaryTable } from "@opencode-ai/core/session/execution-boundary.sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      SessionProjector.node,
      SessionExecutionBoundary.node,
    ]),
  ),
)

const sessionID = SessionV2.ID.make("ses_boundary_test")

function setup() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "boundary-test",
        directory: "/project",
        title: "boundary-test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

describe("SessionExecutionBoundary", () => {
  it.effect("persists the current boundary through the durable Session event projector", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* SessionExecutionBoundary.Service
      const boundary = [
        { action: "edit", resource: "*", effect: "deny" as const },
        { action: "bash", resource: "git status", effect: "ask" as const },
      ]

      expect(yield* service.get(sessionID)).toBeUndefined()
      expect(yield* service.set(sessionID, boundary)).toEqual(boundary)
      expect(yield* service.get(sessionID)).toEqual(boundary)

      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionExecutionBoundaryTable)
        .where(eq(SessionExecutionBoundaryTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(row?.boundary).toEqual(boundary)
    }),
  )

  it.effect("replaces rather than order-merging boundary policy", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* SessionExecutionBoundary.Service
      yield* service.set(sessionID, [{ action: "edit", resource: "*", effect: "deny" }])
      const next = [{ action: "read", resource: "docs/*", effect: "ask" as const }]
      yield* service.set(sessionID, next)
      expect(yield* service.get(sessionID)).toEqual(next)
    }),
  )

  it.effect("rejects a boundary for a missing Session", () =>
    Effect.gen(function* () {
      const service = yield* SessionExecutionBoundary.Service
      const error = yield* service
        .set(SessionV2.ID.make("ses_missing_boundary"), [])
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionV2.NotFoundError)
    }),
  )
})
