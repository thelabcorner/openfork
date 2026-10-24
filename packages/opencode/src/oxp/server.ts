import path from "node:path"
import { Cause, Context, Effect, Layer, Result, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { CodingActivity } from "@opencode-ai/core/coding-activity"
import type { CallToolResult } from "@modelcontextprotocol/server"
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
import { OxpParentToolEpoch, type ParentCorrelation } from "./parent-tool-epoch"
import { OxpSessionTitle } from "./session-title"
import { OxpActivityRecorder } from "./activity-recorder"
import { OxpActivityIdentity } from "./activity-identity"
import { OxpDiagnostics } from "./diagnostics"
import { OxpRuntimeRefresh } from "./runtime-refresh"
import { AX_IMPLEMENTATION } from "./ax-revisions"
import { resultContextChars } from "./context-footprint"
import { createLatencyHistogram, type LatencySnapshot } from "./latency-histogram"
import { OXP_STATIC_TRANSPORT } from "./transport-manifest"
import { startLeanOxpListener } from "./transport-listener"

// Public re-export for existing callers and parity fixtures; the implementation
// is now in the schema-only transport plane rather than the execution service.
export { paginateToolList } from "./transport-pagination"



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
  /** Lifetime, bounded, coarse-bucket milliseconds; never stores request data. */
  readonly latency?: Readonly<Record<"toolCall" | "dispatch" | "activityBegin" | "activitySettle" | "mcpTransport", LatencySnapshot>>
}

export interface Interface {
  readonly start: () => Effect.Effect<Endpoint, OxpError.Error>
  readonly active: () => Endpoint | undefined
  readonly stop: () => Effect.Effect<void>
  readonly metrics: () => Metrics
  /** First-call proof for the host's eager-schema-free listener. Generating
   * tools/list stays Tier-0; dispatch is denied if the source schema changed. */
  readonly validateManifest: () => boolean
  /** Same authorized execution envelope as the listener, exposed for the
   * independently bound host transport; never a bypass to leaf authority. */
  readonly execute: (
    name: string,
    args: unknown,
    meta: Readonly<Record<string, unknown>> | undefined,
    signal: AbortSignal,
  ) => Promise<ExecutedToolCall>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpServer") {}
export const use = serviceUse(Service)

export { projectInternalErrorBody } from "./transport-incident"
export { bridgeRequestCancellation } from "./transport-listener"

type AfterResponse = NonNullable<OxpResult.CapabilityResult["afterResponse"]>
type ExecutedToolCall = {
  readonly result: CallToolResult
  readonly afterResponse?: AfterResponse
}


export function toolResult(result: OxpResult.CapabilityResult): CallToolResult {
  const projected = {
    output: result.output,
    ...(result.structured === undefined ? {} : { data: result.structured }),
    ...(result.attachments?.length ? { attachments: result.attachments } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
    ...(result.mutation ? { mutation: result.mutation } : {}),
  }
  return {
    content: [{ type: "text", text: result.output }, ...(result.mediaContent ?? [])],
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

function requiresParentConversationContext(name: string, args: unknown) {
  if (name !== "capability" || !args || typeof args !== "object" || Array.isArray(args)) return false
  const input = args as Record<string, unknown>
  // Only the browser capability binds a local browser principal to the
  // ChatGPT conversation. Other OXP calls must remain available when the
  // optional activity-correlation key cannot be read.
  return input.action === "call" && input.capability === "browser" && input.namespace !== "mcp"
}

function boundaryFailure(error: unknown): OxpError.Error {
  if (OxpError.isError(error)) return error
  return internalFailure(error, "tool_boundary")
}

function internalFailure(
  cause: unknown,
  phase: OxpDiagnostics.Phase,
  tool?: string,
  action?: string,
): OxpError.Internal {
  let incidentID = "unavailable"
  try {
    const safeTool = tool && OxpSurface.TOOLS.some((definition) => definition.name === tool) ? tool : undefined
    const incident = OxpDiagnostics.record({
      cause,
      phase,
      tool: safeTool,
      action,
      surfaceFingerprint: OxpSurface.FINGERPRINT,
    })
    incidentID = incident.id
    console.error(`[OXP] incident ${incident.id} (${phase}, ${incident.tool ?? "unknown"}): ${incident.errorName}${incident.errorCode ? `/${incident.errorCode}` : ""}`)
  } catch {
    // Diagnostics must never replace the underlying tool failure.
  }
  return new OxpError.Internal({
    detail: `Unexpected OXP failure${incidentID === "unavailable" ? " (diagnostic recording unavailable)" : ` recorded as ${incidentID}. Read recent incidents with openfork_info action=status; use action=diagnostics with incidentID=${incidentID} when available.`}`,
    ...(incidentID === "unavailable" ? {} : { metadata: { incidentID } }),
  })
}

function reportTransportFailure(cause: unknown, phase: "mcp_transport" | "request_body") {
  try {
    const incident = OxpDiagnostics.record({ cause, phase, surfaceFingerprint: OxpSurface.FINGERPRINT })
    try {
      console.error(`[OXP] incident ${incident.id} (${phase}): ${incident.errorName}${incident.errorCode ? `/${incident.errorCode}` : ""}`)
    } catch {
      // Logging is best-effort; the incident remains queryable over OXP.
    }
    return incident.id
  } catch {
    // A broken diagnostic sink must not compound a transport failure.
    return undefined
  }
}

function reportActivityFailure(cause: unknown, name: string, args: unknown) {
  const action = record(args)?.action
  internalFailure(cause, "activity_recording", name, typeof action === "string" ? action : undefined)
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
    const latency = {
      toolCall: createLatencyHistogram(),
      dispatch: createLatencyHistogram(),
      activityBegin: createLatencyHistogram(),
      activitySettle: createLatencyHistogram(),
      mcpTransport: createLatencyHistogram(),
    }
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
    const metrics = (): Metrics => Object.freeze({
      ...metricState,
      ...parentEpochs.stats(),
      latency: Object.freeze({
        toolCall: latency.toolCall.snapshot(),
        dispatch: latency.dispatch.snapshot(),
        activityBegin: latency.activityBegin.snapshot(),
        activitySettle: latency.activitySettle.snapshot(),
        mcpTransport: latency.mcpTransport.snapshot(),
      }),
    })

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

    // The ingress correlation is the ownership source, never user-supplied worker arguments.
    // Resolve only for creations: polling, cancellation and discovery stay read-free.
    const parentSessionFor = (input: OxpWorker.Input, parentCorrelation?: ParentCorrelation) =>
      input.action === "start" || input.action === "batch_start"
        ? activity.resolveSession({ parentCorrelation })
        : Effect.succeed(undefined)

    const dispatch = Effect.fn("OxpServer.dispatch")(function* (
      name: string,
      args: unknown,
      signal: AbortSignal,
      context: OxpCapability.CallContext = {},
      parentCorrelation?: ParentCorrelation,
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
          workerExecute: (workerInput, workerSignal) =>
            parentSessionFor(workerInput, parentCorrelation).pipe(
              Effect.flatMap((parentSession) => workers.execute(workerInput, workerSignal, parentSession)),
            ),
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
        const parentSession = yield* parentSessionFor(input, parentCorrelation)
        return yield* workers.execute(input, signal, parentSession)
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
        // sessionTitle is handshake metadata for the status action only. It is
        // optional at the transport so older clients keep working, but the
        // agent contract requires it: a missing title leaves the session's
        // row anonymous while invalid titles fail compactly.
        if (input.sessionTitle !== undefined && input.action !== "status") {
          return yield* new OxpError.InvalidArgument({
            detail: "sessionTitle is only valid with openfork_info action=status",
          })
        }
        if (input.action === "capabilities") {
          const rows = yield* capability.list(undefined, "all")
          return {
            output: JSON.stringify(rows, null, 2),
            structured: { capabilities: rows },
          } satisfies OxpResult.CapabilityResult
        }
        if (input.action === "diagnostics") {
          const incidents = OxpDiagnostics.list({ limit: input.limit, id: input.incidentID })
          const report = {
            incidents,
            capacity: 64,
            retained: OxpDiagnostics.size(),
            latency: metrics().latency,
            note: "Process-local diagnostics; no arguments, tool results, prompts, credentials, or absolute paths are retained.",
          }
          return {
            output: JSON.stringify(report, null, 2),
            structured: report,
          } satisfies OxpResult.CapabilityResult
        }
        let sessionTitle: string | undefined
        let sessionPersisted = false
        if (input.action === "status" && input.sessionTitle !== undefined) {
          const normalized = OxpSessionTitle.normalizeSessionTitle(input.sessionTitle)
          if (!normalized.ok) {
            return yield* new OxpError.InvalidArgument({
              detail:
                normalized.reason === "blank"
                  ? "sessionTitle is required for the initial OXP status handshake"
                  : `sessionTitle must be at most ${OxpSessionTitle.MAX_TITLE_BYTES} bytes`,
            })
          }
          sessionTitle = normalized.title
          const registered = yield* activity.registerSession({ parentCorrelation, title: normalized.title })
          sessionPersisted = registered.persisted
        }
        if (input.action === "status") {
          const state = yield* config.get()
          const runtime = yield* Effect.promise(() => OxpRuntimeRefresh.status())
          const publicRoots = yield* Effect.forEach(
            state.roots,
            (root) =>
              roots.verify(root).pipe(
                Effect.as({ id: root.id, alias: root.alias, available: true }),
                Effect.catch(() => Effect.succeed({ id: root.id, alias: root.alias, available: false })),
              ),
            // Availability probes are independent: preserve per-root realpath
            // and identity revalidation without serializing unrelated volumes.
            { concurrency: 4 },
          )
          const status = {
            surfaceVersion: OxpSurface.MAJOR_VERSION,
            schemaFingerprint: OxpSurface.FINGERPRINT,
            // On-demand broker semantics can change without changing the
            // permanent MCP manifest. Report them separately so a stable
            // surface fingerprint cannot masquerade as a fresh deployment.
            implementation: { ax: AX_IMPLEMENTATION },
            connector: state.connector,
            configRevision: state.revision,
            runtime,
            // Keep diagnostics available through `status`, whose published
            // connector schema predates the optional action on some MCP
            // clients. This surfaces failures that could not be returned from
            // the original request.
            diagnostics: {
              capacity: 64,
              retained: OxpDiagnostics.size(),
              incidents: OxpDiagnostics.list({ limit: 5 }),
            },
            sessionTitle: sessionTitle ?? null,
            sessionPersisted,
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
              code: state.grant.code ?? false,
              browser: state.grant.browser,
              automation: state.grant.automation ?? false,
              globalUsageAnalytics: state.grant.globalUsageAnalytics ?? false,
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

      if (name === "openfork_diagnostics") {
        // The OXP endpoint's unguessable local URL is the authorization
        // boundary for this minimal operational read. Do not consult config,
        // workspace roots, activity storage, or SQLite here: those may be the
        // very dependencies that caused the incident being inspected.
        const input = yield* Schema.decodeUnknownEffect(OxpSurface.DiagnosticsParameters)(args, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OpenFork diagnostics arguments" })))
        const report = {
          incidents: OxpDiagnostics.list({ limit: input.limit, id: input.incidentID }),
          capacity: 64,
          retained: OxpDiagnostics.size(),
          latency: metrics().latency,
          note: "Process-local diagnostics; no arguments, tool results, prompts, credentials, or absolute paths are retained.",
        }
        return {
          output: JSON.stringify(report, null, 2),
          structured: report,
        } satisfies OxpResult.CapabilityResult
      }

      return yield* new OxpError.NotFound({ detail: `Unknown OXP tool: ${name}` })
    })

    const executeToolCall = async (
      name: string,
      args: unknown,
      requestMeta: Readonly<Record<string, unknown>> | undefined,
      signal: AbortSignal,
    ): Promise<ExecutedToolCall> => {
      const operationAt = performance.now()
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
      let recording: OxpActivityRecorder.Handle | undefined
      const isInfoRead = name === "openfork_info" || name === "openfork_diagnostics"
      try {
        return await Effect.runPromise(
          Effect.gen(function* () {
            if (!isInfoRead) {
              const activityAt = performance.now()
              recording = yield* activity.begin(activityInput).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => {
                    reportActivityFailure(Cause.squash(cause), name, args)
                    return undefined
                  }),
                ),
                Effect.ensuring(Effect.sync(() => latency.activityBegin.observe(performance.now() - activityAt))),
              )
            }
            const callContext: OxpCapability.CallContext =
              parentCorrelation?.scope === "conversation" && requiresParentConversationContext(name, args)
                ? { parentConversationRef: (yield* activityIdentity.pseudonymize(parentCorrelation)).digest }
                : {}
            const dispatchAt = performance.now()
            return yield* dispatch(name, args, signal, callContext, parentCorrelation).pipe(
              Effect.ensuring(Effect.sync(() => latency.dispatch.observe(performance.now() - dispatchAt))),
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
                    if (!isInfoRead) {
                      const settlementAt = performance.now()
                      yield* activity.failure(recording, activityInput, error, resultContextChars(finalResult)).pipe(
                        Effect.catchCause((cause) =>
                          Effect.sync(() => reportActivityFailure(Cause.squash(cause), name, args)),
                        ),
                        Effect.ensuring(Effect.sync(() => latency.activitySettle.observe(performance.now() - settlementAt))),
                      )
                    }
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
                    if (!isInfoRead) {
                      const settlementAt = performance.now()
                      yield* activity.success(recording, activityInput, result, resultContextChars(finalResult)).pipe(
                        Effect.catchCause((cause) =>
                          Effect.sync(() => reportActivityFailure(Cause.squash(cause), name, args)),
                        ),
                        Effect.ensuring(Effect.sync(() => latency.activitySettle.observe(performance.now() - settlementAt))),
                      )
                    }
                    return {
                      result: finalResult,
                      ...(result.afterResponse ? { afterResponse: result.afterResponse } : {}),
                    }
                  }),
              }),
            )
          }),
        )
      } catch (cause) {
        // MCP handlers turn an escaped exception into JSON-RPC
        // -32603, which makes every operation look like a connector
        // outage. Keep failures at the tool boundary and preserve the
        // distinction between a tool error and a transport failure.
        const error = boundaryFailure(cause)
        metricState.failures += 1
        const finalResult = withContinuity(
          toolError(error),
          continuity,
          parentEpochs.hasDurableContinuation(parentCorrelation),
        )
        if (!isInfoRead) {
          const settlementAt = performance.now()
          await Effect.runPromise(
            activity.failure(recording, activityInput, error, resultContextChars(finalResult)),
          ).catch((cause) => reportActivityFailure(cause, name, args))
            .finally(() => latency.activitySettle.observe(performance.now() - settlementAt))
        }
        return { result: finalResult }
      } finally {
        latency.toolCall.observe(performance.now() - operationAt)
      }
    }

    const validateManifest = () => !(
        OxpSurface.FINGERPRINT !== OXP_STATIC_TRANSPORT.fingerprint ||
        OxpSurface.MAJOR_VERSION !== OXP_STATIC_TRANSPORT.majorVersion ||
        OxpSurface.SERVER_INSTRUCTIONS !== OXP_STATIC_TRANSPORT.instructions ||
        JSON.stringify(OxpSurface.TOOLS) !== JSON.stringify(OXP_STATIC_TRANSPORT.tools) ||
        JSON.stringify(OxpSurface.OUTPUT_SCHEMA) !== JSON.stringify(OXP_STATIC_TRANSPORT.outputSchema) ||
        JSON.stringify(OxpSurface.LEGACY_OUTPUT_SCHEMA) !== JSON.stringify(OXP_STATIC_TRANSPORT.legacyOutputSchema)
      )

    const start = Effect.fn("OxpServer.start")(function* () {
      if (current) return yield* new OxpError.Busy({ detail: "OXP MCP endpoint is already running" })
      // Before opening a socket, ensure the generated static schema exactly
      // matches the executable source owner. Never serve a stale contract.
      if (!validateManifest()) {
        return yield* new OxpError.DependencyUnavailable({
          detail: "OXP static transport manifest is stale; regenerate and verify the authoritative tool contract before starting",
        })
      }
      // Both eager service tests and the lazy production host now use exactly
      // one HTTP/MCP implementation, avoiding diverging Host/Origin checks,
      // cancellation fences, buffering, and post-response commit receipts.
      const listener = yield* Effect.tryPromise({
        try: () => startLeanOxpListener({
          execute: executeToolCall,
          internalError: (cause, phase, name, action) =>
            toolError(internalFailure(cause, phase, name, action)),
          onRequest: () => { metricState.lastRequestAt = Date.now() },
          onTransportDuration: (ms) => latency.mcpTransport.observe(ms),
          onTransportError: reportTransportFailure,
        }),
        catch: () => new OxpError.DependencyUnavailable({ detail: "Unable to start the local OXP MCP endpoint" }),
      })
      let closed: Promise<void> | undefined
      const started: Endpoint = Object.freeze({
        ...listener,
        stop: (options = {}) => (closed ??= listener.stop(options).finally(() => {
          if (current === started) current = undefined
        })),
      })
      current = started
      return started
    })

    const stop = Effect.fn("OxpServer.stop")(function* () {
      const endpoint = current
      if (!endpoint) return
      yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
    })

    return Service.of({ start, active: () => current, stop, metrics, validateManifest, execute: executeToolCall })
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
