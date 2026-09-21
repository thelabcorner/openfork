import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import {
  OPERATIONS,
  TIME_LIMIT_DEFAULT_MS,
  TIME_LIMIT_MAX_MS,
  buildExprCall,
  buildCodeCall,
  parseSymbols,
} from "./sympy/core"
import { SympyExecutor } from "./sympy/executor"
import DESCRIPTION from "./sympy.txt"

export const Parameters = Schema.Struct({
  expr: Schema.optional(Schema.String).annotate({
    description:
      "Structured path: a sympy expression string, e.g. sqrt(8), sin(pi/4), x**2 - 4. Mutually exclusive with code.",
  }),
  operation: Schema.optional(Schema.Literals(OPERATIONS)).annotate({
    description:
      "Operation to apply to expr (default simplify): simplify|expand|factor|solve|diff|integrate|limit|series|evalf|nroots|factorint|primefactors|gcd|lcm|apart|together|trigsimp|cancel",
  }),
  symbols: Schema.optional(Schema.String).annotate({
    description:
      'Symbols to declare, space or comma separated, e.g. "x y" or "a b c". Auto-detected from expr when omitted.',
  }),
  variable: Schema.optional(Schema.String).annotate({
    description: "Variable for solve/diff/integrate/limit/series (default: first free symbol).",
  }),
  point: Schema.optional(Schema.String).annotate({
    description: "limit/series: the value the variable approaches (e.g. 0, oo, -oo) / expansion point.",
  }),
  direction: Schema.optional(Schema.Literals(["+", "-"])).annotate({
    description: 'limit: one-sided direction ("+" from above, "-" from below).',
  }),
  order: Schema.optional(NonNegativeInt).annotate({
    description: "diff: derivative order; series: number of terms.",
  }),
  precision: Schema.optional(NonNegativeInt).annotate({
    description: "evalf/nroots: digits of precision (default 15).",
  }),
  code: Schema.optional(Schema.String).annotate({
    description:
      "Advanced path: arbitrary sympy statements (from sympy import * preloaded; symbols declared from `symbols`). The last expression's value is returned. Mutually exclusive with expr.",
  }),
  timeoutMs: Schema.optional(NonNegativeInt).annotate({
    description: `Hard timeout for the python child (default ${TIME_LIMIT_DEFAULT_MS}, max ${TIME_LIMIT_MAX_MS}). Killed on expiry.`,
  }),
})

type Metadata = SympyExecutor.Metadata

export const SympyTool = Tool.define<typeof Parameters, Metadata, ChildProcessSpawner>(
  "sympy",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    return {
      exposure: "lazy" as const,
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.expr !== undefined && params.code !== undefined) {
            throw new Error("Provide either expr (structured) or code (advanced), not both.")
          }
          if (params.expr === undefined && params.code === undefined) {
            throw new Error(
              "Provide expr (structured path) or code (advanced path). See the tool description for examples.",
            )
          }

          const symbols = parseSymbols(params.symbols)
          const built =
            params.code !== undefined
              ? buildCodeCall({ code: params.code, symbols })
              : buildExprCall({
                  expr: params.expr!,
                  operation: params.operation,
                  symbols,
                  variable: params.variable,
                  point: params.point,
                  direction: params.direction,
                  order: params.order,
                  precision: params.precision,
                })
          if (!built.ok) throw new Error(built.error)
          const kind = built.kind

          // Permission: dedicated `sympy` key with the input as the pattern.
          yield* ctx.ask({
            permission: "sympy",
            patterns: [built.display.slice(0, 200)],
            always: [built.display.slice(0, 200)],
            metadata: { kind, ...(kind === "expr" ? { expr: params.expr } : { code: params.code }) },
          })
          return yield* SympyExecutor.execute({
            spawner,
            cwd: instance.directory,
            params,
            abort: ctx.abort,
          })
        }).pipe(Effect.orDie),
    }
  }),
)
