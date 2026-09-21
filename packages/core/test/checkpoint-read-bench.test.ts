import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Checkpoint } from "@opencode-ai/core/checkpoint"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionCheckpointTable, SessionTable } from "@opencode-ai/core/session/sql"
import { RelativePath } from "@opencode-ai/schema/schema"

const bench = process.env.RUN_CHECKPOINT_READ_BENCH === "1" ? test : test.skip

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

const percentiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
  return { p50: at(50), p95: at(95), p99: at(99) }
}

bench(
  "Checkpoint.ReadService bounded/indexed read costs and 1/3/6 contention",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-checkpoint-read-bench-"))
    const filename = path.join(directory, "checkpoint.sqlite")
    const layer = LayerNode.compile(
      LayerNode.group([Database.node, Checkpoint.readNode]),
      [[Database.node, Database.layerFromPath(filename)]],
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const checkpoint = yield* Checkpoint.ReadService
          const rows = Number(process.env.CHECKPOINT_READ_BENCH_ROWS ?? "10000")
          const sessions = Number(process.env.CHECKPOINT_READ_BENCH_SESSIONS ?? "50")
          const rareIndex = Math.max(0, Math.floor(rows * 0.9) - 73)
          const pathsPerCheckpoint = 8
          const patch = "x".repeat(256)
          const projectID = "prj_checkpoint_read_bench"
          const now = Date.now()

          yield* db
            .insert(ProjectTable)
            .values({
              id: projectID as any,
              worktree: "C:/checkpoint-read-bench" as any,
              sandboxes: [],
              time_created: now,
              time_updated: now,
            })
            .run()
            .pipe(Effect.orDie)

          yield* db
            .insert(SessionTable)
            .values(
              Array.from({ length: sessions }, (_, i) => ({
                id: `ses_bench_${String(i).padStart(3, "0")}` as any,
                project_id: projectID as any,
                slug: `bench-${i}`,
                directory: "C:/checkpoint-read-bench" as any,
                title: `Checkpoint Bench Session ${i}`,
                agent: `agent-${i % 4}`,
                version: "test",
                time_created: now + i,
                time_updated: now + i,
              })),
            )
            .run()
            .pipe(Effect.orDie)

          const insertStarted = performance.now()
          for (let start = 0; start < rows; start += 200) {
            const batch = Array.from({ length: Math.min(200, rows - start) }, (_, offset) => {
              const i = start + offset
              const session = i % sessions
              const ordinal = Math.floor(i / sessions) + 1
              const diff = Array.from({ length: pathsPerCheckpoint }, (_, j) => ({
                path: RelativePath.make(
                  j === 0 && i === rareIndex
                    ? "src/rare/ProjectedNeedle.ts"
                    : `src/pkg-${session}/file-${j}.ts`,
                ),
                status: "modified" as const,
                additions: j + 1,
                deletions: j,
                patch,
              }))
              return {
                id: `cp_bench_${String(i).padStart(8, "0")}`,
                session_id: `ses_bench_${String(session).padStart(3, "0")}` as any,
                ordinal,
                kind: "turn",
                status: "ready",
                user_message_id: `msg_bench_${i}`,
                diff,
                additions: 36,
                deletions: 28,
                files: pathsPerCheckpoint,
                epoch: i < rows * 0.9 ? "epoch-a" : "epoch-b",
                created_at: i,
                finalized_at: i,
              }
            })
            yield* db.insert(SessionCheckpointTable).values(batch).run().pipe(Effect.orDie)
          }
          const seedMs = performance.now() - insertStarted

          const measure = Effect.fnUntraced(function* (
            operation: () => Effect.Effect<unknown>,
            rounds = 15,
          ) {
            yield* operation()
            const values: number[] = []
            for (let i = 0; i < rounds; i++) {
              const started = performance.now()
              yield* operation()
              values.push(performance.now() - started)
            }
            return percentiles(values)
          })

          const sessionID = "ses_bench_027"
          const exactID = `cp_bench_${String(rareIndex).padStart(8, "0")}`
          const listSession = () => checkpoint.list({ scope: { sessionID }, limit: 50 })
          const listWorktree = () => checkpoint.list({ scope: { epoch: "epoch-a" }, limit: 50 })
          const exact = () => checkpoint.resolveCheckpoint(exactID)
          const touched = () =>
            checkpoint.search({
              scope: { epoch: "epoch-a" },
              touchedPath: "rare/ProjectedNeedle.ts",
              limit: 50,
            })

          const concurrency = Effect.fnUntraced(function* (
            n: number,
            operation: () => Effect.Effect<unknown>,
          ) {
            return yield* measure(
              () => Effect.all(Array.from({ length: n }, operation), { concurrency: "unbounded", discard: true }),
              11,
            )
          })

          const results = {
            rows,
            sessions,
            pathsPerCheckpoint,
            seedMs,
            databaseBytes: (yield* Effect.promise(() => fs.stat(filename))).size,
            sessionList: yield* measure(listSession),
            worktreeList: yield* measure(listWorktree),
            exactCheckpoint: yield* measure(exact, 25),
            rareTouchedPath: yield* measure(touched, 11),
            concurrentWorktreeList: {
              one: yield* concurrency(1, listWorktree),
              three: yield* concurrency(3, listWorktree),
              six: yield* concurrency(6, listWorktree),
            },
            concurrentTouchedPath: {
              one: yield* concurrency(1, touched),
              three: yield* concurrency(3, touched),
              six: yield* concurrency(6, touched),
            },
          }
          console.log("[checkpoint-read-bench]", JSON.stringify(results))

          const sanity = yield* listWorktree()
          expect(sanity.rows).toHaveLength(50)
          expect(sanity.total).toBe(Math.ceil(rows * 0.9))
          expect((yield* exact()).map((row) => row.id)).toEqual([exactID])
          expect((yield* touched()).rows.map((row) => row.id)).toEqual([exactID])

          // Keep accidental order-of-magnitude regressions visible without
          // pretending CI hardware has a universal latency budget.
          expect(median([results.worktreeList.p50, results.worktreeList.p95])).toBeLessThan(250)
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  300_000,
)
