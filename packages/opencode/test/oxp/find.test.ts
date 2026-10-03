import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpFind } from "@/oxp/find"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-find-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(
  LayerNode.group([CrossSpawnSpawner.node, OxpFind.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, globalLayer]],
)
const it = testEffect(layer)

function attempt<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.match({
      onFailure: (left) => ({ _tag: "Left" as const, left }),
      onSuccess: (right) => ({ _tag: "Right" as const, right }),
    }),
  )
}

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(suite, { recursive: true, force: true })
})

describe("OxpFind", () => {
  it.live("publishes a typed transport envelope and preserves filtered-text search semantics", Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(OxpFind.Parameters, { onExcessProperty: "error" })
    const glob = yield* decode({ rootID: "00000000-0000-4000-8000-000000000001", glob: "*.ts" })
    const grep = yield* decode({ rootID: "00000000-0000-4000-8000-000000000001", grep: "needle", syntax: "literal" })
    const filtered = yield* decode({
      rootID: "00000000-0000-4000-8000-000000000001",
      grep: "needle",
      glob: "*.ts",
      offset: 2,
      limit: 10,
    })
    expect(glob).toMatchObject({ glob: "*.ts" })
    expect(grep).toMatchObject({ grep: "needle", syntax: "literal" })
    expect(filtered).toMatchObject({ grep: "needle", glob: "*.ts", offset: 2, limit: 10 })

    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const find = yield* OxpFind.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "match.ts"), "needle\n"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    const filteredResult = yield* find.execute({ rootID: root.id, glob: "*.ts", grep: "needle" })
    expect(filteredResult.output).toContain("needle")

    const underspecified = yield* find.execute({ rootID: root.id }).pipe(Effect.flip)
    expect(underspecified._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(underspecified.detail).toContain("Invalid OXP find arguments")

    const conflicting = yield* find
      .execute({ rootID: root.id, grep: "needle", glob: "*.ts", include: "*.txt" })
      .pipe(Effect.flip)
    expect(conflicting._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(conflicting.detail).toContain("filters conflict")
  }))

  it.live(
    "searches only an explicitly approved root and projects native paths into the OXP namespace",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => Promise.all([
        fs.writeFile(path.join(rootDir, "a.ts"), "export const a = 1\n"),
        fs.writeFile(path.join(rootDir, "b.txt"), "hello\n"),
      ]))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* find.execute({ glob: "*.ts", rootID: root.id })

      expect(result.output).toContain(`/${root.alias}/a.ts`)
      expect(result.output).not.toContain(rootDir)
      expect(result.metadata?.count).toBe(1)
    }),
  )

  it.live(
    "accepts an explicit virtual-root path without requiring a duplicate root ID",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.ts"), "export const a = 1\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* find.execute({ glob: "*.ts", path: `/${root.alias}` })
      expect(result.output).toContain(`/${root.alias}/a.ts`)
    }),
  )

  it.live(
    "supports exact-file grep without widening the search to siblings",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const target = path.join(rootDir, "target.ts")
      yield* Effect.promise(() => Promise.all([
        fs.writeFile(target, "needle target\n"),
        fs.writeFile(path.join(rootDir, "sibling.ts"), "needle sibling\n"),
      ]))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* find.execute({ grep: "needle", rootID: root.id, path: "target.ts" })

      expect(result.output).toContain(`/${root.alias}/target.ts`)
      expect(result.output).toContain("needle target")
      expect(result.output).not.toContain("sibling")
    }),
  )

  it.live(
    "treats source-code metacharacters literally by default and requires explicit regex opt-in",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(rootDir, "source.ts"),
          [
            "const [data, setData] = tuple",
            "const runtime = makeRuntime(provider)",
            "const alpha = 1",
            "const beta = 2",
          ].join("\n"),
        ),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const bracket = yield* find.execute({ grep: "const [data", rootID: root.id })
      expect(bracket.output).toContain("const [data, setData]")
      expect(bracket.metadata?.syntax).toBe("literal")

      const paren = yield* find.execute({ grep: "makeRuntime(provider", rootID: root.id })
      expect(paren.output).toContain("makeRuntime(provider)")

      const regex = yield* find.execute({ grep: "const (alpha|beta)", syntax: "regex", rootID: root.id })
      expect(regex.metadata?.count).toBe(2)
      expect(regex.metadata?.syntax).toBe("regex")
    }),
  )

  it.live(
    "paginates live grep results without skipping rows hidden by model-facing projection",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(rootDir, "page.ts"),
          Array.from({ length: 5 }, (_, index) => `needle ${index + 1}`).join("\n") + "\n",
        ),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const first = yield* find.execute({ grep: "needle", rootID: root.id, limit: 2 })
      expect(first.output).toContain("Line 1: needle 1")
      expect(first.output).toContain("Line 2: needle 2")
      expect(first.output).not.toContain("Line 3:")
      expect(first.metadata).toMatchObject({
        offset: 0,
        limit: 2,
        count: 2,
        hasMore: true,
        nextOffset: 2,
        complete: false,
        pagination: "live",
      })

      const second = yield* find.execute({ grep: "needle", rootID: root.id, offset: 2, limit: 2 })
      expect(second.output).toContain("Line 3: needle 3")
      expect(second.output).toContain("Line 4: needle 4")
      expect(second.output).not.toContain("Line 1:")
      expect(second.metadata).toMatchObject({
        offset: 2,
        limit: 2,
        count: 2,
        hasMore: true,
        nextOffset: 4,
        complete: false,
      })

      const final = yield* find.execute({ grep: "needle", rootID: root.id, offset: 4, limit: 2 })
      expect(final.output).toContain("Line 5: needle 5")
      expect(final.metadata).toMatchObject({
        offset: 4,
        limit: 2,
        count: 1,
        hasMore: false,
        complete: true,
        truncated: false,
      })
      expect(final.metadata).not.toHaveProperty("nextOffset")

      const invalid = yield* find.execute({ grep: "needle", rootID: root.id, offset: 100_001 }).pipe(Effect.flip)
      expect(invalid._tag).toBe("OXP_INVALID_ARGUMENT")
    }),
  )

  it.live(
    "refuses relative shorthand without an explicit root even when only one root exists",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* attempt(find.execute({ glob: "*.ts", path: "src" }))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_ROOT_REQUIRED")
    }),
  )

  it.live(
    "requires live read authority rather than treating discovery or a root grant as execution authority",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)

      const result = yield* attempt(find.execute({ glob: "*.ts", rootID: root.id }))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_AUTH_DENIED")
    }),
  )

  it.live(
    "applies the shared 96 KiB model-facing projection bound after producer limits",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const payload = `needle ${"x".repeat(1_990)}\n`
      yield* Effect.promise(() => Promise.all(Array.from({ length: 100 }, (_, index) =>
        fs.writeFile(path.join(rootDir, `f-${index}.txt`), payload),
      )))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* find.execute({ grep: "needle", rootID: root.id, include: "*.txt" })
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(96 * 1024)
      expect(result.metadata).toMatchObject({
        projectionTruncated: false,
        pageTruncated: true,
        truncated: true,
        hasMore: true,
        complete: false,
      })
      expect(typeof result.metadata?.nextOffset).toBe("number")
      expect(result.output).not.toContain(rootDir)
    }),
    { timeout: 15_000 },
  )

  it.live(
    "serves 1/3/6 concurrent searches through the same explicit approved root",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(path.join(rootDir, "a.txt"), "fanout needle a\n"),
          fs.writeFile(path.join(rootDir, "b.txt"), "fanout needle b\n"),
        ]),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      for (const count of [1, 3, 6] as const) {
        const results = yield* Effect.all(
          Array.from({ length: count }, () =>
            find.execute({ grep: "fanout needle", rootID: root.id, include: "*.txt" }),
          ),
          { concurrency: "unbounded" },
        )
        expect(results).toHaveLength(count)
        for (const result of results) {
          expect(result.metadata?.count).toBe(2)
          expect(result.output).not.toContain(rootDir)
        }
      }
    }),
  )

  it.live(
    "propagates cancellation into the shared search executor",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const find = yield* OxpFind.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.ts"), "needle\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const controller = new AbortController()
      controller.abort()

      const result = yield* attempt(find.execute({ grep: "needle", rootID: root.id }, controller.signal))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_CANCELLED")
    }),
  )
})
