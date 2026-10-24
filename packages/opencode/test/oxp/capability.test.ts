import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpRuntime } from "@/ofxp/runtime"
import { OxpCapability } from "@/oxp/capability"
import { SWARM_FOCUSED_ACTIONS } from "@/oxp/swarm-focus"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
import { OxpSchema } from "@/oxp/schema"
import { OxpMcpControl } from "@/oxp/mcp-control"
import { OxpSystemOneControl } from "@/oxp/system-one-control"
import { OxpSessionControl } from "@/oxp/session-control"
import { OxpWorkerControl } from "@/oxp/worker-control"
import { OxpAgentCatalog } from "@/oxp/agent-catalog"
import { CAPABILITY_DESCRIPTIONS } from "@/oxp/prose"
import { OxpSurface } from "@/oxp/surface"
import { OxpSession } from "@/oxp/session"
import { OxpToolCoverage } from "@/oxp/tool-coverage"
import { ZipFile } from "@/tool/archive/zipfile"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-capability-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })

function localSchemaRefs(value: unknown, refs = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) localSchemaRefs(item, refs)
    return refs
  }
  if (!value || typeof value !== "object") return refs
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/")) {
      refs.add(item.slice("#/$defs/".length))
      continue
    }
    localSchemaRefs(item, refs)
  }
  return refs
}
const noMcpControl = Layer.succeed(
  OxpMcpControl.Service,
  OxpMcpControl.Service.of({
    list: () => Effect.die("capability test must not enter native MCP runtime"),
    call: () => Effect.die("capability test must not enter native MCP runtime"),
  }),
)
let systemOneCall:
  | {
      directory: string
      input: Parameters<OxpSystemOneControl.Interface["infer"]>[1]
    }
  | undefined
const fakeSystemOneControl = Layer.succeed(
  OxpSystemOneControl.Service,
  OxpSystemOneControl.Service.of({
    infer: (target, input) => {
      systemOneCall = { directory: target.directory, input }
      return target.commitGuard
        ? Effect.tryPromise({ try: target.commitGuard, catch: (cause) => cause as Error }).pipe(
            Effect.andThen(
              Effect.succeed({
                model: input.modelID,
                answers: { valid: { type: "noul" as const, noul: 0.9 } },
                usage: { input_tokens: 12, output_tokens: 2 },
                cost: { input: 0, output: 0, total: 0 },
                raw: { model: input.modelID, fixture: true },
              }),
            ),
          )
        : Effect.succeed({
            model: input.modelID,
            answers: { valid: { type: "noul" as const, noul: 0.9 } },
            usage: { input_tokens: 12, output_tokens: 2 },
            cost: { input: 0, output: 0, total: 0 },
            raw: { model: input.modelID, fixture: true },
          })
    },
  }),
)
const workerModel = {
  providerID: "fixture",
  modelID: "fixture-model",
} as const
let workerStartTarget: OxpWorkerControl.Target | undefined

const fakeWorkerControl = Layer.succeed(
  OxpWorkerControl.Service,
  OxpWorkerControl.Service.of({
    resolveSelection: () => Effect.succeed({ agent: "build", model: workerModel }),
    start: (target) =>
      Effect.sync(() => {
        workerStartTarget = target
        return { workerID: "ses_capability_worker" }
      }),
    continue: () => Effect.die("capability test must not continue delegated workers"),
    setSelection: () => Effect.die("capability test must not rebind delegated workers"),
    wait: () => Effect.die("capability test must not wait delegated workers"),
    result: () => Effect.die("capability test must not read delegated worker results"),
    cancel: () => Effect.die("capability test must not cancel delegated workers"),
    batchStart: () => Effect.die("capability test must not batch-start delegated workers"),
    batchContinue: () => Effect.die("capability test must not batch-continue delegated workers"),
    batchWait: () => Effect.die("capability test must not batch-wait delegated workers"),
    batchCancel: () => Effect.die("capability test must not batch-cancel delegated workers"),
  }),
)

const fakeAgentCatalog = Layer.succeed(
  OxpAgentCatalog.Service,
  OxpAgentCatalog.Service.of({
    list: () =>
      Effect.succeed({
        agents: [{ id: "build", mode: "primary" as const }],
        nativeDefaultAgent: "build",
      }),
  }),
)

const noSessionControl = Layer.succeed(
  OxpSessionControl.Service,
  OxpSessionControl.Service.of({
    pause: () => Effect.die("capability test must not enter Session runtime control"),
    resume: () => Effect.die("capability test must not enter Session runtime control"),
    abort: () => Effect.die("capability test must not enter Session runtime control"),
    archive: () => Effect.die("capability test must not enter Session runtime control"),
    unarchive: () => Effect.die("capability test must not enter Session runtime control"),
    delete: () => Effect.die("capability test must not enter Session runtime control"),
    setSelection: () => Effect.die("capability test must not enter Session runtime control"),
    steer: () => Effect.die("capability test must not enter Session runtime control"),
    send: () => Effect.die("capability test must not enter Session runtime control"),
    turn: () => Effect.die("capability test must not enter Session runtime control"),
    backgroundSubagents: () => Effect.die("capability test must not enter Session runtime control"),
    todoGet: () => Effect.die("capability test must not enter Session runtime control"),
    todoSet: () => Effect.die("capability test must not enter Session runtime control"),
    checkpoint: () => Effect.die("capability test must not enter Session runtime control"),
    goal: () => Effect.die("capability test must not enter Session runtime control"),
  }),
)
let ofxpInvocations: OfxpRuntime.CapabilityInvocation[] = []
let ofxpReceipts: Array<{ peerID: Ofxp.PeerID; invocationID: Ofxp.InvocationID }> = []
const fakeOfxpRuntime = Layer.succeed(
  OfxpRuntime.Service,
  OfxpRuntime.Service.of({
    start: () => Effect.die("capability test must not start OFXP"),
    stop: () => Effect.void,
    setEnabled: () => Effect.die("capability test must not change OFXP lifecycle"),
    rotateIdentity: () => Effect.die("capability test must not rotate OFXP identity"),
    finalizeIdentityRotation: () => Effect.die("capability test must not finalize OFXP identity rotation"),
    status: () => Effect.succeed({ active: false, discovery: "disabled" as const }),
    bootstrap: () => Effect.succeed({ enabled: false } as const),
    replaceServerSeeds: (seeds) => Effect.succeed(seeds.length),
    candidates: () => Effect.succeed([]),
    connectionStatuses: () => Effect.succeed([]),
    pairingPreviews: () => Effect.succeed([]),
    initiatePairing: () => Effect.die("capability test must not pair OFXP peers"),
    confirmPairing: () => Effect.die("capability test must not pair OFXP peers"),
    cancelPairing: () => Effect.die("capability test must not pair OFXP peers"),
    trustedPeers: () => Effect.succeed([]),
    remoteRoots: () => Effect.die("capability test must not list remote OFXP roots"),
    remoteCapabilities: () => Effect.die("capability test must not list remote OFXP capabilities"),
    describeRemoteCapability: () => Effect.die("capability test must not describe remote OFXP capabilities"),
    remoteReceipt: (peerID, invocationID) =>
      Effect.sync(() => {
        ofxpReceipts.push({ peerID, invocationID })
        return {
          ok: true as const,
          receipt: {
            invocationID,
            sourcePeerID: peerID,
            operation: "web",
            commitClass: "safe_read" as const,
            state: "committed" as const,
            createdAt: 1,
            settledAt: 2,
          },
        }
      }),
    invokeRemoteCapability: (input) =>
      Effect.sync(() => {
        ofxpInvocations.push(input)
        return {
          ok: true as const,
          result: {
            title: "Remote OFXP fixture",
            output: "remote-ok",
            metadata: { fixture: true },
          },
        }
      }),
  }),
)
const layer = AppNodeBuilder.build(
  LayerNode.group([CrossSpawnSpawner.node, OxpCapability.node, OxpRoot.node, OxpConfig.node]),
  [
    [Global.node, globalLayer],
    [OxpMcpControl.node, noMcpControl],
    [OxpSystemOneControl.node, fakeSystemOneControl],
    [OxpSessionControl.node, noSessionControl],
    [OxpWorkerControl.node, fakeWorkerControl],
    [OxpAgentCatalog.node, fakeAgentCatalog],
    [OfxpRuntime.node, fakeOfxpRuntime],
  ],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
  systemOneCall = undefined
  workerStartTarget = undefined
  ofxpInvocations = []
  ofxpReceipts = []
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpCapability", () => {
  it.live(
    "describes one focused browser operation and rejects its contract for a different action",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, browser: true })

      const complete = yield* capability.describe("browser")
      const focused = yield* capability.describe("browser", "navigate")
      expect(JSON.stringify(focused.inputSchema).length).toBeLessThan(JSON.stringify(complete.inputSchema).length / 6)
      expect((focused.inputSchema as { properties: { operation: { enum: string[] } } }).properties.operation.enum)
        .toEqual(["navigate"])
      expect(focused.contract).not.toBe(complete.contract)
      // On-demand guidance must never bloat the always-advertised direct MCP
      // manifest: richer schemas belong to the lazy capability descriptor.
      expect(JSON.stringify(OxpSurface.TOOLS.map((tool) => tool.inputSchema)))
        .not.toContain('"description":"')
      const swarmCompact = yield* capability.describe("openfork_swarm", undefined, "compact")
      const swarmBalanced = yield* capability.describe("openfork_swarm")
      const swarmFull = yield* capability.describe("openfork_swarm", undefined, "full")
      expect(swarmCompact.guidance.returnedDescriptions).toBeLessThan(swarmCompact.guidance.authoredDescriptions)
      expect(swarmCompact.guidance.complete).toBe(false)
      expect(swarmCompact.guidance.expansion).toContain("guidanceMode=full")
      expect(swarmBalanced.guidance.complete).toBe(true)
      expect(swarmBalanced.guidance.omittedDescriptions).toBe(0)
      expect(swarmFull.guidance.complete).toBe(true)
      const browserHelp = yield* capability.describe("browser", "navigate")
      expect(browserHelp.guidance.authoredDescriptions).toBe(0)
      expect(browserHelp.guidance.authoringHint).toContain("no authored field descriptions")
      expect(JSON.stringify(swarmCompact.inputSchema)).not.toContain('"description":"')
      expect(JSON.stringify(swarmBalanced.inputSchema)).toContain('"description"')
      expect(swarmCompact.contract).not.toBe(swarmBalanced.contract)
      expect(JSON.stringify(swarmFull.inputSchema).length).toBeGreaterThanOrEqual(JSON.stringify(swarmBalanced.inputSchema).length)
      // Swarm is a flat action enum, not a discriminated union. Explicitly
      // reviewed focused field sets preserve necessary fields and $refs.
      for (const [action, expected] of [
        ["delegate", ["rootID", "action", "swarmName", "requestKey", "coordinatorName", "coordinatorRole", "members", "tasks"]],
        ["member.batch", ["rootID", "action", "swarmId", "members"]],
        ["task.batch", ["rootID", "action", "swarmId", "tasks"]],
      ] as const) {
        const focusedSwarm = yield* capability.describe("openfork_swarm", action)
        const schema = focusedSwarm.inputSchema as {
          properties: Record<string, { enum?: string[] }>
          required: string[]
          $defs?: Record<string, unknown>
        }
        expect(Object.keys(schema.properties)).toEqual([...expected])
        expect(schema.properties.action?.enum).toEqual([action])
        expect(schema.required).toContain("rootID")
        expect(schema.required).toContain("action")
        expect(JSON.stringify(schema).length).toBeLessThan(JSON.stringify(swarmBalanced.inputSchema).length)
        expect(focusedSwarm.contract).not.toBe(swarmBalanced.contract)
        if (action === "delegate") {
          expect(schema.required).toContain("swarmName")
        } else {
          expect(schema.required).toContain("swarmId")
          expect(schema.required).toContain(action === "task.batch" ? "tasks" : "members")
        }
        for (const ref of localSchemaRefs(schema)) expect(schema.$defs?.[ref]).toBeDefined()
      }
      // All connector-supported Swarm actions have reviewed, executable,
      // action-specific discovery. Exclude native-only operator and force
      // authority instead of merely hiding them in the printed description.
      const canonical = (swarmBalanced.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum
      expect(Object.keys(SWARM_FOCUSED_ACTIONS).sort()).toEqual(
        canonical.filter((action) => !action.startsWith("admin.")).sort(),
      )
      for (const [action, spec] of Object.entries(SWARM_FOCUSED_ACTIONS)) {
        const focused = yield* capability.describe("openfork_swarm", action)
        const schema = focused.inputSchema as {
          properties: Record<string, { enum?: string[] }>
          required: string[]
          $defs?: Record<string, unknown>
        }
        expect(schema.properties.action?.enum).toEqual([action])
        expect(Object.keys(schema.properties)).toEqual(["rootID", "action", ...spec.fields])
        expect(schema.required).toEqual(["rootID", "action", ...spec.required])
        expect(JSON.stringify(schema).length).toBeLessThan(JSON.stringify(swarmBalanced.inputSchema).length)
        expect(focused.contract).not.toBe(swarmBalanced.contract)
        expect(schema.properties.force).toBeUndefined()
        expect(schema.properties.sourceSwarmId).toBeUndefined()
        for (const ref of localSchemaRefs(schema)) expect(schema.$defs?.[ref]).toBeDefined()
      }
      // Worker-session settlement authority must not be accidentally lost by
      // the narrower discovery schema; the OXP dispatcher revalidates it.
      const settle = yield* capability.describe("openfork_swarm", "task.settle")
      expect((settle.inputSchema as { required: string[] }).required).toContain("sessionID")
      const settlementSchema = settle.inputSchema as { allOf: Array<{ if: { properties: { settlement: { const: string } } }; then: { required: string[] } }> }
      expect(settlementSchema.allOf[0]?.if.properties.settlement.const).toBe("failed")
      expect(settlementSchema.allOf[0]?.then.required).toContain("failureKind")
      const send = yield* capability.describe("openfork_swarm", "message.send")
      const messageSchema = send.inputSchema as { oneOf: Array<{ required: string[]; not?: { required: string[] } }> }
      expect(messageSchema.oneOf).toHaveLength(2)
      expect(messageSchema.oneOf[0]?.required).toContain("targetMemberId")
      expect(messageSchema.oneOf[1]?.not?.required).toContain("targetMemberId")
      for (const action of ["member.batch", "task.batch"] as const) {
        const contract = yield* capability.describe("openfork_swarm", action)
        const limits = (contract.inputSchema as { allOf: Array<{ properties: Record<string, { minItems: number; maxItems: number }> }> }).allOf[0]!.properties
        const field = action === "member.batch" ? "members" : "tasks"
        expect(limits[field]).toMatchObject({ minItems: 1, maxItems: 8 })
      }
      for (const mode of ["compact", "balanced", "full"] as const) {
        const createdTask = yield* capability.describe("openfork_swarm", "task.create", mode)
        expect((createdTask.inputSchema as { properties: Record<string, unknown> }).properties.description)
          .toBeDefined()
      }
      const focusedMembers = yield* capability.describe("openfork_swarm", "member.batch")
      const crossAction = yield* capability.execute({
        action: "call", capability: "openfork_swarm", contract: focusedMembers.contract,
        args: { rootID: "61741854-3c6e-4cd0-9417-acc25c5ade56", action: "task.batch", swarmId: "sw_test", tasks: [] },
      }).pipe(Effect.flip)
      expect(crossAction._tag).toBe("OXP_INVALID_ARGUMENT")
      // Prove the real broker-to-leaf decoding boundary returns actionable,
      // bounded guidance instead of a generic failure, without reflecting
      // model-supplied private task text back into a validation error.
      const validationRoot = yield* OxpRoot.Service
      const validationPath = path.join(suite, "ax-invalid-swarm-input")
      yield* Effect.promise(() => fs.mkdir(validationPath, { recursive: true }))
      const approvedRoot = yield* validationRoot.approve(validationPath)
      yield* config.setGrant({ read: true, browser: true, delegation: "spawn" })
      const malformed = yield* capability.call("openfork_swarm", {
        rootID: approvedRoot.id,
        action: "task.batch", tasks: [], body: "sensitive-payload-do-not-echo",
      }).pipe(Effect.flip)
      expect(malformed._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(malformed.detail).toContain("swarmId is required")
      expect(malformed.detail).not.toContain("sensitive-payload-do-not-echo")
      const wrongSwarmFocus = yield* capability.execute({
        action: "describe", capability: "openfork_swarm", focusAction: "administrate-everything",
      }).pipe(Effect.flip)
      expect(wrongSwarmFocus._tag).toBe("OXP_INVALID_ARGUMENT")
      const jsonCompact = yield* capability.describe("json", undefined, "compact")
      const valid = yield* capability.execute({
        action: "call",
        capability: "json",
        guidanceMode: "compact",
        contract: jsonCompact.contract,
        args: { mode: "validate", jsonText: '{"ax":true}' },
      })
      expect(valid.output).toContain('ok="true"')
      const wrongMode = yield* capability.execute({
        action: "call",
        capability: "json",
        contract: jsonCompact.contract,
        args: { mode: "validate", jsonText: '{"ax":true}' },
      }).pipe(Effect.flip)
      expect(wrongMode._tag).toBe("OXP_INVALID_ARGUMENT")

      const described = yield* capability.execute({ action: "describe", capability: "browser", focusAction: "navigate" })
      expect(JSON.parse(described.output).contract).toBe(focused.contract)
      const wrong = yield* capability.execute({
        action: "call",
        capability: "browser",
        contract: focused.contract,
        args: { operation: "resize", args: {} },
      }).pipe(Effect.flip)
      expect(wrong._tag).toBe("OXP_INVALID_ARGUMENT")
      const unsupported = yield* capability.execute({
        action: "describe",
        capability: "json",
        focusAction: "validate",
      }).pipe(Effect.flip)
      expect(unsupported._tag).toBe("OXP_INVALID_ARGUMENT")
    }),
  )

  it.live(
    "derives native-tool parity from actually executable OXP targets",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)

      const broker = yield* capability.list(undefined, "all")
      const actual = new Set<string>([
        ...broker.map((row) => row.id),
        ...OxpSurface.DEFINITIONS.map((definition) => definition.name),
        ...OxpSession.executableTargets(),
      ])

      expect(OxpToolCoverage.missingExecutableTargets(actual)).toEqual([])
      expect(OxpToolCoverage.unmappedNativeTools()).toEqual([])
      expect(OxpToolCoverage.unknownExceptions()).toEqual([])
      expect(new Set(OxpToolCoverage.ENTRIES.map((entry) => entry.native)).size).toBe(OxpToolCoverage.ENTRIES.length)
    }),
  )

  it.live(
    "lists compact stable definitions without schema expansion",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const rows = yield* capability.list()
      expect(rows.map((row) => row.id)).toEqual([
        "archive",
        "browser",
        "code",

        "edit",
        "file.transfer",
        "find",
        "git",
        "json",
        "lsp",
        "memory",
        "models",
        "ofxp",
        "openfork_session.checkpoint",
        "openfork_swarm",
        "openfork_worker",
        "patch",
        "process",
        "project",
        "read",
        "refactor",
        "runtime.refresh",
        "schedule",
        "schedule.create",
        "skill",
        "sqlite",
        "symbols",
        "sympy",
        "system-one",
        "test",
        "typecheck",
        "usage",
        "web",
        "write",
      ])
      expect(rows.find((row) => row.id === "archive")).toMatchObject({
        authority: "read",
        exposure: "brokered",
        load: "lazy",
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "code")).toMatchObject({
        authority: "code",
        exposure: "brokered",
        load: "default",
        workspaceTier: 3,
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "browser")).toMatchObject({
        authority: "browser",
        exposure: "brokered",
        workspaceTier: 0,
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "openfork_swarm")).toMatchObject({
        authority: "delegation",
        exposure: "brokered",
        load: "lazy",
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "openfork_worker")).toMatchObject({
        authority: "delegation",
        exposure: "direct",
        workspaceTier: 3,
        mutation: "write",
      })

      expect(rows.find((row) => row.id === "file.transfer")).toMatchObject({
        authority: "filesReceive",
        exposure: "brokered",
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "edit")).toMatchObject({ authority: "write", mutation: "write" })
      expect(
        rows
          .filter((row) => row.id === "edit" || row.id === "patch")
          .every((row) => row.authority === "write" && row.mutation === "write"),
      ).toBe(true)
      expect(rows.find((row) => row.id === "git")).toMatchObject({ authority: "git", mutation: "write" })
      expect(rows.find((row) => row.id === "process")).toMatchObject({ authority: "process", mutation: "write" })
      expect(rows.find((row) => row.id === "runtime.refresh")).toMatchObject({
        authority: "process",
        exposure: "brokered",
        workspaceTier: 0,
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "process")?.description).toMatch(/opaque handle/i)
      expect(rows.find((row) => row.id === "process")?.description).toMatch(/never PID/i)
      expect(rows.find((row) => row.id === "process")?.description).toMatch(
        /upstream may reject model-authored authentication/i,
      )
      expect(rows.find((row) => row.id === "json")).toMatchObject({
        authority: "read",
        authorities: ["read", "write"],
        exposure: "brokered",
        load: "lazy",
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "memory")).toMatchObject({
        authority: "read",
        authorities: ["read", "write"],
        exposure: "brokered",
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "sqlite")).toMatchObject({
        authority: "read",
        authorities: ["read", "write"],
        exposure: "brokered",
        load: "lazy",
        workspaceTier: 3,
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "usage")).toMatchObject({
        authority: "sessionSupervision",
        exposure: "brokered",
        load: "lazy",
        workspaceTier: 1,
        mutation: "none",
      })
      expect(rows.find((row) => row.id === "models")).toMatchObject({
        authority: "read",
        exposure: "brokered",
        load: "lazy",
        workspaceTier: 0,
        mutation: "none",
      })
      expect(rows.find((row) => row.id === "test")).toMatchObject({
        authority: "read",
        authorities: ["read", "process"],
        exposure: "brokered",
        load: "lazy",
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "skill")).toMatchObject({
        authority: "read",
        exposure: "brokered",
        load: "default",
        mutation: "none",
      })
      expect(rows.find((row) => row.id === "typecheck")).toMatchObject({
        authority: "read",
        authorities: ["read", "process"],
        exposure: "brokered",
        mutation: "none",
      })
      expect(rows.find((row) => row.id === "web")).toMatchObject({
        authority: "integrations",
        exposure: "brokered",
        workspaceTier: 0,
        mutation: "none",
      })
      expect(rows.find((row) => row.id === "write")).toMatchObject({
        authority: "write",
        authorities: ["write", "process"],
        exposure: "direct",
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "project")).toMatchObject({
        authority: "read",
        authorities: ["read", "process"],
        exposure: "brokered",
        mutation: "none",
      })
      expect(rows.find((row) => row.id === "archive")?.authorities).toEqual(["read", "write", "process"])
      expect(rows.find((row) => row.id === "refactor")?.authorities).toEqual(["read", "write", "process"])
      expect(
        rows
          .filter((row) => row.authorities)
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(["archive", "json", "memory", "project", "refactor", "sqlite", "test", "typecheck", "write"])
      expect(rows.find((row) => row.id === "schedule.create")).toMatchObject({
        authority: "automation",
        exposure: "brokered",
        workspaceTier: 1,
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "schedule")).toMatchObject({
        authority: "automation",
        exposure: "brokered",
        workspaceTier: 1,
        mutation: "write",
      })
      expect(rows.find((row) => row.id === "system-one")).toMatchObject({
        authority: "integrations",
        exposure: "brokered",
        load: "default",
        workspaceTier: 3,
        mutation: "none",
      })
      const exceptional = new Set([
        "archive",
        "browser",
        "code",
        "edit",
        "file.transfer",
        "git",
        "json",
        "memory",
        "ofxp",
        "openfork_session.checkpoint",
        "openfork_swarm",
        "openfork_worker",
        "patch",
        "process",
        "refactor",
        "runtime.refresh",
        "schedule",
        "schedule.create",
        "sqlite",
        "sympy",
        "system-one",
        "test",
        "usage",
        "web",
        "write",
      ])
      expect(
        rows
          .filter((row) => !exceptional.has(row.id))
          .filter((row) => row.authority !== "read" || row.mutation !== "none")
          .map((row) => ({ id: row.id, authority: row.authority, mutation: row.mutation })),
      ).toEqual([])
      expect(JSON.stringify(rows)).not.toContain("properties")
    }),
  )

  it.live(
    "recovers relevant capabilities from natural-language action queries without eager schema expansion",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const queries = [
        ["batch workers", "openfork_swarm"],
        ["JSON patches", "json"],
        ["find symbol references", "symbols"],
        ["restore checkpoint", "openfork_session.checkpoint"],
        ["project runtime versions", "project"],
        ["run tests", "test"],
      ] as const
      for (const [query, expected] of queries) {
        const rows = yield* capability.list(query, "all")
        expect(rows.slice(0, 3).map((item) => item.id), query).toContain(expected)
        expect(rows.every((item) => item.description.length <= 180), query).toBe(true)
      }
      // Discovery restrictions are applied before ranking. A query cannot
      // force a lazy capability into the default-only result set.
      expect((yield* capability.list("batch workers", "default")).map((item) => item.id))
        .not.toContain("openfork_swarm")
      expect((yield* capability.list("batch workers", "lazy")).map((item) => item.id))
        .toContain("openfork_swarm")
    }),
  )

  it.live(
    "keeps every OpenFork capability description canonical and bounded",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const rows = yield* capability.list(undefined, "all")
      const canonical = CAPABILITY_DESCRIPTIONS as Record<string, string>
      expect(rows.map((row) => row.id)).toEqual(Object.keys(canonical).toSorted())
      for (const row of rows) {
        expect(row.description).toBe(canonical[row.id])
        expect(row.description.length).toBeGreaterThanOrEqual(90)
        expect(row.description.length, row.id).toBeLessThanOrEqual(180)
        expect(row.description).not.toContain("\n")
      }
    }),
  )

  it.live(
    "mirrors native lazy-tool discovery through the capability broker",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const lazyRows = yield* capability.list(undefined, "lazy")
      expect(lazyRows.map((row) => row.id)).toEqual([
        "archive",
        "json",
        "models",
        "openfork_session.checkpoint",
        "openfork_swarm",
        "refactor",
        "sqlite",
        "sympy",
        "test",
        "usage",
      ])
      expect(lazyRows.every((row) => row.load === "lazy")).toBe(true)

      const defaultRows = yield* capability.list(undefined, "default")
      expect(defaultRows.map((row) => row.id)).not.toContain("archive")
      expect(defaultRows.map((row) => row.id)).toContain("system-one")

      expect(defaultRows.map((row) => row.id)).not.toContain("json")
      expect(defaultRows.map((row) => row.id)).not.toContain("refactor")
      expect(defaultRows.map((row) => row.id)).not.toContain("sqlite")
      expect(defaultRows.map((row) => row.id)).not.toContain("test")
      expect(defaultRows.every((row) => row.load === "default")).toBe(true)

      const brokerDefault = yield* capability.execute({ action: "list" })
      const brokerDefaultRows = JSON.parse(brokerDefault.output) as Array<{ id: string; load: string }>
      expect(brokerDefaultRows.map((row) => row.id)).toEqual([
        "archive",
        "json",
        "models",
        "openfork_session.checkpoint",
        "openfork_swarm",
        "refactor",
        "sqlite",
        "sympy",
        "test",
        "usage",
      ])
      expect((brokerDefault.metadata as { load?: string }).load).toBe("lazy")

      const full = yield* capability.execute({ action: "list", load: "all" })
      const fullRows = JSON.parse(full.output) as Array<{ id: string; load: string }>
      expect(fullRows).toHaveLength(Object.keys(CAPABILITY_DESCRIPTIONS).length)
      expect(fullRows.find((row) => row.id === "skill")?.load).toBe("default")
      expect(fullRows.find((row) => row.id === "archive")?.load).toBe("lazy")

      const targeted = yield* capability.execute({ action: "list", query: "runtime refresh" })
      const targetedRows = JSON.parse(targeted.output) as Array<{ id: string; load: string }>
      expect(targetedRows).toEqual([expect.objectContaining({ id: "runtime.refresh", load: "default" })])
      expect((targeted.metadata as { load?: string }).load).toBe("all")

      const punctuation = yield* capability.execute({ action: "list", query: "openfork session checkpoint" })
      const punctuationRows = JSON.parse(punctuation.output) as Array<{ id: string }>
      expect(punctuationRows.map((row) => row.id)).toContain("openfork_session.checkpoint")
    }),
  )

  it.live(
    "describes one canonical schema only on demand",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* capability.describe("read")
      expect(result.capability.id).toBe("read")
      expect(result.protocol).toBe("broker-descriptor-v1")
      expect(result.contract).toMatch(/^broker-v1:[0-9a-f]{24}$/)
      expect(result.invocation).toEqual({
        action: "call",
        targetField: "capability",
        target: "read",
        contractField: "contract",
        argsField: "args",
      })
      expect(result.inputSchema).toMatchObject({ type: "object" })
      expect(JSON.stringify(result.inputSchema)).toContain("rootID")
    }),
  )

  it.live(
    "discovers lazy usage without entering native Session runtime and rejects arbitrary session access",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, sessionSupervision: "approved-roots" })

      const lazy = yield* capability.list("usage", "lazy")
      expect(lazy).toEqual([
        expect.objectContaining({
          id: "usage",
          load: "lazy",
          authority: "sessionSupervision",
          mutation: "none",
        }),
      ])

      const descriptor = yield* capability.describe("usage")
      expect(descriptor.inputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["action"]),
      })
      expect(JSON.stringify(descriptor.inputSchema)).not.toContain("systemPrompt")
      expect(JSON.stringify(descriptor.inputSchema)).not.toContain("apiKey")

      const invalidAction = yield* capability
        .call("usage", { action: "totals", sessionID: "ses_unauthorized" })
        .pipe(Effect.flip)
      expect(invalidAction._tag).toBe("OXP_AUTH_DENIED")

      const inaccessible = yield* capability
        .call("usage", { action: "context", sessionID: "ses_unauthorized" })
        .pipe(Effect.flip)
      expect(inaccessible._tag).toBe("OXP_NOT_FOUND")
    }),
  )

  it.live(
    "discovers the lazy public models catalog and rejects host-private enrichments without model or account reads",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, sessionSupervision: "approved-roots" })
      const listed = yield* capability.list("public model metadata", "lazy")
      expect(listed).toEqual([
        expect.objectContaining({ id: "models", authority: "read", load: "lazy", mutation: "none" }),
      ])
      const descriptor = yield* capability.describe("models")
      const contract = JSON.stringify(descriptor.inputSchema)
      expect(contract).toContain("includeUsage")
      expect(contract).toContain("includeQuota")
      expect(contract).not.toContain("apiKey")
      expect(contract).not.toContain("headers")
      const quota = yield* capability.call("models", { includeQuota: true, providerID: "example" }).pipe(Effect.flip)
      expect(quota._tag).toBe("OXP_INVALID_ARGUMENT")
      const configured = yield* capability.call("models", { scope: "configured" }).pipe(Effect.flip)
      expect(configured._tag).toBe("OXP_INVALID_ARGUMENT")
      const missingSession = yield* capability.call("models", { includeUsage: true }).pipe(Effect.flip)
      expect(missingSession._tag).toBe("OXP_INVALID_ARGUMENT")
      const unknownSession = yield* capability.call("models", { includeUsage: true, sessionID: "ses_unauthorized" }).pipe(Effect.flip)
      expect(unknownSession._tag).toBe("OXP_NOT_FOUND")
      const publicModels = yield* capability.call("models", { q: "gpt", limit: 1 })
      expect(publicModels.structured).toMatchObject({
        source: "public-models-dev",
        quota: "not-inspected-host-private",
      })
    }),
  )

  it.live(
    "makes common read/find shape mistakes self-correcting without accepting them",
    Effect.gen(function* () {
      const capability = yield* OxpCapability.Service
      const rootID = "00000000-0000-4000-8000-000000000001"

      const readError = yield* capability.call("read", { rootID, path: "a.ts", offset: 0 }).pipe(Effect.flip)
      expect(readError._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(readError.detail).toContain("1-based")
      expect(readError.detail).toContain("offset:1")

      const findError = yield* capability.call("find", { rootID, query: "needle", maxResults: 10 }).pipe(Effect.flip)
      expect(findError._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(findError.detail).toContain("query/maxResults")
      expect(findError.detail).toContain("grep")
      expect(findError.detail).toContain("limit")
    }),
  )

  it.live(
    "keeps evolving delegated-worker arguments reachable through the live broker schema",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "worker-broker-workspace")
      const nested = path.join(rootDir, "repo")
      yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ delegation: "spawn" })

      const discovered = yield* capability.execute({
        action: "list",
        query: "worker workdir",
      })
      const discoveredRows = JSON.parse(discovered.output) as Array<{ id: string }>
      expect(discoveredRows.map((row) => row.id)).toContain("openfork_worker")

      const descriptor = yield* capability.describe("openfork_worker")
      expect(descriptor.capability).toMatchObject({
        id: "openfork_worker",
        authority: "delegation",
        exposure: "direct",
        workspaceTier: 3,
        mutation: "write",
      })
      expect((descriptor.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("workdir")
      expect((descriptor.inputSchema as { $defs?: Record<string, unknown> }).$defs).toMatchObject({
        "Oxp.ModelSelection": expect.any(Object),
        "Oxp.WorkerStart": expect.any(Object),
        "Oxp.WorkerContinue": expect.any(Object),
      })
      const workerAgain = yield* capability.describe("openfork_worker")
      expect(workerAgain.contract).toBe(descriptor.contract)
      const fromExecute = yield* capability.execute({ action: "describe", capability: "openfork_worker" })
      expect(JSON.parse(fromExecute.output).contract).toBe(descriptor.contract)

      const resolved = yield* roots.resolvePath("repo", { rootID: root.id })
      let dispatched: unknown
      const result = yield* capability.execute(
        {
          action: "call",
          capability: "openfork_worker",
          contract: descriptor.contract,
          args: {
            action: "start",
            rootID: root.id,
            workdir: "repo",
            prompt: "broker workdir canary",
          },
        },
        undefined,
        {
          workerExecute: (workerInput) =>
            Effect.sync(() => {
              dispatched = workerInput
              return {
                title: "Delegated worker fixture",
                output: JSON.stringify({
                  workerID: "ses_capability_worker",
                  workdir: resolved.virtualPath,
                }),
                structured: {
                  workerID: "ses_capability_worker",
                  workdir: resolved.virtualPath,
                },
                mutation: { attempted: true, committed: true },
              }
            }),
        },
      )

      expect(dispatched).toMatchObject({
        action: "start",
        rootID: root.id,
        workdir: "repo",
        prompt: "broker workdir canary",
      })
      expect(result.structured).toMatchObject({
        workerID: "ses_capability_worker",
        workdir: resolved.virtualPath,
      })
    }),
  )

  it.live(
    "publishes self-contained compact object schemas for every broker descriptor",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)

      const rows = yield* capability.list(undefined, "all")
      for (const row of rows) {
        const descriptor = yield* capability.describe(row.id)
        const schema = descriptor.inputSchema as Record<string, unknown>
        expect(schema.type, row.id).toBe("object")
        const defs =
          schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)
            ? (schema.$defs as Record<string, unknown>)
            : {}
        for (const ref of localSchemaRefs(schema)) {
          expect(Object.prototype.hasOwnProperty.call(defs, ref), `${row.id}: unresolved #/$defs/${ref}`).toBe(true)
        }
        // Null branches are not intrinsically invalid: nullable *required*
        // fields need them. Do not trade away accepted values for smaller
        // descriptors; the decoder-backed AX projection suite covers them.
      }

      const read = yield* capability.describe("read")
      expect((read.inputSchema as { oneOf?: unknown[] }).oneOf).toHaveLength(2)
    }),
  )

  it.live(
    "rejects excess project arguments instead of silently dropping them",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "project-strict-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const error = yield* capability
        .call("project", {
          rootID: root.id,
          action: "summary",
          actiontypo: "summary",
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("OXP_INVALID_ARGUMENT")
    }),
  )

  it.live(
    "self-heals harmless top-level rootID on native list and describe requests",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const rootID = OxpSchema.RootID.make("00000000-0000-4000-8000-000000000001")

      const listed = yield* capability.execute({ action: "list", rootID })
      expect((listed.metadata as { brokerNormalized?: string[] }).brokerNormalized).toEqual([
        "ignored top-level rootID for OpenFork capability.list",
      ])

      const described = yield* capability.execute({ action: "describe", capability: "read", rootID })
      expect(JSON.parse(described.output)).toMatchObject({ capability: { id: "read" } })
      expect((described.metadata as { brokerNormalized?: string[] }).brokerNormalized).toEqual([
        "ignored top-level rootID for OpenFork capability.describe",
      ])
    }),
  )

  it.live(
    "promotes a top-level rootID into native capability.call arguments and rejects conflicting roots",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "broker-root-normalization")
      const otherDir = path.join(suite, "broker-root-normalization-other")
      yield* Effect.promise(() => Promise.all([fs.mkdir(rootDir), fs.mkdir(otherDir)]))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "probe.txt"), "broker root normalization\n"))
      const root = yield* roots.approve(rootDir)
      const other = yield* roots.approve(otherDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const descriptor = yield* capability.describe("read")

      const result = yield* capability.execute({
        action: "call",
        capability: "read",
        contract: descriptor.contract,
        rootID: root.id,
        args: { path: "probe.txt" },
      })
      expect(result.output).toContain("broker root normalization")
      expect((result.metadata as { brokerNormalized?: string[] }).brokerNormalized).toEqual([
        "promoted top-level rootID into OpenFork capability arguments",
      ])

      const conflict = yield* capability
        .execute({
          action: "call",
          capability: "read",
          contract: descriptor.contract,
          rootID: root.id,
          args: { rootID: other.id, path: "probe.txt" },
        })
        .pipe(Effect.flip)
      expect(conflict._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(conflict.detail).toContain("Conflicting rootID")
    }),
  )

  it.live(
    "describes System One as a typed root-scoped semantic capability without credential fields",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)

      const descriptor = yield* capability.describe("system-one")
      expect(descriptor.capability).toMatchObject({
        id: "system-one",
        authority: "integrations",
        exposure: "brokered",
        load: "default",
        workspaceTier: 3,
        mutation: "none",
      })
      const schema = JSON.stringify(descriptor.inputSchema)
      for (const field of [
        "rootID",
        "providerID",
        "modelID",
        "accountID",
        "affinityID",
        "state",
        "questions",
        "timeoutMs",
      ]) {
        expect(schema).toContain(`"${field}"`)
      }
      expect(schema).not.toContain("apiKey")
      expect(schema).not.toContain("credentialRef")
      expect(schema).not.toContain("Authorization")
    }),
  )

  it.live(
    "keeps System One execution behind live integrations authority",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, integrations: false })

      const descriptor = yield* capability.describe("system-one")
      const denied = yield* capability
        .execute({
          action: "call",
          capability: "system-one",
          contract: descriptor.contract,
          args: {
            rootID: "00000000-0000-4000-8000-000000000001",
            providerID: "opencode",
            modelID: "jev-1.13-free",
            state: "candidate",
            questions: {
              valid: {
                type: "noul",
                instructions: "Is the candidate valid?",
              },
            },
          },
        })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")
    }),
  )

  it.live(
    "dispatches typed System One inference through the root-scoped host port",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "system-one-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ integrations: true })

      const descriptor = yield* capability.describe("system-one")
      const result = yield* capability.execute({
        action: "call",
        capability: "system-one",
        contract: descriptor.contract,
        args: {
          rootID: root.id,
          providerID: "opencode",
          modelID: "jev-1.13-free",
          accountID: "zen-fixture",
          affinityID: "proofgate:fixture",
          state: { candidate: "x" },
          questions: {
            valid: {
              type: "noul",
              instructions: "Is the candidate valid?",
            },
          },
          timeoutMs: 15_000,
        },
      })

      expect(systemOneCall?.directory).toBe(rootDir)
      expect(systemOneCall?.input).toMatchObject({
        providerID: "opencode",
        modelID: "jev-1.13-free",
        accountID: "zen-fixture",
        affinityID: "proofgate:fixture",
        timeoutMs: 15_000,
      })
      expect(result.structured).toMatchObject({
        model: "jev-1.13-free",
        answers: { valid: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 12, output_tokens: 2 },
        cost: { input: 0, output: 0, total: 0 },
      })
      expect(result.metadata).toMatchObject({
        providerID: "opencode",
        modelID: "jev-1.13-free",
        inputTokens: 12,
        outputTokens: 2,
        cost: 0,
      })
      expect(result.metadata).not.toHaveProperty("accountID")
      expect(result.output).not.toContain(rootDir)
      expect(JSON.stringify(result)).not.toContain("apiKey")
      expect(JSON.stringify(result)).not.toContain("credentialRef")
      expect(JSON.stringify(result)).not.toContain("Authorization")
    }),
  )

  it.live(
    "dispatches web provider discovery through the broker without network access",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ integrations: true })

      const descriptor = yield* capability.describe("web")
      const result = yield* capability.execute({
        action: "call",
        capability: "web",
        contract: descriptor.contract,
        args: { action: "providers" },
      })

      expect(result.title).toBe("Web search providers")
      expect(result.metadata).toEqual({ action: "providers" })
      expect(result.structured).toMatchObject({ providers: expect.any(Array) })
    }),
  )

  it.live(
    "dispatches local OFXP status through the broker without fabricating a Session",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ integrations: true })

      const descriptor = yield* capability.describe("ofxp")
      const result = yield* capability.execute({
        action: "call",
        capability: "ofxp",
        contract: descriptor.contract,
        args: { action: "status" },
      })

      expect(result.title).toBe("OFXP status")
      expect(result.metadata).toEqual({ action: "status" })
      expect(result.structured).toBeDefined()
    }),
  )

  it.live(
    "dispatches memory reads through the approved-root runtime without a parent Session",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "memory-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const descriptor = yield* capability.describe("memory")
      const result = yield* capability.execute({
        action: "call",
        capability: "memory",
        contract: descriptor.contract,
        args: { rootID: root.id, action: "map" },
      })

      expect(result.title).toBe("Memory map")
      // The shared memory owner adds bounded timing diagnostics without changing
      // the authorized action/root identity of the returned result.
      expect(result.metadata).toMatchObject({
        action: "map",
        rootID: root.id,
        timingMs: { total: expect.any(Number) },
        runtimeTimingMs: { operation: expect.any(Number) },
      })
      expect(result.structured).toMatchObject({ action: "map" })
      expect(result.output).not.toContain(rootDir)
    }),
    { timeout: 30_000 },
  )

  it.live(
    "dispatches LSP through the shared runtime and preserves deterministic missing-file failure",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "lsp-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const descriptor = yield* capability.describe("lsp")
      const missing = yield* capability
        .execute({
          action: "call",
          capability: "lsp",
          contract: descriptor.contract,
          args: {
            rootID: root.id,
            operation: "documentSymbol",
            filePath: "missing.ts",
            line: 1,
            character: 1,
          },
        })
        .pipe(Effect.flip)

      expect(missing._tag).toBe("OXP_NOT_FOUND")
      expect(missing.detail).toContain("does not exist")
      expect(missing.detail).not.toContain(rootDir)
    }),
  )

  it.live(
    "describes and dispatches the canonical schedule lifecycle through the broker contract",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "schedule-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ automation: true })

      const descriptor = yield* capability.describe("schedule")
      expect(descriptor.capability).toMatchObject({
        id: "schedule",
        authority: "automation",
        exposure: "brokered",
        workspaceTier: 1,
        mutation: "write",
      })
      const schema = JSON.stringify(descriptor.inputSchema)
      for (const action of ["create", "list", "update", "inbox", "acknowledge", "run_now", "preview", "agenda"]) {
        expect(schema).toContain(`\"${action}\"`)
      }

      const result = yield* capability.execute({
        action: "call",
        capability: "schedule",
        contract: descriptor.contract,
        args: {
          action: "preview",
          rootID: root.id,
          schedule: { kind: "relative", delayMs: 60_000 },
          count: 1,
        },
      })
      expect(result.structured).toMatchObject({ action: "preview" })
      expect((result.structured as { preview: { next: number[] } }).preview.next).toHaveLength(1)
      expect(result.output).not.toContain(rootDir)
    }),
  )

  it.live(
    "loads a lazy capability schema only at describe and still requires its contract on call",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const descriptor = yield* capability.describe("json")
      expect(descriptor.capability).toMatchObject({ id: "json", load: "lazy", exposure: "brokered" })
      expect(JSON.stringify(descriptor.inputSchema)).toContain("compareJsonText")

      const missingContract = yield* capability
        .execute({ action: "call", capability: "json", args: { mode: "query", jsonText: '{"x":1}', path: "$.x" } })
        .pipe(Effect.flip)
      expect(missingContract._tag).toBe("OXP_INVALID_ARGUMENT")

      const called = yield* capability.execute({
        action: "call",
        capability: "json",
        contract: descriptor.contract,
        args: { mode: "query", jsonText: '{"x":1}', path: "$.x" },
      })
      expect(called.output).toContain("1")
    }),
  )

  it.live(
    "requires describe contract only on the compressed capability call path",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const rejected = yield* capability.execute({ action: "call", capability: "read", args: {} }).pipe(Effect.flip)
      expect(rejected._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(rejected.detail).toContain("descriptor contract")

      const descriptor = yield* capability.describe("read")
      const rejectedCrossCapability = yield* capability
        .execute({ action: "call", capability: "find", contract: descriptor.contract, args: {} })
        .pipe(Effect.flip)
      expect(rejectedCrossCapability._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(rejectedCrossCapability.detail).toContain("descriptor contract")
    }),
  )

  it.live(
    "dispatches calls through the leaf executor's live root/read authority",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "hello\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* capability.call("read", { rootID: root.id, path: "a.txt" })
      expect(result.output).toContain("1: hello")
      expect(result.output).not.toContain(rootDir)
    }),
  )

  it.live(
    "exposes native grep, outline, and around directly through the OXP capability broker",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "read-action-parity")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(rootDir, "file.ts"), "export function brokerSymbol() { return 42 }\nbrokerSymbol()\n"),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, process: false })

      const descriptor = yield* capability.describe("read")
      expect(JSON.stringify(descriptor.inputSchema)).toContain("around")
      for (const action of ["grep", "outline", "around"] as const) {
        const result = yield* capability.execute({
          action: "call",
          capability: "read",
          contract: descriptor.contract,
          args: {
            rootID: root.id,
            path: "file.ts",
            action,
            ...(action === "grep" ? { pattern: "brokerSymbol" } : {}),
            ...(action === "around" ? { symbol: "brokerSymbol" } : {}),
          },
        })
        expect(result.output).toContain("brokerSymbol")
        expect(result.output).not.toContain(rootDir)
      }

      yield* config.setGrant({ read: false })
      const denied = yield* capability
        .call("read", {
          rootID: root.id,
          path: "file.ts",
          action: "around",
          symbol: "brokerSymbol",
        })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")
    }),
  )

  it.live(
    "brokers native symbol intelligence without manufacturing Tool.Context",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "symbols-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const nested = path.join(rootDir, "nested-project")
      yield* Effect.promise(() => fs.mkdir(nested))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(rootDir, "sample.ts"),
          "export function oxpSymbolProbe() { return 42 }\noxpSymbolProbe()\n",
        ),
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(nested, "nested.ts"), "export function nestedScopeProbe() { return 7 }\n"),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const descriptor = yield* capability.describe("symbols")
      expect(descriptor.capability).toMatchObject({
        id: "symbols",
        authority: "read",
        exposure: "brokered",
        mutation: "none",
      })
      const result = yield* capability.execute({
        action: "call",
        capability: "symbols",
        contract: descriptor.contract,
        args: { rootID: root.id, action: "search", query: "oxpSymbolProbe" },
      })
      expect(result.output).toContain('name="oxpSymbolProbe"')
      expect(result.output).not.toContain(rootDir)

      const scoped = yield* capability.call("symbols", {
        rootID: root.id,
        workdir: "nested-project",
        action: "search",
        query: "nestedScopeProbe",
      })
      expect(scoped.output).toContain('name="nestedScopeProbe"')
      expect(scoped.output).not.toContain(rootDir)
      const absentInScope = yield* capability.call("symbols", {
        rootID: root.id,
        workdir: "nested-project",
        action: "search",
        query: "oxpSymbolProbe",
      })
      expect(absentInScope.output).not.toContain('name="oxpSymbolProbe"')
      const escapedScope = yield* capability.call("symbols", {
        rootID: root.id,
        workdir: "../outside-project",
        action: "search",
        query: "nestedScopeProbe",
      }).pipe(Effect.flip)
      expect(escapedScope._tag).toBe("OXP_PATH_ESCAPE")
      const fileAsDirectory = yield* capability.call("symbols", {
        rootID: root.id,
        workdir: "sample.ts",
        action: "search",
        query: "oxpSymbolProbe",
      }).pipe(Effect.flip)
      expect(fileAsDirectory._tag).toBe("OXP_INVALID_ARGUMENT")

      yield* config.setGrant({ read: false })
      const denied = yield* capability
        .call("symbols", { rootID: root.id, action: "search", query: "oxpSymbolProbe" })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")
    }),
  )

  it.live(
    "brokers JSON reads and requires write authority only for commits",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "json-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const file = path.join(rootDir, "app.json")
      yield* Effect.promise(() => fs.writeFile(file, '{ "name": "openfork", "version": 1 }\n'))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, write: false })

      const missingRoot = yield* capability
        .call("json", {
          mode: "query",
          filePath: "app.json",
          path: "$.name",
        })
        .pipe(Effect.flip)
      expect(missingRoot._tag).toBe("OXP_ROOT_REQUIRED")

      const descriptor = yield* capability.describe("json")
      expect(descriptor.capability).toMatchObject({
        id: "json",
        authority: "read",
        exposure: "brokered",
        mutation: "write",
      })

      const queried = yield* capability.execute({
        action: "call",
        capability: "json",
        contract: descriptor.contract,
        args: { rootID: root.id, mode: "query", filePath: "app.json", path: "$.name" },
      })
      expect(queried.output).toContain("openfork")
      expect(queried.output).not.toContain(rootDir)

      const denied = yield* capability
        .call("json", { rootID: root.id, mode: "format", filePath: "app.json", indent: 0, dryRun: false })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ write: true })
      const formatted = yield* capability.call("json", {
        rootID: root.id,
        mode: "format",
        filePath: "app.json",
        indent: 0,
        dryRun: false,
      })
      expect(formatted.mutation).toEqual({ attempted: true, committed: true })
      expect(formatted.output).toContain('written="true"')
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe('{"name":"openfork","version":1}')
    }),
  )

  it.live(
    "allows pure inline JSON analysis without filesystem authority",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: false, write: false })

      const result = yield* capability.call("json", {
        mode: "query",
        jsonText: '{"nested":{"value":42}}',
        path: "$.nested.value",
      })
      expect(result.output).toContain("42")
      expect(result.mutation).toEqual({ attempted: false, committed: false })
    }),
  )

  it.live(
    "brokers test discovery as read-only and test execution as process authority",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "test-workspace")
      const pkg = path.join(rootDir, "pkg")
      yield* Effect.promise(() => fs.mkdir(pkg, { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ scripts: { test: "bun test" } })),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(pkg, "probe.test.ts"),
          ['import { test, expect } from "bun:test"', 'test("oxp test probe", () => expect(21 * 2).toBe(42))', ""].join(
            "\n",
          ),
        ),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, process: false })

      const listed = yield* capability.call("test", {
        rootID: root.id,
        workdir: "pkg",
        action: "list",
      })
      expect(listed.output).toContain("probe.test.ts")
      expect(listed.output).not.toContain(rootDir)
      expect(listed.mutation).toEqual({ attempted: false, committed: false })

      const denied = yield* capability
        .call("test", {
          rootID: root.id,
          workdir: "pkg",
          action: "run",
          path: "probe.test.ts",
        })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ read: false, process: true })
      const ran = yield* capability.call("test", {
        rootID: root.id,
        workdir: "pkg",
        action: "run",
        path: "probe.test.ts",
        timeoutMs: 10_000,
      })
      expect(ran.output).toContain('status="passed"')
      expect(ran.output).toContain("1 passed / 0 failed")
      expect(ran.output).not.toContain(rootDir)
      expect(ran.mutation).toEqual({ attempted: true, committed: true })
    }),
  )

  it.live(
    "brokers pure archive inspection as read and create/extract as write",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "archive-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "source.txt"), "archive probe\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, write: false, process: false })

      const deniedCreate = yield* capability
        .call("archive", {
          rootID: root.id,
          action: "create",
          path: "bundle.zip",
          source: ["source.txt"],
        })
        .pipe(Effect.flip)
      expect(deniedCreate._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ write: true })
      const created = yield* capability.call("archive", {
        rootID: root.id,
        action: "create",
        path: "bundle.zip",
        source: ["source.txt"],
      })
      expect(created.mutation).toEqual({ attempted: true, committed: true })
      expect(created.output).not.toContain(rootDir)

      yield* config.setGrant({ write: false })
      const listed = yield* capability.call("archive", {
        rootID: root.id,
        action: "list",
        path: "bundle.zip",
      })
      expect(listed.output).toContain("source.txt")
      expect(listed.output).not.toContain(rootDir)

      const read = yield* capability.call("archive", {
        rootID: root.id,
        action: "read",
        path: "bundle.zip",
        entry: "source.txt",
      })
      expect(read.output).toContain("archive probe")

      const deniedExtract = yield* capability
        .call("archive", {
          rootID: root.id,
          action: "extract",
          path: "bundle.zip",
          destination: "out",
        })
        .pipe(Effect.flip)
      expect(deniedExtract._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ write: true })
      const extracted = yield* capability.call("archive", {
        rootID: root.id,
        action: "extract",
        path: "bundle.zip",
        destination: "out",
      })
      expect(extracted.mutation).toEqual({ attempted: true, committed: true })
      expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "out", "source.txt"), "utf8"))).toBe(
        "archive probe\n",
      )
    }),
  )

  it.live(
    "keeps archive traversal entries confined during OXP extraction",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "archive-traversal")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const zip = yield* Effect.promise(() =>
        ZipFile.zipToBuffer([
          { name: "../evil.txt", data: new TextEncoder().encode("pwned"), date: new Date() },
          { name: "ok.txt", data: new TextEncoder().encode("fine"), date: new Date() },
        ]),
      )
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "malicious.zip"), zip))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, write: true })

      const result = yield* capability.call("archive", {
        rootID: root.id,
        action: "extract",
        path: "malicious.zip",
        destination: "out",
      })
      expect(result.output).toContain("1 unsafe paths")
      expect(result.output).not.toContain(rootDir)
      expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "out", "ok.txt"), "utf8"))).toBe("fine")
      expect(
        yield* Effect.promise(() =>
          fs
            .access(path.join(rootDir, "evil.txt"))
            .then(() => true)
            .catch(() => false),
        ),
      ).toBe(false)
    }),
  )

  it.live(
    "requires process authority for system-backed archive inspection and fails closed for extraction",
    Effect.gen(function* () {
      if (!Bun.which("python") || !Bun.which("tar")) return
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "archive-system")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const payload = path.join(rootDir, "payload.txt")
      const archive = path.join(rootDir, "data.tar.xz")
      yield* Effect.promise(() => fs.writeFile(payload, "system archive content\n"))
      const code = yield* Effect.promise(
        () =>
          Bun.spawn([
            "python",
            "-c",
            "import tarfile,sys; t=tarfile.open(sys.argv[1],'w:xz'); t.add(sys.argv[2], arcname='folder/payload.txt'); t.close()",
            archive,
            payload,
          ]).exited,
      )
      expect(code).toBe(0)
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, write: false, process: false })

      const denied = yield* capability
        .call("archive", { rootID: root.id, action: "list", path: "data.tar.xz" })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ process: true })
      const listed = yield* capability.call("archive", {
        rootID: root.id,
        action: "list",
        path: "data.tar.xz",
      })
      expect(listed.output).toContain("folder/payload.txt")
      expect(listed.output).not.toContain(rootDir)

      const read = yield* capability.call("archive", {
        rootID: root.id,
        action: "read",
        path: "data.tar.xz",
        entry: "folder/payload.txt",
      })
      expect(read.output).toContain("system archive content")

      const deniedWrite = yield* capability
        .call("archive", {
          rootID: root.id,
          action: "extract",
          path: "data.tar.xz",
          destination: "out",
        })
        .pipe(Effect.flip)
      expect(deniedWrite._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ write: true })
      const failClosed = yield* capability
        .call("archive", {
          rootID: root.id,
          action: "extract",
          path: "data.tar.xz",
          destination: "out",
        })
        .pipe(Effect.flip)
      expect(failClosed._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(failClosed.detail).toContain("system-backed archive extraction is disabled")
    }),
  )

  it.live(
    "keeps OXP skill discovery root-private and virtualizes loaded resources",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "skill-workspace")
      const outside = path.join(suite, "outside-skill")
      const localSkill = path.join(rootDir, ".opencode", "skill", "root-skill")
      const secondSkill = path.join(rootDir, "skills", "second-skill")
      const nestedSkill = path.join(rootDir, "nested-project", ".agents", "skills", "nested-skill")
      yield* Effect.promise(() =>
        Promise.all([
          fs.mkdir(path.join(localSkill, "scripts"), { recursive: true }),
          fs.mkdir(secondSkill, { recursive: true }),
          fs.mkdir(nestedSkill, { recursive: true }),
          fs.mkdir(outside, { recursive: true }),
        ]),
      )
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(
            path.join(localSkill, "SKILL.md"),
            "---\nname: root-skill\ndescription: Root private skill.\n---\n\nUse the root skill.\n",
          ),
          fs.writeFile(path.join(localSkill, "scripts", "probe.txt"), "probe"),
          fs.writeFile(path.join(nestedSkill, "SKILL.md"), "---\nname: nested-skill\ndescription: Nested project only.\n---\n\nUse nested skill.\n"),
          fs.writeFile(
            path.join(secondSkill, "SKILL.md"),
            "---\nname: second-skill\ndescription: Another project skill.\n---\n\nSecond skill.\n",
          ),
          fs.writeFile(
            path.join(outside, "SKILL.md"),
            "---\nname: outside-skill\ndescription: Must remain invisible.\n---\n\nOutside.\n",
          ),
        ]),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const listed = yield* capability.call("skill", {
        rootID: root.id,
        mode: "list",
      })
      expect(listed.output).toContain("root-skill")
      expect(listed.output).toContain("second-skill")
      expect(listed.output).not.toContain("outside-skill")
      expect(listed.output).not.toContain("nested-skill")
      expect(listed.output).not.toContain(rootDir)
      expect(listed.output).not.toContain(outside)

      const searched = yield* capability.call("skill", {
        rootID: root.id,
        mode: "search",
        query: "private",
      })
      expect(searched.output).toContain("root-skill")
      expect(searched.output).not.toContain("second-skill")

      const loaded = yield* capability.call("skill", {
        rootID: root.id,
        name: "root skill",
      })
      expect(loaded.output).toContain('<skill_content name="root-skill">')
      expect(loaded.output).toContain("Use the root skill.")
      expect(loaded.output).toContain("/skill-workspace/.opencode/skill/root-skill")
      expect(loaded.output).toContain("/skill-workspace/.opencode/skill/root-skill/scripts/probe.txt")
      expect(loaded.output).not.toContain(rootDir)

      const nestedListed = yield* capability.call("skill", {
        rootID: root.id,
        workdir: "nested-project",
        mode: "list",
      })
      expect(nestedListed.output).toContain("nested-skill")
      expect(nestedListed.output).not.toContain("root-skill")
      expect(nestedListed.output).not.toContain(rootDir)
      const nestedLoaded = yield* capability.call("skill", {
        rootID: root.id,
        workdir: "nested-project",
        name: "nested-skill",
      })
      expect(nestedLoaded.output).toContain("Use nested skill.")
      expect(nestedLoaded.output).toContain("/skill-workspace/nested-project/.agents/skills/nested-skill")
      const fileAsWorkdir = yield* capability.call("skill", {
        rootID: root.id,
        workdir: ".opencode/skill/root-skill/SKILL.md",
        mode: "list",
      }).pipe(Effect.flip)
      expect(fileAsWorkdir._tag).toBe("OXP_INVALID_ARGUMENT")
      const escapedWorkdir = yield* capability.call("skill", {
        rootID: root.id,
        workdir: "../outside-skill",
        mode: "list",
      }).pipe(Effect.flip)
      expect(escapedWorkdir._tag).toBe("OXP_PATH_ESCAPE")

      const escaped = yield* capability
        .call("skill", {
          rootID: root.id,
          filePath: "../outside-skill",
        })
        .pipe(Effect.flip)
      expect(escaped._tag).toBe("OXP_PATH_ESCAPE")
    }),
  )

  it.live(
    "brokers typecheck explain as read and compiler execution as process without workspace scratch writes",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "typecheck-workspace")
      const repo = path.join(rootDir, "repo")
      yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(
            path.join(repo, "tsconfig.custom.json"),
            JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext" } }),
          ),
          fs.writeFile(path.join(repo, "ok.ts"), "export const answer: number = 42\n"),
          fs.writeFile(path.join(repo, "bad.ts"), 'export const answer: number = "forty-two"\n'),
        ]),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, process: false })

      const explained = yield* capability.call("typecheck", {
        rootID: root.id,
        mode: "explain",
        filePath: "TS2307",
      })
      expect(explained.output).toContain('code="TS2307"')

      const denied = yield* capability
        .call("typecheck", {
          rootID: root.id,
          workdir: "repo",
          mode: "file",
          filePath: "ok.ts",
          tsconfig: "tsconfig.custom.json",
        })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ read: false, process: true })
      const passed = yield* capability.call("typecheck", {
        rootID: root.id,
        workdir: "repo",
        mode: "file",
        filePath: "ok.ts",
        tsconfig: "tsconfig.custom.json",
        timeoutMs: 20_000,
      })
      expect(passed.output).toContain('status="passed"')
      expect(passed.output).not.toContain(rootDir)
      expect(passed.mutation).toEqual({ attempted: false, committed: false })

      const failed = yield* capability.call("typecheck", {
        rootID: root.id,
        workdir: "repo",
        mode: "file",
        filePath: "bad.ts",
        tsconfig: "tsconfig.custom.json",
        timeoutMs: 20_000,
      })
      expect(failed.output).toContain('status="failed"')
      expect(failed.output).toContain("TS2322")
      expect(failed.output).not.toContain(rootDir)

      const workspaceFiles = yield* Effect.promise(() => fs.readdir(repo))
      expect(workspaceFiles.some((name) => name.startsWith(".opencode-typecheck-"))).toBe(false)

      const escaped = yield* capability
        .call("typecheck", {
          rootID: root.id,
          workdir: "repo",
          mode: "file",
          filePath: "../outside.ts",
          tsconfig: "tsconfig.custom.json",
        })
        .pipe(Effect.flip)
      expect(["OXP_NOT_FOUND", "OXP_INVALID_ARGUMENT", "OXP_PATH_ESCAPE"]).toContain(escaped._tag)
    }),
    { timeout: 30_000 },
  )

  it.live(
    "brokers atomic write creation and overwrite behind write authority",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "write-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ write: false })

      const denied = yield* capability
        .call("write", { rootID: root.id, path: "nested/new.txt", content: "first\n" })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ write: true })
      const markdown = [
        "# Storage guide",
        "",
        "```powershell",
        "Write-Output `literal`",
        "$null = 'quoted value'",
        "```",
        "",
        "Markdown `inline code` stays byte-exact.",
        "",
      ].join("\n")
      const literal = yield* capability.call("write", {
        rootID: root.id,
        path: "nested/storage-guide.md",
        content: markdown,
      })
      expect(literal.mutation).toEqual({ attempted: true, committed: true })
      expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "nested", "storage-guide.md"), "utf8"))).toBe(
        markdown,
      )

      const created = yield* capability.call("write", {
        rootID: root.id,
        path: "nested/new.txt",
        content: "first\n",
      })
      expect(created.mutation).toEqual({ attempted: true, committed: true })
      expect(created.output).not.toContain(rootDir)
      expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "nested", "new.txt"), "utf8"))).toBe("first\n")

      const overwritten = yield* capability.call("write", {
        rootID: root.id,
        path: "nested/new.txt",
        content: "second\n",
      })
      expect(overwritten.mutation).toEqual({ attempted: true, committed: true })
      expect((overwritten.metadata as { diff?: string }).diff).toContain("-first")
      expect((overwritten.metadata as { diff?: string }).diff).toContain("+second")
      expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "nested", "new.txt"), "utf8"))).toBe("second\n")

      const noop = yield* capability.call("write", {
        rootID: root.id,
        path: "nested/new.txt",
        content: "second\n",
      })
      expect(noop.mutation).toEqual({ attempted: false, committed: false })
    }),
  )

  it.live(
    "brokers OFXP receipt and call semantics without forcing a root or losing InvocationID",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const capability = yield* OxpCapability.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ integrations: true })

      const peerID = Ofxp.PeerID.make(`ofxp_${"a".repeat(43)}`)
      const invocationID = Ofxp.InvocationID.create()
      const contract = `broker-v1:${"0".repeat(24)}`

      const called = yield* capability.call("ofxp", {
        action: "call",
        peerID,
        capability: "web",
        invocationID,
        contract,
        args: { action: "providers" },
      })
      expect(called.output).toBe("remote-ok")
      expect(called.metadata).toMatchObject({
        action: "call",
        peerID,
        capability: "web",
        invocationID,
        ok: true,
      })
      expect(called.metadata).not.toHaveProperty("rootID")
      expect(ofxpInvocations).toHaveLength(1)
      expect(ofxpInvocations[0]).toMatchObject({
        peerID,
        capability: "web",
        invocationID,
        contract,
        args: { action: "providers" },
        source: { kind: "external" },
      })
      expect(ofxpInvocations[0]).not.toHaveProperty("rootID")

      const receipt = yield* capability.call("ofxp", {
        action: "receipt",
        peerID,
        invocationID,
      })
      expect(receipt.metadata).toMatchObject({
        action: "receipt",
        peerID,
        invocationID,
        ok: true,
      })
      expect((receipt.structured as { receipt?: { invocationID?: string } }).receipt?.invocationID).toBe(invocationID)
      expect(ofxpReceipts).toEqual([{ peerID, invocationID }])

      yield* config.setGrant({ integrations: false })
      const denied = yield* capability.call("ofxp", { action: "status" }).pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")
    }),
  )

  it.live(
    "exposes stateless Code through the permanent broker without widening leaf authority",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "code-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "hello from code\n"))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(rootDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)

      const describedCode = yield* capability.execute({ action: "describe", capability: "code" })
      const codeDescriptor = JSON.parse(describedCode.output) as { contract: string }

      const denied = yield* capability
        .execute({
          action: "call",
          capability: "code",
          contract: codeDescriptor.contract,
          args: { action: "search", query: "read" },
        })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")

      yield* config.setGrant({ code: true })
      const searched = yield* capability.execute({
        action: "call",
        capability: "code",
        contract: codeDescriptor.contract,
        args: { action: "search", query: "read" },
      })
      expect((searched.structured as { action?: string; items?: Array<{ ref: string }> }).action).toBe("search")
      expect(
        (searched.structured as { items?: Array<{ ref: string }> }).items?.some((item) => item.ref === "read"),
      ).toBe(true)
      const actionSearch = yield* capability.execute({
        action: "call",
        capability: "code",
        contract: codeDescriptor.contract,
        args: { action: "search", query: "batch workers", limit: 3 },
      })
      const actionItems = (actionSearch.structured as { items?: Array<{ ref: string; description: string }> }).items ?? []
      expect(actionItems[0]?.ref).toBe("openfork_swarm")
      expect(actionItems.every((entry) => Object.keys(entry).toSorted().join() === "description,ref")).toBe(true)

      const described = yield* capability.execute({
        action: "call",
        capability: "code",
        contract: codeDescriptor.contract,
        args: { action: "describe", ref: "read" },
      })
      expect((described.structured as { item?: { signature?: string } }).item?.signature).toContain('call(ref: "read"')

      const leafDenied = yield* capability.execute({
        action: "call",
        capability: "code",
        contract: codeDescriptor.contract,
        rootID: root.id,
        args: {
          action: "run",
          code: 'return await call("read", { path: "a.txt" })',
        },
      })
      expect((leafDenied.structured as { ok?: boolean; error?: { kind?: string } }).ok).toBe(false)
      expect((leafDenied.structured as { error?: { kind?: string } }).error?.kind).toBe("ToolFailure")

      yield* config.setGrant({ read: true })
      const allowed = yield* capability.execute({
        action: "call",
        capability: "code",
        contract: codeDescriptor.contract,
        rootID: root.id,
        args: {
          action: "run",
          code: 'return await call("read", { path: "a.txt" })',
        },
      })
      expect((allowed.structured as { ok?: boolean }).ok).toBe(true)
      expect(allowed.metadata).toMatchObject({ action: "run", stateless: true, rootID: root.id })
      const visual = yield* capability.execute({
        action: "call",
        capability: "code",
        contract: codeDescriptor.contract,
        rootID: root.id,
        args: { action: "run", code: 'return await call("read", { path: "image.png" })' },
      })
      expect(visual.mediaContent).toEqual([{
        type: "image",
        mimeType: "image/png",
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
      }])
      expect(JSON.stringify(visual.structured)).not.toContain("iVBOR")
      expect(JSON.stringify(visual)).not.toContain(rootDir)
    }),
  )

  it.live(
    "does not confuse discovery with call authority after revocation",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const capability = yield* OxpCapability.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "hello\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      expect((yield* capability.list()).length).toBe(Object.keys(CAPABILITY_DESCRIPTIONS).length)
      yield* config.setGrant({ read: false })

      const denied = yield* capability.call("read", { rootID: root.id, path: "a.txt" }).pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")
    }),
  )
})
