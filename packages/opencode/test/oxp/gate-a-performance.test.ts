import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OxpAuthority } from "@/oxp/authority"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
import { OxpSchema } from "@/oxp/schema"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-gate-a-perf-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpAuthority.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, globalLayer]],
)
const it = testEffect(layer)

type Stats = { medianMs: number; p95Ms: number; samples: number }

function percentile(sorted: readonly number[], p: number) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index]!
}

function measure<A, E, R>(factory: () => Effect.Effect<A, E, R>, samples: number): Effect.Effect<Stats, E, R> {
  return Effect.gen(function* () {
    const timings: number[] = []
    for (let index = 0; index < samples; index++) {
      const started = performance.now()
      yield* factory()
      timings.push(performance.now() - started)
    }
    timings.sort((left, right) => left - right)
    return {
      medianMs: percentile(timings, 0.5),
      p95Ms: percentile(timings, 0.95),
      samples,
    }
  })
}

function denied<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.match({ onFailure: () => undefined, onSuccess: () => undefined }))
}

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(suite, { recursive: true, force: true })
})

describe("OXP Gate A performance proof", () => {
  it.live(
    "measures cached config, 1/8/32-root admission, warm resolution, and denied escape",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const authority = yield* OxpAuthority.Service

      const rootDirs = Array.from({ length: 32 }, (_, index) => path.join(suite, `root-${index.toString().padStart(2, "0")}`))
      yield* Effect.promise(() => Promise.all(rootDirs.map((directory) => fs.mkdir(directory, { recursive: true }))))
      const file = path.join(rootDirs[0]!, "warm.txt")
      yield* Effect.promise(() => fs.writeFile(file, "warm\n"))

      const approved: OxpSchema.Root[] = []
      approved.push(yield* roots.approve(rootDirs[0]!))
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      // Warm all paths before measuring so this probe primarily exposes OXP wrapper,
      // lookup and canonicalization cost rather than one-time filesystem setup.
      yield* config.get()
      yield* roots.resolvePath(file)
      yield* authority.authorize({
        plane: "augmentation",
        operation: "read",
        phase: "read",
        rootID: approved[0]!.id,
      })

      const cachedConfig = yield* measure(() => config.get(), 2_000)
      const authorize1 = yield* measure(
        () =>
          authority.authorize({
            plane: "augmentation",
            operation: "read",
            phase: "read",
            rootID: approved[0]!.id,
          }),
        250,
      )

      for (let index = 1; index < 8; index++) approved.push(yield* roots.approve(rootDirs[index]!))
      const authorize8 = yield* measure(
        () =>
          authority.authorize({
            plane: "augmentation",
            operation: "read",
            phase: "read",
            rootID: approved[7]!.id,
          }),
        250,
      )

      for (let index = 8; index < 32; index++) approved.push(yield* roots.approve(rootDirs[index]!))
      const authorize32 = yield* measure(
        () =>
          authority.authorize({
            plane: "augmentation",
            operation: "read",
            phase: "read",
            rootID: approved[31]!.id,
          }),
        250,
      )
      const warmResolve = yield* measure(() => roots.resolvePath(file), 250)
      const deniedEscape = yield* measure(
        () => denied(roots.resolvePath(`/${approved[0]!.alias}/../outside.txt`)),
        500,
      )

      const report = { cachedConfig, authorize1, authorize8, authorize32, warmResolve, deniedEscape }
      console.log(`OXP_GATE_A_PERF ${JSON.stringify(report)}`)

      for (const stats of Object.values(report)) {
        expect(Number.isFinite(stats.medianMs)).toBe(true)
        expect(Number.isFinite(stats.p95Ms)).toBe(true)
        expect(stats.medianMs).toBeGreaterThanOrEqual(0)
      }
      // Cached Tier-0 state should remain negligible. Keep the assertion deliberately
      // generous enough for loaded CI while still catching accidental IO/runtime work.
      expect(cachedConfig.medianMs).toBeLessThan(1)
      // Root cardinality must not create a pathological admission slope. Filesystem
      // canonicalization remains intentionally uncached for authority safety.
      expect(authorize32.medianMs).toBeLessThan(authorize1.medianMs * 8 + 2)
    }),
    { timeout: 30_000 },
  )
})
