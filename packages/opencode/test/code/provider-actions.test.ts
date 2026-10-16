import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { isCodeRunTrace } from "@opencode-ai/core/v1/session"
import { SavedCodeAdmission } from "@opencode-ai/core/code/admission"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import type * as Tool from "@/tool/tool"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node, Session.node, SavedCodeAdmission.node])
const it = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
  ]),
)

const providerID = ProviderV2.ID.opencode
const modelID = ModelV2.ID.make("test")
const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]

describe("provider-visible Code saved-tool lifecycle", () => {
  it.instance(
    "runs, atomically promotes, discovers on a fresh root, and calls the durable saved revision",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const sessions = yield* Session.Service
        const admissions = yield* SavedCodeAdmission.Service
        const fixture = yield* TestInstance
        const agent = yield* agents.defaultInfo()
        const session = yield* sessions.create({ title: "code saved provider e2e" })

        const tools = yield* registry.tools({ providerID, modelID, agent })
        const code = tools.find((tool) => tool.id === "code")
        if (!code) throw new Error("provider-visible code tool missing")
        const providerDefinition = (tool: typeof code) =>
          JSON.stringify({
            description: tool.description,
            parameterSchema: Schema.toJsonSchemaDocument(tool.parameters).schema,
            jsonSchema: tool.jsonSchema,
          })
        const definitionBeforeSave = providerDefinition(code)

        const makeContext = (label: string): Tool.Context => ({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          partID: PartID.ascending(),
          callID: `call_code_saved_${label}`,
          agent: agent.name,
          abort: new AbortController().signal,
          permissionRuleset: allowAll,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
          captureCapabilities: () =>
            registry.capabilities({
              providerID,
              modelID,
              agent,
              permission: allowAll,
              sessionID: session.id,
            }),
        })

        const savedRun = yield* code.execute(
          {
            action: "run",
            code: "return input.value * 2",
            input: { value: 3 },
            save: {
              name: "double_value",
              inputSchema: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
                additionalProperties: false,
              },
              outputSchema: { type: "number" },
            },
          } as never,
          makeContext("run_save"),
        )

        const runData = savedRun.data as {
          ok: boolean
          value?: unknown
          saved?: { handle: string; path: string; revision: string }
        }
        expect(runData.ok).toBe(true)
        expect(runData.value).toBe(6)
        expect(runData.saved?.handle).toStartWith("saved:project/double_value@sha256:")
        if (!runData.saved) throw new Error("run.save did not return saved revision metadata")
        const saved = runData.saved

        const physical = yield* sessions.physicalScope(session.id)
        expect(physical.root).toBe(fixture.directory)
        const manifestPath = path.join(physical.root, ".openfork", "code", "double_value", "tool.json")
        const manifest = JSON.parse(yield* Effect.promise(() => fs.readFile(manifestPath, "utf8"))) as {
          revision: string
        }
        expect(manifest.revision).toBe(saved.revision)

        // A fresh provider root captures a fresh inventory and must discover the
        // just-admitted saved revision without changing the provider Code schema.
        const inventory = yield* registry.capabilities({
          providerID,
          modelID,
          agent,
          permission: allowAll,
          sessionID: session.id,
        })
        expect(inventory.entries.some((entry) => entry.identity.ref === saved.handle)).toBe(true)
        const codeAfterSave = (yield* registry.tools({ providerID, modelID, agent })).find((tool) => tool.id === "code")
        if (!codeAfterSave) throw new Error("provider-visible code tool missing after saved-tool churn")
        expect(providerDefinition(codeAfterSave)).toBe(definitionBeforeSave)

        const savedSearch = yield* code.execute(
          { action: "search", target: "saved", query: "double_value" } as never,
          makeContext("search_saved"),
        )
        const savedSearchData = savedSearch.data as {
          ok: boolean
          items?: Array<{ kind: string; ref: string; capabilityKind?: string }>
        }
        expect(savedSearchData.ok).toBe(true)
        expect(savedSearchData.items).toContainEqual(
          expect.objectContaining({ kind: "saved", ref: saved.handle, capabilityKind: "saved" }),
        )

        const called = yield* code.execute(
          {
            action: "call",
            tool: "project/double_value",
            input: { value: 5 },
          } as never,
          makeContext("call"),
        )
        const callData = called.data as {
          ok: boolean
          value?: unknown
          calls?: { total: number; failed: number }
          saved?: { handle: string }
        }
        expect(callData.ok).toBe(true)
        expect(callData.value).toBe(10)
        expect(callData.calls?.total).toBeGreaterThanOrEqual(1)
        expect(callData.calls?.failed).toBe(0)
        expect(callData.saved?.handle).toBe(saved.handle)

        // A frozen capability snapshot is discovery state, never execution
        // authority. Revoke admission after capture and deliberately reuse that
        // stale snapshot: nested saved execution must exact-resolve and fail
        // before the saved program can execute.
        const admittedSnapshot = yield* registry.capabilities({
          providerID,
          modelID,
          agent,
          permission: allowAll,
          sessionID: session.id,
        })
        expect(admittedSnapshot.entries.find((entry) => entry.identity.ref === saved.handle)?.codeCallable).toBe(true)
        yield* admissions.revoke({
          scopeKind: "project",
          scopeKey: physical.key,
          savedID: "double_value",
          revision: saved.revision,
        })

        const revokedContext = {
          ...makeContext("nested_after_revoke"),
          captureCapabilities: () => Effect.succeed(admittedSnapshot),
        }
        const revoked = yield* code.execute(
          {
            action: "run",
            code: `return await call(${JSON.stringify(saved.handle)}, { value: 7 })`,
            input: {},
          } as never,
          revokedContext,
        )
        const revokedData = revoked.data as {
          ok: boolean
          error?: { kind: string; message: string }
          calls?: { total: number; failed: number }
        }
        expect(revokedData.ok).toBe(false)
        expect(revokedData.error?.kind).toBe("CapabilityFailed")
        expect(revokedData.error?.message).toContain("not been admitted")
        expect(revokedData.calls?.failed).toBeGreaterThanOrEqual(1)

        yield* sessions.remove(session.id)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "promotes a retained successful CodeRun through standalone code.save and calls it from a fresh root",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const sessions = yield* Session.Service
        const agent = yield* agents.defaultInfo()
        const session = yield* sessions.create({ title: "standalone code.save provider e2e" })

        const code = (yield* registry.tools({ providerID, modelID, agent })).find((tool) => tool.id === "code")
        if (!code) throw new Error("provider-visible code tool missing")

        const makeContext = (
          label: string,
          ids?: { messageID: MessageID; partID: PartID },
        ): Tool.Context => ({
          sessionID: session.id,
          messageID: ids?.messageID ?? MessageID.ascending(),
          partID: ids?.partID ?? PartID.ascending(),
          callID: `call_code_standalone_${label}`,
          agent: agent.name,
          abort: new AbortController().signal,
          permissionRuleset: allowAll,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
          captureCapabilities: () =>
            registry.capabilities({
              providerID,
              modelID,
              agent,
              permission: allowAll,
              sessionID: session.id,
            }),
        })

        const messageID = MessageID.ascending()
        const partID = PartID.ascending()
        const source = "return input.value + 1"
        const input = { value: 8 }
        const run = yield* code.execute(
          { action: "run", code: source, input } as never,
          makeContext("source", { messageID, partID }),
        )
        const runData = run.data as {
          ok: boolean
          runID?: string
          value?: unknown
          sourceHash?: string
        }
        expect(runData.ok).toBe(true)
        expect(runData.value).toBe(9)
        expect(runData.runID).toBe(`run:${partID}`)
        if (!runData.runID) throw new Error("code.run did not return a durable run ID")

        // Persist the root ToolPart exactly at the Session owner. In production
        // SessionProcessor performs this settlement; the CodeRun resolver must
        // consume the same durable V1 ToolPart rather than a Code-specific DB.
        yield* sessions.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)
        yield* sessions.updatePart({
          id: partID,
          messageID,
          sessionID: session.id,
          type: "tool",
          callID: "call_code_standalone_source",
          tool: "code",
          state: {
            status: "completed",
            input: { action: "run", code: source, input },
            output: run.output,
            title: "code",
            metadata: run.metadata,
            time: { start: Date.now(), end: Date.now() },
          },
        })

        const runSearch = yield* code.execute(
          { action: "search", target: "runs" } as never,
          makeContext("search_runs"),
        )
        const runSearchData = runSearch.data as {
          ok: boolean
          items?: Array<{ kind: string; ref: string; description: string }>
        }
        expect(runSearchData.ok).toBe(true)
        expect(runSearchData.items).toContainEqual(
          expect.objectContaining({ kind: "run", ref: runData.runID }),
        )
        expect(JSON.stringify(runSearchData)).not.toContain(source)

        const described = yield* code.execute(
          { action: "describe", ref: runData.runID } as never,
          makeContext("describe_run"),
        )
        const describedData = described.data as {
          ok: boolean
          item?: {
            kind: string
            ref: string
            status: string
            sourceHash?: string
            dependencies?: { literalRefs: string[]; dynamicCallTarget: boolean }
            code?: unknown
            input?: unknown
          }
        }
        expect(describedData.ok).toBe(true)
        expect(describedData.item).toMatchObject({
          kind: "run",
          ref: runData.runID,
          status: "completed",
          sourceHash: runData.sourceHash,
          dependencies: { literalRefs: [], dynamicCallTarget: false },
        })
        expect(describedData.item?.code).toBeUndefined()
        expect(describedData.item?.input).toBeUndefined()

        const replayed = yield* code.execute(
          { action: "run", runID: runData.runID } as never,
          makeContext("replay_default"),
        )
        const replayedData = replayed.data as {
          ok: boolean
          value?: unknown
          replayOf?: string
        }
        expect(replayedData.ok).toBe(true)
        expect(replayedData.value).toBe(9)
        expect(replayedData.replayOf).toBe(runData.runID)

        const replayedOverride = yield* code.execute(
          { action: "run", runID: runData.runID, input: { value: 12 } } as never,
          makeContext("replay_override"),
        )
        const replayedOverrideData = replayedOverride.data as {
          ok: boolean
          value?: unknown
          replayOf?: string
        }
        expect(replayedOverrideData.ok).toBe(true)
        expect(replayedOverrideData.value).toBe(13)
        expect(replayedOverrideData.replayOf).toBe(runData.runID)

        const promoted = yield* code.execute(
          {
            action: "save",
            runID: runData.runID,
            save: {
              name: "increment_value",
              inputSchema: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
                additionalProperties: false,
              },
              outputSchema: { type: "number" },
            },
          } as never,
          makeContext("save"),
        )
        const saveData = promoted.data as {
          ok: boolean
          runID?: string
          saved?: { handle: string; revision: string }
        }
        expect(saveData.ok).toBe(true)
        expect(saveData.runID).toBe(runData.runID)
        expect(saveData.saved?.handle).toStartWith("saved:project/increment_value@sha256:")
        if (!saveData.saved) throw new Error("code.save did not return saved revision metadata")

        const called = yield* code.execute(
          { action: "call", tool: saveData.saved.handle, input: { value: 40 } } as never,
          makeContext("call"),
        )
        const callData = called.data as { ok: boolean; value?: unknown; saved?: { handle: string } }
        expect(callData.ok).toBe(true)
        expect(callData.value).toBe(41)
        expect(callData.saved?.handle).toBe(saveData.saved.handle)

        yield* sessions.remove(session.id)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "persists bounded trace/call counters when a saved code.call fails in a leaf capability",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const sessions = yield* Session.Service
        const agent = yield* agents.defaultInfo()
        const session = yield* sessions.create({ title: "failed code.call trace provider e2e" })
        const code = (yield* registry.tools({ providerID, modelID, agent })).find((tool) => tool.id === "code")
        if (!code) throw new Error("provider-visible code tool missing")

        const makeContext = (label: string): Tool.Context => ({
          sessionID: session.id,
          messageID: MessageID.ascending(),
          partID: PartID.ascending(),
          callID: `call_code_failure_trace_${label}`,
          agent: agent.name,
          abort: new AbortController().signal,
          permissionRuleset: allowAll,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
          captureCapabilities: () =>
            registry.capabilities({
              providerID,
              modelID,
              agent,
              permission: allowAll,
              sessionID: session.id,
            }),
        })

        const promoted = yield* code.execute(
          {
            action: "run",
            code: `
              if (input.fail) {
                return await call("native:read", { filePath: "__code_trace_missing__.txt" })
              }
              return "ready"
            `,
            input: { fail: false },
            save: {
              name: "failure_trace_probe",
              inputSchema: {
                type: "object",
                properties: { fail: { type: "boolean" } },
                required: ["fail"],
                additionalProperties: false,
              },
            },
          } as never,
          makeContext("save"),
        )
        const promotedData = promoted.data as {
          ok: boolean
          saved?: { handle: string }
        }
        expect(promotedData.ok).toBe(true)
        if (!promotedData.saved) throw new Error("run.save did not return saved revision metadata")

        const failed = yield* code.execute(
          { action: "call", tool: promotedData.saved.handle, input: { fail: true } } as never,
          makeContext("call"),
        )
        const failedData = failed.data as {
          ok: boolean
          calls?: { total: number; failed: number }
          error?: { kind: string }
        }
        expect(failedData.ok).toBe(false)
        expect(failedData.calls?.total).toBeGreaterThanOrEqual(2)
        expect(failedData.calls?.failed).toBeGreaterThanOrEqual(1)
        expect(failed.metadata.error).toBe(true)
        expect(failed.metadata.calls).toEqual(failedData.calls)
        expect(isCodeRunTrace(failed.metadata.trace)).toBe(true)
        if (!isCodeRunTrace(failed.metadata.trace)) throw new Error("failed code.call did not persist CodeRunTrace")
        expect(failed.metadata.trace.counters.failed).toBeGreaterThanOrEqual(1)
        expect(failed.metadata.trace.frames.some((frame) => frame.status === "failed")).toBe(true)

        yield* sessions.remove(session.id)
      }),
    { git: true },
    { timeout: 30000 },
  )
})
