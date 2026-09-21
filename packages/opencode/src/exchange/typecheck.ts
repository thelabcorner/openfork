export * as ExchangeTypecheck from "./typecheck"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Schema } from "effect"
import { GitRuntime } from "@opencode-ai/core/git-runtime"
import { Parameters as NativeParameters } from "@/tool/typecheck"
import { TypecheckScope } from "@/tool/typecheck-scope"
import { ExchangeError } from "./error"
import { ExchangeOwnedCommand } from "./owned-command"

export const Parameters = NativeParameters
export type Input = Schema.Schema.Type<typeof Parameters>

const GIT_ARGS = ["--no-optional-locks", "-c", "core.quotepath=false", ...GitRuntime.args([])] as const

export interface Hooks<E> {
  readonly rootPath: string
  readonly directory: string
  /** Authorize/canonicalize one path that must stay inside the approved root. */
  readonly authorizePath: (absolutePath: string) => Effect.Effect<string, ExchangeError.Error | E>
  readonly toVirtualPath: (absolutePath: string) => string
  readonly run: (
    input: Omit<ExchangeOwnedCommand.Input, "workdir"> & { readonly cwd: string },
  ) => Effect.Effect<ExchangeOwnedCommand.Result, E>
  readonly revalidate: () => Effect.Effect<void, ExchangeError.Error | E>
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export function resolveMode(params: Input): TypecheckScope.ScopeMode | "full" | "explain" {
  if (params.mode) return params.mode
  if (params.filePath) return "file"
  if (params.files?.length) return "files"
  if (params.folder) return "folder"
  return "changed"
}

function escapeXml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function contained(base: string, target: string) {
  const rel = path.relative(base, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function safeVirtual(hooks: Hooks<unknown>, absolute: string) {
  try {
    return hooks.toVirtualPath(absolute)
  } catch {
    return `<external>/${path.basename(absolute)}`
  }
}

export function execute<E>(
  params: Input,
  hooks: Hooks<E>,
  signal?: AbortSignal,
): Effect.Effect<Result, ExchangeError.Error | E> {
  return Effect.gen(function* () {
    const mode = resolveMode(params)
    const maxErrors = Math.min(Math.max(params.maxErrors ?? 80, 1), 500)
    if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "Typecheck request was cancelled" })

    if (mode === "explain") {
      const codeText = params.filePath?.replace(/\D/g, "")
      const code = codeText ? Number.parseInt(codeText, 10) : Number.NaN
      if (!Number.isFinite(code) || code <= 0) {
        return yield* new ExchangeError.InvalidArgument({ detail: "typecheck explain requires a TS error code in filePath" })
      }
      const info = TypecheckScope.explainCode(code)
      yield* hooks.revalidate()
      return {
        title: `explain TS${code}`,
        output: [
          `<typecheck-explain code="TS${code}" category="${escapeXml(info.category)}" severity="${info.severity}">`,
          `  <suggestion>${escapeXml(info.suggestion)}</suggestion>`,
          "</typecheck-explain>",
        ].join("\n"),
        metadata: { mode, status: "passed", files: [], errors: 0, truncated: false },
      }
    }

    if (mode === "full" && !params.reason) {
      return yield* new ExchangeError.InvalidArgument({ detail: "typecheck full requires a reason" })
    }
    const directory = yield* hooks.authorizePath(hooks.directory)
    const rootPath = hooks.rootPath

    const authorizeInput = Effect.fn("ExchangeTypecheck.authorizeInput")(function* (value: string) {
      const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(directory, value)
      return yield* hooks.authorizePath(absolute)
    })

    const runOwned = (input: {
      readonly cwd: string
      readonly argv: readonly [string, ...string[]]
      readonly timeoutMs: number
    }) =>
      hooks.run({
        cwd: input.cwd,
        argv: input.argv,
        timeoutMs: input.timeoutMs,
        outputCapBytes: ExchangeOwnedCommand.DEFAULT_OUTPUT_CAP_BYTES,
        title: "typecheck",
        operation: "typecheck.run",
        signal,
      })

    const gitProbe = yield* runOwned({
      cwd: directory,
      argv: ["git", ...GIT_ARGS, "rev-parse", "--show-toplevel"],
      timeoutMs: 15_000,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const gitRootRaw = gitProbe?.exitCode === 0 ? gitProbe.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined
    const gitRoot = gitRootRaw && contained(rootPath, path.resolve(gitRootRaw)) ? path.resolve(gitRootRaw) : undefined
    const worktree = gitRoot ?? directory
    if (mode === "changed" && !gitRoot) {
      return yield* new ExchangeError.InvalidArgument({ detail: "typecheck changed requires a Git worktree inside the approved root" })
    }

    const filePath = params.filePath ? yield* authorizeInput(params.filePath) : undefined
    const files = params.files?.length
      ? yield* Effect.forEach(params.files, (file) => authorizeInput(file), { concurrency: 8 })
      : undefined
    const folder = params.folder ? yield* authorizeInput(params.folder) : undefined

    const runGit = (args: string[], cwd: string) =>
      runOwned({ cwd, argv: ["git", ...GIT_ARGS, ...args], timeoutMs: 15_000 }).pipe(
        Effect.map((result) =>
          result.exitCode === 0
            ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
            : [],
        ),
      )
    const validatePath = (file: string) => Effect.runPromise(hooks.authorizePath(file).pipe(Effect.asVoid))

    const scope = mode === "full"
      ? []
      : yield* TypecheckScope.computeScope({
          mode: mode as TypecheckScope.ScopeMode,
          worktree,
          directory,
          filePath,
          files,
          folder,
          maxFiles: params.maxFiles,
          depth: params.depth,
          includeTests: params.includeTests,
          includeUntracked: params.includeUntracked,
          includeImporters: params.includeImporters,
          runGit,
          validatePath,
        }).pipe(
          Effect.mapError((error) =>
            new ExchangeError.InvalidArgument({
              detail: error instanceof Error ? error.message : "Unable to resolve typecheck scope",
            }),
          ),
        )
    if (mode !== "full" && scope.length === 0) {
      return yield* new ExchangeError.InvalidArgument({ detail: "No files selected to typecheck" })
    }
    for (const file of scope) yield* hooks.authorizePath(file)

    const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 30_000, 1_000), 600_000)
    let diagnostics: TypecheckScope.Diagnostic[]
    let exitCode: number
    let truncated: boolean
    let timedOut: boolean
    let bin: "tsgo" | "tsc"
    let tsconfigPath: string | undefined
    let diagnosticCwd = directory

    if (mode === "full") {
      const scriptDir = yield* Effect.tryPromise({
        try: () => TypecheckScope.findTypecheckScriptDir(directory, worktree),
        catch: () => new ExchangeError.DependencyUnavailable({ detail: "Unable to resolve the package typecheck script" }),
      })
      yield* hooks.authorizePath(scriptDir)
      const full = yield* runOwned({
        cwd: scriptDir,
        argv: ["bun", "run", "typecheck"],
        timeoutMs: Math.max(timeoutMs, 120_000),
      })
      diagnostics = TypecheckScope.parseDiagnostics(full.stdout || full.stderr, maxErrors)
      exitCode = full.timedOut ? 124 : (full.exitCode ?? 1)
      truncated = full.truncated
      timedOut = full.timedOut
      bin = "tsc"
      diagnosticCwd = scriptDir
    } else {
      const firstDir = path.dirname(scope[0]!)
      tsconfigPath = params.tsconfig
        ? yield* authorizeInput(params.tsconfig)
        : (yield* Effect.tryPromise({
            try: () => TypecheckScope.findNearestTsconfigFile(firstDir, worktree),
            catch: () => new ExchangeError.DependencyUnavailable({ detail: "Unable to search for tsconfig" }),
          })) ??
          (yield* Effect.tryPromise({
            try: () => TypecheckScope.findNearestTsconfigFile(directory, worktree),
            catch: () => new ExchangeError.DependencyUnavailable({ detail: "Unable to search for tsconfig" }),
          }))
      if (!tsconfigPath) return yield* new ExchangeError.InvalidArgument({ detail: "No tsconfig found for the selected typecheck scope" })
      tsconfigPath = yield* hooks.authorizePath(tsconfigPath)
      const tsconfigDir = path.dirname(tsconfigPath)
      const compiler = yield* Effect.tryPromise({
        try: () => TypecheckScope.resolveCompiler(tsconfigDir, worktree),
        catch: (error) =>
          new ExchangeError.DependencyUnavailable({
            detail: error instanceof Error ? error.message : "No TypeScript compiler is available",
          }),
      })
      const scratch = yield* Effect.tryPromise({
        try: () => fs.mkdtemp(path.join(os.tmpdir(), "openfork-exchange-typecheck-")),
        catch: () => new ExchangeError.DependencyUnavailable({ detail: "Unable to create typecheck scratch space" }),
      })
      const scoped = yield* Effect.gen(function* () {
        const tempConfig = path.join(scratch, "tsconfig.json")
        const configText = TypecheckScope.scopedConfigText({ baseTsconfig: tsconfigPath!, tempDir: scratch, files: scope })
        yield* Effect.tryPromise({
          try: () => fs.writeFile(tempConfig, configText, "utf8"),
          catch: () => new ExchangeError.DependencyUnavailable({ detail: "Unable to write typecheck scratch config" }),
        })
        return yield* runOwned({
          cwd: tsconfigDir,
          argv: ["node", compiler.path, "--project", tempConfig, "--noEmit", "--pretty", "false"],
          timeoutMs,
        })
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => fs.rm(scratch, { recursive: true, force: true })).pipe(Effect.catch(() => Effect.void)),
        ),
      )
      diagnostics = TypecheckScope.parseDiagnostics(scoped.stdout || scoped.stderr, maxErrors)
      exitCode = scoped.timedOut ? 124 : (scoped.exitCode ?? 1)
      truncated = scoped.truncated
      timedOut = scoped.timedOut
      bin = compiler.bin
      diagnosticCwd = tsconfigDir
    }

    yield* hooks.revalidate()
    const safeDiagnosticPath = (file: string) => {
      const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(diagnosticCwd, file)
      return contained(rootPath, absolute) ? safeVirtual(hooks as Hooks<unknown>, absolute) : `<external>/${path.basename(absolute)}`
    }
    const counts: Record<string, number> = {}
    for (const diagnostic of diagnostics) counts[diagnostic.severity] = (counts[diagnostic.severity] ?? 0) + 1
    const clusters = TypecheckScope.clusterDiagnostics(diagnostics)
    const status = timedOut ? "timed-out" : exitCode === 0 ? "passed" : "failed"
    const output = [
      `<typecheck mode="${mode}" status="${status}" errors="${diagnostics.length}" truncated="${truncated}">`,
      `  <scope files="${scope.length}">`,
      ...scope.map((file) => `    <file>${escapeXml(hooks.toVirtualPath(file))}</file>`),
      "  </scope>",
      tsconfigPath ? `  <tsconfig>${escapeXml(hooks.toVirtualPath(tsconfigPath))}</tsconfig>` : "  <tsconfig>package typecheck script</tsconfig>",
      `  <summary status="${status}" errors="${diagnostics.length}" bin="${bin}" exit="${exitCode}" />`,
      "  <triage>",
      `    <p0>${counts.P0 ?? 0}</p0>`,
      `    <p1>${counts.P1 ?? 0}</p1>`,
      `    <p2>${counts.P2 ?? 0}</p2>`,
      `    <p3>${counts.P3 ?? 0}</p3>`,
      "  </triage>",
      "  <clusters>",
      ...clusters.map(
        (cluster) =>
          `    <cluster code="TS${cluster.code}" severity="${cluster.severity}" category="${escapeXml(cluster.category)}" occurrences="${cluster.count}" files="${cluster.files}" />`,
      ),
      "  </clusters>",
      ...(diagnostics.length
        ? [
            "  <diagnostics>",
            ...diagnostics.map(
              (diagnostic) =>
                `    <diagnostic file="${escapeXml(safeDiagnosticPath(diagnostic.file))}" line="${diagnostic.line}" column="${diagnostic.column}" code="TS${diagnostic.code}" severity="${diagnostic.severity}" category="${escapeXml(diagnostic.category)}">\n      <message>${escapeXml(diagnostic.message)}</message>\n      <suggestion>${escapeXml(diagnostic.suggestion)}</suggestion>\n    </diagnostic>`,
            ),
            "  </diagnostics>",
          ]
        : []),
      `  <next>${timedOut ? "Typecheck timed out and the owned compiler process tree was retired." : diagnostics.length ? "Fix P0 then P1 diagnostics first." : "No errors detected in the selected scope."}</next>`,
      "</typecheck>",
    ].join("\n")

    return {
      title: `typecheck ${mode}`,
      output,
      metadata: {
        mode,
        status,
        files: scope.map((file) => hooks.toVirtualPath(file)),
        errors: diagnostics.length,
        truncated,
        timedOut,
        exitCode,
      },
    } satisfies Result
  })
}

