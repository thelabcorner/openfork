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
  ) => Effect.Effect<void>
  readonly failure: (
    handle: Handle | undefined,
    input: BeginInput,
    error: OxpError.Error,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpActivityRecorder",
) {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(
  source: Record<string, unknown> | undefined,
  key: string,
  max = 512,
) {
  const value = source?.[key]
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max
    ? value
    : undefined
}

export function plane(tool: string): OxpActivitySchema.Plane {
  if (tool === "openfork_session" || tool === "openfork_request")
    return "supervision"
  if (tool === "openfork_worker") return "delegation"
  return "augmentation"
}

function status(
  error: OxpError.Error,
): Exclude<OxpActivitySchema.Status, "running"> {
  if (error._tag === "OXP_CANCELLED") {
    return error.metadata?.committed === true
      ? "cancelled_after_commit"
      : "cancelled_before_commit"
  }
  if (
    error._tag === "OXP_AUTH_DENIED" ||
    error._tag === "OXP_AUTH_REVOKED" ||
    error._tag === "OXP_PATH_ESCAPE"
  )
    return "denied"
  if (
    error._tag === "OXP_CONFLICT" ||
    error._tag === "OXP_ROOT_CHANGED"
  )
    return "conflict"
  if (error._tag === "OXP_AMBIGUOUS_EXTERNAL_RESULT")
    return "ambiguous_external_result"
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
  if (
    sessionID &&
    (tool === "openfork_session" || tool === "openfork_request")
  ) {
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
    if (handle)
      links.push({ kind: "process", ref: handle, relation: "target" })
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

  if (
    tool === "capability" &&
    action === "call" &&
    namespace === "mcp" &&
    metadata?.namespace === "mcp"
  ) {
    const canonical = text(metadata, "capability", 512)
    if (
      canonical &&
      /^[^/\s]{1,255}\/[^/\s]{1,255}$/.test(canonical)
    )
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
      (tool === "capability" &&
        action === "call" &&
        namespace === "openfork" &&
        capability === "file.transfer"))
  ) {
    const transferAction = text(source, "action", 64)
    const file = record(source.file)
    const fileRef =
      text(source, "source_file_id", 512) ??
      text(file, "id", 512)
    if (
      fileRef &&
      transferAction &&
      transferAction !== "list_openai_files"
    ) {
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
    if (sessionID)
      links.push({ kind: "session", ref: sessionID, relation: "observed" })
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
  return value.startsWith("runtime-owner:")
    ? (value as RuntimeOwner.ID)
    : undefined
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
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("OXP activity dead-host recovery failed", { cause }),
      ),
    )

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

    const linkAll = (
      invocationID: OxpActivitySchema.InvocationID,
      links: readonly Link[],
    ) =>
      Effect.forEach(
        links,
        (link) =>
          activity
            .link({ invocationID, ...link })
            .pipe(Effect.catchCause(() => Effect.void)),
        { discard: true, concurrency: "unbounded" },
      )

    const beginRaw = Effect.fn("OxpActivityRecorder.beginRaw")(function* (
      input: BeginInput,
    ) {
      if (!input.parentCorrelation) return undefined
      const correlation = yield* identity.pseudonymize(input.parentCorrelation)
      const args = record(input.args)
      const rootID = text(args, "rootID", 128)
      const action = text(args, "action", 256)
      const rootAlias = rootID
        ? (yield* config.get()).roots.find((root) => root.id === rootID)?.alias
        : undefined
      const started = yield* activity.begin({
        correlation,
        hostRunID,
        observedEpoch: input.observedEpoch,
        plane: plane(input.tool),
        tool: input.tool,
        action,
        rootID,
        rootAlias,
        ...(input.continuityMarker
          ? { summary: { continuityMarker: input.continuityMarker } }
          : {}),
      })
      yield* linkAll(
        started.invocationID,
        inputLinks(input.tool, input.args, rootAlias),
      )
      return {
        activityID: started.activityID,
        invocationID: started.invocationID,
      } satisfies Handle
    })

    const begin: Interface["begin"] = (input) =>
      beginRaw(input).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    const success: Interface["success"] = (handle, input, result) => {
      if (!handle) return Effect.void
      const args = record(input.args)
      const action = text(args, "action", 256)
      return Effect.gen(function* () {
        yield* linkAll(
          handle.invocationID,
          resultLinks(input.tool, action, input.args, result),
        )
        yield* activity.settle({
          invocationID: handle.invocationID,
          status: result.mutation?.committed ? "committed" : "success",
          mutationAttempted: result.mutation?.attempted ?? false,
          mutationCommitted: result.mutation?.committed ?? false,
        })
      }).pipe(Effect.catchCause(() => Effect.void))
    }

    const failure: Interface["failure"] = (handle, input, error) => {
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
        })
      }).pipe(Effect.catchCause(() => Effect.void))
    }

    return Service.of({ begin, success, failure })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    OxpActivity.node,
    OxpActivityIdentity.node,
    OxpConfig.node,
    RuntimeOwner.node,
  ],
})

export * as OxpActivityRecorder from "./activity-recorder"
