import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { OxpAuthority } from "./authority"
import { OxpArchive } from "./archive"
import { OxpError } from "./error"
import { OxpEdit } from "./edit"
import { OxpFind } from "./find"
import { OxpGit } from "./git"
import { OxpJson } from "./json"
import { OxpProject } from "./project"
import { OxpRefactor } from "./refactor"
import { OxpPatch } from "./patch"
import { OxpProcess } from "./process"
import { OxpRuntimeRefresh } from "./runtime-refresh"
import { OxpRead } from "./read"
import { OxpResult } from "./result"
import { OxpSchedule } from "./schedule"
import { OxpScheduleManagement } from "./schedule-management"
import { OxpSchemaProjection } from "./schema-projection"
import { OxpSchema } from "./schema"
import { OxpSkill } from "./skill"
import { OxpSymbols } from "./symbols"
import { OxpTest } from "./test"
import { OxpTypecheck } from "./typecheck"
import { OxpUsage } from "./usage"
import { OxpModels } from "./models"
import { OxpWrite } from "./write"
import { OxpMcp } from "./mcp"
import { OxpFileExchange } from "./file-exchange"
import { OxpBrowser } from "./browser"
import { OxpWeb } from "./web"
import { OxpMemory } from "./memory"
import { OxpLsp } from "./lsp"
import { OxpSqlite } from "./sqlite"
import { OxpSympy } from "./sympy"
import { OxpOfxp } from "./ofxp"
import { OxpSystemOne } from "./system-one"
import { OxpSwarm } from "./swarm"
import { SWARM_FOCUSED_ACTIONS, swarmArgumentDiagnostic } from "./swarm-focus"
import { OxpCapabilitySearch } from "./capability-search"
import { OxpSession } from "./session"
import { OxpWorker } from "./worker"
import { OxpProse } from "./prose"
import { OxpCode } from "./code"
import { ExternalCode } from "@/exchange/code"
import { BrokerContract } from "@/tool/broker-contract"
import { ToolExposure } from "@/tool/exposure"

export type Exposure = "direct" | "brokered"
export type LoadPolicy = "default" | "lazy"
export type ListLoad = LoadPolicy | "all"
export type WorkspaceTier = 0 | 1 | 2 | 3

/** Request-scoped parent context computed at MCP ingress. Values here are
 * already privacy-safe projections; raw upstream correlation never enters the
 * capability layer. */
export interface CallContext {
  readonly parentConversationRef?: string
  /**
   * Higher-tier worker execution stays host-owned so capability discovery can
   * expose the live worker schema without pulling Tier-3 worker ports into the
   * lower-tier capability graph.
   */
  readonly workerExecute?: (
    input: OxpWorker.Input,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export interface CatalogRow {
  readonly id: string
  readonly namespace: "openfork" | "mcp"
  readonly description: string
  readonly authority: OxpSchema.AuthorityClass
  readonly authorities?: readonly OxpSchema.AuthorityClass[]
  readonly exposure: Exposure
  readonly load: LoadPolicy
  readonly workspaceTier: WorkspaceTier
  readonly mutation: "none" | "write"
}

interface Definition extends Omit<CatalogRow, "load"> {
  readonly nativeToolID?: string
  readonly schema: Schema.Top
  readonly schemaConstraints?: Readonly<Record<string, unknown>>
  readonly focusActions?: OxpSchemaProjection.Definition["focusActions"]
  readonly execute: (
    input: unknown,
    signal?: AbortSignal,
    context?: CallContext,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export interface Interface {
  readonly list: (query?: string, load?: ListLoad) => Effect.Effect<readonly CatalogRow[], OxpError.Error>
  readonly describe: (id: string, focusAction?: string, guidanceMode?: OxpSchemaProjection.GuidanceMode) => Effect.Effect<Descriptor, OxpError.Error>
  readonly call: (id: string, input: unknown, signal?: AbortSignal, context?: CallContext) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
  readonly execute: (input: Input, signal?: AbortSignal, context?: CallContext) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export type Descriptor = ReturnType<typeof BrokerContract.describe> & {
  readonly capability: CatalogRow
  readonly guidance: {
    readonly mode: OxpSchemaProjection.GuidanceMode
    readonly authoredDescriptions: number
    readonly returnedDescriptions: number
    readonly omittedDescriptions: number
    readonly complete: boolean
    readonly expansion?: "Describe this capability again with guidanceMode=full for all authored field descriptions."
    readonly authoringHint?: "The selected schema has no authored field descriptions. Use the capability overview and domain documentation; requesting full does not invent missing guidance."
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpCapability") {}
export const use = serviceUse(Service)

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "describe", "call"]).annotate({
    description: "List summaries, describe one schema/contract, or call it.",
  }),
  namespace: Schema.optional(Schema.Literals(["openfork", "mcp"])),
  rootID: Schema.optional(OxpSchema.RootID).annotate({
    description:
      "Approved root. For OpenFork calls it may be promoted into args when the described capability accepts rootID; for MCP it scopes the server.",
  }),
  capability: Schema.optional(Schema.String),
  focusAction: Schema.optional(Schema.String).annotate({
    description: "describe only: narrow a discriminated action/operation union to one executable branch and return its matching contract.",
  }),
  guidanceMode: Schema.optional(Schema.Literals(["compact", "balanced", "full"])).annotate({
    description: "How much parameter guidance to return: balanced (default), compact (minimal), full (all authored prose). Repeat on call when not using balanced.",
  }),
  query: Schema.optional(Schema.String),
  load: Schema.optional(Schema.Literals(["default", "lazy", "all"])).annotate({
    description: "List filter; defaults to lazy without a query and all when a query is supplied.",
  }),
  contract: BrokerContract.Parameter,
  args: Schema.optional(Schema.Unknown).annotate({
    description: "Arguments matching the described schema.",
  }),
  source_file: Schema.optional(OxpFileExchange.ChatGptFile).annotate({
    description: "ChatGPT-provided file; valid only for capability=file.transfer calls.",
  }),
})
export type Input = Schema.Schema.Type<typeof Parameters>

function catalogRow(item: Definition): CatalogRow {
  const {
    schema: _schema,
    schemaConstraints: _schemaConstraints,
    focusActions: _focusActions,
    execute: _execute,
    nativeToolID,
    ...row
  } = item
  // list() now reuses these rows for the lifetime of one authorized runtime.
  // Own and freeze the only nested mutable catalog field as well, so no
  // in-process consumer can poison later discovery results or definitions.
  return Object.freeze({
    ...row,
    ...(row.authorities ? { authorities: Object.freeze([...row.authorities]) } : {}),
    load: ToolExposure.loadPolicy(nativeToolID ?? item.id),
  })
}

// Store immutable JSON snapshots, not object references: consumers/tests can
// decorate their schema projections after describe. Such mutations must never
// poison the trusted descriptor/contract used for subsequent calls.
// New module/layer definitions get fresh snapshots after a runtime refresh.
type TrustedDescriptorSnapshot = {
  readonly json: string
  readonly contract: string
  readonly acceptsRootID: boolean
}
const descriptorCache = new WeakMap<Definition, Map<string, TrustedDescriptorSnapshot>>()
const focusedSchemaCache = new WeakMap<Definition, Map<string, string | null>>()

function focusedSchemaOf(item: Definition, action: string, mode: OxpSchemaProjection.GuidanceMode) {
  // Focus selectors are operation names, not prompts. Bound rejected-key
  // caching so arbitrary discovery probes cannot accumulate unbounded memory.
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(action)) return undefined
  const key = mode + "\u0000" + action
  const existing = focusedSchemaCache.get(item)
  if (existing?.has(key)) {
    const serialized = existing.get(key)
    return serialized ? JSON.parse(serialized) as ReturnType<typeof OxpSchemaProjection.focusedInputSchema> : undefined
  }
  const result = OxpSchemaProjection.focusedInputSchema(item, action, mode)
  const entries = existing ?? new Map<string, string | null>()
  if (entries.size >= 96) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
  entries.set(key, result ? JSON.stringify(result) : null)
  if (!existing) focusedSchemaCache.set(item, entries)
  return result
}

function descriptorOf(item: Definition, focusAction?: string, guidanceMode: OxpSchemaProjection.GuidanceMode = "balanced"): Descriptor {
  const key = guidanceMode + "\u0000" + (focusAction ?? "")
  const entries = descriptorCache.get(item)
  const cached = entries?.get(key)
  if (cached) return JSON.parse(cached.json) as Descriptor
  const inputSchema = (focusAction ? focusedSchemaOf(item, focusAction, guidanceMode) : undefined)
    ?? OxpSchemaProjection.definitionInputSchema(item, guidanceMode)
  const authoredSchema = guidanceMode === "full" ? inputSchema
    : (focusAction ? focusedSchemaOf(item, focusAction, "full") : undefined)
      ?? OxpSchemaProjection.definitionInputSchema(item, "full")
  const authored = OxpSchemaProjection.annotationCoverage(authoredSchema)
  const returned = OxpSchemaProjection.annotationCoverage(inputSchema)
  const descriptor: Descriptor = {
    ...BrokerContract.describe({
      broker: "capability",
      target: item.id,
      targetField: "capability",
      description: item.description,
      schema: inputSchema,
    }),
    capability: catalogRow(item),
    guidance: {
      mode: guidanceMode,
      authoredDescriptions: authored.count,
      returnedDescriptions: returned.count,
      omittedDescriptions: Math.max(0, authored.count - returned.count),
      complete: authored.count === returned.count,
      ...(authored.count > returned.count
        ? { expansion: "Describe this capability again with guidanceMode=full for all authored field descriptions." as const }
        : {}),
      ...(authored.count === 0
        ? { authoringHint: "The selected schema has no authored field descriptions. Use the capability overview and domain documentation; requesting full does not invent missing guidance." as const }
        : {}),
    },
  }
  const cache = entries ?? new Map<string, TrustedDescriptorSnapshot>()
  cache.set(key, {
    json: JSON.stringify(descriptor),
    contract: descriptor.contract,
    acceptsRootID: schemaAcceptsRootID(descriptor.inputSchema),
  })
  if (!entries) descriptorCache.set(item, cache)
  return descriptor
}

function descriptorProof(item: Definition, focusAction?: string, mode: OxpSchemaProjection.GuidanceMode = "balanced") {
  const key = mode + "\u0000" + (focusAction ?? "")
  const cached = descriptorCache.get(item)?.get(key)
  if (cached) return cached
  // First call still mints the exact full-schema contract. Later calls verify
  // a primitive owner-held value, without cloning or re-hashing the schema.
  descriptorOf(item, focusAction, mode)
  return descriptorCache.get(item)!.get(key)!
}

function schemaAcceptsRootID(inputSchema: unknown): boolean {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return false
  const properties = (inputSchema as { readonly properties?: unknown }).properties
  return !!properties &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.prototype.hasOwnProperty.call(properties, "rootID")
}

function argsRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function normalizeRootArgs(item: Definition, args: unknown, rootID?: OxpSchema.RootID) {
  return Effect.gen(function* () {
    if (rootID === undefined) return { args } as const
    if (!descriptorProof(item).acceptsRootID) {
      return {
        args,
        brokerNormalized: ["ignored top-level rootID for a rootless OpenFork capability"],
      } as const
    }
    const record = argsRecord(args)
    if (!record) return { args } as const
    const nested = record.rootID
    if (nested !== undefined && nested !== rootID) {
      return yield* new OxpError.InvalidArgument({
        detail: "Conflicting rootID values were supplied at the capability broker and capability argument levels",
      })
    }
    if (nested === undefined) {
      return {
        args: { ...record, rootID },
        brokerNormalized: ["promoted top-level rootID into OpenFork capability arguments"],
      } as const
    }
    return {
      args,
      brokerNormalized: ["deduplicated identical top-level rootID from OpenFork capability.call"],
    } as const
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const archive = yield* OxpArchive.Service
    const edit = yield* OxpEdit.Service
    const read = yield* OxpRead.Service
    const find = yield* OxpFind.Service
    const git = yield* OxpGit.Service
    const json = yield* OxpJson.Service
    const project = yield* OxpProject.Service
    const refactor = yield* OxpRefactor.Service
    const patch = yield* OxpPatch.Service
    const process = yield* OxpProcess.Service
    const skill = yield* OxpSkill.Service
    const symbols = yield* OxpSymbols.Service
    const test = yield* OxpTest.Service
    const typecheck = yield* OxpTypecheck.Service
    const usage = yield* OxpUsage.Service
    const models = yield* OxpModels.Service
    const write = yield* OxpWrite.Service
    const schedule = yield* OxpSchedule.Service
    const scheduleManagement = yield* OxpScheduleManagement.Service
    const mcp = yield* OxpMcp.Service
    const fileExchange = yield* OxpFileExchange.Service
    const browser = yield* OxpBrowser.Service
    const web = yield* OxpWeb.Service
    const memory = yield* OxpMemory.Service
    const lsp = yield* OxpLsp.Service
    const sqlite = yield* OxpSqlite.Service
    const sympy = yield* OxpSympy.Service
    const ofxp = yield* OxpOfxp.Service
    const systemOne = yield* OxpSystemOne.Service
    const swarm = yield* OxpSwarm.Service
    const session = yield* OxpSession.Service
    const definitions = new Map<string, Definition>([
      [
        "archive",
        {
          id: "archive",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("archive"),
          authority: "read",
          authorities: ["read", "write", "process"],
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpArchive.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpArchive.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP archive arguments" })),
              Effect.flatMap((params) => archive.execute(params, signal)),
            ),
        },
      ],
      [
        "browser",
        {
          id: "browser",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("browser"),
          authority: "browser",
          exposure: "brokered",
          workspaceTier: 0,
          mutation: "write",
          schema: OxpBrowser.Parameters,
          execute: (input, signal, context) =>
            Schema.decodeUnknownEffect(OxpBrowser.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP browser arguments" })),
              Effect.flatMap((params) => browser.execute(params, context?.parentConversationRef, signal)),
            ),
        },
      ],
      [
        "file.transfer",
        {
          id: "file.transfer",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("file.transfer"),
          authority: "filesReceive",
          exposure: "brokered",
          workspaceTier: 1,
          mutation: "write",
          schema: OxpFileExchange.ChatGptParameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpFileExchange.ChatGptParameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP file-transfer arguments" })),
              Effect.flatMap((params) => fileExchange.execute(params, signal)),
            ),
        },
      ],
      [
        "read",
        {
          id: "read",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("read"),
          authority: "read",
          exposure: "direct",
          workspaceTier: 3,
          mutation: "none",
          schema: OxpRead.Parameters,
          schemaConstraints: OxpRead.TransportStrategyConstraints,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpRead.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(
                () =>
                  new OxpError.InvalidArgument({
                    detail:
                      "Invalid OXP read arguments. Read windows are 1-based: offset and limit must be positive integers (use offset:1 for the first line).",
                  }),
              ),
              Effect.flatMap((params) => read.execute(params, signal)),
            ),
        },
      ],
      [
        "edit",
        {
          id: "edit",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("edit"),
          authority: "write",
          exposure: "direct",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpEdit.Parameters,
          schemaConstraints: OxpEdit.TransportStrategyConstraints,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpEdit.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(
                () =>
                  new OxpError.InvalidArgument({
                    detail:
                      "Invalid OXP edit arguments. Use exactly one edit shape: exact {oldString,newString}, batch {edits}, line/range {line|startLine+endLine,oldText,newText}, delete range, insert, append, or nearText. Do not mix strategies.",
                  }),
              ),
              Effect.flatMap((params) => edit.execute(params, signal)),
            ),
        },
      ],
      [
        "git",
        {
          id: "git",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("git"),
          authority: "git",
          exposure: "direct",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpGit.Parameters,
          schemaConstraints: OxpGit.TransportModeConstraints,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpGit.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP Git arguments" })),
              Effect.flatMap((params) => git.execute(params, signal)),
            ),
        },
      ],
      [
        "json",
        {
          id: "json",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("json"),
          authority: "read",
          authorities: ["read", "write"],
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpJson.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpJson.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP JSON arguments" })),
              Effect.flatMap((params) => json.execute(params, signal)),
            ),
        },
      ],
      [
        "lsp",
        {
          id: "lsp",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("lsp"),
          authority: "read",
          exposure: "brokered",
          workspaceTier: 2,
          mutation: "none",
          schema: OxpLsp.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpLsp.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP LSP arguments" })),
              Effect.flatMap((params) => lsp.execute(params, signal)),
            ),
        },
      ],
      [
        "memory",
        {
          id: "memory",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("memory"),
          authority: "read",
          authorities: ["read", "write"],
          exposure: "brokered",
          workspaceTier: 1,
          mutation: "write",
          schema: OxpMemory.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpMemory.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP memory arguments" })),
              Effect.flatMap((params) => memory.execute(params, signal)),
            ),
        },
      ],
      [
        "sqlite",
        {
          id: "sqlite",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("sqlite"),
          authority: "read",
          authorities: ["read", "write"],
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpSqlite.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpSqlite.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP SQLite arguments" })),
              Effect.flatMap((params) => sqlite.execute(params, signal)),
            ),
        },
      ],
      [
        "sympy",
        {
          id: "sympy",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("sympy"),
          authority: "process",
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpSympy.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpSympy.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP SymPy arguments" })),
              Effect.flatMap((params) => sympy.execute(params, signal)),
            ),
        },
      ],
      [
        "ofxp",
        {
          id: "ofxp",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("ofxp"),
          authority: "integrations",
          exposure: "brokered",
          workspaceTier: 0,
          mutation: "write",
          schema: OxpOfxp.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpOfxp.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP OFXP arguments" })),
              Effect.flatMap((params) => ofxp.execute(params, signal)),
            ),
        },
      ],
      [
        "openfork_session.checkpoint",
        {
          id: "openfork_session.checkpoint",
          nativeToolID: "checkpoint",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("openfork_session.checkpoint"),
          authority: "sessionSupervision",
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpSession.CheckpointCapabilityParameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpSession.CheckpointCapabilityParameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP Session checkpoint arguments" })),
              Effect.flatMap((params) =>
                session.execute(
                  {
                    action: "checkpoint",
                    sessionID: params.sessionID,
                    ...(params.rootID ? { rootID: params.rootID } : {}),
                    checkpoint: params.checkpoint,
                  },
                  signal,
                ),
              ),
            ),
        },
      ],
      [
        "openfork_worker",
        {
          id: "openfork_worker",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("openfork_worker"),
          authority: "delegation",
          exposure: "direct",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpWorker.Parameters,
          execute: (input, signal, context) =>
            Schema.decodeUnknownEffect(OxpWorker.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP delegated-worker arguments" })),
              Effect.flatMap((params) =>
                context?.workerExecute
                  ? context.workerExecute(params, signal)
                  : Effect.fail(
                      new OxpError.DependencyUnavailable({
                        detail: "Delegated-worker broker execution requires the OXP host worker dispatcher",
                      }),
                    ),
              ),
            ),
        },
      ],
      [
        "openfork_swarm",
        {
          id: "openfork_swarm",
          nativeToolID: "swarm",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("openfork_swarm"),
          authority: "delegation",
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpSwarm.Parameters,
          focusActions: SWARM_FOCUSED_ACTIONS,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpSwarm.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: swarmArgumentDiagnostic(input) })),
              Effect.flatMap((params) => swarm.execute(params, signal)),
            ),
        },
      ],
      [
        "patch",
        {
          id: "patch",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("patch"),
          authority: "write",
          exposure: "direct",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpPatch.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpPatch.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP patch arguments" })),
              Effect.flatMap((params) => patch.execute(params, signal)),
            ),
        },
      ],
      [
        "find",
        {
          id: "find",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("find"),
          authority: "read",
          exposure: "direct",
          workspaceTier: 3,
          mutation: "none",
          schema: OxpFind.Parameters,
          schemaConstraints: OxpFind.TransportStrategyConstraints,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpFind.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(
                () =>
                  new OxpError.InvalidArgument({
                    detail:
                      'Invalid OXP find arguments. find has no query/maxResults fields: use glob for path search, grep for text search, optional grep + glob to restrict files, and limit for result count. grep is literal by default; set syntax:"regex" only intentionally.',
                  }),
              ),
              Effect.flatMap((params) => find.execute(params, signal)),
            ),
        },
      ],
      [
        "process",
        {
          id: "process",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("process"),
          authority: "process",
          exposure: "direct",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpProcess.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpProcess.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(
                () =>
                  new OxpError.InvalidArgument({
                    detail:
                      "Invalid OXP process transport arguments. Use only fields published by the flat process schema; OXP normalizes known cross-action fields before execution.",
                  }),
              ),
              Effect.flatMap((params) => process.execute(params, signal)),
            ),
        },
      ],
      [
        "runtime.refresh",
        {
          id: "runtime.refresh",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("runtime.refresh"),
          authority: "process",
          exposure: "brokered",
          workspaceTier: 0,
          mutation: "write",
          schema: OxpRuntimeRefresh.Parameters,
          execute: (input) =>
            Schema.decodeUnknownEffect(OxpRuntimeRefresh.Parameters)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(
                () =>
                  new OxpError.InvalidArgument({
                    detail: "Invalid OXP runtime-refresh arguments",
                  }),
              ),
              Effect.flatMap((params) =>
                Effect.gen(function* () {
                  const admission = yield* authority.authorize({
                    plane: "augmentation",
                    operation: `runtime.${params.action}`,
                    phase: "mutate",
                  })
                  yield* authority.revalidate(admission, "commit")
                  return yield* OxpRuntimeRefresh.execute(params)
                }),
              ),
            ),
        },
      ],
      [
        "project",
        {
          id: "project",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("project"),
          authority: "read",
          authorities: ["read", "process"],
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "none",
          schema: OxpProject.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpProject.Parameters)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP project arguments" })),
              Effect.flatMap((params) => project.execute(params, signal)),
            ),
        },
      ],
      [
        "refactor",
        {
          id: "refactor",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("refactor"),
          authority: "read",
          authorities: ["read", "write", "process"],
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpRefactor.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpRefactor.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP refactor arguments" })),
              Effect.flatMap((params) => refactor.execute(params, signal)),
            ),
        },
      ],
      [
        "skill",
        {
          id: "skill",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("skill"),
          authority: "read",
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "none",
          schema: OxpSkill.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpSkill.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP skill arguments" })),
              Effect.flatMap((params) => skill.execute(params, signal)),
            ),
        },
      ],
      [
        "symbols",
        {
          id: "symbols",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("symbols"),
          authority: "read",
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "none",
          schema: OxpSymbols.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpSymbols.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP symbols arguments" })),
              Effect.flatMap((params) => symbols.execute(params, signal)),
            ),
        },
      ],
      [
        "test",
        {
          id: "test",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("test"),
          authority: "read",
          authorities: ["read", "process"],
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpTest.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpTest.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP test arguments" })),
              Effect.flatMap((params) => test.execute(params, signal)),
            ),
        },
      ],
      [
        "typecheck",
        {
          id: "typecheck",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("typecheck"),
          authority: "read",
          authorities: ["read", "process"],
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "none",
          schema: OxpTypecheck.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpTypecheck.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP typecheck arguments" })),
              Effect.flatMap((params) => typecheck.execute(params, signal)),
            ),
        },
      ],
      [
        "usage",
        {
          id: "usage",
          nativeToolID: "usage",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("usage"),
          authority: "sessionSupervision",
          exposure: "brokered",
          workspaceTier: 1,
          mutation: "none",
          schema: OxpUsage.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpUsage.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP usage arguments; context requires sessionID and aggregate actions require the separate global-usage grant" })),
              Effect.flatMap((params) => usage.execute(params, signal)),
            ),
        },
      ],
      [
        "models",
        {
          id: "models",
          nativeToolID: "models",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("models"),
          authority: "read",
          exposure: "brokered",
          workspaceTier: 0,
          mutation: "none",
          schema: OxpModels.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpModels.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP models query arguments" })),
              Effect.flatMap((params) => models.execute(params, signal)),
            ),
        },
      ],
      [
        "web",
        {
          id: "web",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("web"),
          authority: "integrations",
          exposure: "brokered",
          workspaceTier: 0,
          mutation: "none",
          schema: OxpWeb.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpWeb.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP web arguments" })),
              Effect.flatMap((params) => web.execute(params, signal)),
            ),
        },
      ],
      [
        "write",
        {
          id: "write",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("write"),
          authority: "write",
          authorities: ["write", "process"],
          exposure: "direct",
          workspaceTier: 3,
          mutation: "write",
          schema: OxpWrite.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpWrite.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP write arguments" })),
              Effect.flatMap((params) => write.execute(params, signal)),
            ),
        },
      ],
      [
        "system-one",
        {
          id: "system-one",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("system-one"),
          authority: "integrations",
          exposure: "brokered",
          workspaceTier: 3,
          mutation: "none",
          schema: OxpSystemOne.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpSystemOne.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP System One arguments" })),
              Effect.flatMap((params) => systemOne.execute(params, signal)),
            ),
        },
      ],
      [
        "schedule",
        {
          id: "schedule",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("schedule"),
          authority: "automation",
          exposure: "brokered",
          workspaceTier: 1,
          mutation: "write",
          schema: OxpScheduleManagement.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpScheduleManagement.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP schedule arguments" })),
              Effect.flatMap((params) => scheduleManagement.execute(params, signal)),
            ),
        },
      ],
      [
        "schedule.create",
        {
          id: "schedule.create",
          namespace: "openfork",
          description: OxpProse.capabilityDescription("schedule.create"),
          authority: "automation",
          exposure: "brokered",
          workspaceTier: 1,
          mutation: "write",
          schema: OxpSchedule.Parameters,
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpSchedule.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP schedule.create arguments" })),
              Effect.flatMap((params) => schedule.execute(params, signal)),
            ),
        },
      ],
    ])

    // The native OXP definition map is built exactly once per runtime and has
    // no dynamic registrations after Code is installed. Avoid rebuilding its
    // stable ranking generation and local catalog on every Code discovery.
    // External MCP inventory remains fetched/authorized per request below.
    let codeRankingVersion: string | undefined
    let codeLocalCatalog: readonly { ref: string; description: string }[] | undefined
    definitions.set("code", {
      id: "code",
      namespace: "openfork",
      nativeToolID: "code",
      description: OxpCode.DESCRIPTION,
      authority: "code",
      exposure: "brokered",
      workspaceTier: 3,
      // Generated code may compose mutating leaves; leaf definitions still own
      // exact mutation classification and authorization.
      mutation: "write",
      schema: OxpCode.Parameters,
      execute: (input, signal, context) =>
        Schema.decodeUnknownEffect(OxpCode.Parameters)(input, { onExcessProperty: "error" }).pipe(
          Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP Code arguments" })),
          Effect.flatMap((params) =>
            Effect.gen(function* () {
              yield* authority.authorize({
                plane: "augmentation",
                operation: `code.${params.action}`,
                phase: params.action === "run" ? "control" : "discover",
              })
              const { rootID, ...codeInput } = params
              let criticalLeafError: OxpError.Error | undefined
              // Code.run may compose several authorized leaf calls. Only the
              // final MCP result carries model-facing image/audio bytes; the
              // interpreter retains compact handles, never inline base64.
              const mediaContent: NonNullable<OxpResult.CapabilityResult["mediaContent"]>[number][] = []
              let mediaBytes = 0
              const collectMedia = (result: OxpResult.CapabilityResult) => {
                for (const item of result.mediaContent ?? []) {
                  if (mediaContent.length >= 4 || mediaBytes + item.data.length > 4 * 1024 * 1024) break
                  mediaBytes += item.data.length
                  mediaContent.push(item)
                }
              }
              const preserveCriticalLeafError = <A, E extends OxpError.Error, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      if (error._tag === "OXP_AMBIGUOUS_EXTERNAL_RESULT" && !criticalLeafError) {
                        criticalLeafError = error
                      }
                    }),
                  ),
                )
              const external = yield* ExternalCode.execute(codeInput, {
                // Reuse the broker's reviewed actions as read-only retrieval
                // hints. They remain internal: Code.search returns only refs and
                // bounded summaries, never action maps or eagerly loaded schema.
                rankVersion: (codeRankingVersion ??= JSON.stringify([...definitions.values()]
                  .map((item) => [item.id, Object.keys(item.focusActions ?? {}).sort()]))),
                rank: (items, query) => OxpCapabilitySearch.rankCapabilities(
                  items.map((item) => ({
                    id: item.ref,
                    description: item.description,
                    namespace: item.ref.startsWith("mcp:") ? "mcp" as const : "openfork" as const,
                    focusActions: item.ref.startsWith("mcp:")
                      ? undefined
                      : definitions.get(item.ref)?.focusActions,
                    item,
                  })),
                  query,
                ).map(({ item }) => item),
                list: () =>
                  Effect.gen(function* () {
                    const local = (codeLocalCatalog ??= [...definitions.values()]
                      .filter((entry) => entry.id !== "code" && entry.id !== "file.transfer")
                      .map((entry) => ({ ref: entry.id, description: entry.description })))
                    if (!rootID) return local
                    const mcpVisible = yield* authority.discover({
                      plane: "augmentation",
                      operation: "integration.mcp.list",
                    })
                    if (!mcpVisible) return local
                    const remote = yield* mcp.list(rootID)
                    return [
                      ...local,
                      ...remote.map((entry) => ({
                        ref: `mcp:${entry.id}`,
                        description: entry.description,
                      })),
                    ]
                  }),
                describe: (ref) =>
                  Effect.gen(function* () {
                    if (ref.startsWith("mcp:")) {
                      if (!rootID) {
                        return yield* new OxpError.RootRequired({
                          detail: "OXP Code MCP capabilities require an explicit approved root",
                        })
                      }
                      const descriptor = yield* mcp.describe(rootID, ref.slice(4))
                      return {
                        ref: `mcp:${descriptor.capability.id}`,
                        description: descriptor.capability.description,
                        inputSchema: descriptor.inputSchema,
                      }
                    }
                    if (ref === "code" || ref === "file.transfer") {
                      return yield* new OxpError.NotFound({ detail: `Capability is not callable from OXP Code: ${ref}` })
                    }
                    const target = yield* get(ref)
                    const descriptor = descriptorOf(target)
                    return {
                      ref: target.id,
                      description: target.description,
                      inputSchema: descriptor.inputSchema,
                    }
                  }),
                call: (ref, args) =>
                  Effect.gen(function* () {
                    if (ref.startsWith("mcp:")) {
                      if (!rootID) {
                        return yield* new OxpError.RootRequired({
                          detail: "OXP Code MCP capabilities require an explicit approved root",
                        })
                      }
                      const descriptor = yield* mcp.describe(rootID, ref.slice(4))
                      const result = yield* preserveCriticalLeafError(
                        mcp.call(
                          rootID,
                          descriptor.capability.id,
                          descriptor.contract,
                          args,
                          signal,
                        ),
                      )
                      collectMedia(result)
                      return {
                        value: result.structured ?? result.output,
                        ...(result.attachments?.length ? { attachments: result.attachments } : {}),
                        ...(result.mutation ? { mutation: result.mutation } : {}),
                      }
                    }
                    if (ref === "code" || ref === "file.transfer") {
                      return yield* new OxpError.NotFound({ detail: `Capability is not callable from OXP Code: ${ref}` })
                    }
                    const target = yield* get(ref)
                    const normalized = yield* normalizeRootArgs(target, args, rootID)
                    const result = yield* preserveCriticalLeafError(target.execute(normalized.args, signal, context))
                    collectMedia(result)
                    return {
                      value: result.structured ?? result.output,
                      ...(result.attachments?.length ? { attachments: result.attachments } : {}),
                      ...(result.mutation ? { mutation: result.mutation } : {}),
                    }
                  }),
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ExternalCode.InvalidRequest
                    ? new OxpError.InvalidArgument({ detail: error.detail })
                    : error,
                ),
              )
              if (criticalLeafError) return yield* criticalLeafError
              return {
                title: `Code ${params.action}`,
                output: JSON.stringify(external),
                structured: external,
                ...(external.action === "run" && mediaContent.length ? { mediaContent } : {}),
                ...(external.action === "run" && external.attachments?.length
                  ? { attachments: external.attachments }
                  : {}),
                metadata: {
                  action: params.action,
                  stateless: true,
                  ...(rootID ? { rootID } : {}),
                },
                ...(external.action === "run" && external.mutation ? { mutation: external.mutation } : {}),
              } satisfies OxpResult.CapabilityResult
            }),
          ),
        ),
    })

    // Definition identity, loading policy and descriptions are immutable within
    // this runtime. Build the no-query catalogs once, not on every tools/list
    // discovery. Authority is deliberately NOT cached: each invocation still
    // passes both authorization and discoverability checks.
    const definitionsByLoad = Object.freeze({
      all: Object.freeze([...definitions.values()]),
      default: Object.freeze([...definitions.values()].filter((item) => ToolExposure.loadPolicy(item.nativeToolID ?? item.id) === "default")),
      lazy: Object.freeze([...definitions.values()].filter((item) => ToolExposure.loadPolicy(item.nativeToolID ?? item.id) === "lazy")),
    })
    const rowsByID = new Map(definitionsByLoad.all.map((item) => [item.id, catalogRow(item)] as const))
    const unfiltered = Object.freeze({
      all: Object.freeze([...rowsByID.values()].sort((a, b) => a.id.localeCompare(b.id))),
      default: Object.freeze([...rowsByID.values()].filter((row) => row.load === "default").sort((a, b) => a.id.localeCompare(b.id))),
      lazy: Object.freeze([...rowsByID.values()].filter((row) => row.load === "lazy").sort((a, b) => a.id.localeCompare(b.id))),
    })

    const list = Effect.fn("OxpCapability.list")(function* (query?: string, load: ListLoad = "all") {
      yield* authority.authorize({ plane: "augmentation", operation: "capability.list", phase: "discover" })
      const discoverable = yield* authority.discover({ plane: "augmentation", operation: "capability.list" })
      if (!discoverable) return []
      if (!query?.trim()) return unfiltered[load]
      return OxpCapabilitySearch.rankCapabilities(definitionsByLoad[load], query).map((item) => rowsByID.get(item.id)!)
    })

    const get = Effect.fn("OxpCapability.get")(function* (id: string) {
      const item = definitions.get(id)
      if (!item) return yield* new OxpError.NotFound({ detail: `Unknown OXP capability: ${id}` })
      return item
    })

    const describe = Effect.fn("OxpCapability.describe")(function* (id: string, focusAction?: string, guidanceMode: OxpSchemaProjection.GuidanceMode = "balanced") {
      yield* authority.authorize({ plane: "augmentation", operation: "capability.describe", phase: "discover" })
      const item = yield* get(id)
      if (focusAction && !focusedSchemaOf(item, focusAction, guidanceMode)) {
        return yield* new OxpError.InvalidArgument({
          detail: "focusAction requires a unique discriminated action/operation branch. Omit focusAction to inspect the complete canonical schema.",
        })
      }
      return descriptorOf(item, focusAction, guidanceMode)
    })

    const call = Effect.fn("OxpCapability.call")(function* (
      id: string,
      input: unknown,
      signal?: AbortSignal,
      context?: CallContext,
    ) {
      const item = yield* get(id)
      // Leaf execution owns operation-specific authorization/root checks. The
      // broker never turns discovery visibility into call authority.
      return yield* item.execute(input, signal, context)
    })

    const execute = Effect.fn("OxpCapability.execute")(function* (
      input: Input,
      signal?: AbortSignal,
      context?: CallContext,
    ) {
      const namespace = input.namespace ?? "openfork"

      if (input.action === "list") {
        if (input.capability !== undefined || input.args !== undefined || input.contract !== undefined || input.source_file !== undefined || input.focusAction !== undefined || input.guidanceMode !== undefined) {
          return yield* new OxpError.InvalidArgument({ detail: "capability, contract, args, and source_file are not valid for capability.list" })
        }
        if (namespace === "mcp") {
          if (input.load !== undefined) {
            return yield* new OxpError.InvalidArgument({ detail: "load is only valid for namespace=openfork capability.list" })
          }
          if (!input.rootID) {
            return yield* new OxpError.RootRequired({
              detail: "namespace=mcp capability.list requires rootID",
            })
          }
          const rows = yield* mcp.list(input.rootID, input.query)
          return {
            title: "MCP capabilities",
            output: JSON.stringify(rows),
            metadata: {
              action: "list",
              namespace,
              count: rows.length,
              rootID: input.rootID,
            },
          } satisfies OxpResult.CapabilityResult
        }
        const load = input.load ?? (input.query?.trim() ? "all" : "lazy")
        const rows = yield* list(input.query, load)
        return {
          title: load === "lazy" ? "OpenFork lazy capabilities" : "OpenFork capabilities",
          output: JSON.stringify(rows),
          metadata: {
            action: "list",
            namespace,
            load,
            count: rows.length,
            ...(input.rootID ? { brokerNormalized: ["ignored top-level rootID for OpenFork capability.list"] } : {}),
          },
        } satisfies OxpResult.CapabilityResult
      }

      if (!input.capability?.trim()) {
        return yield* new OxpError.InvalidArgument({ detail: `capability.${input.action} requires capability` })
      }
      if (input.query !== undefined) {
        return yield* new OxpError.InvalidArgument({ detail: `query is only valid for capability.list` })
      }
      if (input.load !== undefined) {
        return yield* new OxpError.InvalidArgument({ detail: `load is only valid for capability.list` })
      }

      if (input.action === "describe") {
        if (input.args !== undefined || input.contract !== undefined || input.source_file !== undefined) {
          return yield* new OxpError.InvalidArgument({ detail: "contract, args, and source_file are only valid for capability.call" })
        }
        if (namespace === "mcp") {
          if (input.focusAction !== undefined || input.guidanceMode !== undefined) {
            return yield* new OxpError.InvalidArgument({ detail: "focusAction and guidanceMode are only supported for OpenFork capabilities" })
          }
          if (!input.rootID) {
            return yield* new OxpError.RootRequired({
              detail: "namespace=mcp capability.describe requires rootID",
            })
          }
          const result = yield* mcp.describe(
            input.rootID,
            input.capability,
          )
          return {
            title: `MCP capability ${result.capability.id}`,
            output: JSON.stringify(result),
            metadata: {
              action: "describe",
              namespace,
              capability: result.capability.id,
              rootID: input.rootID,
            },
          } satisfies OxpResult.CapabilityResult
        }
        const result = yield* describe(input.capability, input.focusAction, input.guidanceMode)
        return {
          title: `capability ${input.capability}`,
          output: JSON.stringify(result),
          metadata: {
            action: "describe",
            namespace,
            capability: input.capability,
            ...(input.rootID ? { brokerNormalized: ["ignored top-level rootID for OpenFork capability.describe"] } : {}),
          },
        } satisfies OxpResult.CapabilityResult
      }

      if (input.focusAction !== undefined) {
        return yield* new OxpError.InvalidArgument({ detail: "focusAction is describe-only. Call with the focused descriptor contract and the corresponding action in args." })
      }
      if (namespace === "mcp") {
        if (input.guidanceMode !== undefined) {
          return yield* new OxpError.InvalidArgument({ detail: "guidanceMode is only supported for OpenFork capability.call" })
        }
        if (input.source_file !== undefined) {
          return yield* new OxpError.InvalidArgument({ detail: "source_file is only valid for OpenFork file.transfer" })
        }
        if (!input.rootID) {
          return yield* new OxpError.RootRequired({
            detail: "namespace=mcp capability.call requires rootID",
          })
        }
        return yield* mcp.call(
          input.rootID,
          input.capability,
          input.contract,
          input.args ?? {},
          signal,
        )
      }
      const item = yield* get(input.capability)
      if (input.source_file !== undefined && item.id !== "file.transfer") {
        return yield* new OxpError.InvalidArgument({ detail: "source_file is only valid for capability=file.transfer" })
      }
      const mode = input.guidanceMode ?? "balanced"
      let issue = BrokerContract.violationExpected({
        broker: "capability",
        target: item.id,
        expected: descriptorProof(item, undefined, mode).contract,
        contract: input.contract,
        discovery: `Call capability with action="describe" and capability="${item.id}"`,
      })
      // A focused description proves one exact operation. Never accept that
      // token for a *different* action; leaf validation remains authoritative.
      if (issue) {
        const record = argsRecord(input.args)
        const action = record?.operation ?? record?.action
        if (typeof action === "string" && focusedSchemaOf(item, action, mode)) {
          issue = BrokerContract.violationExpected({
            broker: "capability",
            target: item.id,
            expected: descriptorProof(item, action, mode).contract,
            contract: input.contract,
            discovery: `Call capability.describe with focusAction="${action}" to obtain its current focused contract`,
          })
        }
      }
      if (issue) return yield* new OxpError.InvalidArgument({ detail: issue })
      let args: unknown = input.source_file === undefined
        ? input.args ?? {}
        : { ...((input.args && typeof input.args === "object" && !Array.isArray(input.args)) ? input.args : {}), source_file: input.source_file }
      const normalized = yield* normalizeRootArgs(item, args, input.rootID)
      args = normalized.args
      const brokerNormalized = normalized.brokerNormalized
      const result = yield* call(input.capability, args, signal, context)
      return brokerNormalized
        ? {
            ...result,
            metadata: {
              ...result.metadata,
              brokerNormalized,
            },
          }
        : result
    })

    return Service.of({ list, describe, call, execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    OxpAuthority.node,
    OxpArchive.node,
    OxpEdit.node,
    OxpPatch.node,
    OxpProcess.node,
    OxpRead.node,
    OxpFind.node,
    OxpGit.node,
    OxpJson.node,
    OxpProject.node,
    OxpRefactor.node,
    OxpSkill.node,
    OxpSymbols.node,
    OxpTest.node,
    OxpTypecheck.node,
    OxpUsage.node,
    OxpModels.node,
    OxpWrite.node,
    OxpSchedule.node,
    OxpScheduleManagement.node,
    OxpMcp.node,
    OxpFileExchange.node,
    OxpBrowser.node,
    OxpWeb.node,
    OxpMemory.node,
    OxpLsp.node,
    OxpSqlite.node,
    OxpSympy.node,
    OxpOfxp.node,
    OxpSystemOne.node,
    OxpSwarm.node,
    OxpSession.node,
  ],
})

export * as OxpCapability from "./capability"
