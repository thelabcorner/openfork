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
import { OxpSession } from "./session"
import { OxpWorker } from "./worker"
import { OxpWrite } from "./write"

export const MAJOR_VERSION = 0

export const SERVER_INSTRUCTIONS = [
  "OXP serves the current ChatGPT/OpenAI agent; no backing OpenFork Session; no implicit ChatGPT workspace. Roots bound authority.",
  "Delegation agent/model selections are per-call preferences: honor explicit caller choices when valid; otherwise use native live defaults. No OXP selection allowlist/default gate exists.",
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
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    invoking: "Reading workspace…",
    invoked: "Workspace read",
  },
  {
    name: "edit",
    title: "Edit workspace file",
    description: OxpProse.directToolDescription("edit"),
    schema: OxpEdit.Parameters,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    invoking: "Editing file…",
    invoked: "File edited",
  },
  {
    name: "write",
    title: "Write workspace file",
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

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema)
  if (!value || typeof value !== "object") return value
  const out = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "description")
      .map(([key, item]) => [key, compactSchema(item)]),
  ) as Record<string, unknown>

  if (Array.isArray(out.anyOf)) {
    const options = out.anyOf.filter(
      (item) =>
        !(
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).type === "null"
        ),
    )
    const hasNumber = options.some(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === "number",
    )
    const hasNonJsonNumberSentinel = options.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false
      const values = (item as Record<string, unknown>).enum
      return (
        Array.isArray(values) &&
        values.some((entry) => entry === "NaN" || entry === "Infinity" || entry === "-Infinity")
      )
    })
    if (hasNumber && hasNonJsonNumberSentinel) return { type: "number" }
    if (options.length === 1) return options[0]
    out.anyOf = options
  }

  if (out.type && Array.isArray(out.allOf)) {
    const mergeable = out.allOf.every(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        !("type" in (item as Record<string, unknown>)) &&
        !("anyOf" in (item as Record<string, unknown>)) &&
        !("oneOf" in (item as Record<string, unknown>)) &&
        !("$ref" in (item as Record<string, unknown>)),
    )
    if (mergeable) {
      for (const item of out.allOf) Object.assign(out, item)
      delete out.allOf
    }
  }

  return out
}

function schemaRefs(value: unknown, refs = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) schemaRefs(item, refs)
    return refs
  }
  if (!value || typeof value !== "object") return refs
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/")) {
      refs.add(item.slice("#/$defs/".length))
      continue
    }
    schemaRefs(item, refs)
  }
  return refs
}

function inputSchema(schema: Schema.Top): Tool["inputSchema"] {
  // The fixed OXP manifest is injected into every parent turn. Keep the exact
  // structural JSON shape while removing projection-only noise duplicated by
  // runtime validation. Optional null branches become omission, Effect's
  // JavaScript-only non-finite number sentinels disappear, and scalar allOf
  // wrappers flatten. Runtime decoding still uses the full Effect schema.
  const document = Schema.toJsonSchemaDocument(schema, { additionalProperties: false })
  const projected = compactSchema(document.schema) as Record<string, unknown>
  const definitions = document.definitions as Record<string, unknown> | undefined
  const needed = [...schemaRefs(projected)]
  if (!definitions || needed.length === 0) return projected as Tool["inputSchema"]

  const defs: Record<string, unknown> = {}
  const pending = [...needed]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const name = pending.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    const definition = definitions[name]
    if (definition === undefined) continue
    const compacted = compactSchema(definition)
    defs[name] = compacted
    for (const dependency of schemaRefs(compacted)) {
      if (!seen.has(dependency)) pending.push(dependency)
    }
  }
  return { ...projected, $defs: defs } as unknown as Tool["inputSchema"]
}

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
      inputSchema: inputSchema(definition.schema),
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
