export * as OfxpCapability from "./capability"

import { createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { AppProcess } from "@opencode-ai/core/process"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeFind } from "@/exchange/find"
import { ExchangeGrounding } from "@/exchange/grounding"
import { ExchangeProject } from "@/exchange/project"
import { ExchangeRead } from "@/exchange/read"
import { ExchangeWrite } from "@/exchange/write"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Symbols } from "@/symbols/service"
import { BrokerContract } from "@/tool/broker-contract"
import { OfxpSkillCapability } from "./augmentation/skill"
import { OfxpSymbolsCapability } from "./augmentation/symbols"
import { OfxpWebCapability } from "./augmentation/web"
import { OfxpLspCapability } from "./augmentation/lsp"
import { OfxpGitCapability } from "./augmentation/git"
import { OfxpBrowserCapability } from "./augmentation/browser"
import { OfxpProcessCapability } from "./augmentation/process"
import { OfxpEditCapability } from "./augmentation/edit"
import { OfxpPatchCapability } from "./augmentation/patch"
import { OfxpSympyCapability } from "./augmentation/sympy"
import { OfxpTypecheckCapability } from "./augmentation/typecheck"
import { OfxpTestCapability } from "./augmentation/test"
import { OfxpArchiveCapability } from "./augmentation/archive"
import { OfxpJsonCapability } from "./augmentation/json"
import { OfxpSqliteCapability } from "./augmentation/sqlite"
import { OfxpMemoryCapability } from "./augmentation/memory"
import { OfxpRefactorCapability } from "./augmentation/refactor"
import { OfxpRoot } from "./root"
import { OfxpPrincipal } from "./principal"
import type { PeerCertificateIdentity } from "./certificate"

const ReadArgs = Schema.Struct({
  path: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  action: Schema.optional(Schema.Literals(["read", "tail"])),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})
type ReadArgs = typeof ReadArgs.Type

const FindArgs = Schema.Struct({
  path: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  glob: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  grep: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  include: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
})

const ProjectArgs = Schema.Struct({
  path: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  action: Schema.optional(Schema.Literals(["summary", "structure", "recent"])),
  depth: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(32))),
  maxEntries: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100_000))),
  recent: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10_000))),
})

const WriteArgs = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  content: Schema.String.check(Schema.isMaxLength(512 * 1024)),
  expectedFingerprint: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
})

type Definition = {
  readonly id: Ofxp.CapabilityID
  readonly description: string
  readonly schema?: Schema.Top
  readonly inputSchema?: unknown
  readonly authority: Ofxp.CapabilityClass
  readonly mutation: Ofxp.MutationClass
  readonly commitClass: Ofxp.CommitClass
  readonly requiresRoot: boolean
  /** Operation-dependent capabilities are discoverable with any listed grant. */
  readonly discoverAuthorities?: readonly Ofxp.CapabilityClass[]
}

const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "read" as const,
    description: "Read or tail a file or directory inside one approved remote root.",
    schema: ReadArgs,
    authority: "read",
    mutation: "none",
    commitClass: "safe_read",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "find" as const,
    description: "Glob filenames or grep text inside one approved remote root.",
    schema: FindArgs,
    authority: "read",
    mutation: "none",
    commitClass: "safe_read",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "project" as const,
    description: "Inspect bounded project metadata, structure, or recent files inside one approved remote root.",
    schema: ProjectArgs,
    authority: "read",
    mutation: "none",
    commitClass: "safe_read",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "write" as const,
    description: "Atomically replace one text file inside an approved remote root with receipt-backed idempotency.",
    schema: WriteArgs,
    authority: "write",
    mutation: "idempotent",
    commitClass: "idempotent_mutation",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "edit" as const,
    description: "Apply stale-safe precision edits to one text file inside an approved remote root using the shared OpenFork edit engine.",
    schema: OfxpEditCapability.Parameters,
    authority: "write",
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "patch" as const,
    description: "Plan or atomically apply a guarded multi-file patch inside one approved remote root using the shared OpenFork patch engine.",
    schema: OfxpPatchCapability.Parameters,
    authority: "write",
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "web" as const,
    description: "Fetch known URLs, search the web, or inspect available web-search providers through the remote host.",
    schema: OfxpWebCapability.Parameters,
    authority: "integrations",
    mutation: "none",
    commitClass: "safe_read",
    requiresRoot: false,
  }),
  Object.freeze({
    id: "skill" as const,
    description: "Discover, search, or load project-local skills strictly inside one approved remote root.",
    schema: OfxpSkillCapability.Parameters,
    authority: "read",
    mutation: "none",
    commitClass: "safe_read",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "archive" as const,
    description: "Inspect archives with read authority; create/extract additionally require write authority, and system-backed inspection additionally requires process authority.",
    schema: OfxpArchiveCapability.Parameters,
    authority: "read",
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "json" as const,
    description: "Analyze bounded JSON-family data inline or inside an approved root; durable format/patch commits require write authority and stale-safe receipt semantics.",
    schema: OfxpJsonCapability.Parameters,
    authority: "read",
    discoverAuthorities: ["read", "write"] as const,
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: false,
  }),
  Object.freeze({
    id: "sqlite" as const,
    description: "Inspect/query approved-root SQLite databases with read authority; transactional run and export use write authority with path-specific commit revalidation and receipt-backed non-replay.",
    schema: OfxpSqliteCapability.Parameters,
    authority: "read",
    discoverAuthorities: ["read", "write"] as const,
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "memory" as const,
    description: "Read project/workspace durable memory inside an approved root; remember/forget require write authority and receipt-backed non-replay.",
    schema: OfxpMemoryCapability.Parameters,
    authority: "read",
    discoverAuthorities: ["read", "write"] as const,
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "refactor" as const,
    description: "Resolve and plan structured TypeScript refactors with read authority; preview/source mutations require write authority, and confirmed apply typechecks use OFXP-owned process authority.",
    schema: OfxpRefactorCapability.Parameters,
    authority: "read",
    discoverAuthorities: ["read", "write", "process"] as const,
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "symbols" as const,
    description: "Search definitions, outline source files, and find usages inside one approved remote root.",
    schema: OfxpSymbolsCapability.Parameters,
    authority: "read",
    mutation: "none",
    commitClass: "safe_read",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "lsp" as const,
    description: "Run language-server inspection for one file inside an approved remote root.",
    schema: OfxpLspCapability.Parameters,
    authority: "read",
    mutation: "none",
    commitClass: "safe_read",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "git" as const,
    description: "Run typed Git inspection and guarded repository mutations inside an approved remote Git worktree.",
    schema: OfxpGitCapability.Parameters,
    authority: "git",
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "browser" as const,
    description: "Control the remote OpenFork Desktop browser under an isolated peer/session principal; SnapEye operations add explicit project-root scope.",
    schema: OfxpBrowserCapability.Parameters,
    authority: "browser",
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: false,
  }),
  Object.freeze({
    id: "process" as const,
    description: "Start and control bounded remote process trees inside one approved root with peer/session-scoped handles and receipt-backed mutation reconciliation.",
    schema: OfxpProcessCapability.Parameters,
    authority: "process",
    mutation: "non-idempotent",
    commitClass: "durable_start",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "sympy" as const,
    description: "Run bounded symbolic computation through the remote host's shared process-owned SymPy engine.",
    schema: OfxpSympyCapability.Parameters,
    authority: "process",
    mutation: "none",
    commitClass: "safe_read",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "typecheck" as const,
    description: "Explain TypeScript diagnostics with read authority, or run bounded scoped/full compiler checks with process authority inside an approved root.",
    schema: OfxpTypecheckCapability.Parameters,
    authority: "process",
    discoverAuthorities: ["read", "process"] as const,
    mutation: "none",
    commitClass: "safe_read",
    requiresRoot: true,
  }),
  Object.freeze({
    id: "test" as const,
    description: "List test files with read authority or execute bounded project tests with process authority and receipt-backed non-replay semantics.",
    schema: OfxpTestCapability.Parameters,
    authority: "process",
    discoverAuthorities: ["read", "process"] as const,
    mutation: "non-idempotent",
    commitClass: "non_idempotent_mutation",
    requiresRoot: true,
  }),
] satisfies readonly Definition[])

/**
 * The executable augmentation catalog, derived from the actual dispatcher
 * definitions rather than the native-tool parity ledger. Coverage tests compare
 * this runtime truth against the semantic mapping so a mapping name alone can
 * never masquerade as implemented OFXP support.
 */
export const EXECUTABLE_CAPABILITY_IDS: readonly Ofxp.CapabilityID[] = Object.freeze(
  DEFINITIONS.map((item) => item.id),
)

function catalogRow(item: Definition): Ofxp.CapabilityCatalogRow {
  return {
    id: item.id,
    description: item.description,
    authority: item.authority,
    workspaceTier: 3,
    mutation: item.mutation,
    commitClass: item.commitClass,
    requiresRoot: item.requiresRoot,
  }
}

function granted(grant: Ofxp.Grant, authority: Ofxp.CapabilityClass) {
  switch (authority) {
    case "read":
    case "write":
    case "git":
    case "process":
    case "integrations":
    case "browser":
    case "filesReceive":
    case "filesSend":
    case "automation":
    case "messaging":
    case "requestSupervision":
    case "nestedDelegation":
      return grant[authority]
    case "sessionSupervision":
      return grant.sessionSupervision === "approved-roots"
    case "delegation":
      return grant.delegation === "spawn"
  }
}

function discoverable(grant: Ofxp.Grant, item: Definition) {
  return (item.discoverAuthorities ?? [item.authority]).some((authority) => granted(grant, authority))
}

function digestParts(parts: readonly string[]) {
  const hash = createHash("sha256")
  for (const part of parts) {
    const bytes = Buffer.byteLength(part, "utf8")
    hash.update(String(bytes), "ascii").update(":", "ascii").update(part, "utf8")
  }
  return `sha256:${hash.digest("hex")}`
}

function fileDigest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function descriptorOf(
  item: Definition,
  descriptors: Map<Ofxp.CapabilityID, Ofxp.CapabilityDescriptor>,
): Ofxp.CapabilityDescriptor {
  const cached = descriptors.get(item.id)
  if (cached) return cached
  const inputSchema = item.inputSchema ?? (item.schema
    ? Schema.toJsonSchemaDocument(item.schema, { additionalProperties: false }).schema
    : {})
  const broker = BrokerContract.describe({
    broker: "ofxp.capability",
    target: item.id,
    targetField: "capability",
    description: item.description,
    schema: inputSchema,
  })
  const descriptor: Ofxp.CapabilityDescriptor = {
    ...broker,
    broker: "ofxp.capability",
    target: item.id,
    invocation: { ...broker.invocation, target: item.id, targetField: "capability", argsField: "args" },
    rules: [...broker.rules],
    capability: catalogRow(item),
  }
  descriptors.set(item.id, descriptor)
  return descriptor
}

function failure(
  code: Ofxp.ErrorCode,
  message: string,
  invocationID?: Ofxp.InvocationID,
  retryable = false,
): Ofxp.FailureResponse {
  return {
    ok: false,
    error: {
      code,
      message: message.slice(0, 1024),
      ...(invocationID ? { invocationID } : {}),
      retryable,
    },
  }
}

function errorResponse(error: unknown, invocationID?: Ofxp.InvocationID): Ofxp.FailureResponse {
  if (error instanceof OfxpPeer.OfxpPeerSchema.NotFoundError) {
    return failure("PAIRING_REQUIRED", "This OFXP peer is not paired on the target machine", invocationID)
  }
  if (error instanceof OfxpPeer.OfxpPeerSchema.StaleRevisionError) {
    return failure("STALE_GRANT", error.message, invocationID, true)
  }
  if (error instanceof OfxpPeer.OfxpPeerSchema.AuthorityDeniedError) {
    if (error.reason === "peer_revoked") return failure("PEER_REVOKED", error.message, invocationID)
    if (error.reason === "root_required") return failure("ROOT_REQUIRED", error.message, invocationID)
    if (error.reason === "root_not_found") return failure("ROOT_NOT_FOUND", error.message, invocationID)
    if (error.reason === "root_changed") return failure("ROOT_CHANGED", error.message, invocationID)
    return failure("AUTHORITY_DENIED", error.message, invocationID)
  }
  if (error instanceof OfxpPeer.OfxpPeerSchema.PeerAccessDeniedError) {
    if (error.reason === "peer_revoked") return failure("PEER_REVOKED", error.message, invocationID)
    return failure("AUTHORITY_DENIED", error.message, invocationID)
  }
  if (error instanceof OfxpRoot.InvalidPathError) return failure("INVALID_REQUEST", error.message, invocationID)
  if (error instanceof OfxpRoot.RootChangedError) return failure("ROOT_CHANGED", error.message, invocationID)
  if (error instanceof ExchangeRead.InvalidArgument) return failure("INVALID_REQUEST", error.message, invocationID)
  if (error instanceof ExchangeRead.Cancelled) return failure("CANCELLED", error.message, invocationID, true)
  if (error instanceof ExchangeRead.Conflict) return failure("CONFLICT", error.message, invocationID, true)
  if (error instanceof ExchangeRead.DependencyUnavailable) {
    return failure("DEPENDENCY_UNAVAILABLE", error.message, invocationID, true)
  }
  if (error instanceof ExchangeError.InvalidArgument) return failure("INVALID_REQUEST", error.message, invocationID)
  if (error instanceof ExchangeError.NotFound) return failure("NOT_FOUND", error.message, invocationID)
  if (error instanceof ExchangeError.Cancelled) return failure("CANCELLED", error.message, invocationID, true)
  if (error instanceof ExchangeError.Conflict) return failure("CONFLICT", error.message, invocationID, true)
  if (error instanceof ExchangeError.AuthorityDenied) return failure("AUTHORITY_DENIED", error.message, invocationID)
  if (error instanceof ExchangeError.PathEscape) return failure("INVALID_REQUEST", error.message, invocationID)
  if (error instanceof ExchangeError.DependencyUnavailable) {
    return failure("DEPENDENCY_UNAVAILABLE", error.message, invocationID, true)
  }
  if (error instanceof ExchangeError.AmbiguousCommit) {
    return failure("AMBIGUOUS_COMMIT", error.message, invocationID)
  }
  if (error instanceof OfxpInvocation.OfxpInvocationSchema.CollisionError) {
    return failure("CONFLICT", error.message, invocationID)
  }
  if (error instanceof OfxpInvocation.OfxpInvocationSchema.ValidationError) {
    return failure("INVALID_REQUEST", error.message, invocationID)
  }
  if (error instanceof OfxpInvocation.OfxpInvocationSchema.InvalidTransitionError) {
    return failure("CONFLICT", error.message, invocationID)
  }
  if (error instanceof OfxpInvocation.OfxpInvocationSchema.NotFoundError) {
    return failure("NOT_FOUND", error.message, invocationID)
  }
  return failure("INTERNAL", "OFXP capability execution failed", invocationID, true)
}

function success(
  capability: Ofxp.CapabilityID,
  rootID: Ofxp.RootID | undefined,
  grantRevision: number,
  execution: {
    readonly title?: string
    readonly output: string
    readonly attachments?: readonly Schema.Schema.Type<typeof Ofxp.CapabilityAttachment>[]
    readonly metadata?: Readonly<Record<string, unknown>>
  },
): Ofxp.CapabilityResponse {
  return {
    ok: true,
    result: {
      title: (execution.title ?? capability).slice(0, 512),
      output: execution.output,
      ...(execution.attachments?.length ? { attachments: [...execution.attachments] } : {}),
      metadata: {
        ...execution.metadata,
        capability,
        ...(rootID ? { rootID } : {}),
        grantRevision,
      },
    },
  }
}

export interface Interface {
  readonly dispatch: (
    peer: PeerCertificateIdentity,
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ) => Effect.Effect<unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OfxpCapability") {}
export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const invocations = yield* OfxpInvocation.Service
    const symbols = yield* Symbols.Service
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    const app = yield* AppProcess.Service
    const browser = yield* BrowserHostBroker.Service
    const processCapability = yield* OfxpProcessCapability.Service
    const grounding = yield* ExchangeGrounding.Service
    const definitions: readonly Definition[] = DEFINITIONS
    const definitionByID = new Map<Ofxp.CapabilityID, Definition>(definitions.map((item) => [item.id, item]))
    const descriptors = new Map<Ofxp.CapabilityID, Ofxp.CapabilityDescriptor>()

    const rootList = Effect.fn("OfxpCapability.rootList")(function* (peer: PeerCertificateIdentity) {
      yield* peers.access(peer.peerID)
      const publicRoots = yield* peers.roots(peer.peerID)
      return { ok: true, roots: publicRoots.slice(0, 128) } satisfies Ofxp.RootListResponse
    })

    const capabilityList = Effect.fn("OfxpCapability.list")(function* (peer: PeerCertificateIdentity, body: unknown) {
      const request = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Ofxp.CapabilityListRequest)(body ?? {}, { onExcessProperty: "error" }),
        catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP capability list request is invalid" }),
      })
      const access = yield* peers.access(peer.peerID)
      if (request.rootID) {
        const publicRoots = yield* peers.roots(peer.peerID)
        if (!publicRoots.some((root) => root.id === request.rootID)) {
          return failure("ROOT_NOT_FOUND", `OFXP root is not approved for peer ${peer.peerID}`)
        }
      }
      return {
        ok: true,
        capabilities: definitions.filter((item) => discoverable(access.grant, item)).map(catalogRow),
      } satisfies Ofxp.CapabilityListResponse
    })

    const capabilityDescribe = Effect.fn("OfxpCapability.describe")(function* (peer: PeerCertificateIdentity, body: unknown) {
      const request = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Ofxp.CapabilityDescribeRequest)(body, { onExcessProperty: "error" }),
        catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP capability describe request is invalid" }),
      })
      const access = yield* peers.access(peer.peerID)
      const item = definitionByID.get(request.capability)
      if (!item) return failure("NOT_FOUND", `Unknown OFXP capability: ${request.capability}`)
      if (!discoverable(access.grant, item)) {
        return failure("AUTHORITY_DENIED", `OFXP peer lacks authority to discover ${item.id}`)
      }
      return { ok: true, descriptor: descriptorOf(item, descriptors) } satisfies Ofxp.CapabilityDescribeResponse
    })

    const receiptGet = Effect.fn("OfxpCapability.receiptGet")(function* (peer: PeerCertificateIdentity, body: unknown) {
      const request = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Ofxp.ReceiptGetRequest)(body, { onExcessProperty: "error" }),
        catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP receipt request is invalid" }),
      })
      const record = yield* peers.get(peer.peerID)
      if (record.info.revokedAt !== undefined) {
        return failure("PEER_REVOKED", `OFXP peer is revoked: ${peer.peerID}`, request.invocationID)
      }
      if (record.info.rekeyState !== "stable") {
        return failure("AUTHORITY_DENIED", `OFXP peer requires re-key confirmation: ${peer.peerID}`, request.invocationID)
      }
      const receipt = yield* invocations.get(peer.peerID, request.invocationID)
      return { ok: true, receipt } satisfies Ofxp.ReceiptGetResponse
    })

    const read = Effect.fn("OfxpCapability.read")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      if (call.context.sourcePeerID !== peer.peerID) {
        return failure("IDENTITY_MISMATCH", "Invocation source peer does not match the authenticated TLS peer", call.context.invocationID)
      }
      if (call.context.plane !== "augmentation") {
        return failure("INVALID_REQUEST", "Read capability requires the augmentation plane", call.context.invocationID)
      }
      const args = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(ReadArgs)(call.args, { onExcessProperty: "error" }),
        catch: () => new ExchangeRead.InvalidArgument({ detail: "OFXP read arguments are invalid" }),
      })
      const admission = yield* peers.authorize({ peerID: peer.peerID, capability: "read", rootID: call.rootID })
      const resolved = yield* roots.resolve(admission, args.path)
      const execution = yield* ExchangeRead.execute(
        fs,
        {
          path: resolved.path,
          displayPath: resolved.virtualPath,
          action: args.action,
          offset: args.offset,
          limit: args.limit,
          signal,
          projectionMarker: "<note>OFXP read output truncated; narrow the read window</note>",
        },
        {
          revalidate: () =>
            peers.authorize({
              peerID: peer.peerID,
              capability: "read",
              rootID: call.rootID,
              expectedGrantRevision: admission.grantRevision,
            }),
        },
      )
      if (execution.fingerprint) {
        grounding.scoped(OfxpPrincipal.key(peer.peerID, call.context)).note(resolved.rootID, resolved.path, execution.fingerprint)
      }
      return success("read", call.rootID, admission.grantRevision, {
        ...execution.result,
        metadata: {
          ...execution.result.metadata,
          ...(execution.fingerprint ? { fingerprint: execution.fingerprint } : {}),
          ...(execution.fingerprint ? { grounded: true } : {}),
        },
      })
    })

    const find = Effect.fn("OfxpCapability.find")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      if (call.context.sourcePeerID !== peer.peerID) {
        return failure("IDENTITY_MISMATCH", "Invocation source peer does not match the authenticated TLS peer", call.context.invocationID)
      }
      if (call.context.plane !== "augmentation") {
        return failure("INVALID_REQUEST", "Find capability requires the augmentation plane", call.context.invocationID)
      }
      const args = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(FindArgs)(call.args, { onExcessProperty: "error" }),
        catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP find arguments are invalid" }),
      })
      const admission = yield* peers.authorize({ peerID: peer.peerID, capability: "read", rootID: call.rootID })
      const resolved = yield* roots.resolve(admission, args.path)
      const execution = yield* ExchangeFind.execute(
        { fs, ripgrep },
        {
          path: resolved.path,
          rootLabel: resolved.alias,
          glob: args.glob,
          grep: args.grep,
          include: args.include,
          signal,
          projectionMarker: "<note>OFXP find output truncated; narrow the path or pattern</note>",
          toDisplayPath: (value) => OfxpRoot.toVirtualPath(resolved, value),
        },
        {
          revalidate: () =>
            peers.authorize({
              peerID: peer.peerID,
              capability: "read",
              rootID: call.rootID,
              expectedGrantRevision: admission.grantRevision,
            }),
        },
      )
      return success("find", call.rootID, admission.grantRevision, execution)
    })

    const project = Effect.fn("OfxpCapability.project")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      if (call.context.sourcePeerID !== peer.peerID) {
        return failure("IDENTITY_MISMATCH", "Invocation source peer does not match the authenticated TLS peer", call.context.invocationID)
      }
      if (call.context.plane !== "augmentation") {
        return failure("INVALID_REQUEST", "Project capability requires the augmentation plane", call.context.invocationID)
      }
      const args = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(ProjectArgs)(call.args, { onExcessProperty: "error" }),
        catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP project arguments are invalid" }),
      })
      const admission = yield* peers.authorize({ peerID: peer.peerID, capability: "read", rootID: call.rootID })
      const resolved = yield* roots.resolve(admission, args.path)
      const execution = yield* ExchangeProject.execute(
        ripgrep,
        {
          root: resolved.rootPath,
          scope: resolved.path,
          displayPath: resolved.virtualPath,
          rootLabel: resolved.alias,
          action: args.action,
          depth: args.depth,
          maxEntries: args.maxEntries,
          recent: args.recent,
          signal,
          projectionMarker: "<note>OFXP project output truncated; narrow the project path or request</note>",
        },
        {
          revalidate: () =>
            peers.authorize({
              peerID: peer.peerID,
              capability: "read",
              rootID: call.rootID,
              expectedGrantRevision: admission.grantRevision,
            }),
        },
      )
      return success("project", call.rootID, admission.grantRevision, execution)
    })

    const write = Effect.fn("OfxpCapability.write")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      if (call.context.sourcePeerID !== peer.peerID) {
        return failure("IDENTITY_MISMATCH", "Invocation source peer does not match the authenticated TLS peer", call.context.invocationID)
      }
      if (call.context.plane !== "augmentation") {
        return failure("INVALID_REQUEST", "Write capability requires the augmentation plane", call.context.invocationID)
      }
      const args = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(WriteArgs)(call.args, { onExcessProperty: "error" }),
        catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP write arguments are invalid" }),
      })
      const admission = yield* peers.authorize({ peerID: peer.peerID, capability: "write", rootID: call.rootID })
      const resolved = yield* roots.resolve(admission, args.path, { allowMissing: true })
      const requestDigest = digestParts([
        "ofxp-capability-v1",
        "write",
        resolved.rootID,
        args.path,
        args.content,
        args.expectedFingerprint ?? "",
      ])
      const admitted = yield* invocations.admit({
        invocationID: call.context.invocationID,
        sourcePeerID: peer.peerID,
        operation: "write",
        commitClass: "idempotent_mutation",
        requestDigest,
        targetRef: resolved.virtualPath,
      })

      if (!admitted.fresh) {
        const receipt = admitted.receipt
        if (receipt.state === "committed") {
          return success("write", call.rootID, admission.grantRevision, {
            title: resolved.virtualPath,
            output: `OFXP write invocation ${receipt.invocationID} was already committed; no duplicate mutation was executed.`,
            metadata: { path: resolved.virtualPath, duplicate: true, receipt },
          })
        }
        if (receipt.state === "cancelled") {
          return failure("CANCELLED", `OFXP write invocation ${receipt.invocationID} was already cancelled`, receipt.invocationID)
        }
        if (receipt.state === "failed") {
          return failure("CONFLICT", `OFXP write invocation ${receipt.invocationID} already failed; use a new invocation ID`, receipt.invocationID)
        }
        if (receipt.state === "started" && !receipt.resultDigest) {
          return failure(
            "AMBIGUOUS_COMMIT",
            `OFXP write invocation ${receipt.invocationID} crossed its mutation-start boundary without a reconcilable post-state digest; do not retry the mutation blindly`,
            receipt.invocationID,
          )
        }
        if (receipt.resultDigest) {
          const stat = yield* fs.stat(resolved.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const bytes = stat?.type === "File"
            ? yield* fs.readFile(resolved.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined
          if (bytes && fileDigest(bytes) === receipt.resultDigest) {
            const settled = yield* invocations.settle({
              invocationID: receipt.invocationID,
              state: "committed",
              targetRef: resolved.virtualPath,
              resultDigest: receipt.resultDigest,
            })
            return success("write", call.rootID, admission.grantRevision, {
              title: resolved.virtualPath,
              output: `Reconciled OFXP write invocation ${receipt.invocationID}: the intended post-state is present; no duplicate mutation was executed.`,
              metadata: { path: resolved.virtualPath, duplicate: true, reconciled: true, receipt: settled },
            })
          }
          return failure(
            "AMBIGUOUS_COMMIT",
            `OFXP write invocation ${receipt.invocationID} crossed its durable prepare boundary, but the intended post-state cannot be proven; do not retry with a new invocation until reconciled`,
            receipt.invocationID,
          )
        }
        // A duplicate receipt that is still merely admitted never crossed the
        // mutation-start boundary; resuming the SAME invocation is safe.
      }

      const executed = yield* ExchangeWrite.execute(
        fs,
        {
          path: resolved.path,
          displayPath: resolved.virtualPath,
          content: args.content,
          expectedFingerprint: args.expectedFingerprint,
          signal,
          projectionMarker: "<note>OFXP write diff truncated; inspect the remote file for complete post-state</note>",
        },
        {
          beforeCommit: ({ targetRef, resultDigest }) =>
            invocations.prepare({ invocationID: call.context.invocationID, targetRef, resultDigest }),
          revalidate: () =>
            Effect.gen(function* () {
              const fresh = yield* peers.authorize({
                peerID: peer.peerID,
                capability: "write",
                rootID: call.rootID,
                expectedGrantRevision: admission.grantRevision,
              })
              const target = yield* roots.resolve(fresh, args.path, { allowMissing: true })
              if (FSUtil.normalizePath(target.path) !== FSUtil.normalizePath(resolved.path)) {
                return yield* new OfxpRoot.RootChangedError({ detail: "OFXP write target identity changed before commit" })
              }
            }),
          onCommitted: ({ targetRef, resultDigest }) =>
            invocations.settle({
              invocationID: call.context.invocationID,
              state: "committed",
              targetRef,
              resultDigest,
            }),
        },
      ).pipe(
        Effect.tapError((error) => {
          if (error instanceof ExchangeError.AmbiguousCommit) return Effect.void
          const state = error instanceof ExchangeError.Cancelled ? "cancelled" : "failed"
          return invocations
            .settle({ invocationID: call.context.invocationID, state })
            .pipe(Effect.catch(() => Effect.void), Effect.asVoid)
        }),
      )

      if (!executed.mutation.committed) {
        yield* invocations.settle({
          invocationID: call.context.invocationID,
          state: "committed",
          targetRef: resolved.virtualPath,
          resultDigest: executed.resultDigest,
        })
      }
      return success("write", call.rootID, admission.grantRevision, {
        ...executed.result,
        metadata: {
          ...executed.result.metadata,
          resultDigest: executed.resultDigest,
          invocationID: call.context.invocationID,
        },
      })
    })

    const symbolsCapability = Effect.fn("OfxpCapability.symbols")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpSymbolsCapability.execute({ peers, roots, symbols }, peer, call, signal)
      return success("symbols", call.rootID, execution.grantRevision, execution)
    })

    const skillCapability = Effect.fn("OfxpCapability.skill")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpSkillCapability.execute({ peers, roots, fs }, peer, call, signal)
      return success("skill", call.rootID, execution.grantRevision, execution)
    })

    const webCapability = Effect.fn("OfxpCapability.web")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpWebCapability.execute({ peers, http, flags }, peer, call, signal)
      return success("web", call.rootID, execution.grantRevision, execution)
    })

    const lspCapability = Effect.fn("OfxpCapability.lsp")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpLspCapability.execute({ peers, roots }, peer, call, signal)
      return success("lsp", call.rootID, execution.grantRevision, execution)
    })

    const gitCapability = Effect.fn("OfxpCapability.git")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpGitCapability.execute({ peers, roots, invocations, app }, peer, call, signal)
      return success("git", call.rootID, execution.grantRevision, execution)
    })

    const browserCapability = Effect.fn("OfxpCapability.browser")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpBrowserCapability.execute({ peers, roots, invocations, broker: browser }, peer, call, signal)
      return success("browser", call.rootID, execution.grantRevision, execution)
    })

    const editCapability = Effect.fn("OfxpCapability.edit")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpEditCapability.execute({ peers, roots, invocations, grounding, fs }, peer, call, signal)
      return success("edit", call.rootID, execution.grantRevision, execution)
    })

    const patchCapability = Effect.fn("OfxpCapability.patch")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpPatchCapability.execute({ peers, roots, invocations, grounding, fs }, peer, call, signal)
      return success("patch", call.rootID, execution.grantRevision, execution)
    })

    const process = Effect.fn("OfxpCapability.process")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* processCapability.execute(peer, call, signal)
      return success("process", call.rootID, execution.grantRevision, execution)
    })

    const sympyCapability = Effect.fn("OfxpCapability.sympy")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpSympyCapability.execute(
        { peers, roots, process: processCapability },
        peer,
        call,
        signal,
      )
      return success("sympy", call.rootID, execution.grantRevision, execution)
    })

    const typecheckCapability = Effect.fn("OfxpCapability.typecheck")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpTypecheckCapability.execute(
        { peers, roots, process: processCapability },
        peer,
        call,
        signal,
      )
      return success("typecheck", call.rootID, execution.grantRevision, execution)
    })

    const testCapability = Effect.fn("OfxpCapability.test")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpTestCapability.execute(
        { peers, roots, invocations, process: processCapability, fs, rg: ripgrep },
        peer,
        call,
        signal,
      )
      return success("test", call.rootID, execution.grantRevision, execution)
    })

    const archiveCapability = Effect.fn("OfxpCapability.archive")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpArchiveCapability.execute(
        { peers, roots, invocations, process: processCapability, fs },
        peer,
        call,
        signal,
      )
      return success("archive", call.rootID, execution.grantRevision, execution)
    })

    const jsonCapability = Effect.fn("OfxpCapability.json")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpJsonCapability.execute(
        { peers, roots, invocations, grounding, fs },
        peer,
        call,
        signal,
      )
      return success("json", call.rootID, execution.grantRevision, execution)
    })

    const sqliteCapability = Effect.fn("OfxpCapability.sqlite")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpSqliteCapability.execute(
        { peers, roots, invocations },
        peer,
        call,
        signal,
      )
      return success("sqlite", call.rootID, execution.grantRevision, execution)
    })

    const memoryCapability = Effect.fn("OfxpCapability.memory")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpMemoryCapability.execute(
        { peers, roots, invocations },
        peer,
        call,
        signal,
      )
      return success("memory", call.rootID, execution.grantRevision, execution)
    })

    const refactorCapability = Effect.fn("OfxpCapability.refactor")(function* (
      peer: PeerCertificateIdentity,
      call: Ofxp.CapabilityCall,
      signal?: AbortSignal,
    ) {
      const execution = yield* OfxpRefactorCapability.execute(
        { peers, roots, invocations, process: processCapability, app, fs },
        peer,
        call,
        signal,
      )
      return success("refactor", call.rootID, execution.grantRevision, execution)
    })

    const validatePrincipal = (peer: PeerCertificateIdentity, call: Ofxp.CapabilityCall): Ofxp.CapabilityResponse | undefined => {
      if (call.context.sourcePeerID !== peer.peerID) {
        return failure("IDENTITY_MISMATCH", "Invocation source peer does not match the authenticated TLS peer", call.context.invocationID)
      }
      const legacySession = call.context.sourceSessionID !== undefined
      const explicitSource = call.context.source !== undefined
      if (legacySession === explicitSource) {
        return failure(
          "INVALID_REQUEST",
          "Invocation provenance must contain exactly one sourceSessionID or source principal",
          call.context.invocationID,
        )
      }
      if (call.context.plane !== "augmentation") {
        return failure("INVALID_REQUEST", "OFXP capability.call currently accepts only the augmentation plane", call.context.invocationID)
      }
      return undefined
    }

    const dispatch = Effect.fn("OfxpCapability.dispatch")(function* (
      peer: PeerCertificateIdentity,
      method: string,
      body: unknown,
      signal?: AbortSignal,
    ) {
      if (method === "root.list") {
        return yield* rootList(peer).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))))
      }
      if (method === "capability.list") {
        return yield* capabilityList(peer, body).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))))
      }
      if (method === "capability.describe") {
        return yield* capabilityDescribe(peer, body).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))))
      }
      if (method === "receipt.get") {
        return yield* receiptGet(peer, body).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))))
      }
      if (method !== "capability.call") return failure("NOT_FOUND", `Unknown OFXP application method: ${method}`)
      let invocationID: Ofxp.InvocationID | undefined
      return yield* Effect.gen(function* () {
        const call = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Ofxp.CapabilityCall)(body, { onExcessProperty: "error" }),
          catch: () => new ExchangeRead.InvalidArgument({ detail: "OFXP capability call is invalid" }),
        })
        invocationID = call.context.invocationID
        const item = definitionByID.get(call.capability)
        if (!item) return failure("NOT_FOUND", `OFXP capability is not available: ${call.capability}`, invocationID)
        const descriptor = descriptorOf(item, descriptors)
        if (call.contract !== descriptor.contract) {
          return failure(
            "STALE_CONTRACT",
            `OFXP capability contract is stale for ${call.capability}; describe the capability again before calling it`,
            invocationID,
          )
        }
        const principalFailure = validatePrincipal(peer, call)
        if (principalFailure) return principalFailure
        switch (call.capability) {
          case "read":
            return yield* read(peer, call, signal)
          case "find":
            return yield* find(peer, call, signal)
          case "project":
            return yield* project(peer, call, signal)
          case "write":
            return yield* write(peer, call, signal)
          case "edit":
            return yield* editCapability(peer, call, signal)
          case "patch":
            return yield* patchCapability(peer, call, signal)
          case "web":
            return yield* webCapability(peer, call, signal)
          case "skill":
            return yield* skillCapability(peer, call, signal)
          case "symbols":
            return yield* symbolsCapability(peer, call, signal)
          case "lsp":
            return yield* lspCapability(peer, call, signal)
          case "git":
            return yield* gitCapability(peer, call, signal)
          case "browser":
            return yield* browserCapability(peer, call, signal)
          case "process":
            return yield* process(peer, call, signal)
          case "sympy":
            return yield* sympyCapability(peer, call, signal)
          case "typecheck":
            return yield* typecheckCapability(peer, call, signal)
          case "test":
            return yield* testCapability(peer, call, signal)
          case "archive":
            return yield* archiveCapability(peer, call, signal)
          case "json":
            return yield* jsonCapability(peer, call, signal)
          case "sqlite":
            return yield* sqliteCapability(peer, call, signal)
          case "memory":
            return yield* memoryCapability(peer, call, signal)
          case "refactor":
            return yield* refactorCapability(peer, call, signal)
        }
      }).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error, invocationID))))
    })

    return Service.of({ dispatch })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    OfxpPeer.node,
    OfxpInvocation.node,
    OfxpRoot.node,
    FSUtil.node,
    Ripgrep.node,
    Symbols.node,
    AppProcess.node,
    BrowserHostBroker.node,
    OfxpProcessCapability.node,
    ExchangeGrounding.node,
    httpClient,
    RuntimeFlags.node,
  ],
})
