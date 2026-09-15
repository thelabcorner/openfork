import { constants as FS_CONSTANTS } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { link, lstat, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import {
  SNAPEYE_ARTIFACTS,
  SNAPEYE_DEFAULT_MAX_ARTIFACT_BYTES,
  SNAPEYE_RUN_ARTIFACTS,
  VisualArtifactError,
  isPlainObject,
  isValidSnapEyeName,
  isValidSnapEyeRunId,
  type SnapEyeResult,
  type SnapEyeStoredBaseline,
  validateSnapEyeResult,
} from "./protocol"
import {
  assertNoLinkEscape,
  baselineFilePath,
  ensureSafeParent,
  ensureVisualArtifactLayout,
  resolveVisualArtifactPaths,
  runFilePath,
  type VisualArtifactPaths,
} from "./path-safety"

const BASELINE_COMMIT_KEY = "__snapeyeBaselineCommit"
const BASELINE_COMMIT_FORMAT = "snapeye-baseline-v1"
const GITIGNORE_ENTRIES = ["runs/", "*.tmp"] as const
const baselineLocks = new Map<string, Mutex>()
const runLocks = new Map<string, Mutex>()
const pruneLocks = new Map<string, Mutex>()
const DEFAULT_MAX_RUNS = 20
const HISTORY_JSON_MAX_BYTES = 1024 * 1024
const HISTORY_IO_CONCURRENCY = 8

export type VisualArtifactKind =
  | "baseline"
  | "baseline_metadata"
  | "current"
  | "svg"
  | "diff"
  | "frames"
  | "gif"
  | "video"
  | "result"

export interface VisualBaselineSummary {
  name: string
  imagePath: string
  metadataPath?: string
  byteLength: number
  capturedAt?: string
  lane?: "webview" | "extension"
  engineMajor?: number
  redactionPolicySha256?: string
}

export interface VisualRunSummary {
  runId: string
  resultPath: string
  status: "ok" | "error"
  operation: "capture" | "diff" | "record" | "unknown"
  name?: string
  finishedAt?: string
  changed?: boolean
  frameCount?: number
  artifacts: VisualArtifactKind[]
}

export interface VisualHistorySnapshot {
  root: ".snapeye"
  baselines: VisualBaselineSummary[]
  runs: VisualRunSummary[]
}

export interface VisualArtifactDescriptor {
  kind: VisualArtifactKind
  path: string
  mime: string
  byteLength: number
}

export interface VisualArtifactPayload {
  descriptor: VisualArtifactDescriptor
  bytes: Uint8Array
  sha256: string
}

export interface VisualApprovalExpectation {
  currentSha256: string
  resultSha256: string
  baselineSha256: string
  baselineMetadataSha256: string | null
}

export interface VisualApprovalResult {
  baseline: VisualBaselineSummary
  sourceRunId: string
}

interface BaselineCommit {
  format: typeof BASELINE_COMMIT_FORMAT
  state: "pending" | "committed"
  generation: string
  image?: { algorithm: "sha256"; digest: string; byteLength: number }
  publicMetadata?: { hadCommitKey: true; value: unknown }
}

interface ParsedBaselineMetadata {
  meta: Record<string, unknown> | null
  commit: BaselineCommit | null
}

export interface VisualArtifactStoreOptions {
  maxArtifactBytes?: number
  maxRuns?: number
}

export interface VisualReadHandle {
  readonly byteLength: number
  readonly meta: Record<string, unknown> | null
  read(offset: number, length: number): Promise<Uint8Array>
  close(): Promise<void>
}

export interface VisualWriteHandle {
  readonly expectedBytes?: number
  readonly bytesWritten: number
  write(chunk: Uint8Array): Promise<void>
  commit(): Promise<void>
  abort(): Promise<void>
}

/**
 * Host-owned SnapEye-compatible persistence.
 *
 * The public four methods mirror SnapEye's ArtifactStore. The streaming methods
 * are OpenCode's transport seam and avoid constructing 10-60 MiB base64/Buffer
 * aggregates in Desktop merely because Chrome Native Messaging is chunked.
 */
export class OpenCodeSnapEyeStore {
  readonly paths: VisualArtifactPaths
  readonly maxArtifactBytes: number
  readonly maxRuns: number
  private pruneTask?: Promise<void>
  private pruneDirty = false

  private constructor(paths: VisualArtifactPaths, options: VisualArtifactStoreOptions) {
    this.paths = paths
    this.maxArtifactBytes = options.maxArtifactBytes ?? SNAPEYE_DEFAULT_MAX_ARTIFACT_BYTES
    if (!Number.isSafeInteger(this.maxArtifactBytes) || this.maxArtifactBytes < 1) {
      throw new TypeError("maxArtifactBytes must be a positive safe integer")
    }
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS
    if (!Number.isSafeInteger(this.maxRuns) || this.maxRuns < 0) {
      throw new TypeError("maxRuns must be a non-negative safe integer")
    }
  }

  static async create(projectDirectory: string, options: VisualArtifactStoreOptions = {}): Promise<OpenCodeSnapEyeStore> {
    const paths = await resolveVisualArtifactPaths(projectDirectory)
    const store = new OpenCodeSnapEyeStore(paths, options)
    await store.ensureLayout()
    return store
  }

  async ensureLayout(): Promise<void> {
    await ensureVisualArtifactLayout(this.paths)
    await this.ensureGitignore()
  }

  async readBaseline(name: string): Promise<SnapEyeStoredBaseline | null> {
    const metadataPath = baselineFilePath(this.paths, name, ".json")
    return this.baselineMutex(metadataPath).run(async () => {
      const loaded = await this.readVerifiedBaseline(name)
      if (!loaded) return null
      return { name, image: loaded.image, meta: loaded.meta }
    })
  }

  async openBaselineRead(name: string, options: { verifyWhileReading?: boolean } = {}): Promise<VisualReadHandle | null> {
    const metadataPath = baselineFilePath(this.paths, name, ".json")
    const release = await this.baselineMutex(metadataPath).acquire()
    let openedHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const imagePath = baselineFilePath(this.paths, name, ".png")
      const serialized = await readSafeOrNull(this.paths.root, metadataPath, "utf8")
      const stored = parseBaselineMetadata(serialized as string | null, name)
      if (stored.commit?.state === "pending") {
        throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} replacement did not reach its commit marker`)
      }
      try {
        openedHandle = await openNoFollow(imagePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !stored.commit) {
          release()
          return null
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && stored.commit) {
          throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} committed image is missing`)
        }
        throw error
      }
      const handle = openedHandle
      const entry = await handle.stat()
      if (!entry.isFile()) {
        await handle.close()
        throw new VisualArtifactError("INVALID_PATH", `Expected regular baseline file: ${imagePath}`)
      }
      const confirmed = await readSafeOrNull(this.paths.root, metadataPath, "utf8")
      if (confirmed !== serialized) {
        await handle.close()
        throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} metadata changed during read`)
      }
      const byteLength = entry.size
      if (!Number.isSafeInteger(byteLength) || byteLength > this.maxArtifactBytes) {
        await handle.close()
        throw new VisualArtifactError("ARTIFACT_TOO_LARGE", `Baseline ${JSON.stringify(name)} exceeds ${this.maxArtifactBytes} bytes`)
      }
      const verifyWhileReading = options.verifyWhileReading === true && stored.commit?.state === "committed"
      if (stored.commit?.state === "committed" && !verifyWhileReading) {
        await verifyBaselineHandle(name, handle, byteLength, stored.commit)
      }
      const streamedHash = verifyWhileReading ? createHash("sha256") : null
      let streamedBytes = 0
      let closed = false
      return {
        byteLength,
        meta: stored.meta,
        read: async (offset, length) => {
          if (closed) throw new VisualArtifactError("TRANSFER_CLOSED", "Baseline read handle is closed")
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
            throw new RangeError("Invalid baseline read range")
          }
          const boundedLength = Math.min(length, Math.max(0, byteLength - offset))
          if (boundedLength === 0) return new Uint8Array(0)
          const out = Buffer.allocUnsafe(boundedLength)
          const { bytesRead } = await handle.read(out, 0, boundedLength, offset)
          const bytes = out.subarray(0, bytesRead)
          if (streamedHash) {
            if (offset !== streamedBytes) {
              throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} was read out of sequence`)
            }
            streamedHash.update(bytes)
            streamedBytes += bytesRead
          }
          return bytes
        },
        close: async () => {
          if (closed) return
          closed = true
          let integrityError: VisualArtifactError | undefined
          if (streamedHash && stored.commit?.image && streamedBytes === byteLength) {
            const finalEntry = await handle.stat().catch(() => null)
            if (!finalEntry?.isFile() || finalEntry.size !== byteLength || streamedHash.digest("hex") !== stored.commit.image.digest) {
              integrityError = new VisualArtifactError(
                "BASELINE_INTEGRITY",
                `SnapEye baseline ${JSON.stringify(name)} image does not match its commit marker`,
              )
            }
          }
          await handle.close().catch(() => undefined)
          release()
          if (integrityError) throw integrityError
        },
      }
    } catch (error) {
      await openedHandle?.close().catch(() => undefined)
      release()
      throw error
    }
  }

  async writeBaseline(name: string, baseline: SnapEyeStoredBaseline): Promise<void> {
    const bytes = toBytes(baseline.image)
    const writer = await this.beginBaselineWrite(name, baseline.meta, bytes.byteLength)
    try {
      await writer.write(bytes)
      await writer.commit()
    } catch (error) {
      await writer.abort()
      throw error
    }
  }

  async beginBaselineWrite(
    name: string,
    meta: Record<string, unknown> | null,
    expectedBytes?: number,
    commitPrecondition?: () => Promise<void>,
  ): Promise<VisualWriteHandle> {
    if (meta !== null && !isPlainObject(meta)) {
      throw new VisualArtifactError("INVALID_BASELINE_METADATA", "SnapEye baseline metadata must be an object")
    }
    this.assertExpectedBytes(expectedBytes)
    const imagePath = baselineFilePath(this.paths, name, ".png")
    const metadataPath = baselineFilePath(this.paths, name, ".json")
    const release = await this.baselineMutex(metadataPath).acquire()
    try {
      await ensureSafeParent(this.paths.root, imagePath)
      const temp = join(dirname(imagePath), `.${randomUUID()}.tmp`)
      assertNoLinkEscape(this.paths.root, temp)
      const file = await open(temp, "wx")
      const generation = randomUUID()
      const hash = createHash("sha256")
      let bytesWritten = 0
      let closed = false

      const cleanup = async () => {
        if (!closed) {
          closed = true
          await file.close().catch(() => undefined)
          await rm(temp, { force: true }).catch(() => undefined)
          release()
        }
      }

      const writer: VisualWriteHandle = {
        expectedBytes,
        get bytesWritten() {
          return bytesWritten
        },
        write: async (chunk) => {
          if (closed) throw new VisualArtifactError("TRANSFER_CLOSED", "Baseline write handle is closed")
          const bytes = toBytes(chunk)
          this.assertWriteBudget(bytesWritten, bytes.byteLength, expectedBytes)
          if (bytes.byteLength === 0) return
          await file.write(bytes, 0, bytes.byteLength, null)
          hash.update(bytes)
          bytesWritten += bytes.byteLength
        },
        commit: async () => {
          if (closed) throw new VisualArtifactError("TRANSFER_CLOSED", "Baseline write handle is closed")
          this.assertTransferComplete(bytesWritten, expectedBytes)
          try {
            await file.sync()
            await file.close()
            await commitPrecondition?.()
            const publicMeta = meta ?? {}
            const hadCommitKey = Object.prototype.hasOwnProperty.call(publicMeta, BASELINE_COMMIT_KEY)
            await writeFileAtomic(
              this.paths.root,
              metadataPath,
              serializeJson({ [BASELINE_COMMIT_KEY]: { format: BASELINE_COMMIT_FORMAT, state: "pending", generation } }),
            )
            assertNoLinkEscape(this.paths.root, imagePath)
            await rename(temp, imagePath)
            const commit: BaselineCommit = {
              format: BASELINE_COMMIT_FORMAT,
              state: "committed",
              generation,
              image: { algorithm: "sha256", digest: hash.digest("hex"), byteLength: bytesWritten },
              ...(hadCommitKey ? { publicMetadata: { hadCommitKey: true as const, value: publicMeta[BASELINE_COMMIT_KEY] } } : {}),
            }
            await writeFileAtomic(this.paths.root, metadataPath, serializeJson({ ...publicMeta, [BASELINE_COMMIT_KEY]: commit }))
            closed = true
            release()
          } catch (error) {
            await rm(temp, { force: true }).catch(() => undefined)
            closed = true
            release()
            throw error
          }
        },
        abort: cleanup,
      }
      return writer
    } catch (error) {
      release()
      throw error
    }
  }

  async writeRunArtifact(runId: string, filename: string, data: Uint8Array | ArrayBuffer | string): Promise<void> {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : toBytes(data)
    const writer = await this.beginRunArtifactWrite(runId, filename, bytes.byteLength)
    try {
      await writer.write(bytes)
      await writer.commit()
    } catch (error) {
      await writer.abort()
      throw error
    }
  }

  async beginRunArtifactWrite(runId: string, filename: string, expectedBytes?: number): Promise<VisualWriteHandle> {
    if (!SNAPEYE_RUN_ARTIFACTS.has(filename)) {
      throw new VisualArtifactError("INVALID_ARTIFACT", `Unknown SnapEye run artifact: ${JSON.stringify(filename)}`)
    }
    this.assertExpectedBytes(expectedBytes)
    const resultPath = runFilePath(this.paths, runId, SNAPEYE_ARTIFACTS.result)
    const artifactPath = runFilePath(this.paths, runId, filename)
    const release = await this.runMutex(resultPath).acquire()
    try {
      await this.assertRunOpen(resultPath, runId)
      await ensureSafeParent(this.paths.root, artifactPath)
      const temp = join(dirname(artifactPath), `.${randomUUID()}.tmp`)
      assertNoLinkEscape(this.paths.root, temp)
      const file = await open(temp, "wx")
      let bytesWritten = 0
      let closed = false
      const cleanup = async () => {
        if (closed) return
        closed = true
        await file.close().catch(() => undefined)
        await rm(temp, { force: true }).catch(() => undefined)
        release()
      }
      return {
        expectedBytes,
        get bytesWritten() {
          return bytesWritten
        },
        write: async (chunk) => {
          if (closed) throw new VisualArtifactError("TRANSFER_CLOSED", "Run artifact write handle is closed")
          const bytes = toBytes(chunk)
          this.assertWriteBudget(bytesWritten, bytes.byteLength, expectedBytes)
          if (bytes.byteLength === 0) return
          await file.write(bytes, 0, bytes.byteLength, null)
          bytesWritten += bytes.byteLength
        },
        commit: async () => {
          if (closed) throw new VisualArtifactError("TRANSFER_CLOSED", "Run artifact write handle is closed")
          this.assertTransferComplete(bytesWritten, expectedBytes)
          try {
            await file.sync()
            await file.close()
            await this.assertRunOpen(resultPath, runId)
            assertNoLinkEscape(this.paths.root, artifactPath)
            await rename(temp, artifactPath)
            closed = true
            release()
          } catch (error) {
            await rm(temp, { force: true }).catch(() => undefined)
            closed = true
            release()
            throw error
          }
        },
        abort: cleanup,
      }
    } catch (error) {
      release()
      throw error
    }
  }

  async commitResult(runId: string, result: SnapEyeResult): Promise<void> {
    const problem = validateSnapEyeResult(result, runId)
    if (problem) throw new VisualArtifactError("INVALID_RESULT", `SnapEye refused an invalid result: ${problem}`)
    const resultPath = runFilePath(this.paths, runId, SNAPEYE_ARTIFACTS.result)
    await this.runMutex(resultPath).run(async () => {
      await ensureSafeParent(this.paths.root, resultPath)
      try {
        await writeFileAtomicOnce(this.paths.root, resultPath, serializeJson(result))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new VisualArtifactError("RESULT_ALREADY_COMMITTED", `SnapEye run ${runId} already has a terminal result`)
        }
        throw error
      }
    })
    // Result publication is the terminal correctness boundary; retention is
    // maintenance. Keep it entirely off the operation's latency path and
    // coalesce bursts of completions into the minimum number of directory
    // scans. A commit arriving while pruning marks the store dirty so one final
    // pass observes it before maintenance goes idle.
    this.schedulePrune()
  }

  private schedulePrune(): void {
    this.pruneDirty = true
    if (this.pruneTask) return
    // Give the result-response path an event-loop turn before retention starts
    // touching the filesystem. This is intentionally stronger than a microtask:
    // terminal publication should not compete with housekeeping for its next
    // continuation.
    this.pruneTask = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        while (this.pruneDirty) {
          this.pruneDirty = false
          await this.pruneRuns()
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.pruneTask = undefined
        // Close the tiny race where another result committed after the loop's
        // final dirty check but before this task cleared itself.
        if (this.pruneDirty) this.schedulePrune()
      })
  }

  /** Wait for best-effort retention maintenance to become idle. */
  async flushMaintenance(): Promise<void> {
    while (this.pruneTask || this.pruneDirty) {
      if (!this.pruneTask) this.schedulePrune()
      const task = this.pruneTask
      if (task) await task
    }
  }

  /**
   * Keep the newest terminal runs only. Unlike upstream's server-start pruning,
   * OpenCode can have concurrent operations, so directories without a durable
   * result.json are deliberately excluded and can never be deleted here.
   */
  async pruneRuns(): Promise<{ kept: string[]; removed: string[] }> {
    return this.pruneMutex().run(async () => {
      await assertNoLinkEscape(this.paths.root, this.paths.runs)
      const entries = await readdir(this.paths.runs, { withFileTypes: true })
      const terminal: Array<{ id: string; dir: string; at: number }> = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        let dir: string
        let resultPath: string
        try {
          resultPath = runFilePath(this.paths, entry.name, SNAPEYE_ARTIFACTS.result)
          dir = dirname(resultPath)
        } catch {
          continue
        }
        assertNoLinkEscape(this.paths.root, dir)
        const directory = await lstat(dir).catch(() => null)
        if (!directory?.isDirectory() || directory.isSymbolicLink()) continue
        const raw = await readSafeOrNull(this.paths.root, resultPath, "utf8").catch(() => null)
        if (typeof raw !== "string") continue
        let at = directory.mtimeMs
        try {
          const parsed = JSON.parse(raw) as { finishedAt?: unknown }
          const terminalAt = typeof parsed.finishedAt === "string" ? Date.parse(parsed.finishedAt) : Number.NaN
          if (Number.isFinite(terminalAt)) at = terminalAt
        } catch {
          // A malformed terminal marker is still terminal for retention
          // purposes, but falls back to filesystem time rather than becoming
          // an excuse to traverse or inspect arbitrary content.
        }
        terminal.push({ id: entry.name, dir, at })
      }

      terminal.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
      const kept = terminal.slice(0, this.maxRuns)
      const removed: string[] = []
      for (const run of terminal.slice(this.maxRuns)) {
        await assertNoLinkEscape(this.paths.root, run.dir)
        const current = await lstat(run.dir).catch(() => null)
        if (!current?.isDirectory() || current.isSymbolicLink()) continue
        // Re-check terminality immediately before destructive removal. A run
        // cannot become non-terminal after result.json exists, but this closes
        // the TOCTOU window if the directory was externally replaced.
        const currentResult = runFilePath(this.paths, run.id, SNAPEYE_ARTIFACTS.result)
        if (await readSafeOrNull(this.paths.root, currentResult, "utf8").catch(() => null) === null) continue
        await rm(run.dir, { recursive: true, force: true })
        removed.push(run.id)
      }
      return { kept: kept.map((run) => run.id), removed }
    })
  }

  async readResult(runId: string): Promise<SnapEyeResult | null> {
    const resultPath = runFilePath(this.paths, runId, SNAPEYE_ARTIFACTS.result)
    const raw = await readSafeOrNull(this.paths.root, resultPath, "utf8")
    if (raw === null) return null
    return JSON.parse(raw as string) as SnapEyeResult
  }

  async listHistory(options: { maxRuns?: number; maxBaselines?: number } = {}): Promise<VisualHistorySnapshot> {
    const maxRuns = boundedListLimit(options.maxRuns, 20, 100)
    const maxBaselines = boundedListLimit(options.maxBaselines, 50, 200)
    const [baselines, runs] = await Promise.all([
      this.listBaselines(maxBaselines),
      this.listTerminalRuns(maxRuns),
    ])
    return { root: ".snapeye", baselines, runs }
  }

  async describeArtifact(input:
    | { source: "baseline"; name: string; artifact?: "image" | "metadata" }
    | { source: "run"; runId: string; artifact: "current" | "svg" | "diff" | "frames" | "gif" | "video" | "result" }
  ): Promise<VisualArtifactDescriptor | null> {
    if (input.source === "baseline") {
      const artifact = input.artifact ?? "image"
      const verified = await this.openBaselineRead(input.name)
      if (!verified) return null
      await verified.close()
      const file = baselineFilePath(this.paths, input.name, artifact === "metadata" ? ".json" : ".png")
      return this.describeSafeFile(
        file,
        artifact === "metadata" ? "baseline_metadata" : "baseline",
        artifact === "metadata" ? "application/json" : "image/png",
      )
    }

    const terminal = await readBoundedJsonObject(
      this.paths.root,
      runFilePath(this.paths, input.runId, SNAPEYE_ARTIFACTS.result),
      HISTORY_JSON_MAX_BYTES,
    )
    if (!terminal || validateSnapEyeResult(terminal, input.runId)) return null
    const declared = summarizeArtifactKinds(terminal)
    if (!declared.includes(input.artifact)) return null

    const filename = input.artifact === "video"
      ? resolveVideoFilenameFromResult(terminal)
      : input.artifact === "result"
        ? SNAPEYE_ARTIFACTS.result
        : ({
            current: SNAPEYE_ARTIFACTS.current,
            svg: SNAPEYE_ARTIFACTS.svg,
            diff: SNAPEYE_ARTIFACTS.diff,
            frames: SNAPEYE_ARTIFACTS.frames,
            gif: SNAPEYE_ARTIFACTS.gif,
          } as const)[input.artifact]
    if (!filename) return null
    const file = runFilePath(this.paths, input.runId, filename)
    return this.describeSafeFile(file, input.artifact, mimeForArtifact(filename))
  }

  async readArtifact(
    input:
      | { source: "baseline"; name: string; artifact?: "image" | "metadata" }
      | { source: "run"; runId: string; artifact: "current" | "svg" | "diff" | "frames" | "gif" | "video" | "result" },
    maxBytes: number,
  ): Promise<VisualArtifactPayload | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer")
    const descriptor = await this.describeArtifact(input)
    if (!descriptor) return null
    if (descriptor.byteLength > maxBytes) {
      throw new VisualArtifactError("ARTIFACT_TOO_LARGE", `Visual preview exceeds ${maxBytes} bytes`)
    }
    if (descriptor.kind === "video") {
      throw new VisualArtifactError("INVALID_ARTIFACT", "Video artifacts are open-only and are not copied into the renderer")
    }
    const file = resolve(this.paths.project, descriptor.path)
    assertNoLinkEscape(this.paths.root, file)
    const raw = await readSafeOrNull(this.paths.root, file)
    if (raw === null) return null
    const bytes = raw as Buffer
    if (bytes.byteLength !== descriptor.byteLength) {
      throw new VisualArtifactError("TRANSFER_SIZE_MISMATCH", "Visual artifact changed while it was being opened")
    }
    if (bytes.byteLength > maxBytes) {
      throw new VisualArtifactError("ARTIFACT_TOO_LARGE", `Visual preview exceeds ${maxBytes} bytes`)
    }
    return { descriptor, bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
  }

  /**
   * Promote the exact terminal `current.png` from a reviewed diff to its named
   * baseline. This is intentionally not a recapture: approval must publish the
   * pixels the human actually inspected, with the same target/environment/
   * redaction identity that produced the diff.
   */
  async approveRunCurrent(runId: string, expected: VisualApprovalExpectation): Promise<VisualApprovalResult> {
    if (!isValidSnapEyeRunId(runId)) {
      throw new VisualArtifactError("INVALID_RUN_ID", `Invalid SnapEye run id: ${JSON.stringify(runId)}`)
    }
    if (!isVisualApprovalExpectation(expected)) {
      throw new VisualArtifactError("INVALID_ARTIFACT", "Visual approval requires SHA-256 fingerprints for the reviewed current, result, and complete baseline state")
    }
    const resultPath = runFilePath(this.paths, runId, SNAPEYE_ARTIFACTS.result)
    const reviewed = await this.runMutex(resultPath).run(async () => {
      const rawResult = await readSafeOrNull(this.paths.root, resultPath)
      if (rawResult === null) throw new VisualArtifactError("INVALID_RESULT", `SnapEye run ${runId} has no terminal result`)
      const resultBytes = rawResult as Buffer
      if (resultBytes.byteLength > HISTORY_JSON_MAX_BYTES) {
        throw new VisualArtifactError("INVALID_RESULT", `SnapEye run ${runId} terminal result exceeds the review limit`)
      }
      if (sha256(resultBytes) !== expected.resultSha256) {
        throw new VisualArtifactError("REVIEW_CHANGED", "The reviewed result.json changed after it was displayed")
      }
      let result: Record<string, unknown>
      try {
        result = JSON.parse(resultBytes.toString("utf8")) as Record<string, unknown>
      } catch {
        throw new VisualArtifactError("INVALID_RESULT", `SnapEye run ${runId} has malformed terminal JSON`)
      }
      if (validateSnapEyeResult(result, runId)) {
        throw new VisualArtifactError("INVALID_RESULT", `SnapEye run ${runId} has no valid terminal result`)
      }
      if (result.status !== "ok" || result.operation !== "diff" || !isValidSnapEyeName(result.name)) {
        throw new VisualArtifactError("INVALID_RESULT", "Only a successful visual_diff run can be approved as a baseline")
      }
      const artifacts = isPlainObject(result.artifacts) ? result.artifacts : undefined
      if (artifacts?.current !== SNAPEYE_ARTIFACTS.current) {
        throw new VisualArtifactError("INVALID_RESULT", "The reviewed diff did not publish current.png")
      }
      if (!isBaselineImageMetadata(result.image)) {
        throw new VisualArtifactError("INVALID_RESULT", "The reviewed diff is missing valid image metadata")
      }

      const currentPath = runFilePath(this.paths, runId, SNAPEYE_ARTIFACTS.current)
      assertNoLinkEscape(this.paths.root, currentPath)
      let handle
      try {
        handle = await openNoFollow(currentPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new VisualArtifactError("INVALID_ARTIFACT", "The reviewed current.png is missing")
        }
        throw error
      }
      let image: Buffer
      try {
        const entry = await handle.stat()
        if (!entry.isFile()) throw new VisualArtifactError("INVALID_ARTIFACT", "The reviewed current.png is not a regular file")
        if (entry.size > this.maxArtifactBytes) {
          throw new VisualArtifactError("ARTIFACT_TOO_LARGE", `Visual artifact exceeds ${this.maxArtifactBytes} bytes`)
        }
        image = await handle.readFile()
        if (image.byteLength !== entry.size) {
          throw new VisualArtifactError("TRANSFER_SIZE_MISMATCH", "The reviewed current.png changed while approval was in progress")
        }
      } finally {
        await handle.close().catch(() => undefined)
      }
      if (sha256(image) !== expected.currentSha256) {
        throw new VisualArtifactError("REVIEW_CHANGED", "The reviewed current.png changed after it was displayed")
      }
      return { result, image }
    })

    const result = reviewed.result
    const capturedAt = typeof result.finishedAt === "string" && Number.isFinite(Date.parse(result.finishedAt))
      ? result.finishedAt
      : new Date().toISOString()
    const meta: Record<string, unknown> = {
      schemaVersion: 1,
      name: result.name,
      capturedAt,
      ...(isPlainObject(result.target) ? { target: result.target } : {}),
      image: result.image,
      ...(isPlainObject(result.opencode) ? { opencode: result.opencode } : {}),
    }
    const writer = await this.beginBaselineWrite(result.name as string, meta, reviewed.image.byteLength, async () => {
      const imagePath = baselineFilePath(this.paths, result.name as string, ".png")
      const metadataPath = baselineFilePath(this.paths, result.name as string, ".json")
      const rawImage = await readSafeOrNull(this.paths.root, imagePath)
      const rawMetadata = await readSafeOrNull(this.paths.root, metadataPath)
      if (rawImage === null || sha256(rawImage as Buffer) !== expected.baselineSha256) {
        throw new VisualArtifactError("REVIEW_CHANGED", "The baseline changed after it was reviewed; refresh the visual inspector before approving")
      }
      const metadataSha256 = rawMetadata === null ? null : sha256(rawMetadata as Buffer)
      if (metadataSha256 !== expected.baselineMetadataSha256) {
        throw new VisualArtifactError("REVIEW_CHANGED", "The baseline metadata changed after it was reviewed; refresh the visual inspector before approving")
      }
    })
    try {
      await writer.write(reviewed.image)
      await writer.commit()
    } catch (error) {
      await writer.abort()
      throw error
    }
    const baseline = await this.describeBaselineSummary(result.name as string)
    if (!baseline) throw new VisualArtifactError("BASELINE_INTEGRITY", "Approved baseline was not readable after commit")
    return { baseline, sourceRunId: runId }
  }

  private async listBaselines(limit: number): Promise<VisualBaselineSummary[]> {
    const entries = await readdir(this.paths.baselines, { withFileTypes: true })
    const candidates = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".png"))
    const scanned = await mapConcurrent(candidates, HISTORY_IO_CONCURRENCY, async (entry): Promise<(VisualBaselineSummary & { at: number }) | null> => {
      const name = entry.name.slice(0, -4)
      return isValidSnapEyeName(name) ? this.describeBaselineSummary(name, true) : null
    })
    const rows = scanned.filter((row): row is VisualBaselineSummary & { at: number } => row !== null)
    rows.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
    return rows.slice(0, limit).map(({ at: _at, ...row }) => row)
  }

  private async describeBaselineSummary(name: string, includeSortTime: true): Promise<(VisualBaselineSummary & { at: number }) | null>
  private async describeBaselineSummary(name: string, includeSortTime?: false): Promise<VisualBaselineSummary | null>
  private async describeBaselineSummary(
    name: string,
    includeSortTime = false,
  ): Promise<(VisualBaselineSummary & { at?: number }) | null> {
    if (!isValidSnapEyeName(name)) return null
    const imagePath = baselineFilePath(this.paths, name, ".png")
    assertNoLinkEscape(this.paths.root, imagePath)
    const metadataPath = baselineFilePath(this.paths, name, ".json")
    const [imageStat, metadata, metadataStat] = await Promise.all([
      lstat(imagePath).catch(() => null),
      readBoundedJsonObject(this.paths.root, metadataPath, HISTORY_JSON_MAX_BYTES),
      lstat(metadataPath).catch(() => null),
    ])
    if (!imageStat?.isFile() || imageStat.isSymbolicLink()) return null
    const commitCandidate = metadata?.[BASELINE_COMMIT_KEY]
    const rawCommit = isPlainObject(commitCandidate) && commitCandidate.format === BASELINE_COMMIT_FORMAT
      ? commitCandidate as unknown as BaselineCommit
      : null
    if (rawCommit?.state === "pending") return null
    if (rawCommit?.state === "committed" && (!isValidCommittedBaseline(rawCommit) || rawCommit.image?.byteLength !== imageStat.size)) return null
    const capturedAt = typeof metadata?.capturedAt === "string" ? metadata.capturedAt : undefined
    const opencode = isPlainObject(metadata?.opencode) ? metadata.opencode : undefined
    const row: VisualBaselineSummary & { at?: number } = {
      name,
      imagePath: this.relativeProjectPath(imagePath),
      ...(metadataStat?.isFile() && !metadataStat.isSymbolicLink() ? { metadataPath: this.relativeProjectPath(metadataPath) } : {}),
      byteLength: imageStat.size,
      ...(capturedAt ? { capturedAt } : {}),
      ...(opencode?.lane === "webview" || opencode?.lane === "extension" ? { lane: opencode.lane } : {}),
      ...(typeof opencode?.engineMajor === "number" && Number.isFinite(opencode.engineMajor) ? { engineMajor: opencode.engineMajor } : {}),
      ...(typeof opencode?.redactionPolicySha256 === "string" ? { redactionPolicySha256: opencode.redactionPolicySha256 } : {}),
    }
    if (includeSortTime) row.at = capturedAt && Number.isFinite(Date.parse(capturedAt)) ? Date.parse(capturedAt) : imageStat.mtimeMs
    return row
  }

  private async listTerminalRuns(limit: number): Promise<VisualRunSummary[]> {
    const entries = await readdir(this.paths.runs, { withFileTypes: true })
    const candidates = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isValidSnapEyeRunId(entry.name))
    const scanned = await mapConcurrent(candidates, HISTORY_IO_CONCURRENCY, async (entry): Promise<(VisualRunSummary & { at: number }) | null> => {
      const resultPath = runFilePath(this.paths, entry.name, SNAPEYE_ARTIFACTS.result)
      const dir = dirname(resultPath)
      const [result, dirStat] = await Promise.all([
        readBoundedJsonObject(this.paths.root, resultPath, HISTORY_JSON_MAX_BYTES),
        lstat(dir).catch(() => null),
      ])
      if (!result || validateSnapEyeResult(result, entry.name)) return null
      if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) return null
      const finishedAt = typeof result.finishedAt === "string" ? result.finishedAt : undefined
      const at = finishedAt && Number.isFinite(Date.parse(finishedAt)) ? Date.parse(finishedAt) : dirStat.mtimeMs
      const diff = isPlainObject(result.diff) ? result.diff : undefined
      const record = isPlainObject(result.record) ? result.record : undefined
      return {
        runId: entry.name,
        resultPath: this.relativeProjectPath(resultPath),
        status: result.status as "ok" | "error",
        operation: result.operation as VisualRunSummary["operation"],
        ...(typeof result.name === "string" ? { name: result.name } : {}),
        ...(finishedAt ? { finishedAt } : {}),
        ...(typeof diff?.changed === "boolean" ? { changed: diff.changed } : {}),
        ...(typeof record?.frameCount === "number" && Number.isFinite(record.frameCount) ? { frameCount: record.frameCount } : {}),
        artifacts: summarizeArtifactKinds(result),
        at,
      }
    })
    const rows = scanned.filter((row): row is VisualRunSummary & { at: number } => row !== null)
    rows.sort((a, b) => b.at - a.at || (a.runId < b.runId ? 1 : -1))
    return rows.slice(0, limit).map(({ at: _at, ...row }) => row)
  }

  private async describeSafeFile(file: string, kind: VisualArtifactKind, mime: string): Promise<VisualArtifactDescriptor | null> {
    assertNoLinkEscape(this.paths.root, file)
    const entry = await lstat(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    })
    if (!entry) return null
    if (!entry.isFile() || entry.isSymbolicLink()) throw new VisualArtifactError("INVALID_PATH", `Expected regular visual artifact: ${file}`)
    if (entry.size > this.maxArtifactBytes) {
      throw new VisualArtifactError("ARTIFACT_TOO_LARGE", `Visual artifact exceeds ${this.maxArtifactBytes} bytes`)
    }
    return { kind, path: this.relativeProjectPath(file), mime, byteLength: entry.size }
  }

  private relativeProjectPath(file: string): string {
    const value = relative(this.paths.project, file).replace(/\\/g, "/")
    if (!value || value.startsWith("../") || value === "..") throw new VisualArtifactError("INVALID_PATH", `Artifact escaped project: ${file}`)
    return value
  }

  private async readVerifiedBaseline(name: string): Promise<{
    meta: Record<string, unknown> | null
    image: Buffer
    byteLength: number
  } | null> {
    const imagePath = baselineFilePath(this.paths, name, ".png")
    const metadataPath = baselineFilePath(this.paths, name, ".json")
    const serialized = await readSafeOrNull(this.paths.root, metadataPath, "utf8")
    const stored = parseBaselineMetadata(serialized as string | null, name)
    if (stored.commit?.state === "pending") {
      throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} replacement did not reach its commit marker`)
    }
    const image = await readSafeOrNull(this.paths.root, imagePath)
    if (image === null) {
      if (stored.commit) throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} committed image is missing`)
      return null
    }
    const confirmed = await readSafeOrNull(this.paths.root, metadataPath, "utf8")
    if (confirmed !== serialized) {
      throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} metadata changed during read`)
    }
    const bytes = image as Buffer
    if (bytes.byteLength > this.maxArtifactBytes) {
      throw new VisualArtifactError("ARTIFACT_TOO_LARGE", `Baseline ${JSON.stringify(name)} exceeds ${this.maxArtifactBytes} bytes`)
    }
    if (stored.commit?.state === "committed") verifyBaselineCommit(name, bytes, stored.commit)
    return { meta: stored.meta, image: bytes, byteLength: bytes.byteLength }
  }

  private async assertRunOpen(resultPath: string, runId: string): Promise<void> {
    assertNoLinkEscape(this.paths.root, resultPath)
    try {
      const entry = await lstat(resultPath)
      if (entry) throw new VisualArtifactError("RUN_ALREADY_TERMINAL", `SnapEye run ${runId} is already terminal`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }

  private assertExpectedBytes(expectedBytes: number | undefined): void {
    if (expectedBytes === undefined) return
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new RangeError("expectedBytes must be a non-negative safe integer")
    if (expectedBytes > this.maxArtifactBytes) {
      throw new VisualArtifactError("ARTIFACT_TOO_LARGE", `Artifact declares ${expectedBytes} bytes; limit is ${this.maxArtifactBytes}`)
    }
  }

  private assertWriteBudget(written: number, incoming: number, expectedBytes: number | undefined): void {
    if (incoming < 0 || !Number.isSafeInteger(incoming)) throw new RangeError("Invalid chunk size")
    const next = written + incoming
    if (!Number.isSafeInteger(next) || next > this.maxArtifactBytes || (expectedBytes !== undefined && next > expectedBytes)) {
      throw new VisualArtifactError("ARTIFACT_TOO_LARGE", `Artifact write exceeded its declared/host byte budget`)
    }
  }

  private assertTransferComplete(written: number, expectedBytes: number | undefined): void {
    if (expectedBytes !== undefined && written !== expectedBytes) {
      throw new VisualArtifactError("TRANSFER_SIZE_MISMATCH", `Expected ${expectedBytes} artifact bytes but received ${written}`)
    }
  }

  private baselineMutex(path: string): Mutex {
    let mutex = baselineLocks.get(path)
    if (!mutex) {
      mutex = new Mutex(() => baselineLocks.delete(path))
      baselineLocks.set(path, mutex)
    }
    return mutex
  }

  private runMutex(path: string): Mutex {
    let mutex = runLocks.get(path)
    if (!mutex) {
      mutex = new Mutex(() => runLocks.delete(path))
      runLocks.set(path, mutex)
    }
    return mutex
  }

  private pruneMutex(): Mutex {
    let mutex = pruneLocks.get(this.paths.runs)
    if (!mutex) {
      mutex = new Mutex(() => pruneLocks.delete(this.paths.runs))
      pruneLocks.set(this.paths.runs, mutex)
    }
    return mutex
  }

  private async ensureGitignore(): Promise<void> {
    const path = join(this.paths.root, ".gitignore")
    assertNoLinkEscape(this.paths.root, path)
    const existing = await readSafeOrNull(this.paths.root, path, "utf8")
    const text = (existing as string | null) ?? ""
    const present = new Set(text.split(/\r?\n/).map((line) => line.trim()))
    const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry))
    if (missing.length === 0) return
    const prefix = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`
    await writeFileAtomic(this.paths.root, path, `${prefix}${missing.join("\n")}\n`)
  }
}

const boundedListLimit = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("history list limit must be a positive safe integer")
  return Math.min(value, maximum)
}

const mapConcurrent = async <T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const count = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  }))
  return results
}

const readBoundedJsonObject = async (
  root: string,
  file: string,
  maxBytes: number,
): Promise<Record<string, unknown> | null> => {
  assertNoLinkEscape(root, file)
  let handle
  try {
    handle = await openNoFollow(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  try {
    const entry = await handle.stat()
    if (!entry.isFile()) throw new VisualArtifactError("INVALID_PATH", `Expected regular JSON artifact: ${file}`)
    if (entry.size > maxBytes) return null
    try {
      const value = JSON.parse(await handle.readFile({ encoding: "utf8" }))
      return isPlainObject(value) ? value : null
    } catch {
      return null
    }
  } finally {
    await handle.close()
  }
}

const summarizeArtifactKinds = (result: Record<string, unknown>): VisualArtifactKind[] => {
  const artifacts = isPlainObject(result.artifacts) ? result.artifacts : undefined
  const kinds: VisualArtifactKind[] = ["result"]
  if (!artifacts) return kinds
  if (typeof artifacts.current === "string") kinds.push("current")
  if (typeof artifacts.svg === "string") kinds.push("svg")
  if (typeof artifacts.diff === "string") kinds.push("diff")
  if (typeof artifacts.frames === "string") kinds.push("frames")
  if (typeof artifacts.gif === "string") kinds.push("gif")
  if (typeof artifacts.video === "string") kinds.push("video")
  return kinds
}

const resolveVideoFilenameFromResult = (result: Record<string, unknown>): string | null => {
  const artifacts = isPlainObject(result.artifacts) ? result.artifacts : undefined
  const video = typeof artifacts?.video === "string" ? artifacts.video : undefined
  return video === SNAPEYE_ARTIFACTS.webm || video === SNAPEYE_ARTIFACTS.mp4 ? video : null
}

const isBaselineImageMetadata = (value: unknown): value is Record<string, unknown> => {
  if (!isPlainObject(value) || value.coordinateSpace !== "target-css-px") return false
  for (const key of ["cssWidth", "cssHeight", "pixelWidth", "pixelHeight", "scale"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0) return false
  }
  return true
}

const mimeForArtifact = (filename: string): string => {
  if (filename.endsWith(".png")) return "image/png"
  if (filename.endsWith(".svg")) return "image/svg+xml"
  if (filename.endsWith(".gif")) return "image/gif"
  if (filename.endsWith(".webm")) return "video/webm"
  if (filename.endsWith(".mp4")) return "video/mp4"
  if (filename.endsWith(".json")) return "application/json"
  return "application/octet-stream"
}

class Mutex {
  private locked = false
  private readonly waiters: Array<() => void> = []
  private users = 0

  constructor(private readonly onIdle: () => void) {}

  async acquire(): Promise<() => void> {
    this.users++
    if (this.locked) await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.locked = true
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.locked = false
      this.users--
      if (this.users === 0 && this.waiters.length === 0 && !this.locked) this.onIdle()
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await work()
    } finally {
      release()
    }
  }
}

const parseBaselineMetadata = (serialized: string | null, name: string): ParsedBaselineMetadata => {
  if (serialized === null) return { meta: null, commit: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return { meta: null, commit: null }
  }
  if (!isPlainObject(parsed)) return { meta: null, commit: null }
  const candidate = parsed[BASELINE_COMMIT_KEY]
  if (!isPlainObject(candidate) || candidate.format !== BASELINE_COMMIT_FORMAT) return { meta: parsed, commit: null }
  if (candidate.state !== "pending" && candidate.state !== "committed") {
    throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} commit marker is malformed`)
  }
  const commit = candidate as unknown as BaselineCommit
  if (commit.state === "committed" && !isValidCommittedBaseline(commit)) {
    throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} commit marker is malformed`)
  }
  const meta = { ...parsed }
  delete meta[BASELINE_COMMIT_KEY]
  if (commit.publicMetadata?.hadCommitKey === true) meta[BASELINE_COMMIT_KEY] = commit.publicMetadata.value
  return { meta, commit }
}

const isValidCommittedBaseline = (commit: BaselineCommit): boolean =>
  typeof commit.generation === "string" &&
  commit.generation.length > 0 &&
  commit.image?.algorithm === "sha256" &&
  typeof commit.image.digest === "string" &&
  /^[a-f0-9]{64}$/.test(commit.image.digest) &&
  Number.isSafeInteger(commit.image.byteLength) &&
  commit.image.byteLength >= 0

const verifyBaselineCommit = (name: string, image: Buffer, commit: BaselineCommit): void => {
  if (!commit.image) throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} commit marker is incomplete`)
  const digest = createHash("sha256").update(image).digest("hex")
  if (image.byteLength !== commit.image.byteLength || digest !== commit.image.digest) {
    throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} image does not match its commit marker`)
  }
}

const verifyBaselineHandle = async (
  name: string,
  handle: Awaited<ReturnType<typeof open>>,
  byteLength: number,
  commit: BaselineCommit,
): Promise<void> => {
  if (!commit.image || commit.image.byteLength !== byteLength) {
    throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} image does not match its commit marker`)
  }
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, byteLength)))
  let offset = 0
  while (offset < byteLength) {
    const length = Math.min(buffer.byteLength, byteLength - offset)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    if (bytesRead <= 0) {
      throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} ended before its committed byte length`)
    }
    hash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  if (hash.digest("hex") !== commit.image.digest) {
    throw new VisualArtifactError("BASELINE_INTEGRITY", `SnapEye baseline ${JSON.stringify(name)} image does not match its commit marker`)
  }
}

const serializeJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const toBytes = (value: Uint8Array | ArrayBuffer): Buffer => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  throw new TypeError("Expected binary artifact data")
}

const SHA256_RE = /^[a-f0-9]{64}$/
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex")
const isVisualApprovalExpectation = (value: unknown): value is VisualApprovalExpectation =>
  isPlainObject(value) &&
  typeof value.currentSha256 === "string" && SHA256_RE.test(value.currentSha256) &&
  typeof value.resultSha256 === "string" && SHA256_RE.test(value.resultSha256) &&
  typeof value.baselineSha256 === "string" && SHA256_RE.test(value.baselineSha256) &&
  (value.baselineMetadataSha256 === null ||
    (typeof value.baselineMetadataSha256 === "string" && SHA256_RE.test(value.baselineMetadataSha256)))

const writeFileAtomic = async (root: string, file: string, data: string | Uint8Array): Promise<void> => {
  await ensureSafeParent(root, file)
  const temp = join(dirname(file), `.${randomUUID()}.tmp`)
  assertNoLinkEscape(root, temp)
  try {
    await writeFile(temp, data, { flag: "wx" })
    assertNoLinkEscape(root, file)
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

const writeFileAtomicOnce = async (root: string, file: string, data: string | Uint8Array): Promise<void> => {
  await ensureSafeParent(root, file)
  const temp = join(dirname(file), `.${randomUUID()}.tmp`)
  assertNoLinkEscape(root, temp)
  try {
    await writeFile(temp, data, { flag: "wx" })
    assertNoLinkEscape(root, file)
    await link(temp, file)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

const openNoFollow = async (file: string) => {
  try {
    return await open(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new VisualArtifactError("INVALID_PATH", `Refused to follow symbolic link: ${file}`)
    }
    throw error
  }
}

const readSafeOrNull = async (root: string, file: string, encoding?: "utf8"): Promise<Buffer | string | null> => {
  assertNoLinkEscape(root, file)
  let handle
  try {
    handle = await openNoFollow(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  try {
    const entry = await handle.stat()
    if (!entry.isFile()) throw new VisualArtifactError("INVALID_PATH", `Expected regular file: ${file}`)
    return encoding ? await handle.readFile({ encoding }) : await handle.readFile()
  } finally {
    await handle.close()
  }
}
