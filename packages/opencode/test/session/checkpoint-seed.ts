import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"

/** Seed project + session rows matching the active test instance so checkpoint FKs resolve. */
export const seedSessionRow = (sessionID: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const ctx = yield* InstanceState.context
    const now = Date.now()
    yield* db
      .insert(ProjectTable)
      .values({
        id: ctx.project.id as any,
        worktree: ctx.worktree as any,
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID as any,
        project_id: ctx.project.id as any,
        slug: "checkpoint-test",
        directory: ctx.directory as any,
        title: "checkpoint test",
        version: "0.0.0",
        time_created: now,
        time_updated: now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
