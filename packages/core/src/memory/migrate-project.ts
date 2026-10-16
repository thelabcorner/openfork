import { and, eq, isNull } from "drizzle-orm"
import { Effect } from "effect"
import type { ProjectDirectories } from "../project/directories"
import {
  MemoryEntryTable,
  MemorySuppressionTable,
  MemoryTopicTable,
} from "./sql"

/**
 * Re-home durable Memory when canonical project identity changes.
 *
 * V1 Project.fromDirectory() migrates Session and Workspace project IDs in one
 * immediate transaction. Memory's denormalized project IDs must move in that
 * same transaction, or the new project appears to have lost its memories.
 * Never delete canonical entries/evidence/tombstones; only collapse duplicate
 * topic routing rows when the destination already has that exact scoped key.
 */
export const migrateProject = (
  tx: ProjectDirectories.Transaction,
  oldID: string,
  newID: string,
) => Effect.gen(function* () {
  if (oldID === newID || oldID === "global") return

  const oldTopics = yield* tx.select({
    id: MemoryTopicTable.id,
    scope: MemoryTopicTable.scope,
    workspaceID: MemoryTopicTable.workspace_id,
    key: MemoryTopicTable.key,
  }).from(MemoryTopicTable).where(eq(MemoryTopicTable.project_id, oldID)).all()

  for (const topic of oldTopics) {
    const target = yield* tx.select({ id: MemoryTopicTable.id })
      .from(MemoryTopicTable)
      .where(and(
        eq(MemoryTopicTable.project_id, newID),
        eq(MemoryTopicTable.scope, topic.scope),
        topic.workspaceID === null
          ? isNull(MemoryTopicTable.workspace_id)
          : eq(MemoryTopicTable.workspace_id, topic.workspaceID),
        eq(MemoryTopicTable.key, topic.key),
      ))
      .orderBy(MemoryTopicTable.time_created, MemoryTopicTable.id)
      .limit(1).get()
    if (!target) {
      yield* tx.update(MemoryTopicTable)
        .set({ project_id: newID, projection_dirty: 1 })
        .where(eq(MemoryTopicTable.id, topic.id)).run()
      continue
    }
    // The new project already owns this topic key. Move the references first;
    // only the redundant, now-unreferenced topic is deleted.
    yield* tx.update(MemoryEntryTable)
      .set({ topic_id: target.id })
      .where(eq(MemoryEntryTable.topic_id, topic.id)).run()
    yield* tx.update(MemoryTopicTable)
      .set({ projection_dirty: 1 })
      .where(eq(MemoryTopicTable.id, target.id)).run()
    yield* tx.delete(MemoryTopicTable)
      .where(eq(MemoryTopicTable.id, topic.id)).run()
  }

  yield* tx.update(MemoryEntryTable)
    .set({ project_id: newID })
    .where(eq(MemoryEntryTable.project_id, oldID)).run()
  // Suppression tombstones must follow the facts: losing one can cause a
  // forgotten fact to be re-ingested after the project migration.
  yield* tx.update(MemorySuppressionTable)
    .set({ project_id: newID })
    .where(eq(MemorySuppressionTable.project_id, oldID)).run()
})
