import { describe, expect, test } from "bun:test"
import type { SidecarOxpState } from "../sidecar-protocol"
import { OxpEndpointGenerationTracker } from "./generation"
import { OxpRuntimeStateProjection } from "./runtime-state-projection"

function state(generation: number, url: string, configRevision = 1): SidecarOxpState {
  return {
    version: 1,
    enabled: true,
    connector: { id: "openfork", label: "OpenFork" },
    configRevision,
    roots: [],
    grant: {
      read: true,
      write: false,
      process: false,
      git: false,
      integrations: false,
      browser: false,
      filesReceive: false,
      filesSend: false,
      automation: false,
      sessionSupervision: "none",
      requestSupervision: false,
      delegation: "disabled",
      nestedDelegation: false,
    },
    workerPolicy: { models: [], agents: [] },
    endpoint: {
      state: "ready",
      generation,
      url,
      metadataUrl: `${url}/metadata`,
      schemaFingerprint: "a".repeat(64),
    },
    metrics: {
      calls: 0,
      failures: 0,
      augmentationCalls: 0,
      supervisionCalls: 0,
      delegationCalls: 0,
      parentEpochs: 0,
      parentEpochReminders: 0,
      unattributedParentCalls: 0,
      trackedParents: 0,
    },
  }
}

describe("OXP runtime state projection", () => {
  test("lifts refreshed runtimes and rollback into one monotonic endpoint sequence", () => {
    const projection = new OxpRuntimeStateProjection()
    const original = {}
    const candidate = {}
    const url = "http://127.0.0.1:8123/mcp/first"

    const initial = projection.project(original, original, state(4, url))
    expect(initial?.endpoint.generation).toBe(1)
    const trial = projection.project(candidate, candidate, state(1, `${url}-candidate`))
    expect(trial?.endpoint.generation).toBe(2)
    expect(projection.project(original, candidate, state(5, `${url}-stale`, 2))).toBeUndefined()
    const rollback = projection.project(original, original, state(4, url))
    expect(rollback?.endpoint.generation).toBe(3)
  })

  test("keeps Electron endpoint admission open across runtime replacement and rollback", () => {
    const projection = new OxpRuntimeStateProjection()
    const tracker = new OxpEndpointGenerationTracker()
    const original = {}
    const candidate = {}
    tracker.attach(1)

    const initial = projection.project(original, original, state(4, "http://127.0.0.1:8123/mcp/first"))!
    expect(tracker.observe(1, initial.endpoint, initial.configRevision).accepted).toBe(true)

    const refreshed = projection.project(candidate, candidate, state(1, "http://127.0.0.1:8124/mcp/second"))!
    expect(tracker.observe(1, refreshed.endpoint, refreshed.configRevision)).toEqual({
      accepted: true,
      generation: 2,
      changed: true,
    })

    const rollback = projection.project(original, original, state(4, "http://127.0.0.1:8123/mcp/first"))!
    expect(tracker.observe(1, rollback.endpoint, rollback.configRevision)).toEqual({
      accepted: true,
      generation: 3,
      changed: true,
    })
  })

  test("rejects stale state within one runtime and advances when schema changes", () => {
    const projection = new OxpRuntimeStateProjection()
    const owner = {}
    const first = state(3, "http://127.0.0.1:8123/mcp/first", 7)

    expect(projection.project(owner, owner, first)?.endpoint.generation).toBe(1)
    expect(projection.project(owner, owner, { ...first, endpoint: { ...first.endpoint, schemaFingerprint: "b".repeat(64) } })?.endpoint.generation).toBe(2)
    expect(projection.project(owner, owner, state(1, "http://127.0.0.1:8123/mcp/old", 7))).toBeUndefined()
    expect(projection.project(owner, owner, state(2, "http://127.0.0.1:8123/mcp/old", 6))).toBeUndefined()
  })

  test("keeps the projected generation while a current runtime reports stopped", () => {
    const projection = new OxpRuntimeStateProjection()
    const owner = {}
    const ready = state(2, "http://127.0.0.1:8123/mcp/first")
    const started = projection.project(owner, owner, ready)
    const stopped = projection.project(owner, owner, {
      ...ready,
      endpoint: { state: "stopped", generation: 2 },
    })

    expect(started?.endpoint.generation).toBe(1)
    expect(stopped?.endpoint).toEqual({ state: "stopped", generation: 1 })
  })
})
