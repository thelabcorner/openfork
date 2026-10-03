import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import path from "node:path"
import { Context, Effect, Layer, Result, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { CodingActivity } from "@opencode-ai/core/coding-activity"
import { createMcpHandler, fromJsonSchema, Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server"
import { OxpAuthority } from "./authority"
import { OxpAttribution } from "./attribution"
import { OxpCapability } from "./capability"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpFileExchange } from "./file-exchange"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSurface } from "./surface"
import { OxpSession } from "./session"
import { OxpRequest } from "./request"
import { OxpWorker } from "./worker"
import { OxpParentToolEpoch } from "./parent-tool-epoch"
import { OxpActivityRecorder } from "./activity-recorder"
import { OxpActivityIdentity } from "./activity-identity"
import { OxpRuntimeRefresh } from "./runtime-refresh"
import { resultContextChars } from "./context-footprint"

const MAX_BODY_BYTES = 8 * 1024 * 1024
const TOOL_LIST_PAGE_BYTES = 2 * 1024 * 1024
// The public tunnel identity is intentionally stable. Address the MCP server
// identity by the schema-rich surface fingerprint so reconnecting clients have
// an explicit protocol-visible cache key change whenever tools/instructions do.
const VERSION = `0.1.0+schema.${OxpSurface.FINGERPRINT.slice(0, 12)}`

interface Cursor {
  readonly v: 1
  readonly offset: number
  readonly fingerprint: string
}

export interface Endpoint {
  readonly port: number
  readonly url: string
  readonly metadataUrl: string
  readonly surfaceFingerprint: string
  readonly stop: (options?: { readonly forceAfterMs?: number }) => Promise<void>
}

export interface Metrics {
  readonly lastRequestAt?: number
  readonly lastOperationAt?: number
  readonly calls: number
  readonly failures: number
  readonly augmentationCalls: number
  readonly supervisionCalls: number
  readonly delegationCalls: number
  readonly parentEpochs: number
  readonly parentEpochReminders: number
  readonly conversationCorrelatedCalls: number
  readonly unattributedParentCalls: number
  readonly trackedParents: number
}

export interface Interface {
  readonly start: () => Effect.Effect<Endpoint, OxpError.Error>
  readonly active: () => Endpoint | undefined
  readonly stop: () => Effect.Effect<void>
  readonly metrics: () => Metrics
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpServer") {}
export const use = serviceUse(Service)

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeCursor(value: string | undefined, fingerprint: string, length: number) {
  if (value === undefined) return 0
  if (value.length > 1024) throw new Error("Invalid tools/list cursor")
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>
    if (
      parsed.v !== 1 ||
      parsed.fingerprint !== fingerprint ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      (parsed.offset ?? 0) > length
    ) {
      throw new Error("stale")
    }
    return parsed.offset!
  } catch {
    throw new Error("Invalid or stale tools/list cursor; restart discovery from the first page")
  }
}

export function paginateToolList(
  tools: readonly Tool[],
  cursor?: string,
  byteBudget = TOOL_LIST_PAGE_BYTES,
): { readonly tools: Tool[]; readonly nextCursor?: string } {
  const ordered = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  // The permanent OXP surface is immutable and overwhelmingly dominates this
  // path. Reuse its precomputed surface fingerprint rather than canonicalizing
  // and hashing the full (schema-rich) manifest on every tools/list request.
  const fingerprint =
    tools === OxpSurface.TOOLS ? OxpSurface.FINGERPRINT : OxpSurface.toolProjectionFingerprint(ordered)
  const offset = decodeCursor(cursor, fingerprint, ordered.length)
  const budget = Math.max(1, Math.floor(byteBudget))
  const page: Tool[] = []
  let bytes = 0
  let index = offset
  while (index < ordered.length) {
    const tool = ordered[index]!
    const cost = Buffer.byteLength(JSON.stringify(tool), "utf8") + 1
    if (page.length > 0 && bytes + cost > budget) break
    page.push(tool)
    bytes += cost
    index++
  }
  return {
    tools: page,
    ...(index < ordered.length ? { nextCursor: encodeCursor({ v: 1, offset: index, fingerprint }) } : {}),
  }
}

function jsonError(res: ServerResponse, status: number, error: string) {
  const body = JSON.stringify({ error })
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

async function boundedBody(req: IncomingMessage): Promise<{ readonly body?: unknown; readonly error?: string }> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) return { error: "payload_too_large" }
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString("utf8")
    return { body: text ? JSON.parse(text) : undefined }
  } catch {
    return { error: "invalid_json" }
  }
}

export function bridgeRequestCancellation(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController()
  const onAborted = () => controller.abort()
  const onResponseClose = () => {
    if (!res.writableFinished) controller.abort()
  }
  req.once("aborted", onAborted)
  res.once("close", onResponseClose)
  return {
    signal: controller.signal,
    dispose() {
      req.off("aborted", onAborted)
      res.off("close", onResponseClose)
    },
  }
}

type AfterResponse = NonNullable<OxpResult.CapabilityResult["afterResponse"]>
type ExecutedToolCall = {
  readonly result: CallToolResult
  readonly afterResponse?: AfterResponse
}

async function endResponse(res: ServerResponse, body: Buffer | undefined): Promise<boolean> {
  if (res.destroyed && !res.writableFinished) return false
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      res.off("finish", onFinish)
      res.off("close", onClose)
      resolve(value)
    }
    const onFinish = () => finish(true)
    const onClose = () => finish(res.writableFinished)
    res.once("finish", onFinish)
    res.once("close", onClose)
    res.end(body)
  })
}

async function handleMcpRequest(
  handler: ReturnType<typeof createMcpHandler>,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
  takeAfterResponse?: (request: Request) => AfterResponse | undefined,
) {
  const cancellation = bridgeRequestCancellation(req, res)
  const headers = new Headers()
  for (const [name, raw] of Object.entries(req.headers)) {
    if (raw === undefined || name.toLowerCase() === "content-length") continue
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(name, value)
    } else {
      headers.set(name, raw)
    }
  }
  const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
    method: req.method ?? "POST",
    headers,
    body: parsedBody === undefined ? undefined : JSON.stringify(parsedBody),
    signal: cancellation.signal,
  })
  try {
    const response = await handler.fetch(request)
    if (cancellation.signal.aborted || res.destroyed) return
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined
    if (body) responseHeaders["content-length"] = String(body.byteLength)
    res.writeHead(response.status, responseHeaders)
    const finished = await endResponse(res, body)
    if (finished) {
      const afterResponse = takeAfterResponse?.(request)
      if (afterResponse) {
        await Promise.resolve(afterResponse()).catch(() => undefined)
      }
    }
  } finally {
    cancellation.dispose()
  }
}

function allowedRequest(req: IncomingMessage, port: number) {
  const host = (req.headers.host ?? "").toLowerCase()
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  if (!allowedHosts.has(host)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.protocol === "http:" && allowedHosts.has(parsed.host.toLowerCase()) && parsed.pathname === "/"
  } catch {
    return false
  }
}

function toolResult(result: OxpResult.CapabilityResult): CallToolResult {
  const projected = {
    output: result.output,
    ...(result.structured === undefined ? {} : { data: result.structured }),
    ...(result.attachments?.length ? { attachments: result.attachments } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
    ...(result.mutation ? { mutation: result.mutation } : {}),
  }
  return {
    content: [{ type: "text", text: result.output }],
    structuredContent: projected,
  }
}

function toolError(error: OxpError.Error): CallToolResult {
  const projected = OxpResult.projectError(error)
  const text = `${projected.code}: ${projected.message}`
  return {
    content: [{ type: "text", text }],
    structuredContent: { output: text, error: projected },
    isError: true,
  }
}

const CONTINUATION_ACTIONS = new Set(["start", "continue", "batch_start", "batch_continue"])
const CONTINUITY_NOTICE =
  "OXP continuity notice: this parent session has reached the 20-minute handoff point in its non-renewing 25-minute tool epoch. If substantial work remains, start a durable openfork_worker now with a self-contained handoff of the objective, current state, constraints, and remaining work. Preserve the worker handle and do not spend the remaining parent window polling wait."
const CONTINUITY_ESTABLISHED_NOTICE =
  "OXP continuity notice: this parent session has reached the 20-minute handoff point in its non-renewing 25-minute tool epoch. Durable OpenFork worker continuation is already established in this epoch; let it continue and avoid spending the remaining parent window polling wait."

function establishesDurableContinuation(name: string, args: unknown) {
  if (name !== "openfork_worker" || !args || typeof args !== "object" || Array.isArray(args)) return false
  const action = (args as Record<string, unknown>).action
  return typeof action === "string" && CONTINUATION_ACTIONS.has(action)
}

export function durableContinuationObserved(name: string, args: unknown, error?: OxpError.Error) {
  if (!establishesDurableContinuation(name, args)) return false
  return error === undefined || error.metadata?.committed === true
}

/**
 * OpenAI file-exchange actions that leave a truthful local file effect, mapped
 * to the canonical CodingActivity kind they represent.
 *
 * `get_openai_file` / `list_openai_files` are intentionally absent: they are
 * remote metadata discovery and touch no local file, so they record nothing.
 */
const FILE_ACTIVITY_ACTIONS: Readonly<Record<string, CodingActivity.Kind>> = Object.freeze({
  save_chatgpt_file: "write",
  download_openai_file: "write",
  upload_openai_file: "read",
})

export interface FileActivityTarget {
  readonly kind: CodingActivity.Kind
  /** Canonical OXP virtual path; never a caller spelling and never cwd-relative. */
  readonly virtualPath: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function boundedText(source: Record<string, unknown> | undefined, key: string, max: number) {
  const value = source?.[key]
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined
}

/**
 * True when this OXP call can reach the OpenAI file-exchange broker, whether it
 * arrived as the direct `openai_files` tool or was brokered through
 * `capability` -> `file.transfer`.
 */
export function fileActivityRoute(name: string, args: unknown) {
  if (name === "openai_files") return true
  if (name !== "capability") return false
  const source = record(args)
  return (
    boundedText(source, "namespace", 64) === "openfork" && boundedText(source, "capability", 512) === "file.transfer"
  )
}

/**
 * Derives the canonical CodingActivity targets an OXP success boundary owns.
 *
 * The principal-neutral exchange kernel (`@/exchange/read`, `write`, `edit`,
 * `file-mutation`) already publishes the canonical record for every committed
 * read/write with exact before/after line deltas. OXP must therefore stay silent
 * for `read`/`write`/`edit`/`patch`: re-emitting them here would double-count the
 * same file on the same call. The OpenAI file-exchange broker is the one
 * file-touching OXP surface that publishes local bytes through its own verified
 * `link()` publication instead of the exchange kernel, so it is the only thing
 * this seam records.
 */
export function fileActivityTargets(
  name: string,
  args: unknown,
  result: OxpResult.CapabilityResult,
): readonly FileActivityTarget[] {
  if (!fileActivityRoute(name, args)) return []
  const structured = record(result.structured)
  if (!structured) return []
  const action = boundedText(structured, "action", 64)
  const kind = action === undefined ? undefined : FILE_ACTIVITY_ACTIONS[action]
  if (kind === undefined) return []
  // Only a committed operation is real file activity. Discovery, uncommitted
  // attempts, and externally ambiguous transfers never reach this boundary.
  if (result.mutation?.committed !== true) return []
  const virtualPath = kind === "write" ? boundedText(structured, "path", 4096) : boundedText(structured, "source", 4096)
  if (virtualPath === undefined) return []
  // A transferred blob publishes verified byte counts, never a before/after line
  // delta. There is deliberately no line-count field to read here: any number
  // this seam attached would be a fabricated delta the producer never proved.
  return [{ kind, virtualPath }]
}

/** Canonical identity of a local path for dedupe within one OXP call. */
export function fileActivityIdentity(value: string) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/**
 * Canonical project identity for the approved root that already proved a file.
 *
 * `OxpAttribution` owns this rule for the whole OXP boundary: the exchange
 * producer's display-path heuristic cannot identify an approved root from an
 * absolute `/alias/...` virtual path and instead names a containing directory,
 * so both this seam and the shared exchange read derive project identity from the
 * re-verified canonical root path instead.
 */
export function fileActivityProject(canonicalRootPath: string, alias?: string) {
  return OxpAttribution.project(canonicalRootPath, alias)
}

/**
 * Canonical CodingActivity input for one file-transfer target whose virtual path
 * `OxpRoot.resolvePath` has already resolved against an approved root.
 *
 * Only state the resolve proved is used. `canonicalPath` is the approved root
 * this exact file was proven under, already re-verified against the on-disk
 * directory, so a file directly in the root and a file nested under it attribute
 * to the same project. Nothing here reads cwd, the caller's spelling, the
 * absolute `/alias/...` virtual path, or the operator alias as an identity.
 *
 * That approved root's `canonicalPath` is also this seam's `projectFolder`: the
 * target was reached through `OxpRoot.resolvePath`, so the seam holds genuine
 * root authority even though the transfer broker itself never saw a directory.
 */
export function fileActivityInput(kind: CodingActivity.Kind, resolved: OxpRoot.ResolvedPath): CodingActivity.Input {
  return {
    entity: resolved.path,
    kind,
    project: fileActivityProject(resolved.canonicalPath, resolved.root.alias),
    projectFolder: resolved.canonicalPath,
    source: "oxp",
  }
}

function withContinuity(
  result: CallToolResult,
  observation: OxpParentToolEpoch.Observation,
  durableContinuationEstablished: boolean,
): CallToolResult {
  if (observation.state === "unattributed" || !observation.shouldRemind) return result
  const notice = durableContinuationEstablished ? CONTINUITY_ESTABLISHED_NOTICE : CONTINUITY_NOTICE
  const structured =
    result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
      ? result.structuredContent
      : {}
  return {
    ...result,
    content: [...result.content, { type: "text", text: notice }],
    structuredContent: {
      ...structured,
      oxp: {
        continuity: {
          epoch: observation.epoch,
          observedAgeMs: observation.observedAgeMs,
          state: observation.state,
          deadlineModel: "non-renewing-25m-observed-epoch",
          recommendedAction: durableContinuationEstablished ? "allow-worker-to-continue" : "openfork_worker.start",
          durableContinuationEstablished,
        },
      },
    },
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const capability = yield* OxpCapability.Service
    const fileExchange = yield* OxpFileExchange.Service
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const requests = yield* OxpRequest.Service
    const workers = yield* OxpWorker.Service
    const activity = yield* OxpActivityRecorder.Service
    const activityIdentity = yield* OxpActivityIdentity.Service
    const parentEpochs = OxpParentToolEpoch.makeTracker()
    let current: Endpoint | undefined
    const metricState: {
      lastRequestAt?: number
      lastOperationAt?: number
      calls: number
      failures: number
      augmentationCalls: number
      supervisionCalls: number
      delegationCalls: number
    } = {
      calls: 0,
      failures: 0,
      augmentationCalls: 0,
      supervisionCalls: 0,
      delegationCalls: 0,
    }
    const metrics = (): Metrics => Object.freeze({ ...metricState, ...parentEpochs.stats() })

    /**
     * Emits canonical CodingActivity for the file operations this success
     * boundary owns. Attribution is observability, so this is total: a root
     * change, a vanished target, or a defective observer must never turn a
     * successful OXP call into a failure.
     */
    const recordFileActivity = Effect.fn("OxpServer.fileActivity")(function* (
      name: string,
      args: unknown,
      result: OxpResult.CapabilityResult,
    ) {
      const targets = fileActivityTargets(name, args, result)
      if (targets.length === 0) return
      // Exactly-once per distinct local file. Dedupe runs on the root-verified
      // absolute path so repeated reports of one file in a single call collapse
      // deterministically onto the first producer entry. The map is call-local,
      // so concurrent OXP calls share no mutable state.
      const inputs = new Map<string, CodingActivity.Input>()
      for (const target of targets) {
        const resolved = yield* roots.resolvePath(target.virtualPath).pipe(
          Effect.result,
          Effect.map((settled) => (Result.isSuccess(settled) ? settled.success : undefined)),
        )
        // Fail closed. An unresolvable virtual path is never replaced by a cwd
        // guess, a caller spelling, or a project-name approximation.
        if (resolved === undefined) continue
        const identity = fileActivityIdentity(resolved.path)
        if (inputs.has(identity)) continue
        inputs.set(identity, fileActivityInput(target.kind, resolved))
      }
      yield* Effect.forEach([...inputs.values()], (input) => CodingActivity.record(input).pipe(Effect.ignore), {
        discard: true,
      })
    })

    const fileActivity = (name: string, args: unknown, result: OxpResult.CapabilityResult) =>
      recordFileActivity(name, args, result).pipe(Effect.catchCause(() => Effect.void))

    const dispatch = Effect.fn("OxpServer.dispatch")(function* (
      name: string,
      args: unknown,
      signal: AbortSignal,
      context: OxpCapability.CallContext = {},
    ) {
      if (signal.aborted) return yield* new OxpError.Cancelled({ detail: "OXP request was cancelled" })
      if (
        name === "read" ||
        name === "find" ||
        name === "edit" ||
        name === "write" ||
        name === "patch" ||
        name === "git" ||
        name === "process"
      ) {
        return yield* capability.call(name, args, signal, context)
      }

      if (name === "capability") {
        const input = yield* Schema.decodeUnknownEffect(OxpCapability.Parameters)(args, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP capability arguments" })))
        return yield* capability.execute(input, signal, {
          ...context,
          workerExecute: (workerInput, workerSignal) => workers.execute(workerInput, workerSignal),
        })
      }

      if (name === "openai_files") {
        const input = yield* Schema.decodeUnknownEffect(OxpFileExchange.OpenAiRuntimeParameters)(args, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(
            () =>
              new OxpError.InvalidArgument({
                detail: "Invalid OXP OpenAI Files arguments",
              }),
          ),
        )
        return yield* fileExchange.execute(OxpFileExchange.openAiInput(input), signal)
      }

      if (name === "openfork_session") {
        const input = yield* Schema.decodeUnknownEffect(OxpSession.DirectParameters)(args, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OpenFork Session arguments" })))
        return yield* sessions.execute(input, signal)
      }

      if (name === "openfork_request") {
        const input = yield* Schema.decodeUnknownEffect(OxpRequest.Parameters)(args, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(
            () =>
              new OxpError.InvalidArgument({
                detail: "Invalid OpenFork request-supervision arguments",
              }),
          ),
        )
        return yield* requests.execute(input, signal)
      }

      if (name === "openfork_worker") {
        const input = yield* Schema.decodeUnknownEffect(OxpWorker.Parameters)(args, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(
            () =>
              new OxpError.InvalidArgument({
                detail: "Invalid OpenFork delegated-worker arguments",
              }),
          ),
        )
        return yield* workers.execute(input, signal)
      }

      if (name === "openfork_info") {
        const input = yield* Schema.decodeUnknownEffect(OxpSurface.InfoParameters)(args, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OpenFork info arguments" })))
        yield* authority.authorize({
          plane: "augmentation",
          operation: `info.${input.action}`,
          phase: "discover",
        })
        if (input.action === "capabilities") {
          const rows = yield* capability.list(undefined, "all")
          return {
            output: JSON.stringify(rows, null, 2),
            structured: { capabilities: rows },
          } satisfies OxpResult.CapabilityResult
        }
        if (input.action === "status") {
          const state = yield* config.get()
          const runtime = yield* Effect.promise(() => OxpRuntimeRefresh.status())
          const publicRoots = yield* Effect.forEach(state.roots, (root) =>
            roots.verify(root).pipe(
              Effect.as({ id: root.id, alias: root.alias, available: true }),
              Effect.catch(() => Effect.succeed({ id: root.id, alias: root.alias, available: false })),
            ),
          )
          const status = {
            surfaceVersion: OxpSurface.MAJOR_VERSION,
            schemaFingerprint: OxpSurface.FINGERPRINT,
            connector: state.connector,
            configRevision: state.revision,
            runtime,
            enabled: state.enabled,
            roots: publicRoots,
            // Project only authority that is executable on this versioned MCP
            // surface. Future policy bits remain privileged configuration until
            // their actual capability owners ship.
            grant: {
              read: state.grant.read,
              write: state.grant.write,
              git: state.grant.git,
              process: state.grant.process,
              browser: state.grant.browser,
              automation: state.grant.automation ?? false,
              sessionSupervision: state.grant.sessionSupervision,
              requestSupervision: state.grant.requestSupervision,
              delegation: state.grant.delegation,
              nestedDelegation: state.grant.nestedDelegation,
            },
          }
          return {
            output: JSON.stringify(status, null, 2),
            structured: status,
          } satisfies OxpResult.CapabilityResult
        }
        return yield* new OxpError.InvalidArgument({ detail: "Unknown OpenFork info action" })
      }

      return yield* new OxpError.NotFound({ detail: `Unknown OXP tool: ${name}` })
    })

    const start = Effect.fn("OxpServer.start")(function* () {
      if (current) return yield* new OxpError.Busy({ detail: "OXP MCP endpoint is already running" })
      const started = yield* Effect.tryPromise({
        try: async () => {
          const token = randomBytes(32).toString("base64url")
          const basePath = `/mcp/${token}`
          const metadataPath = `/.well-known/oauth-protected-resource${basePath}`
          let endpointUrl = ""
          let port = 0
          let stopPromise: Promise<void> | undefined
          const sockets = new Set<Socket>()

          const executeToolCall = async (
            name: string,
            args: unknown,
            requestMeta: Readonly<Record<string, unknown>> | undefined,
            signal: AbortSignal,
          ): Promise<ExecutedToolCall> => {
            const parentCorrelation = OxpParentToolEpoch.parentCorrelation(requestMeta)
            const continuity = parentEpochs.observe(parentCorrelation)
            const activityInput = {
              parentCorrelation,
              ...(continuity.state === "unattributed" ? {} : { observedEpoch: continuity.epoch }),
              ...(continuity.state !== "unattributed" && continuity.shouldRemind
                ? { continuityMarker: "handoff_advisory" as const }
                : {}),
              tool: name,
              args,
            } satisfies OxpActivityRecorder.BeginInput
            metricState.calls += 1
            if (name === "openfork_session" || name === "openfork_request") metricState.supervisionCalls += 1
            else if (name === "openfork_worker") metricState.delegationCalls += 1
            else metricState.augmentationCalls += 1
            metricState.lastOperationAt = Date.now()
            return Effect.runPromise(
              Effect.gen(function* () {
                const recording = yield* activity.begin(activityInput)
                const callContext: OxpCapability.CallContext =
                  parentCorrelation?.scope === "conversation"
                    ? { parentConversationRef: (yield* activityIdentity.pseudonymize(parentCorrelation)).digest }
                    : {}
                return yield* dispatch(name, args, signal, callContext).pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      Effect.gen(function* () {
                        metricState.failures += 1
                        if (durableContinuationObserved(name, args, error)) {
                          parentEpochs.markDurableContinuation(parentCorrelation)
                        }
                        const finalResult = withContinuity(
                          toolError(error),
                          continuity,
                          parentEpochs.hasDurableContinuation(parentCorrelation),
                        )
                        yield* activity.failure(recording, activityInput, error, resultContextChars(finalResult))
                        return { result: finalResult }
                      }),
                    onSuccess: (result) =>
                      Effect.gen(function* () {
                        yield* fileActivity(name, args, result)
                        if (durableContinuationObserved(name, args)) {
                          parentEpochs.markDurableContinuation(parentCorrelation)
                        }
                        const finalResult = withContinuity(
                          toolResult(result),
                          continuity,
                          parentEpochs.hasDurableContinuation(parentCorrelation),
                        )
                        yield* activity.success(recording, activityInput, result, resultContextChars(finalResult))
                        return {
                          result: finalResult,
                          ...(result.afterResponse ? { afterResponse: result.afterResponse } : {}),
                        }
                      }),
                  }),
                )
              }),
            )
          }

          const afterResponses = new WeakMap<Request, AfterResponse>()
          const mcpHandler = createMcpHandler(
            (requestContext) => {
              const outputSchema =
                requestContext.era === "legacy" ? OxpSurface.LEGACY_OUTPUT_SCHEMA : OxpSurface.OUTPUT_SCHEMA
              const tools =
                requestContext.era === "legacy"
                  ? OxpSurface.TOOLS.map((tool) => ({
                      ...tool,
                      outputSchema,
                    }))
                  : OxpSurface.TOOLS
              const mcp = new Server(
                { name: "OpenFork OXP", version: VERSION },
                { capabilities: { tools: {} }, instructions: OxpSurface.SERVER_INSTRUCTIONS },
              )
              const outputValidator = fromJsonSchema(outputSchema)
              mcp.setRequestHandler("tools/list", async (request) => paginateToolList(tools, request.params?.cursor))
              mcp.setRequestHandler("tools/call", async (request, ctx) => {
                const executed = await executeToolCall(
                  request.params.name,
                  request.params.arguments ?? {},
                  request.params._meta,
                  ctx.mcpReq.signal,
                )
                const result = executed.result
                if (executed.afterResponse && requestContext.requestInfo) {
                  afterResponses.set(requestContext.requestInfo, executed.afterResponse)
                }
                if (result.structuredContent !== undefined) {
                  const validation = await outputValidator["~standard"].validate(result.structuredContent)
                  if (validation.issues?.length) {
                    return {
                      content: [
                        { type: "text" as const, text: "OXP_INTERNAL: structured result violated outputSchema" },
                      ],
                      isError: true,
                    }
                  }
                }
                return mcp.projectCallToolResult(result, outputSchema)
              })
              return mcp
            },
            { legacy: "stateless" },
          )

          const server = createServer((req, res) => {
            const pathOnly = (req.url ?? "").split("?", 1)[0] ?? ""
            if (!allowedRequest(req, port)) {
              req.resume()
              jsonError(res, 403, "forbidden")
              return
            }
            if (safeEqual(pathOnly, metadataPath)) {
              req.resume()
              if (req.method !== "GET") {
                jsonError(res, 405, "method_not_allowed")
                return
              }
              const body = JSON.stringify({
                resource: endpointUrl,
                resource_name: "OpenFork OXP",
                authorization_servers: [],
                scopes_supported: [],
              })
              res.writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-store",
                "content-length": Buffer.byteLength(body),
              })
              res.end(body)
              return
            }
            if (!safeEqual(pathOnly, basePath)) {
              req.resume()
              jsonError(res, 404, "not_found")
              return
            }
            if (req.method !== "POST") {
              req.resume()
              jsonError(res, 405, "method_not_allowed")
              return
            }
            metricState.lastRequestAt = Date.now()
            const declaredRaw = req.headers["content-length"]
            if (declaredRaw !== undefined) {
              const declared = Number(declaredRaw)
              if (!Number.isSafeInteger(declared) || declared < 0) {
                req.resume()
                jsonError(res, 400, "invalid_content_length")
                return
              }
              if (declared > MAX_BODY_BYTES) {
                req.resume()
                jsonError(res, 413, "payload_too_large")
                return
              }
            }
            // Always own request-body bounding before the MCP SDK. Stateless
            // transports are request-scoped so consuming the body once here is
            // deterministic and concurrent requests never share transport state.
            void boundedBody(req).then(async (parsed) => {
              if (parsed.error) {
                // boundedBody intentionally stops retaining bytes at the cap.
                // Drain the remainder without buffering so a chunked oversized
                // sender cannot leave unread request data pinning this socket.
                req.resume()
                jsonError(res, parsed.error === "payload_too_large" ? 413 : 400, parsed.error)
                return
              }
              try {
                await handleMcpRequest(mcpHandler, req, res, parsed.body, (request) => {
                  const afterResponse = afterResponses.get(request)
                  afterResponses.delete(request)
                  return afterResponse
                })
              } catch {
                if (!res.headersSent) jsonError(res, 500, "mcp_transport_error")
                else res.end()
              }
            })
          })
          server.headersTimeout = 30_000
          server.requestTimeout = 300_000
          server.on("connection", (socket) => {
            sockets.add(socket)
            socket.once("close", () => sockets.delete(socket))
          })
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject)
            server.listen(0, "127.0.0.1", () => {
              server.off("error", reject)
              resolve()
            })
          })
          const address = server.address()
          if (!address || typeof address === "string") {
            throw new Error("OXP MCP server did not bind a TCP port")
          }
          port = address.port
          endpointUrl = `http://127.0.0.1:${port}${basePath}`
          const metadataUrl = `http://127.0.0.1:${port}${metadataPath}`

          const endpoint: Endpoint = Object.freeze({
            port,
            url: endpointUrl,
            metadataUrl,
            surfaceFingerprint: OxpSurface.FINGERPRINT,
            stop: (options: { readonly forceAfterMs?: number } = {}) =>
              (stopPromise ??= (async () => {
                const { forceAfterMs } = options
                await mcpHandler.close().catch(() => undefined)
                await new Promise<void>((resolve) => {
                  const force = forceAfterMs
                    ? setTimeout(() => {
                        for (const socket of sockets) socket.destroy()
                        resolve()
                      }, forceAfterMs)
                    : undefined
                  force?.unref?.()
                  server.close(() => {
                    if (force) clearTimeout(force)
                    resolve()
                  })
                })
                if (current === endpoint) current = undefined
              })()),
          })
          return endpoint
        },
        catch: () => new OxpError.DependencyUnavailable({ detail: "Unable to start the local OXP MCP endpoint" }),
      })
      current = started
      return started
    })

    const stop = Effect.fn("OxpServer.stop")(function* () {
      const endpoint = current
      if (!endpoint) return
      yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
    })

    return Service.of({ start, active: () => current, stop, metrics })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    OxpCapability.node,
    OxpFileExchange.node,
    OxpAuthority.node,
    OxpConfig.node,
    OxpRoot.node,
    OxpSession.node,
    OxpRequest.node,
    OxpWorker.node,
    OxpActivityRecorder.node,
    OxpActivityIdentity.node,
  ],
})

export * as OxpServer from "./server"
