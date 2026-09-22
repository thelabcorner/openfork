import { Schema } from "effect"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUIDString = Schema.String.check(Schema.isPattern(UUID), Schema.isMaxLength(36))

export const ConnectorID = UUIDString.pipe(Schema.brand("OxpConnectorID"))
export type ConnectorID = Schema.Schema.Type<typeof ConnectorID>

export const RootID = UUIDString.pipe(Schema.brand("OxpRootID"))
export type RootID = Schema.Schema.Type<typeof RootID>

export const InvocationID = UUIDString.pipe(Schema.brand("OxpInvocationID"))
export type InvocationID = Schema.Schema.Type<typeof InvocationID>

export const RootAlias = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,31}$/),
)
export type RootAlias = Schema.Schema.Type<typeof RootAlias>

/**
 * Why a root is authorized. Older OXP configs predate source tracking; those
 * roots are interpreted as manual approvals by the root service.
 */
export const RootSource = Schema.Literals(["manual", "project"])
export type RootSource = Schema.Schema.Type<typeof RootSource>

export const MAX_ROOTS = 256

export const Plane = Schema.Literals(["augmentation", "supervision", "delegation"])
export type Plane = Schema.Schema.Type<typeof Plane>

export const SessionSupervision = Schema.Literals(["none", "approved-roots"])
export type SessionSupervision = Schema.Schema.Type<typeof SessionSupervision>

export const Delegation = Schema.Literals(["disabled", "spawn"])
export type Delegation = Schema.Schema.Type<typeof Delegation>

const SelectionID = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  // Provider/model/account identifiers are opaque provider-owned strings, but
  // OXP never permits control characters into a durable selection contract.
  Schema.isPattern(/^[^\x00-\x1f\x7f]+$/),
)

/**
 * OXP model selection. Provider-account identity is deliberately a first-class
 * field rather than being smuggled through modelID text. At external ingress,
 * accountID may contain either the stable provider account id or one exact
 * provider-published human label/alias; runtime resolution canonicalizes it to
 * the stable id before routing or durable persistence.
 *
 * Transport adapters may spell the JSON keys providerId/modelId/accountId; the
 * sidecar/runtime contract keeps the repository's providerID/modelID/accountID
 * naming convention.
 */
export const ModelSelection = Schema.Struct({
  providerID: SelectionID,
  modelID: SelectionID,
  accountID: Schema.optional(SelectionID),
  variant: Schema.optional(SelectionID),
}).annotate({ identifier: "Oxp.ModelSelection" })
export type ModelSelection = Schema.Schema.Type<typeof ModelSelection>

export const WorkerAgentRootPolicy = Schema.Struct({
  rootID: RootID,
  agents: Schema.Array(SelectionID).check(Schema.isMaxLength(64)),
  defaultAgent: Schema.optional(SelectionID),
}).annotate({ identifier: "Oxp.WorkerAgentRootPolicy" })
export type WorkerAgentRootPolicy = Schema.Schema.Type<
  typeof WorkerAgentRootPolicy
>

export const WorkerPolicy = Schema.Struct({
  models: Schema.Array(ModelSelection).check(Schema.isMaxLength(64)),
  /** Legacy global agent authority. New configs use agentRoots. */
  agents: Schema.Array(SelectionID).check(Schema.isMaxLength(64)),
  defaultModel: Schema.optional(ModelSelection),
  /** Legacy global default. New configs use root-scoped defaults. */
  defaultAgent: Schema.optional(SelectionID),
  agentRoots: Schema.optional(
    Schema.Array(WorkerAgentRootPolicy).check(Schema.isMaxLength(MAX_ROOTS)),
  ),
}).annotate({ identifier: "Oxp.WorkerPolicy" })
export type WorkerPolicy = Schema.Schema.Type<typeof WorkerPolicy>

export const AuthorityClass = Schema.Literals([
  "read",
  "write",
  "process",
  "git",
  "integrations",
  "browser",
  "filesReceive",
  "filesSend",
  "catalog",
  "automation",
  "sessionSupervision",
  "requestSupervision",
  "delegation",
  "nestedDelegation",
])
export type AuthorityClass = Schema.Schema.Type<typeof AuthorityClass>

export const Grant = Schema.Struct({
  read: Schema.Boolean,
  write: Schema.Boolean,
  process: Schema.Boolean,
  git: Schema.Boolean,
  integrations: Schema.Boolean,
  browser: Schema.Boolean,
  filesReceive: Schema.Boolean,
  filesSend: Schema.Boolean,
  /** Added compatibly in v1: omission in older oxp.json means false. */
  automation: Schema.optional(Schema.Boolean),
  sessionSupervision: SessionSupervision,
  requestSupervision: Schema.Boolean,
  delegation: Delegation,
  nestedDelegation: Schema.Boolean,
})
export type Grant = Schema.Schema.Type<typeof Grant>

export const Connector = Schema.Struct({
  id: ConnectorID,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
})
export type Connector = Schema.Schema.Type<typeof Connector>

export const Root = Schema.Struct({
  id: RootID,
  alias: RootAlias,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  approvedAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  identityFingerprint: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  /** Optional for compatibility with pre-source-tracking configs. */
  sources: Schema.optional(Schema.Array(RootSource).check(Schema.isMaxLength(2))),
})
export type Root = Schema.Schema.Type<typeof Root>

export const PublicRoot = Schema.Struct({
  id: RootID,
  alias: RootAlias,
  available: Schema.Boolean,
})
export type PublicRoot = Schema.Schema.Type<typeof PublicRoot>

export const Config = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  enabled: Schema.Boolean,
  connector: Connector,
  roots: Schema.Array(Root).check(Schema.isMaxLength(MAX_ROOTS)),
  grant: Grant,
  /**
   * Legacy v0 delegation-selection policy. Parsed only so existing oxp.json
   * documents remain readable; live OXP no longer treats model/agent selection
   * as an authorization boundary and normalized config drops this field.
   */
  workerPolicy: Schema.optional(WorkerPolicy),
})
export type Config = Schema.Schema.Type<typeof Config>

export const DEFAULT_GRANT: Grant = Object.freeze({
  read: false,
  write: false,
  process: false,
  git: false,
  integrations: false,
  browser: false,
  filesReceive: false,
  filesSend: false,
  automation: false,
  sessionSupervision: "none",
  requestSupervision: false,
  delegation: "disabled",
  nestedDelegation: false,
})

export function defaults(connectorID: ConnectorID): Config {
  return {
    version: 1,
    revision: 1,
    enabled: false,
    connector: { id: connectorID, label: "OpenFork OXP" },
    roots: [],
    grant: { ...DEFAULT_GRANT },
  }
}

export * as OxpSchema from "./schema"
