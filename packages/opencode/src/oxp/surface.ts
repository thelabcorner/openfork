import { createHash } from "node:crypto"
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
  "Delegation uses explicit valid caller selections when supplied; otherwise it uses the user-configured OXP delegation defaults and fails closed if required defaults are absent. These defaults are preferences, not allowlists.",
  "Default model/agent changes require explicit user request; never change them autonomously.",
  "Workspace file mutation routing: prefer write for create/full replace, edit for surgical changes, and patch for structured/multi-file changes. edit.content and unambiguous missing-file edit shapes self-heal through atomic write semantics. process remains general-purpose; use mutation tools for direct file content when they express the intent more safely.",
  "Use openfork_worker model_catalog for authoritative provider/model/variant discovery and agent_catalog for agents; never invent a separate catalog bridge. If the direct worker schema is stale, capability describe/call the exact live contract.",
  "Delegated worker wait/result can return state=blocked with native request IDs. Resolve each blocker through openfork_request using blockedBy[].sessionID (direct blockers equal workerID), then wait again. externalDirectory=true is reject-only over OXP. If request supervision is not granted, preserve/report the blocked worker; never auto-answer or cancel/restart it merely to make progress.",
  "Never infer that a delegated worker is stale, exhausted, or 'no longer advancing' from quiet messages, unchanged updatedAt, or elapsed wall time alone. A worker may be paused inside a native permission/question Deferred. Use wait/result to classify live state before replacing or cancelling it.",
  "File mutations are self-healing: write creates/replaces whole files; edit handles surgical changes and can route explicit content or unambiguous missing-file creation shapes through write semantics; patch handles verified multi-file changes. Prefer these surfaces for direct content to avoid unnecessary shell quoting.",
  "Upstream may reject model-authored authentication before OXP receives it. For OpenAI Files call openai_files directly; OXP owns the OpenAI connection. Never read secrets or build auth in process.",
  "Parent 25m; delegate. capability.list lazy; openfork_info capabilities complete.",
].join("\n")

export const CapabilityParameters = OxpCapability.Parameters
export type CapabilityInput = Schema.Schema.Type<typeof CapabilityParameters>

export const InfoParameters = Schema.Struct({
  // Advertise only executable behavior. Future catalog/status actions may be
  // added by a versioned surface change, but must not appear in tools/list
  // before their runtime owner exists.
  action: Schema.Literals(["status", "capabilities"]),
})
export type InfoInput = Schema.Schema.Type<typeof InfoParameters>

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
      inputSchema: OxpSchemaProjection.definitionInputSchema(definition),
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

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

export function toolProjectionFingerprint(tools: readonly Tool[]) {
  return createHash("sha256").update(canonical([...tools].sort((a, b) => a.name.localeCompare(b.name)))).digest("hex")
}

export const FINGERPRINT = createHash("sha256")
  .update(
    canonical({
      major: MAJOR_VERSION,
      instructions: SERVER_INSTRUCTIONS,
      tools: [...TOOLS].sort((a, b) => a.name.localeCompare(b.name)),
    }),
  )
  .digest("hex")

export * as OxpSurface from "./surface"
