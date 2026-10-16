import { createHash } from "node:crypto"
import { canonicalTransportJson } from "./transport-canonical"
import { Schema } from "effect"
import type { Tool } from "@modelcontextprotocol/server"
import { OxpCapability } from "./capability"

import { OxpEdit } from "./edit"
import { OxpFind } from "./find"
import { OxpFileExchange } from "./file-exchange"
import { OxpGit } from "./git"
import { OxpPatch } from "./patch"
import { OxpProcess } from "./process"
import { OxpProse } from "./prose"
import { OxpRead } from "./read"
import { OxpRequest } from "./request"
import { OxpSchemaProjection } from "./schema-projection"
import { OxpSession } from "./session"
import { OxpWorker } from "./worker"
import { OxpWrite } from "./write"

export const MAJOR_VERSION = 0

export const SERVER_INSTRUCTIONS = [
  "OXP serves the current ChatGPT/OpenAI agent; no backing OpenFork Session; no implicit ChatGPT workspace. Roots bound authority.",
  "First call openfork_info(action=status, sessionTitle=this conversation's title). Prefer direct tools for work; for brokered tools use capability.list to discover, capability.describe to obtain the exact schema/contract, then capability.call with that contract. Discovery never grants authority. Never blindly retry a write with an unknown commit outcome.",
  "Delegation uses explicit valid caller selections, otherwise user-configured OXP defaults; missing required defaults fail closed. Defaults are preferences, not allowlists.",
  "Default model/agent changes require explicit user request; never change them autonomously.",
  "File mutations: write creates/replaces whole files; edit handles surgical changes; compatible create/missing-file shapes self-heal through atomic write semantics; patch handles verified multi-file changes. process remains general-purpose.",
  "Use openfork_worker model_catalog for provider/model/variant discovery and agent_catalog for agents. If the direct worker schema is stale, capability describe/call the live contract.",
  "On the first openfork_info action=status, pass sessionTitle set to this conversation's own title (not the repo or root). Status re-checks it on later calls; a different value updates the session title.",
  "Delegated worker wait/result may return blocked with native request IDs. Resolve each blocker via openfork_request using blockedBy[].sessionID, then wait again. externalDirectory=true is reject-only. Without request supervision, preserve/report the block; never auto-answer or restart it.",
  "Do not infer worker staleness from quiet messages, unchanged updatedAt, or elapsed time; native permission/question Deferreds can pause workers. Use wait/result before replacing or cancelling.",
  "Upstream may reject model-authored authentication before OXP receives it. For OpenAI Files call openai_files directly; OXP owns the OpenAI connection. Never read secrets or build auth in process.",
  "Code Mode is brokered: capability describe code, then capability call code with action search/describe/run. Every generated leaf retains its own authority.",
  "Parent 25m; delegate. capability.list lazy; openfork_info capabilities complete. OXP_INTERNAL errors include incident IDs; query openfork_diagnostics by incidentID if openfork_info fails.",
].join("\n")

export const CapabilityParameters = OxpCapability.Parameters
export type CapabilityInput = Schema.Schema.Type<typeof CapabilityParameters>

export const InfoParameters = Schema.Struct({
  // Keep this list aligned with the read-authorized dispatcher branches.
  action: Schema.Literals(["status", "capabilities", "diagnostics"]),
  limit: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20))),
  incidentID: Schema.optional(Schema.String.check(Schema.isUUID())),
  // Conventional handshake metadata. A bounded string at the schema layer;
  // normalization and the blank/length policy live in the status handler so
  // the error messages stay compact and actionable.
  sessionTitle: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
})
export type InfoInput = Schema.Schema.Type<typeof InfoParameters>

export const DiagnosticsParameters = Schema.Struct({
  limit: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20))),
  incidentID: Schema.optional(Schema.String.check(Schema.isUUID())),
})
export type DiagnosticsInput = Schema.Schema.Type<typeof DiagnosticsParameters>

interface Definition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly schema: Schema.Top
  readonly schemaConstraints?: Readonly<Record<string, unknown>>
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly openWorld: boolean
  readonly fileParams?: readonly string[]
  readonly invoking: string
  readonly invoked: string
}

type ChatGptTool = Tool & {
  readonly securitySchemes?: readonly { readonly type: "noauth" }[]
}

export const DEFINITIONS: readonly Definition[] = Object.freeze([
  {
    name: "read",
    title: "Read workspace files",
    description: OxpProse.directToolDescription("read"),
    schema: OxpRead.Parameters,
    schemaConstraints: OxpRead.TransportStrategyConstraints,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    invoking: "Reading workspace…",
    invoked: "Workspace read",
  },
  {
    name: "edit",
    title: "Edit workspace text",
    description: OxpProse.directToolDescription("edit"),
    schema: OxpEdit.Parameters,
    schemaConstraints: OxpEdit.TransportStrategyConstraints,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    invoking: "Editing file…",
    invoked: "File edited",
  },
  {
    name: "write",
    title: "Create or replace workspace file",
    description: OxpProse.directToolDescription("write"),
    schema: OxpWrite.Parameters,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    invoking: "Writing file…",
    invoked: "File written",
  },
  {
    name: "git",
    title: "Use Git",
    description: OxpProse.directToolDescription("git"),
    schema: OxpGit.Parameters,
    schemaConstraints: OxpGit.TransportModeConstraints,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    invoking: "Running Git…",
    invoked: "Git complete",
  },
  {
    name: "patch",
    title: "Patch workspace files",
    description: OxpProse.directToolDescription("patch"),
    schema: OxpPatch.Parameters,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    invoking: "Applying patch…",
    invoked: "Patch complete",
  },
  {
    name: "find",
    title: "Find workspace content",
    description: OxpProse.directToolDescription("find"),
    schema: OxpFind.Parameters,
    schemaConstraints: OxpFind.TransportStrategyConstraints,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    invoking: "Searching workspace…",
    invoked: "Search complete",
  },
  {
    name: "process",
    title: "Run workspace process",
    description: OxpProse.directToolDescription("process"),
    schema: OxpProcess.Parameters,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
    invoking: "Running process…",
    invoked: "Process complete",
  },
  {
    name: "openai_files",
    title: "Use OpenAI Files",
    description: OxpProse.directToolDescription("openai_files"),
    schema: OxpFileExchange.OpenAiParameters,
    schemaConstraints: OxpFileExchange.OpenAiTransportConstraints,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
    invoking: "Using OpenAI Files…",
    invoked: "Files operation complete",
  },
  {
    name: "capability",
    title: "Use OpenFork capability",
    description: OxpProse.directToolDescription("capability"),
    schema: CapabilityParameters,
    readOnly: false,
    destructive: true,
    idempotent: false,
    // The broker can dispatch web/browser/external-MCP capabilities. A generic
    // descriptor must advertise the broadest behavior it can actually execute.
    openWorld: true,
    fileParams: ["source_file"],
    invoking: "Using capability…",
    invoked: "Capability complete",
  },
  {
    name: "openfork_info",
    title: "Inspect OpenFork OXP",
    description: OxpProse.directToolDescription("openfork_info"),
    schema: InfoParameters,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    invoking: "Inspecting OpenFork…",
    invoked: "OpenFork status ready",
  },
  {
    name: "openfork_diagnostics",
    title: "Inspect OXP internal errors",
    description: OxpProse.directToolDescription("openfork_diagnostics"),
    schema: DiagnosticsParameters,
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    invoking: "Reading OXP diagnostics…",
    invoked: "OXP diagnostics ready",
  },
  {
    name: "openfork_session",
    title: "Supervise OpenFork session",
    description: OxpProse.directToolDescription("openfork_session"),
    schema: OxpSession.DirectParameters,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    invoking: "Supervising session…",
    invoked: "Session operation complete",
  },
  {
    name: "openfork_request",
    title: "Answer OpenFork request",
    description: OxpProse.directToolDescription("openfork_request"),
    schema: OxpRequest.Parameters,
    schemaConstraints: OxpRequest.TransportActionConstraints,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    invoking: "Handling request…",
    invoked: "Request handled",
  },
  {
    name: "openfork_worker",
    title: "Manage OpenFork worker",
    description: OxpProse.directToolDescription("openfork_worker"),
    schema: OxpWorker.Parameters,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    invoking: "Managing worker…",
    invoked: "Worker operation complete",
  },
])

/**
 * Every successful OXP call is projected through toolResult() into this stable
 * model-facing envelope. Keep this schema synchronized with that projection:
 * ChatGPT uses outputSchema to validate and reason over structuredContent.
 */
export const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    output: { type: "string" },
    data: {},
    attachments: { type: "array", items: { type: "object" } },
    metadata: { type: "object" },
    mutation: {
      type: "object",
      properties: { attempted: { type: "boolean" }, committed: { type: "boolean" } },
      required: ["attempted", "committed"],
      additionalProperties: false,
    },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean" },
        metadata: { type: "object" },
      },
      required: ["code", "message", "retryable"],
      additionalProperties: false,
    },
    oxp: {
      type: "object",
      properties: { continuity: { type: "object" } },
      required: ["continuity"],
      additionalProperties: false,
    },
  },
  required: ["output"],
  additionalProperties: false,
} as const satisfies Tool["outputSchema"])

/**
 * ChatGPT's currently deployed connector transport still speaks the 2025 MCP
 * era. The v2 MCP compatibility projector wraps structured output differently
 * for that era, so making `output` required there causes the transport adapter
 * to reject otherwise-valid results before they leave OXP.
 *
 * Keep this as a transport-only compatibility schema. Runtime semantics,
 * authority, correlation, and canonical surface ownership remain 2026-era.
 */
export const LEGACY_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: OUTPUT_SCHEMA.properties,
  additionalProperties: false,
} as const satisfies Tool["outputSchema"])

const NOAUTH = Object.freeze([{ type: "noauth" as const }])

export const TOOLS: readonly ChatGptTool[] = Object.freeze(
  DEFINITIONS.map((definition) =>
    Object.freeze({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      // Always keep the *permanently advertised* direct MCP tools lean. Rich
      // descriptions belong to on-demand capability.describe, not every turn.
      inputSchema: OxpSchemaProjection.definitionInputSchema(definition, "compact"),
      outputSchema: OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: definition.readOnly,
        destructiveHint: definition.destructive,
        ...(definition.idempotent ? { idempotentHint: true } : {}),
        openWorldHint: definition.openWorld,
      },
      // OXP's Secure MCP Tunnel is the authenticated connector boundary; the
      // loopback MCP surface itself does not initiate per-tool OAuth. Declare
      // that explicitly so ChatGPT does not infer an OAuth requirement.
      securitySchemes: NOAUTH,
      _meta: {
        securitySchemes: NOAUTH,
        "openai/toolInvocation/invoking": definition.invoking,
        "openai/toolInvocation/invoked": definition.invoked,
        ...(definition.fileParams ? { "openai/fileParams": definition.fileParams } : {}),
      },
    } satisfies ChatGptTool),
  ),
)

export function toolProjectionFingerprint(tools: readonly Tool[]) {
  return createHash("sha256").update(canonicalTransportJson([...tools].sort((a, b) => a.name.localeCompare(b.name)))).digest("hex")
}

export const FINGERPRINT = createHash("sha256")
  .update(
    canonicalTransportJson({
      major: MAJOR_VERSION,
      instructions: SERVER_INSTRUCTIONS,
      tools: [...TOOLS].sort((a, b) => a.name.localeCompare(b.name)),
    }),
  )
  .digest("hex")

export * as OxpSurface from "./surface"
