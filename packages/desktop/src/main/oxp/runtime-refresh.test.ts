import { afterEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  RuntimeRefreshCoordinator,
  type RuntimeBackendModule,
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
  options: { restoreError?: Error } = {},
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
      install(next) {
        control = next
      },
    },
    OxpHost: {
      getState: returnState,
      async restore() {
        counters.restore += 1
        if (options.restoreError) throw options.restoreError
        return endpoint
      },
      async dispose() {
        counters.dispose += 1
      },
      start: returnState,
      stop: returnState,
      revoke: returnState,
      setEnabled: returnState,
      setGrant: returnState,
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

describe("OXP transactional runtime refresh coordinator", () => {
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
    await waitFor(() => candidate.counters.restore === 1)
    await waitFor(() => previous.counters.restore === 1)

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
    await waitFor(
      () => coordinator.status().lastTransition?.trialID === staged.status.trial?.id,
    )

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
