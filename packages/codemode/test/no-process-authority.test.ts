import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

const sourceRoot = path.resolve(import.meta.dir, "../src")

describe("CodeMode confined process boundary", () => {
  test("engine source contains no ambient subprocess authority", async () => {
    const forbidden = [
      /from\s+["'](?:node:)?child_process["']/,
      /require\(\s*["'](?:node:)?child_process["']\s*\)/,
      /\bBun\.spawn(?:Sync)?\b/,
      /\bDeno\.Command\b/,
      /\bcross-spawn\b/,
    ]
    const offenders: string[] = []
    const glob = new Bun.Glob("**/*.{ts,tsx}")

    for await (const relative of glob.scan({ cwd: sourceRoot, onlyFiles: true })) {
      const text = await Bun.file(path.join(sourceRoot, relative)).text()
      if (forbidden.some((pattern) => pattern.test(text))) offenders.push(relative)
    }

    expect(offenders).toEqual([])
  })

  test("executing generated Code never reaches Bun subprocess primitives", async () => {
    const originalSpawn = Bun.spawn
    const originalSpawnSync = Bun.spawnSync
    let spawnCalls = 0
    let spawnSyncCalls = 0

    Bun.spawn = ((..._args: Parameters<typeof Bun.spawn>) => {
      spawnCalls += 1
      throw new Error("CodeMode attempted Bun.spawn")
    }) as unknown as typeof Bun.spawn
    Bun.spawnSync = ((..._args: Parameters<typeof Bun.spawnSync>) => {
      spawnSyncCalls += 1
      throw new Error("CodeMode attempted Bun.spawnSync")
    }) as unknown as typeof Bun.spawnSync

    try {
      const prepared = CodeMode.prepare(
        'const value = await call("native:lookup", { id: input.id }); return { ok: true, value }',
      )
      const result = await Effect.runPromise(
        CodeMode.executePrepared(prepared, {
          input: { id: "abc" },
          call: () => Effect.succeed({ id: "abc", status: "ok" }),
        }),
      )

      expect(result).toMatchObject({
        ok: true,
        value: { ok: true, value: { id: "abc", status: "ok" } },
      })
      expect(spawnCalls).toBe(0)
      expect(spawnSyncCalls).toBe(0)
    } finally {
      Bun.spawn = originalSpawn
      Bun.spawnSync = originalSpawnSync
    }
  })
})
