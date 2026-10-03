import { afterAll, describe, expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionStatus } from "../../src/session/status"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { DirectoryActivityFence } from "@opencode-ai/core/directory-activity-fence"
import { DirectoryMaintenanceGuard } from "@opencode-ai/core/directory-maintenance-guard"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { OxpAttribution } from "@opencode-ai/core/oxp-attribution/attribution"
import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmProfilePreflight } from "../../src/swarm/profile-preflight"
import { Auth } from "../../src/auth"
import { Capacity } from "../../src/capacity/capacity"
import { Config } from "../../src/config/config"
import { ForkCredentials } from "../../src/fork/credentials"
import { Installation } from "../../src/installation"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { DirectoryActivityFencePaths } from "../../src/server/routes/instance/httpapi/groups/directory-activity-fence"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import {
  directoryActivityFenceHandlers,
  isLoopbackRemoteAddress,
} from "../../src/server/routes/instance/httpapi/handlers/directory-activity-fence"
import { forkCredentialHandlers } from "../../src/server/routes/instance/httpapi/handlers/fork-credential"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { ofxpHandlers } from "../../src/server/routes/instance/httpapi/handlers/ofxp"
import { providerSettingsHandlers } from "../../src/server/routes/instance/httpapi/handlers/provider-settings"
import { quotaHandlers } from "../../src/server/routes/instance/httpapi/handlers/quota"
import { revisionDraftHandlers } from "../../src/server/routes/instance/httpapi/handlers/revision-draft"
import { scheduledTaskHandlers } from "../../src/server/routes/instance/httpapi/handlers/scheduled-task"
import { swarmHandlers } from "../../src/server/routes/instance/httpapi/handlers/swarm"
import { usageHandlers } from "../../src/server/routes/instance/httpapi/handlers/usage"
import { wakatimeHandlers } from "../../src/server/routes/instance/httpapi/handlers/wakatime"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instancePin } from "../../src/server/routes/instance/httpapi/middleware/instance-pin"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { INSTANCE_EXPECT_HEADER, instanceIdentity } from "../../src/server/shared/instance-identity"
import { OfxpRoot } from "../../src/ofxp/root"
import { OfxpRuntime } from "../../src/ofxp/runtime"
import { SwarmMemberSessionWake } from "../../src/swarm/member-session-wake"
import { Usage } from "../../src/usage/usage"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { Quota } from "../../src/quota/quota"
import { testEffect } from "../lib/effect"

const suite = join(tmpdir(), "openfork-directory-activity-fence-transport-" + process.pid)

// Negative ownership invariant: a fence request must never materialize a
// workspace Instance. The mock below is present but unimplemented, so any load
// is a counter increment plus a defect instead of a silent bootstrap.
const instanceStoreLoads = Ref.makeUnsafe(0)

afterAll(async () => {
  await rm(suite, { recursive: true, force: true })
})

const makeDirectory = (name: string) =>
  Effect.promise(async () => {
    const directory = join(suite, name)
    await mkdir(directory, { recursive: true })
    return directory
  })

const keyOf = (directory: string) => {
  const key = DirectoryMaintenanceGuard.existingDirectoryKey(directory)
  if (key === undefined) throw new Error(`expected a physical directory key for ${directory}`)
  return key
}

// Real DirectoryActivityFence over an in-memory Database so the HTTP boundary is
// exercised against the actual guard primitive, not a hand-rolled imitation.
const fenceLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, RuntimeOwner.node, DirectoryMaintenanceGuard.node, DirectoryActivityFence.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)

const executingBlocker = {
  sessionID: SessionV2.ID.make("ses_fence_executing"),
  ownerID: "runtime-owner:fence-executing" as RuntimeOwner.ID,
  generation: 7,
  persistedDirectory: "/persisted/directory",
  directory: null,
  recoveryOwnerID: "runtime-owner:fence-recovery" as RuntimeOwner.ID,
} satisfies DirectoryMaintenanceGuard.ActiveExecutionBlocker

const cannedFenceLayer = Layer.mock(DirectoryActivityFence.Service, {
  acquire: () => Effect.succeed({ state: "blocked" as const, blocked: [], executing: [executingBlocker] }),
  assertHealthy: () => Effect.succeed({ state: "healthy" as const }),
  release: () => Effect.succeed("stale" as const),
})

function makeApiLayer(options: { fence: Layer.Layer<DirectoryActivityFence.Service>; auth?: "password" }) {
  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([
        controlHandlers,
        controlPlaneHandlers,
        directoryActivityFenceHandlers,
        forkCredentialHandlers,
        globalHandlers,
        ofxpHandlers,
        providerSettingsHandlers,
        usageHandlers,
        wakatimeHandlers,
        quotaHandlers,
        revisionDraftHandlers,
        scheduledTaskHandlers,
        swarmHandlers,
      ]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      Layer.provide(options.fence),
      Layer.provide(instancePin),
      // Raw HttpApi routes expose an opaque handler context at the request boundary.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
  ).pipe(
    Layer.provide(Layer.mergeAll(
      Layer.mock(SessionExecutionOwner.Service)({}),
      Layer.mock(SessionStatus.Service)({}),
    )),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(
      Layer.mock(Capacity.Service)({
        go: () =>
          Effect.succeed({
            providerID: "opencode-go",
            priorStatus: "ok",
            priorFetchedAt: 0,
            routed: [],
            accounts: [],
          }),
      }),
    ),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(ForkCredentials.Service)({})),
    Layer.provide(Layer.mock(SessionUsage.Service)({})),
    Layer.provide(
      Layer.mock(Quota.Service)({
        providers: () => Effect.succeed({ providers: [] }),
        get: () => Effect.die("unused quota get"),
        resets: ({ from, to }) => Effect.succeed({ from, to, generatedAt: from, occurrences: [], failures: [] }),
      }),
    ),
    Layer.provide(
      Layer.mock(InstanceStore.Service, {
        load: () =>
          Ref.update(instanceStoreLoads, (count) => count + 1).pipe(
            Effect.andThen(Effect.die("directory activity fence routes must never load an Instance")),
          ),
      }),
    ),
    Layer.provide(Layer.mock(OfxpInvocation.Service)({})),
    Layer.provide(Layer.mock(OfxpPeer.Service)({ subscribe: () => () => {} })),
    Layer.provide(Layer.mock(OfxpRoot.Service)({})),
    Layer.provide(Layer.mock(OfxpRuntime.Service)({})),
    Layer.provide(Layer.mock(OxpActivity.Service)({})),
    Layer.provide(Layer.mock(OxpActivityInspection.Service)({})),
    Layer.provide(Layer.mock(RevisionDraft.Service)({})),
    Layer.provide(Layer.mock(ScheduledTask.Service)({})),
    Layer.provide(Layer.mock(ScheduledTaskSessionBinding.Service)({})),
    Layer.provide([
      Layer.mock(SwarmV2.Service)({}),
      Layer.mock(SwarmProfilePreflight.Service)({ check: () => Effect.die("unused Swarm profile preflight") }),
      Layer.mock(SwarmMemberSessionWake.Service)({}),
    ]),
    Layer.provide(Layer.mock(WakaTime.Service)({})),
  ).pipe(
    Layer.provide(Layer.mock(OxpAttribution.Service)({})),
    Layer.provide(
      Layer.mock(Usage.Service)({
        summary: () => Effect.die("unused usage summary"),
        modelProfile: () => Effect.succeed({ models: [] }),
        recordMaintenance: () => Effect.void,
      }),
    ),
    Layer.provide(Layer.mock(Installation.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({ moveSession: () => Effect.void })),
    Layer.provide(
      ServerAuth.Config.configLayer(
        options.auth === "password"
          ? { password: Option.some("secret"), username: "opencode", publicUrl: "" }
          : { password: Option.none(), username: "opencode", publicUrl: "" },
      ),
    ),
  )
}

const it = testEffect(makeApiLayer({ fence: fenceLayer }))
const cannedIt = testEffect(makeApiLayer({ fence: cannedFenceLayer }))
const authIt = testEffect(makeApiLayer({ fence: fenceLayer, auth: "password" }))

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return Effect.gen(function* () {
    let request = HttpClientRequest.post(path).pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)))
    for (const [key, value] of Object.entries(headers)) request = HttpClientRequest.setHeader(request, key, value)
    return yield* HttpClient.execute(request)
  })
}

describe("directory activity fence HttpApi", () => {
  it.live("acquires, proves healthy, releases, and reports stale on the exact token", () =>
    Effect.gen(function* () {
      const alpha = yield* makeDirectory("lifecycle-alpha")
      const bravo = yield* makeDirectory("lifecycle-bravo")

      const response = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-lifecycle",
        directories: [alpha, bravo],
      })
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const body = (yield* response.json) as {
        fenceProtocolVersion: number
        state: string
        token: { acquisitionId: string; guardId: string; ownerID: string; generation: number; directories: string[] }
      }
      expect(body.fenceProtocolVersion).toBe(1)
      expect(body.state).toBe("acquired")
      expect(body.token.guardId).toBe("guard-lifecycle")
      expect(body.token.directories).toEqual([keyOf(alpha), keyOf(bravo)].sort())
      expect(typeof body.token.ownerID).toBe("string")
      expect(body.token.ownerID.length).toBeGreaterThan(0)
      expect(typeof body.token.acquisitionId).toBe("string")
      expect(body.token.generation).toBeGreaterThan(0)
      expect(Object.keys(body.token).sort()).toEqual([
        "acquisitionId",
        "directories",
        "generation",
        "guardId",
        "ownerID",
      ])
      expect(Object.keys(body).sort()).toEqual(["fenceProtocolVersion", "state", "token"])

      const healthy = yield* postJson(DirectoryActivityFencePaths.health, { token: body.token })
      expect(healthy.status).toBe(200)
      expect(yield* healthy.json).toEqual({ fenceProtocolVersion: 1, state: "healthy" })

      const released = yield* postJson(DirectoryActivityFencePaths.release, { token: body.token })
      expect(released.status).toBe(200)
      expect(yield* released.json).toEqual({ fenceProtocolVersion: 1, state: "released" })

      const stale = yield* postJson(DirectoryActivityFencePaths.release, { token: body.token })
      expect(stale.status).toBe(200)
      expect(yield* stale.json).toEqual({ fenceProtocolVersion: 1, state: "stale" })

      const afterRelease = yield* postJson(DirectoryActivityFencePaths.health, { token: body.token })
      expect(afterRelease.status).toBe(200)
      expect(yield* afterRelease.json).toEqual({
        fenceProtocolVersion: 1,
        state: "unhealthy",
        issues: [
          { directory: keyOf(alpha), reason: "released" },
          { directory: keyOf(bravo), reason: "released" },
        ],
      })
    }),
  )

  it.live("passes blocked maintenance through with the durable holder identity and an empty executing shape", () =>
    Effect.gen(function* () {
      const alpha = yield* makeDirectory("maintenance-alpha")
      const bravo = yield* makeDirectory("maintenance-bravo")
      const charlie = yield* makeDirectory("maintenance-charlie")

      const first = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-maintenance",
        directories: [alpha, bravo],
      })
      expect(first.status).toBe(200)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const firstBody = (yield* first.json) as {
        state: string
        token: { acquisitionId: string; guardId: string; ownerID: string; generation: number }
      }
      expect(firstBody.state).toBe("acquired")

      const second = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-maintenance-second",
        directories: [alpha, charlie],
      })
      expect(second.status).toBe(200)
      expect(yield* second.json).toEqual({
        fenceProtocolVersion: 1,
        state: "blocked",
        blocked: [
          {
            directory: keyOf(alpha),
            guardId: "guard-maintenance",
            ownerID: firstBody.token.ownerID,
            acquisitionId: firstBody.token.acquisitionId,
            generation: firstBody.token.generation,
            state: "active",
          },
        ],
        executing: [],
      })
    }),
  )

  it.live("classifies unknown token shapes through the core parser instead of rejecting them early", () =>
    Effect.gen(function* () {
      const numeric = yield* postJson(DirectoryActivityFencePaths.health, { token: 42 })
      expect(numeric.status).toBe(200)
      expect(yield* numeric.json).toEqual({
        fenceProtocolVersion: 1,
        state: "unhealthy",
        issues: [{ directory: "", reason: "malformed-token" }],
      })

      const shaped = yield* postJson(DirectoryActivityFencePaths.health, {
        token: { acquisitionId: "forged", guardId: "forged", ownerID: "forged", generation: 0, directories: [] },
      })
      expect(shaped.status).toBe(200)
      expect(yield* shaped.json).toEqual({
        fenceProtocolVersion: 1,
        state: "unhealthy",
        issues: [{ directory: "", reason: "malformed-token" }],
      })

      const release = yield* postJson(DirectoryActivityFencePaths.release, { token: { anything: true } })
      expect(release.status).toBe(200)
      expect(yield* release.json).toEqual({ fenceProtocolVersion: 1, state: "stale" })
    }),
  )

  it.live("maps malformed directory inputs to typed 400 errors without a protocol field", () =>
    Effect.gen(function* () {
      const alpha = yield* makeDirectory("malformed-alpha")
      const bravo = yield* makeDirectory("malformed-bravo")
      const missing = join(suite, "malformed-absent")

      const invalid = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-malformed",
        directories: [missing, alpha],
      })
      expect(invalid.status).toBe(400)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const invalidBody = (yield* invalid.json) as { name: string; data: { directory?: string } }
      expect(invalidBody.name).toBe("DirectoryMaintenanceGuard.InvalidDirectoryError")
      expect(invalidBody.data.directory).toBe(missing)
      expect(Object.keys(invalidBody).sort()).toEqual(["data", "name"])

      const duplicate = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-malformed",
        directories: [alpha, alpha],
      })
      expect(duplicate.status).toBe(400)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const duplicateBody = (yield* duplicate.json) as { name: string; data: { directory?: string } }
      expect(duplicateBody.name).toBe("DirectoryMaintenanceGuard.DuplicateDirectoryError")
      expect(duplicateBody.data.directory).toBe(keyOf(alpha))

      const nonCanonicalGuard = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard malformed",
        directories: [missing, alpha],
      })
      expect(nonCanonicalGuard.status).toBe(400)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const guardBody = (yield* nonCanonicalGuard.json) as { name: string; data: { guardId?: string } }
      expect(guardBody.name).toBe("DirectoryMaintenanceGuard.InvalidGuardIDError")
      expect(guardBody.data.guardId).toBe("guard malformed")

      // Strict wire schema: a three-directory acquire never reaches the guard
      // primitive at all and fails closed at the declared 400 boundary.
      const wrongCardinality = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-malformed",
        directories: [alpha, bravo, missing],
      })
      expect(wrongCardinality.status).toBe(400)
    }),
  )

  it.live("rejects malformed request bodies at the strict schema boundary", () =>
    Effect.gen(function* () {
      // The authority token is intentionally unknown-typed, but its container
      // is strict: a body without `token` never reaches the core parser.
      const missingToken = yield* postJson(DirectoryActivityFencePaths.health, {})
      expect(missingToken.status).toBe(400)

      const missingDirectories = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-malformed",
      })
      expect(missingDirectories.status).toBe(400)

      const wrongDirectories = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-malformed",
        directories: "not-a-tuple",
      })
      expect(wrongDirectories.status).toBe(400)
    }),
  )

  it.live("answers acquire/health/release with zero InstanceStore loads", () =>
    Effect.gen(function* () {
      yield* Ref.set(instanceStoreLoads, 0)
      const alpha = yield* makeDirectory("ownership-alpha")
      const bravo = yield* makeDirectory("ownership-bravo")

      const acquired = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-ownership",
        directories: [alpha, bravo],
      })
      expect(acquired.status).toBe(200)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const body = (yield* acquired.json) as { token: unknown }

      const healthy = yield* postJson(DirectoryActivityFencePaths.health, { token: body.token })
      expect(healthy.status).toBe(200)
      const released = yield* postJson(DirectoryActivityFencePaths.release, { token: body.token })
      expect(released.status).toBe(200)

      expect(yield* Ref.get(instanceStoreLoads)).toBe(0)
    }),
  )

  it.live("refuses a request pinned to a different instance with a 409", () =>
    Effect.gen(function* () {
      const alpha = yield* makeDirectory("pin-alpha")
      const bravo = yield* makeDirectory("pin-bravo")
      const actual = instanceIdentity().instanceID
      const wrong = `${actual}-other`
      const acquire = (pin: string) =>
        postJson(
          DirectoryActivityFencePaths.acquire,
          { guardId: "guard-instance-pin", directories: [alpha, bravo] },
          { [INSTANCE_EXPECT_HEADER]: pin },
        )

      const mismatch = yield* acquire(wrong)
      expect(mismatch.status).toBe(409)
      expect(yield* mismatch.json).toEqual({
        name: "InstanceMismatchError",
        data: {
          message: "This request was addressed to a different opencode instance.",
          expected: wrong,
          actual,
        },
      })

      const matched = yield* acquire(actual)
      expect(matched.status).toBe(200)
    }),
  )
})

describe("directory activity fence executing blocker passthrough", () => {
  cannedIt.live("never fabricates maintenance identity for an executing blocker", () =>
    Effect.gen(function* () {
      const response = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-executing",
        directories: ["/one", "/two"],
      })
      expect(response.status).toBe(200)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const body = (yield* response.json) as {
        fenceProtocolVersion: number
        state: string
        blocked: unknown[]
        executing: Array<Record<string, unknown>>
      }
      expect(body).toEqual({
        fenceProtocolVersion: 1,
        state: "blocked",
        blocked: [],
        executing: [
          {
            sessionID: "ses_fence_executing",
            ownerID: "runtime-owner:fence-executing",
            generation: 7,
            persistedDirectory: "/persisted/directory",
            directory: null,
            recoveryOwnerID: "runtime-owner:fence-recovery",
          },
        ],
      })
      expect(Object.keys(body).sort()).toEqual(["blocked", "executing", "fenceProtocolVersion", "state"])
      expect(Object.keys(body.executing[0]).sort()).toEqual([
        "directory",
        "generation",
        "ownerID",
        "persistedDirectory",
        "recoveryOwnerID",
        "sessionID",
      ])
    }),
  )
})

describe("directory activity fence authorization", () => {
  authIt.live("rejects unauthenticated callers through the existing Authorization first", () =>
    Effect.gen(function* () {
      const response = yield* postJson(DirectoryActivityFencePaths.acquire, {
        guardId: "guard-auth",
        directories: ["/one", "/two"],
      })
      expect(response.status).toBe(401)
    }),
  )

  authIt.live("serves authenticated loopback callers through the retained transport gate", () =>
    Effect.gen(function* () {
      const authorization = "Basic " + Buffer.from("opencode:secret").toString("base64")
      const alpha = yield* makeDirectory("auth-alpha")
      const bravo = yield* makeDirectory("auth-bravo")

      const response = yield* postJson(
        DirectoryActivityFencePaths.acquire,
        { guardId: "guard-auth", directories: [alpha, bravo] },
        { authorization },
      )
      expect(response.status).toBe(200)
    }),
  )
})

describe("directory activity fence loopback policy", () => {
  test("accepts only kernel loopback remote addresses and fails closed otherwise", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true)
    expect(isLoopbackRemoteAddress("127.9.9.9")).toBe(true)
    expect(isLoopbackRemoteAddress("::1")).toBe(true)
    expect(isLoopbackRemoteAddress("0:0:0:0:0:0:0:1")).toBe(true)
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true)

    expect(isLoopbackRemoteAddress(undefined)).toBe(false)
    expect(isLoopbackRemoteAddress("localhost")).toBe(false)
    expect(isLoopbackRemoteAddress("192.168.1.4")).toBe(false)
    expect(isLoopbackRemoteAddress("::ffff:10.0.0.1")).toBe(false)
    expect(isLoopbackRemoteAddress("127.0.0.1.evil")).toBe(false)
  })
})

describe("directory activity fence route surface ownership", () => {
  const readSource = (relative: string) => readFile(join(import.meta.dir, relative), "utf8")

  test("is RootHttpApi-only, Tier 0, and retains the explicit loopback transport gate", async () => {
    const group = await readSource("../../src/server/routes/instance/httpapi/groups/directory-activity-fence.ts")
    const handler = await readSource("../../src/server/routes/instance/httpapi/handlers/directory-activity-fence.ts")
    const api = await readSource("../../src/server/routes/instance/httpapi/api.ts")
    const combined = group + "\n" + handler

    // The dedicated Tier 0 group must live on RootHttpApi only and must
    // retain all three transport boundaries: RootHttpApi Authorization,
    // global exact-instance pinning, and kernel-derived loopback-only access.
    // It must never materialize a workspace Instance.
    expect(combined).not.toContain("InstanceHttpApi")
    expect(combined).not.toContain("InstanceContextMiddleware")
    expect(combined).not.toContain("InstanceState")
    expect(combined).not.toContain("InstanceStore")
    expect(group).toContain("LoopbackRequiredError")
    expect(handler).toContain("remoteAddress")
    expect(handler).toContain("isLoopbackRemoteAddress")
    expect(handler).toContain("RootHttpApi")

    const rootSegment = api.slice(api.indexOf("export const RootHttpApi"), api.indexOf("export const InstanceHttpApi"))
    const instanceSegment = api.slice(api.indexOf("export const InstanceHttpApi"), api.indexOf("export const OpenCodeHttpApi"))
    expect(rootSegment).toContain("DirectoryActivityFenceApi")
    expect(instanceSegment).not.toContain("DirectoryActivityFenceApi")
  })

  test("exposes exactly the acquire/health/release transport paths", () => {
    expect(DirectoryActivityFencePaths).toEqual({
      acquire: "/experimental/directory-activity-fence/acquire",
      health: "/experimental/directory-activity-fence/health",
      release: "/experimental/directory-activity-fence/release",
    })
  })

  test("retires the old control-plane worktree-fence transport", async () => {
    const api = await readSource("../../src/server/routes/instance/httpapi/api.ts")
    const group = await readSource("../../src/server/routes/instance/httpapi/groups/control-plane.ts")
    const handler = await readSource("../../src/server/routes/instance/httpapi/handlers/control-plane.ts")
    const combined = group + "\n" + handler

    // One fence transport only: the dedicated group above. The former
    // control-plane worktree-fence endpoints must not survive as duplicates.
    expect(api).not.toContain("worktree-fence")
    expect(group).not.toContain("FencePaths")
    expect(group).not.toContain('"acquire"')
    expect(combined).not.toContain("remoteAddress")
    expect(combined).not.toContain("LoopbackRequiredError")

    const rootSegment = api.slice(api.indexOf("export const RootHttpApi"), api.indexOf("export const InstanceHttpApi"))
    const instanceSegment = api.slice(api.indexOf("export const InstanceHttpApi"), api.indexOf("export const OpenCodeHttpApi"))
    expect(rootSegment).toContain(".addHttpApi(ControlPlaneApi)")
    expect(instanceSegment).not.toContain("ControlPlaneApi")
  })
})
