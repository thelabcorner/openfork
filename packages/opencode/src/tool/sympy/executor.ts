import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { withHeavyProcessSlot } from "../heavy-process-concurrency"
import { TRUNCATION_DIR } from "../truncation-dir"
import { ToolID } from "../schema"
import {
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
} from "./core"
import type { Parameters } from "../sympy"
import type { Schema } from "effect"

export type Metadata = {
  kind: "expr" | "code"
  status: string
  operation?: string
  durationMs: number
  exit: number | null
  truncated: boolean
  outputPath?: string
  result?: string
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Metadata
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const PYTHON_CANDIDATES = ["python", "python3", "py"]

type Probe = {
  found: boolean
  interpreter?: string
  version?: string
  sympy?: string
  message?: string
}

const probePython = Effect.fn("SympyExecutor.probe")(function* (spawner: ChildProcessSpawner["Service"], cwd: string) {
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
      const lines = result.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const sympyLine = lines.find((line) => line !== "NO_SYMPY" && /^\d+\.\d+/.test(line))
      const version = lines.find((line) => /^\d+\.\d+\.\d+/.test(line))
      const sympy = lines.find((line) => /^\d+\.\d+\.\d+$/.test(line))
      if (lines.includes("NO_SYMPY") || !sympy) {
        return { found: false, interpreter: candidate, version, message: missingSympyMessage(candidate, version) } satisfies Probe
      }
      return { found: true, interpreter: candidate, version: version ?? "unknown", sympy: sympyLine ?? sympy } satisfies Probe
    }
  }
  return { found: false, message: missingPythonMessage() } satisfies Probe
})

export const execute = Effect.fn("SympyExecutor.execute")(function* (input: {
  readonly spawner: ChildProcessSpawner["Service"]
  readonly cwd: string
  readonly params: Schema.Schema.Type<typeof Parameters>
  readonly abort: AbortSignal
  /**
   * Native sessions retain overflow/failure output for later local inspection.
   * External principals use bounded in-memory capture so a nominally read-only
   * remote computation cannot persist host-local artifacts as a side effect.
   */
  readonly capture?: "spill" | "memory"
  readonly exposeSpillPath?: boolean
}) {
  const { spawner, cwd, params, abort } = input
  const capture = input.capture ?? "spill"
  const started = Date.now()
  if (params.expr !== undefined && params.code !== undefined) {
    return yield* Effect.fail(new Error("Provide either expr (structured) or code (advanced), not both."))
  }
  if (params.expr === undefined && params.code === undefined) {
    return yield* Effect.fail(new Error("Provide expr (structured path) or code (advanced path)."))
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
  if (!built.ok) return yield* Effect.fail(new Error(built.error))
  const kind = built.kind
  const probe = yield* probePython(spawner, cwd)
  if (!probe.found) {
    return {
      title: "sympy unavailable",
      output: `<sympy status="unavailable">\n  <message>${escapeXml(probe.message ?? "Python or SymPy not found")}</message>\n</sympy>`,
      metadata: { kind, status: "unavailable", durationMs: Date.now() - started, exit: null, truncated: false },
    } satisfies Result
  }

  const timeoutMs = Math.min(params.timeoutMs ?? TIME_LIMIT_DEFAULT_MS, TIME_LIMIT_MAX_MS)
  const spill = capture === "spill" ? path.join(TRUNCATION_DIR, ToolID.ascending()) : undefined
  if (spill) yield* Effect.promise(() => fs.mkdir(TRUNCATION_DIR, { recursive: true }))
  let full = ""
  let fileBytes = 0
  let expired = false
  let aborted = false

  const exitCode = yield* withHeavyProcessSlot(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(probe.interpreter!, ["-c", built.code], {
            cwd,
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
                if (spill) await fs.appendFile(spill, chunk, "utf8").catch(() => undefined)
              fileBytes += Buffer.byteLength(chunk, "utf-8")
            }),
          ),
        )
        const abortEffect = Effect.callback<void>((resume) => {
          if (abort.aborted) return resume(Effect.void)
          const handler = () => resume(Effect.void)
          abort.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => abort.removeEventListener("abort", handler))
        })
        const exit = yield* Effect.raceAll([
          handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
          abortEffect.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
          Effect.sleep(`${timeoutMs + 100} millis`).pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
        ])
        if (exit.kind === "abort") {
          aborted = true
          yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
        }
        if (exit.kind === "timeout") {
          expired = true
          yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
        }
        yield* Fiber.join(streamFiber).pipe(Effect.timeout("2 seconds"), Effect.ignore)
        return exit.kind === "exit" ? exit.code : null
      }),
    ).pipe(Effect.orDie),
  )

  const durationMs = Date.now() - started
  const stdout = spill
    ? yield* Effect.promise(() => fs.readFile(spill, "utf8").catch(() => full))
    : full
  const parsed = parseOutput(stdout)
  const status = expired ? "timed-out" : aborted ? "aborted" : exitCode === 0 ? "ok" : "error"
  const resultBytes = Buffer.byteLength(parsed.result, "utf8")
  const keepSpill = Boolean(spill) && (fileBytes > RESULT_CAP_BYTES || status !== "ok")
  const spillPath = keepSpill
    ? spill
    : spill
      ? yield* Effect.promise(() => fs.rm(spill, { force: true })).pipe(Effect.as(undefined))
      : undefined
  const exposedSpill = input.exposeSpillPath === false ? undefined : spillPath
  const boundedCapture = capture === "memory" && fileBytes > Buffer.byteLength(full, "utf8")

  let output: string
  if (status === "timed-out") {
    output = `<sympy status="timed-out" kind="${kind}" duration="${humanizeMs(durationMs)}" timeoutMs="${timeoutMs}">\n  <message>The python/sympy child was killed after ${timeoutMs} ms.</message>\n</sympy>`
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
      ...(exposedSpill
        ? [`  <fullOutput path="${escapeXml(exposedSpill)}" />`]
        : spillPath
          ? [`  <fullOutput omitted="outside-approved-root" />`]
          : boundedCapture
            ? [`  <fullOutput omitted="bounded-memory-capture" />`]
            : []),
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
      truncated: keepSpill || boundedCapture || resultBytes > RESULT_CAP_BYTES,
      ...(exposedSpill ? { outputPath: exposedSpill } : {}),
      ...(status === "ok" ? { result: parsed.result } : {}),
    },
  } satisfies Result
})

export * as SympyExecutor from "./executor"
