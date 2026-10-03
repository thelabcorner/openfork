// Lifecycle-owned Claude Agent Runtime.
//
// One runtime owner per OpenCode instance. The Agent SDK is loaded lazily
// through an injected loader (fake fixtures in tests), each turn is a
// deterministic state machine with overall timeout, stall detection,
// cancellation, and disposal, and diagnostics are bounded and redacted.
// The runtime never sees credentials: child envs are stripped by env.ts.

import { spawnSync } from "node:child_process"
import { ClaudeDisposedError, ClaudeSdkUnavailableError, sanitizeDetail } from "./errors"
import { decodeTransportEvent, type ResultEvent, type RuntimeEventSink } from "./events"
import { buildChildEnv, type ChildEnv } from "./env"
import { defaultSdkLoader, resolveCliPath, type ClaudeSdkModuleShape } from "./availability"
import { isClaudeEffort } from "./models"
import { refreshClaudeSubscriptionModelsFromHandle } from "./model-discovery"
import {
  apiRetryDelayMs,
  classifyClaudeFailure,
  overloadedResultText,
  refusalText,
  resultErrorText,
} from "./failure"
import { shouldEnableClaudeFirstParty } from "@/plugin/shared"

// ── SDK port (fixture-friendly) ──

export interface SdkQueryRequest {
  /**
   * String prompt for single-shot queries, or a streaming-input iterable for
   * external tool continuation (user messages with tool_result blocks are
   * yielded between assistant turns). Passed through to sdk.query verbatim.
   */
  readonly prompt: string | AsyncIterable<unknown>
  readonly options: Record<string, unknown>
}

export interface SdkQueryHandle {
  readonly events: AsyncIterable<unknown>
  interrupt(): Promise<void>
  close(): void
  readonly pid?: number | undefined
  supportedModels?: () => Promise<unknown[]>
}

/**
 * SDK-independent shape for an in-process MCP tool. The actual Agent SDK
 * types stay behind the lazy loader so importing OpenCode never eagerly loads
 * the optional SDK or its MCP dependency graph.
 */
export interface SdkMcpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
  readonly handler: (args: unknown, extra: unknown) => Promise<unknown>
}

/** Loader returns the SDK module shape; called at most once per runtime. */
export type SdkLoader = () => Promise<ClaudeSdkModuleShape>

/**
 * Normalize an SDK query() result into a handle: the SDK returns an async
 * iterable with optional interrupt()/pid; fixtures may return either shape.
 */
export function normalizeQueryResult(raw: unknown): SdkQueryHandle {
  if (!raw || typeof raw !== "object") {
    throw new ClaudeSdkUnavailableError({ message: "Claude Agent SDK query() returned an unexpected result" })
  }
  const candidate = raw as {
    events?: unknown
    interrupt?: unknown
    close?: unknown
    return?: unknown
    pid?: unknown
    supportedModels?: unknown
    [Symbol.asyncIterator]?: unknown
  }
  const iterable =
    typeof candidate[Symbol.asyncIterator] === "function"
      ? (raw as AsyncIterable<unknown>)
      : candidate.events && typeof (candidate.events as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
        ? (candidate.events as AsyncIterable<unknown>)
        : undefined
  if (!iterable) {
    throw new ClaudeSdkUnavailableError({ message: "Claude Agent SDK query result is not a stream" })
  }
  return {
    events: iterable,
    interrupt: async () => {
      if (typeof candidate.interrupt === "function") await candidate.interrupt()
    },
    close: () => {
      if (typeof candidate.close === "function") candidate.close()
      else if (typeof candidate.return === "function") void Promise.resolve(candidate.return()).catch(() => {})
    },
    pid: typeof candidate.pid === "number" ? candidate.pid : undefined,
    supportedModels:
      typeof candidate.supportedModels === "function"
        ? () => Promise.resolve((candidate.supportedModels as () => Promise<unknown[]>).call(raw))
        : undefined,
  }
}

/** Create one SDK query through the validated module shape. */
export function createSdkQuery(sdk: ClaudeSdkModuleShape, request: SdkQueryRequest): SdkQueryHandle {
  if (typeof sdk.query !== "function") {
    throw new ClaudeSdkUnavailableError({ message: "Claude Agent SDK query() is unavailable" })
  }
  const raw = (sdk.query as (input: SdkQueryRequest) => unknown)(request)
  return normalizeQueryResult(raw)
}

// ── Process-tree cleanup ──

/** Kill a spawned CLI process tree; taskkill on Windows, group kill elsewhere. */
export function killProcessTree(pid: number | null | undefined, options: { force?: boolean } = {}): void {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      })
    } catch {
      // best-effort
    }
    return
  }
  const signal: NodeJS.Signals = options.force ? "SIGKILL" : "SIGTERM"
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal)
    } catch {
      // already gone
    }
  }
}

// ── Turn execution ──

export interface RuntimeTimeouts {
  /** Overall turn deadline. */
  readonly turnMs?: number
  /** Max silence between transport events before the turn is stalled. */
  readonly stallMs?: number
  /** Grace after interrupt() for Claude Code to record a clean interrupted turn. */
  readonly stopGraceMs?: number
}

export interface RuntimeOptions {
  readonly loader?: SdkLoader
  /** Injected tree killer (tests assert cleanup without real processes). */
  readonly killTree?: (pid: number, force?: boolean) => void
  readonly sink?: RuntimeEventSink
  readonly timeouts?: RuntimeTimeouts
  readonly env?: ChildEnv
  readonly cwd?: string
  /** Official `claude` CLI path; resolved from PATH when omitted. */
  readonly executablePath?: string
  readonly turnIDPrefix?: string
  /**
   * Rollback gate; defaults to the migration lane's
   * shouldEnableClaudeFirstParty() (plugin/shared). Injectable so fixtures
   * never touch process.env.
   */
  readonly enabled?: () => boolean
}

export interface TurnRequest {
  /** Plain prompt, or a streaming-input iterable fed tool results mid-turn. */
  readonly prompt: string | AsyncIterable<unknown>
  readonly model?: string
  readonly effort?: string
  readonly resume?: string
  /** Pin resume to the last main-chain transcript entry OpenFork observed. */
  readonly resumeSessionAt?: string
  readonly permissionMode?: string
  readonly maxTurns?: number
  /** False for maintenance turns that must never create a resumable Claude transcript. */
  readonly persistSession?: boolean
  readonly signal?: AbortSignal
  /** Per-turn event sink; takes precedence over the constructor sink. */
  readonly sink?: RuntimeEventSink
  /** Host-owned tools exposed through the SDK's in-process MCP server. */
  readonly mcpTools?: readonly SdkMcpToolDefinition[]
  /** Host-owned MCP namespace (for example `openfork`). */
  readonly mcpServerName?: string
  /** SDK aliases for names the model may emit before MCP name resolution. */
  readonly toolAliases?: Readonly<Record<string, string>>
  /** Host-owned note appended to Claude Code's preset system prompt. */
  readonly systemPromptAppend?: string
  /** Reports whether MCP registration was available for this turn. */
  readonly onMcpToolsRegistered?: (registered: boolean) => void
}

export type TurnStatus = "completed" | "cancelled" | "timedOut" | "stalled" | "failed" | "disposed"

export interface TurnUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
}

export interface TurnOutcome {
  readonly status: TurnStatus
  readonly turnID: string
  /** Final assistant text on success. */
  readonly resultText?: string
  readonly isError?: boolean
  readonly sessionID?: string
  readonly usage?: TurnUsage
  /** Anthropic/Claude Code stop reason (max_tokens, refusal, end_turn, ...). */
  readonly stopReason?: string
  /** Last Anthropic HTTP status when Claude Code exhausted its own retries. */
  readonly apiErrorStatus?: number
  /** Last non-replay, main-chain Claude transcript UUID observed this turn. */
  readonly leafUuid?: string
  /** Sanitized failure category when the turn did not complete normally. */
  readonly category?: string
  /** Sanitized, bounded failure message; never contains prompts or tokens. */
  readonly message?: string
}

const DEFAULT_TURN_MS = 10 * 60_000
const DEFAULT_STALL_MS = 10 * 60_000
const DEFAULT_STOP_GRACE_MS = 2_000

interface Diagnostics {
  turnsStarted: number
  completed: number
  failed: number
  cancelled: number
  timedOut: number
  stalled: number
  disposedTurns: number
  sdkLoadFailures: number
  lastEventKind?: string
  lastFailureCategory?: string
}

interface PumpResult {
  readonly error?: { category: string; message: string }
  readonly result?: ResultEvent
  readonly sessionID?: string
  readonly sawOutput?: boolean
  readonly refusal?: string
  readonly leafUuid?: string
}

type StopReason = "cancelled" | "timedOut" | "stalled" | "disposed"

const DEFAULT_TURN_ID_PREFIX = "claude-turn"

let turnCounter = 0

function nextTurnID(prefix: string): string {
  turnCounter += 1
  return `${prefix}-${turnCounter}`
}

/**
 * Lifecycle-owned runtime boundary. Deterministic under fake SDK loaders:
 * normal completion, failure, cancellation, timeout, stall, and disposal all
 * resolve to typed outcomes without leaking prompts or credentials into
 * diagnostics.
 */
export class ClaudeAgentRuntime {
  private disposed = false
  private turnActive = false
  private activeStop: ((reason: StopReason) => void) | undefined
  private loaderPromise: Promise<ClaudeSdkModuleShape> | undefined
  // Per-turn sink (request.sink); single-turn-at-a-time makes this safe.
  private turnSink: RuntimeEventSink | undefined
  private readonly diag: Diagnostics = {
    turnsStarted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    stalled: 0,
    disposedTurns: 0,
    sdkLoadFailures: 0,
  }

  constructor(private readonly options: RuntimeOptions = {}) {}

  get isDisposed(): boolean {
    return this.disposed
  }

  get busy(): boolean {
    return this.activeStop !== undefined
  }

  /** Bounded, redacted counters. No prompts, tokens, arguments, or paths. */
  diagnostics(): Readonly<Diagnostics> {
    return { ...this.diag }
  }

  private emit: RuntimeEventSink = (event) => {
    this.diag.lastEventKind = event.kind
    this.turnSink?.(event)
    this.options.sink?.(event)
  }

  private loadSdk(): Promise<ClaudeSdkModuleShape> {
    if (!this.loaderPromise) {
      const loader = this.options.loader ?? defaultSdkLoader
      this.loaderPromise = loader().catch((error) => {
        // Drop the memoized failure so a later turn can retry a fixed install.
        this.loaderPromise = undefined
        this.diag.sdkLoadFailures += 1
        throw error instanceof ClaudeSdkUnavailableError
          ? error
          : new ClaudeSdkUnavailableError({
              message: "Claude Agent SDK could not be loaded",
              detail: sanitizeDetail(error instanceof Error ? error.message : String(error)),
            })
      })
    }
    return this.loaderPromise
  }

  /** Run one Agent SDK turn to its terminal outcome. */
  async run(request: TurnRequest): Promise<TurnOutcome> {
    if (this.disposed) throw new ClaudeDisposedError({ message: "Claude runtime has been disposed" })
    const isEnabled = this.options.enabled ?? shouldEnableClaudeFirstParty
    if (!isEnabled()) {
      return {
        status: "failed",
        turnID: "disabled",
        category: "disabled",
        message: "First-party Claude support is disabled by OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY.",
      }
    }
    // Claimed synchronously (before any await) so concurrent callers cannot
    // both pass the busy check while the SDK is still loading.
    if (this.turnActive || this.activeStop) {
      return {
        status: "failed",
        turnID: "none",
        category: "busy",
        message: "Another Claude turn is already active in this runtime",
      }
    }
    this.turnActive = true
    this.turnSink = request.sink

    const turnID = nextTurnID(this.options.turnIDPrefix ?? DEFAULT_TURN_ID_PREFIX)
    const turnMs = this.options.timeouts?.turnMs ?? DEFAULT_TURN_MS
    const stallMs = this.options.timeouts?.stallMs ?? DEFAULT_STALL_MS
    const stopGraceMs = this.options.timeouts?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
    const killTree = this.options.killTree
      ? (pid: number, force?: boolean) => this.options.killTree!(pid, force)
      : (pid: number, force?: boolean) => killProcessTree(pid, { force })

    let stopReason: StopReason | undefined
    let notifyStopped: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => {
      notifyStopped = resolve
    })
    const requestStop = (reason: StopReason) => {
      if (stopReason) return
      stopReason = reason
      notifyStopped?.()
    }

    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const armStallTimer = (extraMs = 0) => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => requestStop("stalled"), stallMs + Math.max(0, extraMs))
    }

    const timers: Array<ReturnType<typeof setTimeout>> = []
    const clearTimers = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = undefined
      for (const timer of timers) clearTimeout(timer)
      timers.length = 0
    }

    const abortHandler = () => requestStop("cancelled")
    request.signal?.addEventListener("abort", abortHandler, { once: true })

    this.diag.turnsStarted += 1
    this.emit({ kind: "started", turnID })

    let handle: SdkQueryHandle | undefined
    try {
      const sdk = await this.loadSdk()
      if (stopReason || this.disposed) {
        return this.outcomeForStop(turnID, stopReason ?? "disposed", turnMs, stallMs)
      }
      handle = createSdkQuery(sdk, {
        prompt: request.prompt,
        options: this.buildQueryOptions(request, sdk),
      })
      // Account-authoritative catalog refresh piggybacks the already-running
      // authenticated query. It is deliberately non-blocking and never runs
      // from passive provider/model listing.
      void refreshClaudeSubscriptionModelsFromHandle(handle)

      const turnTimer = setTimeout(() => requestStop("timedOut"), turnMs)
      timers.push(turnTimer)
      armStallTimer()

      this.activeStop = requestStop
      const pumpDone = this.pump(handle, turnID, armStallTimer)

      const winner = await Promise.race([pumpDone.then(() => "pump" as const), stopped.then(() => "stop" as const)])

      clearTimers()
      this.activeStop = undefined
      request.signal?.removeEventListener("abort", abortHandler)

      if (winner === "stop") {
        const stoppedPump = await stopHandleGracefully(handle, pumpDone, killTree, stopGraceMs)
        const reason: StopReason = stopReason ?? "disposed"
        return this.outcomeForStop(turnID, reason, turnMs, stallMs, {
          sessionID: stoppedPump?.result?.session_id ?? stoppedPump?.sessionID ?? request.resume,
          leafUuid: stoppedPump?.leafUuid,
        })
      }

      const pumped = await pumpDone
      // Streaming-input queries remain alive after a result until their input
      // closes. This adapter owns one turn, so release the SDK process here.
      handle.close()
      const terminalFields = {
        sessionID: pumped.result?.session_id ?? pumped.sessionID ?? request.resume,
        stopReason: pumped.result?.stop_reason,
        apiErrorStatus: pumped.result?.api_error_status,
        leafUuid: pumped.leafUuid,
        usage: pumped.result?.usage
          ? { input_tokens: pumped.result.usage.input_tokens, output_tokens: pumped.result.usage.output_tokens }
          : undefined,
      }
      if (pumped.error) {
        return this.settle(
          turnID,
          "failed",
          { category: pumped.error.category, message: pumped.error.message },
          terminalFields,
        )
      }
      const overloaded = pumped.result && !pumped.sawOutput ? overloadedResultText(pumped.result) : undefined
      if (overloaded) {
        return this.settle(turnID, "failed", {
          category: "overloaded",
          message: overloaded,
        }, terminalFields)
      }
      if (pumped.result?.is_error) {
        const message = pumped.refusal ?? resultErrorText(pumped.result)
        const classified = classifyClaudeFailure(message)
        return this.settle(turnID, "failed", {
          category: classified === "unknown" ? "provider-error" : classified,
          message: sanitizeDetail(message),
        }, terminalFields)
      }
      return this.settle(turnID, "completed", undefined, {
        resultText: pumped.result?.result,
        isError: pumped.result?.is_error,
        ...terminalFields,
      })
    } catch (error) {
      clearTimers()
      this.activeStop = undefined
      request.signal?.removeEventListener("abort", abortHandler)
      if (handle) stopHandle(handle, killTree)
      if (error instanceof ClaudeDisposedError) return this.settle(turnID, "disposed")
      if (error instanceof ClaudeSdkUnavailableError) {
        return this.settle(turnID, "failed", { category: "sdk-unavailable", message: error.message })
      }
      return this.settle(turnID, "failed", {
        category: "transport-error",
        message: sanitizeDetail(error instanceof Error ? error.message : String(error)),
      })
    } finally {
      this.turnActive = false
      this.turnSink = undefined
    }
  }

  /**
   * Consume the transport stream until the result event or stream end.
   * Never settles the turn itself; run() decides between pump and stop.
   */
  private async pump(handle: SdkQueryHandle, turnID: string, armStallTimer: (extraMs?: number) => void): Promise<PumpResult> {
    let result: ResultEvent | undefined
    let sawInit = false
    let sawOutput = false
    let refusal: string | undefined
    let leafUuid: string | undefined
    let sessionID: string | undefined
    try {
      for await (const raw of handle.events) {
        const event = decodeTransportEvent(raw)
        armStallTimer(
          event.type === "system" && "subtype" in event && event.subtype === "api_retry"
            ? apiRetryDelayMs(event)
            : 0,
        )
        if (event.type === "system" && "subtype" in event && event.subtype === "init") {
          sawInit = true
        }
        if ("session_id" in event && typeof event.session_id === "string" && event.session_id) {
          sessionID = event.session_id
        }
        if (event.type === "system" && "subtype" in event && event.subtype === "model_refusal_no_fallback") {
          refusal = refusalText(event)
        }
        if (
          (event.type === "assistant" || event.type === "user") &&
          "uuid" in event &&
          event.uuid &&
          !event.parent_tool_use_id &&
          event.isReplay !== true
        ) {
          leafUuid = event.uuid
        }
        if (event.type === "assistant" && "message" in event && event.message?.content) {
          sawOutput ||= event.message.content.some(
            (block) =>
              block.type === "tool_use" ||
              (block.type === "text" && typeof block.text === "string" && block.text.length > 0),
          )
        }
        if (event.type === "stream_event" && "event" in event && event.event && typeof event.event === "object") {
          const stream = event.event as Record<string, unknown>
          const delta = stream.delta
          if (
            stream.type === "content_block_delta" &&
            delta &&
            typeof delta === "object" &&
            (delta as Record<string, unknown>).type === "text_delta" &&
            typeof (delta as Record<string, unknown>).text === "string" &&
            ((delta as Record<string, unknown>).text as string).length > 0
          ) {
            sawOutput = true
          }
        }
        if (event.type === "result" && "is_error" in event) result = event
        this.emit({ kind: "transport", turnID, event })
        if (result) break
      }
      if (!sawInit && !result) {
        return { error: { category: "empty-stream", message: "Claude stream ended without any events" } }
      }
      return { result, sessionID, sawOutput, refusal, leafUuid }
    } catch (error) {
      if (this.disposed) return { sessionID, leafUuid }
      return {
        error: {
          category: "stream-error",
          message: sanitizeDetail(error instanceof Error ? error.message : String(error)),
        },
        sessionID,
        leafUuid,
      }
    }
  }

  private outcomeForStop(
    turnID: string,
    reason: StopReason,
    turnMs: number,
    stallMs: number,
    fields?: Partial<Pick<TurnOutcome, "sessionID" | "leafUuid">>,
  ): TurnOutcome {
    switch (reason) {
      case "cancelled":
        return this.settle(turnID, "cancelled", undefined, fields)
      case "timedOut":
        this.emit({ kind: "timedOut", turnID, timeoutMs: turnMs })
        return this.settle(turnID, "timedOut", { message: `turn exceeded ${turnMs}ms` }, fields)
      case "stalled":
        this.emit({ kind: "stalled", turnID, stallMs })
        return this.settle(turnID, "stalled", { message: `no transport activity for ${stallMs}ms` }, fields)
      case "disposed":
        return this.settle(turnID, "disposed", undefined, fields)
    }
  }

  private settle(
    turnID: string,
    status: TurnStatus,
    extra?: { category: string; message?: string } | { category?: undefined; message: string },
    fields?: Partial<
      Pick<
        TurnOutcome,
        "resultText" | "isError" | "sessionID" | "usage" | "stopReason" | "apiErrorStatus" | "leafUuid"
      >
    >,
  ): TurnOutcome {
    const category = status === "failed" ? (extra?.category ?? "unknown") : undefined
    const message = extra?.message
    switch (status) {
      case "completed":
        this.diag.completed += 1
        this.emit({ kind: "completed", turnID })
        break
      case "cancelled":
        this.diag.cancelled += 1
        this.emit({ kind: "cancelled", turnID })
        break
      case "timedOut":
        this.diag.timedOut += 1
        break
      case "stalled":
        this.diag.stalled += 1
        break
      case "disposed":
        this.diag.disposedTurns += 1
        this.emit({ kind: "disposed", turnID })
        break
      case "failed":
        this.diag.failed += 1
        this.diag.lastFailureCategory = category!
        this.emit({ kind: "failed", turnID, category: category!, message: sanitizeDetail(message ?? "", 300) })
        break
    }
    if (status !== "completed" && status !== "failed") {
      this.diag.lastFailureCategory = status
    }
    return {
      status,
      turnID,
      ...(category !== undefined ? { category } : {}),
      ...(message !== undefined ? { message: sanitizeDetail(message, 300) } : {}),
      ...fields,
    }
  }

  private buildQueryOptions(request: TurnRequest, sdk: ClaudeSdkModuleShape): Record<string, unknown> {
    // Mirror @openchamber/opencode-claude query.ts defaults: Claude Code
    // preset, project/user/local settings, auto-compact, all skills.
    const cwd = this.options.cwd
    if (!cwd) {
      // Missing location is toxic. Never silently target the server's cwd.
      throw new Error("ClaudeAgentRuntime requires an explicit cwd; refusing to fall back to process.cwd()")
    }
    const options: Record<string, unknown> = {
      cwd,
      env: buildChildEnv(this.options.env ?? process.env),
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      autoCompactEnabled: true,
      skills: "all",
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(request.systemPromptAppend ? { append: request.systemPromptAppend } : {}),
      },
      // The host is the tool authority for this provider. Claude's built-in
      // tools must stay disabled or the model can bypass host permissions.
      tools: [],
    }

    const mcpTools = request.mcpTools ?? []
    if (mcpTools.length === 0) {
      request.onMcpToolsRegistered?.(false)
    } else if (typeof sdk.createSdkMcpServer !== "function") {
      // Older/fake SDKs can still exercise the legacy streaming-input bridge;
      // the adapter uses that path when in-process MCP is unavailable.
      request.onMcpToolsRegistered?.(false)
    } else {
      const mcpServerName =
        request.mcpServerName && /^[A-Za-z0-9_-]+$/.test(request.mcpServerName)
          ? request.mcpServerName
          : "opencode"
      const server = (sdk.createSdkMcpServer as (options: Record<string, unknown>) => unknown)({
        name: mcpServerName,
        version: "1.0.0",
        tools: [...mcpTools],
        alwaysLoad: true,
      })
      options.mcpServers = { [mcpServerName]: server }
      options.allowedTools = mcpTools.map((tool) => `mcp__${mcpServerName}__${tool.name}`)
      if (request.toolAliases && Object.keys(request.toolAliases).length > 0) {
        options.toolAliases = { ...request.toolAliases }
      }
      request.onMcpToolsRegistered?.(true)
    }
    const executable = this.options.executablePath ?? resolveCliPath(this.options.env ?? process.env)
    if (executable) options.pathToClaudeCodeExecutable = executable
    if (request.model) options.model = request.model
    if (request.resume) options.resume = request.resume
    if (request.resumeSessionAt) options.resumeSessionAt = request.resumeSessionAt
    if (request.permissionMode) options.permissionMode = request.permissionMode
    if (request.persistSession === false) options.persistSession = false
    if (isClaudeEffort(request.effort)) {
      options.effort = request.effort
      options.thinking = { type: "adaptive" }
    }
    // Claude Code's thinking stream is otherwise empty until the final answer
    // on models that think without an explicit effort variant. Match the
    // current opencode-claude/t3code behavior and request streamed summaries
    // whenever this runtime has not explicitly disabled thinking.
    options.settings = { showThinkingSummaries: true }
    options.extraArgs = { "thinking-display": "summarized" }
    if (request.maxTurns && Number.isInteger(request.maxTurns) && request.maxTurns > 0) {
      options.maxTurns = request.maxTurns
    }
    return options
  }

  /**
   * Dispose the runtime: marks it disposed, stops the active turn (if any)
   * by interrupting and killing its child tree, and rejects subsequent runs.
   * Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.activeStop?.("disposed")
    this.activeStop = undefined
  }
}

function stopHandle(handle: SdkQueryHandle, killTree: (pid: number, force?: boolean) => void): void {
  void handle.interrupt().catch(() => {})
  killTree(handle.pid ?? 0, false)
  handle.close()
}

/**
 * Stop like Claude Code's own Esc path: interrupt first so the CLI can write
 * its interruption/tool settlement to the transcript, let our existing pump
 * remain the sole stream reader, and only hard-stop if it does not settle
 * within the bounded grace.
 */
async function stopHandleGracefully(
  handle: SdkQueryHandle,
  pumpDone: Promise<PumpResult>,
  killTree: (pid: number, force?: boolean) => void,
  graceMs: number,
): Promise<PumpResult | undefined> {
  // The grace bounds the control request too. Query.interrupt() is normally
  // quick, but if the SDK/child is wedged its Promise can hang indefinitely;
  // awaiting it before arming the grace would turn cancellation into another
  // unbounded wait. Start it first and let the existing pump remain the sole
  // reader while we race transcript settlement against the bounded grace.
  void handle.interrupt().catch(() => {})

  let settled: PumpResult | undefined
  if (graceMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      pumpDone
        .then((value) => {
          settled = value
        })
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs)
        timer.unref?.()
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  if (!settled) killTree(handle.pid ?? 0, false)
  handle.close()
  return settled
}

export * as ClaudeRuntime from "./runtime"
