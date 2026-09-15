import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserDispatchContext } from "../contracts"
import { VisualObservationCoordinator } from "./coordinator"
import type { SnapEyeResult } from "./protocol"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const project = async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-visual-coordinator-"))
  roots.push(root)
  return root
}

const context = (directory: string, overrides: Partial<BrowserDispatchContext> = {}): BrowserDispatchContext => ({
  requestId: "req-1",
  sessionId: "sess-1",
  windowId: "win-1",
  workspaceId: "workspace-1",
  directory,
  messageId: "msg-1",
  toolCallId: "tool-1",
  timeoutMs: 30_000,
  ...overrides,
})

const environment = { engineMajor: 140, appearance: "dark" as const, snapeyeVersion: "0.4.0", snapdomVersion: "3.0.0" }

const captureResult = (runId: string): SnapEyeResult => ({
  schemaVersion: 1,
  protocolVersion: 1,
  runId,
  status: "ok",
  operation: "capture",
  name: "panel",
  image: { coordinateSpace: "target-css-px", cssWidth: 1, cssHeight: 1, pixelWidth: 1, pixelHeight: 1, scale: 1 },
  timing: { captureMs: 1 },
  artifacts: { baseline: "../../baselines/panel.png" },
})

test("capability is bound to request/project/tab/name/run and never exposes a path", async () => {
  const root = await project()
  const coordinator = new VisualObservationCoordinator()
  const grant = await coordinator.begin({
    context: context(root),
    lane: "extension",
    tabId: "42",
    operation: "capture",
    name: "panel",
    runId: "run1",
    environment,
  })
  expect(grant.capability.length).toBeGreaterThanOrEqual(32)
  expect(grant.maxChunkBytes).toBe(384 * 1024)
  expect(grant).not.toHaveProperty("directory")
  expect(grant).not.toHaveProperty("path")
  await expect(coordinator.baselineWriteBegin(grant.capability, "other", {}, 1)).rejects.toMatchObject({ code: "VISUAL_SCOPE_VIOLATION" })
  await expect(coordinator.runWriteBegin(grant.capability, "other-run", "current.svg", 1)).rejects.toMatchObject({ code: "VISUAL_SCOPE_VIOLATION" })
  await expect(coordinator.runWriteBegin(grant.capability, "run1", "current.png", 1)).rejects.toMatchObject({ code: "VISUAL_SCOPE_VIOLATION" })
  await coordinator.abort(grant.capability)
})

test("capture streams a baseline and SVG, enriches metadata, then terminally commits result", async () => {
  const root = await project()
  const coordinator = new VisualObservationCoordinator({ webviewChunkBytes: 3 })
  const grant = await coordinator.begin({
    context: context(root),
    lane: "webview",
    tabId: "tab-web",
    operation: "capture",
    name: "panel",
    runId: "run1",
    environment,
  })

  const baseline = await coordinator.baselineWriteBegin(
    grant.capability,
    "panel",
    { schemaVersion: 1, name: "panel", image: { cssWidth: 1, cssHeight: 1, pixelWidth: 1, pixelHeight: 1, scale: 1 } },
    5,
  )
  await coordinator.writeChunk(grant.capability, baseline.writeId, 0, new Uint8Array([1, 2, 3]))
  await coordinator.writeChunk(grant.capability, baseline.writeId, 3, new Uint8Array([4, 5]))
  await coordinator.writeCommit(grant.capability, baseline.writeId)

  const svg = await coordinator.runWriteBegin(grant.capability, "run1", "current.svg", 4)
  await coordinator.writeChunk(grant.capability, svg.writeId, 0, new TextEncoder().encode("<sv"))
  await coordinator.writeChunk(grant.capability, svg.writeId, 3, new TextEncoder().encode("g"))
  await coordinator.writeCommit(grant.capability, svg.writeId)

  const committed = await coordinator.resultCommit(grant.capability, "run1", captureResult("run1"))
  expect(committed.opencode).toMatchObject({ schemaVersion: 1, lane: "webview", platform: process.platform, engineMajor: 140 })
  expect(coordinator.activeCount).toBe(0)

  const meta = JSON.parse(await readFile(join(root, ".snapeye", "baselines", "panel.json"), "utf8"))
  expect(meta.opencode).toMatchObject({ schemaVersion: 1, lane: "webview", engine: "chromium", engineMajor: 140 })
  await expect(coordinator.writeChunk(grant.capability, svg.writeId, 4, new Uint8Array())).rejects.toMatchObject({ code: "VISUAL_CAPABILITY_INVALID" })
})

test("chunk offsets are strictly sequential and byte budget is enforced before host writes", async () => {
  const root = await project()
  const coordinator = new VisualObservationCoordinator({ webviewChunkBytes: 4, captureByteBudget: 5, maxArtifactBytes: 10 })
  const grant = await coordinator.begin({
    context: context(root),
    lane: "webview",
    tabId: "tab-web",
    operation: "capture",
    name: "panel",
    runId: "run1",
    environment,
  })
  const write = await coordinator.baselineWriteBegin(grant.capability, "panel", { schemaVersion: 1, name: "panel" }, 5)
  await coordinator.writeChunk(grant.capability, write.writeId, 0, new Uint8Array([1, 2, 3]))
  await expect(coordinator.writeChunk(grant.capability, write.writeId, 1, new Uint8Array([4]))).rejects.toMatchObject({ code: "VISUAL_TRANSFER_OFFSET" })
  await coordinator.writeChunk(grant.capability, write.writeId, 3, new Uint8Array([4, 5]))
  await coordinator.writeCommit(grant.capability, write.writeId)
  await expect(coordinator.runWriteBegin(grant.capability, "run1", "current.svg", 1)).rejects.toMatchObject({ code: "VISUAL_BYTE_BUDGET_EXCEEDED" })
  await coordinator.abort(grant.capability)
})

test("diff rejects a known incompatible OpenCode environment", async () => {
  const root = await project()
  // Seed via capture with a fingerprint.
  const capture = new VisualObservationCoordinator()
  const cap = await capture.begin({ context: context(root), lane: "webview", tabId: "a", operation: "capture", name: "panel", runId: "seed", environment })
  const w = await capture.baselineWriteBegin(cap.capability, "panel", { schemaVersion: 1, name: "panel" }, 3)
  await capture.writeChunk(cap.capability, w.writeId, 0, new Uint8Array([1, 2, 3]))
  await capture.writeCommit(cap.capability, w.writeId)
  await capture.resultCommit(cap.capability, "seed", captureResult("seed"))

  const diff = new VisualObservationCoordinator()
  const incompatible = await diff.begin({
    context: context(root, { requestId: "req-diff" }),
    lane: "extension",
    tabId: "99",
    operation: "diff",
    name: "panel",
    runId: "run-diff",
    environment: { ...environment, engineMajor: 141 },
  })
  await expect(diff.baselineReadOpen(incompatible.capability, "panel")).rejects.toMatchObject({ code: "VISUAL_ENVIRONMENT_MISMATCH" })
  await diff.abort(incompatible.capability)
})

test("redaction policy is baseline identity: canonical equivalents pass and semantic changes fail", async () => {
  const root = await project()
  const capture = new VisualObservationCoordinator()
  const cap = await capture.begin({
    context: context(root, { requestId: "req-redact-capture" }),
    lane: "webview",
    tabId: "a",
    operation: "capture",
    name: "panel",
    runId: "redact-seed",
    redaction: {
      blocks: [".secret", "#token"],
      attributes: [{ selector: "input", names: ["VALUE", "data-secret"] }],
    },
    environment,
  })
  const writer = await capture.baselineWriteBegin(cap.capability, "panel", { schemaVersion: 1, name: "panel" }, 3)
  await capture.writeChunk(cap.capability, writer.writeId, 0, new Uint8Array([1, 2, 3]))
  await capture.writeCommit(cap.capability, writer.writeId)
  await capture.resultCommit(cap.capability, "redact-seed", captureResult("redact-seed"))

  const equivalent = new VisualObservationCoordinator()
  const same = await equivalent.begin({
    context: context(root, { requestId: "req-redact-same" }),
    lane: "webview",
    tabId: "a",
    operation: "diff",
    name: "panel",
    runId: "redact-same",
    redaction: {
      blocks: ["#token", ".secret", ".secret"],
      attributes: [{ selector: "input", names: ["data-secret", "value"] }],
    },
    environment,
  })
  const opened = await equivalent.baselineReadOpen(same.capability, "panel")
  expect(opened).not.toBeNull()
  if (opened) await equivalent.baselineReadClose(same.capability, opened.readId)
  await equivalent.abort(same.capability)

  const changed = new VisualObservationCoordinator()
  const mismatch = await changed.begin({
    context: context(root, { requestId: "req-redact-changed" }),
    lane: "webview",
    tabId: "a",
    operation: "diff",
    name: "panel",
    runId: "redact-changed",
    redaction: { blocks: [".different-secret"] },
    environment,
  })
  await expect(changed.baselineReadOpen(mismatch.capability, "panel")).rejects.toMatchObject({
    code: "VISUAL_ENVIRONMENT_MISMATCH",
  })
  await changed.abort(mismatch.capability)
})

test("abort signal revokes capability and removes an unfinished transfer", async () => {
  const root = await project()
  const abort = new AbortController()
  const coordinator = new VisualObservationCoordinator({ webviewChunkBytes: 4 })
  const grant = await coordinator.begin({
    context: context(root, { signal: abort.signal }),
    lane: "webview",
    tabId: "a",
    operation: "capture",
    name: "panel",
    runId: "run1",
    environment,
  })
  const writer = await coordinator.baselineWriteBegin(grant.capability, "panel", { schemaVersion: 1, name: "panel" }, 4)
  await coordinator.writeChunk(grant.capability, writer.writeId, 0, new Uint8Array([1, 2]))
  abort.abort()
  for (let i = 0; i < 20 && coordinator.activeCount !== 0; i++) await Bun.sleep(1)
  expect(coordinator.activeCount).toBe(0)
  await expect(coordinator.writeChunk(grant.capability, writer.writeId, 2, new Uint8Array([3, 4]))).rejects.toMatchObject({ code: "VISUAL_CAPABILITY_INVALID" })
  await expect(readFile(join(root, ".snapeye", "baselines", "panel.png"))).rejects.toMatchObject({ code: "ENOENT" })
})

test("capability expiry is terminal and asynchronously aborts unfinished temp state", async () => {
  const root = await project()
  let now = 1_000
  const coordinator = new VisualObservationCoordinator({ now: () => now, webviewChunkBytes: 4 })
  const grant = await coordinator.begin({
    context: context(root, { requestId: "req-expire", timeoutMs: 10 }),
    lane: "webview",
    tabId: "expire-tab",
    operation: "capture",
    name: "panel",
    runId: "expire-run",
    environment,
  })
  const writer = await coordinator.baselineWriteBegin(grant.capability, "panel", { schemaVersion: 1, name: "panel" }, 4)
  await coordinator.writeChunk(grant.capability, writer.writeId, 0, new Uint8Array([1, 2]))
  now = 1_011
  await expect(coordinator.writeChunk(grant.capability, writer.writeId, 2, new Uint8Array([3, 4]))).rejects.toMatchObject({
    code: "VISUAL_CAPABILITY_EXPIRED",
  })
  for (let index = 0; index < 50 && coordinator.activeCount !== 0; index++) await Bun.sleep(1)
  expect(coordinator.activeCount).toBe(0)
  expect(await readFile(join(root, ".snapeye", "baselines", "panel.png")).catch(() => null)).toBeNull()
  expect((await readdir(join(root, ".snapeye", "baselines"))).some((name) => name.endsWith(".tmp"))).toBe(false)
})

test("coordinator stop models Desktop shutdown: active transfers are aborted and a fresh coordinator can reuse the project", async () => {
  const root = await project()
  const first = new VisualObservationCoordinator({ webviewChunkBytes: 4 })
  const grant = await first.begin({
    context: context(root, { requestId: "req-shutdown" }),
    lane: "webview",
    tabId: "shutdown-tab",
    operation: "capture",
    name: "panel",
    runId: "shutdown-run",
    environment,
  })
  const writer = await first.baselineWriteBegin(grant.capability, "panel", { schemaVersion: 1, name: "panel" }, 4)
  await first.writeChunk(grant.capability, writer.writeId, 0, new Uint8Array([1, 2]))
  await first.stop()
  expect(first.activeCount).toBe(0)
  expect(await readFile(join(root, ".snapeye", "baselines", "panel.png")).catch(() => null)).toBeNull()
  expect((await readdir(join(root, ".snapeye", "baselines"))).some((name) => name.endsWith(".tmp"))).toBe(false)

  const restarted = new VisualObservationCoordinator()
  const next = await restarted.begin({
    context: context(root, { requestId: "req-after-restart" }),
    lane: "webview",
    tabId: "restart-tab",
    operation: "capture",
    name: "panel",
    runId: "restart-run",
    environment,
  })
  const nextWriter = await restarted.baselineWriteBegin(next.capability, "panel", { schemaVersion: 1, name: "panel" }, 3)
  await restarted.writeChunk(next.capability, nextWriter.writeId, 0, new Uint8Array([7, 8, 9]))
  await restarted.writeCommit(next.capability, nextWriter.writeId)
  await restarted.resultCommit(next.capability, "restart-run", captureResult("restart-run"))
  expect(await readFile(join(root, ".snapeye", "baselines", "panel.png"))).toEqual(Buffer.from([7, 8, 9]))
})

test("missing project provenance and duplicate request ownership fail closed", async () => {
  const root = await project()
  const coordinator = new VisualObservationCoordinator()
  await expect(
    coordinator.begin({ context: context(root, { directory: undefined }), lane: "webview", tabId: "a", operation: "capture", name: "panel", environment }),
  ).rejects.toMatchObject({ code: "VISUAL_CONTEXT_REQUIRED" })
  const grant = await coordinator.begin({ context: context(root), lane: "webview", tabId: "a", operation: "capture", name: "panel", environment })
  await expect(
    coordinator.begin({ context: context(root), lane: "webview", tabId: "b", operation: "capture", name: "panel2", environment }),
  ).rejects.toMatchObject({ code: "VISUAL_SCOPE_VIOLATION" })
  await coordinator.abort(grant.capability)
})

test("project-scoped history and artifact inspection use trusted directory context without minting capabilities", async () => {
  const root = await project()
  const coordinator = new VisualObservationCoordinator()
  const grant = await coordinator.begin({
    context: context(root, { requestId: "req-seed" }),
    lane: "webview",
    tabId: "tab-web",
    operation: "capture",
    name: "panel",
    runId: "run-history",
    environment,
  })
  const baseline = await coordinator.baselineWriteBegin(grant.capability, "panel", { schemaVersion: 1, name: "panel" }, 3)
  await coordinator.writeChunk(grant.capability, baseline.writeId, 0, new Uint8Array([1, 2, 3]))
  await coordinator.writeCommit(grant.capability, baseline.writeId)
  await coordinator.resultCommit(grant.capability, "run-history", captureResult("run-history"))

  const inspect = context(root, { requestId: "req-inspect" })
  const history = await coordinator.history(inspect, { maxRuns: 5, maxBaselines: 5 })
  expect(history.root).toBe(".snapeye")
  expect(history.baselines[0]?.imagePath).toBe(".snapeye/baselines/panel.png")
  expect(history.runs[0]?.runId).toBe("run-history")
  expect(coordinator.activeCount).toBe(0)

  const artifact = await coordinator.artifact(inspect, { source: "baseline", name: "panel" })
  expect(artifact).toMatchObject({ kind: "baseline", path: ".snapeye/baselines/panel.png", mime: "image/png", byteLength: 3 })
  await expect(coordinator.history(context(root, { requestId: "missing-dir", directory: undefined }))).rejects.toMatchObject({ code: "VISUAL_CONTEXT_REQUIRED" })
})
