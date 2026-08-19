import { Effect, Schema } from "effect"
import path from "path"
import fs from "node:fs/promises"
import { AppProcess } from "@opencode-ai/core/process"
import { ChildProcess } from "effect/unstable/process"

// Shared scoped-typecheck machinery used by the `typecheck` tool and by the
// opt-in `runTypecheck` on edit/write. Scoped modes are fast because they run
// the repo's own compiler against a temporary tsconfig whose `include` is
// narrowed to the target files — the full-project default is never used for a
// scoped check (rail R7).

export const Diagnostic = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  code: Schema.Number,
  category: Schema.String,
  severity: Schema.Literals(["P0", "P1", "P2", "P3"]),
  message: Schema.String,
  suggestion: Schema.String,
})
export type Diagnostic = Schema.Schema.Type<typeof Diagnostic>

export type TypecheckOutcome = {
  exitCode: number
  stdout: string
  stderr: string
  truncated: boolean
  bin: "tsgo" | "tsc"
  diagnostics: Diagnostic[]
}

export type ScopeSummary = {
  mode: string
  files: string[]
  tsconfig?: string
  reason?: string
}

const CATEGORY: Record<number, string> = {
  2307: "import-resolution",
  6142: "import-resolution",
  1259: "import-resolution",
  2322: "type-mismatch",
  2345: "type-mismatch",
  2769: "type-mismatch",
  2305: "missing-export",
  2448: "missing-export",
  2304: "undeclared",
  2552: "undeclared",
  2531: "null-undefined",
  2532: "null-undefined",
  18047: "null-undefined",
  17004: "jsx-config",
  6133: "unused",
  6196: "unused",
  1005: "syntax",
  1109: "syntax",
}

const SEVERITY: Record<string, "P0" | "P1" | "P2" | "P3"> = {
  "import-resolution": "P2",
  "type-mismatch": "P1",
  "missing-export": "P1",
  undeclared: "P0",
  "null-undefined": "P1",
  "jsx-config": "P2",
  unused: "P3",
  syntax: "P0",
}

const SUGGESTION: Record<number, string> = {
  2307: "Cannot find module. Check the import path, that the dependency is installed, and that tsconfig 'paths' maps aliases like '@/*'.",
  6142: "Module was resolved, but the package has no type declarations. Install @types/<pkg> or add a declaration file.",
  1259: "Module can only be referenced with ECMAScript imports/exports. Enable 'esModuleInterop' or 'allowSyntheticDefaultImports' for CommonJS defaults.",
  2322: "Type is not assignable. Compare the expected type from the declaration against the value's inferred type.",
  2345: "Argument is not assignable to the parameter. Check the parameter type and the argument's type.",
  2769: "No overload matches this call. Check the arguments against each overload signature.",
  2305: "Module has no exported member. Confirm the export exists and its exact spelling.",
  2448: "Block-scoped variable used before its declaration. Move the usage after the declaration.",
  2304: "Cannot find name. Declare the variable/type or import it.",
  2552: "Cannot find name. Did you mean one of the names listed by the compiler?",
  2531: "Object is possibly null. Narrow with a guard or use optional chaining before the access.",
  2532: "Object is possibly undefined. Use optional chaining or a check before the access.",
  18047: "Value is possibly undefined under strict mode. Guard the access or assert non-null.",
  17004: "JSX used but '--jsx' is not configured. Set compilerOptions.jsx (e.g. 'react-jsx').",
  6133: "Declared but never used. Remove it or prefix the name with '_'.",
  6196: "Declared but never used. Remove it or prefix the name with '_'.",
  1005: "Syntax error — unexpected token. Check the statement structure.",
  1109: "Syntax error — expression expected. Check the expression placement.",
}

const GENERIC_SUGGESTION = "Review the flagged location and the surrounding declaration to resolve the mismatch."

// Exposed for the typecheck tool's `explain` mode.
export function explainCode(code: number): { category: string; severity: Diagnostic["severity"]; suggestion: string } {
  const category = CATEGORY[code] ?? "other"
  return { category, severity: SEVERITY[category] ?? "P3", suggestion: SUGGESTION[code] ?? GENERIC_SUGGESTION }
}

// The diagnostics parser is pure — keep it synchronous so callers can unit
// test it without a runtime. Continuation lines (indented, no path prefix)
// belong to the previous diagnostic's message.
const DIAG_LINE = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/

export function parseDiagnostics(output: string, maxErrors: number): Diagnostic[] {
  const out: Diagnostic[] = []
  let current: Partial<Diagnostic> | undefined
  const flush = () => {
    if (current && current.code !== undefined && current.message) {
      out.push(current as Diagnostic)
    }
    current = undefined
  }
  for (const line of output.split(/\r?\n/)) {
    const match = DIAG_LINE.exec(line)
    if (match) {
      flush()
      if (out.length >= maxErrors) break
      const code = Number.parseInt(match[4], 10)
      const category = CATEGORY[code] ?? "other"
      current = {
        file: match[1]!,
        line: Number.parseInt(match[2]!, 10),
        column: Number.parseInt(match[3]!, 10),
        code,
        category,
        severity: SEVERITY[category] ?? "P3",
        message: match[5]!,
        suggestion: SUGGESTION[code] ?? GENERIC_SUGGESTION,
      }
      continue
    }
    if (current && line.trim() && current.message !== undefined) {
      current = { ...current, message: `${current.message}\n${line.trim()}` }
    }
  }
  flush()
  return out
}

// Clusters group diagnostics by code + normalized message so the model sees
// which failure class to fix first, ordered P0 -> P3.
export function clusterDiagnostics(diagnostics: Diagnostic[]) {
  const order: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
  const map = new Map<string, { code: number; severity: Diagnostic["severity"]; category: string; files: Set<string>; count: number }>()
  for (const diag of diagnostics) {
    const key = `${diag.code}::${diag.message.replace(/\s+/g, " ").trim()}`
    const hit = map.get(key)
    if (hit) {
      hit.count++
      hit.files.add(diag.file)
      continue
    }
    map.set(key, { code: diag.code, severity: diag.severity, category: diag.category, files: new Set([diag.file]), count: 1 })
  }
  return [...map.values()]
    .toSorted((a, b) => order[a.severity] - order[b.severity] || b.count - a.count)
    .map(({ code, severity, category, files, count }) => ({ code, severity, category, files: files.size, count }))
}

const TSCONFIG_NAME = /^tsconfig.*\.json$/

// Returns the DIRECTORY containing the nearest tsconfig.*.json walking up from
// fromDir toward (and including) stopAt, or undefined. The temp scoped
// tsconfig is written into that directory so `extends: "./tsconfig.json"`
// resolves against the project's real config.
export async function findNearestTsconfig(fromDir: string, stopAt: string): Promise<string | undefined> {
  let dir = path.resolve(fromDir)
  const root = path.resolve(stopAt)
  while (true) {
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    const match = entries.find((name) => TSCONFIG_NAME.test(name))
    if (match) return dir
    if (dir === root || dir === path.dirname(dir)) return undefined
    dir = path.dirname(dir)
  }
}

// Resolve the compiler binary by walking up from the tsconfig directory toward
// the worktree root, preferring the nearest node_modules. tsgo (the native
// preview compiler) is primary; plain tsc.js is the fallback. Falls back to
// the host package's own node_modules (cwd) so the tool works even when the
// project under check has no local TypeScript install (e.g. tests).
async function resolveCompiler(tsconfigDir: string, worktree: string): Promise<{ bin: "tsgo" | "tsc"; path: string }> {
  const walk = async (start: string, stop: string): Promise<{ bin: "tsgo" | "tsc"; path: string } | undefined> => {
    let dir = path.resolve(start)
    const root = path.resolve(stop)
    while (true) {
      const tsgo = path.join(dir, "node_modules", "@typescript", "native-preview", "bin", "tsgo.js")
      const tsc = path.join(dir, "node_modules", "typescript", "lib", "tsc.js")
      if (await fs.stat(tsgo).then(() => true).catch(() => false)) return { bin: "tsgo", path: tsgo }
      if (await fs.stat(tsc).then(() => true).catch(() => false)) return { bin: "tsc", path: tsc }
      if (dir === root || dir === path.dirname(dir)) return undefined
      dir = path.dirname(dir)
    }
  }
  const found =
    (await walk(tsconfigDir, worktree)) ??
    (await walk(worktree, path.dirname(worktree))) ??
    (await walk(process.cwd(), path.dirname(process.cwd())))
  if (found) return found
  throw new Error(
    "No TypeScript compiler found: neither @typescript/native-preview (tsgo) nor typescript (tsc.js) is installed under the project's node_modules.",
  )
}

const TEMP_TSCONFIG_PREFIX = ".opencode-typecheck-"

// Write a temp tsconfig that extends the project's tsconfig but narrows the
// `include` to the target files. Runs the compiler with it and always removes
// the temp file (success or failure) via acquireRelease. The whole effect is
// scoped so the acquireRelease Scope is self-contained (callers never need a
// Scope).
export const runScopedTypecheck = Effect.fn("TypecheckScope.runScoped")(function* (input: {
  app: AppProcess.Interface
  worktree: string
  tsconfigDir: string
  files: string[]
  maxErrors?: number
  timeoutMs?: number
  signal?: AbortSignal
}) {
  const body = Effect.gen(function* () {
    const app = input.app
    const tempName = `${TEMP_TSCONFIG_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.json`
    const tempPath = path.join(input.tsconfigDir, tempName)
    const relative = input.files.map((file) => path.relative(input.tsconfigDir, file).split(path.sep).join("/"))

    const scoped = {
      extends: "./tsconfig.json",
      include: relative,
      compilerOptions: { noEmit: true },
    }

    yield* Effect.acquireRelease(
      Effect.promise(() => fs.writeFile(tempPath, JSON.stringify(scoped, null, 2), "utf8")),
      Effect.fnUntraced(function* () {
        yield* Effect.promise(() => fs.rm(tempPath, { force: true })).pipe(Effect.catch(() => Effect.void))
      }),
    )

    const compiler = yield* Effect.promise(() => resolveCompiler(input.tsconfigDir, input.worktree))
    const command = ChildProcess.make("node", [compiler.path, "--project", tempPath, "--noEmit", "--pretty", "false"], {
      cwd: input.tsconfigDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })

    const result = yield* app.run(command, {
      timeout: input.timeoutMs,
      signal: input.signal,
      maxOutputBytes: 3_000_000,
    }).pipe(Effect.catch((error) => Effect.succeed({
      command: error.command,
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(error.stderr ?? error.message),
      stdoutTruncated: false,
      stderrTruncated: false,
    })))

    const stdout = result.stdout.toString("utf8")
    const stderr = result.stderr.toString("utf8")
    const combined = stdout || stderr
    const truncated = result.stdoutTruncated || result.stderrTruncated
    const diagnostics = parseDiagnostics(combined, input.maxErrors ?? 80)

    return {
      exitCode: result.exitCode,
      stdout,
      stderr,
      truncated,
      bin: compiler.bin,
      diagnostics,
    } satisfies TypecheckOutcome
  })
  return yield* Effect.scoped(body)
})

// `full` mode shells the package's own `typecheck` script (bun run typecheck)
// from the nearest package dir that defines one, walking up to the worktree.
export const runFullTypecheck = Effect.fn("TypecheckScope.runFull")(function* (input: {
  app: AppProcess.Interface
  worktree: string
  cwd: string
  reason: string
  timeoutMs?: number
  signal?: AbortSignal
}) {
  const app = input.app
  const scriptDir = yield* Effect.promise(async () => {
    let dir = path.resolve(input.cwd)
    const root = path.resolve(input.worktree)
    while (true) {
      const pkg = path.join(dir, "package.json")
      const parsed = await fs.readFile(pkg, "utf8").then((text) => JSON.parse(text) as { scripts?: Record<string, string> }).catch(() => undefined)
      if (parsed?.scripts?.typecheck) return dir
      if (dir === root || dir === path.dirname(dir)) return input.worktree
      dir = path.dirname(dir)
    }
  })
  const command = ChildProcess.make("bun", ["run", "typecheck"], {
    cwd: scriptDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const result = yield* app.run(command, {
    timeout: input.timeoutMs,
    signal: input.signal,
    maxOutputBytes: 5_000_000,
  }).pipe(Effect.catch((error) => Effect.succeed({
    command: error.command,
    exitCode: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(error.stderr ?? error.message),
    stdoutTruncated: false,
    stderrTruncated: false,
  })))
  const stdout = result.stdout.toString("utf8")
  const stderr = result.stderr.toString("utf8")
  const combined = stdout || stderr
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    truncated: result.stdoutTruncated || result.stderrTruncated,
    bin: "tsc" as const,
    diagnostics: parseDiagnostics(combined, 80),
  } satisfies TypecheckOutcome
})

export function isTsFile(file: string): boolean {
  const lower = file.toLowerCase()
  return lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".mts") || lower.endsWith(".cts")
}

export function relativePosix(worktree: string, file: string): string {
  return path.relative(worktree, file).split(path.sep).join("/")
}

export * as TypecheckScope from "./typecheck-scope"
