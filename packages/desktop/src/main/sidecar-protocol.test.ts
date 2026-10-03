import { describe, expect, test } from "bun:test"
import {
  isSidecarMessage,
  isSidecarOxpState,
  parseSidecarCommand,
  parseSidecarGrantPatch,
  type SidecarOxpState,
} from "./sidecar-protocol"

const state = (): SidecarOxpState => ({
  version: 1,
  enabled: true,
  connector: { id: "11111111-1111-4111-8111-111111111111", label: "OpenFork OXP" },
  configRevision: 3,
  roots: [{ id: "22222222-2222-4222-8222-222222222222", alias: "project", path: "C:\\repo", available: true, managedByProject: false }],
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
  workerPolicy: {
    models: [],
    agents: [],
    defaultModel: {
      providerID: "workbuddy",
      modelID: "deepseek-v4.1-flash",
    },
    agentRoots: [
      {
        rootID: "22222222-2222-4222-8222-222222222222",
        agents: [],
        defaultAgent: "build",
      },
    ],
  },
  endpoint: {
    state: "ready",
    generation: 1,
    schemaFingerprint: "a".repeat(64),
    url: `http://127.0.0.1:41234/mcp/${"a".repeat(43)}`,
    metadataUrl: `http://127.0.0.1:41234/.well-known/oauth-protected-resource/mcp/${"a".repeat(43)}`,
  },
  metrics: {
    calls: 1,
    failures: 0,
    augmentationCalls: 1,
    supervisionCalls: 0,
    delegationCalls: 0,
    parentEpochs: 0,
    parentEpochReminders: 0,
    unattributedParentCalls: 0,
    trackedParents: 0,
  },
})

describe("desktop sidecar protocol", () => {
  test("accepts the closed OXP request union and rejects forged grant fields", () => {
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 9,
        request: { action: "set-grant", patch: { read: true, sessionSupervision: "approved-roots" } },
      }),
    ).toEqual({
      type: "oxp-request",
      id: 9,
      request: { action: "set-grant", patch: { read: true, sessionSupervision: "approved-roots" } },
    })
    expect(parseSidecarGrantPatch({ read: true, arbitrary: true })).toBeUndefined()
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 9,
        request: { action: "set-grant", patch: { delegation: "anything" } },
      }),
    ).toBeUndefined()
    expect(
      parseSidecarCommand({
        type: "oxp-credential-response",
        id: 21,
        ok: true,
        action: "resolve",
        value: "secret-value",
      }),
    ).toBeUndefined()
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 13,
        request: {
          action: "list-worker-agents",
          rootID: "22222222-2222-4222-8222-222222222222",
        },
      }),
    ).toEqual({
      type: "oxp-request",
      id: 13,
      request: {
        action: "list-worker-agents",
        rootID: "22222222-2222-4222-8222-222222222222",
      },
    })
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 16,
        request: { action: "sync-project-roots", paths: ["C:\\repo", "C:\\repo-2"] },
      }),
    ).toEqual({
      type: "oxp-request",
      id: 16,
      request: { action: "sync-project-roots", paths: ["C:\\repo", "C:\\repo-2"] },
    })
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 17,
        request: { action: "sync-project-roots", paths: ["x".repeat(4097)] },
      }),
    ).toBeUndefined()
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 14,
        request: {
          action: "set-worker-default-agent",
          rootID: "22222222-2222-4222-8222-222222222222",
          agent: "review",
        },
      }),
    ).toEqual({
      type: "oxp-request",
      id: 14,
      request: {
        action: "set-worker-default-agent",
        rootID: "22222222-2222-4222-8222-222222222222",
        agent: "review",
      },
    })
    expect(parseSidecarCommand({ type: "oxp-request", id: 0, request: { action: "get-state" } })).toBeUndefined()
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 15,
        request: {
          action: "set-worker-default-model",
          model: {
            providerID: "workbuddy",
            modelID: "deepseek-v4.1-flash",
          },
        },
      }),
    ).toEqual({
      type: "oxp-request",
      id: 15,
      request: {
        action: "set-worker-default-model",
        model: {
          providerID: "workbuddy",
          modelID: "deepseek-v4.1-flash",
        },
      },
    })
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 10,
        request: {
          action: "set-worker-default-model",
          model: {
            providerID: "workbuddy",
            modelID: "deepseek-v4.1-flash",
            apiKey: "must-not-cross",
          },
        },
      }),
    ).toBeUndefined()
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 10,
        request: { action: "set-openai-api-key", value: "shared-secret" },
      }),
    ).toEqual({
      type: "oxp-request",
      id: 10,
      request: { action: "set-openai-api-key", value: "shared-secret" },
    })
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 10,
        request: { action: "set-openai-api-key", value: "x".repeat(16 * 1024 + 1) },
      }),
    ).toBeUndefined()
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 11,
        request: {
          action: "import-legacy-config",
          plan: {
            roots: [{ path: "C:\\repo", alias: "repo" }],
            grant: { read: true, write: false, filesSend: false },
          },
        },
      }),
    ).toEqual({
      type: "oxp-request",
      id: 11,
      request: {
        action: "import-legacy-config",
        plan: {
          roots: [{ path: "C:\\repo", alias: "repo" }],
          grant: { read: true, write: false, filesSend: false },
        },
      },
    })
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 12,
        request: {
          action: "import-legacy-config",
          plan: {
            roots: [{ path: "C:\\repo", alias: "repo", apiKey: "must-not-cross" }],
            grant: { read: true },
          },
        },
      }),
    ).toBeUndefined()
  })

  test("validates privileged sidecar state before main consumes endpoint secrets", () => {
    const value = state()
    expect(isSidecarOxpState(value)).toBe(true)
    expect(isSidecarMessage({ type: "oxp-state", state: value })).toBe(true)
    const trialID = "11111111-1111-4111-8111-111111111111"
    expect(isSidecarMessage({ type: "oxp-runtime-trial", trialID, state: value })).toBe(true)
    expect(isSidecarMessage({ type: "oxp-runtime-trial", trialID: "not-a-uuid", state: value })).toBe(false)
    expect(parseSidecarCommand({ type: "oxp-runtime-accept", trialID })).toEqual({
      type: "oxp-runtime-accept",
      trialID,
    })
    expect(parseSidecarCommand({ type: "oxp-runtime-accept", trialID: "not-a-uuid" })).toBeUndefined()
    expect(isSidecarMessage({ type: "oxp-response", id: 1, ok: true, state: value })).toBe(true)
    expect(
      isSidecarMessage({
        type: "oxp-agent-catalog-response",
        id: 2,
        ok: true,
        catalog: {
          rootID: "22222222-2222-4222-8222-222222222222",
          rootAlias: "project",
          agents: [
            { id: "build", mode: "primary" },
            { id: "review", mode: "all", description: "Review work" },
          ],
          nativeDefaultAgent: "build",
        },
      }),
    ).toBe(true)

    expect(isSidecarMessage({ type: "oxp-state", state: { ...value, grant: { read: true } } })).toBe(false)
    expect(isSidecarOxpState({ ...value, workerPolicy: { models: [], agents: [] } })).toBe(true)
    expect(
      isSidecarOxpState({
        ...value,
        workerPolicy: {
          ...value.workerPolicy,
          agentRoots: [
            {
              rootID: "33333333-3333-4333-8333-333333333333",
              agents: [],
              defaultAgent: "build",
            },
          ],
        },
      }),
    ).toBe(false)
    expect(isSidecarMessage({ type: "oxp-state", state: { ...value, endpoint: { state: "ready", generation: 0 } } })).toBe(false)
    expect(isSidecarOxpState({ ...value, endpoint: { ...value.endpoint, url: `http://example.com:41234/mcp/${"a".repeat(43)}` } })).toBe(false)
    expect(isSidecarOxpState({ ...value, endpoint: { ...value.endpoint, url: `http://127.0.0.1:41234/mcp/${"b".repeat(43)}` } })).toBe(false)
    expect(isSidecarOxpState({ ...value, endpoint: { ...value.endpoint, schemaFingerprint: "not-a-fingerprint" } })).toBe(false)
    expect(isSidecarOxpState({ ...value, endpoint: { state: "stopped", url: value.endpoint.url } })).toBe(false)
    expect(isSidecarOxpState({ ...value, connector: { ...value.connector, id: "connector" } })).toBe(false)
    expect(isSidecarOxpState({ ...value, roots: [{ ...value.roots[0]!, alias: "../escape" }] })).toBe(false)
    expect(isSidecarOxpState({ ...value, roots: [{ ...value.roots[0]!, managedByProject: undefined }] })).toBe(false)
    expect(isSidecarMessage({ type: "oxp-response", id: -1, ok: true, state: value })).toBe(false)
    expect(isSidecarMessage({ type: "oxp-credential-request", id: 7, action: "list" })).toBe(false)
    expect(
      isSidecarMessage({
        type: "oxp-credential-request",
        id: 8,
        action: "resolve",
        credentialRef: "cred_AAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toBe(false)
  })

  test("bounds startup/control strings rather than trusting utility-process payloads structurally", () => {
    expect(
      parseSidecarCommand({
        type: "start",
        hostname: "127.0.0.1",
        port: 4096,
        password: "secret",
        userDataPath: "C:\\Users\\me\\AppData",
      })?.type,
    ).toBe("start")
    expect(
      parseSidecarCommand({
        type: "start",
        hostname: "127.0.0.1",
        port: 70_000,
        password: "secret",
        userDataPath: "C:\\Users\\me\\AppData",
      }),
    ).toBeUndefined()
    expect(
      parseSidecarCommand({
        type: "oxp-request",
        id: 2,
        request: { action: "approve-root", path: "x".repeat(5000) },
      }),
    ).toBeUndefined()
  })
})
