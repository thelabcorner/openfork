import { $ } from "bun"
import { expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Project } from "@/project/project"

/** A real second WAL writer makes Project.fromDirectory's first insert fail with SQLITE_BUSY.
 * Release that writer after a bounded delay: the same atomic write must then succeed.
 * This is the exact ACP session/new failure when multiple OpenFork hosts share a DB. */
test("Project.fromDirectory retries the atomic upsert when a peer writer releases SQLITE_BUSY", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-acp-project-busy-"))
  const directory = join(folder, "checkout")
  const filename = join(folder, "openfork.db")
  let holder: Sqlite | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
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
          const database = yield* Database.Service
          const project = yield* Project.Service
          // This is the actual primary-connection policy. With the old 5000ms
          // timeout the synchronous INSERT freezes the event loop, so the peer
          // transaction cannot commit until after the wait has already failed.
          const policy = yield* database.db.get<{ timeout: number }>("PRAGMA busy_timeout")
          expect(policy?.timeout).toBe(75)
          holder = new Sqlite(filename)
          holder.exec("PRAGMA busy_timeout = 0")
          holder.exec("BEGIN IMMEDIATE")
          let released = false
          timer = setTimeout(() => {
            holder!.exec("COMMIT")
            released = true
          }, 450)

          const began = performance.now()
          const outcome = yield* project.fromDirectory(directory)
          const elapsed = performance.now() - began
          expect(released).toBe(true)
          expect(elapsed).toBeGreaterThanOrEqual(400)
          expect(elapsed).toBeLessThan(2500)
          expect(outcome.project.id).not.toBe(ProjectV2.ID.global)
          const stored = yield* project.get(outcome.project.id)
          expect(stored?.id).toBe(outcome.project.id)
        }),
      ).pipe(Effect.provide(graph)),
    )
  } finally {
    if (timer) clearTimeout(timer)
    if (holder) {
      try { holder.exec("ROLLBACK") } catch {}
      holder.close()
    }
    await rm(folder, { recursive: true, force: true })
  }
}, 20_000)
