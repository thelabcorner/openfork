export * as ExchangeSympy from "./sympy"

import { Effect } from "effect"
import type { Schema } from "effect"
import { Parameters as NativeParameters } from "@/tool/sympy"
import {
  OUTPUT_CAP_BYTES,
  RESULT_CAP_BYTES,
  TIME_LIMIT_DEFAULT_MS,
  TIME_LIMIT_MAX_MS,
  buildCodeCall,
  buildExprCall,
  firstErrorLine,
  humanizeMs,
  missingPythonMessage,
  missingSympyMessage,
  parseOutput,
  parseSymbols,
  suggestionFor,
} from "@/tool/sympy/core"
import { ExchangeError } from "./error"
import { ExchangeOwnedCommand } from "./owned-command"

export const Parameters = NativeParameters
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface Runner<E> {
  readonly run: (input: ExchangeOwnedCommand.Input) => Effect.Effect<ExchangeOwnedCommand.Result, E>
  /** True only for a missing/unavailable candidate executable during probing. */
  readonly isCandidateUnavailable: (error: E) => boolean
}

const PYTHON_CANDIDATES = ["python", "python3", "py"] as const

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function execute<E>(
  params: Input,
  runner: Runner<E>,
  signal?: AbortSignal,
): Effect.Effect<Result, ExchangeError.InvalidArgument | ExchangeError.Cancelled | E> {
  return Effect.gen(function* () {
    if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "SymPy request was cancelled" })
    if (params.expr !== undefined && params.code !== undefined) {
      return yield* new ExchangeError.InvalidArgument({ detail: "Provide either expr or code, not both" })
    }
    if (params.expr === undefined && params.code === undefined) {
      return yield* new ExchangeError.InvalidArgument({ detail: "Provide expr or code" })
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
    if (!built.ok) return yield* new ExchangeError.InvalidArgument({ detail: built.error })

    const probeCode = [
      "import sys",
      "try:",
      "    import sympy",
      "    print(sympy.__version__)",
      "except Exception:",
      "    print('NO_SYMPY')",
      "print(sys.version.split()[0])",
    ].join("\n")
    let interpreter: string | undefined
    let unavailable = missingPythonMessage()
    for (const candidate of PYTHON_CANDIDATES) {
      const probe = yield* runner
        .run({
          argv: [candidate, "-c", probeCode],
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
          title: `sympy probe: ${candidate}`,
          operation: "process.sympy",
          timeoutMs: 5_000,
          outputCapBytes: 32 * 1024,
          signal,
        })
        .pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) =>
            runner.isCandidateUnavailable(error)
              ? Effect.succeed({ ok: false as const })
              : Effect.fail(error),
          ),
        )
      if (!probe.ok || probe.value.exitCode !== 0) continue
      const lines = probe.value.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const version = lines.find((line) => /^\d+\.\d+\.\d+/.test(line))
      const sympy = lines.find((line) => /^\d+\.\d+\.\d+$/.test(line) && line !== version)
      if (lines.includes("NO_SYMPY") || !sympy) {
        unavailable = missingSympyMessage(candidate, version)
        break
      }
      interpreter = candidate
      break
    }

    if (!interpreter) {
      const metadata = { status: "unavailable", kind: built.kind }
      return {
        title: "sympy unavailable",
        output: `<sympy status="unavailable">\n  <message>${escapeXml(unavailable)}</message>\n</sympy>`,
        metadata,
      } satisfies Result
    }

    const startedAt = Date.now()
    const timeoutMs = Math.min(params.timeoutMs ?? TIME_LIMIT_DEFAULT_MS, TIME_LIMIT_MAX_MS)
    const run = yield* runner.run({
      argv: [interpreter, "-c", built.code],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      title: `sympy ${built.display}`,
      operation: "process.sympy",
      timeoutMs,
      outputCapBytes: OUTPUT_CAP_BYTES,
      signal,
    })
    const durationMs = Date.now() - startedAt
    const combined = run.stdout + (run.stderr ? `\n${run.stderr}` : "")
    const parsed = parseOutput(run.stdout)
    const status = run.timedOut ? "timed-out" : run.exitCode === 0 ? "ok" : "error"
    const resultBytes = Buffer.byteLength(parsed.result, "utf8")
    let output: string
    if (status === "timed-out") {
      output = `<sympy status="timed-out" kind="${built.kind}" duration="${humanizeMs(durationMs)}" timeoutMs="${timeoutMs}">\n  <message>The python/sympy child was killed after ${timeoutMs} ms.</message>\n</sympy>`
    } else if (status === "error") {
      const line = firstErrorLine(combined)
      const suggestion = suggestionFor(line)
      output = [
        `<sympy status="error" kind="${built.kind}" duration="${humanizeMs(durationMs)}">`,
        `  <error>${escapeXml(line)}</error>`,
        ...(suggestion ? [`  <suggestion>${escapeXml(suggestion)}</suggestion>`] : []),
        `  <call>${escapeXml(built.display)}</call>`,
        "</sympy>",
      ].join("\n")
    } else {
      const rendered = parsed.result || "<no result>"
      const truncated = resultBytes > RESULT_CAP_BYTES
      output = [
        `<sympy status="ok" kind="${built.kind}" duration="${humanizeMs(durationMs)}">`,
        `  <call>${escapeXml(built.display)}</call>`,
        `  <result>${escapeXml(truncated ? rendered.slice(0, RESULT_CAP_BYTES) + "…" : rendered)}</result>`,
        ...(parsed.diagnostics ? [`  <diagnostics>${escapeXml(parsed.diagnostics.slice(0, 2000))}</diagnostics>`] : []),
        ...(run.truncated ? [`  <fullOutput omitted="bounded-memory-capture" />`] : []),
        "</sympy>",
      ].join("\n")
    }
    const metadata = {
      status,
      kind: built.kind,
      durationMs,
      exit: run.exitCode,
      truncated: run.truncated || resultBytes > RESULT_CAP_BYTES,
      ...(built.kind === "expr" ? { operation: params.operation ?? "simplify" } : {}),
      ...(status === "ok" ? { result: parsed.result } : {}),
    }
    return { title: `sympy ${built.display}`, output, metadata } satisfies Result
  })
}

