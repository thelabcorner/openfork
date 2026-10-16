import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000
const MAX_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const lastUriSegment = (uri: string) => {
  const trimmed = uri.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment.length > 0 ? segment : undefined
}

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const page = await list(cursor)
    result.push(...items(page))
    if (page.nextCursor === undefined) return result
    if (cursors.has(page.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${page.nextCursor}`)
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

export function defs(client: Client, timeout?: number) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT).pipe(Effect.catch(() => Effect.void))
}

export async function invokeTool(
  client: Client,
  name: string,
  args: unknown,
  options: {
    readonly timeout?: number
    readonly signal?: AbortSignal
  } = {},
) {
  const result = await client.callTool(
    {
      name,
      arguments: (args || {}) as Record<string, unknown>,
    },
    CallToolResultSchema,
    {
      resetTimeoutOnProgress: true,
      signal: options.signal,
      timeout: options.timeout,
      // The MCP SDK only sends a progress token when this hook is present,
      // enabling timeout resets.
      onprogress: () => {},
    },
  )
  if (result.isError)
    throw new Error(
      result.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .filter((text) => text.trim())
        .join("\n\n") || "MCP tool returned an error",
    )
  if (
    result.content.length > 0 ||
    result.structuredContent === undefined ||
    result.structuredContent === null
  )
    return result
  return {
    ...result,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result.structuredContent),
      },
    ],
  }
}


export type ProjectedToolResult = {
  output: string
  data?: unknown
  metadata: Record<string, unknown>
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

export function projectToolResult(result: Awaited<ReturnType<typeof invokeTool>>): ProjectedToolResult {
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of result.content) {
    if (item.type === "text") {
      text.push(item.text)
      continue
    }

    if (item.type === "image" || item.type === "audio") {
      attachments.push({
        type: "file",
        mime: item.mimeType,
        url: `data:${item.mimeType};base64,${item.data}`,
      })
      continue
    }

    if (item.type === "resource_link") {
      text.push(`${item.name}: ${item.uri}`)
      continue
    }

    if (item.type === "resource") {
      const resource = item.resource
      if ("text" in resource && resource.text) text.push(resource.text)
      if (!("blob" in resource) || !resource.blob) continue

      const mime = resource.mimeType ?? "application/octet-stream"
      const size = base64Size(resource.blob)
      if (!SUPPORTED_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${resource.blob}`,
        ...(lastUriSegment(resource.uri) ? { filename: lastUriSegment(resource.uri) } : {}),
      })
      continue
    }

    const unknownItem = item as unknown as { readonly type?: unknown }
    const type = unknownItem.type === undefined ? "unknown" : String(unknownItem.type)
    text.push(`[MCP content omitted from text projection: ${type}]`)
  }

  const structured = result.structuredContent
  return {
    output:
      text.join("\n\n") ||
      (structured === undefined || structured === null ? "" : JSON.stringify(structured)),
    ...(structured === undefined ? {} : { data: structured }),
    metadata:
      typeof result === "object" && result !== null && "metadata" in result && isRecord(result.metadata)
        ? result.metadata
        : {},
    ...(attachments.length > 0 ? { attachments } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number): Tool {
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: (args: unknown, options) =>
      invokeTool(client, mcpTool.name, args, {
        timeout,
        signal: options.abortSignal,
      }),
  })
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Promise<T[]>,
  label: string,
  key?: (item: T) => string,
) {
  return Effect.tryPromise({
    try: () => list(client),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
      const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
      return Object.fromEntries(
        items.map((item) => [
          key ? resourceClient + ":" + key(item) : sanitizedClient + ":" + sanitize(item.name),
          { ...item, client: clientName },
        ]),
      )
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

export function prompts(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return paginate(
    (cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.prompts,
  )
}

export function resources(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resources,
  )
}

export function resourceTemplates(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resourceTemplates,
  )
}

function listTools(client: Client, timeout: number) {
  return Effect.tryPromise({
    try: () =>
      paginate(
        async (cursor) => {
          const params = cursor === undefined ? undefined : { cursor }
          try {
            return await client.listTools(params, { timeout })
          } catch (error) {
            if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
            return client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, { timeout })
          }
        },
        (result) => result.tools,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

export * as McpCatalog from "./catalog"
