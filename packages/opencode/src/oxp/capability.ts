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
import { OxpSession } from "./session"
import { OxpWorker } from "./worker"
import { OxpProse } from "./prose"
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
  readonly execute: (
    input: unknown,
    signal?: AbortSignal,
    context?: CallContext,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export interface Interface {
  readonly list: (query?: string, load?: ListLoad) => Effect.Effect<readonly CatalogRow[], OxpError.Error>
  readonly describe: (id: string) => Effect.Effect<Descriptor, OxpError.Error>
  readonly call: (id: string, input: unknown, signal?: AbortSignal, context?: CallContext) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
  readonly execute: (input: Input, signal?: AbortSignal, context?: CallContext) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export type Descriptor = ReturnType<typeof BrokerContract.describe> & {
  readonly capability: CatalogRow
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
    execute: _execute,
    nativeToolID,
    ...row
  } = item
  return Object.freeze({ ...row, load: ToolExposure.loadPolicy(nativeToolID ?? item.id) })
}

function descriptorOf(item: Definition): Descriptor {
  const inputSchema = OxpSchemaProjection.definitionInputSchema(item)
  return {
    ...BrokerContract.describe({
      broker: "capability",
      target: item.id,
      targetField: "capability",
      description: item.description,
      schema: inputSchema,
    }),
    capability: catalogRow(item),
  }
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
          execute: (input, signal) =>
            Schema.decodeUnknownEffect(OxpSwarm.Parameters)(input, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() => new OxpError.InvalidArgument({ detail: "Invalid OXP Swarm arguments" })),
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

    const visible = Effect.fn("OxpCapability.visible")(function* () {
      const allowed = yield* authority.discover({ plane: "augmentation", operation: "capability.list" })
      return allowed ? [...definitions.values()] : []
    })

    const list = Effect.fn("OxpCapability.list")(function* (query?: string, load: ListLoad = "all") {
      yield* authority.authorize({ plane: "augmentation", operation: "capability.list", phase: "discover" })
      const terms = query
        ?.trim()
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean) ?? []
      return (yield* visible())
        .filter((item) => load === "all" || ToolExposure.loadPolicy(item.nativeToolID ?? item.id) === load)
        .filter((item) => {
          if (terms.length === 0) return true
          const haystack = `${item.id} ${item.description}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
          return terms.every((term) => haystack.includes(term))
        })
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(catalogRow)
    })

    const get = Effect.fn("OxpCapability.get")(function* (id: string) {
      const item = definitions.get(id)
      if (!item) return yield* new OxpError.NotFound({ detail: `Unknown OXP capability: ${id}` })
      return item
    })

    const describe = Effect.fn("OxpCapability.describe")(function* (id: string) {
      yield* authority.authorize({ plane: "augmentation", operation: "capability.describe", phase: "discover" })
      const item = yield* get(id)
      return descriptorOf(item)
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
        if (input.capability !== undefined || input.args !== undefined || input.contract !== undefined || input.source_file !== undefined) {
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
        const result = yield* describe(input.capability)
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

      if (namespace === "mcp") {
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
      const descriptor = descriptorOf(item)
      const issue = BrokerContract.violation({
        broker: "capability",
        target: item.id,
        description: item.description,
        schema: descriptor.inputSchema,
        contract: input.contract,
        discovery: `Call capability with action="describe" and capability="${item.id}"`,
      })
      if (issue) return yield* new OxpError.InvalidArgument({ detail: issue })
      let args = input.source_file === undefined
        ? input.args ?? {}
        : { ...((input.args && typeof input.args === "object" && !Array.isArray(input.args)) ? input.args : {}), source_file: input.source_file }
      let brokerNormalized: string[] | undefined
      if (input.rootID !== undefined) {
        if (schemaAcceptsRootID(descriptor.inputSchema)) {
          const record = argsRecord(args)
          if (record) {
            const nested = record.rootID
            if (nested !== undefined && nested !== input.rootID) {
              return yield* new OxpError.InvalidArgument({
                detail: "Conflicting rootID values were supplied at the capability broker and capability argument levels",
              })
            }
            if (nested === undefined) {
              args = { ...record, rootID: input.rootID }
              brokerNormalized = ["promoted top-level rootID into OpenFork capability arguments"]
            } else {
              brokerNormalized = ["deduplicated identical top-level rootID from OpenFork capability.call"]
            }
          }
        } else {
          brokerNormalized = ["ignored top-level rootID for a rootless OpenFork capability"]
        }
      }
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
