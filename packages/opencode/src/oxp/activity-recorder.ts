import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivitySchema } from "@opencode-ai/core/oxp-activity/schema"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { OxpActivityIdentity } from "./activity-identity"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import type { OxpResult } from "./result"
import type { ParentCorrelation } from "./parent-tool-epoch"
import { BOUNDARY_CONTEXT_SCHEMA, requestContextChars } from "./context-footprint"

export interface Handle {
  readonly activityID: OxpActivitySchema.ActivityID
  readonly invocationID: OxpActivitySchema.InvocationID
}

export interface BeginInput {
  readonly parentCorrelation?: ParentCorrelation
  readonly observedEpoch?: number
  readonly continuityMarker?: OxpActivitySchema.ContinuityMarker
  readonly tool: string
  readonly args: unknown
}

export interface Interface {
  readonly begin: (input: BeginInput) => Effect.Effect<Handle | undefined>
  readonly success: (
    handle: Handle | undefined,
    input: BeginInput,
    result: OxpResult.CapabilityResult,
    resultContextChars?: number,
  ) => Effect.Effect<void>
  readonly failure: (
    handle: Handle | undefined,
    input: BeginInput,
    error: OxpError.Error,
    resultContextChars?: number,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpActivityRecorder") {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(source: Record<string, unknown> | undefined, key: string, max = 512) {
  const value = source?.[key]
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max ? value : undefined
}

function finite(source: Record<string, unknown> | undefined, key: string) {
  const value = source?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function flag(source: Record<string, unknown> | undefined, key: string) {
  const value = source?.[key]
  return typeof value === "boolean" ? value : undefined
}

function diffCounts(value: unknown) {
  if (typeof value !== "string" || !value) return {}
  let additions = 0
  let deletions = 0
  for (const line of value.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions += 1
    else if (line.startsWith("-")) deletions += 1
  }
  return { additions, deletions }
}

function safePatchFiles(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const files = value.slice(0, 32).flatMap((entry) => {
    const row = record(entry)
    const path = text(row, "path", 4096)
    if (!path) return []
    const type = text(row, "type", 32)
    const movePath = text(row, "movePath", 4096)
    return [
      {
        path,
        ...(type ? { type } : {}),
        ...(movePath ? { movePath } : {}),
        ...(finite(row, "additions") === undefined ? {} : { additions: finite(row, "additions") }),
        ...(finite(row, "deletions") === undefined ? {} : { deletions: finite(row, "deletions") }),
      },
    ]
  })
  return files.length ? files : undefined
}

const SAFE_SUMMARY_TARGET_BYTES = 7 * 1024
const DETAIL_TARGET_BYTES = 3 * 1024
const DETAIL_MAX_STRING_BYTES = 2 * 1024
const DETAIL_MAX_DEPTH = 6
const DETAIL_MAX_ARRAY_ITEMS = 32
const DETAIL_MAX_OBJECT_KEYS = 64
const SECRET_KEY =
  /(?:pass(?:word)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|access[_-]?key|refresh[_-]?token)/i

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false }
  const suffix = "\n… [truncated]"
  const suffixBytes = Buffer.byteLength(suffix, "utf8")
  const body = Buffer.from(value, "utf8")
    .subarray(0, Math.max(0, maxBytes - suffixBytes))
    .toString("utf8")
  return { value: body + suffix, truncated: true }
}

function redactInlineSecrets(value: string) {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"';]+/gi, "$1[redacted]")
    .replace(/(^|\s)((?:--?)(?:token|api[-_]?key|password|secret)(?:=|\s+))[^\s"';]+/gi, "$1$2[redacted]")
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*=)[^\s"';]+/g,
      "$1[redacted]",
    )
}

function invocationDetail(value: unknown): OxpActivitySchema.InvocationDetail | undefined {
  if (value === undefined) return
  const seen = new WeakSet<object>()
  let remaining = DETAIL_TARGET_BYTES
  let truncated = false

  const spend = (bytes: number) => {
    remaining = Math.max(0, remaining - bytes)
  }

  const visit = (input: unknown, depth: number, key?: string): unknown => {
    if (remaining <= 0) {
      truncated = true
      return "[truncated]"
    }
    if (input === null || typeof input === "boolean" || typeof input === "number") {
      spend(16)
      return input
    }
    if (typeof input === "bigint") {
      const next = String(input)
      spend(Buffer.byteLength(next, "utf8"))
      return next
    }
    if (typeof input === "string") {
      if (key && SECRET_KEY.test(key)) {
        spend(10)
        return "[redacted]"
      }
      const redacted = redactInlineSecrets(input)
      const limit = Math.max(32, Math.min(DETAIL_MAX_STRING_BYTES, remaining))
      const next = truncateUtf8(redacted, limit)
      truncated ||= next.truncated
      spend(Buffer.byteLength(next.value, "utf8"))
      return next.value
    }
    if (typeof input === "undefined") return undefined
    if (typeof input !== "object") {
      const next = String(input)
      spend(Buffer.byteLength(next, "utf8"))
      return next
    }
    if (depth >= DETAIL_MAX_DEPTH) {
      truncated = true
      spend(16)
      return "[max depth]"
    }
    if (seen.has(input as object)) {
      spend(12)
      return "[circular]"
    }
    seen.add(input as object)

    if (Array.isArray(input)) {
      const source = input.slice(0, DETAIL_MAX_ARRAY_ITEMS)
      if (source.length !== input.length) truncated = true
      return source.map((entry) => visit(entry, depth + 1))
    }

    const result: Record<string, unknown> = {}
    const entries = Object.entries(input as Record<string, unknown>)
    if (entries.length > DETAIL_MAX_OBJECT_KEYS) truncated = true
    for (const [childKey, child] of entries.slice(0, DETAIL_MAX_OBJECT_KEYS)) {
      spend(Buffer.byteLength(childKey, "utf8"))
      const next = SECRET_KEY.test(childKey) ? "[redacted]" : visit(child, depth + 1, childKey)
      if (next !== undefined) result[childKey] = next
      if (remaining <= 0) break
    }
    return result
  }

  const sanitized = visit(value, 0)
  const detail = record(sanitized)
  if (!detail) return
  return truncated ? { ...detail, detailTruncated: true } : detail
}

const REQUEST_DETAIL_KEYS: Readonly<Record<string, readonly string[]>> = {
  read: ["action", "rootID", "path", "offset", "limit", "reads"],
  find: ["action", "rootID", "path", "glob", "grep", "include", "syntax", "maxResults"],
  edit: ["action", "rootID", "path"],
  write: ["action", "rootID", "path"],
  patch: ["action", "rootID", "format", "apply", "showDiff"],
  process: [
    "action",
    "rootID",
    "workdir",
    "command",
    "argv",
    "mode",
    "handle",
    "yieldMs",
    "timeoutMs",
    "offset",
    "maxBytes",
  ],
  git: [
    "action",
    "rootID",
    "workdir",
    "mode",
    "paths",
    "ref",
    "staged",
    "maxBytes",
    "maxCount",
    "contextLines",
    "dryRun",
  ],
  openfork_worker: [
    "action",
    "rootID",
    "workerID",
    "batchID",
    "title",
    "agent",
    "model",
    "expectedModel",
    "timeoutMs",
    "limit",
    "includeArchived",
    "nestedDelegation",
  ],
  openfork_session: [
    "action",
    "sessionID",
    "rootID",
    "parentID",
    "limit",
    "search",
    "roots",
    "includeArchived",
    "beforeMessageID",
    "model",
  ],
  openfork_request: ["action", "sessionID", "rootID", "requestID", "reply"],
  capability: ["action", "namespace", "rootID", "capability"],
  openfork_info: ["action"],
  openai_files: ["action", "rootID", "path", "fileID", "purpose", "limit"],
}

/**
 * Rich activity detail is a tiny presentation projection, never a generic copy
 * of tool arguments. Large/sensitive fields such as prompts, message text,
 * patch/write bodies, capability args and Goal payloads are intentionally absent.
 */
function requestDetail(input: BeginInput): OxpActivitySchema.InvocationDetail | undefined {
  const args = record(input.args)
  const keys = REQUEST_DETAIL_KEYS[input.tool]
  if (!args || !keys) return
  const projected: Record<string, unknown> = {}
  for (const key of keys) {
    const value = args[key]
    if (value !== undefined) projected[key] = value
  }
  if (Object.keys(projected).length === 0) return
  return invocationDetail({ args: projected })
}

/**
 * Successful results are already represented by safe_summary + typed resource
 * links (and often by the native resource itself). Persisting raw output or
 * structured result bodies here duplicates high-volume data into SQLite.
 */
function failureDetail(error: OxpError.Error): OxpActivitySchema.InvocationDetail | undefined {
  return invocationDetail({
    error: {
      code: error._tag,
      message: truncateUtf8(redactInlineSecrets(error.message), 1024).value,
      committed: error.metadata?.committed === true,
    },
  })
}

function finishSummary(value: Record<string, unknown>): OxpActivitySchema.SafeSummary | undefined {
  if (Object.keys(value).length === 0) return undefined
  const bytes = (candidate: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(candidate), "utf8")
  if (bytes(value) <= SAFE_SUMMARY_TARGET_BYTES) return value

  // Large multi-file operations can naturally exceed the durable 8 KiB
  // ceiling. Degrade presentation detail deterministically rather than
  // allowing observability to make the real operation look failed.
  const compact = { ...value }
  if (Array.isArray(compact.files)) {
    const files = [...compact.files]
    while (files.length > 1) {
      files.pop()
      compact.files = files
      compact.filesTruncated = true
      if (bytes(compact) <= SAFE_SUMMARY_TARGET_BYTES) return compact
    }
  }

  for (const key of ["path", "pattern", "include", "workdir", "root", "ref"] as const) {
    if (!(key in compact)) continue
    delete compact[key]
    compact.summaryTruncated = true
    if (bytes(compact) <= SAFE_SUMMARY_TARGET_BYTES) return compact
  }

  const minimal: Record<string, unknown> = { summaryTruncated: true }
  for (const key of [
    "continuityMarker",
    "action",
    "kind",
    "format",
    "fileCount",
    "count",
    "workerCount",
    "applied",
    "changed",
    "running",
    "exitCode",
    "outputBytes",
  ] as const) {
    if (value[key] !== undefined) minimal[key] = value[key]
  }
  return minimal
}

/**
 * Persist only the operation-specific, bounded projection the durable activity
 * UI is allowed to render. Raw args/results, prompts, file contents, patch
 * bodies, process output and credentials never cross this boundary.
 */
function safeSummary(
  input: BeginInput,
  result?: OxpResult.CapabilityResult,
): OxpActivitySchema.SafeSummary | undefined {
  const args = record(input.args)
  const metadata = record(result?.metadata)
  const structured = record(result?.structured)
  const base: Record<string, unknown> = input.continuityMarker ? { continuityMarker: input.continuityMarker } : {}
  const action = text(args, "action", 256)
  if (action) base.action = action

  if (input.tool === "read") {
    const path = text(metadata, "path", 4096)
    if (path) base.path = path
    for (const key of ["lines", "offset", "entries", "targets"] as const) {
      const value = finite(metadata, key)
      if (value !== undefined) base[key] = value
    }
    for (const key of ["directory", "attachment", "truncated"] as const) {
      const value = flag(metadata, key)
      if (value !== undefined) base[key] = value
    }
  } else if (input.tool === "find") {
    const kind = text(metadata, "action", 32)
    const pattern = kind === "glob" ? text(args, "glob", 2048) : text(args, "grep", 2048)
    const include = text(args, "include", 2048)
    const root = text(metadata, "root", 128)
    if (kind) base.kind = kind
    if (pattern) base.pattern = pattern
    if (include) base.include = include
    if (root) base.root = root
    const count = finite(metadata, "count")
    if (count !== undefined) base.count = count
    const truncated = flag(metadata, "truncated")
    if (truncated !== undefined) base.truncated = truncated
  } else if (input.tool === "edit" || input.tool === "write") {
    const path = text(metadata, "path", 4096)
    if (path) {
      const counts = diffCounts(metadata?.diff)
      base.files = [
        {
          path,
          type: input.tool === "write" && flag(metadata, "exists") === false ? "add" : "update",
          ...counts,
        },
      ]
    }
    const strategy = text(metadata, "strategy", 64)
    if (strategy) base.strategy = strategy
    const applied = finite(metadata, "applied")
    if (applied !== undefined) base.applied = applied
    const changed = flag(metadata, "changed")
    if (changed !== undefined) base.changed = changed
  } else if (input.tool === "patch") {
    const files = safePatchFiles(metadata?.files)
    if (files) base.files = files
    const format = text(metadata, "format", 32)
    if (format) base.format = format
    const fileCount = finite(metadata, "fileCount")
    if (fileCount !== undefined) base.fileCount = fileCount
    const applied = flag(metadata, "applied")
    if (applied !== undefined) base.applied = applied
  } else if (input.tool === "process") {
    for (const key of ["handle", "workdir", "mode"] as const) {
      const value = text(metadata ?? structured, key, key === "workdir" ? 4096 : 128)
      if (value) base[key] = value
    }
    for (const key of ["exitCode", "outputBytes", "retainedBytes"] as const) {
      const value = finite(metadata ?? structured, key)
      if (value !== undefined) base[key] = value
    }
    for (const key of ["running", "truncated", "pageTruncated"] as const) {
      const value = flag(metadata ?? structured, key)
      if (value !== undefined) base[key] = value
    }
  } else if (input.tool === "git") {
    for (const key of ["root", "workdir", "mode", "branch", "ref"] as const) {
      const value = text(metadata, key, 4096)
      if (value) base[key] = value
    }
    for (const key of ["files", "additions", "deletions"] as const) {
      const value = finite(metadata, key)
      if (value !== undefined) base[key] = value
    }
  } else if (input.tool === "openfork_worker") {
    for (const key of ["workerID", "batchID", "agent"] as const) {
      const value = text(args, key, 512) ?? text(structured, key, 512)
      if (value) base[key] = value
    }
    const model = record(args?.model) ?? record(structured?.model)
    if (model) {
      const providerID = text(model, "providerID", 256)
      const modelID = text(model, "modelID", 256)
      const variant = text(model, "variant", 256)
      if (providerID && modelID) base.model = { providerID, modelID, ...(variant ? { variant } : {}) }
    }
    if (Array.isArray(args?.workers)) base.workerCount = Math.min(args.workers.length, 16)
    if (Array.isArray(structured?.workerIDs)) base.workerCount = Math.min(structured.workerIDs.length, 100)
  } else if (input.tool === "openfork_session" || input.tool === "openfork_request") {
    for (const key of ["sessionID", "requestID"] as const) {
      const value = text(args, key, 512) ?? text(structured, key, 512)
      if (value) base[key] = value
    }
    const agent = text(args, "agent", 256) ?? text(structured, "agent", 256)
    if (agent) base.agent = agent
    const model = record(args?.model) ?? record(structured?.model)
    if (model) {
      const providerID = text(model, "providerID", 256)
      const modelID = text(model, "modelID", 256)
      const variant = text(model, "variant", 256)
      if (providerID && modelID) base.model = { providerID, modelID, ...(variant ? { variant } : {}) }
    }
  } else if (input.tool === "capability") {
    const namespace = text(args, "namespace", 64)
    const capability = text(args, "capability", 512)
    const canonicalNamespace = text(metadata, "namespace", 64)
    const canonicalCapability = text(metadata, "capability", 512)
    if (
      canonicalNamespace === "mcp" &&
      canonicalCapability &&
      /^[^/\s]{1,255}\/[^/\s]{1,255}$/.test(canonicalCapability)
    ) {
      // External MCP selectors are caller-controlled. Persist only the
      // capability broker's canonical server/tool identity after execution.
      base.namespace = canonicalNamespace
      base.capability = canonicalCapability
    } else if (namespace === "openfork" && capability && /^[A-Za-z0-9_.-]{1,128}$/.test(capability)) {
      // OpenFork capability identifiers are a closed structural namespace;
      // arguments/results remain excluded from the durable activity record.
      base.namespace = namespace
      base.capability = capability
    }
  } else if (input.tool === "openfork_info") {
    // action is already included in base
  } else if (input.tool === "openai_files") {
    const resultAction = text(structured, "action", 64) ?? text(metadata, "action", 64)
    if (resultAction) base.action = resultAction
    const bytes = finite(structured, "bytes") ?? finite(metadata, "bytes")
    if (bytes !== undefined) base.bytes = bytes
  }

  return finishSummary(base)
}

export function plane(tool: string): OxpActivitySchema.Plane {
  if (tool === "openfork_session" || tool === "openfork_request") return "supervision"
  if (tool === "openfork_worker") return "delegation"
  return "augmentation"
}

function status(error: OxpError.Error): Exclude<OxpActivitySchema.Status, "running"> {
  if (error._tag === "OXP_CANCELLED") {
    return error.metadata?.committed === true ? "cancelled_after_commit" : "cancelled_before_commit"
  }
  if (error._tag === "OXP_AUTH_DENIED" || error._tag === "OXP_AUTH_REVOKED" || error._tag === "OXP_PATH_ESCAPE")
    return "denied"
  if (error._tag === "OXP_CONFLICT" || error._tag === "OXP_ROOT_CHANGED") return "conflict"
  if (error._tag === "OXP_AMBIGUOUS_EXTERNAL_RESULT") return "ambiguous_external_result"
  return "failed"
}

type Link = {
  readonly kind: OxpActivitySchema.LinkKind
  readonly ref: string
  readonly relation: string
  readonly label?: string
}

function inputLinks(tool: string, args: unknown, rootAlias?: string): Link[] {
  const source = record(args)
  if (!source) return []
  const links: Link[] = []
  const rootID = text(source, "rootID", 128)
  if (rootID)
    links.push({
      kind: "root",
      ref: rootID,
      relation: "target",
      ...(rootAlias ? { label: rootAlias } : {}),
    })
  const sessionID = text(source, "sessionID")
  if (sessionID && (tool === "openfork_session" || tool === "openfork_request")) {
    links.push({ kind: "session", ref: sessionID, relation: "target" })
  }
  if (tool === "openfork_worker") {
    const workerID = text(source, "workerID")
    if (workerID)
      links.push({
        kind: "worker_session",
        ref: workerID,
        relation: "target",
      })
    const batchID = text(source, "batchID")
    if (batchID)
      links.push({
        kind: "worker_group",
        ref: batchID,
        relation: "target",
      })
  }
  if (tool === "process") {
    const handle = text(source, "handle")
    if (handle) links.push({ kind: "process", ref: handle, relation: "target" })
  }
  return links
}

function resultLinks(
  tool: string,
  action: string | undefined,
  args: unknown,
  result: OxpResult.CapabilityResult,
): Link[] {
  const source = record(result.structured)
  const metadata = record(result.metadata)
  const links: Link[] = []
  const input = record(args)
  const namespace = text(input, "namespace", 64) ?? "openfork"
  const capability = text(input, "capability", 512)

  if (tool === "capability" && action === "call" && namespace === "mcp" && metadata?.namespace === "mcp") {
    const canonical = text(metadata, "capability", 512)
    if (canonical && /^[^/\s]{1,255}\/[^/\s]{1,255}$/.test(canonical))
      links.push({
        kind: "external_mcp",
        ref: canonical,
        relation: "called",
      })
  }

  if (
    source &&
    tool === "capability" &&
    action === "call" &&
    namespace === "openfork" &&
    capability === "schedule.create"
  ) {
    const taskID = text(source, "taskID", 512)
    if (taskID)
      links.push({
        kind: "scheduled_task",
        ref: taskID,
        relation: source.created === true ? "created" : "observed",
      })
  }

  if (
    source &&
    (tool === "openai_files" ||
      (tool === "capability" && action === "call" && namespace === "openfork" && capability === "file.transfer"))
  ) {
    const transferAction = text(source, "action", 64)
    const file = record(source.file)
    const fileRef = text(source, "source_file_id", 512) ?? text(file, "id", 512)
    if (fileRef && transferAction && transferAction !== "list_openai_files") {
      const relation =
        transferAction === "upload_openai_file"
          ? "created"
          : transferAction === "get_openai_file"
            ? "observed"
            : "transferred"
      links.push({
        kind: "file_transfer",
        ref: fileRef,
        relation,
      })
    }
  }

  if (source && tool === "openfork_session") {
    const sessionID = text(source, "sessionID")
    if (sessionID) links.push({ kind: "session", ref: sessionID, relation: "observed" })
  }
  if (source && tool === "openfork_worker") {
    const workerID = text(source, "workerID")
    if (workerID) {
      links.push({
        kind: "worker_session",
        ref: workerID,
        relation: action === "start" ? "created" : "observed",
      })
    }
    const batchID = text(source, "batchID")
    if (batchID)
      links.push({
        kind: "worker_group",
        ref: batchID,
        relation: action === "batch_start" ? "created" : "observed",
      })
    const workerIDs = source.workerIDs
    if (Array.isArray(workerIDs)) {
      for (const value of workerIDs) {
        if (typeof value !== "string" || Buffer.byteLength(value) > 512) continue
        links.push({
          kind: "worker_session",
          ref: value,
          relation: action === "batch_start" ? "created" : "observed",
        })
      }
    }
  }
  if (source && tool === "process") {
    const handle = text(source, "handle")
    if (handle)
      links.push({
        kind: "process",
        ref: handle,
        relation: action === "start" ? "created" : "observed",
      })
  }
  return links
}

function errorLinks(tool: string, error: OxpError.Error): Link[] {
  const metadata = error.metadata
  if (!metadata) return []
  const source = metadata as Readonly<Record<string, unknown>>
  const links: Link[] = []
  if (tool === "openfork_worker") {
    const workerID = text(source as Record<string, unknown>, "workerID")
    if (workerID)
      links.push({
        kind: "worker_session",
        ref: workerID,
        relation: error.metadata?.committed === true ? "created" : "observed",
      })
    const batchID = text(source as Record<string, unknown>, "batchID")
    if (batchID)
      links.push({
        kind: "worker_group",
        ref: batchID,
        relation: error.metadata?.committed === true ? "created" : "observed",
      })
  }
  return links
}

function recoverableHostRun(value: string): RuntimeOwner.ID | undefined {
  return value.startsWith("runtime-owner:") ? (value as RuntimeOwner.ID) : undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const activity = yield* OxpActivity.Service
    const identity = yield* OxpActivityIdentity.Service
    const config = yield* OxpConfig.Service
    const runtime = yield* RuntimeOwner.Service
    const retention = yield* runtime.retain.pipe(
      Effect.map((value) => value as RuntimeOwner.Retention | undefined),
      Effect.catchCause((cause) =>
        Effect.logWarning("OXP activity host liveness retention failed", {
          hostRunID: runtime.id,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    )
    const hostRunID = runtime.id

    // Recovery is conservative by construction. A different host generation is
    // never sufficient evidence by itself: only RuntimeOwner's local ESRCH proof
    // permits us to declare that generation unable to observe a terminal result.
    // Legacy/random host ids and remote/unknown owners remain running rather than
    // being rewritten from insufficient evidence.
    yield* Effect.gen(function* () {
      for (const candidate of yield* activity.runningHostRuns()) {
        if (candidate === hostRunID) continue
        const ownerID = recoverableHostRun(candidate)
        if (!ownerID) continue
        if ((yield* runtime.proveLocalDeath(ownerID)) !== "dead") continue
        yield* activity.interruptHostRun(candidate)
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("OXP activity dead-host recovery failed", { cause })))

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // On graceful host teardown, any span that is still running has no
        // terminal observation from this host. Marking it interrupted is
        // intentionally weaker than rollback and preserves mutation flags.
        yield* activity.interruptHostRun(hostRunID)
      }).pipe(
        retention ? Effect.ensuring(retention.release) : (effect) => effect,
        Effect.catchCause((cause) =>
          Effect.logWarning("OXP activity graceful host settlement failed", {
            hostRunID,
            cause,
          }),
        ),
      ),
    )

    const linkAll = (invocationID: OxpActivitySchema.InvocationID, links: readonly Link[]) => {
      if (links.length === 0) return Effect.void
      return Effect.forEach(
        links,
        (link) => activity.link({ invocationID, ...link }).pipe(Effect.catchCause(() => Effect.void)),
        { discard: true, concurrency: "unbounded" },
      )
    }

    const beginRaw = Effect.fn("OxpActivityRecorder.beginRaw")(function* (input: BeginInput) {
      if (!input.parentCorrelation) return undefined
      const correlation = yield* identity.pseudonymize(input.parentCorrelation)
      const args = record(input.args)
      const rootID = text(args, "rootID", 128)
      const action = text(args, "action", 256)
      const rootAlias = rootID ? (yield* config.get()).roots.find((root) => root.id === rootID)?.alias : undefined
      const summary = safeSummary(input)
      const detail = requestDetail(input)
      const requestChars = requestContextChars(input.args)
      const started = yield* activity.begin({
        correlation,
        hostRunID,
        observedEpoch: input.observedEpoch,
        plane: plane(input.tool),
        tool: input.tool,
        action,
        rootID,
        rootAlias,
        ...(summary ? { summary } : {}),
        ...(detail ? { detail } : {}),
        ...(requestChars === undefined
          ? {}
          : {
              contextRequest: {
                chars: requestChars,
                source: "observed_boundary" as const,
                schema: BOUNDARY_CONTEXT_SCHEMA,
              },
            }),
      })
      yield* linkAll(started.invocationID, inputLinks(input.tool, input.args, rootAlias))
      return {
        activityID: started.activityID,
        invocationID: started.invocationID,
      } satisfies Handle
    })

    const begin: Interface["begin"] = (input) =>
      beginRaw(input).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    const success: Interface["success"] = (handle, input, result, resultContextChars) => {
      if (!handle) return Effect.void
      const args = record(input.args)
      const action = text(args, "action", 256)
      return Effect.gen(function* () {
        yield* linkAll(handle.invocationID, resultLinks(input.tool, action, input.args, result))
        yield* activity.settle({
          invocationID: handle.invocationID,
          status: result.mutation?.committed ? "committed" : "success",
          mutationAttempted: result.mutation?.attempted ?? false,
          mutationCommitted: result.mutation?.committed ?? false,
          summary: safeSummary(input, result),
          ...(resultContextChars === undefined
            ? {}
            : {
                contextResult: {
                  chars: resultContextChars,
                  source: "observed_boundary" as const,
                  schema: BOUNDARY_CONTEXT_SCHEMA,
                },
              }),
        })
      }).pipe(Effect.catchCause(() => Effect.void))
    }

    const failure: Interface["failure"] = (handle, input, error, resultContextChars) => {
      if (!handle) return Effect.void
      return Effect.gen(function* () {
        yield* linkAll(handle.invocationID, errorLinks(input.tool, error))
        const committed = error.metadata?.committed === true
        yield* activity.settle({
          invocationID: handle.invocationID,
          status: status(error),
          errorCode: error._tag,
          mutationAttempted: committed,
          mutationCommitted: committed,
          summary: safeSummary(input),
          detail: failureDetail(error),
          ...(resultContextChars === undefined
            ? {}
            : {
                contextResult: {
                  chars: resultContextChars,
                  source: "observed_boundary" as const,
                  schema: BOUNDARY_CONTEXT_SCHEMA,
                },
              }),
        })
      }).pipe(Effect.catchCause(() => Effect.void))
    }

    return Service.of({ begin, success, failure })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpActivity.node, OxpActivityIdentity.node, OxpConfig.node, RuntimeOwner.node],
})

export * as OxpActivityRecorder from "./activity-recorder"
