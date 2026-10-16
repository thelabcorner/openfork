import type { JSONSchema7 } from "@ai-sdk/provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect } from "effect"
import type { Interface as MCPInterface, Resource } from "./index"
import type * as Tool from "@/tool/tool"
import { Permission } from "@/permission"
import { isRecord } from "@/util/record"

export const IDs = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const

export type ID = (typeof IDs)[keyof typeof IDs]

export const DESCRIPTIONS: Readonly<Record<ID, string>> = {
  [IDs.list]:
    "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
  [IDs.listTemplates]:
    "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
  [IDs.read]:
    "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
}

export const INPUT_SCHEMAS: Readonly<Record<ID, JSONSchema7>> = {
  [IDs.list]: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "Optional MCP server name. When omitted, lists resources from every connected server.",
      },
    },
    additionalProperties: false,
  },
  [IDs.listTemplates]: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description:
          "Optional MCP server name. When omitted, lists resource templates from every connected server.",
      },
    },
    additionalProperties: false,
  },
  [IDs.read]: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server name exactly as returned by list_mcp_resources.",
      },
      uri: {
        type: "string",
        description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
      },
    },
    required: ["server", "uri"],
    additionalProperties: false,
  },
}

const MAX_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

type MCPResourceService = Pick<MCPInterface, "clients" | "resources" | "resourceTemplates" | "readResource">

type PermissionRequest = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

type Plan =
  | {
      readonly id: typeof IDs.list | typeof IDs.listTemplates
      readonly server?: string
      readonly resourceServers: readonly string[]
      readonly permission: PermissionRequest
    }
  | {
      readonly id: typeof IDs.read
      readonly server: string
      readonly uri: string
      readonly permission: PermissionRequest
    }

export interface Definition {
  readonly id: ID
  readonly description: string
  readonly inputSchema: JSONSchema7
  readonly plan: (mcp: MCPResourceService, args: unknown) => Effect.Effect<Plan, Error>
  readonly invoke: (
    mcp: MCPResourceService,
    args: unknown,
    ctx: Tool.Context,
  ) => Effect.Effect<Tool.ExecuteResult, Tool.Failure>
}

function parse<T>(thunk: () => T) {
  return Effect.try({
    try: thunk,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

const resourceServers = Effect.fn("McpResourceTools.resourceServers")(function* (mcp: MCPResourceService) {
  const clients = yield* mcp.clients()
  return Object.entries(clients)
    .filter(([, client]) => !!client.getServerCapabilities()?.resources)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
})

function assertResourceServer(server: string | undefined, servers: readonly string[]) {
  if (!server || servers.includes(server)) return
  throw new Error(
    servers.length === 0
      ? `MCP server "${server}" does not support resources`
      : `MCP server "${server}" does not support resources. Available resource servers: ${servers.join(", ")}`,
  )
}

const planList = Effect.fn("McpResourceTools.planList")(function* (
  mcp: MCPResourceService,
  args: unknown,
  id: typeof IDs.list | typeof IDs.listTemplates,
) {
  const parsed = yield* parse(() => ({ server: optionalString(toRecord(args), "server") }))
  const servers = yield* resourceServers(mcp)
  yield* parse(() => assertResourceServer(parsed.server, servers))
  const patterns = parsed.server ? [`mcp:${parsed.server}:*`] : servers.map((server) => `mcp:${server}:*`)
  return {
    id,
    ...(parsed.server ? { server: parsed.server } : {}),
    resourceServers: servers,
    permission: {
      permission: "read",
      metadata: parsed.server ? { server: parsed.server } : {},
      patterns,
      always: patterns,
    },
  } satisfies Plan
})

const planRead = Effect.fn("McpResourceTools.planRead")(function* (mcp: MCPResourceService, args: unknown) {
  const parsed = yield* parse(() => {
    const record = toRecord(args)
    return {
      server: requiredString(record, "server"),
      uri: requiredString(record, "uri"),
    }
  })
  const servers = yield* resourceServers(mcp)
  yield* parse(() => assertResourceServer(parsed.server, servers))
  return {
    id: IDs.read,
    server: parsed.server,
    uri: parsed.uri,
    permission: {
      permission: "read",
      metadata: { server: parsed.server, uri: parsed.uri },
      patterns: [`mcp:${parsed.server}:${parsed.uri}`],
      always: [`mcp:${parsed.server}:*`],
    },
  } satisfies Plan
})

export const plan = Effect.fn("McpResourceTools.plan")(function* (
  mcp: MCPResourceService,
  id: ID,
  args: unknown,
) {
  switch (id) {
    case IDs.list:
    case IDs.listTemplates:
      return yield* planList(mcp, args, id)
    case IDs.read:
      return yield* planRead(mcp, args)
  }
})

export const authorize = Effect.fn("McpResourceTools.authorize")(function* (
  mcp: MCPResourceService,
  id: ID,
  args: unknown,
  ruleset: PermissionV1.Ruleset,
) {
  const planned = yield* plan(mcp, id, args)
  for (const pattern of planned.permission.patterns) {
    const policy = Permission.evaluate(planned.permission.permission, pattern, ruleset)
    if (policy.action === "deny") {
      return yield* new PermissionV1.DeniedError({ ruleset: [policy] })
    }
  }
})

export const invoke = Effect.fn("McpResourceTools.invoke")(function* (
  mcp: MCPResourceService,
  id: ID,
  args: unknown,
  ctx: Tool.Context,
) {
  const planned = yield* plan(mcp, id, args)
  yield* ctx.ask(planned.permission)

  if (planned.id === IDs.list) {
    const resources = Object.values(yield* mcp.resources(planned.server))
      .filter((resource) => !planned.server || resource.client === planned.server)
      .toSorted((a, b) =>
        (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
          b.client + "\u0000" + b.name + "\u0000" + b.uri,
        ),
      )
    const value = { resources: resources.map(formatResource) }
    return {
      title: planned.server ? `MCP resources: ${planned.server}` : "MCP resources",
      metadata: {
        count: resources.length,
        servers: [...planned.resourceServers],
        ...(planned.server ? { server: planned.server } : {}),
      },
      output: JSON.stringify(value, null, 2),
      data: value,
    } satisfies Tool.ExecuteResult
  }

  if (planned.id === IDs.listTemplates) {
    const templates = Object.values(yield* mcp.resourceTemplates(planned.server))
      .filter((template) => !planned.server || template.client === planned.server)
      .toSorted((a, b) =>
        (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
          b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
        ),
      )
    const value = { resourceTemplates: templates.map(formatTemplate) }
    return {
      title: planned.server ? `MCP resource templates: ${planned.server}` : "MCP resource templates",
      metadata: {
        count: templates.length,
        servers: [...planned.resourceServers],
        ...(planned.server ? { server: planned.server } : {}),
      },
      output: JSON.stringify(value, null, 2),
      data: value,
    } satisfies Tool.ExecuteResult
  }

  const readPlan = planned as Extract<Plan, { id: typeof IDs.read }>
  const content = yield* mcp.readResource(readPlan.server, readPlan.uri)
  if (!content)
    return yield* Effect.fail(new Error(`Failed to read MCP resource: ${readPlan.server}/${readPlan.uri}`))
  const formatted = formatContent(readPlan.server, readPlan.uri, content)
  return {
    title: `MCP resource: ${readPlan.uri}`,
    metadata: {
      server: readPlan.server,
      uri: readPlan.uri,
      contents: formatted.contents,
      attachments: formatted.attachments.length,
    },
    output: formatted.text,
    attachments: formatted.attachments,
  } satisfies Tool.ExecuteResult
})

export const definitions: readonly Definition[] = [
  {
    id: IDs.list,
    description: DESCRIPTIONS[IDs.list],
    inputSchema: INPUT_SCHEMAS[IDs.list],
    plan: (mcp, args) => plan(mcp, IDs.list, args),
    invoke: (mcp, args, ctx) => invoke(mcp, IDs.list, args, ctx),
  },
  {
    id: IDs.listTemplates,
    description: DESCRIPTIONS[IDs.listTemplates],
    inputSchema: INPUT_SCHEMAS[IDs.listTemplates],
    plan: (mcp, args) => plan(mcp, IDs.listTemplates, args),
    invoke: (mcp, args, ctx) => invoke(mcp, IDs.listTemplates, args, ctx),
  },
  {
    id: IDs.read,
    description: DESCRIPTIONS[IDs.read],
    inputSchema: INPUT_SCHEMAS[IDs.read],
    plan: (mcp, args) => plan(mcp, IDs.read, args),
    invoke: (mcp, args, ctx) => invoke(mcp, IDs.read, args, ctx),
  },
]

export function formatResource(resource: Resource) {
  return {
    name: resource.name,
    uri: resource.uri,
    ...(resource.description === undefined ? {} : { description: resource.description }),
    ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
    server: resource.client,
  }
}

export function formatTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter(([key]) => key !== "client"))
  return { ...result, server: template.client }
}

export function formatContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

