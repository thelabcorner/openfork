import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OxpConfig } from "@/oxp/config"
import { OxpSchema } from "@/oxp/schema"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-config-${randomUUID()}`)
const configDir = path.join(suite, "config")
const stateDir = path.join(suite, "state")
const configFile = path.join(configDir, "oxp.json")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(OxpConfig.node, [[Global.node, globalLayer]])
const it = testEffect(layer)

const baseFs = AppNodeBuilder.build(FSUtil.node)
const failingFs = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const actual = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...actual,
      rename: (_from, to) => actual.rename(path.join(suite, "forced-missing-source"), to),
    })
  }),
).pipe(Layer.provide(baseFs))
const failingLayer = AppNodeBuilder.build(OxpConfig.node, [
  [Global.node, globalLayer],
  [FSUtil.node, failingFs],
])
const failingIt = testEffect(failingLayer)

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

describe("OxpConfig", () => {
  it.live(
    "creates disabled-safe defaults once with a stable connector identity",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const first = yield* config.get()
      const bytes = yield* Effect.promise(() => fs.readFile(configFile, "utf8"))
      const second = yield* config.get()
      const reloaded = yield* config.reload()

      expect(first.enabled).toBe(false)
      expect(first.roots).toEqual([])
      expect(first.grant).toEqual(OxpSchema.DEFAULT_GRANT)
      expect(first.connector.id).toBe(second.connector.id)
      expect(first.connector.id).toBe(reloaded.connector.id)
      expect(yield* Effect.promise(() => fs.readFile(configFile, "utf8"))).toBe(bytes)
    }),
  )

  it.live(
    "normalizes legacy configs with no automation grant to false without rewriting them",
    Effect.gen(function* () {
      const legacy = OxpSchema.defaults(OxpSchema.ConnectorID.make(randomUUID()))
      const { automation: _automation, ...legacyGrant } = legacy.grant
      const bytes = JSON.stringify({ ...legacy, grant: legacyGrant }, null, 2) + "\\n"
      yield* Effect.promise(() => fs.writeFile(configFile, bytes, { mode: 0o600 }))

      const config = yield* OxpConfig.Service
      const current = yield* config.get()

      expect(current.grant.automation).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(configFile, "utf8"))).toBe(bytes)
      expect(bytes).not.toContain('"automation"')
    }),
  )

  it.live(
    "increments revision exactly once per semantic mutation and not for no-ops",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const initial = yield* config.get()
      const noOp = yield* config.setEnabled(false)
      const enabled = yield* config.setEnabled(true)
      const repeated = yield* config.setEnabled(true)

      expect(initial.revision).toBe(1)
      expect(noOp.revision).toBe(1)
      expect(enabled.revision).toBe(2)
      expect(repeated.revision).toBe(2)
    }),
  )

  it.live(
    "accepts legacy workerPolicy on read but strips it from live state and the next semantic write",
    Effect.gen(function* () {
      const legacy = {
        ...OxpSchema.defaults(OxpSchema.ConnectorID.make(randomUUID())),
        workerPolicy: {
          models: [{ providerID: "workbuddy", modelID: "deepseek-v4.1-flash" }],
          agents: ["build"],
          defaultModel: { providerID: "workbuddy", modelID: "deepseek-v4.1-flash" },
          defaultAgent: "build",
        },
      }
      yield* Effect.promise(() =>
        fs.writeFile(configFile, JSON.stringify(legacy, null, 2) + "\n", { mode: 0o600 }),
      )
      const config = yield* OxpConfig.Service
      const current = yield* config.get()
      expect(current.workerPolicy).toBeUndefined()

      const enabled = yield* config.setEnabled(true)
      expect(enabled.workerPolicy).toBeUndefined()
      expect(yield* Effect.promise(() => fs.readFile(configFile, "utf8"))).not.toContain('"workerPolicy"')
    }),
  )

  it.live(
    "serializes concurrent mutations without losing updates",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      yield* config.get()
      yield* Effect.all([config.setGrant({ read: true }), config.setGrant({ write: true })], {
        concurrency: "unbounded",
      })
      const current = yield* config.reload()

      expect(current.grant.read).toBe(true)
      expect(current.grant.write).toBe(true)
      expect(current.revision).toBe(3)
    }),
  )

  it.live(
    "normalizes dependent supervision and delegation grants at the authority source",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      yield* config.get()
      const elevated = yield* config.setGrant({
        sessionSupervision: "approved-roots",
        requestSupervision: true,
        delegation: "spawn",
        nestedDelegation: true,
      })
      expect(elevated.grant.requestSupervision).toBe(true)
      expect(elevated.grant.nestedDelegation).toBe(true)

      const narrowed = yield* config.setGrant({ sessionSupervision: "none", delegation: "disabled" })
      expect(narrowed.grant.sessionSupervision).toBe("none")
      expect(narrowed.grant.requestSupervision).toBe(false)
      expect(narrowed.grant.delegation).toBe("disabled")
      expect(narrowed.grant.nestedDelegation).toBe(false)
    }),
  )

  it.live(
    "treats malformed or excess-property configuration as disabled and refuses overwrite",
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.writeFile(configFile, '{"enabled":true,"tunnelApiKey":"secret"}'))
      const config = yield* OxpConfig.Service
      const safe = yield* config.get()
      const mutation = yield* attempt(config.setEnabled(true))

      expect(safe.enabled).toBe(false)
      expect(safe.roots).toEqual([])
      expect(mutation._tag).toBe("Left")
      if (mutation._tag === "Left") expect(mutation.left._tag).toBe("OXP_CONFLICT")
      expect(yield* Effect.promise(() => fs.readFile(configFile, "utf8"))).toContain("tunnelApiKey")
    }),
  )

  it.live(
    "rejects secret or desktop transport fields introduced by an update",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const initial = yield* config.get()
      const mutation = yield* attempt(
        config.update((current) => ({ ...current, tunnelApiKey: "secret" }) as unknown as OxpSchema.Config),
      )
      const current = yield* config.reload()

      expect(mutation._tag).toBe("Left")
      if (mutation._tag === "Left") expect(mutation.left._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(current.revision).toBe(initial.revision)
      expect(JSON.parse(yield* Effect.promise(() => fs.readFile(configFile, "utf8")))).not.toHaveProperty("tunnelApiKey")
    }),
  )

  failingIt.live(
    "keeps the previously committed file intact when atomic publication fails",
    Effect.gen(function* () {
      const original = OxpSchema.defaults(OxpSchema.ConnectorID.make(randomUUID()))
      yield* Effect.promise(() => fs.writeFile(configFile, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 }))
      const before = yield* Effect.promise(() => fs.readFile(configFile, "utf8"))
      const config = yield* OxpConfig.Service
      const result = yield* attempt(config.setEnabled(true))
      const after = yield* Effect.promise(() => fs.readFile(configFile, "utf8"))

      expect(result._tag).toBe("Left")
      expect(after).toBe(before)
    }),
  )
})
