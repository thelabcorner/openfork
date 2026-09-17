import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(FSUtil.node))

describe("FSUtil.copyFileAtomic", () => {
  it.live(
    "never leaves a partial or zeroed target under concurrent writers",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const source = `${tmp.path}/source`
            const target = `${tmp.path}/target`
            const payload = new Uint8Array(256 * 1024)
            for (let index = 0; index < payload.length; index++) payload[index] = index % 251
            yield* fs.writeFile(source, payload)

            // A plain copyFile can interleave with a sibling writer and leave a
            // truncated/zero target; the atomic version must always be complete.
            yield* Effect.all(
              Array.from({ length: 8 }, () => fs.copyFileAtomic(source, target)),
              { concurrency: "unbounded" },
            )

            const result = yield* fs.readFile(target)
            expect(result.length).toBe(payload.length)
            expect(Buffer.from(result).equals(Buffer.from(payload))).toBe(true)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    { timeout: 30_000 },
  )
})
