import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { SessionDelegationInspection } from "@opencode-ai/core/session/delegation-inspection"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionGroup } from "@opencode-ai/schema/session-group"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpSchema } from "./schema"
import type { OxpRuntimeV1 } from "./runtime-v1"

export interface RootTarget {
  readonly admission: OxpAuthority.Admission
  readonly rootID: OxpSchema.RootID
  readonly directory: string
  readonly principalRef: string
}

export interface WorkerTarget extends RootTarget {
  readonly worker: SessionDelegationInspection.WorkerRow
}

export interface BatchTarget extends RootTarget {
  readonly batch: SessionDelegationInspection.BatchRow
}

export interface Interface {
  readonly authorizeRoot: (
    operation: string,
    rootID: OxpSchema.RootID,
    phase?: OxpAuthority.Phase,
  ) => Effect.Effect<RootTarget, OxpError.Error>
  readonly resolveWorker: (
    workerID: string,
    operation: string,
    rootID: OxpSchema.RootID,
    phase?: OxpAuthority.Phase,
  ) => Effect.Effect<WorkerTarget, OxpError.Error>
  readonly resolveBatch: (
    batchID: string,
    operation: string,
    rootID: OxpSchema.RootID,
    phase?: OxpAuthority.Phase,
  ) => Effect.Effect<BatchTarget, OxpError.Error>
  readonly listWorkers: (
    target: RootTarget,
    input?: {
      readonly limit?: number
      readonly includeArchived?: boolean
      readonly before?: SessionDelegationInspection.WorkerCursor
    },
  ) => Effect.Effect<readonly SessionDelegationInspection.WorkerRow[]>
  readonly listBatches: (
    target: RootTarget,
    limit?: number,
  ) => Effect.Effect<readonly SessionDelegationInspection.BatchRow[]>
  readonly batchOwnerRef: (
    target: RootTarget,
    invocationID: OxpSchema.InvocationID,
  ) => string
  readonly runtimeTarget: (
    target: RootTarget,
    phase?: OxpAuthority.Phase,
  ) => OxpRuntimeV1.Target
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpDelegation",
) {}
export const use = serviceUse(Service)

const PRODUCER = "oxp"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const inspection = yield* SessionDelegationInspection.Service

    const rootIDOf = (admission: OxpAuthority.Admission) =>
      admission.root?.root.id

    const principalRefOf = (admission: OxpAuthority.Admission) =>
      "oxp:" + admission.connectorID

    const authorizeRoot: Interface["authorizeRoot"] = Effect.fnUntraced(
      function* (operation, rootID, phase = "delegate") {
        const admission = yield* authority.authorize({
          plane: "delegation",
          operation,
          phase,
          rootID,
        })
        const root = admission.root
        if (!root) {
          return yield* new OxpError.RootRequired({
            detail: "Delegation requires an approved root",
          })
        }
        return {
          admission,
          rootID: root.root.id,
          directory: root.canonicalPath,
          principalRef: principalRefOf(admission),
        }
      },
    )

    const hidden = () =>
      new OxpError.NotFound({
        detail: "Delegated worker is not available to this OXP principal",
      })

    const resolveWorker: Interface["resolveWorker"] = Effect.fnUntraced(
      function* (workerID, operation, rootID, phase = "delegate") {
        const worker = yield* inspection.getWorker(
          SessionSchema.ID.make(workerID),
        )
        if (!worker || worker.malformedOrigin || !worker.origin)
          return yield* hidden()

        const admission = yield* authority
          .authorize({
            plane: "delegation",
            operation,
            phase,
            rootID,
            path: worker.directory,
          })
          .pipe(
            Effect.mapError((error): OxpError.Error =>
              error._tag === "OXP_DEPENDENCY_UNAVAILABLE"
                ? error
                : hidden(),
            ),
          )
        const authorizedRoot = rootIDOf(admission)
        const principalRef = principalRefOf(admission)
        if (
          !authorizedRoot ||
          worker.origin.producer !== PRODUCER ||
          worker.origin.principalRef !== principalRef ||
          worker.origin.rootRef !== authorizedRoot
        ) {
          return yield* hidden()
        }
        return {
          worker,
          admission,
          rootID: authorizedRoot,
          directory: worker.directory,
          principalRef,
        }
      },
    )

    const batchPrefix = (target: RootTarget) =>
      "oxp-batch:" + target.principalRef + ":" + target.rootID + ":"

    const resolveBatch: Interface["resolveBatch"] = Effect.fnUntraced(
      function* (batchID, operation, rootID, phase = "delegate") {
        const target = yield* authorizeRoot(operation, rootID, phase)
        const batch = yield* inspection.getBatch(
          SessionGroup.ID.make(batchID),
        )
        if (
          !batch ||
          !batch.ownerRef ||
          !batch.ownerRef.startsWith(batchPrefix(target))
        ) {
          return yield* new OxpError.NotFound({
            detail: "Delegated batch is not available to this OXP principal",
          })
        }
        return { ...target, batch }
      },
    )

    const listWorkers: Interface["listWorkers"] = (target, input = {}) =>
      inspection.listWorkers({
        producer: PRODUCER,
        principalRef: target.principalRef,
        rootRef: target.rootID,
        limit: input.limit,
        includeArchived: input.includeArchived,
        before: input.before,
      })

    const listBatches: Interface["listBatches"] = (target, limit) =>
      inspection.listBatches({
        ownerRefPrefix: batchPrefix(target),
        limit,
      })

    const runtimeTarget: Interface["runtimeTarget"] = (
      target,
      phase = "commit",
    ) => ({
      directory: target.directory,
      commitGuard: () =>
        Effect.runPromise(
          authority.revalidate(target.admission, phase).pipe(Effect.asVoid),
        ),
    })

    return Service.of({
      authorizeRoot,
      resolveWorker,
      resolveBatch,
      listWorkers,
      listBatches,
      batchOwnerRef: (target, invocationID) =>
        batchPrefix(target) + invocationID,
      runtimeTarget,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, SessionDelegationInspection.node],
})

export * as OxpDelegation from "./delegation"
