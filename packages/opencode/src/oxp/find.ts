import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ExchangeError } from "@/exchange/error"
import { ExchangeFind } from "@/exchange/find"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpLocation } from "./location"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

const NonEmpty = Schema.String.check(Schema.isMinLength(1))
const Offset = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))
const Scope = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  rootID: Schema.optionalKey(OxpSchema.RootID),
})
const GlobSearch = Schema.Struct({
  ...Scope.fields,
  glob: NonEmpty,
  offset: Schema.optionalKey(Offset),
  limit: Schema.optionalKey(Limit),
})
const TextSearch = Schema.Struct({
  ...Scope.fields,
  grep: NonEmpty,
  glob: Schema.optionalKey(NonEmpty),
  include: Schema.optionalKey(Schema.String),
  syntax: Schema.optionalKey(Schema.Literals(["literal", "regex"])),
  offset: Schema.optionalKey(Offset),
  limit: Schema.optionalKey(Limit),
})

/**
 * Runtime search grammar stays strategy-shaped. A text search may carry glob
 * as its file filter, so grep + glob is a first-class operation rather than an
 * invalid mixed strategy. Source-code needles are literal unless regex is
 * explicitly requested.
 */
const RuntimeParameters = Schema.Union([GlobSearch, TextSearch])
type RuntimeInput = Schema.Schema.Type<typeof RuntimeParameters>

/**
 * Transport-safe public envelope. Hosts may flatten or drop conditional schema
 * constraints, so the flat vocabulary is intentional and execution semantics
 * are defined by the canonical runtime strategies above.
 *
 * glob only: path search.
 * grep only: text search.
 * grep + glob: text search restricted to matching files.
 * include is the legacy grep file-filter alias; ExchangeFind rejects only a
 * genuinely conflicting glob/include pair.
 */
export const Parameters = Schema.Struct({
  ...Scope.fields,
  glob: Schema.optionalKey(NonEmpty),
  grep: Schema.optionalKey(NonEmpty),
  include: Schema.optionalKey(Schema.String),
  syntax: Schema.optionalKey(Schema.Literals(["literal", "regex"])),
  offset: Schema.optionalKey(Offset),
  limit: Schema.optionalKey(Limit),
})
export type Input = Schema.Schema.Type<typeof Parameters>

const locationRequirement = Object.freeze({
  anyOf: Object.freeze([
    Object.freeze({ required: ["rootID"] }),
    Object.freeze({ required: ["path"] }),
  ]),
})

/**
 * Conditional grammar for MCP hosts that preserve oneOf. Keep the top-level
 * Parameters envelope flat because some connector projections discard unions.
 *
 * Text search intentionally allows grep + glob: glob is a file filter there.
 * Conflicting glob/include filters remain a runtime InvalidArgument.
 */
export const TransportStrategyConstraints = Object.freeze({
  oneOf: Object.freeze([
    Object.freeze({
      type: "object" as const,
      properties: Object.freeze({
        rootID: {},
        path: {},
        glob: {},
        offset: {},
        limit: {},
      }),
      required: Object.freeze(["glob"]),
      ...locationRequirement,
      additionalProperties: false as const,
    }),
    Object.freeze({
      type: "object" as const,
      properties: Object.freeze({
        rootID: {},
        path: {},
        grep: {},
        glob: {},
        include: {},
        syntax: {},
        offset: {},
        limit: {},
      }),
      required: Object.freeze(["grep"]),
      ...locationRequirement,
      additionalProperties: false as const,
    }),
  ]),
})

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpFind") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: "OXP file search was cancelled" })
  return new OxpError.DependencyUnavailable({ detail: "OXP file search is unavailable" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service

    const executeRaw = Effect.fn("OxpFind.executeRaw")(function* (input: RuntimeInput, signal?: AbortSignal) {
      yield* OxpLocation.requireExplicit(input, "find")

      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "find",
        phase: "read",
        rootID: input.rootID,
        path: input.path,
      })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: "find requires an approved root" })
      const target = OxpLocation.targetPath(admission.root)
      const root = admission.root.root
      const search =
        "grep" in input
          ? {
              grep: input.grep,
              ...(input.glob === undefined ? {} : { glob: input.glob }),
              ...(input.include === undefined ? {} : { include: input.include }),
              ...(input.syntax === undefined ? {} : { syntax: input.syntax }),
              ...(input.offset === undefined ? {} : { offset: input.offset }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }
          : {
              glob: input.glob,
              ...(input.offset === undefined ? {} : { offset: input.offset }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }
      return yield* ExchangeFind.execute(
        { fs, ripgrep },
        {
          path: target,
          rootLabel: root.alias,
          ...search,
          signal,
          projectionMarker: "<note>OXP find output truncated; narrow the path or pattern</note>",
          toDisplayPath: (value) => roots.toVirtualPath(root, value),
        },
        { revalidate: () => authority.revalidate(admission, "egress") },
      ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))
    })

    const execute: Interface["execute"] = (input, signal) =>
      Schema.decodeUnknownEffect(RuntimeParameters)(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(
          () =>
            new OxpError.InvalidArgument({
              detail:
                "Invalid OXP find arguments. find has no query/maxResults fields: use glob for path search, grep for text search, optional grep + glob to restrict files, and limit for result count.",
            }),
        ),
        Effect.flatMap((runtime) => executeRaw(runtime, signal)),
      )

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpRoot.node, FSUtil.node, Ripgrep.node],
})

export * as OxpFind from "./find"
