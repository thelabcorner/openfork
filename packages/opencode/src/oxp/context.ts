import { randomUUID } from "crypto"
import { OxpError } from "./error"
import type { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export interface Principal {
  readonly connectorID: OxpSchema.ConnectorID
  readonly label: string
  readonly profileRealm: string
}

export type Target =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "worker"; readonly id: string }
  | { readonly kind: "worker-group"; readonly id: string }
  | { readonly kind: "job"; readonly id: string }

export interface WorkspaceRef {
  readonly rootID: OxpSchema.RootID
  readonly directory: string
  readonly virtualDirectory: string
  readonly projectID?: string
  readonly worktree?: string
}

export interface Invocation {
  readonly id: OxpSchema.InvocationID
  readonly principal: Principal
  readonly grantRevision: number
  readonly startedAt: number
  readonly plane: OxpSchema.Plane
  readonly operation: string
  readonly rootID?: OxpSchema.RootID
  readonly workspace?: WorkspaceRef
  readonly target?: Target
  readonly correlation?: string
}

export interface CapabilityAuthorityRequest {
  readonly capability: string
  readonly phase:
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
  readonly rootID?: OxpSchema.RootID
  readonly path?: string
  readonly sessionID?: string
  readonly resource?: string
}

export interface CapabilityAuthority {
  readonly authorize: (request: CapabilityAuthorityRequest) => Promise<"allow" | "ask" | "deny">
}

export interface ProgressUpdate {
  readonly phase: string
  readonly title?: string
  readonly completed?: number
  readonly total?: number
  readonly preview?: string
}

export interface CapabilityProgress {
  readonly report: (update: ProgressUpdate) => void
}

export interface CapabilityProvenance {
  readonly actor: "external-agent"
  readonly protocol: "oxp-over-mcp"
  readonly connectorID: OxpSchema.ConnectorID
  readonly invocationID: OxpSchema.InvocationID
  readonly plane: OxpSchema.Plane
  readonly grantRevision: number
  readonly rootID?: OxpSchema.RootID
  readonly target?: Target
  readonly correlation?: string
}

export interface ReadGrounding {
  readonly note: (rootID: OxpSchema.RootID, path: string, fingerprint: string) => void
  readonly get: (rootID: OxpSchema.RootID, path: string) => string | undefined
  readonly remove: (rootID: OxpSchema.RootID, path: string) => void
}

export interface CapabilityContext {
  readonly invocation: Invocation
  readonly abort: AbortSignal
  readonly authority: CapabilityAuthority
  readonly progress: CapabilityProgress
  readonly provenance: CapabilityProvenance
  readonly grounding: ReadGrounding
}

export interface InvocationInput {
  readonly principal: Principal
  readonly grantRevision: number
  readonly plane: OxpSchema.Plane
  readonly operation: string
  readonly rootID?: OxpSchema.RootID
  readonly workspace?: WorkspaceRef
  readonly target?: Target
  readonly correlation?: string
  readonly startedAt?: number
}

export function workspaceFromResolvedRoot(resolved: OxpRoot.ResolvedPath | OxpRoot.ResolvedRoot): WorkspaceRef {
  const directory = "path" in resolved ? resolved.path : resolved.canonicalPath
  const virtualDirectory = "virtualPath" in resolved ? resolved.virtualPath : `/${resolved.root.alias}`
  return Object.freeze({ rootID: resolved.root.id, directory, virtualDirectory })
}

export function createInvocation(input: InvocationInput): Invocation {
  if (input.plane === "augmentation" && input.target && input.target.kind !== "job") {
    throw new OxpError.InvalidArgument({ detail: "Augmentation cannot target a native OpenFork Session or worker" })
  }
  if (input.plane === "supervision" && input.target && input.target.kind !== "session") {
    throw new OxpError.InvalidArgument({ detail: "Supervision may target only an existing native Session" })
  }
  if (
    input.plane === "delegation" &&
    input.target &&
    input.target.kind !== "worker" &&
    input.target.kind !== "worker-group"
  ) {
    throw new OxpError.InvalidArgument({ detail: "Delegation may target only workers or worker groups" })
  }
  return Object.freeze({
    id: OxpSchema.InvocationID.make(randomUUID()),
    principal: Object.freeze({ ...input.principal }),
    grantRevision: input.grantRevision,
    startedAt: input.startedAt ?? Date.now(),
    plane: input.plane,
    operation: input.operation,
    rootID: input.rootID,
    workspace: input.workspace,
    target: input.target,
    correlation: input.correlation,
  })
}

export function provenance(invocation: Invocation): CapabilityProvenance {
  return Object.freeze({
    actor: "external-agent",
    protocol: "oxp-over-mcp",
    connectorID: invocation.principal.connectorID,
    invocationID: invocation.id,
    plane: invocation.plane,
    grantRevision: invocation.grantRevision,
    rootID: invocation.rootID,
    target: invocation.target,
    correlation: invocation.correlation,
  })
}

export function createContext(input: Omit<CapabilityContext, "provenance">): CapabilityContext {
  return Object.freeze({ ...input, provenance: provenance(input.invocation) })
}

export * as OxpContext from "./context"
