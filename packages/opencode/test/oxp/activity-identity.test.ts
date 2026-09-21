import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { OxpActivityIdentity } from "@/oxp/activity-identity"
import { testEffect } from "../lib/effect"

const suite = path.join(
  os.tmpdir(),
  `opencode-oxp-activity-identity-${randomUUID()}`,
)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(OxpActivityIdentity.node, [
  [Global.node, Global.layerWith({ config: configDir, state: stateDir })],
])
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpActivityIdentity", () => {
  it.live(
    "persists one private key while never persisting the raw upstream correlation",
    Effect.gen(function* () {
      const identity = yield* OxpActivityIdentity.Service
      const raw = "upstream-parent-secret-123"
      const first = yield* identity.pseudonymize({
        scheme: "openai/session",
        value: raw,
        scope: "conversation",
      })
      const second = yield* identity.pseudonymize({
        scheme: "openai/session",
        value: raw,
        scope: "conversation",
      })
      const other = yield* identity.pseudonymize({
        scheme: "openai/session",
        value: "other-parent",
        scope: "conversation",
      })
      expect(first).toEqual(second)
      expect(first.scheme).toBe("openai/session")
      expect(first.scope).toBe("conversation")
      expect(first.digest).not.toBe(raw)
      expect(other.digest).not.toBe(first.digest)

      const key = yield* Effect.promise(() =>
        fs.readFile(path.join(configDir, "oxp-activity.key"), "utf8"),
      )
      expect(key).not.toContain(raw)
      expect(key.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    }),
  )
})

