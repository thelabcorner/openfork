import { afterEach, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCodeSnapEyeStore } from "./store"
import {
  SNAPEYE_ARTIFACTS,
  VisualArtifactError,
  generateSnapEyeRunId,
  isValidSnapEyeFilename,
  isValidSnapEyeName,
  isValidSnapEyeRunId,
  type SnapEyeResult,
} from "./protocol"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const project = async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-snapeye-"))
  roots.push(root)
  return root
}

const result = (runId: string): SnapEyeResult => ({
  schemaVersion: 1,
  protocolVersion: 1,
  runId,
  status: "ok",
  operation: "diff",
  name: "panel",
  diff: { changed: false, changedRatio: 0, regionCount: 0, regionsTruncated: false, regions: [] },
})

test("identifier validation exactly rejects traversal/control/path segments", () => {
  expect(isValidSnapEyeRunId("run_ABC-123")).toBe(true)
  expect(isValidSnapEyeName("header.desktop-v2")).toBe(true)
  expect(isValidSnapEyeFilename("current.png")).toBe(true)
  for (const bad of ["", ".", "..", "a..b", "../x", "a/b", "a\\b", "\u0000x", "x".repeat(65)]) {
    expect(isValidSnapEyeRunId(bad)).toBe(false)
  }
  expect(isValidSnapEyeName(".hidden")).toBe(false)
  expect(isValidSnapEyeFilename("file.tmp")).toBe(false)
  expect(generateSnapEyeRunId(1, () => 0)).toMatch(/^r[A-Za-z0-9_-]{15}$/)
})

test("layout preserves existing gitignore content and adds only ephemeral run entries", async () => {
  const root = await project()
  const snapeye = join(root, ".snapeye")
  await Bun.write(join(snapeye, ".gitignore"), "custom.log\n")
  await OpenCodeSnapEyeStore.create(root)
  const text = await readFile(join(snapeye, ".gitignore"), "utf8")
  expect(text).toContain("custom.log\n")
  expect(text.match(/^runs\/$/gm)?.length).toBe(1)
  expect(text.match(/^\*\.tmp$/gm)?.length).toBe(1)
  expect(text).not.toContain("baselines/")
})

test("baseline write/read is SnapEye-compatible and integrity-bound", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  const image = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])
  const meta = { schemaVersion: 1, name: "panel", capturedAt: new Date(0).toISOString(), image: { pixelWidth: 1 } }
  await store.writeBaseline("panel", { image, meta })
  const stored = await store.readBaseline("panel")
  expect(Buffer.from(stored?.image as Uint8Array)).toEqual(Buffer.from(image))
  expect(stored?.meta).toEqual(meta)

  const rawMeta = JSON.parse(await readFile(join(root, ".snapeye", "baselines", "panel.json"), "utf8"))
  expect(rawMeta.__snapeyeBaselineCommit).toMatchObject({
    format: "snapeye-baseline-v1",
    state: "committed",
    image: { algorithm: "sha256", byteLength: image.byteLength },
  })
})

test("tampered baseline bytes fail closed instead of producing a misleading diff", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  await store.writeBaseline("panel", { image: new Uint8Array([1, 2, 3]), meta: { schemaVersion: 1, name: "panel" } })
  await writeFile(join(root, ".snapeye", "baselines", "panel.png"), new Uint8Array([9, 9, 9]))
  await expect(store.readBaseline("panel")).rejects.toMatchObject({ code: "BASELINE_INTEGRITY" })
})

test("chunked baseline writer enforces declared size and never publishes partial bytes", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root, { maxArtifactBytes: 16 })
  const writer = await store.beginBaselineWrite("panel", { schemaVersion: 1, name: "panel" }, 4)
  await writer.write(new Uint8Array([1, 2]))
  await expect(writer.commit()).rejects.toMatchObject({ code: "TRANSFER_SIZE_MISMATCH" })
  await writer.abort()
  expect(await store.readBaseline("panel")).toBeNull()

  const oversized = await store.beginBaselineWrite("large", { schemaVersion: 1, name: "large" }, 4)
  await expect(oversized.write(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" })
  await oversized.abort()
})

test("concurrent baseline replacement is serialized and abort preserves the previous committed pair", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  await store.writeBaseline("panel", { image: new Uint8Array([1, 2, 3]), meta: { schemaVersion: 1, name: "panel", generation: "old" } })

  const aborted = await store.beginBaselineWrite("panel", { schemaVersion: 1, name: "panel", generation: "aborted" }, 3)
  await aborted.write(new Uint8Array([4, 5, 6]))
  await aborted.abort()
  const afterAbort = await store.readBaseline("panel")
  expect(Buffer.from(afterAbort?.image as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
  expect(afterAbort?.meta).toMatchObject({ generation: "old" })

  const first = await store.beginBaselineWrite("panel", { schemaVersion: 1, name: "panel", generation: "first" }, 3)
  await first.write(new Uint8Array([4, 5, 6]))
  let secondResolved = false
  const secondPromise = store.beginBaselineWrite("panel", { schemaVersion: 1, name: "panel", generation: "new" }, 3).then((writer) => {
    secondResolved = true
    return writer
  })
  await Bun.sleep(10)
  expect(secondResolved).toBe(false)

  await first.commit()
  const second = await secondPromise
  await second.write(new Uint8Array([7, 8, 9]))
  await second.commit()
  const committed = await store.readBaseline("panel")
  expect(Buffer.from(committed?.image as Uint8Array)).toEqual(Buffer.from([7, 8, 9]))
  expect(committed?.meta).toMatchObject({ generation: "new" })
  expect((await readdir(join(root, ".snapeye", "baselines"))).some((name) => name.endsWith(".tmp"))).toBe(false)
})

test("run artifacts serialize against terminal result and writes are rejected afterward", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  const runId = "run1"
  const writer = await store.beginRunArtifactWrite(runId, SNAPEYE_ARTIFACTS.current, 4)
  await writer.write(new Uint8Array([1, 2, 3, 4]))

  let resultCommitted = false
  const pendingResult = store.commitResult(runId, result(runId)).then(() => {
    resultCommitted = true
  })
  await Bun.sleep(10)
  expect(resultCommitted).toBe(false)
  await writer.commit()
  await pendingResult
  expect(resultCommitted).toBe(true)

  await expect(store.writeRunArtifact(runId, SNAPEYE_ARTIFACTS.diff, new Uint8Array([1]))).rejects.toMatchObject({
    code: "RUN_ALREADY_TERMINAL",
  })
  await expect(store.commitResult(runId, result(runId))).rejects.toMatchObject({ code: "RESULT_ALREADY_COMMITTED" })
})

test("result commit validates protocol and is a single-assignment terminal marker", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  await expect(store.commitResult("run1", { ...result("other"), runId: "other" })).rejects.toMatchObject({ code: "INVALID_RESULT" })
  await store.commitResult("run1", result("run1"))
  expect(await store.readResult("run1")).toMatchObject({ runId: "run1", status: "ok", operation: "diff" })
})

test("retention prunes only old terminal runs and never baselines or in-flight work", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root, { maxRuns: 2 })
  await store.writeBaseline("panel", { image: new Uint8Array([1, 2, 3]), meta: { schemaVersion: 1, name: "panel" } })

  const inflight = await store.beginRunArtifactWrite("inflight", SNAPEYE_ARTIFACTS.current, 1)
  await inflight.write(new Uint8Array([7]))

  for (let index = 1; index <= 3; index++) {
    const runId = `run${index}`
    await store.commitResult(runId, {
      ...result(runId),
      finishedAt: new Date(index * 1_000).toISOString(),
    })
  }

  await store.flushMaintenance()

  expect(await lstat(join(root, ".snapeye", "runs", "run1")).catch(() => null)).toBeNull()
  expect((await lstat(join(root, ".snapeye", "runs", "run2"))).isDirectory()).toBe(true)
  expect((await lstat(join(root, ".snapeye", "runs", "run3"))).isDirectory()).toBe(true)
  expect((await lstat(join(root, ".snapeye", "runs", "inflight"))).isDirectory()).toBe(true)
  expect(await readFile(join(root, ".snapeye", "baselines", "panel.png"))).toEqual(Buffer.from([1, 2, 3]))

  await inflight.abort()
})

test("terminal result publication does not wait for retention maintenance", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root, { maxRuns: 1 })
  let releasePrune!: () => void
  const blocked = new Promise<void>((resolve) => { releasePrune = resolve })
  let pruneStarted = false
  const originalPrune = store.pruneRuns.bind(store)
  store.pruneRuns = async () => {
    pruneStarted = true
    await blocked
    return originalPrune()
  }

  await store.commitResult("fast_terminal", result("fast_terminal"))
  expect(await store.readResult("fast_terminal")).toMatchObject({ runId: "fast_terminal", status: "ok" })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(pruneStarted).toBe(true)

  releasePrune()
  await store.flushMaintenance()
})

test("history exposes only durable project-relative baselines and terminal runs", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  await store.writeBaseline("panel", {
    image: new Uint8Array([137, 80, 78, 71]),
    meta: {
      schemaVersion: 1,
      name: "panel",
      capturedAt: "2026-09-15T00:00:00.000Z",
      opencode: { schemaVersion: 1, lane: "webview", engineMajor: 140, redactionPolicySha256: "a".repeat(64) },
    },
  })

  await store.writeRunArtifact("run_terminal", SNAPEYE_ARTIFACTS.current, new Uint8Array([1, 2, 3]))
  await store.commitResult("run_terminal", {
    ...result("run_terminal"),
    name: "panel",
    finishedAt: "2026-09-15T00:00:01.000Z",
    artifacts: { current: "current.png" },
  })
  await store.writeRunArtifact("run_inflight", SNAPEYE_ARTIFACTS.current, new Uint8Array([9, 9]))

  const malformedDir = join(root, ".snapeye", "runs", "malformed")
  await mkdir(malformedDir, { recursive: true })
  await writeFile(join(malformedDir, "result.json"), "{not-json", "utf8")

  const history = await store.listHistory()
  expect(history.root).toBe(".snapeye")
  expect(history.baselines).toHaveLength(1)
  expect(history.baselines[0]).toMatchObject({
    name: "panel",
    imagePath: ".snapeye/baselines/panel.png",
    metadataPath: ".snapeye/baselines/panel.json",
    lane: "webview",
    engineMajor: 140,
  })
  expect(history.runs.map((run) => run.runId)).toEqual(["run_terminal"])
  expect(history.runs[0]?.artifacts).toContain("current")
  expect(history.runs[0]?.resultPath).toBe(".snapeye/runs/run_terminal/result.json")
})

test("artifact descriptors require terminal declaration and never expose absolute paths", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  await store.writeBaseline("panel", { image: new Uint8Array([1, 2, 3]), meta: { schemaVersion: 1, name: "panel" } })
  await store.writeRunArtifact("run1", SNAPEYE_ARTIFACTS.current, new Uint8Array([4, 5, 6]))

  expect(await store.describeArtifact({ source: "run", runId: "run1", artifact: "current" })).toBeNull()

  await store.commitResult("run1", {
    ...result("run1"),
    artifacts: { current: "current.png" },
  })
  const current = await store.describeArtifact({ source: "run", runId: "run1", artifact: "current" })
  expect(current).toEqual({ kind: "current", path: ".snapeye/runs/run1/current.png", mime: "image/png", byteLength: 3 })
  expect(current?.path.includes(root.replace(/\\/g, "/"))).toBe(false)
  expect(await store.describeArtifact({ source: "run", runId: "run1", artifact: "diff" })).toBeNull()

  const baseline = await store.describeArtifact({ source: "baseline", name: "panel" })
  expect(baseline?.path).toBe(".snapeye/baselines/panel.png")
  await expect(store.describeArtifact({ source: "run", runId: "../escape", artifact: "result" })).rejects.toMatchObject({ code: "INVALID_RUN_ID" })
})

test("artifact descriptor enforces the host artifact-size ceiling after external replacement", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root, { maxArtifactBytes: 4 })
  await store.writeRunArtifact("run1", SNAPEYE_ARTIFACTS.current, new Uint8Array([1, 2, 3, 4]))
  await store.commitResult("run1", { ...result("run1"), artifacts: { current: "current.png" } })
  await writeFile(join(root, ".snapeye", "runs", "run1", "current.png"), new Uint8Array([1, 2, 3, 4, 5]))
  await expect(store.describeArtifact({ source: "run", runId: "run1", artifact: "current" })).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" })
})

test("preview reads only validated bounded non-video artifacts", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  await store.writeRunArtifact("run1", SNAPEYE_ARTIFACTS.frames, new Uint8Array([1, 2, 3]))
  await store.commitResult("run1", {
    ...result("run1"),
    operation: "record",
    artifacts: { frames: "frames.png" },
  })
  const preview = await store.readArtifact({ source: "run", runId: "run1", artifact: "frames" }, 4)
  expect(preview?.descriptor).toEqual({ kind: "frames", path: ".snapeye/runs/run1/frames.png", mime: "image/png", byteLength: 3 })
  expect(Buffer.from(preview?.bytes ?? new Uint8Array())).toEqual(Buffer.from([1, 2, 3]))
  expect(preview?.sha256).toMatch(/^[a-f0-9]{64}$/)
  await expect(store.readArtifact({ source: "run", runId: "run1", artifact: "frames" }, 2)).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" })
})

test("human approval promotes the exact reviewed current.png and preserves visual identity", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  const current = new Uint8Array([137, 80, 78, 71, 10, 20, 30])
  await store.writeBaseline("panel", { image: new Uint8Array([1, 2, 3]), meta: { schemaVersion: 1, name: "panel" } })
  await store.writeRunArtifact("reviewed", SNAPEYE_ARTIFACTS.current, current)
  await store.commitResult("reviewed", {
    schemaVersion: 1,
    protocolVersion: 1,
    runId: "reviewed",
    status: "ok",
    operation: "diff",
    name: "panel",
    finishedAt: "2026-09-15T02:00:00.000Z",
    target: { selector: "#panel", descriptor: "#panel" },
    image: { coordinateSpace: "target-css-px", cssWidth: 100, cssHeight: 50, pixelWidth: 100, pixelHeight: 50, scale: 1 },
    diff: { changed: true, changedRatio: 0.5, regionCount: 1, regionsTruncated: false, regions: [] },
    artifacts: { baseline: "../../baselines/panel.png", current: "current.png", diff: "diff.png" },
    opencode: { schemaVersion: 1, lane: "webview", platform: process.platform, engine: "chromium", redactionPolicySha256: "b".repeat(64) },
  })

  const currentPreview = await store.readArtifact({ source: "run", runId: "reviewed", artifact: "current" }, 1024)
  const resultPreview = await store.readArtifact({ source: "run", runId: "reviewed", artifact: "result" }, 1024 * 1024)
  const baselinePreview = await store.readArtifact({ source: "baseline", name: "panel" }, 1024)
  const baselineMetadataPreview = await store.readArtifact({ source: "baseline", name: "panel", artifact: "metadata" }, 1024 * 1024)
  const approved = await store.approveRunCurrent("reviewed", {
    currentSha256: currentPreview!.sha256,
    resultSha256: resultPreview!.sha256,
    baselineSha256: baselinePreview!.sha256,
    baselineMetadataSha256: baselineMetadataPreview!.sha256,
  })
  expect(approved.sourceRunId).toBe("reviewed")
  expect(approved.baseline.name).toBe("panel")
  expect(await readFile(join(root, ".snapeye", "baselines", "panel.png"))).toEqual(Buffer.from(current))
  const meta = JSON.parse(await readFile(join(root, ".snapeye", "baselines", "panel.json"), "utf8"))
  expect(meta).toMatchObject({
    schemaVersion: 1,
    name: "panel",
    capturedAt: "2026-09-15T02:00:00.000Z",
    target: { selector: "#panel" },
    image: { coordinateSpace: "target-css-px", cssWidth: 100, cssHeight: 50 },
    opencode: { lane: "webview", redactionPolicySha256: "b".repeat(64) },
  })
})

test("human approval fails closed when any reviewed artifact changes after preview", async () => {
  const makeReviewed = async (suffix: string) => {
    const root = await project()
    const store = await OpenCodeSnapEyeStore.create(root)
    const runId = `review_${suffix}`
    await store.writeBaseline("panel", { image: new Uint8Array([1, 2, 3]), meta: { schemaVersion: 1, name: "panel" } })
    await store.writeRunArtifact(runId, SNAPEYE_ARTIFACTS.current, new Uint8Array([4, 5, 6]))
    await store.commitResult(runId, {
      schemaVersion: 1,
      protocolVersion: 1,
      runId,
      status: "ok",
      operation: "diff",
      name: "panel",
      finishedAt: "2026-09-15T02:00:00.000Z",
      target: { selector: "#panel", descriptor: "#panel" },
      image: { coordinateSpace: "target-css-px", cssWidth: 10, cssHeight: 10, pixelWidth: 10, pixelHeight: 10, scale: 1 },
      diff: { changed: true, changedRatio: 0.1, regionCount: 1, regionsTruncated: false, regions: [] },
      artifacts: { baseline: "../../baselines/panel.png", current: "current.png" },
    })
    const current = await store.readArtifact({ source: "run", runId, artifact: "current" }, 1024)
    const terminal = await store.readArtifact({ source: "run", runId, artifact: "result" }, 1024 * 1024)
    const baseline = await store.readArtifact({ source: "baseline", name: "panel" }, 1024)
    const baselineMetadata = await store.readArtifact({ source: "baseline", name: "panel", artifact: "metadata" }, 1024 * 1024)
    return {
      root,
      store,
      runId,
      expected: {
        currentSha256: current!.sha256,
        resultSha256: terminal!.sha256,
        baselineSha256: baseline!.sha256,
        baselineMetadataSha256: baselineMetadata!.sha256,
      },
    }
  }

  const currentRace = await makeReviewed("current")
  await writeFile(join(currentRace.root, ".snapeye", "runs", currentRace.runId, "current.png"), new Uint8Array([7, 8, 9]))
  await expect(currentRace.store.approveRunCurrent(currentRace.runId, currentRace.expected)).rejects.toMatchObject({ code: "REVIEW_CHANGED" })
  expect(await readFile(join(currentRace.root, ".snapeye", "baselines", "panel.png"))).toEqual(Buffer.from([1, 2, 3]))

  const resultRace = await makeReviewed("result")
  const resultPath = join(resultRace.root, ".snapeye", "runs", resultRace.runId, "result.json")
  const changedResult = JSON.parse(await readFile(resultPath, "utf8"))
  changedResult.target = { selector: "#different", descriptor: "#different" }
  await writeFile(resultPath, `${JSON.stringify(changedResult, null, 2)}\n`, "utf8")
  await expect(resultRace.store.approveRunCurrent(resultRace.runId, resultRace.expected)).rejects.toMatchObject({ code: "REVIEW_CHANGED" })
  expect(await readFile(join(resultRace.root, ".snapeye", "baselines", "panel.png"))).toEqual(Buffer.from([1, 2, 3]))

  const baselineRace = await makeReviewed("baseline")
  await baselineRace.store.writeBaseline("panel", { image: new Uint8Array([9, 9, 9]), meta: { schemaVersion: 1, name: "panel", generation: "external-newer" } })
  await expect(baselineRace.store.approveRunCurrent(baselineRace.runId, baselineRace.expected)).rejects.toMatchObject({ code: "REVIEW_CHANGED" })
  expect(await readFile(join(baselineRace.root, ".snapeye", "baselines", "panel.png"))).toEqual(Buffer.from([9, 9, 9]))

  const baselineMetadataRace = await makeReviewed("baseline_metadata")
  const baselineMetadataPath = join(baselineMetadataRace.root, ".snapeye", "baselines", "panel.json")
  const changedBaselineMetadata = JSON.parse(await readFile(baselineMetadataPath, "utf8"))
  changedBaselineMetadata.externalNote = "changed-after-review"
  await writeFile(baselineMetadataPath, `${JSON.stringify(changedBaselineMetadata, null, 2)}\n`, "utf8")
  await expect(baselineMetadataRace.store.approveRunCurrent(baselineMetadataRace.runId, baselineMetadataRace.expected)).rejects.toMatchObject({ code: "REVIEW_CHANGED" })
  expect(await readFile(join(baselineMetadataRace.root, ".snapeye", "baselines", "panel.png"))).toEqual(Buffer.from([1, 2, 3]))

  const baselineDeletedRace = await makeReviewed("baseline_deleted")
  await rm(join(baselineDeletedRace.root, ".snapeye", "baselines", "panel.png"), { force: true })
  await rm(join(baselineDeletedRace.root, ".snapeye", "baselines", "panel.json"), { force: true })
  await expect(baselineDeletedRace.store.approveRunCurrent(baselineDeletedRace.runId, baselineDeletedRace.expected)).rejects.toMatchObject({ code: "REVIEW_CHANGED" })
})

test("approval remains compatible with an upstream-style baseline that has no metadata file", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  await store.writeBaseline("panel", { image: new Uint8Array([1, 2, 3]), meta: { schemaVersion: 1, name: "panel" } })
  await rm(join(root, ".snapeye", "baselines", "panel.json"), { force: true })
  await store.writeRunArtifact("legacy_review", SNAPEYE_ARTIFACTS.current, new Uint8Array([4, 5, 6]))
  await store.commitResult("legacy_review", {
    schemaVersion: 1,
    protocolVersion: 1,
    runId: "legacy_review",
    status: "ok",
    operation: "diff",
    name: "panel",
    finishedAt: "2026-09-15T02:00:00.000Z",
    target: { selector: "#panel", descriptor: "#panel" },
    image: { coordinateSpace: "target-css-px", cssWidth: 10, cssHeight: 10, pixelWidth: 10, pixelHeight: 10, scale: 1 },
    diff: { changed: true, changedRatio: 0.1, regionCount: 1, regionsTruncated: false, regions: [] },
    artifacts: { baseline: "../../baselines/panel.png", current: "current.png" },
  })
  const current = await store.readArtifact({ source: "run", runId: "legacy_review", artifact: "current" }, 1024)
  const terminal = await store.readArtifact({ source: "run", runId: "legacy_review", artifact: "result" }, 1024 * 1024)
  const baseline = await store.readArtifact({ source: "baseline", name: "panel" }, 1024)
  expect(await store.readArtifact({ source: "baseline", name: "panel", artifact: "metadata" }, 1024)).toBeNull()
  await expect(store.approveRunCurrent("legacy_review", {
    currentSha256: current!.sha256,
    resultSha256: terminal!.sha256,
    baselineSha256: baseline!.sha256,
    baselineMetadataSha256: null,
  })).resolves.toMatchObject({ sourceRunId: "legacy_review", baseline: { name: "panel" } })
  expect(await readFile(join(root, ".snapeye", "baselines", "panel.png"))).toEqual(Buffer.from([4, 5, 6]))
})

test("approval refuses non-diff and incomplete terminal runs", async () => {
  const root = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  await store.commitResult("capture1", {
    schemaVersion: 1,
    protocolVersion: 1,
    runId: "capture1",
    status: "ok",
    operation: "capture",
    name: "panel",
  })
  const captureResult = await store.readArtifact({ source: "run", runId: "capture1", artifact: "result" }, 1024 * 1024)
  const expected = {
    currentSha256: "a".repeat(64),
    resultSha256: captureResult!.sha256,
    baselineSha256: "c".repeat(64),
    baselineMetadataSha256: "d".repeat(64),
  }
  await expect(store.approveRunCurrent("capture1", expected)).rejects.toMatchObject({ code: "INVALID_RESULT" })

  await store.writeRunArtifact("diff1", SNAPEYE_ARTIFACTS.current, new Uint8Array([1]))
  await store.commitResult("diff1", { ...result("diff1"), artifacts: { current: "current.png" } })
  const resultPreview = await store.readArtifact({ source: "run", runId: "diff1", artifact: "result" }, 1024 * 1024)
  await expect(store.approveRunCurrent("diff1", { ...expected, resultSha256: resultPreview!.sha256 })).rejects.toMatchObject({ code: "INVALID_RESULT" })
})

test("an existing .snapeye symlink/junction is rejected as a filesystem escape", async () => {
  const root = await project()
  const outside = await project()
  try {
    await symlink(outside, join(root, ".snapeye"), process.platform === "win32" ? "junction" : "dir")
  } catch {
    // Some locked-down Windows test environments disable symlink creation.
    return
  }
  await expect(OpenCodeSnapEyeStore.create(root)).rejects.toBeInstanceOf(VisualArtifactError)
})

test("a replaced baselines directory link is rejected without leaking its baseline mutex", async () => {
  const root = await project()
  const outside = await project()
  const store = await OpenCodeSnapEyeStore.create(root)
  const baselines = join(root, ".snapeye", "baselines")
  await rm(baselines, { recursive: true, force: true })
  try {
    await symlink(outside, baselines, process.platform === "win32" ? "junction" : "dir")
  } catch {
    return
  }

  const write = () => store.beginBaselineWrite("panel", { schemaVersion: 1, name: "panel" }, 1)
  await expect(write()).rejects.toMatchObject({ code: "INVALID_PATH" })
  // A setup-path failure must release the lock. The second call should reject
  // for the same path reason immediately rather than waiting forever behind a
  // leaked mutex acquired by the first attempt.
  await expect(Promise.race([
    write(),
    Bun.sleep(250).then(() => { throw new Error("baseline mutex leaked after path rejection") }),
  ])).rejects.toMatchObject({ code: "INVALID_PATH" })
})
