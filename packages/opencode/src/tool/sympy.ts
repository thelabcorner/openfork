import { Effect, Fiber, Schema, Stream } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { TRUNCATION_DIR } from "./truncation-dir"
import { ToolID } from "./schema"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import {
  OPERATIONS,
  TIME_LIMIT_DEFAULT_MS,
  TIME_LIMIT_MAX_MS,
  OUTPUT_CAP_BYTES,
  RESULT_CAP_BYTES,
  buildExprCall,
  buildCodeCall,
  parseOutput,
  firstErrorLine,
  suggestionFor,
  humanizeMs,
  parseSymbols,
  missingPythonMessage,
  missingSympyMessage,
} from "./sympy/core"
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
    description: "Symbols to declare, space or comma separated, e.g. \"x y\" or \"a b c\". Auto-detected from expr when omitted.",
  }),
  variable: Schema.optional(Schema.String).annotate({
    description: "Variable for solve/diff/integrate/limit/series (default: first free symbol).",
  }),
  point: Schema.optional(Schema.String).annotate({
    description: "limit/series: the value the variable approaches (e.g. 0, oo, -oo) / expansion point.",
  }),
  direction: Schema.optional(Schema.Literals(["+", "-"])).annotate({
    description: "limit: one-sided direction (\"+\" from above, \"-\" from below).",
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

type Metadata = {
  kind: "expr" | "code"
  status: string
  operation?: string
  durationMs: number
  exit: number | null
  truncated: boolean
  outputPath?: string
  result?: string
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Candidates for the python interpreter, in preference order.
const PYTHON_CANDIDATES = ["python", "python3", "py"]

type Probe = {
  found: boolean
  interpreter?: string
  version?: string
  sympy?: string
  message?: string
}

// Detect python + sympy by running a tiny probe through the spawner.
const probePython = Effect.fn("SympyTool.probe")(function* (
  spawner: ChildProcessSpawner["Service"],
  cwd: string,
) {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = [
      "import sys",
      "try:",
      "    import sympy",
      "    print(sympy.__version__)",
      "except Exception:",
      "    print('NO_SYMPY')",
      "print(sys.version.split()[0])",
    ].join("\n")
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(candidate, ["-c", probe], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
        )
        const out = yield* Stream.runCollect(Stream.decodeText(handle.stdout))
        const code = yield* handle.exitCode.pipe(Effect.catch(() => Effect.succeed(1)))
        return { out: out.join(""), code }
      }),
    ).pipe(Effect.catch(() => Effect.succeed({ out: "", code: 1 })))

    if (result.code === 0) {
      const lines = result.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const sympyLine = lines.find((l) => l !== "NO_SYMPY" && /^\d+\.\d+/.test(l))
      const version = lines.find((l) => /^\d+\.\d+\.\d+/.test(l))
      const sympy = lines.find((l) => /^\d+\.\d+\.\d+$/.test(l))
      if (lines.includes("NO_SYMPY") || !sympy) {
        return {
          found: false,
          interpreter: candidate,
          version: version,
          message: missingSympyMessage(candidate, version),
        } satisfies Probe
      }
      return {
        found: true,
        interpreter: candidate,
        version: version ?? "unknown",
        sympy: sympyLine ?? sympy,
      } satisfies Probe
    }
  }
  return {
    found: false,
    message: missingPythonMessage(),
  } satisfies Probe
})

export const SympyTool = Tool.define<typeof Parameters, Metadata, ChildProcessSpawner>(
  "sympy",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const started = Date.now()

          if (params.expr !== undefined && params.code !== undefined) {
            throw new Error("Provide either expr (structured) or code (advanced), not both.")
          }
          if (params.expr === undefined && params.code === undefined) {
            throw new Error("Provide expr (structured path) or code (advanced path). See the tool description for examples.")
          }

          const symbols = parseSymbols(params.symbols)
          const built = params.code !== undefined
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

          const probe = yield* probePython(spawner, instance.directory)
          if (!probe.found) {
            return {
              title: "sympy unavailable",
              output: `<sympy status="unavailable">\n  <message>${escapeXml(probe.message ?? "Python or SymPy not found")}</message>\n</sympy>`,
              metadata: { kind, status: "unavailable", durationMs: Date.now() - started, exit: null, truncated: false },
            }
          }

          // The child runs a wrapper: for the code path we override
          // sys.displayhook to capture the last expression's value via
          // InteractiveConsole (REPL semantics), then sstr() it.
          const timeoutMs = Math.min(params.timeoutMs ?? TIME_LIMIT_DEFAULT_MS, TIME_LIMIT_MAX_MS)
          const spill = path.join(TRUNCATION_DIR, ToolID.ascending())
          yield* Effect.promise(() => fs.mkdir(TRUNCATION_DIR, { recursive: true }))
          let full = ""
          let fileBytes = 0
          let expired = false
          let aborted = false
          let exitCode: number | null = null

          const script = built.code

          exitCode = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(probe.interpreter!, ["-c", script], {
                  cwd: instance.directory,
                  env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                }),
              )

              const streamFiber = yield* Effect.forkScoped(
                Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                  Effect.promise(async () => {
                    if (full.length < OUTPUT_CAP_BYTES) full += chunk
                    await fs.appendFile(spill, chunk, "utf8").catch(() => undefined)
                    fileBytes += Buffer.byteLength(chunk, "utf-8")
                  }),
                ),
              )

              const abort = Effect.callback<void>((resume) => {
                if (ctx.abort.aborted) return resume(Effect.void)
                const handler = () => resume(Effect.void)
                ctx.abort.addEventListener("abort", handler, { once: true })
                return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
              })

              const exit = yield* Effect.raceAll([
                handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
                abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
                Effect.sleep(`${timeoutMs + 100} millis`).pipe(
                  Effect.map(() => ({ kind: "timeout" as const, code: null })),
                ),
              ])

              if (exit.kind === "abort") {
                aborted = true
                yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
              }
              if (exit.kind === "timeout") {
                expired = true
                yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
              }

              yield* Fiber.join(streamFiber).pipe(Effect.timeout("2 seconds")).pipe(Effect.ignore)
              return exit.kind === "exit" ? exit.code : null
            }),
          ).pipe(Effect.orDie)

          const durationMs = Date.now() - started

          // Read the child's combined output back from the spill file.
          const stdout = yield* Effect.promise(() => fs.readFile(spill, "utf8").catch(() => full))

          const parsed = parseOutput(stdout)
          const timedOut = expired
          const status: string = timedOut ? "timed-out" : aborted ? "aborted" : exitCode === 0 ? "ok" : "error"

          // Keep the spill only when the result is huge or there was a failure.
          const resultBytes = Buffer.byteLength(parsed.result, "utf8")
          const keepSpill = fileBytes > RESULT_CAP_BYTES || status !== "ok"
          const spillPath = keepSpill ? spill : (yield* Effect.promise(() => fs.rm(spill, { force: true })).pipe(Effect.as(undefined)))

          let output = ""
          if (status === "timed-out") {
            output = `<sympy status="timed-out" kind="${kind}" duration="${humanizeMs(durationMs)}" timeoutMs="${timeoutMs}">\n  <message>The python/sympy child was killed after ${timeoutMs} ms — the operation likely diverges or hangs. Try a simpler expression, or use the code path with explicit numeric bounds.</message>\n</sympy>`
          } else if (status === "aborted") {
            output = `<sympy status="aborted" kind="${kind}">\n  <message>Aborted by the user.</message>\n</sympy>`
          } else if (status === "error") {
            const err = firstErrorLine(stdout)
            const suggestion = suggestionFor(err)
            output = [
              `<sympy status="error" kind="${kind}" duration="${humanizeMs(durationMs)}">`,
              `  <error>${escapeXml(err)}</error>`,
              ...(suggestion ? [`  <suggestion>${escapeXml(suggestion)}</suggestion>`] : []),
              `  <call>${escapeXml(built.display)}</call>`,
              `</sympy>`,
            ].join("\n")
          } else {
            const result = parsed.result || "<no result>"
            const truncated = resultBytes > RESULT_CAP_BYTES
            output = [
              `<sympy status="ok" kind="${kind}" duration="${humanizeMs(durationMs)}">`,
              `  <call>${escapeXml(built.display)}</call>`,
              `  <result>${escapeXml(truncated ? result.slice(0, RESULT_CAP_BYTES) + "…" : result)}</result>`,
              ...(parsed.diagnostics ? [`  <diagnostics>${escapeXml(parsed.diagnostics.slice(0, 2000))}</diagnostics>`] : []),
              ...(spillPath ? [`  <fullOutput path="${escapeXml(spillPath)}" />`] : []),
              `</sympy>`,
            ].join("\n")
          }

          return {
            title: `sympy ${built.display}`,
            output,
            metadata: {
              kind,
              status,
              operation: kind === "expr" ? (params.operation ?? "simplify") : undefined,
              durationMs,
              exit: exitCode,
              truncated: keepSpill,
              ...(spillPath ? { outputPath: spillPath } : {}),
              ...(status === "ok" ? { result: parsed.result } : {}),
            } satisfies Metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
