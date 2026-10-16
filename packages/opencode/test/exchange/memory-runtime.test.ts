import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { ExchangeMemory } from "../../src/exchange/memory"
import { dispose } from "../../src/exchange/memory-read-runtime"
import { tmpdir } from "../fixture/fixture"

describe("Tier-1 Exchange memory reads", () => {
  test("read actions bypass the V1 config/plugin bootstrap while retaining memory and Session authority boundaries", async () => {
    await using temp = await tmpdir()
    const configDir = join(temp.path, ".openfork")
    await mkdir(configDir, { recursive: true })
    // Full InstanceStore bootstrapping parses this workspace config. Memory
    // reads are durable DB operations and must not touch it.
    await writeFile(join(configDir, "openfork.json"), "{ malformed workspace config")

    try {
      const context = { rootPath: temp.path, sessionSearchAuthorized: false }
      const map = await Effect.runPromise(ExchangeMemory.executeRuntime({ action: "map" }, context))
      expect(map.metadata.action).toBe("map")
      // First read must not implicitly insert four empty seed topics.
      expect(map.metadata.topics).toBe(0)
      expect(map.metadata.runtimeTimingMs).toMatchObject({
        identity: expect.any(Number),
        operation: expect.any(Number),
      })

      const saved = await Effect.runPromise(ExchangeMemory.executeRuntime({
        action: "search", query: "nonexistent_unique_latency_anchor", sources: "memory",
      }, context))
      expect(saved.structured.sessionEvidence).toEqual({ status: "skipped" })

      const denied = await Effect.runPromise(ExchangeMemory.executeRuntime({
        action: "search", query: "nonexistent_unique_latency_anchor",
      }, context))
      expect(denied.structured.sessionEvidence).toEqual({ status: "not_authorized" })
      expect(denied.metadata.sessionCount).toBe(0)

      const controller = new AbortController()
      controller.abort()
      await expect(Effect.runPromise(ExchangeMemory.executeRuntime({
        action: "map",
      }, { ...context, signal: controller.signal }))).rejects.toThrow()
    } finally {
      await dispose()
    }
  })
})
