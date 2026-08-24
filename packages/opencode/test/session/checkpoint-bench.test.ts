import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { TurnCheckpoint } from "../../src/session/checkpoint"
import { Snapshot } from "../../src/snapshot"
import { InstanceState } from "@/effect/instance-state"
import { SessionCheckpointTable } from "@opencode-ai/core/session/sql"
import {
  disposeAllInstances,
  testInstanceStoreLayer,
  TestInstance,
} from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { seedSessionRow } from "./checkpoint-seed"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([TurnCheckpoint.node, Snapshot.node, Database.node])),
    testInstanceStoreLayer,
  ),
)

const percentiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
  return { p50: at(50), p95: at(95), p99: at(99) }
}

// Env-gated (§51): RUN_CHECKPOINT_BENCH=1 bun test ./test/session/checkpoint-bench.test.ts
// Scale via CHECKPOINT_BENCH_FILES (default 1000) and CHECKPOINT_BENCH_TURNS (default 5).
const bench = process.env.RUN_CHECKPOINT_BENCH === "1" ? it.instance : it.instance.skip

bench(
  "checkpoint throughput: pre-turn capture, finalize, diff latencies",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const dir = tmp.directory
      const svc = yield* TurnCheckpoint.Service
      const snapshot = yield* Snapshot.Service
      const sessionID = "ses_checkpoint_bench"
      yield* seedSessionRow(sessionID)

      const fileCount = Number(process.env.CHECKPOINT_BENCH_FILES ?? "1000")
      const turns = Number(process.env.CHECKPOINT_BENCH_TURNS ?? "5")
      const changedPerTurn = 10

      // Seed a synthetic repo.
      for (let chunkStart = 0; chunkStart < fileCount; chunkStart += 100) {
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: Math.min(100, fileCount - chunkStart) }, (_, i) =>
              Bun.write(path.join(dir, `seed-${chunkStart + i}.txt`), `seed content ${chunkStart + i}`),
            ),
          ),
        )
      }
      expect(yield* snapshot.track()).toBeTruthy()

      const beginMs: number[] = []
      const cycleMs: number[] = []
      let diffMs = 0

      for (let t = 0; t < turns; t++) {
        let t0 = performance.now()
        const turn = yield* svc.begin({ sessionID: sessionID as any, userMessageID: `bench_msg_${t}` })
        beginMs.push(performance.now() - t0)
        yield* Fiber.join(turn!.beforeFiber)

        for (let c = 0; c < changedPerTurn; c++) {
          yield* Effect.promise(() =>
            Bun.write(path.join(dir, `seed-${t * changedPerTurn + c}.txt`), `changed at turn ${t} write ${c}`),
          )
        }

        t0 = performance.now()
        yield* svc.finish(turn)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const db = (yield* Database.Service).db
            const row = yield* db
              .select()
              .from(SessionCheckpointTable)
              .where(eq(SessionCheckpointTable.user_message_id, `bench_msg_${t}`))
              .get()
              .pipe(Effect.orDie)
            return row && row.status !== "capturing" ? row : undefined
          }),
          `bench turn ${t} never finalized`,
          120_000,
        )
        cycleMs.push(performance.now() - t0)

        if (t === turns - 1) {
          const db = (yield* Database.Service).db
          const row = yield* db
            .select()
            .from(SessionCheckpointTable)
            .where(eq(SessionCheckpointTable.user_message_id, `bench_msg_${t}`))
            .get()
            .pipe(Effect.orDie)
          const d0 = performance.now()
          const diff = yield* snapshot.diffFull(row!.before_snapshot!, row!.after_snapshot!)
          diffMs = performance.now() - d0
          expect(diff.length).toBe(changedPerTurn)
        }
      }

      const ctx = yield* InstanceState.context
      const results = {
        files: fileCount,
        turns,
        changedPerTurn,
        platform: process.platform,
        worktree: ctx.worktree,
        beginMs: percentiles(beginMs),
        fullCycleMs: percentiles(cycleMs),
        lastDiffMs: diffMs,
      }
      // bun test swallows Effect logs; print directly so CI captures the numbers.
      console.log("[checkpoint-bench]", JSON.stringify(results))
      // Sanity only — real budgets are machine-relative; see logged percentiles.
      expect(beginMs.every((ms) => ms < 5_000)).toBe(true)
    }),
  { git: true },
  600_000,
)
