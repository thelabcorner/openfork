import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { SessionDelegationInspection } from "@opencode-ai/core/session/delegation-inspection"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { OxpAuthority } from "./authority"
import { OxpAgentCatalog } from "./agent-catalog"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpModelSelection } from "./model-selection"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"
import { OxpWorkerControl } from "./worker-control"

const MAX_WORKERS = 100
const MAX_SCAN = 1_000
const SCAN_PAGE = 100
const MAX_BATCH_WORKERS = 16
const MAX_PROMPT_BYTES = 64 * 1024

const ID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PROMPT_BYTES),
)
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

const WorkerStart = Schema.Struct({
  title: Schema.optional(Name),
  prompt: Text,
  agent: Schema.optional(Name),
  model: Schema.optional(OxpSchema.ModelSelection),
  nestedDelegation: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Oxp.WorkerStart" })

const WorkerContinue = Schema.Struct({
  workerID: ID,
  prompt: Text,
  agent: Schema.optional(Name),
  model: Schema.optional(OxpSchema.ModelSelection),
}).annotate({ identifier: "Oxp.WorkerContinue" })

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "agent_catalog",
    "start",
    "list",
    "get",
    "wait",
    "result",
    "continue",
    "cancel",
    "batch_start",
    "batch_list",
    "batch_get",
    "batch_wait",
    "batch_cancel",
    "batch_continue",
  ]),
  rootID: Schema.optional(OxpSchema.RootID),
  workerID: Schema.optional(ID),
  batchID: Schema.optional(ID),
  title: Schema.optional(Name),
  prompt: Schema.optional(Text),
  agent: Schema.optional(Name),
  model: Schema.optional(OxpSchema.ModelSelection),
  nestedDelegation: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 })),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_WORKERS })),
  ),
  includeArchived: Schema.optional(Schema.Boolean),
  workers: Schema.optional(
    Schema.Array(WorkerStart).check(Schema.isMaxLength(MAX_BATCH_WORKERS)),
  ),
  continuations: Schema.optional(
    Schema.Array(WorkerContinue).check(Schema.isMaxLength(MAX_BATCH_WORKERS)),
  ),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (
    input: Input,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpWorker",
) {}
export const use = serviceUse(Service)

function modelKey(model: OxpSchema.ModelSelection) {
  return JSON.stringify({
    providerID: model.providerID,
    modelID: model.modelID,
    accountID: model.accountID ?? null,
    variant: model.variant ?? null,
  })
}

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail<OxpError.Error>(
        new OxpError.Cancelled({ detail: "OXP worker request was cancelled" }),
      )
    : Effect.void
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const agentCatalog = yield* OxpAgentCatalog.Service
    const config = yield* OxpConfig.Service
    const delegation = yield* SessionDelegationInspection.Service
    const control = yield* OxpWorkerControl.Service

    const currentIdentity = Effect.fnUntraced(function* () {
      const state = yield* config.get()
      return {
        connectorID: state.connector.id,
        principalRef: "oxp:" + state.connector.id,
        nestedDelegation: state.grant.nestedDelegation,
      }
    })

    const normalizeModel = (model: OxpSchema.ModelSelection) =>
      Effect.try({
        try: () => OxpModelSelection.normalize(model),
        catch: (cause) =>
          OxpError.isError(cause)
            ? cause
            : new OxpError.InvalidArgument({
                detail: "Invalid delegated-worker model selection",
              }),
      })


    const mapControlError = (
      error: Error,
      explicitAccountID?: string,
    ): OxpError.Error => {
      if (OxpError.isError(error)) return error
      if (error instanceof OxpWorkerControl.InvalidWorker) {
        return new OxpError.NotFound({
          detail: "Delegated worker is not available to this OXP principal",
        })
      }
      if (error instanceof OxpWorkerControl.SelectionUnavailable) {
        if (error.explicitAccount) {
          return new OxpError.ProviderAccountUnavailable({
            detail: OxpError.boundDetail(error.message),
            ...(explicitAccountID
              ? { metadata: { accountID: explicitAccountID } }
              : {}),
          })
        }
        return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.message) })
      }
      if (error instanceof OxpWorkerControl.StartCommitted) {
        return new OxpError.DependencyUnavailable({
          detail: OxpError.boundDetail(error.message),
          metadata: { workerID: error.workerID, committed: true },
        })
      }
      if (error instanceof OxpWorkerControl.ContinueCommitted) {
        return new OxpError.DependencyUnavailable({
          detail: OxpError.boundDetail(error.message),
          metadata: { workerID: error.workerID, committed: true },
        })
      }
      if (error instanceof OxpWorkerControl.BatchCommitted) {
        return new OxpError.DependencyUnavailable({
          detail: OxpError.boundDetail(error.message),
          metadata: {
            committed: error.workerIDs.length > 0 || error.batchID !== undefined,
            workersCommitted: error.workerIDs.length,
            ...workerHandleMetadata(error.workerIDs),
            ...(error.batchID ? { batchID: error.batchID } : {}),
          },
        })
      }
      const service = error.message.match(/Service not found:\s*([^\s)]+)/i)?.[1]
      if (service) {
        return new OxpError.DependencyUnavailable({
          detail: `Native delegated-worker runtime dependency is unavailable: ${service}`,
          metadata: {
            dependency: service.slice(0, 256),
            nativeError: error.name.slice(0, 256),
          },
        })
      }
      return new OxpError.DependencyUnavailable({
        detail: OxpError.boundDetail(error.message || "Native delegated-worker operation failed"),
        metadata: {
          nativeError: error.name.slice(0, 256),
        },
      })
    }

    const workerHandleMetadata = (workerIDs: readonly string[]) =>
      Object.fromEntries(
        workerIDs.map((workerID, index) => ["workerID" + index, workerID]),
      )

    const workerAdmission = Effect.fnUntraced(function* (
      row: SessionDelegationInspection.WorkerRow,
      operation: string,
      rootID?: OxpSchema.RootID,
    ) {
      const identity = yield* currentIdentity()
      const origin = row.origin
      if (
        row.malformedOrigin ||
        !origin ||
        origin.producer !== "oxp" ||
        origin.principalRef !== identity.principalRef
      ) {
        return yield* new OxpError.NotFound({
          detail: "Delegated worker is not available to this OXP principal",
        })
      }
      const admission = yield* authority
        .authorize({
          plane: "delegation",
          operation,
          phase: "delegate",
          ...(rootID ? { rootID } : {}),
          path: row.directory,
        })
        .pipe(
          Effect.mapError((error): OxpError.Error =>
            error._tag === "OXP_DEPENDENCY_UNAVAILABLE"
              ? error
              : new OxpError.NotFound({
                  detail:
                    "Delegated worker is not available to this OXP principal",
                }),
          ),
        )
      const admittedRoot = admission.root?.root.id
      if (!admittedRoot || origin.rootRef !== admittedRoot) {
        return yield* new OxpError.NotFound({
          detail: "Delegated worker is not available to this OXP principal",
        })
      }
      return { row, origin, admission, identity }
    })

    const getWorker = Effect.fnUntraced(function* (
      workerID: string,
      operation: string,
      rootID?: OxpSchema.RootID,
    ) {
      const row = yield* delegation.getWorker(
        SessionSchema.ID.make(workerID),
      )
      if (!row) {
        return yield* new OxpError.NotFound({
          detail: "Delegated worker is not available to this OXP principal",
        })
      }
      return yield* workerAdmission(row, operation, rootID)
    })

    const runtimeTarget = (
      row: SessionDelegationInspection.WorkerRow,
      admission: OxpAuthority.Admission,
      nested?: OxpAuthority.Admission,
    ): OxpWorkerControl.Target => ({
      directory: row.directory,
      ...(row.workspaceID
        ? { workspaceID: row.workspaceID }
        : {}),
      commitGuard: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* authority.revalidate(admission, "commit")
            if (nested) yield* authority.revalidate(nested, "commit")
            if (!admission.root) {
              return yield* new OxpError.RootRequired({
                detail: "Delegated worker operation requires an approved root",
              })
            }
          }),
        ),
    })

    const rootRuntimeTarget = (
      admission: OxpAuthority.Admission,
      nested?: OxpAuthority.Admission,
    ): OxpWorkerControl.Target => {
      const root = admission.root
      if (!root) {
        throw new OxpError.RootRequired({
          detail: "Delegated worker operation requires an approved root",
        })
      }
      return {
        directory: root.canonicalPath,
        commitGuard: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* authority.revalidate(admission, "commit")
              if (nested) yield* authority.revalidate(nested, "commit")
            }),
          ),
      }
    }

    const projectWorker = (
      row: SessionDelegationInspection.WorkerRow,
      origin: NonNullable<SessionDelegationInspection.WorkerRow["origin"]>,
      admission: OxpAuthority.Admission,
    ) => {
      const root = admission.root
      if (!root || !("path" in root)) {
        throw new OxpError.NotFound({
          detail: "Delegated worker is not available to this OXP principal",
        })
      }
      return {
        workerID: row.id,
        title: row.title,
        agent: origin.agent,
        model: origin.model,
        nestedDelegation: origin.nestedDelegation,
        ...(origin.parentWorkerID
          ? { parentWorkerID: origin.parentWorkerID }
          : {}),
        location: {
          rootID: root.root.id,
          path: root.virtualPath,
        },
        execution: row.execution,
        archived: row.archivedAt !== undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    }

    const batchOwned = Effect.fnUntraced(function* (
      batch: SessionDelegationInspection.BatchRow,
      operation: string,
      rootID?: OxpSchema.RootID,
    ) {
      const identity = yield* currentIdentity()
      const ownerPrefix = "oxp-batch:" + identity.principalRef + ":"
      if (
        !batch.ownerRef?.startsWith(ownerPrefix) ||
        batch.memberIDs.length === 0
      ) {
        return yield* new OxpError.NotFound({
          detail: "Delegated batch is not available to this OXP principal",
        })
      }
      const workers = []
      for (const id of batch.memberIDs) {
        workers.push(
          yield* getWorker(String(id), operation, rootID),
        )
      }
      const rootRefs = new Set(
        workers.map((worker) => worker.origin.rootRef),
      )
      const durableRoot = rootRefs.size === 1 ? [...rootRefs][0] : undefined
      if (
        !durableRoot ||
        !batch.ownerRef.startsWith(ownerPrefix + durableRoot + ":")
      ) {
        return yield* new OxpError.NotFound({
          detail: "Delegated batch is not available to this OXP principal",
        })
      }
      return { batch, workers, identity }
    })

    const executeRaw = Effect.fn("OxpWorker.execute")(function* (
      input: Input,
      signal?: AbortSignal,
    ) {
      yield* cancelled(signal)
      const operation = "worker." + input.action

      if (input.action === "agent_catalog") {
        if (!input.rootID) {
          return yield* new OxpError.InvalidArgument({
            detail: "worker.agent_catalog requires rootID",
          })
        }
        const admission = yield* authority.authorize({
          plane: "delegation",
          operation,
          phase: "read",
          rootID: input.rootID,
        })
        const root = admission.root
        if (!root) {
          return yield* new OxpError.RootRequired({
            detail: "Delegated-worker agent catalog requires an approved root",
          })
        }
        const catalog = yield* agentCatalog.list({
          directory: root.canonicalPath,
        })
        yield* authority.revalidate(admission, "egress")
        const result = {
          rootID: root.root.id,
          rootAlias: root.root.alias,
          agents: catalog.agents,
          nativeDefaultAgent: catalog.nativeDefaultAgent,
        }
        return {
          title: "OpenFork delegated-worker agent catalog",
          output: JSON.stringify(result),
          structured: result,
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "start") {
        if (!input.rootID || !input.prompt) {
          return yield* new OxpError.InvalidArgument({
            detail: "worker.start requires rootID and prompt",
          })
        }
        const admission = yield* authority.authorize({
          plane: "delegation",
          operation,
          phase: "delegate",
          rootID: input.rootID,
        })
        if (!admission.root) {
          return yield* new OxpError.RootRequired({
            detail: "Delegated-worker start requires an approved root",
          })
        }
        const identity = yield* currentIdentity()
        const selected = yield* control
          .resolveSelection(rootRuntimeTarget(admission), {
            ...(input.agent ? { agent: input.agent } : {}),
            ...(input.model
              ? { model: yield* normalizeModel(input.model) }
              : {}),
          })
          .pipe(
            Effect.mapError((error) =>
              mapControlError(error, input.model?.accountID),
            ),
          )
        const nestedRequested = input.nestedDelegation === true
        const nested = nestedRequested
          ? yield* authority.authorize({
              plane: "delegation",
              operation: "worker.nested.start",
              phase: "delegate",
              rootID: input.rootID,
            })
          : undefined
        const invocationRef = "oxp-inv:" + randomUUID()
        const started = yield* control
          .start(
            rootRuntimeTarget(admission, nested),
            {
              title: input.title ?? "OXP delegated worker",
              prompt: input.prompt,
              agent: selected.agent,
              model: selected.model,
              origin: {
                producer: "oxp",
                principalRef: identity.principalRef,
                invocationRef,
                rootRef: String(input.rootID),
                agent: selected.agent,
                model: selected.model,
                nestedDelegation: nestedRequested,
              },
            },
          )
          .pipe(
            Effect.mapError((error) =>
              mapControlError(error, selected.model.accountID),
            ),
          )
        if (signal?.aborted) {
          return yield* new OxpError.Cancelled({
            detail:
              "Delegated worker committed and continues after caller cancellation",
            metadata: { workerID: started.workerID, committed: true },
          })
        }
        const result = {
          workerID: started.workerID,
          invocationRef,
        }
        return {
          title: "OpenFork delegated worker started",
          output: JSON.stringify(result),
          structured: result,
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "list") {
        const identity = yield* currentIdentity()
        const requested = input.limit ?? 50
        const rows: unknown[] = []
        let before:
          | { updatedAt: number; id: SessionSchema.ID }
          | undefined
        let scanned = 0
        while (rows.length < requested && scanned < MAX_SCAN) {
          const page = yield* delegation.listWorkers({
            producer: "oxp",
            principalRef: identity.principalRef,
            limit: Math.min(SCAN_PAGE, MAX_SCAN - scanned),
            includeArchived: input.includeArchived,
            ...(before ? { before } : {}),
          })
          if (page.length === 0) break
          scanned += page.length
          for (const row of page) {
            const projected = yield* workerAdmission(
              row,
              operation,
              input.rootID,
            ).pipe(
              Effect.flatMap(({ origin, admission }) =>
                Effect.try({
                  try: () => projectWorker(row, origin, admission),
                  catch: () =>
                    new OxpError.NotFound({
                      detail: "Delegated worker unavailable",
                    }),
                }),
              ),
              Effect.option,
            )
            if (projected._tag === "Some") rows.push(projected.value)
            if (rows.length >= requested) break
          }
          const last = page.at(-1)
          if (!last || page.length < Math.min(SCAN_PAGE, MAX_SCAN - scanned + page.length)) break
          before = { updatedAt: last.updatedAt, id: last.id }
        }
        return {
          title: "OpenFork delegated workers",
          output: JSON.stringify({ workers: rows }),
          structured: { workers: rows },
          metadata: { count: rows.length },
        } satisfies OxpResult.CapabilityResult
      }

      if (
        input.action === "get" ||
        input.action === "wait" ||
        input.action === "result" ||
        input.action === "continue" ||
        input.action === "cancel"
      ) {
        if (!input.workerID) {
          return yield* new OxpError.InvalidArgument({
            detail: "worker." + input.action + " requires workerID",
          })
        }
        const target = yield* getWorker(
          input.workerID,
          operation,
          input.rootID,
        )
        if (input.action === "get") {
          const result = projectWorker(target.row, target.origin, target.admission)
          return {
            title: "OpenFork delegated worker",
            output: JSON.stringify(result),
            structured: result,
          } satisfies OxpResult.CapabilityResult
        }
        const identity: OxpWorkerControl.Identity = {
          producer: "oxp",
          principalRef: target.identity.principalRef,
        }
        if (input.action === "continue") {
          if (!input.prompt) {
            return yield* new OxpError.InvalidArgument({
              detail: "worker.continue requires prompt",
            })
          }
          if (input.model) {
            const normalized = yield* normalizeModel(input.model)
            if (modelKey(normalized) !== modelKey(target.origin.model)) {
              return yield* new OxpError.InvalidArgument({
                detail:
                  "Continuation model/account selection must match the existing worker's durable selection",
              })
            }
          }
          if (input.agent && input.agent !== target.origin.agent) {
            return yield* new OxpError.InvalidArgument({
              detail:
                "Continuation agent must match the existing worker's durable selection",
            })
          }
          const nested = target.origin.nestedDelegation
            ? yield* authority
                .authorize({
                  plane: "delegation",
                  operation: "worker.nested.continue",
                  phase: "delegate",
                  path: target.row.directory,
                  ...(input.rootID ? { rootID: input.rootID } : {}),
                })
                .pipe(Effect.option)
            : undefined
          const nestedAdmission =
            nested && nested._tag === "Some" ? nested.value : undefined
          const invocationRef = "oxp-inv:" + randomUUID()
          const result = yield* control
            .continue(
              runtimeTarget(
                target.row,
                target.admission,
                nestedAdmission,
              ),
              {
                workerID: input.workerID,
                prompt: input.prompt,
                identity,
                invocationRef,
                nestedDelegation: nestedAdmission !== undefined,
                ...(input.model
                  ? { expectedModel: yield* normalizeModel(input.model) }
                  : {}),
                ...(input.agent ? { expectedAgent: input.agent } : {}),
              },
            )
            .pipe(
              Effect.mapError((error) =>
                mapControlError(error, input.model?.accountID),
              ),
            )
          if (signal?.aborted) {
            return yield* new OxpError.Cancelled({
              detail:
                "Delegated worker continuation committed and continues after caller cancellation",
              metadata: {
                workerID: input.workerID,
                invocationRef,
                committed: true,
              },
            })
          }
          return {
            title: "OpenFork delegated worker continued",
            output: JSON.stringify(result),
            structured: { ...result, invocationRef },
            mutation: { attempted: true, committed: true },
          } satisfies OxpResult.CapabilityResult
        }
        const call =
          input.action === "wait"
            ? control.wait(runtimeTarget(target.row, target.admission), {
                workerID: input.workerID,
                identity,
                ...(input.timeoutMs !== undefined
                  ? { timeoutMs: input.timeoutMs }
                  : {}),
              })
            : input.action === "result"
              ? control.result(runtimeTarget(target.row, target.admission), {
                  workerID: input.workerID,
                  identity,
                })
              : control.cancel(runtimeTarget(target.row, target.admission), {
                  workerID: input.workerID,
                  identity,
                })
        const result = yield* call.pipe(
          Effect.mapError((error) => mapControlError(error)),
        )
        if (input.action === "cancel" && signal?.aborted) {
          return yield* new OxpError.Cancelled({
            detail:
              "Delegated worker cancellation committed before caller cancellation was observed",
            metadata: {
              workerID: input.workerID,
              committed: true,
            },
          })
        }
        return {
          title: "OpenFork delegated worker " + input.action,
          output: JSON.stringify(result),
          structured: result,
          ...(input.action === "cancel"
            ? { mutation: { attempted: true, committed: true } }
            : {}),
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "batch_start") {
        if (!input.rootID || !input.workers || input.workers.length === 0) {
          return yield* new OxpError.InvalidArgument({
            detail: "worker.batch_start requires rootID and non-empty workers",
          })
        }
        const admission = yield* authority.authorize({
          plane: "delegation",
          operation,
          phase: "delegate",
          rootID: input.rootID,
        })
        if (!admission.root) {
          return yield* new OxpError.RootRequired({
            detail: "Delegated-worker batch start requires an approved root",
          })
        }
        const identity = yield* currentIdentity()
        const selected = []
        let needsNested = false
        for (const worker of input.workers) {
          const selection = yield* control
            .resolveSelection(rootRuntimeTarget(admission), {
              ...(worker.agent ? { agent: worker.agent } : {}),
              ...(worker.model
                ? { model: yield* normalizeModel(worker.model) }
                : {}),
            })
            .pipe(
              Effect.mapError((error) =>
                mapControlError(error, worker.model?.accountID),
              ),
            )
          const nestedDelegation = worker.nestedDelegation === true
          if (nestedDelegation) needsNested = true
          selected.push({ worker, selection, nestedDelegation })
        }
        const nested = needsNested
          ? yield* authority.authorize({
              plane: "delegation",
              operation: "worker.nested.batch_start",
              phase: "delegate",
              rootID: input.rootID,
            })
          : undefined
        const batchInvocationID = randomUUID()
        const batchRef = "oxp-batch:" + batchInvocationID
        const batchOwnerRef =
          "oxp-batch:" +
          identity.principalRef +
          ":" +
          input.rootID +
          ":" +
          batchInvocationID
        const result = yield* control
          .batchStart(
            rootRuntimeTarget(admission, nested),
            {
              name: input.title ?? "OXP delegated batch",
              ownerRef: batchOwnerRef,
              workers: selected.map(({ worker, selection, nestedDelegation }) => ({
                title: worker.title ?? "OXP delegated worker",
                prompt: worker.prompt,
                agent: selection.agent,
                model: selection.model,
                origin: {
                  producer: "oxp" as const,
                  principalRef: identity.principalRef,
                  invocationRef: "oxp-inv:" + randomUUID(),
                  rootRef: String(input.rootID),
                  agent: selection.agent,
                  model: selection.model,
                  nestedDelegation,
                },
              })),
            },
          )
          .pipe(Effect.mapError((error) => mapControlError(error)))
        if (signal?.aborted) {
          return yield* new OxpError.Cancelled({
            detail:
              "Delegated batch committed and continues after caller cancellation",
            metadata: {
              batchID: result.batchID,
              workersCommitted: result.workerIDs.length,
              ...workerHandleMetadata(result.workerIDs),
              committed: true,
            },
          })
        }
        return {
          title: "OpenFork delegated batch started",
          output: JSON.stringify({ ...result, batchRef }),
          structured: { ...result, batchRef },
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      if (
        input.action === "batch_list" ||
        input.action === "batch_get" ||
        input.action === "batch_wait" ||
        input.action === "batch_cancel" ||
        input.action === "batch_continue"
      ) {
        const identity = yield* currentIdentity()
        if (input.action === "batch_list") {
          const batches = yield* delegation.listBatches({
            limit: input.limit,
            ownerRefPrefix: "oxp-batch:" + identity.principalRef + ":",
          })
          const visible = []
          for (const batch of batches) {
            const owned = yield* batchOwned(
              batch,
              operation,
              input.rootID,
            ).pipe(Effect.option)
            if (owned._tag === "Some") {
              visible.push({
                batchID: batch.id,
                name: batch.name,
                workerIDs: batch.memberIDs,
                createdAt: batch.createdAt,
                updatedAt: batch.updatedAt,
              })
            }
          }
          return {
            title: "OpenFork delegated batches",
            output: JSON.stringify({ batches: visible }),
            structured: { batches: visible },
            metadata: { count: visible.length },
          } satisfies OxpResult.CapabilityResult
        }
        if (!input.batchID) {
          return yield* new OxpError.InvalidArgument({
            detail: "worker." + input.action + " requires batchID",
          })
        }
        const batch = yield* delegation.getBatch(input.batchID as never)
        if (!batch) {
          return yield* new OxpError.NotFound({
            detail: "Delegated batch is not available to this OXP principal",
          })
        }
        const owned = yield* batchOwned(batch, operation, input.rootID)
        if (input.action === "batch_get") {
          const result = {
            batchID: batch.id,
            name: batch.name,
            workerIDs: batch.memberIDs,
            createdAt: batch.createdAt,
            updatedAt: batch.updatedAt,
          }
          return {
            title: "OpenFork delegated batch",
            output: JSON.stringify(result),
            structured: result,
          } satisfies OxpResult.CapabilityResult
        }
        const target = owned.workers[0]!
        const workerIDs = batch.memberIDs.map(String)
        const runtime = runtimeTarget(target.row, target.admission)
        const controlIdentity: OxpWorkerControl.Identity = {
          producer: "oxp",
          principalRef: identity.principalRef,
        }
        const result =
          input.action === "batch_wait"
            ? yield* control
                .batchWait(runtime, {
                  identity: controlIdentity,
                  workerIDs,
                  ...(input.timeoutMs !== undefined
                    ? { timeoutMs: input.timeoutMs }
                    : {}),
                })
                .pipe(Effect.mapError(mapControlError))
            : input.action === "batch_cancel"
              ? yield* control
                  .batchCancel(runtime, {
                    identity: controlIdentity,
                    workerIDs,
                  })
                  .pipe(Effect.mapError(mapControlError))
              : yield* Effect.gen(function* () {
                  if (
                    !input.continuations ||
                    input.continuations.length === 0
                  ) {
                    return yield* new OxpError.InvalidArgument({
                      detail:
                        "worker.batch_continue requires non-empty continuations",
                    })
                  }
                  const members = new Set(workerIDs)
                  const resolved: Array<{
                    continuation: (typeof input.continuations)[number]
                    worker: (typeof owned.workers)[number]
                  }> = []
                  let needsNested = false
                  for (const continuation of input.continuations) {
                    if (!members.has(continuation.workerID)) {
                      return yield* new OxpError.InvalidArgument({
                        detail:
                          "batch_continue workerID is not a member of the delegated batch",
                      })
                    }
                    const worker = owned.workers.find(
                      (candidate) =>
                        String(candidate.row.id) ===
                        continuation.workerID,
                    )
                    if (!worker) {
                      return yield* new OxpError.NotFound({
                        detail:
                          "Delegated batch member is not available to this OXP principal",
                      })
                    }
                    if (continuation.model) {
                      const normalized = yield* normalizeModel(
                        continuation.model,
                      )
                      if (
                        modelKey(normalized) !==
                        modelKey(worker.origin.model)
                      ) {
                        return yield* new OxpError.InvalidArgument({
                          detail:
                            "Batch continuation model/account selection must match each existing worker's durable selection",
                        })
                      }
                    }
                    if (
                      continuation.agent &&
                      continuation.agent !== worker.origin.agent
                    ) {
                      return yield* new OxpError.InvalidArgument({
                        detail:
                          "Batch continuation agent must match each existing worker's durable selection",
                      })
                    }
                    if (worker.origin.nestedDelegation) needsNested = true
                    resolved.push({ continuation, worker })
                  }
                  const nested = needsNested
                    ? yield* authority
                        .authorize({
                          plane: "delegation",
                          operation: "worker.nested.batch_continue",
                          phase: "delegate",
                          rootID: target.admission.root?.root.id,
                          path: target.row.directory,
                        })
                        .pipe(Effect.option)
                    : undefined
                  const nestedAdmission =
                    nested && nested._tag === "Some" ? nested.value : undefined
                  const items: OxpWorkerControl.ContinueInput[] = []
                  for (const { continuation, worker } of resolved) {
                    items.push({
                      workerID: continuation.workerID,
                      prompt: continuation.prompt,
                      identity: controlIdentity,
                      invocationRef: "oxp-inv:" + randomUUID(),
                      nestedDelegation:
                        worker.origin.nestedDelegation &&
                        nestedAdmission !== undefined,
                      ...(continuation.model
                        ? {
                            expectedModel: yield* normalizeModel(
                              continuation.model,
                            ),
                          }
                        : {}),
                      ...(continuation.agent
                        ? { expectedAgent: continuation.agent }
                        : {}),
                    })
                  }
                  return yield* control
                    .batchContinue(
                      runtimeTarget(target.row, target.admission, nestedAdmission),
                      {
                        identity: controlIdentity,
                        items,
                      },
                    )
                    .pipe(Effect.mapError(mapControlError))
                })
        if (
          signal?.aborted &&
          (input.action === "batch_cancel" ||
            input.action === "batch_continue")
        ) {
          const committedWorkerIDs =
            input.action === "batch_cancel"
              ? workerIDs
              : (input.continuations ?? []).map((item) => item.workerID)
          return yield* new OxpError.Cancelled({
            detail:
              "Delegated batch mutation committed before caller cancellation was observed",
            metadata: {
              batchID: String(batch.id),
              workersCommitted: committedWorkerIDs.length,
              ...workerHandleMetadata(committedWorkerIDs),
              committed: true,
            },
          })
        }
        return {
          title: "OpenFork delegated batch " + input.action,
          output: JSON.stringify({ batchID: batch.id, workers: result }),
          structured: { batchID: batch.id, workers: result },
          ...(input.action === "batch_cancel" ||
          input.action === "batch_continue"
            ? { mutation: { attempted: true, committed: true } }
            : {}),
        } satisfies OxpResult.CapabilityResult
      }

      return yield* new OxpError.InvalidArgument({
        detail: "Unknown delegated-worker action",
      })
    })

    const execute: Interface["execute"] = (input, signal) =>
      executeRaw(input, signal).pipe(
        Effect.catch((error) =>
          OxpError.isError(error)
            ? Effect.fail(error)
            : Effect.fail(
                new OxpError.DependencyUnavailable({
                  detail: "OXP delegated-worker operation failed",
                }),
              ),
        ),
      )

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    OxpAuthority.node,
    OxpAgentCatalog.node,
    OxpConfig.node,
    SessionDelegationInspection.node,
    OxpWorkerControl.node,
  ],
})

export * as OxpWorker from "./worker"
