import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import {
  OPENFORK_ACTIVITY_FENCE_CONFIG_FILENAME,
  openForkActivityFenceAuthorization,
  openForkActivityFenceConfigPath,
  parseOpenForkActivityFenceConfig,
  provisionOpenForkActivityFenceConfig,
  redactedOpenForkActivityFenceConfig,
  serializeOpenForkActivityFenceConfig,
  type FenceConfigError,
} from "../../src/worktree/managed/fence-config"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node])))

const scopedTmpdir = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const INSTANCE_ID = "desktop:launch-a"
const REALM_ID = "realm:0123456789abcdef0123456789abcdef"

function controlPlaneRoot(tmp: string): string {
  const root = path.join(tmp, "worktree-store")
  mkdirSync(root, { recursive: true })
  return root
}

function provision(
  root: string,
  overrides: Partial<{ expectedInstanceID: string; expectedRealmID: string; authorization: string }> = {},
  options: Partial<{ discoveryDirectory: string; allowLiveInstanceTakeover: boolean }> = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return yield* provisionOpenForkActivityFenceConfig(fs, {
      controlPlaneRoot: root,
      config: {
        configVersion: 1,
        expectedInstanceID: overrides.expectedInstanceID ?? INSTANCE_ID,
        expectedRealmID: overrides.expectedRealmID ?? REALM_ID,
        ...(overrides.authorization === undefined ? {} : { authorization: overrides.authorization }),
      },
      ...options,
    })
  })
}

function provisionError(root: string, overrides: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return provision(root, overrides, options).pipe(Effect.flip)
}

function descriptorDirectory(tmp: string, instanceID: string, processID: number): string {
  const directory = path.join(tmp, "service-discovery")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    path.join(directory, "descriptor.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      url: "http://127.0.0.1:4096",
      realmID: REALM_ID,
      instanceID,
      processID,
      startedAt: "2026-01-01T00:00:00.000Z",
      version: "0.0.1",
    })}\n`,
    "utf8",
  )
  return directory
}

describe("activity-fence config parsing", () => {
  test("accepts exactly the frozen shape and rejects unknown keys", () => {
    const parsed = parseOpenForkActivityFenceConfig({
      configVersion: 1,
      expectedInstanceID: INSTANCE_ID,
      expectedRealmID: REALM_ID,
      authorization: "Basic c2VjcmV0",
    })
    expect(parsed.expectedInstanceID).toBe(INSTANCE_ID)
    expect(parsed.authorization).toBe("Basic c2VjcmV0")

    expect(() => parseOpenForkActivityFenceConfig({ configVersion: 1, expectedInstanceID: INSTANCE_ID, extra: true })).toThrow()
    expect(() => parseOpenForkActivityFenceConfig({ configVersion: 2, expectedInstanceID: INSTANCE_ID })).toThrow()
    expect(() => parseOpenForkActivityFenceConfig({ configVersion: 1 })).toThrow()
    expect(() => parseOpenForkActivityFenceConfig({ configVersion: 1, expectedInstanceID: "x\ny" })).toThrow()
    expect(() => parseOpenForkActivityFenceConfig({ configVersion: 1, expectedInstanceID: INSTANCE_ID, authorization: "" })).toThrow()
  })

  test("serializes deterministically and never emits the credential in the diagnostic projection", () => {
    const config = { configVersion: 1 as const, expectedInstanceID: INSTANCE_ID, authorization: "Basic c2VjcmV0" }
    expect(serializeOpenForkActivityFenceConfig(config)).toBe(`${JSON.stringify(config, null, 2)}\n`)
    const projection = redactedOpenForkActivityFenceConfig(config)
    expect(projection.authorization).toBe("[redacted]")
    expect(JSON.stringify(projection)).not.toContain("c2VjcmV0")
  })

  test("only accepts an explicitly named worktree-store directory", () => {
    expect(openForkActivityFenceConfigPath("C:\\state\\worktree-store")).toBe(
      path.join("C:\\state\\worktree-store", OPENFORK_ACTIVITY_FENCE_CONFIG_FILENAME),
    )
    expect(openForkActivityFenceConfigPath("/var/lib/WORKTREE-STORE")).toContain(OPENFORK_ACTIVITY_FENCE_CONFIG_FILENAME)
    expect(() => openForkActivityFenceConfigPath("worktree-store")).toThrow()
    expect(() => openForkActivityFenceConfigPath("C:\\state\\elsewhere")).toThrow()
  })

  test("composes the per-launch authorization from the server credentials", () => {
    expect(openForkActivityFenceAuthorization({})).toBeUndefined()
    expect(openForkActivityFenceAuthorization({ OPENCODE_SERVER_PASSWORD: "secret" })).toBeUndefined()
    expect(
      openForkActivityFenceAuthorization({ OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "secret" }),
    ).toBe(`Basic ${Buffer.from("opencode:secret", "utf8").toString("base64")}`)
  })
})

describe("activity-fence config provisioning", () => {
  it.live("writes a new config with owner-only permissions where the platform permits", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const root = controlPlaneRoot(tmp.path)
      const result = yield* provision(root, { authorization: "Basic c2VjcmV0" })
      expect(result.state).toBe("written")
      const file = path.join(root, OPENFORK_ACTIVITY_FENCE_CONFIG_FILENAME)
      expect(result.file).toBe(file)
      const written = JSON.parse(readFileSync(file, "utf8"))
      expect(written).toEqual({
        configVersion: 1,
        expectedInstanceID: INSTANCE_ID,
        expectedRealmID: REALM_ID,
        authorization: "Basic c2VjcmV0",
      })
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o077).toBe(0)
      }
    }),
  )

  it.live("is idempotent for identical bytes and rotates only the credential for the same instance", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const root = controlPlaneRoot(tmp.path)
      expect((yield* provision(root, { authorization: "Basic b25l" })).state).toBe("written")
      expect((yield* provision(root, { authorization: "Basic b25l" })).state).toBe("unchanged")
      expect((yield* provision(root, { authorization: "Basic dHdv" })).state).toBe("written")
      const written = JSON.parse(readFileSync(path.join(root, OPENFORK_ACTIVITY_FENCE_CONFIG_FILENAME), "utf8"))
      expect(written.authorization).toBe("Basic dHdv")
    }),
  )

  it.live("refuses to overwrite an existing config it cannot strictly parse", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const root = controlPlaneRoot(tmp.path)
      const file = path.join(root, OPENFORK_ACTIVITY_FENCE_CONFIG_FILENAME)
      writeFileSync(file, '{ "configVersion": 1, "expectedInstanceID": "other", "secret": "keep-me" }', "utf8")
      const error = yield* provisionError(root)
      expect((error as FenceConfigError).code).toBe("config-unreadable")
      expect(JSON.stringify(error)).not.toContain("keep-me")

      writeFileSync(file, "not json", "utf8")
      const malformed = yield* provisionError(root)
      expect((malformed as FenceConfigError).code).toBe("config-unreadable")
      expect(readFileSync(file, "utf8")).toBe("not json")
    }),
  )

  it.live("refuses a root that is missing or not named worktree-store", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const missing = yield* provisionError(path.join(tmp.path, "worktree-store"))
      expect((missing as FenceConfigError).code).toBe("config-root-missing")

      mkdirSync(path.join(tmp.path, "elsewhere"), { recursive: true })
      const invalid = yield* provisionError(path.join(tmp.path, "elsewhere"))
      expect((invalid as FenceConfigError).code).toBe("config-path-invalid")
    }),
  )

  it.live("refuses to replace a config owned by a different live instance unless explicitly allowed", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const root = controlPlaneRoot(tmp.path)
      expect((yield* provision(root, { expectedInstanceID: "desktop:other-launch" })).state).toBe("written")

      const discoveryDirectory = descriptorDirectory(tmp.path, "desktop:other-launch", process.pid)
      const refused = yield* provisionError(root, {}, { discoveryDirectory })
      expect((refused as FenceConfigError).code).toBe("config-owned-by-live-instance")

      const unverifiable = yield* provisionError(root)
      expect((unverifiable as FenceConfigError).code).toBe("config-owner-unverifiable")

      const takeover = yield* provision(root, {}, { discoveryDirectory, allowLiveInstanceTakeover: true })
      expect(takeover.state).toBe("written")
      const written = JSON.parse(readFileSync(takeover.file, "utf8"))
      expect(written.expectedInstanceID).toBe(INSTANCE_ID)
    }),
  )

  it.live("rotates a different instance's config once that instance is provably dead", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const root = controlPlaneRoot(tmp.path)
      expect((yield* provision(root, { expectedInstanceID: "desktop:dead-launch" })).state).toBe("written")
      const discoveryDirectory = descriptorDirectory(tmp.path, "desktop:dead-launch", 2_147_483_646)
      const rotated = yield* provision(root, {}, { discoveryDirectory })
      expect(rotated.state).toBe("written")
      expect(JSON.parse(readFileSync(rotated.file, "utf8")).expectedInstanceID).toBe(INSTANCE_ID)
    }),
  )

  it.live("never echoes the existing credential in a refusal", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const root = controlPlaneRoot(tmp.path)
      const secret = `Basic ${Buffer.from("opencode:super-secret", "utf8").toString("base64")}`
      expect((yield* provision(root, { expectedInstanceID: "desktop:live-owner" })).state).toBe("written")
      // Rewrite with a credential so the refusal path has a secret to leak if careless.
      const file = path.join(root, OPENFORK_ACTIVITY_FENCE_CONFIG_FILENAME)
      writeFileSync(
        file,
        serializeOpenForkActivityFenceConfig({
          configVersion: 1,
          expectedInstanceID: "desktop:live-owner",
          expectedRealmID: REALM_ID,
          authorization: secret,
        }),
        "utf8",
      )
      const discoveryDirectory = descriptorDirectory(tmp.path, "desktop:live-owner", process.pid)
      const refused = yield* provisionError(root, {}, { discoveryDirectory })
      expect((refused as FenceConfigError).code).toBe("config-owned-by-live-instance")
      expect(refused.message).not.toContain("super-secret")
      expect(refused.message).not.toContain(secret)
    }),
  )
})
