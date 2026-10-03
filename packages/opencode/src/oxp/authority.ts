import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export type Phase =
  | "discover"
  | "read"
  | "egress"
  | "mutate"
  | "commit"
  | "spawn"
  | "supervise"
  | "delegate"
  | "control"
  | "network"

export interface Request {
  readonly plane: OxpSchema.Plane
  readonly operation: string
  readonly phase: Phase
  readonly rootID?: OxpSchema.RootID
  readonly path?: string
  readonly allowMissing?: boolean
}

export interface Admission {
  readonly request: Request
  readonly revision: number
  /** External OXP principal that was authorized for this operation. */
  readonly connectorID: OxpSchema.ConnectorID
  readonly authority: OxpSchema.AuthorityClass
  readonly root?: OxpRoot.ResolvedPath | OxpRoot.ResolvedRoot
}

export interface Interface {
  readonly discover: (
    request: Omit<Request, "phase" | "rootID" | "path" | "allowMissing">,
  ) => Effect.Effect<boolean, OxpError.Error>
  readonly authorize: (request: Request) => Effect.Effect<Admission, OxpError.Error>
  readonly revalidate: (admission: Admission, phase?: Phase) => Effect.Effect<Admission, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpAuthority") {}
export const use = serviceUse(Service)

export function classify(plane: OxpSchema.Plane, operation: string): OxpSchema.AuthorityClass | undefined {
  if (plane === "supervision") {
    if (operation === "request.list" || operation.startsWith("request.reply") || operation.startsWith("request.answer") || operation.startsWith("request.reject")) {
      return "requestSupervision"
    }
    if (operation === "session" || operation.startsWith("session.")) return "sessionSupervision"
    return undefined
  }
  if (plane === "delegation") {
    if (operation === "swarm" || operation.startsWith("swarm.")) return "delegation"
    if (operation === "worker.nested" || operation.startsWith("worker.nested.")) return "nestedDelegation"
    if (operation === "worker" || operation.startsWith("worker.") || operation === "worker-group" || operation.startsWith("worker-group.")) {
      return "delegation"
    }
    return undefined
  }

  if (
    operation === "read" ||
    operation === "find" ||
    operation === "project" ||
    operation === "symbols" ||
    operation === "lsp" ||
    operation === "memory.read" ||
    operation === "sqlite.read" ||
    operation === "refactor.read" ||
    operation === "json.read" ||
    operation === "test.list" ||
    operation === "archive.read" ||
    operation === "skill.read" ||
    operation === "typecheck.explain" ||
    operation === "info" ||
    operation.startsWith("info.")
  ) {
    return "read"
  }
  if (operation === "capability.list" || operation === "capability.describe") return "catalog"
  if (operation === "write" || operation === "edit" || operation === "patch" || operation === "memory.write" || operation === "sqlite.write" || operation === "refactor.write" || operation === "json.write" || operation === "archive.write") return "write"
  if (operation === "git" || operation.startsWith("git.")) return "git"
  if (operation === "test.run") return "process"
  if (operation === "archive.system") return "process"
  if (operation === "typecheck.run") return "process"
  if (operation === "refactor.process") return "process"
  if (operation === "runtime" || operation.startsWith("runtime.")) return "process"
  if (operation === "process" || operation.startsWith("process.")) return "process"
  if (operation === "integration" || operation.startsWith("integration.")) return "integrations"
  if (operation === "browser" || operation.startsWith("browser.")) return "browser"
  if (operation === "schedule" || operation.startsWith("schedule.")) return "automation"
  if (operation === "file.receive" || operation.startsWith("file.receive.")) return "filesReceive"
  if (operation === "file.send" || operation.startsWith("file.send.")) return "filesSend"
  return undefined
}

function grantAllows(grant: OxpSchema.Grant, authority: OxpSchema.AuthorityClass): boolean {
  switch (authority) {
    case "catalog":
      // Catalog/schema discovery is not execution authority. Leaf calls still
      // authorize their own operation at execution time.
      return true
    case "read":
    case "write":
    case "process":
    case "git":
    case "integrations":
    case "browser":
      return grant[authority]
    case "automation":
      return grant.automation === true
    case "filesSend":
      return grant.filesSend && grant.read
    case "filesReceive":
      return grant.filesReceive && grant.write
    case "sessionSupervision":
      return grant.sessionSupervision === "approved-roots"
    case "requestSupervision":
      return grant.sessionSupervision === "approved-roots" && grant.requestSupervision
    case "delegation":
      return grant.delegation === "spawn"
    case "nestedDelegation":
      return grant.delegation === "spawn" && grant.nestedDelegation
  }
}

function requiresRoot(plane: OxpSchema.Plane, operation: string, authority: OxpSchema.AuthorityClass) {
  if (plane === "supervision") return true
  if (plane === "delegation") {
    // Delegation is always workspace-bound. Model/agent choice is a runtime
    // selection preference, not connector-level authority.
    return true
  }
  if (authority === "integrations" || authority === "browser") return false
  if (operation === "capability.list" || operation === "capability.describe" || operation.startsWith("info.")) return false
  if (operation === "runtime" || operation.startsWith("runtime.")) return false
  return true
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service

    const discover = Effect.fn("OxpAuthority.discover")(function* (
      request: Omit<Request, "phase" | "rootID" | "path" | "allowMissing">,
    ) {
      const current = yield* config.get()
      const authority = classify(request.plane, request.operation)
      return current.enabled && authority !== undefined && grantAllows(current.grant, authority)
    })

    const authorize = Effect.fn("OxpAuthority.authorize")(function* (request: Request) {
      const current = yield* config.get()
      if (!current.enabled) return yield* new OxpError.AuthDenied({ detail: "OXP is disabled" })

      const authority = classify(request.plane, request.operation)
      if (!authority) return yield* new OxpError.InvalidArgument({ detail: "Unknown OXP operation for the selected plane" })
      if (!grantAllows(current.grant, authority)) {
        return yield* new OxpError.AuthDenied({ detail: `OXP authority denied for ${authority}` })
      }

      let root: Admission["root"]
      if (request.path) {
        root = yield* roots.resolvePath(request.path, { rootID: request.rootID, allowMissing: request.allowMissing })
      } else if (request.rootID) {
        root = yield* roots.resolveRoot(request.rootID)
      } else if (requiresRoot(request.plane, request.operation, authority)) {
        return yield* new OxpError.RootRequired({ detail: "This OXP operation requires an explicit approved root or path" })
      }

      return {
        request,
        revision: current.revision,
        connectorID: current.connector.id,
        authority,
        root,
      } satisfies Admission
    })

    const revalidate = Effect.fn("OxpAuthority.revalidate")(function* (admission: Admission, phase?: Phase) {
      const request = phase ? { ...admission.request, phase } : admission.request
      const onFailure = (error: OxpError.Error): Effect.Effect<never, OxpError.Error> => {
        // Revalidation distinguishes an actual authority/location change from an
        // infrastructure failure. Collapsing an unavailable filesystem/config
        // dependency into AUTH_REVOKED would turn a retryable state into a false
        // policy fact and make protocol callers react incorrectly.
        if (error._tag === "OXP_DEPENDENCY_UNAVAILABLE" || error._tag === "OXP_INVALID_ARGUMENT") {
          return Effect.fail(error)
        }
        return Effect.fail(
          new OxpError.AuthRevoked({
            detail: "OXP authority was revoked or its approved location changed",
            metadata: { admittedRevision: admission.revision },
          }),
        )
      }
      const fresh = yield* authorize(request).pipe(Effect.catch(onFailure))
      const admittedRootID = admission.root?.root.id
      const freshRootID = fresh.root?.root.id
      if (
        fresh.connectorID !== admission.connectorID ||
        fresh.authority !== admission.authority ||
        freshRootID !== admittedRootID
      ) {
        return yield* new OxpError.AuthRevoked({
          detail: "OXP authority was revoked or its approved location changed",
          metadata: { admittedRevision: admission.revision },
        })
      }
      return fresh
    })

    return Service.of({ discover, authorize, revalidate })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpConfig.node, OxpRoot.node] })

export * as OxpAuthority from "./authority"
