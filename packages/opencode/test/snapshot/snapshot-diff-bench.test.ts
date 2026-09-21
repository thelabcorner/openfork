import { afterEach, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)
const bench = process.env.RUN_CHECKPOINT_OUTPUT_BENCH === "1" ? it.instance : it.instance.skip

afterEach(async () => {
  await disposeAllInstances()
})

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

bench(
  "bounded checkpoint diff avoids full patch materialization for small output budgets",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const fs = yield* FSUtil.Service
      const files = Number(process.env.CHECKPOINT_OUTPUT_BENCH_FILES ?? "64")
      const lines = Number(process.env.CHECKPOINT_OUTPUT_BENCH_LINES ?? "1000")
      const budget = Number(process.env.CHECKPOINT_OUTPUT_BENCH_BYTES ?? "2000")

      for (let start = 0; start < files; start += 16) {
        yield* Effect.all(
          Array.from({ length: Math.min(16, files - start) }, (_, offset) => {
            const i = start + offset
            const content = Array.from({ length: lines }, (_, line) => `before-${i}-${line}-🙂-你好`).join("\n")
            return fs.writeWithDirs(`${tmp.directory}/bench/${String(i).padStart(3, "0")}.txt`, content)
          }),
          { concurrency: "unbounded" },
        )
      }
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()

      for (let start = 0; start < files; start += 16) {
        yield* Effect.all(
          Array.from({ length: Math.min(16, files - start) }, (_, offset) => {
            const i = start + offset
            const content = Array.from({ length: lines }, (_, line) => `after-${i}-${line}-🚀-日本語`).join("\n")
            return fs.writeWithDirs(`${tmp.directory}/bench/${String(i).padStart(3, "0")}.txt`, content)
          }),
          { concurrency: "unbounded" },
        )
      }
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()

      // One warm call per path before measurement.
      yield* snapshot.diffFullBounded(before!, after!, budget)
      yield* snapshot.diffFull(before!, after!)

      const fullMs: number[] = []
      const boundedMs: number[] = []
      let fullBytes = 0
      let boundedBytes = 0
      let boundedFiles = 0
      for (let run = 0; run < 3; run++) {
        let started = performance.now()
        const full = yield* snapshot.diffFull(before!, after!)
        fullMs.push(performance.now() - started)
        fullBytes = full.reduce((sum, item) => sum + Buffer.byteLength(item.patch ?? "", "utf8"), 0)

        started = performance.now()
        const bounded = yield* snapshot.diffFullBounded(before!, after!, budget)
        boundedMs.push(performance.now() - started)
        boundedBytes = bounded.diffs.reduce((sum, item) => sum + Buffer.byteLength(item.patch ?? "", "utf8"), 0)
        boundedFiles = bounded.diffs.length
        expect(bounded.summary).toHaveLength(files)
        expect(bounded.truncated).toBe(true)
        expect(boundedBytes).toBeLessThanOrEqual(budget)
      }

      const result = {
        files,
        linesPerFile: lines,
        budget,
        fullMs: median(fullMs),
        boundedMs: median(boundedMs),
        speedup: median(fullMs) / median(boundedMs),
        fullPatchBytes: fullBytes,
        boundedPatchBytes: boundedBytes,
        boundedMaterializedFiles: boundedFiles,
      }
      console.log("[checkpoint-output-bench]", JSON.stringify(result))
      expect(result.boundedMaterializedFiles).toBeLessThan(files)
    }),
  { git: true },
  300_000,
)
