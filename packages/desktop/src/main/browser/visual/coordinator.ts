import { randomBytes, randomUUID } from "node:crypto"
import type { BrowserDispatchContext, VisualRedaction } from "../contracts"
import {
  SNAPEYE_ARTIFACTS,
  SNAPEYE_RUN_ARTIFACTS,
  VisualArtifactError,
  generateSnapEyeRunId,
  isPlainObject,
  isValidSnapEyeName,
  isValidSnapEyeRunId,
  type SnapEyeOperation,
  type SnapEyeResult,
} from "./protocol"
import {
  OpenCodeSnapEyeStore,
  type VisualApprovalResult,
  type VisualApprovalExpectation,
  type VisualArtifactDescriptor,
  type VisualArtifactPayload,
  type VisualHistorySnapshot,
  type VisualReadHandle,
  type VisualWriteHandle,
} from "./store"
import {
  EMPTY_VISUAL_REDACTION_SHA256,
  digestNormalizedVisualRedaction,
  normalizeVisualRedaction,
  type NormalizedVisualRedaction,
} from "./redaction"

export type VisualLane = "webview" | "extension"

export interface VisualEnvironmentFingerprint {
  schemaVersion: 1
  lane: VisualLane
  platform: NodeJS.Platform
  engine: "chromium"
  engineMajor?: number
  appearance?: "system" | "light" | "dark"
  snapeyeVersion?: string
  snapdomVersion?: string
  redactionPolicySha256?: string
}

export interface BeginVisualTransactionInput {
  context: BrowserDispatchContext
  lane: VisualLane
  tabId: string
  operation: SnapEyeOperation
  name: string
  runId?: string
  redaction?: VisualRedaction
  environment: Omit<VisualEnvironmentFingerprint, "schemaVersion" | "lane" | "platform" | "engine">
}

export interface VisualTransactionGrant {
  capability: string
  runId: string
  expiresAt: number
  maxChunkBytes: number
  redaction: NormalizedVisualRedaction
}

interface CapabilityRecord {
  token: string
  requestId: string
  context: BrowserDispatchContext
  lane: VisualLane
  tabId: string
  operation: SnapEyeOperation
  name: string
  runId: string
  environment: VisualEnvironmentFingerprint
  expiresAt: number
  maxChunkBytes: number
  byteBudget: number
  transferredBytes: number
  allowedArtifacts: ReadonlySet<string>
  store: OpenCodeSnapEyeStore
  reads: Map<string, ReadTransfer>
  writes: Map<string, WriteTransfer>
  abortListener?: () => void
  terminal: boolean
}

interface ReadTransfer {
  id: string
  kind: "baseline"
  handle: VisualReadHandle
  offset: number
}

interface WriteTransfer {
  id: string
  kind: "baseline" | "run"
  handle: VisualWriteHandle
  offset: number
}

export interface VisualCoordinatorOptions {
  extensionChunkBytes?: number
  webviewChunkBytes?: number
  captureByteBudget?: number
  diffByteBudget?: number
  recordByteBudget?: number
  maxArtifactBytes?: number
  now?: () => number
}

export class VisualCapabilityError extends Error {
  constructor(
    public readonly code:
      | "VISUAL_CONTEXT_REQUIRED"
      | "VISUAL_CAPABILITY_INVALID"
      | "VISUAL_CAPABILITY_EXPIRED"
      | "VISUAL_CAPABILITY_ABORTED"
      | "VISUAL_SCOPE_VIOLATION"
      | "VISUAL_TRANSFER_INVALID"
      | "VISUAL_TRANSFER_OFFSET"
      | "VISUAL_BYTE_BUDGET_EXCEEDED"
      | "VISUAL_ENVIRONMENT_MISMATCH",
    message: string,
  ) {
    super(message)
    this.name = "VisualCapabilityError"
  }
}

/**
 * Desktop authority for SnapEye visual transactions.
 *
 * This class intentionally exposes logical artifact operations rather than a
 * path API. A capability is bound to one broker request, tab, operation,
 * baseline name and run id; even a compromised page that learns the token
 * cannot choose another project path or arbitrary filename.
 */
export class VisualObservationCoordinator {
  private readonly capabilities = new Map<string, CapabilityRecord>()
  private readonly requestCapabilities = new Map<string, string>()
  private readonly stores = new Map<string, Promise<OpenCodeSnapEyeStore>>()
  private readonly now: () => number
  private readonly extensionChunkBytes: number
  private readonly webviewChunkBytes: number
  private readonly budgets: Record<SnapEyeOperation, number>
  private readonly maxArtifactBytes?: number

  constructor(options: VisualCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now
    this.extensionChunkBytes = positiveSafe(options.extensionChunkBytes ?? 384 * 1024, "extensionChunkBytes")
    this.webviewChunkBytes = positiveSafe(options.webviewChunkBytes ?? 2 * 1024 * 1024, "webviewChunkBytes")
    this.budgets = {
      capture: positiveSafe(options.captureByteBudget ?? 128 * 1024 * 1024, "captureByteBudget"),
      diff: positiveSafe(options.diffByteBudget ?? 256 * 1024 * 1024, "diffByteBudget"),
      record: positiveSafe(options.recordByteBudget ?? 256 * 1024 * 1024, "recordByteBudget"),
    }
    if (options.maxArtifactBytes !== undefined) this.maxArtifactBytes = positiveSafe(options.maxArtifactBytes, "maxArtifactBytes")
  }

  async begin(input: BeginVisualTransactionInput): Promise<VisualTransactionGrant> {
    const { context } = input
    if (!context.directory || !context.sessionId || !context.requestId || !input.tabId) {
      throw new VisualCapabilityError(
        "VISUAL_CONTEXT_REQUIRED",
        "Visual operations require an agent-owned broker request with a trusted project directory and tab",
      )
    }
    if (!isValidSnapEyeName(input.name)) {
      throw new VisualArtifactError("INVALID_NAME", `Invalid SnapEye baseline name: ${JSON.stringify(input.name)}`)
    }
    const runId = input.runId ?? generateSnapEyeRunId(this.now())
    if (!isValidSnapEyeRunId(runId)) {
      throw new VisualArtifactError("INVALID_RUN_ID", `Invalid SnapEye run id: ${JSON.stringify(runId)}`)
    }
    if (context.signal?.aborted) {
      throw new VisualCapabilityError("VISUAL_CAPABILITY_ABORTED", "Visual request was aborted before it started")
    }
    if (this.requestCapabilities.has(context.requestId)) {
      throw new VisualCapabilityError("VISUAL_SCOPE_VIOLATION", `Request ${context.requestId} already owns a visual transaction`)
    }

    const store = await this.storeFor(context.directory)
    const token = randomBytes(24).toString("base64url")
    const expiresAt = this.now() + context.timeoutMs
    const redaction = normalizeVisualRedaction(input.redaction)
    const environment: VisualEnvironmentFingerprint = {
      schemaVersion: 1,
      lane: input.lane,
      platform: process.platform,
      engine: "chromium",
      ...input.environment,
      // Always present for OpenCode-created baselines, including the empty
      // policy. This lets a later diff distinguish "no redaction" from a
      // different censoring policy instead of silently comparing unlike images.
      redactionPolicySha256: digestNormalizedVisualRedaction(redaction),
    }
    const record: CapabilityRecord = {
      token,
      requestId: context.requestId,
      context,
      lane: input.lane,
      tabId: input.tabId,
      operation: input.operation,
      name: input.name,
      runId,
      environment,
      expiresAt,
      maxChunkBytes: input.lane === "extension" ? this.extensionChunkBytes : this.webviewChunkBytes,
      byteBudget: this.budgets[input.operation],
      transferredBytes: 0,
      allowedArtifacts: allowedArtifacts(input.operation),
      store,
      reads: new Map(),
      writes: new Map(),
      terminal: false,
    }
    if (context.signal) {
      const abortListener = () => void this.abort(token)
      record.abortListener = abortListener
      context.signal.addEventListener("abort", abortListener, { once: true })
    }
    this.capabilities.set(token, record)
    this.requestCapabilities.set(context.requestId, token)
    return { capability: token, runId, expiresAt, maxChunkBytes: record.maxChunkBytes, redaction }
  }

  async baselineReadOpen(capability: string, name: string): Promise<{
    readId: string
    byteLength: number
    meta: Record<string, unknown> | null
    maxChunkBytes: number
  } | null> {
    const record = this.require(capability)
    this.assertScopeName(record, name)
    if (record.operation !== "diff") {
      throw new VisualCapabilityError("VISUAL_SCOPE_VIOLATION", "Only visual_diff may read a baseline")
    }
    // Diff streams the entire baseline to the browser anyway. Verify the
    // committed SHA-256 incrementally over those exact bytes so a large
    // baseline is read from disk once rather than once for verification and a
    // second time for transport. baselineReadClose() is the integrity barrier.
    const handle = await record.store.openBaselineRead(name, { verifyWhileReading: true })
    if (!handle) return null
    try {
      this.assertEnvironmentCompatible(record, handle.meta)
      this.assertBudget(record, handle.byteLength)
    } catch (error) {
      await handle.close()
      throw error
    }
    const readId = randomUUID()
    record.reads.set(readId, { id: readId, kind: "baseline", handle, offset: 0 })
    return { readId, byteLength: handle.byteLength, meta: handle.meta, maxChunkBytes: record.maxChunkBytes }
  }

  async baselineReadChunk(capability: string, readId: string, offset: number, length: number): Promise<Uint8Array> {
    const record = this.require(capability)
    const transfer = record.reads.get(readId)
    if (!transfer) throw new VisualCapabilityError("VISUAL_TRANSFER_INVALID", `Unknown visual read transfer ${readId}`)
    if (offset !== transfer.offset) {
      throw new VisualCapabilityError("VISUAL_TRANSFER_OFFSET", `Expected read offset ${transfer.offset}, received ${offset}`)
    }
    if (!Number.isSafeInteger(length) || length < 0 || length > record.maxChunkBytes) {
      throw new VisualCapabilityError("VISUAL_TRANSFER_INVALID", `Read length must be 0..${record.maxChunkBytes}`)
    }
    const bytes = await transfer.handle.read(offset, length)
    this.consumeBudget(record, bytes.byteLength)
    transfer.offset += bytes.byteLength
    return bytes
  }

  async baselineReadClose(capability: string, readId: string): Promise<void> {
    const record = this.require(capability)
    const transfer = record.reads.get(readId)
    if (!transfer) return
    record.reads.delete(readId)
    await transfer.handle.close()
  }

  async baselineWriteBegin(
    capability: string,
    name: string,
    meta: Record<string, unknown> | null,
    totalBytes: number,
  ): Promise<{ writeId: string; maxChunkBytes: number }> {
    const record = this.require(capability)
    this.assertScopeName(record, name)
    if (record.operation !== "capture") {
      throw new VisualCapabilityError("VISUAL_SCOPE_VIOLATION", "Only visual_capture may replace a baseline")
    }
    this.assertBudget(record, totalBytes)
    const enrichedMeta = meta === null ? null : { ...meta, opencode: record.environment }
    const handle = await record.store.beginBaselineWrite(name, enrichedMeta, totalBytes)
    const writeId = randomUUID()
    record.writes.set(writeId, { id: writeId, kind: "baseline", handle, offset: 0 })
    return { writeId, maxChunkBytes: record.maxChunkBytes }
  }

  async runWriteBegin(
    capability: string,
    runId: string,
    filename: string,
    totalBytes: number,
  ): Promise<{ writeId: string; maxChunkBytes: number }> {
    const record = this.require(capability)
    this.assertScopeRun(record, runId)
    if (!record.allowedArtifacts.has(filename) || !SNAPEYE_RUN_ARTIFACTS.has(filename)) {
      throw new VisualCapabilityError("VISUAL_SCOPE_VIOLATION", `Artifact ${JSON.stringify(filename)} is not allowed for ${record.operation}`)
    }
    this.assertBudget(record, totalBytes)
    const handle = await record.store.beginRunArtifactWrite(runId, filename, totalBytes)
    const writeId = randomUUID()
    record.writes.set(writeId, { id: writeId, kind: "run", handle, offset: 0 })
    return { writeId, maxChunkBytes: record.maxChunkBytes }
  }

  async writeChunk(capability: string, writeId: string, offset: number, bytes: Uint8Array): Promise<{ offset: number }> {
    const record = this.require(capability)
    const transfer = record.writes.get(writeId)
    if (!transfer) throw new VisualCapabilityError("VISUAL_TRANSFER_INVALID", `Unknown visual write transfer ${writeId}`)
    if (offset !== transfer.offset) {
      throw new VisualCapabilityError("VISUAL_TRANSFER_OFFSET", `Expected write offset ${transfer.offset}, received ${offset}`)
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > record.maxChunkBytes) {
      throw new VisualCapabilityError("VISUAL_TRANSFER_INVALID", `Write chunk must be at most ${record.maxChunkBytes} bytes`)
    }
    this.assertBudget(record, bytes.byteLength)
    await transfer.handle.write(bytes)
    this.consumeBudget(record, bytes.byteLength)
    transfer.offset += bytes.byteLength
    return { offset: transfer.offset }
  }

  async writeCommit(capability: string, writeId: string): Promise<void> {
    const record = this.require(capability)
    const transfer = record.writes.get(writeId)
    if (!transfer) throw new VisualCapabilityError("VISUAL_TRANSFER_INVALID", `Unknown visual write transfer ${writeId}`)
    await transfer.handle.commit()
    record.writes.delete(writeId)
  }

  async writeAbort(capability: string, writeId: string): Promise<void> {
    const record = this.require(capability)
    const transfer = record.writes.get(writeId)
    if (!transfer) return
    record.writes.delete(writeId)
    await transfer.handle.abort()
  }

  async resultCommit(capability: string, runId: string, result: SnapEyeResult): Promise<SnapEyeResult> {
    const record = this.require(capability)
    this.assertScopeRun(record, runId)
    if (record.reads.size > 0 || record.writes.size > 0) {
      throw new VisualCapabilityError("VISUAL_SCOPE_VIOLATION", "Visual result cannot commit while artifact transfers are open")
    }
    if (!isPlainObject(result) || result.operation !== record.operation || result.name !== record.name) {
      throw new VisualCapabilityError("VISUAL_SCOPE_VIOLATION", "Visual result does not match the capability operation/name")
    }
    const enriched = { ...result, opencode: record.environment } as SnapEyeResult
    await record.store.commitResult(runId, enriched)
    record.terminal = true
    await this.dispose(record, false)
    return enriched
  }

  async abort(capability: string): Promise<void> {
    const record = this.capabilities.get(capability)
    if (!record) return
    await this.dispose(record, true)
  }

  async abortRequest(requestId: string): Promise<void> {
    const token = this.requestCapabilities.get(requestId)
    if (token) await this.abort(token)
  }

  async stop(): Promise<void> {
    await Promise.all([...this.capabilities.keys()].map((token) => this.abort(token)))
    this.stores.clear()
  }

  get activeCount(): number {
    return this.capabilities.size
  }

  async history(
    context: BrowserDispatchContext,
    options: { maxRuns?: number; maxBaselines?: number } = {},
  ): Promise<VisualHistorySnapshot> {
    const directory = this.requireProjectContext(context)
    return (await this.storeFor(directory)).listHistory(options)
  }

  async artifact(
    context: BrowserDispatchContext,
    input:
      | { source: "baseline"; name: string; artifact?: "image" | "metadata" }
      | { source: "run"; runId: string; artifact: "current" | "svg" | "diff" | "frames" | "gif" | "video" | "result" },
  ): Promise<VisualArtifactDescriptor | null> {
    const directory = this.requireProjectContext(context)
    return (await this.storeFor(directory)).describeArtifact(input)
  }

  async artifactPreview(
    context: BrowserDispatchContext,
    input:
      | { source: "baseline"; name: string; artifact?: "image" | "metadata" }
      | { source: "run"; runId: string; artifact: "current" | "svg" | "diff" | "frames" | "gif" | "video" | "result" },
    maxBytes = 16 * 1024 * 1024,
  ): Promise<VisualArtifactPayload | null> {
    const directory = this.requireProjectContext(context)
    return (await this.storeFor(directory)).readArtifact(input, maxBytes)
  }

  async approveRun(context: BrowserDispatchContext, runId: string, expected: VisualApprovalExpectation): Promise<VisualApprovalResult> {
    const directory = this.requireProjectContext(context)
    return (await this.storeFor(directory)).approveRunCurrent(runId, expected)
  }

  private require(token: string): CapabilityRecord {
    const record = this.capabilities.get(token)
    if (!record || record.terminal) throw new VisualCapabilityError("VISUAL_CAPABILITY_INVALID", "Visual artifact capability is invalid or terminal")
    if (record.context.signal?.aborted) {
      void this.abort(token)
      throw new VisualCapabilityError("VISUAL_CAPABILITY_ABORTED", "Visual artifact capability was aborted")
    }
    if (this.now() > record.expiresAt) {
      void this.abort(token)
      throw new VisualCapabilityError("VISUAL_CAPABILITY_EXPIRED", "Visual artifact capability expired")
    }
    return record
  }

  private requireProjectContext(context: BrowserDispatchContext): string {
    if (!context.directory || !context.sessionId || !context.requestId) {
      throw new VisualCapabilityError(
        "VISUAL_CONTEXT_REQUIRED",
        "Visual artifact inspection requires a trusted project broker context",
      )
    }
    if (context.signal?.aborted) {
      throw new VisualCapabilityError("VISUAL_CAPABILITY_ABORTED", "Visual artifact inspection was aborted")
    }
    return context.directory
  }

  private assertScopeName(record: CapabilityRecord, name: string): void {
    if (name !== record.name) {
      throw new VisualCapabilityError("VISUAL_SCOPE_VIOLATION", `Capability is bound to baseline ${JSON.stringify(record.name)}`)
    }
  }

  private assertScopeRun(record: CapabilityRecord, runId: string): void {
    if (runId !== record.runId) {
      throw new VisualCapabilityError("VISUAL_SCOPE_VIOLATION", `Capability is bound to run ${JSON.stringify(record.runId)}`)
    }
  }

  private assertBudget(record: CapabilityRecord, incoming: number): void {
    if (!Number.isSafeInteger(incoming) || incoming < 0 || record.transferredBytes + incoming > record.byteBudget) {
      throw new VisualCapabilityError(
        "VISUAL_BYTE_BUDGET_EXCEEDED",
        `Visual transaction exceeded its ${record.byteBudget} byte transport budget`,
      )
    }
  }

  private consumeBudget(record: CapabilityRecord, bytes: number): void {
    this.assertBudget(record, bytes)
    record.transferredBytes += bytes
  }

  private assertEnvironmentCompatible(record: CapabilityRecord, meta: Record<string, unknown> | null): void {
    if (!meta) return
    const previous = meta.opencode
    if (!isPlainObject(previous) || previous.schemaVersion !== 1) return // ordinary upstream SnapEye baseline
    for (const key of ["lane", "platform", "engine", "engineMajor", "appearance", "snapeyeVersion", "snapdomVersion"] as const) {
      const left = previous[key]
      const right = record.environment[key]
      if (left === undefined || right === undefined) continue
      if (left !== right) {
        throw new VisualCapabilityError(
          "VISUAL_ENVIRONMENT_MISMATCH",
          `Baseline environment ${key}=${JSON.stringify(left)} does not match current ${JSON.stringify(right)}`,
        )
      }
    }
    // Baselines created by OpenCode before redaction-policy fingerprinting are
    // equivalent to the empty policy. Ordinary upstream SnapEye baselines have
    // no `opencode` envelope at all and remain intentionally admissible.
    const previousRedaction = typeof previous.redactionPolicySha256 === "string"
      ? previous.redactionPolicySha256
      : EMPTY_VISUAL_REDACTION_SHA256
    const currentRedaction = record.environment.redactionPolicySha256 ?? EMPTY_VISUAL_REDACTION_SHA256
    if (previousRedaction !== currentRedaction) {
      throw new VisualCapabilityError(
        "VISUAL_ENVIRONMENT_MISMATCH",
        "Baseline redaction policy does not match the current visual operation",
      )
    }
  }

  private async dispose(record: CapabilityRecord, abortTransfers: boolean): Promise<void> {
    this.capabilities.delete(record.token)
    if (this.requestCapabilities.get(record.requestId) === record.token) this.requestCapabilities.delete(record.requestId)
    if (record.abortListener && record.context.signal) record.context.signal.removeEventListener("abort", record.abortListener)
    const reads = [...record.reads.values()]
    const writes = [...record.writes.values()]
    record.reads.clear()
    record.writes.clear()
    await Promise.all(reads.map((transfer) => transfer.handle.close().catch(() => undefined)))
    if (abortTransfers) await Promise.all(writes.map((transfer) => transfer.handle.abort().catch(() => undefined)))
    else if (writes.length > 0) await Promise.all(writes.map((transfer) => transfer.handle.abort().catch(() => undefined)))
  }

  private storeFor(directory: string): Promise<OpenCodeSnapEyeStore> {
    // Directory came from trusted broker context. The store canonicalizes it;
    // keying by the input here only avoids repeated setup on the common path.
    let store = this.stores.get(directory)
    if (!store) {
      store = OpenCodeSnapEyeStore.create(directory, { ...(this.maxArtifactBytes ? { maxArtifactBytes: this.maxArtifactBytes } : {}) })
      this.stores.set(directory, store)
      void store.catch(() => this.stores.delete(directory))
    }
    return store
  }
}

const allowedArtifacts = (operation: SnapEyeOperation): ReadonlySet<string> => {
  if (operation === "capture") return new Set([SNAPEYE_ARTIFACTS.svg])
  if (operation === "diff") return new Set([SNAPEYE_ARTIFACTS.current, SNAPEYE_ARTIFACTS.diff, SNAPEYE_ARTIFACTS.svg])
  return new Set([SNAPEYE_ARTIFACTS.frames, SNAPEYE_ARTIFACTS.gif, SNAPEYE_ARTIFACTS.webm, SNAPEYE_ARTIFACTS.mp4])
}

const positiveSafe = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}
