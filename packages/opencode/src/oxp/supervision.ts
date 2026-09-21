import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { SessionInspection } from "@opencode-ai/core/session/inspection"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpSchema } from "./schema"
import type { OxpSessionControl } from "./session-control"

export interface Target {
  readonly row: SessionInspection.SessionRow
  readonly admission: OxpAuthority.Admission
}

export interface Interface {
  readonly authorizeRow: (
    row: SessionInspection.SessionRow,
    operation: string,
    rootID?: OxpSchema.RootID,
  ) => Effect.Effect<OxpAuthority.Admission, OxpError.Error>
  readonly resolve: (
    sessionID: string,
    operation: string,
    rootID?: OxpSchema.RootID,
  ) => Effect.Effect<Target, OxpError.Error>
  readonly runtimeTarget: (
    target: Target,
    phase?: OxpAuthority.Phase,
  ) => OxpSessionControl.Target
  readonly actorRef: (admission: OxpAuthority.Admission) => string
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpSupervision",
) {}
export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const inspection = yield* SessionInspection.Service

    const authorizeRow: Interface["authorizeRow"] = Effect.fnUntraced(
      function* (row, operation, rootID) {
        return yield* authority.authorize({
          plane: "supervision",
          operation,
          phase: "supervise",
          rootID,
          path: row.directory,
        })
      },
    )

    const resolve: Interface["resolve"] = Effect.fnUntraced(
      function* (sessionID, operation, rootID) {
        const row = yield* inspection.get(SessionSchema.ID.make(sessionID))
        if (!row) {
          return yield* new OxpError.NotFound({
            detail: "Session is not available to OXP supervision",
          })
        }
        return yield* authorizeRow(row, operation, rootID).pipe(
          Effect.mapError(
            (error): OxpError.Error =>
              error._tag === "OXP_DEPENDENCY_UNAVAILABLE"
                ? error
                : new OxpError.NotFound({
                    detail: "Session is not available to OXP supervision",
                  }),
          ),
          Effect.map((admission) => ({ row, admission })),
        )
      },
    )

    const runtimeTarget: Interface["runtimeTarget"] = (
      target,
      phase = "commit",
    ) => ({
      sessionID: target.row.id,
      directory: target.row.directory,
      ...(target.row.workspaceID
        ? { workspaceID: target.row.workspaceID }
        : {}),
      commitGuard: () =>
        Effect.runPromise(
          authority.revalidate(target.admission, phase).pipe(Effect.asVoid),
        ),
    })

    return Service.of({
      authorizeRow,
      resolve,
      runtimeTarget,
      actorRef: (admission) => "oxp:" + admission.connectorID,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, SessionInspection.node],
})

export * as OxpSupervision from "./supervision"
