import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { DelegatedWorker } from "@/session/delegated-worker"
import { SessionGroup } from "@/session/group"
import { ToolRegistry } from "@/tool/registry"

const suite = path.join(os.tmpdir(), "openfork-oxp-app-runtime-" + process.pid)

afterAll(async () => {
  await fs.rm(suite, { recursive: true, force: true })
})

describe("OXP AppRuntime wiring", () => {
  test("provides OfxpPeer as an explicit global AppRuntime invariant", async () => {
    const peers = await AppRuntime.runPromise(
      OfxpPeer.Service.use((service) => service.list()),
    )
    expect(Array.isArray(peers)).toBe(true)
  })

  test("boots a real instance ToolRegistry with OFXP available", async () => {
    const directory = path.join(suite, "workspace")
    await fs.mkdir(directory, { recursive: true })

    const ids = await AppRuntime.runPromise(
      InstanceStore.Service.use((instances) =>
        instances.provide(
          { directory },
          ToolRegistry.Service.use((registry) => registry.ids()),
        ),
      ),
    )

    expect(ids).toContain("ofxp")
  }, 30_000)

  test("exports SessionGroup for OXP delegated batch control", async () => {
    const directory = path.join(suite, "delegated-batch-workspace")
    await fs.mkdir(directory, { recursive: true })

    const capabilities = await AppRuntime.runPromise(
      InstanceStore.Service.use((instances) =>
        instances.provide(
          { directory },
          SessionGroup.Service.use((groups) => groups.capabilities()),
        ),
      ),
    )

    expect(capabilities.version).toBeGreaterThan(0)
  }, 30_000)

  test("provides SessionExecutionOwner and boots the real delegated-worker service graph", async () => {
    const directory = path.join(suite, "delegated-worker-workspace")
    await fs.mkdir(directory, { recursive: true })

    const ready = await AppRuntime.runPromise(
      InstanceStore.Service.use((instances) =>
        instances.provide(
          { directory },
          Effect.gen(function* () {
            const owner = yield* SessionExecutionOwner.Service
            expect(typeof owner.tryAcquire).toBe("function")
            yield* DelegatedWorker.make
            return true
          }),
        ),
      ),
    )

    expect(ready).toBe(true)
  }, 30_000)
})
