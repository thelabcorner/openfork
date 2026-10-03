import { afterEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  RuntimeRefreshCoordinator,
  type RuntimeBackendModule,
  type RuntimeBackendTransition,
  type RuntimeRefreshControl,
} from "./runtime-refresh"
import type { SidecarOxpState } from "../sidecar-protocol"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  )
})

function state(
  fingerprint: string,
  port: number,
): SidecarOxpState {
  const token = "a".repeat(43)
  return {
    version: 1,
    enabled: true,
    connector: {
      id: "00000000-0000-4000-8000-000000000001",
      label: "OpenFork OXP",
    },
    configRevision: 4,
    roots: [],
    grant: {
      read: true,
      write: true,
      process: true,
      git: true,
      integrations: true,
      browser: true,
      filesReceive: true,
      filesSend: true,
      automation: true,
      sessionSupervision: "approved-roots",
      requestSupervision: true,
      delegation: "spawn",
      nestedDelegation: true,
    },
    endpoint: {
      state: "ready",
      generation: 1,
      schemaFingerprint: fingerprint,
      url: `http://127.0.0.1:${port}/mcp/${token}`,
      metadataUrl: `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp/${token}`,
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

function fakeModule(
  artifact: string,
  endpoint: SidecarOxpState,
  options: {
    restoreError?: Error
    restoreErrors?: readonly (Error | undefined)[]
    disposeError?: Error
    protocolVersion?: number
  } = {},
) {
  let control: RuntimeRefreshControl | undefined
  const counters = {
    restore: 0,
    dispose: 0,
  }
  const returnState = async () => endpoint
  const module: RuntimeBackendModule = {
    runtimeModuleUrl: pathToFileURL(artifact).href,
    OxpRuntimeRefresh: {
      PROTOCOL_VERSION: options.protocolVersion ?? 2,
      install(next) {
        control = next
      },
    },
    OxpHost: {
      getState: returnState,
      async restore() {
        counters.restore += 1
        const restoreError =
          options.restoreErrors?.[counters.restore - 1] ?? options.restoreError
        if (restoreError) throw restoreError
        return endpoint
      },
      async dispose() {
        counters.dispose += 1
        if (options.disposeError) throw options.disposeError
      },
      start: returnState,
      stop: returnState,
      revoke: returnState,
      setEnabled: returnState,
      setGrant: returnState,
      setWorkerDefaultModel: returnState,
      async listWorkerAgents(rootID) {
        return {
          rootID,
          rootAlias: "test",
          agents: [],
          nativeDefaultAgent: "build",
        }
      },
      setWorkerDefaultAgent: returnState,
      approveRoot: returnState,
      syncProjectRoots: returnState,
      renameRoot: returnState,
      removeRoot: returnState,
      async setOpenAiApiKey() {},
      importLegacyConfig: returnState,
    },
  }
  return {
    module,
    counters,
    control: () => control,
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-oxp-refresh-"))
  roots.push(root)
  const dist = path.join(root, "dist", "node")
  await fs.mkdir(dist, { recursive: true })
  const artifact = path.join(dist, "node.js")
  await fs.writeFile(artifact, "old-runtime")
  return { root, artifact }
}

function artifactOptions(root: string, artifact: string) {
  return {
    artifactUrl: pathToFileURL(artifact).href,
    checkpointRoot: path.join(root, "checkpoint"),
  }
}

function backendTransition(initial: RuntimeBackendModule, events: string[] = []) {
  let current: RuntimeBackendModule | undefined = initial
  const names = new Map<RuntimeBackendModule, string>()
  const api: RuntimeBackendTransition & {
    readonly name: (module: RuntimeBackendModule, name: string) => void
  } = {
    current: () => current,
    name(module, name) {
      names.set(module, name)
    },
    async transition(from, to) {
      expect(current).toBe(from)
      events.push(`${names.get(from) ?? "unknown"}->${names.get(to) ?? "unknown"}`)
      current = to
    },
  }
  return api
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime transition")
    await Bun.sleep(5)
  }
}

async function exists(filepath: string) {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

describe("OXP transactional runtime refresh coordinator", () => {
  test("moves the ordinary HTTP backend only after candidate OXP readiness passes", async () => {
    const { root, artifact } = await fixture()
    const events: string[] = []
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const transition = backendTransition(previous.module, events)
    transition.name(previous.module, "previous")
    transition.name(candidate.module, "candidate")
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => events.push("publish"),
      probe: async (next) => {
        events.push(`probe:${next.endpoint.schemaFingerprint?.slice(0, 1)}`)
      },
      backendTransition: transition,
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 200,
    })
    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => coordinator.status().trial?.phase === "active")

    expect(transition.current()).toBe(candidate.module)
    expect(events).toEqual(["probe:2", "previous->candidate", "publish"])
    await coordinator.acceptFromHost(staged.status.trial!.id)
    await coordinator.dispose()
  })

  test("never moves the ordinary HTTP backend when candidate OXP readiness fails", async () => {
    const { root, artifact } = await fixture()
    const events: string[] = []
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const transition = backendTransition(previous.module, events)
    transition.name(previous.module, "previous")
    transition.name(candidate.module, "candidate")
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async (next) => {
        if (next.endpoint.schemaFingerprint === "2".repeat(64)) throw new Error("candidate not ready")
      },
      backendTransition: transition,
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 100,
    })
    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => coordinator.status().state === "stable")

    expect(transition.current()).toBe(previous.module)
    expect(events).toEqual([])
    expect(coordinator.status().runtimeID).toBe(previousID)
    await coordinator.dispose()
  })

  test("restores previous runtime truth when HTTP candidate activation rejects but restores its source", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    let current: RuntimeBackendModule | undefined = previous.module
    let candidatePublished = false
    const transition: RuntimeBackendTransition = {
      current: () => current,
      async transition(from, to) {
        expect(from).toBe(previous.module)
        expect(to).toBe(candidate.module)
        current = previous.module
        throw new Error("candidate HTTP activation failed")
      },
    }
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: (next) => {
        if (next.endpoint.schemaFingerprint === "2".repeat(64)) candidatePublished = true
      },
      probe: async () => {},
      backendTransition: transition,
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 100,
    })
    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => coordinator.status().state === "stable")

    expect(candidatePublished).toBe(false)
    expect(current).toBe(previous.module)
    expect(coordinator.status()).toMatchObject({
      state: "stable",
      runtimeID: previousID,
      lastTransition: { trialID: staged.status.trial!.id, outcome: "failed" },
    })
    await coordinator.dispose()
  })

  test("reports degraded truth when the HTTP owner loses both candidate and previous listeners", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    let current: RuntimeBackendModule | undefined = previous.module
    const transition: RuntimeBackendTransition = {
      current: () => current,
      async transition() {
        current = undefined
        throw new AggregateError(
          [new Error("candidate failed"), new Error("previous failed")],
          "HTTP backend unavailable",
        )
      },
    }
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      backendTransition: transition,
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 100,
    })
    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => coordinator.status().state === "degraded")

    expect(current).toBeUndefined()
    expect(coordinator.status()).toMatchObject({
      state: "degraded",
      refreshable: false,
      lastTransition: { trialID: staged.status.trial!.id, outcome: "failed" },
    })
    expect(coordinator.status().runtimeID).toBeUndefined()
    await expect(coordinator.host.getState()).rejects.toMatchObject({
      code: "OXP_DEPENDENCY_UNAVAILABLE",
    })
    await coordinator.dispose()
  })

  test("moves the ordinary HTTP backend back when an active candidate rolls back", async () => {
    const { root, artifact } = await fixture()
    const events: string[] = []
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const transition = backendTransition(previous.module, events)
    transition.name(previous.module, "previous")
    transition.name(candidate.module, "candidate")
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      backendTransition: transition,
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 30,
    })
    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => coordinator.status().trial?.phase === "active")
    await waitFor(() => coordinator.status().state === "stable")

    expect(transition.current()).toBe(previous.module)
    expect(events).toEqual(["previous->candidate", "candidate->previous"])
    expect(coordinator.status().runtimeID).toBe(previousID)
    await coordinator.dispose()
  })

  test("uses artifact content as runtime identity and no-ops when the built artifact is unchanged", async () => {
    const { root, artifact } = await fixture()
    const initial = fakeModule(artifact, state("1".repeat(64), 31001))
    let imports = 0
    const coordinator = await RuntimeRefreshCoordinator.create(initial.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      importModule: async () => {
        imports += 1
        return initial.module
      },
    })

    const before = coordinator.status()
    expect(before.refreshable).toBe(true)
    expect(before.runtimeID).toMatch(/^sha256:[a-f0-9]{64}$/)

    const result = await initial.control()!.refresh({
      expectedRuntimeID: before.runtimeID!,
      acceptWithinMs: 100,
    })
    expect(result.changed).toBe(false)
    expect(result.status.lastTransition?.outcome).toBe("unchanged")
    expect(imports).toBe(0)

    await coordinator.dispose()
  })

  test("returns the scheduled trial before activation, then requires acceptance from the candidate", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const published: SidecarOxpState[] = []
    let importedUrl = ""

    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: (next) => published.push(next),
      probe: async () => {},
      activationDelayMs: 25,
      importModule: async (url) => {
        importedUrl = url
        return candidate.module
      },
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 200,
    })
    expect(staged.changed).toBe(true)
    expect(staged.status.state).toBe("scheduled")
    expect(candidate.counters.restore).toBe(0)
    expect(importedUrl).toContain("oxp-runtime-trial=")

    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => candidate.counters.restore === 1)
    expect(coordinator.status()).toMatchObject({
      state: "trial",
      runtimeID: staged.status.trial?.candidateRuntimeID,
      trial: {
        id: staged.status.trial?.id,
        phase: "active",
        previousRuntimeID: previousID,
      },
    })
    expect(previous.counters.dispose).toBe(1)
    expect(published).toHaveLength(1)

    await expect(
      previous.control()!.accept(staged.status.trial!.id),
    ).rejects.toMatchObject({ code: "OXP_HANDLE_STALE" })

    const accepted = await candidate.control()!.accept(staged.status.trial!.id)
    expect(accepted.status.state).toBe("stable")
    expect(accepted.status.lastTransition?.outcome).toBe("accepted")
    await Bun.sleep(225)
    expect(previous.counters.restore).toBe(0)

    await coordinator.dispose()
  })

  test("accepts an active candidate through the private trusted-host acknowledgment path", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const publications: Array<{ state: SidecarOxpState; trialID?: string }> = []

    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: (next, publication) =>
        publications.push({
          state: next,
          ...(publication?.trialID ? { trialID: publication.trialID } : {}),
        }),
      probe: async () => {},
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 200,
    })
    const trialID = staged.status.trial!.id
    await previous.control()!.arm(trialID)
    await waitFor(() => coordinator.status().trial?.phase === "active")

    expect(publications).toHaveLength(1)
    expect(publications[0]).toMatchObject({
      trialID,
      state: { endpoint: { schemaFingerprint: "2".repeat(64) } },
    })

    const accepted = await coordinator.acceptFromHost(trialID)
    expect(accepted.status).toMatchObject({
      state: "stable",
      runtimeID: staged.status.trial?.candidateRuntimeID,
      lastTransition: { trialID, outcome: "accepted" },
    })
    await Bun.sleep(225)
    expect(previous.counters.restore).toBe(0)

    await expect(coordinator.acceptFromHost(trialID)).rejects.toMatchObject({
      code: "OXP_HANDLE_STALE",
    })

    await coordinator.dispose()
  })

  test("cancelling a scheduled trial restores accepted artifact bytes before activation", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      activationDelayMs: 1_000,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 200,
    })
    expect(await fs.readFile(artifact, "utf8")).toBe("candidate-runtime")

    const rolledBack = await previous.control()!.rollback(staged.status.trial!.id)
    expect(rolledBack.status).toMatchObject({
      state: "stable",
      runtimeID: previousID,
      lastTransition: { outcome: "reverted" },
    })
    expect(await fs.readFile(artifact, "utf8")).toBe("old-runtime")
    expect(candidate.counters.restore).toBe(0)

    await coordinator.dispose()
  })

  test("expires an unarmed v2 trial without ever replacing the live endpoint", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      armWithinMs: 20,
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 200,
    })
    expect(staged.status.state).toBe("scheduled")
    expect(candidate.counters.restore).toBe(0)
    expect(previous.counters.dispose).toBe(0)

    await waitFor(() => coordinator.status().state === "stable")
    expect(coordinator.status()).toMatchObject({
      state: "stable",
      runtimeID: previousID,
      lastTransition: {
        trialID: staged.status.trial?.id,
        outcome: "reverted",
        detail: "Refresh trial expired before the scheduling response completed.",
      },
    })
    expect(candidate.counters.restore).toBe(0)
    expect(previous.counters.dispose).toBe(0)
    expect(previous.counters.restore).toBe(0)
    expect(await fs.readFile(artifact, "utf8")).toBe("old-runtime")

    await coordinator.dispose()
  })

  test("lets a legacy v1 accepted runtime cross the response-arm protocol boundary once", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(
      artifact,
      state("1".repeat(64), 31001),
      { protocolVersion: 1 },
    )
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      activationDelayMs: 1,
      legacyResponseEgressDelayMs: 15,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 200,
    })
    expect(staged.status.state).toBe("scheduled")
    expect(candidate.counters.restore).toBe(0)

    // v1 has no post-response arm hook. The coordinator's compatibility bridge
    // activates only after its conservative egress delay.
    await waitFor(() => coordinator.status().trial?.phase === "active")
    expect(candidate.counters.restore).toBe(1)
    const trialID = staged.status.trial!.id
    const accepted = await coordinator.acceptFromHost(trialID)
    expect(accepted.status).toMatchObject({
      state: "stable",
      runtimeID: staged.status.trial?.candidateRuntimeID,
      lastTransition: { trialID, outcome: "accepted" },
    })

    await coordinator.dispose()
  })

  test("automatically restores the previous runtime when the candidate is not accepted", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const published: SidecarOxpState[] = []

    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: (next) => published.push(next),
      probe: async () => {},
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 30,
    })
    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => candidate.counters.restore === 1)
    await waitFor(() => previous.counters.restore === 1)
    await waitFor(() => coordinator.status().state === "stable")

    expect(coordinator.status()).toMatchObject({
      state: "stable",
      runtimeID: previousID,
      lastTransition: {
        trialID: staged.status.trial?.id,
        outcome: "reverted",
      },
    })
    expect(candidate.counters.dispose).toBeGreaterThanOrEqual(1)
    expect(published).toHaveLength(2)
    expect(published[0]!.endpoint.url).toContain(":31002/")
    expect(published[1]!.endpoint.url).toContain(":31001/")

    await coordinator.dispose()
  })

  test("never publishes a candidate that fails its readiness probe", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const published: SidecarOxpState[] = []

    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: (next) => published.push(next),
      probe: async (next) => {
        if (next.endpoint.schemaFingerprint === "2".repeat(64)) {
          throw new Error("candidate probe rejected")
        }
      },
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 100,
    })
    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => coordinator.status().state === "stable")

    expect(coordinator.status()).toMatchObject({
      state: "stable",
      runtimeID: previousID,
      lastTransition: { outcome: "failed" },
    })
    expect(previous.counters.restore).toBe(1)
    expect(published).toHaveLength(1)
    expect(published[0]!.endpoint.url).toContain(":31001/")

    await coordinator.dispose()
  })

  test("releases the lock and reports degraded truth when candidate and previous restoration both fail", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(
      artifact,
      state("1".repeat(64), 31001),
      { restoreError: new Error("previous restore failed") },
    )
    const candidate = fakeModule(
      artifact,
      state("2".repeat(64), 31002),
      { restoreError: new Error("candidate restore failed") },
    )
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 50,
    })
    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => coordinator.status().state === "degraded")

    expect(coordinator.status()).toMatchObject({
      state: "degraded",
      refreshable: false,
      lastTransition: {
        trialID: staged.status.trial?.id,
        outcome: "failed",
      },
    })
    expect(coordinator.status().runtimeID).toBeUndefined()
    expect(coordinator.status().trial).toBeUndefined()
    await expect(coordinator.host.getState()).rejects.toMatchObject({
      code: "OXP_DEPENDENCY_UNAVAILABLE",
    })
    expect(
      await exists(path.join(root, "dist", "node", ".oxp-runtime-refresh.lock")),
    ).toBe(false)
    await expect(
      previous.control()!.refresh({
        expectedRuntimeID: previousID,
        acceptWithinMs: 50,
      }),
    ).rejects.toMatchObject({ code: "OXP_DEPENDENCY_UNAVAILABLE" })

    await coordinator.dispose()
  })

  test("bounds a failed rollback after restoring the candidate and suppresses retry livelock", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(
      artifact,
      state("1".repeat(64), 31001),
      { restoreError: new Error("previous restore failed") },
    )
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 40,
    })
    const trialID = staged.status.trial!.id
    await previous.control()!.arm(trialID)
    await waitFor(() => coordinator.status().trial?.phase === "active")

    await expect(candidate.control()!.rollback(trialID)).rejects.toMatchObject({
      code: "OXP_DEPENDENCY_UNAVAILABLE",
    })
    expect(candidate.counters.restore).toBe(2)
    expect(coordinator.status()).toMatchObject({
      state: "trial",
      runtimeID: staged.status.trial?.candidateRuntimeID,
      trial: { id: trialID, phase: "active" },
    })
    expect(coordinator.status().trial?.acceptBy).toBeGreaterThan(Date.now())

    await expect(candidate.control()!.rollback(trialID)).rejects.toMatchObject({
      code: "OXP_DEPENDENCY_UNAVAILABLE",
    })
    expect(candidate.counters.restore).toBe(2)

    await waitFor(() => coordinator.status().state === "degraded")
    expect(coordinator.status().runtimeID).toBeUndefined()
    expect(coordinator.status().trial).toBeUndefined()
    expect(
      await exists(path.join(root, "dist", "node", ".oxp-runtime-refresh.lock")),
    ).toBe(false)

    await coordinator.dispose()
  })

  test("does not claim the candidate or leak the lock when rollback recovery also fails", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(
      artifact,
      state("1".repeat(64), 31001),
      { restoreError: new Error("previous restore failed") },
    )
    const candidate = fakeModule(
      artifact,
      state("2".repeat(64), 31002),
      { restoreErrors: [undefined, new Error("candidate re-restore failed")] },
    )
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 100,
    })
    const trialID = staged.status.trial!.id
    await previous.control()!.arm(trialID)
    await waitFor(() => coordinator.status().trial?.phase === "active")

    await expect(candidate.control()!.rollback(trialID)).rejects.toThrow()
    expect(coordinator.status()).toMatchObject({
      state: "degraded",
      refreshable: false,
      lastTransition: { trialID, outcome: "failed" },
    })
    expect(coordinator.status().runtimeID).toBeUndefined()
    expect(
      await exists(path.join(root, "dist", "node", ".oxp-runtime-refresh.lock")),
    ).toBe(false)

    await coordinator.dispose()
  })

  test("retires candidate authority and releases the lock when candidate disposal fails", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(
      artifact,
      state("2".repeat(64), 31002),
      { disposeError: new Error("candidate dispose failed") },
    )
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 100,
    })
    const trialID = staged.status.trial!.id
    await previous.control()!.arm(trialID)
    await waitFor(() => coordinator.status().trial?.phase === "active")

    await expect(candidate.control()!.rollback(trialID)).rejects.toThrow(
      "candidate dispose failed",
    )
    expect(candidate.control()).toBeUndefined()
    expect(coordinator.status()).toMatchObject({
      state: "degraded",
      refreshable: false,
      lastTransition: { trialID, outcome: "failed" },
    })
    expect(coordinator.status().runtimeID).toBeUndefined()
    expect(coordinator.status().trial).toBeUndefined()
    expect(
      await exists(path.join(root, "dist", "node", ".oxp-runtime-refresh.lock")),
    ).toBe(false)

    await coordinator.dispose()
  })

  test("keeps restored serving identity truthful when previous-runtime publication fails", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: (next) => {
        if (next.endpoint.schemaFingerprint === "1".repeat(64)) {
          throw new Error("previous publication failed")
        }
      },
      probe: async (next) => {
        if (next.endpoint.schemaFingerprint === "2".repeat(64)) {
          throw new Error("candidate probe rejected")
        }
      },
      activationDelayMs: 5,
      importModule: async () => candidate.module,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    const staged = await previous.control()!.refresh({
      expectedRuntimeID: previousID,
      acceptWithinMs: 100,
    })
    await previous.control()!.arm(staged.status.trial!.id)
    await waitFor(() => coordinator.status().state === "stable")

    expect(coordinator.status()).toMatchObject({
      state: "stable",
      runtimeID: previousID,
      refreshable: true,
      lastTransition: {
        trialID: staged.status.trial?.id,
        outcome: "failed",
      },
    })
    expect(coordinator.status().lastTransition?.detail).toContain(
      "previous runtime was restored",
    )
    expect(coordinator.status().trial).toBeUndefined()
    expect(
      await exists(path.join(root, "dist", "node", ".oxp-runtime-refresh.lock")),
    ).toBe(false)

    await coordinator.dispose()
  })

  test("rejects a hot-refresh candidate that omits the current host control ABI", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    const candidate = fakeModule(artifact, state("2".repeat(64), 31002))
    const {
      listWorkerAgents: _listWorkerAgents,
      ...legacyHost
    } = candidate.module.OxpHost
    const incompleteCandidate = {
      ...candidate.module,
      OxpHost: legacyHost,
    }
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      importModule: async () => incompleteCandidate,
    })
    const previousID = coordinator.status().runtimeID!
    await fs.writeFile(artifact, "candidate-runtime")

    await expect(
      previous.control()!.refresh({
        expectedRuntimeID: previousID,
        acceptWithinMs: 100,
      }),
    ).rejects.toMatchObject({ code: "OXP_DEPENDENCY_UNAVAILABLE" })
    expect(coordinator.status()).toMatchObject({
      state: "stable",
      runtimeID: previousID,
    })
    expect(coordinator.status().trial).toBeUndefined()
    expect(
      await exists(path.join(root, "dist", "node", ".oxp-runtime-refresh.lock")),
    ).toBe(false)

    await coordinator.dispose()
  })

  test("fails stale compare-and-swap refreshes before importing a candidate", async () => {
    const { root, artifact } = await fixture()
    const previous = fakeModule(artifact, state("1".repeat(64), 31001))
    let imports = 0
    const coordinator = await RuntimeRefreshCoordinator.create(previous.module, {
      ...artifactOptions(root, artifact),
      publish: () => {},
      probe: async () => {},
      importModule: async () => {
        imports += 1
        return previous.module
      },
    })
    await fs.writeFile(artifact, "candidate-runtime")

    await expect(
      previous.control()!.refresh({
        expectedRuntimeID: `sha256:${"f".repeat(64)}`,
        acceptWithinMs: 100,
      }),
    ).rejects.toMatchObject({ code: "OXP_CONFLICT" })
    expect(imports).toBe(0)

    await coordinator.dispose()
  })
})
