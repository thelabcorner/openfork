import { $ } from "bun"
import { Database as NativeSQLite } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Project } from "@/project/project"

test("reopening an unchanged project creates no WAL commit, and preserves user-owned metadata", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-project-read-admission-"))
  const directory = join(folder, "checkout")
  const filename = join(folder, "openfork.db")
  let observer: NativeSQLite | undefined
  try {
    await mkdir(directory)
    await $`git init`.cwd(directory).quiet()
    await $`git -c user.name=OpenFork -c user.email=test@openfork.dev commit --allow-empty -m seed`.cwd(directory).quiet()
    const graph = AppNodeBuilder.build(
      LayerNode.group([Project.node, Database.node, CrossSpawnSpawner.node]),
      [[Database.node, Database.layerFromPath(filename)]],
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const projects = yield* Project.Service
          const first = yield* projects.fromDirectory(directory)

          // The authoritative mutation path may update icon/user metadata
          // independently. Workspace discovery must not overwrite these fields.
          yield* db.update(ProjectTable).set({
            name: "Custom name",
            commands: { start: "echo retained" },
            icon_color: "#00ff00",
          }).where(eq(ProjectTable.id, first.project.id)).run().pipe(Effect.orDie)
          const userEdited = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, first.project.id)).get().pipe(Effect.orDie)

          observer = new NativeSQLite(filename)
          observer.exec("PRAGMA busy_timeout = 0")
          const version = () => (observer!.query("PRAGMA data_version").get() as { data_version: number }).data_version
          const before = version()
          for (let i = 0; i < 3; i++) {
            const result = yield* projects.fromDirectory(directory)
            expect(result.project.id).toBe(first.project.id)
          }
          const after = version()
          expect(after).toBe(before)
          const saved = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, first.project.id)).get().pipe(Effect.orDie)
          expect(saved?.time_updated).toBe(userEdited?.time_updated)
          expect(saved?.name).toBe("Custom name")
          expect(saved?.commands).toEqual({ start: "echo retained" })
          expect(saved?.icon_color).toBe("#00ff00")
        }),
      ).pipe(Effect.provide(graph)),
    )
  } finally {
    observer?.close()
    await rm(folder, { recursive: true, force: true })
  }
}, 30_000)