import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { BrokerContract } from "@/tool/broker-contract"
import { sniffAttachmentMime } from "@/util/media"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpMcpControl } from "./mcp-control"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"
import { canonicalToolID, selectMcpTool } from "./mcp-selector"

export interface CatalogRow {
  readonly id: string
  readonly namespace: "mcp"
  readonly server: string
  readonly tool: string
  readonly description: string
  readonly authority: "integrations"
  readonly exposure: "brokered"
  readonly workspaceTier: 3
  /**
   * External MCP annotations are hints, not authority. Until OXP has a trusted
   * per-tool policy, every external tool call is conservatively mutating.
   */
  readonly mutation: "write"
  readonly declaredReadOnlyHint: boolean
}

export type Descriptor = ReturnType<typeof BrokerContract.describe> & {
  readonly capability: CatalogRow
}

export interface Interface {
  readonly list: (
    rootID: OxpSchema.RootID,
    query?: string,
  ) => Effect.Effect<readonly CatalogRow[], OxpError.Error>
  readonly describe: (
    rootID: OxpSchema.RootID,
    selector: string,
  ) => Effect.Effect<Descriptor, OxpError.Error>
  readonly call: (
    rootID: OxpSchema.RootID,
    selector: string,
    contract: string | undefined,
    args: unknown,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpMcp",
) {}
export const use = serviceUse(Service)

const CATALOG_DESCRIPTION_CHARS = 220
const DESCRIPTOR_DESCRIPTION_CHARS = 2_000

function idOf(tool: Pick<OxpMcpControl.Tool, "server" | "name">) {
  return canonicalToolID(tool)
}

function boundedDescription(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`
}

function nativeDescription(tool: OxpMcpControl.Tool) {
  const normalized = tool.description?.replace(/\s+/g, " ").trim()
  return normalized || `External MCP tool ${tool.server}/${tool.name}. Inspect its schema before calling.`
}

function catalogDescription(tool: OxpMcpControl.Tool) {
  return boundedDescription(nativeDescription(tool), CATALOG_DESCRIPTION_CHARS)
}

function descriptorDescription(tool: OxpMcpControl.Tool) {
  return boundedDescription(nativeDescription(tool), DESCRIPTOR_DESCRIPTION_CHARS)
}

function rowOf(tool: OxpMcpControl.Tool): CatalogRow {
  return Object.freeze({
    id: idOf(tool),
    namespace: "mcp" as const,
    server: tool.server,
    tool: tool.name,
    description: catalogDescription(tool),
    authority: "integrations" as const,
    exposure: "brokered" as const,
    workspaceTier: 3 as const,
    mutation: "write" as const,
    declaredReadOnlyHint: tool.readOnlyHint,
  })
}

function descriptorOf(tool: OxpMcpControl.Tool): Descriptor {
  const capability = rowOf(tool)
  return {
    ...BrokerContract.describe({
      broker: "capability:mcp",
      target: capability.id,
      targetField: "capability",
      description: descriptorDescription(tool),
      schema: tool.inputSchema,
    }),
    capability,
  }
}

function textOutput(result: OxpMcpControl.CallResult) {
  const text = result.content
    .flatMap((item) => {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        return [item.text]
      }
      return []
    })
    .filter((item) => item.trim())
    .join("\n\n")
  const omitted = result.content.length -
    result.content.filter(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text",
    ).length
  return {
    text:
      text ||
      (result.structuredContent === undefined
        ? "MCP tool completed without text output."
        : JSON.stringify(result.structuredContent)),
    omitted,
  }
}

/**
 * Forward bounded, well-formed multimodal blocks from an authorized external
 * MCP tool; invalid media never becomes model-visible content.
 */
export function mediaOutput(result: OxpMcpControl.CallResult): NonNullable<OxpResult.CapabilityResult["mediaContent"]> {
  const items: Array<{ type: "image" | "audio"; mimeType: string; data: string }> = []
  const budget = 4 * 1024 * 1024
  let encodedBytes = 0
  for (const part of result.content) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) continue
    const media = part as Record<string, unknown>
    if (media.type !== "image" && media.type !== "audio") continue
    if (typeof media.data !== "string" || typeof media.mimeType !== "string") continue
    if (!((media.type === "image" && /^(image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(media.mimeType)) ||
          (media.type === "audio" && /^audio\/(wav|x-wav|mpeg|mp3|mp4|aiff|aac|ogg|flac)$/.test(media.mimeType)))) continue
    if (items.length >= 4 || !media.data.length || encodedBytes + media.data.length > budget) continue
    if (media.data.length > budget ||
        media.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(media.data)) continue
    // The MCP sender owns these bytes, but its advertised MIME is untrusted.
    // Decode only a fixed-size header, not the full unbounded payload.
    const signature = sniffAttachmentMime(Buffer.from(media.data.slice(0, 256), "base64"), "application/octet-stream")
    const expected = media.mimeType === "audio/mp3" ? "audio/mpeg" :
      media.mimeType === "audio/x-wav" ? "audio/wav" : media.mimeType
    if (signature !== expected) continue
    // A 4 MiB aggregate avoids multiplying large binary content across nested
    // Code calls and the independent MCP outer transport.
    encodedBytes += media.data.length
    items.push({ type: media.type, mimeType: media.mimeType, data: media.data })
  }
  return items as NonNullable<OxpResult.CapabilityResult["mediaContent"]>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const control = yield* OxpMcpControl.Service

    const admitted = Effect.fn("OxpMcp.admitted")(function* (
      rootID: OxpSchema.RootID,
      operation: "list" | "describe" | "call",
    ) {
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: `integration.mcp.${operation}`,
        phase: operation === "call" ? "network" : "discover",
        rootID,
      })
      if (!admission.root) {
        return yield* new OxpError.RootRequired({
          detail: "External MCP operations require an explicit approved root",
        })
      }
      return {
        admission,
        target: {
          directory: admission.root.canonicalPath,
          commitGuard: () =>
            Effect.runPromise(
              authority
                .revalidate(admission, "network")
                .pipe(Effect.asVoid),
            ),
        } satisfies OxpMcpControl.Target,
      }
    })

    const tools = Effect.fn("OxpMcp.tools")(function* (
      rootID: OxpSchema.RootID,
      operation: "list" | "describe" | "call",
    ) {
      const current = yield* admitted(rootID, operation)
      yield* authority.revalidate(current.admission, "read")
      const values = yield* control
        .list(current.target)
        .pipe(
          Effect.mapError(
            () =>
              new OxpError.IntegrationOffline({
                detail: "Unable to inspect MCP tools for the approved root",
              }),
          ),
        )
      return { ...current, values }
    })

    const resolve = Effect.fn("OxpMcp.resolve")(function* (
      rootID: OxpSchema.RootID,
      selector: string,
      operation: "describe" | "call",
    ) {
      const trimmed = selector.trim()
      if (!trimmed) {
        return yield* new OxpError.InvalidArgument({
          detail: "MCP capability selector is empty",
        })
      }
      const current = yield* tools(rootID, operation)
      // No inventory cache: revalidate root authorization, then perform one
      // allocation-bounded scan of the current native MCP tool snapshot.
      const selected = selectMcpTool(current.values, trimmed)
      if (selected.kind === "found") return { ...current, tool: selected.tool }
      if (selected.kind === "ambiguous") {
        return yield* new OxpError.Conflict({
          detail: `MCP tool name "${trimmed}" is ambiguous; use one canonical capability ID: ${selected.candidates.join(", ")}`,
        })
      }
      return yield* new OxpError.NotFound({
        detail: `MCP capability "${trimmed}" is unavailable for this root`,
      })
    })

    const list = Effect.fn("OxpMcp.list")(function* (
      rootID: OxpSchema.RootID,
      query?: string,
    ) {
      const current = yield* tools(rootID, "list")
      const needle = query?.trim().toLowerCase()
      return current.values
        .map(rowOf)
        .filter(
          (row) =>
            !needle ||
            `${row.id} ${row.server} ${row.tool} ${row.description}`
              .toLowerCase()
              .includes(needle),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
    })

    const describe = Effect.fn("OxpMcp.describe")(function* (
      rootID: OxpSchema.RootID,
      selector: string,
    ) {
      const current = yield* resolve(rootID, selector, "describe")
      return descriptorOf(current.tool)
    })

    const call = Effect.fn("OxpMcp.call")(function* (
      rootID: OxpSchema.RootID,
      selector: string,
      contract: string | undefined,
      args: unknown,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) {
        return yield* new OxpError.Cancelled({
          detail: "OXP MCP call was cancelled before invocation",
        })
      }
      if (
        args === null ||
        typeof args !== "object" ||
        Array.isArray(args)
      ) {
        return yield* new OxpError.InvalidArgument({
          detail: "MCP capability args must be a JSON object",
        })
      }
      const current = yield* resolve(rootID, selector, "call")
      const descriptor = descriptorOf(current.tool)
      // External MCP inventories are always refreshed before admission.
      // descriptorOf just minted the schema-bound digest from this exact
      // snapshot: do not canonically hash the same schema a second time.
      const issue = BrokerContract.violationExpected({
        broker: "capability:mcp",
        target: descriptor.capability.id,
        expected: descriptor.contract,
        contract,
        discovery:
          `Call capability with namespace="mcp", action="describe", rootID, and capability="${descriptor.capability.id}"`,
      })
      if (issue) {
        return yield* new OxpError.InvalidArgument({ detail: issue })
      }

      const result = yield* control
        .call(current.target, {
          server: current.tool.server,
          tool: current.tool.name,
          args,
          ...(signal ? { signal } : {}),
        })
        .pipe(
          Effect.mapError((error) => {
            if (OxpError.isError(error)) return error
            if (error instanceof OxpMcpControl.ToolNotFound) {
              return new OxpError.NotFound({
                detail: "MCP tool disappeared before invocation",
              })
            }
            return new OxpError.AmbiguousExternalResult({
              detail:
                "External MCP mutation failed after invocation began; no automatic retry was attempted because commit state is unknown",
            })
          }),
        )

      const projected = textOutput(result)
      const media = mediaOutput(result)
      const omitted = projected.omitted - media.length
      return {
        title: `MCP ${current.tool.server}/${current.tool.name}`,
        output: omitted > 0
          ? `${projected.text}\n\n<content-note omitted="${omitted}">Some external MCP non-text items were omitted (unsupported, malformed, or over the 4 MiB combined media budget). Do not infer their contents.</content-note>`
          : projected.text,
        ...(media.length ? { mediaContent: media } : {}),
        ...(result.structuredContent === undefined
          ? {}
          : { structured: result.structuredContent }),
        metadata: {
          namespace: "mcp",
          capability: descriptor.capability.id,
          server: current.tool.server,
          tool: current.tool.name,
          declaredReadOnlyHint: current.tool.readOnlyHint,
          omittedNonTextItems: omitted,
          ...(media.length ? { forwardedMediaItems: media.length } : {}),
        },
        mutation: { attempted: true, committed: true },
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ list, describe, call })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpMcpControl.node],
})

export * as OxpMcp from "./mcp"
