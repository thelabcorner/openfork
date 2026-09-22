import { afterEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  fingerprintRuntimeDirectory,
  recoverAcceptedRuntime,
  RuntimeArtifactStore,
} from "./runtime-artifacts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  )
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-oxp-artifacts-"))
  roots.push(root)
  const runtime = path.join(root, "project", "dist", "node")
  const checkpoint = path.join(root, "checkpoint")
  await fs.mkdir(runtime, { recursive: true })
  await fs.writeFile(path.join(runtime, "node.js"), "node-v1")
  await fs.writeFile(path.join(runtime, "compress-worker.js"), "compress-v1")
  await fs.writeFile(path.join(runtime, "decompress-worker.js"), "decompress-v1")
  await fs.writeFile(path.join(runtime, "runtime-a.wasm"), "wasm-v1")
  await fs.writeFile(path.join(runtime, "node.js.map"), "map-v1")
  await fs.writeFile(path.join(runtime, ".build-stamp"), "stamp-v1")
  const artifact = path.join(runtime, "node.js")
  return {
    root,
    runtime,
    checkpoint,
    artifact,
    artifactUrl: pathToFileURL(artifact).href,
  }
}

describe("OXP runtime artifact checkpoints", () => {
  test("runtime identity covers executable siblings but ignores maps and build metadata", async () => {
    const { runtime } = await fixture()
    const first = await fingerprintRuntimeDirectory(runtime)

    await fs.writeFile(path.join(runtime, "node.js.map"), "map-v2")
    await fs.writeFile(path.join(runtime, ".build-stamp"), "stamp-v2")
    expect(await fingerprintRuntimeDirectory(runtime)).toBe(first)

    await fs.writeFile(path.join(runtime, "compress-worker.js"), "compress-v2")
    expect(await fingerprintRuntimeDirectory(runtime)).not.toBe(first)
  })

  test("startup recovery restores accepted bytes and removes candidate-only runtime assets", async () => {
    const { runtime, checkpoint, artifactUrl } = await fixture()
    const store = await RuntimeArtifactStore.create(artifactUrl, checkpoint)
    const accepted = await store.initializeAccepted()

    await fs.writeFile(path.join(runtime, "node.js"), "candidate")
    await fs.writeFile(path.join(runtime, "compress-worker.js"), "candidate-worker")
    await fs.writeFile(path.join(runtime, "candidate-only.wasm"), "candidate-wasm")
    expect(await store.currentID()).not.toBe(accepted.runtimeID)

    const recovered = await recoverAcceptedRuntime(artifactUrl, checkpoint)
    expect(recovered.runtimeID).toBe(accepted.runtimeID)
    expect(await fs.readFile(path.join(runtime, "node.js"), "utf8")).toBe("node-v1")
    expect(await fs.readFile(path.join(runtime, "compress-worker.js"), "utf8")).toBe("compress-v1")
    await expect(fs.access(path.join(runtime, "candidate-only.wasm"))).rejects.toBeDefined()
    expect(await store.currentID()).toBe(accepted.runtimeID)
  })

  test("checkpoint recovery preserves accepted output mtimes for source freshness checks", async () => {
    const { runtime, checkpoint, artifactUrl } = await fixture()
    const acceptedTime = new Date("2025-01-02T03:04:05.000Z")
    const nodeFile = path.join(runtime, "node.js")
    await fs.utimes(nodeFile, acceptedTime, acceptedTime)

    const store = await RuntimeArtifactStore.create(artifactUrl, checkpoint)
    await store.initializeAccepted()
    await fs.writeFile(nodeFile, "candidate")
    const candidateTime = new Date("2026-01-02T03:04:05.000Z")
    await fs.utimes(nodeFile, candidateTime, candidateTime)

    await recoverAcceptedRuntime(artifactUrl, checkpoint)
    const restored = await fs.stat(nodeFile)
    expect(restored.mtimeMs).toBe(acceptedTime.getTime())
  })

  test("refuses to bootstrap candidate bytes when prior checkpoint state exists but accepted pointer is missing", async () => {
    const { runtime, checkpoint, artifactUrl } = await fixture()
    const store = await RuntimeArtifactStore.create(artifactUrl, checkpoint)
    await store.initializeAccepted()

    await fs.writeFile(path.join(runtime, "node.js"), "unaccepted-candidate")
    await fs.rm(path.join(checkpoint, "accepted.json"), { force: true })

    await expect(
      recoverAcceptedRuntime(artifactUrl, checkpoint),
    ).rejects.toMatchObject({ code: "unavailable" })
    expect(await fs.readFile(path.join(runtime, "node.js"), "utf8")).toBe(
      "unaccepted-candidate",
    )
  })

  test("acceptance advances only the durable pointer and recovery follows the accepted snapshot", async () => {
    const { runtime, checkpoint, artifactUrl } = await fixture()
    const store = await RuntimeArtifactStore.create(artifactUrl, checkpoint)
    const initial = await store.initializeAccepted()

    await fs.writeFile(path.join(runtime, "node.js"), "node-v2")
    await fs.writeFile(path.join(runtime, "decompress-worker.js"), "decompress-v2")
    const candidate = await store.snapshotCurrent()
    expect(candidate.runtimeID).not.toBe(initial.runtimeID)

    await store.accept(candidate.snapshot, candidate.runtimeID)
    await fs.writeFile(path.join(runtime, "node.js"), "unaccepted-v3")
    await recoverAcceptedRuntime(artifactUrl, checkpoint)

    expect(await fs.readFile(path.join(runtime, "node.js"), "utf8")).toBe("node-v2")
    expect(await fs.readFile(path.join(runtime, "decompress-worker.js"), "utf8")).toBe("decompress-v2")
    expect(await store.currentID()).toBe(candidate.runtimeID)
  })

  test("artifact lock is exclusive and owner-scoped", async () => {
    const { checkpoint, artifactUrl } = await fixture()
    const store = await RuntimeArtifactStore.create(artifactUrl, checkpoint)

    await store.acquire("trial-a")
    await expect(store.acquire("trial-b")).rejects.toMatchObject({ code: "busy" })
    await store.release("trial-b")
    await expect(store.acquire("trial-b")).rejects.toMatchObject({ code: "busy" })
    await store.release("trial-a")
    await store.acquire("trial-b")
    await store.release("trial-b")
  })
})
