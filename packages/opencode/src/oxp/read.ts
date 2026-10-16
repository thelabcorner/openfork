import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"
import { ExchangeRead } from "@/exchange/read"
import { Symbols } from "@/symbols/service"
import { OxpAuthority } from "./authority"
import { OxpAttribution } from "./attribution"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpGrounding } from "./grounding"
import { OxpLocation } from "./location"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

const OUTPUT_BYTES = 96 * 1024
const OUTPUT_LINES = 500
const MAX_BATCH = 8
const MAX_OFFSET = 10_000_000
const MAX_LIMIT = 10_000
const ReadOffset = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_OFFSET })).annotate({
  description: "1-based read offset; use 1 for the first line or directory entry.",
})
const ReadLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })).annotate({
  description: "Positive maximum number of lines or directory entries to return.",
})

export const Window = Schema.Struct({
  path: Schema.String,
  rootID: Schema.optional(OxpSchema.RootID),
  offset: Schema.optional(ReadOffset),
  limit: Schema.optional(ReadLimit),
})
export type Window = Schema.Schema.Type<typeof Window>

export const Parameters = Schema.Struct({
  path: Schema.optional(Schema.String),
  rootID: Schema.optional(OxpSchema.RootID),
  offset: Schema.optional(ReadOffset),
  limit: Schema.optional(ReadLimit),
  action: Schema.optional(Schema.Literals(["read", "tail", "grep", "outline", "around"])),
  pattern: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  symbol: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  reads: Schema.optional(Schema.Array(Window).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BATCH))),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export const TransportStrategyConstraints = Object.freeze({
  oneOf: Object.freeze([
    {
      type: "object" as const,
      properties: {
        path: {},
        rootID: {},
        offset: {},
        limit: {},
        action: { enum: ["read", "tail", "grep", "outline", "around"] },
        pattern: {},
        symbol: {},
      },
      required: ["path"],
      additionalProperties: false as const,
    },
    {
      type: "object" as const,
      properties: {
        rootID: {},
        action: { const: "read" },
        reads: {},
      },
      required: ["reads"],
      additionalProperties: false as const,
    },
  ]),
})

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpRead") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeRead.Error): OxpError.Error {
  if (error instanceof ExchangeRead.InvalidArgument)
    return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeRead.Cancelled) return new OxpError.Cancelled({ detail: "OXP read was cancelled" })
  if (error instanceof ExchangeRead.Conflict)
    return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  return new OxpError.DependencyUnavailable({ detail: "OXP read dependency is unavailable" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const grounding = yield* OxpGrounding.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const symbols = yield* Symbols.Service

    const one = Effect.fn("OxpRead.one")(function* (
      window: Window,
      action: "read" | "tail" | "grep" | "outline" | "around",
      signal?: AbortSignal,
      pattern?: string,
      symbol?: string,
      inlineMedia = false,
    ) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP read was cancelled" })
      yield* OxpLocation.requireExplicit(window, "read")
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "read",
        phase: "read",
        rootID: window.rootID,
        path: window.path,
        allowMissing: true,
      })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: "read requires an approved root" })
      const target = OxpLocation.targetPath(admission.root)
      const root = admission.root.root
      const virtualPath = roots.toVirtualPath(root, target)
      const targetExists = yield* fs
        .exists(target)
        .pipe(
          Effect.mapError(() => new OxpError.DependencyUnavailable({ detail: "Unable to inspect OXP read target" })),
        )
      if (!targetExists) return yield* new OxpError.NotFound({ detail: `Read target does not exist: ${virtualPath}` })
      if (action === "outline") {
        // The native Symbols domain already owns the cached AST/regex outline.
        // Do not invent a Tool.Context or instantiate a second parser.
        const result = yield* symbols
          .execute(
            { action: "outline", file: target, maxResults: 200 },
            { directory: root.path, worktree: root.path, abort: signal },
          )
          .pipe(
            Effect.mapError((error) => {
              if (signal?.aborted) return new OxpError.Cancelled({ detail: "OXP file outline was cancelled" })
              if (error._tag === "SymbolsInvalidInput") {
                return new OxpError.InvalidArgument({
                  detail: OxpError.boundDetail(error.detail.split(root.path).join(`/${root.alias}`)),
                })
              }
              return new OxpError.DependencyUnavailable({ detail: "OXP file outline is unavailable" })
            }),
          )
        if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP file outline was cancelled" })
        yield* authority.revalidate(admission, "egress")
        const projected = ToolOutputProjection.project(result.output, {
          maxLines: OUTPUT_LINES,
          maxBytes: OUTPUT_BYTES,
          strategy: "head",
          marker: "<note>OXP outline truncated; narrow the file/symbol selection</note>",
        })
        return {
          title: `outline ${virtualPath}`,
          output: projected.content,
          metadata: {
            ...result.metadata,
            file: virtualPath,
            truncated: projected.truncated || result.metadata.truncated === true,
            grounded: false,
          },
        } satisfies OxpResult.CapabilityResult
      }
      if (action === "around") {
        if (!symbol) return yield* new OxpError.InvalidArgument({ detail: "around requires symbol" })
        const located = yield* symbols
          .locate(
            { file: target, symbol, limit: window.limit },
            { directory: root.path, worktree: root.path, abort: signal },
          )
          .pipe(
            Effect.mapError((error) => {
              if (signal?.aborted) return new OxpError.Cancelled({ detail: "OXP symbol lookup was cancelled" })
              if (error._tag === "SymbolsInvalidInput") {
                return new OxpError.InvalidArgument({
                  detail: OxpError.boundDetail(error.detail.split(root.path).join(`/${root.alias}`)),
                })
              }
              return new OxpError.DependencyUnavailable({ detail: "OXP symbol lookup is unavailable" })
            }),
          )
        if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP symbol lookup was cancelled" })
        // A definition window is a snippet, not a verified full-file read.
        // The shared ExchangeRead executor still checks concurrent file
        // changes, revalidates egress authority, and records attribution.
        // Intentionally do NOT register its full-read fingerprint for editing.
        const execution = yield* ExchangeRead.execute(
          fs,
          {
            path: target,
            displayPath: virtualPath,
            action: "read",
            expectedFingerprint: located.fingerprint,
            offset: located.offset,
            limit: located.limit,
            signal,
            attribution: OxpAttribution.attribution(admission.root),
            projectionMarker: "<note>OXP symbol window truncated; narrow the read window</note>",
          },
          { revalidate: () => authority.revalidate(admission, "egress") },
        ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))
        return {
          ...execution.result,
          title: `around ${virtualPath}`,
          metadata: {
            ...execution.result.metadata,
            action: "around",
            symbol,
            symbolLine: located.symbolLine,
            fallback: located.fallback,
            grounded: false,
          },
        } satisfies OxpResult.CapabilityResult
      }
      const execution = yield* ExchangeRead.execute(
        fs,
        {
          path: target,
          displayPath: virtualPath,
          action,
          ...(action === "grep" ? { pattern, ripgrep } : {}),
          offset: window.offset,
          limit: window.limit,
          signal,
          inlineMedia,
          projectionMarker: "<note>OXP read output truncated; narrow the read window</note>",
          // The shared exchange read already publishes the one canonical
          // CodingActivity record for this read, so attribution is supplied here
          // rather than emitted a second time. It is derived from the approved
          // root this call's admission re-verified on disk, not from the virtual
          // path spelling, so a nested file and a file at the root name one
          // project — and one canonical project folder — instead of a parent
          // directory. Exactly-once is preserved: the folder enriches the record
          // the exchange read already emits and never adds a second one.
          attribution: OxpAttribution.attribution(admission.root),
        },
        { revalidate: () => authority.revalidate(admission, "egress") },
      ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))
      if (!execution.fingerprint) return execution.result satisfies OxpResult.CapabilityResult

      const current = yield* config.get()
      grounding.scoped(current.connector.id).note(root.id, target, execution.fingerprint)
      return {
        ...execution.result,
        metadata: { ...execution.result.metadata, grounded: true },
      } satisfies OxpResult.CapabilityResult
    })

    const execute = Effect.fn("OxpRead.execute")(function* (input: Input, signal?: AbortSignal) {
      const action = input.action ?? (input.symbol ? "around" : input.pattern ? "grep" : "read")
      if (input.reads && (input.pattern !== undefined || input.symbol !== undefined)) {
        return yield* new OxpError.InvalidArgument({
          detail: "reads[] does not allow top-level grep or symbol parameters",
        })
      }
      if (input.reads && (input.path !== undefined || input.offset !== undefined || input.limit !== undefined)) {
        return yield* new OxpError.InvalidArgument({
          detail: "reads[] cannot be combined with top-level read location/window fields",
        })
      }
      if (input.reads) {
        if (action !== "read")
          return yield* new OxpError.InvalidArgument({ detail: "reads[] supports plain read windows only" })
        if (input.reads.length === 0 || input.reads.length > MAX_BATCH) {
          return yield* new OxpError.InvalidArgument({ detail: `reads[] must contain 1-${MAX_BATCH} targets` })
        }
        const results: {
          index: number
          result: OxpResult.CapabilityResult
          batchProjectionTruncated: boolean
        }[] = []
        const errors: { index: number; code: string; detail: string; error: OxpError.Error }[] = []
        const fragments = new Map<number, string>()
        // Reserve a little envelope room so every successful target receives a
        // fair model-facing slice instead of allowing the first large file to
        // consume the entire batch projection budget.
        const itemMaxBytes = Math.max(4 * 1024, Math.floor((OUTPUT_BYTES - 4 * 1024) / input.reads.length))
        const itemMaxLines = Math.max(32, Math.floor((OUTPUT_LINES - 16) / input.reads.length))
        for (const [index, item] of input.reads.entries()) {
          if (input.rootID && item.rootID && item.rootID !== input.rootID) {
            return yield* new OxpError.InvalidArgument({
              detail: "reads[] item rootID conflicts with the top-level rootID",
            })
          }
          const outcome = yield* one(
            {
              ...item,
              rootID: item.rootID ?? input.rootID,
            },
            "read",
            signal,
          ).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (result) => ({ ok: true as const, result }),
            }),
          )
          if (outcome.ok) {
            const itemProjection = ToolOutputProjection.project(outcome.result.output, {
              maxLines: itemMaxLines,
              maxBytes: itemMaxBytes,
              strategy: "head",
              marker: "<note>OXP batched read item truncated; use this item's nextOffset to continue</note>",
            })
            results.push({
              index,
              result: outcome.result,
              batchProjectionTruncated: itemProjection.truncated,
            })
            fragments.set(index, itemProjection.content)
            continue
          }
          if (
            outcome.error._tag === "OXP_NOT_FOUND" ||
            outcome.error._tag === "OXP_CONFLICT" ||
            outcome.error._tag === "OXP_INVALID_ARGUMENT" ||
            outcome.error._tag === "OXP_ROOT_REQUIRED"
          ) {
            const receipt = {
              index,
              code: outcome.error._tag,
              detail: outcome.error.detail,
              error: outcome.error,
            }
            errors.push(receipt)
            fragments.set(
              index,
              `<read-error index=${JSON.stringify(index)} code=${JSON.stringify(receipt.code)}>${receipt.detail}</read-error>`,
            )
            continue
          }
          return yield* Effect.fail(outcome.error)
        }
        if (results.length === 0 && errors.length > 0) {
          if (errors.length === 1) return yield* Effect.fail(errors[0]!.error)
          return yield* new OxpError.Conflict({
            detail: OxpError.boundDetail(
              errors.map((error) => `read[${error.index}]: ${error.detail}`).join("\n"),
              "No requested read targets were available",
            ),
          })
        }
        const joined = input.reads
          .map((_, index) => fragments.get(index))
          .filter((fragment): fragment is string => fragment !== undefined)
          .join("\n\n")
        const projected = ToolOutputProjection.project(joined, {
          maxLines: OUTPUT_LINES,
          maxBytes: OUTPUT_BYTES,
          strategy: "head",
          marker: "<note>OXP batched read output truncated; narrow the read windows</note>",
        })
        return {
          title: `read ${input.reads.length} targets`,
          output: projected.content,
          attachments: results.flatMap(({ result }) => result.attachments ?? []),
          metadata: {
            action: "read",
            targets: input.reads.length,
            succeeded: results.length,
            failed: errors.length,
            errors: errors.map(({ index, code, detail }) => ({ index, code, detail })),
            items: input.reads.map((_, index) => {
              const error = errors.find((item) => item.index === index)
              if (error) return { index, status: "error" as const, code: error.code, detail: error.detail }
              const success = results.find((item) => item.index === index)
              const itemMetadata = success?.result.metadata
              return {
                index,
                status: "ok" as const,
                ...(typeof itemMetadata?.path === "string" ? { path: itemMetadata.path } : {}),
                ...(typeof itemMetadata?.offset === "number" ? { offset: itemMetadata.offset } : {}),
                ...(success?.batchProjectionTruncated !== true && typeof itemMetadata?.nextOffset === "number"
                  ? { nextOffset: itemMetadata.nextOffset }
                  : {}),
                ...(typeof itemMetadata?.lines === "number" ? { lines: itemMetadata.lines } : {}),
                ...(typeof itemMetadata?.entries === "number" ? { entries: itemMetadata.entries } : {}),
                ...(itemMetadata?.directory === true ? { directory: true as const } : {}),
                truncated: itemMetadata?.truncated === true || success?.batchProjectionTruncated === true,
                ...(success?.batchProjectionTruncated === true
                  ? {
                      batchProjectionTruncated: true as const,
                      retryOffset: typeof itemMetadata?.offset === "number" ? itemMetadata.offset : 1,
                      recommendedLimit: itemMaxLines,
                    }
                  : {}),
              }
            }),
            truncated:
              projected.truncated ||
              results.some(
                ({ result, batchProjectionTruncated }) =>
                  result.metadata?.truncated === true || batchProjectionTruncated,
              ),
          },
        } satisfies OxpResult.CapabilityResult
      }
      if (!input.path) return yield* new OxpError.InvalidArgument({ detail: "read requires path or reads[]" })
      return yield* one(
        { path: input.path, rootID: input.rootID, offset: input.offset, limit: input.limit },
        action,
        signal,
        input.pattern,
        input.symbol ?? input.pattern,
        action === "read",
      )
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpConfig.node, OxpRoot.node, OxpGrounding.node, FSUtil.node, Ripgrep.node, Symbols.node],
})

export * as OxpRead from "./read"
