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
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-authority-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpAuthority.node, OxpRoot.node, OxpConfig.node]),
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

describe("OxpAuthority", () => {
  it.live(
    "keeps augmentation grants independent and requires explicit root authority",
    Effect.gen(function* () {
      const authority = yield* OxpAuthority.Service
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const read = yield* authority.authorize({
        plane: "augmentation",
        operation: "read",
        phase: "read",
        rootID: root.id,
      })
      const write = yield* attempt(
        authority.authorize({ plane: "augmentation", operation: "edit", phase: "mutate", rootID: root.id }),
      )
      const process = yield* attempt(
        authority.authorize({ plane: "augmentation", operation: "process.start", phase: "spawn", rootID: root.id }),
      )
      const git = yield* attempt(
        authority.authorize({ plane: "augmentation", operation: "git.status", phase: "read", rootID: root.id }),
      )
      const implicitRoot = yield* attempt(
        authority.authorize({ plane: "augmentation", operation: "read", phase: "read" }),
      )

      expect(read.authority).toBe("read")
      expect(write._tag).toBe("Left")
      expect(process._tag).toBe("Left")
      expect(git._tag).toBe("Left")
      expect(implicitRoot._tag).toBe("Left")
      if (implicitRoot._tag === "Left") expect(implicitRoot.left._tag).toBe("OXP_ROOT_REQUIRED")
    }),
  )

  it.live(
    "requires both local read and explicit send for file egress, and receive plus write for ingress",
    Effect.gen(function* () {
      const authority = yield* OxpAuthority.Service
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      const file = path.join(rootDir, "a.txt")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(file, "a"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)

      yield* config.setGrant({ filesSend: true })
      const sendWithoutRead = yield* attempt(
        authority.authorize({ plane: "augmentation", operation: "file.send", phase: "egress", rootID: root.id }),
      )
      yield* config.setGrant({ read: true })
      const send = yield* authority.authorize({
        plane: "augmentation",
        operation: "file.send",
        phase: "egress",
        rootID: root.id,
      })

      yield* config.setGrant({ filesReceive: true, write: false })
      const receiveWithoutWrite = yield* attempt(
        authority.authorize({ plane: "augmentation", operation: "file.receive", phase: "commit", rootID: root.id }),
      )
      yield* config.setGrant({ write: true })
      const receive = yield* authority.authorize({
        plane: "augmentation",
        operation: "file.receive",
        phase: "commit",
        rootID: root.id,
      })

      expect(sendWithoutRead._tag).toBe("Left")
      expect(send.authority).toBe("filesSend")
      expect(receiveWithoutWrite._tag).toBe("Left")
      expect(receive.authority).toBe("filesReceive")
    }),
  )

  it.live(
    "keeps scheduled automation as an independent default-off authority with explicit root scope",
    Effect.gen(function* () {
      const authority = yield* OxpAuthority.Service
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "automation-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const denied = yield* attempt(
        authority.authorize({
          plane: "augmentation",
          operation: "schedule.create",
          phase: "mutate",
          rootID: root.id,
        }),
      )
      expect(denied._tag).toBe("Left")
      if (denied._tag === "Left") expect(denied.left._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ read: false, automation: true })
      const admitted = yield* authority.authorize({
        plane: "augmentation",
        operation: "schedule.create",
        phase: "mutate",
        rootID: root.id,
      })
      expect(admitted.authority).toBe("automation")

      const missingRoot = yield* attempt(
        authority.authorize({
          plane: "augmentation",
          operation: "schedule.create",
          phase: "mutate",
        }),
      )
      expect(missingRoot._tag).toBe("Left")
      if (missingRoot._tag === "Left") expect(missingRoot.left._tag).toBe("OXP_ROOT_REQUIRED")

      yield* config.setGrant({ automation: false })
      const revoked = yield* attempt(authority.revalidate(admitted, "commit"))
      expect(revoked._tag).toBe("Left")
      if (revoked._tag === "Left") expect(revoked.left._tag).toBe("OXP_AUTH_REVOKED")
    }),
  )

  it.live(
    "keeps session supervision and request supervision as distinct authorities",
    Effect.gen(function* () {
      const authority = yield* OxpAuthority.Service
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ sessionSupervision: "approved-roots" })

      const session = yield* authority.authorize({
        plane: "supervision",
        operation: "session.list",
        phase: "supervise",
        rootID: root.id,
      })
      const requestDenied = yield* attempt(
        authority.authorize({
          plane: "supervision",
          operation: "request.list",
          phase: "supervise",
          rootID: root.id,
        }),
      )
      yield* config.setGrant({ requestSupervision: true })
      const request = yield* authority.authorize({
        plane: "supervision",
        operation: "request.list",
        phase: "supervise",
        rootID: root.id,
      })

      expect(session.authority).toBe("sessionSupervision")
      expect(requestDenied._tag).toBe("Left")
      expect(request.authority).toBe("requestSupervision")
    }),
  )

  it.live(
    "keeps delegation and nested delegation independent",
    Effect.gen(function* () {
      const authority = yield* OxpAuthority.Service
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ delegation: "spawn", nestedDelegation: false })

      const worker = yield* authority.authorize({
        plane: "delegation",
        operation: "worker.start",
        phase: "delegate",
        rootID: root.id,
      })
      const nestedDenied = yield* attempt(
        authority.authorize({
          plane: "delegation",
          operation: "worker.nested.start",
          phase: "delegate",
          rootID: root.id,
        }),
      )
      yield* config.setGrant({ nestedDelegation: true })
      const nested = yield* authority.authorize({
        plane: "delegation",
        operation: "worker.nested.start",
        phase: "delegate",
        rootID: root.id,
      })

      expect(worker.authority).toBe("delegation")
      expect(nestedDenied._tag).toBe("Left")
      expect(nested.authority).toBe("nestedDelegation")
    }),
  )

  it.live(
    "revalidates live grants and approved roots instead of trusting admitted revision or discovery",
    Effect.gen(function* () {
      const authority = yield* OxpAuthority.Service
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const visible = yield* authority.discover({ plane: "augmentation", operation: "read" })
      const admitted = yield* authority.authorize({
        plane: "augmentation",
        operation: "read",
        phase: "read",
        rootID: root.id,
      })
      yield* config.setGrant({ read: false })
      const revoked = yield* attempt(authority.revalidate(admitted, "commit"))
      const cachedVisibilityCannotCall = yield* attempt(
        authority.authorize({ plane: "augmentation", operation: "read", phase: "read", rootID: root.id }),
      )

      expect(visible).toBe(true)
      expect(revoked._tag).toBe("Left")
      if (revoked._tag === "Left") expect(revoked.left._tag).toBe("OXP_AUTH_REVOKED")
      expect(cachedVisibilityCannotCall._tag).toBe("Left")

      yield* config.setGrant({ read: true })
      const admittedAgain = yield* authority.authorize({
        plane: "augmentation",
        operation: "read",
        phase: "read",
        rootID: root.id,
      })
      yield* roots.remove(root.id)
      const rootRevoked = yield* attempt(authority.revalidate(admittedAgain, "commit"))
      expect(rootRevoked._tag).toBe("Left")
      if (rootRevoked._tag === "Left") expect(rootRevoked.left._tag).toBe("OXP_AUTH_REVOKED")
    }),
  )

  it.live(
    "rejects unknown operation names instead of trusting a caller-supplied authority class",
    Effect.gen(function* () {
      const authority = yield* OxpAuthority.Service
      const config = yield* OxpConfig.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, write: true, process: true, git: true })
      const result = yield* attempt(
        authority.authorize({ plane: "augmentation", operation: "resident-agent.execute", phase: "read" }),
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_INVALID_ARGUMENT")
    }),
  )
})
